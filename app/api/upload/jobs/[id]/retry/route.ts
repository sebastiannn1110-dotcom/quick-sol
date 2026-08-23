import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { getImportJobDiagnostics } from "@/lib/upload/job-diagnostics";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { importLifecycleError } from "@/lib/upload/lifecycle-errors";

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

  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "Trusted backend configuration is required." }, { status: 503 });
  const { data: job, error } = await service.rpc("request_import_job_retry_v2", {
    input_actor_id: context.profile.id,
    input_job_id: id
  });
  if (error) {
    const mapped = importLifecycleError(error, "Unable to retry import job.");
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (!job) return NextResponse.json({ error: "Only failed or cancelled jobs can be retried." }, { status: 409 });
  const typedJob = job as { upload_batch_id: string };
  await logAuditEvent(context, "import_job_retry", "upload_batch", typedJob.upload_batch_id, { jobId: id });
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
    uploadBatchId: typedJob.upload_batch_id.slice(0, 8),
    metadata: { jobRef: id.slice(0, 8) }
  });
  return NextResponse.json({ ok: true, jobId: id, uploadId: typedJob.upload_batch_id, status: "queued" });
}
