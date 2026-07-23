import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function businessRecordReadSegments(relativePath: string) {
  return source(relativePath).split('.from("business_records")').slice(1);
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
    expectActiveBusinessRecordReads("app/api/records/route.ts", 1);
  });

  it("keeps normal search results active-only", () => {
    expectActiveBusinessRecordReads("app/api/search/route.ts", 1);
  });

  it("keeps AI database tools active-only", () => {
    expectActiveBusinessRecordReads("lib/ai/database-tools.ts", 7);
    expectActiveBusinessRecordReads("lib/stock-needs/data-source.ts", 1);
    expectActiveBusinessRecordReads("lib/upload/structure-profile.ts", 1);
  });

  it("keeps analytics API queries active-only", () => {
    expectActiveBusinessRecordReads("app/api/analytics/route.ts", 1);
    expectActiveBusinessRecordReads("app/api/admin/analytics/route.ts", 1);
  });

  it("keeps admin and employee record views active-only", () => {
    expectActiveBusinessRecordReads("app/api/admin/records/route.ts", 1);
    expectActiveBusinessRecordReads("app/api/admin/search/route.ts", 1);
    expectActiveBusinessRecordReads("lib/stock-needs/data-source.ts", 1);
    expectActiveBusinessRecordReads("app/api/employees/route.ts", 1);
  });

  it("keeps executive and MPN record lookups active-only", () => {
    expectActiveBusinessRecordReads("app/api/executive-search/route.ts", 1);
    expectActiveBusinessRecordReads("app/api/executive-search/suggest/route.ts", 1);
    expectActiveBusinessRecordReads("lib/mpn/lookup.ts", 2);
  });

  it("keeps import diagnostics active-only for record counts", () => {
    expectActiveBusinessRecordReads("lib/upload/job-diagnostics.ts", 2);
  });

  it("shows superadmin active and archived counts separately", () => {
    const segments = businessRecordReadSegments("lib/superadmin/metrics.ts");
    expect(segments).toHaveLength(2);
    expect(segments[0].slice(0, 300)).toContain('.is("archived_at", null)');
    expect(segments[1].slice(0, 300)).toContain('.not("archived_at", "is", null)');
  });

  it("keeps duplicate cleanup as soft-archive, not physical delete", () => {
    const cleanupSource = source("scripts/import-duplicate-cleanup.ts");
    expect(cleanupSource).toContain("set archived_at = now()");
    expect(cleanupSource).not.toContain("delete from public.business_records");
  });
});
