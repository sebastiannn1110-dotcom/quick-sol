import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";

const { routeAssistantDatabaseQuery } = vi.hoisted(() => ({
  routeAssistantDatabaseQuery: vi.fn(async () => ({
    permissionDenied: false,
    intent: "stock",
    confidence: 1,
    ambiguous: false,
    plan: {
      intent: "stock",
      confidence: 1,
      tool: "getStockNeedsSummary",
      answerMode: "list",
      language: "en",
      entity: "stock",
      metric: null,
      mpn: null,
      requiresClarification: false,
      policyDecision: "allow"
    },
    toolResult: {
      ok: true,
      tool: "getStockNeedsSummary",
      scope: "own",
      total: 3,
      rows: [],
      data: {
        items: [],
        totals: { inStock: 2, partialStock: 1, noStock: 0 }
      },
      summary: "Synthetic internal summary.",
      empty: false,
      truncated: false,
      deterministic: true
    }
  }))
}));

vi.mock("@/lib/ai/ai-query-router", () => ({ routeAssistantDatabaseQuery }));
vi.mock("@/lib/logger/logger", () => ({
  logger: {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined)
  }
}));

const context = {
  user: null,
  supabase: null,
  isDemoMode: true,
  profile: {
    id: "10000000-0000-4000-8000-000000000001",
    full_name: "Synthetic Performance User",
    email: "performance@example.test",
    role: "employee",
    department: "QA",
    region: "Synthetic",
    is_active: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  },
  requestMeta: {
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    route: "/api/assistant",
    traceId: "internal-trace",
    requestId: "internal-request"
  }
} as AuthContext;

describe("simulated deterministic assistant performance", () => {
  beforeAll(() => {
    delete process.env.OPEN_IA;
    delete process.env.OPENAI_API_KEY;
  });

  it("keeps simulated simple-query P95 below two seconds with bounded public output", async () => {
    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const durations: number[] = [];
    const outputSizes: number[] = [];

    for (let index = 0; index < 25; index += 1) {
      const startedAt = performance.now();
      const result = await answerAssistantQuestion({
        context,
        message: "Which parts have stock available?",
        language: "en",
        channel: "text"
      });
      durations.push(performance.now() - startedAt);
      outputSizes.push(JSON.stringify(result).length);
    }

    const sorted = [...durations].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
    expect(p95).toBeLessThan(2_000);
    expect(Math.max(...outputSizes)).toBeLessThan(4_000);
    expect(routeAssistantDatabaseQuery).toHaveBeenCalledTimes(25);
  });
});
