import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { getCommerceQuote, updateCommerceQuote } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({ version: z.number().int().min(1) }).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ quoteId: string }> },
) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const [id, body] = await Promise.all([
    z.string().uuid().safeParse((await params).quoteId),
    request.json().catch(() => null),
  ]);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The quote id is invalid.");
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return commerceError(422, "VALIDATION_ERROR", "The current quote version is required.");

  try {
    const current = await getCommerceQuote(context.supabase, id.data);
    if (!current) return commerceError(404, "NOT_FOUND", "The quote was not found.");
    if (current.status !== "draft") {
      return commerceError(422, "INVALID_TRANSITION", "Only a draft quote can refresh authorized pricing.");
    }
    const refreshed = await updateCommerceQuote(
      context.supabase,
      id.data,
      parsed.data.version,
      {
        customerId: current.customer.id,
        rfqId: current.rfqId,
        items: current.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          discountPercent: item.discountPercent,
        })),
        validUntil: current.validUntil,
        notes: current.notes,
        commercialTerms: current.commercialTerms,
        taxRate: current.taxRate,
      },
    );
    return refreshed
      ? commerceNoStore(refreshed)
      : commerceError(404, "NOT_FOUND", "The quote was not found.");
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
