import { describe, expect, it } from "vitest";
import {
  analyticsTeamEmployeeIds,
  buildEmployeeAnalytics
} from "@/lib/employee-analytics/aggregate";
import type {
  AnalyticsEmployee,
  AnalyticsQuote,
  AnalyticsQuoteEvent
} from "@/lib/employee-analytics/contracts";

const employees: AnalyticsEmployee[] = [
  { employeeId: "a", managerId: null, name: "Maya Torres", businessTitle: "Sales Representative", businessRank: "individual_contributor", department: "Sales", country: "Colombia", region: "Americas", avatarPath: null },
  { employeeId: "b", managerId: null, name: "Jordan Lee", businessTitle: "Sales Representative", businessRank: "individual_contributor", department: "Sales", country: "United States", region: "Americas", avatarPath: null }
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

const filteredEmployees: AnalyticsEmployee[] = [
  { employeeId: "root", managerId: null, name: "Demo Owner", businessTitle: "CEO", businessRank: "owner", department: "Executive", country: "Singapore", region: "Global", avatarPath: null },
  { employeeId: "americas", managerId: "root", name: "Daniel Brooks", businessTitle: "Sales Manager Americas", businessRank: "manager", department: "Sales", country: "United States", region: "Americas", avatarPath: null },
  { employeeId: "maya", managerId: "americas", name: "Maya Torres", businessTitle: "Sales Representative", businessRank: "salesperson", department: "Sales", country: "Colombia", region: "Americas", avatarPath: null },
  { employeeId: "jordan", managerId: "americas", name: "Jordan Lee", businessTitle: "Sales Representative", businessRank: "salesperson", department: "Sales", country: "United States", region: "Americas", avatarPath: null },
  { employeeId: "europe", managerId: "root", name: "Erik Vogel", businessTitle: "Sales Manager Europe", businessRank: "manager", department: "Sales", country: "Germany", region: "Europe", avatarPath: null },
  { employeeId: "greta", managerId: "europe", name: "Greta Fischer", businessTitle: "Account Executive", businessRank: "salesperson", department: "Sales", country: "Germany", region: "Europe", avatarPath: null },
  { employeeId: "lin", managerId: "root", name: "Lin Wei", businessTitle: "Sourcing Manager", businessRank: "sourcing_manager", department: "Sourcing", country: "Singapore", region: "APAC", avatarPath: null }
];

const filteredQuotes: AnalyticsQuote[] = [
  { id: "q1", sellerId: "maya", clientId: "c1", status: "accepted", total: 12_000, createdAt: "2026-08-01T00:00:00Z", sentAt: "2026-08-02T00:00:00Z" },
  { id: "q2", sellerId: "maya", clientId: "c2", status: "sent", total: 7_500, createdAt: "2026-08-03T00:00:00Z", sentAt: "2026-08-04T00:00:00Z" },
  { id: "q3", sellerId: "jordan", clientId: "c1", status: "rejected", total: 5_000, createdAt: "2026-08-05T00:00:00Z", sentAt: "2026-08-06T00:00:00Z" },
  { id: "q4", sellerId: "greta", clientId: "c3", status: "accepted", total: 30_000, createdAt: "2026-08-07T00:00:00Z", sentAt: "2026-08-08T00:00:00Z" },
  { id: "q5", sellerId: "greta", clientId: "c4", status: "expired", total: 4_000, createdAt: "2026-08-09T00:00:00Z", sentAt: "2026-08-10T00:00:00Z" },
  { id: "q6", sellerId: "greta", clientId: "c3", status: "draft", total: 2_000, createdAt: "2026-08-11T00:00:00Z", sentAt: null },
  { id: "q-no-line", sellerId: "greta", clientId: "c5", status: "accepted", total: 99_000, createdAt: "2026-08-12T00:00:00Z", sentAt: "2026-08-13T00:00:00Z" }
];

const filteredEvents: AnalyticsQuoteEvent[] = [
  { quoteId: "q1", eventType: "sent" },
  { quoteId: "q1", eventType: "accepted" },
  { quoteId: "q1", eventType: "accepted" },
  { quoteId: "q2", eventType: "sent" },
  { quoteId: "q3", eventType: "sent" },
  { quoteId: "q3", eventType: "rejected" },
  { quoteId: "q4", eventType: "sent" },
  { quoteId: "q4", eventType: "accepted" },
  { quoteId: "q5", eventType: "sent" },
  { quoteId: "q5", eventType: "expired" }
];

function buildFilteredAnalytics(filters = {}) {
  return buildEmployeeAnalytics({
    scope: "global",
    employees: filteredEmployees,
    quotes: filteredQuotes,
    items: filteredQuotes.slice(0, 6).map((quote) => ({ quoteId: quote.id })),
    events: filteredEvents,
    filters
  });
}

describe("employee analytics combined filters", () => {
  it("derives non-trivial global metrics and ranks only employees with quote activity", () => {
    const result = buildFilteredAnalytics();

    expect(result.totals).toMatchObject({
      quotesCreated: 6,
      quotesSent: 5,
      quotesAccepted: 2,
      quotesRejected: 1,
      quoteConversionRate: 40,
      quotedValue: 60_500,
      acceptedQuoteValue: 42_000,
      customersServed: 4,
      newCustomers: 4
    });
    expect(result.ranking.map((metric) => metric.employeeId)).toEqual([
      "greta",
      "maya",
      "jordan"
    ]);
    expect(result.ranking.some((metric) => metric.employeeId === "lin")).toBe(false);
  });

  it("combines organization, recursive team, seller, and current-status filters", () => {
    const result = buildFilteredAnalytics({
      country: "Germany",
      region: "Europe",
      department: "Sales",
      businessRank: "salesperson",
      teamManagerId: "europe",
      sellerId: "greta",
      quoteStatus: "accepted"
    });

    expect(result.metrics.map((metric) => metric.employeeId)).toEqual(["greta"]);
    expect(result.totals).toMatchObject({
      quotesCreated: 1,
      quotesSent: 1,
      quotesAccepted: 1,
      quotesRejected: 0,
      quoteConversionRate: 100,
      quotedValue: 30_000,
      acceptedQuoteValue: 30_000,
      customersServed: 1,
      newCustomers: 1
    });
    expect(result.filters).toMatchObject({ quoteStatus: "accepted", teamManagerId: "europe" });
  });

  it("does not turn a later status-filtered quote into a new customer", () => {
    const result = buildFilteredAnalytics({ sellerId: "greta", quoteStatus: "draft" });

    expect(result.totals.quotesCreated).toBe(1);
    expect(result.totals.customersServed).toBe(1);
    expect(result.totals.newCustomers).toBe(0);
  });

  it("builds recursive teams and unfiltered dynamic options from the authorized scope", () => {
    const result = buildFilteredAnalytics({ region: "Europe" });

    expect([...analyticsTeamEmployeeIds(filteredEmployees, "root")]).toEqual([
      "root", "americas", "europe", "lin", "maya", "jordan", "greta"
    ]);
    expect(result.filterOptions.countries).toEqual([
      "Colombia", "Germany", "Singapore", "United States"
    ]);
    expect(result.filterOptions.departments).toEqual(["Executive", "Sales", "Sourcing"]);
    expect(result.filterOptions.teams.map((team) => team.managerId)).toEqual([
      "americas", "root", "europe"
    ]);
    expect(result.filterOptions.sellers.map((seller) => seller.employeeId)).toEqual([
      "greta", "jordan", "maya"
    ]);
    expect(result.metrics.map((metric) => metric.employeeId)).toEqual(["europe", "greta"]);
  });
});
