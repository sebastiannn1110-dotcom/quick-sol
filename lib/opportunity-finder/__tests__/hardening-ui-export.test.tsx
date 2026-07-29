// @vitest-environment jsdom

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import OpportunityCard from "@/components/opportunity-finder/OpportunityCard";
import OpportunityFinder from "@/components/opportunity-finder/OpportunityFinder";
import {
  buildOpportunityCsv,
  buildOpportunityExportWorkbook
} from "@/app/api/opportunity-finder/jobs/[id]/export/route";
import { resultDatabaseRow } from "@/lib/opportunity-finder/api";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import { parseOpportunityWorkbook } from "@/lib/opportunity-finder/parser";
import type {
  CanonicalOpportunityRow,
  OpportunityResult
} from "@/lib/opportunity-finder/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })
  ));
});

function demandRow(): CanonicalOpportunityRow {
  return {
    jobId: "job",
    fileId: "demand-file",
    side: "A",
    fileName: "synthetic-demand.xlsx",
    sheetName: "Demand",
    sourceRow: 2,
    originalIndex: 0,
    recordRole: "demand",
    rawMpn: "NEED-001",
    displayMpn: "NEED-001",
    normalizedMpn: "NEED-001",
    reviewKey: "NEED001",
    manufacturer: "Synthetic Manufacturer",
    customerContext: "Synthetic Customer",
    supplierContext: null,
    requiredQty: 5,
    availableQty: null,
    excessQty: null,
    requiredDate: "2026-08-01",
    unitOfMeasure: null,
    qualityFlags: ["missing_unit"]
  };
}

function databaseResult(result: OpportunityResult) {
  return {
    id: "result-id",
    job_id: result.jobId,
    opportunity_type: result.opportunityType,
    exact_match: result.exactMpnMatch,
    usable_availability_match: result.usableAvailabilityMatch,
    exact_quantity_match: result.exactQuantityMatch,
    display_mpn: result.displayMpn,
    normalized_mpn: result.normalizedMpn,
    manufacturer: result.manufacturer,
    customer_context: result.customerContext,
    supplier_context: result.supplierContext,
    required_qty: result.requiredQty,
    available_qty: result.availableQty,
    allocated_qty: result.allocatedQty,
    shortage_qty: result.shortageQty,
    coverage_percent: result.coveragePercent,
    required_date: result.requiredDate,
    unit_of_measure: result.unitOfMeasure,
    demand_file_id: result.demandFileId,
    demand_file_name: result.demandFileName,
    demand_sheet_name: result.demandSheetName,
    supply_file_id: result.supplyFileId,
    supply_file_name: result.supplyFileName,
    supply_sheet_name: result.supplySheetName,
    demand_source_rows: result.demandSourceRows,
    supply_source_rows: result.supplySourceRows,
    reason_code: result.reasonCode,
    action_code: result.actionCode,
    warnings: result.warnings
  };
}

describe("Opportunity Finder public privacy and terminology", () => {
  it("keeps a financial source out of canonical rows, API DTO, cards, CSV, and XLSX", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opportunity-privacy-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "synthetic-stock.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Stock On Hand");
    sheet.addRow(["MPN", "MFG", "STOCK QTY", "UNIT COST"]);
    sheet.addRow(["STOCK-001", "Synthetic Manufacturer", 9, "FINANCIAL_SENTINEL"]);
    await workbook.xlsx.writeFile(filePath);

    const stockRows: CanonicalOpportunityRow[] = [];
    await parseOpportunityWorkbook({
      filePath,
      fileName: "synthetic-stock.xlsx",
      fileId: "stock-file",
      jobId: "job",
      side: "B",
      role: "stock",
      onBatch: async (rows) => stockRows.push(...rows)
    });
    expect(stockRows).toHaveLength(1);
    expect(stockRows[0].unitOfMeasure).toBeNull();

    const output = matchOpportunityRows({
      jobId: "job",
      roleA: "demand",
      roleB: "stock",
      rows: [demandRow(), ...stockRows]
    });
    const stockOnly = output.results.find((result) => result.displayMpn === "STOCK-001");
    expect(stockOnly?.unitOfMeasure).toBeNull();

    const publicResult = resultDatabaseRow(databaseResult(stockOnly!));
    expect(publicResult.unitOfMeasure).toBeNull();
    expect(JSON.stringify(publicResult)).not.toContain("FINANCIAL_SENTINEL");
    const legacyPublicResult = resultDatabaseRow({
      ...databaseResult(stockOnly!),
      unit_of_measure: "FINANCIAL_SENTINEL"
    }, null);
    expect(legacyPublicResult.unitOfMeasure).toBeNull();
    expect(JSON.stringify(legacyPublicResult)).not.toContain("FINANCIAL_SENTINEL");

    const csv = buildOpportunityCsv([publicResult], "es");
    expect(csv).not.toContain("FINANCIAL_SENTINEL");
    expect(csv).toContain("MPN exacto");
    expect(csv).toContain("Disponibilidad utilizable");
    expect(csv).toContain("Cantidad exacta");

    const exportWorkbook = buildOpportunityExportWorkbook([publicResult], "es");
    const exportBuffer = await exportWorkbook.xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(exportBuffer);
    const exportedValues = reloaded.worksheets[0].getSheetValues();
    expect(JSON.stringify(exportedValues)).not.toContain("FINANCIAL_SENTINEL");
    const unitColumn = (reloaded.worksheets[0].getRow(1).values as unknown[])
      .findIndex((value) => value === "Unidad");
    expect(unitColumn).toBeGreaterThan(0);
    expect(reloaded.worksheets[0].getCell(2, unitColumn).value ?? null).toBeNull();

    render(
      <LanguageProvider>
        <OpportunityCard result={publicResult} jobId="job" />
      </LanguageProvider>
    );
    expect(document.body.textContent).not.toContain("FINANCIAL_SENTINEL");
    expect(screen.getByText(/MPN exacto:/)).toBeTruthy();
    expect(screen.getByText(/Disponibilidad utilizable:/)).toBeTruthy();
    expect(screen.getByText(/Cantidad exacta:/)).toBeTruthy();
  });

  it("labels the exact-MPN filter without implying identical quantities", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/opportunity-finder/i18n.ts"),
      "utf8"
    );
    expect(source).toContain('exactOnly: "Solo coincidencias exactas de MPN"');
    expect(source).toContain("No significa que las cantidades sean idénticas.");
    expect(source).toContain('full_sale: "Venta completa"');
  });

  it("reopens a reused completed job and presents the 409 as saved state", async () => {
    const jobId = "00000000-0000-4000-8000-000000000099";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          code: "COMPARISON_ALREADY_EXISTS",
          errorCode: "COMPARISON_ALREADY_EXISTS",
          jobId,
          status: "completed",
          reusedExistingJob: true,
          createdAt: "2026-07-29T12:00:00.000Z",
          pipelineVersion: "2"
        })
      } as Response)
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: jobId,
            status: "completed",
            currentStage: "completed",
            progressPercent: 100,
            fileARole: "demand",
            fileBRole: "stock",
            totalRowsA: 1,
            totalRowsB: 1,
            processedRows: 2,
            resultCount: 0,
            warningCount: 0,
            summary: {},
            errorCode: null,
            pipelineVersion: "2",
            createdAt: "2026-07-29T12:00:00.000Z",
            expiresAt: null
          },
          files: [],
          results: [],
          possibleMatches: [],
          page: { offset: 0, limit: 48, total: 0 }
        })
      } as Response);

    const { container } = render(
      <LanguageProvider>
        <OpportunityFinder />
      </LanguageProvider>
    );
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    fireEvent.change(inputs[0], {
      target: { files: [new File(["demand"], "synthetic-demand.xlsx")] }
    });
    fireEvent.change(inputs[1], {
      target: { files: [new File(["stock"], "synthetic-stock.xlsx")] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Subir y analizar archivos" }));

    expect(await screen.findByText(/Se encontró una comparación anterior/)).toBeTruthy();
    expect(screen.getByText(/Estado guardado:/).parentElement?.textContent).toContain("Completado");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/opportunity-finder/jobs/${jobId}?`),
        { cache: "no-store" }
      );
    });
    expect(screen.queryByText("No se pudo completar la operación.")).toBeNull();
  });

  it("does not place canonical unit values in Opportunity Finder logs", () => {
    const worker = fs.readFileSync(
      path.join(process.cwd(), "lib/opportunity-finder/worker.ts"),
      "utf8"
    );
    const logSection = worker.slice(worker.indexOf("export async function processOpportunityFinderJob"));
    expect(logSection).not.toMatch(/metadata:\s*\{[^}]*unit(?:OfMeasure|_of_measure)/s);
  });
});
