import { NextResponse } from "next/server";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingAutomationSchema } from "@/lib/sourcing/contracts";
import { sourcingDatabaseError, sourcingError, sourcingNoStore } from "@/lib/sourcing/http";
import { createSourcingRequestFromCommerceRfq } from "@/lib/sourcing/service";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal, explicit automation: one Commerce RFQ line becomes one idempotent sourcing request. */
export async function POST(request: Request) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const body = sourcingAutomationSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return sourcingError(422, "SOURCING_VALIDATION_ERROR", "Invalid Commerce RFQ line.");
  const service = createSupabaseServiceRoleClient();
  if (!service) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing automation is not configured.");
  try {
    const data = await createSourcingRequestFromCommerceRfq(service, context.profile.id, body.data.commerceRfqItemId);
    return sourcingNoStore({ data }, 201);
  } catch (error) {
    return sourcingDatabaseError(error as { code?: string; message?: string });
  }
}
