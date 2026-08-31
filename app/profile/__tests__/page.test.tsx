/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/types";
import ProfilePage from "../page";

const state = vi.hoisted(() => ({
  profile: null as Profile | null,
  refreshProfile: vi.fn(async () => undefined)
}));

vi.mock("@/components/ProfileProvider", () => ({
  useProfile: () => ({
    profile: state.profile,
    loading: false,
    refreshProfile: state.refreshProfile
  })
}));

function profile(overrides: Partial<Profile>): Profile {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    full_name: "Maya Torres \u2014 DEMO",
    email: "maya.torres@quiksol.demo.invalid",
    role: "employee",
    department: "Sales \u2014 DEMO",
    region: "Americas \u2014 DEMO",
    avatar_path: "/demo/people/maya.webp",
    is_active: true,
    created_at: "2026-08-29T00:00:00.000Z",
    updated_at: "2026-08-29T00:00:00.000Z",
    ...overrides
  };
}

beforeEach(() => {
  state.refreshProfile.mockClear();
});

afterEach(cleanup);

describe("ProfilePage avatar controls", () => {
  it("shows only J and no upload controls for Jason even with a stale path", () => {
    state.profile = profile({
      full_name: "Jason Boss \u2014 DEMO",
      email: "JASONBOSS@QUIKSOL.COM",
      avatar_path: "/demo/people/jason.webp"
    });

    render(<ProfilePage />);

    expect(screen.getByText("J")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Jason Boss/ })).toBeNull();
    expect(screen.queryByLabelText(/Nueva foto/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Actualizar foto" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar foto actual" })).toBeNull();
    expect(screen.getByText("El avatar permanente de esta cuenta demo es J.")).toBeTruthy();
  });

  it("keeps photo controls and the configured image for another employee", () => {
    state.profile = profile({});

    render(<ProfilePage />);

    expect(screen.getByRole("img", { name: /Maya Torres/ })).toBeTruthy();
    expect(screen.getByLabelText(/Nueva foto/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actualizar foto" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Eliminar foto actual" })).toBeTruthy();
  });
});
