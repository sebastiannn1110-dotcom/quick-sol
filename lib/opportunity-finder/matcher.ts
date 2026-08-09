import { createHash } from "node:crypto";
import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";
import { normalizeManufacturer } from "@/lib/opportunity-finder/normalization";
import type {
  CanonicalOpportunityRow,
  OpportunityActionCode,
  OpportunityAllocationTrace,
  OpportunityConfidence,
  OpportunityMatchOutput,
  OpportunityMatchTier,
  OpportunityReasonCode,
  OpportunityResult,
  OpportunitySelectedRole,
  OpportunitySourceTrace,
  OpportunitySummary,
  OpportunityType,
  OpportunityWarningCode,
  PossibleOpportunityMatch
} from "@/lib/opportunity-finder/types";

type DemandEvent = {
  key: string;
  rows: CanonicalOpportunityRow[];
  options: CanonicalOpportunityRow[];
  requiredQty: number;
  firstSourceRow: number;
  firstOriginalIndex: number;
  warnings: Set<OpportunityWarningCode>;
};

type SupplyLot = {
  key: string;
  row: CanonicalOpportunityRow;
  originalAvailable: number;
  remainingAvailable: number;
};

type ManufacturerRelation = "exact" | "approved_alias" | "missing" | "conflict";

type Candidate = {
  option: CanonicalOpportunityRow;
  lot: SupplyLot;
  tier: OpportunityMatchTier;
  confidence: OpportunityConfidence;
  relation: ManufacturerRelation;
  automatic: boolean;
  warnings: Set<OpportunityWarningCode>;
};

const HISTORY_ROLES = new Set<OpportunitySelectedRole>([
  "received_history",
  "purchase_history",
  "quote_history",
  "sales_history"
]);

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

const TIER_ORDER: Record<OpportunityMatchTier, number> = {
  exact_mpn_mfg: 0,
  exact_mpn_mfg_missing: 1,
  exact_mpn_approved_alias: 2,
  search_mpn_mfg: 3,
  exact_mpn_mfg_conflict: 4
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
    possibleMatches: 0,
    rejectedRows: 0,
    demandEvents: 0,
    demandPartOptions: 0,
    supplyLots: 0
  };
}

function legacyDemandKey(row: CanonicalOpportunityRow) {
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

function normalizeUnit(value: string | null) {
  return value?.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, " ") ?? "";
}

function exactManufacturer(value: string | null | undefined) {
  return value
    ?.normalize("NFKC")
    .toUpperCase()
    .replace(/[\u00a0\s]+/g, " ")
    .trim() ?? "";
}

function supplierOfferIsLive(row: CanonicalOpportunityRow) {
  if (row.recordRole !== "supplier_offer" || row.isLiveSupply === false) return false;
  if (!row.expiresAt) return false;
  const expiry = new Date(row.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > Date.now();
}

function manufacturerRelation(
  demand: CanonicalOpportunityRow,
  supply: CanonicalOpportunityRow
): ManufacturerRelation {
  const demandExact = exactManufacturer(demand.manufacturer);
  const supplyExact = exactManufacturer(supply.manufacturer);
  if (!demandExact || !supplyExact) return "missing";
  if (demandExact === supplyExact) return "exact";
  const demandCanonical = demand.manufacturerCanonical || normalizeManufacturer(demand.manufacturer);
  const supplyCanonical = supply.manufacturerCanonical || normalizeManufacturer(supply.manufacturer);
  return demandCanonical && supplyCanonical && demandCanonical === supplyCanonical
    ? "approved_alias"
    : "conflict";
}

function allowMissingManufacturerAutomatically() {
  return process.env.OPPORTUNITY_ALLOW_MISSING_MANUFACTURER_AUTO_MATCH !== "false";
}

function supplyQuantity(row: CanonicalOpportunityRow) {
  if (row.recordRole === "excess") return row.excessQty ?? row.availableQty;
  return row.availableQty;
}

function isHistoricalSupply(row: CanonicalOpportunityRow) {
  return HISTORY_ROLES.has(row.recordRole);
}

const SUPPLY_ROLE_ORDER: Partial<Record<OpportunitySelectedRole, number>> = {
  stock: 0,
  excess: 1,
  supplier_offer: 2,
  received_history: 3,
  purchase_history: 4,
  quote_history: 5,
  sales_history: 6
};

function sourceTrace(row: CanonicalOpportunityRow): OpportunitySourceTrace {
  return {
    fileId: row.fileId,
    fileName: row.fileName,
    sheetName: row.sheetName,
    sourceRow: row.sourceRow,
    hidden: Boolean(row.sourceRowHidden),
    headerRow: row.headerRow ?? null,
    columns: row.sourceColumns ?? {},
    originalIndex: row.originalIndex,
    demandEventKey: row.demandEventKey ?? null,
    demandOptionId: row.demandPartOptionId ?? null,
    optionOrdinal: row.optionOrdinal ?? null,
    supplyLotKey: row.supplyLotKey ?? null,
    supplyLotId: row.supplyLotId ?? null
  };
}

function demandOptionIdentity(eventKey: string, row: CanonicalOpportunityRow) {
  return [
    eventKey,
    row.fileId,
    row.sheetName,
    row.sourceRow,
    row.originalIndex,
    row.optionOrdinal ?? "",
    row.normalizedMpn,
    exactManufacturer(row.manufacturer)
  ];
}

function candidateIdentity(
  jobId: string,
  eventKey: string,
  option: CanonicalOpportunityRow,
  lot: SupplyLot
) {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      jobId,
      demandOption: demandOptionIdentity(eventKey, option),
      supplyLotKey: lot.key,
      reasonCode: "symbol_variant"
    }), "utf8")
    .digest("hex");
}

function groupDemandEvents(rows: CanonicalOpportunityRow[]) {
  const groups = new Map<string, DemandEvent>();
  for (const row of rows) {
    const explicitEvent = row.demandEventKey?.trim();
    const key = explicitEvent || legacyDemandKey(row);
    const existing = groups.get(key) ?? {
      key,
      rows: [],
      options: [],
      requiredQty: 0,
      firstSourceRow: row.sourceRow,
      firstOriginalIndex: row.originalIndex,
      warnings: new Set<OpportunityWarningCode>()
    };
    existing.rows.push(row);
    if (!existing.options.some((option) =>
      option.normalizedMpn === row.normalizedMpn &&
      exactManufacturer(option.manufacturer) === exactManufacturer(row.manufacturer)
    )) {
      existing.options.push(row);
    }
    const quantity = row.requiredQty && Number.isFinite(row.requiredQty) && row.requiredQty > 0
      ? row.requiredQty
      : 0;
    if (explicitEvent) {
      // Sanmina/Flex repeat event quantity for each approved MPN. Count it once.
      existing.requiredQty = Math.max(existing.requiredQty, quantity);
    } else {
      // Preserve the certified generic behavior where duplicate identical lines aggregate.
      existing.requiredQty += quantity;
    }
    existing.firstSourceRow = Math.min(existing.firstSourceRow, row.sourceRow);
    existing.firstOriginalIndex = Math.min(existing.firstOriginalIndex, row.originalIndex);
    row.qualityFlags.forEach((warning) => existing.warnings.add(warning));
    groups.set(key, existing);
  }
  return Array.from(groups.values()).sort((left, right) => {
    const leftMpn = left.options[0]?.normalizedMpn ?? "";
    const rightMpn = right.options[0]?.normalizedMpn ?? "";
    return (
      leftMpn.localeCompare(rightMpn) ||
      dateSortValue(left.rows[0]?.requiredDate ?? null) - dateSortValue(right.rows[0]?.requiredDate ?? null) ||
      left.firstOriginalIndex - right.firstOriginalIndex
    );
  });
}

function buildSupplyLots(rows: CanonicalOpportunityRow[]) {
  return rows.map((row) => {
    const parsed = supplyQuantity(row);
    const quantity = parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    return {
      key: row.supplyLotKey || `${row.fileId}:${row.sheetName}:${row.sourceRow}:${row.originalIndex}`,
      row,
      originalAvailable: quantity,
      remainingAvailable: quantity
    } satisfies SupplyLot;
  });
}

function unitCompatibility(demand: CanonicalOpportunityRow, supply: CanonicalOpportunityRow) {
  const demandUnit = normalizeUnit(demand.unitOfMeasure);
  const supplyUnit = normalizeUnit(supply.unitOfMeasure);
  if (!demandUnit || !supplyUnit) {
    return { compatible: true, warning: "missing_unit" as OpportunityWarningCode };
  }
  return demandUnit === supplyUnit
    ? { compatible: true, warning: null }
    : { compatible: false, warning: "incompatible_unit" as OpportunityWarningCode };
}

function candidateFor(option: CanonicalOpportunityRow, lot: SupplyLot): Candidate | null {
  if (option.normalizedMpn !== lot.row.normalizedMpn) return null;
  const relation = manufacturerRelation(option, lot.row);
  const unit = unitCompatibility(option, lot.row);
  const warnings = new Set<OpportunityWarningCode>();
  lot.row.qualityFlags.forEach((warning) => warnings.add(warning));
  if (unit.warning) warnings.add(unit.warning);
  if (relation === "conflict") warnings.add("manufacturer_conflict");
  if (relation === "missing") warnings.add("manufacturer_missing");
  if (relation === "approved_alias") warnings.add("manufacturer_alias_requires_review");
  if (lot.row.isLiveSupply === false) warnings.add("offer_expired");
  if (lot.row.expiresAt) {
    const expiry = new Date(lot.row.expiresAt).getTime();
    if (!Number.isFinite(expiry)) warnings.add("offer_validity_unknown");
    else if (expiry <= Date.now()) warnings.add("offer_expired");
  } else if (lot.row.recordRole === "supplier_offer") {
    warnings.add("offer_validity_unknown");
  }

  const automaticRelation =
    relation === "exact" ||
    (relation === "missing" && allowMissingManufacturerAutomatically());
  const hasLiveSupply = lot.row.recordRole === "supplier_offer"
    ? supplierOfferIsLive(lot.row)
    : lot.row.isLiveSupply !== false && !warnings.has("offer_expired");
  const automatic = automaticRelation && unit.compatible && hasLiveSupply;
  const tier: OpportunityMatchTier = relation === "exact"
    ? "exact_mpn_mfg"
    : relation === "missing"
      ? "exact_mpn_mfg_missing"
      : relation === "approved_alias"
        ? "exact_mpn_approved_alias"
        : "exact_mpn_mfg_conflict";
  const confidence: OpportunityConfidence = relation === "exact"
    ? "high"
    : relation === "missing"
      ? "medium"
      : "review";
  return { option, lot, tier, confidence, relation, automatic, warnings };
}

function sortedCandidates(event: DemandEvent, lots: SupplyLot[]) {
  const candidates: Candidate[] = [];
  for (const option of event.options) {
    for (const lot of lots) {
      const candidate = candidateFor(option, lot);
      if (candidate) candidates.push(candidate);
    }
  }
  const sorted = candidates.sort((left, right) =>
    Number(right.automatic) - Number(left.automatic) ||
    TIER_ORDER[left.tier] - TIER_ORDER[right.tier] ||
    (SUPPLY_ROLE_ORDER[left.lot.row.recordRole] ?? Number.MAX_SAFE_INTEGER) -
      (SUPPLY_ROLE_ORDER[right.lot.row.recordRole] ?? Number.MAX_SAFE_INTEGER) ||
    (left.lot.row.offerPrice ?? Number.MAX_SAFE_INTEGER) - (right.lot.row.offerPrice ?? Number.MAX_SAFE_INTEGER) ||
    left.lot.row.originalIndex - right.lot.row.originalIndex ||
    left.lot.key.localeCompare(right.lot.key)
  );
  // A single physical lot may match more than one approved option on the same
  // demand event. Keep only its best deterministic candidate so availability
  // and allocation can never be counted twice.
  return Array.from(new Map(sorted.map((candidate) => [candidate.lot.key, candidate])).values());
}

function commercialReservation(input: {
  need: number;
  lot: SupplyLot;
}) {
  const available = Math.max(input.lot.remainingAvailable, 0);
  if (input.need <= 0 || available <= 0) {
    return { allocated: 0, reserved: 0, warnings: new Set<OpportunityWarningCode>() };
  }
  const warnings = new Set<OpportunityWarningCode>();
  const moq = input.lot.row.moq && input.lot.row.moq > 0 ? input.lot.row.moq : 0;
  const spq = input.lot.row.spq && input.lot.row.spq > 0 ? input.lot.row.spq : 0;
  let orderQuantity = Math.min(input.need, available);

  if (moq > 0 && orderQuantity < moq) {
    if (available < moq) {
      warnings.add("moq_not_met");
      return { allocated: 0, reserved: 0, warnings };
    }
    orderQuantity = moq;
    warnings.add("spq_adjusted");
  }
  if (spq > 0) {
    const roundedUp = Math.ceil(orderQuantity / spq) * spq;
    if (roundedUp <= available) {
      if (roundedUp !== orderQuantity) warnings.add("spq_adjusted");
      orderQuantity = roundedUp;
    } else {
      const roundedDown = Math.floor(available / spq) * spq;
      if (roundedDown <= 0 || (moq > 0 && roundedDown < moq)) {
        warnings.add("spq_not_feasible");
        return { allocated: 0, reserved: 0, warnings };
      }
      orderQuantity = roundedDown;
      warnings.add("spq_adjusted");
    }
  }
  const reserved = Math.min(orderQuantity, available);
  const allocated = Math.min(input.need, reserved);
  return { allocated, reserved, warnings };
}

function resultCodes(input: {
  supplyRole: OpportunitySelectedRole;
  allocatedQty: number;
  requiredQty: number;
  historical: boolean;
  reviewReason?: OpportunityReasonCode;
}) {
  if (input.reviewReason) {
    return {
      opportunityType: "review_required" as const,
      reasonCode: input.reviewReason,
      actionCode: input.reviewReason === "manufacturer_conflict" || input.reviewReason === "manufacturer_alias_review"
        ? "review_manufacturer" as const
        : "review_terms" as const
    };
  }
  if (input.historical) {
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
  return input.allocatedQty >= input.requiredQty
    ? {
      opportunityType: "full_sale" as const,
      reasonCode: "full_coverage" as const,
      actionCode: "offer_full_quantity" as const
    }
    : {
      opportunityType: "partial_sale" as const,
      reasonCode: "partial_coverage" as const,
      actionCode: "offer_available_quantity" as const
    };
}

function homogeneousValue<T>(values: T[]) {
  if (!values.length) return null;
  return values.every((value) => Object.is(value, values[0])) ? values[0] : null;
}

function validMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function commercialFields(
  option: CanonicalOpportunityRow,
  usedCandidates: Candidate[],
  allocations: OpportunityAllocationTrace[],
  fallbackCandidate: Candidate | null
) {
  const allocationSegments = allocations.flatMap((allocation, index) => {
    const supply = usedCandidates[index]?.lot.row;
    return supply ? [{ allocation, supply }] : [];
  });
  const supplies = allocationSegments.length
    ? allocationSegments.map((segment) => segment.supply)
    : fallbackCandidate
      ? [fallbackCandidate.lot.row]
      : [];
  const targetPrice = option.targetPrice ?? null;
  const targetCurrency = option.currencyStatus === "confirmed" ? option.targetCurrency ?? null : null;
  const supplyCurrencies = supplies.map((supply) =>
    supply.currencyStatus === "confirmed" ? supply.currency ?? null : null
  );
  const homogeneousSupplyCurrency = supplyCurrencies.length > 0 && supplyCurrencies.every(Boolean)
    ? homogeneousValue(supplyCurrencies)
    : null;
  const revenueTrusted = allocationSegments.length > 0 && homogeneousSupplyCurrency !== null &&
    allocationSegments.every(({ supply }) => validMoney(supply.offerPrice));
  const costsTrusted = allocationSegments.length > 0 && homogeneousSupplyCurrency !== null &&
    allocationSegments.every(({ supply }) => validMoney(supply.unitCost));
  const allocatedTotal = allocationSegments.reduce(
    (sum, { allocation }) => sum + allocation.allocatedQty,
    0
  );
  const revenuePotential = revenueTrusted
    ? Math.round(allocationSegments.reduce((sum, { allocation, supply }) =>
        sum + allocation.allocatedQty * supply.offerPrice!, 0
      ) * 1_000_000) / 1_000_000
    : null;
  const totalCost = costsTrusted
    ? Math.round(allocationSegments.reduce((sum, { allocation, supply }) =>
        sum + allocation.allocatedQty * supply.unitCost!, 0
      ) * 1_000_000) / 1_000_000
    : null;
  const fallbackSupply = allocationSegments.length === 0 ? supplies[0] : undefined;
  const fallbackCurrency = fallbackSupply?.currencyStatus === "confirmed"
    ? fallbackSupply.currency ?? null
    : null;
  const fallbackOfferPrice = validMoney(fallbackSupply?.offerPrice) ? fallbackSupply!.offerPrice! : null;
  const fallbackUnitCost = validMoney(fallbackSupply?.unitCost) ? fallbackSupply!.unitCost! : null;
  const offerPrice = revenuePotential !== null && allocatedTotal > 0
    ? Math.round((revenuePotential / allocatedTotal) * 1_000_000) / 1_000_000
    : fallbackOfferPrice;
  const unitCost = totalCost !== null && allocatedTotal > 0
    ? Math.round((totalCost / allocatedTotal) * 1_000_000) / 1_000_000
    : fallbackUnitCost;
  const offerCurrency = revenueTrusted
    ? homogeneousSupplyCurrency
    : fallbackOfferPrice !== null ? fallbackCurrency : null;
  const costCurrency = costsTrusted
    ? homogeneousSupplyCurrency
    : fallbackUnitCost !== null ? fallbackCurrency : null;
  const sameCurrency = Boolean(
    targetCurrency &&
    offerCurrency &&
    targetCurrency === offerCurrency
  );
  const hasSupplyOffer = supplies.some((supply) => validMoney(supply.offerPrice));
  const currency = targetPrice !== null && hasSupplyOffer
    ? sameCurrency ? targetCurrency : null
    : offerCurrency !== null
      ? offerCurrency
      : targetCurrency;
  const targetGapPercent =
    sameCurrency && targetPrice !== null && targetPrice > 0 && offerPrice !== null
      ? Math.round(((offerPrice / targetPrice) - 1) * 1_000_000) / 10_000
      : null;
  const grossProfit = revenueTrusted && costsTrusted && costCurrency === offerCurrency
    ? Math.round(allocationSegments.reduce((sum, { allocation, supply }) =>
        sum + allocation.allocatedQty * (supply.offerPrice! - supply.unitCost!), 0
      ) * 1_000_000) / 1_000_000
    : null;
  const grossMarginPercent = grossProfit !== null && revenuePotential !== null && revenuePotential !== 0
    ? Math.round((grossProfit / revenuePotential) * 1_000_000) / 10_000
    : null;
  const termValues = {
    moq: homogeneousValue(supplies.map((supply) => supply.moq ?? null)),
    spq: homogeneousValue(supplies.map((supply) => supply.spq ?? null)),
    dateCode: homogeneousValue(supplies.map((supply) => supply.dateCode ?? null)),
    coo: homogeneousValue(supplies.map((supply) => supply.coo ?? null)),
    leadTimeWeeks: homogeneousValue(supplies.map((supply) => supply.leadTimeWeeks ?? null)),
    condition: homogeneousValue(supplies.map((supply) => supply.condition ?? null)),
    expiresAt: homogeneousValue(supplies.map((supply) => supply.expiresAt ?? null))
  };
  const termsHomogeneous = supplies.length <= 1 || (
    termValues.moq !== null || supplies.every((supply) => supply.moq == null)
  ) && (
    termValues.spq !== null || supplies.every((supply) => supply.spq == null)
  ) && (
    termValues.dateCode !== null || supplies.every((supply) => supply.dateCode == null)
  ) && (
    termValues.coo !== null || supplies.every((supply) => supply.coo == null)
  ) && (
    termValues.leadTimeWeeks !== null || supplies.every((supply) => supply.leadTimeWeeks == null)
  ) && (
    termValues.condition !== null || supplies.every((supply) => supply.condition == null)
  ) && (
    termValues.expiresAt !== null || supplies.every((supply) => supply.expiresAt == null)
  );
  const unitPricingConfirmed = (
    revenueTrusted || (allocationSegments.length === 0 && fallbackOfferPrice !== null && offerCurrency !== null)
  ) && termsHomogeneous && (
    targetPrice === null || (targetCurrency !== null && targetCurrency === offerCurrency)
  );
  return {
    targetPrice,
    targetCurrency,
    offerPrice,
    offerCurrency,
    targetGapPercent,
    currency,
    revenuePotential,
    pricingQuality: unitPricingConfirmed ? "confirmed" as const : "unconfirmed" as const,
    unitCost,
    costCurrency,
    grossProfit,
    grossMarginPercent,
    financialQuality: costsTrusted || (
      allocationSegments.length === 0 && unitCost !== null && costCurrency !== null
    ) ? "valid" as const : "untrusted" as const,
    ...termValues
  };
}

function buildDemandResult(input: {
  jobId: string;
  event: DemandEvent;
  supplyRole: OpportunitySelectedRole;
  candidates: Candidate[];
  fallbackHistorical: boolean;
}): OpportunityResult | null {
  const { event } = input;
  const requiredQty = event.requiredQty;
  const exactCandidates = input.candidates;
  if (input.fallbackHistorical && !exactCandidates.length) return null;
  const currentCandidates = exactCandidates.filter((candidate) => !isHistoricalSupply(candidate.lot.row));
  const historical = currentCandidates.length === 0 && exactCandidates.length > 0 &&
    exactCandidates.every((candidate) => isHistoricalSupply(candidate.lot.row));
  const automaticCandidates = Array.from(new Map(
    currentCandidates
      .filter((candidate) => candidate.automatic)
      .map((candidate) => [candidate.lot.key, candidate])
  ).values());
  const availableBefore = automaticCandidates.reduce(
    (sum, candidate) => sum + Math.max(candidate.lot.remainingAvailable, 0),
    0
  );
  const allocations: OpportunityAllocationTrace[] = [];
  const usedCandidates: Candidate[] = [];
  const warnings = new Set<OpportunityWarningCode>(event.warnings);
  let allocatedQty = 0;

  if (!historical && requiredQty > 0) {
    for (const candidate of automaticCandidates) {
      if (allocatedQty >= requiredQty) break;
      const reservation = commercialReservation({
        need: requiredQty - allocatedQty,
        lot: candidate.lot
      });
      candidate.warnings.forEach((warning) => warnings.add(warning));
      reservation.warnings.forEach((warning) => warnings.add(warning));
      if (reservation.reserved <= 0) continue;
      const before = candidate.lot.remainingAvailable;
      candidate.lot.remainingAvailable = Math.max(before - reservation.reserved, 0);
      allocatedQty += reservation.allocated;
      usedCandidates.push(candidate);
      allocations.push({
        lotKey: candidate.lot.key,
        demandPartOptionId: candidate.option.demandPartOptionId ?? null,
        supplyLotId: candidate.lot.row.supplyLotId ?? null,
        allocatedQty: reservation.allocated,
        reservedQty: reservation.reserved,
        availableBefore: before,
        remainingQty: candidate.lot.remainingAvailable,
        supply: sourceTrace(candidate.lot.row)
      });
    }
  }

  const firstCandidate = usedCandidates[0] ?? currentCandidates[0] ?? exactCandidates[0] ?? null;
  exactCandidates.forEach((candidate) => candidate.warnings.forEach((warning) => warnings.add(warning)));
  if (!exactCandidates.length) warnings.add("missing_unit");
  if (historical) warnings.add("historical_not_current_stock");
  const invalidQuantity = requiredQty <= 0 || event.warnings.has("invalid_required_quantity");
  let reviewReason: OpportunityReasonCode | undefined;
  if (!historical && invalidQuantity) reviewReason = "invalid_quantity";
  else if (!historical && !automaticCandidates.length && exactCandidates.length) {
    const relations = new Set(exactCandidates.map((candidate) => candidate.relation));
    if (relations.has("conflict")) reviewReason = "manufacturer_conflict";
    else if (relations.has("approved_alias")) reviewReason = "manufacturer_alias_review";
    else if (exactCandidates.some((candidate) => candidate.warnings.has("incompatible_unit"))) reviewReason = "incompatible_unit";
    else if (exactCandidates.some((candidate) =>
      candidate.warnings.has("offer_expired") ||
      candidate.warnings.has("offer_validity_unknown") ||
      (candidate.lot.row.recordRole === "supplier_offer" && !supplierOfferIsLive(candidate.lot.row))
    )) reviewReason = "offer_not_live";
  }
  const codes = resultCodes({
    supplyRole: firstCandidate?.lot.row.recordRole ?? input.supplyRole,
    allocatedQty: historical ? 0 : allocatedQty,
    requiredQty,
    historical,
    reviewReason
  });
  const option = firstCandidate?.option ?? event.options[0];
  const supply = firstCandidate?.lot.row ?? null;
  const shortageQty = historical ? null : Math.max(requiredQty - allocatedQty, 0);
  const usableAvailabilityMatch = !historical && automaticCandidates.length > 0 && availableBefore > 0;
  const exactQuantityMatch = usableAvailabilityMatch && availableBefore === requiredQty && allocatedQty === requiredQty;
  const remainingQty = automaticCandidates.length
    ? automaticCandidates.reduce(
        (sum, candidate) => sum + Math.max(candidate.lot.remainingAvailable, 0),
        0
      )
    : supply
      ? Math.max(firstCandidate?.lot.remainingAvailable ?? 0, 0)
      : null;
  const currentLots = Array.from(new Map(
    currentCandidates.map((candidate) => [candidate.lot.key, candidate.lot])
  ).values());
  const commercial = historical
    ? {
        targetPrice: null,
        targetCurrency: null,
        offerPrice: null,
        offerCurrency: null,
        targetGapPercent: null,
        currency: null,
        revenuePotential: null,
        pricingQuality: "unconfirmed" as const,
        unitCost: null,
        costCurrency: null,
        grossProfit: null,
        grossMarginPercent: null,
        financialQuality: "untrusted" as const,
        moq: null,
        spq: null,
        dateCode: null,
        coo: null,
        leadTimeWeeks: null,
        condition: null,
        expiresAt: null
      }
    : commercialFields(option, usedCandidates, allocations, firstCandidate);

  return {
    jobId: input.jobId,
    opportunityType: codes.opportunityType,
    exactMpnMatch: exactCandidates.length > 0,
    exactMatch: exactCandidates.length > 0,
    usableAvailabilityMatch,
    exactQuantityMatch,
    matchTier: firstCandidate?.tier ?? null,
    confidence: firstCandidate?.confidence ?? (exactCandidates.length ? "review" : "low"),
    matchExplanation: firstCandidate
      ? `${firstCandidate.tier}; deterministic exact-MPN evaluation; lot ${firstCandidate.lot.key}`
      : "No exact normalized MPN was found in the confirmed supply source.",
    reviewStatus: codes.opportunityType === "review_required" ? "pending" : "not_required",
    demandEventKey: event.key,
    demandMpnOriginal: option.rawMpn,
    supplyMpnOriginal: supply?.rawMpn ?? null,
    displayMpn: option.displayMpn,
    normalizedMpn: option.normalizedMpn,
    manufacturer: option.manufacturer ?? supply?.manufacturer ?? null,
    manufacturerCanonical: option.manufacturerCanonical ?? supply?.manufacturerCanonical ?? null,
    customerContext: option.customerContext,
    supplierContext: supply?.supplierContext ?? option.supplierContext,
    requiredQty,
    availableQty: historical ? null : currentLots.reduce(
      (sum, lot) => sum + lot.originalAvailable,
      0
    ),
    allocatedQty: historical ? null : allocatedQty,
    remainingQty: historical ? null : remainingQty,
    shortageQty,
    coveragePercent: historical || requiredQty <= 0
      ? null
      : Math.round((allocatedQty / requiredQty) * 10_000) / 100,
    requiredDate: option.requiredDate,
    unitOfMeasure: option.unitOfMeasure,
    ...commercial,
    demandFileId: option.fileId,
    demandFileName: option.fileName,
    demandSheetName: Array.from(new Set(event.rows.map((row) => row.sheetName))).join(", "),
    supplyFileId: supply?.fileId ?? null,
    supplyFileName: supply?.fileName ?? null,
    supplySheetName: supply
      ? Array.from(new Set(exactCandidates.map((candidate) => candidate.lot.row.sheetName))).join(", ")
      : null,
    demandSourceRows: event.rows.length,
    supplySourceRows: new Set(exactCandidates.map((candidate) => candidate.lot.key)).size,
    demandTraces: event.rows.map(sourceTrace),
    supplyTraces: Array.from(
      new Map(exactCandidates.map((candidate) => [candidate.lot.key, sourceTrace(candidate.lot.row)])).values()
    ),
    allocations,
    reasonCode: codes.reasonCode,
    actionCode: codes.actionCode,
    warnings: Array.from(warnings)
  };
}

function possibleMatchesForEvent(
  jobId: string,
  event: DemandEvent,
  lots: SupplyLot[]
): PossibleOpportunityMatch[] {
  const matches: PossibleOpportunityMatch[] = [];
  const seen = new Set<string>();
  for (const option of event.options) {
    if (!option.reviewKey) continue;
    for (const lot of lots) {
      if (
        !lot.row.reviewKey ||
        option.reviewKey !== lot.row.reviewKey ||
        option.normalizedMpn === lot.row.normalizedMpn
      ) continue;
      const relation = manufacturerRelation(option, lot.row);
      if (relation === "conflict" || relation === "missing") continue;
      const key = candidateIdentity(jobId, event.key, option, lot);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        jobId,
        candidateKey: key,
        demandEventKey: event.key,
        demandOptionId: option.demandPartOptionId ?? null,
        supplyLotId: lot.row.supplyLotId ?? null,
        demandDisplayMpn: option.displayMpn,
        supplyDisplayMpn: lot.row.displayMpn,
        demandNormalizedMpn: option.normalizedMpn,
        supplyNormalizedMpn: lot.row.normalizedMpn,
        reviewKey: option.reviewKey,
        demandFileId: option.fileId,
        supplyFileId: lot.row.fileId,
        reasonCode: "symbol_variant",
        matchTier: "search_mpn_mfg",
        confidence: "review",
        reviewStatus: "pending",
        manufacturerCompatible: true,
        explanation: `Search-normalized symbol variant for demand event ${event.key}; human review is required.`,
        demandTrace: { ...sourceTrace(option), demandEventKey: event.key },
        supplyTrace: sourceTrace(lot.row)
      });
    }
  }
  return matches;
}

function supplyWithoutDemandResults(input: {
  jobId: string;
  lots: SupplyLot[];
  exactDemandMpns: Set<string>;
}) {
  const byMpn = new Map<string, SupplyLot[]>();
  for (const lot of input.lots) {
    if (isHistoricalSupply(lot.row)) continue;
    if (input.exactDemandMpns.has(lot.row.normalizedMpn) || lot.originalAvailable <= 0) continue;
    byMpn.set(lot.row.normalizedMpn, [...(byMpn.get(lot.row.normalizedMpn) ?? []), lot]);
  }
  const results: OpportunityResult[] = [];
  for (const lots of byMpn.values()) {
    const first = lots[0].row;
    const total = lots.reduce((sum, lot) => sum + lot.originalAvailable, 0);
    const remaining = lots.reduce((sum, lot) => sum + lot.remainingAvailable, 0);
    results.push({
      jobId: input.jobId,
      opportunityType: "supply_without_demand",
      exactMpnMatch: false,
      exactMatch: false,
      usableAvailabilityMatch: false,
      exactQuantityMatch: false,
      matchTier: null,
      confidence: "low",
      matchExplanation: "The supply MPN has no exact demand option in this comparison.",
      reviewStatus: "not_required",
      displayMpn: first.displayMpn,
      normalizedMpn: first.normalizedMpn,
      supplyMpnOriginal: first.rawMpn,
      manufacturer: first.manufacturer,
      manufacturerCanonical: first.manufacturerCanonical ?? null,
      customerContext: null,
      supplierContext: first.supplierContext,
      requiredQty: null,
      availableQty: total,
      allocatedQty: 0,
      remainingQty: remaining,
      shortageQty: null,
      coveragePercent: null,
      requiredDate: null,
      unitOfMeasure: first.unitOfMeasure,
      targetPrice: null,
      targetCurrency: null,
      offerPrice: first.offerPrice ?? null,
      offerCurrency: first.offerPrice !== null && first.offerPrice !== undefined &&
        first.currencyStatus === "confirmed" ? first.currency ?? null : null,
      targetGapPercent: null,
      currency: first.offerPrice !== null && first.offerPrice !== undefined &&
        first.currencyStatus === "confirmed" ? first.currency ?? null : null,
      revenuePotential: null,
      unitCost: first.unitCost ?? null,
      costCurrency: first.unitCost !== null && first.unitCost !== undefined &&
        first.currencyStatus === "confirmed" ? first.currency ?? null : null,
      grossProfit: null,
      grossMarginPercent: null,
      moq: first.moq ?? null,
      spq: first.spq ?? null,
      dateCode: first.dateCode ?? null,
      coo: first.coo ?? null,
      leadTimeWeeks: first.leadTimeWeeks ?? null,
      condition: first.condition ?? null,
      expiresAt: first.expiresAt ?? null,
      demandFileId: null,
      demandFileName: null,
      demandSheetName: null,
      supplyFileId: first.fileId,
      supplyFileName: first.fileName,
      supplySheetName: Array.from(new Set(lots.map((lot) => lot.row.sheetName))).join(", "),
      demandSourceRows: 0,
      supplySourceRows: lots.length,
      demandTraces: [],
      supplyTraces: lots.map((lot) => sourceTrace(lot.row)),
      allocations: [],
      reasonCode: "supply_has_no_demand",
      actionCode: "find_buyer",
      warnings: Array.from(new Set(lots.flatMap((lot) => lot.row.qualityFlags)))
    });
  }
  return results;
}

function countSummary(
  results: OpportunityResult[],
  input: {
    analyzedMpns: number;
    exactMatches: number;
    demandEvents: number;
    demandPartOptions: number;
    supplyLots: number;
  }
) {
  const summary = emptySummary();
  Object.assign(summary, input);
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
  clientContext?: string | null;
  missingMpnRows?: number;
  invalidQuantityRows?: number;
  rejectedRows?: number;
}): OpportunityMatchOutput {
  const compatibility = evaluateOpportunityCompatibility(input.roleA, input.roleB);
  if (!compatibility.compatible || !compatibility.demandSide || !compatibility.supplySide) {
    throw new Error(`Incompatible opportunity roles: ${compatibility.reasonCode}`);
  }
  const supplyRole = compatibility.supplySide === "A" ? input.roleA : input.roleB;
  const fallbackHistorical = HISTORY_ROLES.has(supplyRole);
  const clientContext = input.clientContext?.normalize("NFKC").trim().replace(/\s+/g, " ") || null;
  const demandRows = input.rows.filter((row) =>
    row.side === compatibility.demandSide &&
    row.recordRole === "demand" &&
    row.isActiveDemand !== false &&
    row.normalizedMpn
  ).map((row) => !row.customerContext && clientContext
    ? { ...row, customerContext: clientContext }
    : row);
  const supplyRows = input.rows.filter((row) => {
    if (!row.normalizedMpn) return false;
    const selectedSupply = row.side === compatibility.supplySide && row.recordRole === supplyRole;
    const embeddedOffer = !fallbackHistorical &&
      row.recordKind === "supply_lot" && row.recordRole === "supplier_offer";
    return selectedSupply || embeddedOffer;
  });
  const events = groupDemandEvents(demandRows);
  const lots = buildSupplyLots(Array.from(new Map(supplyRows.map((row) => [
    row.supplyLotKey || `${row.fileId}:${row.sheetName}:${row.sourceRow}:${row.originalIndex}`,
    row
  ])).values()));
  const results: OpportunityResult[] = [];
  const possibleMatches: PossibleOpportunityMatch[] = [];
  const exactMatchedMpns = new Set<string>();
  const demandMpns = new Set(events.flatMap((event) => event.options.map((option) => option.normalizedMpn)));

  for (const event of events) {
    const candidates = sortedCandidates(event, lots);
    candidates.forEach((candidate) => exactMatchedMpns.add(candidate.option.normalizedMpn));
    const result = buildDemandResult({
      jobId: input.jobId,
      event,
      supplyRole,
      candidates,
      fallbackHistorical
    });
    if (result) results.push(result);
    if (!fallbackHistorical) {
      possibleMatches.push(...possibleMatchesForEvent(input.jobId, event, lots));
    }
  }

  if (lots.some((lot) => !isHistoricalSupply(lot.row))) {
    results.push(...supplyWithoutDemandResults({
      jobId: input.jobId,
      lots,
      exactDemandMpns: demandMpns
    }));
  }

  const uniquePossible = Array.from(new Map(possibleMatches.map((match) => [
    match.candidateKey,
    match
  ])).values());
  results.sort((left, right) =>
    RESULT_ORDER[left.opportunityType] - RESULT_ORDER[right.opportunityType] ||
    dateSortValue(left.requiredDate) - dateSortValue(right.requiredDate) ||
    left.normalizedMpn.localeCompare(right.normalizedMpn) ||
    (left.demandEventKey ?? "").localeCompare(right.demandEventKey ?? "")
  );
  const summary = countSummary(results, {
    analyzedMpns: new Set([...demandMpns, ...lots.map((lot) => lot.row.normalizedMpn)]).size,
    exactMatches: exactMatchedMpns.size,
    demandEvents: events.length,
    demandPartOptions: events.reduce((sum, event) => sum + event.options.length, 0),
    supplyLots: lots.length
  });
  summary.missingMpnRows = input.missingMpnRows ?? 0;
  summary.invalidQuantityRows = input.invalidQuantityRows ?? 0;
  summary.rejectedRows = input.rejectedRows ?? 0;
  summary.possibleMatches = uniquePossible.length;
  return { results, possibleMatches: uniquePossible, summary, rejectedRows: [] };
}

export const SAFE_RESULT_KEYS = new Set<keyof OpportunityResult>([
  "id",
  "candidateId",
  "jobId",
  "opportunityType",
  "exactMpnMatch",
  "exactMatch",
  "usableAvailabilityMatch",
  "exactQuantityMatch",
  "matchTier",
  "confidence",
  "matchExplanation",
  "reviewStatus",
  "demandEventKey",
  "demandMpnOriginal",
  "supplyMpnOriginal",
  "displayMpn",
  "normalizedMpn",
  "manufacturer",
  "manufacturerCanonical",
  "customerContext",
  "supplierContext",
  "requiredQty",
  "availableQty",
  "allocatedQty",
  "remainingQty",
  "shortageQty",
  "coveragePercent",
  "requiredDate",
  "unitOfMeasure",
  "targetPrice",
  "targetCurrency",
  "offerPrice",
  "offerCurrency",
  "targetGapPercent",
  "currency",
  "revenuePotential",
  "pricingQuality",
  "unitCost",
  "costCurrency",
  "grossProfit",
  "grossMarginPercent",
  "financialQuality",
  "moq",
  "spq",
  "dateCode",
  "coo",
  "leadTimeWeeks",
  "condition",
  "expiresAt",
  "demandFileId",
  "demandFileName",
  "demandSheetName",
  "supplyFileId",
  "supplyFileName",
  "supplySheetName",
  "demandSourceRows",
  "supplySourceRows",
  "demandTraces",
  "supplyTraces",
  "allocations",
  "reasonCode",
  "actionCode",
  "warnings"
]);

/**
 * Backward-compatible test helper. Commercial keys are permitted only when
 * they carry a value and must then be redacted by the role-aware API layer.
 */
export function containsForbiddenOpportunityFields(value: unknown) {
  const forbidden = /(^|[_\s])(price|cost|unit cost|gp|gp rate|margin|commission|raw data)([_\s]|$)|price|cost|grossprofit|grossmargin|commission|rawdata/i;
  const visit = (item: unknown): boolean => {
    if (Array.isArray(item)) return item.some(visit);
    if (!item || typeof item !== "object") return false;
    return Object.entries(item as Record<string, unknown>).some(([key, nested]) => {
      if (forbidden.test(key) && nested !== null && nested !== undefined && nested !== "") return true;
      return visit(nested);
    });
  };
  return visit(value);
}

export type OpportunityResultCodes = {
  opportunityType: OpportunityType;
  reasonCode: OpportunityReasonCode;
  actionCode: OpportunityActionCode;
};
