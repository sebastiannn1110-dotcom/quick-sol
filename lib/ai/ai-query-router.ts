import type { AuthContext } from "@/lib/auth/context";
import type { SafeHistoryMessage } from "@/lib/ai/conversation-memory";
import { canRequestCompanyWideData, questionRequestsCompanyWideData } from "@/lib/ai/ai-permissions";
import {
  getAssistantHelp,
  getAssistantSourceHelp,
  getClarificationRequired,
  getConversationMemoryRecall,
  getConversationMemorySet,
  getDashboardSummary,
  getImportErrors,
  getLatestUploadAttribution,
  getLatestUpload,
  getMissingMpnRecords,
  getOpportunitiesSummary,
  getOpportunityFinderHelp,
  getOpportunityFinderItemDetail,
  getOpportunityFinderSummary,
  getPolicySafetyBoundary,
  getRecordsByMpn,
  getSensitiveDataPermissionDenied,
  getStockNeedsSummary,
  getStockConceptHelp,
  getStockShortageSummary,
  getZeroStockSummary,
  getUploadPresentationSummary,
  getUploadsByUser,
  searchBusinessRecords,
  type AiToolResult
} from "@/lib/ai/database-tools";
import {
  detectAssistantIntent,
  type AssistantIntentId
} from "@/lib/ai/intent-catalog";
import type { AssistantLanguage } from "@/lib/ai/language-detection";
import { detectAssistantPolicyIntent } from "@/lib/ai/policy-firewall";
import {
  configuredGeneralQueryMinConfidence,
  createAssistantResponsePlan,
  type AssistantResponsePlan
} from "@/lib/ai/response-plan";
import type { OpportunityFinderAiMode } from "@/lib/ai/opportunity-finder-tool";
import {
  getClientQuoteSummary,
  getEmployeeQuoteMetrics,
  getQuoteSummary,
  getSourcingLookup
} from "@/lib/ai/commerce-tools";
import {
  logSafeAiEvent,
  sanitizeQuestionForLogs
} from "@/lib/ai/safe-logging";
import { shouldBlockSensitiveAiQuestion } from "@/lib/security/permissions";

export interface AiRouterResult {
  permissionDenied: boolean;
  toolResult: AiToolResult | null;
  intent: AssistantIntentId | "permission_denied";
  confidence: number;
  ambiguous: boolean;
  plan: AssistantResponsePlan;
}

export interface AiRouterOptions {
  language?: AssistantLanguage;
  jobId?: string | null;
  history?: SafeHistoryMessage[];
}

const OPPORTUNITY_MODES: Partial<Record<AssistantIntentId, OpportunityFinderAiMode>> = {
  opportunity_finder_summary: "general",
  opportunity_full_sale: "full_sale",
  opportunity_partial_sale: "partial_sale",
  opportunity_sourcing: "sourcing_needed",
  opportunity_supply_without_demand: "supply_without_demand",
  opportunity_exact_mpn: "exactMpn",
  opportunity_usable_availability: "usableAvailability",
  opportunity_exact_quantity: "exactQuantity",
  opportunity_review_count: "review",
  opportunity_review: "review",
  opportunity_invalid_quantity: "invalid_quantity"
};

function extractPerson(question: string) {
  return question.match(
    /(?:subi[oó]|empleado|employee|usuario|user|de|from)\s+([\p{L}][\p{L}\s]{1,50})/iu
  )?.[1]?.trim() ?? question;
}

function metricForIntent(intent: AssistantIntentId) {
  const metrics: Partial<Record<AssistantIntentId, string>> = {
    opportunity_exact_mpn: "exactMatches",
    opportunity_usable_availability: "usableAvailabilityMatches",
    opportunity_exact_quantity: "exactQuantityMatches",
    opportunity_full_sale: "fullSales",
    opportunity_partial_sale: "partialSales",
    opportunity_sourcing: "sourcingNeeded",
    opportunity_supply_without_demand: "supplyWithoutDemand",
    opportunity_review: "reviewRequired",
    opportunity_review_count: "reviewRequired",
    opportunity_invalid_quantity: "invalidQuantityRows",
    missing_mpn: "missingMpnRows",
    missing_mpn_records: "missingMpnRows"
  };
  return metrics[intent] ?? null;
}

function entityForIntent(intent: AssistantIntentId): AssistantResponsePlan["entity"] {
  if (intent.includes("memory")) return "memory";
  if (intent.includes("upload") || intent === "dashboard" || intent === "import_errors") {
    return "upload";
  }
  if (intent.includes("stock") || intent === "zero_stock") return "stock";
  if (intent.includes("opportunity")) return "opportunity";
  if (intent === "mpn_search" || intent.includes("mpn")) return "mpn";
  return null;
}

function asksForList(question: string) {
  const value = question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\b(que mpn|que piezas|muestra|mostrar|lista|show|which parts|list)\b|显示|列出/.test(value);
}

function asksForCount(question: string) {
  const value = question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\b(cuantos?|cuantas?|how many|number of)\b|多少|几个/.test(value);
}

function clarificationForIntent(
  intent: AssistantIntentId,
  language: AssistantLanguage,
  fallback: string
) {
  if (intent === "best_opportunity_ambiguous") {
    if (language === "en") {
      return "Which criterion should define the best opportunity: full sale, exact quantity, highest usable availability, highest allocatable quantity, lowest shortage, or priority sourcing?";
    }
    if (language === "zh") {
      return "你希望用什么标准定义最佳商机：完整销售、精确数量、最高可用库存、最高可分配数量、最低缺口，还是优先采购？";
    }
    return "¿Qué criterio quieres utilizar para definir la mejor oportunidad: venta completa, cantidad exacta, mayor disponibilidad utilizable, mayor cantidad asignable, menor faltante o sourcing prioritario?";
  }
  if (intent === "clarification_required") {
    if (language === "en") {
      return "Could you clarify whether you want to search an MPN, review stock, shortages, invalid quantities, import errors, or opportunities?";
    }
    if (language === "zh") {
      return "请说明你要查找 MPN、检查库存、缺货、无效数量、导入错误还是商机。";
    }
    return "¿Puedes aclarar si quieres buscar un MPN, revisar stock, faltantes, cantidades inválidas, errores de importación u oportunidades?";
  }
  return fallback;
}

function planForDetected(input: {
  detected: ReturnType<typeof detectAssistantIntent>;
  language: AssistantLanguage;
  question: string;
  answerMode?: AssistantResponsePlan["answerMode"];
  tool?: string | null;
  policyDecision?: AssistantResponsePlan["policyDecision"];
}) {
  const inferredMode =
    metricForIntent(input.detected.intent) && asksForCount(input.question)
      ? "count"
      :
      (
          input.detected.answerMode === "count" ||
          input.detected.intent === "stock"
        ) && asksForList(input.question)
          ? "list"
          : input.detected.answerMode;
  const answerMode = input.answerMode ?? inferredMode;
  return createAssistantResponsePlan({
    intent: input.detected.intent,
    confidence: input.detected.confidence,
    tool: input.tool ?? input.detected.tool,
    answerMode,
    language: input.language,
    entity: entityForIntent(input.detected.intent),
    metric: metricForIntent(input.detected.intent),
    mpn: input.detected.parameters.mpn ?? null,
    requiresClarification: answerMode === "clarify",
    policyDecision: input.policyDecision ?? (answerMode === "deny" ? "deny" : "allow")
  });
}

async function logRouteResult(
  context: AuthContext,
  startedAt: number,
  question: string,
  intent: AssistantIntentId | "permission_denied",
  confidence: number,
  language: AssistantLanguage,
  toolResult: AiToolResult | null,
  status: "completed" | "failed" = "completed"
) {
  void confidence;
  await logSafeAiEvent(context, {
    action: "ai_database_tool_completed",
    status,
    durationMs: Math.round(performance.now() - startedAt),
    metadata: {
      ...sanitizeQuestionForLogs(question),
      intent,
      language,
      tool: toolResult?.tool ?? null,
      scope: toolResult?.scope ?? null,
      rowCount: Number(toolResult?.total ?? toolResult?.rows?.length ?? 0),
      provider: "supabase",
      state: toolResult?.empty ? "empty" : status
    }
  });
}

async function executeDetectedIntent(input: {
  context: AuthContext;
  question: string;
  language: AssistantLanguage;
  intent: AssistantIntentId;
  mpn?: string;
  jobId?: string | null;
  history: SafeHistoryMessage[];
  clarification: string;
}) {
  const { context, question, language, intent } = input;
  if (
    [
      "policy_safety",
      "system_prompt_extraction",
      "internal_instructions_request",
      "sql_execution_request",
      "tool_override_request",
      "role_escalation_request",
      "cross_user_data_request",
      "conversation_access_request",
      "permission_bypass_request"
    ].includes(intent)
  ) {
    return getPolicySafetyBoundary(context, intent);
  }
  if (intent === "sensitive_request") return getSensitiveDataPermissionDenied(context);
  if (
    [
      "assistant_help",
      "assistant_usage_help",
      "assistant_data_sources",
      "response_type_explanation",
      "insufficient_information_policy"
    ].includes(intent)
  ) {
    return getAssistantHelp(context, intent);
  }
  if (intent === "response_source_explanation") return getAssistantSourceHelp(context);
  if (intent === "conversation_memory_set") {
    return getConversationMemorySet(context, input.mpn ?? "");
  }
  if (intent === "conversation_memory_recall") {
    return getConversationMemoryRecall(context, input.history);
  }
  if (intent === "clarification_required" || intent === "best_opportunity_ambiguous") {
    return getClarificationRequired(context, input.clarification);
  }
  if (
    [
      "opportunity_finder_help",
      "opportunity_exact_mpn_help",
      "opportunity_exact_quantity_help",
      "opportunity_full_vs_exact_help",
      "opportunity_exact_mpn_vs_quantity_help"
    ].includes(intent)
  ) {
    return getOpportunityFinderHelp(context, intent);
  }
  if (intent === "opportunity_item_availability" && input.mpn) {
    return getOpportunityFinderItemDetail(context, {
      language,
      mpn: input.mpn,
      jobId: input.jobId
    });
  }
  if (intent === "historical_opportunities") return getOpportunitiesSummary(context, question);
  if (intent === "stock") {
    return getStockNeedsSummary(context, question, input.mpn ?? "");
  }
  if (intent === "stock_shortage") return getStockShortageSummary(context);
  if (intent === "zero_stock") return getZeroStockSummary(context);
  if (intent === "stock_concept_help") return getStockConceptHelp(context);
  if (intent === "quote_summary") return getQuoteSummary(context);
  if (intent === "employee_quote_metrics") {
    return getEmployeeQuoteMetrics(context, question);
  }
  if (intent === "client_quote_summary") return getClientQuoteSummary(context);
  if (intent === "sourcing_lookup") {
    return getSourcingLookup(context, input.mpn ?? "");
  }
  if (intent === "latest_upload_attribution") {
    return getLatestUploadAttribution(context);
  }
  if (intent === "latest_upload") return getLatestUpload(context);
  if (intent === "upload_summary" || intent === "latest_upload_columns") {
    return getUploadPresentationSummary(context, question);
  }
  if (intent === "import_errors") return getImportErrors(context);
  if (intent === "dashboard") return getDashboardSummary(context);
  if (intent === "missing_mpn" || intent === "missing_mpn_records") {
    return getMissingMpnRecords(context);
  }
  if (intent === "mpn_search" && input.mpn) return getRecordsByMpn(context, input.mpn);
  if (intent === "employee_uploads") return getUploadsByUser(context, extractPerson(question));

  const opportunityMode = OPPORTUNITY_MODES[intent];
  if (opportunityMode) {
    return getOpportunityFinderSummary(context, {
      language,
      mode: opportunityMode,
      jobId: input.jobId
    });
  }
  return searchBusinessRecords(context, question);
}

/**
 * Server-owned router. The model never chooses a tool and never supplies SQL.
 */
export async function routeAssistantDatabaseQuery(
  context: AuthContext,
  question: string,
  options: AiRouterOptions = {}
): Promise<AiRouterResult> {
  const startedAt = performance.now();
  const language = options.language ?? "es";
  const history = options.history ?? [];
  const policy = detectAssistantPolicyIntent(question, language);
  if (policy) {
    const toolResult = getPolicySafetyBoundary(context, policy.intent);
    const plan = createAssistantResponsePlan({
      intent: policy.intent,
      confidence: 1,
      tool: policy.tool,
      answerMode: "deny",
      language,
      entity: null,
      metric: null,
      mpn: null,
      requiresClarification: false,
      policyDecision: "deny"
    });
    await logRouteResult(
      context,
      startedAt,
      question,
      policy.intent,
      1,
      language,
      toolResult
    );
    return {
      permissionDenied: false,
      toolResult,
      intent: policy.intent,
      confidence: 1,
      ambiguous: false,
      plan
    };
  }

  const detected = detectAssistantIntent(question, language);

  // Keep the established security detector as a second, independent boundary.
  if (
    detected.intent === "sensitive_request" ||
    shouldBlockSensitiveAiQuestion(question, context.profile.role)
  ) {
    const toolResult = getSensitiveDataPermissionDenied(context);
    await logRouteResult(
      context,
      startedAt,
      question,
      "sensitive_request",
      Math.max(detected.confidence, 0.99),
      language,
      toolResult
    );
    return {
      permissionDenied: false,
      toolResult,
      intent: "sensitive_request",
      confidence: Math.max(detected.confidence, 0.99),
      ambiguous: false,
      plan: createAssistantResponsePlan({
        intent: "sensitive_request",
        confidence: Math.max(detected.confidence, 0.99),
        tool: "sensitiveDataPermissionDenied",
        answerMode: "deny",
        language,
        entity: null,
        metric: null,
        mpn: detected.parameters.mpn ?? null,
        requiresClarification: false,
        policyDecision: "deny"
      })
    };
  }

  if (questionRequestsCompanyWideData(question) && !canRequestCompanyWideData(context.profile.role)) {
    await logRouteResult(
      context,
      startedAt,
      question,
      "permission_denied",
      detected.confidence,
      language,
      null,
      "failed"
    );
    return {
      permissionDenied: true,
      toolResult: null,
      intent: "permission_denied",
      confidence: detected.confidence,
      ambiguous: false,
      plan: createAssistantResponsePlan({
        intent: "permission_denied",
        confidence: detected.confidence,
        tool: null,
        answerMode: "deny",
        language,
        entity: null,
        metric: null,
        mpn: detected.parameters.mpn ?? null,
        requiresClarification: false,
        policyDecision: "deny"
      })
    };
  }

  if (detected.ambiguous) {
    const clarification = clarificationForIntent(
      detected.intent,
      language,
      detected.definition.clarification[language]
    );
    const toolResult = getClarificationRequired(context, clarification);
    const plan = planForDetected({
      detected,
      language,
      question,
      answerMode: "clarify",
      tool: "clarificationRequired"
    });
    await logRouteResult(
      context,
      startedAt,
      question,
      detected.intent,
      detected.confidence,
      language,
      toolResult
    );
    return {
      permissionDenied: false,
      toolResult,
      intent: detected.intent,
      confidence: detected.confidence,
      ambiguous: true,
      plan
    };
  }

  if (detected.intent === "general_query") {
    const threshold = configuredGeneralQueryMinConfidence();
    const explicitBusinessEntity = Boolean(
      detected.parameters.mpn ||
      /\b(mpn|part number|stock|upload|carga|oportunidad|opportunity)\b/i.test(question)
    );
    if (detected.confidence < threshold || !explicitBusinessEntity) {
      const clarification = detected.definition.clarification[language];
      const toolResult = getClarificationRequired(context, clarification);
      const plan = planForDetected({
        detected,
        language,
        question,
        answerMode: "clarify",
        tool: "clarificationRequired"
      });
      await logRouteResult(
        context,
        startedAt,
        question,
        detected.intent,
        detected.confidence,
        language,
        toolResult
      );
      return {
        permissionDenied: false,
        toolResult,
        intent: detected.intent,
        confidence: detected.confidence,
        ambiguous: true,
        plan
      };
    }
  }

  const clarification = clarificationForIntent(
    detected.intent,
    language,
    detected.definition.clarification[language]
  );
  const toolResult = await executeDetectedIntent({
    context,
    question,
    language,
    intent: detected.intent,
    mpn: detected.parameters.mpn,
    jobId: options.jobId ?? detected.parameters.jobId ?? null,
    history,
    clarification
  });
  const plan = planForDetected({
    detected,
    language,
    question,
    tool: toolResult.tool
  });
  await logRouteResult(
    context,
    startedAt,
    question,
    detected.intent,
    detected.confidence,
    language,
    toolResult
  );
  return {
    permissionDenied: false,
    toolResult,
    intent: detected.intent,
    confidence: detected.confidence,
    ambiguous: false,
    plan
  };
}
