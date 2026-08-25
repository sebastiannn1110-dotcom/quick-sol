import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { cleanUuid, loadOwnedOpportunityJob } from "@/lib/opportunity-finder/api";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  }
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const jobStatus = String(job.status ?? "");
  if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(jobStatus)) {
    return NextResponse.json({ jobId, status: jobStatus });
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  const { data: cancelledJob, error } = await service.rpc("cancel_opportunity_finder_job", {
    job_id: jobId,
    actor_id: context.profile.id
  });
  if (error) {
    if (error.code === "P0002") {
      return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ errorCode: "JOB_CANCEL_FAILED" }, { status: 500 });
  }
  const committedJob = (Array.isArray(cancelledJob) ? cancelledJob[0] : cancelledJob) as
    | Record<string, unknown>
    | null;
  const committedStatus = String(committedJob?.status ?? jobStatus);
  const workerActive = ["profiling", "parsing", "matching"].includes(committedStatus);
  await logAuditEvent(context, "opportunity_finder_job_cancelled", "opportunity_finder_job", jobId, {
    workerActive
  });
  return NextResponse.json({
    jobId,
    status: committedStatus,
    cancelRequested: Boolean(committedJob?.cancel_requested ?? true)
  });
}
