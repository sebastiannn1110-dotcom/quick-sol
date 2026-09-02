import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { getCommerceClientActivity } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) {
    return commerceError(503, "DATABASE_NOT_CONFIGURED", "Client Commerce activity is not configured.");
  }

  const id = z.string().uuid().safeParse((await params).clientId);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The client id is invalid.");

  try {
    const activity = await getCommerceClientActivity(context.supabase, context.profile, id.data);
    return activity
      ? commerceNoStore(activity)
      : commerceError(404, "NOT_FOUND", "The client was not found or is outside your Commerce scope.");
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "Client Commerce activity could not be loaded.");
  }
}
