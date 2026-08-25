import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildOpportunityCsv,
  buildOpportunityExportWorkbook,
  assertOpportunityExportSheetCapacity,
  classifyOpportunityForExport,
  OPPORTUNITY_EXPORT_MAX_SHEET_ROWS,
  OPPORTUNITY_EXPORT_SHEET_NAMES,
  OpportunityExportTooLargeError,
  OpportunityStreamingExportWriter,
  safeSpreadsheetValue
} from "@/lib/opportunity-finder/export";
import type {
  OpportunityRejectedRow,
  OpportunityResult,
  PossibleOpportunityMatch
} from "@/lib/opportunity-finder/types";

function result(
  id: string,
  opportunityType: OpportunityResult["opportunityType"],
  overrides: Partial<OpportunityResult> = {}
): OpportunityResult {
  return {
    id,
    jobId: "00000000-0000-4000-8000-000000000001",
    opportunityType,
    exactMpnMatch: true,
    exactMatch: true,
    usableAvailabilityMatch: true,
    exactQuantityMatch: false,
    displayMpn: `MPN-${id}`,
    normalizedMpn: `MPN-${id}`,
    manufacturer: "Synthetic Manufacturer",
    customerContext: "Synthetic Customer",
    supplierContext: "Synthetic Supplier",
    requiredQty: 10,
    availableQty: 10,
    allocatedQty: 10,
    shortageQty: 0,
    coveragePercent: 100,
    requiredDate: "2026-08-01",
    unitOfMeasure: "EA",
    demandFileId: "00000000-0000-4000-8000-000000000011",
    demandFileName: "demand.xlsx",
    demandSheetName: "Demand",
    supplyFileId: "00000000-0000-4000-8000-000000000012",
    supplyFileName: "supply.xlsx",
    supplySheetName: "Supply",
    demandSourceRows: 1,
    supplySourceRows: 1,
    reasonCode: "full_coverage",
    actionCode: "offer_full_quantity",
    warnings: [],
    ...overrides
  };
}

function possibleMatch(overrides: Partial<PossibleOpportunityMatch> = {}): PossibleOpportunityMatch {
  return {
    jobId: "00000000-0000-4000-8000-000000000001",
    candidateKey: "candidate-1",
    demandEventKey: "event-1",
    demandOptionId: "00000000-0000-4000-8000-000000000021",
    supplyLotId: "00000000-0000-4000-8000-000000000022",
    demandDisplayMpn: "ABC-001",
    supplyDisplayMpn: "ABC001",
    demandNormalizedMpn: "ABC-001",
    supplyNormalizedMpn: "ABC001",
    reviewKey: "ABC001",
    demandFileId: "00000000-0000-4000-8000-000000000011",
    supplyFileId: "00000000-0000-4000-8000-000000000012",
    reasonCode: "symbol_variant",
    ...overrides
  };
}

function rejectedRow(overrides: Partial<OpportunityRejectedRow> = {}): OpportunityRejectedRow {
  return {
    jobId: "00000000-0000-4000-8000-000000000001",
    fileId: "00000000-0000-4000-8000-000000000011",
    side: "A",
    fileName: "demand.xlsx",
    sheetName: "Demand",
    sourceRow: 9,
    hidden: false,
    reasonCode: "missing_mpn",
    fieldName: "mpn",
    sourceColumn: "A",
    safeRawValue: "missing",
    ...overrides
  };
}

function headerIndex(sheet: ExcelJS.Worksheet, header: string) {
  const values = sheet.getRow(1).values as unknown[];
  return values.findIndex((value) => value === header);
}

describe("Opportunity Finder export workbook", () => {
  it("creates exactly the nine required Spanish worksheets within Excel's name limit", () => {
    const workbook = buildOpportunityExportWorkbook([], "es");

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(OPPORTUNITY_EXPORT_SHEET_NAMES);
    expect(workbook.worksheets.every((sheet) => sheet.name.length <= 31)).toBe(true);
  });

  it("preserves existing durable candidate identities in review and trace sheets", () => {
    const resultCandidateId = "00000000-0000-5000-8000-000000000123";
    const possibleCandidateId = "00000000-0000-5000-8000-000000000456";
    const workbook = buildOpportunityExportWorkbook([
      result("review", "review_required", {
        candidateId: resultCandidateId,
        reviewStatus: "pending"
      })
    ], "es", {
      possibleMatches: [possibleMatch({ id: possibleCandidateId })]
    });

    const possible = workbook.getWorksheet("Posibles matches")!;
    const candidateColumn = headerIndex(possible, "ID candidato");
    expect(candidateColumn).toBeGreaterThan(0);
    expect(possible.getCell(2, candidateColumn).value).toBe(resultCandidateId);
    expect(possible.getCell(3, candidateColumn).value).toBe(possibleCandidateId);

    const trace = workbook.getWorksheet("Trazabilidad y reglas")!;
    const traceCandidateColumn = headerIndex(trace, "ID candidato");
    expect(traceCandidateColumn).toBeGreaterThan(0);
    expect(trace.getColumn(traceCandidateColumn).values).toContain(resultCandidateId);
  });

  it("marks bounded provenance previews explicitly in workbook traces", () => {
    const workbook = buildOpportunityExportWorkbook([
      result("bounded-trace", "full_sale", {
        supplySourceRows: 5_000,
        supplyTraces: [{
          fileId: "synthetic-supply",
          fileName: "synthetic-supply.xlsx",
          sheetName: "Synthetic",
          sourceRow: 2,
          hidden: false,
          headerRow: 1,
          columns: {},
          originalIndex: 0
        }],
        supplyTracePreviewTruncated: true
      })
    ], "es");
    const trace = workbook.getWorksheet("Trazabilidad y reglas")!;
    const types = trace.getColumn(headerIndex(trace, "Tipo de registro")).values;
    const details = trace.getColumn(headerIndex(trace, "Detalle o regla")).values;

    expect(types).toContain("Vista previa acotada");
    expect(details).toContain(
      "1 de 5000 fila(s) mostradas en la vista previa; no se descartaron resultados ni cantidades."
    );
  });

  it("classifies stock, excess, supplier offers, reviews and historical signals into their semantic sheets", () => {
    const results = [
      result("full", "full_sale"),
      result("partial", "partial_sale", { allocatedQty: 4, shortageQty: 6, coveragePercent: 40 }),
      result("source", "sourcing_needed", { availableQty: 0, allocatedQty: 0, shortageQty: 10, coveragePercent: 0 }),
      result("supply-only", "supply_without_demand", { requiredQty: null, allocatedQty: 0, coveragePercent: null }),
      result("history", "historical_signal", { availableQty: null, allocatedQty: null, coveragePercent: null }),
      result("review", "review_required", { reviewStatus: "pending" }),
      result("offer-full", "supplier_offer_match"),
      result("offer-part", "supplier_offer_match", { allocatedQty: 3, shortageQty: 7, coveragePercent: 30 }),
      result("excess-full", "excess_resale"),
      result("excess-part", "excess_resale", { allocatedQty: 7, shortageQty: 3, coveragePercent: 70 })
    ];

    expect(classifyOpportunityForExport(results[6])).toBe("Oportunidades completas");
    expect(classifyOpportunityForExport(results[7])).toBe("Oportunidades parciales");

    const workbook = buildOpportunityExportWorkbook(results, "es", {
      possibleMatches: [possibleMatch()],
      rejectedRows: [rejectedRow()]
    });

    expect(workbook.getWorksheet("Oportunidades completas")?.rowCount).toBe(4);
    expect(workbook.getWorksheet("Oportunidades parciales")?.rowCount).toBe(4);
    expect(workbook.getWorksheet("Requiere sourcing")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Oferta sin demanda")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Señales históricas")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Posibles matches")?.rowCount).toBe(3);
    expect(workbook.getWorksheet("Filas rechazadas")?.rowCount).toBe(2);
  });

  it("neutralizes formula injection after leading whitespace/control characters in every exported source", async () => {
    const dangerous = result("danger", "full_sale", {
      demandMpnOriginal: "\r\n@calc",
      supplyMpnOriginal: "\t+SUM(1,1)",
      displayMpn: "=HYPERLINK(\"https://invalid.test\")",
      normalizedMpn: "\u200B-2+3",
      manufacturer: "  =cmd",
      customerContext: "\u0007@payload",
      availableQty: -5,
      demandFileName: "\t-formula.xlsx"
    });
    const workbook = buildOpportunityExportWorkbook([dangerous], "es", {
      possibleMatches: [possibleMatch({ demandDisplayMpn: "\uFEFF=1+1" })],
      rejectedRows: [rejectedRow({ safeRawValue: "\u200B@SUM(1,1)" })]
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer);

    const complete = reloaded.getWorksheet("Oportunidades completas")!;
    for (const header of [
      "MPN original demanda",
      "MPN original oferta",
      "MPN mostrado",
      "MPN normalizado",
      "Fabricante original",
      "Cliente o contexto",
      "Archivo demanda"
    ]) {
      const value = complete.getCell(2, headerIndex(complete, header)).value;
      expect(typeof value).toBe("string");
      expect(String(value).startsWith("'")).toBe(true);
      expect(typeof value === "object" && value !== null && "formula" in value).toBe(false);
    }
    const availableValue = complete.getCell(2, headerIndex(complete, "Cantidad disponible")).value;
    expect(availableValue).toBe(-5);
    expect(typeof availableValue).toBe("number");

    const possible = reloaded.getWorksheet("Posibles matches")!;
    expect(String(possible.getCell(2, headerIndex(possible, "MPN demanda")).value).startsWith("'")).toBe(true);
    const rejected = reloaded.getWorksheet("Filas rechazadas")!;
    expect(String(rejected.getCell(2, headerIndex(rejected, "Valor seguro")).value).startsWith("'")).toBe(true);

    const csv = buildOpportunityCsv([dangerous], "es");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"-5"');
    expect(csv).not.toContain('"\'-5"');
    expect(safeSpreadsheetValue(-12.5)).toBe(-12.5);
    expect(safeSpreadsheetValue(" -12.5")).toBe("' -12.5");
  });

  it("keeps pricing and financial columns absent unless their explicit permission options are enabled", () => {
    const priced = result("priced", "full_sale", {
      targetPrice: 2.5,
      offerPrice: 2,
      targetGapPercent: -20,
      currency: "USD",
      revenuePotential: 20,
      unitCost: 1.5,
      grossProfit: 5,
      grossMarginPercent: 25
    });

    const redacted = buildOpportunityExportWorkbook([priced], "es");
    const redactedSheet = redacted.getWorksheet("Oportunidades completas")!;
    expect(headerIndex(redactedSheet, "Target price")).toBe(-1);
    expect(headerIndex(redactedSheet, "Costo unitario")).toBe(-1);

    const authorized = buildOpportunityExportWorkbook([priced], "es", {
      includePricing: true,
      includeFinancials: true
    });
    const authorizedSheet = authorized.getWorksheet("Oportunidades completas")!;
    expect(authorizedSheet.getCell(2, headerIndex(authorizedSheet, "Target price")).value).toBe(2.5);
    expect(authorizedSheet.getCell(2, headerIndex(authorizedSheet, "Costo unitario")).value).toBe(1.5);
  });

  it("writes the same nine-sheet contract with the disk-backed streaming writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opportunity-export-test-"));
    const filename = join(directory, "streamed.xlsx");
    try {
      const writer = new OpportunityStreamingExportWriter("es", {
        filename,
        includePricing: false,
        includeFinancials: false,
        jobId: "00000000-0000-4000-8000-000000000001",
        generatedAt: new Date("2026-08-08T12:00:00.000Z")
      });
      writer.addResults([
        result("streamed", "full_sale", {
          demandMpnOriginal: "\t=CMD()",
          demandTraces: [{
            fileId: "00000000-0000-4000-8000-000000000011",
            fileName: "\u200B@trace.xlsx",
            sheetName: "Demand",
            sourceRow: 2,
            hidden: false,
            headerRow: 1,
            columns: { mpn: "A" }
          }]
        })
      ]);
      writer.addPossibleMatches([possibleMatch({ demandDisplayMpn: " +SUM(1,1)" })]);
      writer.addRejectedRows([rejectedRow({ safeRawValue: "\uFEFF-1+1" })]);
      const counts = await writer.commit();

      expect(counts).toMatchObject({
        resultCount: 1,
        possibleMatchCount: 1,
        rejectedRowCount: 1,
        sheetCount: 9
      });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await readFile(filename));
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(OPPORTUNITY_EXPORT_SHEET_NAMES);
      const complete = workbook.getWorksheet("Oportunidades completas")!;
      expect(String(complete.getCell(2, headerIndex(complete, "MPN original demanda")).value)).toBe("'\t=CMD()");
      const possible = workbook.getWorksheet("Posibles matches")!;
      expect(String(possible.getCell(2, headerIndex(possible, "MPN demanda")).value)).toBe("' +SUM(1,1)");
      const rejected = workbook.getWorksheet("Filas rechazadas")!;
      expect(String(rejected.getCell(2, headerIndex(rejected, "Valor seguro")).value)).toBe("'\uFEFF-1+1");
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("exposes an explicit 413-compatible error for Excel's hard row limit", () => {
    expect(OPPORTUNITY_EXPORT_MAX_SHEET_ROWS).toBe(1_048_576);
    let error: unknown;
    try {
      assertOpportunityExportSheetCapacity(
        OPPORTUNITY_EXPORT_MAX_SHEET_ROWS,
        "Trazabilidad y reglas"
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpportunityExportTooLargeError);
    expect(error).toMatchObject({
      name: "OpportunityExportTooLargeError",
      code: "EXPORT_TOO_LARGE",
      sheetName: "Trazabilidad y reglas"
    });
  });
});
