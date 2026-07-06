import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { FileValidationError, SupabaseError, ValidationError } from "@/lib/errors/AppError";
import { handleRouteError } from "@/lib/errors/errorHandler";
import { safeStoragePath, sanitizeFileName, uploadFormSchema, validateUploadMetadata } from "@/lib/excel/validators";
import { logger } from "@/lib/logger/logger";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

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

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const logContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: request.method
  };

  const rate = await checkPersistentRateLimit({
    action: "upload_initiate",
    identifier: context.profile.id,
    limit: 20,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  try {
    const body = await request.json().catch(() => null);
    const parsed = initiateSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Upload initiate validation failed.", { issues: parsed.error.issues });
    const formParsed = uploadFormSchema.safeParse(parsed.data);
    if (!formParsed.success) throw new ValidationError("Upload form validation failed.", { issues: formParsed.error.issues });

    const fileErrors = validateUploadMetadata({
      fileName: parsed.data.fileName,
      fileSize: parsed.data.fileSize,
      fileType: parsed.data.fileType
    });
    if (fileErrors.length) throw new FileValidationError(fileErrors.join(" "), { fileName: parsed.data.fileName, fileSize: parsed.data.fileSize });

    if (context.isDemoMode || !context.supabase) {
      return NextResponse.json({ error: "Background uploads require Supabase Storage." }, { status: 503 });
    }

    const service = createSupabaseServiceRoleClient();
    if (!service) return NextResponse.json({ error: "Storage service role is not configured." }, { status: 503 });

    if (parsed.data.idempotencyKey) {
      const { data: existingUpload, error: existingError } = await context.supabase
        .from("upload_batches")
        .select("id, status, original_file_name")
        .eq("uploaded_by", context.profile.id)
        .eq("idempotency_key", parsed.data.idempotencyKey)
        .is("archived_at", null)
        .maybeSingle();
      if (existingError) throw new SupabaseError("Unable to check duplicate upload.", { table: "upload_batches", existingError });
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
    const originalFileName = sanitizeFileName(parsed.data.fileName);
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || "excel-uploads";
    const storagePath = safeStoragePath(context.profile.id, uploadBatchId, originalFileName);

    const { data: signedUpload, error: signedError } = await service.storage.from(bucket).createSignedUploadUrl(storagePath);
    if (signedError || !signedUpload) throw new SupabaseError("Unable to create signed upload URL.", { signedError });

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
      idempotency_key: parsed.data.idempotencyKey || null,
      notes: parsed.data.notes || null
    });
    if (batchError) throw new SupabaseError("Unable to create upload batch.", { table: "upload_batches", batchError });

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
      notes: parsed.data.notes || null
    });
    if (jobError) throw new SupabaseError("Unable to create import job.", { table: "import_jobs", jobError });

    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_started",
      message: "Direct-to-storage upload initialized.",
      status: "completed",
      uploadBatchId,
      fileName: originalFileName,
      metadata: { jobId, bucket, storagePath, sizeBytes: parsed.data.fileSize }
    });
    await logAuditEvent(context, "upload_initialized", "upload_batch", uploadBatchId, { jobId, fileName: originalFileName });

    return NextResponse.json({
      uploadId: uploadBatchId,
      jobId,
      bucket,
      storagePath,
      signedUrl: signedUpload.signedUrl,
      token: signedUpload.token,
      path: signedUpload.path,
      upload: {
        id: uploadBatchId,
        original_file_name: originalFileName,
        status: "pending_upload"
      }
    });
  } catch (error) {
    return handleRouteError(error, logContext, {
      module: "upload",
      action: "upload_initiate_failed",
      fallbackMessage: "Unable to initialize large file upload."
    });
  }
}
