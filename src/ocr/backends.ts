import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, findExecutable, makeTempDir, readUtf8, runFile, stableId } from "../utils.js";
import type { OcrBackend, OcrBBox, OcrBlock, OcrContext, OcrPage, OcrPageInput, OcrWord } from "./types.js";

export function createOcrBackend(name: OcrBackend["name"]): OcrBackend {
  switch (name) {
    case "tesseract":
      return {
        name,
        recognizePage: recognizeWithTesseract
      };
    case "paddle":
      return {
        name,
        recognizePage: recognizeWithPaddle
      };
    case "surya":
      return {
        name,
        recognizePage: recognizeWithSurya
      };
    case "doctr":
      return {
        name,
        recognizePage: recognizeWithDoctr
      };
    default:
      assertNever(name);
  }
}

async function recognizeWithTesseract(input: OcrPageInput, context: OcrContext): Promise<OcrPage> {
  const executable = await resolveExecutable(context, ["tesseract"], "tesseract");
  const language = context.options.language ?? "eng";
  const { stdout } = await runFile(executable, [input.imagePath, "stdout", "-l", language, "tsv"], {
    maxBuffer: 100 * 1024 * 1024
  });

  return pageFromTesseractTsv(stdout, input);
}

async function recognizeWithSurya(input: OcrPageInput, context: OcrContext): Promise<OcrPage> {
  const executable = await resolveExecutable(context, ["surya_ocr"], "surya");
  const outputDir = await makeTempDir("smart-loader-surya-");

  await runFile(executable, [input.imagePath, "--output_dir", outputDir], {
    maxBuffer: 200 * 1024 * 1024
  });

  const resultsPath = await findFirstFile(outputDir, "results.json");
  if (!resultsPath) {
    throw new Error(`Surya did not write results.json in ${outputDir}.`);
  }

  const json = JSON.parse(await readUtf8(resultsPath)) as unknown;
  return pageFromSuryaJson(json, input);
}

async function recognizeWithPaddle(input: OcrPageInput, context: OcrContext): Promise<OcrPage> {
  const executable = await resolveExecutable(context, ["paddleocr"], "paddle");
  const outputDir = await makeTempDir("smart-loader-paddle-");
  const args = ["pp_structurev3", "-i", input.imagePath, "--save_path", outputDir];

  if (context.options.language) {
    args.push("--lang", context.options.language);
  }

  await runFile(executable, args, {
    maxBuffer: 200 * 1024 * 1024
  });

  const jsonPath = await findNewestJson(outputDir);
  if (!jsonPath) {
    throw new Error(`PaddleOCR did not write a JSON result in ${outputDir}.`);
  }

  const json = JSON.parse(await readUtf8(jsonPath)) as unknown;
  return pageFromPaddleJson(json, input);
}

async function recognizeWithDoctr(input: OcrPageInput, context: OcrContext): Promise<OcrPage> {
  const executable = await resolveExecutable(context, ["python3", "python"], "doctr");
  const runnerPath = path.join(context.options.assetDir, "runtime", "doctr_runner.py");
  await ensureDir(path.dirname(runnerPath));
  await fs.writeFile(runnerPath, DOCTR_RUNNER);

  const { stdout } = await runFile(executable, [runnerPath, input.imagePath], {
    maxBuffer: 200 * 1024 * 1024
  });

  const json = JSON.parse(stdout) as unknown;
  return pageFromDoctrJson(json, input);
}

async function resolveExecutable(context: OcrContext, defaultNames: string[], backendLabel: string): Promise<string> {
  if (context.options.backendCommand) {
    return context.options.backendCommand;
  }

  const executable = await findExecutable(defaultNames);
  if (!executable) {
    throw new Error(
      `${backendLabel} backend is selected, but no executable was found. Install it or pass --backend-command <path>.`
    );
  }

  return executable;
}

function pageFromTesseractTsv(tsv: string, input: OcrPageInput): OcrPage {
  const rows = parseTsv(tsv);
  const pageRow = rows.find((row) => row.level === "1");
  const width = numberValue(pageRow?.width);
  const height = numberValue(pageRow?.height);
  const lineGroups = new Map<string, OcrWord[]>();

  for (const row of rows) {
    if (row.level !== "5") {
      continue;
    }

    const text = (row.text ?? "").trim();
    if (!text) {
      continue;
    }

    const bbox = bboxFromLeftTopWidthHeight(row.left, row.top, row.width, row.height);
    if (!bbox) {
      continue;
    }

    const key = [row.page_num, row.block_num, row.par_num, row.line_num].join(":");
    const words = lineGroups.get(key) ?? [];
    words.push({
      text,
      bbox,
      confidence: confidenceValue(row.conf)
    });
    lineGroups.set(key, words);
  }

  const blocks = [...lineGroups.entries()].map(([key, words], index) => {
    const bbox = unionBBoxes(words.map((word) => word.bbox));
    return {
      id: blockId(input, key || String(index + 1)),
      text: words.map((word) => word.text).join(" "),
      bbox,
      confidence: average(words.map((word) => word.confidence)),
      label: "text",
      readingOrder: index,
      words
    } satisfies OcrBlock;
  });

  return buildPage(input, blocks, {
    width,
    height,
    raw: rows.length <= 1000 ? rows : undefined
  });
}

function pageFromSuryaJson(json: unknown, input: OcrPageInput): OcrPage {
  const pages = pickFirstPageList(json, input);
  const page = asRecord(pages[0]);
  const imageBBox = bboxFromX1Y1X2Y2(asNumberArray(page?.image_bbox));
  const rawBlocks = asArray(page?.blocks);
  const blocks = rawBlocks.flatMap((rawBlock, index) => {
    const block = asRecord(rawBlock);
    const html = stringValue(block?.html).trim();
    const text = htmlToPlainText(html);
    if (!text) {
      return [];
    }

    const bbox = bboxFromX1Y1X2Y2(asNumberArray(block?.bbox));
    if (!bbox) {
      return [];
    }

    return [
      {
        id: blockId(input, String(index + 1)),
        text,
        markdown: html || text,
        bbox,
        confidence: confidenceValue(block?.confidence),
        label: stringValue(block?.label) || undefined,
        readingOrder: numberValue(block?.reading_order) ?? index
      } satisfies OcrBlock
    ];
  });

  return buildPage(input, blocks, {
    width: imageBBox?.width,
    height: imageBBox?.height,
    raw: page
  });
}

function pageFromPaddleJson(json: unknown, input: OcrPageInput): OcrPage {
  const root = unwrapPaddleJson(json);
  const width = numberValue(root.width);
  const height = numberValue(root.height);
  const parsingBlocks = asArray(root.parsing_res_list);
  const blocksFromLayout = parsingBlocks.flatMap((item, index) => {
    const block = asRecord(item);
    const text = stringValue(block?.block_content).trim();
    const bbox = bboxFromAny(block?.block_bbox);
    if (!text || !bbox) {
      return [];
    }

    return [
      {
        id: blockId(input, `layout-${index + 1}`),
        text: htmlToPlainText(text) || text,
        markdown: text,
        bbox,
        label: stringValue(block?.block_label) || undefined,
        readingOrder: numberValue(block?.block_order) ?? numberValue(block?.block_id) ?? index
      } satisfies OcrBlock
    ];
  });

  const blocks = blocksFromLayout.length > 0 ? blocksFromLayout : blocksFromPaddleOcr(root, input);
  const markdown = paddleMarkdown(root);

  return buildPage(input, blocks, {
    width,
    height,
    markdown,
    raw: root
  });
}

function blocksFromPaddleOcr(root: Record<string, unknown>, input: OcrPageInput): OcrBlock[] {
  const ocr = asRecord(root.overall_ocr_res);
  const texts = asArray(ocr?.rec_texts);
  const scores = asArray(ocr?.rec_scores);
  const polys = asArray(ocr?.rec_polys ?? ocr?.dt_polys ?? ocr?.rec_boxes);

  return texts.flatMap((item, index) => {
    const text = stringValue(item).trim();
    const bbox = bboxFromAny(polys[index]);
    if (!text || !bbox) {
      return [];
    }

    return [
      {
        id: blockId(input, `ocr-${index + 1}`),
        text,
        bbox,
        confidence: confidenceValue(scores[index]),
        label: "text",
        readingOrder: index
      } satisfies OcrBlock
    ];
  });
}

function pageFromDoctrJson(json: unknown, input: OcrPageInput): OcrPage {
  const root = asRecord(json);
  const pages = asArray(root?.pages);
  const page = asRecord(pages[0]);
  const dimensions = asNumberArray(page?.dimensions);
  const height = dimensions?.[0];
  const width = dimensions?.[1];
  const blocks: OcrBlock[] = [];
  let lineIndex = 0;

  for (const rawBlock of asArray(page?.blocks)) {
    const block = asRecord(rawBlock);
    for (const rawLine of asArray(block?.lines)) {
      const line = asRecord(rawLine);
      const words: OcrWord[] = [];
      for (const rawWord of asArray(line?.words)) {
        const word = asRecord(rawWord);
        const text = stringValue(word?.value).trim();
        const bbox = bboxFromDoctrGeometry(word?.geometry, width, height);
        if (!text || !bbox) {
          continue;
        }

        words.push({
          text,
          bbox,
          confidence: confidenceValue(word?.confidence)
        });
      }

      if (words.length === 0) {
        continue;
      }

      lineIndex += 1;
      blocks.push({
        id: blockId(input, String(lineIndex)),
        text: words.map((word) => word.text).join(" "),
        bbox: unionBBoxes(words.map((word) => word.bbox)),
        confidence: average(words.map((word) => word.confidence)),
        label: "text",
        readingOrder: lineIndex - 1,
        words
      });
    }
  }

  return buildPage(input, blocks, {
    width,
    height,
    raw: page
  });
}

function buildPage(
  input: OcrPageInput,
  blocks: OcrBlock[],
  details: { width?: number; height?: number; markdown?: string; raw?: unknown } = {}
): OcrPage {
  const sortedBlocks = [...blocks].sort((a, b) => (a.readingOrder ?? 0) - (b.readingOrder ?? 0));
  const text = sortedBlocks.map((block) => block.text).join("\n").trim();
  const markdown = (details.markdown ?? sortedBlocks.map((block) => block.markdown ?? block.text).join("\n\n")).trim();

  return {
    pageNumber: input.pageNumber,
    imagePath: input.imagePath,
    width: details.width,
    height: details.height,
    text,
    markdown,
    blocks: sortedBlocks,
    warnings: sortedBlocks.length === 0 ? [`No OCR text blocks were found on page ${input.pageNumber}.`] : [],
    raw: details.raw
  };
}

function parseTsv(tsv: string): Array<Record<string, string>> {
  const lines = tsv.split(/\r?\n/).filter((line) => line.trim());
  const [headerLine, ...bodyLines] = lines;
  if (!headerLine) {
    return [];
  }

  const headers = headerLine.split("\t");
  return bodyLines.map((line) => {
    const cells = line.split("\t");
    const record: Record<string, string> = {};

    headers.forEach((header, index) => {
      record[header] = index === headers.length - 1 ? cells.slice(index).join("\t") : (cells[index] ?? "");
    });

    return record;
  });
}

function unwrapPaddleJson(json: unknown): Record<string, unknown> {
  const record = asRecord(json) ?? {};
  const prunedResult = asRecord(record.prunedResult);
  if (prunedResult) {
    return prunedResult;
  }

  const result = asRecord(record.result);
  const layoutResults = asArray(result?.layoutParsingResults);
  const firstLayout = asRecord(layoutResults[0]);
  const servicePruned = asRecord(firstLayout?.prunedResult);
  if (servicePruned) {
    return {
      ...servicePruned,
      markdown: firstLayout?.markdown
    };
  }

  return record;
}

function paddleMarkdown(root: Record<string, unknown>): string | undefined {
  const markdown = asRecord(root.markdown);
  const text = stringValue(markdown?.text);
  if (text) {
    return text;
  }

  const markdownTexts = asArray(markdown?.markdown_texts);
  const joined = markdownTexts.map((item) => stringValue(item)).filter(Boolean).join("\n\n").trim();
  return joined || undefined;
}

function pickFirstPageList(json: unknown, input: OcrPageInput): unknown[] {
  const record = asRecord(json);
  if (!record) {
    return [];
  }

  const basename = path.basename(input.imagePath, path.extname(input.imagePath));
  const exact = asArray(record[basename]);
  if (exact.length > 0) {
    return exact;
  }

  for (const value of Object.values(record)) {
    const pages = asArray(value);
    if (pages.length > 0) {
      return pages;
    }
  }

  return [];
}

async function findFirstFile(dir: string, filename: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstFile(entryPath, filename);
      if (nested) {
        return nested;
      }
    } else if (entry.name === filename) {
      return entryPath;
    }
  }

  return undefined;
}

async function findNewestJson(dir: string): Promise<string | undefined> {
  const files = await listFiles(dir);
  const jsonFiles = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => ({
        file,
        mtimeMs: (await fs.stat(file)).mtimeMs
      }))
  );

  jsonFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return jsonFiles[0]?.file;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }

  return files;
}

function bboxFromLeftTopWidthHeight(left: unknown, top: unknown, width: unknown, height: unknown): OcrBBox | undefined {
  const x = numberValue(left);
  const y = numberValue(top);
  const w = numberValue(width);
  const h = numberValue(height);

  if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) {
    return undefined;
  }

  return { x, y, width: w, height: h, unit: "px" };
}

function bboxFromAny(value: unknown): OcrBBox | undefined {
  const numbers = asNumberArray(value);
  if (!numbers) {
    return undefined;
  }

  if (numbers.length === 4) {
    const [a, b, c, d] = numbers;
    if (c > a && d > b) {
      return bboxFromX1Y1X2Y2(numbers);
    }

    return bboxFromLeftTopWidthHeight(a, b, c, d);
  }

  if (numbers.length >= 8) {
    const xs = numbers.filter((_, index) => index % 2 === 0);
    const ys = numbers.filter((_, index) => index % 2 === 1);
    return bboxFromMinMax(xs, ys);
  }

  return undefined;
}

function bboxFromDoctrGeometry(value: unknown, width?: number, height?: number): OcrBBox | undefined {
  if (!width || !height) {
    return undefined;
  }

  const numbers = asNumberArray(value);
  if (!numbers || numbers.length < 4) {
    return undefined;
  }

  const [x0, y0, x1, y1] = numbers;
  return {
    x: x0 * width,
    y: y0 * height,
    width: Math.max(0, (x1 - x0) * width),
    height: Math.max(0, (y1 - y0) * height),
    unit: "px"
  };
}

function bboxFromX1Y1X2Y2(values?: number[]): OcrBBox | undefined {
  if (!values || values.length < 4) {
    return undefined;
  }

  const [x0, y0, x1, y1] = values;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
    return undefined;
  }

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, unit: "px" };
}

function bboxFromMinMax(xs: number[], ys: number[]): OcrBBox | undefined {
  if (xs.length === 0 || ys.length === 0) {
    return undefined;
  }

  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);

  return bboxFromX1Y1X2Y2([x0, y0, x1, y1]);
}

function unionBBoxes(boxes: OcrBBox[]): OcrBBox {
  const x0 = Math.min(...boxes.map((bbox) => bbox.x));
  const y0 = Math.min(...boxes.map((bbox) => bbox.y));
  const x1 = Math.max(...boxes.map((bbox) => bbox.x + bbox.width));
  const y1 = Math.max(...boxes.map((bbox) => bbox.y + bbox.height));

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, unit: "px" };
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const flattened = flatten(value)
    .map((item) => numberValue(item))
    .filter((item): item is number => item !== undefined);

  return flattened.length > 0 ? flattened : undefined;
}

function flatten(value: unknown[]): unknown[] {
  return value.flatMap((item) => (Array.isArray(item) ? flatten(item) : [item]));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function confidenceValue(value: unknown): number | undefined {
  const parsed = numberValue(value);
  if (parsed === undefined || parsed < 0) {
    return undefined;
  }

  return parsed > 1 ? parsed / 100 : parsed;
}

function average(values: Array<number | undefined>): number | undefined {
  const clean = values.filter((value): value is number => value !== undefined);
  if (clean.length === 0) {
    return undefined;
  }

  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function blockId(input: OcrPageInput, suffix: string): string {
  return `ocr_block_${stableId(`${input.sourcePath}:${input.pageNumber}:${suffix}`)}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported OCR backend: ${String(value)}`);
}

const DOCTR_RUNNER = String.raw`import json
import sys

try:
    from doctr.io import DocumentFile
    from doctr.models import ocr_predictor
except Exception as exc:
    raise SystemExit(f"docTR is not importable. Install python-doctr, then retry. {exc}")

image_path = sys.argv[1]
doc = DocumentFile.from_images(image_path)
model = ocr_predictor(pretrained=True, export_as_straight_boxes=True)
result = model(doc)
print(json.dumps(result.export(), ensure_ascii=False))
`;

