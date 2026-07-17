import type { SupabaseClient } from "@supabase/supabase-js";

export type FileTemplate =
  | "inventario"
  | "pricing"
  | "pricing/logistica"
  | "logistica"
  | "cotizacion"
  | "cotizacion/logistica"
  | "compras/ventas"
  | "general";

export type StructureField =
  | "mpn"
  | "proveedor"
  | "fabricante"
  | "cliente"
  | "cantidad"
  | "precio"
  | "costo"
  | "fecha"
  | "estado"
  | "region"
  | "facility"
  | "notas"
  | "gp"
  | "gp_rate"
  | "po";

export type InferredColumnType = "text" | "number" | "date" | "status" | "notes" | "unknown";

export type StructureColumnProfile = {
  name: string;
  normalizedName: string;
  source: "sheet" | "raw_data" | "normalized_data";
  inferredType: InferredColumnType;
  meaning: string;
  mappedField: StructureField | null;
  occurrenceCount: number;
  presenceRate: number;
};

export type UploadStructureProfile = {
  id?: string;
  uploadBatchId: string;
  fileType: string | null;
  sheetCount: number;
  rowCount: number;
  columnCount: number;
  columns: StructureColumnProfile[];
  detectedTemplate: FileTemplate;
  detectedMappings: Partial<Record<StructureField, string>>;
  dataQualitySummary: {
    warningCount: number;
    rowsWithWarnings: number;
    technicalErrorCount: number;
    topIssues: Array<{ errorType: string; severity: string; message: string; occurrenceCount: number }>;
  };
  warnings: Array<{ type: string; message: string; occurrenceCount?: number }>;
  confidenceScore: number;
  createdAt?: string;
  updatedAt?: string;
};

type JsonRecord = Record<string, unknown>;
type DatabaseClient = Pick<SupabaseClient, "from">;

type UploadProfileInput = {
  id: string;
  file_type?: string | null;
  total_sheets?: number | null;
  total_rows?: number | null;
  valid_rows?: number | null;
  successful_rows?: number | null;
  warning_count?: number | null;
  rows_with_warnings?: number | null;
  technical_error_count?: number | null;
  detected_category?: string | null;
  selected_category?: string | null;
};

type SheetProfileInput = {
  upload_batch_id?: string | null;
  sheet_name?: string | null;
  detected_header_row?: number | null;
  total_rows?: number | null;
  valid_rows?: number | null;
  invalid_rows?: number | null;
  detected_category?: string | null;
  headers_json?: unknown;
  headers?: unknown;
  normalized_headers_json?: unknown;
};

type RecordProfileInput = {
  raw_data?: unknown;
  normalized_data?: unknown;
};

type ErrorSummaryInput = {
  error_type?: string | null;
  severity?: string | null;
  message?: string | null;
  occurrence_count?: number | null;
  sample_raw_data?: unknown;
};

const PROFILE_SELECT = [
  "id",
  "upload_batch_id",
  "file_type",
  "sheet_count",
  "row_count",
  "column_count",
  "columns_json",
  "detected_template",
  "detected_mappings_json",
  "data_quality_summary_json",
  "warnings_json",
  "confidence_score",
  "created_at",
  "updated_at"
].join(",");

const FIELD_ALIASES: Record<StructureField, string[]> = {
  mpn: ["mpn", "part number", "part no", "part no.", "pn", "p/n", "manufacturer part number", "mfr part number", "mfg part number", "item number", "component", "clean mpn"],
  proveedor: ["supplier", "vendor", "supplier name", "global supplier name"],
  fabricante: ["manufacturer", "manufacturer quoted", "mfg", "brand", "clean mfg"],
  cliente: ["customer", "cliente", "client", "client id", "client code", "global customer name"],
  cantidad: ["qty", "quantity", "qtty", "stock qty", "delivery qto", "req qty", "request qty", "rcpt qty", "receipt qty", "on hand", "stock"],
  precio: ["price", "unit price", "selling price", "best price", "offered price", "best price offered", "pricebook", "usd extended price", "extended price"],
  costo: ["cost", "unit cost", "product cost"],
  fecha: ["date", "shipping date", "earliest shipping date", "date code", "created date", "receipt date"],
  estado: ["status", "state", "estado"],
  region: ["region", "geo", "area"],
  facility: ["facility", "plant", "site", "warehouse", "location"],
  notas: ["notes", "note", "comments", "comment", "remark", "remarks"],
  gp: ["gp", "gross profit"],
  gp_rate: ["gp rate", "gross profit rate", "margin rate"],
  po: ["po", "purchase order", "sales order", "order"]
};

const NORMALIZED_FIELD_MAP: Record<string, StructureField> = {
  mpn: "mpn",
  mpn_quoted: "mpn",
  supplier: "proveedor",
  supplier_name: "proveedor",
  manufacturer: "fabricante",
  clean_mfg: "fabricante",
  customer: "cliente",
  client: "cliente",
  qty: "cantidad",
  req_qty: "cantidad",
  on_hand: "cantidad",
  price: "precio",
  total_price: "precio",
  best_price_offered: "precio",
  cost: "costo",
  earliest_shipping_date: "fecha",
  date_code: "fecha",
  shipping_point_country: "region",
  delivery_point: "facility",
  comments: "notas",
  gp: "gp",
  gp_rate: "gp_rate",
  po: "po"
};

const NUMERIC_FIELDS = new Set<StructureField>(["cantidad", "precio", "costo", "gp", "gp_rate"]);
const DATE_FIELDS = new Set<StructureField>(["fecha"]);

function safeIssueMessage(errorType: string | null | undefined) {
  const normalized = normalizeText(String(errorType ?? ""));
  if (/invalid.*number|number|numeric/.test(normalized)) return "Columna numerica con valores no normalizados.";
  if (/invalid.*date|date/.test(normalized)) return "Columna de fecha con valores no normalizados.";
  if (/formula/.test(normalized)) return "Celda o columna con formula no importable directamente.";
  if (/missing|required|null/.test(normalized)) return "Campo requerido ausente en algunas filas.";
  if (/duplicate/.test(normalized)) return "Filas repetidas detectadas durante la importacion.";
  if (/data.*quality|warning/.test(normalized)) return "Advertencia de calidad de datos detectada.";
  return "Incidencia de formato o calidad detectada.";
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s./]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toNormalizedName(value: string) {
  return normalizeText(value).replace(/[./\s]+/g, "_").replace(/^_+|_+$/g, "");
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0 && item.length <= 120);
}

function fieldForColumn(columnName: string, normalizedName = toNormalizedName(columnName)): StructureField | null {
  const direct = NORMALIZED_FIELD_MAP[normalizedName];
  if (direct) return direct;

  const normalizedColumn = normalizeText(columnName);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[StructureField, string[]]>) {
    if (aliases.some((alias) => {
      const normalizedAlias = normalizeText(alias);
      return normalizedColumn === normalizedAlias || normalizedColumn.includes(normalizedAlias);
    })) {
      return field;
    }
  }

  return null;
}

function inferredTypeForField(field: StructureField | null, columnName: string): InferredColumnType {
  if (!field) return /id|code|number|mpn|po/i.test(columnName) ? "text" : "unknown";
  if (NUMERIC_FIELDS.has(field)) return "number";
  if (DATE_FIELDS.has(field)) return "date";
  if (field === "estado") return "status";
  if (field === "notas") return "notes";
  return "text";
}

function meaningForField(field: StructureField | null, columnName: string) {
  if (field === "mpn") return "numero de parte o MPN";
  if (field === "proveedor") return "proveedor";
  if (field === "fabricante") return "fabricante o marca";
  if (field === "cliente") return "cliente";
  if (field === "cantidad") return "cantidad";
  if (field === "precio") return "precio de venta u oferta";
  if (field === "costo") return "costo unitario";
  if (field === "fecha") return "fecha";
  if (field === "estado") return "estado del registro";
  if (field === "region") return "region";
  if (field === "facility") return "facility, planta o ubicacion";
  if (field === "notas") return "notas o comentarios";
  if (field === "gp") return "gross profit";
  if (field === "gp_rate") return "porcentaje de margen";
  if (field === "po") return "orden de compra o venta";
  return `columna ${columnName}`;
}

function templateFromSignals(input: {
  upload: UploadProfileInput;
  columns: StructureColumnProfile[];
  mappings: Partial<Record<StructureField, string>>;
}): FileTemplate {
  const text = normalizeText([
    input.upload.detected_category,
    input.upload.selected_category,
    ...input.columns.map((column) => `${column.name} ${column.normalizedName}`)
  ].filter(Boolean).join(" "));
  const has = (pattern: RegExp) => pattern.test(text);
  const mapped = (field: StructureField) => Boolean(input.mappings[field]);

  if (
    (mapped("fabricante") || has(/\bmfg\b|manufacturer|brand/)) &&
    mapped("mpn") &&
    (has(/stock qty|stock|on hand|inventory/) || mapped("cantidad")) &&
    (has(/unit cost/) || mapped("costo"))
  ) {
    return "inventario";
  }

  if (has(/global customer name|global supplier name|rcpt qty|receipt qty|usd extended price/)) {
    return "cotizacion/logistica";
  }

  if (has(/pricebook/) && (has(/lead ?time/) || mapped("estado"))) return "pricing/logistica";
  if ((mapped("precio") || mapped("costo") || mapped("gp_rate") || mapped("gp")) && mapped("cantidad")) return "pricing";
  if (has(/shipping|delivery|transit|lead ?time|facility|warehouse|rcpt|receipt/) || mapped("facility")) return "logistica";
  if (has(/rfq|quote|quotation|cotizacion/) || (mapped("cliente") && mapped("proveedor") && mapped("precio"))) return "cotizacion";
  if (mapped("po") || has(/purchase order|sales order|order/)) return "compras/ventas";
  if (has(/inventory|inventario/)) return "inventario";
  return "general";
}

function profileFromDb(row: JsonRecord): UploadStructureProfile {
  return {
    id: String(row.id ?? ""),
    uploadBatchId: String(row.upload_batch_id ?? ""),
    fileType: row.file_type ? String(row.file_type) : null,
    sheetCount: Number(row.sheet_count ?? 0),
    rowCount: Number(row.row_count ?? 0),
    columnCount: Number(row.column_count ?? 0),
    columns: Array.isArray(row.columns_json) ? row.columns_json as StructureColumnProfile[] : [],
    detectedTemplate: (row.detected_template ? String(row.detected_template) : "general") as FileTemplate,
    detectedMappings: asRecord(row.detected_mappings_json) as Partial<Record<StructureField, string>>,
    dataQualitySummary: {
      warningCount: Number(asRecord(row.data_quality_summary_json).warningCount ?? 0),
      rowsWithWarnings: Number(asRecord(row.data_quality_summary_json).rowsWithWarnings ?? 0),
      technicalErrorCount: Number(asRecord(row.data_quality_summary_json).technicalErrorCount ?? 0),
      topIssues: Array.isArray(asRecord(row.data_quality_summary_json).topIssues)
        ? asRecord(row.data_quality_summary_json).topIssues as Array<{ errorType: string; severity: string; message: string; occurrenceCount: number }>
        : []
    },
    warnings: Array.isArray(row.warnings_json) ? row.warnings_json as UploadStructureProfile["warnings"] : [],
    confidenceScore: Number(row.confidence_score ?? 0),
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined
  };
}

export function buildUploadStructureProfile(input: {
  upload: UploadProfileInput;
  sheets?: SheetProfileInput[];
  records?: RecordProfileInput[];
  errorSummaries?: ErrorSummaryInput[];
}): UploadStructureProfile {
  const occurrence = new Map<string, StructureColumnProfile>();
  const sampleRows = Math.max(input.records?.length ?? 0, 1);

  const addColumn = (name: string, source: StructureColumnProfile["source"], count = sampleRows) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) return;
    const normalizedName = toNormalizedName(trimmed);
    const key = `${source}:${normalizedName}`;
    const mappedField = fieldForColumn(trimmed, normalizedName);
    const existing = occurrence.get(key);
    if (existing) {
      existing.occurrenceCount += count;
      existing.presenceRate = Math.min(1, existing.occurrenceCount / sampleRows);
      return;
    }
    occurrence.set(key, {
      name: trimmed,
      normalizedName,
      source,
      inferredType: inferredTypeForField(mappedField, trimmed),
      meaning: meaningForField(mappedField, trimmed),
      mappedField,
      occurrenceCount: count,
      presenceRate: Math.min(1, count / sampleRows)
    });
  };

  for (const sheet of input.sheets ?? []) {
    for (const header of [
      ...asStringArray(sheet.headers_json),
      ...asStringArray(sheet.headers)
    ]) {
      addColumn(header, "sheet", Number(sheet.total_rows ?? input.upload.total_rows ?? sampleRows) || sampleRows);
    }
  }

  for (const summary of input.errorSummaries ?? []) {
    const sample = asRecord(summary.sample_raw_data);
    for (const header of asStringArray(sample.columns)) addColumn(header, "sheet", Number(summary.occurrence_count ?? 1) || 1);
  }

  for (const record of input.records ?? []) {
    const rawData = asRecord(record.raw_data);
    for (const key of Object.keys(rawData)) addColumn(key, "raw_data", 1);
  }

  const hasExternalColumns = Array.from(occurrence.values()).some((column) => column.source !== "normalized_data");
  if (!hasExternalColumns) {
    for (const record of input.records ?? []) {
      const normalizedData = asRecord(record.normalized_data);
      for (const key of Object.keys(normalizedData)) {
        if (NORMALIZED_FIELD_MAP[key] || FIELD_ALIASES[key as StructureField]) addColumn(key, "normalized_data", 1);
      }
    }
  }

  const columns = Array.from(occurrence.values()).sort((left, right) => {
    if (left.source !== right.source) return left.source.localeCompare(right.source);
    return left.name.localeCompare(right.name);
  });
  const mappings: Partial<Record<StructureField, string>> = {};
  for (const column of columns) {
    if (column.mappedField && !mappings[column.mappedField]) mappings[column.mappedField] = column.name;
  }

  const topIssues = (input.errorSummaries ?? [])
    .map((summary) => ({
      errorType: String(summary.error_type ?? "unknown"),
      severity: String(summary.severity ?? "low"),
      message: safeIssueMessage(summary.error_type),
      occurrenceCount: Number(summary.occurrence_count ?? 0)
    }))
    .sort((left, right) => right.occurrenceCount - left.occurrenceCount)
    .slice(0, 8);
  const warnings: UploadStructureProfile["warnings"] = topIssues.map((issue) => ({
    type: issue.errorType,
    message: issue.message,
    occurrenceCount: issue.occurrenceCount
  }));
  if (!columns.length) {
    warnings.push({
      type: "missing_column_profile",
      message: "No structural column keys were available for this upload."
    });
  }

  const detectedTemplate = templateFromSignals({ upload: input.upload, columns, mappings });
  const confidenceScore = Math.min(0.95, Math.max(0.2, 0.35 + Object.keys(mappings).length * 0.07 + (columns.length ? 0.15 : 0)));

  return {
    uploadBatchId: input.upload.id,
    fileType: input.upload.file_type ?? null,
    sheetCount: Number(input.upload.total_sheets ?? input.sheets?.length ?? 0),
    rowCount: Number(input.upload.successful_rows ?? input.upload.valid_rows ?? input.upload.total_rows ?? 0),
    columnCount: columns.length,
    columns,
    detectedTemplate,
    detectedMappings: mappings,
    dataQualitySummary: {
      warningCount: Number(input.upload.warning_count ?? 0),
      rowsWithWarnings: Number(input.upload.rows_with_warnings ?? 0),
      technicalErrorCount: Number(input.upload.technical_error_count ?? 0),
      topIssues
    },
    warnings,
    confidenceScore
  };
}

export async function ensureUploadStructureProfile(
  supabase: DatabaseClient,
  uploadBatchId: string
): Promise<UploadStructureProfile> {
  const existing = await supabase
    .from("file_schema_profiles")
    .select(PROFILE_SELECT)
    .eq("upload_batch_id", uploadBatchId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return profileFromDb(existing.data as unknown as JsonRecord);

  const uploadResult = await supabase
    .from("upload_batches")
    .select("id,file_type,total_sheets,total_rows,valid_rows,successful_rows,warning_count,rows_with_warnings,technical_error_count,detected_category,selected_category")
    .eq("id", uploadBatchId)
    .maybeSingle();
  if (uploadResult.error) throw uploadResult.error;
  if (!uploadResult.data) throw new Error("Upload batch not found.");

  const [sheetsResult, recordsResult, summariesResult] = await Promise.all([
    supabase
      .from("upload_sheets")
      .select("upload_batch_id,sheet_name,detected_header_row,total_rows,valid_rows,invalid_rows,detected_category")
      .eq("upload_batch_id", uploadBatchId)
      .limit(20),
    supabase
      .from("business_records")
      .select("raw_data,normalized_data")
      .eq("upload_batch_id", uploadBatchId)
      .is("archived_at", null)
      .limit(50),
    supabase
      .from("import_job_error_summary")
      .select("error_type,severity,message,occurrence_count,sample_raw_data")
      .eq("upload_batch_id", uploadBatchId)
      .order("occurrence_count", { ascending: false })
      .limit(50)
  ]);
  if (sheetsResult.error) throw sheetsResult.error;
  if (recordsResult.error) throw recordsResult.error;
  if (summariesResult.error) throw summariesResult.error;

  const profile = buildUploadStructureProfile({
    upload: uploadResult.data as UploadProfileInput,
    sheets: (sheetsResult.data ?? []) as SheetProfileInput[],
    records: (recordsResult.data ?? []) as RecordProfileInput[],
    errorSummaries: (summariesResult.data ?? []) as ErrorSummaryInput[]
  });

  const upsertResult = await supabase
    .from("file_schema_profiles")
    .upsert({
      upload_batch_id: profile.uploadBatchId,
      file_type: profile.fileType,
      sheet_count: profile.sheetCount,
      row_count: profile.rowCount,
      column_count: profile.columnCount,
      columns_json: profile.columns,
      detected_template: profile.detectedTemplate,
      detected_mappings_json: profile.detectedMappings,
      data_quality_summary_json: profile.dataQualitySummary,
      warnings_json: profile.warnings,
      confidence_score: profile.confidenceScore
    }, { onConflict: "upload_batch_id" })
    .select(PROFILE_SELECT)
    .single();
  if (upsertResult.error) throw upsertResult.error;
  return profileFromDb(upsertResult.data as unknown as JsonRecord);
}

export function formatDetectedFields(profile: UploadStructureProfile) {
  const fields: Array<[StructureField, string]> = [
    ["mpn", "MPN"],
    ["proveedor", "proveedor"],
    ["fabricante", "fabricante"],
    ["cliente", "cliente"],
    ["cantidad", "cantidad"],
    ["precio", "precio"],
    ["costo", "costo"],
    ["fecha", "fecha"],
    ["estado", "estado"]
  ];
  return fields
    .map(([field, label]) => `${label} como ${profile.detectedMappings[field] ?? "no detectado"}`)
    .join(", ");
}

export function formatColumnsAnswer(profile: UploadStructureProfile) {
  if (!profile.columns.length) return "El archivo está importado, pero todavía falta generar el perfil estructural de columnas.";
  const columnText = profile.columns
    .filter((column) => column.source !== "normalized_data" || !profile.columns.some((item) => item.source !== "normalized_data" && item.mappedField === column.mappedField))
    .slice(0, 30)
    .map((column) => `${column.name} como ${column.meaning}`)
    .join(", ");
  const extra = profile.columns.length > 30 ? ` Hay ${profile.columns.length - 30} columnas adicionales no mostradas.` : "";
  return `El último archivo parece de ${profile.detectedTemplate}. Detecté estas columnas: ${columnText}.${extra}`;
}
