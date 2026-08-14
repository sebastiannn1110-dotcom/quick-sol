import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { cleanUuid, OPPORTUNITY_JOB_STATUS_SELECT } from "@/lib/opportunity-finder/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  }

  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const dbStartedAt = performance.now();
  const { data, error } = await context.supabase
    .from("opportunity_finder_jobs")
    .select(OPPORTUNITY_JOB_STATUS_SELECT)
    .eq("id", jobId)
    .eq("created_by", context.profile.id)
    .maybeSingle();
  if (error) return NextResponse.json({ errorCode: "JOB_READ_FAILED" }, { status: 500 });
  const job = data as unknown as Record<string, unknown> | null;
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });

  return NextResponse.json({
    id: job.id,
    comparisonMode: job.comparison_mode ?? "two_files",
    uploadedRole: job.uploaded_role ?? null,
    oppositeDatasetRole: job.opposite_dataset_role ?? null,
    snapshotStatus: job.snapshot_status ?? "not_required",
    datasetVersion: job.dataset_version ?? null,
    existingEntityCount: Number(job.existing_entity_count ?? 0),
    status: job.status,
    currentStage: job.current_stage,
    progressPercent: Number(job.progress_percent ?? 0),
    processedRows: Number(job.processed_rows ?? 0),
    totalRowsA: Number(job.total_rows_a ?? 0),
    totalRowsB: Number(job.total_rows_b ?? 0),
    matchedMpns: Number(job.matched_mpns ?? 0),
    resultCount: Number(job.result_count ?? 0),
    warningCount: Number(job.warning_count ?? 0),
    errorCode: job.error_code,
    cancelRequested: Boolean(job.cancel_requested),
    updatedAt: job.updated_at ?? null
  }, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Server-Timing": `db;dur=${(performance.now() - dbStartedAt).toFixed(1)};desc=\"queries:1\"`
    }
  });
}
