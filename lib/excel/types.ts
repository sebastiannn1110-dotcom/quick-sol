import type { JsonPrimitive, JsonRecord, PlatformRecordColumns } from "@/lib/types";

export interface HeaderDetectionResult {
  headerRowIndex: number;
  headers: string[];
  normalizedHeaders: string[];
  score: number;
  confidence: number;
  recognizedColumns: string[];
}

export interface ImportIssue {
  columnName?: string | null;
  errorType: string;
  message: string;
  rawValue?: string | null;
  severity: "low" | "medium" | "high" | "critical";
}

export interface ParsedExcelRecord {
  sourceSheet: string;
  sheetIndex: number;
  rowIndex: number;
  rawData: JsonRecord;
  normalizedData: JsonRecord;
  columns: PlatformRecordColumns;
  category: string;
  searchableText: string;
  hasErrors: boolean;
  errors: ImportIssue[];
}

export interface ParsedExcelSheet {
  sheetName: string;
  sheetIndex: number;
  detectedHeaderRow: number;
  detectedCategory: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  records: ParsedExcelRecord[];
  issues: ImportIssue[];
  headers: string[];
  normalizedHeaders: string[];
}

export interface ParsedExcelWorkbook {
  sheets: ParsedExcelSheet[];
  records: ParsedExcelRecord[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errorCount: number;
  detectedCategory: string;
  dataQualityScore: number;
}

export type RawCell = JsonPrimitive | Date | undefined;
