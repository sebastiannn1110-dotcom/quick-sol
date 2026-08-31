import { describe, expect, it } from "vitest";
import {
  calculateQuoteTotals,
  canTransitionQuote,
  commerceQuotePatchSchema,
  commerceQuoteWriteSchema,
  commerceRfqActionSchema,
  commerceRfqIntakeSchema,
  commerceRfqQuoteSchema,
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
        { productId: "p1", quantity: 1200, authorizedUnitPrice: 4.65, discountPercent: 2, sellerUnitPrice: 4.557, lineTotal: 5468.4 },
        { productId: "p2", quantity: 3, authorizedUnitPrice: 10, discountPercent: 0, sellerUnitPrice: 10, lineTotal: 30 }
      ],
      subtotal: 5498.4,
      taxRate: 7,
      tax: 384.89,
      total: 5883.29
    });
  });

  it("matches database precision by rounding unit prices to four decimals", () => {
    expect(calculateQuoteTotals([
      { productId: "p1", quantity: 1000, authorizedUnitPrice: 1.2345, discountPercent: 1 }
    ], 0)).toEqual({
      lines: [{
        productId: "p1",
        quantity: 1000,
        authorizedUnitPrice: 1.2345,
        discountPercent: 1,
        sellerUnitPrice: 1.2222,
        lineTotal: 1222.2
      }],
      subtotal: 1222.2,
      taxRate: 0,
      tax: 0,
      total: 1222.2
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

  it("keeps generic quote products strict while preserving unresolved RFQ draft lines", () => {
    const shared = {
      customerId: "11111111-1111-4111-8111-111111111111",
      items: [{ productId: null, quantity: 10, discountPercent: 0 }],
      validUntil: "2030-01-01",
      notes: "",
      commercialTerms: "",
      taxRate: 7
    };

    expect(commerceQuoteWriteSchema.safeParse({
      ...shared,
      rfqId: "22222222-2222-4222-8222-222222222222"
    }).success).toBe(false);
    expect(commerceQuotePatchSchema.safeParse({
      ...shared,
      version: 1,
      rfqId: "22222222-2222-4222-8222-222222222222"
    }).success).toBe(true);
    expect(commerceQuotePatchSchema.safeParse({
      ...shared,
      version: 1,
      rfqId: null
    }).success).toBe(false);
    expect(commerceQuotePatchSchema.safeParse({
      ...shared,
      version: 1
    }).success).toBe(false);
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

  it("accepts only the three explicit RFQ workflow actions", () => {
    expect(commerceRfqActionSchema.safeParse({ action: "mark_in_review" }).success).toBe(true);
    expect(commerceRfqActionSchema.safeParse({
      action: "assign_seller",
      sellerId: "11111111-1111-4111-8111-111111111111"
    }).success).toBe(true);
    expect(commerceRfqActionSchema.safeParse({ action: "create_client" }).success).toBe(true);
    expect(commerceRfqActionSchema.safeParse({ action: "assign_seller" }).success).toBe(false);
    expect(commerceRfqActionSchema.safeParse({ action: "cancel" }).success).toBe(false);
  });

  it("does not accept browser-provided RFQ quote lines or prices", () => {
    expect(commerceRfqQuoteSchema.safeParse({
      validUntil: "2030-01-01",
      items: [{ productId: "11111111-1111-4111-8111-111111111111", quantity: 1 }],
      authorizedUnitPrice: 0.01
    }).success).toBe(false);
    expect(commerceRfqQuoteSchema.parse({ validUntil: "2030-01-01" })).toEqual({
      validUntil: "2030-01-01",
      notes: "",
      commercialTerms: "",
      taxRate: 7
    });
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
  it("parses only a strict Bearer header", () => {
    expect(bearerToken(new Request("https://example.invalid", { headers: { authorization: "Bearer token-1" } }))).toBe("token-1");
    expect(bearerToken(new Request("https://example.invalid", { headers: { authorization: "Basic token-1" } }))).toBeNull();
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
