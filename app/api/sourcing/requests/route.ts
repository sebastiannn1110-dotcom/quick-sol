import { NextResponse } from "next/server";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingRequestSchema } from "@/lib/sourcing/contracts";
import { sourcingDatabaseError, sourcingError, sourcingNoStore } from "@/lib/sourcing/http";
import { createSourcingRequest, listSourcingWorkspace } from "@/lib/sourcing/service";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const service = createSupabaseServiceRoleClient();
  if (!service) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
  try {
    return sourcingNoStore({ data: await listSourcingWorkspace(service) });
  } catch (error) {
    return sourcingDatabaseError(error as { code?: string; message?: string });
  }
}

export async function POST(request: Request) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  const parsed = sourcingRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return sourcingError(422, "SOURCING_VALIDATION_ERROR", "Invalid sourcing request.", parsed.error.flatten());
  if (!context.supabase) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Sourcing storage is not configured.");
  try {
    const data = await createSourcingRequest(context.supabase, context.profile.id, parsed.data);
    return sourcingNoStore({ data }, 201);
  } catch (error) {
    return sourcingDatabaseError(error as { code?: string; message?: string });
  }
}
