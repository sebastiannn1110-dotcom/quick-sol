import {
  findSafeOpportunityUnitColumn,
  normalizeOpportunityHeader,
  OPPORTUNITY_HEADER_ALIASES,
  OPPORTUNITY_QUANTITY_HEADER_ALIASES,
  OPPORTUNITY_STRUCTURAL_HEADER_ALIASES,
  opportunityHeaderHasAlias
} from "@/lib/opportunity-finder/aliases";
import type {
  OpportunityFileType,
  OpportunitySheetProfile,
  OpportunityWorkbookProfile
} from "@/lib/opportunity-finder/types";

const STRUCTURAL_HEADER_TERMS = new Set([
  ...OPPORTUNITY_STRUCTURAL_HEADER_ALIASES,
  "item",
  "item number",
  "source control",
  "sourcecontrol",
  "open balance",
  "credit limit",
  "due date",
  "sales person",
  "unit price",
  "unit cost",
  "gp",
  "g p",
  "description",
  "pdl"
]);

function compactHeader(value: unknown) {
  return normalizeOpportunityHeader(value);
}

function headerMatchesTerm(header: string, term: string) {
  return header === term || header.includes(term);
}

export function opportunityHeaderScore(cells: unknown[]) {
  const headers = cells.map(compactHeader).filter(Boolean);
  const recognized = headers.filter((header) =>
    Array.from(STRUCTURAL_HEADER_TERMS).some((term) => headerMatchesTerm(header, term)) ||
    findSafeOpportunityUnitColumn([header]) === 0
  );
  const hasMpn = opportunityHeaderHasAlias(headers, OPPORTUNITY_HEADER_ALIASES.mpn);
  const hasQuantity = opportunityHeaderHasAlias(headers, OPPORTUNITY_QUANTITY_HEADER_ALIASES);
  const duplicatePenalty = headers.length - new Set(headers).size;
  return {
    headers: cells.map((value) => String(value ?? "").trim()).filter(Boolean),
    normalizedHeaders: headers,
    recognizedCount: recognized.length,
    score: recognized.length * 4 + Math.min(headers.length, 24) + (hasMpn && hasQuantity ? 8 : 0) - duplicatePenalty,
    isHeader: recognized.length >= 2 || (hasMpn && hasQuantity)
  };
}

function allNormalizedHeaders(sheets: OpportunitySheetProfile[]) {
  return sheets.flatMap((sheet) =>
    sheet.headerRows.flatMap((header) => header.headers.map(compactHeader))
  );
}

function has(headers: string[], ...terms: string[]) {
  return terms.some((term) => headers.some((header) => headerMatchesTerm(header, term)));
}

function count(headers: string[], terms: string[]) {
  return terms.filter((term) => has(headers, term)).length;
}

function hasAliases(headers: string[], aliases: readonly string[]) {
  return opportunityHeaderHasAlias(headers, aliases);
}

export function classifyOpportunityWorkbook(input: {
  fileName: string;
  sheets: OpportunitySheetProfile[];
  rowCount: number;
}): OpportunityWorkbookProfile {
  const headers = allNormalizedHeaders(input.sheets);
  const sheetNames = input.sheets.map((sheet) => normalizeOpportunityHeader(sheet.sheetName));
  const fileName = normalizeOpportunityHeader(input.fileName);
  const scores = new Map<OpportunityFileType, number>([
    ["demand", 0],
    ["stock", 0],
    ["excess", 0],
    ["supplier_offer", 0],
    ["received_history", 0],
    ["sales_history", 0],
    ["financial", 0],
    ["unknown", 0]
  ]);
  const reasons = new Map<OpportunityFileType, string[]>();

  function add(type: OpportunityFileType, points: number, reason: string) {
    scores.set(type, (scores.get(type) ?? 0) + points);
    reasons.set(type, [...(reasons.get(type) ?? []), reason]);
  }

  if (
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.primaryMpn) &&
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.stockQuantity)
  ) {
    add("stock", 18, "mpn_and_stock_qty");
  }
  if (
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.stockManufacturer) &&
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.stockQuantity)
  ) {
    add("stock", 6, "stock_manufacturer_columns");
  }
  if (sheetNames.some((name) => /\bstock|inventory\b/.test(name))) add("stock", 3, "inventory_sheet_name");

  const explicitExcessColumns =
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.primaryMpn) &&
    has(headers, "maker") &&
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.excessQuantity);
  if (explicitExcessColumns && /\bexcess|surplus|overstock\b/.test(fileName)) {
    add("excess", 24, "explicit_excess_file_and_columns");
  } else if (explicitExcessColumns) {
    add("excess", 6, "possible_excess_columns_without_explicit_context");
  }

  if (
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.requiredDate) &&
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.demandQuantity) &&
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.primaryMpn)
  ) {
    add("demand", 16, "planned_demand_columns");
  }
  if (count(headers, ["sourcecontrol", "source control", "bpname", "requi", "startdate"]) >= 3) {
    add("demand", 10, "planning_context_columns");
  }
  if (sheetNames.some((name) => /\bplanned|demand|requirements?\b/.test(name))) add("demand", 4, "demand_sheet_name");

  const supplierMpn = hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.supplierOfferMpn);
  const supplierQty = hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.supplierQuantity);
  if (supplierMpn && supplierQty && count(headers, ["brand", "pdl", "list", "description", "price"]) >= 2) {
    add("supplier_offer", 16, "catalog_offer_columns");
  }
  if (input.sheets.length >= 3 && supplierMpn && supplierQty) add("supplier_offer", 5, "multi_sheet_offer");

  if (
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.receivedMpn) &&
    hasAliases(headers, OPPORTUNITY_HEADER_ALIASES.receivedQuantity)
  ) {
    add("received_history", 20, "receipt_history_columns");
  }
  if (count(headers, ["global supplier name", "global customer name", "usd extended price"]) >= 2) {
    add("received_history", 7, "actual_spend_context");
  }

  if (has(headers, "sales person") && has(headers, "item") && count(headers, ["unit price", "unit cost", "sales", "cost", "g p"]) >= 2) {
    add("sales_history", 20, "sales_report_columns");
  }
  if (headers.filter((header) => header === "sales person").length >= 2) add("sales_history", 4, "multiple_sales_tables");

  if (has(headers, "open balance") && count(headers, ["customer", "credit limit", "due date", "invoice", "total"]) >= 2) {
    add("financial", 24, "aging_financial_columns");
  }
  if (sheetNames.some((name) => /\baging|financial|receivable\b/.test(name))) add("financial", 6, "financial_sheet_name");

  const ranked = Array.from(scores.entries())
    .filter(([type]) => type !== "unknown")
    .sort((left, right) => right[1] - left[1]);
  const [winner, runnerUp] = ranked;
  const detectedType =
    !winner || winner[1] < 10 || (runnerUp && winner[1] - runnerUp[1] < 3)
      ? "unknown"
      : winner[0];
  const classificationScore = detectedType === "unknown" ? winner?.[1] ?? 0 : winner[1];

  return {
    fileName: input.fileName,
    sheetCount: input.sheets.length,
    rowCount: input.rowCount,
    detectedType,
    classificationScore,
    classificationReasons:
      detectedType === "unknown"
        ? ["insufficient_or_ambiguous_structure"]
        : (reasons.get(detectedType) ?? []).slice(0, 6),
    sheets: input.sheets
  };
}
