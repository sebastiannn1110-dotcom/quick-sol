import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import type { Language } from "@/lib/i18n";
import {
  cleanUuid,
  loadOwnedOpportunityJob,
  OPPORTUNITY_RESULT_SELECT,
  resultDatabaseRow
} from "@/lib/opportunity-finder/api";
import {
  OPPORTUNITY_TYPE_LABELS,
  opportunityActionLabel,
  opportunityFinderCopy,
  opportunityReasonLabel,
  opportunityWarningLabel
} from "@/lib/opportunity-finder/i18n";
import type { OpportunityResult } from "@/lib/opportunity-finder/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;

function languageFromRequest(request: Request): Language {
  const value = new URL(request.url).searchParams.get("lang");
  return value === "en" || value === "zh" ? value : "es";
}

function exportHeaders(language: Language) {
  const copy = opportunityFinderCopy(language);
  const card = copy.card;
  return [
    copy.filters.type,
    "MPN",
    card.manufacturer,
    card.customer,
    card.required,
    card.available,
    card.allocated,
    card.shortage,
    card.coverage,
    card.requiredDate,
    card.unit,
    card.demandSource,
    card.supplySource,
    card.reason,
    card.action,
    card.warnings
  ];
}

function exportRow(result: OpportunityResult, language: Language) {
  return [
    OPPORTUNITY_TYPE_LABELS[language][result.opportunityType],
    result.displayMpn,
    result.manufacturer ?? "",
    result.customerContext ?? "",
    result.requiredQty ?? "",
    result.availableQty ?? "",
    result.allocatedQty ?? "",
    result.shortageQty ?? "",
    result.coveragePercent ?? "",
    result.requiredDate ?? "",
    result.unitOfMeasure ?? "",
    [result.demandFileName, result.demandSheetName].filter(Boolean).join(" / "),
    [result.supplyFileName, result.supplySheetName].filter(Boolean).join(" / "),
    opportunityReasonLabel(language, result.reasonCode),
    opportunityActionLabel(language, result.actionCode),
    result.warnings.map((warning) => opportunityWarningLabel(language, warning)).join("; ")
  ];
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  }
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  if (!["completed", "completed_with_warnings"].includes(String(job.status ?? ""))) {
    return NextResponse.json({ errorCode: "JOB_NOT_COMPLETED" }, { status: 409 });
  }
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const resultId = cleanUuid(url.searchParams.get("resultId"));
  const language = languageFromRequest(request);
  const results: OpportunityResult[] = [];
  let offset = 0;

  while (true) {
    let query = context.supabase
      .from("opportunity_finder_results")
      .select(OPPORTUNITY_RESULT_SELECT)
      .eq("job_id", jobId)
      .order("created_at", { ascending: true });
    if (resultId) query = query.eq("id", resultId);
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) return NextResponse.json({ errorCode: "EXPORT_FAILED" }, { status: 500 });
    const page = ((data ?? []) as unknown as Record<string, unknown>[]).map(resultDatabaseRow);
    results.push(...page);
    if (page.length < PAGE_SIZE || resultId) break;
    offset += page.length;
  }

  const date = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const rows = [exportHeaders(language), ...results.map((result) => exportRow(result, language))];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="opportunity-finder-${date}.csv"`,
        "Cache-Control": "private, no-store"
      }
    });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Quiksol Opportunity Finder";
  const sheetNames: Record<Language, string> = {
    es: "Oportunidades",
    en: "Opportunities",
    zh: "销售机会"
  };
  const sheet = workbook.addWorksheet(sheetNames[language], {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.addRow(exportHeaders(language));
  for (const result of results) sheet.addRow(exportRow(result, language));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
  sheet.autoFilter = { from: "A1", to: "P1" };
  const widths = [24, 22, 24, 26, 16, 18, 16, 14, 12, 16, 12, 30, 30, 45, 45, 40];
  sheet.columns.forEach((column, index) => {
    column.width = widths[index] ?? 18;
  });
  sheet.getColumn(9).numFmt = "0.00\"%\"";
  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(Buffer.from(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="opportunity-finder-${date}.xlsx"`,
      "Cache-Control": "private, no-store"
    }
  });
}
