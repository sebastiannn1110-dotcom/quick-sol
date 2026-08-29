import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { hashCommerceShareToken } from "@/lib/commerce/auth";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { getCommerceQuote, publicQuotePayload } from "@/lib/commerce/service";
import { checkRateLimit, requestIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const rate = checkRateLimit({ key: `commerce-public-quote:${requestIp(request)}`, limit: 120, windowMs: 60_000 });
  if (!rate.allowed) return commerceError(429, "RATE_LIMITED", "Too many quote link requests.");
  const token = (await params).token.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return commerceError(404, "NOT_FOUND", "The quote link is invalid or expired.");
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return commerceError(503, "DATABASE_NOT_CONFIGURED", "Public quote links are not configured.");
  const { data: share, error } = await service
    .from("commerce_quote_shares")
    .select("quote_id,expires_at")
    .eq("token_hash", hashCommerceShareToken(token))
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !share) return commerceError(404, "NOT_FOUND", "The quote link is invalid or expired.");
  try {
    const quote = await getCommerceQuote(service, share.quote_id);
    if (!quote || !["sent", "accepted", "rejected", "expired"].includes(quote.status)) {
      return commerceError(404, "NOT_FOUND", "The quote link is invalid or expired.");
    }
    return commerceNoStore({ quote: publicQuotePayload(quote), expiresAt: share.expires_at });
  } catch {
    return commerceError(404, "NOT_FOUND", "The quote link is invalid or expired.");
  }
}
