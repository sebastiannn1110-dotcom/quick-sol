import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingOfferSchema } from "@/lib/sourcing/contracts";
import { sourcingDatabaseError, sourcingError, sourcingNoStore } from "@/lib/sourcing/http";
import { createSourcingOffer } from "@/lib/sourcing/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const requestId = z.string().uuid().safeParse((await params).requestId);
  const body = sourcingOfferSchema.safeParse(await request.json().catch(() => null));
  if (!requestId.success || !body.success) return sourcingError(422, "SOURCING_VALIDATION_ERROR", "Invalid supplier offer.");
  if (!context.supabase) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
  try {
    const data = await createSourcingOffer(context.supabase, context.profile.id, requestId.data, body.data);
    return sourcingNoStore({ data }, 201);
  } catch (error) {
    return sourcingDatabaseError(error as { code?: string; message?: string });
  }
}
