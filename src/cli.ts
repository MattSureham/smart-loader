#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { Command } from "commander";
import { loadPath } from "./index.js";
import type { SmartLoaderOptions } from "./types.js";

const program = new Command();

program
  .name("smart-loader")
  .description("Load folders of mixed documents into LLM-friendly text, Markdown, assets, and chunks.")
  .argument("<path>", "File or folder to load")
  .option("-f, --format <format>", "Output format: json, jsonl, or markdown", "json")
  .option("-o, --out <path>", "Write output to a file instead of stdout")
  .option("--asset-dir <path>", "Directory for extracted assets")
  .option("--chunk-size <chars>", "Maximum chunk size in characters", parseInteger)
  .option("--chunk-overlap <chars>", "Chunk overlap in characters", parseInteger)
  .option("--concurrency <count>", "Number of files to load concurrently", parseInteger)
  .option("--max-file-size <mb>", "Maximum file size in megabytes", parseNumber)
  .option("--include-hidden", "Include hidden files")
  .option("--no-recursive", "Do not scan subdirectories")
  .option("--ignore <glob...>", "Additional ignore globs")
  .option("--csv-preview-rows <rows>", "Rows to render as a Markdown table before raw CSV", parseInteger)
  .option("--pdf-render-pages", "Render PDF pages as PNG assets when pdftoppm is installed")
  .option("--pdf-max-pages <pages>", "Maximum PDF pages to render", parseInteger)
  .option("--pdf-dpi <dpi>", "DPI for rendered PDF page images", parseInteger)
  .option("--fail-on-error", "Exit with code 1 if any file fails to load")
  .action(async (inputPath, cliOptions) => {
    const options: SmartLoaderOptions = {
      recursive: cliOptions.recursive,
      includeHidden: cliOptions.includeHidden,
      ignore: cliOptions.ignore,
      assetDir: cliOptions.assetDir,
      chunkSize: cliOptions.chunkSize,
      chunkOverlap: cliOptions.chunkOverlap,
      concurrency: cliOptions.concurrency,
      csvPreviewRows: cliOptions.csvPreviewRows,
      maxFileSizeBytes: cliOptions.maxFileSize ? Math.floor(cliOptions.maxFileSize * 1024 * 1024) : undefined,
      pdf: {
        renderPages: cliOptions.pdfRenderPages ?? false,
        maxRenderedPages: cliOptions.pdfMaxPages,
        renderDpi: cliOptions.pdfDpi
      }
    };

    const result = await loadPath(inputPath, options);
    const serialized = serialize(result, cliOptions.format);

    if (cliOptions.out) {
      await fs.writeFile(cliOptions.out, serialized);
    } else {
      process.stdout.write(serialized);
      if (!serialized.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }

    if (cliOptions.failOnError && result.errors.length > 0) {
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});

function serialize(result: Awaited<ReturnType<typeof loadPath>>, format: string): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(result, null, 2)}\n`;
    case "jsonl":
      return `${result.chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`;
    case "markdown":
      return result.documents
        .map((document) => `<!-- source: ${document.relativePath} -->\n\n${document.markdown.trim()}`)
        .join("\n\n---\n\n");
    default:
      throw new Error(`Unknown output format: ${format}. Expected json, jsonl, or markdown.`);
  }
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer, received ${value}`);
  }

  return parsed;
}

function parseNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, received ${value}`);
  }

  return parsed;
}
