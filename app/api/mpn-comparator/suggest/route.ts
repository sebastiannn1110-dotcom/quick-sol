import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function like(value: string) {
  return `%${value.replace(/[%_]/g, "")}%`;
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const rate = checkRateLimit({ key: `mpn-suggest:${context.profile.id}`, limit: 120, windowMs: 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2 || context.isDemoMode || !context.supabase) {
    return NextResponse.json({ suggestions: [] });
  }

  const { data, error } = await context.supabase
    .from("business_records")
    .select("mpn, mpn_quoted, manufacturer, supplier, supplier_name")
    .is("archived_at", null)
    .or(`mpn.ilike.${like(q)},mpn_quoted.ilike.${like(q)}`)
    .limit(25);

  if (error) return NextResponse.json({ error: "Unable to load MPN suggestions." }, { status: 500 });

  const seen = new Set<string>();
  const suggestions = (data ?? [])
    .flatMap((record) => [record.mpn, record.mpn_quoted])
    .filter(Boolean)
    .map((mpn) => String(mpn).toUpperCase())
    .filter((mpn) => {
      if (seen.has(mpn)) return false;
      seen.add(mpn);
      return true;
    })
    .slice(0, 12);

  return NextResponse.json({ suggestions });
}
