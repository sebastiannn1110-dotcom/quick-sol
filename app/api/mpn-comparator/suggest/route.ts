import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { loadMpnSuggestions, MpnLookupError, MPN_SUGGESTION_MIN_LENGTH } from "@/lib/mpn/lookup";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const startedAt = performance.now();
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const rate = checkRateLimit({ key: `mpn-suggest:${context.profile.id}`, limit: 120, windowMs: 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < MPN_SUGGESTION_MIN_LENGTH || context.isDemoMode || !context.supabase) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const suggestions = await loadMpnSuggestions(context.supabase, q);
    return NextResponse.json({ suggestions });
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
      action: "mpn_suggestions_failed",
      message: "MPN suggestions failed.",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      error: lookupError?.originalError ?? error,
      metadata: { q, stage: lookupError?.stage ?? "unknown", timeout: Boolean(lookupError?.isTimeout) }
    });
    return NextResponse.json(
      { error: lookupError?.isTimeout ? "La busqueda de sugerencias tardo demasiado. Escribe un MPN mas especifico." : "No se pudieron cargar sugerencias en este momento." },
      { status: lookupError?.isTimeout ? 504 : 500 }
    );
  }
}
