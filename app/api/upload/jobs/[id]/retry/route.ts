import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { getImportJobDiagnostics } from "@/lib/upload/job-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required for import jobs." }, { status: 503 });

  const diagnostics = await getImportJobDiagnostics(context.supabase, id);
  if (diagnostics?.safeFinalize.possible) {
    return NextResponse.json({
      error: "This import appears complete with warnings. Contact an admin to safe-finalize it instead of retrying.",
      diagnostics: diagnostics.safeFinalize
    }, { status: 409 });
  }

  const { data: job, error } = await context.supabase
    .from("import_jobs")
    .update({
      status: "queued",
      progress_percent: 0,
      processed_rows: 0,
      successful_rows: 0,
      failed_rows: 0,
      warning_count: 0,
      rows_with_warnings: 0,
      technical_error_count: 0,
      suppressed_error_count: 0,
      error_message: null,
      last_error: null,
      locked_at: null,
      locked_by: null,
      heartbeat_at: null,
      next_retry_at: null,
      worker_id: null,
      cancel_requested: false,
      started_at: null,
      finished_at: null,
      cancelled_at: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("uploaded_by", context.profile.id)
    .in("status", ["failed", "cancelled"])
    .select("id, upload_batch_id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to retry import job." }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Only failed or cancelled jobs can be retried." }, { status: 409 });

  await context.supabase.from("upload_batches").update({
    status: "queued",
    processed_rows: 0,
    successful_rows: 0,
    failed_rows: 0,
    warning_count: 0,
    rows_with_warnings: 0,
    technical_error_count: 0,
    suppressed_error_count: 0,
    error_count: 0,
    processing_progress_percent: 0,
    error_message: null,
    queued_at: new Date().toISOString(),
    processing_started_at: null,
    cancelled_at: null,
    worker_last_heartbeat_at: null,
    completed_at: null
  }).eq("id", job.upload_batch_id);
  await logAuditEvent(context, "import_job_retry", "upload_batch", job.upload_batch_id, { jobId: id });
  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "upload",
    action: "job_queued",
    message: "Import job re-queued by user.",
    status: "completed",
    uploadBatchId: job.upload_batch_id,
    metadata: { jobId: id }
  });
  return NextResponse.json({ ok: true, jobId: id, uploadId: job.upload_batch_id, status: "queued" });
}
