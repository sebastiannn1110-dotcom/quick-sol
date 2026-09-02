import { describe, expect, it } from "vitest";
import { approvedSourcingOfferToSupplierOffer } from "@/lib/sourcing/of-adapter";

const approved = {
  id: "10000000-0000-4000-8000-000000000001",
  requestId: "20000000-0000-4000-8000-000000000001",
  mpn: " sn74lvc2g74-dc ",
  manufacturer: "TI",
  supplierName: "Private supplier",
  supplierReference: "SUP-42",
  availableQuantity: 250,
  unitOfMeasure: "Tray / 25",
  rawUnitCost: 0.45,
  currency: "usd",
  leadTimeDays: 21,
  minimumOrderQuantity: 25,
  standardPackQuantity: 25,
  dateCode: "2630",
  condition: "New",
  countryOfOrigin: "MX",
  expiresAt: "2099-12-31T00:00:00.000Z",
  status: "approved",
  approval: {
    id: "50000000-0000-4000-8000-000000000001",
    approvedBy: "60000000-0000-4000-8000-000000000001",
    version: 7,
    approvedAt: "2026-08-29T12:30:00.000Z"
  },
  provenance: { sourceDocument: "private-file-1" }
};

describe("approved sourcing -> existing OF supplier_offer contract", () => {
  it("preserves exact MPN punctuation, UOM and source provenance", () => {
    const row = approvedSourcingOfferToSupplierOffer({
      offer: approved,
      jobId: "30000000-0000-4000-8000-000000000001",
      fileId: "40000000-0000-4000-8000-000000000001",
      now: Date.UTC(2026, 7, 29)
    });
    expect(row.recordRole).toBe("supplier_offer");
    expect(row.recordKind).toBe("supply_lot");
    expect(row.normalizedMpn).toBe("SN74LVC2G74-DC");
    expect(row.reviewKey).toBe("SN74LVC2G74DC");
    expect(row.unitOfMeasure).toBe("Tray / 25");
    expect(row.sourcingOfferId).toBe(approved.id);
    expect(row.supplyLotKey).toBe(`sourcing-offer:${approved.id}`);
    expect(row.sourcingProvenance).toMatchObject({
      adapterVersion: "sourcing-approved-v1",
      sourceDocument: "private-file-1",
      approvalId: approved.approval.id,
      approvedBy: approved.approval.approvedBy,
      approvalVersion: 7,
      approvedAt: approved.approval.approvedAt
    });
    expect(row.isLiveSupply).toBe(true);
  });

  it("never adapts a pending offer into live OF supply", () => {
    expect(() => approvedSourcingOfferToSupplierOffer({
      offer: { ...approved, status: "pending" },
      jobId: "30000000-0000-4000-8000-000000000001",
      fileId: "40000000-0000-4000-8000-000000000001"
    })).toThrow("SOURCING_OFFER_NOT_APPROVED");
  });

  it("requires immutable approval provenance", () => {
    expect(() => approvedSourcingOfferToSupplierOffer({
      offer: { ...approved, approval: undefined as never },
      jobId: "30000000-0000-4000-8000-000000000001",
      fileId: "40000000-0000-4000-8000-000000000001"
    })).toThrow("SOURCING_APPROVAL_PROVENANCE_REQUIRED");
  });
});
