import type { AiToolResult } from "@/lib/ai/database-tools";
import type { AssistantLanguage } from "@/lib/ai/language-detection";

type CopyKey =
  | "noData"
  | "permission"
  | "safeFallback"
  | "timeout"
  | "rateLimit"
  | "malformed"
  | "inactive"
  | "providerFailed"
  | "providerMissing";

const COPY: Record<AssistantLanguage, Record<CopyKey, string>> = {
  es: {
    noData: "No encontré información autorizada suficiente para responder.",
    permission: "No tienes permiso para ver esa información.",
    safeFallback: "No pude obtener todos los detalles, pero conservo el resumen seguro disponible.",
    timeout: "La operación tardó demasiado. Intenta una pregunta más específica.",
    rateLimit: "Alcanzaste temporalmente el límite de consultas. Inténtalo de nuevo más tarde.",
    malformed: "La solicitud no tiene un formato válido.",
    inactive: "Tu perfil no está activo o no tiene permiso para usar el asistente.",
    providerFailed: "El proveedor externo no pudo completar la operación.",
    providerMissing: "El proveedor externo no está configurado."
  },
  en: {
    noData: "I did not find enough authorized information to answer.",
    permission: "You do not have permission to view that information.",
    safeFallback: "I could not retrieve every detail, but the available safe summary is preserved.",
    timeout: "The operation took too long. Try a more specific question.",
    rateLimit: "You have temporarily reached the query limit. Try again later.",
    malformed: "The request format is invalid.",
    inactive: "Your profile is inactive or does not have permission to use the assistant.",
    providerFailed: "The external provider could not complete the operation.",
    providerMissing: "The external provider is not configured."
  },
  zh: {
    noData: "未找到足够的授权信息来回答。",
    permission: "你无权查看该信息。",
    safeFallback: "目前无法获取全部细节，但已保留可用的安全摘要。",
    timeout: "操作超时。请尝试更具体的问题。",
    rateLimit: "你暂时已达到查询上限，请稍后重试。",
    malformed: "请求格式无效。",
    inactive: "你的个人资料未启用，或无权使用助手。",
    providerFailed: "外部服务提供商未能完成操作。",
    providerMissing: "外部服务提供商尚未配置。"
  }
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function count(value: unknown, key: string) {
  const number = Number(record(value)[key] ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function assistantMessage(language: AssistantLanguage, key: CopyKey) {
  return COPY[language][key];
}

export function localizeToolSummary(toolResult: AiToolResult, language: AssistantLanguage) {
  const data = record(toolResult.data);
  const totals = record(data.totals);
  const total = Number(toolResult.total ?? toolResult.rows?.length ?? 0);

  if (toolResult.tool === "sensitiveDataPermissionDenied") {
    if (language === "zh") return "助手不会显示成本、价格、毛利、利润率、佣金或采购订单。";
    if (language === "es") return "No tengo permiso para mostrar costos, precios o margen en esta vista.";
    return "The assistant does not expose costs, prices, gross profit, margins, commissions, or purchase orders.";
  }
  if (toolResult.tool === "policySafetyBoundary") {
    if (language === "zh") return "安全规则、权限和工具由服务器控制，问题或文件内容无法更改这些规则。";
    if (language === "es") return "Las reglas de seguridad, permisos y herramientas son controladas por el servidor y no pueden cambiarse desde una pregunta o un archivo.";
    return "Security rules, permissions, and tools are controlled by the server and cannot be changed by a question or file content.";
  }
  if (toolResult.tool === "getAssistantHelp") {
    if (language === "zh") return "我可以查询库存、缺货、授权上传、导入错误以及已保存的商机查找结果。我不能显示财务信息、执行 SQL 或更改权限。";
    if (language === "es") return "Puedo consultar stock, faltantes, cargas autorizadas, errores de importación y resultados persistidos del Buscador de oportunidades. No puedo mostrar información financiera, ejecutar SQL ni cambiar permisos.";
    return "I can query stock, shortages, authorized uploads, import errors, and persisted Opportunity Finder results. I cannot expose financial data, run SQL, or change permissions.";
  }
  if (toolResult.tool === "getOpportunityFinderHelp") {
    if (language === "zh") return "精确 MPN 表示零件编号相同；可用库存表示库存可分配；精确数量表示可用量等于需求量。完整销售覆盖全部需求，部分销售只覆盖一部分。";
    if (language === "es") return "MPN exacto indica que la referencia coincide; disponibilidad utilizable indica inventario asignable; cantidad exacta indica que la disponibilidad es igual a la demanda. Una venta completa cubre toda la demanda y una parcial solo una parte.";
    return "Exact MPN means the part number matches; usable availability means stock can be allocated; exact quantity means available quantity equals demand. A full sale covers all demand, while a partial sale covers only part.";
  }
  if (toolResult.tool === "clarificationRequired") {
    if (language === "zh") return "请求可能对应多个操作，请说明你要查询的具体内容。";
    if (language === "es") return "La solicitud puede corresponder a varias acciones; aclara qué información deseas consultar.";
    return "The request may match more than one action; clarify the information you want to query.";
  }
  if (toolResult.tool === "getOpportunityFinderSummary") {
    const exact = count(totals, "exactMatches");
    const usable = count(totals, "usableAvailabilityMatches");
    const exactQty = count(totals, "exactQuantityMatches");
    const full = count(totals, "fullSales");
    const partial = count(totals, "partialSales");
    const sourcing = count(totals, "sourcingNeeded");
    const supplyOnly = count(totals, "supplyWithoutDemand");
    const review = count(totals, "reviewRequired");
    const invalid = count(totals, "invalidQuantityRows");
    if (language === "zh") return `商机查找结果：${exact} 个精确 MPN，${usable} 个可用库存，${exactQty} 个精确数量，${full} 个完整销售，${partial} 个部分销售，${sourcing} 个需要采购，${supplyOnly} 个无需求库存，${review} 个需要审核，${invalid} 个无效数量。`;
    if (language === "es") return `Buscador de oportunidades: ${exact} MPN exactos, ${usable} con disponibilidad utilizable, ${exactQty} con cantidad exacta, ${full} ventas completas, ${partial} ventas parciales, ${sourcing} con sourcing requerido, ${supplyOnly} inventario sin demanda, ${review} en revisión y ${invalid} cantidad inválida.`;
    return `Opportunity Finder: ${exact} exact MPNs, ${usable} with usable availability, ${exactQty} exact quantities, ${full} full sales, ${partial} partial sales, ${sourcing} requiring sourcing, ${supplyOnly} supply without demand, ${review} requiring review, and ${invalid} invalid quantity.`;
  }

  if (toolResult.tool === "getStockNeedsSummary") {
    const available = count(totals, "inStock") + count(totals, "overstock");
    const partial = count(totals, "partialStock");
    const shortage = count(totals, "noStock");
    if (language === "zh") return `授权库存摘要：${available} 个零件有可用库存，${partial} 个为部分库存，${shortage} 个无库存。`;
    if (language === "es") return `Resumen de stock autorizado: ${available} partes con stock disponible, ${partial} con stock parcial y ${shortage} sin stock.`;
    return `Authorized stock summary: ${available} parts have available stock, ${partial} have partial stock, and ${shortage} have no stock.`;
  }
  if (toolResult.tool === "getOpportunitiesSummary") {
    const opportunityTotal = count(totals, "totalOpportunities");
    if (language === "zh") return `历史汇总中有 ${opportunityTotal} 个授权商机。此结果不属于当前的商机查找比较。`;
    if (language === "es") return `El agregado histórico contiene ${opportunityTotal} oportunidades autorizadas y es independiente de la comparación actual del Buscador de oportunidades.`;
    return `The historical aggregate contains ${opportunityTotal} authorized opportunities. This is separate from the current Opportunity Finder comparison.`;
  }
  if (toolResult.tool === "getLatestUpload") {
    const upload = record(toolResult.data);
    const rows = Number(upload.successful_rows ?? upload.valid_rows ?? upload.total_rows ?? 0);
    const status = String(upload.status ?? "unknown").slice(0, 40);
    if (language === "zh") return `最近一次授权上传已处理 ${rows} 行，状态为 ${status}。`;
    if (language === "es") return `La carga autorizada más reciente procesó ${rows} filas y tiene estado ${status}.`;
    return `The latest authorized upload processed ${rows} rows and has status ${status}.`;
  }
  if (toolResult.tool === "getUploadPresentationSummary") {
    const uploads = Array.isArray(data.uploads) ? data.uploads.length : 0;
    if (language === "zh") return `已找到 ${uploads} 个可见上传的安全结构摘要。`;
    if (language === "es") return `Hay un resumen estructural seguro para ${uploads} carga${uploads === 1 ? "" : "s"} visible${uploads === 1 ? "" : "s"}.`;
    return `A safe structural summary is available for ${uploads} visible upload${uploads === 1 ? "" : "s"}.`;
  }
  if (toolResult.tool === "getImportErrors") {
    if (language === "zh") return `查询中有 ${total} 个可见导入错误；原始单元格内容已排除。`;
    if (language === "es") return `La consulta contiene ${total} errores de importación visibles; se excluyó el contenido original de las celdas.`;
    return `The query contains ${total} visible import errors; raw cell content is excluded.`;
  }
  if (toolResult.tool === "getDashboardSummary") {
    const records = count(data, "totalRecords");
    const uploads = count(data, "totalUploads");
    const errors = count(data, "recordsWithErrors");
    if (language === "zh") return `授权摘要：${records} 条记录、${uploads} 次上传、${errors} 条错误记录。`;
    if (language === "es") return `Resumen autorizado: ${records} registros, ${uploads} cargas y ${errors} registros con errores.`;
    return `Authorized summary: ${records} records, ${uploads} uploads, and ${errors} records with errors.`;
  }
  if (toolResult.tool === "getMissingMpnRecords") {
    if (language === "zh") return `有 ${total} 条可见记录缺少 MPN。`;
    if (language === "es") return `Hay ${total} registros visibles sin MPN.`;
    return `${total} visible records are missing an MPN.`;
  }
  if (toolResult.tool === "getRecordsByMpn") {
    if (language === "zh") return `找到 ${total} 条授权的 MPN 记录。`;
    if (language === "es") return `Se encontraron ${total} registros de MPN autorizados.`;
    return `Found ${total} authorized MPN records.`;
  }
  if (toolResult.tool === "getUploadsByUser" || toolResult.tool === "getEmployeeSummary") {
    if (language === "zh") return `找到 ${total} 次授权上传。`;
    if (language === "es") return `Se encontraron ${total} cargas autorizadas.`;
    return `Found ${total} authorized uploads.`;
  }
  if (toolResult.tool === "searchBusinessRecords") {
    if (language === "zh") return `找到 ${total} 条授权记录。`;
    if (language === "es") return `Se encontraron ${total} registros autorizados.`;
    return `Found ${total} authorized records.`;
  }
  if (toolResult.tool === "getMpnPriceComparison" || toolResult.tool === "getLowGpRecords") {
    return assistantMessage(language, "permission");
  }
  return assistantMessage(language, "noData");
}
