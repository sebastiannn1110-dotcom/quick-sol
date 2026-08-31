// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "@/components/Sidebar";
import { LanguageProvider } from "@/components/LanguageProvider";
import { useRfqNotifications } from "@/components/commerce/RfqNotifications";
import type { Profile } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  push: vi.fn()
}));

vi.mock("@/lib/commerce/client", () => ({ commerceRequest: mocks.request }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/clients",
  useRouter: () => ({ push: mocks.push })
}));

const PROFILE: Profile = {
  id: "00000000-0000-4000-8000-000000000001",
  full_name: "Synthetic Seller",
  email: "seller@example.test",
  role: "employee",
  department: "Sales",
  region: "LATAM",
  is_active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString()
};
const SECOND_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

function rawRfq(id: string) {
  return {
    id,
    externalRfqId: `WEB-${id}`,
    status: "assigned",
    source: "quiksol-web",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clientId: null,
    companyOrName: "Amazon-demo",
    contactName: "Demo Buyer",
    country: "Colombia",
    itemCount: 1,
    primaryItem: { mpn: "TL082CDT", quantity: 12 },
    assignedSeller: { id: PROFILE.id, fullName: PROFILE.full_name }
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  mocks.request.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RFQ 12-second polling and sidebar badge", () => {
  it("polls inside the required 10–15 second window and does not repeat the same RFQ toast", async () => {
    const first = rawRfq("00000000-0000-4000-8000-000000000010");
    const second = rawRfq("00000000-0000-4000-8000-000000000011");
    mocks.request.mockResolvedValueOnce({ rfqs: [first], pendingCount: 1 });
    const third = rawRfq("00000000-0000-4000-8000-000000000012");
    const view = renderHook(() => useRfqNotifications(PROFILE.id));
    await flush();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(view.result.current.toast).toBeNull();

    mocks.request.mockResolvedValueOnce({ rfqs: [second, third, first], pendingCount: 3 });
    await act(async () => {
      vi.advanceTimersByTime(11_999);
      await Promise.resolve();
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(view.result.current.toast?.id).toBe(second.id);

    act(() => {
      view.result.current.dismissToast();
    });
    expect(view.result.current.toast?.id).toBe(third.id);
    act(() => {
      view.result.current.dismissToast();
    });
    expect(view.result.current.toast).toBeNull();

    mocks.request.mockResolvedValueOnce({ rfqs: [second, third, first], pendingCount: 3 });
    await act(async () => {
      vi.advanceTimersByTime(12_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(view.result.current.toast).toBeNull();
  });

  it("renders the scoped pending count beside the RFQ navigation entry", async () => {
    mocks.request.mockResolvedValue({ rfqs: [rawRfq("00000000-0000-4000-8000-000000000010")], pendingCount: 3 });
    render(<LanguageProvider><Sidebar profile={PROFILE} /></LanguageProvider>);
    await flush();
    expect(screen.getByTestId("rfq-sidebar-badge").textContent).toBe("3");
    expect(screen.getByText("Solicitudes de cotización")).toBeTruthy();
  });

  it("keeps polling and updates the badge when sessionStorage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    mocks.request.mockResolvedValue({ rfqs: [], pendingCount: 4 });
    const view = renderHook(() => useRfqNotifications(PROFILE.id));
    await flush();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(view.result.current.pendingCount).toBe(4);
  });

  it("keeps seen RFQ storage isolated when the signed-in profile changes", async () => {
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    mocks.request.mockResolvedValueOnce({ rfqs: [rawRfq("00000000-0000-4000-8000-000000000010")], pendingCount: 1 });
    const view = renderHook(
      ({ profileId }: { profileId: string }) => useRfqNotifications(profileId),
      { initialProps: { profileId: PROFILE.id } }
    );
    await flush();
    expect(storageSpy.mock.calls.some(([key]) => String(key).endsWith(`:${PROFILE.id}`))).toBe(true);

    mocks.request.mockResolvedValueOnce({ rfqs: [rawRfq("00000000-0000-4000-8000-000000000020")], pendingCount: 4 });
    view.rerender({ profileId: SECOND_PROFILE_ID });
    await flush();
    expect(view.result.current.pendingCount).toBe(4);
    expect(view.result.current.toast).toBeNull();
    expect(storageSpy.mock.calls.some(([key]) => String(key).endsWith(`:${SECOND_PROFILE_ID}`))).toBe(true);
  });
});
