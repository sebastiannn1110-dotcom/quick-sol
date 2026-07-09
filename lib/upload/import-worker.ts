import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectCategory, detectDominantCategory } from "@/lib/excel/category-detector";
import { detectRowQualityIssues } from "@/lib/excel/data-quality";
import { detectHeaderRow } from "@/lib/excel/header-detector";
import { buildSearchableText, normalizeRow, sanitizeScalar } from "@/lib/excel/normalizer";
import { getFileExtension, sanitizeFileName } from "@/lib/excel/validators";
import { evaluateEmailAlertRules } from "@/lib/email/evaluate-alert-rules";
import { logger } from "@/lib/logger/logger";
import { SECURITY_LIMITS } from "@/lib/security/env";
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
}

interface WorkerContext {
  traceId: string;
  requestId: string;
  route: string;
  method: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  fileName: string;
  uploadBatchId: string;
  jobId: string;
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

function nowIso() {
  return new Date().toISOString();
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

function issueKey(issue: ImportIssue) {
  return [issue.errorType, issue.severity, issue.columnName ?? "", issue.message].join("|");
}

function recordIssue(state: ProcessState, job: ImportJobRow, issue: ImportIssue, rawData: JsonRecord, rowIndex: number) {
  state.errorCount += 1;
  if (issue.errorType === "technical_error" || issue.severity === "critical") state.technicalErrorCount += 1;
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
    sample_raw_data: rawData
  });
}

function shouldImportRow(issues: ImportIssue[]) {
  if (SECURITY_LIMITS.allowPartialRows) return true;
  if (SECURITY_LIMITS.treatValidationAsWarnings) return issues.every((issue) => issue.errorType === "technical_error" || issue.severity !== "critical");
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

async function updateHeartbeat(supabase: SupabaseClient, job: ImportJobRow, workerId: string) {
  const heartbeatAt = nowIso();
  await Promise.all([
    supabase.from("import_jobs").update({
      heartbeat_at: heartbeatAt,
      worker_id: workerId,
      updated_at: heartbeatAt
    }).eq("id", job.id).eq("status", "processing"),
    supabase.from("upload_batches").update({
      worker_last_heartbeat_at: heartbeatAt
    }).eq("id", job.upload_batch_id)
  ]);
  await logger.info({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    module: "upload",
    action: "heartbeat_updated",
    message: "Import worker heartbeat updated.",
    status: "completed",
    uploadBatchId: job.upload_batch_id,
    fileName: job.original_file_name,
    metadata: { jobId: job.id, workerId, memoryUsage: memoryUsageMb() }
  });
}

async function updateProgress(supabase: SupabaseClient, job: ImportJobRow, state: ProcessState, status = "processing") {
  const estimatedProgress = status === "completed" || status === "completed_with_warnings" ? 100 : Math.min(95, Math.max(5, Math.round(state.totalRows / Math.max(state.totalRows + 2000, 1) * 100)));
  await Promise.all([
    supabase.from("import_jobs").update({
      status,
      total_rows: state.totalRows,
      processed_rows: state.totalRows,
      successful_rows: state.validRows,
      failed_rows: state.invalidRows,
      warning_count: state.warningCount,
      rows_with_warnings: state.rowsWithWarnings,
      technical_error_count: state.technicalErrorCount,
      suppressed_error_count: state.suppressedErrorCount,
      progress_percent: estimatedProgress,
      heartbeat_at: nowIso(),
      updated_at: nowIso()
    }).eq("id", job.id),
    supabase.from("upload_batches").update({
      status,
      total_rows: state.totalRows,
      processed_rows: state.totalRows,
      valid_rows: state.validRows,
      invalid_rows: state.invalidRows,
      successful_rows: state.validRows,
      failed_rows: state.invalidRows,
      error_count: state.errorCount,
      warning_count: state.warningCount,
      rows_with_warnings: state.rowsWithWarnings,
      technical_error_count: state.technicalErrorCount,
      suppressed_error_count: state.suppressedErrorCount,
      processing_progress_percent: estimatedProgress
    }).eq("id", job.upload_batch_id)
  ]);
}

async function ensureJobNotCancelled(supabase: SupabaseClient, job: ImportJobRow, state: ProcessState, force = false) {
  if (!force && state.totalRows % SECURITY_LIMITS.importBatchSize !== 0) return;

  const { data, error } = await supabase
    .from("import_jobs")
    .select("status,cancel_requested")
    .eq("id", job.id)
    .maybeSingle();

  if (error) throw error;
  if (data?.status === "cancelled" || data?.cancel_requested) throw new ImportCancelledError();
}

async function flushBatches(supabase: SupabaseClient, job: ImportJobRow, state: ProcessState, context: WorkerContext, force = false) {
  if (!force && state.batch.length < SECURITY_LIMITS.importBatchSize) return;
  if (!state.batch.length && !state.importErrors.length) return;
  await ensureJobNotCancelled(supabase, job, state, true);
  const records = state.batch.splice(0, state.batch.length);
  const errors = state.importErrors.splice(0, state.importErrors.length);
  const flushIndex = state.flushCount;
  state.flushCount += 1;

  async function insertRecordChunk(chunk: Array<Record<string, unknown>>, flushIndexValue: number, chunkIndex: number, depth = 0): Promise<void> {
    const minAdaptiveChunk = 50;
    try {
      await logger.info({
        ...context,
        module: "upload",
        action: "batch_insert_started",
        message: "Import batch insert started.",
        status: "started",
        metadata: { flushIndex: flushIndexValue, chunkIndex, rowCount: chunk.length, insertChunkSize: SECURITY_LIMITS.uploadChunkSize, depth, memory: memoryUsageMb() }
      });
      const { error } = await supabase.from("business_records").insert(chunk);
      if (error) throw error;
      await logger.info({
        ...context,
        module: "upload",
        action: "batch_insert_completed",
        message: "Import batch inserted.",
        status: "completed",
        metadata: { flushIndex: flushIndexValue, chunkIndex, rowCount: chunk.length, insertChunkSize: SECURITY_LIMITS.uploadChunkSize, depth, memory: memoryUsageMb() }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      if (chunk.length <= minAdaptiveChunk || !/57014|statement timeout/i.test(message)) throw error;
      const middle = Math.ceil(chunk.length / 2);
      await logger.warn({
        ...context,
        module: "upload",
        action: "batch_insert_adaptive_split",
        message: "Import batch insert timed out; splitting chunk.",
        status: "started",
        metadata: { flushIndex: flushIndexValue, chunkIndex, rowCount: chunk.length, nextChunkSize: middle, depth },
        error
      });
      await insertRecordChunk(chunk.slice(0, middle), flushIndexValue, chunkIndex * 2, depth + 1);
      await insertRecordChunk(chunk.slice(middle), flushIndexValue, chunkIndex * 2 + 1, depth + 1);
    }
  }

  if (records.length) {
    const insertChunkSize = Math.max(1, SECURITY_LIMITS.uploadChunkSize);
    for (let index = 0; index < records.length; index += insertChunkSize) {
      const chunk = records.slice(index, index + insertChunkSize);
      await insertRecordChunk(chunk, flushIndex, index / insertChunkSize);
    }
  }

  if (errors.length) {
    const { error } = await supabase.from("import_errors").insert(errors.map(toImportErrorRow));
    if (error) throw error;
    await supabase.from("import_job_errors").insert(errors.map((item) => ({
      job_id: job.id,
      upload_batch_id: job.upload_batch_id,
      row_number: item.row_index,
      error_message: item.message,
      raw_data: item.raw_data ?? {}
    })));
  }

  await updateProgress(supabase, job, state);
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
      memory: memoryUsageMb()
    }
  });
}

export async function recoverStaleImportJobs(supabase: SupabaseClient, workerId: string) {
  const staleCutoff = new Date(Date.now() - SECURITY_LIMITS.workerStaleAfterMinutes * 60 * 1000).toISOString();
  const { data: staleJobs, error } = await supabase
    .from("import_jobs")
    .select("id,upload_batch_id,attempts,max_attempts,error_message")
    .eq("status", "processing")
    .lt("heartbeat_at", staleCutoff)
    .limit(25);
  if (error) throw error;

  for (const stale of staleJobs ?? []) {
    const attempts = Number(stale.attempts ?? 0);
    const maxAttempts = Number(stale.max_attempts ?? SECURITY_LIMITS.workerMaxAttempts);
    const nextStatus = attempts >= maxAttempts ? "failed" : "retrying";
    const message = "Worker heartbeat expired; job recovered by worker.";
    await Promise.all([
      supabase.from("import_jobs").update({
        status: nextStatus,
        locked_at: null,
        locked_by: null,
        worker_id: null,
        next_retry_at: nextStatus === "retrying" ? nowIso() : null,
        last_error: stale.error_message ?? message,
        error_message: nextStatus === "failed" ? message : null,
        finished_at: nextStatus === "failed" ? nowIso() : null,
        updated_at: nowIso()
      }).eq("id", stale.id).eq("status", "processing"),
      supabase.from("upload_batches").update({
        status: nextStatus,
        error_message: nextStatus === "failed" ? message : null
      }).eq("id", stale.upload_batch_id)
    ]);
    await logger.warn({
      traceId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      route: "import-worker",
      method: "WORKER",
      module: "upload",
      action: "stale_job_recovered",
      message,
      status: "completed",
      uploadBatchId: stale.upload_batch_id,
      metadata: { jobId: stale.id, workerId, nextStatus }
    });
  }
}

async function createSheetState(supabase: SupabaseClient, job: ImportJobRow, sheetIndex: number, sheetName: string, bufferedRows: RawCell[][], context: WorkerContext) {
  const header = detectHeaderRow(bufferedRows, 30, context);
  const { data, error } = await supabase.from("upload_sheets").insert({
    upload_batch_id: job.upload_batch_id,
    sheet_name: sheetName,
    detected_header_row: header.headerRowIndex + 1,
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    detected_category: "Generic"
  }).select("id").single();
  if (error || !data) throw error ?? new Error("Unable to create upload sheet.");
  return {
    sheetId: data.id,
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
  await ensureJobNotCancelled(supabase, job, state);

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
      raw_value: issue.rawValue ?? null,
      severity: issue.severity,
      raw_data: rawData,
      job_id: job.id
    });
  }
  if (errors.length > rowErrorLimit) state.suppressedErrorCount += errors.length - rowErrorLimit;

  await flushBatches(supabase, job, state, context);
}

async function finalizeSheets(supabase: SupabaseClient, state: ProcessState) {
  for (const sheet of state.sheetRows) {
    await supabase.from("upload_sheets").update({
      total_rows: sheet.totalRows,
      valid_rows: sheet.validRows,
      invalid_rows: sheet.invalidRows,
      detected_category: detectDominantCategory(sheet.categories)
    }).eq("id", sheet.sheetId);
  }
}

async function persistErrorSummary(supabase: SupabaseClient, job: ImportJobRow, state: ProcessState) {
  const summaryRows = Array.from(state.errorSummary.values());
  await supabase.from("import_job_error_summary").delete().eq("job_id", job.id);
  if (!summaryRows.length) return;
  const { error } = await supabase.from("import_job_error_summary").insert(summaryRows);
  if (error) throw error;
}

async function processXlsxFile(supabase: SupabaseClient, job: ImportJobRow, filePath: string, state: ProcessState, context: WorkerContext) {
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
        sheetState = await createSheetState(supabase, job, sheetIndex, sheetName, bufferedRows, context);
        state.sheetRows.push(sheetState);
        const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
        for (const [offset, buffered] of dataRows.entries()) {
          await processDataRow(supabase, job, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
        }
      }
      await processDataRow(supabase, job, state, sheetState, values, rowNumber, context);
    }

    if (!sheetState && bufferedRows.length) {
      const sheetName = (worksheet as { name?: string }).name ?? `Sheet ${sheetIndex + 1}`;
      sheetState = await createSheetState(supabase, job, sheetIndex, sheetName, bufferedRows, context);
      state.sheetRows.push(sheetState);
      const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
      for (const [offset, buffered] of dataRows.entries()) {
        await processDataRow(supabase, job, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
      }
    }
    sheetIndex += 1;
  }
}

async function processCsvFile(supabase: SupabaseClient, job: ImportJobRow, filePath: string, state: ProcessState, context: WorkerContext) {
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
      sheetState = await createSheetState(supabase, job, 0, "CSV", bufferedRows, context);
      state.sheetRows.push(sheetState);
      const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
      for (const [offset, buffered] of dataRows.entries()) {
        await processDataRow(supabase, job, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
      }
    }
    await processDataRow(supabase, job, state, sheetState, values, rowIndex, context);
  }

  if (!sheetState && bufferedRows.length) {
    sheetState = await createSheetState(supabase, job, 0, "CSV", bufferedRows, context);
    state.sheetRows.push(sheetState);
    const dataRows = bufferedRows.slice(sheetState.header.headerRowIndex + 1);
    for (const [offset, buffered] of dataRows.entries()) {
      await processDataRow(supabase, job, state, sheetState, buffered, sheetState.header.headerRowIndex + offset + 2, context);
    }
  }
}

async function downloadStorageObjectToTemp(supabase: SupabaseClient, job: ImportJobRow, context: WorkerContext) {
  const tempRoot = process.env.UPLOAD_TEMP_DIR || path.join(os.tmpdir(), "quiksol-imports");
  await fs.promises.mkdir(tempRoot, { recursive: true });
  const safeName = sanitizeFileName(job.original_file_name);
  const localPath = path.join(tempRoot, `${job.id}-${safeName}`);
  const { data, error } = await supabase.storage.from(job.storage_bucket).createSignedUrl(job.storage_path, 60 * 60);
  if (error || !data?.signedUrl) throw error ?? new Error("Unable to create signed download URL.");

  await logger.info({
    ...context,
    module: "upload",
    action: "worker_storage_download_started",
    message: "Worker storage download started.",
    status: "started",
    metadata: { bucket: job.storage_bucket, sizeBytes: job.size_bytes }
  });

  const response = await fetch(data.signedUrl);
  if (!response.ok || !response.body) throw new Error(`Storage download failed with status ${response.status}.`);
  const webStream = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), fs.createWriteStream(localPath));
  return localPath;
}

export async function claimNextImportJob(supabase: SupabaseClient, workerId: string) {
  const rpcClaim = await supabase
    .rpc("claim_import_job", {
      worker_id_input: workerId,
      stale_after: `${SECURITY_LIMITS.workerStaleAfterMinutes} minutes`
    })
    .limit(1);
  if (!rpcClaim.error && rpcClaim.data?.[0]) return rpcClaim.data[0] as ImportJobRow;
  if (rpcClaim.error && !/claim_import_job|function/i.test(rpcClaim.error.message ?? "")) throw rpcClaim.error;

  await recoverStaleImportJobs(supabase, workerId);
  const { data: jobs, error } = await supabase
    .from("import_jobs")
    .select("*")
    .in("status", ["queued", "retrying"])
    .lt("attempts", SECURITY_LIMITS.workerMaxAttempts)
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso()}`)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const job = jobs?.[0] as ImportJobRow | undefined;
  if (!job) return null;

  const { data: claimed, error: claimError } = await supabase
    .from("import_jobs")
    .update({
      status: "processing",
      attempts: job.attempts + 1,
      locked_at: nowIso(),
      locked_by: workerId,
      worker_id: workerId,
      heartbeat_at: nowIso(),
      started_at: nowIso(),
      updated_at: nowIso()
    })
    .eq("id", job.id)
    .in("status", ["queued", "retrying"])
    .select("*")
    .maybeSingle();
  if (claimError) throw claimError;
  return claimed as ImportJobRow | null;
}

export async function processImportJob(supabase: SupabaseClient, job: ImportJobRow, workerId = "worker") {
  const startedAt = performance.now();
  const context: WorkerContext = {
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    userId: job.uploaded_by,
    fileName: job.original_file_name,
    uploadBatchId: job.upload_batch_id,
    jobId: job.id
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
  const heartbeatTimer = setInterval(() => {
    void updateHeartbeat(supabase, job, workerId).catch(() => undefined);
  }, SECURITY_LIMITS.workerHeartbeatIntervalMs);
  try {
    await updateHeartbeat(supabase, job, workerId);
    await Promise.all([
      supabase.from("upload_batches").update({ status: "processing", processing_started_at: nowIso(), error_message: null }).eq("id", job.upload_batch_id),
      supabase.from("business_records").delete().eq("upload_batch_id", job.upload_batch_id),
      supabase.from("import_errors").delete().eq("upload_batch_id", job.upload_batch_id),
      supabase.from("import_job_errors").delete().eq("job_id", job.id),
      supabase.from("import_job_error_summary").delete().eq("job_id", job.id),
      supabase.from("upload_sheets").delete().eq("upload_batch_id", job.upload_batch_id)
    ]);

    await logger.info({
      ...context,
        module: "upload",
        action: "processing_started",
      message: "Background import processing started.",
      status: "started",
        metadata: { workerId, sizeBytes: job.size_bytes, memoryUsage: memoryUsageMb() }
      });

    localPath = await downloadStorageObjectToTemp(supabase, job, context);
    const extension = getFileExtension(job.original_file_name);
    if (extension === ".csv") await processCsvFile(supabase, job, localPath, state, context);
    else await processXlsxFile(supabase, job, localPath, state, context);

    await flushBatches(supabase, job, state, context, true);
    await ensureJobNotCancelled(supabase, job, state, true);
    await finalizeSheets(supabase, state);
    await persistErrorSummary(supabase, job, state);
    const detectedCategory = detectDominantCategory(state.categoryVotes);
    const dataQualityScore = state.totalRows ? Math.round(((state.totalRows - state.rowsWithWarnings) / state.totalRows) * 1000) / 10 : 0;
    const finishedStatus = finalImportStatus(state);
    const finishedAt = nowIso();
    await Promise.all([
      supabase.from("import_jobs").update({
        status: finishedStatus,
        total_rows: state.totalRows,
        processed_rows: state.totalRows,
        successful_rows: state.validRows,
        failed_rows: state.invalidRows,
        warning_count: state.warningCount,
        rows_with_warnings: state.rowsWithWarnings,
        technical_error_count: state.technicalErrorCount,
        suppressed_error_count: state.suppressedErrorCount,
        progress_percent: 100,
        error_message: null,
        finished_at: finishedAt,
        duration_ms: Math.round(performance.now() - startedAt),
        locked_at: null,
        locked_by: null,
        updated_at: finishedAt
      }).eq("id", job.id),
      supabase.from("upload_batches").update({
        status: finishedStatus,
        detected_category: detectedCategory,
        total_sheets: state.sheetRows.length,
        total_rows: state.totalRows,
        processed_rows: state.totalRows,
        valid_rows: state.validRows,
        invalid_rows: state.invalidRows,
        successful_rows: state.validRows,
        failed_rows: state.invalidRows,
        error_count: state.errorCount,
        warning_count: state.warningCount,
        rows_with_warnings: state.rowsWithWarnings,
        technical_error_count: state.technicalErrorCount,
        suppressed_error_count: state.suppressedErrorCount,
        data_quality_score: dataQualityScore,
        processing_progress_percent: 100,
        completed_at: finishedAt,
        error_message: null
      }).eq("id", job.upload_batch_id)
    ]);

    await logger.audit({
      ...context,
      module: "upload",
      action: "processing_completed",
      message: finishedStatus === "completed_with_warnings" ? "Background import processing completed with warnings." : "Background import processing completed.",
      status: "completed",
      durationMs: Math.round(performance.now() - startedAt),
      category: detectedCategory,
      metadata: { totalRows: state.totalRows, validRows: state.validRows, invalidRows: state.invalidRows, warningCount: state.warningCount, rowsWithWarnings: state.rowsWithWarnings, technicalErrorCount: state.technicalErrorCount, suppressedErrorCount: state.suppressedErrorCount, errorCount: state.errorCount, memory: memoryUsageMb() }
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
    if (error instanceof ImportCancelledError) {
      const cancelledAt = nowIso();
      await Promise.all([
        supabase.from("import_jobs").update({
          status: "cancelled",
          error_message: "Cancelled by user.",
          cancelled_at: cancelledAt,
          finished_at: cancelledAt,
          duration_ms: Math.round(performance.now() - startedAt),
          locked_at: null,
          locked_by: null,
          worker_id: null,
          updated_at: cancelledAt
        }).eq("id", job.id),
        supabase.from("upload_batches").update({
          status: "cancelled",
          error_message: "Cancelled by user.",
          cancelled_at: cancelledAt,
          completed_at: cancelledAt
        }).eq("id", job.upload_batch_id)
      ]);
      await logger.info({
        ...context,
        module: "upload",
        action: "processing_cancelled",
        message: "Background import processing cancelled.",
        status: "completed",
        durationMs: Math.round(performance.now() - startedAt),
        metadata: { workerId, processedRows: state.totalRows, memory: memoryUsageMb() }
      });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown import worker error.";
    const canRetry = job.attempts < job.max_attempts;
    const nextRetryAt = new Date(Date.now() + Math.min(60_000 * job.attempts, 5 * 60_000)).toISOString();
    await Promise.all([
      supabase.from("import_jobs").update({
        status: canRetry ? "retrying" : "failed",
        error_message: canRetry ? null : message,
        last_error: message,
        next_retry_at: canRetry ? nextRetryAt : null,
        finished_at: canRetry ? null : nowIso(),
        duration_ms: Math.round(performance.now() - startedAt),
        locked_at: null,
        locked_by: null,
        worker_id: null,
        updated_at: nowIso()
      }).eq("id", job.id),
      supabase.from("upload_batches").update({
        status: canRetry ? "retrying" : "failed",
        error_message: canRetry ? "Processing failed and will be retried by the worker." : message,
        completed_at: canRetry ? null : nowIso()
      }).eq("id", job.upload_batch_id)
    ]);
    await logger.error({
      ...context,
      module: "upload",
      action: "processing_failed",
      message: "Background import processing failed.",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { memoryUsage: memoryUsageMb(), tempDiskUsageMb: await tempDiskUsageMb(localPath), workerId, retryScheduled: canRetry, nextRetryAt },
      error
    });
    await evaluateEmailAlertRules({
      eventType: "upload_failed",
      actorName: "Background import worker",
      actorEmail: null,
      fileName: job.original_file_name,
      uploadBatchId: job.upload_batch_id,
      errorCount: 1,
      metadata: { message, workerId }
    });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    if (localPath) await fs.promises.unlink(localPath).catch(() => undefined);
  }
}
