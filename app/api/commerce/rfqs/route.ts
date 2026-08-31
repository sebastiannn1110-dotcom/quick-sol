import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCommerceAuth } from "@/lib/commerce/auth";
import { RFQ_STATUSES } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore } from "@/lib/commerce/http";
import { listCommerceRfqs } from "@/lib/commerce/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(RFQ_STATUSES).optional()
}).strict();

export async function GET(request: Request) {
  const context = await requireCommerceAuth(request);
  if (context instanceof NextResponse) return context;

  const url = new URL(request.url);
  const parsed = listQuerySchema.safeParse({
    ...(url.searchParams.has("clientId") ? { clientId: url.searchParams.get("clientId") } : {}),
    ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
    ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") } : {})
  });
  if (!parsed.success) {
    return commerceError(400, "VALIDATION_ERROR", "The RFQ filters are invalid.");
  }

  const filters = new URLSearchParams();
  if (parsed.data.clientId) filters.set("clientId", parsed.data.clientId);
  if (parsed.data.limit) filters.set("limit", String(parsed.data.limit));
  if (parsed.data.status) filters.set("status", parsed.data.status);

  try {
    return commerceNoStore(await listCommerceRfqs(context.supabase, filters));
  } catch {
    return commerceError(500, "COMMERCE_UNAVAILABLE", "RFQs could not be loaded.");
  }
}
