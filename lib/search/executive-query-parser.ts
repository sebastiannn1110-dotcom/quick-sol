export type ExecutiveSearchIntent =
  | "records"
  | "uploads"
  | "users"
  | "errors"
  | "analytics"
  | "price_comparison";

export type ComparisonOperator = "gt" | "gte" | "lt" | "lte" | "eq";

export interface NumericFilter {
  operator: ComparisonOperator;
  value: number;
  source: string;
}

export interface DateRangeFilter {
  preset?: "today" | "yesterday" | "current_week" | "current_month";
  from?: string;
  to?: string;
}

export interface ExecutiveSearchFilters {
  text?: string;
  mpn?: string;
  supplier?: string;
  customer?: string;
  employee?: string;
  po?: string;
  category?: string;
  country?: string;
  dateRange?: DateRangeFilter;
  gpRate?: NumericFilter;
  price?: NumericFilter;
  qty?: NumericFilter;
  leadTimeDays?: NumericFilter;
  hasErrors?: boolean;
  missingMpn?: boolean;
  errorType?: string;
  errorField?: string;
  commission?: NumericFilter | boolean;
  uploadErrorThreshold?: NumericFilter;
  recentUploads?: boolean;
}

export interface ParsedExecutiveQuery {
  originalQuery: string;
  normalizedQuery: string;
  intent: ExecutiveSearchIntent;
  filters: ExecutiveSearchFilters;
  confidence: number;
  detectedTerms: string[];
}

const CATEGORY_ALIASES: Array<[string, string]> = [
  ["sales margin", "Sales Margin"],
  ["margen", "Sales Margin"],
  ["rfq", "RFQ"],
  ["quotation", "RFQ"],
  ["cotizacion", "RFQ"],
  ["supplier offer", "Supplier Offers"],
  ["oferta", "Supplier Offers"],
  ["customer demand", "Customer Demand"],
  ["inventory", "Inventory"],
  ["inventario", "Inventory"],
  ["logistics", "Logistics"],
  ["logistica", "Logistics"],
  ["finance", "Finance"],
  ["quality", "Quality"]
];

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function currentWeekRange(now: Date) {
  const start = startOfDay(now);
  const day = start.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + mondayOffset);
  const end = endOfDay(start);
  end.setDate(start.getDate() + 6);
  return { from: isoDate(start), to: isoDate(end) };
}

function currentMonthRange(now: Date) {
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: isoDate(from), to: isoDate(to) };
}

function parseRelativeDateRange(normalized: string, now: Date): DateRangeFilter | undefined {
  if (/\b(hoy|today)\b/.test(normalized)) {
    return { preset: "today", from: isoDate(now), to: isoDate(now) };
  }
  if (/\b(ayer|yesterday)\b/.test(normalized)) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return { preset: "yesterday", from: isoDate(yesterday), to: isoDate(yesterday) };
  }
  if (/esta semana|this week|current week/.test(normalized)) {
    return { preset: "current_week", ...currentWeekRange(now) };
  }
  if (/este mes|this month|current month/.test(normalized)) {
    return { preset: "current_month", ...currentMonthRange(now) };
  }
  return undefined;
}

function parseOperator(value: string): ComparisonOperator {
  if (/mayor o igual|at least|>=/.test(value)) return "gte";
  if (/menor o igual|at most|<=/.test(value)) return "lte";
  if (/mayor|mas de|more than|above|>/.test(value)) return "gt";
  if (/menor|less than|below|<|bajo|low/.test(value)) return "lt";
  return "eq";
}

function normalizePercent(value: number, source: string) {
  return /%|por ciento|percent/.test(source) && value > 1 ? value / 100 : value;
}

function numberFromMatch(match: RegExpMatchArray | null) {
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function parseNumericAround(normalized: string, fieldPattern: string, sourceLabel: string, percent = false): NumericFilter | undefined {
  const fieldGroup = `(?:${fieldPattern})`;
  const after = normalized.match(new RegExp(`${fieldGroup}.{0,30}(>=|<=|>|<|mayor o igual|menor o igual|mayor|menor|mas de|more than|less than|below|bajo|low|above)\\s*(?:al|a|than)?\\s*(\\d+(?:[\\.,]\\d+)?)\\s*(%|por ciento|percent)?`));
  if (after) {
    const value = Number(after[2].replace(",", "."));
    return {
      operator: parseOperator(after[1]),
      value: percent ? normalizePercent(value, `${after[0]}${after[3] ?? ""}`) : value,
      source: sourceLabel
    };
  }

  const before = normalized.match(new RegExp(`(>=|<=|>|<|mayor o igual|menor o igual|mayor|menor|mas de|more than|less than|below|bajo|low|above)\\s*(?:al|a|than)?\\s*(\\d+(?:[\\.,]\\d+)?)\\s*(%|por ciento|percent)?.{0,30}${fieldGroup}`));
  if (before) {
    const value = Number(before[2].replace(",", "."));
    return {
      operator: parseOperator(before[1]),
      value: percent ? normalizePercent(value, `${before[0]}${before[3] ?? ""}`) : value,
      source: sourceLabel
    };
  }

  return undefined;
}

function extractMpn(query: string, normalized: string) {
  const explicit = query.match(/\b(?:mpn|part number|pn|p\/n|para|for)\s+([A-Z0-9][A-Z0-9._-]{3,})\b/i);
  if (explicit?.[1]) return explicit[1].toUpperCase();

  if (!/mpn|part number|pn|p\/n|precio|price|proveedor|supplier|compar/.test(normalized)) return undefined;

  const candidates = query.match(/\b[A-Z0-9][A-Z0-9._-]{4,}\b/g) ?? [];
  return candidates.find((candidate) => /[A-Z]/.test(candidate) && /\d/.test(candidate))?.toUpperCase();
}

function extractAfter(normalized: string, pattern: RegExp) {
  const match = normalized.match(pattern);
  return match?.[1]?.trim().replace(/[?.!,;:]+$/, "");
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function detectIntent(normalized: string): ExecutiveSearchIntent {
  if (/mejor precio|best price|compar|price comparison|proveedor tiene mejor precio/.test(normalized)) return "price_comparison";
  if (/error|errores|failed|fallid|comision/.test(normalized)) return "errors";
  if (/archivo|file|excel|upload|carga|subio|subido|dataset/.test(normalized)) return "uploads";
  if (/empleado|employee|usuario|user/.test(normalized)) return "users";
  if (/dashboard|resumen|metric|metrica|analytics|analitica/.test(normalized)) return "analytics";
  return "records";
}

export function parseExecutiveQuery(query: string, now = new Date()): ParsedExecutiveQuery {
  const originalQuery = query.trim();
  const normalizedQuery = normalizeText(originalQuery);
  const filters: ExecutiveSearchFilters = {};
  const detectedTerms: string[] = [];

  if (normalizedQuery) filters.text = originalQuery;

  const mpn = extractMpn(originalQuery, normalizedQuery);
  if (mpn) {
    filters.mpn = mpn;
    detectedTerms.push("mpn");
  }

  const po = originalQuery.match(/\bPO[-\s#:]*([A-Z0-9._-]{3,})\b/i)?.[1];
  if (po) {
    filters.po = po.toUpperCase();
    detectedTerms.push("po");
  }

  const customer =
    extractAfter(normalizedQuery, /\b(?:cliente|customer|client|po de|mpn de)\s+([\p{L}0-9 ._-]{2,40})/u) ??
    (/\btesla\b/.test(normalizedQuery) ? "tesla" : undefined);
  if (customer) {
    filters.customer = titleCase(customer.replace(/\b(con|with|gp|po|mpn|mayor|menor).*/i, "").trim());
    detectedTerms.push("customer");
  }

  const supplier = extractAfter(normalizedQuery, /\b(?:proveedor|supplier|vendor)\s+([\p{L}0-9 ._-]{2,40})/u);
  if (supplier && !/tiene mejor precio/.test(supplier)) {
    filters.supplier = titleCase(supplier.replace(/\b(con|with|gp|precio|price|lead).*/i, "").trim());
    detectedTerms.push("supplier");
  }

  const employee =
    extractAfter(normalizedQuery, /\b(?:subio|subido por|empleado|employee|usuario|user|by|from)\s+([\p{L} ._-]{2,40})/u) ??
    undefined;
  if (employee) {
    filters.employee = titleCase(employee.replace(/\b(esta semana|this week|hoy|ayer|este mes).*/i, "").trim());
    detectedTerms.push("employee");
  }

  const country = extractAfter(normalizedQuery, /\b(?:pais|country|china|colombia|usa|mexico|taiwan|vietnam)\b(?:\s+de|\s+from)?\s*([\p{L} ._-]{0,30})/u);
  if (/\bchina\b/.test(normalizedQuery)) {
    filters.country = "China";
    detectedTerms.push("country");
  } else if (country?.trim()) {
    filters.country = titleCase(country);
    detectedTerms.push("country");
  }

  const dateRange = parseRelativeDateRange(normalizedQuery, now);
  if (dateRange) {
    filters.dateRange = dateRange;
    detectedTerms.push("date_range");
  }

  const gpRate = parseNumericAround(normalizedQuery, "gp(?: rate)?|margen|margin", "gp_rate", true);
  if (gpRate) {
    filters.gpRate = gpRate;
    detectedTerms.push("gp_rate");
  }

  const price = parseNumericAround(normalizedQuery, "precio|price|cost|costo", "price");
  if (price) {
    filters.price = price;
    detectedTerms.push("price");
  }

  const qty = parseNumericAround(normalizedQuery, "cantidad|qty|stock|disponible|available", "qty");
  if (qty) {
    filters.qty = qty;
    detectedTerms.push("qty");
  }

  const lead = normalizedQuery.match(/lead time.{0,20}(menor|less than|<|<=)\s*(\d+(?:[\.,]\d+)?)\s*(dias|days|semanas|weeks)?/);
  const leadValue = numberFromMatch(lead ? ([lead[0], lead[2]] as unknown as RegExpMatchArray) : null);
  if (lead && leadValue !== null) {
    filters.leadTimeDays = {
      operator: parseOperator(lead[1]),
      value: /semana|week/.test(lead[3] ?? "") ? leadValue * 7 : leadValue,
      source: "lead_time_days"
    };
    detectedTerms.push("lead_time");
  }

  const uploadErrors = normalizedQuery.match(/(?:mas de|more than|>|mayor)\s*(\d+)\s*errores|errores\s*(?:>|mayor|mas de)\s*(\d+)/);
  const uploadErrorValue = Number(uploadErrors?.[1] ?? uploadErrors?.[2] ?? NaN);
  if (Number.isFinite(uploadErrorValue)) {
    filters.uploadErrorThreshold = { operator: "gt", value: uploadErrorValue, source: "upload_error_count" };
    detectedTerms.push("upload_error_threshold");
  }

  if (/sin mpn|missing mpn|no mpn/.test(normalizedQuery)) {
    filters.missingMpn = true;
    detectedTerms.push("missing_mpn");
  }

  if (/con errores|has errors|errores/.test(normalizedQuery)) {
    filters.hasErrors = true;
    detectedTerms.push("has_errors");
  }

  if (/comision|commission/.test(normalizedQuery)) {
    filters.errorField = "commission";
    filters.commission = true;
    detectedTerms.push("commission");
  }

  const category = CATEGORY_ALIASES.find(([alias]) => normalizedQuery.includes(alias))?.[1];
  if (category) {
    filters.category = category;
    detectedTerms.push("category");
  }

  if (/reciente|recent|ultimo|ultima|last/.test(normalizedQuery)) {
    filters.recentUploads = true;
    detectedTerms.push("recent_uploads");
  }

  const intent = detectIntent(normalizedQuery);
  const confidence = Math.min(0.95, 0.35 + detectedTerms.length * 0.1);

  return {
    originalQuery,
    normalizedQuery,
    intent,
    filters,
    confidence,
    detectedTerms
  };
}
