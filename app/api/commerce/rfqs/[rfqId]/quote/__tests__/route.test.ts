import { beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /api/commerce/rfqs/[rfqId]/quote", () => {
  const requireCommerceAuth = vi.fn();
  const createCommerceQuoteFromRfq = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    requireCommerceAuth.mockResolvedValue({
      profile: { id: "11111111-1111-4111-8111-111111111111", role: "employee" },
      supabase: {}
    });
    vi.doMock("@/lib/commerce/auth", () => ({ requireCommerceAuth }));
    vi.doMock("@/lib/commerce/service", () => ({ createCommerceQuoteFromRfq }));
    vi.doMock("@/lib/security/rateLimit", () => ({
      checkRateLimit: () => ({ allowed: true })
    }));
  });

  it.each([
    { idempotent: false, expectedStatus: 201 },
    { idempotent: true, expectedStatus: 200 }
  ])("returns the real draft with pricing metadata ($expectedStatus)", async ({ idempotent, expectedStatus }) => {
    const rfqId = "22222222-2222-4222-8222-222222222222";
    const quoteId = "33333333-3333-4333-8333-333333333333";
    createCommerceQuoteFromRfq.mockResolvedValue({
      quote: {
        id: quoteId,
        rfqId,
        status: "draft",
        items: [{ productId: null, authorizedUnitPrice: 0 }]
      },
      idempotent,
      pricingRequired: [{ lineNumber: 1, mpn: "UNKNOWN-DEMO", reason: "catalog_not_found" }]
    });

    const request = new Request(`https://app.test/api/commerce/rfqs/${rfqId}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ validUntil: "2030-01-01" })
    });
    const { POST } = await import("../route");
    const response = await POST(request, { params: Promise.resolve({ rfqId }) });

    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      id: quoteId,
      rfqId,
      status: "draft",
      items: [{ productId: null, authorizedUnitPrice: 0 }],
      idempotent,
      pricingRequired: [{ lineNumber: 1, reason: "catalog_not_found" }]
    });
  });
});
