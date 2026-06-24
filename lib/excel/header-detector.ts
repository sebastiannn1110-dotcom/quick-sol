import type { HeaderDetectionResult, RawCell } from "@/lib/excel/types";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";

export const HEADER_KEYWORDS = [
  "cliente",
  "client",
  "customer",
  "supplier",
  "supplier name",
  "mpn",
  "mpn quoted",
  "po",
  "qty",
  "quantity",
  "cost",
  "price",
  "total price",
  "gp",
  "gp rate",
  "commission",
  "comision",
  "line id",
  "description",
  "generic",
  "clean mfg",
  "req qty",
  "delivery",
  "delivery qto",
  "target to vendor",
  "target_to_vendor",
  "potential amount usd",
  "potential_amount_usd",
  "incoterm",
  "best price offered",
  "manufacturer quoted",
  "date code",
  "moq",
  "spq",
  "on hand",
  "lead time",
  "transit time",
  "earliest shipping date",
  "shipping point",
  "shipping point country",
  "delivery point",
  "comments",
  "manufacturer",
  "mfg",
  "warehouse",
  "stock",
  "inspection",
  "authenticity",
  "visual inspection",
  "electrical test",
  "product cost",
  "gross margin",
  "net profit"
];

export function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toSnakeCase(value: unknown) {
  return normalizeHeader(value).replace(/\s+/g, "_");
}

function isRecognizedHeader(value: string) {
  return HEADER_KEYWORDS.some((keyword) => {
    const normalizedKeyword = normalizeHeader(keyword);
    return value === normalizedKeyword || value.includes(normalizedKeyword);
  });
}

function scoreRow(row: RawCell[]) {
  const normalizedValues = row.map(normalizeHeader).filter(Boolean);
  const uniqueValues = new Set(normalizedValues);
  const recognizedColumns = normalizedValues.filter(isRecognizedHeader);
  const nonEmptyCount = normalizedValues.length;
  const duplicatePenalty = normalizedValues.length - uniqueValues.size;
  const score = recognizedColumns.length * 4 + Math.min(nonEmptyCount, 20) - duplicatePenalty;

  return {
    score,
    recognizedColumns,
    nonEmptyCount
  };
}

function makeUniqueHeaders(headers: string[]) {
  const seen = new Map<string, number>();

  return headers.map((header, index) => {
    const fallback = `column_${index + 1}`;
    const base = header || fallback;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function detectHeaderRow(
  rows: RawCell[][],
  scanLimit = 30,
  context?: LogContext
): HeaderDetectionResult {
  if (context) {
    void logger.debug({
      ...context,
      module: "header-detector",
      action: "header_detection_started",
      message: "Header detection started.",
      status: "started",
      metadata: { scanLimit, rowsAvailable: rows.length }
    });
  }

  const rowsToScan = rows.slice(0, scanLimit);
  let best = {
    rowIndex: 0,
    score: -1,
    recognizedColumns: [] as string[],
    nonEmptyCount: 0
  };

  rowsToScan.forEach((row, index) => {
    const scored = scoreRow(row);
    if (scored.score > best.score) {
      best = {
        rowIndex: index,
        ...scored
      };
    }
    if (context && scored.score > 0) {
      void logger.debug({
        ...context,
        module: "header-detector",
        action: "header_candidate_score",
        message: "Header candidate scored.",
        status: "completed",
        rowIndex: index + 1,
        metadata: {
          candidateRowIndex: index + 1,
          score: scored.score,
          matchedColumns: scored.recognizedColumns,
          totalColumns: scored.nonEmptyCount
        }
      });
    }
  });

  const rawHeaders = (rows[best.rowIndex] ?? []).map((cell, index) => {
    const normalized = normalizeHeader(cell);
    return normalized ? String(cell).trim() : `column_${index + 1}`;
  });
  const headers = makeUniqueHeaders(rawHeaders);
  const normalizedHeaders = makeUniqueHeaders(headers.map(toSnakeCase));
  const confidence = best.score <= 0 ? 0 : Math.min(1, best.score / Math.max(12, best.nonEmptyCount * 3));

  const result = {
    headerRowIndex: best.rowIndex,
    headers,
    normalizedHeaders,
    score: best.score,
    confidence,
    recognizedColumns: Array.from(new Set(best.recognizedColumns))
  };

  if (context) {
    void logger.info({
      ...context,
      module: "header-detector",
      action: confidence < 0.35 ? "header_confidence_low" : "header_selected",
      message:
        confidence < 0.35
          ? "Header selected with low confidence."
          : "Header row selected.",
      status: "completed",
      rowIndex: best.rowIndex + 1,
      metadata: {
        candidateRowIndex: best.rowIndex + 1,
        score: best.score,
        matchedColumns: result.recognizedColumns,
        totalColumns: headers.length,
        confidence
      }
    });
  }

  return result;
}
