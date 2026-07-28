import path from "node:path";
import {
  parseOpportunityWorkbook,
  profileOpportunityWorkbook
} from "@/lib/opportunity-finder/parser";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import type {
  CanonicalOpportunityRow,
  OpportunitySelectedRole
} from "@/lib/opportunity-finder/types";

const [fileAPath, fileBPath] = process.argv.slice(2);
if (!fileAPath || !fileBPath) {
  throw new Error("Usage: tsx scripts/benchmark-opportunity-finder.ts <file-a> <file-b>");
}

function memoryMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function main() {
  let peakRssMb = memoryMb();
  const monitor = setInterval(() => {
    peakRssMb = Math.max(peakRssMb, memoryMb());
  }, 100);
  const startedAt = performance.now();
  try {
    const profileStarted = performance.now();
    const profileA = await profileOpportunityWorkbook(fileAPath, path.basename(fileAPath));
    const profileB = await profileOpportunityWorkbook(fileBPath, path.basename(fileBPath));
    const profileMs = Math.round(performance.now() - profileStarted);
    if (profileA.detectedType !== "demand" && profileB.detectedType !== "demand") {
      throw new Error("Benchmark requires one demand file.");
    }
    const roleA = profileA.detectedType as OpportunitySelectedRole;
    const roleB = profileB.detectedType as OpportunitySelectedRole;
    const rows: CanonicalOpportunityRow[] = [];
    let canonicalJsonBytes = 0;
    const parseStarted = performance.now();
    const metricsA = await parseOpportunityWorkbook({
      filePath: fileAPath,
      fileName: path.basename(fileAPath),
      fileId: "00000000-0000-4000-8000-00000000000a",
      jobId: "00000000-0000-4000-8000-000000000001",
      side: "A",
      role: roleA,
      onBatch: async (batch) => {
        canonicalJsonBytes += Buffer.byteLength(JSON.stringify(batch));
        rows.push(...batch);
      }
    });
    const metricsB = await parseOpportunityWorkbook({
      filePath: fileBPath,
      fileName: path.basename(fileBPath),
      fileId: "00000000-0000-4000-8000-00000000000b",
      jobId: "00000000-0000-4000-8000-000000000001",
      side: "B",
      role: roleB,
      onBatch: async (batch) => {
        canonicalJsonBytes += Buffer.byteLength(JSON.stringify(batch));
        rows.push(...batch);
      }
    });
    const parseMs = Math.round(performance.now() - parseStarted);
    const matchStarted = performance.now();
    const output = matchOpportunityRows({
      jobId: "00000000-0000-4000-8000-000000000001",
      rows,
      roleA,
      roleB,
      missingMpnRows: metricsA.missingMpnRows + metricsB.missingMpnRows,
      invalidQuantityRows: metricsA.invalidQuantityRows + metricsB.invalidQuantityRows
    });
    const matchMs = Math.round(performance.now() - matchStarted);
    let resultJsonBytes = 0;
    for (const result of output.results) {
      resultJsonBytes += Buffer.byteLength(JSON.stringify(result));
    }
    const durationMs = Math.round(performance.now() - startedAt);
    process.stdout.write(JSON.stringify({
      fileA: {
        type: profileA.detectedType,
        sheets: profileA.sheetCount,
        rows: profileA.rowCount,
        canonicalRows: metricsA.canonicalRows
      },
      fileB: {
        type: profileB.detectedType,
        sheets: profileB.sheetCount,
        rows: profileB.rowCount,
        canonicalRows: metricsB.canonicalRows
      },
      profileMs,
      parseMs,
      matchMs,
      durationMs,
      rowsPerSecond: Math.round((metricsA.totalRows + metricsB.totalRows) / Math.max(parseMs / 1000, 0.001)),
      peakRssMb,
      canonicalJsonMb: Number((canonicalJsonBytes / 1024 / 1024).toFixed(2)),
      resultJsonMb: Number((resultJsonBytes / 1024 / 1024).toFixed(2)),
      resultCount: output.results.length,
      summary: output.summary
    }));
  } finally {
    clearInterval(monitor);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed.");
  process.exit(1);
});
