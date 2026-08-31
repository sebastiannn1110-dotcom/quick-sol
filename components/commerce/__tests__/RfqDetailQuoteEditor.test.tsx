// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import QuoteEditor, { calculateQuotePreview } from "@/components/commerce/QuoteEditor";
import RfqDetail from "@/components/commerce/RfqDetail";
import { normalizeCommerceQuote, type CommerceQuoteUi, type CommerceRfqDetail } from "@/lib/commerce/ui-model";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

const RFQ: CommerceRfqDetail = {
  id: "00000000-0000-4000-8000-000000000001",
  externalRfqId: "WEB-100",
  clientId: null,
  status: "unassigned",
  source: "quiksol-web",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  companyOrName: "Amazon-demo",
  contactName: "Demo Buyer",
  country: "Colombia",
  itemCount: 1,
  primaryMpn: "TL082CDT",
  primaryQuantity: 12,
  contact: {
    companyOrName: "Amazon-demo",
    contact: "Demo Buyer",
    email: "buyer@example.test",
    phone: "+57 300 000 0000",
    country: "Colombia",
    city: "Bogotá",
    preferredLanguage: "es",
    notes: "Demo request"
  },
  items: [{
    id: "line-1",
    lineNumber: 1,
    mpn: "TL082CDT",
    manufacturer: "STMicroelectronics",
    description: "Operational amplifier",
    quantity: 12,
    targetPrice: null,
    pricing: { productId: null, authorizedUnitPrice: null, currency: "USD", available: false }
  }],
  client: null,
  pricingReady: false,
  assignedSeller: null,
  assignableSellers: [],
  quote: null,
  actions: { markInReview: true, assignSeller: false, createClient: true, createQuote: false }
};

const QUOTEABLE_RFQ: CommerceRfqDetail = {
  ...RFQ,
  clientId: "00000000-0000-4000-8000-000000000006",
  status: "assigned",
  client: { id: "00000000-0000-4000-8000-000000000006", name: "Amazon-demo" },
  assignedSeller: {
    id: "00000000-0000-4000-8000-000000000005",
    fullName: "Maya Torres",
    email: "maya@example.test",
    role: "employee"
  },
  actions: { markInReview: true, assignSeller: true, createClient: false, createQuote: true }
};

const QUOTE: CommerceQuoteUi = {
  id: "00000000-0000-4000-8000-000000000004",
  number: "QKS-202608-001",
  rfqId: RFQ.id,
  sellerId: "00000000-0000-4000-8000-000000000005",
  sellerName: "Maya Torres",
  customer: { id: "00000000-0000-4000-8000-000000000006", companyOrName: "Amazon-demo" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  currency: "USD",
  items: [{
    productId: null,
    mpn: "TL082CDT",
    manufacturer: "STMicroelectronics",
    description: "Operational amplifier",
    quantity: 12,
    authorizedUnitPrice: 0,
    sellerUnitPrice: 0,
    discountPercent: 0,
    lineSubtotal: 0
  }],
  subtotal: 0,
  taxRate: 7,
  tax: 0,
  total: 0,
  validUntil: "2026-09-30",
  notes: "",
  commercialTerms: "",
  status: "draft",
  version: 1
};

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
});

describe("RfqDetail workflow UI", () => {
  it("shows prospect creation and the pricing warning before a client is linked", async () => {
    const runAction = vi.fn(async () => ({ ...RFQ, clientId: "client-1", client: { id: "client-1", name: "Amazon-demo" } }));
    render(<LanguageProvider><RfqDetail rfqId={RFQ.id} load={async () => RFQ} runAction={runAction} /></LanguageProvider>);
    expect(await screen.findByText("Demo Buyer")).toBeTruthy();
    expect(screen.getByText("SIN ASIGNAR")).toBeTruthy();
    expect(screen.getByText("NUEVO")).toBeTruthy();
    expect(screen.getAllByText("Precio requerido").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /Crear cotización/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Crear cliente desde RFQ/i }));
    await waitFor(() => expect(runAction).toHaveBeenCalledWith(RFQ.id, { action: "create_client" }));
  });

  it("creates a persisted draft and opens its editor even when pricing is required", async () => {
    const createQuote = vi.fn(async () => QUOTE);
    render(
      <LanguageProvider>
        <RfqDetail rfqId={RFQ.id} load={async () => QUOTEABLE_RFQ} createQuote={createQuote} />
      </LanguageProvider>
    );

    const createButton = await screen.findByRole("button", { name: /^Crear cotizaci/i });
    expect((createButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByText("Precio requerido").length).toBeGreaterThan(0);

    fireEvent.click(createButton);
    fireEvent.click(screen.getByRole("button", { name: /borrador/i }));

    await waitFor(() => expect(createQuote).toHaveBeenCalledWith(
      RFQ.id,
      expect.objectContaining({ taxRate: 7, notes: "", commercialTerms: "" })
    ));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/admin/quotes/${QUOTE.id}`));
  });
});

describe("QuoteEditor pricing guard", () => {
  it("matches SQL precision by rounding unit price to 4 decimals before the 2-decimal line total", () => {
    const preview = calculateQuotePreview(
      [{ authorizedUnitPrice: 1.2345, quantity: 1000, discountPercent: 1 }],
      [{ quantity: 1000, discountPercent: 1 }],
      0
    );
    expect(preview.sellerUnitPrices[0]).toBe(1.2222);
    expect(preview.lines[0]).toBe(1222.2);
    expect(preview.total).toBe(1222.2);
  });

  it("renders RFQ-prefilled items and keeps Send Quote disabled without authorized pricing", async () => {
    const save = vi.fn(async () => QUOTE);
    const send = vi.fn(async () => QUOTE);
    render(
      <LanguageProvider>
        <QuoteEditor quoteId={QUOTE.id} load={async () => QUOTE} save={save} send={send} />
      </LanguageProvider>
    );
    expect((await screen.findAllByText("QKS-202608-001")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("TL082CDT").length).toBeGreaterThan(0);
    const sendButton = screen.getByRole("button", { name: /Enviar cotizaci/i });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(send).not.toHaveBeenCalled();

    const desktopLine = screen.getByRole("row", { name: /TL082CDT/i });
    expect(within(desktopLine).getAllByText("Precio requerido")).toHaveLength(3);
    expect((screen.getByLabelText(/Descuento TL082CDT/i) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Subtotal").parentElement?.textContent).toContain("Precio requerido");
    expect(screen.getAllByText("Precio requerido").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Guardar borrador/i }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1].items[0].productId).toBeNull();
  });

  it("normalizes an unresolved quote product as null instead of a sentinel string", () => {
    expect(normalizeCommerceQuote(QUOTE).items[0].productId).toBeNull();
  });
});
