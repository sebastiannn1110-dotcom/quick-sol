import { NextResponse } from "next/server";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceCustomerSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { createCommerceCustomer, listCommerceCustomers } from "@/lib/commerce/service";
import { checkRateLimit } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  try {
    const search = new URL(request.url).searchParams.get("query") ?? undefined;
    return commerceNoStore(await listCommerceCustomers(context.supabase, context.profile, search));
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "Customers could not be loaded.");
  }
}

export async function POST(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const rate = checkRateLimit({ key: `commerce-customer:${context.profile.id}`, limit: 30, windowMs: 60_000 });
  if (!rate.allowed) return commerceError(429, "RATE_LIMITED", "Too many customer changes.");
  const parsed = commerceCustomerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return commerceError(422, "VALIDATION_ERROR", "The customer data is invalid.", parsed.error.flatten());
  try {
    return commerceNoStore(await createCommerceCustomer(context.supabase, context.profile, parsed.data), { status: 201 });
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
