import { describe, expect, it } from "vitest";
import {
  BUSINESS_RECORD_DUPLICATE_CRITERION,
  buildDuplicateCleanupPlan
} from "@/lib/upload/duplicate-cleanup";

describe("business record duplicate cleanup planning", () => {
  it("plans soft-archive cleanup for exact duplicates only", () => {
    const plan = buildDuplicateCleanupPlan({
      expectedRecords: 58000,
      activeRecords: 118000,
      duplicateGroups: 49000,
      duplicateRecordsToArchive: 59000,
      uniqueRecordsAfterExactDedupe: 59000,
      maxGroupSize: 3
    });

    expect(plan.criterion).toBe(BUSINESS_RECORD_DUPLICATE_CRITERION);
    expect(plan.cleanupMode).toBe("soft_archive");
    expect(plan.plannedRemainingRecords).toBe(59000);
    expect(plan.residualAfterCleanup).toBe(1000);
    expect(plan.hasExpectedMismatchAfterCleanup).toBe(true);
    expect(plan.confidenceLevel).toBe("high");
    expect(plan.cleanupSafe).toBe(true);
    expect(plan.risk).toBe("medium");
  });

  it("reports low risk when exact duplicate cleanup returns to expected count", () => {
    const plan = buildDuplicateCleanupPlan({
      expectedRecords: 58000,
      activeRecords: 116000,
      duplicateGroups: 58000,
      duplicateRecordsToArchive: 58000,
      uniqueRecordsAfterExactDedupe: 58000,
      maxGroupSize: 2
    });

    expect(plan.plannedRemainingRecords).toBe(58000);
    expect(plan.residualAfterCleanup).toBe(0);
    expect(plan.confidenceLevel).toBe("high");
    expect(plan.cleanupSafe).toBe(true);
    expect(plan.risk).toBe("low");
  });

  it("blocks automatic cleanup when duplicate groups are too large", () => {
    const plan = buildDuplicateCleanupPlan({
      expectedRecords: 100,
      activeRecords: 150,
      duplicateGroups: 1,
      duplicateRecordsToArchive: 50,
      uniqueRecordsAfterExactDedupe: 100,
      maxGroupSize: 51
    });

    expect(plan.confidenceLevel).toBe("low");
    expect(plan.cleanupSafe).toBe(false);
    expect(plan.risk).toBe("high");
    expect(plan.recommendation).toContain("Do not clean automatically");
  });
});
