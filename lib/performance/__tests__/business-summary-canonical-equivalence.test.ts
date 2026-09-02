import { describe, expect, it } from "vitest";
import {
  canonicalDecimal,
  runCanonicalBusinessSummaryAudit,
  sumCanonicalDecimals
} from "@/lib/performance/business-summary-canonical-audit";

describe("Ronda 7 canonical BEFORE/AFTER equivalence", () => {
  it("uses an independent exact decimal oracle without tolerance or rounding", () => {
    expect(sumCanonicalDecimals(Array.from({ length: 1000 }, () => "0.1"))).toBe("100");
    expect(sumCanonicalDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumCanonicalDecimals(["100.0000", "-0.000", "-0.5", "0.50"])).toBe("100");
    expect(sumCanonicalDecimals(["999999999999999.0001", "0.0009"])).toBe("999999999999999.001");
    expect(canonicalDecimal("-0.000")).toBe("0");
    expect(canonicalDecimal("1.2300")).toBe("1.23");
    expect(canonicalDecimal("1e-7")).toBe("0.0000001");
    expect(canonicalDecimal("99.9999999999986")).toBe("99.9999999999986");
    expect(canonicalDecimal("99.9999999999986")).not.toBe("100");
  });

  it("keeps rows, keys, warnings and non-decimals identical while correcting only IEEE-754 sums", () => {
    const reports = [1, 2, 7, 500, 10_001].map((chunk) =>
      runCanonicalBusinessSummaryAudit(10_000, chunk)
    );
    const [reference] = reports;
    expect(reference.classifications.UNEXPECTED_DIFFERENCE).toBe(0);
    expect(reference.classifications).toEqual({
      IDENTICAL: 230_240,
      EXPECTED_DECIMAL_CORRECTION: 24,
      NONDETERMINISTIC_FIELD_EXCLUDED: 0,
      UNEXPECTED_DIFFERENCE: 0
    });
    expect(reference.excludedFields).toEqual([]);
    expect(reference.businessKeys).toEqual({
      summary: ["normalized_mpn"],
      entity: ["source_record_id", "entity_kind", "entity_key"]
    });
    expect(reference.countsBefore).toEqual({ summaryRows: 12, entityRows: 10_000 });
    expect(reference.countsAfter).toEqual(reference.countsBefore);
    expect(reference.hashes.canonicalNonDecimalBefore).toBe(reference.hashes.canonicalNonDecimalAfter);
    expect(reference.hashes.canonicalWarningsBefore).toBe(reference.hashes.canonicalWarningsAfter);
    expect(reference.hashes.canonicalCountsBefore).toBe(reference.hashes.canonicalCountsAfter);
    expect(reference.hashes.canonicalDecimalAfter).toBe(reference.hashes.canonicalDecimalOracle);
    expect(reference.hashes.canonicalDecimalBefore).not.toBe(reference.hashes.canonicalDecimalAfter);
    expect(reference.hashes).toMatchObject({
      rawBeforeSummary: "ccafd3bd30a1947308b6d53987cf2b4e3c36709fc16018d73338c52689a1f5ee",
      rawBeforeEntity: "1b70ae895a1248364adee91d0d28ca271d1db52769d9eae0887421a1e5e5b7fc",
      rawAfterSummary: "0d258296bb1ddaa12df53152b5832dde990ec85f88997cd47648675c3e9c8f28",
      rawAfterEntity: "1b70ae895a1248364adee91d0d28ca271d1db52769d9eae0887421a1e5e5b7fc",
      canonicalNonDecimalBefore: "c383f674f2591401592085daceb07e48bb6c60a10e3bae63cb389e9568d6cca3",
      canonicalNonDecimalAfter: "c383f674f2591401592085daceb07e48bb6c60a10e3bae63cb389e9568d6cca3",
      canonicalDecimalBefore: "132d983b84cc3c45b7a3de9155b153e8e9e1734b43506d13781d6b25f8dbaba7",
      canonicalDecimalAfter: "3d8743a5f3a16d47b4b8be61079d9e66c557a53447e4df4e92b6f49b3cb480f2",
      canonicalDecimalOracle: "3d8743a5f3a16d47b4b8be61079d9e66c557a53447e4df4e92b6f49b3cb480f2",
      canonicalWarningsBefore: "ae6faca0e8a1349879584ed47d9d6315b6668678fecb2c7799c8cdb18b970546",
      canonicalWarningsAfter: "ae6faca0e8a1349879584ed47d9d6315b6668678fecb2c7799c8cdb18b970546",
      canonicalCountsBefore: "16f53c7d7afe3a4b26ba27610e167d94e1b83bf683db36a712cb6265d1897734",
      canonicalCountsAfter: "16f53c7d7afe3a4b26ba27610e167d94e1b83bf683db36a712cb6265d1897734",
      canonicalSummaryBefore: "0c5605ed040238daa859606f22638aaa8822ee2c59ee7ab14aa65b1093f09a62",
      canonicalSummaryAfter: "84cd7ea1db3095cc47ceec20ecfd0fec1bd56feaebd06c204c448e19c8d528b4",
      canonicalSummaryOracle: "84cd7ea1db3095cc47ceec20ecfd0fec1bd56feaebd06c204c448e19c8d528b4",
      canonicalEntityBefore: "0f6834e258500e6fde5a78897ce9e6999f80ac2660197a4aab2d082abb65e2a3",
      canonicalEntityAfter: "0f6834e258500e6fde5a78897ce9e6999f80ac2660197a4aab2d082abb65e2a3",
      canonicalEntityOracle: "0f6834e258500e6fde5a78897ce9e6999f80ac2660197a4aab2d082abb65e2a3",
      canonicalFullBefore: "eafa03d4fb358445b14f455f218c2e1df6d5372b05fabdf25e3c9fd13676d3d3",
      canonicalFullAfter: "6335abb326ae0d0eb317e09584265d1924cbe59f7a9257e9615a927ed85cb45b"
    });

    for (const report of reports) {
      expect(report.classifications.UNEXPECTED_DIFFERENCE).toBe(0);
      expect(report.countsAfter).toEqual(reference.countsAfter);
      expect(report.hashes.rawAfterSummary).toBe(reference.hashes.rawAfterSummary);
      expect(report.hashes.rawAfterEntity).toBe(reference.hashes.rawAfterEntity);
      expect(report.hashes.canonicalNonDecimalAfter).toBe(reference.hashes.canonicalNonDecimalAfter);
      expect(report.hashes.canonicalDecimalAfter).toBe(reference.hashes.canonicalDecimalAfter);
      expect(report.hashes.canonicalWarningsAfter).toBe(reference.hashes.canonicalWarningsAfter);
      expect(report.hashes.canonicalFullAfter).toBe(reference.hashes.canonicalFullAfter);
    }
  }, 120_000);
});
