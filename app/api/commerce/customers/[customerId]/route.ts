import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { commerceCustomerSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { getCommerceCustomer, updateCommerceCustomer } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function validatedId(params: Promise<{ customerId: string }>) {
  return z.string().uuid().safeParse((await params).customerId);
}

export async function GET(request: Request, { params }: { params: Promise<{ customerId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const id = await validatedId(params);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The customer id is invalid.");
  try {
    const customer = await getCommerceCustomer(context.supabase, context.profile, id.data);
    return customer
      ? commerceNoStore(customer)
      : commerceError(404, "NOT_FOUND", "The customer was not found or is outside your scope.");
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "The customer could not be loaded.");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ customerId: string }> }) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;
  const [id, body] = await Promise.all([validatedId(params), request.json().catch(() => null)]);
  if (!id.success) return commerceError(400, "VALIDATION_ERROR", "The customer id is invalid.");
  const parsed = commerceCustomerSchema.safeParse(body);
  if (!parsed.success) return commerceError(422, "VALIDATION_ERROR", "The customer data is invalid.", parsed.error.flatten());
  try {
    const customer = await updateCommerceCustomer(context.supabase, context.profile, id.data, parsed.data);
    return customer
      ? commerceNoStore(customer)
      : commerceError(404, "NOT_FOUND", "The customer was not found or is outside your scope.");
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
