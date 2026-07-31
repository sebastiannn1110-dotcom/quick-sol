import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildOpportunityCsv,
  buildOpportunityExportWorkbook,
  exportHeaders,
  exportRow
} from "@/app/api/opportunity-finder/jobs/[id]/export/route";
import {
  getOpportunityFinderAiSummary,
  type OpportunityFinderAiMetrics
} from "@/lib/ai/opportunity-finder-tool";
import { localizeToolSummary } from "@/lib/ai/messages";
import type { AiToolResult } from "@/lib/ai/database-tools";
import type { Language } from "@/lib/i18n";
import { resultDatabaseRow } from "@/lib/opportunity-finder/api";
import { OPPORTUNITY_TYPE_LABELS } from "@/lib/opportunity-finder/i18n";
import { matchOpportunityRows } from "@/lib/opportunity-finder/matcher";
import {
  OPPORTUNITY_FINDER_PIPELINE_VERSION
} from "@/lib/opportunity-finder/pipeline";
import { parseOpportunityWorkbook } from "@/lib/opportunity-finder/parser";
import type {
  CanonicalOpportunityRow,
  OpportunityMatchOutput,
  OpportunityResult
} from "@/lib/opportunity-finder/types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "00000000-0000-4000-8000-000000000002";
const NEED_FILE_ID = "00000000-0000-4000-8000-000000000003";
const STOCK_FILE_ID = "00000000-0000-4000-8000-000000000004";
const SET_ROOT = path.join(
  process.cwd(),
  "qa",
  "fixtures",
  "opportunity-finder",
  "manual",
  "set-01-planned-po-stock"
);

const EXPECTED_SET_01_COUNTS = {
  exactMatches: 11,
  usableAvailabilityMatches: 9,
  exactQuantityMatches: 5,
  fullSales: 8,
  partialSales: 2,
  sourcingNeeded: 2,
  supplyWithoutDemand: 1,
  reviewRequired: 1,
  invalidQuantityRows: 1
} as const;

async function parseFixture(
  fileName: string,
  fileId: string,
  side: "A" | "B",
  role: "demand" | "stock"
) {
  const rows: CanonicalOpportunityRow[] = [];
  const metrics = await parseOpportunityWorkbook({
    filePath: path.join(SET_ROOT, fileName),
    fileName,
    fileId,
    jobId: JOB_ID,
    side,
    role,
    onBatch: async (batch) => rows.push(...batch)
  });
  return { rows, metrics };
}

async function matchSet01(): Promise<{
  rows: CanonicalOpportunityRow[];
  output: OpportunityMatchOutput;
}> {
  const [need, stock] = await Promise.all([
    parseFixture("QA_Set01_Planned_PO.xlsx", NEED_FILE_ID, "A", "demand"),
    parseFixture("QA_Set01_Stock_On_Hand.xlsx", STOCK_FILE_ID, "B", "stock")
  ]);
  const rows = [...need.rows, ...stock.rows];
  return {
    rows,
    output: matchOpportunityRows({
      jobId: JOB_ID,
      roleA: "demand",
      roleB: "stock",
      rows,
      missingMpnRows:
        need.metrics.missingMpnRows + stock.metrics.missingMpnRows,
      invalidQuantityRows:
        need.metrics.invalidQuantityRows + stock.metrics.invalidQuantityRows
    })
  };
}

function databaseRow(result: OpportunityResult, index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    job_id: JOB_ID,
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
    warnings: result.warnings,
    created_at: `2026-07-30T12:00:${String(index).padStart(2, "0")}.000Z`
  };
}

function persistedJob(output: OpportunityMatchOutput) {
  const warningCount = output.results.reduce(
    (total, result) => total + result.warnings.length,
    0
  );
  return {
    id: JOB_ID,
    created_by: USER_ID,
    idempotency_key:
      `opportunity-finder:v${OPPORTUNITY_FINDER_PIPELINE_VERSION}:${"a".repeat(64)}`,
    status: "completed_with_warnings",
    matched_mpns: output.summary.exactMatches,
    result_count: output.results.length,
    warning_count: warningCount,
    missing_mpn_rows: output.summary.missingMpnRows,
    invalid_quantity_rows: output.summary.invalidQuantityRows,
    summary_json: output.summary,
    completed_at: "2026-07-30T12:00:30.000Z"
  };
}

function persistedSupabase(
  job: ReturnType<typeof persistedJob>,
  resultRows: ReturnType<typeof databaseRow>[]
) {
  type Query = {
    select(...args: unknown[]): Query;
    eq(...args: unknown[]): Query;
    in(...args: unknown[]): Query;
    like(...args: unknown[]): Query;
    order(...args: unknown[]): Query;
    limit(...args: unknown[]): Query;
    or(...args: unknown[]): Query;
    maybeSingle(): Promise<{ data: typeof job; error: null }>;
    range(from: number, to: number): Promise<{
      data: typeof resultRows;
      error: null;
      count: number;
    }>;
  };

  function query(table: string): Query {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      like: () => chain,
      order: () => chain,
      limit: () => chain,
      or: () => chain,
      maybeSingle: async () => ({ data: job, error: null as const }),
      range: async (from: number, to: number) => ({
        data: table === "opportunity_finder_results"
          ? resultRows.slice(from, to + 1)
          : [],
        error: null as const,
        count: table === "opportunity_finder_results" ? resultRows.length : 0
      })
    };
    return chain as Query;
  }

  return {
    from: (table: string) => query(table)
  } as unknown as SupabaseClient;
}

function expectedAiMetrics(
  output: OpportunityMatchOutput
): OpportunityFinderAiMetrics {
  return {
    analyzedMpns: output.summary.analyzedMpns,
    exactMatches: output.summary.exactMatches,
    usableAvailabilityMatches: output.summary.usableAvailabilityMatches,
    exactQuantityMatches: output.summary.exactQuantityMatches,
    fullSales: output.summary.fullSales,
    partialSales: output.summary.partialSales,
    sourcingNeeded: output.summary.sourcingNeeded,
    supplyWithoutDemand: output.summary.supplyWithoutDemand,
    reviewRequired: output.summary.reviewRequired,
    missingMpnRows: output.summary.missingMpnRows,
    invalidQuantityRows: output.summary.invalidQuantityRows,
    resultCount: output.results.length,
    warningCount: output.results.reduce(
      (total, result) => total + result.warnings.length,
      0
    )
  };
}

function safeAiProjection(result: OpportunityResult) {
  return {
    opportunityType: result.opportunityType,
    displayMpn: result.displayMpn,
    requiredQty: result.requiredQty,
    availableQty: result.availableQty,
    allocatedQty: result.allocatedQty,
    shortageQty: result.shortageQty,
    coveragePercent: result.coveragePercent,
    requiredDate: result.requiredDate,
    unitOfMeasure: result.unitOfMeasure,
    exactMpnMatch: result.exactMpnMatch,
    usableAvailabilityMatch: result.usableAvailabilityMatch,
    exactQuantityMatch: result.exactQuantityMatch,
    reasonCode: result.reasonCode,
    actionCode: result.actionCode,
    warnings: result.warnings
  };
}

function parseQuotedCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const source = csv.replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted && character === '"' && source[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      row.push(value);
      value = "";
    } else if (!quoted && character === "\r" && source[index + 1] === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      index += 1;
    } else {
      value += character;
    }
  }
  row.push(value);
  rows.push(row);
  return rows;
}

function stringMatrix(rows: unknown[][]) {
  return rows.map((row) => row.map((value) => String(value ?? "")));
}

async function xlsxMatrix(
  results: OpportunityResult[],
  language: Language
): Promise<string[][]> {
  const exported = buildOpportunityExportWorkbook(results, language);
  const buffer = await exported.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer);
  const sheet = reloaded.worksheets[0];
  const columnCount = exportHeaders(language).length;
  const rows: string[][] = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row: string[] = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      row.push(String(sheet.getCell(rowNumber, columnNumber).value ?? ""));
    }
    rows.push(row);
  }
  return rows;
}

function countExportedTypes(rows: string[][], language: Language) {
  const values = rows.slice(1).map((row) => row[0]);
  const count = (type: keyof typeof OPPORTUNITY_TYPE_LABELS.es) =>
    values.filter((value) => value === OPPORTUNITY_TYPE_LABELS[language][type]).length;
  return {
    fullSales: count("full_sale"),
    partialSales: count("partial_sale"),
    sourcingNeeded: count("sourcing_needed"),
    supplyWithoutDemand: count("supply_without_demand"),
    reviewRequired: count("review_required")
  };
}

describe("Opportunity Finder Set 01 assistant parity", () => {
  it("locks the aggregate contract and preserves MPN identity without inventory reuse", async () => {
    const { rows, output } = await matchSet01();

    expect(output.summary).toEqual(expect.objectContaining(EXPECTED_SET_01_COUNTS));

    const leadingZero = output.results.find(
      (result) => result.displayMpn === "0007-QA-006"
    );
    expect(leadingZero).toEqual(expect.objectContaining({
      displayMpn: "0007-QA-006",
      normalizedMpn: "0007-QA-006"
    }));
    expect(typeof leadingZero?.displayMpn).toBe("string");

    const duplicateDemand = output.results.filter(
      (result) => result.normalizedMpn === "DUP-DEMAND-008"
    );
    const early = duplicateDemand.find(
      (result) => result.customerContext === "DUP-DEMAND-008-EARLY"
    );
    const late = duplicateDemand.find(
      (result) => result.customerContext === "DUP-DEMAND-008-LATE"
    );
    const usableSupply = rows
      .filter(
        (row) =>
          row.side === "B" &&
          row.normalizedMpn === "DUP-DEMAND-008" &&
          (row.availableQty ?? 0) > 0
      )
      .reduce((total, row) => total + (row.availableQty ?? 0), 0);

    expect(early).toEqual(expect.objectContaining({
      requiredQty: 70,
      allocatedQty: 70,
      shortageQty: 0,
      opportunityType: "full_sale"
    }));
    expect(late).toEqual(expect.objectContaining({
      requiredQty: 60,
      allocatedQty: 30,
      shortageQty: 30,
      opportunityType: "partial_sale"
    }));
    expect(duplicateDemand.reduce(
      (total, result) => total + (result.allocatedQty ?? 0),
      0
    )).toBe(usableSupply);
  });

  it("keeps persisted AI, CSV, and XLSX result counts identical in ES, EN, and ZH", async () => {
    const { output } = await matchSet01();
    const resultRows = output.results.map(databaseRow);
    const persistedResults = resultRows.map((row) =>
      resultDatabaseRow(row, OPPORTUNITY_FINDER_PIPELINE_VERSION)
    );
    const supabase = persistedSupabase(persistedJob(output), resultRows);
    const expectedMetrics = expectedAiMetrics(output);
    const expectedTypeCounts = {
      fullSales: 8,
      partialSales: 2,
      sourcingNeeded: 2,
      supplyWithoutDemand: 1,
      reviewRequired: 1
    };

    for (const language of ["es", "en", "zh"] as const) {
      const ai = await getOpportunityFinderAiSummary({
        supabase,
        userId: USER_ID,
        jobId: JOB_ID,
        language,
        limit: 50
      });
      expect(ai).toEqual(expect.objectContaining({
        ok: true,
        status: "ok",
        source: "opportunity_finder_v2",
        pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
        metrics: expectedMetrics
      }));
      expect(ai.items).toEqual(persistedResults.map(safeAiProjection));
      expect(ai.page.total).toBe(persistedResults.length);
      expect(ai.summary).toContain(String(persistedResults.length));

      const assistantToolResult: AiToolResult = {
        ok: true,
        tool: "getOpportunityFinderSummary",
        scope: "own",
        total: persistedResults.length,
        rows: [],
        data: { items: ai.items, totals: ai.metrics },
        summary: "Untrusted internal summary must not be reused.",
        empty: false,
        truncated: false,
        deterministic: true
      };
      const assistantSummary = localizeToolSummary(assistantToolResult, language);
      const expectedAssistantSummary = {
        es: "Buscador de oportunidades: 11 MPN exactos, 9 con disponibilidad utilizable, 5 con cantidad exacta, 8 ventas completas, 2 ventas parciales, 2 con sourcing requerido, 1 inventario sin demanda, 1 en revisión y 1 cantidad inválida.",
        en: "Opportunity Finder: 11 exact MPNs, 9 with usable availability, 5 exact quantities, 8 full sales, 2 partial sales, 2 requiring sourcing, 1 supply without demand, 1 requiring review, and 1 invalid quantity.",
        zh: "商机查找结果：11 个精确 MPN，9 个可用库存，5 个精确数量，8 个完整销售，2 个部分销售，2 个需要采购，1 个无需求库存，1 个需要审核，1 个无效数量。"
      } as const;
      expect(assistantSummary).toBe(expectedAssistantSummary[language]);
      expect(assistantSummary).not.toContain("Untrusted internal summary");

      const expectedRows = [
        exportHeaders(language),
        ...persistedResults.map((result) => exportRow(result, language))
      ];
      const csvRows = parseQuotedCsv(
        buildOpportunityCsv(persistedResults, language)
      );
      const workbookRows = await xlsxMatrix(persistedResults, language);

      expect(csvRows).toEqual(stringMatrix(expectedRows));
      expect(workbookRows).toEqual(stringMatrix(expectedRows));
      expect(countExportedTypes(csvRows, language)).toEqual(expectedTypeCounts);
      expect(countExportedTypes(workbookRows, language)).toEqual(expectedTypeCounts);
      expect(csvRows.some((row) => row[1] === "0007-QA-006")).toBe(true);
      expect(workbookRows.some((row) => row[1] === "0007-QA-006")).toBe(true);
    }
  });
});
