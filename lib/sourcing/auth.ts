import { NextResponse } from "next/server";
import { getAuthContext, type AuthContext } from "@/lib/auth/context";
import { canManageSourcing } from "@/lib/sourcing/permissions";
import { sourcingError } from "@/lib/sourcing/http";

export async function requireSourcingManager(request: Request): Promise<AuthContext | NextResponse> {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!canManageSourcing(context.profile)) {
    return sourcingError(403, "SOURCING_FORBIDDEN", "Sourcing manager or owner access is required.");
  }
  return context;
}
