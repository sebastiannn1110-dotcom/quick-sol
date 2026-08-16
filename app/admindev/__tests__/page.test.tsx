// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminDevPage from "@/app/admindev/page";

vi.mock("@/components/admindev/DatabaseSafetyCenter", () => ({
  default: () => <div>Database Safety disponible</div>
}));

type ModuleName = "health" | "traffic" | "security" | "imports" | "ai" | "chat";

const payloads: Record<ModuleName, unknown> = {
  health: {
    web: { status: "ok" },
    worker: { status: "ok", heartbeatAt: null, workerId: null },
    jobs: { queued: 1, processing: 0, failed: 0, completed: 2, stuck: [] },
    providers: {},
    alerts: []
  },
  traffic: { summary: { totalVisits: 10, errors5xx: 0 } },
  security: { securityEvents: [], failedLogins: [], unauthorizedRequests: [] },
  imports: {
    jobs: [{ id: "job-1", original_file_name: "synthetic.xlsx", status: "completed" }],
    summary: { activeBusinessRecords: 12, archivedBusinessRecords: 0 }
  },
  ai: { failures: 0, averageResponseMs: 20 },
  chat: { messagesLast24h: 4, activeConversations: 1 }
};

function moduleForUrl(url: string): ModuleName {
  if (url.includes("/health")) return "health";
  if (url.includes("/traffic")) return "traffic";
  if (url.includes("/security")) return "security";
  if (url.includes("/imports")) return "imports";
  if (url.includes("/ai")) return "ai";
  return "chat";
}

function response(name: ModuleName, status = 200) {
  return new Response(
    JSON.stringify(status === 200 ? { [name]: payloads[name] } : { error: "MODULE_UNAVAILABLE" }),
    { status, headers: { "content-type": "application/json" } }
  );
}

function mockModules(statuses: Partial<Record<ModuleName, number>> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const name = moduleForUrl(String(input));
    return response(name, statuses[name] ?? 200);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/admindev module isolation", () => {
  it("keeps the panel available and isolates an Imports 500", async () => {
    vi.stubGlobal("fetch", mockModules({ imports: 500 }));
    render(<AdminDevPage />);

    expect(await screen.findByTestId("module-health-success")).toBeTruthy();
    expect(await screen.findByTestId("module-imports-error")).toBeTruthy();
    expect(screen.queryByText("Acceso denegado")).toBeNull();
    expect(screen.getByText("Database Safety disponible")).toBeTruthy();
    expect(screen.getByText("El resto del panel continúa disponible.", { exact: false })).toBeTruthy();
  });

  it("isolates a Health 500 while Imports and Database Safety remain visible", async () => {
    vi.stubGlobal("fetch", mockModules({ health: 500 }));
    render(<AdminDevPage />);

    expect(await screen.findByTestId("module-health-error")).toBeTruthy();
    expect(await screen.findByTestId("module-imports-success")).toBeTruthy();
    expect(screen.queryByText("Acceso denegado")).toBeNull();
    expect(screen.getByText("synthetic.xlsx")).toBeTruthy();
    expect(screen.getByText("Database Safety disponible")).toBeTruthy();
  });

  it.each([401, 403])("shows access denied only for an auth status %s", async (status) => {
    vi.stubGlobal("fetch", mockModules({ health: status }));
    render(<AdminDevPage />);

    expect(await screen.findByText("Acceso denegado")).toBeTruthy();
    expect(screen.getByText("Sesión Super Admin Dev requerida.")).toBeTruthy();
  });

  it("retries only the failed Imports module", async () => {
    let importsCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const name = moduleForUrl(String(input));
      if (name === "imports") importsCalls += 1;
      return response(name, name === "imports" && importsCalls === 1 ? 500 : 200);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminDevPage />);

    expect(await screen.findByTestId("module-imports-error")).toBeTruthy();
    const retryButtons = screen.getAllByRole("button", { name: "Reintentar Importaciones" });
    fireEvent.click(retryButtons[0]);

    await waitFor(() => expect(screen.getByTestId("module-imports-success")).toBeTruthy());
    expect(importsCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});
