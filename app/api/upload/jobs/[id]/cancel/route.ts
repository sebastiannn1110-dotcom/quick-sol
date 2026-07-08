import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required for import jobs." }, { status: 503 });

  const cancelledAt = new Date().toISOString();
  const { data: job, error } = await context.supabase
    .from("import_jobs")
    .update({
      status: "cancelled",
      cancel_requested: true,
      error_message: "Cancelled by user.",
      cancelled_at: cancelledAt,
      finished_at: cancelledAt,
      updated_at: cancelledAt
    })
    .eq("id", id)
    .eq("uploaded_by", context.profile.id)
    .in("status", ["pending_upload", "uploaded", "queued", "processing"])
    .select("id, upload_batch_id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Unable to cancel import job." }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Only pending, queued or processing jobs can be cancelled." }, { status: 409 });

  await context.supabase.from("upload_batches").update({
    status: "cancelled",
    error_message: "Cancelled by user.",
    cancelled_at: cancelledAt,
    completed_at: cancelledAt
  }).eq("id", job.upload_batch_id);

  await logAuditEvent(context, "import_job_cancelled", "upload_batch", job.upload_batch_id, { jobId: id });
  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: request.method,
    module: "upload",
    action: "job_cancelled",
    message: "Import job cancelled by user.",
    status: "completed",
    uploadBatchId: job.upload_batch_id,
    metadata: { jobId: id }
  });

  return NextResponse.json({ ok: true, jobId: id, uploadId: job.upload_batch_id, status: "cancelled" });
}
