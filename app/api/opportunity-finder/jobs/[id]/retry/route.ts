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
  if (!["failed", "cancelled"].includes(String(job.status ?? ""))) {
    return NextResponse.json({ errorCode: "JOB_NOT_RETRYABLE" }, { status: 409 });
  }
  const { data: files } = await context.supabase
    .from("opportunity_finder_files")
    .select("profiled_at,selected_role,storage_deleted_at")
    .eq("job_id", jobId);
  if (files?.some((file) => file.storage_deleted_at)) {
    return NextResponse.json({ errorCode: "SOURCE_FILE_EXPIRED" }, { status: 410 });
  }
  const readyForMatching = files?.length === 2 && files.every((file) => file.profiled_at && file.selected_role);
  const { error } = await context.supabase
    .from("opportunity_finder_jobs")
    .update({
      status: "queued",
      current_stage: readyForMatching ? "normalizing_mpn" : "inspecting_sheets",
      progress_percent: readyForMatching ? 26 : 2,
      cancel_requested: false,
      error_code: null,
      attempts: 0,
      next_retry_at: null,
      locked_at: null,
      locked_by: null,
      heartbeat_at: null
    })
    .eq("id", jobId)
    .eq("created_by", context.profile.id);
  if (error) return NextResponse.json({ errorCode: "JOB_RETRY_FAILED" }, { status: 500 });
  return NextResponse.json({ jobId, status: "queued" });
}
