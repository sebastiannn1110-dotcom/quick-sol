// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "@/components/Sidebar";
import RoleGuard from "@/components/RoleGuard";
import type { Profile, UserRole } from "@/lib/types";

const mocks = vi.hoisted(() => ({ role: "employee" as UserRole }));

vi.mock("next/navigation", () => ({ usePathname: () => "/clients" }));
vi.mock("@/components/LanguageProvider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ProfileProvider", () => ({
  useProfile: () => ({
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Synthetic User",
      email: "user@example.test",
      role: mocks.role,
      department: null,
      region: null,
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    loading: false
  })
}));

function profile(role: UserRole): Profile {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    full_name: "Synthetic User",
    email: "user@example.test",
    role,
    department: null,
    region: null,
    is_active: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}

afterEach(() => {
  cleanup();
  mocks.role = "employee";
});

describe("role navigation and client guards", () => {
  it("shows both Admin and Super Admin Dev navigation to super_admin_dev", () => {
    render(<Sidebar profile={profile("super_admin_dev")} />);
    expect(screen.getByText("nav.admin")).toBeTruthy();
    expect(screen.getByText("nav.superAdminDev")).toBeTruthy();
  });

  it("shows Admin but not Super Admin Dev navigation to a normal admin", () => {
    render(<Sidebar profile={profile("admin")} />);
    expect(screen.getByText("nav.admin")).toBeTruthy();
    expect(screen.queryByText("nav.superAdminDev")).toBeNull();
  });

  it("lets super_admin_dev satisfy an admin guard", () => {
    mocks.role = "super_admin_dev";
    render(<RoleGuard allowedRoles={["admin"]}><span>admin content</span></RoleGuard>);
    expect(screen.getByText("admin content")).toBeTruthy();
  });

  it("does not let admin satisfy a Super Admin Dev guard", () => {
    mocks.role = "admin";
    render(<RoleGuard allowedRoles={["super_admin_dev"]}><span>super content</span></RoleGuard>);
    expect(screen.queryByText("super content")).toBeNull();
    expect(screen.getByText("guard.denied")).toBeTruthy();
  });
});
