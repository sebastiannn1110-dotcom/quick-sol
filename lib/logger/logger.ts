import type { LogEvent, LogLevel, PersistableLogEvent } from "@/lib/logger/types";
import { sanitizeError, sanitizeForLog } from "@/lib/logger/sanitize";
import { getSupabaseServiceRoleKey } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";

function color(level: LogLevel) {
  if (level === "error" || level === "fatal") return "\x1b[31m";
  if (level === "warn" || level === "security") return "\x1b[33m";
  if (level === "audit") return "\x1b[36m";
  if (level === "debug") return "\x1b[90m";
  return "\x1b[32m";
}

function normalizeEvent(event: LogEvent): PersistableLogEvent {
  return {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
    environment: process.env.NODE_ENV ?? "development",
    service: "quiksol-data-platform",
    metadata: event.metadata ? (sanitizeForLog(event.metadata) as Record<string, unknown>) : undefined,
    error: event.error ? sanitizeError(event.error) : undefined
  };
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  audit: 25,
  warn: 30,
  security: 35,
  error: 40,
  fatal: 50
};

function configuredLogLevel() {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (raw in LOG_LEVEL_PRIORITY) return raw as LogLevel;
  return "info";
}

function shouldLog(event: PersistableLogEvent) {
  if (event.level === "debug" && process.env.ENABLE_VERBOSE_IMPORT_LOGS !== "true" && process.env.ENABLE_WORKER_DEBUG_LOGS !== "true" && configuredLogLevel() !== "debug") {
    return false;
  }
  return LOG_LEVEL_PRIORITY[event.level] >= LOG_LEVEL_PRIORITY[configuredLogLevel()];
}

async function persistSystemLog(event: PersistableLogEvent) {
  if (typeof window !== "undefined") return;
  if ("EdgeRuntime" in globalThis) return;
  const serviceRoleKey = getSupabaseServiceRoleKey();
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !serviceRoleKey) return;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const service = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey,
      serverSupabaseClientOptions()
    );

    await service.from("system_logs").insert({
      trace_id: event.traceId,
      request_id: event.requestId ?? null,
      level: event.level,
      module: event.module,
      action: event.action,
      message: event.message,
      user_id: event.userId ?? null,
      user_email: event.userEmail ?? null,
      user_role: event.userRole ?? null,
      route: event.route ?? null,
      method: event.method ?? null,
      status: event.status ?? null,
      duration_ms: event.durationMs ?? null,
      upload_batch_id: event.uploadBatchId ?? null,
      file_name: event.fileName ?? null,
      sheet_name: event.sheetName ?? null,
      row_index: event.rowIndex ?? null,
      column_name: event.columnName ?? null,
      category: event.category ?? null,
      metadata: event.metadata ?? null,
      error: event.error ?? null
    });
  } catch {
    // Logging must never break the user flow.
  }
}

export async function logEvent(event: LogEvent) {
  const normalized = normalizeEvent(event);
  if (!shouldLog(normalized)) return normalized;
  const line = JSON.stringify(normalized);

  if (process.env.NODE_ENV === "development") {
    const reset = "\x1b[0m";
    // Centralized console output is intentional; direct console.* elsewhere should use logger.
    console.log(`${color(normalized.level)}${line}${reset}`);
  } else {
    console.log(line);
  }

  if (["warn", "error", "fatal", "security", "audit"].includes(normalized.level)) {
    await persistSystemLog(normalized);
  }

  return normalized;
}

function levelLogger(level: LogLevel) {
  return (event: Omit<LogEvent, "level">) => logEvent({ ...event, level });
}

export const logger = {
  debug: levelLogger("debug"),
  info: levelLogger("info"),
  warn: levelLogger("warn"),
  error: levelLogger("error"),
  fatal: levelLogger("fatal"),
  security: levelLogger("security"),
  audit: levelLogger("audit")
};
