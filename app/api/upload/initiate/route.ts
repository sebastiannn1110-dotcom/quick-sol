import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { AppError, FileValidationError, ValidationError } from "@/lib/errors/AppError";
import { handleRouteError } from "@/lib/errors/errorHandler";
import { sanitizeFileName, uploadFormSchema, validateUploadMetadata } from "@/lib/excel/validators";
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
  const storageUrl = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_URL;
  if (storageUrl) return `${new URL(storageUrl).origin}/storage/v1/upload/resumable`;
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

    await checkUploadSchema(service, logContext);
    await checkStorageBucket(service, diagnostics.storageBucket, logContext);

    const uploadBatchId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const uploadStrategy = parsed.data.fileSize >= diagnostics.resumableThresholdMb * 1024 * 1024 ? "resumable" : "standard";
    const { data: issuedData, error: issuedError } = await service.rpc("create_import_upload_v2", {
      input_actor_id: context.profile.id,
      input_upload_id: uploadBatchId,
      input_job_id: jobId,
      input_original_file_name: originalFileName,
      input_mime_type: parsed.data.fileType || originalFileName.split(".").pop() || "application/octet-stream",
      input_size_bytes: parsed.data.fileSize,
      input_selected_category: parsed.data.selectedCategory,
      input_department: parsed.data.department,
      input_region: parsed.data.region,
      input_notes: parsed.data.notes || "",
      input_upload_strategy: uploadStrategy,
      input_idempotency_key: parsed.data.idempotencyKey || null,
      input_max_attempts: diagnostics.workerMaxAttempts
    });
    if (issuedError || !issuedData) {
      throw uploadDatabaseError("Unable to issue trusted import job.", issuedError, { ...baseMetadata, rpc: "create_import_upload_v2" });
    }
    const issued = issuedData as {
      duplicate: boolean;
      uploadId: string;
      jobId: string;
      status: string;
      storageBucket: string;
      storagePath: string;
    };
    if (issued.duplicate) {
      return NextResponse.json({
        error: "This file already has an import job. Use retry from the upload history instead of uploading it again.",
        uploadId: issued.uploadId,
        jobId: issued.jobId,
        status: issued.status
      }, { status: 409 });
    }
    const bucket = issued.storageBucket;
    const storagePath = issued.storagePath;
    const uploadMetadata = {
      ...baseMetadata,
      uploadRef: uploadBatchId.slice(0, 8),
      jobRef: jobId.slice(0, 8),
      maxUploadSizeMb: diagnostics.maxUploadSizeMb,
      maxRowsPerFile: diagnostics.maxRowsPerFile,
      resumableThresholdMb: diagnostics.resumableThresholdMb
    };

    await logUploadDiagnostic(logContext, "signed_upload_url_create_started", "Signed upload URL create started.", "started", uploadMetadata);
    const { data: signedUpload, error: signedError } = await service.storage.from(bucket).createSignedUploadUrl(storagePath);
    if (signedError || !signedUpload) {
      await service.rpc("fail_import_upload_initialization_v2", {
        input_actor_id: context.profile.id,
        input_upload_id: uploadBatchId,
        input_job_id: jobId,
        input_error_code: "IMPORT_SIGNED_UPLOAD_URL_FAILED"
      });
      throw uploadStorageError("Unable to create signed upload URL.", signedError, uploadMetadata);
    }
    await logUploadDiagnostic(logContext, "signed_upload_url_create_completed", "Signed upload URL create completed.", "completed", uploadMetadata);

    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_started",
      message: "Direct-to-storage upload initialized.",
      status: "completed",
      uploadBatchId: uploadBatchId.slice(0, 8),
      metadata: { jobRef: jobId.slice(0, 8), sizeBytes: parsed.data.fileSize, maxUploadSizeMb: diagnostics.maxUploadSizeMb, maxRowsPerFile: diagnostics.maxRowsPerFile, uploadStrategy }
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
