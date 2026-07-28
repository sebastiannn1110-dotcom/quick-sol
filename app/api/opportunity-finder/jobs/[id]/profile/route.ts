import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { cleanUuid, loadOwnedOpportunityJob } from "@/lib/opportunity-finder/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!["uploading", "failed"].includes(jobStatus)) {
    return NextResponse.json({ jobId, status: jobStatus });
  }
  const uploadedAt = new Date().toISOString();
  const { data: files, error: fileError } = await context.supabase
    .from("opportunity_finder_files")
    .update({ parse_status: "uploaded", uploaded_at: uploadedAt })
    .eq("job_id", jobId)
    .select("id");
  if (fileError || files?.length !== 2) {
    return NextResponse.json({ errorCode: "EXACTLY_TWO_FILES_REQUIRED" }, { status: 400 });
  }
  const { error } = await context.supabase
    .from("opportunity_finder_jobs")
    .update({
      status: "queued",
      current_stage: "inspecting_sheets",
      progress_percent: 2,
      error_code: null,
      cancel_requested: false,
      next_retry_at: null
    })
    .eq("id", jobId)
    .eq("created_by", context.profile.id);
  if (error) return NextResponse.json({ errorCode: "JOB_QUEUE_FAILED" }, { status: 500 });
  return NextResponse.json({ jobId, status: "queued", currentStage: "inspecting_sheets" });
}
