import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

const root = process.cwd();
const visibleBrandSurfaces = [
  "app/layout.tsx",
  "app/login/page.tsx",
  "app/forgot-password/page.tsx",
  "app/reset-password/page.tsx",
  "app/admin/email-center/page.tsx",
  "app/admindev/page.tsx",
  "components/LoginForm.tsx",
  "components/Sidebar.tsx",
  "components/Navbar.tsx",
  "components/AIAssistantWidget.tsx",
  "components/admindev/DatabaseSafetyCenter.tsx",
  "components/email/EmailAlertRuleForm.tsx",
  "components/email/EmailAlertRulesTable.tsx",
  "components/opportunity-finder/OpportunityFinder.tsx",
  "lib/i18n.ts",
  "lib/email/content.ts",
  "lib/email/evaluate-alert-rules.ts",
  "lib/opportunity-finder/i18n.ts",
  "lib/opportunity-finder/export.ts",
  "data/database.json"
];

describe("Electronic Parts white-label branding", () => {
  it("contains no legacy brand on user-visible surfaces", () => {
    const source = visibleBrandSurfaces
      .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/quiksol|quicksol|quick\s+sol|quik\s+sol/i);
  });

  it("publishes the new PWA identity and icons", () => {
    const value = manifest();
    expect(value.name).toBe("Electronic Parts Demo");
    expect(value.short_name).toBe("Electronic Parts");
    expect(value.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/icon.svg", type: "image/svg+xml" }),
      expect.objectContaining({ src: "/apple-icon.png", sizes: "180x180" })
    ]));
    expect(fs.existsSync(path.join(root, "app", "favicon.ico"))).toBe(true);
    expect(fs.existsSync(path.join(root, "app", "apple-icon.png"))).toBe(true);
  });

  it("uses the requested metadata copy", () => {
    const layoutSource = fs.readFileSync(path.join(root, "app", "layout.tsx"), "utf8");
    expect(layoutSource).toContain("Electronic Parts Demo");
    expect(layoutSource).toContain("B2B platform for electronic component sourcing, inventory intelligence, RFQs, customers and commercial operations.");
    expect(layoutSource).toContain("openGraph");
    expect(layoutSource).toContain("twitter");
  });
});
