import type { AiToolResult } from "@/lib/ai/database-tools";
import type { AssistantLanguage } from "@/lib/ai/language-detection";
import { assistantMessage, localizeToolSummary } from "@/lib/ai/messages";
import type { AssistantResponsePlan } from "@/lib/ai/response-plan";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 160)
    : "";
}

function data(toolResult: AiToolResult) {
  return record(toolResult.data);
}

function localized(
  language: AssistantLanguage,
  values: { es: string; en: string; zh: string }
) {
  return values[language];
}

function policyAnswer(intent: string, language: AssistantLanguage) {
  if (intent === "system_prompt_extraction" || intent === "internal_instructions_request") {
    return localized(language, {
      es: "No puedo revelar el prompt del sistema ni las instrucciones internas.",
      en: "I cannot reveal the system prompt or internal instructions.",
      zh: "我不能透露系统提示或内部指令。"
    });
  }
  if (intent === "sql_execution_request") {
    return localized(language, {
      es: "No puedo ejecutar SQL ni entregar datos masivos de las tablas.",
      en: "I cannot execute SQL or provide bulk table data.",
      zh: "我不能执行 SQL，也不能提供表中的批量数据。"
    });
  }
  if (
    intent === "role_escalation_request" ||
    intent === "cross_user_data_request" ||
    intent === "conversation_access_request" ||
    intent === "permission_bypass_request"
  ) {
    return localized(language, {
      es: "No puedo cambiar roles, omitir permisos ni acceder a datos o conversaciones de otros usuarios.",
      en: "I cannot change roles, bypass permissions, or access other users’ data or conversations.",
      zh: "我不能更改角色、绕过权限，也不能访问其他用户的数据或对话。"
    });
  }
  return localized(language, {
    es: "Las reglas de seguridad, permisos y herramientas son controladas por el servidor y no pueden cambiarse desde una pregunta o un archivo.",
    en: "Security rules, permissions, and tools are controlled by the server and cannot be changed by a question or file.",
    zh: "安全规则、权限和工具由服务器控制，无法通过问题或文件进行更改。"
  });
}

function assistantHelp(intent: string, language: AssistantLanguage) {
  if (intent === "assistant_usage_help") {
    return localized(language, {
      es: "Puedes preguntarme por la última comparación, ventas completas, ventas parciales, sourcing requerido, MPN exactos, disponibilidad utilizable o cantidad exacta.",
      en: "You can ask about the latest comparison, full sales, partial sales, sourcing required, exact MPNs, usable availability, or exact quantity.",
      zh: "你可以询问最新比较、完整销售、部分销售、采购需求、精确 MPN、可用库存或精确数量。"
    });
  }
  if (intent === "assistant_data_sources") {
    return localized(language, {
      es: "Puedo consultar Opportunity Finder, Stock Needs, cargas visibles, perfiles estructurales seguros, dashboard y errores autorizados. No puedo consultar datos de otros usuarios, costos, precios, GP, márgenes, datos crudos, conversaciones ajenas ni SQL libre.",
      en: "I can query authorized Opportunity Finder, Stock Needs, visible uploads, safe structural profiles, dashboard data, and authorized errors. I cannot access other users’ data, costs, prices, GP, margins, raw data, other conversations, or free-form SQL.",
      zh: "我可以查询已授权的商机查找器、库存需求、可见上传、安全结构配置、仪表板和授权错误。我不能访问其他用户的数据、成本、价格、毛利、利润率、原始数据、他人对话或自由 SQL。"
    });
  }
  if (intent === "response_type_explanation") {
    return localized(language, {
      es: "Una respuesta basada en datos proviene de una herramienta determinística autorizada. Una respuesta generada con IA usa un proveedor para redactar a partir de contexto sanitizado. Ambas respetan permisos y la IA no debe inventar datos ausentes.",
      en: "A data-based answer comes from an authorized deterministic tool. An AI-generated answer uses a provider to write from sanitized context. Both respect permissions, and AI must not invent missing data.",
      zh: "基于数据的回答来自已授权的确定性工具。人工智能生成的回答使用提供商根据经过清理的上下文进行表述。两者都遵守权限，人工智能不得编造缺失数据。"
    });
  }
  if (intent === "insufficient_information_policy") {
    return assistantMessage(language, "noData");
  }
  return localized(language, {
    es: "Puedo consultar stock, faltantes, cargas autorizadas, errores de importación y resultados persistidos del Buscador de oportunidades. No puedo mostrar información financiera, ejecutar SQL ni cambiar permisos.",
    en: "I can query stock, shortages, authorized uploads, import errors, and persisted Opportunity Finder results. I cannot expose financial data, execute SQL, or change permissions.",
    zh: "我可以查询库存、缺货、授权上传、导入错误以及已保存的商机查找结果。我不能显示财务数据、执行 SQL 或更改权限。"
  });
}

function opportunityHelp(intent: string, language: AssistantLanguage) {
  if (intent === "opportunity_exact_mpn_help") {
    return localized(language, {
      es: "Una coincidencia exacta de MPN significa que el número de parte normalizado aparece en ambos archivos. No implica cantidades iguales ni garantiza stock utilizable.",
      en: "An exact MPN match means the normalized part number appears in both files. It does not mean quantities are equal or guarantee usable stock.",
      zh: "精确 MPN 匹配表示标准化后的料号出现在两个文件中；它不表示数量相同，也不保证存在可用库存。"
    });
  }
  if (intent === "opportunity_exact_quantity_help") {
    return localized(language, {
      es: "Cantidad exacta significa que, antes de asignar, el saldo utilizable disponible coincide exactamente con la cantidad requerida; la necesidad queda cubierta sin sobrante en ese momento.",
      en: "Exact quantity means usable availability before allocation exactly matched the required quantity, covering demand with no remainder at that moment.",
      zh: "精确数量表示分配前的可用数量与需求数量完全相同，因此当时需求被满足且没有剩余。"
    });
  }
  if (intent === "opportunity_full_vs_exact_help") {
    return localized(language, {
      es: "Venta completa significa que la necesidad quedó totalmente cubierta. Cantidad exacta significa que, antes de asignar, el saldo utilizable era igual a la necesidad. Puede quedar inventario sobrante y aun así ser una venta completa.",
      en: "A full sale means demand was fully covered. An exact quantity match means usable availability before allocation exactly matched the required quantity. A full sale may still leave remaining stock.",
      zh: "完整销售表示需求已被完全满足。精确数量表示分配前的可用数量与需求数量完全相同。完整销售后仍可能有剩余库存。"
    });
  }
  if (intent === "opportunity_exact_mpn_vs_quantity_help") {
    return localized(language, {
      es: "Coincidencia exacta de MPN significa que el número de parte normalizado aparece en ambos archivos. Cantidad exacta significa que la disponibilidad utilizable antes de asignar coincide con la necesidad. La coincidencia de MPN no garantiza stock utilizable.",
      en: "An exact MPN match means the normalized part number appears in both files. Exact quantity means usable availability before allocation exactly matched demand. An MPN match does not guarantee usable stock.",
      zh: "精确 MPN 匹配表示标准化后的料号出现在两个文件中；精确数量表示分配前的可用数量与需求数量完全相同；MPN 匹配不保证存在可用库存。"
    });
  }
  return localized(language, {
    es: "MPN exacto indica que la referencia coincide; disponibilidad utilizable indica inventario válido y asignable; cantidad exacta indica que la disponibilidad antes de asignar es igual a la demanda. Una venta completa cubre toda la demanda y una parcial solo una parte.",
    en: "Exact MPN means the part number matches; usable availability means valid allocatable stock; exact quantity means availability before allocation equals demand. A full sale covers all demand, while a partial sale covers only part.",
    zh: "精确 MPN 表示料号匹配；可用库存表示有效且可分配的库存；精确数量表示分配前的可用数量等于需求。完整销售覆盖全部需求，部分销售只覆盖一部分。"
  });
}

function countAnswer(
  plan: AssistantResponsePlan,
  toolResult: AiToolResult,
  language: AssistantLanguage
) {
  const totals = record(data(toolResult).totals);
  const metricKey = plan.metric ?? "";
  const value = Object.prototype.hasOwnProperty.call(totals, metricKey)
    ? number(totals[metricKey])
    : number(toolResult.total);
  const labels: Record<string, { es: string; en: string; zh: string }> = {
    exactMatches: { es: "MPN exactos", en: "exact MPNs", zh: "个精确 MPN" },
    usableAvailabilityMatches: { es: "MPN con disponibilidad utilizable", en: "MPNs with usable availability", zh: "个 MPN 有可用库存" },
    exactQuantityMatches: { es: "casos con cantidad exacta", en: "exact quantity cases", zh: "个精确数量案例" },
    fullSales: { es: "ventas completas", en: "full sales", zh: "个完整销售" },
    partialSales: { es: "ventas parciales", en: "partial sales", zh: "个部分销售" },
    sourcingNeeded: { es: "casos con sourcing requerido", en: "cases requiring sourcing", zh: "个需要采购的案例" },
    supplyWithoutDemand: { es: "casos de inventario sin demanda", en: "supply-without-demand cases", zh: "个无需求库存案例" },
    reviewRequired: { es: "casos que requieren revisión", en: "cases requiring review", zh: "个需要审核的案例" },
    invalidQuantityRows: { es: "cantidades inválidas", en: "invalid quantities", zh: "个无效数量" },
    missingMpnRows: { es: "registros visibles sin MPN", en: "visible records missing an MPN", zh: "条缺少 MPN 的可见记录" }
  };
  const label = labels[plan.metric ?? ""] ?? {
    es: "resultados",
    en: "results",
    zh: "条结果"
  };
  if (plan.metric === "reviewRequired") {
    return localized(language, {
      es: `Se detectó ${value} caso${value === 1 ? "" : "s"} que requiere${value === 1 ? "" : "n"} revisión.`,
      en: `${value} case${value === 1 ? "" : "s"} require${value === 1 ? "s" : ""} review.`,
      zh: `检测到 ${value} 个需要审核的案例。`
    });
  }
  return localized(language, {
    es: `Se detectaron ${value} ${label.es}.`,
    en: `Detected ${value} ${label.en}.`,
    zh: `检测到 ${value} ${label.zh}。`
  });
}

function mpnItems(toolResult: AiToolResult) {
  return array(data(toolResult).items)
    .map((item) => text(record(item).mpn ?? record(item).displayMpn))
    .filter(Boolean)
    .slice(0, 20);
}

function listAnswer(
  plan: AssistantResponsePlan,
  toolResult: AiToolResult,
  language: AssistantLanguage
) {
  if (plan.intent === "import_errors" || plan.intent === "employee_uploads") {
    return localizeToolSummary(toolResult, language);
  }
  const items = mpnItems(toolResult);
  const suffix = toolResult.truncated
    ? localized(language, {
        es: " La lista está truncada.",
        en: " The list is truncated.",
        zh: " 列表已截断。"
      })
    : "";
  if (!items.length && plan.intent === "stock_shortage") {
    const totals = record(data(toolResult).totals);
    const count = number(totals.shortage ?? totals.noStock ?? toolResult.total);
    if (count > 0) {
      return localized(language, {
        es: `Se detectaron ${count} MPN con faltante de stock.`,
        en: `${count} MPNs have stock shortages.`,
        zh: `${count} 个 MPN 存在库存短缺。`
      });
    }
  }
  if (!items.length && plan.intent === "zero_stock") {
    const totals = record(data(toolResult).totals);
    const count = number(totals.zeroStock ?? totals.noStock ?? toolResult.total);
    if (count > 0) {
      return localized(language, {
        es: `Se detectaron ${count} MPN con stock cero.`,
        en: `${count} MPNs have zero stock.`,
        zh: `${count} 个 MPN 的库存为零。`
      });
    }
  }
  if (!items.length) return assistantMessage(language, "noData");
  if (plan.intent === "opportunity_sourcing") {
    return localized(language, {
      es: `${items.length} partes requieren sourcing: ${items.join(", ")}.${suffix}`,
      en: `${items.length} parts require sourcing: ${items.join(", ")}.${suffix}`,
      zh: `${items.length} 个零件需要采购：${items.join("、")}。${suffix}`
    });
  }
  if (plan.intent === "opportunity_invalid_quantity") {
    return localized(language, {
      es: `Se detectó ${items.length} cantidad${items.length === 1 ? "" : "es"} inválida${items.length === 1 ? "" : "s"}: ${items.join(", ")}.${suffix}`,
      en: `Detected ${items.length} invalid quantit${items.length === 1 ? "y" : "ies"}: ${items.join(", ")}.${suffix}`,
      zh: `检测到 ${items.length} 个无效数量：${items.join("、")}。${suffix}`
    });
  }
  if (plan.intent === "zero_stock") {
    return localized(language, {
      es: `MPN con stock cero: ${items.join(", ")}.${suffix}`,
      en: `MPNs with zero stock: ${items.join(", ")}.${suffix}`,
      zh: `零库存 MPN：${items.join("、")}。${suffix}`
    });
  }
  if (plan.intent === "stock_shortage") {
    return localized(language, {
      es: `MPN con faltante de stock: ${items.join(", ")}.${suffix}`,
      en: `MPNs with stock shortages: ${items.join(", ")}.${suffix}`,
      zh: `库存不足的 MPN：${items.join("、")}。${suffix}`
    });
  }
  return localized(language, {
    es: `MPN autorizados: ${items.join(", ")}.${suffix}`,
    en: `Authorized MPNs: ${items.join(", ")}.${suffix}`,
    zh: `已授权的 MPN：${items.join("、")}。${suffix}`
  });
}

function itemDetailAnswer(
  plan: AssistantResponsePlan,
  toolResult: AiToolResult,
  language: AssistantLanguage
) {
  const source = data(toolResult);
  const item = record(source.item);
  const mpn = text(source.mpn ?? item.displayMpn ?? plan.mpn);
  if (!mpn || !Object.keys(item).length) return assistantMessage(language, "noData");
  const available = Boolean(item.usableAvailabilityMatch)
    ? Math.max(number(item.availableQty), 0)
    : 0;
  return localized(language, {
    es: `El MPN ${mpn} tiene ${available} unidades de disponibilidad utilizable según la comparación actual del Buscador de oportunidades.`,
    en: `MPN ${mpn} has ${available} units of usable availability in the current Opportunity Finder comparison.`,
    zh: `根据当前商机查找器比较，MPN ${mpn} 有 ${available} 个单位的可用库存。`
  });
}

function safeColumnsAnswer(toolResult: AiToolResult, language: AssistantLanguage) {
  const columns = array(data(toolResult).safeColumns)
    .map(text)
    .filter(Boolean)
    .slice(0, 30);
  if (!columns.length) return assistantMessage(language, "noData");
  return localized(language, {
    es: `Columnas estructurales seguras detectadas: ${columns.join(", ")}.`,
    en: `Detected safe structural columns: ${columns.join(", ")}.`,
    zh: `检测到的安全结构列：${columns.join("、")}。`
  });
}

export function localizedSourceLabel(
  sourceType: string,
  language: AssistantLanguage,
  tool: string | null
) {
  if (tool === "getAssistantSourceHelp" || sourceType === "stock_needs") return "Stock Needs";
  if (sourceType === "opportunity_finder") return "Opportunity Finder";
  if (sourceType === "upload_metadata") {
    return localized(language, {
      es: "Carga autorizada",
      en: "Authorized upload",
      zh: "授权上传"
    });
  }
  if (sourceType === "authorized_database") {
    return localized(language, {
      es: "Base de datos autorizada",
      en: "Authorized database",
      zh: "授权数据库"
    });
  }
  if (tool === "conversationMemorySet" || tool === "conversationMemoryRecall") {
    return localized(language, {
      es: "Memoria de la conversación",
      en: "Conversation memory",
      zh: "对话记忆"
    });
  }
  return localized(language, {
    es: "Asistente",
    en: "Assistant",
    zh: "助手"
  });
}

export function renderPlannedAssistantResponse(
  toolResult: AiToolResult,
  plan: AssistantResponsePlan
) {
  const language = plan.language;
  if (plan.answerMode === "deny") {
    if (toolResult.tool === "sensitiveDataPermissionDenied") {
      return localizeToolSummary(toolResult, language);
    }
    return policyAnswer(plan.intent, language);
  }
  if (plan.answerMode === "clarify") return toolResult.summary;
  if (plan.answerMode === "memory_set") {
    const mpn = text(data(toolResult).mpn);
    if (!mpn) return assistantMessage(language, "noData");
    return localized(language, {
      es: `Sí. Recordaré ${mpn} como tu MPN de interés durante esta conversación.`,
      en: `Yes. I will remember ${mpn} as your MPN of interest during this conversation.`,
      zh: `好的。在本次对话中，我会记住 ${mpn} 是你感兴趣的 MPN。`
    });
  }
  if (plan.answerMode === "memory_recall") {
    const mpn = text(data(toolResult).mpn);
    if (!mpn) return assistantMessage(language, "noData");
    return localized(language, {
      es: `El MPN de interés que indicaste anteriormente era ${mpn}.`,
      en: `The MPN of interest you mentioned earlier was ${mpn}.`,
      zh: `你之前提到的感兴趣 MPN 是 ${mpn}。`
    });
  }
  if (plan.intent === "assistant_help" || plan.intent.startsWith("assistant_") || plan.intent === "response_type_explanation" || plan.intent === "insufficient_information_policy") {
    return assistantHelp(plan.intent, language);
  }
  if (plan.intent === "response_source_explanation") {
    return localized(language, {
      es: "La fuente lógica fue Stock Needs, usando datos autorizados dentro del alcance del usuario. La respuesta fue determinística.",
      en: "The logical source was Stock Needs, using authorized data within the user’s scope. The response was deterministic.",
      zh: "逻辑来源是 Stock Needs，使用用户权限范围内的授权数据。该回答是确定性的。"
    });
  }
  if (plan.intent === "stock_concept_help") {
    return localized(language, {
      es: "Stock total es la existencia registrada antes de considerar reservas, validez o asignaciones. Disponibilidad utilizable es la cantidad válida y positiva que puede asignarse según el resultado autorizado.",
      en: "Total stock is recorded inventory before considering reservations, validity, or allocations. Usable availability is the valid positive quantity that can be allocated according to the authorized result.",
      zh: "总库存是考虑预留、有效性或分配之前的登记库存。可用库存是根据授权结果可以分配的有效正数量。"
    });
  }
  if (plan.intent.includes("_help") || plan.intent === "opportunity_finder_help") {
    return opportunityHelp(plan.intent, language);
  }
  if (plan.intent === "latest_upload_columns") return safeColumnsAnswer(toolResult, language);
  if (plan.answerMode === "item_detail" && plan.intent === "opportunity_item_availability") {
    return itemDetailAnswer(plan, toolResult, language);
  }
  if (plan.answerMode === "item_detail" && plan.intent === "mpn_search") {
    const mpn = text(plan.mpn);
    const total = number(toolResult.total ?? toolResult.rows?.length);
    if (!mpn || total <= 0) return assistantMessage(language, "noData");
    return localized(language, {
      es: `Se encontraron ${total} registros autorizados para el MPN ${mpn}.`,
      en: `Found ${total} authorized records for MPN ${mpn}.`,
      zh: `找到 ${total} 条 MPN ${mpn} 的授权记录。`
    });
  }
  if (plan.answerMode === "count") return countAnswer(plan, toolResult, language);
  if (plan.answerMode === "list") return listAnswer(plan, toolResult, language);
  return localizeToolSummary(toolResult, language);
}
