import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpportunityColumnMap,
  parseOpportunityWorkbook,
  profileOpportunityWorkbook
} from "@/lib/opportunity-finder/parser";
import { classifyOpportunityWorkbook } from "@/lib/opportunity-finder/classifier";
import { OPPORTUNITY_ADAPTER_REGISTRY } from "@/lib/opportunity-finder/adapters";
import {
  manufacturersConflict,
  mpnIdentity,
  normalizeManufacturer,
  OPPORTUNITY_MANUFACTURER_ALIAS_VERSION
} from "@/lib/opportunity-finder/normalization";
import type {
  CanonicalOpportunityRow,
  OpportunityRejectedRow,
  OpportunitySheetProfile
} from "@/lib/opportunity-finder/types";

const temporaryPaths: string[] = [];

async function workbookFile(
  sheetName: string,
  rows: unknown[][],
  configure?: (sheet: ExcelJS.Worksheet) => void
) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opportunity-adapter-test-"));
  temporaryPaths.push(directory);
  const filePath = path.join(directory, "fixture.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((row) => sheet.addRow(row));
  configure?.(sheet);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

afterEach(async () => {
  delete process.env.OPPORTUNITY_FINDER_MAX_ROWS_PER_FILE;
  delete process.env.OPPORTUNITY_FINDER_XLSX_STREAMING_THRESHOLD_MB;
  await Promise.all(temporaryPaths.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })
  ));
});

function classified(headers: string[], previewValues?: Record<string, string>) {
  const sheet: OpportunitySheetProfile = {
    sheetName: "misleading name",
    rowCount: previewValues ? 2 : 1,
    headerRows: [{ rowNumber: 1, headers }],
    previewRows: previewValues ? [{ rowNumber: 2, hidden: false, values: previewValues }] : []
  };
  return classifyOpportunityWorkbook({ fileName: "not-trusted.xlsx", sheets: [sheet], rowCount: sheet.rowCount });
}

describe("Opportunity Finder template adapters", () => {
  it("declares every adapter in the typed versioned registry", () => {
    expect(OPPORTUNITY_ADAPTER_REGISTRY.map((adapter) => adapter.id)).toEqual(expect.arrayContaining([
      "sanmina_spotbuys",
      "sanmina_asia_rfq",
      "flex_shortage",
      "flex_shortage_shifted_offer",
      "flex_week_27_rfq",
      "flex_week_28_rfq",
      "flex_purchase_cube",
      "quote_database",
      "generic"
    ]));
    expect(OPPORTUNITY_ADAPTER_REGISTRY.every((adapter) =>
      adapter.version && adapter.fingerprint && adapter.roles.length > 0 && adapter.requiredColumns.length > 0
    )).toBe(true);
  });

  it("uses NFKC exact identity while preserving meaningful punctuation and spacing", () => {
    expect(mpnIdentity("  ＡＢＣ–001  /REEL ")).toMatchObject({
      normalizedMpn: "ABC-001 /REEL",
      reviewKey: "ABC001REEL"
    });
    expect(mpnIdentity("ABC-001").normalizedMpn).not.toBe(mpnIdentity("ABC/001").normalizedMpn);
  });

  it("uses an exact, versioned manufacturer catalog without substring equivalence", () => {
    expect(OPPORTUNITY_MANUFACTURER_ALIAS_VERSION).toMatch(/^mfg-aliases-/);
    expect(normalizeManufacturer("Texas Instruments Inc")).toBe("TEXAS INSTRUMENTS");
    expect(manufacturersConflict("TI", "Texas Instruments")).toBe(false);
    expect(manufacturersConflict("TI", "Titan Microelectronics")).toBe(true);
    expect(manufacturersConflict("Cypress", "Infineon Technologies AG")).toBe(true);
  });

  it("classifies Sanmina, shifted Flex, Cube and quote DB by content", () => {
    expect(classified([
      "Line ID", "SANM UNICOS", "ORDDD", "Plant", "item", "GENERIC", "CLEAN_MFG",
      "RFQ QTY", "Target_to_Vendor"
    ])).toMatchObject({ detectedType: "demand", templateType: "sanmina_spotbuys" });

    const shifted = Array.from({ length: 26 }, () => "");
    Object.assign(shifted, {
      0: "Comp ID", 1: "Facility", 2: "Item", 3: "Impact Date",
      4: "Escalation Number", 6: "Shortage Qty", 8: "MPN", 9: "Global Mfg Name",
      16: "MANUFACTURER", 17: "QUIKSOL QTY AVAILABLE", 18: "QUIKSOL UNIT PRICE"
    });
    expect(classified(shifted)).toMatchObject({
      detectedType: "demand",
      templateType: "flex_shortage_shifted_offer"
    });

    expect(classified([
      "Company", "Facility", "Global Supplier Name", "Global Customer Name",
      "Global Manufacturer Name", "Mfg Partno", "RCPT Qty", "USD Extended Price", "Total"
    ])).toMatchObject({ detectedType: "purchase_history", templateType: "flex_purchase_cube" });
    expect(classified(["MPN", "MFG", "QTY", "Cost", "Price", "Total Price", "GP rate", "GP"]))
      .toMatchObject({ detectedType: "quote_history", templateType: "quote_database" });
  });

  it("distinguishes Flex wk27 and wk28 from where numeric quantity data lives", () => {
    const headers = [
      "CPN", "MFG P/N", "MFG", "Alternate P/N's", "QTY 1 (shortage)",
      "QTY 2 (Lead time/scheduled)", "Customers Target Purchase Price", "Offered Part#",
      "MFR", "Offered STK QTY", "Price", "DC", "LT(weeks)", "MOQ", "SPQ",
      "Packing", "Vendor Type", "COO (Non China)", "Shipment Term", "Full lable",
      "Remarks", "Buyer", "Date", "Quotation Time", "Vendor Code"
    ];
    expect(classified(headers, { B: "PART-27", C: "MFG", F: "55", G: "1.25" }).templateType)
      .toBe("flex_week_27_rfq");
    expect(classified(headers, { B: "PART-28", C: "MFG", D: "42", G: "1.25" }).templateType)
      .toBe("flex_week_28_rfq");
  });

  it("materializes RFQ alternate MPNs under one demand event without duplicating quantity", async () => {
    const headers = [
      "CPN", "MFG P/N", "MFG", "Alternate P/N's", "QTY 1 (shortage)",
      "QTY 2 (Lead time/scheduled)", "Customers Target Purchase Price", "Offered Part#",
      "MFR", "Offered STK QTY", "Price", "DC", "LT(weeks)", "MOQ", "SPQ",
      "Packing", "Vendor Type", "COO (Non China)", "Shipment Term", "Full lable",
      "Remarks", "Buyer", "Date", "Quotation Time", "Vendor Code"
    ];
    const filePath = await workbookFile("RFQ", [
      headers,
      ["DEMO-CUSTOMER-PART", "0007-DEMO-001", "Synthetic Manufacturer", "QA-PART-002; QA-PART-003", "", 25]
    ]);
    const rows: CanonicalOpportunityRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "neutral.xlsx",
      fileId: "synthetic-rfq",
      jobId: "job",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch)
    });

    expect(metrics).toMatchObject({ demandEvents: 1, demandPartOptions: 3, canonicalRows: 3 });
    expect(new Set(rows.map((row) => row.demandEventKey)).size).toBe(1);
    expect(rows.map((row) => row.requiredQty)).toEqual([25, null, null]);
    expect(rows.map((row) => row.isApprovedAlternate)).toEqual([false, true, true]);
  });

  it("maps shifted offer columns explicitly and never maps UNIT COST as UOM", () => {
    const headers = [
      "Comp ID", "Facility", "Item", "Impact Date", "Escalation Number", "Escalation Group",
      "Shortage Qty", "Target Price", "MPN", "Global Mfg Name", "Global Customer Name", "Region",
      "Global Supplier Name", "Age", "Buyer Name", "", "MANUFACTURER",
      "QUIKSOL QTY AVAILABLE", "QUIKSOL UNIT PRICE", "SHIPPING POINT", "COO", "DC",
      "LT WKS", "MOQ", "SPQ", "Comments"
    ];
    expect(buildOpportunityColumnMap(headers, "supplier_offer", "flex_shortage_shifted_offer"))
      .toMatchObject({ mpn: 16, quantity: 17, supplierContext: 15, offerPrice: 18, shifted: true });
    expect(buildOpportunityColumnMap(["MPN", "STOCK QTY", "UNIT COST", "Currency"], "stock"))
      .toMatchObject({ unitOfMeasure: null, unitCost: 2, currency: 3 });
  });

  it("groups Flex alternatives into one demand event and preserves hidden-row evidence", async () => {
    const headers = [
      "Comp ID", "Facility", "Item", "Impact Date", "Escalation Number", "Escalation Group",
      "Shortage Qty", "Target Price", "MPN", "Global Mfg Name", "Global Customer Name", "Region",
      "Global Supplier Name", "Age at Current Escalation Owner (Days)", "Buyer Name"
    ];
    const filePath = await workbookFile("QUIKSOL", [
      headers,
      ["012", "Plant", "ITEM-1", "07/05/2026", "ESC-1", "Group", -10, 1.2, "ABC-1", "TI", "OEM"],
      ["012", "Plant", "ITEM-1", "07/05/2026", "ESC-1", "Group", -10, 1.3, "ABC-1/REEL", "TI", "OEM"],
      ["012", "Plant", "ITEM-2", "N/A", "ESC-2", "Group", 0, 2, "XYZ-2", "ST", "OEM"]
    ], (sheet) => {
      sheet.getRow(2).hidden = true;
      sheet.autoFilter = "A1:O3";
    });

    const profile = await profileOpportunityWorkbook(filePath, "misnamed-sanmina.xlsx");
    expect(profile).toMatchObject({
      detectedType: "demand",
      templateType: "flex_shortage",
      rowCount: 4,
      usefulRowCount: 3,
      hiddenRowCount: 1
    });
    expect(profile.sheets[0].warnings).toEqual(expect.arrayContaining([
      "hidden_rows_included",
      "rows_outside_autofilter_included"
    ]));

    const rows: CanonicalOpportunityRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "misnamed-sanmina.xlsx",
      fileId: "snapshot-flex",
      jobId: "job",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch)
    });
    expect(metrics).toMatchObject({ canonicalRows: 3, demandEvents: 2, demandPartOptions: 3, hiddenRows: 1 });
    expect(rows[0].demandEventKey).toBe(rows[1].demandEventKey);
    expect(rows[0].demandEventKey).toContain("FLEX|snapshot-flex|012|ITEM-1|ESC-1");
    expect(rows.map((row) => row.requiredQty)).toEqual([10, null, 0]);
    expect(rows[0]).toMatchObject({ rawQuantity: "-10", sourceRowHidden: true, optionOrdinal: 1 });
    expect(rows[0].qualityFlags).toContain("hidden_source_row");
    expect(rows[2]).toMatchObject({ requiredDate: null, requiredDateQuality: "not_applicable", isActiveDemand: false });
  });

  it("emits standard Flex embedded offers, including hidden offer-only rows outside the filter", async () => {
    const headers = [
      "Comp ID", "Facility", "Item", "Impact Date", "Escalation Number", "Escalation Group",
      "Shortage Qty", "Target Price", "MPN", "Global Mfg Name", "Global Customer Name", "Region",
      "Global Supplier Name", "Age at Current Escalation Owner (Days)", "Buyer Name", "SUPPLIER",
      "QUIKSOL MPN AVAILABLE", "MANUFACTURER", "QUIKSOL QTY AVAILABLE", "QUIKSOL UNIT PRICE",
      "SHIPPING POINT", "COO", "DC", "LT WKS", "MOQ", "SPQ", "Comments"
    ];
    const filePath = await workbookFile("QUIKSOL", [
      headers,
      [
        "012", "Plant", "ITEM-1", "07/05/2026", "ESC-1", "Group", -10, 1.2,
        "ABC-1", "TI", "OEM", "AMERICAS", "Current Supplier", 2, "Buyer",
        "Embedded Supplier", "ABC-1", "Texas Instruments", 12, 1.1, "HK", "CN", "25+", 2, 5, 1, "Offer"
      ],
      [
        "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "Offer-only Supplier", "ONLY-OFFER-2", "ST", 7, 0.8, "SG", "MY", "26+", 1, 1, 1, "Outside filter"
      ]
    ], (sheet) => {
      sheet.getRow(3).hidden = true;
      sheet.autoFilter = "A1:AA2";
    });

    const profile = await profileOpportunityWorkbook(filePath, "content-not-name.xlsx");
    expect(profile.warnings).toContain("embedded_offer_columns_mapped");
    expect(profile.columnMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalField: "embeddedOffer.mpn", sourceColumn: "Q" }),
      expect.objectContaining({ canonicalField: "embeddedOffer.quantity", sourceColumn: "S" })
    ]));

    const rows: CanonicalOpportunityRow[] = [];
    const rejected: OpportunityRejectedRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "content-not-name.xlsx",
      fileId: "flex-with-offers",
      jobId: "job",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch),
      onRejected: async (batch) => rejected.push(...batch)
    });

    expect(metrics).toMatchObject({
      canonicalRows: 3,
      demandEvents: 1,
      demandPartOptions: 1,
      supplyLots: 2,
      hiddenRows: 1,
      rejectedRows: 0,
      missingMpnRows: 0
    });
    expect(rejected).toEqual([]);
    const demand = rows.find((row) => row.recordKind === "demand_option")!;
    const offers = rows.filter((row) => row.recordKind === "supply_lot");
    expect(demand).not.toHaveProperty("offerPrice");
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      recordRole: "supplier_offer",
      normalizedMpn: "ABC-1",
      availableQty: 12,
      offerPrice: 1.1,
      supplierContext: "Embedded Supplier",
      demandEventKey: demand.demandEventKey,
      sourceColumns: { mpn: "Q", quantity: "S" }
    });
    expect(offers[1]).toMatchObject({
      normalizedMpn: "ONLY-OFFER-2",
      availableQty: 7,
      sourceRow: 3,
      sourceRowHidden: true,
      sourceColumns: { mpn: "Q", quantity: "S" }
    });
    expect(offers[1].qualityFlags).toContain("hidden_source_row");
    expect(new Set(offers.map((row) => row.supplyLotKey)).size).toBe(2);
  });

  it("separates the Sanmina response block into an embedded supply lot", async () => {
    const headers = [
      "Line ID", "SANM UNICOS", "ORDDD", "Plant", "item", "DESCRIPTION", "GENERIC", "CLEAN_MFG",
      "CUSTOMER", "Qty Order WKs 1-13", "RFQ QTY", "Delivery Qto. Current", "Delivery Next Qto.",
      "Delivery Next 2 Qto.", "Delivery Next 3 Qto.", "Target_to_Vendor", "Potencial_AMount_USD",
      "Incoterm to quote", "Supplier Name", "Best Price Offered", "MPN Quoted", "Manufacturer Quoted",
      "Date Code (yyww)", "MOQ", "SPQ", "On Hand", "Lead Time (wks)", "Transit Time (wks)",
      "Earliest Shipping Date (mm/dd/yy)", "Shipping Point (Country)", "Delivery Point", "Comments"
    ];
    const filePath = await workbookFile("Zebra", [
      headers,
      [
        "LINE-1", "1", "ORD-1", "K03", "ITEM-1", "IC", "SGM41527YTQQ24G/TR", "SG MICRO",
        "ZEBRA", 20_000, 17_250, 17_250, 0, 0, 0, 1.12, 19_320, "", "Quiksol Global", 0.55,
        "SGM41527YTQQ24G/TR", "SG MICRO", "25+", 1, 1, 9_000, 2, 1, "08/12/2026", "HK", "", "Reel"
      ]
    ]);
    const rows: CanonicalOpportunityRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "zebra.xlsx",
      fileId: "sanmina-snapshot",
      jobId: "job",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch)
    });
    expect(metrics).toMatchObject({ canonicalRows: 2, demandPartOptions: 1, supplyLots: 1 });
    const [demand, offer] = rows;
    expect(demand).not.toHaveProperty("offerPrice");
    expect(offer).toMatchObject({
      recordRole: "supplier_offer",
      recordKind: "supply_lot",
      normalizedMpn: "SGM41527YTQQ24G/TR",
      manufacturer: "SG MICRO",
      availableQty: 9_000,
      offerPrice: 0.55,
      targetPrice: 1.12,
      demandEventKey: demand.demandEventKey,
      sourceColumns: { mpn: "U", quantity: "Z", offerPrice: "T" }
    });
  });

  it("parses a shifted Flex offer-only row without a false missing-demand rejection", async () => {
    const headers = [
      "Comp ID", "Facility", "Item", "Impact Date", "Escalation Number", "Escalation Group",
      "Shortage Qty", "Target Price", "MPN", "Global Mfg Name", "Global Customer Name", "Region",
      "Global Supplier Name", "Age", "Buyer Name", "", "MANUFACTURER", "QUIKSOL QTY AVAILABLE",
      "QUIKSOL UNIT PRICE", "SHIPPING POINT", "COO", "DC", "LT WKS", "MOQ", "SPQ", "Comments"
    ];
    const filePath = await workbookFile("QUIKSOL", [
      headers,
      [
        "059", "Plant", "ITEM-1", "06/28/2026", "ESC-SHIFT", "Group", "", 1.4, "", "",
        "OEM", "AMERICAS", "", "", "", "Shifted Supplier", "SHIFTED-MPN", 25, 1.1,
        "HK", "CN", "25+", 2, 5, 1, "Shifted"
      ]
    ], (sheet) => {
      sheet.getRow(2).hidden = true;
      sheet.autoFilter = "A1:Z1";
    });
    const rows: CanonicalOpportunityRow[] = [];
    const rejected: OpportunityRejectedRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "misnamed.xlsx",
      fileId: "shifted-snapshot",
      jobId: "job",
      side: "A",
      role: "demand",
      onBatch: async (batch) => rows.push(...batch),
      onRejected: async (batch) => rejected.push(...batch)
    });
    expect(metrics).toMatchObject({
      canonicalRows: 1,
      demandPartOptions: 0,
      supplyLots: 1,
      demandEvents: 0,
      hiddenRows: 1,
      rejectedRows: 0
    });
    expect(rejected).toEqual([]);
    expect(rows[0]).toMatchObject({
      recordRole: "supplier_offer",
      normalizedMpn: "SHIFTED-MPN",
      manufacturer: null,
      availableQty: 25,
      offerPrice: 1.1,
      sourceRowHidden: true,
      sourceColumns: { mpn: "Q", quantity: "R", offerPrice: "S" }
    });
    expect(rows[0].qualityFlags).toEqual(expect.arrayContaining([
      "hidden_source_row",
      "shifted_column_mapping"
    ]));
  });

  it("uses safe cached formula values without executing formulas and still rejects errors", async () => {
    const filePath = await workbookFile("Stock", [
      ["MPN", "MFG", "STOCK QTY", "UOM"],
      ["SAFE-1", "TI", 5, "EA"],
      [{ formula: "\"FORMULA-MPN\"", result: "FORMULA-MPN" }, "TI", 3, "EA"],
      ["ERROR-QTY", "TI", { error: "#N/A" }, "EA"],
      ["=UNTRUSTED-FORMULA-TEXT", "TI", 2, "EA"]
    ]);
    const rows: CanonicalOpportunityRow[] = [];
    const rejected: OpportunityRejectedRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "stock.xlsx",
      fileId: "stock",
      jobId: "job",
      side: "B",
      role: "stock",
      onBatch: async (batch) => rows.push(...batch),
      onRejected: async (batch) => rejected.push(...batch)
    });
    expect(rows.map((row) => row.normalizedMpn)).toEqual(["SAFE-1", "FORMULA-MPN", "ERROR-QTY"]);
    expect(rows[1]).toMatchObject({ availableQty: 3 });
    expect(rows[1].qualityFlags).toContain("formula_cached_value_used");
    expect(rows[2].availableQty).toBeNull();
    expect(rows[2].qualityFlags).toContain("excel_error_value");
    expect(metrics.formulaCellsIgnored).toBeGreaterThan(0);
    expect(metrics.formulaCachedValuesUsed).toBeGreaterThan(0);
    expect(metrics.errorCellsIgnored).toBeGreaterThan(0);
    expect(rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: "invalid_available_quantity", sourceRow: 4, sourceColumn: "C", safeRawValue: null }),
      expect.objectContaining({ reasonCode: "missing_mpn", sourceRow: 5, sourceColumn: "A", safeRawValue: null })
    ]));
    expect(JSON.stringify(rejected)).not.toContain("FORMULA-MPN");
  });

  it("profiles and parses XLSX packages through the bounded streaming path", async () => {
    process.env.OPPORTUNITY_FINDER_XLSX_STREAMING_THRESHOLD_MB = "1";
    const payload = "synthetic-safe-padding-".repeat(16);
    const rows: unknown[][] = [["MPN", "MFG", "STOCK QTY", "UOM", "Notes"]];
    for (let index = 0; index < 4_000; index += 1) {
      rows.push([`STREAM-${index}`, "Synthetic Manufacturer", 1, "EA", `${payload}${index}`]);
    }
    const filePath = await workbookFile("Stock", rows);
    const profile = await profileOpportunityWorkbook(filePath, "streaming.xlsx");
    const parsed: CanonicalOpportunityRow[] = [];
    const metrics = await parseOpportunityWorkbook({
      filePath,
      fileName: "streaming.xlsx",
      fileId: "synthetic-streaming",
      jobId: "job",
      side: "B",
      role: "stock",
      onBatch: async (batch) => parsed.push(...batch)
    });

    expect(profile).toMatchObject({ detectedType: "stock", usefulRowCount: 4_000 });
    expect(metrics).toMatchObject({ canonicalRows: 4_000, supplyLots: 4_000, rejectedRows: 0 });
    expect(parsed).toHaveLength(4_000);
    expect(parsed[0]?.normalizedMpn).toBe("STREAM-0");
    expect(parsed.at(-1)?.normalizedMpn).toBe("STREAM-3999");
  }, 30_000);

  it("enforces the configured useful-file row limit during parsing", async () => {
    process.env.OPPORTUNITY_FINDER_MAX_ROWS_PER_FILE = "2";
    const filePath = await workbookFile("Stock", [
      ["MPN", "STOCK QTY"],
      ["A", 1],
      ["B", 2]
    ]);
    await expect(parseOpportunityWorkbook({
      filePath,
      fileName: "stock.xlsx",
      fileId: "stock",
      jobId: "job",
      side: "B",
      role: "stock",
      onBatch: async () => undefined
    })).rejects.toThrow("OPPORTUNITY_ROW_LIMIT_EXCEEDED");
  });
});
