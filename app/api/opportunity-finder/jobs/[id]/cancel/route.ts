import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { cleanUuid, loadOwnedOpportunityJob } from "@/lib/opportunity-finder/api";

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
  const workerActive = ["profiling", "parsing", "matching"].includes(jobStatus);
  const { error } = await context.supabase
    .from("opportunity_finder_jobs")
    .update({
      cancel_requested: true,
      ...(workerActive ? {} : {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        error_code: "JOB_CANCELLED"
      })
    })
    .eq("id", jobId)
    .eq("created_by", context.profile.id);
  if (error) return NextResponse.json({ errorCode: "JOB_CANCEL_FAILED" }, { status: 500 });
  return NextResponse.json({ jobId, status: workerActive ? jobStatus : "cancelled", cancelRequested: true });
}
