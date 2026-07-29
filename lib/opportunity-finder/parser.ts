import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse";
import {
  classifyOpportunityWorkbook,
  opportunityHeaderScore
} from "@/lib/opportunity-finder/classifier";
import {
  findOpportunityHeaderColumn,
  findSafeOpportunityUnitColumn,
  normalizeOpportunityHeader,
  OPPORTUNITY_HEADER_ALIASES
} from "@/lib/opportunity-finder/aliases";
import {
  mpnIdentity,
  parseOpportunityQuantity,
  safeContextText
} from "@/lib/opportunity-finder/normalization";
import type {
  CanonicalOpportunityRow,
  OpportunitySelectedRole,
  OpportunitySheetProfile,
  OpportunityWarningCode,
  OpportunityWorkbookProfile
} from "@/lib/opportunity-finder/types";

type OpportunityCell = {
  text: string;
  value: unknown;
};

type ColumnMap = {
  mpn: number;
  quantity: number | null;
  manufacturer: number | null;
  customerContext: number | null;
  supplierContext: number | null;
  requiredDate: number | null;
  unitOfMeasure: number | null;
};

export type OpportunityParseMetrics = {
  totalRows: number;
  canonicalRows: number;
  missingMpnRows: number;
  invalidQuantityRows: number;
  negativeQuantityRows: number;
  sheets: Array<{ sheetName: string; rows: number; canonicalRows: number }>;
};

const MAX_PROFILE_ROWS_PER_SHEET = 40;
const DEFAULT_PARSE_BATCH_SIZE = 500;
const MAX_XLSX_FALLBACK_SIZE_BYTES = 16 * 1024 * 1024;

function quantityAliases(role: OpportunitySelectedRole) {
  if (role === "demand") return OPPORTUNITY_HEADER_ALIASES.demandQuantity;
  if (role === "stock") return OPPORTUNITY_HEADER_ALIASES.stockQuantity;
  if (role === "excess") return OPPORTUNITY_HEADER_ALIASES.excessQuantity;
  if (role === "supplier_offer") return OPPORTUNITY_HEADER_ALIASES.supplierQuantity;
  if (role === "received_history") return OPPORTUNITY_HEADER_ALIASES.receivedQuantity;
  return [] as const;
}

export function buildOpportunityColumnMap(
  headerValues: unknown[],
  role: OpportunitySelectedRole
): ColumnMap | null {
  if (role === "ignore") return null;
  const headers = headerValues.map(normalizeOpportunityHeader);
  const mpn = findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.mpn);
  if (mpn === null) return null;
  const quantity = findOpportunityHeaderColumn(headers, quantityAliases(role));
  if (!["received_history", "sales_history"].includes(role) && quantity === null) return null;
  return {
    mpn,
    quantity,
    manufacturer: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.manufacturer),
    customerContext: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.customerReference),
    supplierContext: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.supplierReference),
    requiredDate: findOpportunityHeaderColumn(headers, OPPORTUNITY_HEADER_ALIASES.requiredDate),
    unitOfMeasure: findSafeOpportunityUnitColumn(headers)
  };
}

function dateValue(cell: OpportunityCell | undefined) {
  if (!cell) return null;
  if (cell.value instanceof Date && Number.isFinite(cell.value.getTime())) {
    return cell.value.toISOString().slice(0, 10);
  }
  const text = safeContextText(cell.text, 40);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : text;
}

function cellAt(cells: OpportunityCell[], index: number | null) {
  return index === null ? undefined : cells[index];
}

function excelCell(cell: ExcelJS.Cell): OpportunityCell {
  let value: unknown = cell.value;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if ("result" in value) value = (value as ExcelJS.CellFormulaValue).result;
    else if ("text" in value) value = String((value as ExcelJS.CellHyperlinkValue).text);
    else if ("richText" in value) {
      value = (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
    }
  }
  const text = cell.text?.trim() || (value === null || value === undefined ? "" : String(value).trim());
  return { text, value };
}

function excelRowCells(row: ExcelJS.Row) {
  const cells: OpportunityCell[] = [];
  for (let index = 1; index <= row.cellCount; index += 1) {
    cells.push(excelCell(row.getCell(index)));
  }
  return cells;
}

function csvCells(row: unknown[]) {
  return row.map((value) => ({
    text: value === null || value === undefined ? "" : String(value).trim(),
    value
  }));
}

function sheetJsRows(worksheet: XLSX.WorkSheet) {
  const options = {
    header: 1,
    defval: null,
    blankrows: true
  } as const;
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    ...options,
    raw: true
  });
  const displayRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    ...options,
    raw: false
  });
  const startRow = worksheet["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]).s.r : 0;
  const rowCount = Math.max(rawRows.length, displayRows.length);

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const rawRow = rawRows[rowIndex] ?? [];
    const displayRow = displayRows[rowIndex] ?? [];
    const columnCount = Math.max(rawRow.length, displayRow.length);
    const cells = Array.from({ length: columnCount }, (_, columnIndex) => {
      const value = rawRow[columnIndex];
      const displayValue = displayRow[columnIndex];
      const textSource = displayValue ?? value;
      return {
        value,
        text: textSource === null || textSource === undefined ? "" : String(textSource).trim()
      };
    });
    return { rowNumber: startRow + rowIndex + 1, cells };
  });
}

async function readXlsxFallback(filePath: string) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_XLSX_FALLBACK_SIZE_BYTES) {
    throw new Error("OPPORTUNITY_XLSX_FALLBACK_TOO_LARGE");
  }
  return XLSX.readFile(filePath, {
    cellDates: true,
    dense: true,
    raw: true
  });
}

function rowIsEmpty(cells: OpportunityCell[]) {
  return cells.every((cell) => !cell.text);
}

function headerProfileRows(rows: Array<{ rowNumber: number; cells: OpportunityCell[] }>) {
  const found = rows
    .map((row) => ({ row, scored: opportunityHeaderScore(row.cells.map((cell) => cell.text)) }))
    .filter((item) => item.scored.isHeader)
    .map((item) => ({
      rowNumber: item.row.rowNumber,
      headers: item.row.cells.map((cell) => cell.text).filter(Boolean)
    }));
  if (found.length) return found;
  const best = rows
    .map((row) => ({ row, scored: opportunityHeaderScore(row.cells.map((cell) => cell.text)) }))
    .sort((left, right) => right.scored.score - left.scored.score)[0];
  return best && best.scored.score >= 8
    ? [{ rowNumber: best.row.rowNumber, headers: best.row.cells.map((cell) => cell.text).filter(Boolean) }]
    : [];
}

function extension(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

export async function validateOpportunityFileSignature(filePath: string, fileName: string) {
  const fileExtension = extension(fileName);
  const stat = await fs.promises.stat(filePath);
  if (!stat.size) throw new Error("OPPORTUNITY_FILE_EMPTY");
  const handle = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(stat.size, 8192));
    await handle.read(head, 0, head.length, 0);
    if (fileExtension === ".xlsx") {
      if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error("OPPORTUNITY_FILE_SIGNATURE_INVALID");
      const tailSize = Math.min(stat.size, 2 * 1024 * 1024);
      const tail = Buffer.alloc(tailSize);
      await handle.read(tail, 0, tailSize, stat.size - tailSize);
      if (/vbaProject\.bin|application\/vnd\.ms-office\.vbaProject/i.test(tail.toString("latin1"))) {
        throw new Error("OPPORTUNITY_FILE_MACRO_BLOCKED");
      }
    } else if (fileExtension === ".csv") {
      if (head.includes(0)) throw new Error("OPPORTUNITY_FILE_SIGNATURE_INVALID");
    } else {
      throw new Error("OPPORTUNITY_FILE_EXTENSION_INVALID");
    }
  } finally {
    await handle.close();
  }
}

async function profileXlsxStreaming(filePath: string, fileName: string) {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit"
  });
  const sheets: OpportunitySheetProfile[] = [];
  let totalRows = 0;

  for await (const worksheet of workbookReader) {
    const buffered: Array<{ rowNumber: number; cells: OpportunityCell[] }> = [];
    let rowCount = 0;
    for await (const row of worksheet) {
      const cells = excelRowCells(row);
      if (rowIsEmpty(cells)) continue;
      rowCount += 1;
      totalRows += 1;
      if (buffered.length < MAX_PROFILE_ROWS_PER_SHEET) {
        buffered.push({ rowNumber: row.number, cells });
      }
    }
    if (!rowCount) continue;
    sheets.push({
      sheetName: (worksheet as { name?: string }).name ?? `Sheet ${sheets.length + 1}`,
      rowCount,
      headerRows: headerProfileRows(buffered)
    });
  }
  return classifyOpportunityWorkbook({ fileName, sheets, rowCount: totalRows });
}

async function profileXlsxFallback(filePath: string, fileName: string) {
  const workbook = await readXlsxFallback(filePath);
  const sheets: OpportunitySheetProfile[] = [];
  let totalRows = 0;

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const rows = sheetJsRows(worksheet).filter((row) => !rowIsEmpty(row.cells));
    if (!rows.length) continue;
    totalRows += rows.length;
    sheets.push({
      sheetName,
      rowCount: rows.length,
      headerRows: headerProfileRows(rows.slice(0, MAX_PROFILE_ROWS_PER_SHEET))
    });
  }
  return classifyOpportunityWorkbook({ fileName, sheets, rowCount: totalRows });
}

async function profileXlsx(filePath: string, fileName: string) {
  try {
    const streamed = await profileXlsxStreaming(filePath, fileName);
    if (streamed.sheetCount > 0) return streamed;
  } catch {
    // Some valid XLSX writers order package entries in a way ExcelJS cannot stream.
  }
  return profileXlsxFallback(filePath, fileName);
}

async function profileCsv(filePath: string, fileName: string) {
  const parser = fs.createReadStream(filePath).pipe(parseCsv({
    relax_quotes: true,
    relax_column_count: true,
    bom: true
  }));
  const buffered: Array<{ rowNumber: number; cells: OpportunityCell[] }> = [];
  let rowCount = 0;
  for await (const row of parser) {
    const cells = csvCells(row as unknown[]);
    if (rowIsEmpty(cells)) continue;
    rowCount += 1;
    if (buffered.length < MAX_PROFILE_ROWS_PER_SHEET) {
      buffered.push({ rowNumber: rowCount, cells });
    }
  }
  return classifyOpportunityWorkbook({
    fileName,
    rowCount,
    sheets: rowCount ? [{
      sheetName: "CSV",
      rowCount,
      headerRows: headerProfileRows(buffered)
    }] : []
  });
}

export async function profileOpportunityWorkbook(
  filePath: string,
  fileName: string
): Promise<OpportunityWorkbookProfile> {
  await validateOpportunityFileSignature(filePath, fileName);
  return extension(fileName) === ".csv"
    ? profileCsv(filePath, fileName)
    : profileXlsx(filePath, fileName);
}

function buildCanonicalRow(input: {
  cells: OpportunityCell[];
  columns: ColumnMap;
  jobId: string;
  fileId: string;
  side: "A" | "B";
  fileName: string;
  sheetName: string;
  sourceRow: number;
  originalIndex: number;
  role: OpportunitySelectedRole;
}) {
  const mpnCell = input.cells[input.columns.mpn];
  const identity = mpnIdentity(mpnCell?.text ?? "");
  const quantityCell = cellAt(input.cells, input.columns.quantity);
  const quantity = parseOpportunityQuantity(quantityCell?.value ?? quantityCell?.text ?? null);
  const historical = input.role === "received_history" || input.role === "sales_history";
  const qualityFlags = new Set<OpportunityWarningCode>();
  if (!historical && !quantity.valid) {
    qualityFlags.add(input.role === "demand" ? "invalid_required_quantity" : "invalid_available_quantity");
  }
  if (!historical && quantity.negative) {
    if (input.role === "demand") {
      qualityFlags.add("invalid_required_quantity");
    } else {
      qualityFlags.add("negative_available_quantity");
      qualityFlags.add("invalid_available_quantity");
    }
  }
  const positiveQuantity =
    quantity.valid && quantity.value !== null && quantity.value > 0
      ? quantity.value
      : quantity.valid && quantity.value === 0
        ? 0
        : null;
  const manufacturer = safeContextText(cellAt(input.cells, input.columns.manufacturer)?.text);
  const customerContext = safeContextText(cellAt(input.cells, input.columns.customerContext)?.text);
  const supplierContext = safeContextText(cellAt(input.cells, input.columns.supplierContext)?.text);
  const unitOfMeasure = safeContextText(cellAt(input.cells, input.columns.unitOfMeasure)?.text, 40);
  if (!unitOfMeasure && !historical) qualityFlags.add("missing_unit");

  const row: CanonicalOpportunityRow = {
    jobId: input.jobId,
    fileId: input.fileId,
    side: input.side,
    fileName: input.fileName,
    sheetName: input.sheetName,
    sourceRow: input.sourceRow,
    originalIndex: input.originalIndex,
    recordRole: input.role,
    ...identity,
    manufacturer,
    customerContext,
    supplierContext,
    requiredQty: input.role === "demand" ? positiveQuantity : null,
    availableQty: ["stock", "supplier_offer", "received_history", "sales_history"].includes(input.role)
      ? positiveQuantity
      : null,
    excessQty: input.role === "excess" ? positiveQuantity : null,
    requiredDate: dateValue(cellAt(input.cells, input.columns.requiredDate)),
    unitOfMeasure,
    qualityFlags: Array.from(qualityFlags)
  };
  return { row, quantity };
}

async function parseRows(input: {
  rows: AsyncIterable<{ rowNumber: number; cells: OpportunityCell[] }>;
  sheetName: string;
  jobId: string;
  fileId: string;
  side: "A" | "B";
  fileName: string;
  role: OpportunitySelectedRole;
  metrics: OpportunityParseMetrics;
  batch: CanonicalOpportunityRow[];
  batchSize: number;
  onBatch: (rows: CanonicalOpportunityRow[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean>;
  nextIndex: () => number;
}) {
  let columns: ColumnMap | null = null;
  let sheetRows = 0;
  let sheetCanonicalRows = 0;
  for await (const { rowNumber, cells } of input.rows) {
    if (rowIsEmpty(cells)) continue;
    sheetRows += 1;
    input.metrics.totalRows += 1;
    const scored = opportunityHeaderScore(cells.map((cell) => cell.text));
    const candidateColumns = scored.isHeader
      ? buildOpportunityColumnMap(cells.map((cell) => cell.text), input.role)
      : null;
    if (candidateColumns) {
      columns = candidateColumns;
      continue;
    }
    if (!columns || input.role === "ignore") continue;

    const built = buildCanonicalRow({
      cells,
      columns,
      jobId: input.jobId,
      fileId: input.fileId,
      side: input.side,
      fileName: input.fileName,
      sheetName: input.sheetName,
      sourceRow: rowNumber,
      originalIndex: input.nextIndex(),
      role: input.role
    });
    if (!built.row.normalizedMpn) {
      if (built.quantity.value !== null) input.metrics.missingMpnRows += 1;
      continue;
    }
    if (!["received_history", "sales_history"].includes(input.role) && !built.quantity.valid) {
      input.metrics.invalidQuantityRows += 1;
    }
    if (built.quantity.negative) {
      input.metrics.negativeQuantityRows += 1;
      input.metrics.invalidQuantityRows += built.quantity.valid ? 1 : 0;
    }
    input.batch.push(built.row);
    input.metrics.canonicalRows += 1;
    sheetCanonicalRows += 1;
    if (input.batch.length >= input.batchSize) {
      if (input.shouldCancel && await input.shouldCancel()) throw new Error("OPPORTUNITY_JOB_CANCELLED");
      const ready = input.batch.splice(0, input.batch.length);
      await input.onBatch(ready);
    }
  }
  input.metrics.sheets.push({ sheetName: input.sheetName, rows: sheetRows, canonicalRows: sheetCanonicalRows });
}

async function parseXlsx(input: ParseOpportunityWorkbookInput, metrics: OpportunityParseMetrics) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input.filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit"
  });
  const batch: CanonicalOpportunityRow[] = [];
  let originalIndex = 0;
  try {
    for await (const worksheet of reader) {
      const sheetName = (worksheet as { name?: string }).name ?? `Sheet ${metrics.sheets.length + 1}`;
      async function* rows() {
        for await (const row of worksheet) {
          yield { rowNumber: row.number, cells: excelRowCells(row) };
        }
      }
      await parseRows({
        rows: rows(),
        sheetName,
        jobId: input.jobId,
        fileId: input.fileId,
        side: input.side,
        fileName: input.fileName,
        role: input.role,
        metrics,
        batch,
        batchSize: input.batchSize ?? DEFAULT_PARSE_BATCH_SIZE,
        onBatch: input.onBatch,
        shouldCancel: input.shouldCancel,
        nextIndex: () => originalIndex++
      });
    }
  } catch (error) {
    if (metrics.totalRows > 0) throw error;
  }
  if (metrics.totalRows > 0) {
    if (batch.length) await input.onBatch(batch.splice(0, batch.length));
    return;
  }

  metrics.sheets.length = 0;
  const workbook = await readXlsxFallback(input.filePath);
  originalIndex = 0;
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    async function* rows() {
      for (const row of sheetJsRows(worksheet)) yield row;
    }
    await parseRows({
      rows: rows(),
      sheetName,
      jobId: input.jobId,
      fileId: input.fileId,
      side: input.side,
      fileName: input.fileName,
      role: input.role,
      metrics,
      batch,
      batchSize: input.batchSize ?? DEFAULT_PARSE_BATCH_SIZE,
      onBatch: input.onBatch,
      shouldCancel: input.shouldCancel,
      nextIndex: () => originalIndex++
    });
  }
  if (batch.length) await input.onBatch(batch.splice(0, batch.length));
}

async function parseCsvFile(input: ParseOpportunityWorkbookInput, metrics: OpportunityParseMetrics) {
  const parser = fs.createReadStream(input.filePath).pipe(parseCsv({
    relax_quotes: true,
    relax_column_count: true,
    bom: true
  }));
  async function* rows() {
    let rowNumber = 0;
    for await (const row of parser) {
      rowNumber += 1;
      yield { rowNumber, cells: csvCells(row as unknown[]) };
    }
  }
  const batch: CanonicalOpportunityRow[] = [];
  let originalIndex = 0;
  await parseRows({
    rows: rows(),
    sheetName: "CSV",
    jobId: input.jobId,
    fileId: input.fileId,
    side: input.side,
    fileName: input.fileName,
    role: input.role,
    metrics,
    batch,
    batchSize: input.batchSize ?? DEFAULT_PARSE_BATCH_SIZE,
    onBatch: input.onBatch,
    shouldCancel: input.shouldCancel,
    nextIndex: () => originalIndex++
  });
  if (batch.length) await input.onBatch(batch.splice(0, batch.length));
}

export type ParseOpportunityWorkbookInput = {
  filePath: string;
  fileName: string;
  fileId: string;
  jobId: string;
  side: "A" | "B";
  role: OpportunitySelectedRole;
  batchSize?: number;
  onBatch: (rows: CanonicalOpportunityRow[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean>;
};

export async function parseOpportunityWorkbook(
  input: ParseOpportunityWorkbookInput
): Promise<OpportunityParseMetrics> {
  await validateOpportunityFileSignature(input.filePath, input.fileName);
  const metrics: OpportunityParseMetrics = {
    totalRows: 0,
    canonicalRows: 0,
    missingMpnRows: 0,
    invalidQuantityRows: 0,
    negativeQuantityRows: 0,
    sheets: []
  };
  if (input.role === "ignore") return metrics;
  if (extension(input.fileName) === ".csv") await parseCsvFile(input, metrics);
  else await parseXlsx(input, metrics);
  return metrics;
}
