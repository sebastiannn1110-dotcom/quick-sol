import { NextResponse } from "next/server";
import { clearSuperadminCookie, requireSuperadmin } from "@/lib/superadmin/auth";
import { logger } from "@/lib/logger/logger";
import { requestIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  await logger.audit({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: new URL(request.url).pathname,
    method: request.method,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown",
    module: "security",
    action: "superadmin_logout",
    message: "Superadmin logged out.",
    status: "completed"
  });
  const response = NextResponse.json({ ok: true });
  clearSuperadminCookie(response);
  return response;
}
