import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  buildSuperadminHealth: vi.fn(async () => ({})),
  buildTrafficAnalytics: vi.fn(async () => ({})),
  buildSuperadminSecurity: vi.fn(async () => ({})),
  buildSuperadminImports: vi.fn(async () => ({})),
  buildSuperadminAi: vi.fn(async () => ({})),
  buildSuperadminChat: vi.fn(async () => ({}))
}));

vi.mock("@/lib/superadmin/auth", () => ({
  requireSuperadmin: mocks.requireSuperadmin,
  superadminConfigStatus: () => ({}),
  superadminJson: (body: unknown, init?: ResponseInit) => NextResponse.json(body, init)
}));

vi.mock("@/lib/superadmin/metrics", () => ({
  buildSuperadminHealth: mocks.buildSuperadminHealth,
  buildSuperadminSecurity: mocks.buildSuperadminSecurity,
  buildSuperadminImports: mocks.buildSuperadminImports,
  buildSuperadminAi: mocks.buildSuperadminAi,
  buildSuperadminChat: mocks.buildSuperadminChat
}));

vi.mock("@/lib/traffic/analytics", () => ({
  buildTrafficAnalytics: mocks.buildTrafficAnalytics
}));

import { GET as health } from "@/app/api/superadmin/health/route";
import { GET as traffic } from "@/app/api/superadmin/traffic/route";
import { GET as security } from "@/app/api/superadmin/security/route";
import { GET as imports } from "@/app/api/superadmin/imports/route";
import { GET as ai } from "@/app/api/superadmin/ai/route";
import { GET as chat } from "@/app/api/superadmin/chat/route";
import { POST as legacyLogin } from "@/app/api/superadmin/login/route";

const routes = [
  ["health", health],
  ["traffic", traffic],
  ["security", security],
  ["imports", imports],
  ["ai", ai],
  ["chat", chat]
] as const;

describe("/api/superadmin authorization contract", () => {
  beforeEach(() => mocks.requireSuperadmin.mockReset());

  it.each(routes)("returns 401 for an unauthenticated %s request", async (_name, handler) => {
    mocks.requireSuperadmin.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    const response = await handler(new Request("https://app.test/api/superadmin/health"));
    expect(response.status).toBe(401);
  });

  it.each(routes)("returns 403 for an authenticated non-superadmin %s request", async (_name, handler) => {
    mocks.requireSuperadmin.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    const response = await handler(new Request("https://app.test/api/superadmin/health"));
    expect(response.status).toBe(403);
  });

  it.each(routes)("returns 200 for an authenticated Super Admin Dev %s request", async (_name, handler) => {
    mocks.requireSuperadmin.mockResolvedValue({ service: {} });
    const response = await handler(new Request("https://app.test/api/superadmin/health"));
    expect(response.status).toBe(200);
  });

  it("keeps the parallel login endpoint disabled", async () => {
    const response = await legacyLogin(new Request("https://app.test/api/superadmin/login", { method: "POST" }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: "SUPERADMIN_PARALLEL_LOGIN_DISABLED", loginPath: "/login" });
  });
});
