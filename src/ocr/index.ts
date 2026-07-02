import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { createOcrBackend } from "./backends.js";
import { normalizeOcrOptions, OCR_INPUT_EXTENSIONS } from "./options.js";
import type {
  NormalizedOcrOptions,
  OcrBlock,
  OcrChunk,
  OcrContext,
  OcrDocument,
  OcrError,
  OcrInputFormat,
  OcrOptions,
  OcrPage,
  OcrPageInput,
  OcrResult
} from "./types.js";
import { documentId, ensureDir, estimateTokens, extensionOf, findExecutable, runFile, stableId } from "../utils.js";

export type * from "./types.js";
export { OCR_INPUT_EXTENSIONS };
export { generateOcrPreviewHtml } from "./preview.js";
export { evaluateOcrFiles } from "./eval.js";

export async function runOcrPath(inputPath: string, options: OcrOptions = {}): Promise<OcrResult> {
  const absolutePath = path.resolve(inputPath);
  const stat = await fs.stat(absolutePath);
  const normalizedOptions = normalizeOcrOptions(options);
  const rootPath = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
  const context: OcrContext = {
    rootPath,
    options: normalizedOptions
  };
  const files = stat.isDirectory() ? await scanOcrDirectory(absolutePath, normalizedOptions) : [absolutePath];
  const documents: OcrDocument[] = [];
  const errors: OcrError[] = [];

  await asyncPool(files, normalizedOptions.concurrency, async (filePath) => {
    try {
      const fileStat = await fs.stat(filePath);
      if (fileStat.size > normalizedOptions.maxFileSizeBytes) {
        errors.push({
          sourcePath: filePath,
          reason: `File exceeds maxFileSizeBytes (${normalizedOptions.maxFileSizeBytes}).`,
          code: "file_too_large"
        });
        return;
      }

      documents.push(await runOcrFile(filePath, context));
    } catch (error) {
      errors.push({
        sourcePath: filePath,
        reason: (error as Error).message,
        code: "ocr_failed"
      });
    }
  });

  documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const chunks = documents.flatMap((document) => document.chunks);

  return {
    rootPath,
    backend: normalizedOptions.backend,
    documents,
    chunks,
    errors,
    summary: {
      discoveredFiles: files.length,
      loadedFiles: documents.length,
      skippedFiles: 0,
      failedFiles: errors.length,
      pages: documents.reduce((sum, document) => sum + document.pages.length, 0),
      chunks: chunks.length
    }
  };
}

export async function runOcrFile(filePath: string, contextOrOptions: OcrContext | OcrOptions = {}): Promise<OcrDocument> {
  const absolutePath = path.resolve(filePath);
  const context = isOcrContext(contextOrOptions)
    ? contextOrOptions
    : {
        rootPath: path.dirname(absolutePath),
        options: normalizeOcrOptions(contextOrOptions)
      };
  const ext = extensionOf(absolutePath);
  const format = inputFormatForExtension(ext);
  if (!format) {
    throw new Error(`Unsupported OCR input extension: ${ext || "(none)"}`);
  }

  const relativePath = path.relative(context.rootPath, absolutePath) || path.basename(absolutePath);
  const pageInputs = format === "pdf" ? await renderPdfPages(absolutePath, relativePath, context) : [imagePageInput(absolutePath, relativePath)];
  const backend = createOcrBackend(context.options.backend);
  const pages: OcrPage[] = [];

  for (const pageInput of pageInputs) {
    pages.push(await backend.recognizePage(pageInput, context));
  }

  const stat = await fs.stat(absolutePath);
  const text = pages.map((page) => page.text).join("\n\n").trim();
  const markdown = pages
    .map((page) => `## Page ${page.pageNumber}\n\n${page.markdown || page.text}`)
    .join("\n\n")
    .trim();
  const baseDocument: Omit<OcrDocument, "chunks"> = {
    id: documentId(absolutePath, context.rootPath),
    sourcePath: absolutePath,
    relativePath,
    format,
    backend: context.options.backend,
    text,
    markdown,
    pages,
    warnings: pages.flatMap((page) => page.warnings),
    metadata: {
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      pageCount: pages.length,
      renderDpi: format === "pdf" ? context.options.pdf.renderDpi : undefined
    }
  };

  return {
    ...baseDocument,
    chunks: buildOcrChunks(baseDocument, context.options.chunkSize, context.options.chunkOverlap)
  };
}

function buildOcrChunks(
  document: Omit<OcrDocument, "chunks">,
  maxChars: number,
  overlapChars: number
): OcrChunk[] {
  const chunks: OcrChunk[] = [];
  let globalOffset = 0;

  for (const page of document.pages) {
    const pageBlocks = page.blocks.length > 0 ? page.blocks : syntheticBlocks(page);
    let pending: OcrBlock[] = [];
    let pendingText = "";
    let pendingStart = globalOffset;

    const flush = (): void => {
      if (!pendingText.trim()) {
        pending = [];
        pendingText = "";
        pendingStart = globalOffset;
        return;
      }

      const chunkText = pendingText.trim();
      const bbox = pending.length > 0 ? unionBlockBBoxes(pending) : undefined;
      const confidence = average(pending.map((block) => block.confidence));
      const labels = unique(pending.map((block) => block.label).filter((label): label is string => Boolean(label)));
      const index = chunks.length;

      chunks.push({
        id: `${document.id}_ocr_chunk_${index + 1}`,
        documentId: document.id,
        text: chunkText,
        markdown: chunkText,
        index,
        metadata: {
          sourcePath: document.sourcePath,
          relativePath: document.relativePath,
          format: document.format,
          backend: document.backend,
          page: page.pageNumber,
          bbox,
          pageImagePath: page.imagePath,
          tokenEstimate: estimateTokens(chunkText),
          startChar: pendingStart,
          endChar: pendingStart + chunkText.length,
          confidence,
          labels: labels.length > 0 ? labels : undefined
        }
      });

      const overlap = overlapBlocks(pending, overlapChars);
      pending = overlap;
      pendingText = overlap.map((block) => block.markdown ?? block.text).join("\n");
      pendingStart = Math.max(pendingStart, pendingStart + chunkText.length - pendingText.length);
    };

    for (const block of pageBlocks) {
      const blockText = (block.markdown ?? block.text).trim();
      if (!blockText) {
        continue;
      }

      const nextText = pendingText ? `${pendingText}\n${blockText}` : blockText;
      if (pendingText && nextText.length > maxChars) {
        flush();
      }

      if (!pendingText) {
        pendingStart = globalOffset;
      }

      pending.push(block);
      pendingText = pendingText ? `${pendingText}\n${blockText}` : blockText;

      if (pendingText.length >= maxChars) {
        flush();
      }
    }

    flush();
    globalOffset += page.text.length + 2;
  }

  return chunks;
}

function overlapBlocks(blocks: OcrBlock[], overlapChars: number): OcrBlock[] {
  if (overlapChars <= 0) {
    return [];
  }

  const selected: OcrBlock[] = [];
  let size = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const blockText = block.markdown ?? block.text;
    if (selected.length > 0 && size + blockText.length > overlapChars) {
      break;
    }

    selected.unshift(block);
    size += blockText.length + 1;
  }

  return selected;
}

function syntheticBlocks(page: OcrPage): OcrBlock[] {
  const text = page.markdown || page.text;
  if (!text.trim()) {
    return [];
  }

  return [
    {
      id: `ocr_block_${stableId(`${page.imagePath}:synthetic`)}`,
      text,
      bbox: {
        x: 0,
        y: 0,
        width: page.width ?? 1,
        height: page.height ?? 1,
        unit: "px"
      },
      label: "page",
      readingOrder: 0
    }
  ];
}

function unionBlockBBoxes(blocks: OcrBlock[]): OcrChunk["metadata"]["bbox"] {
  if (blocks.length === 0) {
    return undefined;
  }

  const x0 = Math.min(...blocks.map((block) => block.bbox.x));
  const y0 = Math.min(...blocks.map((block) => block.bbox.y));
  const x1 = Math.max(...blocks.map((block) => block.bbox.x + block.bbox.width));
  const y1 = Math.max(...blocks.map((block) => block.bbox.y + block.bbox.height));

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, unit: "px" };
}

async function renderPdfPages(filePath: string, relativePath: string, context: OcrContext): Promise<OcrPageInput[]> {
  const executable = await findExecutable(["pdftoppm"]);
  if (!executable) {
    throw new Error("PDF OCR requires pdftoppm from Poppler to render pages before OCR.");
  }

  const pageDir = path.join(context.options.assetDir, documentId(filePath, context.rootPath), "pages");
  await ensureDir(pageDir);
  await removeGeneratedPages(pageDir);

  const prefix = path.join(pageDir, "page");
  await runFile(
    executable,
    [
      "-png",
      "-r",
      String(context.options.pdf.renderDpi),
      "-f",
      "1",
      "-l",
      String(context.options.pdf.maxRenderedPages),
      filePath,
      prefix
    ],
    {
      maxBuffer: 100 * 1024 * 1024
    }
  );

  const files = (await fs.readdir(pageDir))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort((a, b) => pageNumber(a) - pageNumber(b));

  return files.map((name) => ({
    imagePath: path.join(pageDir, name),
    pageNumber: pageNumber(name),
    sourcePath: filePath,
    relativePath
  }));
}

async function removeGeneratedPages(pageDir: string): Promise<void> {
  const entries = await fs.readdir(pageDir).catch(() => []);
  await Promise.all(
    entries.filter((name) => /^page-\d+\.png$/.test(name)).map((name) => fs.rm(path.join(pageDir, name), { force: true }))
  );
}

function imagePageInput(filePath: string, relativePath: string): OcrPageInput {
  return {
    imagePath: filePath,
    pageNumber: 1,
    sourcePath: filePath,
    relativePath
  };
}

async function scanOcrDirectory(dirPath: string, options: NormalizedOcrOptions): Promise<string[]> {
  const pattern = options.recursive ? "**/*" : "*";
  const files = await fg(pattern, {
    cwd: dirPath,
    absolute: true,
    onlyFiles: true,
    dot: options.includeHidden,
    ignore: options.ignore,
    followSymbolicLinks: false
  });

  return files.filter((filePath) => inputFormatForExtension(extensionOf(filePath)));
}

function inputFormatForExtension(ext: string): OcrInputFormat | undefined {
  if (ext === ".pdf") {
    return "pdf";
  }

  return OCR_INPUT_EXTENSIONS.includes(ext) ? "image" : undefined;
}

function pageNumber(name: string): number {
  const match = name.match(/page-(\d+)\.png$/);
  return match ? Number(match[1]) : 0;
}

async function asyncPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });

  await Promise.all(workers);
}

function isOcrContext(value: OcrContext | OcrOptions): value is OcrContext {
  return "rootPath" in value && "options" in value;
}

function average(values: Array<number | undefined>): number | undefined {
  const clean = values.filter((value): value is number => value !== undefined);
  if (clean.length === 0) {
    return undefined;
  }

  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

