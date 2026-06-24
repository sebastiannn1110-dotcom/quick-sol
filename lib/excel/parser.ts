import * as XLSX from "xlsx";
import { detectCategory, detectDominantCategory } from "@/lib/excel/category-detector";
import { calculateDataQualityScore, detectRowQualityIssues, markDuplicateRecords } from "@/lib/excel/data-quality";
import { detectHeaderRow } from "@/lib/excel/header-detector";
import { buildSearchableText, normalizeRow, sanitizeScalar } from "@/lib/excel/normalizer";
import type {
  ParsedExcelRecord,
  ParsedExcelSheet,
  ParsedExcelWorkbook,
  RawCell
} from "@/lib/excel/types";
import { SECURITY_LIMITS } from "@/lib/security/env";
import type { JsonRecord } from "@/lib/types";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";

function isEmptyCell(value: unknown) {
  return value === null || value === undefined || String(value).trim() === "";
}

function isEmptyRow(row: unknown[]) {
  return row.every(isEmptyCell);
}

function buildRawRow(headers: string[], row: RawCell[]) {
  return headers.reduce<JsonRecord>((raw, header, index) => {
    if (!header) return raw;
    const value = sanitizeScalar(row[index]);
    if (value !== null) raw[header] = value;
    return raw;
  }, {});
}

function normalizeFileBuffer(fileBuffer: Buffer) {
  return XLSX.read(fileBuffer, {
    type: "buffer",
    cellDates: true,
    cellFormula: false,
    raw: false
  });
}

export async function parseExcelWorkbook(
  file: File,
  context?: LogContext
): Promise<ParsedExcelWorkbook> {
  const startedAt = performance.now();
  await logger.info({
    ...(context ?? { traceId: crypto.randomUUID() }),
    module: "excel-parser",
    action: "parser_started",
    message: "Excel parser started.",
    status: "started",
    fileName: file.name,
    metadata: { fileSize: file.size, fileType: file.type }
  });

  const buffer = Buffer.from(await file.arrayBuffer());
  let workbook: XLSX.WorkBook;
  try {
    workbook = normalizeFileBuffer(buffer);
    await logger.info({
      ...(context ?? { traceId: crypto.randomUUID() }),
      module: "excel-parser",
      action: "workbook_loaded",
      message: "Excel workbook loaded.",
      status: "completed",
      fileName: file.name,
      metadata: { sheetCount: workbook.SheetNames.length }
    });
  } catch (error) {
    await logger.error({
      ...(context ?? { traceId: crypto.randomUUID() }),
      module: "excel-parser",
      action: "workbook_load_failed",
      message: "Excel workbook failed to load.",
      status: "failed",
      fileName: file.name,
      error
    });
    throw error;
  }

  if (workbook.SheetNames.length > SECURITY_LIMITS.maxExcelSheets) {
    throw new Error(`Workbook exceeds the ${SECURITY_LIMITS.maxExcelSheets} sheet limit.`);
  }

  const sheets: ParsedExcelSheet[] = [];
  const allRecords: ParsedExcelRecord[] = [];
  let totalRows = 0;

  await logger.info({
    ...(context ?? { traceId: crypto.randomUUID() }),
    module: "excel-parser",
    action: "sheet_count_detected",
    message: "Workbook sheet count detected.",
    status: "completed",
    fileName: file.name,
    metadata: { sheetCount: workbook.SheetNames.length }
  });

  for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
    const sheetContext = context ? { ...context, sheetName } : undefined;
    await logger.info({
      ...(sheetContext ?? { traceId: crypto.randomUUID(), sheetName }),
      module: "excel-parser",
      action: "sheet_processing_started",
      message: "Sheet processing started.",
      status: "started",
      fileName: file.name,
      sheetName
    });

    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<RawCell[]>(worksheet, {
      header: 1,
      defval: null,
      blankrows: false,
      raw: false
    });

    const nonEmptyRows = rows.filter((row) => !isEmptyRow(row));
    if (!nonEmptyRows.length) {
      await logger.warn({
        ...(sheetContext ?? { traceId: crypto.randomUUID(), sheetName }),
        module: "excel-parser",
        action: "excel_empty_sheet_skipped",
        message: "Empty sheet skipped.",
        status: "completed",
        fileName: file.name,
        sheetName
      });
      continue;
    }

    const headerDetection = detectHeaderRow(nonEmptyRows, 30, sheetContext);
    const dataRows = nonEmptyRows.slice(headerDetection.headerRowIndex + 1);
    const sheetRecords: ParsedExcelRecord[] = [];
    let detailedRowWarningLogs = 0;
    let suppressedRowWarningLogs = 0;
    const maxDetailedRowWarningLogs = 100;
    const sheetIssues = headerDetection.confidence < 0.35
      ? [
          {
            errorType: "low_header_confidence",
            message: "Header detection confidence is low. Review mapping before trusting this import.",
            severity: "medium" as const
          }
        ]
      : [];

    for (const [rowOffset, row] of dataRows.entries()) {
      if (isEmptyRow(row)) continue;
      totalRows += 1;
      if (totalRows > SECURITY_LIMITS.maxExcelRows) {
        throw new Error(`Workbook exceeds the ${SECURITY_LIMITS.maxExcelRows} row limit.`);
      }

      const rawData = buildRawRow(headerDetection.headers, row);
      if (!Object.keys(rawData).length) continue;

      const rowIndex = headerDetection.headerRowIndex + rowOffset + 2;
      // High-volume row processing intentionally avoids per-row debug logs.
      // Significant row issues are logged below with row/column details.
      const normalized = normalizeRow(rawData);
      const categoryDetection = detectCategory(headerDetection.headers, normalized.columns);
      if (recordHasSignificantIssues(normalized.issues)) {
        if (detailedRowWarningLogs >= maxDetailedRowWarningLogs) {
          suppressedRowWarningLogs += 1;
        } else {
          detailedRowWarningLogs += 1;
          await logger.warn({
            ...(sheetContext ?? { traceId: crypto.randomUUID(), sheetName }),
            module: "normalizer",
            action: "row_normalization_warning",
            message: "Row normalization produced warnings.",
            status: "completed",
            fileName: file.name,
            sheetName,
            rowIndex,
            metadata: { issues: normalized.issues }
          });
        }
      }
      const qualityIssues = detectRowQualityIssues(categoryDetection.category, normalized.columns);
      const errors = [...normalized.issues, ...qualityIssues];
      const record: ParsedExcelRecord = {
        sourceSheet: sheetName,
        sheetIndex,
        rowIndex,
        rawData,
        normalizedData: normalized.normalizedData,
        columns: normalized.columns,
        category: categoryDetection.category,
        searchableText: buildSearchableText({
          rawData,
          normalizedData: normalized.normalizedData,
          category: categoryDetection.category
        }),
        hasErrors: errors.some((issue) => issue.severity !== "low"),
        errors
      };
      sheetRecords.push(record);
      allRecords.push(record);
    }

    const detectedCategory = detectDominantCategory(sheetRecords.map((record) => record.category));
    const invalidRows = sheetRecords.filter((record) => record.hasErrors).length;

    sheets.push({
      sheetName,
      sheetIndex,
      detectedHeaderRow: headerDetection.headerRowIndex + 1,
      detectedCategory,
      totalRows: sheetRecords.length,
      validRows: sheetRecords.length - invalidRows,
      invalidRows,
      records: sheetRecords,
      issues: sheetIssues,
      headers: headerDetection.headers,
      normalizedHeaders: headerDetection.normalizedHeaders
    });
    await logger.info({
      ...(sheetContext ?? { traceId: crypto.randomUUID(), sheetName }),
      module: "excel-parser",
      action: "sheet_processing_completed",
      message: "Sheet processing completed.",
      status: "completed",
      fileName: file.name,
      sheetName,
      category: detectedCategory,
      metadata: {
        totalRows: sheetRecords.length,
        validRows: sheetRecords.length - invalidRows,
        invalidRows,
        headerRow: headerDetection.headerRowIndex + 1,
        suppressedRowWarningLogs
      }
    });
  }

  markDuplicateRecords(allRecords);

  const invalidRows = allRecords.filter((record) => record.hasErrors).length;
  const errorCount =
    allRecords.reduce((sum, record) => sum + record.errors.length, 0) +
    sheets.reduce((sum, sheet) => sum + sheet.issues.length, 0);

  const result = {
    sheets,
    records: allRecords,
    totalRows: allRecords.length,
    validRows: allRecords.length - invalidRows,
    invalidRows,
    errorCount,
    detectedCategory: detectDominantCategory(allRecords.map((record) => record.category)),
    dataQualityScore: calculateDataQualityScore(allRecords)
  };

  await logger.info({
    ...(context ?? { traceId: crypto.randomUUID() }),
    module: "excel-parser",
    action: "parser_completed",
    message: "Excel parser completed.",
    status: "completed",
    durationMs: Math.round(performance.now() - startedAt),
    fileName: file.name,
    category: result.detectedCategory,
    metadata: {
      totalRows: result.totalRows,
      validRows: result.validRows,
      invalidRows: result.invalidRows,
      errorCount: result.errorCount,
      dataQualityScore: result.dataQualityScore
    }
  });

  return result;
}

function recordHasSignificantIssues(issues: { severity: string }[]) {
  return issues.some((issue) => issue.severity !== "low");
}
