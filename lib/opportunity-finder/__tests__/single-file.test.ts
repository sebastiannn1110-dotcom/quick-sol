import { describe, expect, it } from "vitest";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import { buildOpportunityFinderIdempotencyKey } from "@/lib/opportunity-finder/pipeline";
import {
  buildPlatformSnapshotRows,
  datasetVersionFromManifest,
  oppositeDatasetRole,
  type OpportunityPlatformEntityRow
} from "@/lib/opportunity-finder/single-file";
import type { CanonicalOpportunityRow, OpportunitySelectedRole } from "@/lib/opportunity-finder/types";

function summary(input: Partial<OpportunityPlatformEntityRow> & { mpn: string }): OpportunityPlatformEntityRow {
  return {
    upload_batch_id: input.upload_batch_id ?? "00000000-0000-4000-8000-000000000001",
    owner_id: input.owner_id ?? "00000000-0000-4000-8000-000000000002",
    data_version: input.data_version ?? 1,
    source_record_id: input.source_record_id ?? "00000000-0000-4000-8000-000000000003",
    entity_kind: input.entity_kind ?? "stock",
    entity_key: input.entity_key ?? `${input.mpn}:${input.entity_kind ?? "stock"}`,
    normalized_mpn: input.mpn,
    display_mpn: input.mpn,
    customer_name: input.customer_name ?? null,
    supplier_name: input.supplier_name ?? null,
    manufacturer_name: input.manufacturer_name ?? null,
    required_qty: input.required_qty ?? null,
    available_qty: input.available_qty ?? null,
    excess_qty: input.excess_qty ?? null,
    required_date: input.required_date ?? null,
    lead_time_weeks: input.lead_time_weeks ?? null,
    moq: input.moq ?? null,
    spq: input.spq ?? null,
    date_code: input.date_code ?? null,
    coo: input.coo ?? null,
    condition: input.condition ?? null,
    expires_at: input.expires_at ?? null,
    unit_of_measure: input.unit_of_measure ?? null,
    is_active_demand: input.is_active_demand ?? true,
    is_live_supply: input.is_live_supply ?? true,
    warnings: input.warnings ?? []
  };
}

function row(input: {
  side: "A" | "B";
  role: OpportunitySelectedRole;
  mpn: string;
  required?: number;
  available?: number;
  manufacturer?: string;
  sourceRow?: number;
  expiry?: string | null;
  eventKey?: string;
}): CanonicalOpportunityRow {
  return {
    jobId: "single-job",
    fileId: input.side === "A" ? "uploaded" : "platform",
    side: input.side,
    fileName: input.side === "A" ? "uploaded.xlsx" : "Base QuikSol autorizada",
    sheetName: "Sheet1",
    sourceRow: input.sourceRow ?? 2,
    originalIndex: (input.sourceRow ?? 2) - 2,
    recordRole: input.role,
    recordKind: input.role === "demand" ? "demand_option" : "supply_lot",
    demandEventKey: input.role === "demand" ? input.eventKey ?? null : null,
    rawMpn: input.mpn,
    displayMpn: input.mpn,
    normalizedMpn: input.mpn,
    reviewKey: input.mpn.replace(/[^A-Z0-9]/g, ""),
    manufacturer: input.manufacturer ?? null,
    customerContext: null,
    supplierContext: null,
    requiredQty: input.required ?? null,
    availableQty: input.available ?? null,
    excessQty: input.role === "excess" ? input.available ?? null : null,
    requiredDate: "2099-01-01",
    unitOfMeasure: "EA",
    expiresAt: input.expiry ?? null,
    isLiveSupply: input.role === "supplier_offer" ? Boolean(input.expiry) : true,
    qualityFlags: []
  };
}

describe("Opportunity Finder single-file mode", () => {
  it("selects the opposite authorized universe for every supported role", () => {
    expect(oppositeDatasetRole("demand")).toBe("stock");
    for (const role of ["stock", "excess", "supplier_offer", "received_history", "purchase_history", "quote_history", "sales_history"] as const) {
      expect(oppositeDatasetRole(role)).toBe("demand");
    }
  });

  it("builds a stable dataset version independent of manifest order", () => {
    const first = [
      { uploadBatchId: "b", ownerId: "u", dataVersion: 2 },
      { uploadBatchId: "a", ownerId: "u", dataVersion: 1 }
    ];
    expect(datasetVersionFromManifest(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(datasetVersionFromManifest(first)).toBe(datasetVersionFromManifest([...first].reverse()));
  });

  it("uses only live stock/excess summaries for an uploaded demand file", () => {
    const rows = buildPlatformSnapshotRows({
      uploadedRole: "demand",
      candidates: [
        summary({ mpn: "FULL", entity_kind: "stock", available_qty: 20 }),
        summary({ mpn: "PARTIAL", entity_kind: "excess", excess_qty: 4 }),
        summary({ mpn: "HISTORY", entity_kind: "historical", available_qty: 99 })
      ]
    });
    expect(rows.map((item) => [item.normalized_mpn, item.role])).toEqual([
      ["FULL", "stock"],
      ["PARTIAL", "excess"]
    ]);
  });

  it("includes only supplier offers with explicit future validity", () => {
    const rows = buildPlatformSnapshotRows({
      uploadedRole: "demand",
      now: new Date("2026-08-14T00:00:00.000Z"),
      candidates: [
        summary({ mpn: "LIVE", entity_kind: "supplier_offer", available_qty: 8, expires_at: "2026-09-01T00:00:00.000Z" }),
        summary({ mpn: "EXPIRED", entity_kind: "supplier_offer", available_qty: 8, expires_at: "2026-01-01T00:00:00.000Z" }),
        summary({ mpn: "UNKNOWN", entity_kind: "supplier_offer", available_qty: 8, expires_at: null })
      ]
    });
    expect(rows.map((row) => row.normalized_mpn)).toEqual(["LIVE"]);
    expect(rows[0]).toMatchObject({ role: "supplier_offer", expires_at: "2026-09-01T00:00:00.000Z" });
  });

  it("creates active demand only when the platform summary has a current unambiguous date", () => {
    const rows = buildPlatformSnapshotRows({
      uploadedRole: "stock",
      now: new Date("2026-08-14T00:00:00.000Z"),
      candidates: [
        summary({ mpn: "ACTIVE", entity_kind: "demand", required_qty: 10, required_date: "2026-09-01" }),
        summary({ mpn: "OLD", entity_kind: "demand", required_qty: 10, required_date: "2026-01-01" }),
        summary({ mpn: "UNKNOWN", entity_kind: "demand", required_qty: 10 })
      ]
    });
    expect(rows.map((item) => [item.normalized_mpn, item.is_active_demand])).toEqual([
      ["ACTIVE", true], ["OLD", false], ["UNKNOWN", false]
    ]);
    expect(rows[2].quality_flags).toContain("ambiguous_date");
  });

  it("reuses the certified matcher and never allocates the same platform stock twice", () => {
    const output = matchOpportunityRows({
      jobId: "single-job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "MPN-1", required: 70, eventKey: "event-a" }),
        row({ side: "A", role: "demand", mpn: "MPN-1", required: 50, sourceRow: 3, eventKey: "event-b" }),
        row({ side: "B", role: "stock", mpn: "MPN-1", available: 100 })
      ]
    });
    expect(output.results.map((item) => [item.allocatedQty, item.shortageQty])).toEqual([[70, 0], [30, 20]]);
  });

  it("does not autoapprove manufacturer conflicts or supplier offers without validity", () => {
    const conflict = matchOpportunityRows({
      jobId: "single-job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "MPN-2", required: 10, manufacturer: "TI" }),
        row({ side: "B", role: "stock", mpn: "MPN-2", available: 10, manufacturer: "MICRON" })
      ]
    });
    expect(conflict.results[0]).toMatchObject({ allocatedQty: 0, opportunityType: "review_required" });

    const invalidOffer = matchOpportunityRows({
      jobId: "single-job",
      roleA: "demand",
      roleB: "supplier_offer",
      rows: [
        row({ side: "A", role: "demand", mpn: "MPN-3", required: 10 }),
        row({ side: "B", role: "supplier_offer", mpn: "MPN-3", available: 10, expiry: null })
      ]
    });
    expect(invalidOffer.results[0].allocatedQty).toBe(0);
  });

  it("does not convert quote history into live inventory", () => {
    const output = matchOpportunityRows({
      jobId: "single-job",
      roleA: "quote_history",
      roleB: "demand",
      rows: [
        row({ side: "A", role: "quote_history", mpn: "MPN-4", available: 10 }),
        row({ side: "B", role: "demand", mpn: "MPN-4", required: 10 })
      ]
    });
    expect(output.results[0]).toMatchObject({ opportunityType: "historical_signal", allocatedQty: null });
  });

  it("includes role, dataset version, mode and tenant scope in single-file idempotency", async () => {
    const base = {
      files: [{ side: "A" as const, contentSha256: "a".repeat(64) }],
      comparisonMode: "single_file" as const,
      uploadedRole: "demand",
      datasetVersion: "b".repeat(64),
      tenantScope: "tenant:own:user"
    };
    const first = await buildOpportunityFinderIdempotencyKey(base);
    expect(first).not.toBe(await buildOpportunityFinderIdempotencyKey({ ...base, datasetVersion: "c".repeat(64) }));
    expect(first).not.toBe(await buildOpportunityFinderIdempotencyKey({ ...base, uploadedRole: "stock" }));
  });
});
