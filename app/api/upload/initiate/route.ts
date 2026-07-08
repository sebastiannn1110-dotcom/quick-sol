import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { AppError, FileValidationError, ValidationError } from "@/lib/errors/AppError";
import { handleRouteError } from "@/lib/errors/errorHandler";
import { safeStoragePath, sanitizeFileName, uploadFormSchema, validateUploadMetadata } from "@/lib/excel/validators";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { logger } from "@/lib/logger/logger";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  assertUploadRuntimeReady,
  checkStorageBucket,
  checkUploadSchema,
  getSupabaseErrorMetadata,
  getUploadRuntimeDiagnostics,
  logUploadDiagnostic,
  uploadDatabaseError,
  uploadFileTooLargeError,
  uploadStorageError
} from "@/lib/upload/diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const initiateSchema = z.object({
  fileName: z.string().trim().min(1).max(260),
  fileSize: z.number().int().positive(),
  fileType: z.string().trim().max(180).optional().nullable(),
  selectedCategory: z.string().default("Auto Detect"),
  department: z.string().trim().min(1),
  region: z.string().trim().min(1),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  idempotencyKey: z.string().trim().max(200).optional().nullable()
});

function supabaseResumableEndpoint(supabaseUrl: string) {
  const url = new URL(supabaseUrl);
  const host = url.hostname.endsWith(".supabase.co")
    ? url.hostname.replace(".supabase.co", ".storage.supabase.co")
    : url.hostname;
  return `${url.protocol}//${host}/storage/v1/upload/resumable`;
}

export async function POST(request: Request) {
  const requestLoggerContext = getLoggerContextFromRequest(request);
  const preAuthLogContext = {
    traceId: requestLoggerContext.traceId,
    requestId: requestLoggerContext.requestId,
    route: new URL(request.url).pathname,
    method: request.method
  };

    await logUploadDiagnostic(preAuthLogContext, "upload_initiate_received", "Upload initiate request received.", "started");
  await logUploadDiagnostic(preAuthLogContext, "auth_check_started", "Upload initiate auth check started.", "started");
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) {
    await logUploadDiagnostic(preAuthLogContext, "auth_check_failed", "Upload initiate auth check failed.", "failed", { responseStatus: context.status });
    return context;
  }
  const logContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: request.method
  };

  try {
    await logUploadDiagnostic(logContext, "auth_check_completed", "Upload initiate auth check completed.", "completed", { userId: context.profile.id });

    const body = await request.json().catch(() => null);
    await logUploadDiagnostic(logContext, "metadata_validation_started", "Upload metadata validation started.", "started");
    const parsed = initiateSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Upload initiate validation failed.", { issues: parsed.error.issues });
    const formParsed = uploadFormSchema.safeParse(parsed.data);
    if (!formParsed.success) throw new ValidationError("Upload form validation failed.", { issues: formParsed.error.issues });

    const fileErrors = validateUploadMetadata({
      fileName: parsed.data.fileName,
      fileSize: parsed.data.fileSize,
      fileType: parsed.data.fileType
    });
    const originalFileName = sanitizeFileName(parsed.data.fileName);
    const baseMetadata = {
      fileName: originalFileName,
      sizeBytes: parsed.data.fileSize
    };
    if (fileErrors.length) {
      const message = fileErrors.join(" ");
      if (/exceeds/i.test(message)) {
        throw uploadFileTooLargeError(message, baseMetadata);
      }
      throw new FileValidationError(message, baseMetadata);
    }
    await logUploadDiagnostic(logContext, "metadata_validation_completed", "Upload metadata validation completed.", "completed", baseMetadata);

    if (context.isDemoMode || !context.supabase) {
      throw new AppError({
        code: "UPLOAD_ENV_ERROR",
        message: "Background uploads require Supabase Storage.",
        statusCode: 503,
        severity: "high",
        safeMessage: "Falta configuracion del servidor para cargas grandes.",
        details: baseMetadata
      });
    }

    await logUploadDiagnostic(logContext, "env_validation_started", "Upload runtime environment validation started.", "started", baseMetadata);
    const diagnostics = getUploadRuntimeDiagnostics();
    assertUploadRuntimeReady(diagnostics);
    await logUploadDiagnostic(logContext, "env_validation_completed", "Upload runtime environment validation completed.", "completed", {
      ...baseMetadata,
      maxUploadSizeMb: diagnostics.maxUploadSizeMb,
      maxRowsPerFile: diagnostics.maxRowsPerFile,
      storageBucket: diagnostics.storageBucket,
      warnings: diagnostics.warnings
    });

    const rate = await checkPersistentRateLimit({
      action: "upload_initiate",
      identifier: context.profile.id,
      limit: 20,
      windowSeconds: 15 * 60,
      blockSeconds: 15 * 60
    });
    if (!rate.allowed) return rateLimitResponse(rate.resetAt);

    const service = createSupabaseServiceRoleClient();
    if (!service) {
      throw new AppError({
        code: "UPLOAD_ENV_ERROR",
        message: "Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY for upload initiation.",
        statusCode: 500,
        severity: "critical",
        safeMessage: "Falta configuracion del servidor para cargas grandes.",
        details: { ...baseMetadata, diagnostics }
      });
    }

    await checkUploadSchema(context.supabase, logContext);
    await checkStorageBucket(service, diagnostics.storageBucket, logContext);

    if (parsed.data.idempotencyKey) {
      const { data: existingUpload, error: existingError } = await context.supabase
        .from("upload_batches")
        .select("id, status, original_file_name")
        .eq("uploaded_by", context.profile.id)
        .eq("idempotency_key", parsed.data.idempotencyKey)
        .is("archived_at", null)
        .maybeSingle();
      if (existingError) throw uploadDatabaseError("Unable to check duplicate upload.", existingError, { ...baseMetadata, table: "upload_batches" });
      if (existingUpload) {
        const { data: existingJob } = await context.supabase
          .from("import_jobs")
          .select("id, status")
          .eq("upload_batch_id", existingUpload.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        await logger.warn({
          ...logContext,
          module: "upload",
          action: "duplicate_upload_blocked",
          message: "Duplicate upload idempotency key blocked.",
          status: "failed",
          uploadBatchId: existingUpload.id,
          metadata: { jobId: existingJob?.id ?? null, status: existingUpload.status }
        });
        return NextResponse.json({
          error: "This file already has an import job. Use retry from the upload history instead of uploading it again.",
          uploadId: existingUpload.id,
          jobId: existingJob?.id ?? null,
          status: existingUpload.status
        }, { status: 409 });
      }
    }

    const uploadBatchId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const bucket = diagnostics.storageBucket;
    const storagePath = safeStoragePath(context.profile.id, uploadBatchId, originalFileName);
    const uploadMetadata = {
      ...baseMetadata,
      uploadBatchId,
      jobId,
      storageBucket: bucket,
      maxUploadSizeMb: diagnostics.maxUploadSizeMb,
      maxRowsPerFile: diagnostics.maxRowsPerFile,
      resumableThresholdMb: diagnostics.resumableThresholdMb
    };
    const uploadStrategy = parsed.data.fileSize >= diagnostics.resumableThresholdMb * 1024 * 1024 ? "resumable" : "standard";

    await logUploadDiagnostic(logContext, "upload_batch_create_started", "Upload batch create started.", "started", uploadMetadata);
    const { error: batchError } = await context.supabase.from("upload_batches").insert({
      id: uploadBatchId,
      uploaded_by: context.profile.id,
      original_file_name: originalFileName,
      stored_file_path: storagePath,
      storage_bucket: bucket,
      file_type: parsed.data.fileType || originalFileName.split(".").pop(),
      file_size: parsed.data.fileSize,
      selected_category: parsed.data.selectedCategory,
      status: "pending_upload",
      total_rows: 0,
      valid_rows: 0,
      invalid_rows: 0,
      error_count: 0,
      upload_progress_percent: 0,
      processing_progress_percent: 0,
      upload_strategy: uploadStrategy,
      idempotency_key: parsed.data.idempotencyKey || null,
      notes: parsed.data.notes || null
    });
    if (batchError) throw uploadDatabaseError("Unable to create upload batch.", batchError, { ...uploadMetadata, table: "upload_batches" });
    await logUploadDiagnostic(logContext, "upload_batch_create_completed", "Upload batch create completed.", "completed", uploadMetadata);

    await logUploadDiagnostic(logContext, "import_job_create_started", "Import job create started.", "started", uploadMetadata);
    const { error: jobError } = await context.supabase.from("import_jobs").insert({
      id: jobId,
      upload_batch_id: uploadBatchId,
      uploaded_by: context.profile.id,
      status: "pending_upload",
      storage_bucket: bucket,
      storage_path: storagePath,
      original_file_name: originalFileName,
      mime_type: parsed.data.fileType || null,
      size_bytes: parsed.data.fileSize,
      selected_category: parsed.data.selectedCategory,
      department: parsed.data.department,
      region: parsed.data.region,
      notes: parsed.data.notes || null,
      upload_strategy: uploadStrategy,
      max_attempts: diagnostics.workerMaxAttempts
    });
    if (jobError) throw uploadDatabaseError("Unable to create import job.", jobError, { ...uploadMetadata, table: "import_jobs" });
    await logUploadDiagnostic(logContext, "import_job_create_completed", "Import job create completed.", "completed", uploadMetadata);

    await logUploadDiagnostic(logContext, "signed_upload_url_create_started", "Signed upload URL create started.", "started", uploadMetadata);
    const { data: signedUpload, error: signedError } = await service.storage.from(bucket).createSignedUploadUrl(storagePath);
    if (signedError || !signedUpload) {
      await Promise.all([
        context.supabase.from("upload_batches").update({ status: "failed", error_message: "Unable to create signed upload URL." }).eq("id", uploadBatchId),
        context.supabase.from("import_jobs").update({ status: "failed", error_message: "Unable to create signed upload URL.", updated_at: new Date().toISOString() }).eq("id", jobId)
      ]);
      throw uploadStorageError("Unable to create signed upload URL.", signedError, uploadMetadata);
    }
    await logUploadDiagnostic(logContext, "signed_upload_url_create_completed", "Signed upload URL create completed.", "completed", uploadMetadata);

    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_started",
      message: "Direct-to-storage upload initialized.",
      status: "completed",
      uploadBatchId,
      fileName: originalFileName,
      metadata: { jobId, bucket, storagePath, sizeBytes: parsed.data.fileSize, maxUploadSizeMb: diagnostics.maxUploadSizeMb, maxRowsPerFile: diagnostics.maxRowsPerFile, uploadStrategy }
    });
    await logAuditEvent(context, "upload_initialized", "upload_batch", uploadBatchId, { jobId, fileName: originalFileName });
    await logUploadDiagnostic(logContext, "upload_initiate_completed", "Upload initiate completed.", "completed", uploadMetadata);

    return NextResponse.json({
      uploadId: uploadBatchId,
      jobId,
      bucket,
      storagePath,
      signedUrl: signedUpload.signedUrl,
      token: signedUpload.token,
      path: signedUpload.path,
      uploadStrategy,
      resumable: {
        enabled: uploadStrategy === "resumable",
        thresholdMb: diagnostics.resumableThresholdMb,
        endpoint: supabaseResumableEndpoint(process.env.NEXT_PUBLIC_SUPABASE_URL!),
        chunkSizeBytes: 6 * 1024 * 1024
      },
      upload: {
        id: uploadBatchId,
        original_file_name: originalFileName,
        status: "pending_upload"
      }
    });
  } catch (error) {
    await logUploadDiagnostic(logContext, "initiate_failed", "Upload initiate failed.", "failed", {
      errorCode: error instanceof AppError ? error.code : "UNKNOWN_ERROR",
      caughtMessage: error instanceof Error ? error.message : "Unknown upload initiate error",
      ...getSupabaseErrorMetadata(error),
      ...(error instanceof AppError ? error.details : {})
    }, error);
    return handleRouteError(error, logContext, {
      module: "upload",
      action: "upload_initiate_failed",
      fallbackMessage: "Unable to initialize large file upload."
    });
  }
}
