// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClientsDirectory from "@/components/clients/ClientsDirectory";
import { LanguageProvider } from "@/components/LanguageProvider";

vi.mock("@/components/ProfileProvider", () => ({
  useProfile: () => ({
    profile: { id: "profile", role: "manager", email: "manager@example.test" },
    loading: false
  })
}));

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload)
  } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClientsDirectory request lifecycle", () => {
  it("consumes the expected summary abort when navigation unmounts the directory", async () => {
    let observedSignal: AbortSignal | null = null;
    const abortObserved = vi.fn();
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);

    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/clients")) return Promise.resolve(jsonResponse({ clients: [] }));
      if (url === "/api/opportunities/summary") {
        observedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal!.addEventListener("abort", () => {
            abortObserved();
            reject(new DOMException("signal is aborted without reason", "AbortError"));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const view = render(<LanguageProvider><ClientsDirectory /></LanguageProvider>);
    await waitFor(() => expect(observedSignal).not.toBeNull());
    view.unmount();
    await waitFor(() => expect(abortObserved).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(observedSignal?.aborted).toBe(true);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("still surfaces a real HTTP 500 from the summary endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/clients")) return Promise.resolve(jsonResponse({ clients: [] }));
      if (url === "/api/opportunities/summary") return Promise.resolve(jsonResponse({}, 500));
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<LanguageProvider><ClientsDirectory /></LanguageProvider>);
    expect(await screen.findByText("No se pudieron cargar las oportunidades.")).toBeTruthy();
    expect(screen.queryByText("No se pudieron cargar los clientes.")).toBeNull();
  });

  it("still surfaces a real backend/network rejection", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/clients")) return Promise.resolve(jsonResponse({ clients: [] }));
      if (url === "/api/opportunities/summary") {
        return Promise.reject(new Error("PGRST_CONNECTION_FAILURE"));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<LanguageProvider><ClientsDirectory /></LanguageProvider>);
    expect(await screen.findByText("No se pudieron cargar las oportunidades.")).toBeTruthy();
    expect(screen.queryByText("No se pudieron cargar los clientes.")).toBeNull();
  });

  it("shows an explicit rebuilding state, no false zero, and retries only on user action", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/clients")) {
        return Promise.resolve(jsonResponse({
          clients: [],
          summary: { status: "ready", currentVersion: null, requiredVersion: null, retryable: false, retryAfterSeconds: 0 }
        }));
      }
      if (url === "/api/opportunities/summary") {
        const summaryCalls = fetchMock.mock.calls.filter(([target]) => String(target) === "/api/opportunities/summary").length;
        if (summaryCalls === 1) return Promise.resolve(jsonResponse({
          error: "The summary is not ready yet.",
          errorCode: "SUMMARY_NOT_READY",
          summaryStatus: "rebuilding",
          status: "rebuilding",
          currentVersion: 4,
          requiredVersion: 5,
          retryable: true,
          retryAfterSeconds: 3
        }, 409));
        return Promise.resolve(jsonResponse({
          totals: { totalOpportunities: 0, immediateSale: 0, partialSale: 0, sourcingNeeded: 0 }
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LanguageProvider><ClientsDirectory /></LanguageProvider>);
    expect(await screen.findByText("El resumen se está actualizando. Los datos estarán disponibles al terminar.")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("El resumen se está actualizando. Los datos estarán disponibles al terminar.")).toBeNull());
  });
});
