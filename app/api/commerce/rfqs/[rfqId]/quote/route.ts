import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceRfqQuoteSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { createCommerceQuoteFromRfq } from "@/lib/commerce/service";
import { checkRateLimit } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function validatedId(params: Promise<{ rfqId: string }>) {
  return z.string().uuid().safeParse((await params).rfqId);
}

export async function POST(request: Request, { params }: { params: Promise<{ rfqId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const rate = checkRateLimit({ key: `commerce-rfq-quote:${context.profile.id}`, limit: 30, windowMs: 60_000 });
  if (!rate.allowed) return commerceError(429, "RATE_LIMITED", "Too many quote creation attempts.");

  const [id, body] = await Promise.all([validatedId(params), request.json().catch(() => null)]);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The RFQ id is invalid.");
  const parsed = commerceRfqQuoteSchema.safeParse(body);
  if (!parsed.success) {
    return commerceError(422, "VALIDATION_ERROR", "The quote data is invalid.", parsed.error.flatten());
  }

  try {
    const result = await createCommerceQuoteFromRfq(context.supabase, id.data, parsed.data);
    if (!result.quote) {
      return commerceError(500, "COMMERCE_UNAVAILABLE", "The quote could not be loaded after creation.");
    }
    return commerceNoStore(
      {
        ...result.quote,
        idempotent: result.idempotent,
        pricingRequired: result.pricingRequired
      },
      { status: result.idempotent ? 200 : 201 }
    );
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
