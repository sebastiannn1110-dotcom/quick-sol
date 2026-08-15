import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import { parseOpportunityWorkbook, profileOpportunityWorkbook } from "@/lib/opportunity-finder/parser";
import type { CanonicalOpportunityRow, OpportunitySelectedRole } from "@/lib/opportunity-finder/types";
import { selectedRoleFromDetectedType } from "@/lib/opportunity-finder/validation";

const privateRoot = process.env.QUIKSOL_PRIVATE_FIXTURES_DIR?.trim();
const shouldSkip = !privateRoot || process.env.CI === "true";
const acceptedExtensions = new Set([".xlsx", ".csv"]);
const discoveredExtensions = new Set([".xlsx", ".csv", ".xls", ".xlsm", ".xlsb"]);

async function privateFiles(root: string) {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (
        entry.isFile() &&
        !entry.name.startsWith("~$") &&
        discoveredExtensions.has(path.extname(entry.name).toLowerCase())
      ) files.push(target);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function digest(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/EXTENSION/.test(message)) return "unsupported_extension";
  if (/MACRO|ENCRYPTED|ZIP|SIGNATURE/.test(message)) return "blocked_workbook";
  if (/ROW_LIMIT/.test(message)) return "row_limit";
  return "private_case_failed";
}

function syntheticStock(index: number): CanonicalOpportunityRow {
  return {
    jobId: "private-local-test",
    fileId: "synthetic-stock",
    side: "B",
    fileName: "synthetic-stock.xlsx",
    sheetName: "Stock",
    sourceRow: index + 2,
    originalIndex: index,
    recordRole: "stock",
    recordKind: "supply_lot",
    rawMpn: `SYNTHETIC-NO-MATCH-${index}`,
    displayMpn: `SYNTHETIC-NO-MATCH-${index}`,
    normalizedMpn: `SYNTHETIC-NO-MATCH-${index}`,
    reviewKey: `SYNTHETICNOMATCH${index}`,
    manufacturer: "Synthetic Manufacturer",
    customerContext: null,
    supplierContext: "Demo Supplier",
    requiredQty: null,
    availableQty: 10,
    excessQty: null,
    requiredDate: null,
    unitOfMeasure: "EA",
    qualityFlags: []
  };
}

function syntheticDemandFromHistory(row: CanonicalOpportunityRow): CanonicalOpportunityRow {
  return {
    ...syntheticStock(0),
    fileId: "synthetic-demand",
    side: "B",
    fileName: "synthetic-demand.xlsx",
    sheetName: "Demand",
    recordRole: "demand",
    recordKind: "demand_option",
    rawMpn: row.rawMpn,
    displayMpn: row.displayMpn,
    normalizedMpn: row.normalizedMpn,
    reviewKey: row.reviewKey,
    manufacturer: row.manufacturer,
    manufacturerCanonical: row.manufacturerCanonical,
    demandEventKey: "SYNTHETIC-HISTORY-CHECK",
    requiredQty: 1,
    availableQty: null,
    isActiveDemand: true
  };
}

describe.skipIf(shouldSkip)("private Opportunity Finder corpus", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("profiles, parses and safely evaluates every private workbook without modifying it", async () => {
    const root = path.resolve(privateRoot!);
    const files = await privateFiles(root);
    expect(files.length).toBeGreaterThan(0);

    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index];
      const extension = path.extname(filePath).toLowerCase();
      const before = await fs.promises.stat(filePath);
      const beforeHash = await digest(filePath);
      const anonymousId = `PRIVATE-${String(index + 1).padStart(3, "0")}-${beforeHash.slice(0, 8)}`;

      try {
        if (!acceptedExtensions.has(extension)) continue;
        const neutralName = `private-input-${String(index + 1).padStart(3, "0")}${extension}`;
        const profile = await profileOpportunityWorkbook(filePath, neutralName);
        const role = selectedRoleFromDetectedType(profile.detectedType);
        expect(role !== null, anonymousId).toBe(true);
        const rows: CanonicalOpportunityRow[] = [];
        await parseOpportunityWorkbook({
          filePath,
          fileName: neutralName,
          fileId: `private-file-${index + 1}`,
          jobId: "private-local-test",
          side: "A",
          role: role!,
          templateType: profile.templateType,
          onBatch: async (batch) => rows.push(...batch),
          onRejected: async () => undefined
        });
        expect(rows.length > 0, anonymousId).toBe(true);

        const historyRole = ([
          "received_history",
          "purchase_history",
          "quote_history",
          "sales_history"
        ] as OpportunitySelectedRole[]).includes(role!);
        if (historyRole) {
          const output = matchOpportunityRows({
            jobId: "private-local-test",
            rows: [...rows, syntheticDemandFromHistory(rows[0])],
            roleA: role!,
            roleB: "demand"
          });
          expect(output.results.every((result) => result.opportunityType === "historical_signal"), anonymousId)
            .toBe(true);
          expect(output.results.every((result) => result.allocatedQty === null), anonymousId).toBe(true);
        } else if (role === "demand") {
          const output = matchOpportunityRows({
            jobId: "private-local-test",
            rows: [...rows, syntheticStock(index)],
            roleA: "demand",
            roleB: "stock"
          });
          expect(output.results.length > 0, anonymousId).toBe(true);
        }
      } catch (error) {
        throw new Error(`${anonymousId}:${safeFailureCode(error)}`);
      } finally {
        const after = await fs.promises.stat(filePath);
        expect(after.size, anonymousId).toBe(before.size);
        expect(after.mtimeMs, anonymousId).toBe(before.mtimeMs);
        expect(await digest(filePath), anonymousId).toBe(beforeHash);
      }
    }

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  }, 300_000);
});
