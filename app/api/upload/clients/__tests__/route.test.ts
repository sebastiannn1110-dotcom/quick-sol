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
    for (const method of ["select", "like", "eq", "is", "order", "limit"]) builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
    return builder;
  }

  it("lists exactly 19 active demo companies using their real client ids", async () => {
    const clients = Array.from({ length: 19 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: index === 0 ? "Amazon-demo" : `Demo company ${index + 1}`
    }));
    const query = queryResult(clients);
    const from = vi.fn(() => query);
    getAuthContext.mockResolvedValue({
      profile: { id: "actor", role: "manager" },
      supabase: { from },
      isDemoMode: false
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/upload/clients"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients });
    expect(from).toHaveBeenCalledWith("clients");
    expect((query.select as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("id,name");
    expect((query.like as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("external_customer_id", "DEMO-%");
    expect((query.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("status", "active");
    expect((query.is as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("archived_at", null);
    expect((query.limit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(20);
  });

  it("fails closed unless the active demo scope contains exactly 19 companies", async () => {
    const query = queryResult([{ id: "4168a214-6675-463c-8c36-a23b0a8d0bee", name: "amazon" }]);
    getAuthContext.mockResolvedValue({
      profile: { id: "actor", role: "manager" },
      supabase: { from: vi.fn(() => query) },
      isDemoMode: false
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/upload/clients"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Demo upload client scope is incomplete." });
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
