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
