import { describe, expect, it } from "vitest";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION,
  opportunityFinderPipelineVersionFromKey,
  sha256OpportunityFileContents
} from "@/lib/opportunity-finder/pipeline";

const files = [
  {
    side: "A" as const,
    contentSha256: "a".repeat(64),
    fileName: "synthetic-demand.xlsx",
    fileSize: 1200,
    fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  },
  {
    side: "B" as const,
    contentSha256: "b".repeat(64),
    fileName: "synthetic-stock.xlsx",
    fileSize: 950,
    fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
];

describe("Opportunity Finder idempotency pipeline", () => {
  it("hashes the actual browser file bytes with SHA-256", async () => {
    const hash = await sha256OpportunityFileContents(new Blob(["abc"]));
    const changed = await sha256OpportunityFileContents(new Blob(["abd"]));

    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(changed).not.toBe(hash);
  });

  it("builds the same private key for the same file bytes and pipeline version", async () => {
    const first = await buildOpportunityFinderIdempotencyKey({
      files
    });
    const second = await buildOpportunityFinderIdempotencyKey({
      files: [...files].reverse().map((file) => ({
        ...file,
        fileName: `renamed-${file.fileName}`,
        fileSize: (file.fileSize ?? 0) + 999,
        fileType: "application/octet-stream"
      }))
    });

    expect(first).toBe(second);
    expect(opportunityFinderPipelineVersionFromKey(first))
      .toBe(OPPORTUNITY_FINDER_PIPELINE_VERSION);
    expect(first).not.toContain("synthetic-demand.xlsx");
    expect(first).not.toContain(files[0].contentSha256);
    expect(first).not.toContain(files[1].contentSha256);
  });

  it("does not reuse the same content pair after a pipeline version change", async () => {
    const current = await buildOpportunityFinderIdempotencyKey({
      files,
      pipelineVersion: "2"
    });
    const future = await buildOpportunityFinderIdempotencyKey({
      files,
      pipelineVersion: "3"
    });

    expect(current).not.toBe(future);
    expect(opportunityFinderPipelineVersionFromKey(current)).toBe("2");
    expect(opportunityFinderPipelineVersionFromKey(future)).toBe("3");
  });

  it("changes the key when a single byte changes either file hash", async () => {
    const original = await buildOpportunityFinderIdempotencyKey({
      files
    });
    const changed = await buildOpportunityFinderIdempotencyKey({
      files: [
        files[0],
        { ...files[1], contentSha256: "c".repeat(64) }
      ]
    });

    expect(original).not.toBe(changed);
  });

  it("scopes reuse to the normalized optional client context", async () => {
    const first = await buildOpportunityFinderIdempotencyKey({
      files,
      clientContext: "  Sanmina   LATAM "
    });
    const equivalent = await buildOpportunityFinderIdempotencyKey({
      files,
      clientContext: "sanmina latam"
    });
    const different = await buildOpportunityFinderIdempotencyKey({
      files,
      clientContext: "Flex"
    });

    expect(first).toBe(equivalent);
    expect(first).not.toBe(different);
    expect(first).not.toContain("SANMINA");
  });

  it("rejects missing, malformed, uppercase, or duplicate-side hashes", async () => {
    await expect(buildOpportunityFinderIdempotencyKey({
      files: [{ ...files[0], contentSha256: "not-a-hash" }, files[1]]
    })).rejects.toThrow("OPPORTUNITY_FILE_HASH_INVALID");
    await expect(buildOpportunityFinderIdempotencyKey({
      files: [{ ...files[0], contentSha256: "A".repeat(64) }, files[1]]
    })).rejects.toThrow("OPPORTUNITY_FILE_HASH_INVALID");
    await expect(buildOpportunityFinderIdempotencyKey({
      files: [files[0], { ...files[1], side: "A" }]
    })).rejects.toThrow("OPPORTUNITY_REQUIRES_EXACTLY_TWO_FILE_HASHES");
  });

  it("does not assign a pipeline version to legacy or malformed keys", () => {
    expect(opportunityFinderPipelineVersionFromKey("legacy-random-key")).toBeNull();
    expect(opportunityFinderPipelineVersionFromKey("opportunity-finder:v2:not-a-digest")).toBeNull();
    expect(opportunityFinderPipelineVersionFromKey(null)).toBeNull();
  });
});
