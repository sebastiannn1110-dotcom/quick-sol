import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("D3 commerce API contract", () => {
  it.each([
    "app/api/commerce/auth/session/route.ts",
    "app/api/commerce/auth/refresh/route.ts",
    "app/api/commerce/employee/dashboard/route.ts",
    "app/api/commerce/catalog/route.ts",
    "app/api/commerce/catalog/[productId]/route.ts",
    "app/api/commerce/customers/route.ts",
    "app/api/commerce/customers/[customerId]/route.ts",
    "app/api/commerce/intake/rfqs/route.ts",
    "app/api/commerce/quotes/route.ts",
    "app/api/commerce/quotes/[quoteId]/route.ts",
    "app/api/commerce/quotes/[quoteId]/send/route.ts",
    "app/api/commerce/quotes/[quoteId]/refresh-pricing/route.ts",
    "app/api/commerce/quotes/[quoteId]/share/route.ts",
    "app/api/commerce/public/catalog/route.ts",
    "app/api/commerce/public/quotes/[token]/route.ts",
    "app/api/commerce/availability/route.ts"
  ])("implements %s", (route) => {
    expect(fs.existsSync(path.resolve(process.cwd(), route))).toBe(true);
  });

  it("validates Bearer tokens through Supabase getUser and an active profile", () => {
    const auth = source("lib/commerce/auth.ts");
    expect(auth).toContain("supabase.auth.getUser(accessToken)");
    expect(auth).toContain("if (!profile.is_active)");
    expect(auth).toContain('Authorization: `Bearer ${accessToken}`');
  });

  it("implements password login, refresh rotation, and server-side logout", () => {
    const session = source("app/api/commerce/auth/session/route.ts");
    const refresh = source("app/api/commerce/auth/refresh/route.ts");
    expect(session).toContain("signInWithPassword");
    expect(session).toContain("export async function DELETE");
    expect(session).toContain("revokeCommerceSession");
    expect(refresh).toContain("auth.refreshSession");
    expect(refresh).toContain("refreshToken: data.session.refresh_token");
  });

  it("never selects or serializes forbidden financial fields", () => {
    const service = source("lib/commerce/service.ts");
    expect(service).not.toMatch(/\b(unit_cost|supplier_cost|gross_profit|gp_rate|gross_margin|internal_supplier)\b/i);
    expect(service).toContain("authorized_unit_price");
  });

  it("uses a signed server-to-server boundary for RFQ intake", () => {
    const intake = source("app/api/commerce/intake/rfqs/route.ts");
    expect(intake).toContain("verifyCommerceIntakeSignature");
    expect(intake).toContain("createSupabaseServiceRoleClient");
    expect(intake).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("requires versions for quote writes and sending", () => {
    const quoteRoute = source("app/api/commerce/quotes/[quoteId]/route.ts");
    const sendRoute = source("app/api/commerce/quotes/[quoteId]/send/route.ts");
    expect(quoteRoute).toContain("commerceQuotePatchSchema");
    expect(sendRoute).toContain("commerceQuoteSendSchema");
    expect(sendRoute).toContain("transitionCommerceQuote");
  });

  it("refreshes authorized pricing only for draft quotes through the existing server recalculation", () => {
    const refreshRoute = source("app/api/commerce/quotes/[quoteId]/refresh-pricing/route.ts");
    expect(refreshRoute).toContain('current.status !== "draft"');
    expect(refreshRoute).toContain("parsed.data.version");
    expect(refreshRoute).toContain("updateCommerceQuote");
    expect(refreshRoute).not.toMatch(/supplier|unitCost|rawUnitCost/i);
  });

  it("stores only hashed share tokens and returns a public allowlist", () => {
    const share = source("app/api/commerce/quotes/[quoteId]/share/route.ts");
    const publicRoute = source("app/api/commerce/public/quotes/[token]/route.ts");
    const service = source("lib/commerce/service.ts");
    expect(share).toContain("hashCommerceShareToken(token)");
    expect(publicRoute).toContain("publicQuotePayload");
    expect(service).toContain("export function publicQuotePayload");
    const allowlist = service.split("export function publicQuotePayload")[1].split("async function teamSellerIds")[0];
    expect(allowlist).not.toContain("sellerEmail");
    expect(allowlist).not.toContain("assignedSalespersonId");
    expect(allowlist).not.toContain("availabilityRevision");
  });

  it("marks every operational response no-store", () => {
    expect(source("lib/commerce/http.ts")).toContain('"cache-control": "no-store, max-age=0"');
  });

  it("publishes only opted-in catalog overlays without exact stock", () => {
    const publicCatalog = source("app/api/commerce/public/catalog/route.ts");
    expect(publicCatalog).toContain('.eq("publish_to_catalog", true)');
    expect(publicCatalog).not.toContain("available_quantity");
    expect(publicCatalog).not.toMatch(/\b(cost|gp|margin|supplier)\b/i);
  });
});
