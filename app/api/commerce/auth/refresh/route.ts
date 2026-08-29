import { NextResponse } from "next/server";
import {
  authenticateCommerceToken,
  commerceSessionPayload,
  createCommerceSupabaseClient
} from "@/lib/commerce/auth";
import { commerceRefreshSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = commerceRefreshSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return commerceError(400, "VALIDATION_ERROR", "A refresh token is required.");
  }
  const supabase = createCommerceSupabaseClient();
  if (!supabase) {
    return commerceError(503, "DATABASE_NOT_CONFIGURED", "Commerce authentication is not configured.");
  }
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: parsed.data.refreshToken });
  if (error || !data.session?.access_token || !data.session.refresh_token) {
    return commerceError(401, "SESSION_EXPIRED", "The employee session cannot be refreshed.");
  }
  const context = await authenticateCommerceToken(data.session.access_token);
  if (context instanceof NextResponse) return context;
  return commerceNoStore({
    session: commerceSessionPayload(
      context,
      data.session.expires_at ? new Date(data.session.expires_at * 1000).toISOString() : null
    ),
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token
  });
}
