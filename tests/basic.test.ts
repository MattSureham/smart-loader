import { createWriteStream, promises as fs } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { loadPath, splitText } from "../src/index.js";

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
});

async function writePdf(filePath: string, text: string): Promise<void> {
  const document = new PDFDocument();
  const stream = createWriteStream(filePath);
  document.pipe(stream);
  document.text(text);
  document.end();
  await once(stream, "finish");
}
