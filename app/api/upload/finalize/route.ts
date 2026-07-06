import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { SupabaseError, ValidationError } from "@/lib/errors/AppError";
import { handleRouteError } from "@/lib/errors/errorHandler";
import { logger } from "@/lib/logger/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const finalizeSchema = z.object({
  uploadId: z.string().uuid(),
  jobId: z.string().uuid(),
  uploadProgressPercent: z.number().min(0).max(100).default(100)
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

  try {
    const body = await request.json().catch(() => null);
    const parsed = finalizeSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Upload finalize validation failed.", { issues: parsed.error.issues });
    if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Background uploads require Supabase." }, { status: 503 });

    const queuedAt = new Date().toISOString();
    const { error: batchError } = await context.supabase
      .from("upload_batches")
      .update({
        status: "queued",
        upload_progress_percent: parsed.data.uploadProgressPercent,
        processing_progress_percent: 0,
        queued_at: queuedAt,
        error_message: null
      })
      .eq("id", parsed.data.uploadId)
      .eq("uploaded_by", context.profile.id);
    if (batchError) throw new SupabaseError("Unable to finalize upload batch.", { table: "upload_batches", batchError });

    const { data: job, error: jobError } = await context.supabase
      .from("import_jobs")
      .update({ status: "queued", progress_percent: 0, error_message: null, updated_at: queuedAt })
      .eq("id", parsed.data.jobId)
      .eq("upload_batch_id", parsed.data.uploadId)
      .eq("uploaded_by", context.profile.id)
      .select("*")
      .single();
    if (jobError || !job) throw new SupabaseError("Unable to queue import job.", { table: "import_jobs", jobError });

    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_completed",
      message: "Direct storage upload finalized by client.",
      status: "completed",
      uploadBatchId: parsed.data.uploadId,
      metadata: { jobId: parsed.data.jobId, uploadProgressPercent: parsed.data.uploadProgressPercent }
    });
    await logger.info({
      ...logContext,
      module: "upload",
      action: "job_queued",
      message: "Import job queued after direct storage upload.",
      status: "completed",
      uploadBatchId: parsed.data.uploadId,
      metadata: { jobId: parsed.data.jobId }
    });
    await logAuditEvent(context, "import_job_queued", "upload_batch", parsed.data.uploadId, { jobId: parsed.data.jobId });

    return NextResponse.json({ uploadId: parsed.data.uploadId, jobId: parsed.data.jobId, status: "queued", job });
  } catch (error) {
    return handleRouteError(error, logContext, {
      module: "upload",
      action: "upload_finalize_failed",
      fallbackMessage: "Unable to queue file processing."
    });
  }
}
