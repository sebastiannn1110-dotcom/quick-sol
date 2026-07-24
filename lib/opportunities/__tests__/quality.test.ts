import { describe, expect, it } from "vitest";
import {
  enrichOpportunitiesWithConfidence,
  scoreOpportunityConfidence
} from "@/lib/opportunities/quality";
import type { SalesOpportunitiesResult, SalesOpportunityItem } from "@/lib/opportunities/opportunities";

function opportunity(overrides: Partial<SalesOpportunityItem> = {}): SalesOpportunityItem {
  return {
    id: "immediate_sale:ABC-001",
    opportunityType: "immediate_sale",
    mpn: "ABC-001",
    normalizedMpn: "ABC001",
    customerNeedName: "Synthetic customer",
    excessOwnerName: null,
    supplierName: "Synthetic supplier",
    manufacturerName: null,
    requiredQty: 10,
    availableQty: 10,
    excessQty: null,
    receivedQty: null,
    shortageQty: 0,
    approvedPartSignal: true,
    receivedSignal: false,
    reason: "Synthetic reason",
    recommendedAction: "Synthetic action",
    accountClients: [],
    sourceUploads: [],
    dataQualityFlags: [],
    ...overrides
  };
}

function result(items: SalesOpportunityItem[]): SalesOpportunitiesResult {
  return {
    items,
    totals: {
      totalOpportunities: items.length,
      immediateSale: items.length,
      partialSale: 0,
      excessResale: 0,
      sourcingNeeded: 0,
      stockWithoutDemand: 0,
      approvedPartMatches: items.filter((item) => item.approvedPartSignal).length,
      receivedHistoryMatches: items.filter((item) => item.receivedSignal).length
    },
    meta: {
      limit: 200,
      offset: 0,
      returnedItems: items.length,
      scannedRecords: items.length,
      scannedUploads: 0,
      totalBeforePagination: items.length
    }
  };
}

describe("opportunity confidence quality", () => {
  it("scores only operational evidence", () => {
    const item = opportunity();
    expect(scoreOpportunityConfidence(item)).toBeGreaterThanOrEqual(75);
    expect(JSON.stringify(item)).not.toMatch(/price|cost|gp_rate|commission|raw_data/i);
  });

  it("filters by confidence and marks truncated evaluation", () => {
    const high = opportunity();
    const low = opportunity({
      id: "stock_without_demand:XYZ-002",
      opportunityType: "stock_without_demand",
      customerNeedName: null,
      supplierName: null,
      requiredQty: null,
      availableQty: null,
      approvedPartSignal: false,
      dataQualityFlags: ["missing_context", "ambiguous_source", "missing_quantity"]
    });
    const base = result([high, low]);
    base.meta.totalBeforePagination = 3;
    const enriched = enrichOpportunitiesWithConfidence(base, "high");

    expect(enriched.items).toHaveLength(1);
    expect(enriched.items[0].confidenceLabel).toBe("high");
    expect(enriched.totals.highConfidence).toBe(1);
    expect(enriched.totals.lowConfidence).toBe(1);
    expect(enriched.meta.confidenceTruncated).toBe(true);
  });
});
