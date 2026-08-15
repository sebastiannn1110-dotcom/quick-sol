export type OpportunityFileType =
  | "demand"
  | "stock"
  | "excess"
  | "supplier_offer"
  | "received_history"
  | "purchase_history"
  | "quote_history"
  | "sales_history"
  | "financial"
  | "unknown";

export type OpportunitySelectedRole =
  | "demand"
  | "stock"
  | "excess"
  | "supplier_offer"
  | "received_history"
  | "purchase_history"
  | "quote_history"
  | "sales_history"
  | "ignore";

export type OpportunityComparisonMode = "single_file" | "two_files";
export type OpportunityDatasetScope = "own" | "team" | "company";

export type OpportunityJobStatus =
  | "uploading"
  | "queued"
  | "profiling"
  | "awaiting_roles"
  | "parsing"
  | "matching"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "cancelled";

export type OpportunityJobStage =
  | "uploading"
  | "inspecting_sheets"
  | "detecting_headers"
  | "confirming_roles"
  | "normalizing_mpn"
  | "grouping_quantities"
  | "finding_matches"
  | "generating_opportunities"
  | "completed";

export type OpportunityType =
  | "full_sale"
  | "partial_sale"
  | "sourcing_needed"
  | "excess_resale"
  | "supplier_offer_match"
  | "supply_without_demand"
  | "historical_signal"
  | "review_required";

export type OpportunityReasonCode =
  | "full_coverage"
  | "partial_coverage"
  | "no_available_supply"
  | "excess_covers_demand"
  | "supplier_offer_available"
  | "historical_match_only"
  | "manufacturer_conflict"
  | "manufacturer_alias_review"
  | "manufacturer_missing"
  | "symbol_variant"
  | "missing_unit"
  | "incompatible_unit"
  | "invalid_quantity"
  | "moq_not_met"
  | "spq_not_feasible"
  | "offer_not_live"
  | "currency_unconfirmed"
  | "supply_has_no_demand";

export type OpportunityActionCode =
  | "offer_full_quantity"
  | "offer_available_quantity"
  | "source_remaining_quantity"
  | "contact_supplier"
  | "find_buyer"
  | "review_manufacturer"
  | "review_quantity"
  | "review_terms"
  | "review_candidate"
  | "upload_current_stock";

export type OpportunityWarningCode =
  | "manufacturer_conflict"
  | "manufacturer_alias_requires_review"
  | "manufacturer_missing"
  | "missing_unit"
  | "incompatible_unit"
  | "invalid_required_quantity"
  | "invalid_available_quantity"
  | "negative_available_quantity"
  | "multiple_manufacturers"
  | "historical_not_current_stock"
  | "ambiguous_date"
  | "excel_error_value"
  | "formula_ignored"
  | "formula_cached_value_used"
  | "currency_missing"
  | "currency_invalid"
  | "offer_expired"
  | "offer_validity_unknown"
  | "moq_not_met"
  | "spq_adjusted"
  | "spq_not_feasible"
  | "hidden_source_row"
  | "shifted_column_mapping"
  | "unconfirmed_mapping";

export type OpportunityTemplateType =
  | "sanmina_spotbuys"
  | "sanmina_asia_rfq"
  | "flex_shortage"
  | "flex_shortage_shifted_offer"
  | "flex_week_27_rfq"
  | "flex_week_28_rfq"
  | "flex_purchase_cube"
  | "quote_database"
  | "generic";

export type OpportunityConfidence = "high" | "medium" | "low" | "review";
export type OpportunityReviewStatus = "not_required" | "pending" | "approved" | "rejected";
export type OpportunityMatchTier =
  | "exact_mpn_mfg"
  | "exact_mpn_mfg_missing"
  | "exact_mpn_approved_alias"
  | "search_mpn_mfg"
  | "exact_mpn_mfg_conflict";

export interface OpportunityColumnMapping {
  canonicalField: string;
  sourceHeader: string;
  sourceColumn: string;
  confidence: OpportunityConfidence;
  mappingVersion: string;
}

export interface OpportunityPreviewRow {
  rowNumber: number;
  hidden: boolean;
  values: Record<string, string>;
}

export interface OpportunitySheetProfile {
  sheetName: string;
  /** Non-empty rows, not the styled Excel dimension. */
  rowCount: number;
  usefulRowCount?: number;
  hiddenRowCount?: number;
  autoFilterRef?: string | null;
  headerRows: Array<{
    rowNumber: number;
    headers: string[];
    normalizedHeaders?: string[];
    columnMappings?: OpportunityColumnMapping[];
  }>;
  previewRows?: OpportunityPreviewRow[];
  warnings?: string[];
  errors?: string[];
}

export interface OpportunityWorkbookProfile {
  fileName: string;
  sheetCount: number;
  rowCount: number;
  usefulRowCount?: number;
  hiddenRowCount?: number;
  detectedType: OpportunityFileType;
  classificationScore: number;
  classificationConfidence?: OpportunityConfidence;
  classificationReasons: string[];
  templateType?: OpportunityTemplateType;
  mappingVersion?: string;
  adapterAmbiguous?: boolean;
  adapterCandidates?: OpportunityTemplateType[];
  adapterEvidence?: string[];
  columnMappings?: OpportunityColumnMapping[];
  warnings?: string[];
  errors?: string[];
  sheets: OpportunitySheetProfile[];
}

export interface OpportunityFileDescriptor {
  id: string;
  jobId: string;
  side: "A" | "B";
  originalFileName: string;
  sizeBytes: number;
  mimeType: string | null;
  detectedType: OpportunityFileType;
  selectedRole: OpportunitySelectedRole | null;
  sheetCount: number;
  rowCount: number;
  parseStatus: string;
  contentSha256?: string | null;
  tenantId?: string | null;
  sourceKind?: "uploaded" | "platform_snapshot";
}

export interface OpportunitySourceTrace {
  fileId: string;
  fileName: string;
  sheetName: string;
  sourceRow: number;
  hidden: boolean;
  headerRow: number | null;
  columns: Record<string, string>;
  originalIndex?: number;
  demandEventKey?: string | null;
  demandOptionId?: string | null;
  optionOrdinal?: number | null;
  supplyLotKey?: string | null;
  supplyLotId?: string | null;
}

export interface CanonicalOpportunityRow {
  id?: string;
  jobId: string;
  fileId: string;
  side: "A" | "B";
  fileName: string;
  sheetName: string;
  sourceRow: number;
  originalIndex: number;
  recordRole: OpportunitySelectedRole;
  recordKind?: "demand_option" | "supply_lot" | "historical_signal";
  templateType?: OpportunityTemplateType;
  mappingVersion?: string;
  headerRow?: number | null;
  sourceRowHidden?: boolean;
  sourceColumns?: Record<string, string>;
  sourceCellRefs?: Record<string, string>;
  rawRow?: Record<string, string | null>;

  rawMpn: string;
  displayMpn: string;
  /** Exact identity key. Unicode NFKC, case/space normalized, punctuation retained. */
  normalizedMpn: string;
  /** Search-only identity key. Never sufficient for automatic allocation. */
  reviewKey: string;
  manufacturer: string | null;
  manufacturerCanonical?: string | null;
  manufacturerAliasVersion?: string | null;

  snapshotKey?: string | null;
  demandEventKey?: string | null;
  demandEventSourceId?: string | null;
  /** UUID of the materialized demand_part_options row, populated by the worker. */
  demandPartOptionId?: string | null;
  supplyLotKey?: string | null;
  /** UUID of the materialized supply_lots row, populated by the worker. */
  supplyLotId?: string | null;
  clientItem?: string | null;
  plantFacility?: string | null;
  endCustomer?: string | null;
  optionOrdinal?: number | null;
  isPrimaryOption?: boolean | null;
  isApprovedAlternate?: boolean | null;
  isActiveDemand?: boolean;

  customerContext: string | null;
  supplierContext: string | null;
  rawQuantity?: string | null;
  requiredQty: number | null;
  availableQty: number | null;
  excessQty: number | null;
  requiredDate: string | null;
  requiredDateQuality?: "valid" | "missing" | "ambiguous" | "not_applicable";
  unitOfMeasure: string | null;

  targetPrice?: number | null;
  targetCurrency?: string | null;
  offerPrice?: number | null;
  unitCost?: number | null;
  currency?: string | null;
  currencyStatus?: "confirmed" | "unconfirmed" | "invalid";
  moq?: number | null;
  spq?: number | null;
  dateCode?: string | null;
  coo?: string | null;
  leadTimeWeeks?: number | null;
  transitTimeWeeks?: number | null;
  condition?: string | null;
  expiresAt?: string | null;
  isLiveSupply?: boolean | null;
  qualityFlags: OpportunityWarningCode[];
}

export interface OpportunityAllocationTrace {
  lotKey: string;
  /** Durable materialized option identity required by the allocation RPC. */
  demandPartOptionId?: string | null;
  /** Durable materialized lot identity; the lot key remains an audit aid. */
  supplyLotId?: string | null;
  allocatedQty: number;
  reservedQty?: number;
  availableBefore: number;
  remainingQty: number;
  supply: OpportunitySourceTrace;
}

export interface OpportunityResult {
  id?: string;
  /** Stable reviewed candidate UUID when this result was explicitly promoted from one. */
  candidateId?: string | null;
  jobId: string;
  opportunityType: OpportunityType;
  exactMpnMatch: boolean;
  /** @deprecated Use exactMpnMatch. Retained for API compatibility. */
  exactMatch: boolean;
  usableAvailabilityMatch: boolean;
  exactQuantityMatch: boolean;
  matchTier?: OpportunityMatchTier | null;
  confidence?: OpportunityConfidence;
  matchExplanation?: string;
  reviewStatus?: OpportunityReviewStatus;

  demandEventKey?: string | null;
  demandMpnOriginal?: string | null;
  supplyMpnOriginal?: string | null;
  displayMpn: string;
  normalizedMpn: string;
  manufacturer: string | null;
  manufacturerCanonical?: string | null;
  customerContext: string | null;
  supplierContext: string | null;
  requiredQty: number | null;
  availableQty: number | null;
  allocatedQty: number | null;
  remainingQty?: number | null;
  shortageQty: number | null;
  coveragePercent: number | null;
  requiredDate: string | null;
  unitOfMeasure: string | null;

  targetPrice?: number | null;
  targetCurrency?: string | null;
  offerPrice?: number | null;
  offerCurrency?: string | null;
  targetGapPercent?: number | null;
  currency?: string | null;
  revenuePotential?: number | null;
  /** Explicit matcher assessment for persisted commercial aggregates. */
  pricingQuality?: "confirmed" | "unconfirmed";
  unitCost?: number | null;
  costCurrency?: string | null;
  grossProfit?: number | null;
  grossMarginPercent?: number | null;
  /** Trust applies to the computed allocation aggregate, even when unit costs differ. */
  financialQuality?: "valid" | "untrusted";
  moq?: number | null;
  spq?: number | null;
  dateCode?: string | null;
  coo?: string | null;
  leadTimeWeeks?: number | null;
  condition?: string | null;
  expiresAt?: string | null;

  demandFileId: string | null;
  demandFileName: string | null;
  demandSheetName: string | null;
  supplyFileId: string | null;
  supplyFileName: string | null;
  supplySheetName: string | null;
  demandSourceRows: number;
  supplySourceRows: number;
  demandTraces?: OpportunitySourceTrace[];
  supplyTraces?: OpportunitySourceTrace[];
  allocations?: OpportunityAllocationTrace[];
  reasonCode: OpportunityReasonCode;
  actionCode: OpportunityActionCode;
  warnings: OpportunityWarningCode[];
}

export interface PossibleOpportunityMatch {
  /** Deterministic UUID derived from candidateKey at the persistence boundary. */
  id?: string;
  jobId: string;
  /** Stable identity for one event/option/lot candidate. */
  candidateKey: string;
  demandEventKey: string;
  demandOptionId: string | null;
  supplyLotId: string | null;
  demandDisplayMpn: string;
  supplyDisplayMpn: string;
  demandNormalizedMpn: string;
  supplyNormalizedMpn: string;
  reviewKey: string;
  demandFileId: string;
  supplyFileId: string;
  reasonCode: "symbol_variant";
  matchTier?: "search_mpn_mfg";
  confidence?: "review";
  reviewStatus?: OpportunityReviewStatus;
  manufacturerCompatible?: boolean;
  explanation?: string | null;
  demandTrace?: OpportunitySourceTrace;
  supplyTrace?: OpportunitySourceTrace;
}

export interface OpportunityRejectedRow {
  jobId: string;
  fileId: string;
  side: "A" | "B";
  fileName: string;
  sheetName: string;
  sourceRow: number;
  hidden: boolean;
  reasonCode: string;
  fieldName: string | null;
  sourceColumn: string | null;
  safeRawValue: string | null;
}

export interface OpportunitySummary {
  analyzedMpns: number;
  exactMatches: number;
  usableAvailabilityMatches: number;
  exactQuantityMatches: number;
  fullSales: number;
  partialSales: number;
  sourcingNeeded: number;
  excessResales: number;
  supplierOfferMatches: number;
  supplyWithoutDemand: number;
  historicalSignals: number;
  reviewRequired: number;
  missingMpnRows: number;
  invalidQuantityRows: number;
  possibleMatches: number;
  rejectedRows?: number;
  demandEvents?: number;
  demandPartOptions?: number;
  supplyLots?: number;
}

export interface OpportunityMatchOutput {
  results: OpportunityResult[];
  possibleMatches: PossibleOpportunityMatch[];
  summary: OpportunitySummary;
  rejectedRows?: OpportunityRejectedRow[];
}

export interface OpportunityCompatibility {
  compatible: boolean;
  demandSide: "A" | "B" | null;
  supplySide: "A" | "B" | null;
  comparisonKind:
    | "demand_stock"
    | "demand_excess"
    | "demand_supplier_offer"
    | "demand_received_history"
    | "demand_purchase_history"
    | "demand_quote_history"
    | "demand_sales_history"
    | "incompatible";
  reasonCode:
    | "compatible"
    | "unknown_role"
    | "ignored_file"
    | "financial_file"
    | "requires_demand"
    | "two_demand_files"
    | "two_history_files"
    | "unsupported_pair";
  recommendedRole: OpportunitySelectedRole | null;
}
