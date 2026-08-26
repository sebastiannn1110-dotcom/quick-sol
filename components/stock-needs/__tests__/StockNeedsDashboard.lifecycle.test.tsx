// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import { StockNeedsDashboard } from "@/components/stock-needs/StockNeedsDashboard";
import type { StockNeedsResult } from "@/lib/stock-needs/stock-needs";

function resultWithMpn(mpn?: string): StockNeedsResult {
  const items = mpn ? [{
    mpn,
    customerName: null,
    manufacturerName: null,
    supplierName: null,
    requiredQty: 1,
    stockQty: 0,
    availableQty: 0,
    shortageQty: 1,
    coverageStatus: "no_stock" as const,
    requiredDate: null,
    leadTime: null,
    sourceUploads: [],
    warnings: []
  }] : [];
  return {
    items,
    totals: {
      totalItems: items.length,
      inStock: 0,
      partialStock: 0,
      noStock: items.length,
      overstock: 0,
      unknown: 0,
      totalRequiredQty: items.length,
      totalStockQty: 0
    },
    meta: {
      limit: 100,
      offset: 0,
      returnedItems: items.length,
      scannedRecords: items.length,
      missingProfileCount: 0,
      missingProfileUploadIds: [],
      hasMissingProfiles: false
    }
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload)
  } as unknown as Response;
}

function renderDashboard() {
  return render(
    <LanguageProvider>
      <StockNeedsDashboard endpoint="/api/stock-needs" adminMode={false} />
    </LanguageProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("StockNeedsDashboard request lifecycle", () => {
  it("issues one request for one logical load even when stored language hydrates", async () => {
    window.localStorage.setItem("quiksol-language", "en");
    const fetchMock = vi.fn(async () => jsonResponse(resultWithMpn()));
    vi.stubGlobal("fetch", fetchMock);

    renderDashboard();

    expect(await screen.findByText("No MPNs match the current filters.")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/stock-needs?limit=100");
  });

  it("aborts the prior request before a refresh so at most one request stays active", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const aborted = vi.fn();
    const pending: Array<(payload: StockNeedsResult) => void> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return false;
          settled = true;
          activeRequests -= 1;
          return true;
        };
        init?.signal?.addEventListener("abort", () => {
          if (!finish()) return;
          aborted();
          reject(new DOMException("Request aborted.", "AbortError"));
        }, { once: true });
        pending.push((payload) => {
          if (!finish()) return;
          resolve(jsonResponse(payload));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDashboard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(aborted).toHaveBeenCalledTimes(1);
    expect(maxActiveRequests).toBe(1);
    await act(async () => pending[1]?.(resultWithMpn("CURRENT")));
    expect(await screen.findByText("CURRENT")).toBeTruthy();
  });

  it("ignores a stale response when a transport does not reject after abort", async () => {
    let resolveFirst: ((response: Response) => void) | null = null;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(jsonResponse(resultWithMpn("LATEST")));
    vi.stubGlobal("fetch", fetchMock);

    renderDashboard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(await screen.findByText("LATEST")).toBeTruthy();

    await act(async () => {
      resolveFirst?.(jsonResponse(resultWithMpn("STALE")));
      await first;
    });
    expect(screen.queryByText("STALE")).toBeNull();
    expect(screen.getByText("LATEST")).toBeTruthy();
  });
});
