import { describe, expect, it } from "vitest";
import { buildSupplierRanking, summarizeMpnOffers } from "@/lib/mpn/recommendation";

describe("MPN recommendation", () => {
  const offers = [
    { id: "1", mpn: "SN74LVC2G74", supplier_name: "Supplier A", price: 1.1, on_hand: 100, lead_time_weeks: 4, gp_rate: 0.25, has_errors: false },
    { id: "2", mpn: "SN74LVC2G74", supplier_name: "Supplier B", price: 1.25, on_hand: 500, lead_time_weeks: 1, gp_rate: 0.22, has_errors: false },
    { id: "3", mpn: "SN74LVC2G74", supplier_name: "Supplier C", price: 2.2, on_hand: 20, lead_time_weeks: 6, gp_rate: 0.4, has_errors: true }
  ];

  it("summarizes best price, fastest lead time and highest quantity", () => {
    const summary = summarizeMpnOffers(offers);

    expect(summary.totalOffers).toBe(3);
    expect(summary.bestPrice).toBe(1.1);
    expect(summary.fastestLeadTime).toBe(1);
    expect(summary.highestQuantity).toBe(500);
    expect(summary.recommendedSupplier).toBeTruthy();
  });

  it("builds supplier ranking", () => {
    const ranking = buildSupplierRanking(offers);

    expect(ranking).toHaveLength(3);
    expect(ranking[0].score).toBeGreaterThan(ranking[2].score);
  });
});
