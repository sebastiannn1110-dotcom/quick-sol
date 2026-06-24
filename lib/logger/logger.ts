import type { LogEvent, LogLevel, PersistableLogEvent } from "@/lib/logger/types";
import { sanitizeError, sanitizeForLog } from "@/lib/logger/sanitize";

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

async function persistSystemLog(event: PersistableLogEvent) {
  if (typeof window !== "undefined") return;
  if ("EdgeRuntime" in globalThis) return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const service = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
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
