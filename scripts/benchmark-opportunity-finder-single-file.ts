import { performance } from "node:perf_hooks";
import { matchOpportunityRows } from "../lib/opportunity-finder/matcher";
import type { CanonicalOpportunityRow } from "../lib/opportunity-finder/types";

const scenarios = [
  { fileRows: 100, baseRows: 10_000 },
  { fileRows: 1_000, baseRows: 100_000 },
  { fileRows: 5_000, baseRows: 500_000 }
];

function row(side: "A" | "B", index: number, quantity: number): CanonicalOpportunityRow {
  const mpn = `MPN-${String(index).padStart(7, "0")}`;
  return {
    jobId: "benchmark",
    fileId: side === "A" ? "file" : "snapshot",
    side,
    fileName: side === "A" ? "benchmark.csv" : "Base QuikSol autorizada",
    sheetName: "benchmark",
    sourceRow: index + 2,
    originalIndex: index,
    recordRole: side === "A" ? "demand" : "stock",
    recordKind: side === "A" ? "demand_option" : "supply_lot",
    rawMpn: mpn,
    displayMpn: mpn,
    normalizedMpn: mpn,
    reviewKey: mpn.replaceAll("-", ""),
    manufacturer: "TI",
    customerContext: null,
    supplierContext: null,
    requiredQty: side === "A" ? quantity : null,
    availableQty: side === "B" ? quantity : null,
    excessQty: null,
    requiredDate: "2099-01-01",
    unitOfMeasure: "EA",
    isLiveSupply: true,
    qualityFlags: []
  };
}

for (const scenario of scenarios) {
  const started = performance.now();
  const memoryBefore = process.memoryUsage().heapUsed;
  const indexStarted = performance.now();
  const baseIndex = new Map<string, number>();
  for (let index = 0; index < scenario.baseRows; index += 1) {
    baseIndex.set(`MPN-${String(index).padStart(7, "0")}`, 10);
  }
  const indexMs = performance.now() - indexStarted;
  const lookupStarted = performance.now();
  const demand = Array.from({ length: scenario.fileRows }, (_, index) => row("A", index, 12));
  const candidates = demand.flatMap((item, index) =>
    baseIndex.has(item.normalizedMpn) ? [row("B", index, baseIndex.get(item.normalizedMpn)!)] : []
  );
  const lookupMs = performance.now() - lookupStarted;
  const matchingStarted = performance.now();
  const output = matchOpportunityRows({
    jobId: "benchmark",
    roleA: "demand",
    roleB: "stock",
    rows: [...demand, ...candidates]
  });
  const matchingMs = performance.now() - matchingStarted;
  const memoryAfter = process.memoryUsage().heapUsed;
  process.stdout.write(`${JSON.stringify({
    fileRows: scenario.fileRows,
    baseRows: scenario.baseRows,
    simulatedIndexedQueries: Math.ceil(scenario.fileRows / 150),
    candidateRows: candidates.length,
    results: output.results.length,
    indexBuildMs: Math.round(indexMs * 10) / 10,
    candidateLookupMs: Math.round(lookupMs * 10) / 10,
    matchingMs: Math.round(matchingMs * 10) / 10,
    totalMs: Math.round((performance.now() - started) * 10) / 10,
    heapDeltaMb: Math.round(Math.max(0, memoryAfter - memoryBefore) / 1024 / 1024 * 10) / 10
  })}\n`);
}
