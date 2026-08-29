import { NextResponse } from "next/server";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { listCommerceCatalog } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  try {
    return commerceNoStore(await listCommerceCatalog(context.supabase, new URL(request.url).searchParams));
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "The seller catalog could not be loaded.");
  }
}
