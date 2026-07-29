import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";
import { manufacturersConflict } from "@/lib/opportunity-finder/normalization";
import type {
  CanonicalOpportunityRow,
  OpportunityActionCode,
  OpportunityMatchOutput,
  OpportunityReasonCode,
  OpportunityResult,
  OpportunitySelectedRole,
  OpportunitySummary,
  OpportunityType,
  OpportunityWarningCode,
  PossibleOpportunityMatch
} from "@/lib/opportunity-finder/types";

type DemandGroup = {
  key: string;
  normalizedMpn: string;
  displayMpn: string;
  reviewKey: string;
  manufacturer: string | null;
  customerContext: string | null;
  supplierContext: string | null;
  requiredQty: number;
  requiredDate: string | null;
  unitOfMeasure: string | null;
  fileId: string;
  fileName: string;
  sheetNames: Set<string>;
  sourceRows: number;
  firstSourceRow: number;
  warnings: Set<OpportunityWarningCode>;
};

type SupplyGroup = {
  normalizedMpn: string;
  displayMpn: string;
  reviewKey: string;
  manufacturers: Set<string>;
  manufacturer: string | null;
  supplierContext: string | null;
  totalAvailable: number;
  remainingAvailable: number;
  unitOfMeasures: Set<string>;
  fileId: string;
  fileName: string;
  sheetNames: Set<string>;
  sourceRows: number;
  warnings: Set<OpportunityWarningCode>;
};

const RESULT_ORDER: Record<OpportunityType, number> = {
  full_sale: 0,
  partial_sale: 1,
  excess_resale: 2,
  supplier_offer_match: 3,
  sourcing_needed: 4,
  supply_without_demand: 5,
  historical_signal: 6,
  review_required: 7
};

function emptySummary(): OpportunitySummary {
  return {
    analyzedMpns: 0,
    exactMatches: 0,
    usableAvailabilityMatches: 0,
    exactQuantityMatches: 0,
    fullSales: 0,
    partialSales: 0,
    sourcingNeeded: 0,
    excessResales: 0,
    supplierOfferMatches: 0,
    supplyWithoutDemand: 0,
    historicalSignals: 0,
    reviewRequired: 0,
    missingMpnRows: 0,
    invalidQuantityRows: 0,
    possibleMatches: 0
  };
}

function demandGroupKey(row: CanonicalOpportunityRow) {
  return [
    row.normalizedMpn,
    row.customerContext ?? "",
    row.requiredDate ?? "",
    row.unitOfMeasure ?? ""
  ].join("\u001f");
}

function dateSortValue(value: string | null) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER - 1;
}

function firstValue(values: Set<string>) {
  return values.values().next().value ?? null;
}

function normalizeUnit(value: string | null) {
  return value?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
}

function supplyQuantity(row: CanonicalOpportunityRow, role: OpportunitySelectedRole) {
  if (role === "excess") return row.excessQty ?? row.availableQty;
  return row.availableQty;
}

function groupDemand(rows: CanonicalOpportunityRow[]) {
  const groups = new Map<string, DemandGroup>();
  for (const row of rows) {
    const key = demandGroupKey(row);
    const existing = groups.get(key) ?? {
      key,
      normalizedMpn: row.normalizedMpn,
      displayMpn: row.displayMpn,
      reviewKey: row.reviewKey,
      manufacturer: row.manufacturer,
      customerContext: row.customerContext,
      supplierContext: row.supplierContext,
      requiredQty: 0,
      requiredDate: row.requiredDate,
      unitOfMeasure: row.unitOfMeasure,
      fileId: row.fileId,
      fileName: row.fileName,
      sheetNames: new Set<string>(),
      sourceRows: 0,
      firstSourceRow: row.sourceRow,
      warnings: new Set<OpportunityWarningCode>()
    };
    existing.requiredQty += row.requiredQty && row.requiredQty > 0 ? row.requiredQty : 0;
    existing.sourceRows += 1;
    existing.firstSourceRow = Math.min(existing.firstSourceRow, row.sourceRow);
    existing.sheetNames.add(row.sheetName);
    row.qualityFlags.forEach((warning) => existing.warnings.add(warning));
    groups.set(key, existing);
  }
  return Array.from(groups.values()).sort(
    (left, right) =>
      left.normalizedMpn.localeCompare(right.normalizedMpn) ||
      dateSortValue(left.requiredDate) - dateSortValue(right.requiredDate) ||
      left.firstSourceRow - right.firstSourceRow
  );
}

function groupSupply(rows: CanonicalOpportunityRow[], role: OpportunitySelectedRole) {
  const groups = new Map<string, SupplyGroup>();
  for (const row of rows) {
    const existing = groups.get(row.normalizedMpn) ?? {
      normalizedMpn: row.normalizedMpn,
      displayMpn: row.displayMpn,
      reviewKey: row.reviewKey,
      manufacturers: new Set<string>(),
      manufacturer: row.manufacturer,
      supplierContext: row.supplierContext,
      totalAvailable: 0,
      remainingAvailable: 0,
      unitOfMeasures: new Set<string>(),
      fileId: row.fileId,
      fileName: row.fileName,
      sheetNames: new Set<string>(),
      sourceRows: 0,
      warnings: new Set<OpportunityWarningCode>()
    };
    const quantity = supplyQuantity(row, role);
    if (quantity !== null && Number.isFinite(quantity) && quantity > 0) {
      existing.totalAvailable += quantity;
      existing.remainingAvailable += quantity;
    }
    if (row.manufacturer) existing.manufacturers.add(row.manufacturer);
    if (row.unitOfMeasure) existing.unitOfMeasures.add(normalizeUnit(row.unitOfMeasure));
    existing.supplierContext = existing.supplierContext ?? row.supplierContext;
    existing.manufacturer = existing.manufacturer ?? row.manufacturer;
    existing.sheetNames.add(row.sheetName);
    existing.sourceRows += 1;
    row.qualityFlags.forEach((warning) => existing.warnings.add(warning));
    groups.set(row.normalizedMpn, existing);
  }
  for (const group of groups.values()) {
    if (group.manufacturers.size > 1) group.warnings.add("multiple_manufacturers");
  }
  return groups;
}

function unitWarnings(demand: DemandGroup, supply: SupplyGroup) {
  const warnings = new Set<OpportunityWarningCode>();
  const demandUnit = normalizeUnit(demand.unitOfMeasure);
  if (!demandUnit || !supply.unitOfMeasures.size) {
    warnings.add("missing_unit");
    return { warnings, incompatible: false };
  }
  if (!supply.unitOfMeasures.has(demandUnit)) {
    warnings.add("incompatible_unit");
    return { warnings, incompatible: true };
  }
  return { warnings, incompatible: false };
}

function manufacturerWarnings(demand: DemandGroup, supply: SupplyGroup) {
  const warnings = new Set<OpportunityWarningCode>();
  if (Array.from(supply.manufacturers).some((manufacturer) => manufacturersConflict(demand.manufacturer, manufacturer))) {
    const anyConsistent = Array.from(supply.manufacturers).some(
      (manufacturer) => !manufacturersConflict(demand.manufacturer, manufacturer)
    );
    if (!anyConsistent) warnings.add("manufacturer_conflict");
  }
  return warnings;
}

function resultCodes(input: {
  supplyRole: OpportunitySelectedRole;
  allocatedQty: number;
  requiredQty: number;
  reviewReason?: "manufacturer" | "unit" | "quantity";
}) {
  if (input.reviewReason === "manufacturer") {
    return {
      opportunityType: "review_required" as const,
      reasonCode: "manufacturer_conflict" as const,
      actionCode: "review_manufacturer" as const
    };
  }
  if (input.reviewReason === "unit") {
    return {
      opportunityType: "review_required" as const,
      reasonCode: "incompatible_unit" as const,
      actionCode: "review_quantity" as const
    };
  }
  if (input.reviewReason === "quantity") {
    return {
      opportunityType: "review_required" as const,
      reasonCode: "invalid_quantity" as const,
      actionCode: "review_quantity" as const
    };
  }
  if (input.supplyRole === "received_history" || input.supplyRole === "sales_history") {
    return {
      opportunityType: "historical_signal" as const,
      reasonCode: "historical_match_only" as const,
      actionCode: "upload_current_stock" as const
    };
  }
  if (input.allocatedQty <= 0) {
    return {
      opportunityType: "sourcing_needed" as const,
      reasonCode: "no_available_supply" as const,
      actionCode: "contact_supplier" as const
    };
  }
  if (input.supplyRole === "excess") {
    return {
      opportunityType: "excess_resale" as const,
      reasonCode: "excess_covers_demand" as const,
      actionCode: input.allocatedQty >= input.requiredQty
        ? "offer_full_quantity" as const
        : "source_remaining_quantity" as const
    };
  }
  if (input.supplyRole === "supplier_offer") {
    return {
      opportunityType: "supplier_offer_match" as const,
      reasonCode: "supplier_offer_available" as const,
      actionCode: input.allocatedQty >= input.requiredQty
        ? "contact_supplier" as const
        : "source_remaining_quantity" as const
    };
  }
  if (input.allocatedQty >= input.requiredQty) {
    return {
      opportunityType: "full_sale" as const,
      reasonCode: "full_coverage" as const,
      actionCode: "offer_full_quantity" as const
    };
  }
  return {
    opportunityType: "partial_sale" as const,
    reasonCode: "partial_coverage" as const,
    actionCode: "offer_available_quantity" as const
  };
}

function makeDemandResult(input: {
  demand: DemandGroup;
  supply: SupplyGroup | null;
  supplyRole: OpportunitySelectedRole;
  availableBeforeAllocation: number;
  allocatedQty: number;
  extraWarnings?: Set<OpportunityWarningCode>;
  reviewReason?: "manufacturer" | "unit" | "quantity";
}): OpportunityResult {
  const historical = input.supplyRole === "received_history" || input.supplyRole === "sales_history";
  const requiredQty = input.demand.requiredQty;
  const allocatedQty = historical ? 0 : input.allocatedQty;
  const warnings = new Set<OpportunityWarningCode>([
    ...input.demand.warnings,
    ...(input.supply?.warnings ?? []),
    ...(input.extraWarnings ?? [])
  ]);
  if (historical) warnings.add("historical_not_current_stock");
  const codes = resultCodes({
    supplyRole: input.supplyRole,
    allocatedQty,
    requiredQty,
    reviewReason: input.reviewReason
  });
  const shortageQty = Math.max(requiredQty - allocatedQty, 0);
  const usableAvailabilityMatch =
    !historical &&
    Boolean(input.supply) &&
    !input.reviewReason &&
    Number.isFinite(input.availableBeforeAllocation) &&
    input.availableBeforeAllocation > 0;
  const exactQuantityMatch =
    usableAvailabilityMatch &&
    input.availableBeforeAllocation === requiredQty &&
    allocatedQty === requiredQty;
  const exactMpnMatch = Boolean(input.supply);
  return {
    jobId: "",
    opportunityType: codes.opportunityType,
    exactMpnMatch,
    exactMatch: exactMpnMatch,
    usableAvailabilityMatch,
    exactQuantityMatch,
    displayMpn: input.demand.displayMpn,
    normalizedMpn: input.demand.normalizedMpn,
    manufacturer: input.demand.manufacturer ?? input.supply?.manufacturer ?? null,
    customerContext: input.demand.customerContext,
    supplierContext: input.supply?.supplierContext ?? input.demand.supplierContext,
    requiredQty,
    availableQty: historical ? null : input.supply?.totalAvailable ?? 0,
    allocatedQty: historical ? null : allocatedQty,
    shortageQty: historical ? null : shortageQty,
    coveragePercent: historical || requiredQty <= 0
      ? null
      : Math.round((allocatedQty / requiredQty) * 10_000) / 100,
    requiredDate: input.demand.requiredDate,
    unitOfMeasure: input.demand.unitOfMeasure,
    demandFileId: input.demand.fileId,
    demandFileName: input.demand.fileName,
    demandSheetName: Array.from(input.demand.sheetNames).join(", "),
    supplyFileId: input.supply?.fileId ?? null,
    supplyFileName: input.supply?.fileName ?? null,
    supplySheetName: input.supply ? Array.from(input.supply.sheetNames).join(", ") : null,
    demandSourceRows: input.demand.sourceRows,
    supplySourceRows: input.supply?.sourceRows ?? 0,
    reasonCode: codes.reasonCode,
    actionCode: codes.actionCode,
    warnings: Array.from(warnings)
  };
}

function countSummary(results: OpportunityResult[], analyzedMpns: number, exactMatches: number) {
  const summary = emptySummary();
  summary.analyzedMpns = analyzedMpns;
  summary.exactMatches = exactMatches;
  summary.usableAvailabilityMatches = new Set(
    results
      .filter((result) => result.usableAvailabilityMatch)
      .map((result) => result.normalizedMpn)
  ).size;
  summary.exactQuantityMatches = results.filter((result) => result.exactQuantityMatch).length;
  for (const result of results) {
    if (result.opportunityType === "full_sale") summary.fullSales += 1;
    if (result.opportunityType === "partial_sale") summary.partialSales += 1;
    if (result.opportunityType === "sourcing_needed") summary.sourcingNeeded += 1;
    if (result.opportunityType === "excess_resale") summary.excessResales += 1;
    if (result.opportunityType === "supplier_offer_match") summary.supplierOfferMatches += 1;
    if (result.opportunityType === "supply_without_demand") summary.supplyWithoutDemand += 1;
    if (result.opportunityType === "historical_signal") summary.historicalSignals += 1;
    if (result.opportunityType === "review_required") summary.reviewRequired += 1;
  }
  return summary;
}

export function matchOpportunityRows(input: {
  jobId: string;
  rows: CanonicalOpportunityRow[];
  roleA: OpportunitySelectedRole;
  roleB: OpportunitySelectedRole;
  missingMpnRows?: number;
  invalidQuantityRows?: number;
}): OpportunityMatchOutput {
  const compatibility = evaluateOpportunityCompatibility(input.roleA, input.roleB);
  if (!compatibility.compatible || !compatibility.demandSide || !compatibility.supplySide) {
    throw new Error(`Incompatible opportunity roles: ${compatibility.reasonCode}`);
  }
  const supplyRole = compatibility.supplySide === "A" ? input.roleA : input.roleB;
  const demandRows = input.rows.filter(
    (row) => row.side === compatibility.demandSide && row.recordRole === "demand" && row.normalizedMpn
  );
  const supplyRows = input.rows.filter(
    (row) => row.side === compatibility.supplySide && row.normalizedMpn
  );
  const demandGroups = groupDemand(demandRows);
  const supplyGroups = groupSupply(supplyRows, supplyRole);
  const results: OpportunityResult[] = [];
  const exactMatchedMpns = new Set<string>();
  const demandMpns = new Set(demandGroups.map((group) => group.normalizedMpn));

  for (const demand of demandGroups) {
    const supply = supplyGroups.get(demand.normalizedMpn) ?? null;
    if (supply) exactMatchedMpns.add(demand.normalizedMpn);

    if (demand.requiredQty <= 0 || demand.warnings.has("invalid_required_quantity")) {
      results.push(makeDemandResult({
        demand,
        supply,
        supplyRole,
        availableBeforeAllocation: supply ? Math.max(supply.remainingAvailable, 0) : 0,
        allocatedQty: 0,
        reviewReason: "quantity"
      }));
      continue;
    }

    if (supplyRole === "received_history" || supplyRole === "sales_history") {
      if (supply) {
        results.push(makeDemandResult({
          demand,
          supply,
          supplyRole,
          availableBeforeAllocation: 0,
          allocatedQty: 0
        }));
      }
      continue;
    }

    const units = supply ? unitWarnings(demand, supply) : { warnings: new Set<OpportunityWarningCode>(["missing_unit"]), incompatible: false };
    const manufacturer = supply ? manufacturerWarnings(demand, supply) : new Set<OpportunityWarningCode>();
    const reviewReason = manufacturer.has("manufacturer_conflict")
      ? "manufacturer" as const
      : units.incompatible
        ? "unit" as const
        : undefined;
    const availableBeforeAllocation = supply ? Math.max(supply.remainingAvailable, 0) : 0;
    const allocatedQty =
      !supply || reviewReason
        ? 0
        : Math.min(demand.requiredQty, availableBeforeAllocation);
    if (supply && !reviewReason) supply.remainingAvailable = Math.max(supply.remainingAvailable - allocatedQty, 0);
    const extraWarnings = new Set<OpportunityWarningCode>([...units.warnings, ...manufacturer]);
    results.push(makeDemandResult({
      demand,
      supply,
      supplyRole,
      availableBeforeAllocation,
      allocatedQty,
      extraWarnings,
      reviewReason
    }));
  }

  if (supplyRole !== "received_history" && supplyRole !== "sales_history") {
    for (const supply of supplyGroups.values()) {
      if (demandMpns.has(supply.normalizedMpn) || supply.totalAvailable <= 0) continue;
      results.push({
        jobId: input.jobId,
        opportunityType: "supply_without_demand",
        exactMpnMatch: false,
        exactMatch: false,
        usableAvailabilityMatch: false,
        exactQuantityMatch: false,
        displayMpn: supply.displayMpn,
        normalizedMpn: supply.normalizedMpn,
        manufacturer: supply.manufacturer,
        customerContext: null,
        supplierContext: supply.supplierContext,
        requiredQty: null,
        availableQty: supply.totalAvailable,
        allocatedQty: 0,
        shortageQty: null,
        coveragePercent: null,
        requiredDate: null,
        unitOfMeasure: firstValue(supply.unitOfMeasures),
        demandFileId: null,
        demandFileName: null,
        demandSheetName: null,
        supplyFileId: supply.fileId,
        supplyFileName: supply.fileName,
        supplySheetName: Array.from(supply.sheetNames).join(", "),
        demandSourceRows: 0,
        supplySourceRows: supply.sourceRows,
        reasonCode: "supply_has_no_demand",
        actionCode: "find_buyer",
        warnings: Array.from(supply.warnings)
      });
    }
  }

  const supplyByReviewKey = new Map<string, SupplyGroup[]>();
  for (const supply of supplyGroups.values()) {
    if (!supply.reviewKey) continue;
    supplyByReviewKey.set(supply.reviewKey, [...(supplyByReviewKey.get(supply.reviewKey) ?? []), supply]);
  }
  const possibleMatches: PossibleOpportunityMatch[] = [];
  const possibleSeen = new Set<string>();
  for (const demand of demandGroups) {
    if (supplyGroups.has(demand.normalizedMpn) || !demand.reviewKey) continue;
    for (const supply of supplyByReviewKey.get(demand.reviewKey) ?? []) {
      if (supply.normalizedMpn === demand.normalizedMpn) continue;
      const key = `${demand.normalizedMpn}\u001f${supply.normalizedMpn}`;
      if (possibleSeen.has(key)) continue;
      possibleSeen.add(key);
      possibleMatches.push({
        jobId: input.jobId,
        demandDisplayMpn: demand.displayMpn,
        supplyDisplayMpn: supply.displayMpn,
        demandNormalizedMpn: demand.normalizedMpn,
        supplyNormalizedMpn: supply.normalizedMpn,
        reviewKey: demand.reviewKey,
        demandFileId: demand.fileId,
        supplyFileId: supply.fileId,
        reasonCode: "symbol_variant"
      });
    }
  }

  for (const result of results) result.jobId = input.jobId;
  results.sort(
    (left, right) =>
      RESULT_ORDER[left.opportunityType] - RESULT_ORDER[right.opportunityType] ||
      dateSortValue(left.requiredDate) - dateSortValue(right.requiredDate) ||
      left.normalizedMpn.localeCompare(right.normalizedMpn)
  );
  const analyzedMpns = new Set([
    ...demandGroups.map((group) => group.normalizedMpn),
    ...Array.from(supplyGroups.keys())
  ]).size;
  const summary = countSummary(results, analyzedMpns, exactMatchedMpns.size);
  summary.missingMpnRows = input.missingMpnRows ?? 0;
  summary.invalidQuantityRows = input.invalidQuantityRows ?? 0;
  summary.possibleMatches = possibleMatches.length;
  return { results, possibleMatches, summary };
}

export const SAFE_RESULT_KEYS = new Set<keyof OpportunityResult>([
  "id",
  "jobId",
  "opportunityType",
  "exactMpnMatch",
  "exactMatch",
  "usableAvailabilityMatch",
  "exactQuantityMatch",
  "displayMpn",
  "normalizedMpn",
  "manufacturer",
  "customerContext",
  "supplierContext",
  "requiredQty",
  "availableQty",
  "allocatedQty",
  "shortageQty",
  "coveragePercent",
  "requiredDate",
  "unitOfMeasure",
  "demandFileId",
  "demandFileName",
  "demandSheetName",
  "supplyFileId",
  "supplyFileName",
  "supplySheetName",
  "demandSourceRows",
  "supplySourceRows",
  "reasonCode",
  "actionCode",
  "warnings"
]);

export function containsForbiddenOpportunityFields(value: unknown) {
  const forbidden = /(^|[_\s])(price|cost|unit cost|gp|gp rate|margin|commission|raw data)([_\s]|$)/i;
  const visit = (item: unknown): boolean => {
    if (Array.isArray(item)) return item.some(visit);
    if (!item || typeof item !== "object") return false;
    return Object.entries(item as Record<string, unknown>).some(([key, nested]) => forbidden.test(key) || visit(nested));
  };
  return visit(value);
}

export type OpportunityResultCodes = {
  opportunityType: OpportunityType;
  reasonCode: OpportunityReasonCode;
  actionCode: OpportunityActionCode;
};
