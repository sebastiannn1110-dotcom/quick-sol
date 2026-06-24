import type { SupabaseClient } from "@supabase/supabase-js";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";

type SupabasePromise<T> = PromiseLike<{ data: T | null; error: { code?: string; message: string } | null; count?: number | null }>;

async function runSupabaseOperation<T>(
  operation: string,
  table: string,
  context: LogContext,
  fn: () => SupabasePromise<T>,
  metadata?: Record<string, unknown>
) {
  const startedAt = performance.now();
  await logger.debug({
    ...context,
    module: "supabase",
    action: `supabase_${operation}_started`,
    message: `Supabase ${operation} started`,
    status: "started",
    metadata: { table, ...metadata }
  });

  const result = await fn();
  const durationMs = Math.round(performance.now() - startedAt);

  if (result.error) {
    await logger.error({
      ...context,
      module: "supabase",
      action: `supabase_${operation}_failed`,
      message: `Supabase ${operation} failed`,
      status: "failed",
      durationMs,
      metadata: { table, ...metadata, code: result.error.code },
      error: result.error
    });
  } else {
    await logger.debug({
      ...context,
      module: "supabase",
      action: `supabase_${operation}_completed`,
      message: `Supabase ${operation} completed`,
      status: "completed",
      durationMs,
      metadata: { table, count: result.count, ...metadata }
    });
  }

  return result;
}

export function safeInsert<T>(
  supabase: SupabaseClient,
  table: string,
  payload: unknown,
  context: LogContext,
  metadata?: Record<string, unknown>
) {
  return runSupabaseOperation<T>("insert", table, context, () => supabase.from(table).insert(payload as never), metadata);
}

export function safeUpdate<T>(
  supabase: SupabaseClient,
  table: string,
  payload: unknown,
  context: LogContext,
  filter: (query: ReturnType<SupabaseClient["from"]>) => SupabasePromise<T>,
  metadata?: Record<string, unknown>
) {
  return runSupabaseOperation<T>(
    "update",
    table,
    context,
    () => filter(supabase.from(table).update(payload as never) as never),
    metadata
  );
}

export function safeQuery<T>(
  table: string,
  context: LogContext,
  fn: () => SupabasePromise<T>,
  metadata?: Record<string, unknown>
) {
  return runSupabaseOperation<T>("query", table, context, fn, metadata);
}

export async function safeStorageUpload(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  file: File,
  context: LogContext,
  options?: { contentType?: string; cacheControl?: string; upsert?: boolean }
) {
  const startedAt = performance.now();
  await logger.info({
    ...context,
    module: "supabase",
    action: "supabase_storage_upload_started",
    message: "Supabase storage upload started",
    status: "started",
    metadata: { bucket, path, fileSize: file.size, contentType: options?.contentType }
  });

  const result = await supabase.storage.from(bucket).upload(path, file, options);
  const durationMs = Math.round(performance.now() - startedAt);

  if (result.error) {
    await logger.error({
      ...context,
      module: "supabase",
      action: "supabase_storage_upload_failed",
      message: "Supabase storage upload failed",
      status: "failed",
      durationMs,
      metadata: { bucket, path },
      error: result.error
    });
  } else {
    await logger.info({
      ...context,
      module: "supabase",
      action: "supabase_storage_upload_completed",
      message: "Supabase storage upload completed",
      status: "completed",
      durationMs,
      metadata: { bucket, path }
    });
  }

  return result;
}
