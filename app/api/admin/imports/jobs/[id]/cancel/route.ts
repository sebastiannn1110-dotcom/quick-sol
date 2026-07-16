import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required." }, { status: 503 });

  const { id } = await params;
  const cancelledAt = new Date().toISOString();
  const { data: job, error } = await context.supabase
    .from("import_jobs")
    .update({
      status: "cancelled",
      cancel_requested: true,
      error_message: "Cancelled by admin.",
      cancelled_at: cancelledAt,
      finished_at: cancelledAt,
      updated_at: cancelledAt
    })
    .eq("id", id)
    .in("status", ["pending_upload", "uploaded", "queued", "retrying", "processing"])
    .select("id, upload_batch_id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Unable to cancel import job." }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Only pending, queued, retrying or processing jobs can be cancelled." }, { status: 409 });

  await context.supabase.from("upload_batches").update({
    status: "cancelled",
    error_message: "Cancelled by admin.",
    cancelled_at: cancelledAt,
    completed_at: cancelledAt
  }).eq("id", job.upload_batch_id);

  await logAuditEvent(context, "admin_import_job_cancelled", "upload_batch", job.upload_batch_id, { jobId: id });
  return NextResponse.json({ ok: true, jobId: id, uploadId: job.upload_batch_id, status: "cancelled" });
}
