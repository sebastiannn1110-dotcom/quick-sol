import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const getAuthContext = vi.fn();
const loadEmployeeAnalytics = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue({ profile: { id: "actor" } });
  loadEmployeeAnalytics.mockResolvedValue({ scope: "global", currency: "USD" });
  vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  vi.doMock("@/lib/employee-analytics/service", () => ({ loadEmployeeAnalytics }));
});

describe("GET /api/employee-analytics", () => {
  it("passes every validated filter to the scoped analytics service", async () => {
    const { GET } = await import("../route");
    const request = new Request(
      "https://app.test/api/employee-analytics"
      + "?country=Germany&region=Europe&department=Sales&businessRank=salesperson"
      + "&teamManagerId=00000000-0000-4000-8000-000000000001"
      + "&sellerId=00000000-0000-4000-8000-000000000002&quoteStatus=accepted"
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(loadEmployeeAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ profile: { id: "actor" } }),
      {
        country: "Germany",
        region: "Europe",
        department: "Sales",
        businessRank: "salesperson",
        teamManagerId: "00000000-0000-4000-8000-000000000001",
        sellerId: "00000000-0000-4000-8000-000000000002",
        quoteStatus: "accepted"
      }
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    "?quoteStatus=won",
    "?businessRank=super_admin_dev",
    "?sellerId=not-a-uuid",
    "?country=Germany&country=France",
    "?unexpected=value"
  ])("rejects an invalid or ambiguous filter query: %s", async (query) => {
    const { GET } = await import("../route");
    const response = await GET(new Request(`https://app.test/api/employee-analytics${query}`));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid employee analytics filters.",
      code: "EMPLOYEE_ANALYTICS_FILTERS_INVALID"
    });
    expect(loadEmployeeAnalytics).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("short-circuits before validation and data access when authentication fails", async () => {
    getAuthContext.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://app.test/api/employee-analytics?unexpected=value")
    );

    expect(response.status).toBe(401);
    expect(loadEmployeeAnalytics).not.toHaveBeenCalled();
  });

  it("returns a no-store 500 when the scoped analytics dependency fails", async () => {
    loadEmployeeAnalytics.mockRejectedValueOnce(new Error("dependency failed"));
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/employee-analytics"));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
