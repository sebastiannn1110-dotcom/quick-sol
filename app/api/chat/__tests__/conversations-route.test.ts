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
      route: "/api/chat/conversations",
      traceId: "trace-id",
      requestId: "request-id"
    }
  };
}

describe("GET /api/chat/conversations", () => {
  const logger = createLoggerMock();
  const getAuthContext = vi.fn();
  const logAuditEvent = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext, logAuditEvent }));
  });

  it("returns a clear migration error when chat tables are missing", async () => {
    const missingError = {
      code: "PGRST205",
      message: "Could not find the table 'public.chat_conversation_members' in the schema cache"
    };
    const membersBuilder = {
      select: vi.fn(() => membersBuilder),
      eq: vi.fn(async () => ({ data: null, error: missingError }))
    };
    const supabase = { from: vi.fn(() => membersBuilder) };
    getAuthContext.mockResolvedValue(createContext(supabase));

    const { GET } = await import("../conversations/route");
    const response = await GET(new Request("https://app.test/api/chat/conversations"));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toContain("chat interno");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "chat_conversations_membership_load_failed",
      metadata: expect.objectContaining({ requiredMigration: "20260629000000_enterprise_mvp.sql" })
    }));
  });
});
