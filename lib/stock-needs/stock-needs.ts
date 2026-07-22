export type CoverageStatus = "in_stock" | "partial_stock" | "no_stock" | "overstock" | "unknown";

export type StockNeedsFilters = {
  q?: string | null;
  customer?: string | null;
  supplier?: string | null;
  manufacturer?: string | null;
  status?: string | null;
  coverageStatus?: CoverageStatus | null;
  uploadBatchId?: string | null;
  limit?: number;
  offset?: number;
};

export type StockNeedsSourceUpload = {
  uploadBatchId: string;
  fileName: string | null;
  detectedTemplate: string | null;
  importStatus: string | null;
};

export type StockNeedsItem = {
  mpn: string;
  customerName: string | null;
  manufacturerName: string | null;
  supplierName: string | null;
  requiredQty: number | null;
  stockQty: number | null;
  availableQty: number | null;
  shortageQty: number | null;
  coverageStatus: CoverageStatus;
  requiredDate: string | null;
  leadTime: string | null;
  sourceUploads: StockNeedsSourceUpload[];
  warnings: string[];
};

export type StockNeedsTotals = {
  totalItems: number;
  inStock: number;
  partialStock: number;
  noStock: number;
  overstock: number;
  unknown: number;
  totalRequiredQty: number;
  totalStockQty: number;
};

export type StockNeedsResult = {
  items: StockNeedsItem[];
  totals: StockNeedsTotals;
  meta: {
    limit: number;
    offset: number;
    returnedItems: number;
    scannedRecords: number;
    missingProfileCount: number;
    missingProfileUploadIds: string[];
    hasMissingProfiles: boolean;
  };
};

export type StockNeedsRecord = {
  id?: string;
  upload_batch_id: string;
  category?: string | null;
  raw_data?: unknown;
  normalized_data?: unknown;
  has_errors?: boolean | null;
  errors?: unknown;
  mpn?: string | null;
  mpn_quoted?: string | null;
  customer?: string | null;
  client?: string | null;
  supplier?: string | null;
  supplier_name?: string | null;
  manufacturer?: string | null;
  clean_mfg?: string | null;
  qty?: number | null;
  req_qty?: number | null;
  on_hand?: number | null;
  earliest_shipping_date?: string | null;
  lead_time_weeks?: number | string | null;
  upload_batches?: {
    original_file_name?: string | null;
    detected_category?: string | null;
    status?: string | null;
    created_at?: string | null;
  } | null;
};

export type StockNeedsProfile = {
  upload_batch_id: string;
  detected_template?: string | null;
  detected_mappings_json?: unknown;
  column_count?: number | null;
};

export type StockNeedsImportJob = {
  upload_batch_id: string;
  status?: string | null;
};

type JsonRecord = Record<string, unknown>;

type Accumulator = {
  key: string;
  mpn: string;
  customerName: string | null;
  manufacturerName: string | null;
  supplierName: string | null;
  requiredQty: number | null;
  stockQty: number | null;
  requiredDate: string | null;
  leadTime: string | null;
  sourceUploads: Map<string, StockNeedsSourceUpload>;
  warnings: Set<string>;
};

const PART_ALIASES = ["MPN", "mpn", "Item", "Mfg Partno", "Part Number", "Manufacturer Part Number", "mpn_quoted"];
const STOCK_QTY_ALIASES = ["STOCK QTY", "stock_qty", "stock qty", "on_hand", "on hand", "available qty", "available quantity"];
const NEED_QTY_ALIASES = ["Quantity", "qty", "req_qty", "required qty", "request qty", "delivery qto", "RCPT Qty", "RCPT Qty_2", "receipt qty"];
const CUSTOMER_ALIASES = ["Global Customer Name", "customer", "client", "BPName", "BusinessPartnerID"];
const SUPPLIER_ALIASES = ["Global Supplier Name", "supplier", "supplier name", "vendor"];
const MANUFACTURER_ALIASES = ["MFG", "manufacturer", "Global Manufacturer Name", "ManuName", "ManuCode", "clean_mfg"];
const REQUIRED_DATE_ALIASES = ["RequiredDate", "required date", "StartDate", "start date", "earliest_shipping_date"];
const LEAD_TIME_ALIASES = ["LeadTime", "lead time", "InTransitLT", "lead_time_weeks", "transit_time_weeks"];
const STATUS_ALIASES = ["status", "state", "estado"];

export function normalizePartNumberForMatch(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const compact = text.replace(/\s+/g, "").toUpperCase();
  return compact || null;
}

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

function firstValue(record: JsonRecord, aliases: string[]) {
  const byKey = keyed(record);
  for (const alias of aliases) {
    const value = byKey.get(normalizedKey(alias));
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return null;
}

function firstText(record: JsonRecord, aliases: string[], max = 120) {
  const value = firstValue(record, aliases);
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function firstNumber(record: JsonRecord, aliases: string[]) {
  const value = firstValue(record, aliases);
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function hasAny(record: JsonRecord, aliases: string[]) {
  return firstValue(record, aliases) !== null;
}

function uploadTemplate(profile: StockNeedsProfile | undefined, record: StockNeedsRecord) {
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

function upsertSource(acc: Accumulator, upload: StockNeedsSourceUpload) {
  if (!acc.sourceUploads.has(upload.uploadBatchId)) acc.sourceUploads.set(upload.uploadBatchId, upload);
}

function coverageStatus(requiredQty: number | null, stockQty: number | null, hasMpn: boolean): CoverageStatus {
  if (!hasMpn) return "unknown";
  if ((requiredQty === null || requiredQty <= 0) && stockQty !== null && stockQty > 0) return "overstock";
  if (requiredQty === null || requiredQty <= 0) return "unknown";
  if (stockQty === null || stockQty <= 0) return "no_stock";
  if (stockQty < requiredQty) return "partial_stock";
  if (stockQty > requiredQty) return "overstock";
  return "in_stock";
}

function isStockRecord(raw: JsonRecord, normalized: JsonRecord, template: string) {
  return template.includes("inventario") || hasAny(raw, STOCK_QTY_ALIASES) || hasAny(normalized, ["on_hand"]);
}

function isNeedRecord(raw: JsonRecord, normalized: JsonRecord, template: string) {
  if (template.includes("inventario")) return false;
  const hasNeedQty = hasAny(raw, NEED_QTY_ALIASES) || hasAny(normalized, ["req_qty", "qty"]);
  const hasNeedContext =
    hasAny(raw, CUSTOMER_ALIASES) ||
    hasAny(raw, REQUIRED_DATE_ALIASES) ||
    hasAny(raw, LEAD_TIME_ALIASES) ||
    hasAny(raw, STATUS_ALIASES) ||
    hasAny(raw, ["PriceBook", "Price Book", "GlobalPrice", "ContractGlobalPrice", "USD Extended Price", "USD Extended Price_2"]);
  return hasNeedQty && (hasNeedContext || template.includes("pricing") || template.includes("logistica") || template.includes("cotizacion"));
}

function findMpn(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  return firstValue(raw, PART_ALIASES) ?? firstValue(normalized, PART_ALIASES) ?? record.mpn ?? record.mpn_quoted ?? null;
}

function findCustomer(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  return firstText(raw, CUSTOMER_ALIASES) ?? firstText(normalized, ["customer", "client"]) ?? record.customer ?? record.client ?? null;
}

function findSupplier(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  return firstText(raw, SUPPLIER_ALIASES) ?? firstText(normalized, ["supplier", "supplier_name"]) ?? record.supplier_name ?? record.supplier ?? null;
}

function findManufacturer(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  return firstText(raw, MANUFACTURER_ALIASES) ?? firstText(normalized, ["manufacturer", "clean_mfg"]) ?? record.manufacturer ?? record.clean_mfg ?? null;
}

function findRequiredQty(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  return firstNumber(raw, NEED_QTY_ALIASES) ?? firstNumber(normalized, ["req_qty", "qty"]) ?? record.req_qty ?? record.qty ?? null;
}

function findStockQty(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  return firstNumber(raw, STOCK_QTY_ALIASES) ?? firstNumber(normalized, ["on_hand"]) ?? record.on_hand ?? null;
}

function findRequiredDate(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  return firstText(raw, REQUIRED_DATE_ALIASES, 40) ?? firstText(normalized, ["earliest_shipping_date"], 40) ?? record.earliest_shipping_date ?? null;
}

function findLeadTime(raw: JsonRecord, normalized: JsonRecord, record: StockNeedsRecord) {
  const value = firstValue(raw, LEAD_TIME_ALIASES) ?? firstValue(normalized, ["lead_time_weeks", "transit_time_weeks"]) ?? record.lead_time_weeks ?? null;
  if (value === null || value === undefined || value === "") return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, 40);
}

function matchesFilter(value: string | null, filter?: string | null) {
  if (!filter) return true;
  return (value ?? "").toLowerCase().includes(filter.toLowerCase().trim());
}

function matchesPartnerFilter(item: StockNeedsItem, filters: StockNeedsFilters) {
  if (filters.supplier && filters.manufacturer && filters.supplier === filters.manufacturer) {
    return matchesFilter(item.supplierName, filters.supplier) || matchesFilter(item.manufacturerName, filters.manufacturer);
  }
  return matchesFilter(item.supplierName, filters.supplier) && matchesFilter(item.manufacturerName, filters.manufacturer);
}

function emptyTotals(): StockNeedsTotals {
  return {
    totalItems: 0,
    inStock: 0,
    partialStock: 0,
    noStock: 0,
    overstock: 0,
    unknown: 0,
    totalRequiredQty: 0,
    totalStockQty: 0
  };
}

export function buildStockNeedsResult(input: {
  records: StockNeedsRecord[];
  profiles?: StockNeedsProfile[];
  importJobs?: StockNeedsImportJob[];
  filters?: StockNeedsFilters;
}): StockNeedsResult {
  const filters = input.filters ?? {};
  const limit = Math.min(Math.max(Number(filters.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset ?? 0) || 0, 0);
  const profiles = new Map((input.profiles ?? []).map((profile) => [profile.upload_batch_id, profile]));
  const jobs = new Map((input.importJobs ?? []).map((job) => [job.upload_batch_id, job]));
  const rows = new Map<string, Accumulator>();
  const missingProfiles = new Set<string>();

  for (const record of input.records) {
    if (filters.uploadBatchId && record.upload_batch_id !== filters.uploadBatchId) continue;

    const raw = asRecord(record.raw_data);
    const normalized = asRecord(record.normalized_data);
    const rawMpn = findMpn(raw, normalized, record);
    const key = normalizePartNumberForMatch(rawMpn);
    if (!key) continue;

    const profile = profiles.get(record.upload_batch_id);
    if (!profile) missingProfiles.add(record.upload_batch_id);
    const template = uploadTemplate(profile, record);
    const stockRecord = isStockRecord(raw, normalized, template);
    const needRecord = isNeedRecord(raw, normalized, template);
    if (!stockRecord && !needRecord) continue;

    const existing = rows.get(key) ?? {
      key,
      mpn: key,
      customerName: null,
      manufacturerName: null,
      supplierName: null,
      requiredQty: null,
      stockQty: null,
      requiredDate: null,
      leadTime: null,
      sourceUploads: new Map<string, StockNeedsSourceUpload>(),
      warnings: new Set<string>()
    };

    const customer = findCustomer(raw, normalized, record);
    const supplier = findSupplier(raw, normalized, record);
    const manufacturer = findManufacturer(raw, normalized, record);
    existing.customerName = existing.customerName ?? customer;
    existing.supplierName = existing.supplierName ?? supplier;
    existing.manufacturerName = existing.manufacturerName ?? manufacturer;
    existing.requiredDate = existing.requiredDate ?? findRequiredDate(raw, normalized, record);
    existing.leadTime = existing.leadTime ?? findLeadTime(raw, normalized, record);

    if (stockRecord) {
      const qty = findStockQty(raw, normalized, record);
      if (qty !== null) existing.stockQty = (existing.stockQty ?? 0) + Math.max(qty, 0);
    }
    if (needRecord) {
      const qty = findRequiredQty(raw, normalized, record);
      if (qty !== null) existing.requiredQty = (existing.requiredQty ?? 0) + Math.max(qty, 0);
    }

    upsertSource(existing, sourceUpload(record, profile, jobs.get(record.upload_batch_id)));
    rows.set(key, existing);
  }

  const q = normalizePartNumberForMatch(filters.q);
  const filtered = Array.from(rows.values())
    .map((row): StockNeedsItem => {
      const status = coverageStatus(row.requiredQty, row.stockQty, Boolean(row.key));
      const shortageQty = row.requiredQty !== null ? Math.max(row.requiredQty - (row.stockQty ?? 0), 0) : null;
      return {
        mpn: row.mpn,
        customerName: row.customerName,
        manufacturerName: row.manufacturerName,
        supplierName: row.supplierName,
        requiredQty: row.requiredQty,
        stockQty: row.stockQty,
        availableQty: row.stockQty,
        shortageQty,
        coverageStatus: status,
        requiredDate: row.requiredDate,
        leadTime: row.leadTime,
        sourceUploads: Array.from(row.sourceUploads.values()).slice(0, 5),
        warnings: Array.from(row.warnings).slice(0, 5)
      };
    })
    .filter((item) => !q || item.mpn.includes(q))
    .filter((item) => matchesFilter(item.customerName, filters.customer))
    .filter((item) => matchesPartnerFilter(item, filters))
    .filter((item) => !filters.status || item.sourceUploads.some((upload) => upload.importStatus === filters.status))
    .filter((item) => !filters.coverageStatus || item.coverageStatus === filters.coverageStatus)
    .sort((left, right) => {
      const order: Record<CoverageStatus, number> = { no_stock: 0, partial_stock: 1, unknown: 2, in_stock: 3, overstock: 4 };
      return order[left.coverageStatus] - order[right.coverageStatus] || left.mpn.localeCompare(right.mpn);
    });

  const totals = filtered.reduce((acc, item) => {
    acc.totalItems += 1;
    acc.totalRequiredQty += item.requiredQty ?? 0;
    acc.totalStockQty += item.stockQty ?? 0;
    if (item.coverageStatus === "in_stock") acc.inStock += 1;
    if (item.coverageStatus === "partial_stock") acc.partialStock += 1;
    if (item.coverageStatus === "no_stock") acc.noStock += 1;
    if (item.coverageStatus === "overstock") acc.overstock += 1;
    if (item.coverageStatus === "unknown") acc.unknown += 1;
    return acc;
  }, emptyTotals());

  const items = filtered.slice(offset, offset + limit);
  return {
    items,
    totals,
    meta: {
      limit,
      offset,
      returnedItems: items.length,
      scannedRecords: input.records.length,
      missingProfileCount: missingProfiles.size,
      missingProfileUploadIds: Array.from(missingProfiles).slice(0, 20),
      hasMissingProfiles: missingProfiles.size > 0
    }
  };
}

export function summarizeStockNeeds(result: StockNeedsResult, options?: { mpn?: string | null; mode?: "shortage" | "stock" | "needs" | "files" }) {
  const formatQty = (value: number) => new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(value);
  const mpn = options?.mpn ? normalizePartNumberForMatch(options.mpn) : null;
  if (mpn) {
    const item = result.items.find((row) => row.mpn === mpn);
    if (!item) return `No encontre stock o necesidades visibles para el MPN ${mpn}.`;
    return `Para ${item.mpn}: necesidad ${item.requiredQty ?? "desconocida"}, stock ${item.stockQty ?? "desconocido"}, cobertura ${item.coverageStatus.replace(/_/g, " ")}.`;
  }
  if (options?.mode === "files") {
    const uploadNames = new Set(result.items.flatMap((item) => item.sourceUploads.map((upload) => upload.detectedTemplate ?? "sin plantilla")));
    return `Los archivos visibles se agrupan como ${Array.from(uploadNames).slice(0, 5).join(", ") || "sin clasificacion suficiente"}.`;
  }
  if (options?.mode === "needs") {
    return `Detecte ${result.totals.totalItems} MPNs con necesidades o stock visible y ${formatQty(result.totals.totalRequiredQty)} unidades requeridas.`;
  }
  if (options?.mode === "shortage") {
    const shortageItems = result.items.filter((item) => item.coverageStatus === "no_stock" || item.coverageStatus === "partial_stock");
    const examples = shortageItems.slice(0, 10).map((item) => item.mpn);
    const exampleText = examples.length ? ` Algunos ejemplos son: ${examples.join(", ")}.` : "";
    return `Encontre ${result.totals.noStock} MPN con necesidad y sin stock disponible, y ${result.totals.partialStock} con stock parcial.${exampleText} El total requerido detectado es ${formatQty(result.totals.totalRequiredQty)} unidades y el stock disponible cruzado actualmente es ${formatQty(result.totals.totalStockQty)}.`;
  }
  return `Resumen de cobertura: ${result.totals.inStock} con stock completo, ${result.totals.partialStock} con stock parcial, ${result.totals.noStock} sin stock, ${result.totals.overstock} con sobrestock y ${result.totals.unknown} desconocidos.`;
}
