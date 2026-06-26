import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { summarizeMpnOffers, buildSupplierRanking, type MpnOffer } from "@/lib/mpn/recommendation";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function like(value: string) {
  return `%${value.replace(/[%_]/g, "")}%`;
}

function priceHistory(offers: Array<MpnOffer & { upload_batches?: { original_file_name?: string | null; created_at?: string | null } | null }>) {
  return offers
    .filter((offer) => offer.price !== null && offer.price !== undefined)
    .map((offer) => ({
      date: offer.upload_batches?.created_at ?? offer.created_at,
      price: Number(offer.price),
      supplier: offer.supplier_name ?? offer.supplier ?? "Unknown supplier",
      uploadFile: offer.upload_batches?.original_file_name ?? null
    }))
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const rate = checkRateLimit({ key: `mpn-comparator:${context.profile.id}`, limit: 80, windowMs: 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const { searchParams } = new URL(request.url);
  const mpn = (searchParams.get("mpn") ?? "").trim().slice(0, 120);
  if (!mpn) return NextResponse.json({ error: "MPN is required." }, { status: 400 });

  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "api",
    action: "mpn_comparison_started",
    message: "MPN comparison started.",
    status: "started",
    metadata: { mpn }
  });

  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({
      mpn,
      summary: summarizeMpnOffers([]),
      offers: [],
      priceHistory: [],
      supplierRanking: []
    });
  }

  const { data, error } = await context.supabase
    .from("business_records")
    .select("*, profiles(full_name,email,department,region,role), upload_batches(id,original_file_name,detected_category,status,created_at,stored_file_path)")
    .is("archived_at", null)
    .or(`mpn.ilike.${like(mpn)},mpn_quoted.ilike.${like(mpn)}`)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    await logger.error({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "api",
      action: "mpn_comparison_failed",
      message: "MPN comparison failed.",
      status: "failed",
      error,
      metadata: { mpn }
    });
    return NextResponse.json({ error: "Unable to compare MPN." }, { status: 500 });
  }

  const offers = (data ?? []) as Array<MpnOffer & { upload_batches?: { original_file_name?: string | null; created_at?: string | null } | null }>;
  const summary = summarizeMpnOffers(offers);
  const supplierRanking = buildSupplierRanking(offers);

  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "api",
    action: "mpn_comparison_completed",
    message: "MPN comparison completed.",
    status: "completed",
    metadata: { mpn, offers: offers.length, recommendedSupplier: summary.recommendedSupplier }
  });

  return NextResponse.json({
    mpn,
    summary,
    offers,
    priceHistory: priceHistory(offers),
    supplierRanking,
    note: offers.length > 1 ? null : "No hay suficiente historial para este MPN todavia. Se muestran las ofertas disponibles."
  });
}
