import type { JsonPrimitive, JsonRecord, PlatformRecordColumns } from "@/lib/types";
import type { ImportIssue } from "@/lib/excel/types";
import { normalizeHeader, toSnakeCase } from "@/lib/excel/header-detector";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";

const FORMULA_ERROR_RE = /^(#VALUE!|#REF!|#DIV\/0!|#N\/A|#NAME\?|#NUM!|#NULL!)$/i;
const FORMULA_INJECTION_RE = /^[=+\-@]/;

const FIELD_ALIASES: Record<keyof PlatformRecordColumns, string[]> = {
  line_id: ["line id", "line", "line_id"],
  client: ["client id", "client code"],
  customer: ["customer", "cliente", "client", "sanm unico"],
  supplier: ["supplier", "vendor"],
  supplier_name: ["supplier name", "supplier", "vendor name"],
  mpn: [
    "mpn",
    "part number",
    "part no",
    "part no.",
    "pn",
    "p/n",
    "manufacturer part number",
    "mfr part number",
    "mfg part number",
    "item number",
    "component",
    "clean mpn"
  ],
  mpn_quoted: ["mpn quoted", "quoted mpn"],
  manufacturer: ["manufacturer", "manufacturer quoted", "mfg", "brand"],
  clean_mfg: ["clean mfg", "clean manufacturer", "mfg clean"],
  description: ["description", "desc"],
  generic: ["generic", "generic category"],
  po: ["po", "purchase order"],
  qty: ["qty", "quantity", "qtty", "delivery qto", "qty order wks 1 13"],
  req_qty: ["req qty", "required qty", "request qty"],
  cost: ["cost", "unit cost", "product cost"],
  price: ["price", "unit price", "selling price"],
  total_price: ["total price", "total sale", "amount"],
  gp_rate: ["gp rate", "gross profit rate", "margin rate"],
  gp: ["gp", "gross profit"],
  commission: ["commission", "comision"],
  potential_amount_usd: ["potential amount usd", "potential_amount_usd", "potential amount"],
  target_to_vendor: ["target to vendor", "target_to_vendor"],
  best_price_offered: ["best price offered", "best price", "offered price"],
  date_code: ["date code", "dc"],
  moq: ["moq"],
  spq: ["spq"],
  on_hand: ["on hand", "stock", "inventory"],
  lead_time_weeks: ["lead time wks", "lead time weeks", "lead time"],
  transit_time_weeks: ["transit time wks", "transit time weeks", "transit time"],
  earliest_shipping_date: ["earliest shipping date", "shipping date"],
  shipping_point_country: ["shipping point country", "shipping point", "origin country"],
  delivery_point: ["delivery point", "delivery location", "destination"],
  comments: ["comments", "comment", "notes"]
};

const NUMERIC_FIELDS = new Set<keyof PlatformRecordColumns>([
  "qty",
  "req_qty",
  "cost",
  "price",
  "total_price",
  "gp_rate",
  "gp",
  "commission",
  "potential_amount_usd",
  "target_to_vendor",
  "best_price_offered",
  "moq",
  "spq",
  "on_hand",
  "lead_time_weeks",
  "transit_time_weeks"
]);

const DATE_FIELDS = new Set<keyof PlatformRecordColumns>(["earliest_shipping_date"]);

export function sanitizeScalar(value: unknown): JsonPrimitive {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return value;

  const text = String(value).replace(/\u0000/g, "").trim();
  if (!text) return null;
  if (FORMULA_INJECTION_RE.test(text)) return `'${text}`;
  return text;
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const normalized = value
    .replace(/\u00a0/g, " ")
    .replace(/[%,$]/g, "")
    .replace(/\s/g, "")
    .replace(/,(?=\d{3}(\D|$))/g, "");
  const numberValue = Number(normalized);

  if (!Number.isFinite(numberValue)) return null;
  return /%/.test(value) && numberValue > 1 ? numberValue / 100 : numberValue;
}

export function parseDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number" && value > 25569 && value < 80000) {
    const date = new Date((value - 25569) * 86400 * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function aliasesForHeader(header: string) {
  const normalized = normalizeHeader(header);

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
      return field as keyof PlatformRecordColumns;
    }
  }

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(normalizeHeader(alias)))) {
      return field as keyof PlatformRecordColumns;
    }
  }

  return null;
}

function findRawValueByAliases(rawData: JsonRecord, aliases: string[]) {
  for (const [header, value] of Object.entries(rawData)) {
    const normalizedHeader = normalizeHeader(header);
    if (
      aliases.some((alias) => {
        const normalizedAlias = normalizeHeader(alias);
        return normalizedHeader === normalizedAlias || normalizedHeader.includes(normalizedAlias);
      })
    ) {
      const safeValue = sanitizeScalar(value);
      if (safeValue !== null && safeValue !== "") return safeValue;
    }
  }
  return null;
}

export function normalizeRow(rawData: JsonRecord, context?: LogContext) {
  const normalizedData: JsonRecord = {};
  const columns: PlatformRecordColumns = {};
  const issues: ImportIssue[] = [];
  const unmappedHeaders: string[] = [];

  if (context) {
    void logger.debug({
      ...context,
      module: "normalizer",
      action: "normalization_started",
      message: "Row normalization started.",
      status: "started",
      metadata: { columnCount: Object.keys(rawData).length }
    });
  }

  for (const [header, value] of Object.entries(rawData)) {
    const snakeHeader = toSnakeCase(header);
    const safeValue = sanitizeScalar(value);
    normalizedData[snakeHeader] = safeValue;

    if (typeof safeValue === "string" && FORMULA_ERROR_RE.test(safeValue)) {
      issues.push({
        columnName: header,
        errorType: "formula_error",
        message: `Excel formula error detected in ${header}.`,
        rawValue: safeValue,
        severity: "high"
      });
      continue;
    }

    const field = aliasesForHeader(header);
    if (!field) {
      unmappedHeaders.push(header);
      if (context) {
        void logger.debug({
          ...context,
          module: "normalizer",
          action: "unknown_column_detected",
          message: "Unknown column preserved in raw data.",
          status: "completed",
          columnName: header
        });
      }
      continue;
    }

    if (context) {
      void logger.debug({
        ...context,
        module: "normalizer",
        action: "column_mapping_detected",
        message: "Column mapping detected.",
        status: "completed",
        columnName: header,
        metadata: { normalizedField: field }
      });
    }

    if (NUMERIC_FIELDS.has(field)) {
      const parsed = parseNumber(value);
      if (value !== null && value !== undefined && value !== "" && parsed === null) {
        issues.push({
          columnName: header,
          errorType: "invalid_number",
          message: `${header} should be numeric.`,
          rawValue: String(value),
          severity: "medium"
        });
        if (context) {
          void logger.warn({
            ...context,
            module: "normalizer",
            action: "numeric_conversion_failed",
            message: "Numeric conversion failed.",
            status: "failed",
            columnName: header,
            metadata: { expectedType: "number", normalizedField: field, rawValue: value }
          });
        }
      }
      (columns as Record<string, unknown>)[field] = parsed;
      normalizedData[field] = parsed;
      continue;
    }

    if (DATE_FIELDS.has(field)) {
      const parsed = parseDate(value);
      if (value !== null && value !== undefined && value !== "" && parsed === null) {
        issues.push({
          columnName: header,
          errorType: "invalid_date",
          message: `${header} should be a date.`,
          rawValue: String(value),
          severity: "medium"
        });
        if (context) {
          void logger.warn({
            ...context,
            module: "normalizer",
            action: "date_conversion_failed",
            message: "Date conversion failed.",
            status: "failed",
            columnName: header,
            metadata: { expectedType: "date", normalizedField: field, rawValue: value }
          });
        }
      }
      (columns as Record<string, unknown>)[field] = parsed;
      normalizedData[field] = parsed;
      continue;
    }

    (columns as Record<string, unknown>)[field] = safeValue;
    normalizedData[field] = safeValue;
  }

  if (unmappedHeaders.length) {
    issues.push({
      errorType: "unrecognized_columns",
      message: `${unmappedHeaders.length} columns were preserved as raw data but not mapped.`,
      rawValue: unmappedHeaders.slice(0, 10).join(", "),
      severity: "low"
    });
  }

  if (!columns.mpn) {
    const fallbackMpn =
      columns.mpn_quoted ??
      findRawValueByAliases(rawData, [
        "MPN",
        "Part Number",
        "PN",
        "P/N",
        "Manufacturer Part Number",
        "Mfr Part Number",
        "MFG Part Number",
        "Part No",
        "Item Number",
        "Component",
        "Clean MPN",
        "MPN Quoted"
      ]);

    if (fallbackMpn !== null) {
      columns.mpn = String(fallbackMpn);
      normalizedData.mpn = String(fallbackMpn);
    } else {
      columns.mpn = null;
      normalizedData.mpn = null;
    }
  }

  if (context) {
    void logger.debug({
      ...context,
      module: "normalizer",
      action: "normalization_completed",
      message: "Row normalization completed.",
      status: "completed",
      metadata: {
        mappedColumns: Object.keys(columns).length,
        issueCount: issues.length
      }
    });
  }

  return {
    normalizedData,
    columns,
    issues
  };
}

export function buildSearchableText(input: {
  rawData: JsonRecord;
  normalizedData: JsonRecord;
  category: string;
  employeeName?: string;
  employeeEmail?: string;
}) {
  return [
    input.category,
    input.employeeName,
    input.employeeEmail,
    ...Object.values(input.rawData),
    ...Object.values(input.normalizedData)
  ]
    .flat()
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}
