import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadmin/auth";
import { logger } from "@/lib/logger/logger";
import { requestIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const queuedAt = new Date().toISOString();
  const { data: job, error } = await context.service
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
    .select("id,upload_batch_id")
    .maybeSingle();
  if (error || !job) return NextResponse.json({ error: "Unable to retry job." }, { status: 500 });

  await context.service.from("upload_batches").update({
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

  await logger.audit({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: new URL(request.url).pathname,
    method: request.method,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown",
    module: "admin",
    action: "superadmin_job_retry",
    message: "Superadmin retried an import job.",
    status: "completed",
    metadata: { jobId: id, uploadBatchId: job.upload_batch_id }
  });
  return NextResponse.json({ ok: true, jobId: id, uploadId: job.upload_batch_id });
}
