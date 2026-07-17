import type { AuthContext } from "@/lib/auth/context";
import { getAiPermissionScope, mustForceOwnerScope } from "@/lib/ai/ai-permissions";
import { buildSupplierRanking, summarizeMpnOffers, type MpnOffer } from "@/lib/mpn/recommendation";
import { logger } from "@/lib/logger/logger";

export type AiDatabaseToolName =
  | "getUploadPresentationSummary"
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
  deterministic?: boolean;
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

function result(
  context: AuthContext,
  tool: AiDatabaseToolName,
  data: unknown,
  summary: string,
  empty: boolean,
  truncated = false,
  options?: { deterministic?: boolean; warning?: string }
): AiToolResult {
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
    truncated,
    deterministic: options?.deterministic,
    warning: options?.warning
  };
}

function normalizedText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function timeoutLike(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = [record.code, record.message, record.details, record.hint, String(error ?? "")].filter(Boolean).join(" ");
  return /57014|statement timeout|timeout/i.test(message);
}

async function logAiFallback(context: AuthContext, action: string, metadata?: Record<string, unknown>, error?: unknown) {
  await logger.warn({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "ai",
    action,
    message: "AI deterministic fallback event.",
    status: error ? "failed" : "completed",
    metadata,
    error
  });
}

type UploadPresentationKind =
  | "latest_files"
  | "columns"
  | "template"
  | "fields"
  | "format_issues"
  | "mixed_types"
  | "uploader"
  | "help";

type UploadOverview = {
  id: string;
  uploaded_by: string;
  original_file_name: string | null;
  file_type: string | null;
  detected_category: string | null;
  selected_category: string | null;
  status: string | null;
  total_rows: number | null;
  valid_rows: number | null;
  successful_rows: number | null;
  failed_rows: number | null;
  warning_count: number | null;
  rows_with_warnings: number | null;
  technical_error_count: number | null;
  data_quality_score: number | null;
  created_at: string;
  profiles?: {
    full_name?: string | null;
    email?: string | null;
    department?: string | null;
    region?: string | null;
    role?: string | null;
  } | null;
};

type ImportJobOverview = {
  id: string;
  upload_batch_id: string;
  status: string | null;
  total_rows: number | null;
  processed_rows: number | null;
  successful_rows: number | null;
  failed_rows: number | null;
  warning_count: number | null;
  rows_with_warnings: number | null;
  technical_error_count: number | null;
};

type SheetOverview = {
  upload_batch_id: string;
  sheet_name: string | null;
  detected_header_row: number | null;
  total_rows: number | null;
  valid_rows: number | null;
  invalid_rows: number | null;
  detected_category: string | null;
};

type ErrorSummaryOverview = {
  upload_batch_id: string;
  error_type: string;
  severity: string;
  message: string;
  occurrence_count: number;
  sample_raw_data?: {
    column_count?: number;
    columns?: string[];
    truncated_columns?: number;
  } | null;
};

const FIELD_ALIASES: Record<string, string[]> = {
  mpn: ["mpn", "part number", "part no", "pn", "p/n", "manufacturer part number", "mfr part number", "mfg part number", "item number", "component", "clean mpn"],
  supplier: ["supplier", "vendor", "supplier name", "manufacturer", "mfg", "brand"],
  customer: ["customer", "cliente", "client", "client id", "client code"],
  qty: ["qty", "quantity", "qtty", "stock qty", "delivery qto", "req qty", "request qty"],
  price: ["price", "unit price", "selling price", "best price", "offered price", "best price offered"],
  cost: ["cost", "unit cost", "product cost"],
  date: ["date", "shipping date", "earliest shipping date", "date code"],
  status: ["status", "state", "estado"],
  gp: ["gp", "gross profit"],
  gp_rate: ["gp rate", "gross profit rate", "margin rate"],
  po: ["po", "purchase order"]
};

const NORMALIZED_FIELD_LABEL: Record<string, string> = {
  mpn: "MPN",
  supplier: "supplier/manufacturer",
  customer: "customer",
  qty: "quantity",
  price: "price",
  cost: "cost",
  date: "date",
  status: "status",
  gp: "GP",
  gp_rate: "GP rate",
  po: "PO"
};

const SAMPLE_RECORD_FIELDS = [
  "mpn",
  "mpn_quoted",
  "manufacturer",
  "clean_mfg",
  "supplier",
  "supplier_name",
  "customer",
  "client",
  "qty",
  "req_qty",
  "price",
  "best_price_offered",
  "cost",
  "earliest_shipping_date",
  "date_code",
  "gp",
  "gp_rate",
  "po",
  "on_hand",
  "lead_time_weeks",
  "transit_time_weeks",
  "shipping_point_country",
  "delivery_point"
];

function classifyUploadPresentationQuestion(question: string): UploadPresentationKind {
  const text = normalizedText(question);
  if (/que puedo preguntarte|que preguntas|ayuda|help/.test(text)) return "help";
  if (/quien|subio|uploaded by|uploader/.test(text) && /archivo|upload|carga/.test(text)) return "uploader";
  if (/tipo mezclado|tipos mezclados|mixed type|normaliz/.test(text)) return "mixed_types";
  if (/problema|formato|warning|advertencia|incidencia|error/.test(text)) return "format_issues";
  if (/campo|detectaste|mpn|proveedor|cliente|cantidad|precio|costo|fecha|estado/.test(text)) return "fields";
  if (/plantilla|template|inventario|pricing|logistica|cotizacion|general/.test(text)) return "template";
  if (/columna|column/.test(text)) return "columns";
  return "latest_files";
}

function headersFromSummaries(summaries: ErrorSummaryOverview[], uploadId: string) {
  const headers = new Set<string>();
  let columnCount = 0;
  let truncatedColumns = 0;
  for (const summary of summaries.filter((item) => item.upload_batch_id === uploadId)) {
    const sample = summary.sample_raw_data;
    columnCount = Math.max(columnCount, Number(sample?.column_count ?? 0));
    truncatedColumns = Math.max(truncatedColumns, Number(sample?.truncated_columns ?? 0));
    for (const column of sample?.columns ?? []) {
      if (column && column.length <= 80) headers.add(column);
    }
  }
  return { headers: Array.from(headers).slice(0, 50), columnCount: columnCount || headers.size, truncatedColumns };
}

function headerMatches(header: string, aliases: string[]) {
  const normalized = normalizedText(header).replace(/[_-]+/g, " ");
  return aliases.some((alias) => {
    const normalizedAlias = normalizedText(alias);
    return normalized === normalizedAlias || normalized.includes(normalizedAlias);
  });
}

function sampleHasField(samples: Array<Record<string, unknown>>, uploadId: string, fields: string[]) {
  return samples.some((record) => {
    if (record.upload_batch_id !== uploadId) return false;
    return fields.some((field) => {
      const value = record[field];
      return value !== null && value !== undefined && value !== "";
    });
  });
}

function detectedFieldLabel(
  key: string,
  headers: string[],
  samples: Array<Record<string, unknown>>,
  uploadId: string,
  sampleFields: string[]
) {
  const header = headers.find((item) => headerMatches(item, FIELD_ALIASES[key] ?? []));
  if (header) return header;
  return sampleHasField(samples, uploadId, sampleFields) ? NORMALIZED_FIELD_LABEL[key] : "no detectado";
}

function detectedTemplate(input: {
  upload: UploadOverview;
  headers: string[];
  samples: Array<Record<string, unknown>>;
}) {
  const category = normalizedText(`${input.upload.detected_category ?? ""} ${input.upload.selected_category ?? ""}`);
  const joinedHeaders = normalizedText(input.headers.join(" "));
  const has = (fields: string[]) => fields.some((field) => joinedHeaders.includes(field));

  if (/inventory|inventario/.test(category) || has(["stock", "on hand", "inventory"])) return "inventario";
  if (/logistic|logistica|shipping/.test(category) || has(["shipping", "lead time", "transit", "delivery"])) return "logistica";
  if (/rfq|quotation|cotizacion|customer demand/.test(category)) return "cotizacion";
  if (/sales margin|supplier offer|pricing/.test(category) || has(["unit cost", "unit price", "gp rate", "gross profit", "best price"])) return "pricing";
  return "general";
}

function compactStatus(upload: UploadOverview) {
  if (upload.status === "completed_with_warnings") return "procesado con advertencias de calidad";
  if (upload.status === "completed") return "procesado";
  if (upload.status === "failed") return "fallido";
  return upload.status ?? "sin estado";
}

function formatIssueSummary(summaries: ErrorSummaryOverview[], uploadId: string) {
  const scoped = summaries
    .filter((item) => item.upload_batch_id === uploadId)
    .sort((left, right) => Number(right.occurrence_count ?? 0) - Number(left.occurrence_count ?? 0))
    .slice(0, 4);
  if (!scoped.length) return "No detecté problemas de formato en el resumen disponible.";
  return scoped
    .map((item) => `${item.message} (${item.occurrence_count} ocurrencias)`)
    .join(" ");
}

function mixedTypeSummary(summaries: ErrorSummaryOverview[], uploadId: string) {
  const scoped = summaries
    .filter((item) => item.upload_batch_id === uploadId)
    .filter((item) => /invalid_number|invalid_date|formula_error|data_quality_warning/i.test(item.error_type) || /number|date|numeric|formula|normaliz/i.test(item.message))
    .sort((left, right) => Number(right.occurrence_count ?? 0) - Number(left.occurrence_count ?? 0))
    .slice(0, 4);
  if (!scoped.length) return "No detecté columnas con tipos mezclados en el resumen disponible.";
  return scoped
    .map((item) => `${item.message} Debe normalizarse antes de comparar o calcular.`)
    .join(" ");
}

function uploadHelpSummary() {
  return [
    "Puedes preguntarme por los últimos archivos subidos, quién los subió, qué plantilla aplica, qué columnas se detectaron, qué campos parecen MPN, proveedor, cliente, cantidad, precio, costo, fecha y estado, y qué problemas de formato o tipos mezclados aparecen.",
    "Responderé usando el resumen disponible y sin mostrar datos reales del archivo."
  ].join(" ");
}

function buildUploadPresentationSummary(input: {
  kind: UploadPresentationKind;
  uploads: UploadOverview[];
  sheets: SheetOverview[];
  summaries: ErrorSummaryOverview[];
  samples: Array<Record<string, unknown>>;
}) {
  if (input.kind === "help") return uploadHelpSummary();
  const latest = input.uploads[0];
  if (!latest) return "No encontré archivos subidos visibles para responder esa pregunta.";

  const latestHeaders = headersFromSummaries(input.summaries, latest.id);
  const latestSheets = input.sheets.filter((sheet) => sheet.upload_batch_id === latest.id);
  const template = detectedTemplate({ upload: latest, headers: latestHeaders.headers, samples: input.samples });
  const profileMissing = latestHeaders.headers.length === 0;

  if (input.kind === "latest_files") {
    const lines = input.uploads.slice(0, 3).map((upload, index) => {
      const headers = headersFromSummaries(input.summaries, upload.id);
      const uploadTemplate = detectedTemplate({ upload, headers: headers.headers, samples: input.samples });
      return `Archivo ${index + 1}: parece ${uploadTemplate}, estado ${compactStatus(upload)}, con ${upload.successful_rows ?? upload.valid_rows ?? upload.total_rows ?? 0} filas procesadas.`;
    });
    return `Analicé los últimos archivos visibles sin mostrar datos reales. ${lines.join(" ")}`;
  }

  if (input.kind === "columns") {
    if (profileMissing) return "El archivo está importado, pero todavía falta generar el perfil estructural de columnas.";
    const columnText = latestHeaders.headers.slice(0, 30).join(", ");
    const extra = latestHeaders.truncatedColumns > 0 ? ` Hay ${latestHeaders.truncatedColumns} columnas adicionales no mostradas.` : "";
    return `El último archivo tiene aproximadamente ${latestHeaders.columnCount} columnas detectadas. Columnas visibles en el perfil: ${columnText}.${extra}`;
  }

  if (input.kind === "template") {
    const reason = latest.detected_category ? `La categoría detectada fue ${latest.detected_category}.` : "La decisión usa las columnas y el resumen de importación disponible.";
    return `La plantilla que mejor aplica al último archivo es ${template}. ${reason}`;
  }

  if (input.kind === "fields") {
    const headers = latestHeaders.headers;
    const parts = [
      `MPN como ${detectedFieldLabel("mpn", headers, input.samples, latest.id, ["mpn", "mpn_quoted"])}`,
      `proveedor o fabricante como ${detectedFieldLabel("supplier", headers, input.samples, latest.id, ["supplier", "supplier_name", "manufacturer", "clean_mfg"])}`,
      `cliente como ${detectedFieldLabel("customer", headers, input.samples, latest.id, ["customer", "client"])}`,
      `cantidad como ${detectedFieldLabel("qty", headers, input.samples, latest.id, ["qty", "req_qty", "on_hand"])}`,
      `precio como ${detectedFieldLabel("price", headers, input.samples, latest.id, ["price", "best_price_offered"])}`,
      `costo como ${detectedFieldLabel("cost", headers, input.samples, latest.id, ["cost"])}`,
      `fecha como ${detectedFieldLabel("date", headers, input.samples, latest.id, ["earliest_shipping_date", "date_code"])}`,
      `estado como ${detectedFieldLabel("status", headers, input.samples, latest.id, [])}`
    ];
    return `En el último archivo detecté ${parts.join(", ")}.`;
  }

  if (input.kind === "format_issues") {
    const sheetInfo = latestSheets.length
      ? `El archivo tiene ${latestSheets.length} hoja${latestSheets.length === 1 ? "" : "s"} registrada${latestSheets.length === 1 ? "" : "s"}.`
      : "";
    return `${sheetInfo} ${formatIssueSummary(input.summaries, latest.id)}`.trim();
  }

  if (input.kind === "mixed_types") {
    return mixedTypeSummary(input.summaries, latest.id);
  }

  const uploader = latest.profiles?.full_name || "un usuario visible";
  return `El último archivo lo subió ${uploader}. No muestro emails ni datos sensibles en esta respuesta.`;
}

export async function getUploadPresentationSummary(context: AuthContext, question: string) {
  const supabase = requireSupabase(context);
  const kind = classifyUploadPresentationQuestion(question);

  let uploadQuery = supabase
    .from("upload_batches")
    .select("id, uploaded_by, original_file_name, file_type, detected_category, selected_category, status, total_rows, valid_rows, successful_rows, failed_rows, warning_count, rows_with_warnings, technical_error_count, data_quality_score, created_at, profiles(full_name,email,department,region,role)")
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(kind === "latest_files" ? 3 : 1);
  if (mustForceOwnerScope(context.profile.role)) uploadQuery = uploadQuery.eq("uploaded_by", context.profile.id);
  const { data: uploads, error: uploadError } = await uploadQuery;
  if (uploadError) throw uploadError;

  const safeUploads = (uploads ?? []) as UploadOverview[];
  const uploadIds = safeUploads.map((upload) => upload.id);
  if (!uploadIds.length) {
    return result(context, "getUploadPresentationSummary", { uploads: [] }, "No encontré archivos subidos visibles para responder esa pregunta.", true, false, { deterministic: true });
  }

  const jobsPromise = supabase
    .from("import_jobs")
    .select("id, upload_batch_id, status, total_rows, processed_rows, successful_rows, failed_rows, warning_count, rows_with_warnings, technical_error_count, created_at")
    .in("upload_batch_id", uploadIds)
    .order("created_at", { ascending: false });
  const sheetsPromise = supabase
    .from("upload_sheets")
    .select("upload_batch_id, sheet_name, detected_header_row, total_rows, valid_rows, invalid_rows, detected_category")
    .in("upload_batch_id", uploadIds)
    .limit(20);
  const summariesPromise = supabase
    .from("import_job_error_summary")
    .select("upload_batch_id, error_type, severity, message, occurrence_count, sample_raw_data")
    .in("upload_batch_id", uploadIds)
    .order("occurrence_count", { ascending: false })
    .limit(50);
  const samplesPromise = supabase
    .from("business_records")
    .select(["upload_batch_id", ...SAMPLE_RECORD_FIELDS].join(", "))
    .in("upload_batch_id", uploadIds)
    .is("archived_at", null)
    .limit(30);

  const [jobsResult, sheetsResult, summariesResult, samplesResult] = await Promise.allSettled([
    jobsPromise,
    sheetsPromise,
    summariesPromise,
    samplesPromise
  ]);

  const optionalErrors: string[] = [];
  const pickData = <T>(settled: PromiseSettledResult<{ data: unknown; error: unknown }>, label: string): T | null => {
    if (settled.status === "rejected") {
      optionalErrors.push(label);
      void logAiFallback(context, timeoutLike(settled.reason) ? "ai_timeout" : "ai_context_limited", { label }, settled.reason);
      return null;
    }
    if (settled.value.error) {
      optionalErrors.push(label);
      void logAiFallback(context, timeoutLike(settled.value.error) ? "ai_timeout" : "ai_context_limited", { label }, settled.value.error);
      return null;
    }
    return settled.value.data as T | null;
  };

  const jobs = pickData<ImportJobOverview[]>(jobsResult, "import_jobs") ?? [];
  const sheets = pickData<SheetOverview[]>(sheetsResult, "upload_sheets") ?? [];
  const summaries = pickData<ErrorSummaryOverview[]>(summariesResult, "import_job_error_summary") ?? [];
  const samples = pickData<Array<Record<string, unknown>>>(samplesResult, "business_records_sample") ?? [];
  const summary = buildUploadPresentationSummary({ kind, uploads: safeUploads, sheets, summaries, samples });

  if (!summaries.length) {
    void logAiFallback(context, "ai_missing_file_profile", { kind, uploadCount: safeUploads.length });
  }
  if (optionalErrors.length) {
    void logAiFallback(context, "ai_fallback_used", { kind, optionalErrors });
  }

  return result(
    context,
    "getUploadPresentationSummary",
    { uploads: safeUploads, jobs, sheets, summaries, sampleFieldCount: samples.length },
    summary,
    false,
    false,
    {
      deterministic: true,
      warning: optionalErrors.length ? "No pude obtener todos los detalles en este momento, pero puedo mostrarte el resumen disponible." : undefined
    }
  );
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
