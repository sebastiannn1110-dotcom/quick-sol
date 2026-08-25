import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  opportunityPayloadChunks,
  possibleMatchInsert,
  resultInsert,
  stageMatchOutput,
  type OpportunityOutputStage
} from "@/lib/opportunity-finder/worker";
import {
  matchOpportunityRows,
  matchOpportunityRowsAsync
} from "@/lib/opportunity-finder/matcher";
import type {
  CanonicalOpportunityRow,
  OpportunityResult
} from "@/lib/opportunity-finder/types";

function matcherRow(input: {
  side: "A" | "B";
  index: number;
  mpn: string;
}): CanonicalOpportunityRow {
  const demand = input.side === "A";
  return {
    jobId: "synthetic-r6-stream-worker",
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
    manufacturer: "SYNTH-MFG",
    manufacturerCanonical: "SYNTH-MFG",
    customerContext: demand ? `Synthetic customer ${input.index}` : null,
    supplierContext: demand ? null : "Synthetic supplier",
    requiredQty: demand ? 1 : null,
    availableQty: demand ? null : 1,
    excessQty: null,
    requiredDate: demand ? "2099-01-01" : null,
    unitOfMeasure: "EA",
    supplyLotKey: demand ? null : `synthetic-lot-${input.index}`,
    isActiveDemand: demand ? true : undefined,
    isLiveSupply: demand ? undefined : true,
    qualityFlags: []
  };
}

function hotMpnResult(traceCount: number): OpportunityResult {
  const supplyTraces = Array.from({ length: traceCount }, (_, index) => ({
    fileId: "synthetic-supply",
    fileName: "synthetic-supply.csv",
    sheetName: "Synthetic",
    sourceRow: index + 2,
    hidden: false,
    headerRow: 1,
    columns: { mpn: "A" },
    originalIndex: index,
    demandEventKey: null,
    demandOptionId: null,
    optionOrdinal: null,
    supplyLotKey: `synthetic-lot-${index}`,
    supplyLotId: null
  }));
  return {
    jobId: "synthetic-r6-payload",
    opportunityType: "full_sale",
    exactMpnMatch: true,
    exactMatch: true,
    usableAvailabilityMatch: true,
    exactQuantityMatch: true,
    displayMpn: "SYNTH-HOT-MPN",
    normalizedMpn: "SYNTH-HOT-MPN",
    manufacturer: "SYNTH-MFG",
    customerContext: "Synthetic customer",
    supplierContext: "Synthetic supplier",
    requiredQty: 1,
    availableQty: traceCount,
    allocatedQty: 1,
    shortageQty: 0,
    coveragePercent: 100,
    requiredDate: "2099-01-01",
    unitOfMeasure: "EA",
    demandFileId: "synthetic-demand",
    demandFileName: "synthetic-demand.csv",
    demandSheetName: "Synthetic",
    supplyFileId: "synthetic-supply",
    supplyFileName: "synthetic-supply.csv",
    supplySheetName: "Synthetic",
    demandSourceRows: 1,
    supplySourceRows: supplyTraces.length,
    supplyTraces,
    reasonCode: "fully_covered",
    actionCode: "sell_full",
    warnings: []
  };
}

function allocationHeavyResult(allocationCount: number): OpportunityResult {
  const result = hotMpnResult(0);
  result.demandEventKey = "synthetic-demand-event";
  result.requiredQty = allocationCount;
  result.availableQty = allocationCount;
  result.allocatedQty = allocationCount;
  result.allocations = Array.from({ length: allocationCount }, (_, index) => {
    const supplyLotId = `00000000-0000-4001-8000-${String(index + 1).padStart(12, "0")}`;
    return {
      lotKey: `synthetic-allocation-lot-${String(index).padStart(4, "0")}`,
      demandPartOptionId: "00000000-0000-4000-8000-000000000010",
      supplyLotId,
      allocatedQty: 1,
      reservedQty: 1,
      availableBefore: allocationCount - index,
      remainingQty: allocationCount - index - 1,
      supply: {
        fileId: "synthetic-supply",
        fileName: "synthetic-supply.csv",
        sheetName: "Synthetic",
        sourceRow: index + 2,
        hidden: false,
        headerRow: 1,
        columns: { mpn: "A" },
        originalIndex: index,
        demandEventKey: null,
        demandOptionId: null,
        optionOrdinal: null,
        supplyLotKey: `synthetic-allocation-lot-${String(index).padStart(4, "0")}`,
        supplyLotId
      }
    };
  });
  return result;
}

function legacyResultKey(result: OpportunityResult) {
  return createHash("sha256")
    .update(JSON.stringify({
      jobId: result.jobId,
      opportunityType: result.opportunityType,
      demandEventKey: result.demandEventKey ?? null,
      normalizedMpn: result.normalizedMpn,
      customerContext: result.customerContext,
      supplierContext: result.supplierContext,
      requiredDate: result.requiredDate,
      ...(result.candidateId ? { candidateId: result.candidateId } : {}),
      demandTraces: (result.demandTraces ?? []).map((trace) => [
        trace.fileId,
        trace.sheetName,
        trace.sourceRow
      ]),
      supplyTraces: (result.supplyTraces ?? []).map((trace) => [
        trace.fileId,
        trace.sheetName,
        trace.sourceRow
      ])
    }), "utf8")
    .digest("hex");
}

function deterministicResultId(resultKey: string) {
  const value = resultKey.slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16], 16) & 0x3) | 0x8).toString(16);
  const compact = value.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function compactResultKey(result: OpportunityResult) {
  const tracesDigest = (traces: NonNullable<OpportunityResult["supplyTraces"]>) => {
    const digest = createHash("sha256");
    for (const trace of traces) {
      digest.update(JSON.stringify([trace.fileId, trace.sheetName, trace.sourceRow]), "utf8");
    }
    return digest.digest("hex");
  };
  const allocations = result.allocations ?? [];
  const allocationDigest = createHash("sha256");
  for (const allocation of allocations) {
    allocationDigest.update(JSON.stringify([
      allocation.lotKey,
      allocation.demandPartOptionId,
      allocation.supplyLotId,
      allocation.allocatedQty,
      allocation.reservedQty,
      allocation.availableBefore,
      allocation.remainingQty,
      `${allocation.supply.fileId}\u001f${allocation.supply.sheetName}\u001f${allocation.supply.sourceRow}`
    ]), "utf8");
  }
  const demandTraces = result.demandTraces ?? [];
  const supplyTraces = result.supplyTraces ?? [];
  return createHash("sha256")
    .update(JSON.stringify({
      identityVersion: "opportunity-result-compact-v1",
      jobId: result.jobId,
      opportunityType: result.opportunityType,
      demandEventKey: result.demandEventKey ?? null,
      normalizedMpn: result.normalizedMpn,
      customerContext: result.customerContext,
      supplierContext: result.supplierContext,
      requiredDate: result.requiredDate,
      ...(result.candidateId ? { candidateId: result.candidateId } : {}),
      demandTraceCount: demandTraces.length,
      demandTraceDigest: tracesDigest(demandTraces),
      demandSourceRows: result.demandSourceRows,
      supplyTraceCount: supplyTraces.length,
      supplyTraceDigest: tracesDigest(supplyTraces),
      supplySourceRows: result.supplySourceRows,
      supplyTracePreviewTruncated: result.supplyTracePreviewTruncated === true,
      allocationCount: allocations.length,
      allocationDigest: allocationDigest.digest("hex")
    }), "utf8")
    .digest("hex");
}

function syntheticStage(): OpportunityOutputStage {
  return {
    jobId: "synthetic-r6-payload",
    workerId: "synthetic-worker",
    lockToken: "synthetic-lock",
    processingFence: 1,
    commitKey: "synthetic-commit",
    counts: {
      results: 0,
      possible_matches: 0,
      rejected_rows: 0,
      allocations: 0,
      commercials: 0,
      financials: 0
    }
  };
}

function outputWithResult(result: OpportunityResult) {
  return {
    results: [result],
    possibleMatches: [],
    rejectedRows: [],
    summary: {}
  } as Parameters<typeof stageMatchOutput>[2];
}

describe("Opportunity Finder bounded database payloads", () => {
  it("preserves the exact legacy result key and UUID when decision evidence is complete", () => {
    const result = hotMpnResult(12);
    result.demandTraces = [{
      ...result.supplyTraces![0],
      fileId: "synthetic-demand",
      fileName: "synthetic-demand.csv",
      sourceRow: 77
    }];
    result.demandSourceRows = 1;
    const expectedKey = legacyResultKey(result);

    const insert = resultInsert(result);

    expect(insert.result_key).toBe(expectedKey);
    expect(insert.id).toBe(deterministicResultId(expectedKey));
  });

  it("uses an explicit bounded identity version when decision evidence is truncated", () => {
    const first = hotMpnResult(64);
    const second = hotMpnResult(64);
    const expectedKey = compactResultKey(first);
    const legacyKey = legacyResultKey(first);

    const firstInsert = resultInsert(first);
    const secondInsert = resultInsert(second);

    expect(firstInsert.result_key).toBe(expectedKey);
    expect(firstInsert.result_key).not.toBe(legacyKey);
    expect(firstInsert.id).toBe(deterministicResultId(expectedKey));
    expect(secondInsert.result_key).toBe(firstInsert.result_key);
    expect(secondInsert.id).toBe(firstInsert.id);
  });

  it.each([999, 1000, 1001, 5000, 10000])(
    "preserves all %i records without a silent 1,000-row truncation",
    (count) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        id: index,
        value: `SYNTHETIC-${String(index).padStart(5, "0")}`
      }));
      const chunks = opportunityPayloadChunks(rows, 500, 64 * 1024);
      expect(chunks.flat()).toEqual(rows);
      expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    }
  );

  it("splits wide traces by UTF-8 payload size as well as row count", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id: index,
      trace: "x".repeat(1_024)
    }));
    const chunks = opportunityPayloadChunks(rows, 500, 4_096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(rows);
    expect(chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk), "utf8") <= 4_096)).toBe(true);
  });

  it("rejects a single item that cannot fit instead of emitting an oversized chunk", () => {
    expect(() => opportunityPayloadChunks(
      [{ trace: "x".repeat(8_192) }],
      500,
      4_096
    )).toThrow("OPPORTUNITY_OUTPUT_ITEM_EXCEEDS_DATABASE_PAYLOAD_LIMIT");
  });

  it("bounds repeated hot-MPN decision evidence before database serialization", () => {
    const result = hotMpnResult(5_000);

    const insert = resultInsert(result);
    expect(insert.supply_source_rows).toBe(5_000);
    expect(insert.supply_traces).toHaveLength(32);
    expect(Buffer.byteLength(JSON.stringify(insert), "utf8")).toBeLessThan(768 * 1024);
    expect(opportunityPayloadChunks([insert], 500, 768 * 1024)).toHaveLength(1);
  });

  it("transforms a raw oversized hot-MPN result before applying database payload limits", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const stage = syntheticStage();
    const output = outputWithResult(hotMpnResult(5_000));

    await expect(stageMatchOutput(
      { rpc } as unknown as SupabaseClient,
      stage,
      output
    )).resolves.toBeUndefined();

    const resultAppend = rpc.mock.calls.find(([, input]) =>
      (input as { output_kind?: string }).output_kind === "results"
    );
    expect(resultAppend).toBeDefined();
    const staged = (resultAppend?.[1] as { items: Array<{ supply_traces: unknown[] }> }).items[0];
    expect(staged.supply_traces).toHaveLength(32);
    expect(stage.counts.results).toBe(1);
  });

  it("stages 1,001 allocations with continuous ranks, start indexes, and counts", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const stage = syntheticStage();

    await expect(stageMatchOutput(
      { rpc } as unknown as SupabaseClient,
      stage,
      outputWithResult(allocationHeavyResult(1_001))
    )).resolves.toBeUndefined();

    const allocationAppends = rpc.mock.calls
      .map(([, input]) => input as {
        output_kind: string;
        start_index: number;
        items: Array<{
          allocation_key: string;
          supply_lot_key: string;
          deterministic_rank: number;
        }>;
      })
      .filter((input) => input.output_kind === "allocations");
    const stagedAllocations = allocationAppends.flatMap((append) => append.items);

    expect(allocationAppends.map((append) => append.items.length)).toEqual([500, 500, 1]);
    expect(allocationAppends.map((append) => append.start_index)).toEqual([0, 500, 1_000]);
    expect(stagedAllocations.map((row) => row.deterministic_rank)).toEqual(
      Array.from({ length: 1_001 }, (_, index) => index)
    );
    expect(stagedAllocations.map((row) => row.supply_lot_key)).toEqual(
      Array.from(
        { length: 1_001 },
        (_, index) => `synthetic-allocation-lot-${String(index).padStart(4, "0")}`
      )
    );
    expect(new Set(stagedAllocations.map((row) => row.allocation_key)).size).toBe(1_001);
    expect(stage.counts).toEqual({
      results: 1,
      possible_matches: 0,
      rejected_rows: 0,
      allocations: 1_001,
      commercials: 0,
      financials: 0
    });
  });

  it("stops allocation staging without advancing the failed chunk count", async () => {
    let allocationAppend = 0;
    const rpc = vi.fn(async (_name: string, input: { output_kind?: string }) => {
      if (input.output_kind === "allocations") {
        allocationAppend += 1;
        if (allocationAppend === 2) {
          return { data: null, error: { message: "SYNTHETIC_STAGE_FAILURE" } };
        }
      }
      return { data: null, error: null };
    });
    const stage = syntheticStage();

    await expect(stageMatchOutput(
      { rpc } as unknown as SupabaseClient,
      stage,
      outputWithResult(allocationHeavyResult(1_001))
    )).rejects.toMatchObject({ message: "SYNTHETIC_STAGE_FAILURE" });

    const allocationAppends = rpc.mock.calls
      .map(([, input]) => input as {
        output_kind: string;
        start_index: number;
        items: unknown[];
      })
      .filter((input) => input.output_kind === "allocations");
    expect(allocationAppends.map((append) => append.start_index)).toEqual([0, 500]);
    expect(allocationAppends.map((append) => append.items.length)).toEqual([500, 500]);
    expect(stage.counts.results).toBe(1);
    expect(stage.counts.allocations).toBe(500);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("preserves deterministic persisted IDs and classifications in bounded stream mode", async () => {
    const count = 60;
    const rows = [
      ...Array.from({ length: count }, (_, index) => matcherRow({
        side: "A",
        index,
        mpn: `SYNTH-STREAM-WORKER-${index}`
      })),
      ...Array.from({ length: count }, (_, index) => matcherRow({
        side: "B",
        index,
        mpn: `SYNTH-STREAM-WORKER-${index}`
      })),
      matcherRow({ side: "A", index: count + 1, mpn: "SYNTH-STREAM-VARIANT-1" }),
      matcherRow({ side: "B", index: count + 1, mpn: "SYNTHSTREAMVARIANT1" }),
      matcherRow({ side: "B", index: count + 2, mpn: "SYNTH-STREAM-SUPPLY-ONLY" })
    ];
    const full = matchOpportunityRows({
      jobId: "synthetic-r6-stream-worker",
      rows,
      roleA: "demand",
      roleB: "stock"
    });
    const streamedResults: OpportunityResult[] = [];
    const streamedPossibleMatches: typeof full.possibleMatches = [];
    const chunkSizes: number[] = [];
    const streamed = await matchOpportunityRowsAsync(
      {
        jobId: "synthetic-r6-stream-worker",
        rows,
        roleA: "demand",
        roleB: "stock"
      },
      {
        collectOutput: false,
        outputChunkSize: 13,
        onOutputChunk: (chunk) => {
          chunkSizes.push(chunk.results.length + chunk.possibleMatches.length);
          streamedResults.push(...chunk.results);
          streamedPossibleMatches.push(...chunk.possibleMatches);
        }
      }
    );
    const persistedResults = (results: OpportunityResult[]) => results.map((result) => {
      const insert = resultInsert(result);
      return [insert.id, insert.opportunity_type, insert.normalized_mpn];
    }).sort(([left], [right]) => String(left).localeCompare(String(right)));
    const persistedPossibleMatches = (matches: typeof full.possibleMatches) => matches
      .map((match) => {
        const insert = possibleMatchInsert(match);
        return [insert.id, insert.candidate_key, insert.reason_code];
      })
      .sort(([left], [right]) => String(left).localeCompare(String(right)));

    expect(streamed.results).toEqual([]);
    expect(streamed.possibleMatches).toEqual([]);
    expect(streamed.summary).toEqual(full.summary);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(13);
    expect(persistedResults(streamedResults)).toEqual(persistedResults(full.results));
    expect(persistedPossibleMatches(streamedPossibleMatches)).toEqual(
      persistedPossibleMatches(full.possibleMatches)
    );
  });

  it("keeps matching cancelable and progress chunked in the production worker", () => {
    const worker = fs.readFileSync(
      path.join(process.cwd(), "lib/opportunity-finder/worker.ts"),
      "utf8"
    );

    expect(worker).toContain("matchOpportunityRowsAsync");
    expect(worker).toContain("eventsPerYield: 100");
    expect(worker).toContain("collectOutput: false");
    expect(worker).toContain("outputChunkSize: OUTPUT_STAGE_CHUNK_SIZE");
    expect(worker).toContain("onOutputChunk: async (chunk)");
    expect(worker).toContain("await stageMatchOutput(input.supabase, input.outputStage, chunk)");
    expect(worker).toContain("assertNotCancelled: () => requireNotCancelled");
    expect(worker).toContain("reportMatchingProgress");
    expect(worker).toContain("completedEvents / totalEvents");
    expect(worker).toContain('.eq("cancel_requested", false)');
    expect(worker).toContain("cancelled = await isCancelled");
  });
});
