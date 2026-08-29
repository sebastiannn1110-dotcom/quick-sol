import { NextResponse } from "next/server";
import {
  authenticateCommerceToken,
  bearerToken,
  commerceSessionPayload,
  createCommerceSupabaseClient,
  requireCommerceAuth,
  revokeCommerceSession
} from "@/lib/commerce/auth";
import { commerceLoginSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { checkRateLimit, requestIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = commerceLoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return commerceError(400, "VALIDATION_ERROR", "A valid email and password are required.");
  }
  const rate = checkRateLimit({
    key: `commerce-login:${requestIp(request)}:${parsed.data.email}`,
    limit: 8,
    windowMs: 15 * 60 * 1000
  });
  if (!rate.allowed) {
    return commerceError(429, "RATE_LIMITED", "Too many login attempts. Try again later.", {
      retryAfterSeconds: Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))
    });
  }

  const supabase = createCommerceSupabaseClient();
  if (!supabase) {
    return commerceError(503, "DATABASE_NOT_CONFIGURED", "Commerce authentication is not configured.");
  }
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password
  });
  if (error || !data.session?.access_token || !data.session.refresh_token) {
    return commerceError(401, "AUTHENTICATION_FAILED", "The employee credentials are invalid.");
  }
  const context = await authenticateCommerceToken(data.session.access_token);
  if (context instanceof NextResponse) {
    await supabase.auth.signOut({ scope: "local" });
    return context;
  }
  return commerceNoStore({
    session: commerceSessionPayload(
      context,
      data.session.expires_at ? new Date(data.session.expires_at * 1000).toISOString() : null
    ),
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token
  }, { status: 201 });
}

export async function DELETE(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const token = bearerToken(request)!;
  const { error } = await revokeCommerceSession(token);
  if (error) return commerceError(503, "COMMERCE_UNAVAILABLE", "The employee session could not be closed.");
  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
