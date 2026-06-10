import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { buildChunks } from "./chunk.js";
import { normalizeOptions } from "./options.js";
import { EXTENSION_TO_FORMAT, FORMAT_LOADERS, SUPPORTED_EXTENSIONS } from "./registry.js";
import type {
  LoadedDocument,
  LoaderAsset,
  LoaderContext,
  LoadError,
  LoadResult,
  ParsedDocument,
  SmartLoaderOptions
} from "./types.js";
import { documentId, extensionOf } from "./utils.js";

export type * from "./types.js";
export { SUPPORTED_EXTENSIONS };
export { splitText } from "./chunk.js";

export async function loadPath(inputPath: string, options: SmartLoaderOptions = {}): Promise<LoadResult> {
  const absolutePath = path.resolve(inputPath);
  const stat = await fs.stat(absolutePath);
  const normalizedOptions = normalizeOptions(options);
  const rootPath = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
  const context: LoaderContext = {
    rootPath,
    options: normalizedOptions
  };

  const files = stat.isDirectory() ? await scanDirectory(absolutePath, normalizedOptions) : [absolutePath];
  const documents: LoadedDocument[] = [];
  const errors: LoadError[] = [];

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

      const document = await loadFile(filePath, context);
      documents.push(document);
    } catch (error) {
      errors.push({
        sourcePath: filePath,
        reason: (error as Error).message,
        code: "load_failed"
      });
    }
  });

  documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const chunks = documents.flatMap((document) => document.chunks);

  return {
    rootPath,
    documents,
    chunks,
    errors,
    summary: {
      discoveredFiles: files.length,
      loadedFiles: documents.length,
      skippedFiles: 0,
      failedFiles: errors.length,
      chunks: chunks.length,
      assets: documents.reduce((sum, document) => sum + document.assets.length, 0)
    }
  };
}

export async function loadDirectory(dirPath: string, options: SmartLoaderOptions = {}): Promise<LoadResult> {
  const absolutePath = path.resolve(dirPath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`Expected a directory: ${absolutePath}`);
  }

  return loadPath(absolutePath, options);
}

export async function loadFile(filePath: string, contextOrOptions: LoaderContext | SmartLoaderOptions = {}): Promise<LoadedDocument> {
  const absolutePath = path.resolve(filePath);
  const context = isLoaderContext(contextOrOptions)
    ? contextOrOptions
    : {
        rootPath: path.dirname(absolutePath),
        options: normalizeOptions(contextOrOptions)
      };

  const ext = extensionOf(absolutePath);
  const format = EXTENSION_TO_FORMAT.get(ext);
  if (!format) {
    throw new Error(`Unsupported file extension: ${ext || "(none)"}`);
  }

  const loader = FORMAT_LOADERS[format];
  const parsed = await loader(absolutePath, context);
  const stat = await fs.stat(absolutePath);
  const relativePath = path.relative(context.rootPath, absolutePath) || path.basename(absolutePath);
  await describeAssets(parsed.assets ?? [], absolutePath, relativePath, format, context);

  let markdown = parsed.markdown ?? parsed.text;
  if (parsed.assets?.some((asset) => asset.description)) {
    markdown = appendAssetDescriptions(markdown, parsed.assets);
  }

  const documentBase: Omit<LoadedDocument, "chunks"> = {
    id: documentId(absolutePath, context.rootPath),
    sourcePath: absolutePath,
    relativePath,
    format,
    mimeType: parsed.mimeType,
    title: parsed.title,
    text: parsed.text,
    markdown,
    assets: parsed.assets ?? [],
    warnings: parsed.warnings ?? [],
    metadata: {
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      loader: parsed.loader,
      ...(parsed.metadata ?? {})
    }
  };

  return {
    ...documentBase,
    chunks: buildChunks(documentBase, context.options.chunkSize, context.options.chunkOverlap)
  };
}

async function scanDirectory(dirPath: string, options: ReturnType<typeof normalizeOptions>): Promise<string[]> {
  const pattern = options.recursive ? "**/*" : "*";
  const files = await fg(pattern, {
    cwd: dirPath,
    absolute: true,
    onlyFiles: true,
    dot: options.includeHidden,
    ignore: options.ignore,
    followSymbolicLinks: false
  });

  return files.filter((filePath) => EXTENSION_TO_FORMAT.has(extensionOf(filePath)));
}

async function describeAssets(
  assets: LoaderAsset[],
  sourcePath: string,
  relativePath: string,
  format: LoadedDocument["format"],
  context: LoaderContext
): Promise<void> {
  if (!context.options.describeAsset) {
    return;
  }

  for (const asset of assets) {
    const description = await context.options.describeAsset(asset, {
      sourcePath,
      relativePath,
      format
    });

    if (description?.trim()) {
      asset.description = description.trim();
    }
  }
}

function appendAssetDescriptions(markdown: string, assets: LoaderAsset[]): string {
  const described = assets.filter((asset) => asset.description);
  if (described.length === 0) {
    return markdown;
  }

  const section = described
    .map((asset, index) => {
      const label = asset.originalName ?? `asset-${index + 1}`;
      return `- ${label}: ${asset.description}`;
    })
    .join("\n");

  return `${markdown.trim()}\n\n## Extracted Asset Notes\n\n${section}\n`;
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

function isLoaderContext(value: LoaderContext | SmartLoaderOptions): value is LoaderContext {
  return "rootPath" in value && "options" in value;
}
