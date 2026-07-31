import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("presentation cleanup", () => {
  it("uses the shared safe client image with no high-confidence UI", () => {
    const directory = source("components/clients/ClientsDirectory.tsx");
    const card = source("components/clients/ClientCard.tsx");
    const detail = source("app/clients/[clientId]/page.tsx");

    expect(card).toContain("<ClientImage");
    expect(detail).toContain("<ClientImage");
    expect(card).toContain("authorizedIdentificationImageUrl");
    expect(detail).toContain("authorizedIdentificationImageUrl");
    expect(directory).not.toContain("clients.description");
    expect(directory).not.toContain("metrics.highConfidence");
    expect(card).not.toContain("clients.highConfidence");
    expect(detail).not.toContain("metrics.highConfidence");
  });

  it("does not expose a settings link in the responsive sidebar", () => {
    const sidebar = source("components/Sidebar.tsx");
    expect(sidebar).not.toContain('href: "/settings"');
    expect(sidebar).not.toContain("nav.settings");
    expect(sidebar).not.toContain("Settings,");
  });

  it("removes only the requested chat and employee messages and nested employee scroll", () => {
    const chat = source("components/chat/ChatLayout.tsx");
    const employees = source("app/employees/page.tsx");

    expect(chat).not.toContain("Conversaciones privadas y grupos protegidos");
    expect(chat).toContain("<ConversationList");
    expect(chat).toContain("<ChatWindow");
    expect(employees).not.toContain("La actividad operativa de otros empleados");
    expect(employees).not.toContain("max-h-[calc(100vh-250px)]");
    expect(employees).not.toContain("overflow-auto");
    expect(employees).toContain("filtered.map");
    expect(employees).toContain("startChat");
  });

  it("keeps only the presentation-ready admin modules and skips analytics loading", () => {
    const admin = source("app/admin/page.tsx");
    const hiddenPaths = [
      "/admin/analytics",
      "/admin/traffic",
      "/admin/import-errors",
      "/admin/logs",
      "/admin/performance",
      "/admin/audit-logs",
      "/admin/security",
      "/admin/email-alerts",
      "/categories"
    ];

    for (const hiddenPath of hiddenPaths) expect(admin).not.toContain(hiddenPath);
    expect(admin).not.toContain("/api/admin/analytics");
    expect(admin).not.toContain("AnalyticsCards");
    expect(admin).toContain("/admin/clients");
    expect(admin).toContain("/admin/users");
    expect(admin).toContain("/admin/uploads");
    expect(admin).toContain("/admin/email-center");
  });

  it("removes orphaned ES, EN and ZH presentation strings", () => {
    const i18n = source("lib/i18n.ts");
    expect(i18n).not.toContain('"nav.settings"');
    expect(i18n).not.toContain('"clients.description"');
    expect(i18n).not.toContain('"clients.highConfidence"');
    expect(i18n).not.toContain("Clientes activos, archivos autorizados");
    expect(i18n).not.toContain("Active clients, authorized files");
  });
});
