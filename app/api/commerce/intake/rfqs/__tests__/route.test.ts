import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/commerce/intake/rfqs/route";

describe("disabled external RFQ intake", () => {
  it.each([GET, POST])("returns 410 without requiring an HMAC secret", async (handler) => {
    const response = handler();
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: "integration_disabled" });
  });
});

