import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  OpportunityActionCode,
  OpportunityReasonCode,
  OpportunitySelectedRole,
  OpportunityType,
  OpportunityWarningCode
} from "@/lib/opportunity-finder/types";
import { OPPORTUNITY_FINDER_PIPELINE_VERSION } from "@/lib/opportunity-finder/pipeline";

export const OPPORTUNITY_JOB_SELECT = [
  "id",
  "created_by",
  "idempotency_key",
  "tenant_id",
  "client_context",
  "pipeline_version",
  "content_pair_sha256",
  "comparison_mode",
  "uploaded_role",
  "opposite_dataset_role",
  "dataset_version",
  "dataset_scope",
  "dataset_manifest",
  "dataset_snapshot_id",
  "dataset_snapshot_at",
  "snapshot_status",
  "existing_entity_count",
  "existing_mpn_count",
  "performance_metrics",
  "status",
  "current_stage",
  "progress_percent",
  "file_a_id",
  "file_b_id",
  "file_a_role",
  "file_b_role",
  "total_rows_a",
  "total_rows_b",
  "processed_rows",
  "matched_mpns",
  "result_count",
  "warning_count",
  "missing_mpn_rows",
  "invalid_quantity_rows",
  "summary_json",
  "error_code",
  "cancel_requested",
  "created_at",
  "started_at",
  "completed_at",
  "expires_at",
  "cancelled_at",
  "updated_at"
].join(",");

// Polling must not read large JSON manifests, summaries, or other terminal-only
// fields. Ownership remains part of the same RLS-authorized query.
export const OPPORTUNITY_JOB_STATUS_SELECT = [
  "id",
  "created_by",
  "comparison_mode",
  "uploaded_role",
  "opposite_dataset_role",
  "snapshot_status",
  "dataset_version",
  "existing_entity_count",
  "status",
  "current_stage",
  "progress_percent",
  "processed_rows",
  "total_rows_a",
  "total_rows_b",
  "matched_mpns",
  "result_count",
  "warning_count",
  "error_code",
  "cancel_requested",
  "updated_at"
].join(",");

export const OPPORTUNITY_FILE_SELECT = [
  "id",
  "job_id",
  "side",
  "original_file_name",
  "mime_type",
  "size_bytes",
  "actual_size_bytes",
  "content_sha256",
  "validation_status",
  "detected_type",
  "selected_role",
  "classification_score",
  "classification_reasons",
  "sheet_profiles",
  "sheet_count",
  "row_count",
  "useful_row_count",
  "hidden_row_count",
  "template_type",
  "mapping_version",
  "column_mappings",
  "profile_warnings",
  "profile_errors",
  "validity_override_expires_at",
  "parse_status",
  "uploaded_at",
  "profiled_at",
  "parsed_at",
  "file_expires_at",
  "storage_deleted_at",
  "source_kind"
].join(",");

export const OPPORTUNITY_RESULT_SELECT = [
  "id",
  "candidate_id",
  "job_id",
  "opportunity_type",
  "exact_match",
  "exact_mpn_match",
  "usable_availability_match",
  "exact_quantity_match",
  "match_tier",
  "confidence",
  "match_explanation",
  "review_status",
  "demand_event_key",
  "demand_mpn_original",
  "supply_mpn_original",
  "display_mpn",
  "normalized_mpn",
  "manufacturer",
  "manufacturer_canonical",
  "customer_context",
  "supplier_context",
  "required_qty",
  "available_qty",
  "allocated_qty",
  "remaining_qty",
  "shortage_qty",
  "coverage_percent",
  "required_date",
  "unit_of_measure",
  "moq",
  "spq",
  "date_code",
  "coo",
  "lead_time_weeks",
  "condition",
  "expires_at",
  "demand_file_id",
  "demand_file_name",
  "demand_sheet_name",
  "supply_file_id",
  "supply_file_name",
  "supply_sheet_name",
  "demand_source_rows",
  "supply_source_rows",
  "demand_traces",
  "supply_traces",
  "allocations_trace",
  "reason_code",
  "action_code",
  "warnings",
  "created_at"
].join(",");

export function cleanUuid(value: string | null | undefined) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function cleanSearch(value: string | null, max = 120) {
  const text = value
    ?.replace(/[^\p{L}\p{N}\s._@/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

const OPPORTUNITY_TYPES = new Set<OpportunityType>([
  "full_sale",
  "partial_sale",
  "sourcing_needed",
  "excess_resale",
  "supplier_offer_match",
  "supply_without_demand",
  "historical_signal",
  "review_required"
]);

export function resultFilters(request: Request) {
  const search = new URL(request.url).searchParams;
  const rawType = cleanSearch(search.get("type"), 40);
  return {
    q: cleanSearch(search.get("q")),
    manufacturer: cleanSearch(search.get("manufacturer")),
    context: cleanSearch(search.get("context")),
    opportunityType: rawType && OPPORTUNITY_TYPES.has(rawType as OpportunityType)
      ? rawType as OpportunityType
      : null,
    fileId: cleanUuid(search.get("fileId")),
    withShortage: search.get("withShortage") === "true",
    withAvailable: search.get("withAvailable") === "true",
    exactOnly: search.get("exactOnly") === "true",
    limit: Math.min(Math.max(Number(search.get("limit") ?? 48) || 48, 1), 100),
    offset: Math.max(Number(search.get("offset") ?? 0) || 0, 0)
  };
}

export async function loadOwnedOpportunityJob(
  supabase: SupabaseClient,
  jobId: string,
  userId: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("opportunity_finder_jobs")
    .select(OPPORTUNITY_JOB_SELECT)
    .eq("id", jobId)
    .eq("created_by", userId)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as Record<string, unknown> | null;
}

function nullableFiniteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resultDatabaseRow(
  row: Record<string, unknown>,
  pipelineVersion: string | null = OPPORTUNITY_FINDER_PIPELINE_VERSION,
  protectedFields?: {
    commercial?: Record<string, unknown> | null;
    financial?: Record<string, unknown> | null;
  }
) {
  const exactMpnMatch = row.exact_mpn_match === null || row.exact_mpn_match === undefined
    ? Boolean(row.exact_match)
    : Boolean(row.exact_mpn_match);
  const unitOfMeasure =
    pipelineVersion === OPPORTUNITY_FINDER_PIPELINE_VERSION
      ? row.unit_of_measure as string | null
      : null;
  return {
    id: row.id as string,
    candidateId: typeof row.candidate_id === "string" ? row.candidate_id : null,
    jobId: row.job_id as string,
    opportunityType: row.opportunity_type as OpportunityType,
    exactMpnMatch,
    exactMatch: exactMpnMatch,
    usableAvailabilityMatch: Boolean(row.usable_availability_match),
    exactQuantityMatch: Boolean(row.exact_quantity_match),
    matchTier: row.match_tier ?? null,
    confidence: row.confidence ?? "low",
    matchExplanation: row.match_explanation ?? "",
    reviewStatus: row.review_status ?? "not_required",
    demandEventKey: row.demand_event_key as string | null,
    demandMpnOriginal: row.demand_mpn_original as string | null,
    supplyMpnOriginal: row.supply_mpn_original as string | null,
    displayMpn: row.display_mpn as string,
    normalizedMpn: row.normalized_mpn as string,
    manufacturer: row.manufacturer as string | null,
    manufacturerCanonical: row.manufacturer_canonical as string | null,
    customerContext: row.customer_context as string | null,
    supplierContext: row.supplier_context as string | null,
    requiredQty: nullableFiniteNumber(row.required_qty),
    availableQty: nullableFiniteNumber(row.available_qty),
    allocatedQty: nullableFiniteNumber(row.allocated_qty),
    remainingQty: nullableFiniteNumber(row.remaining_qty),
    shortageQty: nullableFiniteNumber(row.shortage_qty),
    coveragePercent: nullableFiniteNumber(row.coverage_percent),
    requiredDate: row.required_date as string | null,
    unitOfMeasure,
    targetPrice: protectedFields?.commercial?.target_price == null
      ? null
      : Number(protectedFields.commercial.target_price),
    offerPrice: protectedFields?.commercial?.offer_price == null
      ? null
      : Number(protectedFields.commercial.offer_price),
    targetGapPercent: protectedFields?.commercial?.target_gap_percent == null
      ? null
      : Number(protectedFields.commercial.target_gap_percent),
    currency: (protectedFields?.commercial?.currency as string | null | undefined) ?? null,
    revenuePotential: protectedFields?.commercial?.revenue_potential == null
      ? null
      : Number(protectedFields.commercial.revenue_potential),
    unitCost: protectedFields?.financial?.unit_cost == null
      ? null
      : Number(protectedFields.financial.unit_cost),
    grossProfit: protectedFields?.financial?.gross_profit == null
      ? null
      : Number(protectedFields.financial.gross_profit),
    grossMarginPercent: protectedFields?.financial?.gross_margin_percent == null
      ? null
      : Number(protectedFields.financial.gross_margin_percent),
    moq: nullableFiniteNumber(row.moq),
    spq: nullableFiniteNumber(row.spq),
    dateCode: row.date_code as string | null,
    coo: row.coo as string | null,
    leadTimeWeeks: nullableFiniteNumber(row.lead_time_weeks),
    condition: row.condition as string | null,
    expiresAt: row.expires_at as string | null,
    demandFileId: row.demand_file_id as string | null,
    demandFileName: row.demand_file_name as string | null,
    demandSheetName: row.demand_sheet_name as string | null,
    supplyFileId: row.supply_file_id as string | null,
    supplyFileName: row.supply_file_name as string | null,
    supplySheetName: row.supply_sheet_name as string | null,
    demandSourceRows: Number(row.demand_source_rows ?? 0),
    supplySourceRows: Number(row.supply_source_rows ?? 0),
    demandTraces: row.demand_traces ?? [],
    supplyTraces: row.supply_traces ?? [],
    allocations: row.allocations_trace ?? [],
    reasonCode: row.reason_code as OpportunityReasonCode,
    actionCode: row.action_code as OpportunityActionCode,
    warnings: (row.warnings ?? []) as OpportunityWarningCode[]
  };
}

export function roleValue(value: unknown): OpportunitySelectedRole | null {
  const roles = new Set<OpportunitySelectedRole>([
    "demand",
    "stock",
    "excess",
    "supplier_offer",
    "received_history",
    "purchase_history",
    "quote_history",
    "sales_history",
    "ignore"
  ]);
  return typeof value === "string" && roles.has(value as OpportunitySelectedRole)
    ? value as OpportunitySelectedRole
    : null;
}
