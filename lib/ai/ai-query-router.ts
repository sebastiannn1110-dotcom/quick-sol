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
  getUploadsByUser,
  searchBusinessRecords,
  type AiToolResult
} from "@/lib/ai/database-tools";

export interface AiRouterResult {
  permissionDenied: boolean;
  toolResult: AiToolResult | null;
}

function normalized(question: string) {
  return question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function extractMpn(question: string) {
  const explicit = question.match(/(?:mpn|part number|p\/n)\s*(?:es|:|=|de)?\s*([A-Za-z0-9._/-]{3,80})/i)?.[1];
  if (explicit) return explicit;
  const candidates = question.match(/\b[A-Z0-9][A-Z0-9._/-]{4,30}\b/g);
  return candidates?.find((value) => /\d/.test(value)) ?? "";
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

  let toolResult: AiToolResult;
  const mpn = extractMpn(question);
  if (/mejor precio|best price|compare|comparar|比较|价格/.test(text) && mpn) toolResult = await getMpnPriceComparison(context, mpn);
  else if (/gp/.test(text) && /menor|bajo|debajo|less|low|低/.test(text)) toolResult = await getLowGpRecords(context, extractThreshold(question));
  else if (/sin mpn|missing mpn|falta.*mpn|缺少.*mpn/.test(text)) toolResult = await getMissingMpnRecords(context);
  else if (/mpn|part number|p\/n/.test(text) && mpn) toolResult = await getRecordsByMpn(context, mpn);
  else if (/ultimo|ultima|last|recent|reciente|最新/.test(text) && /excel|upload|carga|archivo|文件/.test(text)) toolResult = await getLatestUpload(context);
  else if (/que subio|cargas de|uploads? (?:de|from)|employee|empleado|员工/.test(text)) toolResult = await getUploadsByUser(context, extractPerson(question));
  else if (/error|problema|fallo|commission|comision|错误|佣金/.test(text)) toolResult = await getImportErrors(context);
  else if (/resumen|summary|dashboard|panel|cuantos|cuantas|总览|汇总/.test(text)) toolResult = await getDashboardSummary(context);
  else if (/empleado|employee|usuario|员工/.test(text)) toolResult = await getEmployeeSummary(context, extractPerson(question));
  else toolResult = await searchBusinessRecords(context, question);

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
    metadata: { question: question.slice(0, 500), tool: toolResult.tool, summary: toolResult.summary, empty: toolResult.empty }
  });

  return { permissionDenied: false, toolResult };
}
