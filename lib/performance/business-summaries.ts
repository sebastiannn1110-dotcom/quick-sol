import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectOpportunitySignals } from "@/lib/opportunities/opportunities";
import {
  buildStockNeedsResult,
  type StockNeedsImportJob,
  type StockNeedsProfile,
  type StockNeedsRecord
} from "@/lib/stock-needs/stock-needs";

export const BUSINESS_SUMMARY_SOURCE_CHUNK_SIZE = 500;
export const BUSINESS_SUMMARY_MAX_STAGE_BYTES = 8 * 1024 * 1024;

export type BusinessSummaryRebuildClaim = {
  upload_batch_id: string;
  target_data_version: number;
  rebuild_id: string;
  rebuild_generation: number;
  fence_token: number;
  lease_expires_at: string;
  evaluation_at: string;
};

type BusinessSummarySourceRow = {
  record_id: string;
  record_created_at: string;
  record_payload: StockNeedsRecord;
};

export type BusinessMpnSummaryRow = {
  normalized_mpn: string;
  display_mpn: string;
  customer_name: string | null;
  supplier_name: string | null;
  manufacturer_name: string | null;
  manufacturer_names: string[];
  demand_qty: number | null;
  stock_qty: number | null;
  excess_qty: number | null;
  received_qty: number | null;
  stock_required_qty: number | null;
  stock_available_qty: number | null;
  stock_customer_name: string | null;
  stock_supplier_name: string | null;
  stock_manufacturer_name: string | null;
  required_date: string | null;
  lead_time: string | null;
  unit_of_measure: string | null;
  approved_part_signal: boolean;
  received_signal: boolean;
  source_record_count: number;
  warnings: string[];
};

export type BusinessOpportunityEntityRow = {
  source_record_id: string;
  entity_kind: "demand" | "stock" | "excess" | "supplier_offer" | "historical";
  entity_key: string;
  normalized_mpn: string;
  display_mpn: string;
  manufacturer_name: string | null;
  customer_name: string | null;
  supplier_name: string | null;
  required_qty: number | null;
  available_qty: number | null;
  excess_qty: number | null;
  required_date: string | null;
  unit_of_measure: string | null;
  lead_time_weeks: number | null;
  moq: number | null;
  spq: number | null;
  date_code: string | null;
  coo: string | null;
  condition: string | null;
  expires_at: string | null;
  is_active_demand: boolean;
  is_live_supply: boolean;
  warnings: string[];
};

function sourceRecord(record: StockNeedsRecord) {
  return record as unknown as Record<string, unknown>;
}

function objectValue(record: StockNeedsRecord, aliases: string[]) {
  const source = sourceRecord(record);
  const containers = [source.normalized_data, source.raw_data, source]
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
  for (const container of containers) {
    for (const alias of aliases) {
      const value = container[alias];
      if (value !== null && value !== undefined && String(value).trim()) return value;
    }
  }
  return null;
}

function parsedEntityDate(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{5}(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : null;
  const parsed = numeric !== null && numeric > 25569 && numeric < 80000
    ? new Date((numeric - 25569) * 86_400_000)
    : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) return null;
  const year = parsed.getUTCFullYear();
  return year >= 1900 && year <= 9999 ? parsed : null;
}

function entityDate(record: StockNeedsRecord) {
  const value = objectValue(record, ["required_date", "Required Date", "RequiredDate", "Need Date", "Demand Date", "earliest_shipping_date"]);
  if (value === null) return null;
  return parsedEntityDate(value)?.toISOString().slice(0, 10) ?? null;
}

function entityTimestamp(record: StockNeedsRecord, aliases: string[]) {
  const value = objectValue(record, aliases);
  if (value === null) return null;
  return parsedEntityDate(value)?.toISOString() ?? null;
}

function entityText(record: StockNeedsRecord, aliases: string[], max = 40) {
  const value = objectValue(record, aliases);
  const text = value === null ? "" : String(value).normalize("NFKC").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, max) : null;
}

function entityNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function buildBusinessOpportunityEntityRows(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
  evaluationAt?: string | Date;
}): BusinessOpportunityEntityRow[] {
  const requestedEvaluationAt = input.evaluationAt instanceof Date
    ? input.evaluationAt.getTime()
    : input.evaluationAt
      ? new Date(input.evaluationAt).getTime()
      : Date.now();
  if (!Number.isFinite(requestedEvaluationAt)) {
    throw new Error("BUSINESS_SUMMARY_EVALUATION_TIME_INVALID");
  }
  const recordsById = new Map(input.records.map((record) => [String(record.id ?? ""), record]));
  const rows: BusinessOpportunityEntityRow[] = [];
  for (const signal of detectOpportunitySignals(input)) {
    const sourceRecordId = String(signal.id ?? "");
    const record = recordsById.get(sourceRecordId);
    if (!sourceRecordId || !record) continue;
    const requiredDate = entityDate(record);
    const unitOfMeasure = entityText(record, ["unit_of_measure", "UOM", "Unit", "Unit of Measure"]);
    const leadTimeWeeks = entityNumber(objectValue(record, ["lead_time_weeks", "Lead Time Weeks", "LeadTime", "Lead Time"]));
    const moq = entityNumber(objectValue(record, ["moq", "MOQ", "Minimum Order Quantity"]));
    const spq = entityNumber(objectValue(record, ["spq", "SPQ", "Standard Pack Quantity", "Pack Qty"]));
    const dateCode = entityText(record, ["date_code", "Date Code YYWW", "Date Code", "DC"]);
    const coo = entityText(record, ["coo", "COO", "Country of Origin", "COO Non China"]);
    const condition = entityText(record, ["condition", "Condition", "Packing"]);
    const template = String(signal.sourceUpload.detectedTemplate ?? "").toLowerCase();
    const explicitSupplierOffer = /supplier.?offer|vendor.?offer|quote.?received|cotizaci[oó]n.?proveedor/.test(template);
    const offerExpiry = entityTimestamp(record, ["expires_at", "Valid Until", "Valid Through", "Expiry Date", "Expiration Date", "Quote Validity"]);
    const offerQty = entityNumber(objectValue(record, ["Offer Qty", "Available Qty", "Max QTY", "Quantity", "QTY", "qty"]));
    const common = {
      source_record_id: sourceRecordId,
      normalized_mpn: signal.normalizedMpn,
      display_mpn: signal.mpn,
      manufacturer_name: signal.manufacturerName,
      customer_name: signal.customerName,
      supplier_name: signal.supplierName,
      required_date: requiredDate,
      unit_of_measure: unitOfMeasure,
      lead_time_weeks: leadTimeWeeks,
      moq,
      spq,
      date_code: dateCode,
      coo,
      condition,
      expires_at: null,
      warnings: signal.dataQualityFlags
    };
    if (!explicitSupplierOffer && signal.demandSignal && entityNumber(signal.requiredQty) !== null) rows.push({
      ...common,
      entity_kind: "demand",
      entity_key: `${sourceRecordId}:demand`,
      required_qty: entityNumber(signal.requiredQty),
      available_qty: null,
      excess_qty: null,
      is_active_demand: requiredDate !== null,
      is_live_supply: true
    });
    if (!explicitSupplierOffer && signal.stockSignal && entityNumber(signal.stockQty) !== null) rows.push({
      ...common,
      entity_kind: "stock",
      entity_key: `${sourceRecordId}:stock`,
      required_qty: null,
      available_qty: entityNumber(signal.stockQty),
      excess_qty: null,
      is_active_demand: true,
      is_live_supply: true
    });
    if (!explicitSupplierOffer && signal.excessSignal && entityNumber(signal.excessQty) !== null) rows.push({
      ...common,
      entity_kind: "excess",
      entity_key: `${sourceRecordId}:excess`,
      required_qty: null,
      available_qty: entityNumber(signal.excessQty),
      excess_qty: entityNumber(signal.excessQty),
      is_active_demand: true,
      is_live_supply: true
    });
    if (explicitSupplierOffer && offerQty !== null && offerExpiry) rows.push({
      ...common,
      entity_kind: "supplier_offer",
      entity_key: `${sourceRecordId}:supplier_offer`,
      required_qty: null,
      available_qty: offerQty,
      excess_qty: null,
      expires_at: offerExpiry,
      is_active_demand: true,
      is_live_supply: new Date(offerExpiry).getTime() > requestedEvaluationAt
    });
    if (signal.receivedSignal && entityNumber(signal.receivedQty) !== null) rows.push({
      ...common,
      entity_kind: "historical",
      entity_key: `${sourceRecordId}:historical`,
      required_qty: null,
      available_qty: entityNumber(signal.receivedQty),
      excess_qty: null,
      is_active_demand: false,
      is_live_supply: false,
      warnings: Array.from(new Set([...signal.dataQualityFlags, "historical_not_current_stock"]))
    });
  }
  return rows;
}

export function buildBusinessMpnSummaryRows(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}): BusinessMpnSummaryRow[] {
  const stock = buildStockNeedsResult({ ...input, includeAllItems: true });
  const stockByMpn = new Map(stock.items.map((item) => [item.mpn, item]));
  const grouped = new Map<string, BusinessMpnSummaryRow>();
  const manufacturersByMpn = new Map<string, Set<string>>();

  for (const signal of detectOpportunitySignals(input)) {
    const row = grouped.get(signal.normalizedMpn) ?? {
      normalized_mpn: signal.normalizedMpn,
      display_mpn: signal.mpn,
      customer_name: null,
      supplier_name: null,
      manufacturer_name: null,
      manufacturer_names: [],
      demand_qty: null,
      stock_qty: null,
      excess_qty: null,
      received_qty: null,
      stock_required_qty: null,
      stock_available_qty: null,
      stock_customer_name: null,
      stock_supplier_name: null,
      stock_manufacturer_name: null,
      required_date: null,
      lead_time: null,
      unit_of_measure: null,
      approved_part_signal: false,
      received_signal: false,
      source_record_count: 0,
      warnings: []
    };
    row.customer_name ??= signal.customerName;
    row.supplier_name ??= signal.supplierName;
    row.manufacturer_name ??= signal.manufacturerName;
    const manufacturers = manufacturersByMpn.get(signal.normalizedMpn) ?? new Set<string>();
    if (signal.manufacturerName) manufacturers.add(signal.manufacturerName);
    manufacturersByMpn.set(signal.normalizedMpn, manufacturers);
    if (signal.demandSignal && signal.requiredQty !== null) row.demand_qty = (row.demand_qty ?? 0) + signal.requiredQty;
    if (signal.stockSignal && signal.stockQty !== null) row.stock_qty = (row.stock_qty ?? 0) + signal.stockQty;
    if (signal.excessSignal && signal.excessQty !== null) row.excess_qty = (row.excess_qty ?? 0) + signal.excessQty;
    if (signal.receivedQty !== null) row.received_qty = (row.received_qty ?? 0) + signal.receivedQty;
    row.approved_part_signal ||= signal.approvedPartSignal;
    row.received_signal ||= signal.receivedSignal;
    row.source_record_count += 1;
    for (const warning of signal.dataQualityFlags) {
      if (!row.warnings.includes(warning)) row.warnings.push(warning);
    }
    grouped.set(signal.normalizedMpn, row);
  }

  for (const row of grouped.values()) {
    row.manufacturer_names = Array.from(manufacturersByMpn.get(row.normalized_mpn) ?? []);
    const stockItem = stockByMpn.get(row.normalized_mpn);
    row.stock_required_qty = stockItem?.requiredQty ?? null;
    row.stock_available_qty = stockItem?.stockQty ?? null;
    row.stock_customer_name = stockItem?.customerName ?? null;
    row.stock_supplier_name = stockItem?.supplierName ?? null;
    row.stock_manufacturer_name = stockItem?.manufacturerName ?? null;
    row.required_date = stockItem?.requiredDate ?? null;
    row.lead_time = stockItem?.leadTime ?? null;
    if (row.manufacturer_names.length > 1 && !row.warnings.includes("manufacturer_context_mixed")) {
      row.warnings.push("manufacturer_context_mixed");
    }
  }
  for (const stockItem of stock.items) {
    if (grouped.has(stockItem.mpn)) continue;
    grouped.set(stockItem.mpn, {
      normalized_mpn: stockItem.mpn, display_mpn: stockItem.mpn,
      customer_name: null, supplier_name: null, manufacturer_name: null, manufacturer_names: [],
      demand_qty: null, stock_qty: null, excess_qty: null, received_qty: null,
      stock_required_qty: stockItem.requiredQty, stock_available_qty: stockItem.stockQty,
      stock_customer_name: stockItem.customerName, stock_supplier_name: stockItem.supplierName,
      stock_manufacturer_name: stockItem.manufacturerName, required_date: stockItem.requiredDate,
      lead_time: stockItem.leadTime, unit_of_measure: null, approved_part_signal: false,
      received_signal: false, source_record_count: 0, warnings: stockItem.warnings
    });
  }
  return Array.from(grouped.values()).sort((left, right) => left.normalized_mpn.localeCompare(right.normalized_mpn));
}

function rpcErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "SUMMARY_REBUILD_FAILED";
  const value = "code" in error ? String(error.code ?? "") : "";
  if (value) return value;
  const message = "message" in error ? String(error.message ?? "") : "";
  return message.match(/[A-Z][A-Z0-9_]{2,79}/)?.[0] ?? "SUMMARY_REBUILD_FAILED";
}

async function heartbeatBusinessSummaryRebuild(
  supabase: SupabaseClient,
  claim: BusinessSummaryRebuildClaim,
  workerId: string,
  leaseSeconds: number
) {
  const heartbeat = await supabase.rpc("heartbeat_business_summary_rebuild_v2", {
    input_upload_batch_id: claim.upload_batch_id,
    input_worker_id: workerId,
    input_rebuild_id: claim.rebuild_id,
    input_generation: claim.rebuild_generation,
    input_fence_token: claim.fence_token,
    input_lease_seconds: leaseSeconds
  });
  if (heartbeat.error) throw heartbeat.error;
  return String(heartbeat.data ?? "");
}

export function isBusinessSummaryFencedError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code ?? "") : "";
  const message = "message" in error ? String(error.message ?? "") : "";
  return code === "55000" && /SUMMARY_(?:WORKER|BUILDER)_FENCED/.test(message);
}

export function isRetryableBusinessSummaryError(error: unknown) {
  if (isBusinessSummaryFencedError(error)) return false;
  if (!error || typeof error !== "object") return true;
  const code = "code" in error ? String(error.code ?? "") : "";
  return !["22023", "22P02", "23502", "23503", "23505", "23514", "42501"].includes(code);
}

export function safeBusinessSummaryErrorCode(error: unknown) {
  return rpcErrorCode(error).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "SUMMARY_REBUILD_FAILED";
}

export async function rebuildBusinessUploadSummary(
  supabase: SupabaseClient,
  claim: BusinessSummaryRebuildClaim,
  workerId: string,
  options: { chunkSize?: number; leaseSeconds?: number } = {}
) {
  const chunkSize = Math.min(
    Math.max(Math.floor(options.chunkSize ?? BUSINESS_SUMMARY_SOURCE_CHUNK_SIZE), 1),
    BUSINESS_SUMMARY_SOURCE_CHUNK_SIZE
  );
  const leaseSeconds = Math.min(Math.max(Math.floor(options.leaseSeconds ?? 120), 30), 900);
  const [uploadResult, profilesResult, jobsResult] = await Promise.all([
    supabase
      .from("upload_batches")
      .select("id,original_file_name,detected_category,status,created_at")
      .eq("id", claim.upload_batch_id)
      .single(),
    supabase
      .from("file_schema_profiles")
      .select("upload_batch_id,detected_template,detected_mappings_json,column_count")
      .eq("upload_batch_id", claim.upload_batch_id),
    supabase
      .from("import_jobs")
      .select("upload_batch_id,status")
      .eq("upload_batch_id", claim.upload_batch_id)
      .order("updated_at", { ascending: false })
      .limit(1)
  ]);
  if (uploadResult.error) throw uploadResult.error;
  if (profilesResult.error) throw profilesResult.error;
  if (jobsResult.error) throw jobsResult.error;

  const profiles = (profilesResult.data ?? []) as StockNeedsProfile[];
  const importJobs = (jobsResult.data ?? []) as StockNeedsImportJob[];
  const sourceFingerprint = createHash("sha256");
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  let chunkSequence = 0;
  let sourceRecords = 0;
  let summaryPartials = 0;
  let opportunityEntities = 0;
  let peakChunkRows = 0;
  let peakPayloadBytes = 0;

  while (true) {
    const pageResult = await supabase.rpc("read_business_summary_source_chunk_v2", {
      input_upload_batch_id: claim.upload_batch_id,
      input_worker_id: workerId,
      input_rebuild_id: claim.rebuild_id,
      input_generation: claim.rebuild_generation,
      input_fence_token: claim.fence_token,
      input_after_created_at: cursorCreatedAt,
      input_after_id: cursorId,
      input_limit: chunkSize
    });
    if (pageResult.error) throw pageResult.error;
    const sourcePage = (pageResult.data ?? []) as unknown as BusinessSummarySourceRow[];
    if (!sourcePage.length) break;
    if (sourcePage.length > chunkSize) throw new Error("SUMMARY_SOURCE_CHUNK_LIMIT_BROKEN");

    const records = sourcePage.map((source) => ({
      ...(source.record_payload as StockNeedsRecord),
      id: source.record_id,
      created_at: source.record_created_at,
      upload_batches: uploadResult.data
    })) as StockNeedsRecord[];
    // Stage one partial per source row. PostgreSQL can then replay float8
    // accumulation in the exact global newest-first order; pre-summing each
    // chunk would change IEEE-754 results at the chunk boundaries.
    const summaryRows = records.flatMap((record, sourceOrdinal) =>
      buildBusinessMpnSummaryRows({ records: [record], profiles, importJobs })
        .map((row) => ({ ...row, source_ordinal: sourceOrdinal }))
    );
    const entityRows = buildBusinessOpportunityEntityRows({
      records,
      profiles,
      importJobs,
      evaluationAt: claim.evaluation_at
    });
    const payloadBytes = Buffer.byteLength(JSON.stringify({ summaryRows, entityRows }), "utf8");
    if (payloadBytes > BUSINESS_SUMMARY_MAX_STAGE_BYTES) {
      throw new Error("SUMMARY_STAGE_LIMIT_EXCEEDED");
    }
    const last = sourcePage.at(-1);
    if (!last?.record_id || !last.record_created_at) {
      throw new Error("SUMMARY_SOURCE_CURSOR_MISSING");
    }
    if (cursorCreatedAt === last.record_created_at && cursorId === last.record_id) {
      throw new Error("SUMMARY_SOURCE_CURSOR_STALLED");
    }
    for (const source of sourcePage) {
      sourceFingerprint.update(`${source.record_created_at}:${source.record_id}\n`, "utf8");
    }

    // Computation is bounded to one page. Renew immediately before the write so
    // a slow page never publishes under an expired lease.
    await heartbeatBusinessSummaryRebuild(supabase, claim, workerId, leaseSeconds);
    const stage = await supabase.rpc("stage_business_summary_chunk_v2", {
      input_upload_batch_id: claim.upload_batch_id,
      input_worker_id: workerId,
      input_rebuild_id: claim.rebuild_id,
      input_generation: claim.rebuild_generation,
      input_fence_token: claim.fence_token,
      input_chunk_sequence: chunkSequence,
      input_source_rows: sourcePage.length,
      input_summary_rows: summaryRows,
      input_entity_rows: entityRows,
      input_payload_bytes: payloadBytes,
      input_cursor_created_at: last.record_created_at,
      input_cursor_id: last.record_id
    });
    if (stage.error) throw stage.error;

    sourceRecords += sourcePage.length;
    summaryPartials += summaryRows.length;
    opportunityEntities += entityRows.length;
    peakChunkRows = Math.max(peakChunkRows, sourcePage.length);
    peakPayloadBytes = Math.max(peakPayloadBytes, payloadBytes);
    cursorCreatedAt = last.record_created_at;
    cursorId = last.record_id;
    chunkSequence += 1;
  }

  await heartbeatBusinessSummaryRebuild(supabase, claim, workerId, leaseSeconds);
  const fingerprint = sourceFingerprint.digest("hex");
  const publish = await supabase.rpc("publish_business_summary_rebuild_v2", {
    input_upload_batch_id: claim.upload_batch_id,
    input_worker_id: workerId,
    input_rebuild_id: claim.rebuild_id,
    input_generation: claim.rebuild_generation,
    input_fence_token: claim.fence_token,
    input_expected_source_rows: sourceRecords,
    input_source_fingerprint: fingerprint
  });
  if (publish.error) throw publish.error;

  return {
    rebuilt: true,
    version: Number(claim.target_data_version),
    sourceRecords,
    summaryPartials,
    opportunityEntities,
    chunks: chunkSequence,
    peakChunkRows,
    peakPayloadBytes,
    sourceFingerprint: fingerprint,
    publish: publish.data
  };
}
