import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const UPLOAD_ID = "00000000-0000-4000-8000-000000000010";
const CLIENT_ID = "00000000-0000-4000-8000-000000000020";

describe("POST /api/business-summary/rebuild", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each(["employee", "manager", "admin", "super_admin_dev"])(
    "uses the authenticated user client for %s without a service-role bypass",
    async (role) => {
      const rpc = vi.fn(async () => ({
        data: { requestedCount: 1, status: "queued" },
        error: null
      }));
      vi.doMock("@/lib/auth/context", () => ({
        getAuthContext: vi.fn(async () => ({
          profile: { id: "actor", role },
          supabase: { rpc },
          isDemoMode: false
        }))
      }));
      const route = await import("../route");
      const response = await route.POST(new Request("https://app.test/api/business-summary/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadBatchId: UPLOAD_ID, clientId: CLIENT_ID })
      }));

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ requestedCount: 1, status: "queued" });
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(rpc).toHaveBeenCalledWith("request_business_summary_rebuild_v2", {
        input_upload_batch_id: UPLOAD_ID,
        input_client_id: CLIENT_ID
      });
    }
  );

  it("rejects malformed or additional scope fields before calling PostgreSQL", async () => {
    const rpc = vi.fn();
    vi.doMock("@/lib/auth/context", () => ({
      getAuthContext: vi.fn(async () => ({ profile: { id: "actor" }, supabase: { rpc }, isDemoMode: false }))
    }));
    const route = await import("../route");
    const response = await route.POST(new Request("https://app.test/api/business-summary/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "not-a-uuid", serviceRole: true })
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errorCode: "SUMMARY_REBUILD_SCOPE_INVALID" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("preserves authentication failures and does not touch the RPC", async () => {
    const authResponse = NextResponse.json({ error: "Authentication required" }, { status: 401 });
    vi.doMock("@/lib/auth/context", () => ({
      getAuthContext: vi.fn(async () => authResponse)
    }));
    const route = await import("../route");
    const response = await route.POST(new Request("https://app.test/api/business-summary/rebuild", {
      method: "POST",
      body: "{}"
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("fails closed and sanitizes a grant denial", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "private detail" } }));
    vi.doMock("@/lib/auth/context", () => ({
      getAuthContext: vi.fn(async () => ({ profile: { id: "actor" }, supabase: { rpc }, isDemoMode: false }))
    }));
    const route = await import("../route");
    const response = await route.POST(new Request("https://app.test/api/business-summary/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ errorCode: "SUMMARY_REBUILD_FORBIDDEN" });
  });
});
