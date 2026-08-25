import { describe, expect, it } from "vitest";
import type { AiToolResult } from "@/lib/ai/database-tools";
import type { AssistantLanguage } from "@/lib/ai/language-detection";
import { createAssistantResponsePlan } from "@/lib/ai/response-plan";
import { renderPlannedAssistantResponse } from "@/lib/ai/response-renderer";

const helpResult: AiToolResult = {
  ok: true,
  tool: "getOpportunityFinderHelp",
  scope: "own",
  total: 0,
  data: { reasonCode: "snapshot" },
  rows: [],
  summary: "Safe synthetic help.",
  empty: false,
  deterministic: true
};

function explanation(intent: string, language: AssistantLanguage) {
  return renderPlannedAssistantResponse(
    helpResult,
    createAssistantResponsePlan({
      intent,
      confidence: 1,
      tool: "getOpportunityFinderHelp",
      answerMode: intent === "opportunity_full_vs_exact_help"
        ? "comparison_explanation"
        : "concept_explanation",
      language,
      entity: "opportunity",
      metric: null,
      mpn: null,
      requiresClarification: false,
      policyDecision: "allow"
    })
  );
}

describe("multilingual Opportunity Finder explanation snapshots", () => {
  it.each(["es", "en", "zh"] as const)(
    "keeps exact MPN, usable availability, exact quantity, full sale, partial sale, and comparison copy stable in %s",
    (language) => {
      expect({
        exactMpn: explanation("opportunity_exact_mpn_help", language),
        usableAvailability: explanation("opportunity_finder_help", language),
        exactQuantity: explanation("opportunity_exact_quantity_help", language),
        fullSale: explanation("opportunity_finder_help", language),
        partialSale: explanation("opportunity_finder_help", language),
        fullSaleVsExactQuantity: explanation("opportunity_full_vs_exact_help", language)
      }).toMatchSnapshot();
    }
  );
});
