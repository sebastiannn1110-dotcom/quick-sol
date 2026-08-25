import type { AiToolResult } from "@/lib/ai/database-tools";

export type ToolSourceType =
  | "authorized_database"
  | "stock_needs"
  | "opportunity_finder"
  | "historical_opportunities"
  | "upload_metadata"
  | "assistant_policy";

export interface ToolEvidence {
  sourceType: ToolSourceType;
  rowCount: number;
  truncated: boolean;
  deterministic: boolean;
}

export interface ToolPublicResult {
  ok: boolean;
  tool: string;
  scope: "own" | "team" | "company";
  total: number;
  summary: string;
  warning?: string;
  evidence: ToolEvidence;
}

export interface ToolLlmContext {
  tool: string;
  scope: "own" | "team" | "company";
  total: number;
  truncated: boolean;
  evidence: ToolEvidence;
  data: unknown;
  droppedFieldCount: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, max = 120) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function compactObject(value: JsonRecord) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function safeRecordRow(value: unknown) {
  const row = record(value);
  return compactObject({
    category: text(row.category, 60),
    mpn: text(row.mpn, 80),
    mpnQuoted: text(row.mpn_quoted, 80),
    quantity: numberValue(row.qty),
    hasErrors: booleanValue(row.has_errors),
    createdAt: text(row.created_at, 40)
  });
}

function safeUploadRow(value: unknown) {
  const row = record(value);
  return compactObject({
    status: text(row.status, 40),
    detectedCategory: text(row.detected_category, 60),
    selectedCategory: text(row.selected_category, 60),
    fileType: text(row.file_type, 30),
    totalRows: numberValue(row.total_rows),
    validRows: numberValue(row.valid_rows),
    successfulRows: numberValue(row.successful_rows),
    failedRows: numberValue(row.failed_rows),
    warningCount: numberValue(row.warning_count),
    rowsWithWarnings: numberValue(row.rows_with_warnings),
    technicalErrorCount: numberValue(row.technical_error_count),
    dataQualityScore: numberValue(row.data_quality_score),
    createdAt: text(row.created_at, 40)
  });
}

function safeStockItem(value: unknown) {
  const row = record(value);
  return compactObject({
    mpn: text(row.mpn, 80),
    requiredQty: numberValue(row.requiredQty),
    stockQty: numberValue(row.stockQty),
    availableQty: numberValue(row.availableQty),
    shortageQty: numberValue(row.shortageQty),
    coverageStatus: text(row.coverageStatus, 40),
    requiredDate: text(row.requiredDate, 40),
    leadTime: text(row.leadTime, 40),
    warningCodes: array(row.warnings).map((item) => text(item, 60)).filter(Boolean).slice(0, 8)
  });
}

function safeOpportunityItem(value: unknown) {
  const row = record(value);
  return compactObject({
    mpn: text(row.mpn ?? row.displayMpn, 80),
    opportunityType: text(row.opportunityType, 50),
    exactMpnMatch: booleanValue(row.exactMpnMatch ?? row.exactMatch),
    usableAvailabilityMatch: booleanValue(row.usableAvailabilityMatch),
    exactQuantityMatch: booleanValue(row.exactQuantityMatch),
    requiredQty: numberValue(row.requiredQty),
    availableQty: numberValue(row.availableQty),
    allocatedQty: numberValue(row.allocatedQty),
    shortageQty: numberValue(row.shortageQty),
    coveragePercent: numberValue(row.coveragePercent),
    confidenceLabel: text(row.confidenceLabel, 20),
    warningCodes: array(row.warnings ?? row.dataQualityFlags)
      .map((item) => text(item, 60))
      .filter(Boolean)
      .slice(0, 8)
  });
}

function safeTotals(value: unknown) {
  const source = record(value);
  const allowedKeys = new Set([
    "totalItems",
    "inStock",
    "partialStock",
    "noStock",
    "overstock",
    "unknown",
    "totalRequiredQty",
    "totalStockQty",
    "totalOpportunities",
    "immediateSale",
    "partialSale",
    "excessResale",
    "sourcingNeeded",
    "stockWithoutDemand",
    "approvedPartMatches",
    "receivedHistoryMatches",
    "highConfidence",
    "mediumConfidence",
    "lowConfidence",
    "analyzedMpns",
    "exactMatches",
    "usableAvailabilityMatches",
    "exactQuantityMatches",
    "fullSales",
    "partialSales",
    "supplyWithoutDemand",
    "reviewRequired",
    "missingMpnRows",
    "invalidQuantityRows",
    "possibleMatches"
  ]);
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key, item]) => allowedKeys.has(key) && typeof item === "number" && Number.isFinite(item))
  );
}

function safeMeta(value: unknown) {
  const source = record(value);
  return compactObject({
    returnedItems: numberValue(source.returnedItems),
    scannedRecords: numberValue(source.scannedRecords),
    scannedUploads: numberValue(source.scannedUploads),
    totalBeforePagination: numberValue(source.totalBeforePagination),
    hasMissingProfiles: booleanValue(source.hasMissingProfiles),
    confidenceTruncated: booleanValue(source.confidenceTruncated),
    pipelineCompatible: booleanValue(source.pipelineCompatible)
  });
}

function safeImportError(value: unknown) {
  const row = record(value);
  return compactObject({
    rowIndex: numberValue(row.row_index),
    columnName: text(row.column_name, 80),
    errorType: text(row.error_type, 60),
    severity: text(row.severity, 20),
    createdAt: text(row.created_at, 40)
  });
}

function safeProfile(value: unknown) {
  const row = record(value);
  return compactObject({
    columnCount: numberValue(row.columnCount),
    detectedTemplate: text(row.detectedTemplate, 60),
    confidenceScore: numberValue(row.confidenceScore)
  });
}

function safeDashboard(value: unknown) {
  const source = record(value);
  return compactObject({
    totalRecords: numberValue(source.totalRecords),
    totalUploads: numberValue(source.totalUploads),
    recordsWithErrors: numberValue(source.recordsWithErrors),
    recordsMissingMpn: numberValue(source.recordsMissingMpn),
    latestUpload: safeUploadRow(source.latestUpload)
  });
}

function safeToolData(tool: string, value: unknown): unknown {
  const source = record(value);
  switch (tool) {
    case "sensitiveDataPermissionDenied":
    case "policySafetyBoundary":
    case "clarificationRequired":
    case "getAssistantHelp":
    case "getOpportunityFinderHelp":
    case "getStockConceptHelp":
      return { reasonCode: text(source.reason ?? source.reasonCode, 60) };
    case "getAssistantSourceHelp":
      return {
        sourceType: "stock_needs",
        sourceLabel: "Stock Needs",
        basedOnAuthorizedData: true,
        deterministicOrLlm: "deterministic"
      };
    case "conversationMemorySet":
    case "conversationMemoryRecall":
      return { mpn: text(source.mpn, 80) };
    case "getUploadPresentationSummary":
      return {
        uploads: array(source.uploads).map(safeUploadRow).slice(0, 3),
        profiles: array(source.profiles).map(safeProfile).slice(0, 3),
        safeColumns: array(source.safeColumns).map((item) => text(item, 80)).filter(Boolean).slice(0, 30)
      };
    case "getStockNeedsSummary":
    case "getStockShortageSummary":
    case "getZeroStockSummary":
      return {
        items: array(source.items).map(safeStockItem).slice(0, 10),
        totals: safeTotals(source.totals),
        meta: safeMeta(source.meta)
      };
    case "getOpportunitiesSummary":
    case "getOpportunityFinderSummary":
      return {
        items: array(source.items).map(safeOpportunityItem).slice(0, 10),
        totals: safeTotals(source.totals ?? source.summary),
        meta: safeMeta(source.meta)
      };
    case "getOpportunityFinderItemDetail":
      return {
        mpn: text(source.mpn, 80),
        item: safeOpportunityItem(source.item)
      };
    case "getLatestUpload":
      return safeUploadRow(value);
    case "searchBusinessRecords":
    case "getRecordsByMpn":
    case "getMissingMpnRecords":
      return array(value).map(safeRecordRow).slice(0, 50);
    case "getUploadsByUser":
    case "getEmployeeSummary":
      return Array.isArray(value)
        ? array(value).map(safeUploadRow).slice(0, 50)
        : { uploads: array(source.uploads).map(safeUploadRow).slice(0, 50) };
    case "getImportErrors":
      return array(value).map(safeImportError).slice(0, 50);
    case "getDashboardSummary":
      return safeDashboard(value);
    case "getMpnPriceComparison":
    case "getLowGpRecords":
      return { reasonCode: "sensitive_fields_restricted" };
    default:
      return {};
  }
}

function countFields(value: unknown, depth = 0): number {
  if (depth > 6 || value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countFields(item, depth + 1), 0);
  if (typeof value !== "object") return 0;
  return Object.entries(value as JsonRecord).reduce(
    (sum, [, item]) => sum + 1 + countFields(item, depth + 1),
    0
  );
}

function sourceTypeForTool(tool: string): ToolSourceType {
  if (
    [
      "getStockNeedsSummary",
      "getStockShortageSummary",
      "getZeroStockSummary",
      "getAssistantSourceHelp"
    ].includes(tool)
  ) return "stock_needs";
  if (
    [
      "getOpportunityFinderSummary",
      "getOpportunityFinderItemDetail",
      "getOpportunityFinderHelp"
    ].includes(tool)
  ) return "opportunity_finder";
  if (tool === "getOpportunitiesSummary") return "historical_opportunities";
  if (tool === "getUploadPresentationSummary" || tool === "getLatestUpload") return "upload_metadata";
  if (
    [
      "sensitiveDataPermissionDenied",
      "policySafetyBoundary",
      "clarificationRequired",
      "getAssistantHelp",
      "getStockConceptHelp",
      "conversationMemorySet",
      "conversationMemoryRecall"
    ].includes(tool)
  ) return "assistant_policy";
  return "authorized_database";
}

export function toolEvidence(toolResult: Pick<AiToolResult, "tool" | "total" | "rows" | "truncated" | "deterministic">): ToolEvidence {
  return {
    sourceType: sourceTypeForTool(toolResult.tool),
    rowCount: Number(toolResult.total ?? toolResult.rows?.length ?? 0),
    truncated: Boolean(toolResult.truncated),
    deterministic: Boolean(toolResult.deterministic)
  };
}

export function sanitizeToolResultForLlm(toolResult: AiToolResult): ToolLlmContext {
  const data = safeToolData(toolResult.tool, toolResult.data);
  return {
    tool: toolResult.tool,
    scope: toolResult.scope,
    total: Number(toolResult.total ?? toolResult.rows?.length ?? 0),
    truncated: Boolean(toolResult.truncated),
    evidence: toolEvidence(toolResult),
    data,
    droppedFieldCount: Math.max(0, countFields(toolResult.data) - countFields(data))
  };
}

export function publicToolResult(toolResult: AiToolResult | null): ToolPublicResult | null {
  if (!toolResult) return null;
  return {
    ok: toolResult.ok,
    tool: toolResult.tool,
    scope: toolResult.scope,
    total: Number(toolResult.total ?? toolResult.rows?.length ?? 0),
    summary: "",
    evidence: toolEvidence(toolResult)
  };
}
