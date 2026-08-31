// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import { mergeRfqPoll, RfqToast } from "@/components/commerce/RfqNotifications";
import type { CommerceRfqSummary } from "@/lib/commerce/ui-model";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

function rfq(id: string, status: CommerceRfqSummary["status"] = "assigned"): CommerceRfqSummary {
  return {
    id,
    externalRfqId: `WEB-${id}`,
    clientId: null,
    status,
    source: "quiksol-web",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    companyOrName: "Amazon-demo",
    contactName: "Demo Buyer",
    country: "Colombia",
    itemCount: 1,
    primaryMpn: "TL082CDT",
    primaryQuantity: 12,
    assignedSeller: { id: "seller-1", fullName: "Maya Torres", email: "", role: "employee" }
  };
}

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
});

describe("RFQ notification polling state", () => {
  it("establishes a baseline, emits a new pending RFQ once, and deduplicates later polls", () => {
    const first = rfq("rfq-1");
    const second = rfq("rfq-2");
    const third = rfq("rfq-3");
    const baseline = mergeRfqPoll([], false, [first]);
    expect(baseline.toast).toBeNull();

    const next = mergeRfqPoll(baseline.seenIds, true, [second, third, first]);
    expect(next.toast?.id).toBe("rfq-2");
    expect(next.toasts.map((item) => item.id)).toEqual(["rfq-2", "rfq-3"]);

    const repeated = mergeRfqPoll(next.seenIds, true, [second, third, first]);
    expect(repeated.toast).toBeNull();
    expect(new Set(repeated.seenIds).size).toBe(3);
  });

  it("does not toast a newly observed completed RFQ", () => {
    expect(mergeRfqPoll(["rfq-1"], true, [rfq("rfq-2", "quoted")]).toast).toBeNull();
  });
});

describe("RFQ toast", () => {
  it("contains only the allowlisted company/MPN summary and opens the RFQ on click", () => {
    render(<LanguageProvider><RfqToast rfq={rfq("rfq-2")} onDismiss={vi.fn()} /></LanguageProvider>);
    expect(screen.getByText("Amazon-demo")).toBeTruthy();
    expect(screen.getByText("TL082CDT")).toBeTruthy();
    fireEvent.click(screen.getByText("Amazon-demo"));
    expect(mocks.push).toHaveBeenCalledWith("/admin/rfqs/rfq-2");
  });
});
