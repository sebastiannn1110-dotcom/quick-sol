import { beforeEach, describe, expect, it, vi } from "vitest";

function createLoggerMock() {
  return {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    fatal: vi.fn(async () => undefined),
    security: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined)
  };
}

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  full_name: "Quiksol Admin",
  email: "admin@quiksol.local",
  role: "admin",
  department: "Operations",
  region: "Global",
  is_active: true,
  created_at: "2026-06-25T00:00:00.000Z",
  updated_at: "2026-06-25T00:00:00.000Z"
};

function createContext(supabase: unknown) {
  return {
    user: null,
    profile,
    supabase,
    isDemoMode: false,
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/chat/users",
      traceId: "trace-id",
      requestId: "request-id"
    }
  };
}

describe("GET /api/chat/users", () => {
  const logger = createLoggerMock();
  const getAuthContext = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  });

  it("falls back to profiles when the list_chat_users RPC is missing", async () => {
    const profilesBuilder = {
      select: vi.fn(() => profilesBuilder),
      eq: vi.fn(() => profilesBuilder),
      order: vi.fn(() => profilesBuilder),
      limit: vi.fn(() => profilesBuilder),
      or: vi.fn(async () => ({ data: [profile], error: null }))
    };
    const supabase = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "PGRST202", message: "Could not find the function public.list_chat_users(search_text)" }
      })),
      from: vi.fn(() => profilesBuilder)
    };
    getAuthContext.mockResolvedValue(createContext(supabase));

    const { GET } = await import("../users/route");
    const response = await GET(new Request("https://app.test/api/chat/users?q=admin"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.users).toEqual([expect.objectContaining({ email: "admin@quiksol.local" })]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      action: "chat_users_rpc_missing_fallback",
      metadata: expect.objectContaining({ requiredMigration: "20260629000000_enterprise_mvp.sql" })
    }));
  });
});
