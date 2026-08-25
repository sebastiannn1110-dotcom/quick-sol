import { runCanonicalBusinessSummaryAudit } from "@/lib/performance/business-summary-canonical-audit";

function positiveInteger(name: string, fallback: number) {
  const marker = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(marker))?.slice(marker.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
}

const rows = positiveInteger("rows", 10_000);
const chunk = positiveInteger("chunk", 500);
const report = runCanonicalBusinessSummaryAudit(rows, chunk);

process.stdout.write(`${JSON.stringify({
  ...report,
  differences: report.differences.filter((difference) => difference.classification !== "UNEXPECTED_DIFFERENCE")
}, null, 2)}\n`);
