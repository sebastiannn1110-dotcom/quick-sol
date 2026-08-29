import { describe, expect, it } from "vitest";
import { buildEmployeeAnalytics } from "@/lib/employee-analytics/aggregate";

const employees = [
  { employeeId: "a", name: "Maya Torres", businessTitle: "Sales Representative", businessRank: "individual_contributor", region: "Americas", avatarPath: null },
  { employeeId: "b", name: "Jordan Lee", businessTitle: "Sales Representative", businessRank: "individual_contributor", region: "Americas", avatarPath: null }
];

const quotes = [
  { id: "q1", sellerId: "a", clientId: "c1", status: "accepted" as const, total: 100, createdAt: "2026-08-01T00:00:00Z", sentAt: "2026-08-02T00:00:00Z" },
  { id: "q2", sellerId: "a", clientId: "c2", status: "sent" as const, total: 50, createdAt: "2026-08-03T00:00:00Z", sentAt: "2026-08-04T00:00:00Z" },
  { id: "q3", sellerId: "b", clientId: "c1", status: "rejected" as const, total: 200, createdAt: "2026-08-05T00:00:00Z", sentAt: "2026-08-06T00:00:00Z" },
  { id: "q4", sellerId: "b", clientId: "c3", status: "draft" as const, total: 999, createdAt: "2026-08-07T00:00:00Z", sentAt: null }
];

describe("employee quote analytics", () => {
  it("derives the exact demo metrics from quotes, line presence, and events", () => {
    const result = buildEmployeeAnalytics({
      scope: "global",
      employees,
      quotes,
      items: [{ quoteId: "q1" }, { quoteId: "q2" }, { quoteId: "q3" }],
      events: [
        { quoteId: "q1", eventType: "sent" },
        { quoteId: "q1", eventType: "accepted" },
        { quoteId: "q2", eventType: "sent" },
        { quoteId: "q3", eventType: "sent" },
        { quoteId: "q3", eventType: "rejected" }
      ]
    });

    expect(result.metrics[0]).toMatchObject({
      employeeId: "a",
      quotesCreated: 2,
      quotesSent: 2,
      quotesAccepted: 1,
      quotesRejected: 0,
      quoteConversionRate: 50,
      quotedValue: 150,
      acceptedQuoteValue: 100,
      customersServed: 2,
      newCustomers: 2
    });
    expect(result.metrics[1]).toMatchObject({
      employeeId: "b",
      quotesCreated: 1,
      quotesSent: 1,
      quotesAccepted: 0,
      quotesRejected: 1,
      quotedValue: 200,
      acceptedQuoteValue: 0,
      customersServed: 1,
      newCustomers: 0
    });
    expect(result.ranking.map((metric) => metric.employeeId)).toEqual(["a", "b"]);
    expect(result.definitions.ranking).toBe("Accepted Quote Value");
    expect(result.totals).toMatchObject({
      quotesCreated: 3,
      quotesSent: 3,
      quotesAccepted: 1,
      quotesRejected: 1,
      quoteConversionRate: 33.33,
      quotedValue: 350,
      acceptedQuoteValue: 100
    });
    expect(result.regions[0]).toMatchObject({
      region: "Americas",
      employeeCount: 2,
      quotesCreated: 3,
      acceptedQuoteValue: 100
    });
  });

  it("does not count a quote without a persisted line item", () => {
    const result = buildEmployeeAnalytics({
      scope: "self",
      employees: [employees[1]],
      quotes: [quotes[3]],
      items: [],
      events: []
    });
    expect(result.totals.quotesCreated).toBe(0);
    expect(result.totals.quotedValue).toBe(0);
  });
});
