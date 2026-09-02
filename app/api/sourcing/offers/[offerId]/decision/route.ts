import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingDecisionSchema } from "@/lib/sourcing/contracts";
import { sourcingDatabaseError, sourcingError, sourcingNoStore } from "@/lib/sourcing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const offerId = z.string().uuid().safeParse((await params).offerId);
  const decision = sourcingDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!offerId.success || !decision.success) return sourcingError(422, "SOURCING_VALIDATION_ERROR", "Invalid sourcing decision.");
  if (!context.supabase) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
  const result = decision.data.decision === "approve"
    ? await context.supabase.rpc("approve_sourcing_offer_v1", {
        input_offer_id: offerId.data,
        input_authorized_unit_price: decision.data.authorizedUnitPrice,
        input_authorized_currency: decision.data.authorizedCurrency,
        input_coarse_availability: decision.data.coarseAvailability,
        input_reason: decision.data.reason
      })
    : await context.supabase.rpc("reject_sourcing_offer_v1", {
        input_offer_id: offerId.data,
        input_reason: decision.data.reason
      });
  if (result.error) return sourcingDatabaseError(result.error);
  return sourcingNoStore({ data: { id: result.data, decision: decision.data.decision } });
}
