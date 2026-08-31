import type { AssistantLanguage } from "@/lib/ai/language-detection";

export type AssistantAnswerMode =
  | "help"
  | "deny"
  | "clarify"
  | "summary"
  | "count"
  | "list"
  | "item_detail"
  | "concept_explanation"
  | "comparison_explanation"
  | "memory_set"
  | "memory_recall"
  | "no_data";

export type AssistantPolicyDecision = "allow" | "deny";

export interface AssistantResponsePlan {
  intent: string;
  confidence: number;
  tool: string | null;
  answerMode: AssistantAnswerMode;
  language: AssistantLanguage;
  entity: "mpn" | "stock" | "opportunity" | "upload" | "memory" | "employee" | "rfq" | "client" | null;
  metric: string | null;
  mpn: string | null;
  requiresClarification: boolean;
  policyDecision: AssistantPolicyDecision;
}

export const DEFAULT_GENERAL_QUERY_MIN_CONFIDENCE = 0.75;

export function configuredGeneralQueryMinConfidence() {
  const parsed = Number(process.env.AI_GENERAL_QUERY_MIN_CONFIDENCE);
  if (!Number.isFinite(parsed)) return DEFAULT_GENERAL_QUERY_MIN_CONFIDENCE;
  return Math.min(Math.max(parsed, 0.5), 0.99);
}

export function createAssistantResponsePlan(input: AssistantResponsePlan) {
  return Object.freeze({
    ...input,
    confidence: Number(Math.min(Math.max(input.confidence, 0), 1).toFixed(2)),
    mpn: input.mpn?.trim().slice(0, 80) || null
  });
}
