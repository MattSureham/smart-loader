import type { FileLoader, SupportedFormat } from "./types.js";
import { loadDoc } from "./loaders/doc.js";
import { loadDocx } from "./loaders/docx.js";
import { loadPdf } from "./loaders/pdf.js";
import { loadCsv, loadHtml, loadJson, loadMarkdown, loadText } from "./loaders/text.js";

export const EXTENSION_TO_FORMAT = new Map<string, SupportedFormat>([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".txt", "text"],
  [".json", "json"],
  [".csv", "csv"],
  [".html", "html"],
  [".htm", "html"],
  [".pdf", "pdf"],
  [".docx", "docx"],
  [".doc", "doc"]
]);

export const FORMAT_LOADERS: Record<SupportedFormat, FileLoader> = {
  markdown: loadMarkdown,
  text: loadText,
  json: loadJson,
  csv: loadCsv,
  html: loadHtml,
  pdf: loadPdf,
  docx: loadDocx,
  doc: loadDoc
};

export const SUPPORTED_EXTENSIONS = [...EXTENSION_TO_FORMAT.keys()];
