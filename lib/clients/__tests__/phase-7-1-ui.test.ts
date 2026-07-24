import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Phase 7.1 shared client and opportunity UI", () => {
  it("exposes normal authenticated routes and keeps admin writes separate", () => {
    expect(source("app/clients/page.tsx")).toContain("EmployeeGuard");
    expect(source("app/clients/[clientId]/page.tsx")).toContain("EmployeeGuard");
    expect(source("app/opportunities/page.tsx")).toContain("EmployeeGuard");
    expect(source("app/admin/clients/new/page.tsx")).toContain("AdminManagerGuard");
    expect(source("app/admin/clients/[clientId]/edit/page.tsx")).toContain("AdminManagerGuard");
  });

  it("reuses the same opportunities component globally, in admin and by client", () => {
    expect(source("app/opportunities/page.tsx")).toContain("OpportunitiesDashboard");
    expect(source("app/admin/opportunities/page.tsx")).toContain("OpportunitiesDashboard");
    expect(source("components/clients/ClientOpportunities.tsx")).toContain("OpportunitiesDashboard");
    expect(source("components/clients/ClientsDirectory.tsx")).toContain("/api/opportunities?limit=200");
    expect(source("components/clients/ClientsDirectory.tsx")).toContain("/opportunities");
    expect(source("components/opportunities/OpportunitiesDashboard.tsx")).toContain("metrics.highConfidence");
    expect(source("components/opportunities/OpportunitiesDashboard.tsx")).toContain("confidenceTruncated");
    expect(source("components/opportunities/OpportunitiesDashboard.tsx")).toContain('params.set("confidence"');
    expect(source("components/clients/ClientCard.tsx")).toContain("highConfidenceCount");
  });

  it("has a mobile card view and avoids a global horizontal table overflow", () => {
    expect(source("components/opportunities/OpportunityTable.tsx")).toContain("lg:hidden");
    expect(source("components/opportunities/OpportunityTable.tsx")).toContain("hidden overflow-x-auto lg:block");
    expect(source("components/clients/ClientGrid.tsx")).toContain("sm:grid-cols-2");
    expect(source("components/clients/ClientCard.tsx")).toContain("object-contain");
  });

  it("translates client and opportunity navigation in ES, EN and ZH", () => {
    expect(translate("nav.clients", "es")).toBe("Clientes");
    expect(translate("nav.clients", "en")).toBe("Clients");
    expect(translate("nav.clients", "zh")).toBe("客户");
    expect(translate("nav.opportunities", "es")).toBe("Oportunidades");
    expect(translate("nav.opportunities", "en")).toBe("Opportunities");
    expect(translate("nav.opportunities", "zh")).toBe("销售机会");
  });
});
