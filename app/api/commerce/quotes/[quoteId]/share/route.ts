import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createCommerceShareToken,
  hashCommerceShareToken,
  requireCommerceAuth
} from "@/lib/commerce/auth";
import { commerceQuoteShareSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ quoteId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const [id, body] = await Promise.all([
    z.string().uuid().safeParse((await params).quoteId),
    request.json().catch(() => ({}))
  ]);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The quote id is invalid.");
  const parsed = commerceQuoteShareSchema.safeParse(body);
  if (!parsed.success) return commerceError(422, "VALIDATION_ERROR", "The share expiry is invalid.");

  const token = createCommerceShareToken();
  const expiresAt = new Date(Date.now() + parsed.data.expiresInHours * 60 * 60 * 1000).toISOString();
  const { error } = await context.supabase.rpc("create_commerce_quote_share_v1", {
    input_quote_id: id.data,
    input_token_hash: hashCommerceShareToken(token),
    input_expires_at: expiresAt
  });
  if (error) return databaseErrorResponse(error);

  const configuredBase = process.env.COMMERCE_PUBLIC_QUOTE_BASE_URL?.trim();
  const baseUrl = configuredBase?.startsWith("https://")
    ? configuredBase.replace(/\/$/, "")
    : new URL(request.url).origin;
  return commerceNoStore({
    shareUrl: `${baseUrl}/api/commerce/public/quotes/${encodeURIComponent(token)}`,
    expiresAt
  }, { status: 201 });
}
