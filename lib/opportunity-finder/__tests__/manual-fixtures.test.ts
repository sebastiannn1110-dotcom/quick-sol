import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseOpportunityWorkbook,
  profileOpportunityWorkbook
} from "@/lib/opportunity-finder/parser";
import {
  containsForbiddenOpportunityFields,
  matchOpportunityRows
} from "@/lib/opportunity-finder/matcher";
import type {
  CanonicalOpportunityRow,
  OpportunityResult,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";

type CertifiedCase = {
  testCaseId: string;
  needFile: string;
  availabilityFile: string;
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

const fixtureRoot = path.join(
  process.cwd(),
  "qa",
  "fixtures",
  "opportunity-finder",
  "manual"
);

const certifiedSets: Array<{
  directory: string;
  availabilityRole: OpportunitySelectedRole;
  validityOverrideExpiresAt?: string;
}> = [
  { directory: "set-01-planned-po-stock", availabilityRole: "stock" },
  { directory: "set-02-customer-demand-inventory", availabilityRole: "stock" },
  { directory: "set-03-need-list-excess", availabilityRole: "excess" },
  {
    directory: "set-04-rfq-supplier-offers",
    availabilityRole: "supplier_offer",
    validityOverrideExpiresAt: "2099-12-31T23:59:59.000Z"
  },
  { directory: "set-05-demand-received-parts", availabilityRole: "received_history" }
];

function manifest(setDirectory: string) {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, setDirectory, "expected-results.json"), "utf8")
  ) as CertifiedCase[];
}

async function parseFixture(input: {
  filePath: string;
  fileId: string;
  side: "A" | "B";
  role: OpportunitySelectedRole;
  validityOverrideExpiresAt?: string;
}) {
  const rows: CanonicalOpportunityRow[] = [];
  const metrics = await parseOpportunityWorkbook({
    filePath: input.filePath,
    fileName: path.basename(input.filePath),
    fileId: input.fileId,
    jobId: "00000000-0000-4000-8000-000000000001",
    side: input.side,
    role: input.role,
    validityOverrideExpiresAt: input.validityOverrideExpiresAt,
    onBatch: async (batch) => rows.push(...batch)
  });
  return { rows, metrics };
}

function matchingResult(certifiedCase: CertifiedCase, results: OpportunityResult[]) {
  const candidates = results.filter(
    (result) => result.normalizedMpn === certifiedCase.mpn
  );
  if (certifiedCase.expectedReference) {
    return candidates.find(
      (result) => result.customerContext === certifiedCase.expectedReference
    ) ?? null;
  }
  return candidates[0] ?? null;
}

function expectNumber(actual: number | null, expected: number | null) {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  expect(actual!).toBeCloseTo(expected, 8);
}

function expectCertifiedResult(
  certifiedCase: CertifiedCase,
  result: OpportunityResult | null
) {
  if (certifiedCase.expectedType === "no_result") {
    expect(result, certifiedCase.testCaseId).toBeNull();
    return;
  }

  expect(result, certifiedCase.testCaseId).not.toBeNull();
  expect(result!.opportunityType).toBe(certifiedCase.expectedType);
  expectNumber(result!.requiredQty, certifiedCase.requiredQty);
  expectNumber(result!.availableQty, certifiedCase.originalAvailability);
  expectNumber(result!.allocatedQty, certifiedCase.expectedAssignedQty);
  expectNumber(result!.shortageQty, certifiedCase.expectedShortage);
  expectNumber(result!.coveragePercent, certifiedCase.expectedCoverage);
  expect(result!.exactMpnMatch).toBe(certifiedCase.exactMpnMatch);
  expect(result!.usableAvailabilityMatch).toBe(
    certifiedCase.usableAvailabilityMatch
  );
  expect(result!.exactQuantityMatch).toBe(certifiedCase.exactQuantityMatch);
  expect(result!.manufacturer).toBe(certifiedCase.expectedManufacturer);
  expect(result!.customerContext).toBe(certifiedCase.expectedReference);
  expect(result!.warnings).toEqual(
    expect.arrayContaining(certifiedCase.expectedWarnings)
  );
}

function expectNoInventoryReuse(
  rows: CanonicalOpportunityRow[],
  results: OpportunityResult[]
) {
  const supplyByMpn = new Map<string, number>();
  const allocatedByMpn = new Map<string, number>();
  for (const row of rows.filter((item) => item.side === "B")) {
    const quantity = row.excessQty ?? row.availableQty ?? 0;
    if (Number.isFinite(quantity) && quantity > 0) {
      supplyByMpn.set(
        row.normalizedMpn,
        (supplyByMpn.get(row.normalizedMpn) ?? 0) + quantity
      );
    }
  }
  for (const result of results) {
    const quantity = result.allocatedQty ?? 0;
    if (quantity > 0) {
      allocatedByMpn.set(
        result.normalizedMpn,
        (allocatedByMpn.get(result.normalizedMpn) ?? 0) + quantity
      );
    }
  }
  for (const [mpn, allocated] of allocatedByMpn) {
    expect(allocated, mpn).toBeLessThanOrEqual((supplyByMpn.get(mpn) ?? 0) + 1e-9);
  }
}

describe("Opportunity Finder certified manual fixtures", () => {
  it("contains five synthetic sets and exactly 29 certified cases", () => {
    expect(certifiedSets).toHaveLength(5);
    expect(
      certifiedSets.reduce(
        (total, set) => total + manifest(set.directory).length,
        0
      )
    ).toBe(29);
  });

  for (const [setIndex, set] of certifiedSets.entries()) {
    it(`passes every certified case in ${set.directory}`, async () => {
      const cases = manifest(set.directory);
      const setRoot = path.join(fixtureRoot, set.directory);
      const needPath = path.join(setRoot, cases[0].needFile);
      const availabilityPath = path.join(setRoot, cases[0].availabilityFile);
      const [needProfile, availabilityProfile, need, availability] = await Promise.all([
        profileOpportunityWorkbook(needPath, path.basename(needPath)),
        profileOpportunityWorkbook(availabilityPath, path.basename(availabilityPath)),
        parseFixture({
          filePath: needPath,
          fileId: `00000000-0000-4000-8000-0000000000${setIndex}a`,
          side: "A",
          role: "demand"
        }),
        parseFixture({
          filePath: availabilityPath,
          fileId: `00000000-0000-4000-8000-0000000000${setIndex}b`,
           side: "B",
           role: set.availabilityRole,
           validityOverrideExpiresAt: set.validityOverrideExpiresAt
         })
      ]);

      expect(needProfile.detectedType).toBe("demand");
      if (set.availabilityRole === "excess" && availabilityProfile.detectedType === "unknown") {
        expect(availabilityProfile.classificationReasons).toContain("insufficient_or_ambiguous_structure");
      } else {
        expect(availabilityProfile.detectedType).toBe(set.availabilityRole);
      }

      const allRows = [...need.rows, ...availability.rows];
      const output = matchOpportunityRows({
        jobId: "00000000-0000-4000-8000-000000000001",
        roleA: "demand",
        roleB: set.availabilityRole,
        rows: allRows,
        missingMpnRows:
          need.metrics.missingMpnRows + availability.metrics.missingMpnRows,
        invalidQuantityRows:
          need.metrics.invalidQuantityRows + availability.metrics.invalidQuantityRows
      });

      for (const certifiedCase of cases) {
        expectCertifiedResult(
          certifiedCase,
          matchingResult(certifiedCase, output.results)
        );
      }

      expectNoInventoryReuse(allRows, output.results);
      expect(containsForbiddenOpportunityFields(output)).toBe(false);
      expect(output.summary.usableAvailabilityMatches).toBe(
        new Set(
          output.results
            .filter((result) => result.usableAvailabilityMatch)
            .map((result) => result.normalizedMpn)
        ).size
      );
      expect(output.summary.exactQuantityMatches).toBe(
        output.results.filter((result) => result.exactQuantityMatch).length
      );

      if (setIndex === 0) {
        const leadingZero = output.results.find(
          (result) => result.displayMpn === "0007-QA-006"
        );
        expect(leadingZero?.normalizedMpn).toBe("0007-QA-006");
      }
      expect(
        output.results.every(
          (result) =>
            !result.displayMpn.includes("-") || result.normalizedMpn.includes("-")
        )
      ).toBe(true);
    });
  }
});
