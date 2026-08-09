import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
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
import { getRolePermissions } from "@/lib/security/permissions";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { assertCanonicalOpportunityStorageReference } from "@/lib/opportunity-finder/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jobPayload(job: Record<string, unknown>) {
  return {
    id: job.id,
    clientContext: job.client_context,
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
    pipelineVersion: typeof job.pipeline_version === "string"
      ? job.pipeline_version
      : opportunityFinderPipelineVersionFromKey(job.idempotency_key),
    contentVerified: Boolean(job.content_pair_sha256),
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
    actualSizeBytes: file.actual_size_bytes == null ? null : Number(file.actual_size_bytes),
    contentVerified: Boolean(file.content_sha256),
    validationStatus: file.validation_status,
    detectedType: file.detected_type,
    selectedRole: file.selected_role,
    validityOverrideExpiresAt: file.validity_override_expires_at ?? null,
    classificationScore: Number(file.classification_score ?? 0),
    classificationReasons: file.classification_reasons ?? [],
    sheets: file.sheet_profiles ?? [],
    sheetCount: Number(file.sheet_count ?? 0),
    rowCount: Number(file.row_count ?? 0),
    usefulRowCount: Number(file.useful_row_count ?? file.row_count ?? 0),
    hiddenRowCount: Number(file.hidden_row_count ?? 0),
    templateType: file.template_type,
    mappingVersion: file.mapping_version,
    columnMappings: file.column_mappings ?? [],
    warnings: file.profile_warnings ?? [],
    errors: file.profile_errors ?? [],
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
  const pipelineVersion = typeof job.pipeline_version === "string"
    ? job.pipeline_version
    : opportunityFinderPipelineVersionFromKey(job.idempotency_key);
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
    .order("id", { ascending: true })
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (resultsError) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });

  const permissions = getRolePermissions(context.profile.role);
  let tenantAdmin = false;
  if (
    job.tenant_id &&
    (permissions.canViewSensitivePricing || permissions.canViewCosts || permissions.canViewGp)
  ) {
    const { data: adminCheck, error: adminCheckError } = await context.supabase.rpc(
      "is_opportunity_finder_tenant_admin",
      { target_tenant_id: job.tenant_id }
    );
    tenantAdmin = !adminCheckError && adminCheck === true;
  }
  const canViewPricing = tenantAdmin && permissions.canViewSensitivePricing;
  const canViewFinancials = tenantAdmin && permissions.canViewCosts && permissions.canViewGp;
  const resultRows = (results ?? []) as unknown as Record<string, unknown>[];
  const resultIds = resultRows.map((result) => String(result.id));
  const commercialByResult = new Map<string, Record<string, unknown>>();
  const financialByResult = new Map<string, Record<string, unknown>>();
  if (resultIds.length && (canViewPricing || canViewFinancials)) {
    const service = createSupabaseServiceRoleClient();
    if (!service) return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
    if (canViewPricing) {
      const { data: commercial, error: commercialError } = await service
        .from("opportunity_finder_result_commercials")
        .select("result_id,target_price,offer_price,target_gap_percent,currency,revenue_potential,pricing_quality")
        .eq("job_id", jobId)
        .in("result_id", resultIds);
      if (commercialError) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });
      for (const item of commercial ?? []) {
        if (item.pricing_quality !== "invalid") commercialByResult.set(item.result_id, item);
      }
    }
    if (canViewFinancials) {
      const { data: financial, error: financialError } = await service
        .from("opportunity_finder_result_financials")
        .select("result_id,unit_cost,gross_profit,gross_margin_percent,cost_quality")
        .eq("job_id", jobId)
        .in("result_id", resultIds);
      if (financialError) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });
      for (const item of financial ?? []) {
        if (item.cost_quality === "valid" && item.unit_cost !== null) {
          financialByResult.set(item.result_id, item);
        }
      }
    }
  }

  const search = new URL(request.url).searchParams;
  const possibleOffset = Math.max(Number(search.get("possibleOffset") ?? 0) || 0, 0);
  const possibleLimit = Math.min(Math.max(Number(search.get("possibleLimit") ?? 100) || 100, 1), 250);
  const rejectedOffset = Math.max(Number(search.get("rejectedOffset") ?? 0) || 0, 0);
  const rejectedLimit = Math.min(Math.max(Number(search.get("rejectedLimit") ?? 100) || 100, 1), 250);
  const { data: possibleMatches, error: possibleError, count: possibleCount } = await context.supabase
    .from("opportunity_finder_possible_matches")
    .select("id,demand_display_mpn,supply_display_mpn,demand_normalized_mpn,supply_normalized_mpn,reason_code,match_tier,confidence,explanation,review_status,manufacturer_compatible,demand_trace,supply_trace", { count: "exact" })
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(possibleOffset, possibleOffset + possibleLimit - 1);
  if (possibleError) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });

  const { data: rejectedRows, error: rejectedError, count: rejectedCount } = await context.supabase
    .from("opportunity_finder_rejected_rows")
    .select("id,file_id,side,file_name,sheet_name,source_row,source_row_hidden,reason_code,field_name,source_column,safe_raw_value", { count: "exact" })
    .eq("job_id", jobId)
    .order("source_row", { ascending: true })
    .order("id", { ascending: true })
    .range(rejectedOffset, rejectedOffset + rejectedLimit - 1);
  if (rejectedError) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });

  return NextResponse.json({
    job: jobPayload(job),
    files: ((files ?? []) as unknown as Record<string, unknown>[]).map(filePayload),
    results: resultRows.map(
      (result) => resultDatabaseRow(result, pipelineVersion, {
        commercial: commercialByResult.get(String(result.id)) ?? null,
        financial: financialByResult.get(String(result.id)) ?? null
      })
    ),
    possibleMatches: (possibleMatches ?? []).map((match) => ({
      id: match.id,
      demandDisplayMpn: match.demand_display_mpn,
      supplyDisplayMpn: match.supply_display_mpn,
      demandNormalizedMpn: match.demand_normalized_mpn,
      supplyNormalizedMpn: match.supply_normalized_mpn,
      reasonCode: match.reason_code,
      matchTier: match.match_tier,
      confidence: match.confidence,
      explanation: match.explanation,
      reviewStatus: match.review_status,
      manufacturerCompatible: match.manufacturer_compatible,
      demandTrace: match.demand_trace,
      supplyTrace: match.supply_trace
    })),
    rejectedRows: (rejectedRows ?? []).map((row) => ({
      id: row.id,
      fileId: row.file_id,
      side: row.side,
      fileName: row.file_name,
      sheetName: row.sheet_name,
      sourceRow: row.source_row,
      hidden: row.source_row_hidden,
      reasonCode: row.reason_code,
      fieldName: row.field_name,
      sourceColumn: row.source_column,
      safeRawValue: row.safe_raw_value
    })),
    capabilities: {
      canViewPricing,
      canViewFinancials
    },
    page: {
      offset: filters.offset,
      limit: filters.limit,
      total: count ?? 0
    },
    possiblePage: {
      offset: possibleOffset,
      limit: possibleLimit,
      total: possibleCount ?? 0
    },
    rejectedPage: {
      offset: rejectedOffset,
      limit: rejectedLimit,
      total: rejectedCount ?? 0
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
  const { error: prepareError } = await service.rpc("prepare_opportunity_finder_job_deletion", {
    job_id: jobId,
    actor_id: context.profile.id
  });
  if (prepareError) {
    if (prepareError.code === "P0002") {
      return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
    }
    if (prepareError.code === "55000" || prepareError.code === "40001") {
      return NextResponse.json({ errorCode: "CANCEL_JOB_BEFORE_DELETE" }, { status: 409 });
    }
    return NextResponse.json({ errorCode: "JOB_DELETE_FAILED" }, { status: 500 });
  }
  const { data: files, error: filesError } = await service
    .from("opportunity_finder_files")
    .select("id,job_id,original_file_name,storage_bucket,storage_path")
    .eq("job_id", jobId);
  if (filesError) {
    return NextResponse.json({ errorCode: "SOURCE_FILES_LOAD_FAILED" }, { status: 500 });
  }
  for (const file of files ?? []) {
    try {
      assertCanonicalOpportunityStorageReference({
        ownerId: context.profile.id,
        jobId,
        fileId: file.id,
        originalFileName: file.original_file_name,
        storageBucket: file.storage_bucket,
        storagePath: file.storage_path
      });
    } catch {
      return NextResponse.json({ errorCode: "FILE_STORAGE_REFERENCE_INVALID" }, { status: 500 });
    }
  }
  for (const file of files ?? []) {
    const { error: storageError } = await service.storage
      .from(file.storage_bucket)
      .remove([file.storage_path]);
    if (storageError) {
      return NextResponse.json({ errorCode: "STORAGE_DELETE_FAILED" }, { status: 502 });
    }
  }
  const { error } = await service.rpc("finalize_opportunity_finder_job_deletion", {
    job_id: jobId,
    actor_id: context.profile.id
  });
  if (error) {
    if (error.code === "P0002") {
      return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
    }
    if (error.code === "55000" || error.code === "40001") {
      return NextResponse.json({ errorCode: "JOB_DELETE_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ errorCode: "JOB_DELETE_FAILED" }, { status: 500 });
  }
  await logAuditEvent(context, "opportunity_finder_job_deleted", "opportunity_finder_job", jobId);
  return NextResponse.json({ deleted: true });
}
