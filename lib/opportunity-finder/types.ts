export type OpportunityFileType =
  | "demand"
  | "stock"
  | "excess"
  | "supplier_offer"
  | "received_history"
  | "sales_history"
  | "financial"
  | "unknown";

export type OpportunitySelectedRole =
  | "demand"
  | "stock"
  | "excess"
  | "supplier_offer"
  | "received_history"
  | "sales_history"
  | "ignore";

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
  | "missing_unit"
  | "incompatible_unit"
  | "invalid_quantity"
  | "supply_has_no_demand";

export type OpportunityActionCode =
  | "offer_full_quantity"
  | "offer_available_quantity"
  | "source_remaining_quantity"
  | "contact_supplier"
  | "find_buyer"
  | "review_manufacturer"
  | "review_quantity"
  | "upload_current_stock";

export type OpportunityWarningCode =
  | "manufacturer_conflict"
  | "missing_unit"
  | "incompatible_unit"
  | "invalid_required_quantity"
  | "invalid_available_quantity"
  | "negative_available_quantity"
  | "multiple_manufacturers"
  | "historical_not_current_stock";

export interface OpportunitySheetProfile {
  sheetName: string;
  rowCount: number;
  headerRows: Array<{
    rowNumber: number;
    headers: string[];
  }>;
}

export interface OpportunityWorkbookProfile {
  fileName: string;
  sheetCount: number;
  rowCount: number;
  detectedType: OpportunityFileType;
  classificationScore: number;
  classificationReasons: string[];
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
  rawMpn: string;
  displayMpn: string;
  normalizedMpn: string;
  reviewKey: string;
  manufacturer: string | null;
  customerContext: string | null;
  supplierContext: string | null;
  requiredQty: number | null;
  availableQty: number | null;
  excessQty: number | null;
  requiredDate: string | null;
  unitOfMeasure: string | null;
  qualityFlags: OpportunityWarningCode[];
}

export interface OpportunityResult {
  id?: string;
  jobId: string;
  opportunityType: OpportunityType;
  /** The normalized MPN exists on both sides of the comparison. */
  exactMpnMatch: boolean;
  /** @deprecated Use exactMpnMatch. Retained for API compatibility. */
  exactMatch: boolean;
  /** Positive, valid supply remained and passed compatibility checks for this allocation. */
  usableAvailabilityMatch: boolean;
  /** Usable availability immediately before allocation exactly equaled the required quantity. */
  exactQuantityMatch: boolean;
  displayMpn: string;
  normalizedMpn: string;
  manufacturer: string | null;
  customerContext: string | null;
  supplierContext: string | null;
  requiredQty: number | null;
  availableQty: number | null;
  allocatedQty: number | null;
  shortageQty: number | null;
  coveragePercent: number | null;
  requiredDate: string | null;
  unitOfMeasure: string | null;
  demandFileId: string | null;
  demandFileName: string | null;
  demandSheetName: string | null;
  supplyFileId: string | null;
  supplyFileName: string | null;
  supplySheetName: string | null;
  demandSourceRows: number;
  supplySourceRows: number;
  reasonCode: OpportunityReasonCode;
  actionCode: OpportunityActionCode;
  warnings: OpportunityWarningCode[];
}

export interface PossibleOpportunityMatch {
  jobId: string;
  demandDisplayMpn: string;
  supplyDisplayMpn: string;
  demandNormalizedMpn: string;
  supplyNormalizedMpn: string;
  reviewKey: string;
  demandFileId: string;
  supplyFileId: string;
  reasonCode: "symbol_variant";
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
}

export interface OpportunityMatchOutput {
  results: OpportunityResult[];
  possibleMatches: PossibleOpportunityMatch[];
  summary: OpportunitySummary;
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
