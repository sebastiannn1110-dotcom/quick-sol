import type { LogContext } from "@/lib/logger/types";
import { requestIp } from "@/lib/security/rateLimit";

export const TRACE_HEADER = "x-quiksol-trace-id";
export const REQUEST_HEADER = "x-quiksol-request-id";

export function createTraceId() {
  return crypto.randomUUID();
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function getLoggerContextFromRequest(request: Request): LogContext {
  const url = new URL(request.url);
  const traceId = request.headers.get(TRACE_HEADER) || createTraceId();
  const requestId = request.headers.get(REQUEST_HEADER) || createRequestId();

  return {
    traceId,
    requestId,
    route: url.pathname,
    method: request.method,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown"
  };
}

export function mergeLogContext(base: LogContext, next?: Partial<LogContext>): LogContext {
  return {
    ...base,
    ...next,
    traceId: next?.traceId ?? base.traceId,
    requestId: next?.requestId ?? base.requestId
  };
}
