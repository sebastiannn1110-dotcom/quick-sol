import { createHash } from "node:crypto";
import type { AuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";

export type AiLogStatus = "started" | "completed" | "failed";

export interface SafeAiLogMetadata {
  intent?: string | null;
  language?: "es" | "en" | "zh";
  tool?: string | null;
  scope?: "own" | "team" | "company" | null;
  channel?: "text" | "voice";
  durationMs?: number;
  rowCount?: number;
  characterCount?: number;
  provider?: "openai" | "elevenlabs" | "supabase" | "deterministic";
  model?: string;
  state?: string;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  fallbackUsed?: boolean;
  droppedFieldCount?: number;
  timeout?: boolean;
}

const SAFE_METADATA_KEYS = new Set<keyof SafeAiLogMetadata>([
  "intent",
  "language",
  "tool",
  "scope",
  "channel",
  "durationMs",
  "rowCount",
  "characterCount",
  "provider",
  "model",
  "state",
  "errorCode",
  "inputTokens",
  "outputTokens",
  "fallbackUsed",
  "droppedFieldCount",
  "timeout"
]);

export function hashAiUser(userId: string) {
  return createHash("sha256")
    .update(`quiksol-ai-user:${userId}`)
    .digest("hex")
    .slice(0, 24);
}

export function sanitizeQuestionForLogs(question: string) {
  return {
    characterCount: Array.from(question).length
  };
}

export function safeAiErrorCode(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
    const name = typeof record.name === "string" ? record.name.toUpperCase() : "";
    const status = typeof record.status === "number" ? record.status : 0;
    if (name === "ABORTERROR" || code === "ABORT_ERR") return "cancelled";
    if (code === "57014" || code.includes("TIMEOUT") || name.includes("TIMEOUT")) return "timeout";
    if (status === 401) return "unauthenticated";
    if (status === 403) return "permission_denied";
    if (status === 404) return "not_found";
    if (status === 413) return "payload_too_large";
    if (status === 429) return "rate_limited";
    if (status === 503) return "provider_not_configured";
  }
  return "operation_failed";
}

export function sanitizeAiLogMetadata(metadata: SafeAiLogMetadata = {}) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key, value]) => SAFE_METADATA_KEYS.has(key as keyof SafeAiLogMetadata) && value !== undefined)
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 100) : value
      ])
  ) as SafeAiLogMetadata;
}

export async function logSafeAiEvent(
  context: AuthContext,
  input: {
    action: string;
    status: AiLogStatus;
    metadata?: SafeAiLogMetadata;
    durationMs?: number;
    error?: unknown;
  }
) {
  const level = input.status === "failed" ? "warn" : "info";
  const errorCode = input.error ? safeAiErrorCode(input.error) : input.metadata?.errorCode;
  return logger[level]({
    traceId: context.requestMeta.traceId,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "ai",
    action: input.action.slice(0, 120),
    message: "AI operation event.",
    status: input.status,
    durationMs: input.durationMs,
    metadata: {
      userHash: hashAiUser(context.profile.id),
      ...sanitizeAiLogMetadata({
        ...input.metadata,
        errorCode
      })
    }
  });
}
