import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { summarizeMpnOffers, buildSupplierRanking, type MpnOffer } from "@/lib/mpn/recommendation";
import { cleanMpnOfferForOutput, loadMpnComparatorOffers, MpnLookupError, normalizedMpnDisplay } from "@/lib/mpn/lookup";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { canViewCosts, canViewGp, canViewSensitivePricing, canViewSupplierDetails, redactSensitiveFieldsForRole } from "@/lib/security/permissions";
import type { UserRole } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function permissionSafePayload<T extends {
  summary: {
    bestPrice: number | null;
    worstPrice: number | null;
    recommendedSupplier: string | null;
    recommendationReason: string;
  };
  priceHistory: unknown[];
  supplierRanking: Array<{
    bestPrice: number | null;
    averageGpRate: number | null;
  }>;
}>(payload: T, role: UserRole) {
  if (canViewSensitivePricing(role) && canViewCosts(role) && canViewGp(role) && canViewSupplierDetails(role)) {
    return redactSensitiveFieldsForRole(payload, role);
  }

  const scoped = {
    ...payload,
    summary: {
      ...payload.summary,
      bestPrice: canViewSensitivePricing(role) ? payload.summary.bestPrice : null,
      worstPrice: canViewSensitivePricing(role) ? payload.summary.worstPrice : null,
      recommendedSupplier: canViewSupplierDetails(role) ? payload.summary.recommendedSupplier : null,
      recommendationReason: "Hay registros visibles para este MPN. Los precios, costos y margen estan ocultos para tu rol."
    },
    priceHistory: canViewSensitivePricing(role) ? payload.priceHistory : [],
    supplierRanking: payload.supplierRanking.map((item) => ({
      ...item,
      bestPrice: canViewSensitivePricing(role) ? item.bestPrice : null,
      averageGpRate: canViewGp(role) ? item.averageGpRate : null
    }))
  };

  return redactSensitiveFieldsForRole(scoped, role);
}

export async function GET(request: Request) {
  const startedAt = performance.now();
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const rate = checkRateLimit({ key: `mpn-comparator:${context.profile.id}`, limit: 80, windowMs: 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const { searchParams } = new URL(request.url);
  const mpn = normalizedMpnDisplay(searchParams.get("mpn") ?? "");
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
    return NextResponse.json(permissionSafePayload({
      mpn,
      summary: summarizeMpnOffers([]),
      offers: [],
      priceHistory: [],
      supplierRanking: []
    }, context.profile.role));
  }

  let offers: Array<MpnOffer & { upload_batches?: { original_file_name?: string | null; created_at?: string | null } | null }>;
  try {
    offers = (await loadMpnComparatorOffers(context.supabase, mpn)).map(cleanMpnOfferForOutput);
  } catch (error) {
    const lookupError = error instanceof MpnLookupError ? error : null;
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
      durationMs: Math.round(performance.now() - startedAt),
      error: lookupError?.originalError ?? error,
      metadata: { mpn, stage: lookupError?.stage ?? "unknown", timeout: Boolean(lookupError?.isTimeout) }
    });
    return NextResponse.json(
      { error: lookupError?.isTimeout ? "La busqueda del MPN tardo demasiado. Intenta con un MPN exacto." : "No se pudo comparar este MPN en este momento." },
      { status: lookupError?.isTimeout ? 504 : 500 }
    );
  }

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
    durationMs: Math.round(performance.now() - startedAt),
    metadata: { mpn, offers: offers.length, recommendedSupplier: summary.recommendedSupplier }
  });

  return NextResponse.json(permissionSafePayload({
    mpn,
    summary,
    offers,
    priceHistory: priceHistory(offers),
    supplierRanking,
    note: offers.length > 1 ? null : "No hay suficiente historial para este MPN todavía. Se muestran las ofertas disponibles."
  }, context.profile.role));
}
