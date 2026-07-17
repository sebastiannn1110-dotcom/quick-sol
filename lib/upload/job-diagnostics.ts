import type { SupabaseClient } from "@supabase/supabase-js";

type ImportTerminalStatus = "completed" | "completed_with_warnings" | "cancelled";

export type ImportJobDiagnosticRow = {
  id: string;
  upload_batch_id: string;
  status: string;
  total_rows: number | null;
  processed_rows: number | null;
  successful_rows: number | null;
  failed_rows: number | null;
  attempts: number | null;
  max_attempts: number | null;
  warning_count?: number | null;
  rows_with_warnings?: number | null;
  technical_error_count?: number | null;
  suppressed_error_count?: number | null;
  progress_percent?: number | null;
  error_message?: string | null;
  last_error?: string | null;
  heartbeat_at?: string | null;
  locked_by?: string | null;
  locked_at?: string | null;
  next_retry_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  original_file_name?: string | null;
  worker_id?: string | null;
};

export type UploadDiagnosticRow = {
  id: string;
  status: string;
  total_rows: number | null;
  processed_rows?: number | null;
  valid_rows?: number | null;
  invalid_rows?: number | null;
  successful_rows?: number | null;
  failed_rows?: number | null;
  error_count?: number | null;
  warning_count?: number | null;
  rows_with_warnings?: number | null;
  technical_error_count?: number | null;
  suppressed_error_count?: number | null;
  processing_progress_percent?: number | null;
  error_message?: string | null;
  worker_last_heartbeat_at?: string | null;
};

export type ImportDiagnosticsCounts = {
  rowsTotal: number;
  rowsProcessed: number;
  rowsImported: number;
  failedRows: number;
  businessRecords: number;
  businessRecordsWithWarnings: number;
  recordOverflow: number;
  technicalErrors: number;
  warningCount: number;
  rowsWithWarnings: number;
  suppressedWarnings: number;
  importErrorSamples: number;
  technicalImportErrorSamples: number;
  jobErrorSamples: number;
  groupedWarnings: number;
};

export type SafeFinalizeAssessment = {
  possible: boolean;
  reason: string;
  recommendedAction: string;
};

type SummaryRow = {
  error_type: string | null;
  severity: string | null;
  message: string | null;
  occurrence_count: number | null;
  sample_row_number: number | null;
};

const TERMINAL_STATUSES: ImportTerminalStatus[] = ["completed", "completed_with_warnings", "cancelled"];

function numberValue(...values: Array<number | null | undefined>) {
  const numericValues = values.map((item) => Number(item ?? 0)).filter(Number.isFinite);
  return Math.max(0, ...numericValues);
}

function countValue(count: number | null | undefined) {
  return Number.isFinite(Number(count)) ? Number(count) : 0;
}

function finalStatusForCounts(counts: ImportDiagnosticsCounts) {
  return counts.warningCount > 0 || counts.rowsWithWarnings > 0 || counts.suppressedWarnings > 0 || counts.failedRows > 0
    ? "completed_with_warnings"
    : "completed";
}

export function redactDiagnosticText(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]")
    .replace(/\b(?:\+?\d[\d\s().-]{6,}\d)\b/g, "[redacted_number]")
    .replace(/\$\s?\d+(?:[,.]\d+)*/g, "[redacted_amount]")
    .replace(/\b\d{8,}\b/g, "[redacted_number]");
}

export function buildSafeFinalizeAssessment(input: {
  jobStatus: string;
  counts: ImportDiagnosticsCounts;
}): SafeFinalizeAssessment {
  const { jobStatus, counts } = input;
  if (TERMINAL_STATUSES.includes(jobStatus as ImportTerminalStatus)) {
    return {
      possible: false,
      reason: "Job already has a terminal status.",
      recommendedAction: "No action needed."
    };
  }

  const rowsHandled = counts.rowsTotal > 0 && (counts.rowsProcessed >= counts.rowsTotal || counts.rowsImported >= counts.rowsTotal);
  if (!rowsHandled) {
    return {
      possible: false,
      reason: "Safe finalize requires all rows to be processed or imported.",
      recommendedAction: "Let the worker continue or investigate a real technical failure."
    };
  }

  if (counts.rowsImported <= 0) {
    return {
      possible: false,
      reason: "Safe finalize requires at least one imported row.",
      recommendedAction: "Retry only after confirming why no records were inserted."
    };
  }

  if (counts.technicalErrors > 0) {
    return {
      possible: false,
      reason: "Safe finalize is blocked because technical errors are recorded.",
      recommendedAction: "Fix the technical error, then retry."
    };
  }

  return {
    possible: true,
    reason: "All rows are accounted for, records exist, and no technical errors are recorded.",
    recommendedAction: "Run safe finalize."
  };
}

export async function getImportJobDiagnostics(supabase: SupabaseClient, jobId: string) {
  const { data: job, error: jobError } = await supabase
    .from("import_jobs")
    .select("id,upload_batch_id,status,total_rows,processed_rows,successful_rows,failed_rows,attempts,max_attempts,warning_count,rows_with_warnings,technical_error_count,suppressed_error_count,progress_percent,error_message,last_error,heartbeat_at,locked_by,locked_at,next_retry_at,started_at,finished_at,duration_ms,original_file_name,worker_id")
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return null;

  const typedJob = job as ImportJobDiagnosticRow;
  const uploadBatchId = typedJob.upload_batch_id;
  const [
    uploadResult,
    recordCount,
    recordWarnings,
    importErrors,
    technicalImportErrors,
    jobErrors,
    groupedWarnings,
    groupedWarningRows
  ] = await Promise.all([
    supabase
      .from("upload_batches")
      .select("id,status,total_rows,processed_rows,valid_rows,invalid_rows,successful_rows,failed_rows,error_count,warning_count,rows_with_warnings,technical_error_count,suppressed_error_count,processing_progress_percent,error_message,worker_last_heartbeat_at")
      .eq("id", uploadBatchId)
      .maybeSingle(),
    supabase.from("business_records").select("id", { count: "estimated", head: true }).eq("upload_batch_id", uploadBatchId).is("archived_at", null),
    supabase.from("business_records").select("id", { count: "estimated", head: true }).eq("upload_batch_id", uploadBatchId).is("archived_at", null).eq("has_errors", true),
    supabase.from("import_errors").select("id", { count: "exact", head: true }).eq("upload_batch_id", uploadBatchId),
    supabase.from("import_errors").select("id", { count: "exact", head: true }).eq("upload_batch_id", uploadBatchId).or("error_type.eq.technical_error,severity.eq.critical"),
    supabase.from("import_job_errors").select("id", { count: "exact", head: true }).eq("job_id", jobId),
    supabase.from("import_job_error_summary").select("id", { count: "exact", head: true }).eq("job_id", jobId),
    supabase
      .from("import_job_error_summary")
      .select("error_type,severity,message,occurrence_count,sample_row_number")
      .eq("job_id", jobId)
      .order("occurrence_count", { ascending: false })
      .limit(20)
  ]);

  if (uploadResult.error) throw uploadResult.error;
  if (recordCount.error) throw recordCount.error;
  if (recordWarnings.error) throw recordWarnings.error;
  if (importErrors.error) throw importErrors.error;
  if (technicalImportErrors.error) throw technicalImportErrors.error;
  if (jobErrors.error) throw jobErrors.error;
  if (groupedWarnings.error) throw groupedWarnings.error;
  if (groupedWarningRows.error) throw groupedWarningRows.error;

  const upload = (uploadResult.data ?? null) as UploadDiagnosticRow | null;
  const businessRecords = countValue(recordCount.count);
  const businessRecordsWithWarnings = countValue(recordWarnings.count);
  const declaredRowsImported = numberValue(typedJob.successful_rows, upload?.successful_rows, upload?.valid_rows);
  const rowsImported = declaredRowsImported > 0 ? declaredRowsImported : businessRecords;
  const rowsTotal = numberValue(typedJob.total_rows, upload?.total_rows, rowsImported);
  const rowsProcessed = numberValue(typedJob.processed_rows, upload?.processed_rows, rowsImported);
  const technicalErrors = numberValue(typedJob.technical_error_count, upload?.technical_error_count, technicalImportErrors.count);
  const importErrorCount = countValue(importErrors.count);
  const technicalImportErrorCount = countValue(technicalImportErrors.count);
  const declaredWarningCount = numberValue(typedJob.warning_count, upload?.warning_count);
  const warningCount = declaredWarningCount > 0 ? declaredWarningCount : Math.max(0, importErrorCount - technicalImportErrorCount);
  const declaredRowsWithWarnings = numberValue(typedJob.rows_with_warnings, upload?.rows_with_warnings);
  const rowsWithWarnings = declaredRowsWithWarnings > 0 ? declaredRowsWithWarnings : businessRecordsWithWarnings;
  const failedRows = numberValue(
    typedJob.failed_rows,
    upload?.failed_rows,
    upload?.invalid_rows,
    rowsTotal > rowsImported ? rowsTotal - rowsImported : 0
  );
  const counts: ImportDiagnosticsCounts = {
    rowsTotal,
    rowsProcessed,
    rowsImported,
    failedRows,
    businessRecords,
    businessRecordsWithWarnings,
    recordOverflow: Math.max(0, businessRecords - rowsTotal),
    technicalErrors,
    warningCount,
    rowsWithWarnings,
    suppressedWarnings: numberValue(typedJob.suppressed_error_count, upload?.suppressed_error_count),
    importErrorSamples: importErrorCount,
    technicalImportErrorSamples: technicalImportErrorCount,
    jobErrorSamples: countValue(jobErrors.count),
    groupedWarnings: countValue(groupedWarnings.count)
  };

  return {
    job: {
      ...typedJob,
      error_message: redactDiagnosticText(typedJob.error_message),
      last_error: redactDiagnosticText(typedJob.last_error)
    },
    upload: upload
      ? {
          ...upload,
          error_message: redactDiagnosticText(upload.error_message)
        }
      : null,
    counts,
    groupedWarningSamples: ((groupedWarningRows.data ?? []) as SummaryRow[]).map((row) => ({
      error_type: row.error_type,
      severity: row.severity,
      message: redactDiagnosticText(row.message),
      occurrence_count: row.occurrence_count,
      sample_row_number: row.sample_row_number
    })),
    safeFinalize: buildSafeFinalizeAssessment({ jobStatus: typedJob.status, counts })
  };
}

export async function finalizeImportJobSafely(
  supabase: SupabaseClient,
  jobId: string,
  options: { reason?: string; durationMs?: number } = {}
) {
  const diagnostics = await getImportJobDiagnostics(supabase, jobId);
  if (!diagnostics?.safeFinalize.possible) {
    return { finalized: false, diagnostics };
  }

  const finishedAt = new Date().toISOString();
  const status = finalStatusForCounts(diagnostics.counts);
  const warningMessage = status === "completed_with_warnings" ? "Archivo procesado con advertencias de calidad." : null;

  const jobUpdate = await supabase
    .from("import_jobs")
    .update({
      status,
      total_rows: diagnostics.counts.rowsTotal,
      processed_rows: diagnostics.counts.rowsTotal,
      successful_rows: diagnostics.counts.rowsImported,
      failed_rows: diagnostics.counts.failedRows,
      warning_count: diagnostics.counts.warningCount,
      rows_with_warnings: diagnostics.counts.rowsWithWarnings,
      technical_error_count: 0,
      suppressed_error_count: diagnostics.counts.suppressedWarnings,
      progress_percent: 100,
      error_message: null,
      last_error: null,
      next_retry_at: null,
      finished_at: finishedAt,
      duration_ms: options.durationMs ?? diagnostics.job.duration_ms ?? null,
      locked_at: null,
      locked_by: null,
      worker_id: null,
      updated_at: finishedAt
    })
    .eq("id", jobId);
  if (jobUpdate.error) throw jobUpdate.error;

  const uploadUpdate = await supabase
    .from("upload_batches")
    .update({
      status,
      total_rows: diagnostics.counts.rowsTotal,
      processed_rows: diagnostics.counts.rowsTotal,
      valid_rows: diagnostics.counts.rowsImported,
      invalid_rows: diagnostics.counts.failedRows,
      successful_rows: diagnostics.counts.rowsImported,
      failed_rows: diagnostics.counts.failedRows,
      error_count: diagnostics.counts.warningCount + diagnostics.counts.technicalErrors,
      warning_count: diagnostics.counts.warningCount,
      rows_with_warnings: diagnostics.counts.rowsWithWarnings,
      technical_error_count: 0,
      suppressed_error_count: diagnostics.counts.suppressedWarnings,
      processing_progress_percent: 100,
      completed_at: finishedAt,
      error_message: warningMessage
    })
    .eq("id", diagnostics.job.upload_batch_id);
  if (uploadUpdate.error) throw uploadUpdate.error;

  return {
    finalized: true,
    status,
    reason: options.reason ?? diagnostics.safeFinalize.reason,
    diagnostics
  };
}
