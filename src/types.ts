export type SupportedFormat =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "docx"
  | "doc";

export type AssetKind = "image" | "page-image" | "attachment";

export interface LoaderAsset {
  id: string;
  kind: AssetKind;
  filePath: string;
  mimeType?: string;
  originalName?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  text: string;
  markdown: string;
  index: number;
  metadata: {
    sourcePath: string;
    relativePath: string;
    format: SupportedFormat;
    tokenEstimate: number;
    startChar: number;
    endChar: number;
  };
}

export interface LoadedDocument {
  id: string;
  sourcePath: string;
  relativePath: string;
  format: SupportedFormat;
  mimeType?: string;
  title?: string;
  text: string;
  markdown: string;
  chunks: DocumentChunk[];
  assets: LoaderAsset[];
  warnings: string[];
  metadata: {
    sizeBytes: number;
    modifiedAt: string;
    loader: string;
    [key: string]: unknown;
  };
}

export interface LoadError {
  sourcePath: string;
  reason: string;
  code?: string;
}

export interface LoadResult {
  rootPath: string;
  documents: LoadedDocument[];
  chunks: DocumentChunk[];
  errors: LoadError[];
  summary: {
    discoveredFiles: number;
    loadedFiles: number;
    skippedFiles: number;
    failedFiles: number;
    chunks: number;
    assets: number;
  };
}

export interface PdfOptions {
  renderPages?: boolean;
  maxRenderedPages?: number;
  renderDpi?: number;
}

export interface SmartLoaderOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  ignore?: string[];
  maxFileSizeBytes?: number;
  assetDir?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  concurrency?: number;
  csvPreviewRows?: number;
  pdf?: PdfOptions;
  describeAsset?: (asset: LoaderAsset, context: AssetDescriptionContext) => Promise<string | undefined>;
}

export interface NormalizedSmartLoaderOptions {
  recursive: boolean;
  includeHidden: boolean;
  ignore: string[];
  maxFileSizeBytes: number;
  assetDir: string;
  chunkSize: number;
  chunkOverlap: number;
  concurrency: number;
  csvPreviewRows: number;
  pdf: Required<PdfOptions>;
  describeAsset?: SmartLoaderOptions["describeAsset"];
}

export interface AssetDescriptionContext {
  sourcePath: string;
  relativePath: string;
  format: SupportedFormat;
}

export interface LoaderContext {
  rootPath: string;
  options: NormalizedSmartLoaderOptions;
}

export interface ParsedDocument {
  text: string;
  markdown?: string;
  assets?: LoaderAsset[];
  warnings?: string[];
  metadata?: Record<string, unknown>;
  title?: string;
  mimeType?: string;
  loader: string;
}

export type FileLoader = (filePath: string, context: LoaderContext) => Promise<ParsedDocument>;
