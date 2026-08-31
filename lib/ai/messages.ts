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
  | "metricsUnavailable"
  | "rfqUnavailable"
  | "clientUnavailable"
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
    metricsUnavailable: "No pude consultar las métricas en este momento.",
    rfqUnavailable: "No pude consultar los RFQs en este momento.",
    clientUnavailable: "No pude consultar los clientes en este momento.",
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
    metricsUnavailable: "I could not query the metrics right now.",
    rfqUnavailable: "I could not query RFQs right now.",
    clientUnavailable: "I could not query clients right now.",
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
    metricsUnavailable: "目前无法查询绩效指标。",
    rfqUnavailable: "目前无法查询 RFQ。",
    clientUnavailable: "目前无法查询客户数据。",
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

function safeText(value: unknown, max = 160) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function localizedUploadStatus(value: unknown, language: AssistantLanguage) {
  const status = safeText(value, 40);
  const labels: Record<string, Record<AssistantLanguage, string>> = {
    pending: { es: "pendiente", en: "pending", zh: "\u5f85\u5904\u7406" },
    pending_upload: { es: "pendiente de carga", en: "pending upload", zh: "\u5f85\u4e0a\u4f20" },
    uploading: { es: "cargando", en: "uploading", zh: "\u4e0a\u4f20\u4e2d" },
    uploaded: { es: "cargado", en: "uploaded", zh: "\u5df2\u4e0a\u4f20" },
    queued: { es: "en cola", en: "queued", zh: "\u5df2\u6392\u961f" },
    retrying: { es: "reintentando", en: "retrying", zh: "\u91cd\u8bd5\u4e2d" },
    processing: { es: "procesando", en: "processing", zh: "\u5904\u7406\u4e2d" },
    completed: { es: "completado", en: "completed", zh: "\u5df2\u5b8c\u6210" },
    completed_with_warnings: {
      es: "completado con advertencias",
      en: "completed with warnings",
      zh: "\u5df2\u5b8c\u6210\uff0c\u4f46\u6709\u8b66\u544a"
    },
    failed: { es: "fallido", en: "failed", zh: "\u5931\u8d25" },
    cancelled: { es: "cancelado", en: "cancelled", zh: "\u5df2\u53d6\u6d88" }
  };
  return labels[status]?.[language] ?? status.replace(/_/g, " ");
}

function localizedUploadDate(value: unknown, language: AssistantLanguage) {
  const raw = safeText(value, 40);
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.getTime())) return "";
  const locale = language === "es" ? "es-CO" : language === "zh" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(parsed);
}

function localizedMoney(value: unknown, language: AssistantLanguage, currency = "USD") {
  const parsed = Number(value ?? 0);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  const locale = language === "es" ? "es-CO" : language === "zh" ? "zh-CN" : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    maximumFractionDigits: 2
  }).format(amount);
}

function localizedNumber(value: unknown, language: AssistantLanguage, maximumFractionDigits = 2) {
  const parsed = Number(value ?? 0);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  const locale = language === "es" ? "es-CO" : language === "zh" ? "zh-CN" : "en-US";
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(amount);
}

function employeeMetricLabel(metric: string, language: AssistantLanguage) {
  const labels: Record<string, Record<AssistantLanguage, string>> = {
    overall: {
      es: "Accepted Quote Value del ranking oficial",
      en: "Accepted Quote Value in the official ranking",
      zh: "官方排名中的已接受报价金额"
    },
    accepted_quotes: { es: "cotizaciones aceptadas", en: "accepted quotes", zh: "已接受报价" },
    conversion_rate: { es: "conversión", en: "conversion", zh: "转化率" },
    accepted_quote_value: { es: "Accepted Quote Value", en: "Accepted Quote Value", zh: "已接受报价金额" },
    sent_quotes: { es: "cotizaciones enviadas", en: "sent quotes", zh: "已发送报价" },
    created_quotes: { es: "cotizaciones creadas", en: "created quotes", zh: "已创建报价" },
    customers_served: { es: "clientes atendidos", en: "customers served", zh: "已服务客户" },
    draft_quotes: { es: "cotizaciones en draft", en: "draft quotes", zh: "草稿报价" }
  };
  return labels[metric]?.[language] ?? labels.overall[language];
}

function employeeMetricValue(
  employee: Record<string, unknown>,
  metric: string,
  language: AssistantLanguage,
  currency: string
) {
  if (metric === "conversion_rate") {
    return `${localizedNumber(employee.quoteConversionRate, language)}%`;
  }
  if (metric === "accepted_quote_value" || metric === "overall") {
    return localizedMoney(employee.acceptedQuoteValue, language, currency);
  }
  const keys: Record<string, string> = {
    accepted_quotes: "quotesAccepted",
    sent_quotes: "quotesSent",
    created_quotes: "quotesCreated",
    customers_served: "customersServed",
    draft_quotes: "draftQuotes"
  };
  return localizedNumber(employee[keys[metric] ?? "acceptedQuoteValue"], language, 0);
}

function employeeMetricEntry(
  employee: Record<string, unknown>,
  metric: string,
  language: AssistantLanguage,
  currency: string
) {
  const name = safeText(employee.name, 160);
  const value = employeeMetricValue(employee, metric, language, currency);
  const label = employeeMetricLabel(metric, language);
  if (language === "zh") return `${name} — ${label} ${value}`;
  if (language === "es") return `${name} — ${value} en ${label}`;
  return `${name} — ${value} ${label}`;
}

function employeeSupportingFacts(
  employee: Record<string, unknown>,
  language: AssistantLanguage,
  currency: string
) {
  const accepted = localizedNumber(employee.quotesAccepted, language, 0);
  const conversion = localizedNumber(employee.quoteConversionRate, language);
  const acceptedValue = localizedMoney(employee.acceptedQuoteValue, language, currency);
  if (language === "zh") {
    return `${accepted} 份已接受报价，转化率 ${conversion}%，已接受报价金额 ${acceptedValue}`;
  }
  if (language === "es") {
    return `${accepted} cotizaciones aceptadas, ${conversion}% de conversión y ${acceptedValue} en Accepted Quote Value`;
  }
  return `${accepted} accepted quotes, ${conversion}% conversion, and ${acceptedValue} in Accepted Quote Value`;
}

function employeeFilterQualifier(value: unknown, language: AssistantLanguage) {
  const filters = record(value);
  const definitions: Array<[string, Record<AssistantLanguage, string>]> = [
    ["country", { es: "país", en: "country", zh: "国家" }],
    ["region", { es: "región", en: "region", zh: "地区" }],
    ["department", { es: "departamento", en: "department", zh: "部门" }],
    ["team", { es: "equipo", en: "team", zh: "团队" }]
  ];
  const parts = definitions.flatMap(([key, labels]) => {
    const item = safeText(filters[key], 160);
    return item ? [`${labels[language]} ${item}`] : [];
  });
  if (!parts.length) return "";
  if (language === "zh") return `（${parts.join("，")}）`;
  return ` ${language === "es" ? "para" : "for"} ${parts.join(", ")}`;
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
  if (toolResult.tool === "quote_summary") {
    const quoteCount = count(data, "quoteCount");
    const statusCounts = record(data.statusCounts);
    const accepted = count(statusCounts, "accepted");
    const open = count(statusCounts, "draft") + count(statusCounts, "sent");
    const quotedValue = localizedMoney(data.quotedValue, language, String(data.currency ?? "USD"));
    const acceptedValue = localizedMoney(data.acceptedQuoteValue, language, String(data.currency ?? "USD"));
    if (language === "zh") return `\u6388\u6743\u8303\u56f4\u5185\u5171\u6709 ${quoteCount} \u4efd\u62a5\u4ef7\uff0c${open} \u4efd\u672a\u7ed3\uff0c${accepted} \u4efd\u5df2\u63a5\u53d7\u3002\u62a5\u4ef7\u603b\u989d\u4e3a ${quotedValue}\uff0c\u5df2\u63a5\u53d7\u62a5\u4ef7\u91d1\u989d\u4e3a ${acceptedValue}\u3002`;
    if (language === "es") return `En tu alcance autorizado hay ${quoteCount} cotizaciones: ${open} abiertas y ${accepted} aceptadas. El valor cotizado es ${quotedValue} y el Accepted Quote Value es ${acceptedValue}.`;
    return `Your authorized scope contains ${quoteCount} quotes: ${open} open and ${accepted} accepted. Quoted value is ${quotedValue}, and Accepted Quote Value is ${acceptedValue}.`;
  }
  if (toolResult.tool === "employee_quote_metrics") {
    const queryMode = safeText(data.queryMode, 30);
    const metric = safeText(data.sortBy, 40) || "overall";
    const currency = safeText(data.currency, 3) || "USD";
    const filterQualifier = employeeFilterQualifier(data.appliedFilters, language);
    const selected = record(data.selectedEmployee);
    const name = safeText(selected.name, 160);
    const ranking = Array.isArray(data.ranking) ? data.ranking.map(record) : [];
    const clarification = record(data.clarification);
    const clarificationMessage = safeText(clarification.message, 320);
    if (clarificationMessage) {
      const candidates = Array.isArray(clarification.candidates)
        ? clarification.candidates.map(record).map((candidate) => {
            const candidateName = safeText(candidate.name, 160);
            const details = [candidate.businessTitle, candidate.region]
              .map((item) => safeText(item, 160))
              .filter(Boolean);
            return `${candidateName}${details.length ? ` (${details.join(" · ")})` : ""}`;
          }).filter(Boolean)
        : [];
      if (!candidates.length) return clarificationMessage;
      if (language === "zh") return `${clarificationMessage} 可选项：${candidates.join("；")}。`;
      if (language === "es") return `${clarificationMessage} Opciones: ${candidates.join("; ")}.`;
      return `${clarificationMessage} Options: ${candidates.join("; ")}.`;
    }

    if (queryMode === "aggregate") {
      const activeSellers = count(data, "activeSellerCount");
      if (metric === "accepted_quotes") {
        const value = count(totals, "quotesAccepted");
        if (language === "zh") return `授权范围${filterQualifier}内共有 ${value} 份已接受报价。`;
        if (language === "es") return `En el alcance autorizado${filterQualifier} tenemos ${value} cotizaciones aceptadas.`;
        return `The authorized scope${filterQualifier} has ${value} accepted quotes.`;
      }
      if (metric === "conversion_rate") {
        const value = localizedNumber(totals.quoteConversionRate, language);
        if (language === "zh") return `授权范围${filterQualifier}内的整体报价转化率为 ${value}%。`;
        if (language === "es") return `La tasa de conversión global del alcance autorizado${filterQualifier} es ${value}%.`;
        return `The overall quote conversion rate in the authorized scope${filterQualifier} is ${value}%.`;
      }
      if (metric === "accepted_quote_value") {
        const value = localizedMoney(totals.acceptedQuoteValue, language, currency);
        if (language === "zh") return `授权范围${filterQualifier}内的已接受报价总额为 ${value}。`;
        if (language === "es") return `El Accepted Quote Value total del alcance autorizado${filterQualifier} es ${value}.`;
        return `Total Accepted Quote Value in the authorized scope${filterQualifier} is ${value}.`;
      }
      if (metric === "draft_quotes") {
        const value = count(totals, "draftQuotes");
        if (language === "zh") return `授权范围${filterQualifier}内共有 ${value} 份草稿报价。`;
        if (language === "es") return `En el alcance autorizado${filterQualifier} tenemos ${value} cotizaciones en draft.`;
        return `The authorized scope${filterQualifier} has ${value} draft quotes.`;
      }
      const aggregateCountKeys: Record<string, string> = {
        sent_quotes: "quotesSent",
        created_quotes: "quotesCreated",
        customers_served: "customersServed"
      };
      if (aggregateCountKeys[metric]) {
        const value = count(totals, aggregateCountKeys[metric]);
        const label = employeeMetricLabel(metric, language);
        if (language === "zh") return `授权范围${filterQualifier}内共有 ${value} 个${label}。`;
        if (language === "es") return `En el alcance autorizado${filterQualifier} tenemos ${value} ${label}.`;
        return `The authorized scope${filterQualifier} has ${value} ${label}.`;
      }
      const accepted = count(totals, "quotesAccepted");
      const conversion = localizedNumber(totals.quoteConversionRate, language);
      const value = localizedMoney(totals.acceptedQuoteValue, language, currency);
      if (language === "zh") return `销售团队${filterQualifier}有 ${activeSellers} 名可见活跃销售人员、${accepted} 份已接受报价，整体转化率 ${conversion}%，已接受报价金额 ${value}。`;
      if (language === "es") return `El equipo visible${filterQualifier} tiene ${activeSellers} vendedores activos, ${accepted} cotizaciones aceptadas, ${conversion}% de conversión global y ${value} en Accepted Quote Value.`;
      return `The visible team${filterQualifier} has ${activeSellers} active sellers, ${accepted} accepted quotes, ${conversion}% overall conversion, and ${value} in Accepted Quote Value.`;
    }

    if (queryMode === "comparison") {
      const comparison = record(data.comparison);
      const employees = Array.isArray(comparison.employees)
        ? comparison.employees.map(record).filter((employee) => safeText(employee.name, 160))
        : ranking;
      if (employees.length !== 2) return assistantMessage(language, "noData");
      const facts = employees.map((employee) => employeeMetricEntry(employee, metric, language, currency));
      const winner = record(comparison.winner);
      const winnerName = safeText(winner.name, 160);
      const tied = comparison.tied === true;
      if (language === "zh") return `${facts.join("；")}。${tied ? "两人在该指标上并列。" : `${winnerName} 在该指标上领先。`}`;
      if (language === "es") return `${facts.join("; ")}. ${tied ? "Ambos están empatados en esa métrica." : `${winnerName} lidera en esa métrica.`}`;
      return `${facts.join("; ")}. ${tied ? "They are tied on that metric." : `${winnerName} leads on that metric.`}`;
    }

    if (queryMode === "below_average" || queryMode === "needs_improvement") {
      const source = queryMode === "below_average" ? data.belowAverage : data.needsImprovement;
      const employees = Array.isArray(source) ? source.map(record) : ranking;
      const average = record(data.average);
      const averageValue = employeeMetricValue({
        quoteConversionRate: average.value,
        acceptedQuoteValue: average.value,
        quotesAccepted: average.value,
        quotesSent: average.value,
        quotesCreated: average.value,
        customersServed: average.value,
        draftQuotes: average.value
      }, metric, language, currency);
      if (!employees.length) {
        if (language === "zh") return "授权范围内没有符合该条件的销售人员。";
        if (language === "es") return "No hay vendedores visibles que cumplan esa condición.";
        return "No visible sellers meet that condition.";
      }
      const entries = employees.map((employee) => employeeMetricEntry(employee, metric, language, currency)).join("; ");
      if (queryMode === "below_average") {
        if (language === "zh") return `低于平均值（${averageValue}）的销售人员：${entries}。`;
        if (language === "es") return `Por debajo del promedio de ${averageValue} en ${employeeMetricLabel(metric, language)}: ${entries}.`;
        return `Below the ${averageValue} average for ${employeeMetricLabel(metric, language)}: ${entries}.`;
      }
      if (language === "zh") return `按${employeeMetricLabel(metric, language)}排序，需要改进的销售人员：${entries}。`;
      if (language === "es") return `Según ${employeeMetricLabel(metric, language)}, quienes necesitan mejorar son: ${entries}.`;
      return `Based on ${employeeMetricLabel(metric, language)}, the sellers needing improvement are: ${entries}.`;
    }

    if (queryMode === "employee") {
      if (!name) return assistantMessage(language, "noData");
      if (metric !== "overall") {
        const entry = employeeMetricEntry(selected, metric, language, currency);
        if (language === "zh") return `${entry}。`;
        return `${entry}.`;
      }
      const facts = employeeSupportingFacts(selected, language, currency);
      if (language === "zh") return `${name}：${facts}。`;
      if (language === "es") return `${name} tiene ${facts}.`;
      return `${name} has ${facts}.`;
    }

    if (!ranking.length && name) ranking.push(selected);
    if (!ranking.length) return assistantMessage(language, "noData");
    const rankStart = Math.max(1, count(data, "rankStart") || 1);
    const entries = ranking.map((employee, index) =>
      `${rankStart + index}. ${employeeMetricEntry(employee, metric, language, currency)}`
    );
    if (ranking.length > 1 || rankStart > 1) {
      const end = rankStart + ranking.length - 1;
      if (language === "zh") return `销售排名${filterQualifier}第 ${rankStart} 至 ${end} 名：\n${entries.join("\n")}`;
      if (language === "es") return `Ranking comercial${filterQualifier}, puestos ${rankStart} a ${end}:\n${entries.join("\n")}`;
      return `Sales ranking${filterQualifier}, positions ${rankStart}–${end}:\n${entries.join("\n")}`;
    }
    const leader = ranking[0];
    const leaderName = safeText(leader.name, 160);
    const facts = employeeSupportingFacts(leader, language, currency);
    if (metric === "accepted_quote_value") {
      const acceptedValue = localizedMoney(leader.acceptedQuoteValue, language, currency);
      if (language === "zh") return `${leaderName} 的已接受报价金额最高，为 ${acceptedValue}；${facts}。`;
      if (language === "es") return `${leaderName} tiene el mayor Accepted Quote Value: ${acceptedValue}. Registra ${facts}.`;
      return `${leaderName} has the highest Accepted Quote Value at ${acceptedValue}. The record contains ${facts}.`;
    }
    if (metric === "overall") {
      if (language === "zh") return `目前 ${leaderName} 位居官方销售排名${filterQualifier}第一：${facts}。`;
      if (language === "es") return `Actualmente, ${leaderName} ocupa el primer lugar del ranking comercial oficial${filterQualifier}: ${facts}.`;
      return `Currently, ${leaderName} ranks first in the official sales ranking${filterQualifier} with ${facts}.`;
    }
    const entry = employeeMetricEntry(leader, metric, language, currency);
    if (language === "zh") return `${entry}，在该指标上排名第一。`;
    if (language === "es") return `${entry}; ocupa el primer lugar en esa métrica.`;
    return `${entry}; this is the highest value for that metric.`;
  }
  if (toolResult.tool === "client_quote_summary") {
    const client = record(data.topClient);
    const name = safeText(client.name, 200);
    if (!name) return assistantMessage(language, "noData");
    const openCount = count(client, "openQuoteCount");
    const openValue = localizedMoney(client.openQuoteValue, language, String(data.currency ?? "USD"));
    if (language === "zh") return `${name} \u7684\u672a\u7ed3\u62a5\u4ef7\u91d1\u989d\u6700\u9ad8\uff0c\u5171 ${openCount} \u4efd\uff0c\u603b\u989d\u4e3a ${openValue}\u3002\u672a\u7ed3\u62a5\u4ef7\u6307\u8349\u7a3f\u6216\u5df2\u53d1\u9001\u72b6\u6001\u3002`;
    if (language === "es") return `${name} es el cliente con mayor valor de cotizaciones abiertas: ${openValue} en ${openCount} cotizaciones. Abiertas significa draft o sent.`;
    return `${name} has the highest open quote value: ${openValue} across ${openCount} quotes. Open means draft or sent.`;
  }
  if (toolResult.tool === "rfq_summary") {
    const mode = safeText(data.mode, 30);
    const rfqs = Array.isArray(data.rfqs) ? data.rfqs.map(record) : [];
    const clarification = record(data.clarification);
    const candidates = Array.isArray(clarification.candidates)
      ? clarification.candidates.map((item) => safeText(item, 160)).filter(Boolean)
      : [];
    if (candidates.length) {
      if (language === "zh") return `有多名员工符合该姓名：${candidates.join("、")}。请指定完整姓名。`;
      if (language === "es") return `Hay más de un empleado visible con ese nombre: ${candidates.join(", ")}. Indica el nombre completo.`;
      return `More than one visible employee matches that name: ${candidates.join(", ")}. Please provide the full name.`;
    }
    const rfqCount = count(data, "count");
    if (mode === "new_count") {
      if (language === "zh") return `你的授权范围内有 ${rfqCount} 个新 RFQ。这里“新”指过去 24 小时内创建、状态为未分配或已分配的 RFQ。`;
      if (language === "es") return `Hay ${rfqCount} RFQs nuevos en tu alcance autorizado. “Nuevo” significa un RFQ unassigned o assigned creado durante las últimas 24 horas.`;
      return `There are ${rfqCount} new RFQs in your authorized scope. “New” means an unassigned or assigned RFQ created during the last 24 hours.`;
    }
    const labels = rfqs.slice(0, 5).map((rfq) => {
      const externalId = safeText(rfq.externalRfqId, 160);
      const status = safeText(rfq.status, 30);
      return `${externalId}${status ? ` (${status})` : ""}`;
    }).filter(Boolean);
    if (mode === "latest") {
      const latest = rfqs[0] ?? {};
      const externalId = safeText(latest.externalRfqId, 160);
      if (!externalId) return assistantMessage(language, "noData");
      const status = safeText(latest.status, 30);
      const company = safeText(latest.companyOrName, 200);
      const createdAt = localizedUploadDate(latest.createdAt, language);
      if (language === "zh") return `最近的 RFQ 是 ${externalId}${company ? `，客户为 ${company}` : ""}，状态为 ${status}${createdAt ? `，创建于 ${createdAt}` : ""}。`;
      if (language === "es") return `El RFQ más reciente es ${externalId}${company ? ` de ${company}` : ""}, con estado ${status}${createdAt ? `, creado el ${createdAt}` : ""}.`;
      return `The most recent RFQ is ${externalId}${company ? ` for ${company}` : ""}, with status ${status}${createdAt ? `, created ${createdAt}` : ""}.`;
    }
    if (mode === "employee") {
      const employee = safeText(data.employeeName, 160);
      if (language === "zh") return `${employee || "该员工"} 在你的授权范围内有 ${rfqCount} 个 RFQ${labels.length ? `：${labels.join("、")}` : ""}。`;
      if (language === "es") return `${employee || "El empleado"} tiene ${rfqCount} RFQs en tu alcance autorizado${labels.length ? `: ${labels.join(", ")}` : "."}`;
      return `${employee || "The employee"} has ${rfqCount} RFQs in your authorized scope${labels.length ? `: ${labels.join(", ")}` : "."}`;
    }
    if (mode === "unassigned") {
      if (language === "zh") return `你的授权范围内有 ${rfqCount} 个未分配 RFQ${labels.length ? `：${labels.join("、")}` : ""}。`;
      if (language === "es") return `Hay ${rfqCount} RFQs sin asignar en tu alcance autorizado${labels.length ? `: ${labels.join(", ")}` : "."}`;
      return `There are ${rfqCount} unassigned RFQs in your authorized scope${labels.length ? `: ${labels.join(", ")}` : "."}`;
    }
    if (language === "zh") return `你的授权范围内共有 ${rfqCount} 个 RFQ${labels.length ? `：${labels.join("、")}` : ""}。`;
    if (language === "es") return `Hay ${rfqCount} RFQs en tu alcance autorizado${labels.length ? `: ${labels.join(", ")}` : "."}`;
    return `There are ${rfqCount} RFQs in your authorized scope${labels.length ? `: ${labels.join(", ")}` : "."}`;
  }
  if (toolResult.tool === "client_lookup") {
    const mode = safeText(data.mode, 30);
    const clients = Array.isArray(data.clients) ? data.clients.map(record) : [];
    const client = record(data.client);
    const clientName = safeText(client.name, 200);
    const demoDisclosure = client.isDemoAccount === true
      ? language === "es"
        ? " Es una entidad ficticia del entorno demo, sin afiliación con la marca real."
        : language === "zh"
          ? " 这是演示环境中的虚构实体，与真实品牌无关联。"
          : " This is a fictitious demo entity with no affiliation to the real brand."
      : "";
    if (mode === "count") {
      const clientCount = count(data, "count");
      if (language === "zh") return `你的授权客户列表中有 ${clientCount} 个活跃客户。`;
      if (language === "es") return `Hay ${clientCount} clientes activos en tu lista autorizada.`;
      return `There are ${clientCount} active clients in your authorized list.`;
    }
    if (mode === "search") {
      const names = clients.slice(0, 10).map((item) => safeText(item.name, 200)).filter(Boolean);
      if (!names.length) return assistantMessage(language, "noData");
      const hasDemo = clients.some((item) => item.isDemoAccount === true);
      const disclosure = hasDemo
        ? language === "es"
          ? " Las cuentas *-demo son entidades ficticias sin afiliación con las marcas reales."
          : language === "zh"
            ? " *-demo 账户是虚构实体，与真实品牌无关联。"
            : " *-demo accounts are fictitious entities with no affiliation to the real brands."
        : "";
      if (language === "zh") return `找到 ${names.length} 个授权客户：${names.join("、")}。${disclosure}`.trim();
      if (language === "es") return `Encontré ${names.length} clientes autorizados: ${names.join(", ")}.${disclosure}`;
      return `Found ${names.length} authorized clients: ${names.join(", ")}.${disclosure}`;
    }
    if (mode === "owner") {
      const seller = safeText(data.assignedSellerName, 160);
      if (language === "zh") return `${clientName} 由 ${seller || "尚未分配销售人员"} 负责。${demoDisclosure}`;
      if (language === "es") return `${clientName} está atendido por ${seller || "ningún vendedor asignado"}.${demoDisclosure}`;
      return `${clientName} is handled by ${seller || "no assigned seller"}.${demoDisclosure}`;
    }
    const activityCount = count(data, "activityCount");
    if (mode === "rfqs") {
      const rfqs = Array.isArray(data.rfqs) ? data.rfqs.map(record) : [];
      const labels = rfqs.slice(0, 5).map((rfq) => `${safeText(rfq.externalRfqId, 160)} (${safeText(rfq.status, 30)})`);
      if (language === "zh") return `${clientName} 在你的授权范围内有 ${activityCount} 个 RFQ${labels.length ? `：${labels.join("、")}` : ""}。${demoDisclosure}`;
      if (language === "es") return `${clientName} tiene ${activityCount} RFQs en tu alcance autorizado${labels.length ? `: ${labels.join(", ")}` : "."}${demoDisclosure}`;
      return `${clientName} has ${activityCount} RFQs in your authorized scope${labels.length ? `: ${labels.join(", ")}` : "."}${demoDisclosure}`;
    }
    const quotes = Array.isArray(data.quotes) ? data.quotes.map(record) : [];
    const labels = quotes.slice(0, 5).map((quote) => `${safeText(quote.number, 100)} (${safeText(quote.status, 30)})`);
    if (language === "zh") return `${clientName} 在你的授权范围内有 ${activityCount} 份报价${labels.length ? `：${labels.join("、")}` : ""}。${demoDisclosure}`;
    if (language === "es") return `${clientName} tiene ${activityCount} cotizaciones en tu alcance autorizado${labels.length ? `: ${labels.join(", ")}` : "."}${demoDisclosure}`;
    return `${clientName} has ${activityCount} quotes in your authorized scope${labels.length ? `: ${labels.join(", ")}` : "."}${demoDisclosure}`;
  }
  if (toolResult.tool === "sourcing_lookup") {
    const approvals = Array.isArray(data.approvals) ? data.approvals.map(record) : [];
    const first = approvals[0] ?? {};
    const mpn = safeText(data.mpn ?? first.mpn, 160);
    if (!mpn || !approvals.length) return assistantMessage(language, "noData");
    const price = localizedMoney(first.authorizedUnitPrice, language, String(first.currency ?? "USD"));
    const availability = safeText(first.coarseAvailability, 30) || "contact_us";
    const leadTime = Number(first.leadTimeDays ?? 0);
    if (language === "zh") return `${mpn} \u6709 ${approvals.length} \u4e2a\u5df2\u6388\u6743\u7684\u5546\u4e1a\u9009\u9879\u3002\u6388\u6743\u5355\u4ef7\u4e3a ${price}\uff0c\u53ef\u7528\u6027\u4e3a ${availability}${leadTime ? `\uff0c\u4ea4\u671f ${leadTime} \u5929` : ""}\u3002\u4f9b\u5e94\u5546\u6210\u672c\u548c\u7cbe\u786e\u5e93\u5b58\u672a\u5305\u542b\u5728\u6b64 AI \u56de\u7b54\u4e2d\u3002`;
    if (language === "es") return `Hay ${approvals.length} opci\u00f3n comercial autorizada para ${mpn}. El precio autorizado es ${price}, la disponibilidad es ${availability}${leadTime ? ` y el lead time es ${leadTime} d\u00edas` : ""}. La IA no incluye costo de proveedor ni cantidad interna exacta.`;
    return `${mpn} has ${approvals.length} authorized commercial option. Authorized unit price is ${price}, availability is ${availability}${leadTime ? `, and lead time is ${leadTime} days` : ""}. Supplier cost and exact internal quantity are not included in this AI response.`;
  }
  if (toolResult.tool === "getLatestUploadAttribution") {
    const item = record(data.item);
    const fileName = safeText(item.fileName, 260);
    if (!fileName) return assistantMessage(language, "noData");
    const uploader = safeText(item.uploaderDisplayName, 160) || (
      language === "es"
        ? "un usuario autorizado"
        : language === "zh"
          ? "\u4e00\u540d\u5df2\u6388\u6743\u7528\u6237"
          : "an authorized user"
    );
    const uploadedAt = localizedUploadDate(item.uploadedAt, language);
    const status = localizedUploadStatus(item.status, language);
    if (language === "zh") {
      return `\u6700\u8fd1\u4e00\u6b21\u6388\u6743\u4e0a\u4f20\u7531 ${uploader} \u5b8c\u6210\uff0c\u6587\u4ef6\u540d\u4e3a ${fileName}${uploadedAt ? `\uff0c\u4e0a\u4f20\u65f6\u95f4\u4e3a ${uploadedAt}` : ""}${status ? `\uff0c\u72b6\u6001\u4e3a ${status}` : ""}\u3002`;
    }
    if (language === "es") {
      return `La carga autorizada m\u00e1s reciente la realiz\u00f3 ${uploader}: ${fileName}${uploadedAt ? `, el ${uploadedAt}` : ""}${status ? `, con estado ${status}` : ""}.`;
    }
    return `The latest authorized upload was made by ${uploader}: ${fileName}${uploadedAt ? `, on ${uploadedAt}` : ""}${status ? `, with status ${status}` : ""}.`;
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
