import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingDatabaseError, sourcingError, sourcingNoStore } from "@/lib/sourcing/http";
import { approvedSourcingOfferToSupplierOffer } from "@/lib/sourcing/of-adapter";
import { sourcingOfferPayload } from "@/lib/sourcing/service";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = z.string().uuid();

type ServiceClient = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

async function loadAdapterOffer(service: ServiceClient, offerId: string) {
  const [offerResult, approvalResult] = await Promise.all([
    service.from("sourcing_offers").select("*").eq("id", offerId).maybeSingle(),
    service.from("commercial_price_approvals")
      .select("id,approved_by,version,created_at")
      .eq("sourcing_offer_id", offerId)
      .eq("status", "active")
      .gt("valid_until", new Date().toISOString())
      .maybeSingle()
  ]);
  const error = offerResult.error ?? approvalResult.error;
  if (error) return { error, offer: null };
  if (!offerResult.data) return { error: null, offer: null };
  if (!approvalResult.data) return { error: null, offer: "approval_missing" as const };
  const approval = approvalResult.data;
  return {
    error: null,
    offer: {
      ...sourcingOfferPayload(offerResult.data as unknown as Record<string, unknown>),
      approval: {
        id: String(approval.id),
        approvedBy: String(approval.approved_by),
        version: Number(approval.version),
        approvedAt: String(approval.created_at)
      }
    }
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const offerId = uuid.safeParse((await params).offerId);
  const url = new URL(request.url);
  const jobId = uuid.safeParse(url.searchParams.get("jobId"));
  const fileId = uuid.safeParse(url.searchParams.get("fileId"));
  if (!offerId.success || !jobId.success || !fileId.success) {
    return sourcingError(422, "SOURCING_VALIDATION_ERROR", "offerId, jobId and fileId must be UUIDs.");
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
  const loaded = await loadAdapterOffer(service, offerId.data);
  if (loaded.error) return sourcingDatabaseError(loaded.error);
  if (!loaded.offer) return sourcingError(404, "SOURCING_NOT_FOUND", "The sourcing offer was not found.");
  if (loaded.offer === "approval_missing") {
    return sourcingError(409, "SOURCING_APPROVAL_NOT_ACTIVE", "The sourcing offer has no active approval.");
  }
  try {
    return sourcingNoStore({
      data: approvedSourcingOfferToSupplierOffer({
        offer: loaded.offer,
        jobId: jobId.data,
        fileId: fileId.data
      })
    });
  } catch (adapterError) {
    return sourcingError(409, "SOURCING_OF_CONTRACT_REJECTED", (adapterError as Error).message);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const offerId = uuid.safeParse((await params).offerId);
  const body = z.discriminatedUnion("action", [
    z.object({ action: z.literal("prepare") }).strict(),
    z.object({ action: z.literal("link"), supplyLotId: uuid }).strict()
  ]).safeParse(await request.json().catch(() => null));
  if (!offerId.success || !body.success) return sourcingError(422, "SOURCING_VALIDATION_ERROR", "Invalid OF linkage.");
  if (body.data.action === "prepare") {
    const service = createSupabaseServiceRoleClient();
    if (!service) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
    const loaded = await loadAdapterOffer(service, offerId.data);
    if (loaded.error) return sourcingDatabaseError(loaded.error);
    if (!loaded.offer) return sourcingError(404, "SOURCING_NOT_FOUND", "The sourcing offer was not found.");
    if (loaded.offer === "approval_missing") {
      return sourcingError(409, "SOURCING_APPROVAL_NOT_ACTIVE", "The sourcing offer has no active approval.");
    }
    const offer = loaded.offer;
    try {
      return sourcingNoStore({
        data: approvedSourcingOfferToSupplierOffer({
          offer,
          // Preparation is transport-only; a real OF job/file may be supplied
          // through GET before materialization. No matcher is invoked here.
          jobId: offer.requestId,
          fileId: offer.id
        })
      });
    } catch (adapterError) {
      return sourcingError(409, "SOURCING_OF_CONTRACT_REJECTED", (adapterError as Error).message);
    }
  }
  if (!context.supabase) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
  const { data, error } = await context.supabase.rpc("link_sourcing_offer_to_of_supply_lot_v1", {
    input_offer_id: offerId.data,
    input_supply_lot_id: body.data.supplyLotId
  });
  if (error) return sourcingDatabaseError(error);
  return sourcingNoStore({ data: { supplyLotId: data, sourcingOfferId: offerId.data } });
}
