import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceQuotePatchSchema, commerceQuoteTransitionSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { getCommerceQuote, transitionCommerceQuote, updateCommerceQuote } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function quoteId(params: Promise<{ quoteId: string }>) {
  return z.string().uuid().safeParse((await params).quoteId);
}

export async function GET(request: Request, { params }: { params: Promise<{ quoteId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const id = await quoteId(params);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The quote id is invalid.");
  try {
    const quote = await getCommerceQuote(context.supabase, id.data);
    return quote
      ? commerceNoStore(quote)
      : commerceError(404, "NOT_FOUND", "The quote was not found or is outside your scope.");
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "The quote could not be loaded.");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ quoteId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const [id, body] = await Promise.all([quoteId(params), request.json().catch(() => null)]);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The quote id is invalid.");
  try {
    const transition = commerceQuoteTransitionSchema.safeParse(body);
    if (transition.success) {
      const quote = await transitionCommerceQuote(
        context.supabase,
        id.data,
        transition.data.version,
        transition.data.status,
        transition.data.reason
      );
      return quote ? commerceNoStore(quote) : commerceError(404, "NOT_FOUND", "The quote was not found.");
    }
    const update = commerceQuotePatchSchema.safeParse(body);
    if (!update.success) {
      return commerceError(422, "VALIDATION_ERROR", "The quote patch is invalid.", update.error.flatten());
    }
    const { version, ...input } = update.data;
    const quote = await updateCommerceQuote(context.supabase, id.data, version, input);
    return quote ? commerceNoStore(quote) : commerceError(404, "NOT_FOUND", "The quote was not found.");
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
