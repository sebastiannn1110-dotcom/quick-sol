import { describe, expect, it } from "vitest";
import {
  containsForbiddenOpportunityFields,
  matchOpportunityRows
} from "@/lib/opportunity-finder/matcher";
import {
  attachMaterializedEntityIds,
  commercialInsert,
  demandRowWithFallbackContext,
  financialInsert,
  possibleMatchInsert,
  resultInsert
} from "@/lib/opportunity-finder/worker";
import type {
  CanonicalOpportunityRow,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";

function row(input: Partial<CanonicalOpportunityRow> & {
  side: "A" | "B";
  role: OpportunitySelectedRole;
  mpn: string;
}): CanonicalOpportunityRow {
  return {
    ...input,
    jobId: "job",
    fileId: input.side === "A" ? "demand-file" : "supply-file",
    side: input.side,
    fileName: input.side === "A" ? "demand.xlsx" : "supply.xlsx",
    sheetName: "Sheet1",
    sourceRow: input.sourceRow ?? 2,
    originalIndex: input.originalIndex ?? 0,
    recordRole: input.role,
    rawMpn: input.mpn,
    displayMpn: input.mpn,
    normalizedMpn: input.mpn.toUpperCase(),
    reviewKey: input.mpn.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    manufacturer: input.manufacturer ?? null,
    customerContext: input.customerContext ?? null,
    supplierContext: input.supplierContext ?? null,
    requiredQty: input.requiredQty ?? null,
    availableQty: input.availableQty ?? null,
    excessQty: input.excessQty ?? null,
    requiredDate: input.requiredDate ?? null,
    unitOfMeasure: input.unitOfMeasure ?? null,
    qualityFlags: input.qualityFlags ?? []
  };
}

describe("two-file opportunity allocation", () => {
  it("aggregates duplicate stock and never reuses the same units", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "ABC-1", requiredQty: 700, requiredDate: "2026-08-01", customerContext: "A" }),
        row({ side: "A", role: "demand", mpn: "ABC-1", requiredQty: 600, requiredDate: "2026-08-02", customerContext: "B", sourceRow: 3 }),
        row({ side: "B", role: "stock", mpn: "ABC-1", availableQty: 400 }),
        row({ side: "B", role: "stock", mpn: "ABC-1", availableQty: 600, sourceRow: 3 })
      ]
    });
    expect(output.results.map((item) => [item.opportunityType, item.allocatedQty, item.shortageQty])).toEqual([
      ["full_sale", 700, 0],
      ["partial_sale", 300, 300]
    ]);
  });

  it("reports remaining quantity across every eligible lot, including unused lots", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "REMAINING-ALL", manufacturer: "TI", requiredQty: 5 }),
        row({ side: "B", role: "stock", mpn: "REMAINING-ALL", manufacturer: "TI", availableQty: 10 }),
        row({
          side: "B",
          role: "stock",
          mpn: "REMAINING-ALL",
          manufacturer: "TI",
          availableQty: 10,
          sourceRow: 3,
          originalIndex: 1
        })
      ]
    });

    expect(output.results[0]).toMatchObject({
      availableQty: 20,
      allocatedQty: 5,
      remainingQty: 15
    });
  });

  it("uses required date before source order", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 5, requiredDate: "2026-09-01", customerContext: "later", sourceRow: 2 }),
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 5, requiredDate: "2026-08-01", customerContext: "first", sourceRow: 10 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 5 })
      ]
    });
    expect(output.results[0]).toMatchObject({ customerContext: "first", allocatedQty: 5 });
    expect(output.results[1]).toMatchObject({ customerContext: "later", allocatedQty: 0 });
  });

  it("does not count zero or negative stock as availability", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 0 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: null, qualityFlags: ["negative_available_quantity"] })
      ]
    });
    expect(output.results[0]).toMatchObject({
      opportunityType: "sourcing_needed",
      exactMpnMatch: true,
      exactMatch: true,
      usableAvailabilityMatch: false,
      exactQuantityMatch: false,
      availableQty: 0,
      allocatedQty: 0,
      shortageQty: 10
    });
    expect(output.results[0].warnings).toContain("negative_available_quantity");
    expect(output.summary).toMatchObject({
      exactMatches: 1,
      usableAvailabilityMatches: 0,
      exactQuantityMatches: 0
    });
  });

  it("ignores invalid supply quantities without reducing valid inventory", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: -5 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: Number.NaN, sourceRow: 3 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 10, sourceRow: 4 })
      ]
    });

    expect(output.results[0]).toMatchObject({
      opportunityType: "full_sale",
      exactMpnMatch: true,
      exactMatch: true,
      usableAvailabilityMatch: true,
      exactQuantityMatch: true,
      availableQty: 10,
      allocatedQty: 10,
      shortageQty: 0
    });
    expect(output.summary).toMatchObject({
      exactMatches: 1,
      usableAvailabilityMatches: 1,
      exactQuantityMatches: 1
    });
  });

  it("calculates usable and exact quantity matches from remaining inventory at allocation time", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({
          side: "A",
          role: "demand",
          mpn: "X",
          requiredQty: 5,
          requiredDate: "2026-08-01",
          customerContext: "first"
        }),
        row({
          side: "A",
          role: "demand",
          mpn: "X",
          requiredQty: 5,
          requiredDate: "2026-08-02",
          customerContext: "second",
          sourceRow: 3
        }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 5 })
      ]
    });

    expect(output.results[0]).toMatchObject({
      customerContext: "first",
      exactMpnMatch: true,
      exactMatch: true,
      usableAvailabilityMatch: true,
      exactQuantityMatch: true,
      allocatedQty: 5
    });
    expect(output.results[1]).toMatchObject({
      customerContext: "second",
      exactMpnMatch: true,
      exactMatch: true,
      usableAvailabilityMatch: false,
      exactQuantityMatch: false,
      allocatedQty: 0
    });
    expect(output.summary).toMatchObject({
      exactMatches: 1,
      usableAvailabilityMatches: 1,
      exactQuantityMatches: 1
    });
  });

  it("distinguishes full coverage from an exact quantity match", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 6 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 10 })
      ]
    });

    expect(output.results[0]).toMatchObject({
      opportunityType: "full_sale",
      usableAvailabilityMatch: true,
      exactQuantityMatch: false,
      allocatedQty: 6
    });
  });

  it("keeps manufacturer conflicts visible but not confirmed", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10, manufacturer: "TI" }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 10, manufacturer: "Samsung" })
      ]
    });
    expect(output.results[0]).toMatchObject({
      opportunityType: "review_required",
      exactMpnMatch: true,
      exactMatch: true,
      usableAvailabilityMatch: false,
      exactQuantityMatch: false,
      allocatedQty: 0,
      reasonCode: "manufacturer_conflict"
    });
  });

  it("keeps symbol-only variants outside exact opportunities", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "ABC-001", requiredQty: 10, manufacturer: "TI" }),
        row({ side: "B", role: "stock", mpn: "ABC001", availableQty: 10, manufacturer: "TI" })
      ]
    });
    expect(output.results.find((item) => item.displayMpn === "ABC-001")).toMatchObject({
      opportunityType: "sourcing_needed",
      exactMpnMatch: false,
      exactMatch: false
    });
    expect(output.possibleMatches).toHaveLength(1);
  });

  it("preserves every event/option/lot candidate when search norms and files repeat", () => {
    const demandRows = [
      row({
        side: "A",
        role: "demand",
        mpn: "ABC-001",
        manufacturer: "TI",
        requiredQty: 10,
        demandEventKey: "event:one",
        demandPartOptionId: "00000000-0000-4000-8000-000000000101",
        sourceRow: 2,
        originalIndex: 0,
        optionOrdinal: 1
      }),
      row({
        side: "A",
        role: "demand",
        mpn: "ABC/001",
        manufacturer: "TI",
        requiredQty: null,
        demandEventKey: "event:one",
        demandPartOptionId: "00000000-0000-4000-8000-000000000102",
        sourceRow: 3,
        originalIndex: 1,
        optionOrdinal: 2
      }),
      row({
        side: "A",
        role: "demand",
        mpn: "ABC-001",
        manufacturer: "TI",
        requiredQty: 20,
        demandEventKey: "event:two",
        demandPartOptionId: "00000000-0000-4000-8000-000000000201",
        sourceRow: 4,
        originalIndex: 2,
        optionOrdinal: 1
      }),
      row({
        side: "A",
        role: "demand",
        mpn: "ABC/001",
        manufacturer: "TI",
        requiredQty: null,
        demandEventKey: "event:two",
        demandPartOptionId: "00000000-0000-4000-8000-000000000202",
        sourceRow: 5,
        originalIndex: 3,
        optionOrdinal: 2
      })
    ];
    const supplyRows = [
      row({
        side: "B",
        role: "stock",
        mpn: "ABC 001",
        manufacturer: "TI",
        availableQty: 10,
        supplyLotKey: "lot:one",
        supplyLotId: "00000000-0000-4000-8000-000000000301",
        sourceRow: 2,
        originalIndex: 0
      }),
      row({
        side: "B",
        role: "stock",
        mpn: "ABC001",
        manufacturer: "TI",
        availableQty: 10,
        supplyLotKey: "lot:two",
        supplyLotId: "00000000-0000-4000-8000-000000000302",
        sourceRow: 3,
        originalIndex: 1
      })
    ];
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [...demandRows, ...supplyRows]
    });

    expect(output.possibleMatches).toHaveLength(8);
    expect(new Set(output.possibleMatches.map((match) => match.candidateKey)).size).toBe(8);
    expect(output.possibleMatches.every((match) => /^[a-f0-9]{64}$/.test(match.candidateKey))).toBe(true);
    expect(new Set(output.possibleMatches.map((match) => match.demandEventKey))).toEqual(
      new Set(["event:one", "event:two"])
    );
    expect(new Set(output.possibleMatches.map((match) => match.demandOptionId)).size).toBe(4);
    expect(new Set(output.possibleMatches.map((match) => match.supplyLotId)).size).toBe(2);

    const persisted = output.possibleMatches.map(possibleMatchInsert);
    expect(new Set(persisted.map((match) => match.candidate_key)).size).toBe(8);
    expect(new Set(persisted.map((match) => match.id)).size).toBe(8);
    expect(persisted.every((match) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(match.id)
    )).toBe(true);
    const repeated = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [...demandRows, ...supplyRows]
    }).possibleMatches.map(possibleMatchInsert);
    expect(repeated.map((match) => match.id)).toEqual(persisted.map((match) => match.id));
    expect(repeated.map((match) => match.candidate_key))
      .toEqual(persisted.map((match) => match.candidate_key));
    expect(persisted[0]).toMatchObject({
      id: expect.any(String),
      demand_option_id: expect.any(String),
      supply_lot_id: expect.any(String),
      demand_trace: expect.objectContaining({
        demandEventKey: expect.any(String),
        demandOptionId: expect.any(String),
        originalIndex: expect.any(Number)
      }),
      supply_trace: expect.objectContaining({
        supplyLotKey: expect.any(String),
        supplyLotId: expect.any(String),
        originalIndex: expect.any(Number)
      })
    });
    expect(persisted.every((match) => match.review_status === "pending")).toBe(true);
    expect(output.results.every((result) => result.candidateId == null)).toBe(true);

    const promoted = {
      ...output.results[0],
      candidateId: persisted[0].id,
      opportunityType: "review_required" as const,
      reviewStatus: "pending" as const
    };
    expect(resultInsert(promoted)).toMatchObject({
      candidate_id: persisted[0].id,
      opportunity_type: "review_required",
      review_status: "pending"
    });
    expect(() => possibleMatchInsert({
      ...output.possibleMatches[0],
      id: "00000000-0000-4000-8000-000000000001"
    })).toThrow("OPPORTUNITY_CANDIDATE_ID_CONFLICT");
  });

  it("deduplicates repeated copies of the same semantic option within one event", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({
          side: "A",
          role: "demand",
          mpn: "ABC-001",
          manufacturer: "TI",
          requiredQty: 10,
          demandEventKey: "event:one",
          sourceRow: 2,
          originalIndex: 0
        }),
        row({
          side: "A",
          role: "demand",
          mpn: "ABC-001",
          manufacturer: "TI",
          requiredQty: null,
          demandEventKey: "event:one",
          sourceRow: 3,
          originalIndex: 1
        }),
        row({
          side: "B",
          role: "stock",
          mpn: "ABC001",
          manufacturer: "TI",
          availableQty: 10,
          supplyLotKey: "lot:one"
        })
      ]
    });

    expect(output.summary).toMatchObject({ demandEvents: 1, demandPartOptions: 1 });
    expect(output.possibleMatches).toHaveLength(1);
  });

  it("attaches materialized option and lot UUIDs by physical source identity", () => {
    const identities = {
      demandPartOptionIdsByIdentity: new Map([
        [JSON.stringify(["event:one", "demand-file", "ABC-001", "Sheet1", 2, 7, 1]), "option-uuid-1"],
        [JSON.stringify(["event:one", "demand-file", "ABC-001", "Sheet1", 2, 8, 2]), "option-uuid-2"]
      ]),
      demandPartOptionIdsByOriginalIndex: new Map<string, string>(),
      supplyLotIdsByKey: new Map([["lot:one", "lot-uuid"]]),
      supplyLotIdsBySource: new Map([
        [JSON.stringify(["supply-file", "ABC001", "Sheet1", 2, 7]), "fallback-lot-uuid-1"],
        [JSON.stringify(["supply-file", "ABC001", "Sheet1", 2, 8]), "fallback-lot-uuid-2"]
      ]),
      demandEventCount: 2,
      demandPartOptionCount: 2,
      supplyLotCount: 2
    };
    const demandOne = attachMaterializedEntityIds(row({
      side: "A",
      role: "demand",
      mpn: "ABC-001",
      demandEventKey: "event:one",
      sourceRow: 2,
      originalIndex: 7,
      optionOrdinal: 1
    }), identities);
    const demandTwo = attachMaterializedEntityIds(row({
      side: "A",
      role: "demand",
      mpn: "ABC-001",
      demandEventKey: "event:one",
      sourceRow: 2,
      originalIndex: 8,
      optionOrdinal: 2
    }), identities);
    const supply = attachMaterializedEntityIds(row({
      side: "B",
      role: "stock",
      mpn: "ABC001",
      recordKind: "supply_lot",
      supplyLotKey: "lot:one",
      sourceRow: 2,
      originalIndex: 7
    }), identities);
    const fallbackSupply = attachMaterializedEntityIds(row({
      side: "B",
      role: "stock",
      mpn: "ABC001",
      recordKind: "supply_lot",
      supplyLotKey: null,
      sourceRow: 2,
      originalIndex: 8
    }), identities);

    expect(demandOne.demandPartOptionId).toBe("option-uuid-1");
    expect(demandTwo.demandPartOptionId).toBe("option-uuid-2");
    expect(supply.supplyLotId).toBe("lot-uuid");
    expect(fallbackSupply.supplyLotId).toBe("fallback-lot-uuid-2");
  });

  it("uses the normalized job context before resolving a generic materialized event", () => {
    const eventKey = ["ABC-001", "Context North", "", ""].join("\u001f");
    const contextualDemand = demandRowWithFallbackContext(row({
      side: "A",
      role: "demand",
      mpn: "ABC-001",
      sourceRow: 9,
      originalIndex: 12,
      optionOrdinal: 1
    }), "  Context   North  ");
    const attached = attachMaterializedEntityIds(contextualDemand, {
      demandPartOptionIdsByIdentity: new Map([[
        JSON.stringify([eventKey, "demand-file", "ABC-001", "Sheet1", 9, 12, 1]),
        "context-option-uuid"
      ]]),
      demandPartOptionIdsByOriginalIndex: new Map(),
      supplyLotIdsByKey: new Map(),
      supplyLotIdsBySource: new Map(),
      demandEventCount: 1,
      demandPartOptionCount: 1,
      supplyLotCount: 0
    });

    expect(contextualDemand.customerContext).toBe("Context North");
    expect(attached.demandPartOptionId).toBe("context-option-uuid");
  });

  it("always sends approved manufacturer aliases to review", () => {
    const previous = process.env.OPPORTUNITY_ALLOW_APPROVED_MFG_ALIAS_AUTO_MATCH;
    process.env.OPPORTUNITY_ALLOW_APPROVED_MFG_ALIAS_AUTO_MATCH = "true";
    try {
      const output = matchOpportunityRows({
        jobId: "job",
        roleA: "demand",
        roleB: "stock",
        rows: [
          row({ side: "A", role: "demand", mpn: "ALIAS", manufacturer: "TI", requiredQty: 10 }),
          row({ side: "B", role: "stock", mpn: "ALIAS", manufacturer: "Texas Instruments", availableQty: 10 })
        ]
      });

      expect(output.results[0]).toMatchObject({
        opportunityType: "review_required",
        matchTier: "exact_mpn_approved_alias",
        allocatedQty: 0,
        reasonCode: "manufacturer_alias_review"
      });
    } finally {
      if (previous === undefined) delete process.env.OPPORTUNITY_ALLOW_APPROVED_MFG_ALIAS_AUTO_MATCH;
      else process.env.OPPORTUNITY_ALLOW_APPROVED_MFG_ALIAS_AUTO_MATCH = previous;
    }
  });

  it("marks received history as historical, never as current availability", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "received_history",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10 }),
        row({ side: "B", role: "received_history", mpn: "X", availableQty: 100 })
      ]
    });
    expect(output.results[0]).toMatchObject({
      opportunityType: "historical_signal",
      exactMpnMatch: true,
      exactMatch: true,
      usableAvailabilityMatch: false,
      exactQuantityMatch: false,
      availableQty: null,
      allocatedQty: null,
      actionCode: "upload_current_stock"
    });
  });

  it.each([
    "received_history",
    "purchase_history",
    "quote_history",
    "sales_history"
  ] as const)("keeps %s strictly historical across conflicts, search variants, and embedded offers", (historyRole) => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: historyRole,
      rows: [
        row({
          side: "A",
          role: "demand",
          mpn: "HISTORY-CONFLICT",
          manufacturer: "TI",
          requiredQty: 5
        }),
        row({
          side: "B",
          role: historyRole,
          mpn: "HISTORY-CONFLICT",
          manufacturer: "MICRON",
          availableQty: 50,
          offerPrice: 2,
          unitCost: 1,
          currency: "USD",
          currencyStatus: "confirmed"
        }),
        row({ side: "A", role: "demand", mpn: "SEARCH-001", manufacturer: "TI", requiredQty: 3, sourceRow: 3 }),
        row({ side: "B", role: historyRole, mpn: "SEARCH001", manufacturer: "TI", availableQty: 30, sourceRow: 3 }),
        row({
          side: "A",
          role: "supplier_offer",
          recordKind: "supply_lot",
          supplyLotKey: "embedded-history-offer",
          mpn: "SEARCH-001",
          manufacturer: "TI",
          availableQty: 3,
          offerPrice: 1.5,
          currency: "USD",
          currencyStatus: "confirmed",
          sourceRow: 4
        })
      ]
    });

    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      opportunityType: "historical_signal",
      allocatedQty: null,
      availableQty: null,
      targetPrice: null,
      offerPrice: null,
      currency: null,
      unitCost: null,
      grossProfit: null,
      reviewStatus: "not_required"
    });
    expect(output.results[0].warnings).toEqual(expect.arrayContaining([
      "manufacturer_conflict",
      "historical_not_current_stock"
    ]));
    expect(output.results[0].allocations).toEqual([]);
    expect(output.possibleMatches).toEqual([]);
    expect(output.summary).toMatchObject({
      historicalSignals: 1,
      reviewRequired: 0,
      supplierOfferMatches: 0,
      possibleMatches: 0,
      supplyLots: 2
    });
  });

  it("uses a supplier offer embedded on the demand side as a distinct current lot", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "EMBEDDED", requiredQty: 8, manufacturer: "TI" }),
        row({
          side: "A",
          role: "supplier_offer",
          recordKind: "supply_lot",
          supplyLotKey: "embedded:offer:1",
          mpn: "EMBEDDED",
          availableQty: 8,
          manufacturer: "TI",
          expiresAt: "2099-12-31T23:59:59.000Z",
          sourceRow: 2,
          originalIndex: 1
        })
      ]
    });

    expect(output.results[0]).toMatchObject({
      opportunityType: "supplier_offer_match",
      allocatedQty: 8,
      shortageQty: 0,
      supplyFileId: "demand-file"
    });
    expect(output.summary.supplyLots).toBe(1);
  });

  it("requires a strictly future expiry before treating a supplier offer as live", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "supplier_offer",
      rows: [
        row({ side: "A", role: "demand", mpn: "STRICT-EXPIRY", manufacturer: "TI", requiredQty: 8 }),
        row({
          side: "B",
          role: "supplier_offer",
          mpn: "STRICT-EXPIRY",
          manufacturer: "TI",
          availableQty: 8,
          expiresAt: null,
          qualityFlags: ["offer_validity_unknown"]
        })
      ]
    });

    expect(output.results[0]).toMatchObject({
      opportunityType: "review_required",
      reasonCode: "offer_not_live",
      allocatedQty: 0,
      shortageQty: 8,
      reviewStatus: "pending",
      warnings: expect.arrayContaining(["offer_validity_unknown"]),
      allocations: []
    });
    expect(output.summary).toMatchObject({ reviewRequired: 1, supplierOfferMatches: 0 });
  });

  it("preserves punctuation and Unicode in exact manufacturer identity", () => {
    const punctuation = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "MFG-PUNCT", manufacturer: "A-B", requiredQty: 1 }),
        row({ side: "B", role: "stock", mpn: "MFG-PUNCT", manufacturer: "AB", availableQty: 1 })
      ]
    });
    expect(punctuation.results[0]).toMatchObject({
      opportunityType: "review_required",
      reasonCode: "manufacturer_conflict",
      allocatedQty: 0
    });

    const unicode = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "MFG-CJK", manufacturer: "台積電", requiredQty: 1 }),
        row({ side: "B", role: "stock", mpn: "MFG-CJK", manufacturer: "台積電", availableQty: 1 })
      ]
    });
    expect(unicode.results[0]).toMatchObject({
      opportunityType: "full_sale",
      matchTier: "exact_mpn_mfg",
      allocatedQty: 1
    });
    expect(unicode.results[0].warnings).not.toContain("manufacturer_missing");
  });

  it("does not count one lot twice when duplicate event options can both match it", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({
          side: "A",
          role: "demand",
          mpn: "ONE-LOT",
          manufacturer: "TI",
          requiredQty: 10,
          demandEventKey: "event:one"
        }),
        row({
          side: "A",
          role: "demand",
          mpn: "ONE-LOT",
          manufacturer: null,
          requiredQty: null,
          demandEventKey: "event:one",
          sourceRow: 3,
          originalIndex: 1
        }),
        row({ side: "B", role: "stock", mpn: "ONE-LOT", manufacturer: "TI", availableQty: 6 })
      ]
    });

    expect(output.results[0]).toMatchObject({
      availableQty: 6,
      allocatedQty: 6,
      shortageQty: 4
    });
    expect(output.results[0].allocations).toHaveLength(1);
  });

  it("never emits forbidden commercial fields", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "X", requiredQty: 10 }),
        row({ side: "B", role: "stock", mpn: "X", availableQty: 10 })
      ]
    });
    expect(containsForbiddenOpportunityFields(output)).toBe(false);
  });

  it("counts Sanmina/Flex alternate MPN rows as one demand event", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({
          side: "A",
          role: "demand",
          mpn: "OPTION-A",
          requiredQty: 100,
          demandEventKey: "snapshot:ORDDD-1",
          customerContext: "Event 1"
        }),
        row({
          side: "A",
          role: "demand",
          mpn: "OPTION-B",
          requiredQty: 100,
          demandEventKey: "snapshot:ORDDD-1",
          customerContext: "Event 1",
          sourceRow: 3,
          originalIndex: 1
        }),
        row({ side: "B", role: "stock", mpn: "OPTION-B", availableQty: 100 })
      ]
    });

    expect(output.results.filter((result) => result.demandFileId)).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      opportunityType: "full_sale",
      demandEventKey: "snapshot:ORDDD-1",
      requiredQty: 100,
      allocatedQty: 100,
      displayMpn: "OPTION-B"
    });
    expect(output.summary).toMatchObject({ demandEvents: 1, demandPartOptions: 2 });
  });

  it("allocates only compatible lots when another lot has a manufacturer conflict", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "MIXED", requiredQty: 10, manufacturer: "TI" }),
        row({ side: "B", role: "stock", mpn: "MIXED", availableQty: 4, manufacturer: "TI" }),
        row({ side: "B", role: "stock", mpn: "MIXED", availableQty: 20, manufacturer: "Samsung", sourceRow: 3 })
      ]
    });

    expect(output.results[0]).toMatchObject({
      opportunityType: "partial_sale",
      availableQty: 24,
      allocatedQty: 4,
      shortageQty: 6
    });
    expect(output.results[0].warnings).toContain("manufacturer_conflict");
    expect(output.results[0].allocations).toHaveLength(1);
  });

  it("carries the materialized demand option identity into every allocation", () => {
    const demandPartOptionId = "4ac9d264-8c75-4ee4-a070-4ac8e89951b2";
    const supplyLotId = "146d77ac-75ad-46ef-849f-944cd2d78c46";
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({
          side: "A",
          role: "demand",
          mpn: "TRACE-OPTION",
          manufacturer: "MICRON",
          requiredQty: 4,
          demandPartOptionId
        }),
        row({
          side: "B",
          role: "stock",
          mpn: "TRACE-OPTION",
          manufacturer: "MICRON",
          availableQty: 4,
          supplyLotId
        })
      ]
    });

    expect(output.results[0].allocations).toEqual([
      expect.objectContaining({ demandPartOptionId, supplyLotId, allocatedQty: 4 })
    ]);
  });

  it("reserves MOQ/SPQ deterministically without reusing the reserved remainder", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "PACK", requiredQty: 6, customerContext: "first", requiredDate: "2026-08-01" }),
        row({ side: "A", role: "demand", mpn: "PACK", requiredQty: 6, customerContext: "second", requiredDate: "2026-08-02", sourceRow: 3 }),
        row({ side: "B", role: "stock", mpn: "PACK", availableQty: 12, moq: 10, spq: 5 })
      ]
    });

    expect(output.results[0]).toMatchObject({ opportunityType: "full_sale", allocatedQty: 6 });
    expect(output.results[0].allocations?.[0]).toMatchObject({ availableBefore: 12, remainingQty: 2 });
    expect(output.results[1]).toMatchObject({ opportunityType: "sourcing_needed", allocatedQty: 0 });
    expect(output.results[1].warnings).toContain("moq_not_met");
  });

  it("computes target competitiveness and GP only when valid cost exists", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "PRICE", requiredQty: 10, targetPrice: 2, targetCurrency: "USD", currencyStatus: "confirmed" }),
        row({ side: "B", role: "stock", mpn: "PRICE", availableQty: 10, offerPrice: 1.5, unitCost: 1, currency: "USD", currencyStatus: "confirmed" })
      ]
    });

    expect(output.results[0]).toMatchObject({
      targetPrice: 2,
      offerPrice: 1.5,
      targetGapPercent: -25,
      revenuePotential: 15,
      unitCost: 1,
      grossProfit: 5
    });
    expect(output.results[0].grossMarginPercent).toBeCloseTo(33.3333, 3);
    expect(containsForbiddenOpportunityFields(output)).toBe(true);
  });

  it("does not calculate revenue, target gap, GP, or margin without confirmed currency", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "NO-CURRENCY", requiredQty: 4, targetPrice: 2 }),
        row({ side: "B", role: "stock", mpn: "NO-CURRENCY", availableQty: 4, offerPrice: 1.5, unitCost: 1 })
      ]
    });

    expect(output.results[0]).toMatchObject({
      targetGapPercent: null,
      currency: null,
      revenuePotential: null,
      grossProfit: null,
      grossMarginPercent: null
    });
  });

  it("never uses demand target currency to validate a supply offer or unit cost", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({
          side: "A",
          role: "demand",
          mpn: "CURRENCY-PROVENANCE",
          requiredQty: 4,
          targetPrice: 2,
          targetCurrency: "USD",
          currencyStatus: "confirmed"
        }),
        row({
          side: "B",
          role: "stock",
          mpn: "CURRENCY-PROVENANCE",
          availableQty: 4,
          offerPrice: 1.5,
          unitCost: 1,
          currency: null,
          currencyStatus: "unconfirmed"
        })
      ]
    });
    const result = output.results[0];

    expect(result).toMatchObject({
      targetCurrency: "USD",
      offerCurrency: null,
      costCurrency: null,
      currency: null,
      targetGapPercent: null,
      revenuePotential: null,
      grossProfit: null,
      grossMarginPercent: null
    });
    expect(commercialInsert(result, "result-id")).toMatchObject({
      currency: null,
      pricing_quality: "unconfirmed"
    });
    expect(financialInsert(result, "result-id")).toBeNull();
  });

  it("aggregates multi-lot revenue and GP by actual allocated quantities without borrowing first-lot terms", () => {
    const baseRows = [
      row({ side: "A", role: "demand", mpn: "MULTI-PRICE", manufacturer: "TI", requiredQty: 5 }),
      row({
        side: "B",
        role: "stock",
        mpn: "MULTI-PRICE",
        manufacturer: "TI",
        availableQty: 3,
        offerPrice: 10,
        unitCost: 6,
        currency: "USD",
        currencyStatus: "confirmed",
        moq: 1,
        dateCode: "A",
        sourceRow: 2
      }),
      row({
        side: "B",
        role: "stock",
        mpn: "MULTI-PRICE",
        manufacturer: "TI",
        availableQty: 2,
        offerPrice: 12,
        unitCost: 7,
        currency: "USD",
        currencyStatus: "confirmed",
        moq: 2,
        dateCode: "B",
        sourceRow: 3,
        originalIndex: 1
      })
    ];
    const homogeneous = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: baseRows
    }).results[0];

    expect(homogeneous).toMatchObject({
      allocatedQty: 5,
      offerPrice: 10.8,
      offerCurrency: "USD",
      revenuePotential: 54,
      pricingQuality: "unconfirmed",
      unitCost: 6.4,
      costCurrency: "USD",
      grossProfit: 22,
      financialQuality: "valid",
      moq: null,
      dateCode: null
    });
    expect(homogeneous.grossMarginPercent).toBeCloseTo(40.7407, 3);
    expect(commercialInsert(homogeneous, "result-id")).toMatchObject({
      offer_price: 10.8,
      currency: "USD",
      revenue_potential: 54,
      pricing_quality: "unconfirmed"
    });
    expect(financialInsert(homogeneous, "result-id")).toMatchObject({
      unit_cost: 6.4,
      cost_currency: "USD",
      gross_profit: 22,
      cost_quality: "valid",
      cost_source_trace: { sources: expect.arrayContaining([
        expect.objectContaining({ sourceRow: 2 }),
        expect.objectContaining({ sourceRow: 3 })
      ]) }
    });

    const mixedCurrencyRows = baseRows.map((item, index) => index === 2
      ? { ...item, currency: "EUR", offerPrice: 13, unitCost: 8 }
      : item
    );
    const mixed = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: mixedCurrencyRows
    }).results[0];
    expect(mixed).toMatchObject({
      offerPrice: null,
      offerCurrency: null,
      currency: null,
      revenuePotential: null,
      pricingQuality: "unconfirmed",
      unitCost: null,
      costCurrency: null,
      grossProfit: null,
      grossMarginPercent: null,
      financialQuality: "untrusted",
      moq: null,
      dateCode: null
    });
    expect(financialInsert(mixed, "result-id")).toBeNull();
  });

  it("excludes inactive demand rows from matching and event counts", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [
        row({ side: "A", role: "demand", mpn: "N-A-DATE", requiredQty: 10, isActiveDemand: false }),
        row({ side: "B", role: "stock", mpn: "N-A-DATE", availableQty: 10 })
      ]
    });

    expect(output.summary).toMatchObject({ demandEvents: 0, demandPartOptions: 0 });
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      opportunityType: "supply_without_demand",
      allocatedQty: 0
    });
  });

  it("uses the optional job context only when the demand row has none", () => {
    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      clientContext: "  Sanmina   LATAM ",
      rows: [
        row({ side: "A", role: "demand", mpn: "WITH-CONTEXT", requiredQty: 5 }),
        row({
          side: "A",
          role: "demand",
          mpn: "FILE-CONTEXT",
          requiredQty: 5,
          customerContext: "From file",
          sourceRow: 3
        }),
        row({ side: "B", role: "stock", mpn: "WITH-CONTEXT", availableQty: 5 }),
        row({ side: "B", role: "stock", mpn: "FILE-CONTEXT", availableQty: 5, sourceRow: 3 })
      ]
    });

    expect(output.results.find((result) => result.normalizedMpn === "WITH-CONTEXT"))
      .toMatchObject({ customerContext: "Sanmina LATAM" });
    expect(output.results.find((result) => result.normalizedMpn === "FILE-CONTEXT"))
      .toMatchObject({ customerContext: "From file" });
  });

});
