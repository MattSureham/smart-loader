import { pathToFileURL } from "node:url";
import type { OcrResult } from "./types.js";

export function generateOcrPreviewHtml(result: OcrResult): string {
  const data = {
    rootPath: result.rootPath,
    backend: result.backend,
    documents: result.documents.map((document) => ({
      id: document.id,
      relativePath: document.relativePath,
      sourcePath: document.sourcePath,
      pages: document.pages.map((page) => ({
        pageNumber: page.pageNumber,
        imageUrl: pathToFileURL(page.imagePath).href,
        width: page.width,
        height: page.height
      }))
    })),
    chunks: result.chunks.map((chunk) => ({
      id: chunk.id,
      documentId: chunk.documentId,
      index: chunk.index,
      text: chunk.text,
      metadata: chunk.metadata
    }))
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>smart-loader OCR Preview</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #18202a;
      --muted: #667085;
      --line: #d7dce3;
      --accent: #0f766e;
      --accent-soft: rgba(15, 118, 110, 0.14);
      --mark: rgba(255, 196, 0, 0.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      letter-spacing: 0;
    }
    header {
      height: 52px;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    header h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 650;
    }
    header span {
      color: var(--muted);
      white-space: nowrap;
    }
    main {
      display: grid;
      grid-template-columns: minmax(300px, 34vw) minmax(0, 1fr);
      height: calc(100vh - 52px);
      min-height: 520px;
    }
    aside {
      overflow: auto;
      border-right: 1px solid var(--line);
      background: var(--panel);
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .toolbar input {
      width: 100%;
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      font: inherit;
    }
    .chunk {
      width: 100%;
      display: block;
      padding: 12px 14px;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    .chunk:hover,
    .chunk.active {
      background: var(--accent-soft);
    }
    .chunk-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .chunk-text {
      max-height: 92px;
      overflow: hidden;
      white-space: pre-wrap;
    }
    section.viewer {
      overflow: auto;
      padding: 18px;
    }
    .page-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
      color: var(--muted);
    }
    .page-head strong {
      color: var(--text);
      font-weight: 650;
    }
    .page-wrap {
      position: relative;
      width: fit-content;
      max-width: 100%;
      margin: 0 auto 24px;
      border: 1px solid var(--line);
      background: #fff;
      box-shadow: 0 14px 34px rgba(16, 24, 40, 0.10);
    }
    .page-wrap img {
      display: block;
      width: min(100%, 1100px);
      height: auto;
      max-height: none;
    }
    .bbox {
      position: absolute;
      border: 2px solid var(--accent);
      background: var(--mark);
      pointer-events: none;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9) inset;
    }
    .empty {
      height: 100%;
      display: grid;
      place-items: center;
      color: var(--muted);
      padding: 24px;
      text-align: center;
    }
    @media (max-width: 820px) {
      main {
        grid-template-columns: 1fr;
        grid-template-rows: 42vh 1fr;
      }
      aside {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      header span {
        display: none;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>smart-loader OCR Preview</h1>
    <span id="summary"></span>
  </header>
  <main>
    <aside>
      <div class="toolbar">
        <input id="filter" type="search" placeholder="Filter chunks">
      </div>
      <div id="chunks"></div>
    </aside>
    <section class="viewer" id="viewer">
      <div class="empty">Select a chunk to inspect its page bbox.</div>
    </section>
  </main>
  <script id="ocr-data" type="application/json">${json}</script>
  <script>
    const data = JSON.parse(document.getElementById("ocr-data").textContent);
    const chunksEl = document.getElementById("chunks");
    const viewerEl = document.getElementById("viewer");
    const filterEl = document.getElementById("filter");
    const summaryEl = document.getElementById("summary");
    const documents = new Map(data.documents.map((document) => [document.id, document]));
    let activeId = data.chunks[0]?.id;

    summaryEl.textContent = data.backend + " - " + data.documents.length + " documents - " + data.chunks.length + " chunks";

    function renderChunks() {
      const query = filterEl.value.trim().toLowerCase();
      const visible = data.chunks.filter((chunk) => {
        return !query || chunk.text.toLowerCase().includes(query) || chunk.metadata.relativePath.toLowerCase().includes(query);
      });
      chunksEl.innerHTML = "";
      for (const chunk of visible) {
        const button = document.createElement("button");
        button.className = "chunk" + (chunk.id === activeId ? " active" : "");
        button.type = "button";
        button.innerHTML = '<div class="chunk-title"><span></span><span></span></div><div class="chunk-text"></div>';
        button.querySelector(".chunk-title span:first-child").textContent = chunk.metadata.relativePath;
        button.querySelector(".chunk-title span:last-child").textContent = "p." + chunk.metadata.page;
        button.querySelector(".chunk-text").textContent = chunk.text;
        button.addEventListener("click", () => {
          activeId = chunk.id;
          renderChunks();
          renderViewer(chunk);
        });
        chunksEl.appendChild(button);
      }
      if (!activeId && visible[0]) {
        activeId = visible[0].id;
      }
    }

    function renderViewer(chunk) {
      const documentRecord = documents.get(chunk.documentId);
      const page = documentRecord?.pages.find((item) => item.pageNumber === chunk.metadata.page);
      if (!page) {
        viewerEl.innerHTML = '<div class="empty">No page image is available for this chunk.</div>';
        return;
      }

      viewerEl.innerHTML = '<div class="page-head"><div><strong></strong><span></span></div><a target="_blank" rel="noreferrer">Open image</a></div><div class="page-wrap"><img alt=""><div class="bbox"></div></div>';
      viewerEl.querySelector("strong").textContent = chunk.metadata.relativePath;
      viewerEl.querySelector(".page-head span").textContent = " - page " + chunk.metadata.page;
      viewerEl.querySelector("a").href = page.imageUrl;
      const img = viewerEl.querySelector("img");
      const box = viewerEl.querySelector(".bbox");
      img.src = page.imageUrl;
      img.alt = chunk.metadata.relativePath + " page " + chunk.metadata.page;

      function positionBox() {
        const bbox = chunk.metadata.bbox;
        if (!bbox || !img.naturalWidth || !img.naturalHeight) {
          box.style.display = "none";
          return;
        }

        box.style.display = "block";
        box.style.left = (bbox.x / img.naturalWidth * 100) + "%";
        box.style.top = (bbox.y / img.naturalHeight * 100) + "%";
        box.style.width = (bbox.width / img.naturalWidth * 100) + "%";
        box.style.height = (bbox.height / img.naturalHeight * 100) + "%";
      }

      img.addEventListener("load", positionBox, { once: true });
      if (img.complete) {
        positionBox();
      }
    }

    filterEl.addEventListener("input", renderChunks);
    renderChunks();
    if (data.chunks[0]) {
      renderViewer(data.chunks[0]);
    }
  </script>
</body>
</html>
`;
}
