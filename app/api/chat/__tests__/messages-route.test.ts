import { beforeEach, describe, expect, it, vi } from "vitest";

const profile = {
  id: "00000000-0000-4000-8000-000000000003",
  full_name: "Employee C",
  email: "c@quiksol.local",
  role: "employee",
  department: "Sales",
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
      route: "/api/chat/conversations/00000000-0000-4000-8000-000000000001/messages",
      traceId: "trace-id",
      requestId: "request-id"
    }
  };
}

describe("GET /api/chat/conversations/[id]/messages", () => {
  const getAuthContext = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  });

  it("blocks a user who is not a member of the conversation", async () => {
    const membershipBuilder = {
      select: vi.fn(() => membershipBuilder),
      eq: vi.fn(() => membershipBuilder),
      maybeSingle: vi.fn(async () => ({ data: null, error: null }))
    };
    const supabase = { from: vi.fn(() => membershipBuilder) };
    getAuthContext.mockResolvedValue(createContext(supabase));

    const { GET } = await import("../conversations/[id]/messages/route");
    const response = await GET(
      new Request("https://app.test/api/chat/conversations/00000000-0000-4000-8000-000000000001/messages"),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toContain("No perteneces");
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });
});
