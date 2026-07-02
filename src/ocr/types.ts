export type OcrBackendName = "tesseract" | "paddle" | "surya" | "doctr";

export type OcrInputFormat = "pdf" | "image";

export interface OcrBBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: "px";
}

export interface OcrBlock {
  id: string;
  text: string;
  markdown?: string;
  bbox: OcrBBox;
  confidence?: number;
  label?: string;
  readingOrder?: number;
  words?: OcrWord[];
}

export interface OcrWord {
  text: string;
  bbox: OcrBBox;
  confidence?: number;
}

export interface OcrPage {
  pageNumber: number;
  imagePath: string;
  width?: number;
  height?: number;
  text: string;
  markdown: string;
  blocks: OcrBlock[];
  warnings: string[];
  raw?: unknown;
}

export interface OcrChunk {
  id: string;
  documentId: string;
  text: string;
  markdown: string;
  index: number;
  metadata: {
    sourcePath: string;
    relativePath: string;
    format: OcrInputFormat;
    backend: OcrBackendName;
    page: number;
    bbox?: OcrBBox;
    pageImagePath?: string;
    tokenEstimate: number;
    startChar: number;
    endChar: number;
    confidence?: number;
    labels?: string[];
  };
}

export interface OcrDocument {
  id: string;
  sourcePath: string;
  relativePath: string;
  format: OcrInputFormat;
  backend: OcrBackendName;
  text: string;
  markdown: string;
  pages: OcrPage[];
  chunks: OcrChunk[];
  warnings: string[];
  metadata: {
    sizeBytes: number;
    modifiedAt: string;
    pageCount: number;
    [key: string]: unknown;
  };
}

export interface OcrError {
  sourcePath: string;
  reason: string;
  code?: string;
}

export interface OcrResult {
  rootPath: string;
  backend: OcrBackendName;
  documents: OcrDocument[];
  chunks: OcrChunk[];
  errors: OcrError[];
  summary: {
    discoveredFiles: number;
    loadedFiles: number;
    skippedFiles: number;
    failedFiles: number;
    pages: number;
    chunks: number;
  };
}

export interface OcrPdfOptions {
  maxRenderedPages?: number;
  renderDpi?: number;
}

export interface OcrOptions {
  backend?: OcrBackendName;
  backendCommand?: string;
  language?: string;
  recursive?: boolean;
  includeHidden?: boolean;
  ignore?: string[];
  maxFileSizeBytes?: number;
  assetDir?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  concurrency?: number;
  pdf?: OcrPdfOptions;
}

export interface NormalizedOcrOptions {
  backend: OcrBackendName;
  backendCommand?: string;
  language?: string;
  recursive: boolean;
  includeHidden: boolean;
  ignore: string[];
  maxFileSizeBytes: number;
  assetDir: string;
  chunkSize: number;
  chunkOverlap: number;
  concurrency: number;
  pdf: Required<OcrPdfOptions>;
}

export interface OcrContext {
  rootPath: string;
  options: NormalizedOcrOptions;
}

export interface OcrPageInput {
  imagePath: string;
  pageNumber: number;
  sourcePath: string;
  relativePath: string;
}

export interface OcrBackend {
  name: OcrBackendName;
  recognizePage(input: OcrPageInput, context: OcrContext): Promise<OcrPage>;
}

