import { beforeEach, describe, expect, it, vi } from "vitest";

const ownerId = "10000000-0000-4000-8000-000000000001";
const supabase = { from: vi.fn() };
const getAuthContext = vi.fn();
const listOwnedConversations = vi.fn();
const createOwnedConversation = vi.fn();

describe("/api/ai/conversations ownership contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAuthContext.mockResolvedValue({
      profile: { id: ownerId },
      supabase,
      isDemoMode: false
    });
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/ai/conversation-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/ai/conversation-memory")>(
        "@/lib/ai/conversation-memory"
      );
      return {
        ...actual,
        listOwnedConversations,
        createOwnedConversation
      };
    });
  });

  it("always lists with the authenticated profile id", async () => {
    listOwnedConversations.mockResolvedValue([]);
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://app.test/api/ai/conversations?userId=20000000-0000-4000-8000-000000000002")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(listOwnedConversations).toHaveBeenCalledWith(supabase, ownerId, 30);
  });

  it("degrades to an empty optional history when the memory migration is missing", async () => {
    const { ConversationMemoryError } = await import("@/lib/ai/conversation-memory");
    listOwnedConversations.mockRejectedValue(
      new ConversationMemoryError("Synthetic migration missing", "migration_required")
    );
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/ai/conversations"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: [],
      persistenceAvailable: false
    });
  });

  it("rejects attempts to supply a different user id in the create body", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://app.test/api/ai/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Synthetic QA",
          language: "es",
          userId: "20000000-0000-4000-8000-000000000002"
        })
      })
    );

    expect(response.status).toBe(422);
    expect(createOwnedConversation).not.toHaveBeenCalled();
  });

  it("creates using the authenticated profile id", async () => {
    createOwnedConversation.mockResolvedValue({ id: "30000000-0000-4000-8000-000000000003" });
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://app.test/api/ai/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Synthetic QA", language: "en" })
      })
    );

    expect(response.status).toBe(201);
    expect(createOwnedConversation).toHaveBeenCalledWith(supabase, ownerId, {
      title: "Synthetic QA",
      language: "en"
    });
  });
});
