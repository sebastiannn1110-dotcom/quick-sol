import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceRfqActionSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import {
  assignCommerceRfqSeller,
  createCommerceClientFromRfq,
  getCommerceRfq,
  markCommerceRfqInReview
} from "@/lib/commerce/service";
import { checkRateLimit } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function validatedId(params: Promise<{ rfqId: string }>) {
  return z.string().uuid().safeParse((await params).rfqId);
}

export async function GET(request: Request, { params }: { params: Promise<{ rfqId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const id = await validatedId(params);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The RFQ id is invalid.");

  try {
    const rfq = await getCommerceRfq(context.supabase, context.profile, id.data);
    return rfq
      ? commerceNoStore(rfq)
      : commerceError(404, "NOT_FOUND", "The RFQ was not found or is outside your scope.");
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "The RFQ could not be loaded.");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ rfqId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const rate = checkRateLimit({ key: `commerce-rfq:${context.profile.id}`, limit: 60, windowMs: 60_000 });
  if (!rate.allowed) return commerceError(429, "RATE_LIMITED", "Too many RFQ changes.");

  const [id, body] = await Promise.all([validatedId(params), request.json().catch(() => null)]);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The RFQ id is invalid.");
  const parsed = commerceRfqActionSchema.safeParse(body);
  if (!parsed.success) {
    return commerceError(422, "VALIDATION_ERROR", "The RFQ action is invalid.", parsed.error.flatten());
  }

  try {
    const rfq = parsed.data.action === "mark_in_review"
      ? await markCommerceRfqInReview(context.supabase, context.profile, id.data)
      : parsed.data.action === "assign_seller"
        ? await assignCommerceRfqSeller(
            context.supabase,
            context.profile,
            id.data,
            parsed.data.sellerId
          )
        : await createCommerceClientFromRfq(context.supabase, context.profile, id.data);
    return rfq
      ? commerceNoStore(rfq)
      : commerceError(404, "NOT_FOUND", "The RFQ was not found or is outside your scope.");
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
