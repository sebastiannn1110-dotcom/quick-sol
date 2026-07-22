import type { AuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { canRequestCompanyWideData, questionRequestsCompanyWideData } from "@/lib/ai/ai-permissions";
import {
  getDashboardSummary,
  getEmployeeSummary,
  getImportErrors,
  getLatestUpload,
  getLowGpRecords,
  getMissingMpnRecords,
  getMpnPriceComparison,
  getRecordsByMpn,
  getSensitiveDataPermissionDenied,
  getStockNeedsSummary,
  getUploadPresentationSummary,
  getUploadsByUser,
  searchBusinessRecords,
  type AiToolResult
} from "@/lib/ai/database-tools";
import { canViewCosts, canViewGp, canViewSensitivePricing, questionRequestsSensitiveCommercialData } from "@/lib/security/permissions";

export interface AiRouterResult {
  permissionDenied: boolean;
  toolResult: AiToolResult | null;
}

function normalized(question: string) {
  return question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function cleanMpnCandidate(value: string | undefined) {
  const candidate = value?.replace(/[.,;:!?]+$/g, "").trim() ?? "";
  if (!candidate) return "";
  const text = normalized(candidate);
  const stopWords = new Set([
    "tiene",
    "tienen",
    "tenemos",
    "tengo",
    "hay",
    "falta",
    "faltan",
    "faltante",
    "faltantes",
    "stock",
    "para",
    "este",
    "esta",
    "estos",
    "estas",
    "referencia",
    "referencias",
    "parte",
    "partes",
    "necesita",
    "necesitan",
    "disponible",
    "disponibles"
  ]);
  if (stopWords.has(text)) return "";
  if (!(/\d|[._/-]|[A-Z]{2,}/.test(candidate))) return "";
  return candidate;
}

function extractMpn(question: string) {
  const explicit = question.match(/(?:mpn|part number|p\/n)\s*(?:es|:|=|de)?\s*([A-Za-z0-9._/-]{3,80})/i)?.[1];
  const cleanExplicit = cleanMpnCandidate(explicit);
  if (cleanExplicit) return cleanExplicit;
  const candidates = question.match(/\b[A-Z0-9][A-Z0-9._/-]{4,30}\b/g);
  return candidates?.map(cleanMpnCandidate).find((value) => /\d/.test(value)) ?? "";
}

function extractThreshold(question: string) {
  const match = question.match(/(?:menor|debajo|less than|below)\s+(?:al?\s*)?(\d+(?:[.,]\d+)?)\s*%?/i);
  if (!match) return 0.15;
  const value = Number(match[1].replace(",", "."));
  return value > 1 ? value / 100 : value;
}

function extractPerson(question: string) {
  return question.match(/(?:subio|subio el|empleado|employee|de|from)\s+([\p{L}][\p{L}\s]{1,50})/iu)?.[1]?.trim() ?? question;
}

function isUploadPresentationQuestion(text: string) {
  return (
    /ultim[oa]s?.*(archivo|upload|carga)/.test(text) ||
    /(archivo|upload|carga).*(columna|plantilla|template|formato|tipo mezclado|tipos mezclados|campo|detectaste)/.test(text) ||
    /(campo|detectaste).*(mpn|proveedor|cliente|cantidad|precio|costo|fecha|estado)/.test(text) ||
    /(problema|problemas).*(formato|detectaste)|formato.*detectaste/.test(text) ||
    /tipos? mezclados|columnas.*tipos?/.test(text) ||
    /(plantilla|template).*(inventario|pricing|logistica|cotizacion|general|archivo|upload|carga)/.test(text) ||
    /(mpn|proveedor|cliente|cantidad|precio|costo|fecha|estado).*(archivo|detectaste|campo)/.test(text) ||
    /quien.*subio.*(archivo|upload|carga)/.test(text) ||
    /que puedo preguntarte.*(archivo|upload|carga)/.test(text)
  );
}

function isStockNeedsQuestion(text: string) {
  return (
    /(referencia|referencias|ref|refs).*(stock|inventario|falta|faltante|parcial|disponible)/.test(text) ||
    /(stock|inventario).*(mpn|item|parte|part|cliente|necesita|necesidad|falta|parcial|disponible)/.test(text) ||
    /(mpn|item|parte|part|referencia|referencias).*(stock|inventario|falta|faltante|parcial|disponible)/.test(text) ||
    /(cliente|customer).*(necesita|necesidad|demand|needs?)/.test(text) ||
    /(falta de stock|faltante de stock|sin stock|no tienen stock|no tiene stock|no stock|stock parcial|partial stock)/.test(text) ||
    /(archivo|archivos).*(inventario|necesidades del cliente|stock disponible)/.test(text)
  );
}

function isRestrictedSensitiveQuestion(question: string, role: AuthContext["profile"]["role"]) {
  if (!questionRequestsSensitiveCommercialData(question)) return false;
  return !canViewCosts(role) || !canViewSensitivePricing(role) || !canViewGp(role);
}

async function logToolCompleted(context: AuthContext, startedAt: number, question: string, toolResult: AiToolResult) {
  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "ai",
    action: "ai_database_tool_completed",
    message: "Controlled AI database tool completed.",
    status: "completed",
    durationMs: Math.round(performance.now() - startedAt),
    metadata: { question: question.slice(0, 500), tool: toolResult.tool, scope: toolResult.scope, summary: toolResult.summary, empty: toolResult.empty }
  });
}

export async function routeAssistantDatabaseQuery(context: AuthContext, question: string): Promise<AiRouterResult> {
  const startedAt = performance.now();
  const text = normalized(question);
  if (questionRequestsCompanyWideData(question) && !canRequestCompanyWideData(context.profile.role)) {
    await logger.security({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "ai",
      action: "ai_company_scope_denied",
      message: "AI company-wide query was denied.",
      status: "failed"
    });
    return { permissionDenied: true, toolResult: null };
  }

  if (isRestrictedSensitiveQuestion(question, context.profile.role)) {
    const toolResult = getSensitiveDataPermissionDenied(context);
    await logToolCompleted(context, startedAt, question, toolResult);
    return { permissionDenied: false, toolResult };
  }

  if (isStockNeedsQuestion(text)) {
    const toolResult = await getStockNeedsSummary(context, question, extractMpn(question));
    await logToolCompleted(context, startedAt, question, toolResult);
    return { permissionDenied: false, toolResult };
  }

  if (isUploadPresentationQuestion(text)) {
    const toolResult = await getUploadPresentationSummary(context, question);
    await logToolCompleted(context, startedAt, question, toolResult);
    return { permissionDenied: false, toolResult };
  }

  let toolResult: AiToolResult;
  const mpn = extractMpn(question);
  if (/mejor precio|best price|compare|comparar/.test(text) && mpn) toolResult = await getMpnPriceComparison(context, mpn);
  else if (/gp/.test(text) && /menor|bajo|debajo|less|low/.test(text)) toolResult = await getLowGpRecords(context, extractThreshold(question));
  else if (/sin mpn|missing mpn|falta.*mpn/.test(text)) toolResult = await getMissingMpnRecords(context);
  else if (/mpn|part number|p\/n/.test(text) && mpn) toolResult = await getRecordsByMpn(context, mpn);
  else if (/ultimo|ultima|last|recent|reciente/.test(text) && /excel|upload|carga|archivo/.test(text)) toolResult = await getLatestUpload(context);
  else if (/que subio|cargas de|uploads? (?:de|from)|employee|empleado/.test(text)) toolResult = await getUploadsByUser(context, extractPerson(question));
  else if (/error|problema|fallo|commission|comision/.test(text)) toolResult = await getImportErrors(context);
  else if (/resumen|summary|dashboard|panel|cuantos|cuantas/.test(text)) toolResult = await getDashboardSummary(context);
  else if (/empleado|employee|usuario/.test(text)) toolResult = await getEmployeeSummary(context, extractPerson(question));
  else toolResult = await searchBusinessRecords(context, question);

  await logToolCompleted(context, startedAt, question, toolResult);
  return { permissionDenied: false, toolResult };
}
