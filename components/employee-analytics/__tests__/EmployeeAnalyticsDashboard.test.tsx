// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import EmployeeAnalyticsDashboard, {
  buildEmployeeAnalyticsEndpoint,
  reconcileEmployeeComparison
} from "@/components/employee-analytics/EmployeeAnalyticsDashboard";
import type {
  EmployeeAnalyticsPayload,
  EmployeeQuoteMetrics
} from "@/lib/employee-analytics/contracts";

const maya: EmployeeQuoteMetrics = {
  employeeId: "00000000-0000-4000-8000-000000000001",
  managerId: null,
  name: "Maya Torres",
  businessTitle: "Sales Representative",
  businessRank: "salesperson",
  department: "Sales",
  country: "Colombia",
  region: "Americas",
  avatarPath: null,
  quotesCreated: 3,
  quotesSent: 3,
  quotesAccepted: 1,
  quotesRejected: 1,
  quoteConversionRate: 33.33,
  quotedValue: 20_000,
  acceptedQuoteValue: 12_000,
  customersServed: 2,
  newCustomers: 2
};

const greta: EmployeeQuoteMetrics = {
  ...maya,
  employeeId: "00000000-0000-4000-8000-000000000002",
  name: "Greta Fischer",
  businessTitle: "Account Executive",
  country: "Germany",
  region: "Europe",
  quotesAccepted: 2,
  quoteConversionRate: 66.67,
  quotedValue: 40_500,
  acceptedQuoteValue: 30_000,
  customersServed: 2,
  newCustomers: 2
};

function payload(metrics: EmployeeQuoteMetrics[], country?: string): EmployeeAnalyticsPayload {
  const totals = metrics.reduce((sum, metric) => ({
    quotesCreated: sum.quotesCreated + metric.quotesCreated,
    quotesSent: sum.quotesSent + metric.quotesSent,
    quotesAccepted: sum.quotesAccepted + metric.quotesAccepted,
    quotesRejected: sum.quotesRejected + metric.quotesRejected,
    quoteConversionRate: 0,
    quotedValue: sum.quotedValue + metric.quotedValue,
    acceptedQuoteValue: sum.acceptedQuoteValue + metric.acceptedQuoteValue,
    customersServed: sum.customersServed + metric.customersServed,
    newCustomers: sum.newCustomers + metric.newCustomers
  }), {
    quotesCreated: 0,
    quotesSent: 0,
    quotesAccepted: 0,
    quotesRejected: 0,
    quoteConversionRate: 0,
    quotedValue: 0,
    acceptedQuoteValue: 0,
    customersServed: 0,
    newCustomers: 0
  });
  totals.quoteConversionRate = totals.quotesSent
    ? Number(((totals.quotesAccepted / totals.quotesSent) * 100).toFixed(2))
    : 0;

  return {
    scope: "global",
    currency: "USD",
    generatedAt: "2026-08-29T00:00:00.000Z",
    filters: country ? { country } : {},
    filterOptions: {
      countries: ["Colombia", "Germany"],
      regions: ["Americas", "Europe"],
      departments: ["Sales"],
      businessRanks: ["salesperson"],
      teams: [],
      sellers: [maya, greta].map((metric) => ({
        employeeId: metric.employeeId,
        name: metric.name,
        businessTitle: metric.businessTitle
      })),
      quoteStatuses: ["draft", "sent", "accepted", "rejected", "expired"]
    },
    metrics,
    ranking: [...metrics].sort((a, b) => b.acceptedQuoteValue - a.acceptedQuoteValue),
    regions: [],
    totals,
    definitions: {
      ranking: "Accepted Quote Value",
      newCustomers: "First authorized valid quote."
    }
  };
}

function jsonResponse(value: unknown, ok = true) {
  return {
    ok,
    json: vi.fn(async () => value)
  } as unknown as Response;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("quiksol-language", "en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("EmployeeAnalyticsDashboard filters", () => {
  it("builds one deterministic, encoded query and reconciles removed comparison IDs", () => {
    expect(buildEmployeeAnalyticsEndpoint({
      country: "United States",
      region: "Americas",
      department: "Sales & Success",
      businessRank: "salesperson",
      teamManagerId: "00000000-0000-4000-8000-000000000010",
      sellerId: maya.employeeId,
      quoteStatus: "accepted"
    })).toBe(
      "/api/employee-analytics?country=United+States&region=Americas"
      + "&department=Sales+%26+Success&businessRank=salesperson"
      + "&teamManagerId=00000000-0000-4000-8000-000000000010"
      + `&sellerId=${maya.employeeId}&quoteStatus=accepted`
    );
    expect(reconcileEmployeeComparison([greta], {
      firstId: maya.employeeId,
      secondId: "missing"
    })).toEqual({ firstId: greta.employeeId, secondId: greta.employeeId });
  });

  it("refreshes metrics for a filter and clear action while keeping comparison valid", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({
        analytics: url.includes("country=Germany")
          ? payload([greta], "Germany")
          : payload([maya, greta])
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LanguageProvider>
        <EmployeeAnalyticsDashboard />
      </LanguageProvider>
    );

    expect(await screen.findByText("Employee ranking")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "Germany" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "/api/employee-analytics?country=Germany"
    );
    await waitFor(() => {
      expect((screen.getByLabelText("Employee A") as HTMLSelectElement).value).toBe(
        greta.employeeId
      );
      expect((screen.getByLabelText("Employee B") as HTMLSelectElement).value).toBe(
        greta.employeeId
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("/api/employee-analytics");
  });

  it("never keeps metrics from the previous filters when the new request fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ analytics: payload([maya, greta]) }))
      .mockResolvedValueOnce(jsonResponse({ error: "failed" }, false));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LanguageProvider>
        <EmployeeAnalyticsDashboard />
      </LanguageProvider>
    );

    expect((await screen.findAllByText("$42,000.00")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "Germany" } });

    expect(screen.queryByText("$42,000.00")).toBeNull();
    expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe("Germany");
    expect(await screen.findByText("Employee Analytics could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("$42,000.00")).toBeNull();
  });

  it("discards a response for an endpoint superseded by a newer filter combination", async () => {
    const staleMetric: EmployeeQuoteMetrics = {
      ...greta,
      name: "Stale Seller",
      quotedValue: 77_777,
      acceptedQuoteValue: 77_777
    };
    let resolveGermany: ((response: Response) => void) | undefined;
    let resolveCombined: ((response: Response) => void) | undefined;
    const germanyRequest = new Promise<Response>((resolve) => {
      resolveGermany = resolve;
    });
    const combinedRequest = new Promise<Response>((resolve) => {
      resolveCombined = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("region=Europe")) return combinedRequest;
      if (url.includes("country=Germany")) return germanyRequest;
      return Promise.resolve(jsonResponse({ analytics: payload([maya, greta]) }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LanguageProvider>
        <EmployeeAnalyticsDashboard />
      </LanguageProvider>
    );
    expect((await screen.findAllByText("$42,000.00")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "Germany" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "Europe" } });
    expect(screen.queryByText("$42,000.00")).toBeNull();

    await act(async () => {
      resolveGermany?.(jsonResponse({ analytics: payload([staleMetric], "Germany") }));
      await germanyRequest;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "country=Germany&region=Europe"
    );
    expect(screen.queryByText("Stale Seller")).toBeNull();
    expect(screen.queryByText("$77,777.00")).toBeNull();

    await act(async () => {
      resolveCombined?.(jsonResponse({ analytics: payload([greta], "Germany") }));
      await combinedRequest;
    });
    await waitFor(() => expect(screen.getAllByText("$30,000.00").length).toBeGreaterThan(0));
    expect(screen.queryByText("Stale Seller")).toBeNull();
  });
});
