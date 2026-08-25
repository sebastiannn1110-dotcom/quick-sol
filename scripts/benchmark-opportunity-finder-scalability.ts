import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createOpportunityMatcherDiagnostics,
  matchOpportunityRows,
  matchOpportunityRowsAsync
} from "../lib/opportunity-finder/matcher";
import type { CanonicalOpportunityRow } from "../lib/opportunity-finder/types";

type Scenario =
  | "typical"
  | "unique"
  | "same-mpn"
  | "same-mpn-high-cardinality"
  | "hot-10"
  | "manufacturer-incompatible"
  | "demand-heavy"
  | "supply-heavy"
  | "duplicates";

function argument(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const size = Number.parseInt(argument("size", "1000"), 10);
const scenario = argument("scenario", "typical") as Scenario;
const shuffle = argument("shuffle", "false") === "true";
const includeFingerprint = argument("fingerprint", "true") !== "false";
const forceGc = argument("gc", "false") === "true";
const useAsync = argument("async", "false") === "true";
const useStream = argument("stream", "false") === "true";
const profileMemory = argument("profile-memory", "false") === "true";
if (!Number.isSafeInteger(size) || size < 2 || size > 250_000) {
  throw new Error("--size must be an integer between 2 and 250000");
}
if (!new Set<Scenario>([
  "typical",
  "unique",
  "same-mpn",
  "same-mpn-high-cardinality",
  "hot-10",
  "manufacturer-incompatible",
  "demand-heavy",
  "supply-heavy",
  "duplicates"
]).has(scenario)) {
  throw new Error("Unsupported --scenario");
}

function splitCounts() {
  if (scenario === "demand-heavy") return { demand: Math.floor(size * 0.9), supply: size - Math.floor(size * 0.9) };
  if (scenario === "supply-heavy") return { demand: Math.floor(size * 0.1), supply: size - Math.floor(size * 0.1) };
  return { demand: Math.floor(size / 2), supply: size - Math.floor(size / 2) };
}

function mpnFor(index: number, sideCount: number) {
  if (scenario === "same-mpn" || scenario === "same-mpn-high-cardinality") {
    return "SYNTH-HOT-000000";
  }
  if (scenario === "hot-10") return `SYNTH-HOT-${String(index % 10).padStart(6, "0")}`;
  if (scenario === "duplicates") return `SYNTH-DUP-${String(index % Math.max(1, Math.floor(sideCount / 20))).padStart(6, "0")}`;
  if (scenario === "typical") return `SYNTH-TYP-${String(index % Math.max(1, Math.floor(Math.min(size, sideCount) / 2))).padStart(6, "0")}`;
  return `SYNTH-UNQ-${String(index).padStart(6, "0")}`;
}

function canonicalRow(
  side: "A" | "B",
  index: number,
  sideCount: number
): CanonicalOpportunityRow {
  const mpn = mpnFor(index, sideCount);
  const demand = side === "A";
  const manufacturer = scenario === "manufacturer-incompatible"
    ? demand ? "SYNTH-DEMAND-MFG" : "SYNTH-SUPPLY-MFG"
    : scenario === "same-mpn-high-cardinality"
      ? `SYNTH-MFG-${String(index).padStart(6, "0")}`
    : `SYNTH-MFG-${index % 7}`;
  return {
    jobId: "synthetic-r6-benchmark",
    fileId: demand ? "synthetic-demand" : "synthetic-supply",
    side,
    fileName: demand ? "synthetic-demand.csv" : "synthetic-supply.csv",
    sheetName: "Synthetic",
    sourceRow: index + 2,
    originalIndex: index,
    recordRole: demand ? "demand" : "stock",
    recordKind: demand ? "demand_option" : "supply_lot",
    rawMpn: mpn,
    displayMpn: mpn,
    normalizedMpn: mpn,
    reviewKey: mpn.replaceAll("-", ""),
    manufacturer,
    manufacturerCanonical: manufacturer,
    customerContext: demand
      ? scenario === "duplicates"
        ? `Synthetic customer ${index % Math.max(1, Math.floor(sideCount / 20))}`
        : `Synthetic customer ${index}`
      : null,
    supplierContext: demand ? null : `Synthetic supplier ${index % 11}`,
    requiredQty: demand ? 5 + (index % 13) : null,
    availableQty: demand ? null : 3 + (index % 17),
    excessQty: null,
    requiredDate: demand
      ? scenario === "duplicates"
        ? "2099-01-15"
        : `2099-01-${String(1 + (index % 28)).padStart(2, "0")}`
      : null,
    unitOfMeasure: index % 9 === 0 ? null : "EA",
    isActiveDemand: demand ? true : undefined,
    isLiveSupply: demand ? undefined : true,
    supplyLotKey: demand ? null : `synthetic-lot-${index}`,
    demandEventKey: demand && scenario === "typical"
      ? `synthetic-event-${Math.floor(index / 5)}`
      : null,
    optionOrdinal: demand && scenario === "typical" ? (index % 5) + 1 : null,
    qualityFlags: []
  };
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function deterministicShuffle<T>(values: T[]) {
  const shuffled = [...values];
  let state = 0x6d2b79f5;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + index) | 0;
    const target = Math.abs(state) % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

async function runBenchmark() {
const counts = splitCounts();
const generationStarted = performance.now();
const demandRows = Array.from(
  { length: counts.demand },
  (_, index) => canonicalRow("A", index, counts.demand)
);
const supplyRows = Array.from(
  { length: counts.supply },
  (_, index) => canonicalRow("B", index, counts.supply)
);
const generationMs = performance.now() - generationStarted;
const diagnostics = createOpportunityMatcherDiagnostics();
if (forceGc) global.gc?.();
const beforeMemory = process.memoryUsage();
const started = performance.now();
const rows = shuffle
  ? deterministicShuffle([...demandRows, ...supplyRows])
  : [...demandRows, ...supplyRows];
const matchInput = {
  jobId: "synthetic-r6-benchmark",
  rows,
  roleA: "demand",
  roleB: "stock",
  diagnostics
} as const;
let streamedResultCount = 0;
let streamedPossibleMatchCount = 0;
const streamedClassifications = new Map<string, number>();
const streamFingerprint = includeFingerprint ? createHash("sha256") : null;
const output = useAsync || useStream
  ? await matchOpportunityRowsAsync(matchInput, {
      operationsPerYield: 2_048,
      ...(profileMemory
        ? {
            eventsPerYield: 1_000,
            onProgress: ({ completedEvents, totalEvents }: {
              completedEvents: number;
              totalEvents: number;
            }) => {
              const memory = process.memoryUsage();
              process.stderr.write(`${JSON.stringify({
                completedEvents,
                totalEvents,
                heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024 * 10) / 10,
                rssMb: Math.round(memory.rss / 1024 / 1024 * 10) / 10
              })}\n`);
            }
          }
        : {}),
      ...(useStream
        ? {
            collectOutput: false,
            outputChunkSize: 500,
            onOutputChunk: (chunk: {
              results: Array<{ opportunityType: string }>;
              possibleMatches: unknown[];
            }) => {
              streamedResultCount += chunk.results.length;
              streamedPossibleMatchCount += chunk.possibleMatches.length;
              for (const result of chunk.results) {
                streamedClassifications.set(
                  result.opportunityType,
                  (streamedClassifications.get(result.opportunityType) ?? 0) + 1
                );
              }
              streamFingerprint?.update(JSON.stringify(chunk), "utf8");
            }
          }
        : {})
    })
  : matchOpportunityRows(matchInput);
const matcherMs = performance.now() - started;
if (forceGc) global.gc?.();
const afterMemory = process.memoryUsage();

const classifications = useStream
  ? Object.fromEntries(Array.from(streamedClassifications).sort(([left], [right]) =>
      left.localeCompare(right)
    ))
  : Object.fromEntries(
      Array.from(new Set(output.results.map((result) => result.opportunityType))).sort().map((type) => [
        type,
        output.results.filter((result) => result.opportunityType === type).length
      ])
    );
const fingerprint = includeFingerprint
  ? useStream
    ? (streamFingerprint?.update(JSON.stringify(output.summary), "utf8").digest("hex") ?? null)
    : stableFingerprint({
        results: output.results,
        possibleMatches: output.possibleMatches,
        summary: output.summary
      })
  : null;
const maxRssMb = process.resourceUsage().maxRSS / 1024;

process.stdout.write(`${JSON.stringify({
  scenario,
  shuffle,
  forceGc,
  useAsync: useAsync || useStream,
  useStream,
  totalInputRows: size,
  acceptedRows: demandRows.length + supplyRows.length,
  demandRows: demandRows.length,
  supplyRows: supplyRows.length,
  generationMs: Math.round(generationMs * 10) / 10,
  matcherMs: Math.round(matcherMs * 10) / 10,
  totalProcessingMs: Math.round((generationMs + matcherMs) * 10) / 10,
  rssBeforeMb: Math.round(beforeMemory.rss / 1024 / 1024 * 10) / 10,
  rssAfterMb: Math.round(afterMemory.rss / 1024 / 1024 * 10) / 10,
  heapBeforeMb: Math.round(beforeMemory.heapUsed / 1024 / 1024 * 10) / 10,
  heapAfterMb: Math.round(afterMemory.heapUsed / 1024 / 1024 * 10) / 10,
  maxRssMb: Math.round(maxRssMb * 10) / 10,
  candidateComparisons:
    diagnostics.exactCandidateComparisons + diagnostics.reviewCandidateComparisons,
  resultCount: useStream ? streamedResultCount : output.results.length,
  possibleMatchCount: useStream ? streamedPossibleMatchCount : output.possibleMatches.length,
  classifications,
  diagnostics,
  fingerprint
})}\n`);
}

void runBenchmark();
