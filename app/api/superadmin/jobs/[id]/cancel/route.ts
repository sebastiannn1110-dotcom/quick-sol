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
  const cancelledAt = new Date().toISOString();
  const { data: job, error } = await context.service
    .from("import_jobs")
    .update({
      status: "cancelled",
      cancel_requested: true,
      error_message: "Cancelled by superadmin.",
      locked_at: null,
      locked_by: null,
      worker_id: null,
      cancelled_at: cancelledAt,
      updated_at: cancelledAt
    })
    .eq("id", id)
    .select("id,upload_batch_id")
    .maybeSingle();
  if (error || !job) return NextResponse.json({ error: "Unable to cancel job." }, { status: 500 });

  await context.service.from("upload_batches").update({
    status: "cancelled",
    error_message: "Cancelled by superadmin.",
    cancelled_at: cancelledAt
  }).eq("id", job.upload_batch_id);

  await logger.audit({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: new URL(request.url).pathname,
    method: request.method,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown",
    module: "admin",
    action: "superadmin_job_cancel",
    message: "Superadmin cancelled an import job.",
    status: "completed",
    metadata: { jobId: id, uploadBatchId: job.upload_batch_id }
  });
  return NextResponse.json({ ok: true, jobId: id, uploadId: job.upload_batch_id });
}
