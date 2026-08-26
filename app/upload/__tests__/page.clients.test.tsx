// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UploadPage from "@/app/upload/page";
import { LanguageProvider } from "@/components/LanguageProvider";

vi.mock("@/components/UploadExcelCard", () => ({
  default: ({ client }: { client: { id: string; name: string } | null }) => (
    <div data-testid="upload-card-client">{client?.name ?? "NO_CLIENT"}</div>
  )
}));
vi.mock("@/components/ColumnMapper", () => ({ default: () => <div /> }));
vi.mock("@/components/UploadHistory", () => ({ default: () => <div /> }));

function jsonResponse(payload: unknown) {
  return { ok: true, json: vi.fn(async () => payload) } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("global upload client selector", () => {
  it("preselects an accessible company from the client page link and supports name search", async () => {
    const googleId = "20000000-0000-4000-8000-000000000001";
    const amazonId = "20000000-0000-4000-8000-000000000002";
    window.history.replaceState({}, "", `/upload?clientId=${googleId}`);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/upload") return Promise.resolve(jsonResponse({ uploads: [] }));
      if (String(input) === "/api/upload/clients") return Promise.resolve(jsonResponse({
        clients: [{ id: googleId, name: "Google" }, { id: amazonId, name: "Amazon" }]
      }));
      throw new Error(`Unexpected request: ${String(input)}`);
    }));

    render(<LanguageProvider><UploadPage /></LanguageProvider>);

    expect(await screen.findByText("¿A qué empresa quieres subir estos archivos?")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("upload-card-client").textContent).toBe("Google"));

    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar empresa" }), { target: { value: "Amazon" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Empresa" }), { target: { value: amazonId } });
    expect(screen.getByTestId("upload-card-client").textContent).toBe("Amazon");
  });

  it("does not trust an inaccessible clientId from the URL", async () => {
    window.history.replaceState({}, "", "/upload?clientId=20000000-0000-4000-8000-000000000099");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/upload") return Promise.resolve(jsonResponse({ uploads: [] }));
      if (String(input) === "/api/upload/clients") return Promise.resolve(jsonResponse({
        clients: [{ id: "20000000-0000-4000-8000-000000000001", name: "Google" }]
      }));
      throw new Error(`Unexpected request: ${String(input)}`);
    }));

    render(<LanguageProvider><UploadPage /></LanguageProvider>);

    await waitFor(() => expect(screen.getByTestId("upload-card-client").textContent).toBe("NO_CLIENT"));
    expect((screen.getByRole("combobox", { name: "Empresa" }) as HTMLSelectElement).value).toBe("");
  });
});
