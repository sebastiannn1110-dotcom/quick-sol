// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import OpportunitiesDashboard from "@/components/opportunities/OpportunitiesDashboard";
import { EMPTY_OPPORTUNITIES_RESULT } from "@/components/opportunities/opportunity-ui";
import { StockNeedsDashboard } from "@/components/stock-needs/StockNeedsDashboard";

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload)
  } as unknown as Response;
}

function rebuildingPayload() {
  return {
    error: "The summary is not ready yet.",
    errorCode: "SUMMARY_NOT_READY",
    summaryStatus: "rebuilding",
    status: "rebuilding",
    currentVersion: 4,
    requiredVersion: 5,
    retryable: true,
    retryAfterSeconds: 3
  };
}

function failedPayload() {
  return {
    error: "The summary rebuild failed.",
    errorCode: "SUMMARY_REBUILD_FAILED",
    summaryStatus: "failed",
    status: "failed",
    currentVersion: 4,
    requiredVersion: 5,
    retryable: true,
    retryAfterSeconds: 30
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("summary lifecycle UI", () => {
  it("keeps Opportunities free of false zeroes and retries only after a manual action", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(rebuildingPayload(), 409))
      .mockResolvedValueOnce(response(EMPTY_OPPORTUNITIES_RESULT));
    vi.stubGlobal("fetch", fetchMock);

    render(<LanguageProvider><OpportunitiesDashboard /></LanguageProvider>);

    expect(await screen.findByText("El resumen se está actualizando. Los datos estarán disponibles al terminar.")).toBeTruthy();
    expect(screen.getByText("Oportunidades totales").nextElementSibling?.textContent).toBe("—");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Oportunidades totales").nextElementSibling?.textContent).toBe("0"));
  });

  it("finishes Stock loading on a lifecycle response and exposes a bounded manual retry", async () => {
    const ready = {
      items: [],
      totals: {
        totalItems: 0,
        inStock: 0,
        partialStock: 0,
        noStock: 0,
        overstock: 0,
        unknown: 0,
        totalRequiredQty: 0,
        totalStockQty: 0
      },
      meta: {
        limit: 100,
        offset: 0,
        returnedItems: 0,
        scannedRecords: 0,
        missingProfileCount: 0,
        missingProfileUploadIds: [],
        hasMissingProfiles: false
      }
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(rebuildingPayload(), 409))
      .mockResolvedValueOnce(response(ready));
    vi.stubGlobal("fetch", fetchMock);

    render(<LanguageProvider><StockNeedsDashboard adminMode={false} endpoint="/api/stock-needs" /></LanguageProvider>);

    expect(await screen.findByText("El resumen se está actualizando. Los datos estarán disponibles al terminar.")).toBeTruthy();
    expect(screen.getByText("MPN totales").nextElementSibling?.textContent).toBe("—");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("MPN totales").nextElementSibling?.textContent).toBe("0"));
  });

  it("requeues a terminal failed summary exactly once before retrying the read", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(failedPayload(), 503))
      .mockResolvedValueOnce(response({ requestedCount: 1, status: "queued" }))
      .mockResolvedValueOnce(response(EMPTY_OPPORTUNITIES_RESULT));
    vi.stubGlobal("fetch", fetchMock);

    render(<LanguageProvider><OpportunitiesDashboard /></LanguageProvider>);

    expect(await screen.findByText(/La reconstrucci.n del resumen fall./)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const retry = screen.getByRole("button", { name: "Reintentar" });
    fireEvent.click(retry);
    fireEvent.click(retry);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/business-summary/rebuild",
      expect.objectContaining({ method: "POST", cache: "no-store" })
    ]);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/business-summary/rebuild")).toHaveLength(1);
    await waitFor(() => expect(screen.getByText("Oportunidades totales").nextElementSibling?.textContent).toBe("0"));
  });

  it("does not offer a fake retry when the summary contract is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      error: "The summary contract is unavailable.",
      errorCode: "SUMMARY_CONTRACT_UNAVAILABLE",
      summaryStatus: "contract_unavailable",
      status: "contract_unavailable",
      currentVersion: null,
      requiredVersion: null,
      retryable: false,
      retryAfterSeconds: 60
    }, 503)));

    render(<LanguageProvider><OpportunitiesDashboard /></LanguageProvider>);
    expect(await screen.findByText(/El contrato de resumen no est. disponible/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
  });
});
