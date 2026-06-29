import { logger } from "@/lib/logger/logger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export async function logPublicSecurityEvent(input: {
  traceId: string;
  requestId?: string;
  route: string;
  eventType: string;
  severity: "low" | "medium" | "high" | "critical";
  ipAddress: string;
  userAgent: string;
  metadata?: Record<string, unknown>;
}) {
  await logger.security({
    traceId: input.traceId,
    requestId: input.requestId,
    route: input.route,
    module: "security",
    action: input.eventType,
    message: `Public security event recorded: ${input.eventType}`,
    status: "failed",
    metadata: input.metadata
  });

  const service = createSupabaseServiceRoleClient();
  if (!service) return;
  await service.from("security_events").insert({
    trace_id: input.traceId,
    event_type: input.eventType,
    severity: input.severity,
    route: input.route,
    ip_address: input.ipAddress,
    user_agent: input.userAgent,
    metadata: input.metadata ?? null
  });
}
