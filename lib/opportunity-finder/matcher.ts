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
  key: string | null;
  rows: CanonicalOpportunityRow[];
  options: CanonicalOpportunityRow[];
  requiredQty: number;
  firstSourceRow: number;
  firstOriginalIndex: number;
  warnings?: Set<OpportunityWarningCode>;
};

type SupplyLot = {
  key: string;
  row: CanonicalOpportunityRow;
  originalAvailable: number;
  remainingAvailable: number;
  exactManufacturer: string;
  canonicalManufacturer: string;
  normalizedUnit: string;
  automaticGroup: AutomaticSupplyGroup | null;
};

type SharedAutomaticSupplyGroup = {
  remaining: number;
};

type AutomaticSupplyGroup = SupplyLot | SharedAutomaticSupplyGroup;

type SupplyReviewBucket = SupplyLot[] | Map<string, SupplyLot[]>;
type AdaptiveLotGroup = SupplyLot | SupplyLot[];
type AdaptiveLotIndex = Map<string, AdaptiveLotGroup>;

type SupplyIndex = {
  lots: SupplyLot[];
  bucketsByMpn: Map<string, SupplyMpnBucket>;
  reviewByKey: Map<string, SupplyReviewBucket>;
};

type SupplyMpnBucket = {
  lots: SupplyLot[];
  currentLots: number;
  currentOriginalAvailable: number;
  compactIndexes?: SupplyMpnCompactIndexes;
};

type SupplyMpnCompactIndexes = {
  byExactManufacturer: AdaptiveLotIndex;
  byCanonicalManufacturer: AdaptiveLotIndex;
  byUnit: AdaptiveLotIndex;
  liveByUnit: AdaptiveLotIndex;
  unitLotsByLargeExactManufacturer: Map<string, AdaptiveLotIndex>;
  unitLotsByLargeCanonicalManufacturer: Map<string, AdaptiveLotIndex>;
  canonicalCountsByLargeExactManufacturer: Map<string, Map<string, number>>;
  warningLots: Map<OpportunityWarningCode, AdaptiveLotGroup>;
  warningLotsByExactManufacturer: Map<OpportunityWarningCode, AdaptiveLotIndex>;
  warningLotsByCanonicalManufacturer: Map<OpportunityWarningCode, AdaptiveLotIndex>;
  bySheet: AdaptiveLotIndex;
  sheetLotsByExactManufacturer: Map<string, AdaptiveLotIndex>;
  sheetLotsByCanonicalManufacturer: Map<string, AdaptiveLotIndex>;
};

type RowMatchKeys = {
  exactManufacturer: string;
  canonicalManufacturer: string;
  normalizedUnit: string;
};

type MatcherContext = {
  now: number;
  rowKeys?: WeakMap<CanonicalOpportunityRow, RowMatchKeys>;
  sourceTraces?: WeakMap<CanonicalOpportunityRow, OpportunitySourceTrace>;
  diagnostics?: OpportunityMatcherDiagnostics;
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

type CandidateTemplate = Omit<Candidate, "option"> & {
  optionIndex: number;
};

type CandidateRank = Pick<
  CandidateTemplate,
  "automatic" | "lot" | "optionIndex" | "tier"
>;

type CompactOptionDetail = {
  option: CanonicalOpportunityRow;
  index: number;
  keys: RowMatchKeys;
};

type CompactDemandOptionIndex = {
  first: CompactOptionDetail;
  firstMissingManufacturer?: CompactOptionDetail;
  firstMissingUnit?: CompactOptionDetail;
  byExactManufacturer: Map<string, CompactOptionDetail>;
  byCanonicalManufacturer: Map<string, CompactOptionDetail>;
  byUnit: Map<string, CompactOptionDetail>;
};

type CandidatePlan = {
  entries: CandidateTemplate[];
  currentEntries: CandidateTemplate[];
  automaticEntries: CandidateTemplate[];
  automaticGroups: Set<AutomaticSupplyGroup>;
  warningOrder: OpportunityWarningCode[];
  supplyTraces: OpportunitySourceTrace[];
  supplySheetName: string | null;
  currentOriginalAvailable: number;
  matchedMpns: string[];
  entryCount: number;
  currentEntryCount: number;
  relations: Set<ManufacturerRelation>;
  hasIncompatibleUnit: boolean;
  hasOfferIssue: boolean;
  compact: boolean;
  allocationCursor: number;
  permanentAllocationWarnings: OpportunityWarningCode[];
};

export type OpportunityMatcherDiagnostics = {
  demandEvents: number;
  supplyLots: number;
  optionDedupComparisons: number;
  exactCandidateComparisons: number;
  reviewCandidateComparisons: number;
  exactCandidatesCreated: number;
  possibleMatchesCreated: number;
  exactIndexLookups: number;
  reviewIndexLookups: number;
  normalizationCalls: number;
  maxCandidateMaterialization: number;
  candidatePlanCacheHits: number;
  automaticGroupReads: number;
  allocationCandidatesVisited: number;
  provenancePreviewCandidates: number;
  maxProvenancePreviewMaterialization: number;
  candidateIndexEntriesVisited: number;
};

export function createOpportunityMatcherDiagnostics(): OpportunityMatcherDiagnostics {
  return {
    demandEvents: 0,
    supplyLots: 0,
    optionDedupComparisons: 0,
    exactCandidateComparisons: 0,
    reviewCandidateComparisons: 0,
    exactCandidatesCreated: 0,
    possibleMatchesCreated: 0,
    exactIndexLookups: 0,
    reviewIndexLookups: 0,
    normalizationCalls: 0,
    maxCandidateMaterialization: 0,
    candidatePlanCacheHits: 0,
    automaticGroupReads: 0,
    allocationCandidatesVisited: 0,
    provenancePreviewCandidates: 0,
    maxProvenancePreviewMaterialization: 0,
    candidateIndexEntriesVisited: 0
  };
}

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

function demandEventIdentity(event: DemandEvent) {
  return event.key ?? legacyDemandKey(event.rows[0]);
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

function compareCanonicalRows(
  left: CanonicalOpportunityRow,
  right: CanonicalOpportunityRow
) {
  return (
    left.normalizedMpn.localeCompare(right.normalizedMpn) ||
    dateSortValue(left.requiredDate) - dateSortValue(right.requiredDate) ||
    left.originalIndex - right.originalIndex ||
    left.fileId.localeCompare(right.fileId) ||
    left.sheetName.localeCompare(right.sheetName) ||
    left.sourceRow - right.sourceRow ||
    (left.optionOrdinal ?? Number.MAX_SAFE_INTEGER) -
      (right.optionOrdinal ?? Number.MAX_SAFE_INTEGER) ||
    exactManufacturer(left.manufacturer).localeCompare(exactManufacturer(right.manufacturer)) ||
    left.rawMpn.localeCompare(right.rawMpn) ||
    (left.demandPartOptionId ?? "").localeCompare(right.demandPartOptionId ?? "") ||
    (left.supplyLotId ?? "").localeCompare(right.supplyLotId ?? "") ||
    (left.supplyLotKey ?? "").localeCompare(right.supplyLotKey ?? "") ||
    (left.requiredDate ?? "").localeCompare(right.requiredDate ?? "") ||
    (left.unitOfMeasure ?? "").localeCompare(right.unitOfMeasure ?? "") ||
    (left.requiredQty ?? Number.NEGATIVE_INFINITY) -
      (right.requiredQty ?? Number.NEGATIVE_INFINITY) ||
    (left.availableQty ?? Number.NEGATIVE_INFINITY) -
      (right.availableQty ?? Number.NEGATIVE_INFINITY) ||
    (left.offerPrice ?? Number.NEGATIVE_INFINITY) -
      (right.offerPrice ?? Number.NEGATIVE_INFINITY) ||
    [...left.qualityFlags].sort().join("\u001f").localeCompare(
      [...right.qualityFlags].sort().join("\u001f")
    )
  );
}

function compareSupplyRows(
  left: CanonicalOpportunityRow,
  right: CanonicalOpportunityRow
) {
  return (
    (SUPPLY_ROLE_ORDER[left.recordRole] ?? Number.MAX_SAFE_INTEGER) -
      (SUPPLY_ROLE_ORDER[right.recordRole] ?? Number.MAX_SAFE_INTEGER) ||
    compareCanonicalRows(left, right)
  );
}

function supplyRowIdentity(row: CanonicalOpportunityRow) {
  return row.supplyLotKey ||
    `${row.fileId}:${row.sheetName}:${row.sourceRow}:${row.originalIndex}`;
}

function stableSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableSemanticValue(nested)]));
}

function semanticRowKey(row: CanonicalOpportunityRow) {
  return JSON.stringify(stableSemanticValue({
    ...row,
    qualityFlags: [...row.qualityFlags].sort()
  }));
}

function compareDemandRows(
  left: CanonicalOpportunityRow,
  right: CanonicalOpportunityRow
) {
  return compareCanonicalRows(left, right) ||
    semanticRowKey(left).localeCompare(semanticRowKey(right));
}

function* deduplicateSupplyRowsSteps(
  rows: CanonicalOpportunityRow[],
  work: MatcherWorkBudget
): Generator<void, CanonicalOpportunityRow[], void> {
  const deduplicated = new Map<string, CanonicalOpportunityRow>();
  const duplicateQualityFlags = new Map<string, Set<OpportunityWarningCode>>();
  for (const row of rows) {
    if (matcherWorkStep(work)) yield;
    const key = supplyRowIdentity(row);
    const existing = deduplicated.get(key);
    if (!existing) {
      deduplicated.set(key, row);
      continue;
    }
    const qualityFlags = duplicateQualityFlags.get(key) ?? new Set(existing.qualityFlags);
    row.qualityFlags.forEach((warning) => qualityFlags.add(warning));
    duplicateQualityFlags.set(key, qualityFlags);
    if (semanticRowKey(row).localeCompare(semanticRowKey(existing)) < 0) {
      deduplicated.set(key, row);
    }
  }
  const result: CanonicalOpportunityRow[] = [];
  for (const [key, winner] of deduplicated) {
    const duplicateFlags = duplicateQualityFlags.get(key);
    const canonicalFlags = duplicateFlags
      ? Array.from(duplicateFlags).sort()
      : winner.qualityFlags.length <= 1
        ? winner.qualityFlags
        : Array.from(new Set(winner.qualityFlags)).sort();
    const alreadyCanonical = canonicalFlags.length === winner.qualityFlags.length &&
      canonicalFlags.every((warning, index) => warning === winner.qualityFlags[index]);
    result.push(alreadyCanonical ? winner : { ...winner, qualityFlags: canonicalFlags });
    if (matcherWorkStep(work)) yield;
  }
  return result.sort(compareSupplyRows);
}

function rowMatchKeys(row: CanonicalOpportunityRow, context: MatcherContext): RowMatchKeys {
  const cached = context.rowKeys?.get(row);
  if (cached) return cached;
  const keys = computeRowMatchKeys(row, context);
  context.rowKeys?.set(row, keys);
  return keys;
}

function computeRowMatchKeys(
  row: CanonicalOpportunityRow,
  context: MatcherContext
): RowMatchKeys {
  const keys = {
    exactManufacturer: exactManufacturer(row.manufacturer),
    canonicalManufacturer: row.manufacturerCanonical || normalizeManufacturer(row.manufacturer),
    normalizedUnit: normalizeUnit(row.unitOfMeasure)
  };
  if (context.diagnostics) context.diagnostics.normalizationCalls += 3;
  return keys;
}

function supplierOfferIsLive(row: CanonicalOpportunityRow, now = Date.now()) {
  if (row.recordRole !== "supplier_offer" || row.isLiveSupply === false) return false;
  if (!row.expiresAt) return false;
  const expiry = new Date(row.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > now;
}

function manufacturerRelation(
  demand: CanonicalOpportunityRow,
  supply: SupplyLot,
  context: MatcherContext
): ManufacturerRelation {
  const demandKeys = rowMatchKeys(demand, context);
  if (!demandKeys.exactManufacturer || !supply.exactManufacturer) return "missing";
  if (demandKeys.exactManufacturer === supply.exactManufacturer) return "exact";
  return demandKeys.canonicalManufacturer && supply.canonicalManufacturer &&
    demandKeys.canonicalManufacturer === supply.canonicalManufacturer
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

// Full candidate materialization is retained for ordinary buckets so the
// certified output stays byte-for-byte compatible. Larger buckets use the
// composite manufacturer/UOM indexes below and materialize only candidates
// that can influence allocation or ranking.
const FULL_CANDIDATE_PLAN_LIMIT = 128;
const COMPACT_TRACE_PREVIEW_LIMIT = 32;
const COMPACT_CANDIDATE_PLAN_CACHE_LIMIT = 128;

type MatcherWorkBudget = {
  operations: number;
  operationsPerYield: number;
};

function matcherWorkBudget(operationsPerYield = Number.POSITIVE_INFINITY): MatcherWorkBudget {
  return { operations: 0, operationsPerYield };
}

function boundedMatcherControlValue(
  value: number | undefined,
  fallback: number,
  maximum: number
) {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), maximum));
}

function matcherWorkStep(work: MatcherWorkBudget, count = 1) {
  if (!Number.isFinite(work.operationsPerYield)) return false;
  work.operations += count;
  if (work.operations < work.operationsPerYield) return false;
  work.operations %= work.operationsPerYield;
  return true;
}

function runMatcherStepsSynchronously<T>(steps: Generator<void, T, void>) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

async function runMatcherStepsCooperatively<T>(
  steps: Generator<void, T, void>,
  assertNotCancelled?: () => void | Promise<void>
) {
  let step = steps.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assertNotCancelled?.();
    step = steps.next();
  }
  return step.value;
}

async function yieldMatcherControl(
  assertNotCancelled?: () => void | Promise<void>
) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assertNotCancelled?.();
}

function compareSupplyLots(left: SupplyLot, right: SupplyLot) {
  return (
    (SUPPLY_ROLE_ORDER[left.row.recordRole] ?? Number.MAX_SAFE_INTEGER) -
      (SUPPLY_ROLE_ORDER[right.row.recordRole] ?? Number.MAX_SAFE_INTEGER) ||
    (left.row.offerPrice ?? Number.MAX_SAFE_INTEGER) -
      (right.row.offerPrice ?? Number.MAX_SAFE_INTEGER) ||
    left.row.originalIndex - right.row.originalIndex ||
    left.key.localeCompare(right.key)
  );
}

function appendIndexValue<T>(map: Map<string, T[]>, key: string, value: T) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function appendAdaptiveLot<K>(
  map: Map<K, AdaptiveLotGroup>,
  key: K,
  lot: SupplyLot
) {
  const existing = map.get(key);
  if (!existing) map.set(key, lot);
  else if (Array.isArray(existing)) existing.push(lot);
  else map.set(key, [existing, lot]);
}

function adaptiveLots(group: AdaptiveLotGroup | undefined): SupplyLot[] {
  if (!group) return [];
  return Array.isArray(group) ? group : [group];
}

function adaptiveLotCount(group: AdaptiveLotGroup | undefined) {
  if (!group) return 0;
  return Array.isArray(group) ? group.length : 1;
}

function* supplyMpnCompactIndexSteps(
  bucket: SupplyMpnBucket,
  context: MatcherContext,
  work: MatcherWorkBudget
): Generator<void, SupplyMpnCompactIndexes, void> {
  if (bucket.compactIndexes) return bucket.compactIndexes;
  let canonicalMatchesExact = true;
  let allLotsLive = true;
  for (const lot of bucket.lots) {
    canonicalMatchesExact &&= lot.canonicalManufacturer === lot.exactManufacturer;
    allLotsLive &&= lot.automaticGroup !== null;
    if (matcherWorkStep(work)) yield;
  }
  const byExactManufacturer: AdaptiveLotIndex = new Map();
  const byCanonicalManufacturer: AdaptiveLotIndex = canonicalMatchesExact
    ? byExactManufacturer
    : new Map();
  const byUnit: AdaptiveLotIndex = new Map();
  const liveByUnit: AdaptiveLotIndex = allLotsLive ? byUnit : new Map();
  const warningLots = new Map<OpportunityWarningCode, AdaptiveLotGroup>();
  const bySheet: AdaptiveLotIndex = new Map();

  for (const lot of bucket.lots) {
    appendAdaptiveLot(byExactManufacturer, lot.exactManufacturer, lot);
    if (!canonicalMatchesExact) {
      appendAdaptiveLot(byCanonicalManufacturer, lot.canonicalManufacturer, lot);
    }
    appendAdaptiveLot(byUnit, lot.normalizedUnit, lot);
    if (!allLotsLive && lot.automaticGroup) {
      appendAdaptiveLot(liveByUnit, lot.normalizedUnit, lot);
    }
    appendAdaptiveLot(bySheet, lot.row.sheetName, lot);
    const intrinsicWarnings = new Set<OpportunityWarningCode>(lot.row.qualityFlags);
    if (lot.row.isLiveSupply === false) intrinsicWarnings.add("offer_expired");
    if (lot.row.expiresAt) {
      const expiry = new Date(lot.row.expiresAt).getTime();
      const warning = !Number.isFinite(expiry)
        ? "offer_validity_unknown"
        : expiry <= context.now
          ? "offer_expired"
          : null;
      if (warning) intrinsicWarnings.add(warning);
    } else if (lot.row.recordRole === "supplier_offer") {
      intrinsicWarnings.add("offer_validity_unknown");
    }
    for (const warning of intrinsicWarnings) {
      appendAdaptiveLot(warningLots, warning, lot);
      if (matcherWorkStep(work)) yield;
    }
    if (matcherWorkStep(work)) yield;
  }

  const unitLotsByLargeExactManufacturer = new Map<string, AdaptiveLotIndex>();
  const canonicalCountsByLargeExactManufacturer = new Map<string, Map<string, number>>();
  for (const [manufacturer, group] of byExactManufacturer) {
    if (adaptiveLotCount(group) <= FULL_CANDIDATE_PLAN_LIMIT) continue;
    const byManufacturerUnit: AdaptiveLotIndex = new Map();
    const canonicalCounts = new Map<string, number>();
    for (const lot of adaptiveLots(group)) {
      appendAdaptiveLot(byManufacturerUnit, lot.normalizedUnit, lot);
      canonicalCounts.set(
        lot.canonicalManufacturer,
        (canonicalCounts.get(lot.canonicalManufacturer) ?? 0) + 1
      );
      if (matcherWorkStep(work)) yield;
    }
    unitLotsByLargeExactManufacturer.set(manufacturer, byManufacturerUnit);
    canonicalCountsByLargeExactManufacturer.set(manufacturer, canonicalCounts);
  }
  const unitLotsByLargeCanonicalManufacturer = canonicalMatchesExact
    ? unitLotsByLargeExactManufacturer
    : new Map<string, AdaptiveLotIndex>();
  if (!canonicalMatchesExact) {
    for (const [manufacturer, group] of byCanonicalManufacturer) {
      if (adaptiveLotCount(group) <= FULL_CANDIDATE_PLAN_LIMIT) continue;
      const byManufacturerUnit: AdaptiveLotIndex = new Map();
      for (const lot of adaptiveLots(group)) {
        appendAdaptiveLot(byManufacturerUnit, lot.normalizedUnit, lot);
        if (matcherWorkStep(work)) yield;
      }
      unitLotsByLargeCanonicalManufacturer.set(manufacturer, byManufacturerUnit);
    }
  }

  const warningLotsByExactManufacturer = new Map<OpportunityWarningCode, AdaptiveLotIndex>();
  const warningLotsByCanonicalManufacturer = new Map<OpportunityWarningCode, AdaptiveLotIndex>();
  for (const [warning, group] of warningLots) {
    if (adaptiveLotCount(group) <= FULL_CANDIDATE_PLAN_LIMIT) continue;
    if (adaptiveLotCount(group) === bucket.lots.length) {
      warningLotsByExactManufacturer.set(warning, byExactManufacturer);
      warningLotsByCanonicalManufacturer.set(warning, byCanonicalManufacturer);
      continue;
    }
    const exactIndex: AdaptiveLotIndex = new Map();
    const canonicalIndex: AdaptiveLotIndex = canonicalMatchesExact ? exactIndex : new Map();
    for (const lot of adaptiveLots(group)) {
      appendAdaptiveLot(exactIndex, lot.exactManufacturer, lot);
      if (!canonicalMatchesExact) appendAdaptiveLot(canonicalIndex, lot.canonicalManufacturer, lot);
      if (matcherWorkStep(work)) yield;
    }
    warningLotsByExactManufacturer.set(warning, exactIndex);
    warningLotsByCanonicalManufacturer.set(warning, canonicalIndex);
  }

  const sheetLotsByExactManufacturer = new Map<string, AdaptiveLotIndex>();
  const sheetLotsByCanonicalManufacturer = new Map<string, AdaptiveLotIndex>();
  for (const [sheet, group] of bySheet) {
    if (adaptiveLotCount(group) <= FULL_CANDIDATE_PLAN_LIMIT) continue;
    if (adaptiveLotCount(group) === bucket.lots.length) {
      sheetLotsByExactManufacturer.set(sheet, byExactManufacturer);
      sheetLotsByCanonicalManufacturer.set(sheet, byCanonicalManufacturer);
      continue;
    }
    const exactIndex: AdaptiveLotIndex = new Map();
    const canonicalIndex: AdaptiveLotIndex = canonicalMatchesExact ? exactIndex : new Map();
    for (const lot of adaptiveLots(group)) {
      appendAdaptiveLot(exactIndex, lot.exactManufacturer, lot);
      if (!canonicalMatchesExact) appendAdaptiveLot(canonicalIndex, lot.canonicalManufacturer, lot);
      if (matcherWorkStep(work)) yield;
    }
    sheetLotsByExactManufacturer.set(sheet, exactIndex);
    sheetLotsByCanonicalManufacturer.set(sheet, canonicalIndex);
  }

  const compactIndexes = {
    byExactManufacturer,
    byCanonicalManufacturer,
    byUnit,
    liveByUnit,
    unitLotsByLargeExactManufacturer,
    unitLotsByLargeCanonicalManufacturer,
    canonicalCountsByLargeExactManufacturer,
    warningLots,
    warningLotsByExactManufacturer,
    warningLotsByCanonicalManufacturer,
    bySheet,
    sheetLotsByExactManufacturer,
    sheetLotsByCanonicalManufacturer
  } satisfies SupplyMpnCompactIndexes;
  bucket.compactIndexes = compactIndexes;
  return compactIndexes;
}

function sourceTrace(
  row: CanonicalOpportunityRow,
  context: MatcherContext
): OpportunitySourceTrace {
  const cached = context.sourceTraces?.get(row);
  if (cached) return cached;
  const trace: OpportunitySourceTrace = {
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
  context.sourceTraces?.set(row, trace);
  return trace;
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

function* groupDemandEventSteps(
  rows: CanonicalOpportunityRow[],
  context: MatcherContext,
  work: MatcherWorkBudget
): Generator<void, DemandEvent[], void> {
  const groups = new Map<string, DemandEvent>();
  for (const row of rows) {
    if (matcherWorkStep(work)) yield;
    const explicitEvent = row.demandEventKey?.trim();
    const groupKey = explicitEvent || legacyDemandKey(row);
    const existing = groups.get(groupKey) ?? {
      key: explicitEvent || null,
      rows: [],
      options: [],
      requiredQty: 0,
      firstSourceRow: row.sourceRow,
      firstOriginalIndex: row.originalIndex
    };
    existing.rows.push(row);
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
    if (row.qualityFlags.length) {
      existing.warnings ??= new Set<OpportunityWarningCode>();
      row.qualityFlags.forEach((warning) => existing.warnings?.add(warning));
    }
    groups.set(groupKey, existing);
  }
  for (const event of groups.values()) {
    event.rows.sort(compareDemandRows);
    const optionKeys = new Set<string>();
    for (const row of event.rows) {
      const optionKey = JSON.stringify([
        row.normalizedMpn,
        rowMatchKeys(row, context).exactManufacturer
      ]);
      if (!optionKeys.has(optionKey)) {
        event.options.push(row);
        optionKeys.add(optionKey);
      }
      if (matcherWorkStep(work)) yield;
    }
    if (event.options.length === event.rows.length) event.options = event.rows;
    if (matcherWorkStep(work)) yield;
  }
  return Array.from(groups.values()).sort((left, right) => {
    const leftMpn = left.options[0]?.normalizedMpn ?? "";
    const rightMpn = right.options[0]?.normalizedMpn ?? "";
    return (
      leftMpn.localeCompare(rightMpn) ||
      dateSortValue(left.rows[0]?.requiredDate ?? null) - dateSortValue(right.rows[0]?.requiredDate ?? null) ||
      left.firstOriginalIndex - right.firstOriginalIndex ||
      left.firstSourceRow - right.firstSourceRow ||
      demandEventIdentity(left).localeCompare(demandEventIdentity(right))
    );
  });
}

function* buildSupplyIndexSteps(
  rows: CanonicalOpportunityRow[],
  context: MatcherContext,
  work: MatcherWorkBudget
): Generator<void, SupplyIndex, void> {
  const lots: SupplyLot[] = [];
  const lotsByMpn = new Map<string, SupplyLot[]>();
  const reviewByKey = new Map<string, SupplyReviewBucket>();
  for (const row of rows) {
    if (matcherWorkStep(work)) yield;
    const parsed = supplyQuantity(row);
    const quantity = parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const keys = computeRowMatchKeys(row, context);
    const lot: SupplyLot = {
      key: row.supplyLotKey || `${row.fileId}:${row.sheetName}:${row.sourceRow}:${row.originalIndex}`,
      row,
      originalAvailable: quantity,
      remainingAvailable: quantity,
      exactManufacturer: keys.exactManufacturer,
      canonicalManufacturer: keys.canonicalManufacturer,
      normalizedUnit: keys.normalizedUnit,
      automaticGroup: null
    };
    lots.push(lot);
    const exactLots = lotsByMpn.get(row.normalizedMpn);
    if (exactLots) exactLots.push(lot);
    else lotsByMpn.set(row.normalizedMpn, [lot]);
    if (row.reviewKey) {
      const reviewBucket = reviewByKey.get(row.reviewKey);
      if (!reviewBucket) {
        reviewByKey.set(row.reviewKey, [lot]);
      } else if (Array.isArray(reviewBucket)) {
        if (reviewBucket.length < FULL_CANDIDATE_PLAN_LIMIT) {
          reviewBucket.push(lot);
        } else {
          const byMpn = new Map<string, SupplyLot[]>();
          for (const existing of reviewBucket) {
            appendIndexValue(byMpn, existing.row.normalizedMpn, existing);
          }
          appendIndexValue(byMpn, row.normalizedMpn, lot);
          reviewByKey.set(row.reviewKey, byMpn);
        }
      } else {
        appendIndexValue(reviewBucket, row.normalizedMpn, lot);
      }
    }
  }
  const bucketsByMpn = new Map<string, SupplyMpnBucket>();
  for (const [mpn, indexedLots] of lotsByMpn) {
    if (matcherWorkStep(work)) yield;
    const sortedLots = indexedLots.sort(compareSupplyLots);
    const currentAndUsableLots: SupplyLot[] = [];
    let currentLots = 0;
    let currentOriginalAvailable = 0;
    for (const lot of sortedLots) {
      if (matcherWorkStep(work)) yield;
      if (!isHistoricalSupply(lot.row)) {
        currentLots += 1;
        currentOriginalAvailable += lot.originalAvailable;
      }
      const expiry = lot.row.expiresAt ? new Date(lot.row.expiresAt).getTime() : Number.NaN;
      const explicitlyExpired = Number.isFinite(expiry) && expiry <= context.now;
      const currentAndUsable = !isHistoricalSupply(lot.row) && (
        lot.row.recordRole === "supplier_offer"
          ? supplierOfferIsLive(lot.row, context.now)
          : lot.row.isLiveSupply !== false && !explicitlyExpired
      );
      if (currentAndUsable) currentAndUsableLots.push(lot);
    }
    currentAndUsableLots.sort((left, right) =>
      left.exactManufacturer.localeCompare(right.exactManufacturer) ||
      left.normalizedUnit.localeCompare(right.normalizedUnit) ||
      compareSupplyLots(left, right)
    );
    for (let start = 0; start < currentAndUsableLots.length;) {
      const first = currentAndUsableLots[start];
      let end = start + 1;
      let remaining = first.originalAvailable;
      while (
        end < currentAndUsableLots.length &&
        currentAndUsableLots[end].exactManufacturer === first.exactManufacturer &&
        currentAndUsableLots[end].normalizedUnit === first.normalizedUnit
      ) {
        remaining += currentAndUsableLots[end].originalAvailable;
        end += 1;
        if (matcherWorkStep(work)) yield;
      }
      if (end === start + 1) {
        first.automaticGroup = first;
      } else {
        const sharedGroup: SharedAutomaticSupplyGroup = { remaining };
        for (let index = start; index < end; index += 1) {
          currentAndUsableLots[index].automaticGroup = sharedGroup;
          if (matcherWorkStep(work)) yield;
        }
      }
      start = end;
      if (matcherWorkStep(work)) yield;
    }
    bucketsByMpn.set(mpn, {
      lots: sortedLots,
      currentLots,
      currentOriginalAvailable
    });
  }
  return { lots, bucketsByMpn, reviewByKey };
}

function unitCompatibility(
  demand: CanonicalOpportunityRow,
  supply: SupplyLot,
  context: MatcherContext
) {
  const demandUnit = rowMatchKeys(demand, context).normalizedUnit;
  const supplyUnit = supply.normalizedUnit;
  if (!demandUnit || !supplyUnit) {
    return { compatible: true, warning: "missing_unit" as OpportunityWarningCode };
  }
  return demandUnit === supplyUnit
    ? { compatible: true, warning: null }
    : { compatible: false, warning: "incompatible_unit" as OpportunityWarningCode };
}

function candidateFor(
  option: CanonicalOpportunityRow,
  optionIndex: number,
  lot: SupplyLot,
  context: MatcherContext
): CandidateTemplate | null {
  if (option.normalizedMpn !== lot.row.normalizedMpn) return null;
  const relation = manufacturerRelation(option, lot, context);
  const unit = unitCompatibility(option, lot, context);
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
    else if (expiry <= context.now) warnings.add("offer_expired");
  } else if (lot.row.recordRole === "supplier_offer") {
    warnings.add("offer_validity_unknown");
  }

  const automaticRelation =
    relation === "exact" ||
    (relation === "missing" && allowMissingManufacturerAutomatically());
  const hasLiveSupply = lot.row.recordRole === "supplier_offer"
    ? supplierOfferIsLive(lot.row, context.now)
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
  return { optionIndex, lot, tier, confidence, relation, automatic, warnings };
}

function compareCandidates(left: CandidateRank, right: CandidateRank) {
  return (
    Number(right.automatic) - Number(left.automatic) ||
    TIER_ORDER[left.tier] - TIER_ORDER[right.tier] ||
    (SUPPLY_ROLE_ORDER[left.lot.row.recordRole] ?? Number.MAX_SAFE_INTEGER) -
      (SUPPLY_ROLE_ORDER[right.lot.row.recordRole] ?? Number.MAX_SAFE_INTEGER) ||
    (left.lot.row.offerPrice ?? Number.MAX_SAFE_INTEGER) -
      (right.lot.row.offerPrice ?? Number.MAX_SAFE_INTEGER) ||
    left.lot.row.originalIndex - right.lot.row.originalIndex ||
    left.lot.key.localeCompare(right.lot.key)
  );
}

function candidatePrecedes(left: CandidateRank, right: CandidateRank) {
  const order = compareCandidates(left, right);
  return order < 0 || (order === 0 && left.optionIndex < right.optionIndex);
}

function* candidatePlanSignatureSteps(
  event: DemandEvent,
  context: MatcherContext,
  supplyIndex: SupplyIndex | undefined,
  work: MatcherWorkBudget
): Generator<void, string, void> {
  const signatureOptions: unknown[] = [];
  for (const option of event.options) {
    const keys = rowMatchKeys(option, context);
    const bucket = supplyIndex?.bucketsByMpn.get(option.normalizedMpn);
    let manufacturerSignature: unknown[];
    if (!bucket) {
      manufacturerSignature = ["none"];
    } else if (!keys.exactManufacturer) {
      manufacturerSignature = ["missing_demand"];
    } else {
      const indexes = bucket.compactIndexes ?? (
        bucket.lots.length > FULL_CANDIDATE_PLAN_LIMIT
          ? yield* supplyMpnCompactIndexSteps(bucket, context, work)
          : undefined
      );
      let hasExact = indexes?.byExactManufacturer.has(keys.exactManufacturer) ?? false;
      let hasCanonical = Boolean(
        keys.canonicalManufacturer && indexes?.byCanonicalManufacturer.has(keys.canonicalManufacturer)
      );
      if (!indexes) {
        for (const lot of bucket.lots) {
          hasExact ||= lot.exactManufacturer === keys.exactManufacturer;
          hasCanonical ||= Boolean(
            keys.canonicalManufacturer && lot.canonicalManufacturer === keys.canonicalManufacturer
          );
          if (hasExact) break;
          if (matcherWorkStep(work)) yield;
        }
      }
      manufacturerSignature = hasExact
        ? ["exact", keys.exactManufacturer, keys.canonicalManufacturer]
        : hasCanonical
          ? ["alias", keys.canonicalManufacturer]
          : ["unmatched"];
    }
    signatureOptions.push([
      option.normalizedMpn,
      ...manufacturerSignature,
      keys.normalizedUnit
    ]);
    if (matcherWorkStep(work)) yield;
  }
  return JSON.stringify(signatureOptions);
}

function indexedLotsForUnit(
  index: AdaptiveLotIndex | undefined,
  unit: string
) {
  if (!index) return [];
  if (!unit) return Array.from(index.values()).flatMap(adaptiveLots);
  return [
    ...adaptiveLots(index.get(unit)),
    ...(unit ? adaptiveLots(index.get("")) : [])
  ];
}

function hasUnitOutside(
  supplyByUnit: AdaptiveLotIndex | undefined,
  compatibleUnits: Set<string>
) {
  if (!supplyByUnit || compatibleUnits.has("")) return false;
  const nonEmptySupplyUnitCount = supplyByUnit.size - Number(supplyByUnit.has(""));
  let coveredUnitCount = 0;
  for (const unit of compatibleUnits) {
    if (unit && supplyByUnit.has(unit)) coveredUnitCount += 1;
  }
  return nonEmptySupplyUnitCount > coveredUnitCount;
}

function adaptiveGroupHasUnitOutside(
  group: AdaptiveLotGroup | undefined,
  unitIndex: AdaptiveLotIndex | undefined,
  compatibleUnits: Set<string>
) {
  if (unitIndex) return hasUnitOutside(unitIndex, compatibleUnits);
  if (!group || compatibleUnits.has("")) return false;
  return adaptiveLots(group).some((lot) =>
    Boolean(lot.normalizedUnit) && !compatibleUnits.has(lot.normalizedUnit)
  );
}

function exactGroupCanonicalCount(
  indexes: SupplyMpnCompactIndexes,
  exactManufacturerValue: string,
  canonicalManufacturerValue: string
) {
  const indexed = indexes.canonicalCountsByLargeExactManufacturer
    .get(exactManufacturerValue)
    ?.get(canonicalManufacturerValue);
  if (indexed !== undefined) return indexed;
  return adaptiveLots(indexes.byExactManufacturer.get(exactManufacturerValue)).reduce(
    (count, lot) => count + Number(lot.canonicalManufacturer === canonicalManufacturerValue),
    0
  );
}

function adaptiveGroupExactUnitLots(
  group: AdaptiveLotGroup | undefined,
  unitIndex: AdaptiveLotIndex | undefined,
  unit: string
) {
  if (unitIndex) return adaptiveLots(unitIndex.get(unit));
  return adaptiveLots(group).filter((lot) => lot.normalizedUnit === unit);
}

function adaptiveGroupCompatibleLiveLots(
  group: AdaptiveLotGroup | undefined,
  unitIndex: AdaptiveLotIndex | undefined,
  unit: string
) {
  const lots = !unit
    ? adaptiveLots(group)
    : [
        ...adaptiveGroupExactUnitLots(group, unitIndex, unit),
        ...adaptiveGroupExactUnitLots(group, unitIndex, "")
      ];
  return lots.filter((lot) => lot.automaticGroup !== null);
}

function compactRelationStats(
  bucket: SupplyMpnBucket,
  indexes: SupplyMpnCompactIndexes,
  optionDetails: Array<{
    option: CanonicalOpportunityRow;
    index: number;
    keys: RowMatchKeys;
  }>
) {
  const exactManufacturers = new Set<string>();
  const canonicalManufacturers = new Set<string>();
  const demandUnits = new Set<string>();
  const exactCoveredByCanonical = new Map<string, number>();
  let demandMissingManufacturer = false;
  let exactCount = 0;
  let hasExactIncompatibleUnit = false;

  for (const { keys } of optionDetails) {
    demandUnits.add(keys.normalizedUnit);
    if (!keys.exactManufacturer) {
      demandMissingManufacturer = true;
      continue;
    }
    if (!exactManufacturers.has(keys.exactManufacturer)) {
      exactManufacturers.add(keys.exactManufacturer);
      const exactLots = indexes.byExactManufacturer.get(keys.exactManufacturer);
      exactCount += adaptiveLotCount(exactLots);
      if (keys.canonicalManufacturer && exactLots) {
        exactCoveredByCanonical.set(
          keys.canonicalManufacturer,
          (exactCoveredByCanonical.get(keys.canonicalManufacturer) ?? 0) +
            exactGroupCanonicalCount(
              indexes,
              keys.exactManufacturer,
              keys.canonicalManufacturer
            )
        );
      }
      hasExactIncompatibleUnit ||= adaptiveGroupHasUnitOutside(
        exactLots,
        indexes.unitLotsByLargeExactManufacturer.get(keys.exactManufacturer),
        new Set([keys.normalizedUnit])
      );
    }
    if (keys.canonicalManufacturer) canonicalManufacturers.add(keys.canonicalManufacturer);
  }

  const missingSupplyGroup = indexes.byExactManufacturer.get("");
  const missingSupplyCount = adaptiveLotCount(missingSupplyGroup);
  const missingCount = demandMissingManufacturer
    ? Math.max(bucket.lots.length - exactCount, 0)
    : missingSupplyCount;
  let aliasCount = 0;
  if (!demandMissingManufacturer) {
    for (const canonical of canonicalManufacturers) {
      aliasCount += Math.max(
        adaptiveLotCount(indexes.byCanonicalManufacturer.get(canonical)) -
          (exactCoveredByCanonical.get(canonical) ?? 0) -
          exactGroupCanonicalCount(indexes, "", canonical),
        0
      );
    }
  }
  const conflictCount = demandMissingManufacturer
    ? 0
    : Math.max(bucket.lots.length - exactCount - missingCount - aliasCount, 0);
  const hasMissingSupplyIncompatibleUnit = missingSupplyCount > 0 && adaptiveGroupHasUnitOutside(
    missingSupplyGroup,
    indexes.unitLotsByLargeExactManufacturer.get(""),
    demandUnits
  );

  return {
    exactCount,
    missingCount,
    aliasCount,
    conflictCount,
    hasIncompatibleUnit: hasExactIncompatibleUnit || hasMissingSupplyIncompatibleUnit
  };
}

function* buildCompactDemandOptionIndexSteps(
  details: CompactOptionDetail[],
  work: MatcherWorkBudget
): Generator<void, CompactDemandOptionIndex, void> {
  const first = details[0];
  if (!first) throw new Error("OPPORTUNITY_COMPACT_PLAN_OPTIONS_MISSING");
  const index: CompactDemandOptionIndex = {
    first,
    byExactManufacturer: new Map(),
    byCanonicalManufacturer: new Map(),
    byUnit: new Map()
  };
  for (const detail of details) {
    if (!detail.keys.exactManufacturer) index.firstMissingManufacturer ??= detail;
    else if (!index.byExactManufacturer.has(detail.keys.exactManufacturer)) {
      index.byExactManufacturer.set(detail.keys.exactManufacturer, detail);
    }
    if (detail.keys.canonicalManufacturer &&
        !index.byCanonicalManufacturer.has(detail.keys.canonicalManufacturer)) {
      index.byCanonicalManufacturer.set(detail.keys.canonicalManufacturer, detail);
    }
    if (!detail.keys.normalizedUnit) index.firstMissingUnit ??= detail;
    else if (!index.byUnit.has(detail.keys.normalizedUnit)) {
      index.byUnit.set(detail.keys.normalizedUnit, detail);
    }
    if (matcherWorkStep(work)) yield;
  }
  return index;
}

function earlierCompactOption(
  left: CompactOptionDetail | undefined,
  right: CompactOptionDetail | undefined
) {
  if (!left) return right;
  if (!right) return left;
  return left.index <= right.index ? left : right;
}

function bestCompactCandidate(
  optionIndex: CompactDemandOptionIndex,
  lot: SupplyLot,
  context: MatcherContext
) {
  const compatible = !lot.normalizedUnit
    ? optionIndex.first
    : earlierCompactOption(
        optionIndex.byUnit.get(lot.normalizedUnit),
        optionIndex.firstMissingUnit
      );
  const details = [
    optionIndex.byExactManufacturer.get(lot.exactManufacturer),
    optionIndex.firstMissingManufacturer,
    optionIndex.byCanonicalManufacturer.get(lot.canonicalManufacturer),
    compatible,
    optionIndex.first
  ];
  const seen = new Set<number>();
  let best: CandidateTemplate | null = null;
  for (const detail of details) {
    if (!detail || seen.has(detail.index)) continue;
    seen.add(detail.index);
    if (context.diagnostics) context.diagnostics.exactCandidateComparisons += 1;
    const candidate = candidateFor(detail.option, detail.index, lot, context);
    if (!candidate) continue;
    if (context.diagnostics) context.diagnostics.exactCandidatesCreated += 1;
    if (!best || candidatePrecedes(candidate, best)) best = candidate;
  }
  return best;
}

function addBestCompactCandidate(
  bestByLot: Map<string, CandidateTemplate>,
  optionIndex: CompactDemandOptionIndex,
  lot: SupplyLot,
  context: MatcherContext
) {
  const candidate = bestCompactCandidate(optionIndex, lot, context);
  if (!candidate) return;
  const existing = bestByLot.get(lot.key);
  if (!existing || candidatePrecedes(candidate, existing)) {
    bestByLot.set(lot.key, candidate);
  }
}

function compactRelationForLot(keys: RowMatchKeys, lot: SupplyLot): ManufacturerRelation {
  if (!keys.exactManufacturer || !lot.exactManufacturer) return "missing";
  if (keys.exactManufacturer === lot.exactManufacturer) return "exact";
  return keys.canonicalManufacturer && lot.canonicalManufacturer &&
    keys.canonicalManufacturer === lot.canonicalManufacturer
    ? "approved_alias"
    : "conflict";
}

function compactLotIsAutomatic(
  keys: RowMatchKeys,
  lot: SupplyLot,
  relation: ManufacturerRelation
) {
  const relationAllowed = relation === "exact" ||
    (relation === "missing" && allowMissingManufacturerAutomatically());
  const unitCompatible = !keys.normalizedUnit ||
    !lot.normalizedUnit ||
    keys.normalizedUnit === lot.normalizedUnit;
  return relationAllowed && unitCompatible && lot.automaticGroup !== null;
}

function compactTierForRelation(
  relation: ManufacturerRelation
): OpportunityMatchTier {
  if (relation === "exact") return "exact_mpn_mfg";
  if (relation === "missing") return "exact_mpn_mfg_missing";
  if (relation === "approved_alias") return "exact_mpn_approved_alias";
  return "exact_mpn_mfg_conflict";
}

function* materializeSingleOptionCompactRepresentativeSteps(input: {
  bestByLot: Map<string, CandidateTemplate>;
  previewByLot: Map<string, CandidateRank>;
  bucket: SupplyMpnBucket;
  indexes: SupplyMpnCompactIndexes;
  detail: CompactOptionDetail;
  optionIndex: CompactDemandOptionIndex;
  relationStats: ReturnType<typeof compactRelationStats>;
  context: MatcherContext;
}, work: MatcherWorkBudget): Generator<void, void, void> {
  const {
    bestByLot,
    previewByLot,
    bucket,
    indexes,
    detail,
    optionIndex,
    relationStats,
    context
  } = input;
  const relationOrder: ManufacturerRelation[] = [
    "exact",
    "missing",
    "approved_alias",
    "conflict"
  ];
  const relationLots = (relation: ManufacturerRelation) => {
    if (relation === "exact") {
      return adaptiveLots(indexes.byExactManufacturer.get(detail.keys.exactManufacturer));
    }
    if (relation === "missing") {
      return detail.keys.exactManufacturer
        ? adaptiveLots(indexes.byExactManufacturer.get(""))
        : bucket.lots;
    }
    if (relation === "approved_alias") {
      return detail.keys.canonicalManufacturer
        ? adaptiveLots(indexes.byCanonicalManufacturer.get(detail.keys.canonicalManufacturer))
        : [];
    }
    return bucket.lots;
  };
  const relationCount = (relation: ManufacturerRelation) => {
    if (relation === "exact") return relationStats.exactCount;
    if (relation === "missing") return relationStats.missingCount;
    if (relation === "approved_alias") return relationStats.aliasCount;
    return relationStats.conflictCount;
  };
  const automaticRelations = new Set<ManufacturerRelation>();
  const automaticWarnings = new Set<OpportunityWarningCode>();
  const automaticSheets = new Set<string>();
  let automaticCandidateCount = 0;
  const addLot = (lot: SupplyLot) => {
    if (bestByLot.has(lot.key)) return;
    addBestCompactCandidate(bestByLot, optionIndex, lot, context);
  };
  const addAllocationLot = (lot: SupplyLot) => {
    const previouslyPresent = bestByLot.has(lot.key);
    addLot(lot);
    if (previouslyPresent) return;
    const candidate = bestByLot.get(lot.key);
    if (!candidate?.automatic) return;
    automaticCandidateCount += 1;
    automaticRelations.add(candidate.relation);
    automaticSheets.add(candidate.lot.row.sheetName);
    candidate.warnings.forEach((warning) => automaticWarnings.add(warning));
  };
  const addPreviewLot = (lot: SupplyLot) => {
    if (previewByLot.has(lot.key)) return;
    const relation = compactRelationForLot(detail.keys, lot);
    previewByLot.set(lot.key, {
      lot,
      optionIndex: detail.index,
      automatic: compactLotIsAutomatic(detail.keys, lot, relation),
      tier: compactTierForRelation(relation)
    });
    if (context.diagnostics) {
      context.diagnostics.provenancePreviewCandidates += 1;
    }
  };
  const firstRankedLot = function* (
    lots: SupplyLot[],
    relation: ManufacturerRelation,
    predicate: (lot: SupplyLot) => boolean = () => true
  ): Generator<void, SupplyLot | undefined, void> {
    for (const lot of lots) {
      if (context.diagnostics) context.diagnostics.candidateIndexEntriesVisited += 1;
      if (matcherWorkStep(work)) yield;
      if (!predicate(lot) || compactRelationForLot(detail.keys, lot) !== relation) continue;
      // Every automatic candidate was materialized above from the live
      // manufacturer/UOM indexes. Callers invoke this helper only when the
      // relevant relation/dimension has no automatic candidate, so the first
      // base-ranked match is also the exact candidate-ranked representative.
      return lot;
    }
    return undefined;
  };
  const dimensionRelationLots = (
    allGroup: AdaptiveLotGroup,
    byExactManufacturer: AdaptiveLotIndex | undefined,
    byCanonicalManufacturer: AdaptiveLotIndex | undefined,
    relation: ManufacturerRelation
  ) => {
    const allLots = adaptiveLots(allGroup);
    if (relation === "exact") {
      return byExactManufacturer
        ? adaptiveLots(byExactManufacturer.get(detail.keys.exactManufacturer))
        : allLots.filter((lot) => lot.exactManufacturer === detail.keys.exactManufacturer);
    }
    if (relation === "missing") {
      return detail.keys.exactManufacturer
        ? byExactManufacturer
          ? adaptiveLots(byExactManufacturer.get(""))
          : allLots.filter((lot) => !lot.exactManufacturer)
        : allLots;
    }
    if (relation === "approved_alias") {
      return detail.keys.canonicalManufacturer
        ? byCanonicalManufacturer
          ? adaptiveLots(byCanonicalManufacturer.get(detail.keys.canonicalManufacturer))
          : allLots.filter((lot) =>
              lot.canonicalManufacturer === detail.keys.canonicalManufacturer
            )
        : [];
    }
    return allLots;
  };

  // Materialize every usable allocation candidate from the selective indexes.
  if (detail.keys.exactManufacturer) {
    const exactGroup = indexes.byExactManufacturer.get(detail.keys.exactManufacturer);
    const exactUnits = indexes.unitLotsByLargeExactManufacturer.get(detail.keys.exactManufacturer);
    for (const lot of adaptiveGroupCompatibleLiveLots(
      exactGroup,
      exactUnits,
      detail.keys.normalizedUnit
    )) {
      if (context.diagnostics) context.diagnostics.candidateIndexEntriesVisited += 1;
      addAllocationLot(lot);
      if (matcherWorkStep(work)) yield;
    }
    if (allowMissingManufacturerAutomatically()) {
      const missingGroup = indexes.byExactManufacturer.get("");
      const missingUnits = indexes.unitLotsByLargeExactManufacturer.get("");
      for (const lot of adaptiveGroupCompatibleLiveLots(
        missingGroup,
        missingUnits,
        detail.keys.normalizedUnit
      )) {
        if (context.diagnostics) context.diagnostics.candidateIndexEntriesVisited += 1;
        addAllocationLot(lot);
        if (matcherWorkStep(work)) yield;
      }
    }
  } else if (allowMissingManufacturerAutomatically()) {
    for (const lot of indexedLotsForUnit(indexes.liveByUnit, detail.keys.normalizedUnit)) {
      if (context.diagnostics) context.diagnostics.candidateIndexEntriesVisited += 1;
      addAllocationLot(lot);
      if (matcherWorkStep(work)) yield;
    }
  }

  // Retain the exact ranked provenance prefix separately from the allocation
  // plan. This keeps diagnostic/materialized candidate state output-sensitive
  // while a bounded 32-item preview still preserves the certified ordering.
  for (const relation of relationOrder) {
    if (relationCount(relation) <= 0) continue;
    const retainedTarget = Math.max(
      COMPACT_TRACE_PREVIEW_LIMIT - automaticCandidateCount,
      0
    );
    let retained = 0;
    if (retainedTarget > 0) {
      for (const lot of relationLots(relation)) {
        if (context.diagnostics) context.diagnostics.candidateIndexEntriesVisited += 1;
        if (matcherWorkStep(work)) yield;
        if (compactRelationForLot(detail.keys, lot) !== relation ||
            compactLotIsAutomatic(detail.keys, lot, relation)) continue;
        addPreviewLot(lot);
        retained += 1;
        if (retained >= retainedTarget) break;
      }
    }
    if (!automaticRelations.has(relation)) {
      const representative = yield* firstRankedLot(relationLots(relation), relation);
      if (representative) addLot(representative);
    }
  }

  // Preserve the first ranked occurrence of every intrinsic warning and every
  // source sheet. Replaying candidate warnings after the representatives are
  // sorted exactly reproduces the full-plan warning and sheet order.
  for (const [warning, lots] of indexes.warningLots) {
    if (automaticWarnings.has(warning)) continue;
    const exactIndex = indexes.warningLotsByExactManufacturer.get(warning);
    const canonicalIndex = indexes.warningLotsByCanonicalManufacturer.get(warning);
    for (const relation of relationOrder) {
      if (relationCount(relation) <= 0) continue;
      const lot = yield* firstRankedLot(
        dimensionRelationLots(lots, exactIndex, canonicalIndex, relation),
        relation
      );
      if (lot) addLot(lot);
    }
  }
  for (const [sheet, lots] of indexes.bySheet) {
    if (automaticSheets.has(sheet)) continue;
    const exactIndex = indexes.sheetLotsByExactManufacturer.get(sheet);
    const canonicalIndex = indexes.sheetLotsByCanonicalManufacturer.get(sheet);
    for (const relation of relationOrder) {
      if (relationCount(relation) <= 0) continue;
      const lot = yield* firstRankedLot(
        dimensionRelationLots(lots, exactIndex, canonicalIndex, relation),
        relation
      );
      if (lot) addLot(lot);
    }
  }

  // Unit warnings are option-dependent. Missing UOM has a direct composite
  // lookup; incompatible UOM needs only the first ranked representative for
  // each relation, never one candidate per distinct UOM.
  if (detail.keys.normalizedUnit) {
    if (!automaticWarnings.has("missing_unit")) {
      const missingUnitLots = adaptiveLots(indexes.byUnit.get(""));
      for (const relation of relationOrder) {
        if (relationCount(relation) <= 0) continue;
        const relationMissingUnitLots = relation === "exact"
          ? adaptiveGroupExactUnitLots(
              indexes.byExactManufacturer.get(detail.keys.exactManufacturer),
              indexes.unitLotsByLargeExactManufacturer.get(detail.keys.exactManufacturer),
              ""
            )
          : relation === "missing"
            ? detail.keys.exactManufacturer
              ? adaptiveGroupExactUnitLots(
                  indexes.byExactManufacturer.get(""),
                  indexes.unitLotsByLargeExactManufacturer.get(""),
                  ""
                )
              : missingUnitLots
            : relation === "approved_alias"
              ? adaptiveGroupExactUnitLots(
                  indexes.byCanonicalManufacturer.get(detail.keys.canonicalManufacturer),
                  indexes.unitLotsByLargeCanonicalManufacturer.get(
                    detail.keys.canonicalManufacturer
                  ),
                  ""
                )
              : missingUnitLots;
        const lot = yield* firstRankedLot(
          relationMissingUnitLots,
          relation
        );
        if (lot) addLot(lot);
      }
    }
    const nonEmptyUnitCount = indexes.byUnit.size - Number(indexes.byUnit.has(""));
    const hasOutsideUnit = nonEmptyUnitCount > Number(
      indexes.byUnit.has(detail.keys.normalizedUnit)
    );
    if (hasOutsideUnit) {
      for (const relation of relationOrder) {
        if (relationCount(relation) <= 0) continue;
        const lot = yield* firstRankedLot(
          relationLots(relation),
          relation,
          (candidateLot) => Boolean(candidateLot.normalizedUnit) &&
            candidateLot.normalizedUnit !== detail.keys.normalizedUnit
        );
        if (lot) addLot(lot);
      }
    }
  }
}

function* compactCandidatePlanSteps(
  event: DemandEvent,
  supplyIndex: SupplyIndex,
  context: MatcherContext,
  work: MatcherWorkBudget
): Generator<void, CandidatePlan, void> {
  const optionsByMpn = new Map<string, Array<{ option: CanonicalOpportunityRow; index: number }>>();
  for (const [index, option] of event.options.entries()) {
    const options = optionsByMpn.get(option.normalizedMpn) ?? [];
    options.push({ option, index });
    optionsByMpn.set(option.normalizedMpn, options);
    if (matcherWorkStep(work)) yield;
  }
  const bestByLot = new Map<string, CandidateTemplate>();
  const previewByLot = new Map<string, CandidateRank>();
  const relationSet = new Set<ManufacturerRelation>();
  const warningOrder: OpportunityWarningCode[] = [];
  const warningSet = new Set<OpportunityWarningCode>();
  const matchedMpns: string[] = [];
  let entryCount = 0;
  let currentEntryCount = 0;
  let currentOriginalAvailable = 0;
  let hasIncompatibleUnit = false;
  let hasOfferIssue = false;

  const addWarning = (warning: OpportunityWarningCode) => {
    if (warningSet.has(warning)) return;
    warningSet.add(warning);
    warningOrder.push(warning);
  };

  for (const [mpn, indexedOptions] of optionsByMpn) {
    const bucket = supplyIndex.bucketsByMpn.get(mpn);
    if (!bucket) continue;
    const indexes = yield* supplyMpnCompactIndexSteps(bucket, context, work);
    matchedMpns.push(mpn);
    entryCount += bucket.lots.length;
    currentEntryCount += bucket.currentLots;
    currentOriginalAvailable += bucket.currentOriginalAvailable;
    const optionDetails: CompactOptionDetail[] = [];
    for (const { option, index } of indexedOptions) {
      optionDetails.push({
        option,
        index,
        keys: rowMatchKeys(option, context)
      });
      if (matcherWorkStep(work)) yield;
    }
    const compactOptionIndex = yield* buildCompactDemandOptionIndexSteps(
      optionDetails,
      work
    );
    if (optionDetails.length > 1) {
      for (const lot of bucket.lots) {
        if (context.diagnostics) context.diagnostics.candidateIndexEntriesVisited += 1;
        addBestCompactCandidate(bestByLot, compactOptionIndex, lot, context);
        if (matcherWorkStep(work)) yield;
      }
      continue;
    }

    const relationStats = compactRelationStats(bucket, indexes, optionDetails);
    if (relationStats.exactCount > 0) relationSet.add("exact");
    if (relationStats.missingCount > 0) relationSet.add("missing");
    if (relationStats.aliasCount > 0) relationSet.add("approved_alias");
    if (relationStats.conflictCount > 0) relationSet.add("conflict");
    yield* materializeSingleOptionCompactRepresentativeSteps({
      bestByLot,
      previewByLot,
      bucket,
      indexes,
      detail: optionDetails[0],
      optionIndex: compactOptionIndex,
      relationStats,
      context
    }, work);
    if (matcherWorkStep(work)) yield;
  }

  const entries = Array.from(bestByLot.values()).sort(compareCandidates);
  const currentEntries = entries.filter((candidate) => !isHistoricalSupply(candidate.lot.row));
  const automaticEntries = currentEntries.filter((candidate) => candidate.automatic);
  const automaticGroups = new Set<AutomaticSupplyGroup>();
  for (const candidate of automaticEntries) {
    if (!candidate.lot.automaticGroup) continue;
    automaticGroups.add(candidate.lot.automaticGroup);
    if (matcherWorkStep(work)) yield;
  }
  for (const candidate of entries) {
    relationSet.add(candidate.relation);
    for (const warning of candidate.warnings) addWarning(warning);
    if (matcherWorkStep(work)) yield;
  }
  hasIncompatibleUnit ||= entries.some((candidate) =>
    candidate.warnings.has("incompatible_unit")
  );
  hasOfferIssue ||= entries.some((candidate) =>
    candidate.warnings.has("offer_expired") ||
    candidate.warnings.has("offer_validity_unknown") ||
    (candidate.lot.row.recordRole === "supplier_offer" &&
      !supplierOfferIsLive(candidate.lot.row, context.now))
  );
  if (context.diagnostics) {
    context.diagnostics.maxCandidateMaterialization = Math.max(
      context.diagnostics.maxCandidateMaterialization,
      entries.length
    );
    context.diagnostics.maxProvenancePreviewMaterialization = Math.max(
      context.diagnostics.maxProvenancePreviewMaterialization,
      previewByLot.size
    );
  }
  const rankedPreviewCandidates = Array.from(new Map([
    ...entries,
    ...previewByLot.values()
  ].map((candidate) => [candidate.lot.key, candidate])).values()).sort(compareCandidates);
  const expectedPreviewLength = Math.min(entryCount, COMPACT_TRACE_PREVIEW_LIMIT);
  if (rankedPreviewCandidates.length < expectedPreviewLength) {
    throw new Error("OPPORTUNITY_COMPACT_TRACE_PREVIEW_INCOMPLETE");
  }
  const supplyTraces = rankedPreviewCandidates
    .slice(0, COMPACT_TRACE_PREVIEW_LIMIT)
    .map((candidate) => sourceTrace(candidate.lot.row, context));
  return {
    entries,
    currentEntries,
    automaticEntries,
    automaticGroups,
    warningOrder,
    supplyTraces,
    supplySheetName: Array.from(new Set(
      entries.map((candidate) => candidate.lot.row.sheetName)
    )).join(", ") || null,
    currentOriginalAvailable,
    matchedMpns,
    entryCount,
    currentEntryCount,
    relations: relationSet,
    hasIncompatibleUnit,
    hasOfferIssue,
    compact: true,
    allocationCursor: 0,
    permanentAllocationWarnings: []
  };
}

function* candidatePlanSteps(
  event: DemandEvent,
  supplyIndex: SupplyIndex,
  cache: Map<string, CandidatePlan>,
  context: MatcherContext,
  work: MatcherWorkBudget
): Generator<void, CandidatePlan, void> {
  let candidateWork = 0;
  for (const option of event.options) {
    candidateWork += supplyIndex.bucketsByMpn.get(option.normalizedMpn)?.lots.length ?? 0;
    if (matcherWorkStep(work)) yield;
  }
  if (candidateWork > FULL_CANDIDATE_PLAN_LIMIT) {
    const signature = yield* candidatePlanSignatureSteps(
      event,
      context,
      supplyIndex,
      work
    );
    const cached = cache.get(signature);
    if (cached) {
      cache.delete(signature);
      cache.set(signature, cached);
      if (context.diagnostics) context.diagnostics.candidatePlanCacheHits += 1;
      return cached;
    }
    const compact = yield* compactCandidatePlanSteps(event, supplyIndex, context, work);
    cache.set(signature, compact);
    if (cache.size > COMPACT_CANDIDATE_PLAN_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return compact;
  }
  const bestByLot = new Map<string, CandidateTemplate>();
  for (const [optionIndex, option] of event.options.entries()) {
    const lots = supplyIndex.bucketsByMpn.get(option.normalizedMpn)?.lots ?? [];
    if (context.diagnostics) context.diagnostics.exactIndexLookups += 1;
    for (const lot of lots) {
      if (context.diagnostics) {
        context.diagnostics.exactCandidateComparisons += 1;
        context.diagnostics.candidateIndexEntriesVisited += 1;
      }
      const candidate = candidateFor(option, optionIndex, lot, context);
      if (candidate) {
        if (context.diagnostics) context.diagnostics.exactCandidatesCreated += 1;
        const existing = bestByLot.get(lot.key);
        if (!existing || candidatePrecedes(candidate, existing)) {
          bestByLot.set(lot.key, candidate);
        }
      }
      if (matcherWorkStep(work)) yield;
    }
  }
  if (context.diagnostics) {
    context.diagnostics.maxCandidateMaterialization = Math.max(
      context.diagnostics.maxCandidateMaterialization,
      bestByLot.size
    );
  }
  const entries = Array.from(bestByLot.values()).sort(compareCandidates);
  const currentEntries = entries.filter((candidate) => !isHistoricalSupply(candidate.lot.row));
  const automaticEntries = currentEntries.filter((candidate) => candidate.automatic);
  const automaticGroups = new Set<AutomaticSupplyGroup>();
  for (const candidate of automaticEntries) {
    if (candidate.lot.automaticGroup) {
      automaticGroups.add(candidate.lot.automaticGroup);
    }
    if (matcherWorkStep(work)) yield;
  }
  const warningOrder = Array.from(new Set(entries.flatMap((candidate) =>
    Array.from(candidate.warnings)
  )));
  const plan: CandidatePlan = {
    entries,
    currentEntries,
    automaticEntries,
    automaticGroups,
    warningOrder,
    supplyTraces: entries.map((candidate) => sourceTrace(candidate.lot.row, context)),
    supplySheetName: entries.length
      ? Array.from(new Set(entries.map((candidate) => candidate.lot.row.sheetName))).join(", ")
      : null,
    currentOriginalAvailable: currentEntries.reduce(
      (sum, candidate) => sum + candidate.lot.originalAvailable,
      0
    ),
    matchedMpns: Array.from(new Set(entries.map((candidate) =>
      event.options[candidate.optionIndex]?.normalizedMpn ?? candidate.lot.row.normalizedMpn
    ))),
    entryCount: entries.length,
    currentEntryCount: currentEntries.length,
    relations: new Set(entries.map((candidate) => candidate.relation)),
    hasIncompatibleUnit: entries.some((candidate) => candidate.warnings.has("incompatible_unit")),
    hasOfferIssue: entries.some((candidate) =>
      candidate.warnings.has("offer_expired") ||
      candidate.warnings.has("offer_validity_unknown") ||
      (candidate.lot.row.recordRole === "supplier_offer" &&
        !supplierOfferIsLive(candidate.lot.row, context.now))
    ),
    compact: false,
    allocationCursor: 0,
    permanentAllocationWarnings: []
  };
  return plan;
}

function candidatePlan(
  event: DemandEvent,
  supplyIndex: SupplyIndex,
  cache: Map<string, CandidatePlan>,
  context: MatcherContext
) {
  return runMatcherStepsSynchronously(candidatePlanSteps(
    event,
    supplyIndex,
    cache,
    context,
    matcherWorkBudget()
  ));
}

function materializeCandidate(event: DemandEvent, candidate: CandidateTemplate): Candidate {
  return { ...candidate, option: event.options[candidate.optionIndex] };
}

function automaticRemaining(
  supplyIndex: SupplyIndex,
  plan: CandidatePlan,
  diagnostics?: OpportunityMatcherDiagnostics
) {
  let total = 0;
  for (const group of plan.automaticGroups) {
    if (diagnostics) diagnostics.automaticGroupReads += 1;
    total += Math.max("remaining" in group ? group.remaining : group.remainingAvailable, 0);
  }
  return total;
}

function reserveFromSupplyIndex(lot: SupplyLot, reserved: number) {
  if (reserved <= 0 || !lot.automaticGroup) return;
  if (!("remaining" in lot.automaticGroup)) return;
  lot.automaticGroup.remaining = Math.max(lot.automaticGroup.remaining - reserved, 0);
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

type DemandResultInput = {
  jobId: string;
  event: DemandEvent;
  supplyRole: OpportunitySelectedRole;
  plan: CandidatePlan;
  supplyIndex: SupplyIndex;
  fallbackHistorical: boolean;
  context: MatcherContext;
  diagnostics?: OpportunityMatcherDiagnostics;
};

type DemandAllocationState = {
  historical: boolean;
  automaticCandidates: CandidateTemplate[];
  availableBefore: number;
  allocations: OpportunityAllocationTrace[];
  usedCandidates: CandidateTemplate[];
  warnings: Set<OpportunityWarningCode>;
  allocatedQty: number;
};

function* demandAllocationSteps(
  input: DemandResultInput,
  work: MatcherWorkBudget
): Generator<void, DemandAllocationState, void> {
  const { event } = input;
  const requiredQty = event.requiredQty;
  const historical = input.plan.currentEntryCount === 0 && input.plan.entryCount > 0;
  const automaticCandidates = input.plan.automaticEntries;
  const availableBefore = automaticRemaining(input.supplyIndex, input.plan, input.diagnostics);
  const allocations: OpportunityAllocationTrace[] = [];
  const usedCandidates: CandidateTemplate[] = [];
  const warnings = new Set<OpportunityWarningCode>(event.warnings ?? []);
  input.plan.permanentAllocationWarnings.forEach((warning) => warnings.add(warning));
  const preserveDepletedCandidateWarnings = (candidate: CandidateTemplate) => {
    candidate.warnings.forEach((warning) => {
      if (!input.plan.permanentAllocationWarnings.includes(warning)) {
        input.plan.permanentAllocationWarnings.push(warning);
      }
    });
  };
  let allocatedQty = 0;

  if (!historical && requiredQty > 0) {
    for (
      let candidateIndex = input.plan.allocationCursor;
      candidateIndex < automaticCandidates.length;
      candidateIndex += 1
    ) {
      if (allocatedQty >= requiredQty) break;
      const candidate = automaticCandidates[candidateIndex];
      if (input.diagnostics) input.diagnostics.allocationCandidatesVisited += 1;
      if (matcherWorkStep(work)) yield;
      const reservation = commercialReservation({
        need: requiredQty - allocatedQty,
        lot: candidate.lot
      });
      candidate.warnings.forEach((warning) => warnings.add(warning));
      reservation.warnings.forEach((warning) => warnings.add(warning));
      if (reservation.reserved <= 0) {
        if (candidateIndex === input.plan.allocationCursor &&
            candidate.lot.remainingAvailable <= 0) {
          input.plan.allocationCursor += 1;
          preserveDepletedCandidateWarnings(candidate);
        }
        continue;
      }
      const before = candidate.lot.remainingAvailable;
      candidate.lot.remainingAvailable = Math.max(before - reservation.reserved, 0);
      reserveFromSupplyIndex(candidate.lot, reservation.reserved);
      allocatedQty += reservation.allocated;
      usedCandidates.push(candidate);
      allocations.push({
        lotKey: candidate.lot.key,
        demandPartOptionId: event.options[candidate.optionIndex]?.demandPartOptionId ?? null,
        supplyLotId: candidate.lot.row.supplyLotId ?? null,
        allocatedQty: reservation.allocated,
        reservedQty: reservation.reserved,
        availableBefore: before,
        remainingQty: candidate.lot.remainingAvailable,
        supply: sourceTrace(candidate.lot.row, input.context)
      });
      if (candidateIndex === input.plan.allocationCursor && candidate.lot.remainingAvailable <= 0) {
        input.plan.allocationCursor += 1;
        preserveDepletedCandidateWarnings(candidate);
      }
    }
  }

  return {
    historical,
    automaticCandidates,
    availableBefore,
    allocations,
    usedCandidates,
    warnings,
    allocatedQty
  };
}

function buildDemandResult(
  input: DemandResultInput,
  preparedAllocation?: DemandAllocationState
): OpportunityResult | null {
  const { event } = input;
  const requiredQty = event.requiredQty;
  const exactCandidates = input.plan.entries;
  if (input.fallbackHistorical && input.plan.entryCount === 0) return null;
  const currentCandidates = input.plan.currentEntries;
  const {
    historical,
    automaticCandidates,
    availableBefore,
    allocations,
    usedCandidates,
    warnings,
    allocatedQty
  } = preparedAllocation ?? runMatcherStepsSynchronously(
    demandAllocationSteps(input, matcherWorkBudget())
  );

  const firstCandidateTemplate = usedCandidates[0] ?? currentCandidates[0] ?? exactCandidates[0] ?? null;
  const firstCandidate = firstCandidateTemplate
    ? materializeCandidate(event, firstCandidateTemplate)
    : null;
  input.plan.warningOrder.forEach((warning) => warnings.add(warning));
  if (input.plan.entryCount === 0) warnings.add("missing_unit");
  if (historical) warnings.add("historical_not_current_stock");
  const invalidQuantity = requiredQty <= 0 ||
    Boolean(event.warnings?.has("invalid_required_quantity"));
  let reviewReason: OpportunityReasonCode | undefined;
  if (!historical && invalidQuantity) reviewReason = "invalid_quantity";
  else if (!historical && !automaticCandidates.length && input.plan.entryCount > 0) {
    const relations = input.plan.relations;
    if (relations.has("conflict")) reviewReason = "manufacturer_conflict";
    else if (relations.has("approved_alias")) reviewReason = "manufacturer_alias_review";
    else if (input.plan.hasIncompatibleUnit) reviewReason = "incompatible_unit";
    else if (input.plan.hasOfferIssue) reviewReason = "offer_not_live";
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
    ? automaticRemaining(input.supplyIndex, input.plan, input.diagnostics)
    : supply
      ? Math.max(firstCandidate?.lot.remainingAvailable ?? 0, 0)
      : null;
  const materializedUsedCandidates = usedCandidates.map((candidate) =>
    materializeCandidate(event, candidate)
  );
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
    : commercialFields(option, materializedUsedCandidates, allocations, firstCandidate);

  return {
    jobId: input.jobId,
    opportunityType: codes.opportunityType,
    exactMpnMatch: input.plan.entryCount > 0,
    exactMatch: input.plan.entryCount > 0,
    usableAvailabilityMatch,
    exactQuantityMatch,
    matchTier: firstCandidate?.tier ?? null,
    confidence: firstCandidate?.confidence ?? (input.plan.entryCount > 0 ? "review" : "low"),
    matchExplanation: firstCandidate
      ? `${firstCandidate.tier}; deterministic exact-MPN evaluation; lot ${firstCandidate.lot.key}`
      : "No exact normalized MPN was found in the confirmed supply source.",
    reviewStatus: codes.opportunityType === "review_required" ? "pending" : "not_required",
    demandEventKey: demandEventIdentity(event),
    demandMpnOriginal: option.rawMpn,
    supplyMpnOriginal: supply?.rawMpn ?? null,
    displayMpn: option.displayMpn,
    normalizedMpn: option.normalizedMpn,
    manufacturer: option.manufacturer ?? supply?.manufacturer ?? null,
    manufacturerCanonical: option.manufacturerCanonical ?? supply?.manufacturerCanonical ?? null,
    customerContext: option.customerContext,
    supplierContext: supply?.supplierContext ?? option.supplierContext,
    requiredQty,
    availableQty: historical ? null : input.plan.currentOriginalAvailable,
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
    supplySheetName: supply ? input.plan.supplySheetName : null,
    demandSourceRows: event.rows.length,
    supplySourceRows: input.plan.entryCount,
    demandTraces: event.rows.map((row) => sourceTrace(row, input.context)),
    supplyTraces: input.plan.supplyTraces,
    allocations,
    ...(input.plan.entryCount > input.plan.supplyTraces.length
      ? { supplyTracePreviewTruncated: true }
      : {}),
    reasonCode: codes.reasonCode,
    actionCode: codes.actionCode,
    warnings: Array.from(warnings)
  };
}

type PossibleMatchEmission = {
  possibleMatch: PossibleOpportunityMatch;
};

function* possibleMatchEmissionSteps(
  jobId: string,
  event: DemandEvent,
  supplyIndex: SupplyIndex,
  context: MatcherContext,
  work: MatcherWorkBudget
): Generator<PossibleMatchEmission | undefined, void, void> {
  const seen = new Set<string>();
  const eventKey = demandEventIdentity(event);
  for (const option of event.options) {
    if (!option.reviewKey) continue;
    const variants = supplyIndex.reviewByKey.get(option.reviewKey);
    if (context.diagnostics) context.diagnostics.reviewIndexLookups += 1;
    const lots: SupplyLot[] = [];
    if (Array.isArray(variants)) {
      for (const lot of variants) {
        if (lot.row.normalizedMpn !== option.normalizedMpn) lots.push(lot);
        if (matcherWorkStep(work)) yield;
      }
      lots.sort((left, right) =>
        left.row.originalIndex - right.row.originalIndex ||
        left.row.fileId.localeCompare(right.row.fileId) ||
        left.row.sheetName.localeCompare(right.row.sheetName) ||
        left.row.sourceRow - right.row.sourceRow ||
        left.key.localeCompare(right.key)
      );
    } else if (variants) {
      for (const [normalizedMpn, groupedLots] of variants) {
        if (normalizedMpn === option.normalizedMpn) continue;
        for (const lot of groupedLots) {
          lots.push(lot);
          if (matcherWorkStep(work)) yield;
        }
      }
      lots.sort((left, right) =>
        left.row.originalIndex - right.row.originalIndex ||
        left.row.fileId.localeCompare(right.row.fileId) ||
        left.row.sheetName.localeCompare(right.row.sheetName) ||
        left.row.sourceRow - right.row.sourceRow ||
        left.key.localeCompare(right.key)
      );
    }
    for (const lot of lots) {
      if (context.diagnostics) context.diagnostics.reviewCandidateComparisons += 1;
      if (matcherWorkStep(work)) yield;
      if (
        !lot.row.reviewKey ||
        option.reviewKey !== lot.row.reviewKey
      ) continue;
      const relation = manufacturerRelation(option, lot, context);
      if (relation === "conflict" || relation === "missing") continue;
      const key = candidateIdentity(jobId, eventKey, option, lot);
      if (seen.has(key)) continue;
      seen.add(key);
      if (context.diagnostics) context.diagnostics.possibleMatchesCreated += 1;
      yield {
        possibleMatch: {
          jobId,
          candidateKey: key,
          demandEventKey: eventKey,
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
          explanation: `Search-normalized symbol variant for demand event ${eventKey}; human review is required.`,
          demandTrace: { ...sourceTrace(option, context), demandEventKey: eventKey },
          supplyTrace: sourceTrace(lot.row, context)
        }
      };
    }
  }
}

function possibleMatchesForEvent(
  jobId: string,
  event: DemandEvent,
  supplyIndex: SupplyIndex,
  context: MatcherContext
) {
  const matches: PossibleOpportunityMatch[] = [];
  const steps = possibleMatchEmissionSteps(
    jobId,
    event,
    supplyIndex,
    context,
    matcherWorkBudget()
  );
  let step = steps.next();
  while (!step.done) {
    if (step.value) matches.push(step.value.possibleMatch);
    step = steps.next();
  }
  return matches;
}

type SupplyWithoutDemandInput = {
  jobId: string;
  lots: SupplyLot[];
  exactDemandMpns: Set<string>;
  context: MatcherContext;
};

function* supplyWithoutDemandGroupSteps(
  input: SupplyWithoutDemandInput,
  work: MatcherWorkBudget
): Generator<void, Map<string, SupplyLot[]>, void> {
  const byMpn = new Map<string, SupplyLot[]>();
  for (const lot of input.lots) {
    if (!isHistoricalSupply(lot.row) &&
        !input.exactDemandMpns.has(lot.row.normalizedMpn) &&
        lot.originalAvailable > 0) {
      const grouped = byMpn.get(lot.row.normalizedMpn);
      if (grouped) grouped.push(lot);
      else byMpn.set(lot.row.normalizedMpn, [lot]);
    }
    if (matcherWorkStep(work)) yield;
  }
  return byMpn;
}

function* buildSupplyWithoutDemandResultSteps(
  input: SupplyWithoutDemandInput,
  lots: SupplyLot[],
  work: MatcherWorkBudget
): Generator<void, OpportunityResult, void> {
  const first = lots[0].row;
  let total = 0;
  let remaining = 0;
  const sheetNames = new Set<string>();
  const supplyTraces: OpportunitySourceTrace[] = [];
  const warnings = new Set<OpportunityWarningCode>();
  for (const [index, lot] of lots.entries()) {
    total += lot.originalAvailable;
    remaining += lot.remainingAvailable;
    sheetNames.add(lot.row.sheetName);
    if (index < COMPACT_TRACE_PREVIEW_LIMIT) {
      supplyTraces.push(sourceTrace(lot.row, input.context));
    }
    lot.row.qualityFlags.forEach((warning) => warnings.add(warning));
    if (matcherWorkStep(work)) yield;
  }
  return {
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
      supplySheetName: Array.from(sheetNames).join(", "),
      demandSourceRows: 0,
      supplySourceRows: lots.length,
      demandTraces: [],
      supplyTraces,
      allocations: [],
      ...(lots.length > COMPACT_TRACE_PREVIEW_LIMIT
        ? { supplyTracePreviewTruncated: true }
        : {}),
      reasonCode: "supply_has_no_demand",
      actionCode: "find_buyer",
    warnings: Array.from(warnings)
  };
}

type MatchSummaryAccumulator = {
  summary: OpportunitySummary;
  usableAvailabilityMpns: Set<string>;
};

function addResultToSummaryAccumulator(
  accumulator: MatchSummaryAccumulator,
  result: OpportunityResult
) {
  if (result.usableAvailabilityMatch) {
    accumulator.usableAvailabilityMpns.add(result.normalizedMpn);
  }
  if (result.exactQuantityMatch) accumulator.summary.exactQuantityMatches += 1;
  if (result.opportunityType === "full_sale") accumulator.summary.fullSales += 1;
  if (result.opportunityType === "partial_sale") accumulator.summary.partialSales += 1;
  if (result.opportunityType === "sourcing_needed") accumulator.summary.sourcingNeeded += 1;
  if (result.opportunityType === "excess_resale") accumulator.summary.excessResales += 1;
  if (result.opportunityType === "supplier_offer_match") {
    accumulator.summary.supplierOfferMatches += 1;
  }
  if (result.opportunityType === "supply_without_demand") {
    accumulator.summary.supplyWithoutDemand += 1;
  }
  if (result.opportunityType === "historical_signal") accumulator.summary.historicalSignals += 1;
  if (result.opportunityType === "review_required") accumulator.summary.reviewRequired += 1;
}

export type OpportunityMatchInput = {
  jobId: string;
  rows: CanonicalOpportunityRow[];
  roleA: OpportunitySelectedRole;
  roleB: OpportunitySelectedRole;
  clientContext?: string | null;
  missingMpnRows?: number;
  invalidQuantityRows?: number;
  rejectedRows?: number;
  diagnostics?: OpportunityMatcherDiagnostics;
};

export type OpportunityMatcherProgress = {
  completedEvents: number;
  totalEvents: number;
};

export type OpportunityMatcherOutputChunk = {
  results: OpportunityResult[];
  possibleMatches: PossibleOpportunityMatch[];
};

export type OpportunityMatcherControl = {
  eventsPerYield?: number;
  operationsPerYield?: number;
  /** Worker-only bounded persistence mode; defaults to retaining the full output. */
  collectOutput?: boolean;
  /** Maximum combined results and possible matches delivered in one callback. */
  outputChunkSize?: number;
  /** Required when collectOutput is false. The matcher awaits this for backpressure. */
  onOutputChunk?: (chunk: OpportunityMatcherOutputChunk) => void | Promise<void>;
  assertNotCancelled?: () => void | Promise<void>;
  onProgress?: (progress: OpportunityMatcherProgress) => void | Promise<void>;
};

type MatchExecution = {
  input: OpportunityMatchInput;
  context: MatcherContext;
  supplyRole: OpportunitySelectedRole;
  fallbackHistorical: boolean;
  events: DemandEvent[];
  supplyIndex: SupplyIndex;
  lots: SupplyLot[];
  results: OpportunityResult[];
  possibleMatches: PossibleOpportunityMatch[];
  possibleMatchKeys: Set<string>;
  exactMatchedMpns: Set<string>;
  demandMpns: Set<string>;
  candidatePlans: Map<string, CandidatePlan>;
  summaryAccumulator: MatchSummaryAccumulator;
};

type AsyncMatcherOutputController = {
  collectOutput: boolean;
  chunkSize: number;
  onOutputChunk?: OpportunityMatcherControl["onOutputChunk"];
  assertNotCancelled?: OpportunityMatcherControl["assertNotCancelled"];
  pendingResults: OpportunityResult[];
  pendingPossibleMatches: PossibleOpportunityMatch[];
};

function createAsyncMatcherOutputController(
  control: OpportunityMatcherControl
): AsyncMatcherOutputController {
  const collectOutput = control.collectOutput !== false;
  if (!collectOutput && !control.onOutputChunk) {
    throw new Error("OPPORTUNITY_MATCH_OUTPUT_SINK_REQUIRED");
  }
  return {
    collectOutput,
    chunkSize: boundedMatcherControlValue(control.outputChunkSize, 500, 500),
    onOutputChunk: control.onOutputChunk,
    assertNotCancelled: control.assertNotCancelled,
    pendingResults: [],
    pendingPossibleMatches: []
  };
}

function recordMatchResult(
  execution: MatchExecution,
  result: OpportunityResult,
  collectOutput: boolean
) {
  addResultToSummaryAccumulator(execution.summaryAccumulator, result);
  if (collectOutput) execution.results.push(result);
}

function recordPossibleMatch(
  execution: MatchExecution,
  possibleMatch: PossibleOpportunityMatch,
  collectOutput: boolean
) {
  execution.summaryAccumulator.summary.possibleMatches += 1;
  if (collectOutput) execution.possibleMatches.push(possibleMatch);
}

async function flushMatcherOutputChunk(
  controller: AsyncMatcherOutputController,
  force = false
) {
  if (controller.collectOutput) return;
  const pendingCount = controller.pendingResults.length + controller.pendingPossibleMatches.length;
  if (!pendingCount || (!force && pendingCount < controller.chunkSize)) return;
  const resultCount = Math.min(controller.pendingResults.length, controller.chunkSize);
  const results = controller.pendingResults.splice(0, resultCount);
  const possibleMatchCount = Math.min(
    controller.pendingPossibleMatches.length,
    controller.chunkSize - results.length
  );
  const possibleMatches = controller.pendingPossibleMatches.splice(0, possibleMatchCount);
  await controller.onOutputChunk?.({ results, possibleMatches });
  await controller.assertNotCancelled?.();
}

async function emitMatchResult(
  execution: MatchExecution,
  controller: AsyncMatcherOutputController,
  result: OpportunityResult
) {
  recordMatchResult(execution, result, controller.collectOutput);
  if (!controller.collectOutput) {
    controller.pendingResults.push(result);
    await flushMatcherOutputChunk(controller);
  }
}

async function emitPossibleMatch(
  execution: MatchExecution,
  controller: AsyncMatcherOutputController,
  possibleMatch: PossibleOpportunityMatch
) {
  recordPossibleMatch(execution, possibleMatch, controller.collectOutput);
  if (!controller.collectOutput) {
    controller.pendingPossibleMatches.push(possibleMatch);
    await flushMatcherOutputChunk(controller);
  }
}

function* prepareMatchExecutionSteps(
  input: OpportunityMatchInput,
  work: MatcherWorkBudget,
  cacheRowMetadata = true
): Generator<void, MatchExecution, void> {
  const context: MatcherContext = {
    now: Date.now(),
    rowKeys: cacheRowMetadata
      ? new WeakMap<CanonicalOpportunityRow, RowMatchKeys>()
      : undefined,
    sourceTraces: cacheRowMetadata
      ? new WeakMap<CanonicalOpportunityRow, OpportunitySourceTrace>()
      : undefined,
    diagnostics: input.diagnostics
  };
  const compatibility = evaluateOpportunityCompatibility(input.roleA, input.roleB);
  if (!compatibility.compatible || !compatibility.demandSide || !compatibility.supplySide) {
    throw new Error(`Incompatible opportunity roles: ${compatibility.reasonCode}`);
  }
  const supplyRole = compatibility.supplySide === "A" ? input.roleA : input.roleB;
  const fallbackHistorical = HISTORY_ROLES.has(supplyRole);
  const clientContext = input.clientContext?.normalize("NFKC").trim().replace(/\s+/g, " ") || null;
  const demandRows: CanonicalOpportunityRow[] = [];
  for (const row of input.rows) {
    if (
      row.side === compatibility.demandSide &&
      row.recordRole === "demand" &&
      row.isActiveDemand !== false &&
      row.normalizedMpn
    ) {
      demandRows.push(!row.customerContext && clientContext
        ? { ...row, customerContext: clientContext }
        : row);
    }
    if (matcherWorkStep(work)) yield;
  }
  const supplyRows: CanonicalOpportunityRow[] = [];
  for (const row of input.rows) {
    if (!row.normalizedMpn) {
      if (matcherWorkStep(work)) yield;
      continue;
    }
    const selectedSupply = row.side === compatibility.supplySide && row.recordRole === supplyRole;
    const embeddedOffer = !fallbackHistorical &&
      row.recordKind === "supply_lot" && row.recordRole === "supplier_offer";
    if (selectedSupply || embeddedOffer) supplyRows.push(row);
    if (matcherWorkStep(work)) yield;
  }
  const events = yield* groupDemandEventSteps(demandRows, context, work);
  const deduplicatedSupplyRows = yield* deduplicateSupplyRowsSteps(supplyRows, work);
  const supplyIndex = yield* buildSupplyIndexSteps(deduplicatedSupplyRows, context, work);
  const lots = supplyIndex.lots;
  const results: OpportunityResult[] = [];
  const possibleMatches: PossibleOpportunityMatch[] = [];
  const possibleMatchKeys = new Set<string>();
  const exactMatchedMpns = new Set<string>();
  const demandMpns = new Set<string>();
  for (const event of events) {
    for (const option of event.options) {
      demandMpns.add(option.normalizedMpn);
      if (matcherWorkStep(work)) yield;
    }
  }
  const candidatePlans = new Map<string, CandidatePlan>();

  if (input.diagnostics) {
    input.diagnostics.demandEvents = events.length;
    input.diagnostics.supplyLots = lots.length;
  }

  return {
    input,
    context,
    supplyRole,
    fallbackHistorical,
    events,
    supplyIndex,
    lots,
    results,
    possibleMatches,
    possibleMatchKeys,
    exactMatchedMpns,
    demandMpns,
    candidatePlans,
    summaryAccumulator: {
      summary: emptySummary(),
      usableAvailabilityMpns: new Set<string>()
    }
  };
}

function prepareMatchExecution(input: OpportunityMatchInput): MatchExecution {
  return runMatcherStepsSynchronously(prepareMatchExecutionSteps(
    input,
    matcherWorkBudget()
  ));
}

function processMatchEvent(execution: MatchExecution, event: DemandEvent) {
  const plan = candidatePlan(
    event,
    execution.supplyIndex,
    execution.candidatePlans,
    execution.context
  );
  plan.matchedMpns.forEach((mpn) => execution.exactMatchedMpns.add(mpn));
  const result = buildDemandResult({
    jobId: execution.input.jobId,
    event,
    supplyRole: execution.supplyRole,
    plan,
    supplyIndex: execution.supplyIndex,
    fallbackHistorical: execution.fallbackHistorical,
    context: execution.context,
    diagnostics: execution.input.diagnostics
  });
  if (result) recordMatchResult(execution, result, true);
  if (!execution.fallbackHistorical) {
    for (const possibleMatch of possibleMatchesForEvent(
      execution.input.jobId,
      event,
      execution.supplyIndex,
      execution.context
    )) {
      if (execution.possibleMatchKeys.has(possibleMatch.candidateKey)) continue;
      execution.possibleMatchKeys.add(possibleMatch.candidateKey);
      recordPossibleMatch(execution, possibleMatch, true);
    }
  }
}

async function processMatchEventCooperatively(
  execution: MatchExecution,
  event: DemandEvent,
  work: MatcherWorkBudget,
  outputController: AsyncMatcherOutputController,
  assertNotCancelled?: () => void | Promise<void>
) {
  const plan = await runMatcherStepsCooperatively(candidatePlanSteps(
    event,
    execution.supplyIndex,
    execution.candidatePlans,
    execution.context,
    work
  ), assertNotCancelled);
  plan.matchedMpns.forEach((mpn) => execution.exactMatchedMpns.add(mpn));
  const resultInput: DemandResultInput = {
    jobId: execution.input.jobId,
    event,
    supplyRole: execution.supplyRole,
    plan,
    supplyIndex: execution.supplyIndex,
    fallbackHistorical: execution.fallbackHistorical,
    context: execution.context,
    diagnostics: execution.input.diagnostics
  };
  const allocation = await runMatcherStepsCooperatively(
    demandAllocationSteps(resultInput, work),
    assertNotCancelled
  );
  const result = buildDemandResult(resultInput, allocation);
  if (result) await emitMatchResult(execution, outputController, result);
  if (execution.fallbackHistorical) return;

  const possibleMatchSteps = possibleMatchEmissionSteps(
    execution.input.jobId,
    event,
    execution.supplyIndex,
    execution.context,
    work
  );
  let possibleMatchStep = possibleMatchSteps.next();
  while (!possibleMatchStep.done) {
    const emission = possibleMatchStep.value;
    if (!emission) {
      await yieldMatcherControl(assertNotCancelled);
    } else if (!execution.possibleMatchKeys.has(emission.possibleMatch.candidateKey)) {
      execution.possibleMatchKeys.add(emission.possibleMatch.candidateKey);
      await emitPossibleMatch(execution, outputController, emission.possibleMatch);
    }
    possibleMatchStep = possibleMatchSteps.next();
  }
}

function* finalizeMatchExecutionSteps(
  execution: MatchExecution,
  work: MatcherWorkBudget
): Generator<void, OpportunityMatchOutput, void> {
  const supplyWithoutDemandInput = {
    jobId: execution.input.jobId,
    lots: execution.lots,
    exactDemandMpns: execution.demandMpns,
    context: execution.context
  };
  const supplyOnlyGroups = yield* supplyWithoutDemandGroupSteps(
    supplyWithoutDemandInput,
    work
  );
  for (const lots of supplyOnlyGroups.values()) {
    const result = yield* buildSupplyWithoutDemandResultSteps(
      supplyWithoutDemandInput,
      lots,
      work
    );
    recordMatchResult(execution, result, true);
    if (matcherWorkStep(work)) yield;
  }

  execution.results.sort((left, right) =>
    RESULT_ORDER[left.opportunityType] - RESULT_ORDER[right.opportunityType] ||
    dateSortValue(left.requiredDate) - dateSortValue(right.requiredDate) ||
    left.normalizedMpn.localeCompare(right.normalizedMpn) ||
    (left.demandEventKey ?? "").localeCompare(right.demandEventKey ?? "")
  );
  const analyzedMpns = new Set(execution.demandMpns);
  for (const lot of execution.lots) {
    analyzedMpns.add(lot.row.normalizedMpn);
    if (matcherWorkStep(work)) yield;
  }
  let demandPartOptions = 0;
  for (const event of execution.events) {
    demandPartOptions += event.options.length;
    if (matcherWorkStep(work)) yield;
  }
  const summary = execution.summaryAccumulator.summary;
  summary.analyzedMpns = analyzedMpns.size;
  summary.exactMatches = execution.exactMatchedMpns.size;
  summary.usableAvailabilityMatches = execution.summaryAccumulator.usableAvailabilityMpns.size;
  summary.demandEvents = execution.events.length;
  summary.demandPartOptions = demandPartOptions;
  summary.supplyLots = execution.lots.length;
  summary.missingMpnRows = execution.input.missingMpnRows ?? 0;
  summary.invalidQuantityRows = execution.input.invalidQuantityRows ?? 0;
  summary.rejectedRows = execution.input.rejectedRows ?? 0;
  summary.possibleMatches = execution.possibleMatches.length;
  return {
    results: execution.results,
    possibleMatches: execution.possibleMatches,
    summary,
    rejectedRows: []
  };
}

async function finalizeMatchExecutionCooperatively(
  execution: MatchExecution,
  work: MatcherWorkBudget,
  outputController: AsyncMatcherOutputController,
  assertNotCancelled?: () => void | Promise<void>
): Promise<OpportunityMatchOutput> {
  const supplyWithoutDemandInput = {
    jobId: execution.input.jobId,
    lots: execution.lots,
    exactDemandMpns: execution.demandMpns,
    context: execution.context
  };
  const supplyOnlyGroups = await runMatcherStepsCooperatively(
    supplyWithoutDemandGroupSteps(supplyWithoutDemandInput, work),
    assertNotCancelled
  );
  for (const lots of supplyOnlyGroups.values()) {
    const result = await runMatcherStepsCooperatively(
      buildSupplyWithoutDemandResultSteps(supplyWithoutDemandInput, lots, work),
      assertNotCancelled
    );
    await emitMatchResult(execution, outputController, result);
    if (matcherWorkStep(work)) await yieldMatcherControl(assertNotCancelled);
  }

  if (outputController.collectOutput) {
    execution.results.sort((left, right) =>
      RESULT_ORDER[left.opportunityType] - RESULT_ORDER[right.opportunityType] ||
      dateSortValue(left.requiredDate) - dateSortValue(right.requiredDate) ||
      left.normalizedMpn.localeCompare(right.normalizedMpn) ||
      (left.demandEventKey ?? "").localeCompare(right.demandEventKey ?? "")
    );
  }
  const analyzedMpns = new Set(execution.demandMpns);
  for (const lot of execution.lots) {
    analyzedMpns.add(lot.row.normalizedMpn);
    if (matcherWorkStep(work)) await yieldMatcherControl(assertNotCancelled);
  }
  let demandPartOptions = 0;
  for (const event of execution.events) {
    demandPartOptions += event.options.length;
    if (matcherWorkStep(work)) await yieldMatcherControl(assertNotCancelled);
  }
  const summary = execution.summaryAccumulator.summary;
  summary.analyzedMpns = analyzedMpns.size;
  summary.exactMatches = execution.exactMatchedMpns.size;
  summary.usableAvailabilityMatches = execution.summaryAccumulator.usableAvailabilityMpns.size;
  summary.demandEvents = execution.events.length;
  summary.demandPartOptions = demandPartOptions;
  summary.supplyLots = execution.lots.length;
  summary.missingMpnRows = execution.input.missingMpnRows ?? 0;
  summary.invalidQuantityRows = execution.input.invalidQuantityRows ?? 0;
  summary.rejectedRows = execution.input.rejectedRows ?? 0;

  while (
    outputController.pendingResults.length ||
    outputController.pendingPossibleMatches.length
  ) {
    await flushMatcherOutputChunk(outputController, true);
  }
  return {
    results: execution.results,
    possibleMatches: execution.possibleMatches,
    summary,
    rejectedRows: []
  };
}

function finalizeMatchExecution(execution: MatchExecution): OpportunityMatchOutput {
  return runMatcherStepsSynchronously(finalizeMatchExecutionSteps(
    execution,
    matcherWorkBudget()
  ));
}

export function matchOpportunityRows(input: OpportunityMatchInput): OpportunityMatchOutput {
  const execution = prepareMatchExecution(input);
  for (const event of execution.events) processMatchEvent(execution, event);
  return finalizeMatchExecution(execution);
}

export async function matchOpportunityRowsAsync(
  input: OpportunityMatchInput,
  control: OpportunityMatcherControl = {}
): Promise<OpportunityMatchOutput> {
  await control.assertNotCancelled?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const eventsPerYield = boundedMatcherControlValue(
    control.eventsPerYield,
    1_000,
    10_000
  );
  const operationsPerYield = boundedMatcherControlValue(
    control.operationsPerYield,
    2_000,
    100_000
  );
  const outputController = createAsyncMatcherOutputController(control);
  const work = matcherWorkBudget(operationsPerYield);
  const execution = await runMatcherStepsCooperatively(
    prepareMatchExecutionSteps(input, work, outputController.collectOutput),
    control.assertNotCancelled
  );
  await control.assertNotCancelled?.();
  for (const [eventIndex, event] of execution.events.entries()) {
    await processMatchEventCooperatively(
      execution,
      event,
      work,
      outputController,
      control.assertNotCancelled
    );
    const completedEvents = eventIndex + 1;
    if (
      completedEvents === execution.events.length ||
      completedEvents % eventsPerYield === 0
    ) {
      await control.assertNotCancelled?.();
      await control.onProgress?.({
        completedEvents,
        totalEvents: execution.events.length
      });
      if (completedEvents < execution.events.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  await control.assertNotCancelled?.();
  return finalizeMatchExecutionCooperatively(
    execution,
    work,
    outputController,
    control.assertNotCancelled
  );
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
  "demandTracePreviewTruncated",
  "supplyTracePreviewTruncated",
  "allocationTracePreviewTruncated",
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
