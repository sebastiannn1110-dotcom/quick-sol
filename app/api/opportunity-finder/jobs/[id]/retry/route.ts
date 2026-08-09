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
  if (!["failed", "cancelled"].includes(String(job.status ?? ""))) {
    return NextResponse.json({ errorCode: "JOB_NOT_RETRYABLE" }, { status: 409 });
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  const { data: retriedJob, error } = await service.rpc("retry_opportunity_finder_job", {
    job_id: jobId,
    actor_id: context.profile.id
  });
  if (error) {
    if (error.code === "P0002") {
      return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
    }
    if (error.code === "55000") {
      const sourceExpired = /source_file_expired/i.test(error.message ?? "");
      return NextResponse.json({
        errorCode: sourceExpired ? "SOURCE_FILE_EXPIRED" : "JOB_NOT_RETRYABLE"
      }, { status: sourceExpired ? 410 : 409 });
    }
    return NextResponse.json({ errorCode: "JOB_RETRY_FAILED" }, { status: 500 });
  }
  const committedJob = (Array.isArray(retriedJob) ? retriedJob[0] : retriedJob) as
    | Record<string, unknown>
    | null;
  const readyForMatching = String(committedJob?.current_stage ?? "") === "normalizing_mpn";
  await logAuditEvent(context, "opportunity_finder_job_retried", "opportunity_finder_job", jobId, {
    readyForMatching
  });
  return NextResponse.json({ jobId, status: "queued" });
}
