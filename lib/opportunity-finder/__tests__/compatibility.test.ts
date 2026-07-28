import { describe, expect, it } from "vitest";
import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";

describe("opportunity finder compatibility matrix", () => {
  it.each([
    ["demand", "stock", "demand_stock"],
    ["excess", "demand", "demand_excess"],
    ["demand", "supplier_offer", "demand_supplier_offer"],
    ["received_history", "demand", "demand_received_history"],
    ["demand", "sales_history", "demand_sales_history"]
  ] as const)("allows %s + %s", (left, right, kind) => {
    expect(evaluateOpportunityCompatibility(left, right)).toMatchObject({
      compatible: true,
      comparisonKind: kind
    });
  });

  it.each([
    ["stock", "excess", "requires_demand"],
    ["stock", "supplier_offer", "requires_demand"],
    ["received_history", "sales_history", "two_history_files"],
    ["demand", "demand", "two_demand_files"],
    ["ignore", "stock", "ignored_file"]
  ] as const)("rejects %s + %s", (left, right, reasonCode) => {
    expect(evaluateOpportunityCompatibility(left, right)).toMatchObject({
      compatible: false,
      reasonCode
    });
  });
});
