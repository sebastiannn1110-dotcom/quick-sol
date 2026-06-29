// Analytics intentionally excludes raw_data, normalized_data, searchable_text and
// other large JSON/text fields. The dashboard only needs these scalar columns.
export const ANALYTICS_RECORD_SELECT = [
  "id", "upload_batch_id", "upload_sheet_id", "uploaded_by", "category", "row_index",
  "has_errors", "errors", "created_at", "archived_at", "line_id", "client", "customer",
  "supplier", "supplier_name", "mpn", "mpn_quoted", "manufacturer", "clean_mfg",
  "description", "generic", "po", "qty", "req_qty", "cost", "price", "total_price",
  "gp_rate", "gp", "commission", "potential_amount_usd", "target_to_vendor",
  "best_price_offered", "date_code", "moq", "spq", "on_hand", "lead_time_weeks",
  "transit_time_weeks", "earliest_shipping_date", "shipping_point_country",
  "delivery_point", "comments", "profiles(full_name,email,department,region,role)"
].join(",");

export const ANALYTICS_UPLOAD_SELECT = [
  "id", "uploaded_by", "original_file_name", "status", "detected_category", "selected_category",
  "total_rows", "valid_rows", "invalid_rows", "error_count", "data_quality_score", "created_at",
  "completed_at", "archived_at", "profiles(full_name,email,department,region,role)"
].join(",");

export const ANALYTICS_PROFILE_SELECT = "id,full_name,email,role,department,region,is_active,created_at,updated_at,avatar_path";
