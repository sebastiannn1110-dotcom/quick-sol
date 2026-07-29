import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
function source(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("Opportunity Finder access and isolation integration", () => {
  it("protects the route for authenticated employee, manager and admin users", () => {
    expect(source("proxy.ts")).toContain('"/opportunity-finder"');
    expect(source("app/opportunity-finder/page.tsx")).toContain("EmployeeGuard");
    expect(source("components/EmployeeGuard.tsx")).toContain('["admin", "manager", "employee"]');
  });

  it("makes the two-file finder the single seller navigation entry", () => {
    const sidebar = source("components/Sidebar.tsx");
    expect(sidebar).toContain('href: "/opportunity-finder"');
    expect(sidebar).not.toContain('href: "/mpn-comparator"');
    expect(sidebar).not.toContain('href: "/opportunities"');
  });

  it("keeps every job read scoped to the authenticated owner", () => {
    const api = source("lib/opportunity-finder/api.ts");
    expect(api).toContain('.eq("created_by", userId)');
    const migration = source("supabase/migrations/20260727090000_opportunity_finder.sql");
    expect(migration).toContain("created_by = auth.uid()");
    expect(migration).toContain("Canonical rows intentionally have no authenticated-user policy");
  });

  it("never stages rows in business_records or selects forbidden commercial fields", () => {
    const worker = source("lib/opportunity-finder/worker.ts");
    expect(worker).not.toContain('from("business_records")');
    const resultSelect = source("lib/opportunity-finder/api.ts").split("export const OPPORTUNITY_RESULT_SELECT")[1];
    expect(resultSelect).not.toMatch(/"price"|"cost"|"gp"|"gp_rate"|"commission"|"raw_data"/);
  });

  it("uses a dedicated worker without modifying duplicate cleanup", () => {
    expect(source("package.json")).toContain('"worker:opportunity-finder"');
    expect(source("scripts/opportunity-finder-worker.ts")).toContain("claimNextOpportunityFinderJob");
  });

  it("runs the Opportunity Finder worker with the production web process", () => {
    expect(source("package.json")).toContain('"start": "node scripts/start-production.mjs"');
    const productionStart = source("scripts/start-production.mjs");
    expect(productionStart).toContain('nextCli, "start"');
    expect(productionStart).toContain('"scripts/opportunity-finder-worker.ts"');
    expect(productionStart).toContain("SIGTERM");
  });

  it("requires exactly two files and queues background work instead of parsing in HTTP", () => {
    const createRoute = source("app/api/opportunity-finder/jobs/route.ts");
    const profileRoute = source("app/api/opportunity-finder/jobs/[id]/profile/route.ts");
    expect(createRoute).toContain("z.array(fileSchema).length(2)");
    expect(createRoute).toContain("createSignedUploadUrl");
    expect(createRoute).not.toContain("parseOpportunityWorkbook");
    expect(profileRoute).toContain('status: "queued"');
  });

  it("persists cancellation, safe retry and owner-scoped idempotency", () => {
    const cancelRoute = source("app/api/opportunity-finder/jobs/[id]/cancel/route.ts");
    const retryRoute = source("app/api/opportunity-finder/jobs/[id]/retry/route.ts");
    const worker = source("lib/opportunity-finder/worker.ts");
    const migration = source("supabase/migrations/20260727090000_opportunity_finder.sql");
    expect(cancelRoute).toContain("cancel_requested: true");
    expect(retryRoute).toContain('status: "queued"');
    expect(worker).toContain('from("opportunity_finder_results").delete()');
    expect(migration).toContain("opportunity_finder_jobs_owner_idempotency_uidx");
  });

  it("keeps legacy seller routes available during the transition", () => {
    expect(fs.existsSync(path.join(root, "app/mpn-comparator/page.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(root, "app/opportunities/page.tsx"))).toBe(true);
  });

  it("uses mobile cards, stacked controls and touch-sized actions without a wide table", () => {
    const finder = source("components/opportunity-finder/OpportunityFinder.tsx");
    const card = source("components/opportunity-finder/OpportunityCard.tsx");
    expect(finder).toContain("overflow-x-hidden");
    expect(finder).toContain("md:grid-cols-2");
    expect(finder).toContain("min-h-11");
    expect(card).toContain("grid-cols-2");
    expect(`${finder}${card}`).not.toContain("<table");
    const responsiveVerifier = source("scripts/verify-opportunity-responsive.mjs");
    for (const width of [360, 390, 430, 768, 1024, 1366, 1440, 1920]) {
      expect(responsiveVerifier).toContain(`width: ${width}`);
    }
  });

  it("ships ES, EN and simplified Chinese module copy", () => {
    const i18n = source("lib/opportunity-finder/i18n.ts");
    expect(i18n).toContain('title: "Buscador de oportunidades"');
    expect(i18n).toContain('title: "Opportunity Finder"');
    expect(i18n).toContain('title: "销售机会查找器"');
    expect(i18n).not.toContain("High Confidence");
  });
});
