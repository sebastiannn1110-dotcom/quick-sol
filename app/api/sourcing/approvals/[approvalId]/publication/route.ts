import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingPublicationSchema } from "@/lib/sourcing/contracts";
import { sourcingDatabaseError, sourcingError, sourcingNoStore } from "@/lib/sourcing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ approvalId: string }> }) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const approvalId = z.string().uuid().safeParse((await params).approvalId);
  const body = sourcingPublicationSchema.safeParse(await request.json().catch(() => null));
  if (!approvalId.success || !body.success) return sourcingError(422, "SOURCING_VALIDATION_ERROR", "Invalid publication request.");
  if (!context.supabase) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
  const { data, error } = await context.supabase.rpc("set_commercial_price_publication_v1", {
    input_approval_id: approvalId.data,
    input_publish_to_catalog: body.data.publishToCatalog
  });
  if (error) return sourcingDatabaseError(error);
  return sourcingNoStore({ data: { id: data, publishToCatalog: body.data.publishToCatalog } });
}
