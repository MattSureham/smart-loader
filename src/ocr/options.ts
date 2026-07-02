import path from "node:path";
import { DEFAULT_IGNORES } from "../options.js";
import type { NormalizedOcrOptions, OcrOptions } from "./types.js";

export const OCR_INPUT_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"];

export function normalizeOcrOptions(options: OcrOptions = {}): NormalizedOcrOptions {
  const chunkSize = options.chunkSize ?? 4000;
  const chunkOverlap = options.chunkOverlap ?? 300;

  if (chunkSize < 200) {
    throw new Error("OCR chunkSize must be at least 200 characters.");
  }

  if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error("OCR chunkOverlap must be non-negative and smaller than chunkSize.");
  }

  return {
    backend: options.backend ?? "tesseract",
    backendCommand: options.backendCommand,
    language: options.language,
    recursive: options.recursive ?? true,
    includeHidden: options.includeHidden ?? false,
    ignore: [...DEFAULT_IGNORES, ...(options.ignore ?? [])],
    maxFileSizeBytes: options.maxFileSizeBytes ?? 100 * 1024 * 1024,
    assetDir: path.resolve(options.assetDir ?? path.join(process.cwd(), ".smart-loader", "ocr-assets")),
    chunkSize,
    chunkOverlap,
    concurrency: Math.max(1, options.concurrency ?? 1),
    pdf: {
      maxRenderedPages: Math.max(1, options.pdf?.maxRenderedPages ?? 25),
      renderDpi: Math.max(72, options.pdf?.renderDpi ?? 192)
    }
  };
}

