import { describe, expect, it } from "vitest";
import {
  containsForbiddenOpportunityFields,
  matchOpportunityRows
} from "@/lib/opportunity-finder/matcher";
import type {
  CanonicalOpportunityRow,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";

function row(input: Partial<CanonicalOpportunityRow> & {
  side: "A" | "B";
  role: OpportunitySelectedRole;
  mpn: string;
}): CanonicalOpportunityRow {
  return {
    jobId: "job",
    fileId: input.side === "A" ? "demand-file" : "supply-file",
    side: input.side,
    fileName: input.side === "A" ? "demand.xlsx" : "supply.xlsx",
    sheetName: "Sheet1",
    sourceRow: input.sourceRow ?? 2,
    originalIndex: input.originalIndex ?? 0,
    recordRole: input.role,
    rawMpn: input.mpn,
    displayMpn: input.mpn,
    normalizedMpn: input.mpn.toUpperCase(),
    reviewKey: input.mpn.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    manufacturer: input.manufacturer ?? null,
    customerContext: input.customerContext ?? null,
    supplierContext: input.supplierContext ?? null,
    requiredQty: input.requiredQty ?? null,
    availableQty: input.availableQty ?? null,
    excessQty: input.excessQty ?? null,
    requiredDate: input.requiredDate ?? null,
    unitOfMeasure: input.unitOfMeasure ?? null,
    qualityFlags: input.qualityFlags ?? []
  };
}

describe("two-file opportunity allocation", () => {
  it("aggregates duplicate stock and never reuses the same units", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "ABC-1", requiredQty: 700, requiredDate: "2026-08-01", customerContext: "A" }),
        row({ side: "A", role: "demand", mpn: "ABC-1", requiredQty: 600, requiredDate: "2026-08-02", customerContext: "B", sourceRow: 3 }),
        row({ side: "B", role: "stock", mpn: "ABC-1", availableQty: 400 }),
        row({ side: "B", role: "stock", mpn: "ABC-1", availableQty: 600, sourceRow: 3 })
      ]
    });
    expect(output.results.map((item) => [item.opportunityType, item.allocatedQty, item.shortageQty])).toEqual([
      ["full_sale", 700, 0],
      ["partial_sale", 300, 300]
    ]);
  });

  it("uses required date before source order", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 5, requiredDate: "2026-09-01", customerContext: "later", sourceRow: 2 }),
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 5, requiredDate: "2026-08-01", customerContext: "first", sourceRow: 10 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 5 })
      ]
    });
    expect(output.results[0]).toMatchObject({ customerContext: "first", allocatedQty: 5 });
    expect(output.results[1]).toMatchObject({ customerContext: "later", allocatedQty: 0 });
  });

  it("does not count zero or negative stock as availability", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 0 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: null, qualityFlags: ["negative_available_quantity"] })
      ]
    });
    expect(output.results[0]).toMatchObject({
      opportunityType: "sourcing_needed",
      availableQty: 0,
      allocatedQty: 0,
      shortageQty: 10
    });
    expect(output.results[0].warnings).toContain("negative_available_quantity");
  });

  it("keeps manufacturer conflicts visible but not confirmed", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10, manufacturer: "TI" }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 10, manufacturer: "Samsung" })
      ]
    });
    expect(output.results[0]).toMatchObject({
      opportunityType: "review_required",
      allocatedQty: 0,
      reasonCode: "manufacturer_conflict"
    });
  });

  it("keeps symbol-only variants outside exact opportunities", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "ABC-001", requiredQty: 10 }),
        row({ side: "B", role: "stock", mpn: "ABC001", availableQty: 10 })
      ]
    });
    expect(output.results.find((item) => item.displayMpn === "ABC-001")).toMatchObject({
      opportunityType: "sourcing_needed",
      exactMatch: false
    });
    expect(output.possibleMatches).toHaveLength(1);
  });

  it("marks received history as historical, never as current availability", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "received_history",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10 }),
        row({ side: "B", role: "received_history", mpn: "X", availableQty: 100 })
      ]
    });
    expect(output.results[0]).toMatchObject({
      opportunityType: "historical_signal",
      availableQty: null,
      allocatedQty: null,
      actionCode: "upload_current_stock"
    });
  });

  it("never emits forbidden commercial fields", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 10 })
      ]
    });
    expect(containsForbiddenOpportunityFields(output)).toBe(false);
  });
});
