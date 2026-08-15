import type { SupabaseClient } from "@supabase/supabase-js";
import { detectOpportunitySignals } from "@/lib/opportunities/opportunities";
import { BUSINESS_RECORD_UPLOAD_RELATION } from "@/lib/platform/query-columns";
import {
  buildStockNeedsResult,
  type StockNeedsImportJob,
  type StockNeedsProfile,
  type StockNeedsRecord
} from "@/lib/stock-needs/stock-needs";

const RECONCILIATION_PAGE_SIZE = 1000;
export const BUSINESS_SUMMARY_PUBLISH_CHUNK_SIZE = 500;
const RECORD_SELECT = `id,upload_batch_id,category,raw_data,normalized_data,has_errors,errors,mpn,mpn_quoted,customer,client,supplier,supplier_name,manufacturer,clean_mfg,qty,req_qty,on_hand,earliest_shipping_date,lead_time_weeks,created_at,${BUSINESS_RECORD_UPLOAD_RELATION}(original_file_name,detected_category,status,created_at)`;

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
}): BusinessOpportunityEntityRow[] {
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
      is_live_supply: new Date(offerExpiry).getTime() > Date.now()
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

export async function loadCompleteUploadRecords(
  supabase: SupabaseClient,
  uploadBatchId: string,
  pageSize = RECONCILIATION_PAGE_SIZE
) {
  const records: StockNeedsRecord[] = [];
  let cursorId: string | null = null;
  while (true) {
    let query = supabase
      .from("business_records")
      .select(RECORD_SELECT)
      .eq("upload_batch_id", uploadBatchId)
      .is("archived_at", null)
      .order("id", { ascending: false });
    if (cursorId) query = query.lt("id", cursorId);
    const { data, error } = await query.limit(pageSize);
    if (error) throw error;
    const page = (data ?? []) as unknown as StockNeedsRecord[];
    records.push(...page);
    if (page.length < pageSize) break;
    const last = page.at(-1) as (StockNeedsRecord & { created_at?: string; id?: string }) | undefined;
    if (!last?.id) throw new Error("BUSINESS_SUMMARY_KEYSET_CURSOR_MISSING");
    if (cursorId === last.id) {
      throw new Error("BUSINESS_SUMMARY_KEYSET_CURSOR_STALLED");
    }
    cursorId = last.id;
  }
  return records.sort((left, right) => {
    const leftRow = left as StockNeedsRecord & { created_at?: string; id?: string };
    const rightRow = right as StockNeedsRecord & { created_at?: string; id?: string };
    const createdOrder = String(rightRow.created_at ?? "").localeCompare(String(leftRow.created_at ?? ""));
    return createdOrder || String(rightRow.id ?? "").localeCompare(String(leftRow.id ?? ""));
  });
}

export function businessSummaryPublishChunks<T>(rows: T[], chunkSize = BUSINESS_SUMMARY_PUBLISH_CHUNK_SIZE) {
  if (!rows.length) return [] as T[][];
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += safeChunkSize) {
    chunks.push(rows.slice(index, index + safeChunkSize));
  }
  return chunks;
}

export async function publishBusinessOpportunityEntityRows(
  supabase: SupabaseClient,
  rows: Array<BusinessOpportunityEntityRow & {
    upload_batch_id: string;
    owner_id: string;
    data_version: number;
  }>,
  targetUploadBatchId: string,
  expectedDataVersion: number
) {
  for (const entityChunk of businessSummaryPublishChunks(rows)) {
    // Source versions are immutable. Ignoring an existing primary key makes a
    // retry resume cheaply after a partial publish instead of rewriting every
    // previously persisted entity through the locking RPC.
    const entityPublish = await supabase
      .from("business_opportunity_entities")
      .upsert(entityChunk, {
        onConflict: "upload_batch_id,data_version,source_record_id,entity_kind",
        ignoreDuplicates: true
      });
    if (entityPublish.error) throw entityPublish.error;
  }

  // The empty RPC is the atomic visibility boundary. It locks and rechecks the
  // source version, then advances opportunity_entity_version only after every
  // direct chunk has completed.
  const finalize = await supabase.rpc("replace_business_upload_opportunity_entities_v1", {
    target_upload_batch_id: targetUploadBatchId,
    expected_data_version: expectedDataVersion,
    entity_rows: []
  });
  if (finalize.error) throw finalize.error;
}

export async function rebuildBusinessUploadSummary(supabase: SupabaseClient, uploadBatchId: string) {
  const versionResult = await supabase
    .from("business_upload_versions")
    .select("owner_id,data_version,dirty")
    .eq("upload_batch_id", uploadBatchId)
    .single();
  if (versionResult.error) throw versionResult.error;
  if (!versionResult.data.dirty) return { rebuilt: false, version: Number(versionResult.data.data_version) };

  const [records, profilesResult, jobsResult] = await Promise.all([
    loadCompleteUploadRecords(supabase, uploadBatchId),
    supabase.from("file_schema_profiles").select("upload_batch_id,detected_template,detected_mappings_json,column_count").eq("upload_batch_id", uploadBatchId),
    supabase.from("import_jobs").select("upload_batch_id,status").eq("upload_batch_id", uploadBatchId).order("updated_at", { ascending: false }).limit(1)
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (jobsResult.error) throw jobsResult.error;
  const rows = buildBusinessMpnSummaryRows({
    records,
    profiles: (profilesResult.data ?? []) as StockNeedsProfile[],
    importJobs: (jobsResult.data ?? []) as StockNeedsImportJob[]
  });
  const opportunityEntities = buildBusinessOpportunityEntityRows({
    records,
    profiles: (profilesResult.data ?? []) as StockNeedsProfile[],
    importJobs: (jobsResult.data ?? []) as StockNeedsImportJob[]
  });
  const version = Number(versionResult.data.data_version);
  const versionedOpportunityEntities = opportunityEntities.map((row) => ({
    ...row,
    upload_batch_id: uploadBatchId,
    owner_id: versionResult.data.owner_id,
    data_version: version
  }));
  await publishBusinessOpportunityEntityRows(supabase, versionedOpportunityEntities, uploadBatchId, version);

  const summaryRows = rows.map((row) => ({
    ...row,
    upload_batch_id: uploadBatchId,
    owner_id: versionResult.data.owner_id,
    data_version: version
  }));
  for (const summaryChunk of businessSummaryPublishChunks(summaryRows)) {
    const summaryPublish = await supabase
      .from("business_mpn_summaries")
      .upsert(summaryChunk, { onConflict: "upload_batch_id,data_version,normalized_mpn" });
    if (summaryPublish.error) throw summaryPublish.error;
  }

  // Finalization is deliberately separate from chunk publication. The RPC
  // locks and rechecks the source version, then makes the complete set visible.
  const finalize = await supabase.rpc("replace_business_upload_summary_v1", {
    target_upload_batch_id: uploadBatchId,
    expected_data_version: version,
    summary_rows: []
  });
  if (finalize.error) throw finalize.error;
  return {
    rebuilt: true,
    version,
    sourceRecords: records.length,
    summaryRows: rows.length,
    opportunityEntities: opportunityEntities.length
  };
}
