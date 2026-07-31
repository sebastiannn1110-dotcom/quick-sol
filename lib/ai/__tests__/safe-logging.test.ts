import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";

const { info } = vi.hoisted(() => ({ info: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger/logger", () => ({
  logger: { info, warn: vi.fn(async () => undefined) }
}));

describe("safe AI logs", () => {
  it("distinguishes user cancellation from timeouts", async () => {
    const { safeAiErrorCode } = await import("@/lib/ai/safe-logging");
    expect(safeAiErrorCode(new DOMException("Cancelled", "AbortError"))).toBe("cancelled");
    expect(safeAiErrorCode({ code: "57014" })).toBe("timeout");
  });

  it("keeps only the hashed user and allowlisted metrics", async () => {
    const { logSafeAiEvent, sanitizeQuestionForLogs } = await import("@/lib/ai/safe-logging");
    const context = {
      profile: {
        id: "10000000-0000-4000-8000-000000000001",
        email: "private@example.test",
        role: "manager"
      },
      requestMeta: {
        traceId: "trace-internal",
        route: "/api/assistant"
      }
    } as AuthContext;

    await logSafeAiEvent(context, {
      action: "ai_text_done",
      status: "completed",
      metadata: {
        intent: "stock",
        tool: "getStockNeedsSummary",
        language: "es",
        channel: "text",
        provider: "deterministic",
        rowCount: 4,
        ...sanitizeQuestionForLogs("MPN 000-AX9-07 private-file.xlsx private@example.test")
      }
    });

    const logged = info.mock.calls[0]?.[0];
    const serialized = JSON.stringify(logged);
    expect(logged).toMatchObject({
      traceId: "trace-internal",
      userRole: "manager",
      module: "ai",
      metadata: {
        intent: "stock",
        rowCount: 4,
        characterCount: 53
      }
    });
    expect(serialized).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("000-AX9-07");
    expect(serialized).not.toContain("private-file.xlsx");
    expect((logged?.metadata as Record<string, unknown>).userHash).toMatch(/^[a-f0-9]{24}$/);
  });
});
