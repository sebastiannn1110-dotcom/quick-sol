import type { SuperadminContext } from "@/lib/superadmin/auth";
import { superadminJson } from "@/lib/superadmin/auth";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";

const SAFE_DATABASE_CODES = [
  "SUPER_ADMIN_DEV_REQUIRED",
  "BACKUP_STALE",
  "BACKUP_INVALID",
  "BACKUP_NOT_VERIFIED",
  "CHALLENGE_INVALID",
  "CHALLENGE_EXPIRED",
  "CHALLENGE_ALREADY_USED",
  "COUNTDOWN_ACTIVE",
  "SESSION_CHANGED",
  "OPERATION_NOT_FOUND",
  "OPERATION_NOT_ARMED"
] as const;

export async function databaseSafetyRateLimit(
  context: SuperadminContext,
  action: string,
  limit: number,
  windowSeconds: number
) {
  const result = await checkPersistentRateLimit({
    action: `database_safety_${action}`,
    identifier: `${context.user.id}:${context.requestMeta.ipAddress}`,
    limit,
    windowSeconds,
    blockSeconds: windowSeconds
  });
  if (result.allowed) return null;
  return superadminJson(
    { error: "RATE_LIMITED", resetAt: result.resetAt },
    {
      status: 429,
      headers: { "Retry-After": `${Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))}` }
    }
  );
}

export function safeDatabaseError(error: unknown, fallback = "DATABASE_SAFETY_OPERATION_FAILED") {
  const message = typeof error === "object" && error && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : "";
  return SAFE_DATABASE_CODES.find((code) => message.includes(code)) ?? fallback;
}

export function databaseSafetyErrorResponse(error: unknown, fallback?: string) {
  const code = safeDatabaseError(error, fallback);
  const status = code === "SUPER_ADMIN_DEV_REQUIRED" || code === "CHALLENGE_INVALID" || code === "SESSION_CHANGED"
    ? 403
    : code === "OPERATION_NOT_FOUND"
      ? 404
      : 409;
  return superadminJson({ error: code, deleteLocked: true }, { status });
}

export async function loadDatabaseSafetySnapshot(context: SuperadminContext) {
  const { data, error } = await context.supabase.rpc("database_safety_current_snapshot");
  if (error || !data) throw error ?? new Error("DATABASE_SAFETY_SNAPSHOT_MISSING");
  return data as {
    dataVersion: number;
    schemaVersion: string;
    migrationVersion: string;
    tableCount: number;
    storageObjectCount: number | null;
    storageFilesIncluded: false;
    tables: Array<{
      schema: string;
      table: string;
      count: number | null;
      category: string;
      action: "DELETE" | "PRESERVE";
      reason: string;
    }>;
  };
}
