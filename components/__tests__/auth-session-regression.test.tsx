// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginForm from "@/components/LoginForm";
import LogoutButton from "@/components/LogoutButton";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  loginFailed: vi.fn(),
  loginSuccess: vi.fn(),
  logout: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      signOut: mocks.signOut
    }
  })
}));
vi.mock("@/lib/logger/clientLogger", () => ({
  clientLogger: {
    loginFailed: mocks.loginFailed,
    loginSuccess: mocks.loginSuccess,
    logout: mocks.logout
  }
}));
vi.mock("@/components/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key })
}));
vi.mock("@/components/LanguageToggle", () => ({ default: () => null }));
vi.mock("@/components/BrandMark", () => ({ default: () => null }));

describe("login, logout and session UI regression", () => {
  beforeEach(() => {
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.logout.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      configured: true,
      supabaseUrl: "https://project.example.test",
      supabasePublishableKey: "synthetic-public-key"
    })));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves password login and the safe authenticated redirect", async () => {
    render(<LoginForm />);
    await waitFor(() => expect(
      (screen.getByRole("button", { name: "auth.signIn" }) as HTMLButtonElement).disabled
    ).toBe(false));

    fireEvent.change(screen.getByLabelText("auth.identifier"), {
      target: { value: "user.test.demo.com" }
    });
    fireEvent.change(screen.getByLabelText("auth.password"), {
      target: { value: ["synthetic", "login", "value"].join("-") }
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.signIn" }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/clients"));
    expect(fetch).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        identifier: "user.test.demo.com",
        password: "synthetic-login-value"
      })
    }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("preserves logout, local session removal and redirect to login", async () => {
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "auth.signOut" }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.replace).toHaveBeenCalledWith("/login");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
