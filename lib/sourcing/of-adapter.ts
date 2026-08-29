import {
  manufacturerIdentity,
  mpnIdentity,
  safeContextText
} from "@/lib/opportunity-finder/normalization";
import type { CanonicalOpportunityRow } from "@/lib/opportunity-finder/types";

export type ApprovedSourcingOffer = {
  id: string;
  requestId: string;
  mpn: string;
  manufacturer: string | null;
  supplierName: string;
  supplierReference?: string | null;
  availableQuantity: number;
  unitOfMeasure: string | null;
  rawUnitCost: number;
  currency: string;
  leadTimeDays: number | null;
  minimumOrderQuantity: number;
  standardPackQuantity?: number | null;
  dateCode?: string | null;
  condition?: string | null;
  countryOfOrigin?: string | null;
  expiresAt: string;
  status: string;
  approval: {
    id: string;
    approvedBy: string;
    version: number;
    approvedAt: string;
  };
  provenance?: Record<string, unknown>;
};

export type SourcingSupplierOfferContract = CanonicalOpportunityRow & {
  sourcingOfferId: string;
  sourcingRequestId: string;
  sourcingProvenance: Record<string, unknown>;
};

/**
 * Approved-source adapter only. It emits the established supplier_offer
 * contract and deliberately does not call or alter the matcher/pipeline.
 * UOM is passed through unchanged so compatibility remains owned by OF.
 */
export function approvedSourcingOfferToSupplierOffer(input: {
  offer: ApprovedSourcingOffer;
  jobId: string;
  fileId: string;
  fileName?: string;
  side?: "A" | "B";
  now?: number;
}): SourcingSupplierOfferContract {
  const { offer } = input;
  if (offer.status !== "approved") throw new Error("SOURCING_OFFER_NOT_APPROVED");
  if (!offer.approval?.id || !offer.approval.approvedBy || !Number.isFinite(offer.approval.version)) {
    throw new Error("SOURCING_APPROVAL_PROVENANCE_REQUIRED");
  }
  const approvedAt = new Date(offer.approval.approvedAt).getTime();
  if (!Number.isFinite(approvedAt)) throw new Error("SOURCING_APPROVAL_PROVENANCE_REQUIRED");
  const identity = mpnIdentity(offer.mpn);
  if (!identity.normalizedMpn || !Number.isFinite(offer.availableQuantity) || offer.availableQuantity <= 0) {
    throw new Error("SOURCING_OFFER_INVALID_CONTRACT");
  }
  const manufacturer = manufacturerIdentity(offer.manufacturer);
  const expires = new Date(offer.expiresAt).getTime();
  if (!Number.isFinite(expires)) throw new Error("SOURCING_OFFER_INVALID_EXPIRY");
  const currency = offer.currency.trim().toUpperCase();
  const qualityFlags: CanonicalOpportunityRow["qualityFlags"] = [];
  if (!/^[A-Z]{3}$/.test(currency)) qualityFlags.push("currency_invalid");
  const now = input.now ?? Date.now();
  if (expires <= now) qualityFlags.push("offer_expired");

  return {
    jobId: input.jobId,
    fileId: input.fileId,
    side: input.side ?? "B",
    fileName: input.fileName ?? `sourcing-offer-${offer.id}.json`,
    sheetName: "Approved sourcing",
    sourceRow: 1,
    originalIndex: 0,
    recordRole: "supplier_offer",
    recordKind: "supply_lot",
    templateType: "generic",
    mappingVersion: "sourcing-approved-v1",
    headerRow: null,
    sourceRowHidden: false,
    sourceColumns: {
      mpn: "sourcing_offers.mpn",
      manufacturer: "sourcing_offers.manufacturer",
      quantity: "sourcing_offers.available_quantity",
      supplier: "sourcing_offers.supplier_name",
      unitOfMeasure: "sourcing_offers.unit_of_measure",
      unitCost: "sourcing_offers.raw_unit_cost",
      currency: "sourcing_offers.currency",
      expiresAt: "sourcing_offers.expires_at"
    },
    rawRow: {
      sourcing_offer_id: offer.id,
      sourcing_request_id: offer.requestId,
      commercial_price_approval_id: offer.approval.id,
      approved_by: offer.approval.approvedBy,
      approval_version: String(offer.approval.version),
      approved_at: new Date(approvedAt).toISOString(),
      supplier_reference: safeContextText(offer.supplierReference, 160),
      approval_state: offer.status
    },
    rawMpn: identity.rawMpn,
    displayMpn: identity.displayMpn,
    normalizedMpn: identity.normalizedMpn,
    reviewKey: identity.reviewKey,
    manufacturer: manufacturer.raw,
    manufacturerCanonical: manufacturer.canonical || null,
    manufacturerAliasVersion: manufacturer.aliasVersion,
    supplyLotKey: `sourcing-offer:${offer.id}`,
    customerContext: null,
    supplierContext: safeContextText(offer.supplierName, 200),
    rawQuantity: String(offer.availableQuantity),
    requiredQty: null,
    availableQty: offer.availableQuantity,
    excessQty: null,
    requiredDate: null,
    requiredDateQuality: "not_applicable",
    unitOfMeasure: offer.unitOfMeasure,
    offerPrice: offer.rawUnitCost,
    unitCost: offer.rawUnitCost,
    currency,
    currencyStatus: /^[A-Z]{3}$/.test(currency) ? "confirmed" : "invalid",
    moq: offer.minimumOrderQuantity,
    spq: offer.standardPackQuantity ?? null,
    dateCode: safeContextText(offer.dateCode, 80),
    coo: safeContextText(offer.countryOfOrigin, 120),
    leadTimeWeeks: offer.leadTimeDays == null ? null : offer.leadTimeDays / 7,
    condition: safeContextText(offer.condition, 80),
    expiresAt: new Date(expires).toISOString(),
    isLiveSupply: expires > now,
    qualityFlags,
    sourcingOfferId: offer.id,
    sourcingRequestId: offer.requestId,
    sourcingProvenance: {
      ...(offer.provenance ?? {}),
      source: "sourcing_offers",
      adapterVersion: "sourcing-approved-v1",
      offerId: offer.id,
      requestId: offer.requestId,
      approvalId: offer.approval.id,
      approvedBy: offer.approval.approvedBy,
      approvalVersion: offer.approval.version,
      approvedAt: new Date(approvedAt).toISOString()
    }
  };
}
