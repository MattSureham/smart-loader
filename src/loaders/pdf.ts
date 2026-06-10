import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { FileLoader, LoaderAsset } from "../types.js";
import { assetDirForFile, findExecutable, mimeTypeForImageExtension, runFile, stableId } from "../utils.js";

export const loadPdf: FileLoader = async (filePath, context) => {
  const buffer = await fs.readFile(filePath);
  const warnings: string[] = [];
  const assets: LoaderAsset[] = [];
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let textResult: Awaited<ReturnType<PDFParse["getText"]>>;
  let infoResult: Awaited<ReturnType<PDFParse["getInfo"]>> | undefined;

  try {
    textResult = await parser.getText();
    try {
      infoResult = await parser.getInfo();
    } catch (error) {
      warnings.push(`PDF metadata extraction failed. ${(error as Error).message}`);
    }
  } finally {
    await parser.destroy();
  }

  const text = normalizePdfText(textResult.text);
  const info = infoResult?.info as Record<string, unknown> | undefined;
  const title = typeof info?.Title === "string" ? info.Title : path.basename(filePath);

  if (!text.trim()) {
    warnings.push("No extractable PDF text was found. The PDF may be scanned or image-heavy.");
  }

  if (context.options.pdf.renderPages) {
    const rendered = await renderPdfPages(filePath, context);
    warnings.push(...rendered.warnings);
    assets.push(...rendered.assets);
  } else {
    warnings.push("PDF images are not extracted by default. Enable pdf.renderPages and provide describeAsset for OCR or vision enrichment.");
  }

  return {
    text,
    markdown: `# ${title}\n\n${text}`,
    assets,
    warnings,
    metadata: {
      pages: textResult.total ?? infoResult?.total,
      info,
      fingerprints: infoResult?.fingerprints,
      permissions: infoResult?.permission
    },
    title,
    loader: "pdf",
    mimeType: "application/pdf"
  };
};

function normalizePdfText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

async function renderPdfPages(
  filePath: string,
  context: Parameters<FileLoader>[1]
): Promise<{ assets: LoaderAsset[]; warnings: string[] }> {
  const executable = await findExecutable(["pdftoppm"]);
  if (!executable) {
    return {
      assets: [],
      warnings: ["pdf.renderPages was requested, but pdftoppm was not found. Install Poppler to render PDF page images."]
    };
  }

  const assetDir = await assetDirForFile(filePath, context);
  const prefix = path.join(assetDir, "page");
  const maxPages = String(context.options.pdf.maxRenderedPages);
  const dpi = String(context.options.pdf.renderDpi);

  await runFile(executable, ["-png", "-r", dpi, "-f", "1", "-l", maxPages, filePath, prefix], {
    maxBuffer: 100 * 1024 * 1024
  });

  const files = (await fs.readdir(assetDir))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort((a, b) => pageNumber(a) - pageNumber(b));

  const assets = files.map((name) => {
    const file = path.join(assetDir, name);
    return {
      id: `asset_${stableId(`${filePath}:${name}`)}`,
      kind: "page-image" as const,
      filePath: file,
      mimeType: mimeTypeForImageExtension(path.extname(name)),
      originalName: name,
      metadata: {
        page: pageNumber(name)
      }
    };
  });

  return {
    assets,
    warnings: assets.length === Number(maxPages) ? [`Rendered the first ${maxPages} PDF pages as images.`] : []
  };
}

function pageNumber(name: string): number {
  const match = name.match(/page-(\d+)\.png$/);
  return match ? Number(match[1]) : 0;
}
