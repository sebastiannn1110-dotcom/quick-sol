import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSuperadmin: vi.fn()
}));

vi.mock("@/lib/superadmin/auth", () => ({
  CRITICAL_CACHE_CONTROL: "private, no-store",
  assertCriticalSameOrigin: () => null,
  challengeHash: (value: string) => value,
  createDestructionChallenge: () => "synthetic-challenge",
  reauthenticateSuperAdmin: vi.fn(async () => false),
  requireSuperadmin: mocks.requireSuperadmin,
  superadminConfigStatus: () => ({}),
  superadminIpHash: () => null,
  superadminJson: (body: unknown, init?: ResponseInit) => NextResponse.json(body, init),
  superadminSessionBinding: vi.fn(async () => null)
}));

import { POST as arm } from "@/app/api/admindev/database-safety/arm/route";
import { POST as createBackup } from "@/app/api/admindev/database-safety/backups/route";
import { POST as downloadBackup } from "@/app/api/admindev/database-safety/backups/[id]/download/route";
import { GET as downloadManifest } from "@/app/api/admindev/database-safety/backups/[id]/manifest/route";
import { POST as verifyBackup } from "@/app/api/admindev/database-safety/backups/[id]/verify/route";
import { POST as dryRun } from "@/app/api/admindev/database-safety/dry-run/route";
import { POST as execute } from "@/app/api/admindev/database-safety/execute/route";
import { POST as cancel } from "@/app/api/admindev/database-safety/operations/[id]/cancel/route";
import { GET as status } from "@/app/api/admindev/database-safety/status/route";

const id = "00000000-0000-4000-8000-000000000001";
const routes = [
  ["status", (request: Request) => status(request)],
  ["dry-run", (request: Request) => dryRun(request)],
  ["create backup", (request: Request) => createBackup(request)],
  ["verify", (request: Request) => verifyBackup(request, { params: Promise.resolve({ id }) })],
  ["download", (request: Request) => downloadBackup(request, { params: Promise.resolve({ id }) })],
  ["manifest", (request: Request) => downloadManifest(request, { params: Promise.resolve({ id }) })],
  ["arm/reauth", (request: Request) => arm(request)],
  ["cancel", (request: Request) => cancel(request, { params: Promise.resolve({ id }) })],
  ["execute", (request: Request) => execute(request)]
] as const;

describe("Database Safety endpoint role matrix", () => {
  beforeEach(() => mocks.requireSuperadmin.mockReset());

  it.each(routes)("returns 401 for anonymous access to %s", async (_name, handler) => {
    mocks.requireSuperadmin.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    const response = await handler(new Request("https://app.test/api/admindev/database-safety/test", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it.each(["employee", "manager", "admin"] as const)("returns 403 for %s on every endpoint", async (role) => {
    mocks.requireSuperadmin.mockResolvedValue(NextResponse.json({ error: "Forbidden", role }, { status: 403 }));
    for (const [, handler] of routes) {
      const response = await handler(new Request("https://app.test/api/admindev/database-safety/test", { method: "POST" }));
      expect(response.status).toBe(403);
    }
  });
});
