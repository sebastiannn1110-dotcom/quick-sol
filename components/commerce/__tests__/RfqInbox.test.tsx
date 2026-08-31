// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import RfqInbox from "@/components/commerce/RfqInbox";
import type { CommerceRfqSummary } from "@/lib/commerce/ui-model";

const RFQ: CommerceRfqSummary = {
  id: "00000000-0000-4000-8000-000000000010",
  externalRfqId: "WEB-RFQ-1001",
  clientId: "00000000-0000-4000-8000-000000000020",
  status: "assigned",
  source: "quiksol-web",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  companyOrName: "Amazon-demo",
  contactName: "Demo Buyer",
  country: "Colombia",
  itemCount: 1,
  primaryMpn: "TL082CDT",
  primaryQuantity: 12,
  assignedSeller: {
    id: "00000000-0000-4000-8000-000000000030",
    fullName: "Maya Torres",
    email: "maya@example.test",
    role: "employee"
  }
};

afterEach(cleanup);

describe("RfqInbox", () => {
  it("renders the allowlisted RFQ fields, DEMO marker, pending badge, and responsive variants", async () => {
    render(
      <LanguageProvider>
        <RfqInbox load={async () => ({ rfqs: [RFQ], pendingCount: 3 })} />
      </LanguageProvider>
    );
    expect((await screen.findAllByText("Amazon-demo")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("DEMO").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TL082CDT").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ASIGNADO").length).toBeGreaterThan(0);
    expect(screen.getAllByText("NUEVO").length).toBeGreaterThan(0);
    expect(screen.getByText(/3 pendientes/i)).toBeTruthy();
    expect(screen.getAllByText("Maya Torres").length).toBeGreaterThan(0);
    const links = screen.getAllByRole("link", { name: /Abrir/i });
    expect(links[0].getAttribute("href")).toBe(`/admin/rfqs/${RFQ.id}`);
  });
});
