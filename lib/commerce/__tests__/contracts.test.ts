import { describe, expect, it } from "vitest";
import {
  calculateQuoteTotals,
  canAccessSeller,
  canTransitionQuote,
  commerceQuoteWriteSchema,
  commerceRfqIntakeSchema,
  commerceScopes,
  sessionRole
} from "@/lib/commerce/contracts";
import {
  bearerToken,
  canonicalJson,
  commerceRequestFingerprint,
  signCommerceIntake,
  verifyCommerceIntakeSignature
} from "@/lib/commerce/auth";

describe("commerce request and pricing contracts", () => {
  it("calculates all quote prices on the server with currency rounding", () => {
    expect(calculateQuoteTotals([
      { productId: "p1", quantity: 1200, authorizedUnitPrice: 4.65, discountPercent: 2 },
      { productId: "p2", quantity: 3, authorizedUnitPrice: 10, discountPercent: 0 }
    ], 7)).toEqual({
      lines: [
        { productId: "p1", quantity: 1200, authorizedUnitPrice: 4.65, discountPercent: 2, sellerUnitPrice: 4.56, lineTotal: 5472 },
        { productId: "p2", quantity: 3, authorizedUnitPrice: 10, discountPercent: 0, sellerUnitPrice: 10, lineTotal: 30 }
      ],
      subtotal: 5502,
      taxRate: 7,
      tax: 385.14,
      total: 5887.14
    });
  });

  it("rejects browser prices and totals instead of trusting them", () => {
    const parsed = commerceQuoteWriteSchema.safeParse({
      customerId: "11111111-1111-4111-8111-111111111111",
      items: [{ productId: "22222222-2222-4222-8222-222222222222", quantity: 1 }],
      validUntil: "2030-01-01",
      subtotal: 0,
      total: 0,
      authorizedUnitPrice: 0
    });
    expect(parsed.success).toBe(false);
  });

  it("bounds RFQ lines and preserves string MPNs", () => {
    const parsed = commerceRfqIntakeSchema.parse({
      externalRfqId: "RFQ-DEMO-0001",
      contact: { companyOrName: "DEMO", contact: "Adrian", email: "adrian@demo.invalid" },
      items: [{ mpn: "000-QKS-042", quantity: 1200 }]
    });
    expect(parsed.items[0].mpn).toBe("000-QKS-042");
    expect(parsed.source).toBe("quiksol-web");
  });

  it("allows only the defined quote lifecycle", () => {
    expect(canTransitionQuote("draft", "sent")).toBe(true);
    expect(canTransitionQuote("sent", "accepted")).toBe(true);
    expect(canTransitionQuote("sent", "rejected")).toBe(true);
    expect(canTransitionQuote("accepted", "sent")).toBe(false);
    expect(canTransitionQuote("draft", "accepted")).toBe(false);
  });
});

describe("commerce auth and permissions", () => {
  const employee = { id: "employee", role: "employee" as const, department: "Sales", region: "Americas" };
  const manager = { id: "manager", role: "manager" as const, department: "Sales", region: "Americas" };
  const admin = { id: "admin", role: "admin" as const, department: null, region: null };
  const seller = { id: "seller", department: "Sales", region: "Americas" };

  it("parses only a strict Bearer header", () => {
    expect(bearerToken(new Request("https://example.invalid", { headers: { authorization: "Bearer token-1" } }))).toBe("token-1");
    expect(bearerToken(new Request("https://example.invalid", { headers: { authorization: "Basic token-1" } }))).toBeNull();
  });

  it("enforces self, team, and global seller scopes", () => {
    expect(canAccessSeller(employee, seller)).toBe(false);
    expect(canAccessSeller({ ...employee, id: "seller" }, seller)).toBe(true);
    expect(canAccessSeller(manager, seller)).toBe(true);
    expect(canAccessSeller({ ...manager, department: "Ops", region: "Asia" }, seller)).toBe(false);
    expect(canAccessSeller(admin, seller)).toBe(true);
  });

  it("maps super_admin_dev to the web-compatible admin role without losing scopes", () => {
    expect(sessionRole("super_admin_dev")).toBe("admin");
    expect(commerceScopes("super_admin_dev").allOperations).toBe(true);
    expect(commerceScopes("employee").teamOperations).toBe(false);
  });

  it("verifies timestamped RFQ HMAC and rejects body tampering", () => {
    const secret = "a".repeat(32);
    const timestamp = "1900000000";
    const body = JSON.stringify({ externalRfqId: "RFQ-DEMO-0001" });
    const headers = new Headers({
      "x-quiksol-timestamp": timestamp,
      "x-quiksol-signature": `sha256=${signCommerceIntake(body, timestamp, secret)}`
    });
    expect(verifyCommerceIntakeSignature(body, headers, { secret, now: 1_900_000_000_000 }).ok).toBe(true);
    expect(verifyCommerceIntakeSignature(`${body} `, headers, { secret, now: 1_900_000_000_000 }).ok).toBe(false);
  });

  it("makes RFQ fingerprints independent of object key order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(commerceRequestFingerprint({ b: 2, a: 1 })).toBe(commerceRequestFingerprint({ a: 1, b: 2 }));
  });
});
