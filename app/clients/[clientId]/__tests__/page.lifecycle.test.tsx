// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClientDetailPage from "../page";
import { LanguageProvider } from "@/components/LanguageProvider";

const CLIENT_ID = "00000000-0000-4000-8000-000000000020";

vi.mock("next/navigation", () => ({ useParams: () => ({ clientId: CLIENT_ID }) }));
vi.mock("@/components/EmployeeGuard", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/clients/ClientImage", () => ({ default: () => <div data-testid="client-image" /> }));
vi.mock("@/components/clients/ClientFiles", () => ({ default: () => <div /> }));
vi.mock("@/components/clients/ClientOpportunities", () => ({ default: () => <div /> }));

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload)
  } as unknown as Response;
}

function client(summaryStatus: "failed" | "ready") {
  return {
    id: CLIENT_ID,
    name: "Client fixture",
    description: null,
    industry: null,
    region: null,
    website: null,
    logoUrl: null,
    authorizedIdentificationImageUrl: null,
    status: "active",
    fileCount: 1,
    summaryStatus,
    summaryCurrentVersion: summaryStatus === "ready" ? 2 : 1,
    summaryRequiredVersion: 2,
    mpnCount: summaryStatus === "ready" ? 5 : null,
    opportunityCount: summaryStatus === "ready" ? 0 : null,
    immediateSaleCount: summaryStatus === "ready" ? 0 : null,
    partialSaleCount: summaryStatus === "ready" ? 0 : null,
    sourcingNeededCount: summaryStatus === "ready" ? 0 : null,
    stockWithoutDemandCount: summaryStatus === "ready" ? 0 : null,
    highConfidenceCount: summaryStatus === "ready" ? 0 : null,
    highConfidenceTruncated: summaryStatus === "ready" ? false : null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    canManage: false,
    privateDetails: null
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClientDetailPage summary lifecycle", () => {
  it("requeues a failed client-scoped summary once before refreshing details", async () => {
    let detailReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/clients/${CLIENT_ID}`) {
        detailReads += 1;
        return Promise.resolve(response({ client: client(detailReads === 1 ? "failed" : "ready") }));
      }
      if (url === `/api/clients/${CLIENT_ID}/uploads`) return Promise.resolve(response({ uploads: [] }));
      if (url === "/api/business-summary/rebuild" && init?.method === "POST") {
        return Promise.resolve(response({ requestedCount: 1, status: "queued" }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LanguageProvider><ClientDetailPage /></LanguageProvider>);
    expect(await screen.findByText(/La reconstrucci.n del resumen fall./)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/business-summary/rebuild")).toHaveLength(0);

    const retry = screen.getByRole("button", { name: "Reintentar" });
    fireEvent.click(retry);
    fireEvent.click(retry);

    await waitFor(() => expect(detailReads).toBe(2));
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/business-summary/rebuild")).toHaveLength(1);
    const rebuildCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/business-summary/rebuild");
    expect(JSON.parse(String(rebuildCall?.[1]?.body))).toEqual({ clientId: CLIENT_ID });
    await waitFor(() => expect(screen.queryByText(/La reconstrucci.n del resumen fall./)).toBeNull());
  });
});
