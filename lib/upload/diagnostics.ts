import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors/AppError";
import { getSupabasePublishableKey, getSupabaseServiceRoleKey, getRowsPerFileLimit, SECURITY_LIMITS } from "@/lib/security/env";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";
import { isMissingSchemaError, type SupabaseErrorLike } from "@/lib/supabase/schema-errors";

export const BACKGROUND_IMPORT_MIGRATION = "20260706000000_background_import_jobs.sql";
export const DEFAULT_UPLOAD_BUCKET = "excel-uploads";
export const DEFAULT_UPLOAD_PROVIDER = "supabase";
export const SAFE_DEFAULT_ROWS_PER_FILE = 100_000;
export const ADVANCED_MAX_ROWS_PER_FILE = 1_000_000;

export interface UploadRuntimeDiagnostics {
  provider: string;
  storageBucket: string;
  backgroundImportsEnabled: boolean;
  maxUploadSizeMb: number;
  maxRowsPerFile: number;
  maxExcelRowsEnv: number | null;
  maxRowsPerFileEnv: number | null;
  maxExcelSheets: number;
  importBatchSize: number;
  uploadTempDir: string;
  workerConcurrency: number;
  workerPollIntervalMs: number;
  hasSupabaseUrl: boolean;
  hasPublishableKey: boolean;
  hasServiceRoleKey: boolean;
  warnings: string[];
  errors: string[];
}

function envNumber(name: string) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function supabaseErrorMetadata(error: unknown) {
  const supabaseError = (typeof error === "object" && error !== null ? error : {}) as SupabaseErrorLike;
  return {
    errorMessage: supabaseError.message ?? (error instanceof Error ? error.message : String(error ?? "")),
    errorStack: error instanceof Error ? error.stack : undefined,
    supabaseErrorCode: supabaseError.code,
    supabaseErrorDetails: supabaseError.details,
    supabaseErrorHint: supabaseError.hint
  };
}

export function getSupabaseErrorMetadata(error: unknown) {
  return supabaseErrorMetadata(error);
}

function isRlsError(error: unknown) {
  const metadata = supabaseErrorMetadata(error);
  return metadata.supabaseErrorCode === "42501" || /row-level security|permission denied/i.test(metadata.errorMessage);
}

function isMissingBucketError(error: unknown) {
  const metadata = supabaseErrorMetadata(error);
  return /bucket.*not.*found|not found|does not exist/i.test(metadata.errorMessage);
}

export function getUploadRuntimeDiagnostics(): UploadRuntimeDiagnostics {
  const provider = (process.env.UPLOAD_STORAGE_PROVIDER || DEFAULT_UPLOAD_PROVIDER).trim().toLowerCase();
  const storageBucket = (process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_UPLOAD_BUCKET).trim();
  const backgroundValue = process.env.ENABLE_BACKGROUND_IMPORTS;
  const maxRowsPerFileEnv = envNumber("MAX_ROWS_PER_FILE");
  const maxExcelRowsEnv = envNumber("MAX_EXCEL_ROWS");
  const maxRowsPerFile = getRowsPerFileLimit();
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) errors.push("Missing NEXT_PUBLIC_SUPABASE_URL.");
  if (!getSupabasePublishableKey()) errors.push("Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  if (!getSupabaseServiceRoleKey()) errors.push("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY for upload initiation.");
  if (!process.env.SUPABASE_STORAGE_BUCKET) warnings.push(`SUPABASE_STORAGE_BUCKET is not set. Using default ${DEFAULT_UPLOAD_BUCKET}.`);
  if (!process.env.UPLOAD_STORAGE_PROVIDER) warnings.push(`UPLOAD_STORAGE_PROVIDER is not set. Using default ${DEFAULT_UPLOAD_PROVIDER}.`);
  if (provider !== DEFAULT_UPLOAD_PROVIDER) errors.push(`Unsupported UPLOAD_STORAGE_PROVIDER=${provider}. Only supabase is supported.`);
  if (!backgroundValue) warnings.push("ENABLE_BACKGROUND_IMPORTS is not set. Background imports are treated as enabled by default.");
  if (backgroundValue && backgroundValue.toLowerCase() !== "true") errors.push("ENABLE_BACKGROUND_IMPORTS is not true. The background import flow is disabled.");
  if (!maxRowsPerFileEnv) warnings.push(`MAX_ROWS_PER_FILE is not set. Using safe row limit ${maxRowsPerFile}. MAX_ROWS_PER_FILE has priority over MAX_EXCEL_ROWS.`);
  if (!maxRowsPerFileEnv && maxExcelRowsEnv && maxExcelRowsEnv > ADVANCED_MAX_ROWS_PER_FILE) {
    warnings.push(`MAX_EXCEL_ROWS=${maxExcelRowsEnv} is too high without MAX_ROWS_PER_FILE. Effective limit is ${SAFE_DEFAULT_ROWS_PER_FILE}.`);
  }
  if (maxRowsPerFile > ADVANCED_MAX_ROWS_PER_FILE) {
    warnings.push(`MAX_ROWS_PER_FILE=${maxRowsPerFile} is above the advanced tested recommendation ${ADVANCED_MAX_ROWS_PER_FILE}.`);
  }
  if (SECURITY_LIMITS.maxUploadSizeBytes / 1024 / 1024 > 500) warnings.push("MAX_UPLOAD_SIZE_MB is above 500 MB. Validate Render, Supabase and worker memory before production use.");

  return {
    provider,
    storageBucket,
    backgroundImportsEnabled: !backgroundValue || backgroundValue.toLowerCase() === "true",
    maxUploadSizeMb: Math.round(SECURITY_LIMITS.maxUploadSizeBytes / 1024 / 1024),
    maxRowsPerFile,
    maxExcelRowsEnv,
    maxRowsPerFileEnv,
    maxExcelSheets: SECURITY_LIMITS.maxExcelSheets,
    importBatchSize: SECURITY_LIMITS.importBatchSize,
    uploadTempDir: process.env.UPLOAD_TEMP_DIR || ".tmp/imports",
    workerConcurrency: SECURITY_LIMITS.workerConcurrency,
    workerPollIntervalMs: SECURITY_LIMITS.workerPollIntervalMs,
    hasSupabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    hasPublishableKey: Boolean(getSupabasePublishableKey()),
    hasServiceRoleKey: Boolean(getSupabaseServiceRoleKey()),
    warnings,
    errors
  };
}

export function assertUploadRuntimeReady(diagnostics: UploadRuntimeDiagnostics) {
  if (!diagnostics.errors.length) return;
  throw new AppError({
    code: "UPLOAD_ENV_ERROR",
    message: diagnostics.errors.join(" "),
    statusCode: 500,
    severity: "critical",
    safeMessage: "Falta configuracion del servidor para cargas grandes.",
    details: { diagnostics }
  });
}

export function uploadFileTooLargeError(message: string, details: Record<string, unknown>) {
  return new AppError({
    code: "UPLOAD_FILE_TOO_LARGE",
    message,
    statusCode: 413,
    severity: "medium",
    safeMessage: "El archivo supera el limite permitido.",
    details
  });
}

export function uploadDatabaseError(message: string, error: unknown, details: Record<string, unknown> = {}) {
  const metadata = supabaseErrorMetadata(error);
  const missingMigration = isMissingSchemaError(error);
  const rlsBlocked = isRlsError(error);
  return new AppError({
    code: missingMigration ? "UPLOAD_MIGRATION_MISSING" : rlsBlocked ? "UPLOAD_RLS_BLOCKED" : "UPLOAD_DATABASE_ERROR",
    message: missingMigration
      ? "Background import migration is missing or incomplete."
      : rlsBlocked
        ? "RLS policy blocked upload initiation."
        : message,
    statusCode: 500,
    severity: "high",
    safeMessage: "No se pudo preparar la carga por un problema de base de datos.",
    details: {
      ...details,
      requiredMigration: missingMigration ? BACKGROUND_IMPORT_MIGRATION : undefined,
      ...metadata
    }
  });
}

export function uploadStorageError(message: string, error: unknown, details: Record<string, unknown> = {}) {
  const metadata = supabaseErrorMetadata(error);
  return new AppError({
    code: isMissingBucketError(error) ? "UPLOAD_STORAGE_BUCKET_MISSING" : "UPLOAD_STORAGE_ERROR",
    message: isMissingBucketError(error)
      ? `Storage bucket ${details.storageBucket ?? DEFAULT_UPLOAD_BUCKET} does not exist or is not accessible.`
      : message,
    statusCode: 500,
    severity: "high",
    safeMessage: "No se pudo preparar la carga por un problema de Storage.",
    details: { ...details, ...metadata }
  });
}

export async function logUploadDiagnostic(
  context: LogContext,
  action: string,
  message: string,
  status: "started" | "completed" | "failed",
  metadata: Record<string, unknown> = {},
  error?: unknown
) {
  const payload = {
    ...context,
    module: "upload" as const,
    action,
    message,
    status,
    metadata: error ? { ...metadata, ...supabaseErrorMetadata(error) } : metadata,
    error
  };
  if (status === "failed") return logger.error(payload);
  return logger.info(payload);
}

export async function checkUploadSchema(supabase: SupabaseClient, context?: LogContext) {
  const checks = [
    {
      table: "upload_batches",
      query: supabase
        .from("upload_batches")
        .select("id,storage_bucket,upload_progress_percent,processing_progress_percent,idempotency_key")
        .limit(1)
    },
    {
      table: "import_jobs",
      query: supabase
        .from("import_jobs")
        .select("id,status,storage_bucket,storage_path,original_file_name,progress_percent")
        .limit(1)
    },
    {
      table: "import_job_errors",
      query: supabase
        .from("import_job_errors")
        .select("id,job_id,upload_batch_id,row_number,error_message,raw_data")
        .limit(1)
    }
  ];

  for (const check of checks) {
    const { error } = await check.query;
    if (!error) continue;
    if (context) {
      await logUploadDiagnostic(context, "database_schema_check_failed", `Upload schema check failed for ${check.table}.`, "failed", { table: check.table, requiredMigration: BACKGROUND_IMPORT_MIGRATION }, error);
    }
    throw uploadDatabaseError("Unable to validate background import database schema.", error, { table: check.table });
  }
}

export async function checkStorageBucket(service: SupabaseClient, storageBucket: string, context?: LogContext) {
  const { error } = await service.storage.getBucket(storageBucket);
  if (!error) return;
  if (context) {
    await logUploadDiagnostic(context, "storage_bucket_check_failed", `Storage bucket ${storageBucket} is not accessible.`, "failed", { storageBucket }, error);
  }
  throw uploadStorageError(`Storage bucket ${storageBucket} does not exist or is not accessible.`, error, { storageBucket });
}
