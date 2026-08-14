import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import type { Language } from "@/lib/i18n";
import {
  cleanUuid,
  loadOwnedOpportunityJob,
  OPPORTUNITY_RESULT_SELECT,
  resultDatabaseRow
} from "@/lib/opportunity-finder/api";
import {
  OpportunityExportTooLargeError,
  OpportunityStreamingExportWriter,
  opportunityCsvHeaderLine,
  opportunityCsvResultLine
} from "@/lib/opportunity-finder/export";
import { opportunityFinderPipelineVersionFromKey } from "@/lib/opportunity-finder/pipeline";
import type {
  OpportunityAllocationTrace,
  OpportunityRejectedRow,
  OpportunityResult,
  OpportunitySourceTrace,
  PossibleOpportunityMatch
} from "@/lib/opportunity-finder/types";
import {
  canViewCosts,
  canViewGp,
  canViewSensitivePricing
} from "@/lib/security/permissions";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export {
  buildOpportunityCsv,
  buildOpportunityExportWorkbook,
  classifyOpportunityForExport,
  exportHeaders,
  exportRow,
  OPPORTUNITY_EXPORT_SHEET_NAMES,
  safeSpreadsheetValue
} from "@/lib/opportunity-finder/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;
const SERVICE_QUERY_PAGE_SIZE = 500;
const EXPORT_RATE_LIMIT = 10;
const EXPORT_RATE_WINDOW_SECONDS = 60 * 60;

const OPPORTUNITY_EXPORT_RESULT_SELECT = OPPORTUNITY_RESULT_SELECT;
const OPPORTUNITY_EXPORT_LEGACY_RESULT_SELECT = [
  "id",
  "job_id",
  "opportunity_type",
  "exact_match",
  "usable_availability_match",
  "exact_quantity_match",
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

function languageFromRequest(request: Request): Language {
  const value = new URL(request.url).searchParams.get("lang");
  return value === "en" || value === "zh" ? value : "es";
}

function isMissingOptionalSchema(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? "");
  const message = String(record.message ?? "");
  return code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    /schema cache|does not exist|could not find/i.test(message);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function objectValue(value: unknown) {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function arrayValue<T>(value: unknown) {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function exportResultDatabaseRow(row: Record<string, unknown>, pipelineVersion: string | null) {
  return {
    ...resultDatabaseRow(row, pipelineVersion),
    demandEventKey: optionalString(row.demand_event_key),
    demandMpnOriginal: optionalString(row.demand_mpn_original),
    supplyMpnOriginal: optionalString(row.supply_mpn_original),
    manufacturerCanonical: optionalString(row.manufacturer_canonical),
    matchTier: optionalString(row.match_tier) as OpportunityResult["matchTier"],
    confidence: optionalString(row.confidence) as OpportunityResult["confidence"],
    matchExplanation: optionalString(row.match_explanation) ?? undefined,
    reviewStatus: optionalString(row.review_status) as OpportunityResult["reviewStatus"],
    remainingQty: optionalNumber(row.remaining_qty),
    moq: optionalNumber(row.moq),
    spq: optionalNumber(row.spq),
    dateCode: optionalString(row.date_code),
    coo: optionalString(row.coo),
    leadTimeWeeks: optionalNumber(row.lead_time_weeks),
    condition: optionalString(row.condition),
    expiresAt: optionalString(row.expires_at),
    demandTraces: arrayValue<OpportunitySourceTrace>(row.demand_traces),
    supplyTraces: arrayValue<OpportunitySourceTrace>(row.supply_traces),
    allocations: arrayValue<OpportunityAllocationTrace>(row.allocations_trace)
  } as OpportunityResult;
}

async function loadResultPage(
  supabase: SupabaseClient,
  jobId: string,
  resultId: string | null,
  select: string,
  offset: number
) {
  let query = supabase
    .from("opportunity_finder_results")
    .select(select)
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (resultId) query = query.eq("id", resultId);
  const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
  return {
    rows: (data ?? []) as unknown as Record<string, unknown>[],
    error
  };
}

async function loadFirstResultPage(
  supabase: SupabaseClient,
  jobId: string,
  resultId: string | null,
  pipelineVersion: string | null
) {
  let select = OPPORTUNITY_EXPORT_RESULT_SELECT;
  let loaded = await loadResultPage(supabase, jobId, resultId, select, 0);
  if (loaded.error && isMissingOptionalSchema(loaded.error)) {
    select = OPPORTUNITY_EXPORT_LEGACY_RESULT_SELECT;
    loaded = await loadResultPage(supabase, jobId, resultId, select, 0);
  }
  return {
    results: loaded.rows.map((row) => exportResultDatabaseRow(row, pipelineVersion)),
    error: loaded.error,
    select
  };
}

function possibleMatchDatabaseRow(row: Record<string, unknown>): PossibleOpportunityMatch {
  return {
    id: optionalString(row.id) ?? undefined,
    jobId: String(row.job_id ?? ""),
    demandDisplayMpn: String(row.demand_display_mpn ?? ""),
    supplyDisplayMpn: String(row.supply_display_mpn ?? ""),
    demandNormalizedMpn: String(row.demand_normalized_mpn ?? ""),
    supplyNormalizedMpn: String(row.supply_normalized_mpn ?? ""),
    reviewKey: String(row.review_key ?? ""),
    demandFileId: String(row.demand_file_id ?? ""),
    supplyFileId: String(row.supply_file_id ?? ""),
    reasonCode: "symbol_variant",
    matchTier: optionalString(row.match_tier) === "search_mpn_mfg" ? "search_mpn_mfg" : undefined,
    confidence: optionalString(row.confidence) === "review" ? "review" : undefined,
    reviewStatus: optionalString(row.review_status) as PossibleOpportunityMatch["reviewStatus"],
    manufacturerCompatible: typeof row.manufacturer_compatible === "boolean"
      ? row.manufacturer_compatible
      : undefined,
    demandTrace: objectValue(row.demand_trace) as unknown as OpportunitySourceTrace | undefined,
    supplyTrace: objectValue(row.supply_trace) as unknown as OpportunitySourceTrace | undefined,
    ...({ matchExplanation: optionalString(row.explanation) } as Record<string, unknown>)
  } as PossibleOpportunityMatch;
}

function rejectedRowDatabaseRow(row: Record<string, unknown>): OpportunityRejectedRow {
  return {
    jobId: String(row.job_id ?? ""),
    fileId: String(row.file_id ?? ""),
    side: row.side === "B" ? "B" : "A",
    fileName: String(row.file_name ?? ""),
    sheetName: String(row.sheet_name ?? ""),
    sourceRow: Number(row.source_row ?? 0),
    hidden: Boolean(row.source_row_hidden),
    reasonCode: String(row.reason_code ?? "unknown"),
    fieldName: optionalString(row.field_name),
    sourceColumn: optionalString(row.source_column),
    safeRawValue: optionalString(row.safe_raw_value)
  };
}

async function loadPossibleMatchPage(supabase: SupabaseClient, jobId: string, offset: number) {
  const { data, error } = await supabase
    .from("opportunity_finder_possible_matches")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  return {
    matches: ((data ?? []) as unknown as Record<string, unknown>[]).map(possibleMatchDatabaseRow),
    error
  };
}

async function loadRejectedRowPage(supabase: SupabaseClient, jobId: string, offset: number) {
  const { data, error } = await supabase
    .from("opportunity_finder_rejected_rows")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error && isMissingOptionalSchema(error)) {
    return { rejectedRows: [] as OpportunityRejectedRow[], error: null, unavailable: true };
  }
  return {
    rejectedRows: ((data ?? []) as unknown as Record<string, unknown>[]).map(rejectedRowDatabaseRow),
    error,
    unavailable: false
  };
}

async function loadRestrictedResultFields(
  jobId: string,
  results: OpportunityResult[],
  permissions: { includePricing: boolean; includeFinancials: boolean }
) {
  if (!permissions.includePricing && !permissions.includeFinancials) {
    return { results, includePricing: false, includeFinancials: false };
  }
  const service = createSupabaseServiceRoleClient();
  const resultIds = results.flatMap((result) => result.id ? [result.id] : []);
  if (!service || !resultIds.length) {
    return { results, includePricing: false, includeFinancials: false };
  }

  const commercialByResult = new Map<string, Record<string, unknown>>();
  const financialByResult = new Map<string, Record<string, unknown>>();
  let pricingLoaded = !permissions.includePricing;
  let financialsLoaded = !permissions.includeFinancials;

  if (permissions.includePricing) {
    pricingLoaded = true;
    for (let offset = 0; offset < resultIds.length; offset += SERVICE_QUERY_PAGE_SIZE) {
      const ids = resultIds.slice(offset, offset + SERVICE_QUERY_PAGE_SIZE);
      const { data, error } = await service
        .from("opportunity_finder_result_commercials")
        .select("result_id,target_price,offer_price,target_gap_percent,currency,revenue_potential,pricing_quality")
        .eq("job_id", jobId)
        .in("result_id", ids);
      if (error) {
        pricingLoaded = false;
        commercialByResult.clear();
        break;
      }
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        commercialByResult.set(String(row.result_id), row);
      }
    }
  }

  if (permissions.includeFinancials) {
    financialsLoaded = true;
    for (let offset = 0; offset < resultIds.length; offset += SERVICE_QUERY_PAGE_SIZE) {
      const ids = resultIds.slice(offset, offset + SERVICE_QUERY_PAGE_SIZE);
      const { data, error } = await service
        .from("opportunity_finder_result_financials")
        .select("result_id,unit_cost,gross_profit,gross_margin_percent,cost_quality")
        .eq("job_id", jobId)
        .in("result_id", ids);
      if (error) {
        financialsLoaded = false;
        financialByResult.clear();
        break;
      }
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        financialByResult.set(String(row.result_id), row);
      }
    }
  }

  return {
    includePricing: permissions.includePricing && pricingLoaded,
    includeFinancials: permissions.includeFinancials && financialsLoaded,
    results: results.map((result) => {
      const commercial = result.id ? commercialByResult.get(result.id) : undefined;
      const financial = result.id ? financialByResult.get(result.id) : undefined;
      const usableCommercial = commercial && optionalString(commercial.pricing_quality) !== "invalid";
      const validCost = financial && optionalNumber(financial.unit_cost) !== null &&
        optionalString(financial.cost_quality) === "valid";
      return {
        ...result,
        ...(usableCommercial ? {
          targetPrice: optionalNumber(commercial.target_price),
          offerPrice: optionalNumber(commercial.offer_price),
          targetGapPercent: optionalNumber(commercial.target_gap_percent),
          currency: optionalString(commercial.currency),
          revenuePotential: optionalNumber(commercial.revenue_potential)
        } : {}),
        ...(validCost ? {
          unitCost: optionalNumber(financial.unit_cost),
          grossProfit: optionalNumber(financial.gross_profit),
          grossMarginPercent: optionalNumber(financial.gross_margin_percent)
        } : {})
      };
    })
  };
}

async function restrictedExportPermissions(
  supabase: SupabaseClient,
  jobId: string,
  userId: string,
  role: Parameters<typeof canViewSensitivePricing>[0]
) {
  const includePricing = canViewSensitivePricing(role);
  const includeFinancials = canViewCosts(role) && canViewGp(role);
  if (!includePricing && !includeFinancials) return { includePricing: false, includeFinancials: false };

  const { data: jobScope, error: jobScopeError } = await supabase
    .from("opportunity_finder_jobs")
    .select("tenant_id")
    .eq("id", jobId)
    .eq("created_by", userId)
    .maybeSingle();
  if (jobScopeError || !jobScope?.tenant_id) {
    return { includePricing: false, includeFinancials: false };
  }

  const { data: tenantAdmin, error: tenantAdminError } = await supabase.rpc(
    "is_opportunity_finder_tenant_admin",
    { target_tenant_id: jobScope.tenant_id }
  );
  if (tenantAdminError || tenantAdmin !== true) {
    return { includePricing: false, includeFinancials: false };
  }
  return { includePricing, includeFinancials };
}

class OpportunityExportDatabaseError extends Error {
  constructor(readonly causeValue: unknown) {
    super("Opportunity export database query failed.");
    this.name = "OpportunityExportDatabaseError";
  }
}

function assertExportActive(signal: AbortSignal) {
  if (!signal.aborted) return;
  const error = new Error("Opportunity export was cancelled by the client.");
  error.name = "AbortError";
  throw error;
}

async function makeTemporaryExport(extension: "csv" | "xlsx") {
  const directory = await mkdtemp(join(tmpdir(), "quik-opportunity-export-"));
  return { directory, filename: join(directory, `export.${extension}`) };
}

async function cleanupTemporaryExport(directory: string) {
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined);
}

function tempFileReadableStream(filename: string, directory: string) {
  const nodeStream = createReadStream(filename, { highWaterMark: 64 * 1024 });
  const reader = (Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>).getReader();
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = () => {
    if (!cleanupPromise) cleanupPromise = cleanupTemporaryExport(directory);
    return cleanupPromise;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!nodeStream.closed) await once(nodeStream, "close").catch(() => undefined);
          await cleanup();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        nodeStream.destroy();
        if (!nodeStream.closed) await once(nodeStream, "close").catch(() => undefined);
        await cleanup();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        nodeStream.destroy();
        if (!nodeStream.closed) await once(nodeStream, "close").catch(() => undefined);
        await cleanup();
      }
    }
  });
}

async function nextResultPage(input: {
  supabase: SupabaseClient;
  jobId: string;
  resultId: string | null;
  pipelineVersion: string | null;
  select: string;
  offset: number;
}) {
  const loaded = await loadResultPage(
    input.supabase,
    input.jobId,
    input.resultId,
    input.select,
    input.offset
  );
  if (loaded.error) throw new OpportunityExportDatabaseError(loaded.error);
  return loaded.rows.map((row) => exportResultDatabaseRow(row, input.pipelineVersion));
}

async function loadRestrictedPage(input: {
  jobId: string;
  results: OpportunityResult[];
  permissions: { includePricing: boolean; includeFinancials: boolean };
  expected?: { includePricing: boolean; includeFinancials: boolean };
}) {
  const restricted = await loadRestrictedResultFields(input.jobId, input.results, input.permissions);
  if (input.expected && (
    restricted.includePricing !== input.expected.includePricing ||
    restricted.includeFinancials !== input.expected.includeFinancials
  )) {
    throw new OpportunityExportDatabaseError("Restricted export fields became unavailable between pages.");
  }
  return restricted;
}

async function writeChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string
) {
  if (stream.write(chunk, "utf8")) return;
  await once(stream, "drain");
}

async function writeStreamingCsv(input: {
  filename: string;
  signal: AbortSignal;
  supabase: SupabaseClient;
  jobId: string;
  resultId: string | null;
  pipelineVersion: string | null;
  select: string;
  firstResults: OpportunityResult[];
  permissions: { includePricing: boolean; includeFinancials: boolean };
  language: Language;
}) {
  const output = createWriteStream(input.filename, { flags: "wx" });
  try {
    assertExportActive(input.signal);
    const firstRestricted = await loadRestrictedPage({
      jobId: input.jobId,
      results: input.firstResults,
      permissions: input.permissions
    });
    const effectivePermissions = {
      includePricing: firstRestricted.includePricing,
      includeFinancials: firstRestricted.includeFinancials
    };
    await writeChunk(output, `\uFEFF${opportunityCsvHeaderLine(input.language, effectivePermissions)}`);

    let page = firstRestricted.results;
    let rawPageLength = input.firstResults.length;
    let offset = 0;
    let resultCount = 0;
    while (true) {
      assertExportActive(input.signal);
      for (const result of page) {
        await writeChunk(output, `\r\n${opportunityCsvResultLine(result, input.language, effectivePermissions)}`);
        resultCount += 1;
      }
      if (input.resultId || rawPageLength < PAGE_SIZE) break;
      offset += rawPageLength;
      const next = await nextResultPage({ ...input, offset });
      rawPageLength = next.length;
      const restricted = await loadRestrictedPage({
        jobId: input.jobId,
        results: next,
        permissions: effectivePermissions,
        expected: effectivePermissions
      });
      page = restricted.results;
    }

    output.end();
    await once(output, "finish");
    if (!output.closed) await once(output, "close");
    return {
      resultCount,
      possibleMatchCount: 0,
      rejectedRowCount: 0,
      sheetCount: 0,
      ...effectivePermissions
    };
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function writeStreamingXlsx(input: {
  filename: string;
  signal: AbortSignal;
  supabase: SupabaseClient;
  jobId: string;
  resultId: string | null;
  pipelineVersion: string | null;
  select: string;
  firstResults: OpportunityResult[];
  permissions: { includePricing: boolean; includeFinancials: boolean };
  language: Language;
  summary?: Record<string, unknown>;
  comparisonMode?: "single_file" | "two_files";
  uploadedRole?: string | null;
  existingEntityCount?: number | null;
  datasetVersion?: string | null;
  analyzedAt?: string | null;
}) {
  const firstRestricted = await loadRestrictedPage({
    jobId: input.jobId,
    results: input.firstResults,
    permissions: input.permissions
  });
  const effectivePermissions = {
    includePricing: firstRestricted.includePricing,
    includeFinancials: firstRestricted.includeFinancials
  };
  const writer = new OpportunityStreamingExportWriter(input.language, {
    filename: input.filename,
    summary: input.summary,
    includePricing: effectivePermissions.includePricing,
    includeFinancials: effectivePermissions.includeFinancials,
    jobId: input.jobId,
    pipelineVersion: input.pipelineVersion,
    comparisonMode: input.comparisonMode,
    uploadedRole: input.uploadedRole,
    existingEntityCount: input.existingEntityCount,
    datasetVersion: input.datasetVersion,
    analyzedAt: input.analyzedAt
  });

  try {
    let page = firstRestricted.results;
    let rawPageLength = input.firstResults.length;
    let offset = 0;
    while (true) {
      assertExportActive(input.signal);
      writer.addResults(page);
      if (input.resultId || rawPageLength < PAGE_SIZE) break;
      offset += rawPageLength;
      const next = await nextResultPage({ ...input, offset });
      rawPageLength = next.length;
      const restricted = await loadRestrictedPage({
        jobId: input.jobId,
        results: next,
        permissions: effectivePermissions,
        expected: effectivePermissions
      });
      page = restricted.results;
    }

    if (!input.resultId) {
      let possibleOffset = 0;
      while (true) {
        assertExportActive(input.signal);
        const possible = await loadPossibleMatchPage(input.supabase, input.jobId, possibleOffset);
        if (possible.error) throw new OpportunityExportDatabaseError(possible.error);
        writer.addPossibleMatches(possible.matches);
        if (possible.matches.length < PAGE_SIZE) break;
        possibleOffset += possible.matches.length;
      }

      let rejectedOffset = 0;
      while (true) {
        assertExportActive(input.signal);
        const rejected = await loadRejectedRowPage(input.supabase, input.jobId, rejectedOffset);
        if (rejected.error) throw new OpportunityExportDatabaseError(rejected.error);
        if (rejected.unavailable) break;
        writer.addRejectedRows(rejected.rejectedRows);
        if (rejected.rejectedRows.length < PAGE_SIZE) break;
        rejectedOffset += rejected.rejectedRows.length;
      }
    }
    assertExportActive(input.signal);
    const counts = await writer.commit();
    return { ...counts, ...effectivePermissions };
  } catch (error) {
    writer.abort();
    throw error;
  }
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

  const url = new URL(request.url);
  const rawResultId = url.searchParams.get("resultId");
  const resultId = rawResultId === null ? null : cleanUuid(rawResultId);
  if (rawResultId !== null && !resultId) {
    return NextResponse.json({ errorCode: "INVALID_RESULT_ID" }, { status: 400 });
  }

  const rate = await checkPersistentRateLimit({
    action: "opportunity_finder_export",
    identifier: context.profile.id,
    limit: EXPORT_RATE_LIMIT,
    windowSeconds: EXPORT_RATE_WINDOW_SECONDS,
    blockSeconds: 60
  });
  if (!rate.allowed) {
    return NextResponse.json({ errorCode: "EXPORT_RATE_LIMITED" }, {
      status: 429,
      headers: {
        "Retry-After": `${Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))}`,
        "Cache-Control": "private, no-store"
      }
    });
  }

  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  if (!["completed", "completed_with_warnings"].includes(String(job.status ?? ""))) {
    return NextResponse.json({ errorCode: "JOB_NOT_COMPLETED" }, { status: 409 });
  }

  const pipelineVersion = typeof job.pipeline_version === "string"
    ? job.pipeline_version
    : opportunityFinderPipelineVersionFromKey(job.idempotency_key);
  const loadedResults = await loadFirstResultPage(context.supabase, jobId, resultId, pipelineVersion);
  if (loadedResults.error) {
    return NextResponse.json({ errorCode: "EXPORT_FAILED" }, { status: 500 });
  }
  if (resultId && loadedResults.results.length === 0) {
    return NextResponse.json({ errorCode: "RESULT_NOT_FOUND" }, { status: 404 });
  }

  const permissions = await restrictedExportPermissions(
    context.supabase,
    jobId,
    context.profile.id,
    context.profile.role
  );

  const format = url.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const language = languageFromRequest(request);
  const date = new Date().toISOString().slice(0, 10);
  const temporary = await makeTemporaryExport(format);
  try {
    const common = {
      filename: temporary.filename,
      signal: request.signal,
      supabase: context.supabase,
      jobId,
      resultId,
      pipelineVersion,
      select: loadedResults.select,
      firstResults: loadedResults.results,
      permissions,
      language
    };
    const counts = format === "csv"
      ? await writeStreamingCsv(common)
      : await writeStreamingXlsx({
        ...common,
        summary: resultId ? undefined : job.summary_json as Record<string, unknown> | undefined,
        comparisonMode: job.comparison_mode === "single_file" ? "single_file" : "two_files",
        uploadedRole: typeof job.uploaded_role === "string" ? job.uploaded_role : null,
        existingEntityCount: Number(job.existing_entity_count ?? 0),
        datasetVersion: typeof job.dataset_version === "string" ? job.dataset_version : null,
        analyzedAt: typeof job.completed_at === "string" ? job.completed_at : null
      });
    const file = await stat(temporary.filename);

    await logAuditEvent(
      context,
      "opportunity_finder_exported",
      "opportunity_finder_job",
      jobId,
      {
        format,
        scope: resultId ? "single_result" : "full_job",
        resultCount: counts.resultCount,
        possibleMatchCount: counts.possibleMatchCount,
        rejectedRowCount: counts.rejectedRowCount,
        sheetCount: counts.sheetCount,
        pricingIncluded: counts.includePricing,
        financialsIncluded: counts.includeFinancials,
        pipelineVersion,
        fileSizeBytes: file.size
      }
    );

    return new NextResponse(tempFileReadableStream(temporary.filename, temporary.directory), {
      headers: {
        "Content-Type": format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="opportunity-finder-${date}.${format}"`,
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    await cleanupTemporaryExport(temporary.directory);
    if (error instanceof OpportunityExportTooLargeError) {
      return NextResponse.json({
        errorCode: "EXPORT_TOO_LARGE",
        sheetName: error.sheetName
      }, { status: 413 });
    }
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json({ errorCode: "EXPORT_CANCELLED" }, { status: 499 });
    }
    return NextResponse.json({ errorCode: "EXPORT_FAILED" }, { status: 500 });
  }
}
