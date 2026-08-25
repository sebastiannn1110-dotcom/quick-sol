import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function businessRecordReadSegments(relativePath: string) {
  return source(relativePath).split('.from("business_records")').slice(1);
}

function expectSafeViewReads(relativePath: string, minimumArchivedFilters: number) {
  const text = source(relativePath);
  expect(text, relativePath).not.toContain('.from("business_records")');
  expect(text, relativePath).toMatch(/businessRecordReadContract|BUSINESS_RECORDS_(?:SAFE|COMMERCIAL)_VIEW|recordsSource/);
  expect((text.match(/\.is\("archived_at", null\)/g) ?? []).length, relativePath)
    .toBeGreaterThanOrEqual(minimumArchivedFilters);
}

function expectActiveBusinessRecordReads(relativePath: string, expectedReads: number) {
  const segments = businessRecordReadSegments(relativePath);
  expect(segments, relativePath).toHaveLength(expectedReads);
  for (const segment of segments) {
    expect(segment.slice(0, 700), relativePath).toContain('.is("archived_at", null)');
  }
}

describe("archived business record filters", () => {
  it("keeps normal records API results active-only", () => {
    expectSafeViewReads("app/api/records/route.ts", 2);
  });

  it("keeps normal search results active-only", () => {
    expectSafeViewReads("app/api/search/route.ts", 1);
  });

  it("keeps AI database tools active-only", () => {
    expectSafeViewReads("lib/ai/database-tools.ts", 6);
    expectSafeViewReads("lib/stock-needs/data-source.ts", 3);
    expectActiveBusinessRecordReads("lib/upload/structure-profile.ts", 1);
  });

  it("keeps analytics API queries active-only", () => {
    expectSafeViewReads("app/api/analytics/route.ts", 1);
    expectSafeViewReads("app/api/admin/analytics/route.ts", 1);
  });

  it("keeps admin and employee record views active-only", () => {
    expectSafeViewReads("app/api/admin/records/route.ts", 1);
    expectSafeViewReads("app/api/admin/search/route.ts", 1);
    expectSafeViewReads("lib/stock-needs/data-source.ts", 3);
    expect(source("app/api/admin/opportunities/route.ts")).toContain("loadSalesOpportunities");
    const opportunityService = source("lib/opportunities/service.ts");
    expect(opportunityService).toContain('rpc("get_sales_opportunities_page_v1"');
    expect(opportunityService).toContain("requireBusinessSummaryReady");
    expect(opportunityService).not.toContain("loadStockNeedsInput");
    expect(opportunityService).not.toContain('.from("business_records")');
    expect(businessRecordReadSegments("app/api/admin/opportunities/route.ts")).toHaveLength(0);
    expectSafeViewReads("app/api/employees/route.ts", 1);
  });

  it("keeps executive and MPN record lookups active-only", () => {
    expectSafeViewReads("app/api/executive-search/route.ts", 1);
    expectSafeViewReads("app/api/executive-search/suggest/route.ts", 1);
    expectSafeViewReads("lib/mpn/lookup.ts", 3);
  });

  it("keeps import diagnostics active-only for record counts", () => {
    expectSafeViewReads("lib/upload/job-diagnostics.ts", 2);
  });

  it("uses bounded superadmin counters without exact archived-record scans", () => {
    const metricsSource = source("lib/superadmin/metrics.ts");
    const segments = businessRecordReadSegments("lib/superadmin/metrics.ts");
    expect(segments).toHaveLength(1);
    expect(segments[0].slice(0, 300)).toContain('count: "planned"');
    expect(metricsSource).toContain('.rpc("get_business_record_counter_v1")');
    expect(metricsSource).not.toContain('count: "exact", head: true }).not("archived_at"');
  });

  it("keeps duplicate cleanup as soft-archive, not physical delete", () => {
    const cleanupSource = source("scripts/import-duplicate-cleanup.ts");
    expect(cleanupSource).toContain("set archived_at = now()");
    expect(cleanupSource).not.toContain("delete from public.business_records");
  });
});
