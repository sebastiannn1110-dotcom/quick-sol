import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseOpportunityWorkbook,
  profileOpportunityWorkbook
} from "@/lib/opportunity-finder/parser";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import type { CanonicalOpportunityRow } from "@/lib/opportunity-finder/types";

const realRoot = process.env.OPPORTUNITY_REAL_FIXTURES_DIR;
const runGolden = Boolean(realRoot && fs.existsSync(realRoot));

function findFile(name: string) {
  if (!realRoot) throw new Error("OPPORTUNITY_REAL_FIXTURES_DIR is not configured");
  const pending = [realRoot];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.name === name) return fullPath;
    }
  }
  throw new Error(`Missing real fixture: ${name}`);
}

describe.runIf(runGolden)("private Sanmina/Flex golden profiles", () => {
  it("certifies Sanmina options/events without copying private data into fixtures", async () => {
    const names = [
      "SPOTBUYS_SUPPLIER_2026Wk30 General.xlsx",
      "SPOTBUYS_SUPPLIER_2026Wk3026 Orbcomm.xlsx",
      "SPOTBUYS_SUPPLIER_2026Wk3026 Shure.xlsx",
      "SPOTBUYS_SUPPLIER_2026Wk3026 Zebra.xlsx"
    ];
    let options = 0;
    let events = 0;
    const embeddedOffers: CanonicalOpportunityRow[] = [];
    for (const [index, name] of names.entries()) {
      const filePath = findFile(name);
      const rows: CanonicalOpportunityRow[] = [];
      const metrics = await parseOpportunityWorkbook({
        filePath,
        fileName: name,
        fileId: `sanmina-${index}`,
        jobId: "golden",
        side: "A",
        role: "demand",
        onBatch: async (batch) => rows.push(...batch)
      });
      options += metrics.demandPartOptions;
      events += metrics.demandEvents;
      embeddedOffers.push(...rows.filter((row) => row.recordKind === "supply_lot"));
    }
    expect(options).toBe(5_692);
    expect(events).toBe(2_991);
    expect(embeddedOffers).toHaveLength(8);
    expect(new Set(embeddedOffers.map((row) => row.supplyLotKey)).size).toBe(8);
    expect(embeddedOffers.find((row) => row.normalizedMpn === "SGM41527YTQQ24G/TR"))
      .toMatchObject({
        recordRole: "supplier_offer",
        availableQty: 9_000,
        offerPrice: 0.55,
        targetPrice: 1.12
      });
    expect(embeddedOffers.every((row) => row.qualityFlags.includes("offer_validity_unknown")))
      .toBe(true);
  }, 60_000);

  it("certifies Flex global, shifted and RFQ profiles by content", async () => {
    const globalName = "QUIKSOL  Stock - FLEX Shortages - 7-7-2026.xlsx";
    const globalPath = findFile(globalName);
    const globalProfile = await profileOpportunityWorkbook(globalPath, globalName);
    expect(globalProfile).toMatchObject({
      detectedType: "demand",
      templateType: "flex_shortage",
      usefulRowCount: 3_045,
      hiddenRowCount: 3_027
    });
    const rows: CanonicalOpportunityRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath: globalPath,
      fileName: globalName,
      fileId: "flex-global",
      jobId: "golden",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch)
    });
    expect(metrics).toMatchObject({
      demandPartOptions: 3_045,
      demandEvents: 1_190,
      supplyLots: 18,
      hiddenRows: 3_027
    });
    const globalOffers = rows.filter((row) => row.recordKind === "supply_lot");
    expect(globalOffers).toHaveLength(18);
    expect(globalOffers.filter((row) => row.sourceRow > 3_033)).toHaveLength(13);
    expect(new Set(globalOffers.map((row) => row.supplyLotKey)).size).toBe(18);
    expect(globalOffers.find((row) => row.normalizedMpn === "NCV1117DT33T5G"))
      .toMatchObject({
        recordRole: "supplier_offer",
        availableQty: 47_500,
        offerPrice: 0.15,
        targetPrice: 0.160289
      });
    expect(globalOffers.every((row) => row.qualityFlags.includes("offer_validity_unknown")))
      .toBe(true);

    const shiftedName = "RFQ SANMINA GENERAL  WK#30 ORBC.xlsx";
    const shiftedMatches: string[] = [];
    if (realRoot) {
      const pending = [realRoot];
      while (pending.length) {
        const directory = pending.pop()!;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(full);
          else if (entry.name === shiftedName) shiftedMatches.push(full);
        }
      }
    }
    const shiftedPath = shiftedMatches.find((value) => value.includes("FILES FLEX"));
    expect(shiftedPath).toBeTruthy();
    const shiftedProfile = await profileOpportunityWorkbook(shiftedPath!, shiftedName);
    expect(shiftedProfile).toMatchObject({
      detectedType: "demand",
      templateType: "flex_shortage_shifted_offer",
      usefulRowCount: 299,
      hiddenRowCount: 297
    });
    const shiftedRows: CanonicalOpportunityRow[] = [];
    const shiftedMetrics = await parseOpportunityWorkbook({
      filePath: shiftedPath!,
      fileName: shiftedName,
      fileId: "flex-shifted",
      jobId: "golden",
      side: "A",
      role: "demand",
      onBatch: async (batch) => shiftedRows.push(...batch)
    });
    expect(shiftedMetrics).toMatchObject({
      demandPartOptions: 299,
      demandEvents: 197,
      supplyLots: 2,
      hiddenRows: 297
    });
    expect(shiftedRows.filter((row) => row.recordKind === "supply_lot")).toHaveLength(2);
    expect(shiftedRows.filter((row) => row.recordKind === "supply_lot"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          recordRole: "supplier_offer",
          manufacturer: null,
          mappingVersion: "flex-shortage-shifted-offer-v1"
        })
      ]));

    const week27 = await profileOpportunityWorkbook(
      findFile("RFQ GLOBAL SHORTAGE FLEX  wk#27.xlsx"),
      "RFQ GLOBAL SHORTAGE FLEX  wk#27.xlsx"
    );
    const week28 = await profileOpportunityWorkbook(
      findFile("RFQ GLOBAL SHORTAGE FLEX  wk#28.xlsx"),
      "RFQ GLOBAL SHORTAGE FLEX  wk#28.xlsx"
    );
    expect(week27).toMatchObject({ templateType: "flex_week_27_rfq" });
    expect(week27.sheets.find((sheet) => sheet.sheetName === "RFQ Email Temp_Cover")?.usefulRowCount).toBe(55);
    expect(week28).toMatchObject({ templateType: "flex_week_28_rfq" });
    expect(week28.sheets.find((sheet) => sheet.sheetName === "RFQ Email Temp_Cover")?.usefulRowCount).toBe(42);
  }, 60_000);

  it("never classifies Cube purchases or the quote DB as live inventory", async () => {
    const cube = await profileOpportunityWorkbook(
      findFile("Database Cube Americas.xlsx"),
      "Database Cube Americas.xlsx"
    );
    const quotes = await profileOpportunityWorkbook(
      findFile("DATABASE 206 JULIO GOOD.xlsx"),
      "DATABASE 206 JULIO GOOD.xlsx"
    );
    expect(cube).toMatchObject({ detectedType: "purchase_history", templateType: "flex_purchase_cube" });
    expect(quotes).toMatchObject({ detectedType: "quote_history", templateType: "quote_database" });
  }, 60_000);

  it("keeps the 96-result reference while refusing the conflicting manufacturer lot", async () => {
    const demandName = "Quicksol_QA_Demanda_Planificada.xlsx";
    const supplyName = "Quicksol_QA_Inventario_Disponible.xlsx";
    const rows: CanonicalOpportunityRow[] = [];
    await parseOpportunityWorkbook({
      filePath: findFile(demandName),
      fileName: demandName,
      fileId: "reference-demand",
      jobId: "reference",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch)
    });
    await parseOpportunityWorkbook({
      filePath: findFile(supplyName),
      fileName: supplyName,
      fileId: "reference-supply",
      jobId: "reference",
      side: "B",
      role: "stock",
      onBatch: async (batch) => rows.push(...batch)
    });

    const output = matchOpportunityRows({
      jobId: "reference",
      roleA: "demand",
      roleB: "stock",
      rows
    });
    expect(output.results).toHaveLength(96);
    // The legacy sheet labels 47/6, but that count consumes 45 units from a
    // manufacturer-conflicting SYN-AX4-220 lot. The mandatory no-auto-conflict
    // rule deliberately keeps those units unallocated, yielding 46/7.
    expect(output.summary).toMatchObject({
      fullSales: 46,
      partialSales: 7,
      sourcingNeeded: 31,
      supplyWithoutDemand: 12
    });
    const conflictingManufacturerResults = output.results.filter((result) =>
      result.normalizedMpn === "SYN-AX4-220"
    );
    expect(conflictingManufacturerResults).toHaveLength(3);
    expect(conflictingManufacturerResults.reduce((sum, result) => sum + (result.allocatedQty ?? 0), 0)).toBe(50);
    expect(conflictingManufacturerResults.reduce((sum, result) => sum + (result.shortageQty ?? 0), 0)).toBe(25);
    expect(conflictingManufacturerResults.some((result) => result.opportunityType === "partial_sale")).toBe(true);
    expect(conflictingManufacturerResults.every((result) => result.warnings.includes("manufacturer_conflict"))).toBe(true);

    const allocatedByLot = new Map<string, number>();
    for (const result of output.results) {
      for (const allocation of result.allocations ?? []) {
        allocatedByLot.set(
          allocation.lotKey,
          (allocatedByLot.get(allocation.lotKey) ?? 0) + (allocation.reservedQty ?? allocation.allocatedQty)
        );
      }
    }
    const supplyByLot = new Map(
      rows
        .filter((row) => row.recordRole === "stock")
        .map((row) => [
          row.supplyLotKey || `${row.fileId}:${row.sheetName}:${row.sourceRow}:${row.originalIndex}`,
          row.availableQty ?? 0
        ])
    );
    for (const [lotKey, allocated] of allocatedByLot) {
      expect(allocated).toBeLessThanOrEqual(supplyByLot.get(lotKey) ?? 0);
    }
  }, 60_000);
});
