import type { SupabaseClient } from "@supabase/supabase-js";
import { getEmailProvider } from "@/lib/email/email-service";
import { SECURITY_LIMITS, getSupabaseServiceRoleKey } from "@/lib/security/env";
import { DEFAULT_UPLOAD_BUCKET } from "@/lib/upload/diagnostics";

type Row = Record<string, unknown>;

function text(row: Row, key: string, fallback = "") {
  const value = row[key];
  return typeof value === "string" && value ? value : fallback;
}

function numberValue(row: Row, key: string) {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export async function buildSuperadminHealth(service: SupabaseClient) {
  const staleCutoff = new Date(Date.now() - SECURITY_LIMITS.workerStaleAfterMinutes * 60 * 1000).toISOString();
  const [
    queued,
    processing,
    failed,
    completed,
    stuck,
    latestHeartbeat,
    recentTechnicalErrors,
    storageBucket
  ] = await Promise.all([
    service.from("import_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "retrying"]),
    service.from("import_jobs").select("id", { count: "exact", head: true }).eq("status", "processing"),
    service.from("import_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
    service.from("import_jobs").select("id", { count: "exact", head: true }).in("status", ["completed", "completed_with_warnings"]),
    service.from("import_jobs").select("id,original_file_name,heartbeat_at,locked_at").eq("status", "processing").lt("heartbeat_at", staleCutoff).limit(10),
    service.from("import_jobs").select("heartbeat_at,worker_id,original_file_name").not("heartbeat_at", "is", null).order("heartbeat_at", { ascending: false }).limit(1).maybeSingle(),
    service.from("system_logs").select("created_at,action,message,route,level").in("level", ["error", "fatal"]).order("created_at", { ascending: false }).limit(10),
    service.storage.getBucket(process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_UPLOAD_BUCKET)
  ]);

  const heartbeatAt = latestHeartbeat.data ? text(latestHeartbeat.data as Row, "heartbeat_at") : null;
  const workerStale = !heartbeatAt || new Date(heartbeatAt).getTime() < Date.now() - SECURITY_LIMITS.workerStaleAfterMinutes * 60 * 1000;
  const alerts = [
    workerStale ? "Worker sin heartbeat reciente." : null,
    (stuck.data?.length ?? 0) > 0 ? "Hay jobs processing atascados." : null,
    (failed.count ?? 0) > 0 ? `${failed.count} jobs fallidos acumulados.` : null,
    storageBucket.error ? "Bucket de Storage no accesible." : null
  ].filter(Boolean);

  return {
    web: { status: "ok" },
    worker: {
      status: workerStale ? "stale" : "ok",
      heartbeatAt,
      workerId: latestHeartbeat.data ? text(latestHeartbeat.data as Row, "worker_id") : null,
      staleAfterMinutes: SECURITY_LIMITS.workerStaleAfterMinutes
    },
    jobs: {
      queued: queued.count ?? 0,
      processing: processing.count ?? 0,
      failed: failed.count ?? 0,
      completed: completed.count ?? 0,
      stuck: stuck.data ?? []
    },
    providers: {
      supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && getSupabaseServiceRoleKey()) ? "configured" : "missing",
      storage: storageBucket.error ? "failed" : "ok",
      bucket: process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_UPLOAD_BUCKET,
      openai: process.env.OPEN_IA || process.env.OPENAI_API_KEY ? "configured" : "missing",
      openaiModel: process.env.OPENAI_MODEL || "gpt-5.5",
      elevenlabs: process.env.ELEVENLABS_API_KEY ? "configured" : "missing",
      email: getEmailProvider()
    },
    recentTechnicalErrors: recentTechnicalErrors.data ?? [],
    alerts
  };
}

export async function buildSuperadminSecurity(service: SupabaseClient) {
  const since = hoursAgo(24);
  const [securityEvents, failedLogins, unauthorized, roleChanges] = await Promise.all([
    service.from("security_events").select("created_at,event_type,severity,actor_email,route,ip_address,user_agent,metadata").gte("created_at", since).order("created_at", { ascending: false }).limit(100),
    service.from("system_logs").select("created_at,action,user_email,ip_address,user_agent,metadata").ilike("action", "%login_failed%").gte("created_at", since).order("created_at", { ascending: false }).limit(100),
    service.from("system_logs").select("created_at,action,route,user_email,ip_address,status_code,message").or("status_code.eq.401,status_code.eq.403,action.ilike.%permission%,action.ilike.%unauthorized%").gte("created_at", since).order("created_at", { ascending: false }).limit(100),
    service.from("audit_logs").select("created_at,actor_email,action,entity_type,entity_id,metadata").or("action.ilike.%role%,action.ilike.%user%").gte("created_at", since).order("created_at", { ascending: false }).limit(50)
  ]);

  return {
    securityEvents: securityEvents.data ?? [],
    failedLogins: failedLogins.data ?? [],
    unauthorizedRequests: unauthorized.data ?? [],
    roleChanges: roleChanges.data ?? [],
    suspiciousIps: summarizeByIp([...(securityEvents.data ?? []), ...(failedLogins.data ?? []), ...(unauthorized.data ?? [])] as Row[])
  };
}

export async function buildSuperadminImports(service: SupabaseClient) {
  const [jobsResult, activeRecords, archivedRecords] = await Promise.all([
    service
      .from("import_jobs")
      .select("id,upload_batch_id,status,original_file_name,total_rows,processed_rows,successful_rows,failed_rows,warning_count,rows_with_warnings,technical_error_count,worker_id,heartbeat_at,created_at,finished_at,last_error,error_message")
      .order("created_at", { ascending: false })
      .limit(50),
    service.from("business_records").select("id", { count: "exact", head: true }).is("archived_at", null),
    service.from("business_records").select("id", { count: "exact", head: true }).not("archived_at", "is", null)
  ]);
  const { data, error } = jobsResult;
  if (error) throw error;
  if (activeRecords.error) throw activeRecords.error;
  if (archivedRecords.error) throw archivedRecords.error;
  return {
    jobs: data ?? [],
    summary: {
      queued: (data ?? []).filter((job) => job.status === "queued" || job.status === "retrying").length,
      processing: (data ?? []).filter((job) => job.status === "processing").length,
      completedWithWarnings: (data ?? []).filter((job) => job.status === "completed_with_warnings").length,
      failed: (data ?? []).filter((job) => job.status === "failed").length,
      activeBusinessRecords: activeRecords.count ?? 0,
      archivedBusinessRecords: archivedRecords.count ?? 0
    }
  };
}

export async function buildSuperadminAi(service: SupabaseClient) {
  const since = hoursAgo(24);
  const { data, error } = await service
    .from("system_logs")
    .select("created_at,level,action,message,duration_ms,user_email,metadata,error")
    .eq("module", "ai")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const logs = (data ?? []) as Row[];
  const durations = logs.map((row) => numberValue(row, "duration_ms")).filter((value) => value > 0);
  return {
    env: {
      hasOpenIa: Boolean(process.env.OPEN_IA),
      hasOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "gpt-5.5"
    },
    total: logs.length,
    failures: logs.filter((row) => ["error", "fatal"].includes(text(row, "level"))).length,
    averageResponseMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    logs
  };
}

export async function buildSuperadminChat(service: SupabaseClient) {
  const since = hoursAgo(24);
  const [messages, conversations, attachments, logs] = await Promise.all([
    service.from("chat_messages").select("id", { count: "exact", head: true }).gte("created_at", since),
    service.from("chat_conversations").select("id", { count: "exact", head: true }),
    service.from("chat_attachments").select("id", { count: "exact", head: true }).gte("created_at", since),
    service.from("system_logs").select("created_at,level,action,message,user_email,route,metadata").eq("module", "chat").gte("created_at", since).order("created_at", { ascending: false }).limit(100)
  ]);

  return {
    messagesLast24h: messages.count ?? 0,
    activeConversations: conversations.count ?? 0,
    attachmentsLast24h: attachments.count ?? 0,
    errors: (logs.data ?? []).filter((row) => ["error", "fatal", "security"].includes(row.level ?? "")),
    logs: logs.data ?? []
  };
}

function summarizeByIp(rows: Row[]) {
  const map = new Map<string, { ip: string; events: number; lastSeenAt: string; routes: Set<string> }>();
  for (const row of rows) {
    const ip = text(row, "ip_address", "unknown");
    const existing = map.get(ip) ?? { ip, events: 0, lastSeenAt: text(row, "created_at"), routes: new Set<string>() };
    existing.events += 1;
    existing.routes.add(text(row, "route", "unknown"));
    if (text(row, "created_at") > existing.lastSeenAt) existing.lastSeenAt = text(row, "created_at");
    map.set(ip, existing);
  }
  return Array.from(map.values()).map((item) => ({ ip: item.ip, events: item.events, lastSeenAt: item.lastSeenAt, routes: item.routes.size })).sort((a, b) => b.events - a.events).slice(0, 20);
}
