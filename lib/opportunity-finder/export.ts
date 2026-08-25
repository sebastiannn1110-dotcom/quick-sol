import { once } from "node:events";
import ExcelJS from "exceljs";
import type { Language } from "@/lib/i18n";
import {
  OPPORTUNITY_TYPE_LABELS,
  opportunityActionLabel,
  opportunityFinderCopy,
  opportunityReasonLabel,
  opportunityWarningLabel
} from "@/lib/opportunity-finder/i18n";
import type {
  OpportunityRejectedRow,
  OpportunityResult,
  OpportunitySourceTrace,
  OpportunitySummary,
  PossibleOpportunityMatch
} from "@/lib/opportunity-finder/types";

export const OPPORTUNITY_EXPORT_SHEET_NAMES = [
  "Resumen",
  "Oportunidades completas",
  "Oportunidades parciales",
  "Requiere sourcing",
  "Oferta sin demanda",
  "Posibles matches",
  "Señales históricas",
  "Filas rechazadas",
  "Trazabilidad y reglas"
] as const;

export type OpportunityExportSheetName = typeof OPPORTUNITY_EXPORT_SHEET_NAMES[number];

export interface OpportunityExportOptions {
  possibleMatches?: PossibleOpportunityMatch[];
  rejectedRows?: OpportunityRejectedRow[];
  summary?: Partial<OpportunitySummary> | Record<string, unknown>;
  includePricing?: boolean;
  includeFinancials?: boolean;
  jobId?: string | null;
  pipelineVersion?: string | null;
  generatedAt?: Date | string;
  comparisonMode?: "single_file" | "two_files";
  uploadedRole?: string | null;
  existingEntityCount?: number | null;
  datasetVersion?: string | null;
  analyzedAt?: Date | string | null;
}

type ExportCellValue = string | number | boolean | Date | null;

const DANGEROUS_FORMULA_PREFIX = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u;
const HEADER_FILL = "FF0F766E";
const TITLE_FILL = "FF134E4A";
const LIGHT_FILL = "FFF0FDFA";
const BORDER_COLOR = "FFD1D5DB";

const PRICING_HEADERS = [
  "Target price",
  "Precio de oferta",
  "Diferencia contra target %",
  "Moneda",
  "Revenue potencial"
] as const;

const FINANCIAL_HEADERS = [
  "Costo unitario",
  "GP",
  "Margen bruto %"
] as const;

const BASE_OPPORTUNITY_HEADERS = [
  "Tipo",
  "ID resultado",
  "ID candidato",
  "MPN original demanda",
  "MPN original oferta",
  "MPN mostrado",
  "MPN normalizado",
  "Fabricante original",
  "Fabricante canónico",
  "Cliente o contexto",
  "Proveedor o contexto",
  "Evento de demanda",
  "Cantidad requerida",
  "Cantidad disponible",
  "Cantidad asignada",
  "Cantidad remanente",
  "Faltante",
  "Cobertura %",
  "Fecha requerida",
  "Unidad",
  "MPN exacto",
  "Disponibilidad utilizable",
  "Cantidad exacta",
  "Nivel de match",
  "Confianza",
  "Explicación determinista",
  "Motivo",
  "Acción",
  "Advertencias",
  "Estado de revisión",
  "MOQ",
  "SPQ",
  "Date code",
  "COO",
  "Lead time (semanas)",
  "Condición",
  "Vigencia",
  "Archivo demanda",
  "Hoja demanda",
  "Filas demanda",
  "Archivo oferta",
  "Hoja oferta",
  "Filas oferta"
] as const;

/**
 * Prefixes spreadsheet-like text that Excel could reinterpret as a formula.
 * Numeric values stay numeric, including legitimate negative quantities/prices.
 */
export function safeSpreadsheetValue(value: unknown): ExportCellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return DANGEROUS_FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function localizedLabel(value: string | undefined, fallback: string) {
  return value || fallback;
}

export function exportHeaders(language: Language) {
  const copy = opportunityFinderCopy(language);
  const card = copy.card;
  return [
    copy.filters.type,
    "MPN",
    card.exactMpnMatch,
    card.usableAvailabilityMatch,
    card.exactQuantity,
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

export function exportRow(result: OpportunityResult, language: Language) {
  const card = opportunityFinderCopy(language).card;
  const booleanLabel = (value: boolean) => value ? card.yes : card.no;
  return [
    OPPORTUNITY_TYPE_LABELS[language][result.opportunityType],
    result.displayMpn,
    booleanLabel(result.exactMpnMatch),
    booleanLabel(result.usableAvailabilityMatch),
    booleanLabel(result.exactQuantityMatch),
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
    localizedLabel(opportunityReasonLabel(language, result.reasonCode), result.reasonCode),
    localizedLabel(opportunityActionLabel(language, result.actionCode), result.actionCode),
    result.warnings
      .map((warning) => localizedLabel(opportunityWarningLabel(language, warning), warning))
      .join("; ")
  ];
}

function csvCell(value: unknown) {
  const safeValue = safeSpreadsheetValue(value);
  const text = String(safeValue ?? "");
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export function opportunityCsvHeaderLine(
  language: Language,
  options: Pick<OpportunityExportOptions, "includePricing" | "includeFinancials"> = {}
) {
  const headers = [
    ...exportHeaders(language),
    ...(options.includePricing ? PRICING_HEADERS : []),
    ...(options.includeFinancials ? FINANCIAL_HEADERS : [])
  ];
  return headers.map(csvCell).join(",");
}

export function opportunityCsvResultLine(
  result: OpportunityResult,
  language: Language,
  options: Pick<OpportunityExportOptions, "includePricing" | "includeFinancials"> = {}
) {
  const row = [
    ...exportRow(result, language),
    ...(options.includePricing ? [
      result.targetPrice ?? null,
      result.offerPrice ?? null,
      result.targetGapPercent ?? null,
      result.currency ?? null,
      result.revenuePotential ?? null
    ] : []),
    ...(options.includeFinancials ? [
      result.unitCost ?? null,
      result.grossProfit ?? null,
      result.grossMarginPercent ?? null
    ] : [])
  ];
  return row.map(csvCell).join(",");
}

export function buildOpportunityCsv(
  results: OpportunityResult[],
  language: Language,
  options: Pick<OpportunityExportOptions, "includePricing" | "includeFinancials"> = {}
) {
  return `\uFEFF${[
    opportunityCsvHeaderLine(language, options),
    ...results.map((result) => opportunityCsvResultLine(result, language, options))
  ].join("\r\n")}`;
}

function resultHasFullCoverage(result: OpportunityResult) {
  if (result.opportunityType === "full_sale") return true;
  if (result.opportunityType !== "excess_resale" && result.opportunityType !== "supplier_offer_match") {
    return false;
  }
  if (typeof result.requiredQty === "number" && result.requiredQty > 0) {
    return typeof result.allocatedQty === "number" && result.allocatedQty >= result.requiredQty;
  }
  return typeof result.coveragePercent === "number" && result.coveragePercent >= 100;
}

export function classifyOpportunityForExport(result: OpportunityResult): OpportunityExportSheetName {
  if (resultHasFullCoverage(result)) return "Oportunidades completas";
  if (
    result.opportunityType === "partial_sale" ||
    result.opportunityType === "excess_resale" ||
    result.opportunityType === "supplier_offer_match"
  ) return "Oportunidades parciales";
  if (result.opportunityType === "sourcing_needed") return "Requiere sourcing";
  if (result.opportunityType === "supply_without_demand") return "Oferta sin demanda";
  if (result.opportunityType === "historical_signal") return "Señales históricas";
  return "Posibles matches";
}

function opportunityHeaders(options: OpportunityExportOptions) {
  return [
    ...BASE_OPPORTUNITY_HEADERS,
    ...(options.includePricing ? PRICING_HEADERS : []),
    ...(options.includeFinancials ? FINANCIAL_HEADERS : [])
  ];
}

function opportunityDetailRow(
  result: OpportunityResult,
  language: Language,
  options: OpportunityExportOptions
) {
  const card = opportunityFinderCopy(language).card;
  const booleanLabel = (value: boolean) => value ? card.yes : card.no;
  return [
    OPPORTUNITY_TYPE_LABELS[language][result.opportunityType],
    result.id ?? null,
    result.candidateId ?? null,
    result.demandMpnOriginal ?? result.displayMpn,
    result.supplyMpnOriginal ?? null,
    result.displayMpn,
    result.normalizedMpn,
    result.manufacturer,
    result.manufacturerCanonical ?? null,
    result.customerContext,
    result.supplierContext,
    result.demandEventKey ?? null,
    result.requiredQty,
    result.availableQty,
    result.allocatedQty,
    result.remainingQty ?? null,
    result.shortageQty,
    result.coveragePercent,
    result.requiredDate,
    result.unitOfMeasure,
    booleanLabel(result.exactMpnMatch),
    booleanLabel(result.usableAvailabilityMatch),
    booleanLabel(result.exactQuantityMatch),
    result.matchTier ?? null,
    result.confidence ?? null,
    result.matchExplanation ?? null,
    localizedLabel(opportunityReasonLabel(language, result.reasonCode), result.reasonCode),
    localizedLabel(opportunityActionLabel(language, result.actionCode), result.actionCode),
    result.warnings
      .map((warning) => localizedLabel(opportunityWarningLabel(language, warning), warning))
      .join("; "),
    result.reviewStatus ?? null,
    result.moq ?? null,
    result.spq ?? null,
    result.dateCode ?? null,
    result.coo ?? null,
    result.leadTimeWeeks ?? null,
    result.condition ?? null,
    result.expiresAt ?? null,
    result.demandFileName,
    result.demandSheetName,
    result.demandSourceRows,
    result.supplyFileName,
    result.supplySheetName,
    result.supplySourceRows,
    ...(options.includePricing ? [
      result.targetPrice ?? null,
      result.offerPrice ?? null,
      result.targetGapPercent ?? null,
      result.currency ?? null,
      result.revenuePotential ?? null
    ] : []),
    ...(options.includeFinancials ? [
      result.unitCost ?? null,
      result.grossProfit ?? null,
      result.grossMarginPercent ?? null
    ] : [])
  ];
}

function addSafeRow(sheet: ExcelJS.Worksheet, values: unknown[]) {
  return sheet.addRow(values.map(safeSpreadsheetValue));
}

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber = 1) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  row.height = 30;
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  row.eachCell((cell) => {
    cell.border = {
      top: { style: "thin", color: { argb: BORDER_COLOR } },
      left: { style: "thin", color: { argb: BORDER_COLOR } },
      bottom: { style: "thin", color: { argb: BORDER_COLOR } },
      right: { style: "thin", color: { argb: BORDER_COLOR } }
    };
  });
}

function styleDataSheet(sheet: ExcelJS.Worksheet, headers: readonly string[], rowHeight = 30) {
  styleHeader(sheet);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(headers.length, 1) }
  };
  sheet.properties.defaultRowHeight = rowHeight;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.height = rowHeight;
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => {
      cell.border = {
        bottom: { style: "hair", color: { argb: BORDER_COLOR } }
      };
    });
  });
  sheet.columns.forEach((column, index) => {
    const header = headers[index] ?? "";
    const textHeavy = /MPN|Fabricante|contexto|Explicación|Motivo|Acción|Advertencias|Archivo|Hoja|regla|Columnas|Valor/i.test(header);
    column.width = textHeavy ? Math.min(Math.max(header.length + 3, 18), 38) : Math.min(Math.max(header.length + 3, 12), 24);
  });
}

function applyOpportunityNumberFormats(sheet: ExcelJS.Worksheet, headers: readonly string[]) {
  const format = (header: string, numberFormat: string) => {
    const index = headers.indexOf(header);
    if (index >= 0) sheet.getColumn(index + 1).numFmt = numberFormat;
  };
  for (const header of [
    "Cantidad requerida",
    "Cantidad disponible",
    "Cantidad asignada",
    "Cantidad remanente",
    "Faltante",
    "MOQ",
    "SPQ"
  ]) format(header, "#,##0.00;[Red]-#,##0.00");
  format("Cobertura %", "0.00\"%\"");
  format("Diferencia contra target %", "0.00\"%\"");
  format("Margen bruto %", "0.00\"%\"");
  for (const header of ["Target price", "Precio de oferta", "Revenue potencial", "Costo unitario", "GP"]) {
    format(header, "#,##0.00;[Red]-#,##0.00");
  }
}

function summaryRows(
  results: OpportunityResult[],
  possibleMatches: PossibleOpportunityMatch[],
  rejectedRows: OpportunityRejectedRow[],
  summary: OpportunityExportOptions["summary"]
) {
  const classifiedCounts = new Map<OpportunityExportSheetName, number>();
  for (const result of results) {
    const sheet = classifyOpportunityForExport(result);
    classifiedCounts.set(sheet, (classifiedCounts.get(sheet) ?? 0) + 1);
  }
  const summaryRecord = (summary ?? {}) as Record<string, unknown>;
  const numericSummary = (key: string) => {
    const value = Number(summaryRecord[key]);
    return Number.isFinite(value) ? value : null;
  };
  return [
    ["Métrica", "Valor", "Descripción"],
    ["Resultados exportados", results.length, "Resultados incluidos en este archivo."],
    ["Oportunidades completas", classifiedCounts.get("Oportunidades completas") ?? 0, "Cobertura completa con disponibilidad utilizable."],
    ["Oportunidades parciales", classifiedCounts.get("Oportunidades parciales") ?? 0, "Existe asignación, pero no cubre toda la demanda."],
    ["Requiere sourcing", classifiedCounts.get("Requiere sourcing") ?? 0, "Demanda sin disponibilidad utilizable suficiente."],
    ["Oferta sin demanda", classifiedCounts.get("Oferta sin demanda") ?? 0, "Oferta o inventario sin demanda detectada."],
    ["Posibles matches", (classifiedCounts.get("Posibles matches") ?? 0) + possibleMatches.length, "Candidatos que requieren revisión humana."],
    ["Señales históricas", classifiedCounts.get("Señales históricas") ?? 0, "Coincidencias históricas; no representan stock actual."],
    ["Filas rechazadas", rejectedRows.length || numericSummary("rejectedRows") || 0, "Filas no incorporadas al modelo canónico."],
    ["MPN analizados", numericSummary("analyzedMpns"), "MPN únicos analizados por el motor."],
    ["Eventos de demanda", numericSummary("demandEvents"), "Eventos de demanda sin duplicar cantidades por alternativa."],
    ["Opciones de MPN", numericSummary("demandPartOptions"), "Opciones o alternativos asociados a eventos de demanda."],
    ["Lotes de oferta", numericSummary("supplyLots"), "Lotes independientes disponibles para asignación."]
  ];
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  results: OpportunityResult[],
  options: OpportunityExportOptions
) {
  const possibleMatches = options.possibleMatches ?? [];
  const rejectedRows = options.rejectedRows ?? [];
  const sheet = workbook.addWorksheet("Resumen", { views: [{ state: "frozen", ySplit: 3 }] });
  sheet.mergeCells("A1:C1");
  const title = sheet.getCell("A1");
  title.value = "Opportunity Finder — Resumen de exportación";
  title.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TITLE_FILL } };
  title.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 34;
  sheet.addRow([]);
  for (const row of summaryRows(results, possibleMatches, rejectedRows, options.summary)) {
    addSafeRow(sheet, row);
  }
  styleHeader(sheet, 3);
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 62;
  for (let rowNumber = 4; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.height = 26;
    row.alignment = { vertical: "middle", wrapText: true };
    if (rowNumber % 2 === 0) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_FILL } };
    }
  }

  const metadataStart = sheet.rowCount + 2;
  addSafeRow(sheet, ["Metadato", "Valor", ""]);
  styleHeader(sheet, metadataStart);
  addSafeRow(sheet, ["Job", options.jobId ?? results[0]?.jobId ?? null, ""]);
  addSafeRow(sheet, ["Versión de pipeline", options.pipelineVersion ?? null, ""]);
  addSafeRow(sheet, ["Modo de comparación", options.comparisonMode === "single_file" ? "Un archivo vs Base QuikSol" : "Dos archivos", ""]);
  addSafeRow(sheet, ["Rol detectado", options.uploadedRole ?? null, ""]);
  addSafeRow(sheet, ["Entidades existentes consideradas", options.existingEntityCount ?? 0, ""]);
  addSafeRow(sheet, ["Snapshot / versión", options.datasetVersion ?? null, ""]);
  addSafeRow(sheet, ["Fecha de análisis", options.analyzedAt instanceof Date
    ? options.analyzedAt.toISOString()
    : options.analyzedAt ?? options.generatedAt ?? new Date().toISOString(), ""]);
  addSafeRow(sheet, ["Generado en", options.generatedAt instanceof Date
    ? options.generatedAt.toISOString()
    : options.generatedAt ?? new Date().toISOString(), ""]);
  addSafeRow(sheet, ["Precios incluidos", options.includePricing === true ? "Sí" : "No", ""]);
  addSafeRow(sheet, ["Costos, GP y margen incluidos", options.includeFinancials === true ? "Sí" : "No", ""]);
  return sheet;
}

function addOpportunitySheet(
  workbook: ExcelJS.Workbook,
  name: Exclude<OpportunityExportSheetName, "Resumen" | "Posibles matches" | "Filas rechazadas" | "Trazabilidad y reglas">,
  results: OpportunityResult[],
  language: Language,
  options: OpportunityExportOptions
) {
  const headers = opportunityHeaders(options);
  const sheet = workbook.addWorksheet(name);
  addSafeRow(sheet, [...headers]);
  for (const result of results) addSafeRow(sheet, opportunityDetailRow(result, language, options));
  styleDataSheet(sheet, headers, 34);
  applyOpportunityNumberFormats(sheet, headers);
  return sheet;
}

const POSSIBLE_MATCH_HEADERS = [
  "Tipo de candidato",
  "ID resultado",
  "ID candidato",
  "MPN demanda",
  "MPN oferta",
  "MPN normalizado demanda",
  "MPN normalizado oferta",
  "Clave de revisión",
  "Fabricante",
  "Fabricante compatible",
  "Nivel de match",
  "Confianza",
  "Explicación determinista",
  "Motivo",
  "Estado de revisión",
  "Archivo demanda",
  "Hoja demanda",
  "Fila demanda",
  "Archivo oferta",
  "Hoja oferta",
  "Fila oferta"
] as const;

function addPossibleMatchesSheet(
  workbook: ExcelJS.Workbook,
  reviewResults: OpportunityResult[],
  possibleMatches: PossibleOpportunityMatch[],
  language: Language
) {
  const sheet = workbook.addWorksheet("Posibles matches");
  addSafeRow(sheet, [...POSSIBLE_MATCH_HEADERS]);
  for (const result of reviewResults) {
    addSafeRow(sheet, [
      "Resultado en revisión",
      result.id ?? null,
      result.candidateId ?? null,
      result.demandMpnOriginal ?? result.displayMpn,
      result.supplyMpnOriginal ?? null,
      result.normalizedMpn,
      null,
      null,
      result.manufacturer,
      null,
      result.matchTier ?? null,
      result.confidence ?? null,
      result.matchExplanation ?? null,
      localizedLabel(opportunityReasonLabel(language, result.reasonCode), result.reasonCode),
      result.reviewStatus ?? null,
      result.demandFileName,
      result.demandSheetName,
      result.demandTraces?.[0]?.sourceRow ?? null,
      result.supplyFileName,
      result.supplySheetName,
      result.supplyTraces?.[0]?.sourceRow ?? null
    ]);
  }
  for (const match of possibleMatches) {
    const matchWithExplanation = match as PossibleOpportunityMatch & {
      matchExplanation?: string | null;
      explanation?: string | null;
    };
    addSafeRow(sheet, [
      "Variante candidata",
      null,
      match.id ?? null,
      match.demandDisplayMpn,
      match.supplyDisplayMpn,
      match.demandNormalizedMpn,
      match.supplyNormalizedMpn,
      match.reviewKey,
      null,
      match.manufacturerCompatible ?? null,
      match.matchTier ?? "search_mpn_mfg",
      match.confidence ?? "review",
      matchWithExplanation.matchExplanation ?? matchWithExplanation.explanation ?? null,
      match.reasonCode,
      match.reviewStatus ?? "pending",
      match.demandTrace?.fileName ?? match.demandFileId,
      match.demandTrace?.sheetName ?? null,
      match.demandTrace?.sourceRow ?? null,
      match.supplyTrace?.fileName ?? match.supplyFileId,
      match.supplyTrace?.sheetName ?? null,
      match.supplyTrace?.sourceRow ?? null
    ]);
  }
  styleDataSheet(sheet, POSSIBLE_MATCH_HEADERS, 34);
  return sheet;
}

const REJECTED_HEADERS = [
  "Archivo",
  "Lado",
  "Hoja",
  "Fila",
  "Fila oculta",
  "Motivo de rechazo",
  "Campo",
  "Columna origen",
  "Valor seguro"
] as const;

function addRejectedRowsSheet(workbook: ExcelJS.Workbook, rejectedRows: OpportunityRejectedRow[]) {
  const sheet = workbook.addWorksheet("Filas rechazadas");
  addSafeRow(sheet, [...REJECTED_HEADERS]);
  for (const row of rejectedRows) {
    addSafeRow(sheet, [
      row.fileName,
      row.side,
      row.sheetName,
      row.sourceRow,
      row.hidden,
      row.reasonCode,
      row.fieldName,
      row.sourceColumn,
      row.safeRawValue
    ]);
  }
  styleDataSheet(sheet, REJECTED_HEADERS, 32);
  return sheet;
}

const TRACE_HEADERS = [
  "Tipo de registro",
  "ID o regla",
  "ID candidato",
  "MPN",
  "Lado",
  "Archivo",
  "Hoja",
  "Fila origen",
  "Fila oculta",
  "Fila de encabezado",
  "Columnas originales",
  "Lote",
  "Cantidad asignada",
  "Disponible antes",
  "Remanente",
  "Detalle o regla"
] as const;

function sourceTraceRow(
  result: OpportunityResult,
  side: "Demanda" | "Oferta" | "Asignación",
  trace: OpportunitySourceTrace,
  allocation?: { lotKey: string; allocatedQty: number; availableBefore: number; remainingQty: number }
) {
  return [
    allocation ? "Asignación" : "Trazabilidad",
    result.id ?? result.demandEventKey ?? null,
    result.candidateId ?? null,
    result.displayMpn,
    side,
    trace.fileName,
    trace.sheetName,
    trace.sourceRow,
    trace.hidden,
    trace.headerRow,
    trace.columns,
    allocation?.lotKey ?? null,
    allocation?.allocatedQty ?? null,
    allocation?.availableBefore ?? null,
    allocation?.remainingQty ?? null,
    allocation ? "Asignación determinista de un lote." : "Fila original vinculada al resultado."
  ];
}

function fallbackTraceRow(result: OpportunityResult, side: "Demanda" | "Oferta") {
  const demand = side === "Demanda";
  return [
    "Trazabilidad agregada",
    result.id ?? result.demandEventKey ?? null,
    result.candidateId ?? null,
    result.displayMpn,
    side,
    demand ? result.demandFileName : result.supplyFileName,
    demand ? result.demandSheetName : result.supplySheetName,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    `${demand ? result.demandSourceRows : result.supplySourceRows} fila(s) de origen; el detalle por fila no estaba disponible en la API.`
  ];
}

function previewTraceNoticeRow(
  result: OpportunityResult,
  side: "Demanda" | "Oferta" | "Asignaciones",
  shown: number,
  total: number | null
) {
  return [
    "Vista previa acotada",
    result.id ?? result.demandEventKey ?? null,
    result.candidateId ?? null,
    result.displayMpn,
    side,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    total === null
      ? `${shown} registro(s) mostrados; la evidencia normalizada completa no estuvo disponible.`
      : `${shown} de ${total} fila(s) mostradas en la vista previa; no se descartaron resultados ni cantidades.`
  ];
}

function ruleRows(options: OpportunityExportOptions) {
  return [
    ["Regla", "mpn_exact_norm", null, null, null, null, null, null, null, null, null, null, null, null, "MPN exacto usa Unicode NFKC, mayúsculas y espacios normalizados; preserva guiones, barras, ceros iniciales y sufijos."],
    ["Regla", "search_norm_review", null, null, null, null, null, null, null, null, null, null, null, null, "Una coincidencia sin separadores sólo genera un posible match y requiere revisión humana."],
    ["Regla", "manufacturer", null, null, null, null, null, null, null, null, null, null, null, null, "El fabricante por sí solo nunca constituye un match; conflictos y alias no aprobados requieren revisión."],
    ["Regla", "allocation", null, null, null, null, null, null, null, null, null, null, null, null, "La asignación es determinista y un lote no puede reutilizarse entre oportunidades."],
    ["Regla", "coverage", null, null, null, null, null, null, null, null, null, null, null, null, "Cobertura = cantidad asignada / cantidad requerida; disponibilidad, cobertura completa y cantidad exacta son conceptos distintos."],
    ["Regla", "moq_spq", null, null, null, null, null, null, null, null, null, null, null, null, "MOQ y SPQ se aplican sin superar la disponibilidad del lote."],
    ["Regla", "historical", null, null, null, null, null, null, null, null, null, null, null, null, "Las coincidencias históricas son señales y nunca se presentan como stock actual."],
    ["Regla", "formula_injection", null, null, null, null, null, null, null, null, null, null, null, null, "Los textos que podrían interpretarse como fórmulas se exportan como texto literal."],
    ["Regla", "pricing_redaction", null, null, null, null, null, null, null, null, null, null, null, null, options.includePricing ? "Precios incluidos para un contexto autorizado." : "Precios omitidos por configuración de permisos."],
    ["Regla", "financial_redaction", null, null, null, null, null, null, null, null, null, null, null, null, options.includeFinancials ? "Costo, GP y margen incluidos para un contexto autorizado." : "Costo, GP y margen omitidos por configuración de permisos."]
  ].map(([type, idOrRule, ...rest]) => [type, idOrRule, null, ...rest]);
}

function addTraceSheet(
  workbook: ExcelJS.Workbook,
  results: OpportunityResult[],
  options: OpportunityExportOptions
) {
  const sheet = workbook.addWorksheet("Trazabilidad y reglas");
  addSafeRow(sheet, [...TRACE_HEADERS]);
  for (const result of results) {
    const demandTraces = result.demandTraces ?? [];
    const supplyTraces = result.supplyTraces ?? [];
    for (const trace of demandTraces) addSafeRow(sheet, sourceTraceRow(result, "Demanda", trace));
    for (const trace of supplyTraces) addSafeRow(sheet, sourceTraceRow(result, "Oferta", trace));
    for (const allocation of result.allocations ?? []) {
      addSafeRow(sheet, sourceTraceRow(result, "Asignación", allocation.supply, allocation));
    }
    if (result.demandTracePreviewTruncated) {
      addSafeRow(sheet, previewTraceNoticeRow(
        result,
        "Demanda",
        demandTraces.length,
        result.demandSourceRows
      ));
    }
    if (result.supplyTracePreviewTruncated) {
      addSafeRow(sheet, previewTraceNoticeRow(
        result,
        "Oferta",
        supplyTraces.length,
        result.supplySourceRows
      ));
    }
    if (result.allocationTracePreviewTruncated) {
      addSafeRow(sheet, previewTraceNoticeRow(
        result,
        "Asignaciones",
        result.allocations?.length ?? 0,
        null
      ));
    }
    if (!demandTraces.length && result.demandFileName) addSafeRow(sheet, fallbackTraceRow(result, "Demanda"));
    if (!supplyTraces.length && result.supplyFileName) addSafeRow(sheet, fallbackTraceRow(result, "Oferta"));
  }
  for (const row of ruleRows(options)) addSafeRow(sheet, row);
  styleDataSheet(sheet, TRACE_HEADERS, 36);
  for (const header of ["Cantidad asignada", "Disponible antes", "Remanente"] as const) {
    const index = TRACE_HEADERS.indexOf(header);
    sheet.getColumn(index + 1).numFmt = "#,##0.00;[Red]-#,##0.00";
  }
  return sheet;
}

export function buildOpportunityExportWorkbook(
  results: OpportunityResult[],
  language: Language,
  options: OpportunityExportOptions = {}
) {
  const normalizedOptions: OpportunityExportOptions = {
    ...options,
    possibleMatches: options.possibleMatches ?? [],
    rejectedRows: options.rejectedRows ?? [],
    includePricing: options.includePricing === true,
    includeFinancials: options.includeFinancials === true
  };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Quiksol Opportunity Finder";
  workbook.created = options.generatedAt instanceof Date ? options.generatedAt : new Date();

  addSummarySheet(workbook, results, normalizedOptions);

  const grouped = new Map<OpportunityExportSheetName, OpportunityResult[]>();
  for (const result of results) {
    const sheetName = classifyOpportunityForExport(result);
    grouped.set(sheetName, [...(grouped.get(sheetName) ?? []), result]);
  }

  addOpportunitySheet(workbook, "Oportunidades completas", grouped.get("Oportunidades completas") ?? [], language, normalizedOptions);
  addOpportunitySheet(workbook, "Oportunidades parciales", grouped.get("Oportunidades parciales") ?? [], language, normalizedOptions);
  addOpportunitySheet(workbook, "Requiere sourcing", grouped.get("Requiere sourcing") ?? [], language, normalizedOptions);
  addOpportunitySheet(workbook, "Oferta sin demanda", grouped.get("Oferta sin demanda") ?? [], language, normalizedOptions);
  addPossibleMatchesSheet(
    workbook,
    grouped.get("Posibles matches") ?? [],
    normalizedOptions.possibleMatches ?? [],
    language
  );
  addOpportunitySheet(workbook, "Señales históricas", grouped.get("Señales históricas") ?? [], language, normalizedOptions);
  addRejectedRowsSheet(workbook, normalizedOptions.rejectedRows ?? []);
  addTraceSheet(workbook, results, normalizedOptions);

  return workbook;
}

/** Excel's hard row limit. Streaming keeps memory bounded, but cannot bypass this format limit. */
export const OPPORTUNITY_EXPORT_MAX_SHEET_ROWS = 1_048_576;

export class OpportunityExportTooLargeError extends Error {
  readonly code = "EXPORT_TOO_LARGE";

  constructor(readonly sheetName: string) {
    super(`Worksheet ${sheetName} exceeds Excel's ${OPPORTUNITY_EXPORT_MAX_SHEET_ROWS}-row limit.`);
    this.name = "OpportunityExportTooLargeError";
  }
}

export function assertOpportunityExportSheetCapacity(rowCount: number, sheetName: string) {
  if (rowCount >= OPPORTUNITY_EXPORT_MAX_SHEET_ROWS) {
    throw new OpportunityExportTooLargeError(sheetName);
  }
}

export interface OpportunityStreamingExportOptions extends OpportunityExportOptions {
  filename: string;
}

function streamingColumnWidth(header: string) {
  const textHeavy = /MPN|Fabricante|contexto|Explicación|Motivo|Acción|Advertencias|Archivo|Hoja|regla|Columnas|Valor/i
    .test(header);
  return textHeavy
    ? Math.min(Math.max(header.length + 3, 18), 38)
    : Math.min(Math.max(header.length + 3, 12), 24);
}

function styleStreamingHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  row.height = 30;
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  row.eachCell((cell) => {
    cell.border = {
      top: { style: "thin", color: { argb: BORDER_COLOR } },
      left: { style: "thin", color: { argb: BORDER_COLOR } },
      bottom: { style: "thin", color: { argb: BORDER_COLOR } },
      right: { style: "thin", color: { argb: BORDER_COLOR } }
    };
  });
}

function styleStreamingDataRow(row: ExcelJS.Row, rowHeight: number) {
  row.height = rowHeight;
  row.alignment = { vertical: "top", wrapText: true };
  row.eachCell((cell) => {
    cell.border = { bottom: { style: "hair", color: { argb: BORDER_COLOR } } };
  });
}

function assertStreamingRowCapacity(sheet: ExcelJS.Worksheet) {
  assertOpportunityExportSheetCapacity(sheet.rowCount, sheet.name);
}

function addCommittedSafeRow(
  sheet: ExcelJS.Worksheet,
  values: readonly unknown[],
  style: "header" | "data" | "none" = "data",
  rowHeight = 30
) {
  assertStreamingRowCapacity(sheet);
  const row = sheet.addRow(values.map(safeSpreadsheetValue));
  if (style === "header") styleStreamingHeader(row);
  if (style === "data") styleStreamingDataRow(row, rowHeight);
  row.commit();
  return row;
}

function configureStreamingDataSheet(
  sheet: ExcelJS.Worksheet,
  headers: readonly string[],
  rowHeight: number
) {
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(headers.length, 1) }
  };
  sheet.properties.defaultRowHeight = rowHeight;
  headers.forEach((header, index) => {
    sheet.getColumn(index + 1).width = streamingColumnWidth(header);
  });
  addCommittedSafeRow(sheet, headers, "header");
}

function applyStreamingOpportunityNumberFormats(sheet: ExcelJS.Worksheet, headers: readonly string[]) {
  const format = (header: string, numberFormat: string) => {
    const index = headers.indexOf(header);
    if (index >= 0) sheet.getColumn(index + 1).numFmt = numberFormat;
  };
  for (const header of [
    "Cantidad requerida",
    "Cantidad disponible",
    "Cantidad asignada",
    "Cantidad remanente",
    "Faltante",
    "MOQ",
    "SPQ"
  ]) format(header, "#,##0.00;[Red]-#,##0.00");
  format("Cobertura %", "0.00\"%\"");
  format("Diferencia contra target %", "0.00\"%\"");
  format("Margen bruto %", "0.00\"%\"");
  for (const header of ["Target price", "Precio de oferta", "Revenue potencial", "Costo unitario", "GP"]) {
    format(header, "#,##0.00;[Red]-#,##0.00");
  }
}

/**
 * Disk-backed XLSX writer. Rows are committed immediately and shared strings are disabled,
 * so heap usage is bounded by the current database page instead of the entire export.
 */
export class OpportunityStreamingExportWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly summarySheet: ExcelJS.Worksheet;
  private readonly completeSheet: ExcelJS.Worksheet;
  private readonly partialSheet: ExcelJS.Worksheet;
  private readonly sourcingSheet: ExcelJS.Worksheet;
  private readonly supplyOnlySheet: ExcelJS.Worksheet;
  private readonly possibleSheet: ExcelJS.Worksheet;
  private readonly historicalSheet: ExcelJS.Worksheet;
  private readonly rejectedSheet: ExcelJS.Worksheet;
  private readonly traceSheet: ExcelJS.Worksheet;
  private readonly resultHeaders: readonly string[];
  private readonly counts = new Map<OpportunityExportSheetName, number>();
  private possibleMatchCount = 0;
  private rejectedRowCount = 0;
  private resultCount = 0;
  private committed = false;

  readonly options: OpportunityStreamingExportOptions;

  constructor(readonly language: Language, options: OpportunityStreamingExportOptions) {
    this.options = {
      ...options,
      includePricing: options.includePricing === true,
      includeFinancials: options.includeFinancials === true
    };
    this.resultHeaders = opportunityHeaders(this.options);
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: options.filename,
      useSharedStrings: false,
      useStyles: true,
      zip: { zlib: { level: 6 } }
    });
    this.workbook.creator = "Quiksol Opportunity Finder";
    this.workbook.created = options.generatedAt instanceof Date ? options.generatedAt : new Date();

    // Creation order is intentional and is the contractual workbook order.
    this.summarySheet = this.workbook.addWorksheet(OPPORTUNITY_EXPORT_SHEET_NAMES[0], {
      views: [{ state: "frozen", ySplit: 3 }]
    });
    this.completeSheet = this.addOpportunityDataSheet(OPPORTUNITY_EXPORT_SHEET_NAMES[1]);
    this.partialSheet = this.addOpportunityDataSheet(OPPORTUNITY_EXPORT_SHEET_NAMES[2]);
    this.sourcingSheet = this.addOpportunityDataSheet(OPPORTUNITY_EXPORT_SHEET_NAMES[3]);
    this.supplyOnlySheet = this.addOpportunityDataSheet(OPPORTUNITY_EXPORT_SHEET_NAMES[4]);
    this.possibleSheet = this.workbook.addWorksheet(OPPORTUNITY_EXPORT_SHEET_NAMES[5], {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    configureStreamingDataSheet(this.possibleSheet, POSSIBLE_MATCH_HEADERS, 34);
    this.historicalSheet = this.addOpportunityDataSheet(OPPORTUNITY_EXPORT_SHEET_NAMES[6]);
    this.rejectedSheet = this.workbook.addWorksheet(OPPORTUNITY_EXPORT_SHEET_NAMES[7], {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    configureStreamingDataSheet(this.rejectedSheet, REJECTED_HEADERS, 32);
    this.traceSheet = this.workbook.addWorksheet(OPPORTUNITY_EXPORT_SHEET_NAMES[8], {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    for (const header of ["Cantidad asignada", "Disponible antes", "Remanente"] as const) {
      const index = TRACE_HEADERS.indexOf(header);
      this.traceSheet.getColumn(index + 1).numFmt = "#,##0.00;[Red]-#,##0.00";
    }
    configureStreamingDataSheet(this.traceSheet, TRACE_HEADERS, 36);
  }

  private addOpportunityDataSheet(name: string) {
    const sheet = this.workbook.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    applyStreamingOpportunityNumberFormats(sheet, this.resultHeaders);
    configureStreamingDataSheet(sheet, this.resultHeaders, 34);
    return sheet;
  }

  private resultSheet(name: OpportunityExportSheetName) {
    if (name === OPPORTUNITY_EXPORT_SHEET_NAMES[1]) return this.completeSheet;
    if (name === OPPORTUNITY_EXPORT_SHEET_NAMES[2]) return this.partialSheet;
    if (name === OPPORTUNITY_EXPORT_SHEET_NAMES[3]) return this.sourcingSheet;
    if (name === OPPORTUNITY_EXPORT_SHEET_NAMES[4]) return this.supplyOnlySheet;
    if (name === OPPORTUNITY_EXPORT_SHEET_NAMES[6]) return this.historicalSheet;
    return null;
  }

  private addReviewResult(result: OpportunityResult) {
    addCommittedSafeRow(this.possibleSheet, [
      "Resultado en revisión",
      result.id ?? null,
      result.candidateId ?? null,
      result.demandMpnOriginal ?? result.displayMpn,
      result.supplyMpnOriginal ?? null,
      result.normalizedMpn,
      null,
      null,
      result.manufacturer,
      null,
      result.matchTier ?? null,
      result.confidence ?? null,
      result.matchExplanation ?? null,
      localizedLabel(opportunityReasonLabel(this.language, result.reasonCode), result.reasonCode),
      result.reviewStatus ?? null,
      result.demandFileName,
      result.demandSheetName,
      result.demandTraces?.[0]?.sourceRow ?? null,
      result.supplyFileName,
      result.supplySheetName,
      result.supplyTraces?.[0]?.sourceRow ?? null
    ], "data", 34);
  }

  private addResultTraces(result: OpportunityResult) {
    const demandTraces = result.demandTraces ?? [];
    const supplyTraces = result.supplyTraces ?? [];
    for (const trace of demandTraces) {
      addCommittedSafeRow(this.traceSheet, sourceTraceRow(result, "Demanda", trace), "data", 36);
    }
    for (const trace of supplyTraces) {
      addCommittedSafeRow(this.traceSheet, sourceTraceRow(result, "Oferta", trace), "data", 36);
    }
    for (const allocation of result.allocations ?? []) {
      addCommittedSafeRow(
        this.traceSheet,
        sourceTraceRow(result, "Asignación", allocation.supply, allocation),
        "data",
        36
      );
    }
    if (result.demandTracePreviewTruncated) {
      addCommittedSafeRow(this.traceSheet, previewTraceNoticeRow(
        result,
        "Demanda",
        demandTraces.length,
        result.demandSourceRows
      ), "data", 36);
    }
    if (result.supplyTracePreviewTruncated) {
      addCommittedSafeRow(this.traceSheet, previewTraceNoticeRow(
        result,
        "Oferta",
        supplyTraces.length,
        result.supplySourceRows
      ), "data", 36);
    }
    if (result.allocationTracePreviewTruncated) {
      addCommittedSafeRow(this.traceSheet, previewTraceNoticeRow(
        result,
        "Asignaciones",
        result.allocations?.length ?? 0,
        null
      ), "data", 36);
    }
    if (!demandTraces.length && result.demandFileName) {
      addCommittedSafeRow(this.traceSheet, fallbackTraceRow(result, "Demanda"), "data", 36);
    }
    if (!supplyTraces.length && result.supplyFileName) {
      addCommittedSafeRow(this.traceSheet, fallbackTraceRow(result, "Oferta"), "data", 36);
    }
  }

  addResults(results: readonly OpportunityResult[]) {
    if (this.committed) throw new Error("Opportunity export writer has already been committed.");
    for (const result of results) {
      const sheetName = classifyOpportunityForExport(result);
      this.resultCount += 1;
      this.counts.set(sheetName, (this.counts.get(sheetName) ?? 0) + 1);
      const sheet = this.resultSheet(sheetName);
      if (sheet) {
        addCommittedSafeRow(
          sheet,
          opportunityDetailRow(result, this.language, this.options),
          "data",
          34
        );
      } else {
        this.addReviewResult(result);
      }
      this.addResultTraces(result);
    }
  }

  addPossibleMatches(matches: readonly PossibleOpportunityMatch[]) {
    if (this.committed) throw new Error("Opportunity export writer has already been committed.");
    for (const match of matches) {
      const matchWithExplanation = match as PossibleOpportunityMatch & {
        matchExplanation?: string | null;
        explanation?: string | null;
      };
      this.possibleMatchCount += 1;
      addCommittedSafeRow(this.possibleSheet, [
        "Variante candidata",
        null,
        match.id ?? null,
        match.demandDisplayMpn,
        match.supplyDisplayMpn,
        match.demandNormalizedMpn,
        match.supplyNormalizedMpn,
        match.reviewKey,
        null,
        match.manufacturerCompatible ?? null,
        match.matchTier ?? "search_mpn_mfg",
        match.confidence ?? "review",
        matchWithExplanation.matchExplanation ?? matchWithExplanation.explanation ?? null,
        match.reasonCode,
        match.reviewStatus ?? "pending",
        match.demandTrace?.fileName ?? match.demandFileId,
        match.demandTrace?.sheetName ?? null,
        match.demandTrace?.sourceRow ?? null,
        match.supplyTrace?.fileName ?? match.supplyFileId,
        match.supplyTrace?.sheetName ?? null,
        match.supplyTrace?.sourceRow ?? null
      ], "data", 34);
    }
  }

  addRejectedRows(rows: readonly OpportunityRejectedRow[]) {
    if (this.committed) throw new Error("Opportunity export writer has already been committed.");
    for (const row of rows) {
      this.rejectedRowCount += 1;
      addCommittedSafeRow(this.rejectedSheet, [
        row.fileName,
        row.side,
        row.sheetName,
        row.sourceRow,
        row.hidden,
        row.reasonCode,
        row.fieldName,
        row.sourceColumn,
        row.safeRawValue
      ], "data", 32);
    }
  }

  private writeSummary() {
    this.summarySheet.getColumn(1).width = 28;
    this.summarySheet.getColumn(2).width = 16;
    this.summarySheet.getColumn(3).width = 62;
    this.summarySheet.mergeCells("A1:C1");
    const titleRow = this.summarySheet.getRow(1);
    const title = titleRow.getCell(1);
    title.value = safeSpreadsheetValue("Opportunity Finder — Resumen de exportación");
    title.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TITLE_FILL } };
    title.alignment = { vertical: "middle", horizontal: "left" };
    titleRow.height = 34;
    titleRow.commit();
    addCommittedSafeRow(this.summarySheet, [], "none");

    const summaryRecord = (this.options.summary ?? {}) as Record<string, unknown>;
    const numericSummary = (key: string) => {
      const value = Number(summaryRecord[key]);
      return Number.isFinite(value) ? value : null;
    };
    const rows = [
      ["Métrica", "Valor", "Descripción"],
      ["Resultados exportados", this.resultCount, "Resultados incluidos en este archivo."],
      ["Oportunidades completas", this.counts.get(OPPORTUNITY_EXPORT_SHEET_NAMES[1]) ?? 0, "Cobertura completa con disponibilidad utilizable."],
      ["Oportunidades parciales", this.counts.get(OPPORTUNITY_EXPORT_SHEET_NAMES[2]) ?? 0, "Existe asignación, pero no cubre toda la demanda."],
      ["Requiere sourcing", this.counts.get(OPPORTUNITY_EXPORT_SHEET_NAMES[3]) ?? 0, "Demanda sin disponibilidad utilizable suficiente."],
      ["Oferta sin demanda", this.counts.get(OPPORTUNITY_EXPORT_SHEET_NAMES[4]) ?? 0, "Oferta o inventario sin demanda detectada."],
      ["Posibles matches", (this.counts.get(OPPORTUNITY_EXPORT_SHEET_NAMES[5]) ?? 0) + this.possibleMatchCount, "Candidatos que requieren revisión humana."],
      ["Señales históricas", this.counts.get(OPPORTUNITY_EXPORT_SHEET_NAMES[6]) ?? 0, "Coincidencias históricas; no representan stock actual."],
      ["Filas rechazadas", this.rejectedRowCount || numericSummary("rejectedRows") || 0, "Filas no incorporadas al modelo canónico."],
      ["MPN analizados", numericSummary("analyzedMpns"), "MPN únicos analizados por el motor."],
      ["Eventos de demanda", numericSummary("demandEvents"), "Eventos de demanda sin duplicar cantidades por alternativa."],
      ["Opciones de MPN", numericSummary("demandPartOptions"), "Opciones o alternativos asociados a eventos de demanda."],
      ["Lotes de oferta", numericSummary("supplyLots"), "Lotes independientes disponibles para asignación."]
    ] as const;
    rows.forEach((row, index) => {
      addCommittedSafeRow(
        this.summarySheet,
        row,
        index === 0 ? "header" : "data",
        index === 0 ? 30 : 26
      );
    });

    addCommittedSafeRow(this.summarySheet, [], "none");
    addCommittedSafeRow(this.summarySheet, ["Metadato", "Valor", ""], "header");
    addCommittedSafeRow(this.summarySheet, ["Job", this.options.jobId ?? null, ""]);
    addCommittedSafeRow(this.summarySheet, ["Versión de pipeline", this.options.pipelineVersion ?? null, ""]);
    addCommittedSafeRow(this.summarySheet, ["Modo de comparación", this.options.comparisonMode === "single_file" ? "Un archivo vs Base QuikSol" : "Dos archivos", ""]);
    addCommittedSafeRow(this.summarySheet, ["Rol detectado", this.options.uploadedRole ?? null, ""]);
    addCommittedSafeRow(this.summarySheet, ["Entidades existentes consideradas", this.options.existingEntityCount ?? 0, ""]);
    addCommittedSafeRow(this.summarySheet, ["Snapshot / versión", this.options.datasetVersion ?? null, ""]);
    addCommittedSafeRow(this.summarySheet, ["Fecha de análisis", this.options.analyzedAt instanceof Date
      ? this.options.analyzedAt.toISOString()
      : this.options.analyzedAt ?? this.options.generatedAt ?? new Date().toISOString(), ""]);
    addCommittedSafeRow(this.summarySheet, [
      "Generado en",
      this.options.generatedAt instanceof Date
        ? this.options.generatedAt.toISOString()
        : this.options.generatedAt ?? new Date().toISOString(),
      ""
    ]);
    addCommittedSafeRow(this.summarySheet, ["Precios incluidos", this.options.includePricing ? "Sí" : "No", ""]);
    addCommittedSafeRow(this.summarySheet, [
      "Costos, GP y margen incluidos",
      this.options.includeFinancials ? "Sí" : "No",
      ""
    ]);
  }

  async commit() {
    if (this.committed) throw new Error("Opportunity export writer has already been committed.");
    this.committed = true;
    this.writeSummary();
    for (const row of ruleRows(this.options)) {
      addCommittedSafeRow(this.traceSheet, row, "data", 36);
    }
    for (const sheet of [
      this.summarySheet,
      this.completeSheet,
      this.partialSheet,
      this.sourcingSheet,
      this.supplyOnlySheet,
      this.possibleSheet,
      this.historicalSheet,
      this.rejectedSheet,
      this.traceSheet
    ]) sheet.commit();
    await this.workbook.commit();
    const outputStream = (this.workbook as unknown as {
      stream?: NodeJS.EventEmitter & { closed?: boolean };
    }).stream;
    if (outputStream && outputStream.closed !== true) {
      await once(outputStream, "close");
    }
    return {
      resultCount: this.resultCount,
      possibleMatchCount: this.possibleMatchCount,
      rejectedRowCount: this.rejectedRowCount,
      sheetCount: OPPORTUNITY_EXPORT_SHEET_NAMES.length
    };
  }

  abort() {
    const internals = (this.workbook as unknown as {
      stream?: { destroy?: (error?: Error) => void };
      zip?: { abort?: () => void };
    });
    internals.zip?.abort?.();
    internals.stream?.destroy?.();
  }
}
