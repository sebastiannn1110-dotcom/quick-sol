import { mpnIdentity } from "@/lib/opportunity-finder/normalization";

export const PUBLIC_CATALOG_APPROVAL_FIELDS = [
  "mpn",
  "authorizedUnitPrice",
  "currency",
  "coarseAvailability",
  "leadTimeDays",
  "minimumOrderQuantity",
  "version",
  "updatedAt"
] as const;

export function normalizePublicCatalogMpns(searchParams: URLSearchParams) {
  const requested = [...searchParams.getAll("mpn"), ...searchParams.getAll("mpns")]
    .flatMap((value) => value.split(","))
    .map((value) => mpnIdentity(value).normalizedMpn)
    .filter(Boolean);
  return Array.from(new Set(requested)).slice(0, 50);
}

/** Public allow-list: deliberately impossible to add exact stock/cost/supplier by spread. */
export function publicCatalogApproval(row: Record<string, unknown>) {
  return {
    mpn: String(row.mpn ?? ""),
    authorizedUnitPrice: Number(row.authorized_unit_price),
    currency: String(row.currency ?? "USD"),
    coarseAvailability: String(row.coarse_availability ?? "contact_us"),
    leadTimeDays: row.lead_time_days == null ? null : Number(row.lead_time_days),
    minimumOrderQuantity: Number(row.minimum_order_quantity ?? 1),
    version: Number(row.version ?? 1),
    updatedAt: String(row.updated_at)
  };
}
