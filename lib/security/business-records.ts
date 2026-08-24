import type { UserRole } from "@/lib/types";

export const BUSINESS_RECORDS_SAFE_VIEW = "business_records_safe_v1";
export const BUSINESS_RECORDS_COMMERCIAL_VIEW = "business_records_commercial_v1";
export const IMPORT_ERRORS_SAFE_VIEW = "import_errors_safe_v1";
export const BUSINESS_MPN_SUMMARIES_SAFE_VIEW = "business_mpn_summaries_safe_v1";
export const BUSINESS_OPPORTUNITY_ENTITIES_SAFE_VIEW = "business_opportunity_entities_safe_v1";

export const SAFE_RECORD_SELECT = [
  "id", "upload_batch_id", "upload_sheet_id", "uploaded_by", "category", "row_index",
  "has_errors", "created_at", "archived_at", "line_id", "mpn", "mpn_quoted",
  "description", "generic", "qty", "req_qty", "date_code", "moq", "spq", "on_hand",
  "lead_time_weeks", "transit_time_weeks", "earliest_shipping_date",
  "shipping_point_country", "delivery_point", "profiles", "upload_batches"
].join(",");

export const COMMERCIAL_RECORD_SELECT = [
  "id", "upload_batch_id", "upload_sheet_id", "uploaded_by", "category", "row_index",
  "has_errors", "created_at", "archived_at", "line_id", "client", "customer", "supplier",
  "supplier_name", "mpn", "mpn_quoted", "manufacturer", "clean_mfg", "description", "generic",
  "po", "qty", "req_qty", "cost", "price", "total_price", "gp_rate", "gp", "commission",
  "potential_amount_usd", "target_to_vendor", "best_price_offered", "date_code", "moq", "spq",
  "on_hand", "lead_time_weeks", "transit_time_weeks", "earliest_shipping_date",
  "shipping_point_country", "delivery_point", "comments", "profiles", "upload_batches"
].join(",");

export type BusinessRecordReadContract = {
  table: typeof BUSINESS_RECORDS_SAFE_VIEW | typeof BUSINESS_RECORDS_COMMERCIAL_VIEW;
  select: string;
};

export function businessRecordReadContract(
  role: UserRole,
  options: { aiSafe?: boolean } = {}
): BusinessRecordReadContract {
  if (options.aiSafe || role === "employee") {
    return { table: BUSINESS_RECORDS_SAFE_VIEW, select: SAFE_RECORD_SELECT };
  }
  return { table: BUSINESS_RECORDS_COMMERCIAL_VIEW, select: COMMERCIAL_RECORD_SELECT };
}

export function permittedRecordSearchColumns(role: UserRole, options: { aiSafe?: boolean } = {}) {
  const safe = ["mpn", "mpn_quoted", "description", "generic", "line_id", "category"];
  if (options.aiSafe || role === "employee") return safe;
  const commercial = [...safe, "supplier", "supplier_name", "customer", "client", "manufacturer", "clean_mfg"];
  if (role === "manager") return commercial;
  return [...commercial, "po", "comments"];
}

export function ilikeAny(columns: string[], value: string) {
  const escaped = value.replace(/[%_,()]/g, "").slice(0, 120);
  return columns.map((column) => `${column}.ilike.%${escaped}%`).join(",");
}
