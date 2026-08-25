import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { cleanUuid } from "@/lib/opportunity-finder/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const search = new URL(request.url).searchParams;
  const offset = Math.max(Number(search.get("offset") ?? 0) || 0, 0);
  const limit = Math.min(Math.max(Number(search.get("limit") ?? 100) || 100, 1), 250);
  const owned = await context.supabase.from("opportunity_finder_jobs").select("id").eq("id", jobId).eq("created_by", context.profile.id).maybeSingle();
  if (owned.error) return NextResponse.json({ errorCode: "JOB_READ_FAILED" }, { status: 500 });
  if (!owned.data) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const { data, error, count } = await context.supabase
    .from("opportunity_finder_possible_matches")
    .select("id,demand_display_mpn,supply_display_mpn,demand_normalized_mpn,supply_normalized_mpn,reason_code,match_tier,confidence,explanation,review_status,manufacturer_compatible,demand_trace,supply_trace", { count: "exact" })
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ errorCode: "RESULTS_READ_FAILED" }, { status: 500 });
  return NextResponse.json({
    possibleMatches: (data ?? []).map((match) => ({
      id: match.id,
      demandDisplayMpn: match.demand_display_mpn,
      supplyDisplayMpn: match.supply_display_mpn,
      demandNormalizedMpn: match.demand_normalized_mpn,
      supplyNormalizedMpn: match.supply_normalized_mpn,
      reasonCode: match.reason_code,
      matchTier: match.match_tier,
      confidence: match.confidence,
      explanation: match.explanation,
      reviewStatus: match.review_status,
      manufacturerCompatible: match.manufacturer_compatible,
      demandTrace: match.demand_trace,
      supplyTrace: match.supply_trace
    })),
    page: { offset, limit, total: count ?? 0 }
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
