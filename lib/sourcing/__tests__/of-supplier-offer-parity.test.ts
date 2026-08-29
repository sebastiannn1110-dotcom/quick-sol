import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import { parseOpportunityWorkbook } from "@/lib/opportunity-finder/parser";
import type { CanonicalOpportunityRow, OpportunityResult } from "@/lib/opportunity-finder/types";

type ExpectedCase = {
  testCaseId: string;
  mpn: string;
  expectedType: string;
  requiredQty: number | null;
  originalAvailability: number | null;
  expectedAssignedQty: number | null;
  expectedShortage: number | null;
  expectedCoverage: number | null;
  exactMpnMatch: boolean;
  usableAvailabilityMatch: boolean;
  exactQuantityMatch: boolean;
  expectedWarnings: string[];
  expectedManufacturer: string | null;
  expectedReference: string | null;
};

const fixtureRoot = path.join(process.cwd(), "qa/fixtures/opportunity-finder/manual/set-04-rfq-supplier-offers");

async function parse(fileName: string, fileId: string, side: "A" | "B", role: "demand" | "supplier_offer") {
  const rows: CanonicalOpportunityRow[] = [];
  const metrics = await parseOpportunityWorkbook({
    filePath: path.join(fixtureRoot, fileName),
    fileName,
    fileId,
    jobId: "00000000-0000-4000-8000-000000000001",
    side,
    role,
    ...(role === "supplier_offer" ? { validityOverrideExpiresAt: "2099-12-31T23:59:59.000Z" } : {}),
    onBatch: async (batch) => rows.push(...batch)
  });
  return { rows, metrics };
}

function resultFor(expected: ExpectedCase, results: OpportunityResult[]) {
  const sameMpn = results.filter((result) => result.normalizedMpn === expected.mpn);
  return expected.expectedReference
    ? sameMpn.find((result) => result.customerContext === expected.expectedReference) ?? null
    : sameMpn[0] ?? null;
}

/** Mandatory D6 parity: the certified supplier-offer fixture remains byte-for-contract equivalent. */
describe("D6 Opportunity Finder supplier-offer parity", () => {
  it("keeps every certified set-04 result unchanged", async () => {
    const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "expected-results.json"), "utf8")) as ExpectedCase[];
    const [demand, supply] = await Promise.all([
      parse("QA_Set04_RFQ_Demand.xlsx", "00000000-0000-4000-8000-00000000004a", "A", "demand"),
      parse("QA_Set04_Supplier_Offers.xlsx", "00000000-0000-4000-8000-00000000004b", "B", "supplier_offer")
    ]);
    const output = matchOpportunityRows({
      jobId: "00000000-0000-4000-8000-000000000001",
      roleA: "demand",
      roleB: "supplier_offer",
      rows: [...demand.rows, ...supply.rows],
      missingMpnRows: demand.metrics.missingMpnRows + supply.metrics.missingMpnRows,
      invalidQuantityRows: demand.metrics.invalidQuantityRows + supply.metrics.invalidQuantityRows
    });

    for (const contract of expected) {
      const result = resultFor(contract, output.results);
      if (contract.expectedType === "no_result") {
        expect(result, contract.testCaseId).toBeNull();
        continue;
      }
      expect(result, contract.testCaseId).not.toBeNull();
      expect(result).toMatchObject({
        opportunityType: contract.expectedType,
        requiredQty: contract.requiredQty,
        availableQty: contract.originalAvailability,
        allocatedQty: contract.expectedAssignedQty,
        shortageQty: contract.expectedShortage,
        coveragePercent: contract.expectedCoverage,
        exactMpnMatch: contract.exactMpnMatch,
        usableAvailabilityMatch: contract.usableAvailabilityMatch,
        exactQuantityMatch: contract.exactQuantityMatch,
        manufacturer: contract.expectedManufacturer,
        customerContext: contract.expectedReference
      });
      expect(result?.warnings).toEqual(expect.arrayContaining(contract.expectedWarnings));
    }
    expect(expected).toHaveLength(4);
  }, 30_000);
});
