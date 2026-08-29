import { NextResponse } from "next/server";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceQuoteWriteSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { createCommerceQuote, listCommerceQuotes } from "@/lib/commerce/service";
import { checkRateLimit } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") ?? 100) || 100, 1), 500);
  try {
    return commerceNoStore(await listCommerceQuotes(context.supabase, limit));
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "Quotes could not be loaded.");
  }
}

export async function POST(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const rate = checkRateLimit({ key: `commerce-quote:${context.profile.id}`, limit: 60, windowMs: 60_000 });
  if (!rate.allowed) return commerceError(429, "RATE_LIMITED", "Too many quote changes.");
  const parsed = commerceQuoteWriteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return commerceError(422, "VALIDATION_ERROR", "The quote data is invalid.", parsed.error.flatten());
  try {
    const quote = await createCommerceQuote(context.supabase, parsed.data);
    return quote
      ? commerceNoStore(quote, { status: 201 })
      : commerceError(500, "COMMERCE_UNAVAILABLE", "The quote was created but could not be loaded.");
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
