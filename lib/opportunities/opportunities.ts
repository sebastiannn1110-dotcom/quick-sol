import {
  normalizePartNumberForMatch,
  type StockNeedsImportJob,
  type StockNeedsProfile,
  type StockNeedsRecord,
  type StockNeedsSourceUpload
} from "@/lib/stock-needs/stock-needs";

export type OpportunityType =
  | "immediate_sale"
  | "partial_sale"
  | "excess_resale"
  | "sourcing_needed"
  | "stock_without_demand";

export type SalesOpportunityFilters = {
  q?: string | null;
  mpn?: string | null;
  clientId?: string | null;
  customer?: string | null;
  supplier?: string | null;
  manufacturer?: string | null;
  opportunityType?: OpportunityType | null;
  uploadBatchId?: string | null;
  limit?: number;
  offset?: number;
};

export type SalesOpportunityItem = {
  id: string;
  opportunityType: OpportunityType;
  mpn: string;
  normalizedMpn: string;
  customerNeedName: string | null;
  excessOwnerName: string | null;
  supplierName: string | null;
  manufacturerName: string | null;
  requiredQty: number | null;
  availableQty: number | null;
  excessQty: number | null;
  receivedQty: number | null;
  shortageQty: number | null;
  approvedPartSignal: boolean;
  receivedSignal: boolean;
  reason: string;
  recommendedAction: string;
  accountClients: Array<{ id: string; name: string }>;
  sourceUploads: StockNeedsSourceUpload[];
  dataQualityFlags: string[];
};

export type SalesOpportunityTotals = {
  totalOpportunities: number;
  immediateSale: number;
  partialSale: number;
  excessResale: number;
  sourcingNeeded: number;
  stockWithoutDemand: number;
  approvedPartMatches: number;
  receivedHistoryMatches: number;
};

export type SalesOpportunitiesResult = {
  items: SalesOpportunityItem[];
  totals: SalesOpportunityTotals;
  meta: {
    limit: number;
    offset: number;
    returnedItems: number;
    scannedRecords: number;
    scannedUploads: number;
    totalBeforePagination: number;
  };
};

export type OpportunityRecordSignal = {
  id?: string;
  uploadBatchId: string;
  mpn: string;
  normalizedMpn: string;
  customerName: string | null;
  supplierName: string | null;
  manufacturerName: string | null;
  requiredQty: number | null;
  stockQty: number | null;
  excessQty: number | null;
  receivedQty: number | null;
  demandSignal: boolean;
  stockSignal: boolean;
  excessSignal: boolean;
  approvedPartSignal: boolean;
  receivedSignal: boolean;
  sourceUpload: StockNeedsSourceUpload;
  dataQualityFlags: string[];
};

type JsonRecord = Record<string, unknown>;

type OpportunityGroup = {
  mpn: string;
  normalizedMpn: string;
  demandQty: number;
  stockQty: number;
  excessQty: number;
  receivedQty: number;
  customerName: string | null;
  excessOwnerName: string | null;
  supplierName: string | null;
  manufacturerName: string | null;
  approvedPartSignal: boolean;
  receivedSignal: boolean;
  sourceUploads: Map<string, StockNeedsSourceUpload>;
  dataQualityFlags: Set<string>;
};

const PART_ALIASES = [
  "MPN",
  "mpn",
  "Item",
  "Mfg Partno",
  "Mfg Part No",
  "Part Number",
  "Manufacturer Part Number",
  "MFR Part Number",
  "MFG Part Number",
  "SKU",
  "mpn_quoted"
];

const DEMAND_QTY_ALIASES = [
  "Required Qty",
  "Required Quantity",
  "Demand Qty",
  "Demand Quantity",
  "Quantity",
  "QTY",
  "Requi",
  "Plan",
  "req_qty",
  "qty",
  "Open Qty",
  "Needed Qty"
];

const DEMAND_CONTEXT_ALIASES = [
  "RequiredDate",
  "Required Date",
  "Need Date",
  "Demand Date",
  "StartDate",
  "LeadTime",
  "Lead Time",
  "Customer",
  "Global Customer Name",
  "cliente"
];

const CUSTOMER_STRICT_ALIASES = ["Global Customer Name", "Customer", "customerName", "customer", "client", "cliente"];
const CUSTOMER_CONTEXT_ALIASES = [...CUSTOMER_STRICT_ALIASES, "BPName", "BusinessPartnerID"];

const STOCK_QTY_ALIASES = [
  "STOCK QTY",
  "Stock Qty",
  "stock",
  "on_hand",
  "on hand",
  "available qty",
  "available quantity",
  "available",
  "inventory qty",
  "inventory quantity"
];

const EXCESS_QTY_ALIASES = [
  "Excess Qty",
  "Excess Quantity",
  "Available Excess",
  "Customer Excess",
  "Surplus Qty",
  "Surplus Quantity",
  "Overstock Qty",
  "Overstock Quantity"
];

const EXCESS_SIGNAL_ALIASES = [
  "Excess",
  "Excess Qty",
  "Surplus",
  "Overstock",
  "Available Excess",
  "Customer Excess"
];

const APPROVED_ALIASES = [
  "Approved",
  "Approved Part",
  "AVL",
  "AML",
  "SourceControl",
  "SourceControlDesc",
  "Customer Approved",
  "Approved Vendor",
  "Approved Manufacturer",
  "Source Controlled"
];

const RECEIVED_QTY_ALIASES = [
  "RCPT Qty",
  "RCPT Qty_2",
  "Received Qty",
  "Received Quantity",
  "Receipt Qty",
  "Receipt Quantity",
  "received",
  "receipt"
];

const SUPPLIER_ALIASES = ["Global Supplier Name", "Supplier", "supplierName", "supplier", "vendor", "proveedor"];
const MANUFACTURER_ALIASES = ["MFG", "ManuName", "Global Manufacturer Name", "Manufacturer", "manufacturer", "fabricante", "clean_mfg"];
const STATUS_ALIASES = ["status", "state", "estado", "Status"];

const SENSITIVE_OUTPUT_KEYS = [
  "cost",
  "unit cost",
  "price",
  "pricebook",
  "globalprice",
  "contractglobalprice",
  "usd extended price",
  "gp",
  "gp rate",
  "margin"
];

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function normalizedKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function keyed(record: JsonRecord) {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) out.set(normalizedKey(key), value);
  return out;
}

function firstValue(records: JsonRecord[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizedKey);
  for (const record of records) {
    const byKey = keyed(record);
    for (const alias of normalizedAliases) {
      const value = byKey.get(alias);
      if (value !== null && value !== undefined && String(value).trim() !== "") return value;
    }
  }
  return null;
}

function hasAny(records: JsonRecord[], aliases: string[]) {
  return firstValue(records, aliases) !== null;
}

function firstText(records: JsonRecord[], aliases: string[], max = 120) {
  const value = firstValue(records, aliases);
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function firstNumber(records: JsonRecord[], aliases: string[]) {
  const value = firstValue(records, aliases);
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value: string | null | undefined, max = 120) {
  const text = value?.replace(/[^\p{L}\p{N}\s._@/-]/gu, " ").replace(/\s+/g, " ").trim() ?? "";
  return text ? text.slice(0, max) : null;
}

function templateText(profile: StockNeedsProfile | undefined, record: StockNeedsRecord) {
  return String(profile?.detected_template ?? record.upload_batches?.detected_category ?? record.category ?? "").toLowerCase();
}

function sourceUpload(record: StockNeedsRecord, profile: StockNeedsProfile | undefined, job: StockNeedsImportJob | undefined): StockNeedsSourceUpload {
  return {
    uploadBatchId: record.upload_batch_id,
    fileName: record.upload_batches?.original_file_name ?? null,
    detectedTemplate: profile?.detected_template ?? record.upload_batches?.detected_category ?? record.category ?? null,
    importStatus: job?.status ?? record.upload_batches?.status ?? null
  };
}

function joinedContext(records: JsonRecord[], aliases: string[]) {
  return aliases
    .map((alias) => firstText(records, [alias], 200))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isTruthySignal(value: unknown) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  const text = String(value).trim().toLowerCase();
  if (!text || /^(false|no|n|0|none|null|not approved)$/i.test(text)) return false;
  return true;
}

function approvedSignal(records: JsonRecord[]) {
  for (const alias of APPROVED_ALIASES) {
    const value = firstValue(records, [alias]);
    if (isTruthySignal(value)) return true;
  }
  const context = joinedContext(records, [...APPROVED_ALIASES, ...STATUS_ALIASES]);
  return /\b(approved|avl|aml|source\s*controlled?|sourcecontrol)\b/.test(context);
}

function receivedQty(records: JsonRecord[]) {
  return firstNumber(records, RECEIVED_QTY_ALIASES);
}

function excessSignal(records: JsonRecord[], template: string) {
  if (hasAny(records, EXCESS_SIGNAL_ALIASES)) return true;
  const context = `${template} ${joinedContext(records, [...EXCESS_SIGNAL_ALIASES, ...STATUS_ALIASES])}`;
  return /\b(excess|surplus|overstock)\b/.test(context);
}

function demandContext(records: JsonRecord[], template: string) {
  return (
    hasAny(records, DEMAND_CONTEXT_ALIASES) ||
    /pricing|logistica|logistics|cotizacion|quotation|rfq|demand|need|needs|planned/.test(template)
  );
}

function stockContext(records: JsonRecord[], template: string, record: StockNeedsRecord) {
  return (
    hasAny(records, STOCK_QTY_ALIASES) ||
    record.on_hand !== null && record.on_hand !== undefined ||
    /inventario|inventory|stock/.test(template)
  );
}

function demandSpecificQuantity(records: JsonRecord[]) {
  return hasAny(records, DEMAND_QTY_ALIASES.filter((alias) => !/^quantity$|^qty$/i.test(alias)));
}

function rawMpnValue(records: JsonRecord[], record: StockNeedsRecord) {
  return firstValue(records, PART_ALIASES) ?? record.mpn ?? record.mpn_quoted ?? null;
}

function customerName(records: JsonRecord[], record: StockNeedsRecord, hasDemandContext: boolean) {
  return (
    firstText(records, hasDemandContext ? CUSTOMER_CONTEXT_ALIASES : CUSTOMER_STRICT_ALIASES) ??
    cleanText(record.customer ?? record.client ?? null) ??
    null
  );
}

function supplierName(records: JsonRecord[], record: StockNeedsRecord) {
  return firstText(records, SUPPLIER_ALIASES) ?? cleanText(record.supplier_name ?? record.supplier ?? null) ?? null;
}

function manufacturerName(records: JsonRecord[], record: StockNeedsRecord) {
  return firstText(records, MANUFACTURER_ALIASES) ?? cleanText(record.manufacturer ?? record.clean_mfg ?? null) ?? null;
}

function buildMaps(input: {
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}) {
  return {
    profiles: new Map((input.profiles ?? []).map((profile) => [profile.upload_batch_id, profile])),
    jobs: new Map((input.importJobs ?? []).map((job) => [job.upload_batch_id, job]))
  };
}

function detectRecordSignal(record: StockNeedsRecord, profile: StockNeedsProfile | undefined, job: StockNeedsImportJob | undefined): OpportunityRecordSignal | null {
  const raw = asRecord(record.raw_data);
  const normalized = asRecord(record.normalized_data);
  const records = [raw, normalized];
  const rawMpn = rawMpnValue(records, record);
  const normalizedMpn = normalizePartNumberForMatch(rawMpn);
  if (!normalizedMpn) return null;

  const template = templateText(profile, record);
  const stockQty = firstNumber(records, STOCK_QTY_ALIASES) ?? record.on_hand ?? null;
  const requiredQty = firstNumber(records, DEMAND_QTY_ALIASES) ?? record.req_qty ?? record.qty ?? null;
  const hasDemandContext = demandContext(records, template);
  const hasStockContext = stockContext(records, template, record);
  const hasExcessSignal = excessSignal(records, template);
  const explicitExcessQty = firstNumber(records, EXCESS_QTY_ALIASES);
  const excessQty = explicitExcessQty ?? (hasExcessSignal ? stockQty : null);
  const rcptQty = receivedQty(records);
  const stockSignal = stockQty !== null && stockQty > 0 && hasStockContext;
  const demandSignal =
    requiredQty !== null &&
    requiredQty > 0 &&
    !/inventario|inventory/.test(template) &&
    (demandSpecificQuantity(records) || hasDemandContext || !hasStockContext);
  const approvedPartSignal = approvedSignal(records);
  const receivedSignal = rcptQty !== null && rcptQty > 0;
  const flags = new Set<string>();

  if (demandSignal && !customerName(records, record, hasDemandContext)) flags.add("missing_customer_context");
  if ((stockSignal || hasExcessSignal) && !supplierName(records, record) && !manufacturerName(records, record)) flags.add("missing_supplier_or_manufacturer_context");
  if (approvedPartSignal) flags.add("approved_part_signal");
  if (receivedSignal) flags.add("received_history_signal");

  return {
    id: record.id,
    uploadBatchId: record.upload_batch_id,
    mpn: normalizedMpn,
    normalizedMpn,
    customerName: customerName(records, record, hasDemandContext),
    supplierName: supplierName(records, record),
    manufacturerName: manufacturerName(records, record),
    requiredQty: demandSignal ? Math.max(requiredQty ?? 0, 0) : null,
    stockQty: stockSignal ? Math.max(stockQty ?? 0, 0) : null,
    excessQty: hasExcessSignal && excessQty !== null ? Math.max(excessQty, 0) : null,
    receivedQty: rcptQty !== null ? Math.max(rcptQty, 0) : null,
    demandSignal,
    stockSignal,
    excessSignal: hasExcessSignal,
    approvedPartSignal,
    receivedSignal,
    sourceUpload: sourceUpload(record, profile, job),
    dataQualityFlags: Array.from(flags)
  };
}

function detectSignals(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}) {
  const { profiles, jobs } = buildMaps(input);
  return input.records
    .map((record) => detectRecordSignal(record, profiles.get(record.upload_batch_id), jobs.get(record.upload_batch_id)))
    .filter((signal): signal is OpportunityRecordSignal => Boolean(signal));
}

export function detectDemandRecords(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}) {
  return detectSignals(input).filter((signal) => signal.demandSignal);
}

export function detectStockRecords(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}) {
  return detectSignals(input).filter((signal) => signal.stockSignal);
}

export function detectExcessRecords(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}) {
  return detectSignals(input).filter((signal) => signal.excessSignal && (signal.excessQty ?? 0) > 0);
}

export function detectApprovedPartSignals(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}) {
  return detectSignals(input).filter((signal) => signal.approvedPartSignal);
}

export function detectReceivedSignals(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
}) {
  return detectSignals(input).filter((signal) => signal.receivedSignal);
}

function emptyTotals(): SalesOpportunityTotals {
  return {
    totalOpportunities: 0,
    immediateSale: 0,
    partialSale: 0,
    excessResale: 0,
    sourcingNeeded: 0,
    stockWithoutDemand: 0,
    approvedPartMatches: 0,
    receivedHistoryMatches: 0
  };
}

export function formatOpportunityReason(item: Pick<SalesOpportunityItem, "opportunityType" | "requiredQty" | "availableQty" | "excessQty" | "shortageQty" | "approvedPartSignal" | "receivedSignal">) {
  const signals = [
    item.approvedPartSignal ? "approved part signal" : "",
    item.receivedSignal ? "received history" : ""
  ].filter(Boolean);
  const suffix = signals.length ? ` Supporting signals: ${signals.join(", ")}.` : "";

  if (item.opportunityType === "immediate_sale") return `Customer demand is covered by available stock.${suffix}`;
  if (item.opportunityType === "partial_sale") return `Customer demand is only partially covered; shortage is ${item.shortageQty ?? 0} units.${suffix}`;
  if (item.opportunityType === "excess_resale") return `A clear excess/surplus source matches current demand for the same MPN.${suffix}`;
  if (item.opportunityType === "sourcing_needed") return `Customer demand exists and no internal stock or excess source was detected.${suffix}`;
  return `Stock or excess is available, but no current customer demand was detected.${suffix}`;
}

export function formatRecommendedAction(item: Pick<SalesOpportunityItem, "opportunityType" | "shortageQty">) {
  if (item.opportunityType === "immediate_sale") return "Prioritize customer outreach and reserve available quantity.";
  if (item.opportunityType === "partial_sale") return `Offer available quantity and source the remaining ${item.shortageQty ?? 0} units.`;
  if (item.opportunityType === "excess_resale") return "Validate excess availability and broker it against matching demand.";
  if (item.opportunityType === "sourcing_needed") return "Start supplier sourcing for the detected demand.";
  return "Create outbound campaign or search for buyers.";
}

function mergeSignal(group: OpportunityGroup, signal: OpportunityRecordSignal) {
  if (signal.demandSignal && signal.requiredQty !== null) group.demandQty += signal.requiredQty;
  if (signal.stockSignal && signal.stockQty !== null) group.stockQty += signal.stockQty;
  if (signal.excessSignal && signal.excessQty !== null) group.excessQty += signal.excessQty;
  if (signal.receivedQty !== null) group.receivedQty += signal.receivedQty;
  group.customerName = group.customerName ?? signal.customerName;
  if (signal.excessSignal) group.excessOwnerName = group.excessOwnerName ?? signal.customerName ?? signal.supplierName ?? signal.manufacturerName;
  group.supplierName = group.supplierName ?? signal.supplierName;
  group.manufacturerName = group.manufacturerName ?? signal.manufacturerName;
  group.approvedPartSignal ||= signal.approvedPartSignal;
  group.receivedSignal ||= signal.receivedSignal;
  group.sourceUploads.set(signal.sourceUpload.uploadBatchId, signal.sourceUpload);
  for (const flag of signal.dataQualityFlags) group.dataQualityFlags.add(flag);
}

function addManufacturerFlags(group: OpportunityGroup, signals: OpportunityRecordSignal[]) {
  const manufacturers = new Set(signals.filter((signal) => signal.normalizedMpn === group.normalizedMpn).map((signal) => signal.manufacturerName).filter(Boolean));
  if (manufacturers.size > 1) group.dataQualityFlags.add("manufacturer_context_mixed");
}

function makeItem(group: OpportunityGroup, opportunityType: OpportunityType): SalesOpportunityItem {
  const requiredQty = group.demandQty > 0 ? group.demandQty : null;
  const availableQty = group.stockQty > 0 ? group.stockQty : null;
  const excessQty = group.excessQty > 0 ? group.excessQty : null;
  const shortageQty = requiredQty !== null ? Math.max(requiredQty - (availableQty ?? 0) - (opportunityType === "excess_resale" ? (excessQty ?? 0) : 0), 0) : null;
  const item: SalesOpportunityItem = {
    id: `${opportunityType}:${group.normalizedMpn}`,
    opportunityType,
    mpn: group.mpn,
    normalizedMpn: group.normalizedMpn,
    customerNeedName: group.customerName,
    excessOwnerName: opportunityType === "excess_resale" || opportunityType === "stock_without_demand" ? group.excessOwnerName : null,
    supplierName: group.supplierName,
    manufacturerName: group.manufacturerName,
    requiredQty,
    availableQty,
    excessQty,
    receivedQty: group.receivedQty > 0 ? group.receivedQty : null,
    shortageQty,
    approvedPartSignal: group.approvedPartSignal,
    receivedSignal: group.receivedSignal,
    reason: "",
    recommendedAction: "",
    accountClients: [],
    sourceUploads: Array.from(group.sourceUploads.values()).slice(0, 6),
    dataQualityFlags: Array.from(group.dataQualityFlags).slice(0, 8)
  };
  return {
    ...item,
    reason: formatOpportunityReason(item),
    recommendedAction: formatRecommendedAction(item)
  };
}

function opportunityTypesForGroup(group: OpportunityGroup): OpportunityType[] {
  const types: OpportunityType[] = [];
  if (group.demandQty > 0) {
    if (group.stockQty >= group.demandQty) types.push("immediate_sale");
    else if (group.stockQty > 0) types.push("partial_sale");
    else if (group.excessQty <= 0) types.push("sourcing_needed");
    if (group.excessQty > 0) types.push("excess_resale");
  } else if (group.stockQty > 0 || group.excessQty > 0) {
    types.push("stock_without_demand");
  }
  return types;
}

function matchesFilter(value: string | null, filter?: string | null) {
  if (!filter) return true;
  return (value ?? "").toLowerCase().includes(filter.toLowerCase().trim());
}

function matchesPartnerFilter(item: SalesOpportunityItem, filters: SalesOpportunityFilters) {
  if (filters.supplier && filters.manufacturer && filters.supplier === filters.manufacturer) {
    return matchesFilter(item.supplierName, filters.supplier) || matchesFilter(item.manufacturerName, filters.manufacturer);
  }
  return matchesFilter(item.supplierName, filters.supplier) && matchesFilter(item.manufacturerName, filters.manufacturer);
}

function itemMatchesSearch(item: SalesOpportunityItem, filters: SalesOpportunityFilters) {
  const q = normalizePartNumberForMatch(filters.q ?? filters.mpn ?? null);
  const text = cleanText(filters.q ?? null, 120)?.toLowerCase() ?? "";
  if (filters.mpn && item.normalizedMpn !== normalizePartNumberForMatch(filters.mpn)) return false;
  if (q && !item.normalizedMpn.includes(q)) return false;
  if (text && !q) {
    const haystack = [
      item.mpn,
      item.customerNeedName,
      item.excessOwnerName,
      item.supplierName,
      item.manufacturerName,
      item.opportunityType,
      item.recommendedAction
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  return true;
}

function sortItems(left: SalesOpportunityItem, right: SalesOpportunityItem) {
  const order: Record<OpportunityType, number> = {
    immediate_sale: 0,
    partial_sale: 1,
    excess_resale: 2,
    sourcing_needed: 3,
    stock_without_demand: 4
  };
  return (
    order[left.opportunityType] - order[right.opportunityType] ||
    (right.requiredQty ?? -1) - (left.requiredQty ?? -1) ||
    (right.shortageQty ?? -1) - (left.shortageQty ?? -1) ||
    left.mpn.localeCompare(right.mpn)
  );
}

function computeTotals(items: SalesOpportunityItem[]) {
  return items.reduce((acc, item) => {
    acc.totalOpportunities += 1;
    if (item.opportunityType === "immediate_sale") acc.immediateSale += 1;
    if (item.opportunityType === "partial_sale") acc.partialSale += 1;
    if (item.opportunityType === "excess_resale") acc.excessResale += 1;
    if (item.opportunityType === "sourcing_needed") acc.sourcingNeeded += 1;
    if (item.opportunityType === "stock_without_demand") acc.stockWithoutDemand += 1;
    if (item.approvedPartSignal) acc.approvedPartMatches += 1;
    if (item.receivedSignal) acc.receivedHistoryMatches += 1;
    return acc;
  }, emptyTotals());
}

export function buildSalesOpportunitiesResult(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
  filters?: SalesOpportunityFilters;
}): SalesOpportunitiesResult {
  const filters = input.filters ?? {};
  const limit = Math.min(Math.max(Number(filters.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset ?? 0) || 0, 0);
  const signals = detectSignals(input).filter((signal) => !filters.uploadBatchId || signal.uploadBatchId === filters.uploadBatchId);
  const groups = new Map<string, OpportunityGroup>();

  for (const signal of signals) {
    const group = groups.get(signal.normalizedMpn) ?? {
      mpn: signal.normalizedMpn,
      normalizedMpn: signal.normalizedMpn,
      demandQty: 0,
      stockQty: 0,
      excessQty: 0,
      receivedQty: 0,
      customerName: null,
      excessOwnerName: null,
      supplierName: null,
      manufacturerName: null,
      approvedPartSignal: false,
      receivedSignal: false,
      sourceUploads: new Map<string, StockNeedsSourceUpload>(),
      dataQualityFlags: new Set<string>()
    };
    mergeSignal(group, signal);
    groups.set(signal.normalizedMpn, group);
  }

  for (const group of groups.values()) addManufacturerFlags(group, signals);

  const allItems = Array.from(groups.values())
    .flatMap((group) => opportunityTypesForGroup(group).map((type) => makeItem(group, type)))
    .filter((item) => itemMatchesSearch(item, filters))
    .filter((item) => matchesFilter(item.customerNeedName, filters.customer))
    .filter((item) => matchesPartnerFilter(item, filters))
    .filter((item) => !filters.opportunityType || item.opportunityType === filters.opportunityType)
    .sort(sortItems);

  const items = allItems.slice(offset, offset + limit);
  return {
    items,
    totals: computeTotals(allItems),
    meta: {
      limit,
      offset,
      returnedItems: items.length,
      scannedRecords: input.records.length,
      scannedUploads: new Set(input.records.map((record) => record.upload_batch_id)).size,
      totalBeforePagination: allItems.length
    }
  };
}

export function summarizeSalesOpportunities(result: SalesOpportunitiesResult, options?: { mode?: OpportunityType | "approved" | "received" | null }) {
  const mode = options?.mode ?? null;
  if (mode && mode !== "approved" && mode !== "received") {
    const scoped = result.items.filter((item) => item.opportunityType === mode);
    const examples = scoped.slice(0, 8).map((item) => item.mpn);
    const exampleText = examples.length ? ` Algunos MPN: ${examples.join(", ")}.` : "";
    return `Encontré ${scoped.length} oportunidades de tipo ${mode.replace(/_/g, " ")}.${exampleText}`;
  }
  if (mode === "approved") {
    return `Encontré ${result.totals.approvedPartMatches} oportunidades con señales de parte aprobada o AVL/AML.`;
  }
  if (mode === "received") {
    return `Encontré ${result.totals.receivedHistoryMatches} oportunidades con historial recibido.`;
  }
  return [
    `Encontré ${result.totals.totalOpportunities} oportunidades comerciales.`,
    `${result.totals.immediateSale} parecen venta inmediata, ${result.totals.partialSale} son ventas parciales, ${result.totals.excessResale} son reventa de exceso, ${result.totals.sourcingNeeded} requieren sourcing y ${result.totals.stockWithoutDemand} tienen stock sin demanda actual.`,
    `${result.totals.approvedPartMatches} tienen señal de parte aprobada y ${result.totals.receivedHistoryMatches} tienen historial recibido.`
  ].join(" ");
}

export function opportunityTypeFromQuestion(question: string): OpportunityType | "approved" | "received" | null {
  const text = question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/venta inmediata|vender ya|puedo vender|immediate/.test(text)) return "immediate_sale";
  if (/venta parcial|parcial|partial/.test(text)) return "partial_sale";
  if (/sourcing|buscar proveedor|requieren proveedor|sin stock|no stock/.test(text)) return "sourcing_needed";
  if (/exceso|surplus|overstock|revender|reventa|broker/.test(text)) return "excess_resale";
  if (/stock.*sin demanda|sin demanda|outbound|comprador/.test(text)) return "stock_without_demand";
  if (/aprobada|aprobadas|approved|avl|aml/.test(text)) return "approved";
  if (/recibidas|recibidos|received|receipt|rcpt|historial/.test(text)) return "received";
  return null;
}

export function containsSensitiveOpportunityOutput(value: unknown) {
  const serialized = JSON.stringify(value).toLowerCase();
  return SENSITIVE_OUTPUT_KEYS.some((key) => serialized.includes(key));
}
