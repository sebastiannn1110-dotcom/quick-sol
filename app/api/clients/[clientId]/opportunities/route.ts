import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { isUuid } from "@/lib/clients/clients";
import { loadSalesOpportunities, parseSalesOpportunityFilters } from "@/lib/opportunities/service";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { clientId } = await params;
  if (!isUuid(clientId)) return NextResponse.json({ error: "Invalid client id." }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Client not found." }, { status: 404 });

  try {
    const filters = { ...parseSalesOpportunityFilters(request), clientId };
    const result = await loadSalesOpportunities(context.supabase, context.profile.role, filters);
    if (!result) return NextResponse.json({ error: "Client not found or outside your scope." }, { status: 404 });
    return NextResponse.json(redactSensitiveFieldsForRole(result, context.profile.role));
  } catch {
    return NextResponse.json({ error: "Unable to load client opportunities." }, { status: 500 });
  }
}
