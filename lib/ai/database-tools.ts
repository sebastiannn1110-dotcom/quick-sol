import type { AuthContext } from "@/lib/auth/context";
import { getAiPermissionScope, mustForceOwnerScope } from "@/lib/ai/ai-permissions";
import { buildSupplierRanking, summarizeMpnOffers, type MpnOffer } from "@/lib/mpn/recommendation";

export type AiDatabaseToolName =
  | "getLatestUpload"
  | "searchBusinessRecords"
  | "getRecordsByMpn"
  | "getUploadsByUser"
  | "getImportErrors"
  | "getDashboardSummary"
  | "getMpnPriceComparison"
  | "getEmployeeSummary"
  | "getLowGpRecords"
  | "getMissingMpnRecords";

export interface AiToolResult {
  ok: boolean;
  tool: AiDatabaseToolName;
  scope: "own" | "team" | "company";
  total?: number;
  rows?: unknown[];
  data: unknown;
  summary: string;
  empty: boolean;
  truncated?: boolean;
  warning?: string;
  error?: string;
}

function requireSupabase(context: AuthContext) {
  if (!context.supabase) throw new Error("Supabase is not available for AI database tools.");
  return context.supabase;
}

function cleanSearchTerm(value: string, max = 100) {
  return value.replace(/[^\p{L}\p{N}\s._@-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function rowsFromData(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.records)) return record.records;
    if (Array.isArray(record.uploads)) return record.uploads;
    if (Array.isArray(record.offers)) return record.offers;
  }
  return undefined;
}

function result(context: AuthContext, tool: AiDatabaseToolName, data: unknown, summary: string, empty: boolean, truncated = false): AiToolResult {
  const rows = rowsFromData(data);
  return {
    ok: !empty,
    tool,
    scope: getAiPermissionScope(context).mode,
    total: rows?.length,
    rows,
    data,
    summary,
    empty,
    truncated
  };
}

export async function getLatestUpload(context: AuthContext) {
  const supabase = requireSupabase(context);
  let query = supabase
    .from("upload_batches")
    .select("id, uploaded_by, original_file_name, detected_category, status, total_rows, valid_rows, invalid_rows, successful_rows, failed_rows, error_count, warning_count, rows_with_warnings, technical_error_count, suppressed_error_count, data_quality_score, created_at, profiles(full_name,email,department,region,role)")
    .order("created_at", { ascending: false })
    .limit(1);
  if (mustForceOwnerScope(context.profile.role)) query = query.eq("uploaded_by", context.profile.id);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  const summary = data
    ? data.status === "completed_with_warnings"
      ? `Ultima carga: ${data.original_file_name}. Se importaron ${data.successful_rows ?? data.valid_rows ?? 0} de ${data.total_rows ?? 0} filas. Termino con ${data.rows_with_warnings ?? 0} filas con advertencias de datos y ${data.technical_error_count ?? 0} errores tecnicos.`
      : `Ultima carga: ${data.original_file_name}, estado ${data.status}, ${data.total_rows} filas y ${data.error_count} incidencias.`
    : "No hay cargas visibles.";
  return result(context, "getLatestUpload", data, summary, !data);
}

export async function searchBusinessRecords(context: AuthContext, searchTerm: string) {
  const supabase = requireSupabase(context);
  const term = cleanSearchTerm(searchTerm);
  if (term.length < 2) return result(context, "searchBusinessRecords", [], "La busqueda necesita al menos dos caracteres.", true);
  const pattern = `%${term}%`;
  let query = supabase
    .from("business_records")
    .select("id, upload_batch_id, uploaded_by, category, customer, client, supplier, supplier_name, mpn, mpn_quoted, description, qty, cost, price, total_price, gp_rate, gp, commission, has_errors, created_at, profiles(full_name,email,department,region,role), upload_batches(original_file_name)")
    .is("archived_at", null)
    .or(`searchable_text.ilike.${pattern},mpn.ilike.${pattern},mpn_quoted.ilike.${pattern},supplier.ilike.${pattern},supplier_name.ilike.${pattern},customer.ilike.${pattern},client.ilike.${pattern}`)
    .order("created_at", { ascending: false })
    .limit(50);
  if (mustForceOwnerScope(context.profile.role)) query = query.eq("uploaded_by", context.profile.id);
  const { data, error } = await query;
  if (error) throw error;
  return result(context, "searchBusinessRecords", data ?? [], `Se encontraron ${data?.length ?? 0} registros para ${term}.`, !data?.length, (data?.length ?? 0) === 50);
}

export async function getRecordsByMpn(context: AuthContext, mpnInput: string) {
  const supabase = requireSupabase(context);
  const mpn = cleanSearchTerm(mpnInput, 80);
  let query = supabase
    .from("business_records")
    .select("id, upload_batch_id, uploaded_by, category, customer, supplier, supplier_name, mpn, mpn_quoted, manufacturer, qty, cost, price, total_price, gp_rate, gp, commission, created_at, profiles(full_name,email,department,region,role), upload_batches(original_file_name)")
    .is("archived_at", null)
    .or(`mpn.ilike.%${mpn}%,mpn_quoted.ilike.%${mpn}%`)
    .order("created_at", { ascending: false })
    .limit(100);
  if (mustForceOwnerScope(context.profile.role)) query = query.eq("uploaded_by", context.profile.id);
  const { data, error } = await query;
  if (error) throw error;
  return result(context, "getRecordsByMpn", data ?? [], `Se encontraron ${data?.length ?? 0} registros para el MPN ${mpn}.`, !data?.length, (data?.length ?? 0) === 100);
}

export async function getUploadsByUser(context: AuthContext, userSearch: string) {
  const supabase = requireSupabase(context);
  if (mustForceOwnerScope(context.profile.role)) {
    const own = await supabase.from("upload_batches").select("id, original_file_name, status, total_rows, error_count, data_quality_score, created_at").eq("uploaded_by", context.profile.id).order("created_at", { ascending: false }).limit(30);
    if (own.error) throw own.error;
    return result(context, "getUploadsByUser", own.data ?? [], `Tienes ${own.data?.length ?? 0} cargas recientes.`, !own.data?.length, (own.data?.length ?? 0) === 30);
  }

  const term = cleanSearchTerm(userSearch, 80);
  const { data: profiles, error: profileError } = await supabase.from("profiles").select("id, full_name, email, department, region, role").or(`full_name.ilike.%${term}%,email.ilike.%${term}%`).limit(10);
  if (profileError) throw profileError;
  const ids = (profiles ?? []).map((profile) => profile.id);
  if (!ids.length) return result(context, "getUploadsByUser", { profiles: [], uploads: [] }, "No se encontro un usuario visible con ese nombre.", true);
  const { data: uploads, error } = await supabase.from("upload_batches").select("id, uploaded_by, original_file_name, status, total_rows, error_count, data_quality_score, created_at").in("uploaded_by", ids).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return result(context, "getUploadsByUser", { profiles, uploads: uploads ?? [] }, `Se encontraron ${uploads?.length ?? 0} cargas para ${profiles?.map((item) => item.full_name).join(", ")}.`, !uploads?.length, (uploads?.length ?? 0) === 50);
}

export async function getImportErrors(context: AuthContext, uploadId?: string) {
  const supabase = requireSupabase(context);
  let query = supabase.from("import_errors").select("id, upload_batch_id, row_index, column_name, error_type, message, raw_value, severity, created_at, upload_batches(original_file_name,uploaded_by)").order("created_at", { ascending: false }).limit(50);
  if (uploadId) query = query.eq("upload_batch_id", uploadId);
  const { data, error } = await query;
  if (error) throw error;
  return result(context, "getImportErrors", data ?? [], `Hay ${data?.length ?? 0} errores de importacion visibles en la consulta.`, !data?.length, (data?.length ?? 0) === 50);
}

export async function getDashboardSummary(context: AuthContext) {
  const supabase = requireSupabase(context);
  const ownerId = mustForceOwnerScope(context.profile.role) ? context.profile.id : null;
  let recordsCount = supabase.from("business_records").select("id", { count: "exact", head: true }).is("archived_at", null);
  let uploadsCount = supabase.from("upload_batches").select("id", { count: "exact", head: true }).neq("status", "archived");
  let errorCount = supabase.from("business_records").select("id", { count: "exact", head: true }).is("archived_at", null).eq("has_errors", true);
  let missingMpnCount = supabase.from("business_records").select("id", { count: "exact", head: true }).is("archived_at", null).is("mpn", null);
  if (ownerId) {
    recordsCount = recordsCount.eq("uploaded_by", ownerId);
    uploadsCount = uploadsCount.eq("uploaded_by", ownerId);
    errorCount = errorCount.eq("uploaded_by", ownerId);
    missingMpnCount = missingMpnCount.eq("uploaded_by", ownerId);
  }
  const [records, uploads, errors, missingMpn, latest] = await Promise.all([recordsCount, uploadsCount, errorCount, missingMpnCount, getLatestUpload(context)]);
  const data = { totalRecords: records.count ?? 0, totalUploads: uploads.count ?? 0, recordsWithErrors: errors.count ?? 0, recordsMissingMpn: missingMpn.count ?? 0, latestUpload: latest.data, scope: getAiPermissionScope(context).mode };
  return result(context, "getDashboardSummary", data, `Resumen: ${data.totalRecords} registros, ${data.totalUploads} cargas, ${data.recordsWithErrors} registros con errores y ${data.recordsMissingMpn} sin MPN.`, data.totalRecords === 0);
}

export async function getMpnPriceComparison(context: AuthContext, mpn: string) {
  const records = await getRecordsByMpn(context, mpn);
  const rows = (Array.isArray(records.data) ? records.data : []) as MpnOffer[];
  const summary = summarizeMpnOffers(rows);
  const ranking = buildSupplierRanking(rows).slice(0, 10);
  const data = { mpn, summary, ranking, offers: rows.slice(0, 25) };
  return result(context, "getMpnPriceComparison", data, summary.recommendedSupplier ? `Mejor opcion para ${mpn}: ${summary.recommendedSupplier}. ${summary.recommendationReason}` : `No hay ofertas comparables para ${mpn}.`, !summary.recommendedSupplier, rows.length > 25);
}

export async function getEmployeeSummary(context: AuthContext, userSearch: string) {
  const uploads = await getUploadsByUser(context, userSearch);
  const data = uploads.data as { profiles?: Array<{ id: string; full_name: string }>; uploads?: Array<{ id: string }> } | Array<unknown>;
  return result(context, "getEmployeeSummary", data, uploads.summary, uploads.empty, uploads.truncated);
}

export async function getLowGpRecords(context: AuthContext, threshold = 0.15) {
  const supabase = requireSupabase(context);
  const safeThreshold = Math.min(Math.max(Number(threshold) || 0.15, 0), 1);
  let query = supabase.from("business_records").select("id, upload_batch_id, uploaded_by, mpn, customer, supplier, price, cost, gp_rate, gp, commission, created_at, profiles(full_name,email,department,region,role), upload_batches(original_file_name)").is("archived_at", null).not("gp_rate", "is", null).lt("gp_rate", safeThreshold).order("gp_rate", { ascending: true }).limit(50);
  if (mustForceOwnerScope(context.profile.role)) query = query.eq("uploaded_by", context.profile.id);
  const { data, error } = await query;
  if (error) throw error;
  return result(context, "getLowGpRecords", { threshold: safeThreshold, records: data ?? [] }, `Hay ${data?.length ?? 0} registros visibles con GP rate menor a ${(safeThreshold * 100).toFixed(1)}%.`, !data?.length, (data?.length ?? 0) === 50);
}

export async function getMissingMpnRecords(context: AuthContext) {
  const supabase = requireSupabase(context);
  let query = supabase.from("business_records").select("id, upload_batch_id, uploaded_by, category, customer, supplier, description, created_at, profiles(full_name,email,department,region,role), upload_batches(original_file_name)").is("archived_at", null).is("mpn", null).order("created_at", { ascending: false }).limit(50);
  if (mustForceOwnerScope(context.profile.role)) query = query.eq("uploaded_by", context.profile.id);
  const { data, error } = await query;
  if (error) throw error;
  return result(context, "getMissingMpnRecords", data ?? [], `Hay ${data?.length ?? 0} registros visibles sin MPN.`, !data?.length, (data?.length ?? 0) === 50);
}
