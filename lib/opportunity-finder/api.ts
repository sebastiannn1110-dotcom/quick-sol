import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  OpportunityActionCode,
  OpportunityReasonCode,
  OpportunitySelectedRole,
  OpportunityType,
  OpportunityWarningCode
} from "@/lib/opportunity-finder/types";

export const OPPORTUNITY_JOB_SELECT = [
  "id",
  "created_by",
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
  "cancelled_at"
].join(",");

export const OPPORTUNITY_FILE_SELECT = [
  "id",
  "job_id",
  "side",
  "original_file_name",
  "mime_type",
  "size_bytes",
  "detected_type",
  "selected_role",
  "classification_score",
  "classification_reasons",
  "sheet_profiles",
  "sheet_count",
  "row_count",
  "parse_status",
  "uploaded_at",
  "profiled_at",
  "parsed_at",
  "file_expires_at",
  "storage_deleted_at"
].join(",");

export const OPPORTUNITY_RESULT_SELECT = [
  "id",
  "job_id",
  "opportunity_type",
  "exact_match",
  "display_mpn",
  "normalized_mpn",
  "manufacturer",
  "customer_context",
  "supplier_context",
  "required_qty",
  "available_qty",
  "allocated_qty",
  "shortage_qty",
  "coverage_percent",
  "required_date",
  "unit_of_measure",
  "demand_file_id",
  "demand_file_name",
  "demand_sheet_name",
  "supply_file_id",
  "supply_file_name",
  "supply_sheet_name",
  "demand_source_rows",
  "supply_source_rows",
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

export function resultDatabaseRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    opportunityType: row.opportunity_type as OpportunityType,
    exactMatch: Boolean(row.exact_match),
    displayMpn: row.display_mpn as string,
    normalizedMpn: row.normalized_mpn as string,
    manufacturer: row.manufacturer as string | null,
    customerContext: row.customer_context as string | null,
    supplierContext: row.supplier_context as string | null,
    requiredQty: row.required_qty === null ? null : Number(row.required_qty),
    availableQty: row.available_qty === null ? null : Number(row.available_qty),
    allocatedQty: row.allocated_qty === null ? null : Number(row.allocated_qty),
    shortageQty: row.shortage_qty === null ? null : Number(row.shortage_qty),
    coveragePercent: row.coverage_percent === null ? null : Number(row.coverage_percent),
    requiredDate: row.required_date as string | null,
    unitOfMeasure: row.unit_of_measure as string | null,
    demandFileId: row.demand_file_id as string | null,
    demandFileName: row.demand_file_name as string | null,
    demandSheetName: row.demand_sheet_name as string | null,
    supplyFileId: row.supply_file_id as string | null,
    supplyFileName: row.supply_file_name as string | null,
    supplySheetName: row.supply_sheet_name as string | null,
    demandSourceRows: Number(row.demand_source_rows ?? 0),
    supplySourceRows: Number(row.supply_source_rows ?? 0),
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
    "sales_history",
    "ignore"
  ]);
  return typeof value === "string" && roles.has(value as OpportunitySelectedRole)
    ? value as OpportunitySelectedRole
    : null;
}
