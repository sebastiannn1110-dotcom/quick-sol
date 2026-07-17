import { createHash } from "node:crypto";

export const BUSINESS_RECORD_DUPLICATE_CRITERION =
  "upload_batch_id + row_index + md5(raw_data::text) + md5(normalized_data::text) + category";

export type DuplicateCleanupInput = {
  expectedRecords: number;
  activeRecords: number;
  duplicateGroups: number;
  duplicateRecordsToArchive: number;
  uniqueRecordsAfterExactDedupe: number;
  maxGroupSize: number;
};

export type DuplicateCleanupPlan = DuplicateCleanupInput & {
  criterion: string;
  cleanupMode: "soft_archive";
  plannedRemainingRecords: number;
  residualAfterCleanup: number;
  hasExpectedMismatchAfterCleanup: boolean;
  confidenceLevel: "low" | "medium" | "high";
  cleanupSafe: boolean;
  risk: "low" | "medium" | "high";
  recommendation: string;
};

export type DuplicateSourceRow = {
  id: string;
  rowIndex: number | null;
  category: string | null;
  rawData: unknown;
  normalizedData: unknown;
  createdAt: string;
};

export type DuplicateCandidate = {
  id: string;
  rowIndex: number | null;
  rawHashPrefix: string;
  normalizedHashPrefix: string;
  keeperId: string;
  createdAt: string;
};

export type DuplicateGroupSummary = {
  rowIndex: number | null;
  recordsInGroup: number;
  recordsToArchive: number;
  rawHashPrefix: string;
  normalizedHashPrefix: string;
  keeperId: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type DuplicateScanResult = {
  activeRecords: number;
  duplicateGroups: number;
  duplicateRecordsToArchive: number;
  uniqueRecordsAfterExactDedupe: number;
  maxGroupSize: number;
  candidates: DuplicateCandidate[];
  sampleDuplicateGroups: DuplicateGroupSummary[];
};

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJson(item)])
    );
  }
  return value;
}

export function stableJsonHash(value: unknown) {
  return createHash("md5").update(JSON.stringify(stableJson(value ?? {}))).digest("hex");
}

function compareNewestFirst(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }) {
  const created = String(right.createdAt).localeCompare(String(left.createdAt));
  if (created !== 0) return created;
  return String(right.id).localeCompare(String(left.id));
}

function compareCandidates(left: DuplicateCandidate, right: DuplicateCandidate) {
  const leftRow = left.rowIndex ?? Number.MAX_SAFE_INTEGER;
  const rightRow = right.rowIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftRow !== rightRow) return leftRow - rightRow;
  const created = String(left.createdAt).localeCompare(String(right.createdAt));
  if (created !== 0) return created;
  return String(left.id).localeCompare(String(right.id));
}

export function scanDuplicateRows(rows: DuplicateSourceRow[]): DuplicateScanResult {
  const groups = new Map<string, Array<DuplicateSourceRow & { rawHash: string; normalizedHash: string }>>();

  for (const row of rows) {
    const rawHash = stableJsonHash(row.rawData);
    const normalizedHash = stableJsonHash(row.normalizedData);
    const key = [row.rowIndex ?? "", rawHash, normalizedHash, row.category ?? ""].join("|");
    const group = groups.get(key) ?? [];
    group.push({ ...row, rawHash, normalizedHash });
    groups.set(key, group);
  }

  const candidates: DuplicateCandidate[] = [];
  const sampleDuplicateGroups: DuplicateGroupSummary[] = [];
  let duplicateGroups = 0;
  let duplicateRecordsToArchive = 0;
  let maxGroupSize = 0;

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    duplicateGroups += 1;
    duplicateRecordsToArchive += group.length - 1;
    maxGroupSize = Math.max(maxGroupSize, group.length);
    const sorted = [...group].sort(compareNewestFirst);
    const keeper = sorted[0];
    const duplicateRows = sorted.slice(1);
    const sortedByCreated = [...group].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));

    candidates.push(
      ...duplicateRows.map((row) => ({
        id: row.id,
        rowIndex: row.rowIndex,
        rawHashPrefix: row.rawHash.slice(0, 12),
        normalizedHashPrefix: row.normalizedHash.slice(0, 12),
        keeperId: keeper.id,
        createdAt: row.createdAt
      }))
    );

    sampleDuplicateGroups.push({
      rowIndex: keeper.rowIndex,
      recordsInGroup: group.length,
      recordsToArchive: group.length - 1,
      rawHashPrefix: keeper.rawHash.slice(0, 12),
      normalizedHashPrefix: keeper.normalizedHash.slice(0, 12),
      keeperId: keeper.id,
      firstSeenAt: sortedByCreated[0]?.createdAt ?? keeper.createdAt,
      lastSeenAt: sortedByCreated.at(-1)?.createdAt ?? keeper.createdAt
    });
  }

  candidates.sort(compareCandidates);
  sampleDuplicateGroups.sort((left, right) => {
    if (right.recordsInGroup !== left.recordsInGroup) return right.recordsInGroup - left.recordsInGroup;
    return (left.rowIndex ?? Number.MAX_SAFE_INTEGER) - (right.rowIndex ?? Number.MAX_SAFE_INTEGER);
  });

  return {
    activeRecords: rows.length,
    duplicateGroups,
    duplicateRecordsToArchive,
    uniqueRecordsAfterExactDedupe: rows.length - duplicateRecordsToArchive,
    maxGroupSize,
    candidates,
    sampleDuplicateGroups: sampleDuplicateGroups.slice(0, 10)
  };
}

export function buildDuplicateCleanupPlan(input: DuplicateCleanupInput): DuplicateCleanupPlan {
  const plannedRemainingRecords = input.activeRecords - input.duplicateRecordsToArchive;
  const residualAfterCleanup = plannedRemainingRecords - input.expectedRecords;
  const hasExpectedMismatchAfterCleanup = residualAfterCleanup !== 0;
  const hasLargeGroups = input.maxGroupSize > 3;
  const hasVeryLargeGroups = input.maxGroupSize > 10;
  const hasDuplicates = input.duplicateRecordsToArchive > 0;
  const confidenceLevel = !hasDuplicates
    ? "high"
    : hasVeryLargeGroups
      ? "low"
      : hasLargeGroups
        ? "medium"
        : "high";
  const cleanupSafe = hasDuplicates && confidenceLevel !== "low";
  const risk = hasVeryLargeGroups
    ? "high"
    : hasLargeGroups || hasExpectedMismatchAfterCleanup
    ? "medium"
    : hasDuplicates
      ? "low"
      : "low";

  const recommendation = !hasDuplicates
    ? "No duplicate cleanup is needed."
    : !cleanupSafe
      ? "Do not clean automatically; duplicate groups are too large for a safe exact cleanup without manual review."
    : hasExpectedMismatchAfterCleanup
      ? "Soft-archive exact duplicate records only; investigate the remaining expected-count mismatch separately."
      : "Soft-archive exact duplicate records after reviewing the dry-run report.";

  return {
    ...input,
    criterion: BUSINESS_RECORD_DUPLICATE_CRITERION,
    cleanupMode: "soft_archive",
    plannedRemainingRecords,
    residualAfterCleanup,
    hasExpectedMismatchAfterCleanup,
    confidenceLevel,
    cleanupSafe,
    risk,
    recommendation
  };
}
