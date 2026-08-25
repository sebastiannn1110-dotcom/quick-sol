import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { SupabaseError, ValidationError } from "@/lib/errors/AppError";
import { handleRouteError } from "@/lib/errors/errorHandler";
import { logger } from "@/lib/logger/logger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { importLifecycleError } from "@/lib/upload/lifecycle-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const finalizeSchema = z.object({
  uploadId: z.string().uuid(),
  jobId: z.string().uuid(),
  uploadProgressPercent: z.number().min(0).max(100).default(100),
  uploadSpeedBps: z.number().int().nonnegative().optional().nullable(),
  uploadEtaSeconds: z.number().int().nonnegative().optional().nullable()
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
    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_finalize_received",
      message: "Upload finalize request received.",
      status: "started"
    });
    const parsed = finalizeSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Upload finalize validation failed.", { issues: parsed.error.issues });
    if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Background uploads require Supabase." }, { status: 503 });

    const service = createSupabaseServiceRoleClient();
    if (!service) return NextResponse.json({ error: "Background uploads require trusted server configuration." }, { status: 503 });
    const { data: job, error: jobError } = await service.rpc("finalize_import_upload_v2", {
      input_actor_id: context.profile.id,
      input_upload_id: parsed.data.uploadId,
      input_job_id: parsed.data.jobId
    });
    if (jobError) {
      const mapped = importLifecycleError(jobError, "Unable to queue import job.");
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    if (!job) throw new SupabaseError("Unable to queue import job.", { table: "import_jobs" });

    await logger.info({
      ...logContext,
      module: "upload",
      action: "upload_completed",
      message: "Direct storage upload finalized by client.",
      status: "completed",
      uploadBatchId: parsed.data.uploadId.slice(0, 8),
      metadata: { jobRef: parsed.data.jobId.slice(0, 8), uploadProgressPercent: 100 }
    });
    await logger.info({
      ...logContext,
      module: "upload",
      action: "job_queued",
      message: "Import job queued after direct storage upload.",
      status: "completed",
      uploadBatchId: parsed.data.uploadId.slice(0, 8),
      metadata: { jobRef: parsed.data.jobId.slice(0, 8) }
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
