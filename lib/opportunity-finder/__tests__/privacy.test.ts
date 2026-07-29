import { describe, expect, it } from "vitest";
import {
  findSafeOpportunityUnitColumn,
  isForbiddenOpportunityUnitSourceHeader
} from "@/lib/opportunity-finder/aliases";
import { buildOpportunityColumnMap } from "@/lib/opportunity-finder/parser";

const SAFE_UNIT_HEADERS = [
  "Unit",
  "UOM",
  "Unit of Measure",
  "UM",
  "unit_of_measure",
  "UNIT-OF-MEASURE"
] as const;

const FORBIDDEN_UNIT_SOURCE_HEADERS = [
  "UNIT COST",
  "Unit_Cost",
  "UNIT-COST",
  "COST PER UNIT",
  "UNIT PRICE",
  "PRICE/UNIT",
  "UNIT AMOUNT",
  "UNIT VALUE",
  "UNIT CURRENCY",
  "GP RATE",
  "G.P. RATE",
  "MARGIN %",
  "UNIT PROFIT"
] as const;

describe("Opportunity Finder Unit/UOM source privacy", () => {
  it.each(SAFE_UNIT_HEADERS)("accepts the explicit safe alias %s", (header) => {
    const headers = ["MPN", "STOCK QTY", header];
    expect(findSafeOpportunityUnitColumn(headers)).toBe(2);
    expect(buildOpportunityColumnMap(headers, "stock")?.unitOfMeasure).toBe(2);
    expect(isForbiddenOpportunityUnitSourceHeader(header)).toBe(false);
  });

  it.each(FORBIDDEN_UNIT_SOURCE_HEADERS)("rejects the financial source header %s", (header) => {
    const headers = ["MPN", "STOCK QTY", header];
    expect(findSafeOpportunityUnitColumn(headers)).toBeNull();
    expect(buildOpportunityColumnMap(headers, "stock")?.unitOfMeasure).toBeNull();
    expect(isForbiddenOpportunityUnitSourceHeader(header)).toBe(true);
  });

  it("selects the explicit UOM source even when a financial column appears first", () => {
    const headers = ["MPN", "STOCK QTY", "UNIT COST", "UOM"];
    expect(buildOpportunityColumnMap(headers, "stock")?.unitOfMeasure).toBe(3);
  });

  it("does not broaden support to unverified descriptive aliases", () => {
    const headers = ["MPN", "STOCK QTY", "Measurement Unit", "Packaging Unit"];
    expect(buildOpportunityColumnMap(headers, "stock")?.unitOfMeasure).toBeNull();
  });
});
