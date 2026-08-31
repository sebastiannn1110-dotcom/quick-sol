import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthContext = vi.fn();
const logAuditEvent = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext, logAuditEvent }));

function context(email: string, avatarPath: string | null = null) {
  return {
    user: null,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Jason Boss \u2014 DEMO",
      email,
      avatar_path: avatarPath
    },
    supabase: {
      rpc: vi.fn(),
      storage: { from: vi.fn() }
    },
    isDemoMode: false,
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/profile/avatar",
      traceId: "trace",
      requestId: "request"
    }
  };
}

describe("/api/profile/avatar permanent Jason initial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never exposes Jason's stale stored avatar path", async () => {
    getAuthContext.mockResolvedValue(context("JASONBOSS@QUIKSOL.COM", "stale/jason.webp"));
    const { GET } = await import("../route");

    const response = await GET(new Request("https://app.test/api/profile/avatar"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ avatarPath: null, avatarUrl: null });
  });

  it("blocks Jason's upload before parsing or writing the file", async () => {
    const auth = context("jasonBoss@quiksol.com");
    getAuthContext.mockResolvedValue(auth);
    const { POST } = await import("../route");

    const response = await POST(new Request("https://app.test/api/profile/avatar", { method: "POST" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "El avatar permanente de esta cuenta demo es J." });
    expect(auth.supabase.storage.from).not.toHaveBeenCalled();
    expect(auth.supabase.rpc).not.toHaveBeenCalled();
  });

  it("keeps the normal upload validation path for every other employee", async () => {
    getAuthContext.mockResolvedValue(context("maya.torres@quiksol.demo.invalid"));
    const { POST } = await import("../route");

    const response = await POST(new Request("https://app.test/api/profile/avatar", { method: "POST" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Selecciona una imagen." });
  });
});
