import { readUtf8 } from "../utils.js";
import type { OcrBBox, OcrChunk } from "./types.js";

export interface OcrEvalRecord {
  id?: string;
  text?: string;
  tableMarkdown?: string;
  bbox?: OcrBBox;
  page?: number;
  relativePath?: string;
  chunkIndex?: number;
}

export interface OcrEvalResult {
  predictionCount: number;
  goldCount: number;
  charErrorRate?: number;
  wordErrorRate?: number;
  tableRestorationRate?: number;
  bboxMeanIoU?: number;
  bboxAccuracyAt50?: number;
  traceabilityRate: number;
}

export async function evaluateOcrFiles(predictionsPath: string, goldPath: string): Promise<OcrEvalResult> {
  const predictions = await readRecords(predictionsPath);
  const gold = await readRecords(goldPath);
  return evaluateOcrRecords(predictions, gold);
}

export function evaluateOcrRecords(predictions: unknown[], gold: unknown[]): OcrEvalResult {
  const predictionRecords = predictions.map(normalizePredictionRecord).filter((record): record is OcrEvalRecord => Boolean(record));
  const goldRecords = gold.map(normalizeGoldRecord).filter((record): record is OcrEvalRecord => Boolean(record));
  const predictionText = predictionRecords.map((record) => record.text ?? "").join("\n");
  const goldText = goldRecords.map((record) => record.text ?? "").join("\n");
  const traceable = predictionRecords.filter((record) => record.relativePath && record.page && record.bbox);
  const bboxPairs = matchByKey(predictionRecords, goldRecords).filter((pair) => pair.prediction.bbox && pair.gold.bbox);
  const bboxIous = bboxPairs.map((pair) => iou(pair.prediction.bbox!, pair.gold.bbox!));
  const tableGold = goldRecords.filter((record) => record.tableMarkdown);
  const tablePredictions = matchByKey(predictionRecords, tableGold)
    .map((pair) => tokenF1(pair.prediction.tableMarkdown ?? pair.prediction.text ?? "", pair.gold.tableMarkdown ?? ""))
    .filter((value) => value !== undefined) as number[];

  return {
    predictionCount: predictionRecords.length,
    goldCount: goldRecords.length,
    charErrorRate: goldText ? levenshtein([...predictionText], [...goldText]) / [...goldText].length : undefined,
    wordErrorRate: goldText ? levenshtein(words(predictionText), words(goldText)) / Math.max(1, words(goldText).length) : undefined,
    tableRestorationRate: tablePredictions.length > 0 ? average(tablePredictions) : undefined,
    bboxMeanIoU: bboxIous.length > 0 ? average(bboxIous) : undefined,
    bboxAccuracyAt50: bboxIous.length > 0 ? bboxIous.filter((score) => score >= 0.5).length / bboxIous.length : undefined,
    traceabilityRate: predictionRecords.length > 0 ? traceable.length / predictionRecords.length : 0
  };
}

async function readRecords(filePath: string): Promise<unknown[]> {
  const text = await readUtf8(filePath);
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      return recordsFromJson(json);
    } catch {
      // Fall through to JSONL parsing below.
    }
  }

  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function recordsFromJson(json: unknown): unknown[] {
  if (Array.isArray(json)) {
    return json;
  }

  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    if (Array.isArray(record.chunks)) {
      return record.chunks;
    }

    if (Array.isArray(record.documents)) {
      return record.documents.flatMap((document) => {
        if (document && typeof document === "object" && Array.isArray((document as Record<string, unknown>).chunks)) {
          return (document as Record<string, unknown>).chunks as unknown[];
        }

        return [];
      });
    }

    return [record];
  }

  return [];
}

function normalizePredictionRecord(value: unknown): OcrEvalRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Partial<OcrChunk> & Record<string, unknown>;
  const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {};

  return {
    id: stringValue(record.id),
    text: stringValue(record.text),
    tableMarkdown: stringValue(record.tableMarkdown) || stringValue(record.markdown),
    bbox: bboxValue(metadata.bbox ?? record.bbox),
    page: numberValue(metadata.page ?? record.page),
    relativePath: stringValue(metadata.relativePath ?? record.relativePath),
    chunkIndex: numberValue(record.index ?? metadata.index)
  };
}

function normalizeGoldRecord(value: unknown): OcrEvalRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    id: stringValue(record.id),
    text: stringValue(record.text),
    tableMarkdown: stringValue(record.tableMarkdown),
    bbox: bboxValue(record.bbox),
    page: numberValue(record.page),
    relativePath: stringValue(record.relativePath),
    chunkIndex: numberValue(record.chunkIndex ?? record.index)
  };
}

function matchByKey<T extends OcrEvalRecord, U extends OcrEvalRecord>(
  predictions: T[],
  gold: U[]
): Array<{ prediction: T; gold: U }> {
  const predictionMap = new Map<string, T>();
  for (const prediction of predictions) {
    const key = recordKey(prediction);
    if (key) {
      predictionMap.set(key, prediction);
    }
  }

  return gold.flatMap((goldRecord, index) => {
    const key = recordKey(goldRecord);
    const prediction = key ? predictionMap.get(key) : predictions[index];
    return prediction ? [{ prediction, gold: goldRecord }] : [];
  });
}

function recordKey(record: OcrEvalRecord): string | undefined {
  if (record.id) {
    return record.id;
  }

  if (record.relativePath && record.page !== undefined && record.chunkIndex !== undefined) {
    return `${record.relativePath}:${record.page}:${record.chunkIndex}`;
  }

  return undefined;
}

function levenshtein<T>(a: T[], b: T[]): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = Object.is(a[i - 1], b[j - 1]) ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }

    for (let j = 0; j < previous.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function tokenF1(prediction: string, gold: string): number | undefined {
  const predictionTokens = words(normalizeTableText(prediction));
  const goldTokens = words(normalizeTableText(gold));
  if (goldTokens.length === 0) {
    return undefined;
  }

  const counts = new Map<string, number>();
  for (const token of goldTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  let overlap = 0;
  for (const token of predictionTokens) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(token, count - 1);
    }
  }

  if (overlap === 0) {
    return 0;
  }

  const precision = overlap / Math.max(1, predictionTokens.length);
  const recall = overlap / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function normalizeTableText(text: string): string {
  return text.replace(/[|:-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function iou(a: OcrBBox, b: OcrBBox): number {
  const ax1 = a.x + a.width;
  const ay1 = a.y + a.height;
  const bx1 = b.x + b.width;
  const by1 = b.y + b.height;
  const ix = Math.max(0, Math.min(ax1, bx1) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay1, by1) - Math.max(a.y, b.y));
  const intersection = ix * iy;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function bboxValue(value: unknown): OcrBBox | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const x = numberValue(record.x);
  const y = numberValue(record.y);
  const width = numberValue(record.width);
  const height = numberValue(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }

  return { x, y, width, height, unit: "px" };
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
