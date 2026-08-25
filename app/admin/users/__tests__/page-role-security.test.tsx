// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminUsersPage from "@/app/admin/users/page";
import type { UserRole } from "@/lib/types";

const mocks = vi.hoisted(() => ({ currentRole: "admin" as UserRole }));

vi.mock("@/components/AdminGuard", () => ({
  default: ({ children }: { children: ReactNode }) => children
}));
vi.mock("@/components/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key })
}));
vi.mock("@/components/ProfileProvider", () => ({
  useProfile: () => ({ profile: { role: mocks.currentRole } })
}));
vi.mock("@/components/chat/UserAvatar", () => ({
  default: () => <span aria-hidden="true" />
}));

const privilegedProfile = {
  id: "00000000-0000-4000-8000-000000000099",
  full_name: "Privileged Profile",
  email: "privileged@example.test",
  role: "super_admin_dev" as const,
  department: null,
  region: null,
  is_active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString()
};

describe("admin users privileged role UI", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ users: [privilegedProfile] })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mocks.currentRole = "admin";
  });

  it("does not offer a normal admin controls for a Super Admin Dev profile", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("Privileged Profile");

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "admin.deactivate" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Employee" }));
    expect(screen.queryByRole("option", { name: "Super Admin Dev" })).toBeNull();
  });

  it("offers the explicit privileged role only to Super Admin Dev", async () => {
    mocks.currentRole = "super_admin_dev";
    render(<AdminUsersPage />);
    await screen.findByText("Privileged Profile");

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "admin.deactivate" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Employee" }));
    expect(screen.getByRole("option", { name: "Super Admin Dev" })).toBeTruthy();
  });
});
