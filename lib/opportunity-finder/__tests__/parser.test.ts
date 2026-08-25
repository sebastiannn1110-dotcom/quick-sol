import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseOpportunityWorkbook,
  profileOpportunityWorkbook
} from "@/lib/opportunity-finder/parser";
import type { CanonicalOpportunityRow } from "@/lib/opportunity-finder/types";

const temporaryPaths: string[] = [];

async function syntheticWorkbook(
  sheetName: string,
  rows: unknown[][]
) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opportunity-test-"));
  temporaryPaths.push(directory);
  const filePath = path.join(directory, "synthetic.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((row) => sheet.addRow(row));
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function syntheticCsv(rows: unknown[][]) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opportunity-test-"));
  temporaryPaths.push(directory);
  const filePath = path.join(directory, "synthetic.csv");
  const csv = rows.map((row) => row.map((value) =>
    `"${String(value ?? "").replace(/"/g, "\"\"")}"`
  ).join(",")).join("\r\n");
  await fs.promises.writeFile(filePath, csv, "utf8");
  return filePath;
}

async function syntheticSheetJsWorkbook(sheetName: string, rows: unknown[][]) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opportunity-sheetjs-test-"));
  temporaryPaths.push(directory);
  const filePath = path.join(directory, "synthetic-sheetjs.xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })
  ));
});

describe("streaming opportunity workbook parser", () => {
  it("parses a planned demand workbook without financial fields", async () => {
    const filePath = await syntheticWorkbook("Planned PO 391", [
      ["Requi", "Item", "Quantity", "RequiredDate", "BPName", "mpn", "ManuName", "Price Book"],
      ["REQ-1", "ITEM-1", 10, new Date("2026-08-01"), "Proposed supplier", "001234", "TI", 999]
    ]);
    const rows: CanonicalOpportunityRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "planned.xlsx",
      fileId: "file-a",
      jobId: "job",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch)
    });
    expect(metrics.canonicalRows).toBe(1);
    expect(rows[0]).toMatchObject({
      displayMpn: "001234",
      normalizedMpn: "001234",
      requiredQty: 10,
      supplierContext: "Proposed supplier"
    });
    expect(JSON.stringify(rows[0]).toLowerCase()).not.toContain("price");
  });

  it("recognizes repeated supplier-offer header blocks and ignores category rows", async () => {
    const filePath = await syntheticCsv([
      ["Category title"],
      [],
      ["List#", "Item#", "MFR#", "Desc", "Max QTY", "Final Price"],
      ["1", "I-1", "ABC-1", "Laptop", 5, 100],
      ["Accessories"],
      [],
      ["List#", "Item#", "MFR#", "Desc", "Max QTY", "Final Price"],
      ["2", "I-2", "XYZ-2", "Tablet", 7, 200]
    ]);
    const rows: CanonicalOpportunityRow[] = [];
    await parseOpportunityWorkbook({
      filePath,
      fileName: "catalog.csv",
      fileId: "file-b",
      jobId: "job",
      side: "B",
      role: "supplier_offer",
      onBatch: async (batch) => rows.push(...batch)
    });
    expect(rows.map((row) => row.normalizedMpn)).toEqual(["ABC-1", "XYZ-2"]);
    expect(rows.map((row) => row.availableQty)).toEqual([5, 7]);
  });

  it("keeps missing offer validity strictly null unless a file-level expiry is attested", async () => {
    const filePath = await syntheticCsv([
      ["List#", "Item#", "MFR#", "Max QTY", "Final Price"],
      ["1", "I-1", "STRICT-NULL", 5, 100]
    ]);
    const withoutOverride: CanonicalOpportunityRow[] = [];
    await parseOpportunityWorkbook({
      filePath,
      fileName: "catalog.csv",
      fileId: "file-b",
      jobId: "job",
      side: "B",
      role: "supplier_offer",
      onBatch: async (batch) => withoutOverride.push(...batch)
    });
    expect(withoutOverride[0]).toMatchObject({
      expiresAt: null,
      qualityFlags: expect.arrayContaining(["offer_validity_unknown"])
    });

    const withOverride: CanonicalOpportunityRow[] = [];
    await parseOpportunityWorkbook({
      filePath,
      fileName: "catalog.csv",
      fileId: "file-b",
      jobId: "job",
      side: "B",
      role: "supplier_offer",
      validityOverrideExpiresAt: "2099-01-02T03:04:00.000Z",
      onBatch: async (batch) => withOverride.push(...batch)
    });
    expect(withOverride[0].expiresAt).toBe("2099-01-02T03:04:00.000Z");
    expect(withOverride[0].qualityFlags).not.toContain("offer_validity_unknown");

    const stockFilePath = await syntheticCsv([
      ["MPN", "MFG", "STOCK QTY"],
      ["STRICT-NULL", "TI", 5]
    ]);
    const stockRows: CanonicalOpportunityRow[] = [];
    await parseOpportunityWorkbook({
      filePath: stockFilePath,
      fileName: "stock.csv",
      fileId: "file-b",
      jobId: "job",
      side: "B",
      role: "stock",
      validityOverrideExpiresAt: "2099-01-02T03:04:00.000Z",
      onBatch: async (batch) => stockRows.push(...batch)
    });
    expect(stockRows[0].expiresAt).toBeNull();
  });

  it("does not treat Sales Report ITEM# as a reliable MPN", async () => {
    const filePath = await syntheticCsv([
      ["SALES PERSON", "ITEM#", "QTY", "UNIT PRICE($)", "UNIT COST($)", "SALES($)", "G.P.(%)"],
      ["Person", "INTERNAL-ITEM", 10, 20, 15, 200, 0.25]
    ]);
    const rows: CanonicalOpportunityRow[] = [];
    await parseOpportunityWorkbook({
      filePath,
      fileName: "sales.csv",
      fileId: "file-b",
      jobId: "job",
      side: "B",
      role: "sales_history",
      onBatch: async (batch) => rows.push(...batch)
    });
    expect(rows).toHaveLength(0);
  });

  it("profiles and parses XLSX files produced by a non-ExcelJS writer", async () => {
    const filePath = await syntheticSheetJsWorkbook("Stock On Hand", [
      ["MPN", "MFG", "STOCK QTY", "UNIT COST"],
      ["0007-QA-01", "Luminara Circuits", 25, 1.25]
    ]);
    const profile = await profileOpportunityWorkbook(filePath, "inventory.xlsx");
    expect(profile).toMatchObject({
      detectedType: "stock",
      sheetCount: 1,
      rowCount: 2
    });

    const rows: CanonicalOpportunityRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "inventory.xlsx",
      fileId: "file-b",
      jobId: "job",
      side: "B",
      role: "stock",
      onBatch: async (batch) => rows.push(...batch)
    });
    expect(metrics.canonicalRows).toBe(1);
    expect(rows[0]).toMatchObject({
      displayMpn: "0007-QA-01",
      normalizedMpn: "0007-QA-01",
      availableQty: 25,
      manufacturer: "Luminara Circuits",
      unitOfMeasure: null
    });
    expect(rows[0].qualityFlags).toContain("missing_unit");
  });
});
