# smart-loader

`smart-loader` is a small, framework-agnostic loader for agent and LLM workflows.
It scans files or folders, converts supported formats into normalized text and
Markdown, extracts document assets when possible, and returns chunked records
that can be passed to any model, vector store, or agent framework.

## Supported formats

- Text-native: `.md`, `.markdown`, `.txt`, `.json`, `.csv`, `.html`, `.htm`
- Documents: `.pdf`, `.docx`
- Legacy Word: `.doc` through available system converters (`textutil` on macOS
  or LibreOffice/soffice when installed)

## Design

The core idea is to separate document loading from model-specific reasoning:

1. Scan a folder with conservative default ignores.
2. Route each file to a format loader.
3. Normalize output into `LoadedDocument`.
4. Extract images/assets when the format supports it.
5. Optionally call a user-provided `describeAsset` adapter for OCR or vision
   captioning.
6. Chunk the final Markdown/text for model context windows.

This keeps the package usable from LangChain, LlamaIndex, custom agents, shell
scripts, MCP servers, or any other runtime that can call a Node library or CLI.

## CLI

```bash
npm install
npm run build
node dist/cli.js ./docs --format json --out loaded.json
```

Other useful output formats:

```bash
node dist/cli.js ./docs --format jsonl --out chunks.jsonl
node dist/cli.js ./docs --format markdown --out corpus.md
```

PDF page rendering can be enabled when `pdftoppm` from Poppler is installed:

```bash
node dist/cli.js ./docs --pdf-render-pages --pdf-max-pages 10
```

## SDK

```ts
import { loadPath } from "@smart-loader/core";

const result = await loadPath("./docs", {
  chunkSize: 6000,
  chunkOverlap: 500,
  describeAsset: async (asset) => {
    // Plug in OCR, a vision model, or a framework-specific media reader here.
    return undefined;
  }
});

for (const chunk of result.chunks) {
  console.log(chunk.text);
}
```

Use `loadDirectory(path, options)` for directory-only callers and
`loadFile(path, options)` when the input is known to be a single file.

## Output shape

Each loaded file is represented as a `LoadedDocument` with:

- `text`: plain text where available
- `markdown`: model-friendly Markdown
- `assets`: extracted images or rendered PDF pages
- `chunks`: overlapping text chunks with metadata
- `warnings`: lossy conversion notes

The CLI returns a `LoadResult` containing all documents, flattened chunks,
recoverable errors, and a summary.
