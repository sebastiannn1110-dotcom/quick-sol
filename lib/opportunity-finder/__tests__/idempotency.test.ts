import { describe, expect, it } from "vitest";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION,
  opportunityFinderPipelineVersionFromKey
} from "@/lib/opportunity-finder/pipeline";

const files = [
  {
    side: "A" as const,
    fileName: "synthetic-demand.xlsx",
    fileSize: 1200,
    fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  },
  {
    side: "B" as const,
    fileName: "synthetic-stock.xlsx",
    fileSize: 950,
    fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
];

describe("Opportunity Finder idempotency pipeline", () => {
  it("builds the same private key for the same attempt, files, and pipeline version", async () => {
    const first = await buildOpportunityFinderIdempotencyKey({
      attemptId: "00000000-0000-4000-8000-000000000001",
      files
    });
    const second = await buildOpportunityFinderIdempotencyKey({
      attemptId: "00000000-0000-4000-8000-000000000001",
      files: [...files].reverse()
    });

    expect(first).toBe(second);
    expect(opportunityFinderPipelineVersionFromKey(first))
      .toBe(OPPORTUNITY_FINDER_PIPELINE_VERSION);
    expect(first).not.toContain("synthetic-demand.xlsx");
    expect(first).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("does not reuse the same attempt after a pipeline version change", async () => {
    const current = await buildOpportunityFinderIdempotencyKey({
      attemptId: "same-attempt",
      files,
      pipelineVersion: "2"
    });
    const future = await buildOpportunityFinderIdempotencyKey({
      attemptId: "same-attempt",
      files,
      pipelineVersion: "3"
    });

    expect(current).not.toBe(future);
    expect(opportunityFinderPipelineVersionFromKey(current)).toBe("2");
    expect(opportunityFinderPipelineVersionFromKey(future)).toBe("3");
  });

  it("binds the key to the selected file metadata without exposing it", async () => {
    const original = await buildOpportunityFinderIdempotencyKey({
      attemptId: "same-attempt",
      files
    });
    const changed = await buildOpportunityFinderIdempotencyKey({
      attemptId: "same-attempt",
      files: [
        files[0],
        { ...files[1], fileSize: files[1].fileSize + 1 }
      ]
    });

    expect(original).not.toBe(changed);
  });

  it("does not assign a pipeline version to legacy or malformed keys", () => {
    expect(opportunityFinderPipelineVersionFromKey("legacy-random-key")).toBeNull();
    expect(opportunityFinderPipelineVersionFromKey("opportunity-finder:v2:not-a-digest")).toBeNull();
    expect(opportunityFinderPipelineVersionFromKey(null)).toBeNull();
  });
});
