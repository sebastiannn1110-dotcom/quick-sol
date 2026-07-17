import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("AI upload profile integration", () => {
  it("answers upload column questions from structural profiles", () => {
    const databaseTools = source("lib/ai/database-tools.ts");

    expect(databaseTools).toContain("ensureUploadStructureProfile");
    expect(databaseTools).toContain("formatColumnsAnswer(latestProfile)");
    expect(databaseTools).toContain("formatDetectedFields(latestProfile)");
    expect(databaseTools).toContain("profiles: profilesList.map");
    expect(databaseTools).not.toContain("SAMPLE_RECORD_FIELDS");
  });

  it("keeps backfill file profile output report-only and value-safe", () => {
    const packageJson = source("package.json");
    const script = source("scripts/backfill-file-profiles.ts");

    expect(packageJson).toContain('"backfill:file-profiles"');
    expect(script).toContain("ensureUploadStructureProfile");
    expect(script).toContain("No row values, customer names, supplier names, prices, costs, PO, notes or MPN values are printed.");
    expect(script).not.toContain("console.log(profile");
  });
});
