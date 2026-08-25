import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createOpportunityMatcherDiagnostics,
  matchOpportunityRows,
  matchOpportunityRowsAsync
} from "@/lib/opportunity-finder/matcher";
import type { CanonicalOpportunityRow } from "@/lib/opportunity-finder/types";

function row(input: {
  side: "A" | "B";
  index: number;
  mpn: string;
  manufacturer?: string | null;
  customer?: string | null;
  requiredQty?: number | null;
  availableQty?: number | null;
  unit?: string | null;
  eventKey?: string | null;
}): CanonicalOpportunityRow {
  const demand = input.side === "A";
  return {
    jobId: "synthetic-r6-test",
    fileId: demand ? "synthetic-demand" : "synthetic-supply",
    side: input.side,
    fileName: demand ? "synthetic-demand.csv" : "synthetic-supply.csv",
    sheetName: "Synthetic",
    sourceRow: input.index + 2,
    originalIndex: input.index,
    recordRole: demand ? "demand" : "stock",
    recordKind: demand ? "demand_option" : "supply_lot",
    rawMpn: input.mpn,
    displayMpn: input.mpn,
    normalizedMpn: input.mpn,
    reviewKey: input.mpn.replace(/[^A-Z0-9]/g, ""),
    manufacturer: input.manufacturer ?? "SYNTH-MFG",
    manufacturerCanonical: input.manufacturer ?? "SYNTH-MFG",
    customerContext: demand ? input.customer ?? `Synthetic customer ${input.index}` : null,
    supplierContext: demand ? null : `Synthetic supplier ${input.index % 5}`,
    requiredQty: demand ? input.requiredQty ?? 1 : null,
    availableQty: demand ? null : input.availableQty ?? 1,
    excessQty: null,
    requiredDate: demand ? "2099-01-01" : null,
    unitOfMeasure: input.unit === undefined ? "EA" : input.unit,
    demandEventKey: demand ? input.eventKey ?? null : null,
    supplyLotKey: demand ? null : `synthetic-lot-${input.index}`,
    isActiveDemand: demand ? true : undefined,
    isLiveSupply: demand ? undefined : true,
    qualityFlags: []
  };
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function deterministicShuffle<T>(values: T[]) {
  const shuffled = [...values];
  let state = 0x5f3759df;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 13), 1 | state) + index) | 0;
    const target = Math.abs(state) % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

describe("Opportunity Finder scalability contracts", () => {
  it("uses exact and review indexes instead of scanning every supply lot", () => {
    const count = 2_000;
    const demand = Array.from({ length: count }, (_, index) => row({
      side: "A",
      index,
      mpn: `SYNTH-UNIQUE-${index}`
    }));
    const supply = Array.from({ length: count }, (_, index) => row({
      side: "B",
      index,
      mpn: `SYNTH-UNIQUE-${index}`
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(output.results).toHaveLength(count);
    expect(diagnostics.exactCandidateComparisons).toBe(count);
    expect(diagnostics.reviewCandidateComparisons).toBe(0);
    expect(diagnostics.maxCandidateMaterialization).toBe(1);
    expect(diagnostics.normalizationCalls).toBe((count * 2) * 3);
  });

  it("reuses one bounded candidate plan for thousands of same-MPN rows", () => {
    const count = 1_000;
    const demand = Array.from({ length: count }, (_, index) => row({
      side: "A",
      index,
      mpn: "SYNTH-HOT-MPN",
      requiredQty: 1
    }));
    const supply = Array.from({ length: count }, (_, index) => row({
      side: "B",
      index,
      mpn: "SYNTH-HOT-MPN",
      availableQty: 1
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(output.results).toHaveLength(count);
    expect(output.results.every((result) => result.opportunityType === "full_sale")).toBe(true);
    expect(diagnostics.exactCandidateComparisons).toBe(count);
    expect(diagnostics.reviewCandidateComparisons).toBe(0);
    expect(diagnostics.candidatePlanCacheHits).toBe(count - 1);
    expect(diagnostics.maxCandidateMaterialization).toBe(count);
    expect(diagnostics.allocationCandidatesVisited).toBe(count);
    expect(output.results[0].supplyTraces).toBe(output.results[1].supplyTraces);
  });

  it("uses manufacturer and UOM indexes for high-cardinality hot MPNs", () => {
    const count = 500;
    const demand = Array.from({ length: count }, (_, index) => row({
      side: "A",
      index,
      mpn: "SYNTH-HOT-HIGH-CARDINALITY",
      manufacturer: `SYNTH-MFG-${index}`
    }));
    const supply = Array.from({ length: count }, (_, index) => row({
      side: "B",
      index,
      mpn: "SYNTH-HOT-HIGH-CARDINALITY",
      manufacturer: `SYNTH-MFG-${index}`
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(output.results).toHaveLength(count);
    expect(diagnostics.exactCandidateComparisons).toBeLessThanOrEqual(count * 2);
    expect(diagnostics.exactCandidateComparisons).toBeLessThan(count * count);
    expect(diagnostics.maxCandidateMaterialization).toBeLessThanOrEqual(2);
    expect(diagnostics.provenancePreviewCandidates).toBeLessThanOrEqual(count * 32);
    expect(diagnostics.maxProvenancePreviewMaterialization).toBeLessThanOrEqual(32);
    expect(diagnostics.candidatePlanCacheHits).toBe(0);
  });

  it("keeps honest candidate-index visits subquadratic for unique UOM signatures", () => {
    const count = 500;
    const demand = Array.from({ length: count }, (_, index) => row({
      side: "A",
      index,
      mpn: "SYNTH-HOT-UOM-CARDINALITY",
      manufacturer: "TI",
      unit: `DETERMINISTIC-UOM-${index}`,
      eventKey: `synthetic-uom-event-${index}`
    }));
    const supply = Array.from({ length: count }, (_, index) => row({
      side: "B",
      index,
      mpn: "SYNTH-HOT-UOM-CARDINALITY",
      manufacturer: "TI",
      unit: `DETERMINISTIC-UOM-${index}`
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(output.results).toHaveLength(count);
    expect(diagnostics.candidateIndexEntriesVisited).toBeLessThanOrEqual(count * 64);
    expect(diagnostics.candidateIndexEntriesVisited).toBeLessThan(count * count);
    expect(diagnostics.exactCandidateComparisons).toBeLessThanOrEqual(count * 2);
    expect(diagnostics.maxCandidateMaterialization).toBeLessThanOrEqual(2);
  });

  it("reuses a bounded plan when hot-MPN supply omits manufacturer", () => {
    const count = 500;
    const demand = Array.from({ length: count }, (_, index) => row({
      side: "A",
      index,
      mpn: "SYNTH-HOT-MISSING-MFG",
      manufacturer: `SYNTH-DEMAND-MFG-${index}`
    }));
    const supply = Array.from({ length: count }, (_, index) => ({
      ...row({
        side: "B",
        index,
        mpn: "SYNTH-HOT-MISSING-MFG",
        manufacturer: null
      }),
      manufacturer: null,
      manufacturerCanonical: null
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(output.results).toHaveLength(count);
    expect(diagnostics.exactCandidateComparisons).toBeLessThanOrEqual(count * 2);
    expect(diagnostics.exactCandidateComparisons).toBeLessThan(count * count);
    expect(diagnostics.candidatePlanCacheHits).toBe(count - 1);
  });

  it("avoids options x supply work for one explicit high-cardinality event", () => {
    const count = 500;
    const demand = Array.from({ length: count }, (_, index) => row({
      side: "A",
      index,
      mpn: "SYNTH-HOT-MULTI-OPTION",
      manufacturer: `SYNTH-DEMAND-MFG-${index}`,
      eventKey: "synthetic-high-card-event"
    }));
    const supply = Array.from({ length: count }, (_, index) => ({
      ...row({
        side: "B",
        index,
        mpn: "SYNTH-HOT-MULTI-OPTION",
        manufacturer: null
      }),
      manufacturer: null,
      manufacturerCanonical: null
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(output.results).toHaveLength(1);
    expect(output.summary.demandPartOptions).toBe(count);
    expect(diagnostics.exactCandidateComparisons).toBeLessThanOrEqual(count * 3);
    expect(diagnostics.exactCandidateComparisons).toBeLessThan(count * count);
  });

  it("uses compact generation when option count makes a 128-lot bucket quadratic", () => {
    const optionCount = 500;
    const supplyCount = 128;
    const demand = Array.from({ length: optionCount }, (_, index) => row({
      side: "A",
      index,
      mpn: "SYNTH-HOT-OPTIONS-128",
      manufacturer: `SYNTH-MFG-${index}`,
      eventKey: "synthetic-options-128-event"
    }));
    const supply = Array.from({ length: supplyCount }, (_, index) => row({
      side: "B",
      index,
      mpn: "SYNTH-HOT-OPTIONS-128",
      manufacturer: `SYNTH-MFG-${index}`
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();

    matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(diagnostics.exactCandidateComparisons).toBeLessThan(optionCount * 10);
    expect(diagnostics.exactCandidateComparisons).toBeLessThan(optionCount * supplyCount);
  });

  it("preserves exact-vs-alias UOM review semantics across the compact threshold", () => {
    const match = (count: number) => {
      const exactOption = {
        ...row({
          side: "A",
          index: 0,
          mpn: "SYNTH-COMPACT-UOM",
          manufacturer: "TI",
          unit: "EA",
          eventKey: "synthetic-compact-uom-event"
        }),
        manufacturerCanonical: "TEXAS-INSTRUMENTS"
      };
      const aliasOption = {
        ...row({
          side: "A",
          index: 1,
          mpn: "SYNTH-COMPACT-UOM",
          manufacturer: "TEXAS INSTRUMENTS",
          unit: "KG",
          eventKey: "synthetic-compact-uom-event"
        }),
        manufacturerCanonical: "TEXAS-INSTRUMENTS"
      };
      const supply = Array.from({ length: count }, (_, index) => ({
        ...row({
          side: "B",
          index,
          mpn: "SYNTH-COMPACT-UOM",
          manufacturer: "TI",
          unit: "KG"
        }),
        manufacturerCanonical: "TEXAS-INSTRUMENTS",
        expiresAt: "2000-01-01T00:00:00.000Z"
      }));
      return matchOpportunityRows({
        jobId: "synthetic-r6-test",
        rows: [exactOption, aliasOption, ...supply],
        roleA: "demand",
        roleB: "stock"
      }).results[0];
    };

    for (const result of [match(128), match(129), match(257)]) {
      expect(result).toMatchObject({
        opportunityType: "review_required",
        reasonCode: "incompatible_unit",
        matchTier: "exact_mpn_mfg"
      });
      expect(result.warnings).toEqual([
        "incompatible_unit",
        "offer_expired"
      ]);
    }
  });

  it("does not inherit missing-UOM warnings from a losing option at the compact threshold", () => {
    const match = (count: number) => {
      const exactOption = row({
        side: "A",
        index: 0,
        mpn: "SYNTH-COMPACT-MISSING-UOM",
        manufacturer: "TI",
        unit: "EA",
        eventKey: "synthetic-compact-missing-uom-event"
      });
      const losingOption = row({
        side: "A",
        index: 1,
        mpn: "SYNTH-COMPACT-MISSING-UOM",
        manufacturer: "ADI",
        unit: null,
        eventKey: "synthetic-compact-missing-uom-event"
      });
      const supply = Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: "SYNTH-COMPACT-MISSING-UOM",
        manufacturer: "TI",
        unit: "EA"
      }));
      return matchOpportunityRows({
        jobId: "synthetic-r6-test",
        rows: [exactOption, losingOption, ...supply],
        roleA: "demand",
        roleB: "stock"
      }).results[0];
    };

    expect(match(128)).toMatchObject({ opportunityType: "full_sale", warnings: [] });
    expect(match(129)).toMatchObject({ opportunityType: "full_sale", warnings: [] });
  });

  it("keeps missing manufacturer disjoint from canonical aliases above the compact threshold", () => {
    vi.stubEnv("OPPORTUNITY_ALLOW_MISSING_MANUFACTURER_AUTO_MATCH", "false");
    try {
      const match = (count: number) => matchOpportunityRows({
        jobId: "synthetic-r6-test",
        rows: [
          {
            ...row({
              side: "A",
              index: 0,
              mpn: "SYNTH-COMPACT-MISSING-CANONICAL",
              manufacturer: "A"
            }),
            manufacturerCanonical: "CANONICAL-X"
          },
          ...Array.from({ length: count }, (_, index) => ({
            ...row({
              side: "B",
              index,
              mpn: "SYNTH-COMPACT-MISSING-CANONICAL",
              manufacturer: null
            }),
            manufacturer: null,
            manufacturerCanonical: "CANONICAL-X"
          }))
        ],
        roleA: "demand",
        roleB: "stock"
      }).results[0];

      for (const result of [match(128), match(129), match(257)]) {
        expect(result).toMatchObject({
          opportunityType: "sourcing_needed",
          reasonCode: "no_available_supply"
        });
        expect(result.warnings).toContain("manufacturer_missing");
        expect(result.warnings).not.toContain("manufacturer_alias_requires_review");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps exact manufacturer disjoint when its canonical value differs", () => {
    const result = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [
        {
          ...row({
            side: "A",
            index: 0,
            mpn: "SYNTH-COMPACT-EXACT-CANONICAL",
            manufacturer: "A",
            unit: "EA"
          }),
          manufacturerCanonical: "CANONICAL-X"
        },
        {
          ...row({
            side: "B",
            index: 0,
            mpn: "SYNTH-COMPACT-EXACT-CANONICAL",
            manufacturer: "A",
            unit: "KG"
          }),
          manufacturerCanonical: "CANONICAL-Y"
        },
        ...Array.from({ length: 128 }, (_, index) => ({
          ...row({
            side: "B",
            index: index + 1,
            mpn: "SYNTH-COMPACT-EXACT-CANONICAL",
            manufacturer: "B",
            unit: "EA"
          }),
          manufacturerCanonical: "CANONICAL-X"
        }))
      ],
      roleA: "demand",
      roleB: "stock"
    }).results[0];

    expect(result).toMatchObject({
      opportunityType: "review_required",
      reasonCode: "manufacturer_alias_review"
    });
    expect(result.warnings).toContain("incompatible_unit");
    expect(result.warnings).toContain("manufacturer_alias_requires_review");
    expect(result.warnings).not.toContain("manufacturer_conflict");
  });

  it("detects a late incompatible exact UOM on both sides of the compact threshold", () => {
    const match = (count: number) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [
        row({
          side: "A",
          index: 0,
          mpn: "SYNTH-COMPACT-LATE-UOM",
          manufacturer: "TI",
          unit: "EA"
        }),
        ...Array.from({ length: count }, (_, index) => ({
          ...row({
            side: "B",
            index,
            mpn: "SYNTH-COMPACT-LATE-UOM",
            manufacturer: "TI",
            unit: index === count - 1 ? "KG" : "EA"
          }),
          expiresAt: "2000-01-01T00:00:00.000Z"
        }))
      ],
      roleA: "demand",
      roleB: "stock"
    }).results[0];

    for (const result of [match(128), match(129), match(257)]) {
      expect(result).toMatchObject({
        opportunityType: "review_required",
        reasonCode: "incompatible_unit"
      });
      expect(result.warnings).toEqual(["offer_expired", "incompatible_unit"]);
    }
  });

  it.each([
    ["approved alias", "CANONICAL-X", "manufacturer_alias_review", "manufacturer_alias_requires_review"],
    ["manufacturer conflict", "CANONICAL-Y", "manufacturer_conflict", "manufacturer_conflict"]
  ] as const)("detects late incompatible UOMs in %s groups above 256 lots", (
    _label,
    supplyCanonical,
    reasonCode,
    relationWarning
  ) => {
    const match = (count: number) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [
        {
          ...row({
            side: "A",
            index: 0,
            mpn: "SYNTH-COMPACT-LATE-RELATION-UOM",
            manufacturer: "A",
            unit: "EA"
          }),
          manufacturerCanonical: "CANONICAL-X"
        },
        ...Array.from({ length: count }, (_, index) => ({
          ...row({
            side: "B",
            index,
            mpn: "SYNTH-COMPACT-LATE-RELATION-UOM",
            manufacturer: "B",
            unit: index === count - 1 ? "KG" : "EA"
          }),
          manufacturerCanonical: supplyCanonical,
          expiresAt: "2000-01-01T00:00:00.000Z"
        }))
      ],
      roleA: "demand",
      roleB: "stock"
    }).results[0];

    for (const result of [match(128), match(129), match(257)]) {
      expect(result).toMatchObject({
        opportunityType: "review_required",
        reasonCode
      });
      expect(result.warnings).toContain(relationWarning);
      expect(result.warnings).toContain("incompatible_unit");
    }
  });

  it.each([
    ["approved alias", "SHARED-CANONICAL", "manufacturer_alias_review", "manufacturer_alias_requires_review"],
    ["manufacturer conflict", "OTHER-CANONICAL", "manufacturer_conflict", "manufacturer_conflict"]
  ] as const)(
    "preserves %s relations across the compact threshold",
    (_label, residualCanonical, reasonCode, warning) => {
      const match = (count: number) => {
        const options = ["A", "B"].map((manufacturer, index) => ({
          ...row({
            side: "A",
            index,
            mpn: "SYNTH-COMPACT-RELATION",
            manufacturer,
            eventKey: "synthetic-compact-relation-event"
          }),
          manufacturerCanonical: "SHARED-CANONICAL"
        }));
        const supply = Array.from({ length: count }, (_, index) => {
          const residual = index === count - 1;
          const manufacturer = residual ? "C" : index % 2 ? "A" : "B";
          return {
            ...row({
              side: "B",
              index,
              mpn: "SYNTH-COMPACT-RELATION",
              manufacturer
            }),
            manufacturerCanonical: residual ? residualCanonical : "SHARED-CANONICAL",
            expiresAt: "2000-01-01T00:00:00.000Z"
          };
        });
        return matchOpportunityRows({
          jobId: "synthetic-r6-test",
          rows: [...options, ...supply],
          roleA: "demand",
          roleB: "stock"
        }).results[0];
      };

      for (const result of [match(128), match(129), match(257)]) {
        expect(result).toMatchObject({ opportunityType: "review_required", reasonCode });
        expect(result.warnings).toContain(warning);
      }
    }
  );

  it("does not reuse an exact-manufacturer plan across different canonical relations", () => {
    const eventA = {
      ...row({
        side: "A",
        index: 0,
        mpn: "SYNTH-CACHE-CANONICAL",
        manufacturer: "TI",
        eventKey: "synthetic-cache-event-a"
      }),
      manufacturerCanonical: "CANONICAL-X"
    };
    const eventB = {
      ...row({
        side: "A",
        index: 1,
        mpn: "SYNTH-CACHE-CANONICAL",
        manufacturer: "TI",
        eventKey: "synthetic-cache-event-b"
      }),
      manufacturerCanonical: "CANONICAL-Y"
    };
    const exact = {
      ...row({
        side: "B",
        index: 0,
        mpn: "SYNTH-CACHE-CANONICAL",
        manufacturer: "TI",
        availableQty: 2
      }),
      manufacturerCanonical: "CANONICAL-X"
    };
    const alias = {
      ...row({
        side: "B",
        index: 1,
        mpn: "SYNTH-CACHE-CANONICAL",
        manufacturer: "TEXAS INSTRUMENTS",
        availableQty: 2
      }),
      manufacturerCanonical: "CANONICAL-X"
    };
    const diagnostics = createOpportunityMatcherDiagnostics();
    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [eventA, eventB, exact, alias],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });
    const byEvent = new Map(output.results.map((result) => [result.demandEventKey, result]));

    expect(byEvent.get("synthetic-cache-event-a")?.warnings).toContain(
      "manufacturer_alias_requires_review"
    );
    expect(byEvent.get("synthetic-cache-event-b")?.warnings).toContain("manufacturer_conflict");
    expect(diagnostics.candidatePlanCacheHits).toBe(0);
  });

  it("keeps warning order and canonical trace order stable across 128/129 lots", () => {
    const conflict = (count: number) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [
        row({
          side: "A",
          index: 0,
          mpn: "SYNTH-COMPACT-WARNINGS",
          manufacturer: "TI",
          unit: "EA"
        }),
        ...Array.from({ length: count }, (_, index) => ({
          ...row({
            side: "B",
            index,
            mpn: "SYNTH-COMPACT-WARNINGS",
            manufacturer: "ADI",
            unit: "KG"
          }),
          expiresAt: "2000-01-01T00:00:00.000Z"
        }))
      ],
      roleA: "demand",
      roleB: "stock"
    }).results[0];
    const full = conflict(128);
    const compact = conflict(129);

    expect(full.warnings).toEqual([
      "incompatible_unit",
      "manufacturer_conflict",
      "offer_expired"
    ]);
    expect(compact.warnings).toEqual(full.warnings);
    expect(compact.supplyTraces).toEqual(full.supplyTraces?.slice(0, 32));
    expect(full.supplyTracePreviewTruncated).not.toBe(true);
    expect(compact.supplyTracePreviewTruncated).toBe(true);
  });

  it("keeps candidate-ranked trace and sheet precedence in compact previews", () => {
    const match = (count: number) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [
        row({
          side: "A",
          index: 0,
          mpn: "SYNTH-COMPACT-TRACE-RANK",
          manufacturer: "TI",
          unit: "EA"
        }),
        ...Array.from({ length: count }, (_, index) => ({
          ...row({
            side: "B",
            index,
            mpn: "SYNTH-COMPACT-TRACE-RANK",
            manufacturer: index === 0 ? "ADI" : "TI",
            unit: "EA"
          }),
          sheetName: index === 0 ? "Conflict" : "Exact"
        }))
      ],
      roleA: "demand",
      roleB: "stock"
    }).results[0];
    const full = match(128);
    const compact = match(129);

    expect(full.supplyTraces?.[0]?.sheetName).toBe("Exact");
    expect(compact.supplyTraces?.[0]?.sheetName).toBe("Exact");
    expect(full.supplySheetName).toBe("Exact, Conflict");
    expect(compact.supplySheetName).toBe("Exact, Conflict");
    expect(compact.supplyTraces).toEqual(full.supplyTraces?.slice(0, 32));
  });

  it("keeps single-option compact output independent of cache composition above 256 lots", () => {
    const match = (includeEquivalentEvent: boolean) => {
      const demand = {
        ...row({
          side: "A",
          index: 0,
          mpn: "SYNTH-COMPACT-CACHE-COMPOSITION",
          manufacturer: "A",
          eventKey: "synthetic-compact-cache-event-a"
        }),
        manufacturerCanonical: "CANONICAL-X"
      };
      const equivalentDemand = {
        ...row({
          side: "A",
          index: 1,
          mpn: "SYNTH-COMPACT-CACHE-COMPOSITION",
          manufacturer: "A",
          eventKey: "synthetic-compact-cache-event-b"
        }),
        manufacturerCanonical: "CANONICAL-X"
      };
      const supply = Array.from({ length: 257 }, (_, index) => {
        const alias = index >= 128;
        return {
          ...row({
            side: "B",
            index,
            mpn: "SYNTH-COMPACT-CACHE-COMPOSITION",
            manufacturer: alias ? "B" : "C"
          }),
          manufacturerCanonical: alias ? "CANONICAL-X" : "CANONICAL-Y",
          sheetName: alias
            ? index < 193 ? "AliasA" : "AliasB"
            : "ConflictA",
          qualityFlags: index === 128
            ? ["formula_ignored" as const]
            : index === 0
              ? ["negative_available_quantity" as const]
              : []
        };
      });
      const diagnostics = createOpportunityMatcherDiagnostics();
      const output = matchOpportunityRows({
        jobId: "synthetic-r6-test",
        rows: [demand, ...(includeEquivalentEvent ? [equivalentDemand] : []), ...supply],
        roleA: "demand",
        roleB: "stock",
        diagnostics
      });
      return {
        result: output.results.find((item) =>
          item.demandEventKey === "synthetic-compact-cache-event-a"
        ),
        diagnostics
      };
    };
    const isolated = match(false);
    const composed = match(true);

    expect(fingerprint(composed.result)).toBe(fingerprint(isolated.result));
    expect(isolated.result?.supplyTraces).toHaveLength(32);
    expect(isolated.result?.supplyTraces?.every((trace) =>
      trace.sheetName === "AliasA"
    )).toBe(true);
    expect(isolated.result?.supplySheetName).toBe("AliasA, AliasB, ConflictA");
    expect(isolated.result?.warnings).toEqual([
      "formula_ignored",
      "manufacturer_alias_requires_review",
      "negative_available_quantity",
      "manufacturer_conflict"
    ]);
    expect(isolated.result?.supplyTracePreviewTruncated).toBe(true);
    expect(composed.diagnostics.candidatePlanCacheHits).toBe(1);
  });

  it("keeps possible-match work output-sensitive", () => {
    const demand = Array.from({ length: 500 }, (_, index) => row({
      side: "A",
      index,
      mpn: `SYNTH-${index}-A`
    }));
    const supply = Array.from({ length: 500 }, (_, index) => row({
      side: "B",
      index,
      mpn: `SYNTH-${index}A`
    }));
    const diagnostics = createOpportunityMatcherDiagnostics();
    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [...demand, ...supply],
      roleA: "demand",
      roleB: "stock",
      diagnostics
    });

    expect(output.possibleMatches).toHaveLength(500);
    expect(diagnostics.reviewCandidateComparisons).toBe(500);
    expect(diagnostics.possibleMatchesCreated).toBe(500);
    expect(diagnostics.exactCandidateComparisons).toBe(0);
  });

  it("does not include expired inventory in aggregate usable availability", () => {
    const demand = row({
      side: "A",
      index: 0,
      mpn: "SYNTH-EXPIRY",
      requiredQty: 5
    });
    const usable = row({
      side: "B",
      index: 0,
      mpn: "SYNTH-EXPIRY",
      availableQty: 5
    });
    const expired = {
      ...row({
        side: "B",
        index: 1,
        mpn: "SYNTH-EXPIRY",
        availableQty: 10
      }),
      expiresAt: "2000-01-01T00:00:00.000Z"
    };

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [demand, usable, expired],
      roleA: "demand",
      roleB: "stock"
    });

    expect(output.results[0]).toMatchObject({
      availableQty: 15,
      allocatedQty: 5,
      usableAvailabilityMatch: true,
      exactQuantityMatch: true
    });
  });

  it("preserves the golden result fingerprint when input rows are shuffled", () => {
    const rows = [
      row({ side: "A", index: 0, mpn: "SYNTH-A", manufacturer: "SYNTH-MFG", requiredQty: 5 }),
      row({ side: "A", index: 1, mpn: "SYNTH-B", manufacturer: "SYNTH-MFG", requiredQty: 8 }),
      row({ side: "A", index: 2, mpn: "SYNTH-C", manufacturer: "SYNTH-MFG", requiredQty: 3, unit: "EA" }),
      row({ side: "A", index: 3, mpn: "SYNTH-D", manufacturer: "SYNTH-OTHER", requiredQty: 2 }),
      row({ side: "B", index: 0, mpn: "SYNTH-A", manufacturer: "SYNTH-MFG", availableQty: 5 }),
      row({ side: "B", index: 1, mpn: "SYNTH-B", manufacturer: "SYNTH-MFG", availableQty: 3 }),
      row({ side: "B", index: 2, mpn: "SYNTH-C", manufacturer: "SYNTH-MFG", availableQty: 3, unit: "KG" }),
      row({ side: "B", index: 3, mpn: "SYNTH-D", manufacturer: "SYNTH-MFG", availableQty: 2 }),
      row({ side: "B", index: 4, mpn: "SYNTH-E", manufacturer: "SYNTH-MFG", availableQty: 7 })
    ];
    const match = (inputRows: CanonicalOpportunityRow[]) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: inputRows,
      roleA: "demand",
      roleB: "stock"
    });

    const ordered = match(rows);
    const shuffled = match(deterministicShuffle(rows));

    expect(fingerprint(shuffled)).toBe(fingerprint(ordered));
    expect(fingerprint(ordered)).toBe(
      "61d054027c59f9c7c12bc7ba6f9a7f1a32a95af6f243c71729e017e5afed367c"
    );
  });

  it("is deterministic for shuffled explicit multi-option events", () => {
    const rows = [
      row({ side: "A", index: 0, mpn: "SYNTH-ALT-A", eventKey: "event-1", requiredQty: 7 }),
      row({ side: "A", index: 1, mpn: "SYNTH-ALT-B", eventKey: "event-1", requiredQty: 7 }),
      row({ side: "A", index: 2, mpn: "SYNTH-ALT-C", eventKey: "event-2", requiredQty: 4 }),
      row({ side: "A", index: 3, mpn: "SYNTH-ALT-D", eventKey: "event-2", requiredQty: 4 }),
      row({ side: "B", index: 0, mpn: "SYNTH-ALT-A", availableQty: 7 }),
      row({ side: "B", index: 1, mpn: "SYNTH-ALT-B", availableQty: 7 }),
      row({ side: "B", index: 2, mpn: "SYNTH-ALT-C", availableQty: 4 }),
      row({ side: "B", index: 3, mpn: "SYNTH-ALT-D", availableQty: 4 })
    ];
    const match = (inputRows: CanonicalOpportunityRow[]) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: inputRows,
      roleA: "demand",
      roleB: "stock"
    });

    expect(fingerprint(match(deterministicShuffle(rows)))).toBe(fingerprint(match(rows)));
  });

  it("deduplicates supply identities deterministically without losing quality warnings", () => {
    const demand = row({ side: "A", index: 0, mpn: "SYNTH-DUPLICATE-LOT", requiredQty: 1 });
    const supplyA = row({ side: "B", index: 0, mpn: "SYNTH-DUPLICATE-LOT", availableQty: 0 });
    const supplyB = {
      ...row({ side: "B", index: 0, mpn: "SYNTH-DUPLICATE-LOT", availableQty: null }),
      availableQty: null,
      qualityFlags: ["negative_available_quantity" as const]
    };
    const match = (rows: CanonicalOpportunityRow[]) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows,
      roleA: "demand",
      roleB: "stock"
    });
    const ordered = match([demand, supplyA, supplyB]);
    const shuffled = match([supplyB, demand, supplyA]);

    expect(fingerprint(shuffled)).toBe(fingerprint(ordered));
    expect(ordered.results[0].warnings).toContain("negative_available_quantity");
    expect(ordered.results[0].availableQty).toBe(0);
  });

  it("selects conflicting duplicate supply commercial terms deterministically", () => {
    const demand = row({ side: "A", index: 0, mpn: "SYNTH-DUPLICATE-MOQ", requiredQty: 1 });
    const base = row({ side: "B", index: 0, mpn: "SYNTH-DUPLICATE-MOQ", availableQty: 1 });
    const noMoq = { ...base, moq: null };
    const highMoq = { ...base, moq: 20 };
    const match = (rows: CanonicalOpportunityRow[]) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows,
      roleA: "demand",
      roleB: "stock"
    });

    expect(fingerprint(match([demand, noMoq, highMoq]))).toBe(
      fingerprint(match([highMoq, demand, noMoq]))
    );
  });

  it("selects conflicting duplicate demand context and target price deterministically", () => {
    const base = row({
      side: "A",
      index: 0,
      mpn: "SYNTH-DUPLICATE-DEMAND",
      requiredQty: 1,
      eventKey: "synthetic-duplicate-demand-event"
    });
    const demandA = {
      ...base,
      customerContext: "Synthetic customer A",
      targetPrice: 10,
      targetCurrency: "USD",
      currencyStatus: "confirmed" as const
    };
    const demandB = {
      ...base,
      customerContext: "Synthetic customer B",
      targetPrice: 20,
      targetCurrency: "USD",
      currencyStatus: "confirmed" as const
    };
    const supply = {
      ...row({ side: "B", index: 0, mpn: "SYNTH-DUPLICATE-DEMAND", availableQty: 1 }),
      offerPrice: 15,
      currency: "USD",
      currencyStatus: "confirmed" as const
    };
    const match = (rows: CanonicalOpportunityRow[]) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows,
      roleA: "demand",
      roleB: "stock"
    });

    expect(fingerprint(match([demandA, demandB, supply]))).toBe(
      fingerprint(match([demandB, supply, demandA]))
    );
  });

  it("preserves primary stock precedence over embedded supplier offers", () => {
    const stock = {
      ...row({ side: "B", index: 1, mpn: "SYNTH-SUPPLY-ONLY", availableQty: 2 }),
      supplierContext: "Synthetic stock source"
    };
    const offer = {
      ...row({ side: "B", index: 0, mpn: "SYNTH-SUPPLY-ONLY", availableQty: 3 }),
      recordRole: "supplier_offer" as const,
      supplierContext: "Synthetic offer source",
      expiresAt: "2099-01-01T00:00:00.000Z"
    };
    const match = (rows: CanonicalOpportunityRow[]) => matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows,
      roleA: "demand",
      roleB: "stock"
    });
    const ordered = match([stock, offer]);
    const shuffled = match([offer, stock]);

    expect(fingerprint(shuffled)).toBe(fingerprint(ordered));
    expect(ordered.results[0]).toMatchObject({
      opportunityType: "supply_without_demand",
      supplierContext: "Synthetic stock source",
      availableQty: 5
    });
  });

  it("keeps composite option and availability keys collision-free", () => {
    const demandA = row({
      side: "A",
      index: 0,
      mpn: "SYNTH-A\u001fB",
      manufacturer: "SYNTH-C",
      eventKey: "control-event",
      requiredQty: 5,
      unit: "EA"
    });
    const demandB = row({
      side: "A",
      index: 1,
      mpn: "SYNTH-A",
      manufacturer: "B\u001fSYNTH-C",
      eventKey: "control-event",
      requiredQty: 5,
      unit: "EA"
    });
    const supplyA = row({
      side: "B",
      index: 0,
      mpn: "SYNTH-A\u001fB",
      manufacturer: "SYNTH-C",
      availableQty: 5,
      unit: "EA"
    });
    const supplyB = row({
      side: "B",
      index: 1,
      mpn: "SYNTH-A",
      manufacturer: "B\u001fSYNTH-C",
      availableQty: 5,
      unit: "EA"
    });

    const output = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows: [demandA, demandB, supplyA, supplyB],
      roleA: "demand",
      roleB: "stock"
    });

    expect(output.summary.demandPartOptions).toBe(2);
    expect(output.results[0]).toMatchObject({
      opportunityType: "full_sale",
      allocatedQty: 5,
      supplySourceRows: 2
    });
  });

  it("does not label a live supplier offer as expired when missing-manufacturer auto-match is disabled", () => {
    vi.stubEnv("OPPORTUNITY_ALLOW_MISSING_MANUFACTURER_AUTO_MATCH", "false");
    try {
      const demand = {
        ...row({ side: "A", index: 0, mpn: "SYNTH-LIVE-OFFER" }),
        manufacturer: null,
        manufacturerCanonical: null
      };
      const offer = {
        ...row({ side: "B", index: 0, mpn: "SYNTH-LIVE-OFFER" }),
        recordRole: "supplier_offer" as const,
        manufacturer: null,
        manufacturerCanonical: null,
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      const output = matchOpportunityRows({
        jobId: "synthetic-r6-test",
        rows: [demand, offer],
        roleA: "demand",
        roleB: "supplier_offer"
      });

      expect(output.results[0]).toMatchObject({
        opportunityType: "sourcing_needed",
        reasonCode: "no_available_supply"
      });
      expect(output.results[0].reasonCode).not.toBe("offer_not_live");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("yields bounded progress while preserving synchronous result parity", async () => {
    const count = 120;
    const rows = [
      ...Array.from({ length: count }, (_, index) => row({
        side: "A",
        index,
        mpn: `SYNTH-ASYNC-${index}`
      })),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: `SYNTH-ASYNC-${index}`
      }))
    ];
    const progress: number[] = [];
    const asyncOutput = await matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock"
      },
      {
        eventsPerYield: 25,
        onProgress: ({ completedEvents }) => {
          progress.push(completedEvents);
        }
      }
    );
    const syncOutput = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows,
      roleA: "demand",
      roleB: "stock"
    });

    expect(progress).toEqual([25, 50, 75, 100, 120]);
    expect(fingerprint(asyncOutput)).toBe(fingerprint(syncOutput));
  });

  it("preserves sync parity while yielding inside one hot event", async () => {
    const count = 300;
    const rows = [
      row({
        side: "A",
        index: 0,
        mpn: "SYNTH-ASYNC-HOT-EVENT",
        requiredQty: 150,
        eventKey: "synthetic-async-hot-event"
      }),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: "SYNTH-ASYNC-HOT-EVENT",
        availableQty: 1
      }))
    ];
    const progress: number[] = [];
    let cancellationChecks = 0;

    const asyncOutput = await matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock"
      },
      {
        eventsPerYield: 100,
        operationsPerYield: 16,
        assertNotCancelled: () => {
          cancellationChecks += 1;
        },
        onProgress: ({ completedEvents }) => {
          progress.push(completedEvents);
        }
      }
    );
    const syncOutput = matchOpportunityRows({
      jobId: "synthetic-r6-test",
      rows,
      roleA: "demand",
      roleB: "stock"
    });

    expect(fingerprint(asyncOutput)).toBe(fingerprint(syncOutput));
    expect(progress).toEqual([1]);
    expect(cancellationChecks).toBeGreaterThan(3);
  });

  it("streams bounded chunks with the same classifications, candidates, and summary", async () => {
    const count = 120;
    const rows = [
      ...Array.from({ length: count }, (_, index) => row({
        side: "A",
        index,
        mpn: `SYNTH-STREAM-${index}`,
        requiredQty: 2
      })),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: `SYNTH-STREAM-${index}`,
        availableQty: index % 3
      })),
      row({ side: "A", index: count + 1, mpn: "SYNTH-STREAM-VARIANT-1" }),
      row({ side: "B", index: count + 1, mpn: "SYNTHSTREAMVARIANT1" }),
      row({ side: "B", index: count + 2, mpn: "SYNTH-STREAM-SUPPLY-ONLY" })
    ];
    const full = await matchOpportunityRowsAsync({
      jobId: "synthetic-r6-test",
      rows,
      roleA: "demand",
      roleB: "stock"
    });
    const streamedResults: typeof full.results = [];
    const streamedPossibleMatches: typeof full.possibleMatches = [];
    const chunkSizes: number[] = [];

    const streamed = await matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock"
      },
      {
        collectOutput: false,
        outputChunkSize: 7,
        onOutputChunk: (chunk) => {
          chunkSizes.push(chunk.results.length + chunk.possibleMatches.length);
          streamedResults.push(...chunk.results);
          streamedPossibleMatches.push(...chunk.possibleMatches);
        }
      }
    );

    expect(streamed.results).toEqual([]);
    expect(streamed.possibleMatches).toEqual([]);
    expect(streamed.summary).toEqual(full.summary);
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(7);
    expect(streamedResults.map(fingerprint).sort()).toEqual(
      full.results.map(fingerprint).sort()
    );
    expect(streamedPossibleMatches.map(fingerprint).sort()).toEqual(
      full.possibleMatches.map(fingerprint).sort()
    );
    expect(new Set(streamedResults.map((result) => result.opportunityType))).toEqual(
      new Set(full.results.map((result) => result.opportunityType))
    );
  });

  it("stops matching when the bounded output sink fails", async () => {
    const count = 100;
    const rows = [
      ...Array.from({ length: count }, (_, index) => row({
        side: "A",
        index,
        mpn: `SYNTH-STREAM-FAIL-${index}`
      })),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: `SYNTH-STREAM-FAIL-${index}`
      }))
    ];
    let chunkCalls = 0;
    let stagedResults = 0;

    await expect(matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock"
      },
      {
        collectOutput: false,
        outputChunkSize: 10,
        onOutputChunk: (chunk) => {
          chunkCalls += 1;
          stagedResults += chunk.results.length;
          if (chunkCalls === 2) throw new Error("SYNTHETIC_OUTPUT_STAGE_FAILED");
        }
      }
    )).rejects.toThrow("SYNTHETIC_OUTPUT_STAGE_FAILED");
    expect(chunkCalls).toBe(2);
    expect(stagedResults).toBe(20);
    expect(stagedResults).toBeLessThan(count);
  });

  it("observes cancellation inside the allocation loop of one hot event", async () => {
    const count = 300;
    const diagnostics = createOpportunityMatcherDiagnostics();
    const progress: number[] = [];
    const rows = [
      row({
        side: "A",
        index: 0,
        mpn: "SYNTH-CANCEL-HOT-ALLOCATION",
        requiredQty: count,
        eventKey: "synthetic-cancel-hot-allocation"
      }),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: "SYNTH-CANCEL-HOT-ALLOCATION",
        availableQty: 1
      }))
    ];

    await expect(matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock",
        diagnostics
      },
      {
        operationsPerYield: 16,
        assertNotCancelled: () => {
          if (diagnostics.allocationCandidatesVisited >= 16) {
            throw new Error("OPPORTUNITY_MATCH_CANCELLED_IN_ALLOCATION");
          }
        },
        onProgress: ({ completedEvents }) => {
          progress.push(completedEvents);
        }
      }
    )).rejects.toThrow("OPPORTUNITY_MATCH_CANCELLED_IN_ALLOCATION");
    expect(diagnostics.allocationCandidatesVisited).toBeGreaterThanOrEqual(16);
    expect(diagnostics.allocationCandidatesVisited).toBeLessThan(count);
    expect(progress).toEqual([]);
  });

  it("observes cancellation inside candidate planning of one hot event", async () => {
    const count = 300;
    const diagnostics = createOpportunityMatcherDiagnostics();
    const progress: number[] = [];
    const rows = [
      row({
        side: "A",
        index: 0,
        mpn: "SYNTH-CANCEL-HOT-PLAN",
        requiredQty: count,
        eventKey: "synthetic-cancel-hot-plan"
      }),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: "SYNTH-CANCEL-HOT-PLAN",
        availableQty: 1
      }))
    ];

    await expect(matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock",
        diagnostics
      },
      {
        operationsPerYield: 16,
        assertNotCancelled: () => {
          if (diagnostics.candidateIndexEntriesVisited >= 16) {
            throw new Error("OPPORTUNITY_MATCH_CANCELLED_IN_PLAN");
          }
        },
        onProgress: ({ completedEvents }) => {
          progress.push(completedEvents);
        }
      }
    )).rejects.toThrow("OPPORTUNITY_MATCH_CANCELLED_IN_PLAN");
    expect(diagnostics.candidateIndexEntriesVisited).toBeGreaterThanOrEqual(16);
    expect(diagnostics.candidateIndexEntriesVisited).toBeLessThan(count);
    expect(diagnostics.allocationCandidatesVisited).toBe(0);
    expect(progress).toEqual([]);
  });

  it("observes cancellation inside possible-match expansion of one hot event", async () => {
    const count = 300;
    const diagnostics = createOpportunityMatcherDiagnostics();
    const progress: number[] = [];
    const rows = [
      row({
        side: "A",
        index: 0,
        mpn: "SYNTH-VARIANT",
        eventKey: "synthetic-cancel-hot-review"
      }),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: "SYNTHVARIANT",
        availableQty: 1
      }))
    ];

    await expect(matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock",
        diagnostics
      },
      {
        operationsPerYield: 16,
        assertNotCancelled: () => {
          if (diagnostics.reviewCandidateComparisons >= 16) {
            throw new Error("OPPORTUNITY_MATCH_CANCELLED_IN_REVIEW");
          }
        },
        onProgress: ({ completedEvents }) => {
          progress.push(completedEvents);
        }
      }
    )).rejects.toThrow("OPPORTUNITY_MATCH_CANCELLED_IN_REVIEW");
    expect(diagnostics.reviewCandidateComparisons).toBeGreaterThanOrEqual(16);
    expect(diagnostics.reviewCandidateComparisons).toBeLessThan(count);
    expect(progress).toEqual([]);
  });

  it("observes cancellation while preparing fifty thousand rows", async () => {
    const count = 50_000;
    const diagnostics = createOpportunityMatcherDiagnostics();
    const progress: number[] = [];
    let cancellationChecks = 0;
    const rows = Array.from({ length: count }, (_, index) => row({
      side: "B",
      index,
      mpn: `SYNTH-CANCEL-PREPARE-${index}`,
      availableQty: 1
    }));

    await expect(matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock",
        diagnostics
      },
      {
        operationsPerYield: 32,
        assertNotCancelled: () => {
          cancellationChecks += 1;
          if (cancellationChecks >= 3) {
            throw new Error("OPPORTUNITY_MATCH_CANCELLED_IN_PREPARATION");
          }
        },
        onProgress: ({ completedEvents }) => {
          progress.push(completedEvents);
        }
      }
    )).rejects.toThrow("OPPORTUNITY_MATCH_CANCELLED_IN_PREPARATION");
    expect(cancellationChecks).toBe(3);
    expect(diagnostics.supplyLots).toBe(0);
    expect(diagnostics.candidateIndexEntriesVisited).toBe(0);
    expect(progress).toEqual([]);
  });

  it("observes cancellation while finalizing a hot supply-only bucket", async () => {
    const count = 20_000;
    const diagnostics = createOpportunityMatcherDiagnostics();
    let checksAfterPreparation = 0;
    const rows = Array.from({ length: count }, (_, index) => row({
      side: "B",
      index,
      mpn: "SYNTH-CANCEL-FINALIZE-HOT-SUPPLY",
      availableQty: 1
    }));

    await expect(matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock",
        diagnostics
      },
      {
        operationsPerYield: 4_096,
        assertNotCancelled: () => {
          if (diagnostics.supplyLots !== count) return;
          checksAfterPreparation += 1;
          if (checksAfterPreparation >= 3) {
            throw new Error("OPPORTUNITY_MATCH_CANCELLED_IN_FINALIZATION");
          }
        }
      }
    )).rejects.toThrow("OPPORTUNITY_MATCH_CANCELLED_IN_FINALIZATION");
    expect(diagnostics.supplyLots).toBe(count);
    expect(checksAfterPreparation).toBe(3);
    expect(diagnostics.candidateIndexEntriesVisited).toBe(0);
  });

  it("observes cancellation between event chunks", async () => {
    const count = 100;
    const rows = [
      ...Array.from({ length: count }, (_, index) => row({
        side: "A",
        index,
        mpn: `SYNTH-CANCEL-${index}`
      })),
      ...Array.from({ length: count }, (_, index) => row({
        side: "B",
        index,
        mpn: `SYNTH-CANCEL-${index}`
      }))
    ];
    let checks = 0;

    await expect(matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-test",
        rows,
        roleA: "demand",
        roleB: "stock"
      },
      {
        eventsPerYield: 10,
        assertNotCancelled: () => {
          checks += 1;
          if (checks === 3) throw new Error("OPPORTUNITY_MATCH_CANCELLED");
        }
      }
    )).rejects.toThrow("OPPORTUNITY_MATCH_CANCELLED");
    expect(checks).toBe(3);
  });
});
