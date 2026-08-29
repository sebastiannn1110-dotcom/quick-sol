import { NextResponse } from "next/server";
import { commerceSessionPayload, requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { commerceDashboard } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  try {
    const dashboard = await commerceDashboard(context.supabase);
    return commerceNoStore({
      session: commerceSessionPayload(context),
      ...dashboard,
      platform: { mode: "connected", label: "QuikSol Commerce", checkedAt: new Date().toISOString() }
    });
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "The employee dashboard could not be loaded.");
  }
}
