import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { normalizePartNumberForMatch } from "@/lib/stock-needs/stock-needs";
import {
  cleanUuid,
  loadOwnedOpportunityJob,
  OPPORTUNITY_FILE_SELECT,
  OPPORTUNITY_RESULT_SELECT,
  resultDatabaseRow,
  resultFilters
} from "@/lib/opportunity-finder/api";
import { opportunityFinderPipelineVersionFromKey } from "@/lib/opportunity-finder/pipeline";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jobPayload(job: Record<string, unknown>) {
  return {
    id: job.id,
    status: job.status,
    currentStage: job.current_stage,
    progressPercent: Number(job.progress_percent ?? 0),
    fileARole: job.file_a_role,
    fileBRole: job.file_b_role,
    totalRowsA: Number(job.total_rows_a ?? 0),
    totalRowsB: Number(job.total_rows_b ?? 0),
    processedRows: Number(job.processed_rows ?? 0),
    matchedMpns: Number(job.matched_mpns ?? 0),
    resultCount: Number(job.result_count ?? 0),
    warningCount: Number(job.warning_count ?? 0),
    missingMpnRows: Number(job.missing_mpn_rows ?? 0),
    invalidQuantityRows: Number(job.invalid_quantity_rows ?? 0),
    summary: job.summary_json ?? {},
    errorCode: job.error_code,
    cancelRequested: Boolean(job.cancel_requested),
    pipelineVersion: opportunityFinderPipelineVersionFromKey(job.idempotency_key),
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    expiresAt: job.expires_at,
    cancelledAt: job.cancelled_at
  };
}

function filePayload(file: Record<string, unknown>) {
  return {
    id: file.id,
    side: file.side,
    originalFileName: file.original_file_name,
    mimeType: file.mime_type,
    sizeBytes: Number(file.size_bytes ?? 0),
    detectedType: file.detected_type,
    selectedRole: file.selected_role,
    classificationScore: Number(file.classification_score ?? 0),
    classificationReasons: file.classification_reasons ?? [],
    sheets: file.sheet_profiles ?? [],
    sheetCount: Number(file.sheet_count ?? 0),
    rowCount: Number(file.row_count ?? 0),
    parseStatus: file.parse_status,
    uploadedAt: file.uploaded_at,
    profiledAt: file.profiled_at,
    parsedAt: file.parsed_at,
    fileExpiresAt: file.file_expires_at,
    storageDeletedAt: file.storage_deleted_at
  };
}

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
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const pipelineVersion = opportunityFinderPipelineVersionFromKey(job.idempotency_key);
  const { data: files, error: filesError } = await context.supabase
    .from("opportunity_finder_files")
    .select(OPPORTUNITY_FILE_SELECT)
    .eq("job_id", jobId)
    .order("side", { ascending: true });
  if (filesError) return NextResponse.json({ errorCode: "JOB_READ_FAILED" }, { status: 500 });

  const filters = resultFilters(request);
  let resultsQuery = context.supabase
    .from("opportunity_finder_results")
    .select(OPPORTUNITY_RESULT_SELECT, { count: "exact" })
    .eq("job_id", jobId);
  const normalizedQuery = normalizePartNumberForMatch(filters.q);
  if (normalizedQuery) resultsQuery = resultsQuery.ilike("normalized_mpn", `%${normalizedQuery}%`);
  if (filters.manufacturer) resultsQuery = resultsQuery.ilike("manufacturer", `%${filters.manufacturer}%`);
  if (filters.context) {
    resultsQuery = resultsQuery.or(
      `customer_context.ilike.%${filters.context}%,supplier_context.ilike.%${filters.context}%`
    );
  }
  if (filters.opportunityType) resultsQuery = resultsQuery.eq("opportunity_type", filters.opportunityType);
  if (filters.fileId) {
    resultsQuery = resultsQuery.or(`demand_file_id.eq.${filters.fileId},supply_file_id.eq.${filters.fileId}`);
  }
  if (filters.withShortage) resultsQuery = resultsQuery.gt("shortage_qty", 0);
  if (filters.withAvailable) resultsQuery = resultsQuery.eq("usable_availability_match", true);
  if (filters.exactOnly) resultsQuery = resultsQuery.eq("exact_match", true);
  const { data: results, error: resultsError, count } = await resultsQuery
    .order("created_at", { ascending: true })
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (resultsError) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });

  const { data: possibleMatches, error: possibleError } = await context.supabase
    .from("opportunity_finder_possible_matches")
    .select("id,demand_display_mpn,supply_display_mpn,demand_normalized_mpn,supply_normalized_mpn,reason_code")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (possibleError) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });

  return NextResponse.json({
    job: jobPayload(job),
    files: ((files ?? []) as unknown as Record<string, unknown>[]).map(filePayload),
    results: ((results ?? []) as unknown as Record<string, unknown>[]).map(
      (result) => resultDatabaseRow(result, pipelineVersion)
    ),
    possibleMatches: (possibleMatches ?? []).map((match) => ({
      id: match.id,
      demandDisplayMpn: match.demand_display_mpn,
      supplyDisplayMpn: match.supply_display_mpn,
      demandNormalizedMpn: match.demand_normalized_mpn,
      supplyNormalizedMpn: match.supply_normalized_mpn,
      reasonCode: match.reason_code
    })),
    page: {
      offset: filters.offset,
      limit: filters.limit,
      total: count ?? 0
    }
  });
}

export async function DELETE(
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
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  if (["profiling", "parsing", "matching"].includes(String(job.status ?? ""))) {
    return NextResponse.json({ errorCode: "CANCEL_JOB_BEFORE_DELETE" }, { status: 409 });
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  const { data: files } = await service
    .from("opportunity_finder_files")
    .select("storage_bucket,storage_path")
    .eq("job_id", jobId);
  for (const file of files ?? []) {
    await service.storage.from(file.storage_bucket).remove([file.storage_path]);
  }
  const { error } = await context.supabase
    .from("opportunity_finder_jobs")
    .delete()
    .eq("id", jobId)
    .eq("created_by", context.profile.id);
  if (error) return NextResponse.json({ errorCode: "JOB_DELETE_FAILED" }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
