import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { importLifecycleError } from "@/lib/upload/lifecycle-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required." }, { status: 503 });

  const { id } = await params;
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "Trusted backend configuration is required." }, { status: 503 });
  const { data: job, error } = await service.rpc("request_import_job_cancel_v2", {
    input_actor_id: context.profile.id,
    input_job_id: id
  });

  if (error) {
    const mapped = importLifecycleError(error, "Unable to cancel import job.");
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (!job) return NextResponse.json({ error: "Only pending, queued, retrying or processing jobs can be cancelled." }, { status: 409 });

  const typedJob = job as { uploadId: string; status: string };
  await logAuditEvent(context, "admin_import_job_cancelled", "upload_batch", typedJob.uploadId, { jobId: id });
  return NextResponse.json({ ok: true, jobId: id, uploadId: typedJob.uploadId, status: typedJob.status });
}
