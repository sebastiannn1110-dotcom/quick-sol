import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse";
import {
  buildOpportunityAdapterColumnMap,
  buildOpportunityDemandEventKey,
  detectOpportunityTemplate,
  excelColumnName,
  opportunityTemplateHasEmbeddedOffers,
  opportunityColumnMappings,
  type OpportunityAdapterColumnMap
} from "@/lib/opportunity-finder/adapters";
import {
  classifyOpportunityWorkbook,
  opportunityHeaderScore
} from "@/lib/opportunity-finder/classifier";
import { normalizeOpportunityHeader } from "@/lib/opportunity-finder/aliases";
import {
  isOpportunityExcelError,
  manufacturerIdentity,
  mpnIdentity,
  parseOpportunityQuantity,
  safeContextText
} from "@/lib/opportunity-finder/normalization";
import {
  opportunityFinderMaxCompressionRatio,
  opportunityFinderMaxFileSizeBytes,
  opportunityFinderMaxRowsPerFile,
  opportunityFinderMaxXlsxEntries,
  opportunityFinderMaxXlsxUncompressedBytes,
  opportunityFinderXlsxStreamingThresholdBytes
} from "@/lib/opportunity-finder/validation";
import type {
  CanonicalOpportunityRow,
  OpportunityRejectedRow,
  OpportunitySelectedRole,
  OpportunitySheetProfile,
  OpportunityTemplateType,
  OpportunityWarningCode,
  OpportunityWorkbookProfile
} from "@/lib/opportunity-finder/types";

type OpportunityCell = {
  text: string;
  value: unknown;
  formula: boolean;
  cachedFormulaValue: boolean;
  error: boolean;
  hyperlink: boolean;
};

type OpportunitySourceRow = {
  rowNumber: number;
  cells: OpportunityCell[];
  hidden: boolean;
};

export type OpportunityParseMetrics = {
  totalRows: number;
  canonicalRows: number;
  missingMpnRows: number;
  invalidQuantityRows: number;
  negativeQuantityRows: number;
  hiddenRows: number;
  formulaCellsIgnored: number;
  formulaCachedValuesUsed: number;
  errorCellsIgnored: number;
  demandEvents: number;
  demandPartOptions: number;
  supplyLots: number;
  historicalSignals: number;
  rejectedRows: number;
  sheets: Array<{
    sheetName: string;
    rows: number;
    canonicalRows: number;
    hiddenRows: number;
    headerRow: number | null;
    templateType: OpportunityTemplateType;
  }>;
};

export type OpportunityXlsxPackageInspection = {
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  hasExternalLinks: boolean;
  hasConnections: boolean;
};

const MAX_PROFILE_SCAN_ROWS_PER_SHEET = 64;
const MAX_PROFILE_SAMPLED_ROWS_PER_SHEET = 192;
const MAX_PREVIEW_ROWS = 5;
const MAX_PREVIEW_COLUMNS = 40;
const MAX_PREVIEW_CELL_LENGTH = 180;
const DEFAULT_PARSE_BATCH_SIZE = 500;
const MAX_XLSX_FALLBACK_SIZE_BYTES = 16 * 1024 * 1024;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 65_535;

function extension(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

function safeSpreadsheetText(value: unknown, max = 1_000) {
  return safeContextText(value, max) ?? "";
}

function ignoredCell(input: Partial<OpportunityCell> = {}): OpportunityCell {
  return {
    text: "",
    value: null,
    formula: Boolean(input.formula),
    cachedFormulaValue: Boolean(input.cachedFormulaValue),
    error: Boolean(input.error),
    hyperlink: Boolean(input.hyperlink)
  };
}

function normalizedCell(value: unknown, displayValue?: unknown): OpportunityCell {
  const candidate = displayValue ?? value;
  if (isOpportunityExcelError(candidate) || isOpportunityExcelError(value)) {
    return ignoredCell({ error: true });
  }
  const text = safeSpreadsheetText(candidate);
  if (text.startsWith("=")) return ignoredCell({ formula: true });
  return { text, value, formula: false, cachedFormulaValue: false, error: false, hyperlink: false };
}

function cachedFormulaCell(value: unknown, displayValue?: unknown): OpportunityCell {
  const converted = normalizedCell(value, displayValue);
  if (converted.error || converted.formula || !converted.text) {
    return ignoredCell({ formula: true, error: converted.error });
  }
  return { ...converted, formula: true, cachedFormulaValue: true };
}

function cellHasUsableValue(cell: OpportunityCell | null | undefined): cell is OpportunityCell {
  return Boolean(cell && !cell.error && (!cell.formula || cell.cachedFormulaValue));
}

function excelCell(cell: ExcelJS.Cell): OpportunityCell {
  const raw = cell.value;
  if (raw && typeof raw === "object" && !(raw instanceof Date)) {
    if ("formula" in raw || "sharedFormula" in raw) {
      const result = "result" in raw ? raw.result : null;
      const cachedError = Boolean(
        isOpportunityExcelError(result) ||
        (result && typeof result === "object" && "error" in result)
      );
      return cachedError || result === null || result === undefined
        ? ignoredCell({ formula: true, error: cachedError })
        : cachedFormulaCell(result);
    }
    if ("error" in raw) return ignoredCell({ error: true });
    if ("hyperlink" in raw) {
      const text = safeSpreadsheetText((raw as ExcelJS.CellHyperlinkValue).text);
      return isOpportunityExcelError(text)
        ? ignoredCell({ error: true, hyperlink: true })
        : {
            text,
            value: text,
            formula: false,
            cachedFormulaValue: false,
            error: false,
            hyperlink: true
          };
    }
    if ("richText" in raw) {
      const value = (raw as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
      return normalizedCell(value);
    }
  }
  return normalizedCell(raw, cell.text || undefined);
}

function excelRowCells(row: ExcelJS.Row) {
  const cells: OpportunityCell[] = [];
  for (let index = 1; index <= row.cellCount; index += 1) {
    cells.push(excelCell(row.getCell(index)));
  }
  return cells;
}

function csvCells(row: unknown[]) {
  return row.map((value) => normalizedCell(value));
}

function sheetJsCell(cell: XLSX.CellObject): OpportunityCell {
  if (cell.f) {
    const cachedError = cell.t === "e" || isOpportunityExcelError(cell.v) || isOpportunityExcelError(cell.w);
    return cachedError || cell.v === null || cell.v === undefined
      ? ignoredCell({ formula: true, error: cachedError })
      : cachedFormulaCell(cell.v, cell.w);
  }
  if (cell.t === "e") return ignoredCell({ error: true });
  const converted = normalizedCell(cell.v, cell.w);
  if (cell.l) converted.hyperlink = true;
  return converted;
}

function* sheetJsRows(worksheet: XLSX.WorkSheet): Generator<OpportunitySourceRow> {
  let currentRow = -1;
  let columns = new Map<number, OpportunityCell>();
  const rowMetadata = worksheet["!rows"] as Array<{ hidden?: boolean } | undefined> | undefined;

  function sourceRow(zeroBasedRow: number, rowCells: Map<number, OpportunityCell>) {
    const maxColumn = Math.max(...rowCells.keys());
    return {
      rowNumber: zeroBasedRow + 1,
      cells: Array.from({ length: maxColumn + 1 }, (_, index) =>
        rowCells.get(index) ?? ignoredCell()
      ),
      hidden: Boolean(rowMetadata?.[zeroBasedRow]?.hidden)
    };
  }

  for (const address in worksheet) {
    const candidate = worksheet[address];
    if (address.startsWith("!") || !/^[A-Z]+\d+$/.test(address) || !candidate) continue;
    const position = XLSX.utils.decode_cell(address);
    if (currentRow >= 0 && position.r < currentRow) {
      throw new Error("OPPORTUNITY_XLSX_CELL_ORDER_INVALID");
    }
    if (currentRow >= 0 && position.r !== currentRow) {
      yield sourceRow(currentRow, columns);
      columns = new Map<number, OpportunityCell>();
    }
    currentRow = position.r;
    const cell = sheetJsCell(candidate as XLSX.CellObject);
    columns.set(position.c, cell);
  }
  if (currentRow >= 0 && columns.size > 0) yield sourceRow(currentRow, columns);
}

async function readXlsxFallback(filePath: string) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_XLSX_FALLBACK_SIZE_BYTES) {
    throw new Error("OPPORTUNITY_XLSX_FALLBACK_TOO_LARGE");
  }
  return XLSX.readFile(filePath, {
    cellDates: true,
    cellStyles: true,
    dense: false,
    raw: true,
    bookVBA: false,
    bookDeps: false
  });
}

function rowIsEmpty(cells: OpportunityCell[]) {
  return cells.every((cell) => !cell.text && !cell.formula && !cell.error);
}

class ProfileRowSampler {
  readonly rows: OpportunitySourceRow[] = [];
  private captureUntilRow = -1;

  add(row: OpportunitySourceRow) {
    const isHeader = opportunityHeaderScore(row.cells.map((cell) => cell.text)).isHeader;
    if (isHeader) this.captureUntilRow = Math.max(this.captureUntilRow, row.rowNumber + MAX_PREVIEW_ROWS);
    if (
      this.rows.length < MAX_PROFILE_SCAN_ROWS_PER_SHEET ||
      isHeader ||
      row.rowNumber <= this.captureUntilRow
    ) {
      if (this.rows.length < MAX_PROFILE_SAMPLED_ROWS_PER_SHEET) this.rows.push(row);
    }
  }
}

function headerProfileRows(rows: OpportunitySourceRow[]) {
  const scored = rows.map((row) => ({
    row,
    scored: opportunityHeaderScore(row.cells.map((cell) => cell.text))
  }));
  const found = scored
    .filter((item) => item.scored.isHeader)
    .map((item) => ({
      rowNumber: item.row.rowNumber,
      headers: item.row.cells.map((cell) => cell.text),
      normalizedHeaders: item.row.cells.map((cell) => normalizeOpportunityHeader(cell.text))
    }));
  if (found.length) return found;
  const best = scored.sort((left, right) => right.scored.score - left.scored.score)[0];
  return best && best.scored.score >= 8
    ? [{
        rowNumber: best.row.rowNumber,
        headers: best.row.cells.map((cell) => cell.text),
        normalizedHeaders: best.row.cells.map((cell) => normalizeOpportunityHeader(cell.text))
      }]
    : [];
}

function previewText(cell: OpportunityCell) {
  if (cell.formula && !cell.cachedFormulaValue) return "[FORMULA IGNORED]";
  if (cell.error) return "[CELL ERROR]";
  return safeSpreadsheetText(cell.text, MAX_PREVIEW_CELL_LENGTH);
}

function previewRows(rows: OpportunitySourceRow[], headerRow: number | null) {
  if (headerRow === null) return [];
  return rows
    .filter((row) => row.rowNumber > headerRow && !rowIsEmpty(row.cells))
    .filter((row) => !opportunityHeaderScore(row.cells.map((cell) => cell.text)).isHeader)
    .slice(0, MAX_PREVIEW_ROWS)
    .map((row) => ({
      rowNumber: row.rowNumber,
      hidden: row.hidden,
      values: Object.fromEntries(
        row.cells.slice(0, MAX_PREVIEW_COLUMNS).flatMap((cell, index) => {
          const value = previewText(cell);
          return value ? [[excelColumnName(index), value]] : [];
        })
      )
    }));
}

function autoFilterRef(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "ref" in value && typeof value.ref === "string") {
    return value.ref;
  }
  return null;
}

function autoFilterLastRow(ref: string | null) {
  if (!ref) return null;
  try {
    return XLSX.utils.decode_range(ref).e.r + 1;
  } catch {
    return null;
  }
}

function buildSheetProfile(input: {
  sheetName: string;
  rowCount: number;
  hiddenRowCount: number;
  rowNumbers: number[];
  bufferedRows: OpportunitySourceRow[];
  autoFilterRef: string | null;
  formulaCells: number;
  cachedFormulaCells: number;
  errorCells: number;
}) {
  const headerRows = headerProfileRows(input.bufferedRows);
  const firstHeader = headerRows.length
    ? Math.min(...headerRows.map((row) => row.rowNumber))
    : null;
  const headerNumbers = new Set(headerRows.map((row) => row.rowNumber));
  const usefulRowCount = firstHeader === null
    ? 0
    : input.rowNumbers.filter((row) => row > firstHeader && !headerNumbers.has(row)).length;
  const warnings: string[] = [];
  if (input.hiddenRowCount > 0) warnings.push("hidden_rows_included");
  if (input.formulaCells > input.cachedFormulaCells) warnings.push("formulas_ignored");
  if (input.cachedFormulaCells > 0) warnings.push("formula_cached_values_available");
  if (input.errorCells > 0) warnings.push("excel_errors_ignored");
  const filterEnd = autoFilterLastRow(input.autoFilterRef);
  if (filterEnd !== null && input.rowNumbers.some((row) => row > filterEnd)) {
    warnings.push("rows_outside_autofilter_included");
  }
  return {
    sheetName: input.sheetName,
    rowCount: input.rowCount,
    usefulRowCount,
    hiddenRowCount: input.hiddenRowCount,
    autoFilterRef: input.autoFilterRef,
    headerRows,
    previewRows: previewRows(input.bufferedRows, firstHeader),
    warnings,
    errors: []
  } satisfies OpportunitySheetProfile;
}

function assertRowLimit(rowCount: number) {
  if (rowCount > opportunityFinderMaxRowsPerFile()) {
    throw new Error("OPPORTUNITY_ROW_LIMIT_EXCEEDED");
  }
}

function profileCells(cells: OpportunityCell[]) {
  return {
    formulas: cells.filter((cell) => cell.formula).length,
    cachedFormulas: cells.filter((cell) => cell.cachedFormulaValue).length,
    errors: cells.filter((cell) => cell.error).length
  };
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
    const sampler = new ProfileRowSampler();
    const rowNumbers: number[] = [];
    let rowCount = 0;
    let hiddenRowCount = 0;
    let formulaCells = 0;
    let cachedFormulaCells = 0;
    let errorCells = 0;
    for await (const row of worksheet) {
      const cells = excelRowCells(row);
      if (rowIsEmpty(cells)) continue;
      const hidden = Boolean((row as ExcelJS.Row).hidden);
      rowCount += 1;
      totalRows += 1;
      assertRowLimit(totalRows);
      rowNumbers.push(row.number);
      if (hidden) hiddenRowCount += 1;
      const quality = profileCells(cells);
      formulaCells += quality.formulas;
      cachedFormulaCells += quality.cachedFormulas;
      errorCells += quality.errors;
      sampler.add({ rowNumber: row.number, cells, hidden });
    }
    if (!rowCount) continue;
    const worksheetFilter = autoFilterRef(
      (worksheet as unknown as { autoFilter?: unknown }).autoFilter
    );
    sheets.push(buildSheetProfile({
      sheetName: (worksheet as { name?: string }).name ?? `Sheet ${sheets.length + 1}`,
      rowCount,
      hiddenRowCount,
      rowNumbers,
      bufferedRows: sampler.rows,
      autoFilterRef: worksheetFilter,
      formulaCells,
      cachedFormulaCells,
      errorCells
    }));
  }
  return enrichWorkbookProfile(classifyOpportunityWorkbook({ fileName, sheets, rowCount: totalRows }));
}

async function profileXlsxFallback(filePath: string, fileName: string) {
  const workbook = await readXlsxFallback(filePath);
  const sheets: OpportunitySheetProfile[] = [];
  let totalRows = 0;
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const sampler = new ProfileRowSampler();
    const rowNumbers: number[] = [];
    let rowCount = 0;
    let hiddenRowCount = 0;
    const counts = { formulas: 0, cachedFormulas: 0, errors: 0 };
    for (const row of sheetJsRows(worksheet)) {
      if (rowIsEmpty(row.cells)) continue;
      rowCount += 1;
      totalRows += 1;
      assertRowLimit(totalRows);
      rowNumbers.push(row.rowNumber);
      if (row.hidden) hiddenRowCount += 1;
      const quality = profileCells(row.cells);
      counts.formulas += quality.formulas;
      counts.cachedFormulas += quality.cachedFormulas;
      counts.errors += quality.errors;
      sampler.add(row);
    }
    if (!rowCount) continue;
    sheets.push(buildSheetProfile({
      sheetName,
      rowCount,
      hiddenRowCount,
      rowNumbers,
      bufferedRows: sampler.rows,
      autoFilterRef: autoFilterRef(worksheet["!autofilter"]),
      formulaCells: counts.formulas,
      cachedFormulaCells: counts.cachedFormulas,
      errorCells: counts.errors
    }));
  }
  return enrichWorkbookProfile(classifyOpportunityWorkbook({ fileName, sheets, rowCount: totalRows }));
}

function selectedRoleForProfile(profile: OpportunityWorkbookProfile) {
  return profile.detectedType === "financial" || profile.detectedType === "unknown"
    ? null
    : profile.detectedType as OpportunitySelectedRole;
}

function enrichWorkbookProfile(profile: OpportunityWorkbookProfile) {
  const role = selectedRoleForProfile(profile);
  if (!role) return profile;
  const workbookMappings = [];
  for (const sheet of profile.sheets) {
    for (const header of sheet.headerRows) {
      const map = buildOpportunityAdapterColumnMap(
        header.headers,
        role,
        profile.templateType ?? "generic"
      );
      if (!map) continue;
      const mappings = opportunityColumnMappings(map, header.headers);
      const embeddedOfferMap = role === "demand" && opportunityTemplateHasEmbeddedOffers(
        profile.templateType ?? "generic"
      )
        ? buildOpportunityAdapterColumnMap(
            header.headers,
            "supplier_offer",
            profile.templateType ?? "generic"
          )
        : null;
      const embeddedOfferMappings = embeddedOfferMap
        ? opportunityColumnMappings(embeddedOfferMap, header.headers).map((mapping) => ({
            ...mapping,
            canonicalField: `embeddedOffer.${mapping.canonicalField}`
          }))
        : [];
      const combinedMappings = [...mappings, ...embeddedOfferMappings];
      header.normalizedHeaders = header.headers.map(normalizeOpportunityHeader);
      header.columnMappings = combinedMappings;
      if (!workbookMappings.length) workbookMappings.push(...combinedMappings);
    }
  }
  profile.columnMappings = workbookMappings;
  if (role === "demand" && opportunityTemplateHasEmbeddedOffers(profile.templateType ?? "generic")) {
    profile.warnings = Array.from(new Set([
      ...(profile.warnings ?? []),
      "embedded_offer_columns_mapped"
    ]));
  }
  return profile;
}

function shouldStreamXlsx(inspection: OpportunityXlsxPackageInspection) {
  return inspection.totalUncompressedBytes >= opportunityFinderXlsxStreamingThresholdBytes();
}

async function profileXlsx(
  filePath: string,
  fileName: string,
  inspection: OpportunityXlsxPackageInspection
) {
  const stat = await fs.promises.stat(filePath);
  if (!shouldStreamXlsx(inspection) && stat.size <= MAX_XLSX_FALLBACK_SIZE_BYTES) {
    return profileXlsxFallback(filePath, fileName);
  }
  try {
    const streamed = await profileXlsxStreaming(filePath, fileName);
    if (streamed.sheetCount > 0) return streamed;
  } catch (error) {
    if (error instanceof Error && error.message === "OPPORTUNITY_ROW_LIMIT_EXCEEDED") throw error;
  }
  if (!shouldStreamXlsx(inspection) && stat.size <= MAX_XLSX_FALLBACK_SIZE_BYTES) {
    return profileXlsxFallback(filePath, fileName);
  }
  throw new Error("OPPORTUNITY_XLSX_STREAMING_PARSE_FAILED");
}

async function profileCsv(filePath: string, fileName: string) {
  const parser = fs.createReadStream(filePath).pipe(parseCsv({
    relax_quotes: true,
    relax_column_count: true,
    bom: true
  }));
  const sampler = new ProfileRowSampler();
  const rowNumbers: number[] = [];
  let physicalRow = 0;
  let rowCount = 0;
  let formulaCells = 0;
  let cachedFormulaCells = 0;
  let errorCells = 0;
  for await (const row of parser) {
    physicalRow += 1;
    const cells = csvCells(row as unknown[]);
    if (rowIsEmpty(cells)) continue;
    rowCount += 1;
    assertRowLimit(rowCount);
    rowNumbers.push(physicalRow);
    const quality = profileCells(cells);
    formulaCells += quality.formulas;
    cachedFormulaCells += quality.cachedFormulas;
    errorCells += quality.errors;
    sampler.add({ rowNumber: physicalRow, cells, hidden: false });
  }
  const sheets = rowCount ? [buildSheetProfile({
    sheetName: "CSV",
    rowCount,
    hiddenRowCount: 0,
    rowNumbers,
    bufferedRows: sampler.rows,
    autoFilterRef: null,
    formulaCells,
    cachedFormulaCells,
    errorCells
  })] : [];
  return enrichWorkbookProfile(classifyOpportunityWorkbook({ fileName, rowCount, sheets }));
}

function findEocd(buffer: Buffer) {
  for (let index = buffer.length - ZIP_EOCD_MIN_SIZE; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

export async function inspectOpportunityXlsxPackage(
  filePath: string
): Promise<OpportunityXlsxPackageInspection> {
  const stat = await fs.promises.stat(filePath);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const tailSize = Math.min(stat.size, ZIP_EOCD_MIN_SIZE + ZIP_MAX_COMMENT_SIZE);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, stat.size - tailSize);
    const eocd = findEocd(tail);
    if (eocd < 0) throw new Error("OPPORTUNITY_XLSX_ZIP_INVALID");
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new Error("OPPORTUNITY_XLSX_MULTIDISK_BLOCKED");
    }
    if (
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw new Error("OPPORTUNITY_XLSX_ZIP64_BLOCKED");
    }
    if (!entryCount || entryCount > opportunityFinderMaxXlsxEntries()) {
      throw new Error("OPPORTUNITY_XLSX_ENTRY_LIMIT_EXCEEDED");
    }
    if (centralSize > 32 * 1024 * 1024 || centralOffset + centralSize > stat.size) {
      throw new Error("OPPORTUNITY_XLSX_ZIP_INVALID");
    }
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    let cursor = 0;
    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;
    let hasExternalLinks = false;
    let hasConnections = false;
    let hasContentTypes = false;
    let hasWorkbook = false;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error("OPPORTUNITY_XLSX_ZIP_INVALID");
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressed = central.readUInt32LE(cursor + 20);
      const uncompressed = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > central.length) throw new Error("OPPORTUNITY_XLSX_ZIP_INVALID");
      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = nameBuffer.toString(flags & 0x0800 ? "utf8" : "latin1").replace(/\\/g, "/");
      const lower = name.toLowerCase();
      if (flags & 0x0001 || method === 99 || /(^|\/)encryptioninfo$|(^|\/)encryptedpackage$/i.test(name)) {
        throw new Error("OPPORTUNITY_FILE_ENCRYPTED_BLOCKED");
      }
      if (method !== 0 && method !== 8) throw new Error("OPPORTUNITY_XLSX_COMPRESSION_BLOCKED");
      if (
        lower.includes("vbaproject.bin") ||
        lower.startsWith("xl/macrosheets/") ||
        lower.startsWith("xl/intlmacrosheets/") ||
        lower.startsWith("xl/activex/") ||
        lower.startsWith("xl/embeddings/")
      ) {
        throw new Error("OPPORTUNITY_FILE_MACRO_BLOCKED");
      }
      hasExternalLinks ||= lower.startsWith("xl/externallinks/");
      hasConnections ||= lower === "xl/connections.xml" || lower.startsWith("xl/querytables/");
      hasContentTypes ||= lower === "[content_types].xml";
      hasWorkbook ||= lower === "xl/workbook.xml";
      totalCompressedBytes += compressed;
      totalUncompressedBytes += uncompressed;
      if (totalUncompressedBytes > opportunityFinderMaxXlsxUncompressedBytes()) {
        throw new Error("OPPORTUNITY_XLSX_UNCOMPRESSED_LIMIT_EXCEEDED");
      }
      if (compressed === 0 && uncompressed > 0) {
        throw new Error("OPPORTUNITY_XLSX_COMPRESSION_RATIO_EXCEEDED");
      }
      cursor = next;
    }
    if (!hasContentTypes || !hasWorkbook) throw new Error("OPPORTUNITY_XLSX_PACKAGE_INVALID");
    const ratio = totalUncompressedBytes / Math.max(totalCompressedBytes, 1);
    if (ratio > opportunityFinderMaxCompressionRatio()) {
      throw new Error("OPPORTUNITY_XLSX_COMPRESSION_RATIO_EXCEEDED");
    }
    return {
      entryCount,
      totalCompressedBytes,
      totalUncompressedBytes,
      hasExternalLinks,
      hasConnections
    };
  } finally {
    await handle.close();
  }
}

export async function validateOpportunityFileSignature(filePath: string, fileName: string) {
  const fileExtension = extension(fileName);
  const stat = await fs.promises.stat(filePath);
  if (!stat.size) throw new Error("OPPORTUNITY_FILE_EMPTY");
  if (stat.size > opportunityFinderMaxFileSizeBytes()) throw new Error("OPPORTUNITY_FILE_TOO_LARGE");
  const handle = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(stat.size, 8_192));
    await handle.read(head, 0, head.length, 0);
    if (fileExtension === ".xlsx") {
      if (head[0] !== 0x50 || head[1] !== 0x4b) {
        throw new Error("OPPORTUNITY_FILE_SIGNATURE_INVALID");
      }
    } else if (fileExtension === ".csv") {
      if (head.includes(0) || (head[0] === 0x50 && head[1] === 0x4b)) {
        throw new Error("OPPORTUNITY_FILE_SIGNATURE_INVALID");
      }
    } else {
      throw new Error("OPPORTUNITY_FILE_EXTENSION_INVALID");
    }
  } finally {
    await handle.close();
  }
  return fileExtension === ".xlsx" ? inspectOpportunityXlsxPackage(filePath) : null;
}

export async function profileOpportunityWorkbook(
  filePath: string,
  fileName: string
): Promise<OpportunityWorkbookProfile> {
  const inspection = await validateOpportunityFileSignature(filePath, fileName);
  const profile = extension(fileName) === ".csv"
    ? await profileCsv(filePath, fileName)
    : await profileXlsx(filePath, fileName, inspection!);
  if (inspection?.hasExternalLinks) {
    profile.warnings = Array.from(new Set([...(profile.warnings ?? []), "external_links_ignored"]));
  }
  if (inspection?.hasConnections) {
    profile.warnings = Array.from(new Set([...(profile.warnings ?? []), "external_connections_ignored"]));
  }
  return profile;
}

export function buildOpportunityColumnMap(
  headerValues: unknown[],
  role: OpportunitySelectedRole,
  templateType: OpportunityTemplateType = "generic"
) {
  return buildOpportunityAdapterColumnMap(headerValues, role, templateType);
}

function cellAt(cells: OpportunityCell[], index: number | null) {
  return index === null ? undefined : cells[index];
}

function parsedNumber(cell: OpportunityCell | undefined) {
  if (!cellHasUsableValue(cell)) return null;
  const parsed = parseOpportunityQuantity(cell.value ?? cell.text);
  return parsed.valid ? parsed.value : null;
}

function parsedPositiveNumber(cell: OpportunityCell | undefined) {
  const value = parsedNumber(cell);
  return value !== null && value >= 0 ? value : null;
}

function dateValue(cell: OpportunityCell | undefined) {
  if (!cellHasUsableValue(cell)) {
    return { value: null, quality: "missing" as const };
  }
  if (cell.value instanceof Date && Number.isFinite(cell.value.getTime())) {
    return { value: cell.value.toISOString().slice(0, 10), quality: "valid" as const };
  }
  const text = safeContextText(cell.text, 40);
  if (!text) return { value: null, quality: "missing" as const };
  if (/^(?:n\/?a|not applicable)$/i.test(text)) {
    return { value: null, quality: "not_applicable" as const };
  }
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us) {
    year = Number(us[3]);
    month = Number(us[1]);
    day = Number(us[2]);
  } else {
    return { value: text, quality: "ambiguous" as const };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { value: text, quality: "ambiguous" as const };
  }
  return { value: date.toISOString().slice(0, 10), quality: "valid" as const };
}

function mappedColumnEntries(columns: OpportunityAdapterColumnMap) {
  return Object.entries(columns).filter(
    ([field, value]) =>
      !["templateType", "mappingVersion", "quantityMode", "shifted"].includes(field) &&
      typeof value === "number" &&
      value >= 0
  ) as Array<[string, number]>;
}

function sourceTraceFields(
  cells: OpportunityCell[],
  columns: OpportunityAdapterColumnMap,
  sourceRow: number
) {
  const sourceColumns: Record<string, string> = {};
  const sourceCellRefs: Record<string, string> = {};
  for (const [field, index] of mappedColumnEntries(columns)) {
    const column = excelColumnName(index);
    sourceColumns[field] = column;
    sourceCellRefs[field] = `${column}${sourceRow}`;
  }
  const rawRow = Object.fromEntries(
    cells.slice(0, 80).map((cell, index) => [
      excelColumnName(index),
      cell.formula || cell.error ? null : safeContextText(cell.text, 500)
    ])
  );
  return { sourceColumns, sourceCellRefs, rawRow };
}

function sourceIdentifier(
  cell: OpportunityCell | undefined,
  options: { preferRawNumeric?: boolean } = {}
) {
  if (!cellHasUsableValue(cell)) return null;
  if (
    options.preferRawNumeric &&
    typeof cell.value === "number" &&
    Number.isFinite(cell.value) &&
    Math.abs(cell.value) <= Number.MAX_SAFE_INTEGER
  ) {
    return String(cell.value);
  }
  return safeContextText(cell.text, 200);
}

function isHistoricalRole(role: OpportunitySelectedRole) {
  return ["received_history", "purchase_history", "quote_history", "sales_history"].includes(role);
}

type DemandEventState = {
  seen: Set<string>;
  ordinals: Map<string, number>;
};

const ISO_CURRENCIES = new Set([
  "BRL", "CAD", "CNY", "COP", "EUR", "GBP", "HKD", "JPY", "KRW",
  "MXN", "SGD", "TWD", "USD"
]);

function parsedCurrency(cell: OpportunityCell | null | undefined) {
  if (!cellHasUsableValue(cell)) {
    return { value: null, status: "unconfirmed" as const };
  }
  const value = safeContextText(cell.text, 12)?.toUpperCase() ?? null;
  if (!value) return { value: null, status: "unconfirmed" as const };
  return ISO_CURRENCIES.has(value)
    ? { value, status: "confirmed" as const }
    : { value, status: "invalid" as const };
}

function normalizedValidityOverride(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function buildCanonicalRow(input: {
  cells: OpportunityCell[];
  columns: OpportunityAdapterColumnMap;
  jobId: string;
  fileId: string;
  side: "A" | "B";
  fileName: string;
  sheetName: string;
  sourceRow: number;
  sourceRowHidden: boolean;
  headerRow: number;
  originalIndex: number;
  role: OpportunitySelectedRole;
  snapshotKey: string;
  eventState: DemandEventState;
  validityOverrideExpiresAt?: string | null;
  mpnOverride?: string;
  forceAlternate?: boolean;
}) {
  const mpnCell = input.cells[input.columns.mpn];
  const identity = mpnIdentity(input.mpnOverride ?? mpnCell?.text ?? "");
  const quantityCell = cellAt(input.cells, input.columns.quantity);
  const quantity = parseOpportunityQuantity(
    !cellHasUsableValue(quantityCell) ? null : quantityCell.value ?? quantityCell.text ?? null
  );
  const historical = isHistoricalRole(input.role);
  const qualityFlags = new Set<OpportunityWarningCode>();
  if (input.cells.some((cell) => cell.formula && !cell.cachedFormulaValue)) qualityFlags.add("formula_ignored");
  if (input.cells.some((cell) => cell.cachedFormulaValue)) qualityFlags.add("formula_cached_value_used");
  if (input.cells.some((cell) => cell.error)) qualityFlags.add("excel_error_value");
  if (input.sourceRowHidden) qualityFlags.add("hidden_source_row");
  if (input.columns.shifted) qualityFlags.add("shifted_column_mapping");
  if (historical) qualityFlags.add("historical_not_current_stock");

  const parsedQuantity = quantity.value === null
    ? null
    : input.columns.quantityMode === "absolute"
      ? Math.abs(quantity.value)
      : quantity.value >= 0
        ? quantity.value
        : null;
  if (!historical && !quantity.valid) {
    qualityFlags.add(input.role === "demand" ? "invalid_required_quantity" : "invalid_available_quantity");
  }
  if (!historical && quantity.negative && input.columns.quantityMode !== "absolute") {
    qualityFlags.add(input.role === "demand" ? "invalid_required_quantity" : "negative_available_quantity");
    if (input.role !== "demand") qualityFlags.add("invalid_available_quantity");
  }

  const manufacturer = safeContextText(cellAt(input.cells, input.columns.manufacturer)?.text);
  const manufacturerData = manufacturerIdentity(manufacturer);
  const customerContext = safeContextText(cellAt(input.cells, input.columns.customerContext)?.text);
  const supplierContext = safeContextText(cellAt(input.cells, input.columns.supplierContext)?.text);
  const unitOfMeasure = safeContextText(cellAt(input.cells, input.columns.unitOfMeasure)?.text, 40);
  if (!unitOfMeasure && !historical) qualityFlags.add("missing_unit");
  const parsedDate = dateValue(cellAt(input.cells, input.columns.requiredDate));
  if (parsedDate.quality === "ambiguous") qualityFlags.add("ambiguous_date");

  // Escalation identifiers are often rendered in scientific notation. Use the
  // exact safe integer payload, converted to text, so distinct events do not
  // collapse to the same displayed 2.02606E+13 value.
  const eventSourceId = sourceIdentifier(
    cellAt(input.cells, input.columns.eventSourceId),
    { preferRawNumeric: true }
  );
  const compId = sourceIdentifier(cellAt(input.cells, input.columns.compId));
  const clientItem = sourceIdentifier(cellAt(input.cells, input.columns.item));
  const eventKey = (input.role === "demand" || (
    input.role === "supplier_offer" &&
    opportunityTemplateHasEmbeddedOffers(input.columns.templateType)
  ))
    ? buildOpportunityDemandEventKey({
        templateType: input.columns.templateType,
        snapshotKey: input.snapshotKey,
        orddd: eventSourceId,
        compId,
        item: clientItem,
        escalationNumber: eventSourceId,
        fallback: ["sanmina_asia_rfq", "flex_week_27_rfq", "flex_week_28_rfq"].includes(
          input.columns.templateType
        ) ? `${input.sheetName}:${input.sourceRow}` : null
      })
    : null;
  const tracksDemandEvent = input.role === "demand" && Boolean(identity.normalizedMpn) && Boolean(eventKey);
  const previousOrdinal = tracksDemandEvent ? input.eventState.ordinals.get(eventKey!) ?? 0 : 0;
  const optionOrdinal = tracksDemandEvent ? previousOrdinal + 1 : null;
  if (tracksDemandEvent) input.eventState.ordinals.set(eventKey!, optionOrdinal!);
  const firstEventQuantity = !tracksDemandEvent || !input.eventState.seen.has(eventKey!);
  if (tracksDemandEvent) input.eventState.seen.add(eventKey!);

  const primaryRaw = sourceIdentifier(cellAt(input.cells, input.columns.primaryOption));
  const isPrimaryOption = input.role !== "demand"
    ? null
    : input.forceAlternate
      ? false
    : input.columns.templateType === "sanmina_spotbuys"
    ? primaryRaw === "1"
    : eventKey
      ? optionOrdinal === 1
      : null;
  const source = sourceTraceFields(input.cells, input.columns, input.sourceRow);
  const recordKind = input.role === "demand"
    ? "demand_option" as const
    : historical
      ? "historical_signal" as const
      : "supply_lot" as const;
  const targetPrice = parsedPositiveNumber(cellAt(input.cells, input.columns.targetPrice));
  const offerPrice = parsedPositiveNumber(cellAt(input.cells, input.columns.offerPrice));
  const unitCost = parsedPositiveNumber(cellAt(input.cells, input.columns.unitCost));
  const currency = parsedCurrency(cellAt(input.cells, input.columns.currency));
  const expiry = dateValue(cellAt(input.cells, input.columns.expiryDate));
  const expiresAt = expiry.value ?? (
    input.role === "supplier_offer"
      ? normalizedValidityOverride(input.validityOverrideExpiresAt)
      : null
  );
  if (currency.status === "invalid") qualityFlags.add("currency_invalid");
  if (
    (input.role === "supplier_offer" || input.role === "quote_history") &&
    !expiresAt
  ) {
    qualityFlags.add("offer_validity_unknown");
  }

  const row: CanonicalOpportunityRow = {
    jobId: input.jobId,
    fileId: input.fileId,
    side: input.side,
    fileName: input.fileName,
    sheetName: input.sheetName,
    sourceRow: input.sourceRow,
    originalIndex: input.originalIndex,
    recordRole: input.role,
    recordKind,
    templateType: input.columns.templateType,
    mappingVersion: input.columns.mappingVersion,
    headerRow: input.headerRow,
    sourceRowHidden: input.sourceRowHidden,
    ...source,
    ...identity,
    manufacturer,
    manufacturerCanonical: manufacturerData.canonical || null,
    manufacturerAliasVersion: manufacturerData.aliasVersion,
    snapshotKey: input.snapshotKey,
    demandEventKey: eventKey,
    demandEventSourceId: eventSourceId,
    supplyLotKey: input.role !== "demand"
      ? `${input.fileId}|${input.sheetName}|${input.sourceRow}|${input.originalIndex}`
      : null,
    clientItem,
    plantFacility: sourceIdentifier(cellAt(input.cells, input.columns.facility)),
    endCustomer: sourceIdentifier(cellAt(input.cells, input.columns.endCustomer)),
    optionOrdinal,
    isPrimaryOption,
    isApprovedAlternate: input.role === "demand" && eventKey
      ? input.forceAlternate === true || !isPrimaryOption
      : null,
    isActiveDemand: input.role === "demand"
      ? parsedQuantity !== null && parsedQuantity > 0 && parsedDate.quality !== "not_applicable"
      : undefined,
    customerContext,
    supplierContext,
    rawQuantity: quantityCell && cellHasUsableValue(quantityCell) && !quantityCell.formula
      ? safeContextText(quantityCell.text, 80)
      : null,
    requiredQty: input.role === "demand" && firstEventQuantity ? parsedQuantity : null,
    availableQty: ["stock", "supplier_offer", "received_history", "purchase_history", "quote_history", "sales_history"].includes(input.role)
      ? parsedQuantity
      : null,
    excessQty: input.role === "excess" ? parsedQuantity : null,
    requiredDate: parsedDate.value,
    requiredDateQuality: parsedDate.quality,
    unitOfMeasure,
    ...(targetPrice !== null ? { targetPrice, targetCurrency: currency.value } : {}),
    ...(offerPrice !== null ? { offerPrice } : {}),
    ...(unitCost !== null ? { unitCost } : {}),
    ...(targetPrice !== null || offerPrice !== null || unitCost !== null
      ? { currency: currency.value, currencyStatus: currency.status }
      : {}),
    moq: parsedPositiveNumber(cellAt(input.cells, input.columns.moq)),
    spq: parsedPositiveNumber(cellAt(input.cells, input.columns.spq)),
    dateCode: sourceIdentifier(cellAt(input.cells, input.columns.dateCode)),
    coo: sourceIdentifier(cellAt(input.cells, input.columns.coo)),
    leadTimeWeeks: parsedPositiveNumber(cellAt(input.cells, input.columns.leadTime)),
    transitTimeWeeks: parsedPositiveNumber(cellAt(input.cells, input.columns.transitTime)),
    condition: sourceIdentifier(cellAt(input.cells, input.columns.condition)),
    expiresAt,
    isLiveSupply: null,
    qualityFlags: Array.from(qualityFlags)
  };
  return { row, quantity };
}

function alternateMpnValues(cells: OpportunityCell[], columns: OpportunityAdapterColumnMap) {
  const cell = cellAt(cells, columns.alternateMpn);
  if (!cellHasUsableValue(cell)) return [];
  const seen = new Set<string>();
  const alternatives: string[] = [];
  for (const candidate of cell.text.split(/[;,\r\n]+/)) {
    const identity = mpnIdentity(candidate);
    if (!identity.normalizedMpn || seen.has(identity.normalizedMpn)) continue;
    seen.add(identity.normalizedMpn);
    alternatives.push(identity.displayMpn);
    if (alternatives.length >= 20) break;
  }
  return alternatives;
}

function sheetTemplate(
  headerValues: string[],
  sheetName: string,
  preview?: OpportunitySourceRow
) {
  return detectOpportunityTemplate([{
    sheetName,
    rowCount: preview ? 2 : 1,
    headerRows: [{ rowNumber: 1, headers: headerValues }],
    previewRows: preview ? [{
      rowNumber: preview.rowNumber,
      hidden: preview.hidden,
      values: Object.fromEntries(preview.cells.map((cell, index) => [excelColumnName(index), cell.text]))
    }] : []
  }]);
}

function hasValidEmbeddedOffer(
  cells: OpportunityCell[],
  columns: OpportunityAdapterColumnMap | null
) {
  if (!columns) return false;
  const mpnCell = cells[columns.mpn];
  const quantityCell = cellAt(cells, columns.quantity);
  if (
    !mpnIdentity(mpnCell?.text ?? "").normalizedMpn ||
    !quantityCell ||
    !cellHasUsableValue(quantityCell)
  ) {
    return false;
  }
  const quantity = parseOpportunityQuantity(quantityCell.value ?? quantityCell.text);
  return quantity.valid && quantity.value !== null && quantity.value > 0;
}

async function parseRows(input: {
  rows: AsyncIterable<OpportunitySourceRow>;
  sheetName: string;
  jobId: string;
  fileId: string;
  side: "A" | "B";
  fileName: string;
  role: OpportunitySelectedRole;
  templateType?: OpportunityTemplateType;
  snapshotKey: string;
  metrics: OpportunityParseMetrics;
  batch: CanonicalOpportunityRow[];
  batchSize: number;
  onBatch: (rows: CanonicalOpportunityRow[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean>;
  nextIndex: () => number;
  eventState: DemandEventState;
  rejectedBatch: OpportunityRejectedRow[];
  onRejected?: (rows: OpportunityRejectedRow[]) => Promise<void>;
  validityOverrideExpiresAt?: string | null;
}) {
  let columns: OpportunityAdapterColumnMap | null = null;
  let embeddedOfferColumns: OpportunityAdapterColumnMap | null = null;
  let headerValues: string[] = [];
  let headerRow: number | null = null;
  let activeTemplate = input.templateType ?? "generic";
  let sheetRows = 0;
  let sheetCanonicalRows = 0;
  let sheetHiddenRows = 0;
  const emittedEmbeddedOfferRows = new Set<string>();

  function appendCanonicalRow(row: CanonicalOpportunityRow) {
    input.batch.push(row);
    input.metrics.canonicalRows += 1;
    sheetCanonicalRows += 1;
    if (row.recordKind === "demand_option") input.metrics.demandPartOptions += 1;
    if (row.recordKind === "supply_lot") input.metrics.supplyLots += 1;
    if (row.recordKind === "historical_signal") input.metrics.historicalSignals += 1;
  }

  for await (const { rowNumber, cells, hidden } of input.rows) {
    if (rowIsEmpty(cells)) continue;
    sheetRows += 1;
    input.metrics.totalRows += 1;
    assertRowLimit(input.metrics.totalRows);
    if (hidden) {
      input.metrics.hiddenRows += 1;
      sheetHiddenRows += 1;
    }
    input.metrics.formulaCellsIgnored += cells.filter(
      (cell) => cell.formula && !cell.cachedFormulaValue
    ).length;
    input.metrics.formulaCachedValuesUsed += cells.filter(
      (cell) => cell.cachedFormulaValue
    ).length;
    input.metrics.errorCellsIgnored += cells.filter((cell) => cell.error).length;

    const rawHeaders = cells.map((cell) => cell.text);
    const scored = opportunityHeaderScore(rawHeaders);
    if (scored.isHeader) {
      const detectedTemplate = input.templateType
        ? input.templateType
        : sheetTemplate(rawHeaders, input.sheetName).templateType;
      const candidateColumns = buildOpportunityAdapterColumnMap(
        rawHeaders,
        input.role,
        detectedTemplate
      );
      if (candidateColumns) {
        columns = candidateColumns;
        activeTemplate = detectedTemplate;
        embeddedOfferColumns = input.role === "demand" && opportunityTemplateHasEmbeddedOffers(
          detectedTemplate
        )
          ? buildOpportunityAdapterColumnMap(
              rawHeaders,
              "supplier_offer",
              detectedTemplate
            )
          : null;
        headerValues = rawHeaders;
        headerRow = rowNumber;
        continue;
      }
    }
    if (!columns || headerRow === null || input.role === "ignore") continue;

    if (!input.templateType && activeTemplate === "flex_week_27_rfq") {
      const refined = sheetTemplate(headerValues, input.sheetName, { rowNumber, cells, hidden });
      if (refined.templateType === "flex_week_28_rfq") {
        const refinedColumns = buildOpportunityAdapterColumnMap(
          headerValues,
          input.role,
          refined.templateType
        );
        if (refinedColumns) {
          columns = refinedColumns;
          activeTemplate = refined.templateType;
        }
      }
    }

    const built = buildCanonicalRow({
      cells,
      columns,
      jobId: input.jobId,
      fileId: input.fileId,
      side: input.side,
      fileName: input.fileName,
      sheetName: input.sheetName,
      sourceRow: rowNumber,
      sourceRowHidden: hidden,
      headerRow,
      originalIndex: input.nextIndex(),
      role: input.role,
      snapshotKey: input.snapshotKey,
      eventState: input.eventState,
      validityOverrideExpiresAt: input.validityOverrideExpiresAt
    });
    const alternateRows = input.role === "demand"
      ? alternateMpnValues(cells, columns)
          .filter((mpn) => mpnIdentity(mpn).normalizedMpn !== built.row.normalizedMpn)
          .map((mpn) => buildCanonicalRow({
            cells,
            columns: columns!,
            jobId: input.jobId,
            fileId: input.fileId,
            side: input.side,
            fileName: input.fileName,
            sheetName: input.sheetName,
            sourceRow: rowNumber,
            sourceRowHidden: hidden,
            headerRow: headerRow!,
            originalIndex: input.nextIndex(),
            role: input.role,
            snapshotKey: input.snapshotKey,
            eventState: input.eventState,
            validityOverrideExpiresAt: input.validityOverrideExpiresAt,
            mpnOverride: mpn,
            forceAlternate: true
          }))
      : [];
    let embeddedOffer: ReturnType<typeof buildCanonicalRow> | null = null;
    const embeddedOfferSourceKey = `${input.fileId}|${input.sheetName}|${rowNumber}`;
    if (
      hasValidEmbeddedOffer(cells, embeddedOfferColumns) &&
      !emittedEmbeddedOfferRows.has(embeddedOfferSourceKey)
    ) {
      emittedEmbeddedOfferRows.add(embeddedOfferSourceKey);
      embeddedOffer = buildCanonicalRow({
        cells,
        columns: embeddedOfferColumns!,
        jobId: input.jobId,
        fileId: input.fileId,
        side: input.side,
        fileName: input.fileName,
        sheetName: input.sheetName,
        sourceRow: rowNumber,
        sourceRowHidden: hidden,
        headerRow,
        originalIndex: input.nextIndex(),
        role: "supplier_offer",
        snapshotKey: input.snapshotKey,
        eventState: input.eventState,
        validityOverrideExpiresAt: input.validityOverrideExpiresAt
      });
    }
    if (!built.row.normalizedMpn && alternateRows.length === 0) {
      if (embeddedOffer) {
        appendCanonicalRow(embeddedOffer.row);
        if (input.batch.length >= input.batchSize) {
          if (input.shouldCancel && await input.shouldCancel()) throw new Error("OPPORTUNITY_JOB_CANCELLED");
          await input.onBatch(input.batch.splice(0, input.batch.length));
        }
        continue;
      }
      if (built.quantity.value !== null) input.metrics.missingMpnRows += 1;
      input.metrics.rejectedRows += 1;
      if (input.onRejected) {
        const cell = cells[columns.mpn];
        input.rejectedBatch.push({
          jobId: input.jobId,
          fileId: input.fileId,
          side: input.side,
          fileName: input.fileName,
          sheetName: input.sheetName,
          sourceRow: rowNumber,
          hidden,
          reasonCode: "missing_mpn",
          fieldName: "mpn",
          sourceColumn: excelColumnName(columns.mpn),
          safeRawValue: cell && !cell.formula && !cell.error
            ? safeContextText(cell.text, 160)
            : null
        });
        if (input.rejectedBatch.length >= input.batchSize) {
          await input.onRejected(input.rejectedBatch.splice(0, input.rejectedBatch.length));
        }
      }
      continue;
    }
    const invalidQuantity = !isHistoricalRole(input.role) && (
      !built.quantity.valid ||
      (built.quantity.negative && columns.quantityMode !== "absolute")
    );
    if (invalidQuantity) {
      input.metrics.invalidQuantityRows += 1;
      input.metrics.rejectedRows += 1;
      if (input.onRejected) {
        const cell = cellAt(cells, columns.quantity);
        const demandQuantity = input.role === "demand";
        input.rejectedBatch.push({
          jobId: input.jobId,
          fileId: input.fileId,
          side: input.side,
          fileName: input.fileName,
          sheetName: input.sheetName,
          sourceRow: rowNumber,
          hidden,
          reasonCode: demandQuantity
            ? "invalid_required_quantity"
            : built.quantity.negative
              ? "negative_available_quantity"
              : "invalid_available_quantity",
          fieldName: demandQuantity ? "required_qty" : "available_qty",
          sourceColumn: columns.quantity === null ? null : excelColumnName(columns.quantity),
          safeRawValue: cell && !cell.formula && !cell.error
            ? safeContextText(cell.text, 160)
            : null
        });
        if (input.rejectedBatch.length >= input.batchSize) {
          await input.onRejected(input.rejectedBatch.splice(0, input.rejectedBatch.length));
        }
      }
    }
    if (built.quantity.negative) input.metrics.negativeQuantityRows += 1;
    if (built.row.normalizedMpn) appendCanonicalRow(built.row);
    for (const alternate of alternateRows) appendCanonicalRow(alternate.row);
    if (embeddedOffer) appendCanonicalRow(embeddedOffer.row);
    if (input.batch.length >= input.batchSize) {
      if (input.shouldCancel && await input.shouldCancel()) throw new Error("OPPORTUNITY_JOB_CANCELLED");
      await input.onBatch(input.batch.splice(0, input.batch.length));
    }
  }
  input.metrics.sheets.push({
    sheetName: input.sheetName,
    rows: sheetRows,
    canonicalRows: sheetCanonicalRows,
    hiddenRows: sheetHiddenRows,
    headerRow,
    templateType: activeTemplate
  });
}

async function parseXlsxFallback(input: ParseOpportunityWorkbookInput, metrics: OpportunityParseMetrics) {
  const workbook = await readXlsxFallback(input.filePath);
  const batch: CanonicalOpportunityRow[] = [];
  const eventState: DemandEventState = { seen: new Set(), ordinals: new Map() };
  const rejectedBatch: OpportunityRejectedRow[] = [];
  let originalIndex = 0;
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    async function* rows() {
      for (const row of sheetJsRows(worksheet!)) yield row;
    }
    await parseRows({
      rows: rows(),
      sheetName,
      jobId: input.jobId,
      fileId: input.fileId,
      side: input.side,
      fileName: input.fileName,
      role: input.role,
      templateType: input.templateType,
      snapshotKey: input.snapshotKey ?? input.fileId,
      metrics,
      batch,
      batchSize: input.batchSize ?? DEFAULT_PARSE_BATCH_SIZE,
      onBatch: input.onBatch,
      shouldCancel: input.shouldCancel,
      nextIndex: () => originalIndex++,
      eventState,
      rejectedBatch,
      onRejected: input.onRejected,
      validityOverrideExpiresAt: input.validityOverrideExpiresAt
    });
  }
  metrics.demandEvents = eventState.seen.size;
  if (batch.length) await input.onBatch(batch.splice(0, batch.length));
  if (input.onRejected && rejectedBatch.length) {
    await input.onRejected(rejectedBatch.splice(0, rejectedBatch.length));
  }
}

async function parseXlsxStreaming(input: ParseOpportunityWorkbookInput, metrics: OpportunityParseMetrics) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input.filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit"
  });
  const batch: CanonicalOpportunityRow[] = [];
  const eventState: DemandEventState = { seen: new Set(), ordinals: new Map() };
  const rejectedBatch: OpportunityRejectedRow[] = [];
  let originalIndex = 0;
  for await (const worksheet of reader) {
    const sheetName = (worksheet as { name?: string }).name ?? `Sheet ${metrics.sheets.length + 1}`;
    async function* rows() {
      for await (const row of worksheet) {
        yield {
          rowNumber: row.number,
          cells: excelRowCells(row),
          hidden: Boolean((row as ExcelJS.Row).hidden)
        };
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
      templateType: input.templateType,
      snapshotKey: input.snapshotKey ?? input.fileId,
      metrics,
      batch,
      batchSize: input.batchSize ?? DEFAULT_PARSE_BATCH_SIZE,
      onBatch: input.onBatch,
      shouldCancel: input.shouldCancel,
      nextIndex: () => originalIndex++,
      eventState,
      rejectedBatch,
      onRejected: input.onRejected,
      validityOverrideExpiresAt: input.validityOverrideExpiresAt
    });
  }
  metrics.demandEvents = eventState.seen.size;
  if (batch.length) await input.onBatch(batch.splice(0, batch.length));
  if (input.onRejected && rejectedBatch.length) {
    await input.onRejected(rejectedBatch.splice(0, rejectedBatch.length));
  }
}

async function parseXlsx(
  input: ParseOpportunityWorkbookInput,
  metrics: OpportunityParseMetrics,
  inspection: OpportunityXlsxPackageInspection
) {
  const stat = await fs.promises.stat(input.filePath);
  if (!shouldStreamXlsx(inspection) && stat.size <= MAX_XLSX_FALLBACK_SIZE_BYTES) {
    await parseXlsxFallback(input, metrics);
    return;
  }
  await parseXlsxStreaming(input, metrics);
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
      yield { rowNumber, cells: csvCells(row as unknown[]), hidden: false };
    }
  }
  const batch: CanonicalOpportunityRow[] = [];
  const eventState: DemandEventState = { seen: new Set(), ordinals: new Map() };
  const rejectedBatch: OpportunityRejectedRow[] = [];
  let originalIndex = 0;
  await parseRows({
    rows: rows(),
    sheetName: "CSV",
    jobId: input.jobId,
    fileId: input.fileId,
    side: input.side,
    fileName: input.fileName,
    role: input.role,
    templateType: input.templateType,
    snapshotKey: input.snapshotKey ?? input.fileId,
    metrics,
    batch,
    batchSize: input.batchSize ?? DEFAULT_PARSE_BATCH_SIZE,
    onBatch: input.onBatch,
    shouldCancel: input.shouldCancel,
    nextIndex: () => originalIndex++,
    eventState,
    rejectedBatch,
    onRejected: input.onRejected,
    validityOverrideExpiresAt: input.validityOverrideExpiresAt
  });
  metrics.demandEvents = eventState.seen.size;
  if (batch.length) await input.onBatch(batch.splice(0, batch.length));
  if (input.onRejected && rejectedBatch.length) {
    await input.onRejected(rejectedBatch.splice(0, rejectedBatch.length));
  }
}

export type ParseOpportunityWorkbookInput = {
  filePath: string;
  fileName: string;
  fileId: string;
  jobId: string;
  side: "A" | "B";
  role: OpportunitySelectedRole;
  templateType?: OpportunityTemplateType;
  snapshotKey?: string;
  /** File-level supplier-offer validity attestation, used only when a row has no expiry. */
  validityOverrideExpiresAt?: string | null;
  batchSize?: number;
  onBatch: (rows: CanonicalOpportunityRow[]) => Promise<void>;
  onRejected?: (rows: OpportunityRejectedRow[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean>;
};

export async function parseOpportunityWorkbook(
  input: ParseOpportunityWorkbookInput
): Promise<OpportunityParseMetrics> {
  const inspection = await validateOpportunityFileSignature(input.filePath, input.fileName);
  const metrics: OpportunityParseMetrics = {
    totalRows: 0,
    canonicalRows: 0,
    missingMpnRows: 0,
    invalidQuantityRows: 0,
    negativeQuantityRows: 0,
    hiddenRows: 0,
    formulaCellsIgnored: 0,
    formulaCachedValuesUsed: 0,
    errorCellsIgnored: 0,
    demandEvents: 0,
    demandPartOptions: 0,
    supplyLots: 0,
    historicalSignals: 0,
    rejectedRows: 0,
    sheets: []
  };
  if (input.role === "ignore") return metrics;
  if (extension(input.fileName) === ".csv") await parseCsvFile(input, metrics);
  else await parseXlsx(input, metrics, inspection!);
  return metrics;
}
