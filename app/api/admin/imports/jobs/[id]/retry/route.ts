import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { getImportJobDiagnostics } from "@/lib/upload/job-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required." }, { status: 503 });

  const { id } = await params;
  const diagnostics = await getImportJobDiagnostics(context.supabase, id);
  if (!diagnostics) return NextResponse.json({ error: "Import job not found." }, { status: 404 });
  if (diagnostics.safeFinalize.possible) {
    return NextResponse.json({
      error: "This job appears fully imported. Use safe finalize instead of retrying.",
      diagnostics
    }, { status: 409 });
  }

  const queuedAt = new Date().toISOString();
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
      updated_at: queuedAt
    })
    .eq("id", id)
    .in("status", ["failed", "cancelled", "retrying"])
    .select("id, upload_batch_id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to retry import job." }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Only failed, cancelled or retrying jobs can be retried." }, { status: 409 });

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
    queued_at: queuedAt,
    processing_started_at: null,
    cancelled_at: null,
    worker_last_heartbeat_at: null,
    completed_at: null
  }).eq("id", job.upload_batch_id);

  await logAuditEvent(context, "admin_import_job_retry", "upload_batch", job.upload_batch_id, { jobId: id });
  return NextResponse.json({ ok: true, jobId: id, uploadId: job.upload_batch_id, status: "queued" });
}
