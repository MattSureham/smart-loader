import path from "node:path";
import type { NormalizedSmartLoaderOptions, SmartLoaderOptions } from "./types.js";

export const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.smart-loader/**",
  "**/.DS_Store"
];

export function normalizeOptions(options: SmartLoaderOptions = {}): NormalizedSmartLoaderOptions {
  const chunkSize = options.chunkSize ?? 6000;
  const chunkOverlap = options.chunkOverlap ?? 500;

  if (chunkSize < 500) {
    throw new Error("chunkSize must be at least 500 characters.");
  }

  if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error("chunkOverlap must be non-negative and smaller than chunkSize.");
  }

  return {
    recursive: options.recursive ?? true,
    includeHidden: options.includeHidden ?? false,
    ignore: [...DEFAULT_IGNORES, ...(options.ignore ?? [])],
    maxFileSizeBytes: options.maxFileSizeBytes ?? 50 * 1024 * 1024,
    assetDir: path.resolve(options.assetDir ?? path.join(process.cwd(), ".smart-loader", "assets")),
    chunkSize,
    chunkOverlap,
    concurrency: Math.max(1, options.concurrency ?? 4),
    csvPreviewRows: Math.max(1, options.csvPreviewRows ?? 100),
    pdf: {
      renderPages: options.pdf?.renderPages ?? false,
      maxRenderedPages: Math.max(1, options.pdf?.maxRenderedPages ?? 25),
      renderDpi: Math.max(72, options.pdf?.renderDpi ?? 150)
    },
    describeAsset: options.describeAsset
  };
}
