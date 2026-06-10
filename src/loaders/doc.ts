import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileLoader } from "../types.js";
import { findExecutable, makeTempDir, runFile } from "../utils.js";
import { loadDocx } from "./docx.js";

export const loadDoc: FileLoader = async (filePath, context) => {
  const textutil = process.platform === "darwin" ? await findExecutable(["textutil"]) : undefined;
  if (textutil) {
    try {
      const { stdout, stderr } = await runFile(textutil, ["-convert", "txt", "-stdout", filePath]);
      return {
        text: stdout.trim(),
        markdown: stdout.trim(),
        warnings: [
          "Loaded legacy .doc through macOS textutil. Formatting and embedded images may be lost.",
          ...(stderr.trim() ? [stderr.trim()] : [])
        ],
        loader: "doc:textutil",
        mimeType: "application/msword"
      };
    } catch {
      // Fall through to LibreOffice conversion.
    }
  }

  const office = await findExecutable(["soffice", "libreoffice"]);
  if (office) {
    const tempDir = await makeTempDir("smart-loader-doc-");
    await runFile(office, ["--headless", "--convert-to", "docx", "--outdir", tempDir, filePath], {
      maxBuffer: 100 * 1024 * 1024
    });

    const converted = await findConvertedDocx(tempDir, filePath);
    if (converted) {
      const parsed = await loadDocx(converted, context);
      return {
        ...parsed,
        warnings: [
          "Converted legacy .doc to .docx through LibreOffice before loading.",
          ...(parsed.warnings ?? [])
        ],
        loader: "doc:libreoffice",
        mimeType: "application/msword"
      };
    }
  }

  throw new Error("Legacy .doc loading requires macOS textutil or LibreOffice/soffice to be installed.");
};

async function findConvertedDocx(tempDir: string, originalPath: string): Promise<string | undefined> {
  const expected = path.join(tempDir, `${path.basename(originalPath, path.extname(originalPath))}.docx`);
  try {
    await fs.access(expected);
    return expected;
  } catch {
    const fallback = (await fs.readdir(tempDir)).find((name) => name.toLowerCase().endsWith(".docx"));
    return fallback ? path.join(tempDir, fallback) : undefined;
  }
}
