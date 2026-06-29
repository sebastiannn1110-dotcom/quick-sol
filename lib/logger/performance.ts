import type { LogContext, LogModule } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";
import { sanitizeForLog } from "@/lib/logger/sanitize";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";

async function persistPerformanceLog(
  operation: string,
  module: LogModule,
  context: LogContext,
  durationMs: number,
  status: "completed" | "failed",
  metadata?: Record<string, unknown>
) {
  if (typeof window !== "undefined") return;
  if ("EdgeRuntime" in globalThis) return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const service = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      serverSupabaseClientOptions()
    );

    await service.from("performance_logs").insert({
      trace_id: context.traceId,
      request_id: context.requestId ?? null,
      operation,
      module,
      duration_ms: durationMs,
      status,
      metadata: sanitizeForLog(metadata ?? {})
    });
  } catch {
    // Performance logging must never block the business flow.
  }
}

export async function measureAsync<T>(
  operationName: string,
  module: LogModule,
  context: LogContext,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
  options?: { slowThresholdMs?: number; slowAction?: string }
): Promise<T> {
  const startedAt = performance.now();
  const slowThresholdMs = options?.slowThresholdMs ?? 1500;
  await logger.info({
    ...context,
    module,
    action: `${operationName}_started`,
    message: `${operationName} started`,
    status: "started",
    metadata
  });

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - startedAt);
    await logger.info({
      ...context,
      module,
      action: `${operationName}_completed`,
      message: `${operationName} completed`,
      status: "completed",
      durationMs,
      metadata
    });

    if (durationMs > slowThresholdMs) {
      await persistPerformanceLog(operationName, module, context, durationMs, "completed", metadata);
      await logger.warn({
        ...context,
        module,
        action: options?.slowAction ?? "slow_operation_detected",
        message: `${operationName} took longer than expected`,
        status: "completed",
        durationMs,
        metadata
      });
    } else {
      await persistPerformanceLog(operationName, module, context, durationMs, "completed", metadata);
    }

    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    await persistPerformanceLog(operationName, module, context, durationMs, "failed", metadata);
    await logger.error({
      ...context,
      module,
      action: `${operationName}_failed`,
      message: `${operationName} failed`,
      status: "failed",
      durationMs,
      metadata,
      error
    });
    throw error;
  }
}
