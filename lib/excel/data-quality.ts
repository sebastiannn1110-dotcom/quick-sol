import type { ImportIssue, ParsedExcelRecord } from "@/lib/excel/types";
import type { PlatformRecordColumns } from "@/lib/types";

const REQUIRED_BY_CATEGORY: Record<string, (keyof PlatformRecordColumns)[]> = {
  "Sales Margin": ["customer", "supplier", "mpn", "qty", "cost", "price", "gp_rate"],
  RFQ: ["customer", "line_id", "req_qty", "potential_amount_usd"],
  "Customer Demand": ["customer", "req_qty", "description"],
  "Supplier Offers": ["supplier_name", "mpn_quoted", "best_price_offered", "moq"],
  Logistics: ["lead_time_weeks", "transit_time_weeks", "shipping_point_country", "delivery_point"],
  Inventory: ["mpn", "manufacturer", "qty"],
  Finance: ["cost", "price", "gp", "commission"],
  Quality: ["mpn", "supplier"],
  Generic: []
};

function isMissing(value: unknown) {
  return value === null || value === undefined || value === "";
}

export function detectRowQualityIssues(
  category: string,
  columns: PlatformRecordColumns
): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const requiredFields = REQUIRED_BY_CATEGORY[category] ?? [];

  for (const field of requiredFields) {
    if (isMissing(columns[field])) {
      issues.push({
        columnName: field,
        errorType: "missing_required_field",
        message: `${field} is important for ${category} records.`,
        severity: "medium"
      });
    }
  }

  if (columns.gp_rate !== null && columns.gp_rate !== undefined) {
    const gpRate = Number(columns.gp_rate);
    if (!Number.isFinite(gpRate) || gpRate < -1 || gpRate > 1) {
      issues.push({
        columnName: "gp_rate",
        errorType: "invalid_gp_rate",
        message: "GP rate should be a decimal percentage between -1 and 1.",
        rawValue: String(columns.gp_rate),
        severity: "medium"
      });
    }
  }

  for (const field of ["qty", "req_qty", "cost", "price"] as const) {
    const value = columns[field];
    if (value !== null && value !== undefined && Number(value) < 0) {
      issues.push({
        columnName: field,
        errorType: "negative_number",
        message: `${field} should not be negative.`,
        rawValue: String(value),
        severity: "medium"
      });
    }
  }

  return issues;
}

export function markDuplicateRecords(records: ParsedExcelRecord[]) {
  const seen = new Map<string, ParsedExcelRecord>();

  records.forEach((record) => {
    const key = [
      record.columns.customer,
      record.columns.supplier ?? record.columns.supplier_name,
      record.columns.mpn ?? record.columns.mpn_quoted,
      record.columns.po,
      record.columns.qty ?? record.columns.req_qty
    ]
      .filter(Boolean)
      .join("|")
      .toLowerCase();

    if (!key || key.split("|").length < 3) return;

    const first = seen.get(key);
    if (!first) {
      seen.set(key, record);
      return;
    }

    const issue: ImportIssue = {
      errorType: "duplicate_record",
      message: "Possible duplicate by customer + supplier + MPN + PO + quantity.",
      rawValue: key,
      severity: "medium"
    };
    record.errors.push(issue);
    record.hasErrors = true;
    first.errors.push(issue);
    first.hasErrors = true;
  });
}

export function calculateDataQualityScore(records: ParsedExcelRecord[]) {
  if (!records.length) return 0;

  const totalPenalty = records.reduce((sum, record) => {
    const rowPenalty = record.errors.reduce((rowSum, issue) => {
      if (issue.severity === "critical") return rowSum + 30;
      if (issue.severity === "high") return rowSum + 20;
      if (issue.severity === "medium") return rowSum + 10;
      return rowSum + 3;
    }, 0);
    return sum + Math.min(60, rowPenalty);
  }, 0);

  const maxPenalty = records.length * 60;
  return Math.max(0, Math.round(100 - (totalPenalty / maxPenalty) * 100));
}
