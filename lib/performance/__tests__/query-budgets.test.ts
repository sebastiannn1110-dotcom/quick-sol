import { describe, expect, it } from "vitest";
import { latencyPercentiles, QUERY_BUDGETS, safePerformanceMetric } from "@/lib/performance/query-budgets";

describe("performance observability contracts", () => {
  it("keeps critical route query budgets bounded", () => {
    expect(QUERY_BUDGETS.recordsPage).toBeLessThanOrEqual(3);
    expect(QUERY_BUDGETS.executiveMpn).toBeLessThanOrEqual(2);
    expect(QUERY_BUDGETS.opportunityFinderStatus).toBeLessThanOrEqual(2);
    expect(QUERY_BUDGETS.opportunityFinderSupplemental).toBeLessThanOrEqual(2);
    expect(QUERY_BUDGETS.dashboardAssistant).toBeLessThanOrEqual(2);
  });

  it("records only safe aggregate dimensions and computes percentiles", () => {
    expect(safePerformanceMetric({ route: "/api/records?q=SECRET", dbTimeMs: 1.2, queryCount: 2, rows: 25, bytes: 500, backendCpuMs: null, serializationMs: 2.8, cache: "miss" })).toEqual({
      route: "/api/records", dbTimeMs: 1, queryCount: 2, rows: 25, bytes: 500,
      backendCpuMs: null, serializationMs: 3, cache: "miss"
    });
    expect(latencyPercentiles([1, 2, 3, 4, 5, 100])).toEqual({ p50: 3, p95: 100, p99: 100 });
  });
});
