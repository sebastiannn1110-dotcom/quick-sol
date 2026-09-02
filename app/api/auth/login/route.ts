import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveLoginIdentifier } from "@/lib/auth/demo-login";
import { logger } from "@/lib/logger/logger";
import { getLoggerContextFromRequest } from "@/lib/logger/context";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, requestIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024)
}).strict();

export async function POST(request: Request) {
  const context = getLoggerContextFromRequest(request);
  const ipAddress = requestIp(request);
  const rate = checkRateLimit({ key: `login:${ipAddress}`, limit: 10, windowMs: 10 * 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const email = resolveLoginIdentifier(parsed.data.identifier);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: parsed.data.password
  });

  if (error || !data.session || !data.user) {
    await logger.warn({
      ...context,
      module: "auth",
      action: "login_failed",
      message: "Login failed.",
      status: "failed",
      metadata: { identifier: parsed.data.identifier.trim().toLowerCase(), ipAddress }
    });
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  await logger.audit({
    ...context,
    userId: data.user.id,
    module: "auth",
    action: "login_success",
    message: "Login completed.",
    status: "completed",
    metadata: { identifier: parsed.data.identifier.trim().toLowerCase(), ipAddress }
  });

  return NextResponse.json({ ok: true });
}

