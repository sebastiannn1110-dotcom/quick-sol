// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClientCommerceActivity from "@/components/clients/ClientCommerceActivity";
import { LanguageProvider } from "@/components/LanguageProvider";
import { parseClientCommerceActivity } from "@/lib/commerce/ui-model";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ClientCommerceActivity", () => {
  it("maps the allowlisted client activity shape and renders at most the recent RFQ/Quote fields", async () => {
    const activity = parseClientCommerceActivity({
      recentRfqs: [{
        id: "00000000-0000-4000-8000-000000000001",
        status: "assigned",
        createdAt: "2026-08-30T12:00:00.000Z",
        mpn: "TL082CDT",
        quantity: 12
      }],
      recentQuotes: [{
        id: "00000000-0000-4000-8000-000000000002",
        number: "QKS-202608-001",
        status: "sent",
        createdAt: "2026-08-30T12:10:00.000Z",
        total: 245.5,
        currency: "USD",
        seller: { id: "00000000-0000-4000-8000-000000000003", fullName: "Maya Torres" }
      }]
    });
    expect(activity.recentRfqs[0].primaryMpn).toBe("TL082CDT");
    expect(activity.recentRfqs[0].primaryQuantity).toBe(12);
    expect(activity.recentQuotes[0].sellerName).toBe("Maya Torres");

    render(
      <LanguageProvider>
        <ClientCommerceActivity clientId="client-1" load={async () => activity} />
      </LanguageProvider>
    );
    expect(await screen.findByText("TL082CDT")).toBeTruthy();
    expect(screen.getByText("QKS-202608-001")).toBeTruthy();
    expect(screen.getByText(/Maya Torres/)).toBeTruthy();
  });

  it.each([403, 404])("shows empty activity without a red error for an out-of-scope employee (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    render(
      <LanguageProvider>
        <ClientCommerceActivity clientId="00000000-0000-4000-8000-000000000099" />
      </LanguageProvider>
    );
    expect(await screen.findByText("No hay RFQs recientes.")).toBeTruthy();
    expect(screen.getByText("No hay cotizaciones recientes.")).toBeTruthy();
    expect(screen.queryByText("No se pudo cargar esta información comercial.")).toBeNull();
  });
});
