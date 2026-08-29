import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { getCommerceProduct } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const productId = z.string().uuid().safeParse((await params).productId);
  if (!productId.success) return commerceError(400, "VALIDATION_ERROR", "The product id is invalid.");
  try {
    const product = await getCommerceProduct(context.supabase, productId.data);
    return product
      ? commerceNoStore(product)
      : commerceError(404, "NOT_FOUND", "The product was not found.");
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "The product could not be loaded.");
  }
}
