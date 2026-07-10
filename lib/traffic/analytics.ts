import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

export type TrafficRange = "today" | "yesterday" | "7d" | "30d";

export interface TrafficAnalytics {
  range: {
    key: TrafficRange;
    from: string;
    to: string;
  };
  summary: {
    totalVisits: number;
    approximateUniqueVisitors: number;
    loggedInUsers: number;
    anonymousVisits: number;
    totalRequests: number;
    successfulRequests: number;
    errors4xx: number;
    errors5xx: number;
    averageResponseMs: number;
    lastVisitAt: string | null;
  };
  visitsByHour: Array<{ bucket: string; visits: number }>;
  visitsByDay: Array<{ bucket: string; visits: number }>;
  topRoutes: Array<{ route: string; visits: number; uniqueUsers: number; averageResponseMs: number; errors: number }>;
  activeUsers: Array<{ userId: string; email: string; role: string; lastActivityAt: string; requests: number; routesUsed: number; uploads: number; errors: number }>;
  topIps: Array<{ ip: string; userAgent: string; requests: number; firstVisitAt: string; lastVisitAt: string; routes: number }>;
  importantEvents: Array<{ createdAt: string; action: string; route: string | null; userEmail: string | null; status: string | null; message: string }>;
  recentErrors: Array<{ createdAt: string; action: string; route: string | null; statusCode: number | null; message: string; userEmail: string | null }>;
}

const IMPORTANT_ACTIONS = new Set([
  "login_success",
  "login_failed",
  "logout",
  "upload_started",
  "upload_ui_started",
  "upload_ui_completed",
  "job_queued",
  "processing_started",
  "processing_completed",
  "ai_request_received",
  "ai_response_completed",
  "chat_message_sent",
  "admin_page_viewed",
  "role_guard_failed",
  "failed_permission_check",
  "analytics_failed"
]);

export function trafficDateRange(key: string | null | undefined): { key: TrafficRange; from: Date; to: Date } {
  const now = new Date();
  const normalized = key === "today" || key === "yesterday" || key === "30d" ? key : "7d";
  const from = new Date(now);
  const to = new Date(now);

  if (normalized === "today") {
    from.setHours(0, 0, 0, 0);
  } else if (normalized === "yesterday") {
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() - 1);
    to.setHours(23, 59, 59, 999);
  } else {
    from.setDate(from.getDate() - (normalized === "30d" ? 30 : 7));
  }

  return { key: normalized, from, to };
}

function text(row: Row, key: string, fallback = "") {
  const value = row[key];
  return typeof value === "string" && value ? value : fallback;
}

function numberValue(row: Row, key: string) {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function createdAt(row: Row) {
  return text(row, "created_at") || new Date(0).toISOString();
}

function hourBucket(value: string) {
  const date = new Date(value);
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

function dayBucket(value: string) {
  return new Date(value).toISOString().slice(0, 10);
}

function increment(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function topEntries<T>(items: T[], count = 12) {
  return items.slice(0, count);
}

export async function buildTrafficAnalytics(supabase: SupabaseClient, rangeKey?: string | null): Promise<TrafficAnalytics> {
  const range = trafficDateRange(rangeKey);
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();

  const [clientLogs, systemLogs, uploads] = await Promise.all([
    supabase
      .from("client_logs")
      .select("id,created_at,level,action,message,user_id,route,ip_address,user_agent,metadata")
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase
      .from("system_logs")
      .select("id,created_at,level,module,action,message,user_id,user_email,user_role,route,method,status,status_code,duration_ms,ip_address,user_agent,metadata")
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase
      .from("upload_batches")
      .select("id,uploaded_by,created_at,status")
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .limit(5000)
  ]);

  if (clientLogs.error) throw clientLogs.error;
  if (systemLogs.error) throw systemLogs.error;
  if (uploads.error) throw uploads.error;

  const pageViews = ((clientLogs.data ?? []) as Row[]).filter((row) => text(row, "action") === "page_view");
  const requests = (systemLogs.data ?? []) as Row[];
  const uploadRows = (uploads.data ?? []) as Row[];
  const allEvents = [...pageViews, ...requests].sort((a, b) => createdAt(b).localeCompare(createdAt(a)));
  const uniqueUsers = new Set<string>();
  const uniqueVisitors = new Set<string>();
  const uploadsByUser = new Map<string, number>();
  const routeStats = new Map<string, { visits: number; users: Set<string>; duration: number; durationCount: number; errors: number }>();
  const userStats = new Map<string, { email: string; role: string; lastActivityAt: string; requests: number; routes: Set<string>; errors: number }>();
  const ipStats = new Map<string, { userAgent: string; requests: number; firstVisitAt: string; lastVisitAt: string; routes: Set<string> }>();
  const visitsHour = new Map<string, number>();
  const visitsDay = new Map<string, number>();

  for (const upload of uploadRows) {
    const userId = text(upload, "uploaded_by");
    if (userId) increment(uploadsByUser, userId);
  }

  for (const event of allEvents) {
    const route = text(event, "route", "unknown");
    const userId = text(event, "user_id");
    const userEmail = text(event, "user_email", userId || "anonymous");
    const userRole = text(event, "user_role", "unknown");
    const ip = text(event, "ip_address", userId ? `user:${userId}` : "anonymous");
    const userAgent = text(event, "user_agent", "unknown");
    const eventCreatedAt = createdAt(event);
    const statusCode = numberValue(event, "status_code");
    const isError = statusCode >= 400 || text(event, "status") === "failed" || ["error", "fatal", "security"].includes(text(event, "level"));

    if (userId) {
      uniqueUsers.add(userId);
      uniqueVisitors.add(userId);
      const existing = userStats.get(userId) ?? { email: userEmail, role: userRole, lastActivityAt: eventCreatedAt, requests: 0, routes: new Set<string>(), errors: 0 };
      existing.requests += 1;
      existing.routes.add(route);
      if (isError) existing.errors += 1;
      if (eventCreatedAt > existing.lastActivityAt) existing.lastActivityAt = eventCreatedAt;
      userStats.set(userId, existing);
    } else {
      uniqueVisitors.add(ip);
    }

    const routeExisting = routeStats.get(route) ?? { visits: 0, users: new Set<string>(), duration: 0, durationCount: 0, errors: 0 };
    routeExisting.visits += 1;
    if (userId) routeExisting.users.add(userId);
    const duration = numberValue(event, "duration_ms");
    if (duration > 0) {
      routeExisting.duration += duration;
      routeExisting.durationCount += 1;
    }
    if (isError) routeExisting.errors += 1;
    routeStats.set(route, routeExisting);

    const ipExisting = ipStats.get(ip) ?? { userAgent, requests: 0, firstVisitAt: eventCreatedAt, lastVisitAt: eventCreatedAt, routes: new Set<string>() };
    ipExisting.requests += 1;
    ipExisting.routes.add(route);
    if (eventCreatedAt < ipExisting.firstVisitAt) ipExisting.firstVisitAt = eventCreatedAt;
    if (eventCreatedAt > ipExisting.lastVisitAt) ipExisting.lastVisitAt = eventCreatedAt;
    ipStats.set(ip, ipExisting);
  }

  for (const visit of pageViews) {
    increment(visitsHour, hourBucket(createdAt(visit)));
    increment(visitsDay, dayBucket(createdAt(visit)));
  }

  const statusCodes = requests.map((row) => numberValue(row, "status_code")).filter(Boolean);
  const durations = requests.map((row) => numberValue(row, "duration_ms")).filter((value) => value > 0);
  const errors5xx = statusCodes.filter((statusCode) => statusCode >= 500).length + requests.filter((row) => text(row, "level") === "fatal").length;
  const errors4xx = statusCodes.filter((statusCode) => statusCode >= 400 && statusCode < 500).length + requests.filter((row) => text(row, "action").includes("permission") || text(row, "action").includes("unauthorized")).length;

  return {
    range: { key: range.key, from: fromIso, to: toIso },
    summary: {
      totalVisits: pageViews.length,
      approximateUniqueVisitors: uniqueVisitors.size,
      loggedInUsers: uniqueUsers.size,
      anonymousVisits: pageViews.filter((row) => !text(row, "user_id")).length,
      totalRequests: requests.length,
      successfulRequests: Math.max(0, requests.length - errors4xx - errors5xx),
      errors4xx,
      errors5xx,
      averageResponseMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      lastVisitAt: allEvents[0] ? createdAt(allEvents[0]) : null
    },
    visitsByHour: Array.from(visitsHour.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([bucket, visits]) => ({ bucket, visits })),
    visitsByDay: Array.from(visitsDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([bucket, visits]) => ({ bucket, visits })),
    topRoutes: topEntries(Array.from(routeStats.entries())
      .map(([route, value]) => ({
        route,
        visits: value.visits,
        uniqueUsers: value.users.size,
        averageResponseMs: value.durationCount ? Math.round(value.duration / value.durationCount) : 0,
        errors: value.errors
      }))
      .sort((a, b) => b.visits - a.visits)),
    activeUsers: topEntries(Array.from(userStats.entries())
      .map(([userId, value]) => ({
        userId,
        email: value.email,
        role: value.role,
        lastActivityAt: value.lastActivityAt,
        requests: value.requests,
        routesUsed: value.routes.size,
        uploads: uploadsByUser.get(userId) ?? 0,
        errors: value.errors
      }))
      .sort((a, b) => b.requests - a.requests)),
    topIps: topEntries(Array.from(ipStats.entries())
      .map(([ip, value]) => ({ ip, userAgent: value.userAgent, requests: value.requests, firstVisitAt: value.firstVisitAt, lastVisitAt: value.lastVisitAt, routes: value.routes.size }))
      .sort((a, b) => b.requests - a.requests)),
    importantEvents: topEntries(requests
      .filter((row) => IMPORTANT_ACTIONS.has(text(row, "action")) || text(row, "level") === "security")
      .map((row) => ({ createdAt: createdAt(row), action: text(row, "action"), route: text(row, "route") || null, userEmail: text(row, "user_email") || null, status: text(row, "status") || null, message: text(row, "message") }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), 20),
    recentErrors: topEntries(requests
      .filter((row) => numberValue(row, "status_code") >= 500 || ["error", "fatal"].includes(text(row, "level")))
      .map((row) => ({ createdAt: createdAt(row), action: text(row, "action"), route: text(row, "route") || null, statusCode: numberValue(row, "status_code") || null, message: text(row, "message"), userEmail: text(row, "user_email") || null }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), 20)
  };
}
