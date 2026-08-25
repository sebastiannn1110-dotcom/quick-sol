import { createHash } from "node:crypto";
import {
  rebuildBusinessUploadSummary,
  type BusinessSummaryRebuildClaim
} from "@/lib/performance/business-summaries";

const UPLOAD_ID = "7b000000-0000-4000-8000-000000000010";
const REBUILD_ID = "7b000000-0000-4000-8000-000000000020";
const EVALUATION_AT = "2026-08-25T12:00:00.000Z";

function positiveInteger(name: string, fallback: number) {
  const marker = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(marker))?.slice(marker.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
}

const rowCount = positiveInteger("rows", 10_000);
const chunkSize = positiveInteger("chunk", 500);
if (chunkSize > 500) throw new Error("INVALID_CHUNK_SIZE");

function mb(bytes: number) {
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}

function sourceId(index: number) {
  return `7b000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function sourceRow(index: number) {
  const mpn = `R7-BENCH-${String(index).padStart(7, "0")}`;
  return {
    record_id: sourceId(index),
    record_created_at: new Date(Date.UTC(2026, 7, 25, 12, 0, 0) - index * 1000).toISOString(),
    record_payload: {
      upload_batch_id: UPLOAD_ID,
      raw_data: {
        MPN: mpn,
        "Required Qty": index % 10 === 0 ? 0.1 : (index % 97) + 1,
        "Required Date": "2026-09-30",
        Customer: `Synthetic Customer ${index % 17}`,
        Manufacturer: `Synthetic Maker ${index % 11}`
      },
      normalized_data: {},
      mpn,
      req_qty: index % 10 === 0 ? 0.1 : (index % 97) + 1
    }
  };
}

function canonicalRow(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = { ...(value as Record<string, unknown>) };
  delete row.source_ordinal;
  return row;
}

const summaryFingerprint = createHash("sha256");
const entityFingerprint = createHash("sha256");
let readOffset = 0;
let queryCount = 0;
let writeCount = 0;
let stageCalls = 0;
let heartbeatCalls = 0;
let publishCalls = 0;
let maxPayloadBytes = 0;
let maxChunkRows = 0;

function resolvedQuery(result: unknown) {
  return {
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    limit() { return Promise.resolve(result); },
    single() { return Promise.resolve(result); },
    then(resolve: (value: unknown) => unknown) { return Promise.resolve(result).then(resolve); }
  };
}

const supabase = {
  from(table: string) {
    queryCount += 1;
    if (table === "upload_batches") return resolvedQuery({
      data: {
        id: UPLOAD_ID,
        original_file_name: "r7-benchmark-synthetic.xlsx",
        detected_category: "pricing",
        status: "completed",
        created_at: EVALUATION_AT
      },
      error: null
    });
    if (table === "file_schema_profiles") return resolvedQuery({ data: [], error: null });
    if (table === "import_jobs") return resolvedQuery({ data: [], error: null });
    throw new Error(`UNEXPECTED_TABLE_${table}`);
  },
  async rpc(name: string, args: Record<string, unknown>) {
    queryCount += 1;
    if (name === "read_business_summary_source_chunk_v2") {
      const requested = Number(args.input_limit);
      const count = Math.min(requested, rowCount - readOffset);
      const data = count > 0
        ? Array.from({ length: count }, (_, local) => sourceRow(readOffset + local))
        : [];
      readOffset += count;
      maxChunkRows = Math.max(maxChunkRows, count);
      return { data, error: null };
    }
    if (name === "heartbeat_business_summary_rebuild_v2") {
      heartbeatCalls += 1;
      writeCount += 1;
      return { data: "2099-01-01T00:00:00.000Z", error: null };
    }
    if (name === "stage_business_summary_chunk_v2") {
      stageCalls += 1;
      writeCount += 1;
      const summaries = args.input_summary_rows as unknown[];
      const entities = args.input_entity_rows as unknown[];
      for (const row of summaries) {
        summaryFingerprint.update(`${JSON.stringify(canonicalRow(row))}\n`, "utf8");
      }
      for (const row of entities) {
        entityFingerprint.update(`${JSON.stringify(canonicalRow(row))}\n`, "utf8");
      }
      maxPayloadBytes = Math.max(maxPayloadBytes, Number(args.input_payload_bytes));
      return { data: { accepted: true, duplicate: false }, error: null };
    }
    if (name === "publish_business_summary_rebuild_v2") {
      publishCalls += 1;
      writeCount += 1;
      return { data: { status: "ready", version: 1 }, error: null };
    }
    throw new Error(`UNEXPECTED_RPC_${name}`);
  }
};

const claim: BusinessSummaryRebuildClaim = {
  upload_batch_id: UPLOAD_ID,
  target_data_version: 1,
  rebuild_id: REBUILD_ID,
  rebuild_generation: 1,
  fence_token: 1,
  lease_expires_at: "2099-01-01T00:00:00.000Z",
  evaluation_at: EVALUATION_AT
};

async function main() {
  const initial = process.memoryUsage();
  const startedAt = performance.now();
  const result = await rebuildBusinessUploadSummary(supabase as never, claim, "r7-benchmark-worker", {
    chunkSize,
    leaseSeconds: 120
  });
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const final = process.memoryUsage();

  const report = {
    rows: rowCount,
    batches: result.chunks,
    chunkSize,
    elapsedMs,
    rssInitialMb: mb(initial.rss),
    rssFinalMb: mb(final.rss),
    heapInitialMb: mb(initial.heapUsed),
    heapFinalMb: mb(final.heapUsed),
    maxChunkRows,
    maxChunkBytes: maxPayloadBytes,
    queryCount,
    writes: writeCount,
    stageCalls,
    heartbeatCalls,
    publishCalls,
    maxPayloadBytes,
    simultaneousVersions: 1,
    activeJobs: 1,
    summaryFingerprint: summaryFingerprint.digest("hex"),
    entityFingerprint: entityFingerprint.digest("hex"),
    sourceFingerprint: result.sourceFingerprint,
    result: result.sourceRecords === rowCount
      && result.peakChunkRows <= chunkSize
      && result.peakPayloadBytes <= 8 * 1024 * 1024
      && readOffset === rowCount
      ? "PASS"
      : "FAIL"
  };

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
