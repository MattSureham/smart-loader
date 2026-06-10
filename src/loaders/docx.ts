import { promises as fs } from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import TurndownService from "turndown";
import type { FileLoader, LoaderAsset } from "../types.js";
import { assetDirForFile, extensionForMimeType, stableId } from "../utils.js";

export const loadDocx: FileLoader = async (filePath, context) => {
  const assets: LoaderAsset[] = [];
  const assetDir = await assetDirForFile(filePath, context);
  let imageIndex = 0;

  const result = await mammoth.convertToHtml(
    { path: filePath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        imageIndex += 1;
        const buffer = await image.read("buffer");
        const ext = extensionForMimeType(image.contentType);
        const fileName = `image-${String(imageIndex).padStart(3, "0")}${ext}`;
        const outputPath = path.join(assetDir, fileName);
        await fs.writeFile(outputPath, buffer);

        const asset: LoaderAsset = {
          id: `asset_${stableId(`${filePath}:${imageIndex}`)}`,
          kind: "image",
          filePath: outputPath,
          mimeType: image.contentType,
          originalName: fileName,
          metadata: {
            index: imageIndex
          }
        };
        assets.push(asset);

        return {
          src: outputPath,
          alt: `Extracted image ${imageIndex}`
        };
      })
    }
  );

  const raw = await mammoth.extractRawText({ path: filePath });
  const turndown = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" });
  const markdown = turndown.turndown(result.value);

  return {
    text: raw.value.trim() || markdown,
    markdown,
    assets,
    warnings: result.messages.map((message) => `${message.type}: ${message.message}`),
    metadata: {
      extractedImages: assets.length
    },
    loader: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
};
