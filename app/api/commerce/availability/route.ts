import { NextResponse } from "next/server";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { PRODUCT_SELECT, productPayload } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function values(params: URLSearchParams, singular: string, plural: string) {
  return [
    ...params.getAll(singular),
    ...(params.get(plural)?.split(",") ?? [])
  ].map((value) => value.trim()).filter(Boolean).slice(0, 100);
}

export async function GET(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const params = new URL(request.url).searchParams;
  const productIds = values(params, "productId", "productIds");
  const mpns = values(params, "mpn", "mpns");
  if (!productIds.length && !mpns.length) {
    return commerceError(400, "VALIDATION_ERROR", "At least one product id or MPN is required.");
  }
  let query = context.supabase
    .from("commerce_catalog_products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
    .limit(100);
  if (productIds.length && mpns.length) {
    query = query.or(`id.in.(${productIds.join(",")}),mpn.in.(${mpns.map((mpn) => `"${mpn.replace(/[",()]/g, "")}"`).join(",")})`);
  } else if (productIds.length) {
    query = query.in("id", productIds);
  } else {
    query = query.in("mpn", mpns);
  }
  const { data, error } = await query;
  if (error) return commerceError(500, "COMMERCE_UNAVAILABLE", "Availability could not be loaded.");
  return commerceNoStore({
    data: ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
      const product = productPayload(row);
      return {
        productId: product.id,
        mpn: product.mpn,
        authorizedUnitPrice: product.authorizedUnitPrice,
        currency: product.currency,
        minimumOrderQuantity: product.minimumOrderQuantity,
        leadTimeDays: product.leadTimeDays,
        availability: product.availability
      };
    })
  });
}
