import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { buildSalesOpportunitiesResult } from "@/lib/opportunities/opportunities";
import { enrichOpportunitiesWithConfidence } from "@/lib/opportunities/quality";
import { loadSalesOpportunities, parseSalesOpportunityFilters } from "@/lib/opportunities/service";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const filters = parseSalesOpportunityFilters(request);

  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json(redactSensitiveFieldsForRole(
      enrichOpportunitiesWithConfidence(
        buildSalesOpportunitiesResult({ records: [], filters }),
        filters.confidence
      ),
      context.profile.role
    ));
  }

  try {
    const result = await loadSalesOpportunities(context.supabase, context.profile.role, filters);
    if (!result) return NextResponse.json({ error: "Client not found or outside your scope." }, { status: 404 });
    return NextResponse.json(redactSensitiveFieldsForRole(result, context.profile.role));
  } catch {
    return NextResponse.json({ error: "Unable to load sales opportunities." }, { status: 500 });
  }
}
