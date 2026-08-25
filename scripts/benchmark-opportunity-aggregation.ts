import { performance } from "node:perf_hooks";
import {
  buildSalesOpportunitiesResult,
  detectOpportunitySignals
} from "@/lib/opportunities/opportunities";
import type { StockNeedsRecord } from "@/lib/stock-needs/stock-needs";

function input(size: number) {
  const records: StockNeedsRecord[] = Array.from({ length: size }, (_, index) => {
    const mpn = `MPN-${Math.floor(index / 10)}`;
    const stock = index % 2 === 0;
    return stock
      ? { upload_batch_id: "stock", mpn, on_hand: 2, manufacturer: `MFG-${index % 3}`, upload_batches: { detected_category: "Inventory" } }
      : { upload_batch_id: "demand", mpn, req_qty: 1, customer: "Synthetic", upload_batches: { detected_category: "pricing" } };
  });
  return {
    records,
    profiles: [
      { upload_batch_id: "stock", detected_template: "inventario" },
      { upload_batch_id: "demand", detected_template: "pricing" }
    ]
  };
}

function measured<T>(fn: () => T) {
  global.gc?.();
  const memoryBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const value = fn();
  return {
    value,
    ms: Number((performance.now() - started).toFixed(3)),
    heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore
  };
}

function legacyQuadratic(inputValue: ReturnType<typeof input>) {
  buildSalesOpportunitiesResult({ ...inputValue, filters: { limit: 1 } });
  const signals = detectOpportunitySignals(inputValue);
  const groups = new Set(signals.map((signal) => signal.normalizedMpn));
  let mixed = 0;
  for (const mpn of groups) {
    const manufacturers = new Set(signals.filter((signal) => signal.normalizedMpn === mpn).map((signal) => signal.manufacturerName).filter(Boolean));
    if (manufacturers.size > 1) mixed += 1;
  }
  return mixed;
}

const results = [];
for (const size of [1000, 5000, 10000, 50000, 100000]) {
  const fixture = input(size);
  const current = measured(() => buildSalesOpportunitiesResult({ ...fixture, filters: { limit: 1 } }));
  const legacy = size <= 10000 ? measured(() => legacyQuadratic(input(size))) : null;
  results.push({
    rows: size,
    legacyMs: legacy?.ms ?? null,
    currentMs: current.ms,
    legacyHeapDeltaBytes: legacy?.heapDeltaBytes ?? null,
    currentHeapDeltaBytes: current.heapDeltaBytes,
    speedup: legacy ? Number((legacy.ms / current.ms).toFixed(2)) : null,
    legacyStatus: legacy ? "measured" : "not_run_to_avoid_intentional_quadratic_cpu"
  });
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
