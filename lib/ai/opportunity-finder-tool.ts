import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OPPORTUNITY_FINDER_PIPELINE_VERSION,
  opportunityFinderPipelineVersionFromKey
} from "@/lib/opportunity-finder/pipeline";
import type {
  OpportunityActionCode,
  OpportunityReasonCode,
  OpportunityType,
  OpportunityWarningCode
} from "@/lib/opportunity-finder/types";

export type OpportunityFinderAiLanguage = "es" | "en" | "zh";

export type OpportunityFinderAiMode =
  | "general"
  | "full_sale"
  | "partial_sale"
  | "sourcing_needed"
  | "supply_without_demand"
  | "exactMpn"
  | "usableAvailability"
  | "exactQuantity"
  | "review"
  | "invalid_quantity";

export interface OpportunityFinderAiRequest {
  /** Authenticated Supabase client. RLS remains the final authorization boundary. */
  supabase: SupabaseClient;
  /** Authenticated profile/user identifier. Used as an additional ownership filter. */
  userId: string;
  /** Optional job to inspect. It must be owned, completed, and on the current pipeline. */
  jobId?: string | null;
  language?: OpportunityFinderAiLanguage;
  mode?: OpportunityFinderAiMode;
  offset?: number;
  limit?: number;
}

export interface OpportunityFinderAiItem {
  opportunityType: OpportunityType;
  displayMpn: string;
  requiredQty: number | null;
  availableQty: number | null;
  allocatedQty: number | null;
  shortageQty: number | null;
  coveragePercent: number | null;
  requiredDate: string | null;
  unitOfMeasure: string | null;
  exactMpnMatch: boolean;
  usableAvailabilityMatch: boolean;
  exactQuantityMatch: boolean;
  reasonCode: OpportunityReasonCode;
  actionCode: OpportunityActionCode;
  warnings: OpportunityWarningCode[];
}

export interface OpportunityFinderAiMetrics {
  analyzedMpns: number;
  exactMatches: number;
  usableAvailabilityMatches: number;
  exactQuantityMatches: number;
  fullSales: number;
  partialSales: number;
  sourcingNeeded: number;
  supplyWithoutDemand: number;
  reviewRequired: number;
  missingMpnRows: number;
  invalidQuantityRows: number;
  resultCount: number;
  warningCount: number;
}

export interface OpportunityFinderAiResult {
  ok: boolean;
  status: "ok" | "no_completed_job" | "job_not_found" | "incompatible_pipeline";
  source: "opportunity_finder_v2";
  pipelineVersion: string;
  mode: OpportunityFinderAiMode;
  summary: string;
  metrics: OpportunityFinderAiMetrics;
  items: OpportunityFinderAiItem[];
  page: {
    offset: number;
    limit: number;
    total: number;
    truncated: boolean;
  };
}

export interface OpportunityFinderAiItemDetailResult {
  ok: boolean;
  status:
    | "ok"
    | "item_not_found"
    | "no_completed_job"
    | "job_not_found"
    | "incompatible_pipeline";
  source: "opportunity_finder_v2";
  pipelineVersion: string;
  mpn: string;
  summary: string;
  item: OpportunityFinderAiItem | null;
}

const COMPLETED_STATUSES = ["completed", "completed_with_warnings"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_IN_TEXT_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const MAX_LIMIT = 50;
const MAX_OFFSET = 10_000;

const JOB_SELECT = [
  "id",
  "created_by",
  "idempotency_key",
  "status",
  "matched_mpns",
  "result_count",
  "warning_count",
  "missing_mpn_rows",
  "invalid_quantity_rows",
  "summary_json",
  "completed_at"
].join(",");

/**
 * Deliberately excludes UUIDs, file/sheet names, manufacturer, customer/supplier
 * context, and all financial fields.
 */
export const OPPORTUNITY_FINDER_AI_RESULT_SELECT = [
  "opportunity_type",
  "exact_match",
  "usable_availability_match",
  "exact_quantity_match",
  "display_mpn",
  "required_qty",
  "available_qty",
  "allocated_qty",
  "shortage_qty",
  "coverage_percent",
  "required_date",
  "unit_of_measure",
  "reason_code",
  "action_code",
  "warnings"
].join(",");

const EMPTY_METRICS: OpportunityFinderAiMetrics = {
  analyzedMpns: 0,
  exactMatches: 0,
  usableAvailabilityMatches: 0,
  exactQuantityMatches: 0,
  fullSales: 0,
  partialSales: 0,
  sourcingNeeded: 0,
  supplyWithoutDemand: 0,
  reviewRequired: 0,
  missingMpnRows: 0,
  invalidQuantityRows: 0,
  resultCount: 0,
  warningCount: 0
};

const COPY = {
  es: {
    noJob: "No hay una comparación completada compatible disponible. Ejecuta una nueva comparación en el Buscador de oportunidades.",
    notFound: "No se encontró una comparación completada autorizada con ese identificador.",
    incompatible: "La comparación solicitada pertenece a una versión anterior. Ejecuta una nueva comparación para obtener resultados compatibles.",
    result: (total: number, mode: string) =>
      `La comparación más reciente contiene ${total} resultado${total === 1 ? "" : "s"} para ${mode}.`
  },
  en: {
    noJob: "No compatible completed comparison is available. Run a new comparison in Opportunity Finder.",
    notFound: "No authorized completed comparison was found for that identifier.",
    incompatible: "The requested comparison belongs to an older version. Run a new comparison to obtain compatible results.",
    result: (total: number, mode: string) =>
      `The latest comparison contains ${total} result${total === 1 ? "" : "s"} for ${mode}.`
  },
  zh: {
    noJob: "没有可用的兼容已完成比较。请在商机查找器中运行新的比较。",
    notFound: "未找到与该标识符对应且已获授权的已完成比较。",
    incompatible: "所请求的比较属于旧版本。请运行新的比较以获取兼容结果。",
    result: (total: number, mode: string) => `最新比较中，“${mode}”共有 ${total} 条结果。`
  }
} as const;

const MODE_LABELS: Record<OpportunityFinderAiLanguage, Record<OpportunityFinderAiMode, string>> = {
  es: {
    general: "todas las oportunidades",
    full_sale: "ventas completas",
    partial_sale: "ventas parciales",
    sourcing_needed: "sourcing requerido",
    supply_without_demand: "inventario sin demanda",
    exactMpn: "MPN exacto",
    usableAvailability: "disponibilidad utilizable",
    exactQuantity: "cantidad exacta",
    review: "revisión requerida",
    invalid_quantity: "cantidades inválidas"
  },
  en: {
    general: "all opportunities",
    full_sale: "full sales",
    partial_sale: "partial sales",
    sourcing_needed: "sourcing required",
    supply_without_demand: "supply without demand",
    exactMpn: "exact MPN",
    usableAvailability: "usable availability",
    exactQuantity: "exact quantity",
    review: "review required",
    invalid_quantity: "invalid quantities"
  },
  zh: {
    general: "全部商机",
    full_sale: "完整销售",
    partial_sale: "部分销售",
    sourcing_needed: "需要采购",
    supply_without_demand: "无需求库存",
    exactMpn: "精确 MPN",
    usableAvailability: "可用库存",
    exactQuantity: "精确数量",
    review: "需要审核",
    invalid_quantity: "无效数量"
  }
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metric(summary: Record<string, unknown>, key: string, fallback: unknown = 0) {
  return safeNumber(summary[key] ?? fallback);
}

function metricsFromJob(job: Record<string, unknown>): OpportunityFinderAiMetrics {
  const summary = asRecord(job.summary_json);
  return {
    analyzedMpns: metric(summary, "analyzedMpns", job.matched_mpns),
    exactMatches: metric(summary, "exactMatches"),
    usableAvailabilityMatches: metric(summary, "usableAvailabilityMatches"),
    exactQuantityMatches: metric(summary, "exactQuantityMatches"),
    fullSales: metric(summary, "fullSales"),
    partialSales: metric(summary, "partialSales"),
    sourcingNeeded: metric(summary, "sourcingNeeded"),
    supplyWithoutDemand: metric(summary, "supplyWithoutDemand"),
    reviewRequired: metric(summary, "reviewRequired"),
    missingMpnRows: metric(summary, "missingMpnRows", job.missing_mpn_rows),
    invalidQuantityRows: metric(summary, "invalidQuantityRows", job.invalid_quantity_rows),
    resultCount: safeNumber(job.result_count),
    warningCount: safeNumber(job.warning_count)
  };
}

function safeWarnings(value: unknown): OpportunityWarningCode[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<OpportunityWarningCode>([
    "manufacturer_conflict",
    "missing_unit",
    "incompatible_unit",
    "invalid_required_quantity",
    "invalid_available_quantity",
    "negative_available_quantity",
    "multiple_manufacturers",
    "historical_not_current_stock"
  ]);
  return value.filter(
    (warning): warning is OpportunityWarningCode =>
      typeof warning === "string" && allowed.has(warning as OpportunityWarningCode)
  );
}

function safePublicText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(UUID_IN_TEXT_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeItem(row: Record<string, unknown>): OpportunityFinderAiItem {
  return {
    opportunityType: row.opportunity_type as OpportunityType,
    displayMpn: safePublicText(row.display_mpn, 160),
    requiredQty: nullableNumber(row.required_qty),
    availableQty: nullableNumber(row.available_qty),
    allocatedQty: nullableNumber(row.allocated_qty),
    shortageQty: nullableNumber(row.shortage_qty),
    coveragePercent: nullableNumber(row.coverage_percent),
    requiredDate: typeof row.required_date === "string" ? row.required_date.slice(0, 10) : null,
    unitOfMeasure: typeof row.unit_of_measure === "string"
      ? safePublicText(row.unit_of_measure, 24) || null
      : null,
    exactMpnMatch: Boolean(row.exact_match),
    usableAvailabilityMatch: Boolean(row.usable_availability_match),
    exactQuantityMatch: Boolean(row.exact_quantity_match),
    reasonCode: row.reason_code as OpportunityReasonCode,
    actionCode: row.action_code as OpportunityActionCode,
    warnings: safeWarnings(row.warnings)
  };
}

function emptyResult(
  status: Exclude<OpportunityFinderAiResult["status"], "ok">,
  language: OpportunityFinderAiLanguage,
  mode: OpportunityFinderAiMode
): OpportunityFinderAiResult {
  const copy = COPY[language];
  const summary =
    status === "incompatible_pipeline"
      ? copy.incompatible
      : status === "job_not_found"
        ? copy.notFound
        : copy.noJob;
  return {
    ok: false,
    status,
    source: "opportunity_finder_v2",
    pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
    mode,
    summary,
    metrics: { ...EMPTY_METRICS },
    items: [],
    page: { offset: 0, limit: 0, total: 0, truncated: false }
  };
}

async function loadJob(input: OpportunityFinderAiRequest) {
  const select = input.supabase.from("opportunity_finder_jobs").select(JOB_SELECT);
  if (input.jobId) {
    if (!UUID_PATTERN.test(input.jobId)) return { job: null, status: "job_not_found" as const };
    const { data, error } = await select
      .eq("id", input.jobId)
      .eq("created_by", input.userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { job: null, status: "job_not_found" as const };
    return { job: data as unknown as Record<string, unknown>, status: null };
  }

  const { data, error } = await select
    .eq("created_by", input.userId)
    .in("status", [...COMPLETED_STATUSES])
    .like("idempotency_key", `opportunity-finder:v${OPPORTUNITY_FINDER_PIPELINE_VERSION}:%`)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { job: data as unknown as Record<string, unknown>, status: null }
    : { job: null, status: "no_completed_job" as const };
}

interface OpportunityResultsQuery {
  eq(column: string, value: unknown): OpportunityResultsQuery;
  or(filters: string): OpportunityResultsQuery;
  order(column: string, options: { ascending: boolean }): OpportunityResultsQuery;
  range(from: number, to: number): PromiseLike<{
    data: unknown[] | null;
    error: unknown;
    count: number | null;
  }>;
}

function applyModeFilters(
  query: OpportunityResultsQuery,
  mode: OpportunityFinderAiMode
): OpportunityResultsQuery {
  switch (mode) {
    case "full_sale":
    case "partial_sale":
    case "sourcing_needed":
    case "supply_without_demand":
      return query.eq("opportunity_type", mode);
    case "exactMpn":
      return query.eq("exact_match", true);
    case "usableAvailability":
      return query.eq("usable_availability_match", true);
    case "exactQuantity":
      return query.eq("exact_quantity_match", true);
    case "review":
      return query.eq("opportunity_type", "review_required");
    case "invalid_quantity":
      return query.or(
        'reason_code.eq.invalid_quantity,warnings.cs.["invalid_required_quantity"],warnings.cs.["invalid_available_quantity"]'
      );
    default:
      return query;
  }
}

/**
 * Reads the persisted Opportunity Finder V2 result for the authenticated user.
 *
 * It intentionally does not execute the matcher, use a service-role client, read
 * staging rows, or perform any insert/update/upsert/delete/RPC operation.
 */
export async function getOpportunityFinderAiSummary(
  input: OpportunityFinderAiRequest
): Promise<OpportunityFinderAiResult> {
  const language = input.language ?? "es";
  const mode = input.mode ?? "general";
  const loaded = await loadJob(input);
  if (!loaded.job) return emptyResult(loaded.status, language, mode);

  const pipelineVersion = opportunityFinderPipelineVersionFromKey(loaded.job.idempotency_key);
  if (pipelineVersion !== OPPORTUNITY_FINDER_PIPELINE_VERSION) {
    return emptyResult("incompatible_pipeline", language, mode);
  }
  if (!COMPLETED_STATUSES.includes(loaded.job.status as typeof COMPLETED_STATUSES[number])) {
    return emptyResult("no_completed_job", language, mode);
  }

  const offset = Math.min(Math.max(Math.trunc(input.offset ?? 0), 0), MAX_OFFSET);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), MAX_LIMIT);
  let query = input.supabase
    .from("opportunity_finder_results")
    .select(OPPORTUNITY_FINDER_AI_RESULT_SELECT, { count: "exact" })
    .eq("job_id", String(loaded.job.id)) as unknown as OpportunityResultsQuery;
  query = applyModeFilters(query, mode);
  const { data, error, count } = await query
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const total = safeNumber(count);
  const items = ((data ?? []) as unknown as Record<string, unknown>[]).map(safeItem);
  return {
    ok: true,
    status: "ok",
    source: "opportunity_finder_v2",
    pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
    mode,
    summary: COPY[language].result(total, MODE_LABELS[language][mode]),
    metrics: metricsFromJob(loaded.job),
    items,
    page: {
      offset,
      limit,
      total,
      truncated: offset + limit < total
    }
  };
}

function normalizedMpn(value: string) {
  return value
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9._/-]/g, "")
    .slice(0, 80);
}

function itemDetailSummary(
  language: OpportunityFinderAiLanguage,
  mpn: string,
  item: OpportunityFinderAiItem | null
) {
  if (!item) {
    if (language === "en") return `No authorized Opportunity Finder result was found for MPN ${mpn}.`;
    if (language === "zh") return `未在商机查找器中找到 MPN ${mpn} 的授权结果。`;
    return `No se encontró un resultado autorizado del Buscador de oportunidades para el MPN ${mpn}.`;
  }
  const usable = item.usableAvailabilityMatch
    ? Math.max(item.availableQty ?? 0, 0)
    : 0;
  if (language === "en") {
    return `MPN ${mpn} has ${usable} units of usable availability in the current Opportunity Finder comparison.`;
  }
  if (language === "zh") {
    return `根据当前商机查找器比较，MPN ${mpn} 有 ${usable} 个单位的可用库存。`;
  }
  return `El MPN ${mpn} tiene ${usable} unidades de disponibilidad utilizable según la comparación actual del Buscador de oportunidades.`;
}

export async function getOpportunityFinderAiItemDetail(
  input: Pick<
    OpportunityFinderAiRequest,
    "supabase" | "userId" | "jobId" | "language"
  > & { mpn: string }
): Promise<OpportunityFinderAiItemDetailResult> {
  const language = input.language ?? "es";
  const mpn = normalizedMpn(input.mpn);
  const loaded = await loadJob({
    ...input,
    mode: "general"
  });
  if (!loaded.job) {
    const empty = emptyResult(loaded.status, language, "general");
    return {
      ok: false,
      status: loaded.status,
      source: "opportunity_finder_v2",
      pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
      mpn,
      summary: empty.summary,
      item: null
    };
  }

  const pipelineVersion = opportunityFinderPipelineVersionFromKey(loaded.job.idempotency_key);
  if (pipelineVersion !== OPPORTUNITY_FINDER_PIPELINE_VERSION) {
    const empty = emptyResult("incompatible_pipeline", language, "general");
    return {
      ok: false,
      status: "incompatible_pipeline",
      source: "opportunity_finder_v2",
      pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
      mpn,
      summary: empty.summary,
      item: null
    };
  }

  const { data, error } = await input.supabase
    .from("opportunity_finder_results")
    .select(OPPORTUNITY_FINDER_AI_RESULT_SELECT)
    .eq("job_id", String(loaded.job.id))
    .eq("normalized_mpn", mpn)
    .order("required_date", { ascending: true })
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as unknown as Record<string, unknown>[])[0];
  const item = row ? safeItem(row) : null;
  return {
    ok: Boolean(item),
    status: item ? "ok" : "item_not_found",
    source: "opportunity_finder_v2",
    pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
    mpn,
    summary: itemDetailSummary(language, mpn, item),
    item
  };
}
