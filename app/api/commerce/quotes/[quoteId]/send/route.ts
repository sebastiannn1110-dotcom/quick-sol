import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceQuoteSendSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { transitionCommerceQuote } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ quoteId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const [id, body] = await Promise.all([
    z.string().uuid().safeParse((await params).quoteId),
    request.json().catch(() => null)
  ]);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The quote id is invalid.");
  const parsed = commerceQuoteSendSchema.safeParse(body);
  if (!parsed.success) return commerceError(422, "VALIDATION_ERROR", "The current quote version is required.");
  try {
    const quote = await transitionCommerceQuote(context.supabase, id.data, parsed.data.version, "sent");
    return quote ? commerceNoStore(quote) : commerceError(404, "NOT_FOUND", "The quote was not found.");
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
