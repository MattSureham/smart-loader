import { createWriteStream, promises as fs } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { generateOcrPreviewHtml, loadPath, splitText } from "../src/index.js";
import { evaluateOcrRecords } from "../src/ocr/eval.js";
import type { OcrResult } from "../src/ocr/types.js";

describe("smart-loader", () => {
  it("loads text-native files from a folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smart-loader-test-"));
    await fs.writeFile(path.join(dir, "note.md"), "# Note\n\nHello world.");
    await fs.writeFile(path.join(dir, "data.json"), JSON.stringify({ ok: true, count: 2 }));
    await fs.writeFile(path.join(dir, "table.csv"), "name,score\nAda,10\nLinus,9\n");
    await fs.writeFile(path.join(dir, "image.png"), "not really an image");

    const result = await loadPath(dir, { chunkSize: 1000, chunkOverlap: 100 });

    expect(result.summary.discoveredFiles).toBe(3);
    expect(result.summary.loadedFiles).toBe(3);
    expect(result.documents.map((doc) => doc.relativePath).sort()).toEqual(["data.json", "note.md", "table.csv"]);
    expect(result.chunks.length).toBe(3);
    expect(result.documents.find((doc) => doc.relativePath === "table.csv")?.markdown).toContain("| name | score |");
  });

  it("splits long text with overlap", () => {
    const text = Array.from({ length: 100 }, (_, index) => `Sentence ${index}.`).join(" ");
    const chunks = splitText(text, 120, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endChar).toBeGreaterThan(chunks[1].startChar);
  });

  it("loads extractable PDF text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smart-loader-pdf-test-"));
    await writePdf(path.join(dir, "hello.pdf"), "Hello from a generated PDF.");

    const result = await loadPath(dir, { chunkSize: 1000, chunkOverlap: 100 });
    const document = result.documents.find((doc) => doc.relativePath === "hello.pdf");

    expect(result.errors).toEqual([]);
    expect(document?.format).toBe("pdf");
    expect(document?.text).toContain("Hello from a generated PDF.");
  });

  it("evaluates OCR predictions with traceability metadata", () => {
    const result = evaluateOcrRecords(
      [
        {
          id: "chunk-1",
          text: "Hello world",
          metadata: {
            relativePath: "scan.pdf",
            page: 1,
            bbox: { x: 10, y: 10, width: 100, height: 30, unit: "px" }
          }
        }
      ],
      [
        {
          id: "chunk-1",
          text: "Hello world",
          bbox: { x: 10, y: 10, width: 100, height: 30, unit: "px" }
        }
      ]
    );

    expect(result.charErrorRate).toBe(0);
    expect(result.wordErrorRate).toBe(0);
    expect(result.traceabilityRate).toBe(1);
    expect(result.bboxAccuracyAt50).toBe(1);
  });

  it("generates an OCR preview with embedded chunk data", () => {
    const preview = generateOcrPreviewHtml({
      rootPath: "/tmp",
      backend: "tesseract",
      documents: [
        {
          id: "doc-1",
          sourcePath: "/tmp/scan.pdf",
          relativePath: "scan.pdf",
          format: "pdf",
          backend: "tesseract",
          text: "Hello",
          markdown: "Hello",
          warnings: [],
          metadata: {
            sizeBytes: 10,
            modifiedAt: new Date(0).toISOString(),
            pageCount: 1
          },
          pages: [
            {
              pageNumber: 1,
              imagePath: "/tmp/page-1.png",
              width: 200,
              height: 100,
              text: "Hello",
              markdown: "Hello",
              blocks: [],
              warnings: []
            }
          ],
          chunks: [
            {
              id: "chunk-1",
              documentId: "doc-1",
              text: "Hello",
              markdown: "Hello",
              index: 0,
              metadata: {
                sourcePath: "/tmp/scan.pdf",
                relativePath: "scan.pdf",
                format: "pdf",
                backend: "tesseract",
                page: 1,
                bbox: { x: 10, y: 10, width: 100, height: 30, unit: "px" },
                pageImagePath: "/tmp/page-1.png",
                tokenEstimate: 2,
                startChar: 0,
                endChar: 5
              }
            }
          ]
        }
      ],
      chunks: [
        {
          id: "chunk-1",
          documentId: "doc-1",
          text: "Hello",
          markdown: "Hello",
          index: 0,
          metadata: {
            sourcePath: "/tmp/scan.pdf",
            relativePath: "scan.pdf",
            format: "pdf",
            backend: "tesseract",
            page: 1,
            bbox: { x: 10, y: 10, width: 100, height: 30, unit: "px" },
            pageImagePath: "/tmp/page-1.png",
            tokenEstimate: 2,
            startChar: 0,
            endChar: 5
          }
        }
      ],
      errors: [],
      summary: {
        discoveredFiles: 1,
        loadedFiles: 1,
        skippedFiles: 0,
        failedFiles: 0,
        pages: 1,
        chunks: 1
      }
    } satisfies OcrResult);

    expect(preview).toContain("smart-loader OCR Preview");
    expect(preview).toContain("chunk-1");
  });
});

async function writePdf(filePath: string, text: string): Promise<void> {
  const document = new PDFDocument();
  const stream = createWriteStream(filePath);
  document.pipe(stream);
  document.text(text);
  document.end();
  await once(stream, "finish");
}
