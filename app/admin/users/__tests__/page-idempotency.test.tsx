// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminUsersPage from "@/app/admin/users/page";

vi.mock("@/components/AdminGuard", () => ({
  default: ({ children }: { children: ReactNode }) => children
}));
vi.mock("@/components/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key })
}));
vi.mock("@/components/ProfileProvider", () => ({
  useProfile: () => ({ profile: { role: "admin" } })
}));
vi.mock("@/components/chat/UserAvatar", () => ({
  default: () => <span aria-hidden="true" />
}));

const OPERATION_KEY = "00000000-0000-4000-8000-000000000840";

function openAndFillCreateForm() {
  fireEvent.click(screen.getByRole("button", { name: "Create Employee" }));
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Retry Employee" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "retry@example.test" } });
}

function submitButton() {
  return screen.getAllByRole("button", { name: "Create Employee" }).at(-1)!;
}

describe("admin user creation idempotency UI", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => OPERATION_KEY) });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the same operation key across a network failure and explicit retry", async () => {
    let postAttempt = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ users: [] });
      postAttempt += 1;
      if (postAttempt === 1) throw new TypeError("response lost");
      return Response.json({
        created: true,
        reused: true,
        recovered: true,
        provisioningStatus: "completed",
        user: { id: "00000000-0000-4000-8000-000000000006", role: "employee", is_active: true },
        temporaryPasswordAvailable: false
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminUsersPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    openAndFillCreateForm();
    fireEvent.click(submitButton());

    await screen.findByText(/result is uncertain/i);
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("retry@example.test");

    fireEvent.click(submitButton());
    await screen.findByText(/creation recovered from a retry/i);
    expect(screen.getByText(/temporary password cannot be recovered/i)).toBeTruthy();

    const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls).toHaveLength(2);
    for (const [, init] of postCalls) {
      expect(init?.headers).toEqual(expect.objectContaining({ "Idempotency-Key": OPERATION_KEY }));
    }
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps the operation key and form after a retryable HTTP response", async () => {
    let postAttempt = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ users: [] });
      postAttempt += 1;
      if (postAttempt === 1) {
        return Response.json(
          { error: "uncertain", code: "PROVISIONING_RETRYABLE" },
          { status: 503, headers: { "Retry-After": "2" } }
        );
      }
      return Response.json({
        created: true,
        reused: true,
        recovered: true,
        provisioningStatus: "completed",
        user: { id: "00000000-0000-4000-8000-000000000006", role: "employee", is_active: true },
        temporaryPasswordAvailable: false
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminUsersPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    openAndFillCreateForm();
    fireEvent.click(submitButton());

    await screen.findByText(/result is uncertain/i);
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("retry@example.test");
    fireEvent.click(submitButton());
    await screen.findByText(/creation recovered from a retry/i);

    const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[0][1]?.headers).toEqual(expect.objectContaining({ "Idempotency-Key": OPERATION_KEY }));
    expect(postCalls[1][1]?.headers).toEqual(expect.objectContaining({ "Idempotency-Key": OPERATION_KEY }));
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("uses a synchronous lock while the visual submit and close controls are disabled", async () => {
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ users: [] });
      return pendingPost;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminUsersPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    openAndFillCreateForm();
    const form = screen.getByLabelText("Email").closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Creating..." }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect((screen.getByRole("button", { name: "table.close" }) as HTMLButtonElement).disabled).toBe(true);
    const backgroundCreate = screen.getByRole("button", { name: "Create Employee" }) as HTMLButtonElement;
    expect(backgroundCreate.disabled).toBe(true);
    fireEvent.click(backgroundCreate);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    resolvePost(Response.json({
      created: true,
      reused: false,
      recovered: false,
      provisioningStatus: "completed",
      user: { id: "00000000-0000-4000-8000-000000000006", role: "employee", is_active: true },
      temporaryPasswordAvailable: true,
      temporaryPassword: "one-response-only"
    }));

    await screen.findByText(/Temporary password: one-response-only/i);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
