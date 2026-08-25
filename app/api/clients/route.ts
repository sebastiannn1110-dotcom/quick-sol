import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { aggregateClientSummaryState, listClientSummaries } from "@/lib/clients/data-source";
import { summaryResponseHeaders } from "@/lib/performance/summary-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({
      clients: [],
      summary: aggregateClientSummaryState([])
    }, { headers: summaryResponseHeaders() });
  }

  const includeArchived = context.profile.role !== "employee" &&
    new URL(request.url).searchParams.get("includeArchived") === "true";

  try {
    const clients = await listClientSummaries(context.supabase, context.profile.role, { includeArchived });
    const summary = aggregateClientSummaryState(clients);
    return NextResponse.json({ clients, summary }, {
      headers: summaryResponseHeaders(summary)
    });
  } catch {
    return NextResponse.json({ error: "Unable to load clients." }, { status: 500 });
  }
}
