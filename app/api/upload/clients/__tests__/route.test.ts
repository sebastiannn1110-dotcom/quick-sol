import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("GET /api/upload/clients", () => {
  const getAuthContext = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  });

  function queryResult(data: unknown) {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order", "limit"]) builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
    return builder;
  }

  it("lists only the minimal id/name projection filtered by active scope", async () => {
    const query = queryResult([{ id: "20000000-0000-4000-8000-000000000001", name: "Google" }]);
    const from = vi.fn(() => query);
    getAuthContext.mockResolvedValue({
      profile: { id: "actor", role: "manager" },
      supabase: { from },
      isDemoMode: false
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/upload/clients"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: [{ id: "20000000-0000-4000-8000-000000000001", name: "Google" }] });
    expect(from).toHaveBeenCalledWith("clients");
    expect((query.select as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("id,name");
    expect((query.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("status", "active");
    expect((query.is as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("archived_at", null);
  });

  it("rejects a role that cannot assign client uploads", async () => {
    getAuthContext.mockResolvedValue({
      profile: { id: "actor", role: "employee" },
      supabase: { from: vi.fn() },
      isDemoMode: false
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/upload/clients"));

    expect(response.status).toBe(403);
  });

  it("preserves an authentication guard response", async () => {
    getAuthContext.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/upload/clients"));

    expect(response.status).toBe(401);
  });
});
