import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectCategory, detectDominantCategory } from "@/lib/excel/category-detector";
import { detectRowQualityIssues } from "@/lib/excel/data-quality";
import { detectHeaderRow } from "@/lib/excel/header-detector";
import { buildSearchableText, normalizeRow, sanitizeScalar } from "@/lib/excel/normalizer";
import { getFileExtension } from "@/lib/excel/validators";
import { evaluateEmailAlertRules } from "@/lib/email/evaluate-alert-rules";
import { logger } from "@/lib/logger/logger";
import { SECURITY_LIMITS } from "@/lib/security/env";
import { redactDiagnosticText } from "@/lib/upload/job-diagnostics";
import type { HeaderDetectionResult, ImportIssue, RawCell } from "@/lib/excel/types";
import type { JsonRecord } from "@/lib/types";

export interface ImportJobRow {
  id: string;
  upload_batch_id: string;
  uploaded_by: string;
  status: "pending_upload" | "uploaded" | "queued" | "retrying" | "processing" | "completed" | "completed_with_warnings" | "failed" | "cancelled";
  storage_bucket: string;
  storage_path: string;
  original_file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  selected_category: string | null;
  department: string | null;
  region: string | null;
  notes: string | null;
  total_rows: number;
  processed_rows: number;
  successful_rows: number;
  failed_rows: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  heartbeat_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  worker_id: string | null;
  cancel_requested: boolean;
  backend_issued: boolean;
  provenance_status: "legacy" | "awaiting_upload" | "verified" | "rejected";
  source: string;
  dataset_key: string;
  import_mode: "replace_upload";
  replacement_scope_key: string;
  expected_size_bytes: number | null;
  expected_sha256: string | null;
  storage_object_id: string | null;
  generation: number;
  lease_token: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  publication_state: "pending" | "staging" | "validated" | "published" | "failed" | "cancelled";
  error_code: string | null;
}

interface WorkerContext {
  traceId: string;
  requestId: string;
  route: string;
  method: string;
  uploadBatchId: string;
  jobRef: string;
}

interface SheetState {
  sheetId: string;
  sheetIndex: number;
  sheetName: string;
  header: HeaderDetectionResult;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  categories: string[];
}

interface ProcessState {
  batch: Array<Record<string, unknown>>;
  importErrors: Array<Record<string, unknown>>;
  errorSummary: Map<string, ErrorSummaryEntry>;
  sheetRows: SheetState[];
  categoryVotes: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errorCount: number;
  warningCount: number;
  rowsWithWarnings: number;
  technicalErrorCount: number;
  suppressedErrorCount: number;
  missingMpnCount: number;
  lowGpRate: number | null;
  flushCount: number;
}

interface ErrorSummaryEntry {
  job_id: string;
  upload_batch_id: string;
  error_type: string;
  severity: string;
  message: string;
  occurrence_count: number;
  sample_row_number: number;
  sample_raw_data: JsonRecord;
}

class ImportCancelledError extends Error {
  constructor() {
    super("Import job was cancelled.");
    this.name = "ImportCancelledError";
  }
}

function selectedCategory(selected: string | null | undefined, detected: string) {
  if (!selected || selected === "Auto Detect") return detected;
  if (selected === "Supplier Offer") return "Supplier Offers";
  if (selected === "Quotation") return "RFQ";
  return selected;
}

function finalImportStatus(state: ProcessState) {
  return state.warningCount > 0 || state.technicalErrorCount > 0 || state.suppressedErrorCount > 0 || state.invalidRows > 0
    ? "completed_with_warnings"
    : "completed";
}

class ImportWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code
  ) {
    super(message);
    this.name = "ImportWorkerError";
  }
}

class ImportWorkerFencedError extends ImportWorkerError {
  constructor() {
    super("IMPORT_WORKER_FENCED", false, "Import worker lease is no longer authoritative.");
    this.name = "ImportWorkerFencedError";
  }
}

function isTechnicalIssue(issue: ImportIssue) {
  return issue.errorType === "technical_error";
}

function redactedRowSample(rawData: JsonRecord): JsonRecord {
  const columns = Object.keys(rawData);
  return {
    column_count: columns.length,
    columns: columns.slice(0, 50),
    truncated_columns: Math.max(0, columns.length - 50)
  };
}

function classifyThrownError(error: unknown) {
  if (error instanceof ImportWorkerError) {
    return { code: error.code, retryable: error.retryable, safeMessage: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/storage|download|signed url|fetch/i.test(message)) return { code: "IMPORT_STORAGE_TRANSIENT", retryable: true, safeMessage: "Storage download failed during import." };
  if (/57014|statement timeout|timeout|connection|network|fetch failed|ECONN/i.test(message)) return { code: "IMPORT_TRANSIENT_INFRASTRUCTURE", retryable: true, safeMessage: "Database or network timeout during import." };
  if (/parser|workbook|csv|xlsx|zip|corrupt/i.test(message)) return { code: "IMPORT_FILE_CORRUPT", retryable: false, safeMessage: "The file could not be parsed reliably." };
  if (/schema|column|relation|constraint|violates|23505|PGRST/i.test(message)) return { code: "IMPORT_DATABASE_CONTRACT_INVALID", retryable: false, safeMessage: "Database schema or constraint error during import." };
  return { code: "IMPORT_WORKER_FAILED", retryable: true, safeMessage: "Import worker failed unexpectedly." };
}

function safeJobRef(jobId: string) {
  return jobId.slice(0, 8);
}

function stagingKey(prefix: string, payload: unknown, index: number) {
  return `${prefix}:${createHash("sha256").update(JSON.stringify([payload, index])).digest("hex")}`;
}

function issueKey(issue: ImportIssue) {
  return [issue.errorType, issue.severity, issue.columnName ?? "", issue.message].join("|");
}

function recordIssue(state: ProcessState, job: ImportJobRow, issue: ImportIssue, rawData: JsonRecord, rowIndex: number) {
  state.errorCount += 1;
  if (isTechnicalIssue(issue)) state.technicalErrorCount += 1;
  else state.warningCount += 1;

  const key = issueKey(issue);
  const existing = state.errorSummary.get(key);
  if (existing) {
    existing.occurrence_count += 1;
    return;
  }
  state.errorSummary.set(key, {
    job_id: job.id,
    upload_batch_id: job.upload_batch_id,
    error_type: issue.errorType,
    severity: issue.severity,
    message: issue.message,
    occurrence_count: 1,
    sample_row_number: rowIndex,
    sample_raw_data: redactedRowSample(rawData)
  });
}

function shouldImportRow(issues: ImportIssue[]) {
  if (issues.some(isTechnicalIssue)) return false;
  if (SECURITY_LIMITS.allowPartialRows) return true;
  if (SECURITY_LIMITS.treatValidationAsWarnings) return issues.every((issue) => issue.severity !== "critical");
  return !issues.some((issue) => issue.severity === "high" || issue.severity === "critical");
}

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

function toImportErrorRow(item: Record<string, unknown>) {
  const row = { ...item };
  delete row.job_id;
  delete row.raw_data;
  return row;
}

function excelCellValue(value: ExcelJS.CellValue): RawCell {
  if (value instanceof Date) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return excelCellValue(value.result as ExcelJS.CellValue);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text).join("");
    }
    return String(value);
  }
  return value;
}

function memoryUsageMb() {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024)
  };
}

async function tempDiskUsageMb(filePath: string | null) {
  if (!filePath) return 0;
  const stat = await fs.promises.stat(filePath).catch(() => null);
  return stat ? Math.round(stat.size / 1024 / 1024) : 0;
}

function throwRpcError(error: { message?: string; code?: string } | null) {
  if (!error) return;
  const diagnostic = `${error.code ?? ""} ${error.message ?? ""}`;
  if (/IMPORT_CANCEL_REQUESTED/.test(diagnostic)) throw new ImportCancelledError();
  if (/IMPORT_WORKER_FENCED|IMPORT_JOB_SUPERSEDED/.test(diagnostic)) throw new ImportWorkerFencedError();
  const contractCode = diagnostic.match(/IMPORT_[A-Z0-9_]+/)?.[0];
  if (contractCode) {
    const retryable = /PUBLISH_INJECTED_FAILURE|STORAGE_TRANSIENT|DATABASE_TRANSIENT/.test(contractCode);
    throw new ImportWorkerError(contractCode, retryable, "Import backend rejected the operation safely.");
  }
  throw new ImportWorkerError("IMPORT_DATABASE_CONTRACT_INVALID", false, "Import backend contract failed.");
}

async function updateHeartbeat(supabase: SupabaseClient, job: ImportJobRow, workerId: string) {
  const { data, error } = await supabase.rpc("renew_import_job_lease_v2", {
    input_job_id: job.id,
    input_worker_id: workerId,
    input_generation: job.generation,
    input_lease_token: job.lease_token,
    input_lease_seconds: Math.max(30, Math.ceil(SECURITY_LIMITS.workerHeartbeatIntervalMs / 1000) * 4)
  });
  throwRpcError(error);
  const result = data as { renewed?: boolean; cancelRequested?: boolean } | null;
  if (result?.cancelRequested) throw new ImportCancelledError();
  if (!result?.renewed) throw new ImportWorkerFencedError();
}

async function updateProgress(supabase: SupabaseClient, job: ImportJobRow, workerId: string, state: ProcessState) {
  const estimatedProgress = Math.min(95, Math.max(5, Math.round(state.totalRows / Math.max(state.totalRows + 2000, 1) * 100)));
  const { error } = await supabase.rpc("update_import_job_progress_v2", {
    input_job_id: job.id,
    input_worker_id: workerId,
    input_generation: job.generation,
    input_lease_token: job.lease_token,
    input_metrics: {
      totalRows: state.totalRows,
      validRows: state.validRows,
      invalidRows: state.invalidRows,
      warningCount: state.warningCount,
      rowsWithWarnings: state.rowsWithWarnings,
      technicalErrorCount: state.technicalErrorCount,
      suppressedErrorCount: state.suppressedErrorCount,
      progressPercent: estimatedProgress
    }
  });
  throwRpcError(error);
}

async function ensureJobNotCancelled(supabase: SupabaseClient, job: ImportJobRow, workerId: string, state: ProcessState, force = false) {
  if (!force && state.totalRows % SECURITY_LIMITS.importBatchSize !== 0) return;
  await updateHeartbeat(supabase, job, workerId);
}

async function stageRows(
  supabase: SupabaseClient,
  job: ImportJobRow,
  workerId: string,
  entityKind: "sheet" | "business_record" | "import_error" | "job_error" | "error_summary",
  rows: Array<{ rowKey: string; payload: Record<string, unknown> }>
) {
  if (!rows.length) return;
  const { error } = await supabase.rpc("stage_import_job_rows_v2", {
    input_job_id: job.id,
    input_worker_id: workerId,
    input_generation: job.generation,
    input_lease_token: job.lease_token,
    input_entity_kind: entityKind,
    input_rows: rows
  });
  throwRpcError(error);
}

async function flushBatches(supabase: SupabaseClient, job: ImportJobRow, workerId: string, state: ProcessState, context: WorkerContext, force = false) {
  if (!force && state.batch.length < SECURITY_LIMITS.importBatchSize) return;
  if (!state.batch.length && !state.importErrors.length) return;
  await ensureJobNotCancelled(supabase, job, workerId, state, true);
  const records = state.batch.splice(0, state.batch.length);
  const errors = state.importErrors.splice(0, state.importErrors.length);
  const flushIndex = state.flushCount;
  state.flushCount += 1;

  if (records.length) {
    await stageRows(supabase, job, workerId, "business_record", records.map((payload, index) => ({
      rowKey: stagingKey(`record:${flushIndex}`, payload.id, index),
      payload
    })));
  }

  if (errors.length) {
    await stageRows(supabase, job, workerId, "import_error", errors.map((item, index) => ({
      rowKey: stagingKey(`error:${flushIndex}`, [item.row_index, item.column_name, item.error_type], index),
      payload: toImportErrorRow(item)
    })));
    await stageRows(supabase, job, workerId, "job_error", errors.map((item, index) => ({
      rowKey: stagingKey(`job-error:${flushIndex}`, [item.row_index, item.error_type], index),
      payload: {
        row_number: item.row_index,
        error_message: item.message,
        raw_data: item.raw_data ?? {}
      }
    })));
  }

  await updateProgress(supabase, job, workerId, state);
  await logger.info({
    ...context,
    module: "upload",
    action: "rows_processed",
    message: "Import rows processed progress saved.",
    status: "completed",
    metadata: {
      processedRows: state.totalRows,
      successfulRows: state.validRows,
      failedRows: state.invalidRows,
      warningCount: state.warningCount,
      rowsWithWarnings: state.rowsWithWarnings,
      technicalErrorCount: state.technicalErrorCount,
      suppressedErrorCount: state.suppressedErrorCount,
      errorCount: state.errorCount,
      memory: memoryUsageMb(),
      jobRef: context.jobRef,
      stage: "staging"
    }
  });
}

export async function recoverStaleImportJobs(supabase: SupabaseClient, workerId: string) {
  const { error } = await supabase.rpc("recover_stale_import_jobs_v2", {
    input_worker_id: workerId,
    input_limit: 25
  });
  throwRpcError(error);
}

async function createSheetState(job: ImportJobRow, sheetIndex: number, sheetName: string, bufferedRows: RawCell[][], context: WorkerContext) {
  const header = detectHeaderRow(bufferedRows, 30, context);
  return {
    sheetId: crypto.randomUUID(),
    sheetIndex,
    sheetName,
    header,
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    categories: []
  };
}

async function processDataRow(
  supabase: SupabaseClient,
  job: ImportJobRow,
  workerId: string,
  state: ProcessState,
  sheet: SheetState,
  row: RawCell[],
  rowIndex: number,
  context: WorkerContext
) {
  if (isEmptyRow(row)) return;
  if (state.totalRows >= SECURITY_LIMITS.maxExcelRows) {
    throw new Error(`Workbook exceeds the ${SECURITY_LIMITS.maxExcelRows} row limit.`);
  }
  const rawData = buildRawRow(sheet.header.headers, row);
  if (!Object.keys(rawData).length) return;

  const normalized = normalizeRow(rawData);
  const categoryDetection = detectCategory(sheet.header.headers, normalized.columns);
  const qualityIssues = detectRowQualityIssues(categoryDetection.category, normalized.columns);
  const errors = [...normalized.issues, ...qualityIssues];
  const hasWarnings = errors.length > 0;
  const importRow = shouldImportRow(errors);
  const category = selectedCategory(job.selected_category, categoryDetection.category);
  const businessRecordId = crypto.randomUUID();

  state.totalRows += 1;
  sheet.totalRows += 1;
  sheet.categories.push(categoryDetection.category);
  state.categoryVotes.push(categoryDetection.category);
  if (!importRow) {
    state.invalidRows += 1;
    sheet.invalidRows += 1;
  } else {
    state.validRows += 1;
    sheet.validRows += 1;
  }
  if (hasWarnings) state.rowsWithWarnings += 1;
  errors.forEach((issue) => recordIssue(state, job, issue, rawData, rowIndex));
  if (!normalized.columns.mpn) state.missingMpnCount += 1;
  const gpRate = Number(normalized.columns.gp_rate);
  if (Number.isFinite(gpRate)) state.lowGpRate = state.lowGpRate === null ? gpRate : Math.min(state.lowGpRate, gpRate);
  await ensureJobNotCancelled(supabase, job, workerId, state);

  if (importRow) {
    state.batch.push({
      id: businessRecordId,
      upload_batch_id: job.upload_batch_id,
      upload_sheet_id: sheet.sheetId,
      uploaded_by: job.uploaded_by,
      category,
      row_index: rowIndex,
      raw_data: rawData,
      normalized_data: {
        ...normalized.normalizedData,
        department: job.department,
        region: job.region
      },
      searchable_text: buildSearchableText({
        rawData,
        normalizedData: normalized.normalizedData,
        category
      }).slice(0, 8000),
      has_errors: hasWarnings,
      errors,
      ...normalized.columns
    });
  }

  const rowErrorLimit = Math.max(0, SECURITY_LIMITS.importMaxErrorsPerRow);
  for (const issue of errors.slice(0, rowErrorLimit)) {
    if (state.importErrors.length >= SECURITY_LIMITS.importMaxErrorsPerJob) {
      state.suppressedErrorCount += 1;
      continue;
    }
    state.importErrors.push({
      trace_id: context.traceId,
      upload_batch_id: job.upload_batch_id,
      upload_sheet_id: sheet.sheetId,
      business_record_id: importRow ? businessRecordId : null,
      row_index: rowIndex,
      column_name: issue.columnName ?? null,
      error_type: issue.errorType,
      message: issue.message,
      raw_value: null,
      severity: issue.severity,
      raw_data: redactedRowSample(rawData),
      job_id: job.id
    });
  }
  if (errors.length > rowErrorLimit) state.suppressedErrorCount += errors.length - rowErrorLimit;

  await flushBatches(supabase, job, workerId, state, context);
}

async function finalizeSheets(supabase: SupabaseClient, job: ImportJobRow, workerId: string, state: ProcessState) {
  await stageRows(supabase, job, workerId, "sheet", state.sheetRows.map((sheet) => ({
    rowKey: `sheet:${sheet.sheetIndex}`,
    payload: {
      id: sheet.sheetId,
      sheet_name: sheet.sheetName,
      detected_header_row: sheet.header.headerRowIndex + 1,
      total_rows: sheet.totalRows,
      valid_rows: sheet.validRows,
      invalid_rows: sheet.invalidRows,
      detected_category: detectDominantCategory(sheet.categories),
      recognized_columns: sheet.header.recognizedColumns
    }
  })));
}

async function persistErrorSummary(supabase: SupabaseClient, job: ImportJobRow, workerId: string, state: ProcessState) {
  const summaryRows = Array.from(state.errorSummary.values());
  await stageRows(supabase, job, workerId, "error_summary", summaryRows.map((payload, index) => ({
    rowKey: stagingKey("summary", [payload.error_type, payload.severity, payload.message], index),
    payload: { ...payload }
  })));
}

async function processXlsxFile(supabase: SupabaseClient, job: ImportJobRow, workerId: string, filePath: string, state: ProcessState, context: WorkerContext) {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    worksheets: "emit"
  });

  let sheetIndex = 0;
  for await (const worksheet of workbookReader) {
    if (sheetIndex >= SECURITY_LIMITS.maxExcelSheets) throw new Error(`Workbook exceeds the ${SECURITY_LIMITS.maxExcelSheets} sheet limit.`);
    const bufferedRows: RawCell[][] = [];
    let sheetState: SheetState | null = null;
    let rowNumber = 0;

    for await (const excelRow of worksheet) {
      rowNumber = excelRow.number;
      const values = Array.isArray(excelRow.values) ? excelRow.values.slice(1).map((value) => excelCellValue(value as ExcelJS.CellValue)) : [];
      if (isEmptyRow(values)) continue;
      if (!sheetState && bufferedRows.length < 30) {
        bufferedRows.push(values);
        continue;
      }
      if (!sheetState) {
        const sheetName = (worksheet as { name?: string }).name ?? `Sheet ${sheetIndex + 1}`;
        sheetState = await createSheetState(job, sheetIndex, sheetName, bufferedRows, context);
        state.sheetRows.push(sheetState);
        const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
        for (const [offset, buffered] of dataRows.entries()) {
          await processDataRow(supabase, job, workerId, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
        }
      }
      await processDataRow(supabase, job, workerId, state, sheetState, values, rowNumber, context);
    }

    if (!sheetState && bufferedRows.length) {
      const sheetName = (worksheet as { name?: string }).name ?? `Sheet ${sheetIndex + 1}`;
      sheetState = await createSheetState(job, sheetIndex, sheetName, bufferedRows, context);
      state.sheetRows.push(sheetState);
      const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
      for (const [offset, buffered] of dataRows.entries()) {
        await processDataRow(supabase, job, workerId, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
      }
    }
    sheetIndex += 1;
  }
}

async function processCsvFile(supabase: SupabaseClient, job: ImportJobRow, workerId: string, filePath: string, state: ProcessState, context: WorkerContext) {
  const parser = fs.createReadStream(filePath).pipe(parseCsv({ relax_quotes: true, relax_column_count: true, bom: true }));
  const bufferedRows: RawCell[][] = [];
  let sheetState: SheetState | null = null;
  let rowIndex = 0;

  for await (const row of parser) {
    rowIndex += 1;
    const values = (row as unknown[]).map((value) => sanitizeScalar(value) as RawCell);
    if (isEmptyRow(values)) continue;
    if (!sheetState && bufferedRows.length < 30) {
      bufferedRows.push(values);
      continue;
    }
    if (!sheetState) {
      sheetState = await createSheetState(job, 0, "CSV", bufferedRows, context);
      state.sheetRows.push(sheetState);
      const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
      for (const [offset, buffered] of dataRows.entries()) {
        await processDataRow(supabase, job, workerId, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
      }
    }
    await processDataRow(supabase, job, workerId, state, sheetState, values, rowIndex, context);
  }

  if (!sheetState && bufferedRows.length) {
    sheetState = await createSheetState(job, 0, "CSV", bufferedRows, context);
    state.sheetRows.push(sheetState);
    const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
    for (const [offset, buffered] of dataRows.entries()) {
      await processDataRow(supabase, job, workerId, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
    }
  }
}

async function downloadStorageObjectToTemp(supabase: SupabaseClient, job: ImportJobRow, context: WorkerContext) {
  const extension = getFileExtension(job.original_file_name);
  const expectedPath = `${job.uploaded_by}/${job.upload_batch_id}/${job.original_file_name}`;
  if (!job.backend_issued
    || job.provenance_status !== "verified"
    || !["trusted_upload_api", "trusted_retry_api"].includes(job.source)
    || job.dataset_key !== "business_records"
    || job.import_mode !== "replace_upload"
    || job.replacement_scope_key !== job.upload_batch_id
    || job.storage_bucket !== "excel-uploads"
    || job.storage_path !== expectedPath
    || !job.storage_object_id
    || ![".csv", ".xlsx"].includes(extension)
    || !job.expected_size_bytes
    || job.expected_size_bytes <= 0
    || job.expected_size_bytes > SECURITY_LIMITS.maxUploadSizeBytes) {
    throw new ImportWorkerError("IMPORT_PROVENANCE_INVALID", false, "Import provenance validation failed.");
  }
  const tempRoot = process.env.UPLOAD_TEMP_DIR || path.join(os.tmpdir(), "quiksol-imports");
  await fs.promises.mkdir(tempRoot, { recursive: true });
  const localPath = path.join(tempRoot, `${job.id}${extension}`);
  const { data, error } = await supabase.storage.from("excel-uploads").createSignedUrl(expectedPath, 60 * 60);
  if (error || !data?.signedUrl) {
    const notFound = /not found|does not exist|404/i.test(error?.message ?? "");
    throw new ImportWorkerError(notFound ? "IMPORT_STORAGE_OBJECT_MISSING" : "IMPORT_STORAGE_TRANSIENT", !notFound, "Storage object could not be opened.");
  }

  await logger.info({
    ...context,
    module: "upload",
    action: "worker_storage_download_started",
    message: "Worker storage download started.",
    status: "started",
    metadata: { jobRef: context.jobRef, stage: "download", expectedSizeBytes: job.expected_size_bytes }
  });

  const response = await fetch(data.signedUrl, { redirect: "error", cache: "no-store" });
  if (!response.ok || !response.body) {
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new ImportWorkerError(
      response.status === 404 ? "IMPORT_STORAGE_OBJECT_MISSING" : "IMPORT_STORAGE_DOWNLOAD_FAILED",
      retryable,
      "Storage download failed during import."
    );
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > SECURITY_LIMITS.maxUploadSizeBytes || sizeBytes > Number(job.expected_size_bytes)) {
        callback(new ImportWorkerError("IMPORT_FILE_SIZE_MISMATCH", false, "Downloaded file size does not match its trusted metadata."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  const webStream = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), verifier, fs.createWriteStream(localPath));
  const sha256 = hash.digest("hex");
  if (sizeBytes !== Number(job.expected_size_bytes)) {
    throw new ImportWorkerError("IMPORT_FILE_SIZE_MISMATCH", false, "Downloaded file size does not match its trusted metadata.");
  }
  if (job.expected_sha256 && job.expected_sha256 !== sha256) {
    throw new ImportWorkerError("IMPORT_FILE_HASH_MISMATCH", false, "Downloaded file hash does not match its trusted metadata.");
  }
  return { localPath, sizeBytes, sha256 };
}

export async function claimNextImportJob(supabase: SupabaseClient, workerId: string) {
  const rpcClaim = await supabase
    .rpc("claim_import_job_v2", {
      input_worker_id: workerId,
      input_lease_seconds: Math.max(30, Math.ceil(SECURITY_LIMITS.workerHeartbeatIntervalMs / 1000) * 4)
    })
    .limit(1);
  throwRpcError(rpcClaim.error);
  return (rpcClaim.data?.[0] as ImportJobRow | undefined) ?? null;
}

export async function processImportJob(supabase: SupabaseClient, job: ImportJobRow, workerId = "worker") {
  const startedAt = performance.now();
  const context: WorkerContext = {
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    uploadBatchId: safeJobRef(job.upload_batch_id),
    jobRef: safeJobRef(job.id)
  };
  const state: ProcessState = {
    batch: [],
    importErrors: [],
    errorSummary: new Map(),
    sheetRows: [],
    categoryVotes: [],
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    errorCount: 0,
    warningCount: 0,
    rowsWithWarnings: 0,
    technicalErrorCount: 0,
    suppressedErrorCount: 0,
    missingMpnCount: 0,
    lowGpRate: null,
    flushCount: 0
  };

  let localPath: string | null = null;
  let leaseFailure: unknown = null;
  const heartbeatTimer = setInterval(() => {
    void updateHeartbeat(supabase, job, workerId).catch((error) => {
      leaseFailure = error;
    });
  }, SECURITY_LIMITS.workerHeartbeatIntervalMs);
  try {
    await updateHeartbeat(supabase, job, workerId);

    await logger.info({
      ...context,
      module: "upload",
      action: "processing_started",
      message: "Background import processing started.",
      status: "started",
      metadata: { workerId, jobRef: context.jobRef, attempt: job.attempts, stage: "claimed", expectedSizeBytes: job.expected_size_bytes, memoryUsage: memoryUsageMb() }
    });

    const downloaded = await downloadStorageObjectToTemp(supabase, job, context);
    localPath = downloaded.localPath;
    const extension = getFileExtension(job.original_file_name);
    try {
      if (extension === ".csv") await processCsvFile(supabase, job, workerId, localPath, state, context);
      else if (extension === ".xlsx") await processXlsxFile(supabase, job, workerId, localPath, state, context);
      else throw new ImportWorkerError("IMPORT_FILE_EXTENSION_INVALID", false, "File extension is not supported.");
    } catch (error) {
      if (error instanceof ImportWorkerError || error instanceof ImportCancelledError) throw error;
      throw new ImportWorkerError("IMPORT_FILE_CORRUPT", false, "The file could not be parsed reliably.");
    }

    if (leaseFailure) throw leaseFailure;
    await flushBatches(supabase, job, workerId, state, context, true);
    await ensureJobNotCancelled(supabase, job, workerId, state, true);
    await finalizeSheets(supabase, job, workerId, state);
    await persistErrorSummary(supabase, job, workerId, state);
    const validation = await supabase.rpc("validate_import_job_staging_v2", {
      input_job_id: job.id,
      input_worker_id: workerId,
      input_generation: job.generation,
      input_lease_token: job.lease_token,
      input_file_size: downloaded.sizeBytes,
      input_file_sha256: downloaded.sha256
    });
    throwRpcError(validation.error);
    const detectedCategory = detectDominantCategory(state.categoryVotes);
    const dataQualityScore = state.totalRows ? Math.round(((state.totalRows - state.rowsWithWarnings) / state.totalRows) * 1000) / 10 : 0;
    const finishedStatus = finalImportStatus(state);
    const publication = await supabase.rpc("publish_import_job_v2", {
      input_job_id: job.id,
      input_worker_id: workerId,
      input_generation: job.generation,
      input_lease_token: job.lease_token,
      input_metrics: {
        totalRows: state.totalRows,
        validRows: state.validRows,
        invalidRows: state.invalidRows,
        warningCount: state.warningCount,
        rowsWithWarnings: state.rowsWithWarnings,
        technicalErrorCount: state.technicalErrorCount,
        suppressedErrorCount: state.suppressedErrorCount,
        sheetCount: state.sheetRows.length,
        detectedCategory,
        dataQualityScore,
        durationMs: Math.round(performance.now() - startedAt)
      }
    });
    throwRpcError(publication.error);

    await logger.audit({
      ...context,
      module: "upload",
      action: "processing_completed",
      message: finishedStatus === "completed_with_warnings" ? "Background import processing completed with warnings." : "Background import processing completed.",
      status: "completed",
      durationMs: Math.round(performance.now() - startedAt),
      category: detectedCategory,
      metadata: { jobRef: context.jobRef, stage: "published", attempt: job.attempts, totalRows: state.totalRows, validRows: state.validRows, invalidRows: state.invalidRows, warningCount: state.warningCount, rowsWithWarnings: state.rowsWithWarnings, technicalErrorCount: state.technicalErrorCount, suppressedErrorCount: state.suppressedErrorCount, errorCount: state.errorCount, memory: memoryUsageMb() }
    });

    await Promise.all([
      evaluateEmailAlertRules({
        eventType: "upload_completed",
        actorName: "Background import worker",
        actorEmail: null,
        fileName: job.original_file_name,
        uploadBatchId: job.upload_batch_id,
        errorCount: state.errorCount,
        dataQualityScore,
        missingMpnCount: state.missingMpnCount,
        lowGpRate: state.lowGpRate,
        totalRows: state.totalRows,
        validRows: state.validRows,
        dashboardUrl: process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/admin/uploads` : null,
        metadata: { detectedCategory, workerId }
      }),
      evaluateEmailAlertRules({ eventType: "upload_has_many_errors", actorName: "Background import worker", actorEmail: null, fileName: job.original_file_name, uploadBatchId: job.upload_batch_id, errorCount: state.errorCount, totalRows: state.totalRows, validRows: state.validRows }),
      evaluateEmailAlertRules({ eventType: "import_quality_below_threshold", actorName: "Background import worker", actorEmail: null, fileName: job.original_file_name, uploadBatchId: job.upload_batch_id, errorCount: state.errorCount, dataQualityScore, totalRows: state.totalRows, validRows: state.validRows })
    ]);
  } catch (error) {
    const classified = classifyThrownError(error);
    const safeMessage = redactDiagnosticText(classified.safeMessage) ?? "Import worker failed unexpectedly.";
    if (!(error instanceof ImportWorkerFencedError)) {
      const failure = await supabase.rpc("fail_import_job_v2", {
        input_job_id: job.id,
        input_worker_id: workerId,
        input_generation: job.generation,
        input_lease_token: job.lease_token,
        input_error_code: error instanceof ImportCancelledError ? "IMPORT_CANCELLED" : classified.code,
        input_retryable: error instanceof ImportCancelledError ? false : classified.retryable
      });
      if (failure.error && !/IMPORT_WORKER_FENCED/.test(`${failure.error.code ?? ""} ${failure.error.message ?? ""}`)) {
        throwRpcError(failure.error);
      }
    }
    await logger.error({
      ...context,
      module: "upload",
      action: "processing_failed",
      message: "Background import processing failed.",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { jobRef: context.jobRef, stage: "failed", attempt: job.attempts, errorCode: classified.code, memoryUsage: memoryUsageMb(), tempDiskUsageMb: await tempDiskUsageMb(localPath), workerId, retryable: classified.retryable, safeErrorMessage: safeMessage },
      error: { name: error instanceof Error ? error.name : "ImportWorkerError", message: safeMessage, code: classified.code }
    });
    await evaluateEmailAlertRules({
      eventType: "upload_failed",
      actorName: "Background import worker",
      actorEmail: null,
      fileName: job.original_file_name,
      uploadBatchId: job.upload_batch_id,
      errorCount: 1,
      metadata: { message: safeMessage, workerId }
    });
    if (error instanceof ImportCancelledError) return;
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    if (localPath) await fs.promises.unlink(localPath).catch(() => undefined);
  }
}
