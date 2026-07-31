import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSuperadminAi } from "@/lib/superadmin/metrics";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function metricsService(rows: Record<string, unknown>[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "order"]) {
    builder[method] = () => builder;
  }
  builder.limit = async () => ({ data: rows, error: null });
  return {
    from: () => builder
  } as unknown as SupabaseClient;
}

describe("sanitized AI observability", () => {
  it("counts info successes, warn failures, latency, tokens and dimensions", async () => {
    const metrics = await buildSuperadminAi(metricsService([
      {
        created_at: "2026-01-01T00:00:00Z",
        level: "info",
        action: "ai_text_started",
        status: "started",
        duration_ms: 0,
        metadata: { language: "es", channel: "text" }
      },
      {
        created_at: "2026-01-01T00:00:01Z",
        level: "info",
        action: "ai_text_done",
        status: "completed",
        duration_ms: 100,
        metadata: {
          language: "es",
          channel: "text",
          intent: "stock",
          tool: "getStockNeedsSummary",
          provider: "deterministic",
          inputTokens: 10,
          outputTokens: 5
        }
      },
      {
        created_at: "2026-01-01T00:00:02Z",
        level: "warn",
        action: "ai_llm_timeout",
        status: "failed",
        duration_ms: 300,
        metadata: {
          language: "en",
          channel: "voice",
          provider: "openai",
          timeout: true,
          fallbackUsed: true
        }
      }
    ]));

    expect(metrics).toMatchObject({
      total: 3,
      requests: 1,
      successes: 1,
      failures: 1,
      timeouts: 1,
      rateLimits: 0,
      fallbackUses: 1,
      averageResponseMs: 200,
      tokens: { input: 10, output: 5 },
      byIntent: { unknown: 2, stock: 1 },
      byProvider: { unknown: 1, deterministic: 1, openai: 1 },
      byLanguage: { es: 2, en: 1 },
      byChannel: { text: 2, voice: 1 }
    });
  });

  it("persists successful AI info events and defines unscheduled retention", () => {
    const logger = source("lib/logger/logger.ts");
    const migration = source("supabase/migrations/20260730123000_ai_observability_retention.sql");
    expect(logger).toContain('normalized.module === "ai" && normalized.level === "info"');
    expect(migration).toContain("purge_old_ai_system_logs");
    expect(migration).toContain("retention_days < 1 or retention_days > 365");
    expect(migration).toContain("No schedule is installed");
    expect(migration).not.toMatch(/cron\.schedule|pg_cron/);
  });
});
