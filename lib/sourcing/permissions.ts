import type { BusinessRank, Profile, UserRole } from "@/lib/types";

export type SourcingIdentity = {
  role: UserRole;
  business_rank?: BusinessRank | null;
  is_active?: boolean;
};

export function canManageSourcing(identity: SourcingIdentity | null | undefined) {
  if (!identity || identity.is_active === false) return false;
  return identity.role === "super_admin_dev" ||
    identity.business_rank === "sourcing_manager" ||
    (identity.business_rank === "owner" && identity.role === "admin");
}

export function sourcingAccessReason(identity: SourcingIdentity | null | undefined) {
  if (!identity || identity.is_active === false) return "inactive" as const;
  return canManageSourcing(identity) ? "privileged" as const : "seller_safe_only" as const;
}

export type SellerSafeApproval = {
  id: string;
  requestId: string;
  sourcingOfferId: string;
  mpn: string;
  manufacturer: string | null;
  authorizedUnitPrice: number;
  currency: string;
  coarseAvailability: "available" | "limited" | "unavailable" | "contact_us";
  leadTimeDays: number | null;
  minimumOrderQuantity: number;
  validUntil: string;
  version: number;
  updatedAt: string;
};

/**
 * Deliberate allow-list. Seller/public consumers cannot receive supplier,
 * raw cost, documents, provenance, notes, or exact quantity through this map.
 */
export function sellerSafeApproval(row: Record<string, unknown>): SellerSafeApproval {
  return {
    id: String(row.id),
    requestId: String(row.sourcing_request_id),
    sourcingOfferId: String(row.sourcing_offer_id),
    mpn: String(row.mpn ?? ""),
    manufacturer: typeof row.manufacturer === "string" && row.manufacturer ? row.manufacturer : null,
    authorizedUnitPrice: Number(row.authorized_unit_price),
    currency: String(row.currency ?? "USD"),
    coarseAvailability: String(row.coarse_availability ?? "contact_us") as SellerSafeApproval["coarseAvailability"],
    leadTimeDays: row.lead_time_days == null ? null : Number(row.lead_time_days),
    minimumOrderQuantity: Number(row.minimum_order_quantity ?? 1),
    validUntil: String(row.valid_until),
    version: Number(row.version ?? 1),
    updatedAt: String(row.updated_at)
  };
}

export function profileSourcingIdentity(profile: Pick<Profile, "role" | "business_rank" | "is_active">) {
  return {
    role: profile.role,
    business_rank: profile.business_rank ?? null,
    is_active: profile.is_active
  } satisfies SourcingIdentity;
}
