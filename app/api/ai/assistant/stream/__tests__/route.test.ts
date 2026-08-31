import { beforeEach, describe, expect, it, vi } from "vitest";

const ownerId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000002";
const supabase = { from: vi.fn() };
const getAuthContext = vi.fn();
const checkPersistentRateLimit = vi.fn();
const answerAssistantQuestion = vi.fn();
const loadOwnedConversation = vi.fn();
const appendOwnedMessage = vi.fn();
class MockAssistantRequestError extends Error {}
class MockAssistantConfigError extends Error {}

function request(body: Record<string, unknown>, signal?: AbortSignal) {
  return new Request("https://app.test/api/ai/assistant/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
}

describe("POST /api/ai/assistant/stream", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAuthContext.mockResolvedValue({
      profile: { id: ownerId },
      supabase,
      isDemoMode: false,
      requestMeta: {}
    });
    checkPersistentRateLimit.mockResolvedValue({
      allowed: true,
      resetAt: Date.now() + 60_000
    });
    loadOwnedConversation.mockResolvedValue({
      conversation: { id: conversationId },
      messages: [],
      safeHistory: [{ role: "assistant", content: "Previous synthetic context" }]
    });
    appendOwnedMessage.mockResolvedValue({});
    answerAssistantQuestion.mockResolvedValue({
      intent: "getOpportunityFinderSummary",
      tool: "getOpportunityFinderSummary",
      answer: "Synthetic answer",
      answerText:
        "Synthetic answer 123e4567-e89b-42d3-a456-426614174000 /api/private/path",
      speechText:
        "Synthetic speech 123e4567-e89b-42d3-a456-426614174000 /storage/private/file",
      timings: { dataLookupMs: 10, llmMs: 12, totalMs: 22 },
      sourceType: "opportunity_finder",
      generatedWithAi: true,
      fallbackUsed: false
    });
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/security/persistent-rate-limit", () => ({ checkPersistentRateLimit }));
    vi.doMock("@/lib/security/rateLimit", () => ({
      rateLimitResponse: vi.fn(() => new Response(null, { status: 429 }))
    }));
    vi.doMock("@/lib/ai/assistantCore", () => ({
      answerAssistantQuestion,
      AssistantRequestError: MockAssistantRequestError,
      AssistantConfigError: MockAssistantConfigError
    }));
    vi.doMock("@/lib/ai/conversation-memory", async () => {
      const actual = await vi.importActual<typeof import("@/lib/ai/conversation-memory")>(
        "@/lib/ai/conversation-memory"
      );
      return {
        ...actual,
        loadOwnedConversation,
        appendOwnedMessage
      };
    });
  });

  it("emits ordered no-store progress and a sanitized completed event", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({
        message: "Show the synthetic opportunity summary",
        language: "en",
        conversationId
      })
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const stages = [...body.matchAll(/"stage":"([^"]+)"/g)].map((match) => match[1]);
    expect(stages).toEqual([
      "validating",
      "searching",
      "processing",
      "generating",
      "completed",
      "completed"
    ]);
    expect(body).toContain('"source":"Opportunity Finder"');
    expect(body).toContain('"basedOnData":true');
    expect(body).toContain('"generatedWithAi":true');
    expect(body).not.toContain("123e4567-e89b-42d3-a456-426614174000");
    expect(body).not.toContain("/api/private/path");
    expect(body).not.toContain("/storage/private/file");
    expect(body).not.toContain(conversationId);
    expect(body).not.toContain("toolResult");
    expect(appendOwnedMessage).toHaveBeenNthCalledWith(
      1,
      supabase,
      ownerId,
      conversationId,
      expect.objectContaining({ role: "user", sourceType: "user" })
    );
    expect(appendOwnedMessage).toHaveBeenNthCalledWith(
      2,
      supabase,
      ownerId,
      conversationId,
      expect.objectContaining({
        role: "assistant",
        sourceType: "opportunity_finder",
        content: expect.stringContaining("[redacted-id]")
      })
    );
    expect(answerAssistantQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [{ role: "assistant", content: "Previous synthetic context" }],
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("answers without loading or persisting memory when no conversation is supplied", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({
        message: "Show the stateless synthetic summary",
        language: "en"
      })
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: completed');
    expect(body).toContain('"answer":"Synthetic answer [redacted-id] [internal-path]"');
    expect(loadOwnedConversation).not.toHaveBeenCalled();
    expect(appendOwnedMessage).not.toHaveBeenCalled();
    expect(answerAssistantQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ history: [] })
    );
  });

  it("rejects an oversized message before invoking memory or the assistant", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({
        message: "x".repeat(2_001),
        language: "en",
        conversationId
      })
    );

    expect(response.status).toBe(413);
    expect(loadOwnedConversation).not.toHaveBeenCalled();
    expect(answerAssistantQuestion).not.toHaveBeenCalled();
  });

  it("emits a safe localized tool failure without leaking internal details", async () => {
    answerAssistantQuestion.mockRejectedValueOnce(
      new MockAssistantRequestError(
        "No pude consultar las métricas en este momento. 123e4567-e89b-42d3-a456-426614174000 /api/private"
      )
    );
    const { POST } = await import("../route");
    const response = await POST(request({
      message: "quien es el mejor vendedor",
      language: "es"
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: error");
    expect(body).toContain("No pude consultar las métricas en este momento.");
    expect(body).not.toContain("123e4567-e89b-42d3-a456-426614174000");
    expect(body).not.toContain("/api/private");
  });

  it("stops emitting and does not persist an assistant message after cancellation", async () => {
    let releaseAnswer: ((value: unknown) => void) | undefined;
    answerAssistantQuestion.mockImplementation(
      () => new Promise((resolve) => {
        releaseAnswer = resolve;
      })
    );
    const controller = new AbortController();
    const { POST } = await import("../route");
    const response = await POST(
      request(
        {
          message: "Cancel this synthetic request",
          language: "en",
          conversationId
        },
        controller.signal
      )
    );
    const bodyPromise = response.text();
    await vi.waitFor(() => expect(answerAssistantQuestion).toHaveBeenCalled());
    controller.abort();
    releaseAnswer?.({
      intent: "unused",
      tool: null,
      answerText: "Must not be persisted",
      speechText: "Must not be persisted",
      timings: { dataLookupMs: 0, llmMs: 0, totalMs: 0 }
    });
    const body = await bodyPromise;

    expect(body).not.toContain("Must not be persisted");
    expect(appendOwnedMessage).toHaveBeenCalledTimes(1);
  });
});
