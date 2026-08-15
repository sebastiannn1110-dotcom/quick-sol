import { describe, expect, it } from "vitest";
import { opportunityPayloadChunks } from "@/lib/opportunity-finder/worker";

describe("Opportunity Finder bounded database payloads", () => {
  it.each([999, 1000, 1001, 5000, 10000])(
    "preserves all %i records without a silent 1,000-row truncation",
    (count) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        id: index,
        value: `SYNTHETIC-${String(index).padStart(5, "0")}`
      }));
      const chunks = opportunityPayloadChunks(rows, 500, 64 * 1024);
      expect(chunks.flat()).toEqual(rows);
      expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    }
  );

  it("splits wide traces by UTF-8 payload size as well as row count", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id: index,
      trace: "x".repeat(1_024)
    }));
    const chunks = opportunityPayloadChunks(rows, 500, 4_096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(rows);
    expect(chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk), "utf8") <= 4_096)).toBe(true);
  });
});
