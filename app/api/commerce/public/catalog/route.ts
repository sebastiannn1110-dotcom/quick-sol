import { sourcingError, sourcingNoStore } from "@/lib/sourcing/http";
import { normalizePublicCatalogMpns, publicCatalogApproval } from "@/lib/sourcing/public-catalog";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public/no-store allow-listed catalog overlay; no integration secret is required. */
export async function GET(request: Request) {
  const mpns = normalizePublicCatalogMpns(new URL(request.url).searchParams);
  if (!mpns.length) return sourcingError(422, "CATALOG_MPN_REQUIRED", "At least one MPN is required.");
  const service = createSupabaseServiceRoleClient();
  if (!service) return sourcingError(503, "CATALOG_NOT_CONFIGURED", "The public catalog overlay is not configured.");
  const { data, error } = await service.from("commercial_price_approvals")
    .select("mpn,authorized_unit_price,currency,coarse_availability,lead_time_days,minimum_order_quantity,version,updated_at")
    .eq("status", "active")
    .eq("publish_to_catalog", true)
    .gt("valid_until", new Date().toISOString())
    .in("normalized_mpn", mpns)
    .order("normalized_mpn", { ascending: true })
    .limit(50);
  if (error) return sourcingError(503, "CATALOG_UNAVAILABLE", "The public catalog overlay is temporarily unavailable.");
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(publicCatalogApproval);
  return sourcingNoStore({ data: rows, count: rows.length });
}
