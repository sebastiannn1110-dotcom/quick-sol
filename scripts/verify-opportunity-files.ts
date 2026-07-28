import fs from "node:fs";
import path from "node:path";
import { profileOpportunityWorkbook } from "@/lib/opportunity-finder/parser";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: tsx scripts/verify-opportunity-files.ts <directory>");

async function main() {
  const files = fs.readdirSync(directory).filter((file) => /\.(xlsx|csv)$/i.test(file));
  const output = [];
  for (const fileName of files) {
    const startedAt = performance.now();
    const profile = await profileOpportunityWorkbook(path.join(directory, fileName), fileName);
    output.push({
      fileName,
      detectedType: profile.detectedType,
      sheetCount: profile.sheetCount,
      rowCount: profile.rowCount,
      classificationScore: profile.classificationScore,
      durationMs: Math.round(performance.now() - startedAt)
    });
  }
  process.stdout.write(JSON.stringify(output));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Verification failed.");
  process.exit(1);
});
