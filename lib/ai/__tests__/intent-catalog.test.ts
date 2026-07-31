import { describe, expect, it } from "vitest";
import {
  ASSISTANT_INTENT_CATALOG,
  detectAssistantIntent
} from "@/lib/ai/intent-catalog";

describe("typed multilingual AI intent catalog", () => {
  it("declares every required server-controlled field", () => {
    for (const definition of ASSISTANT_INTENT_CATALOG) {
      expect(definition).toEqual(expect.objectContaining({
        id: expect.any(String),
        aliases: {
          es: expect.any(Array),
          en: expect.any(Array),
          zh: expect.any(Array)
        },
        priority: expect.any(Number),
        parameters: expect.any(Array),
        tool: expect.any(String),
        permission: expect.any(String),
        clarification: {
          es: expect.any(String),
          en: expect.any(String),
          zh: expect.any(String)
        },
        positiveExamples: expect.any(Array),
        negativeExamples: expect.any(Array)
      }));
    }
  });

  it.each([
    ["\u00bfQu\u00e9 MPN tienen stock?", "es"],
    ["Which parts have stock available?", "en"],
    ["\u663e\u793a\u6709\u5e93\u5b58\u7684\u96f6\u4ef6\u3002", "zh"]
  ] as const)("routes stock equivalently: %s", (question, language) => {
    expect(detectAssistantIntent(question, language).tool).toBe("getStockNeedsSummary");
  });

  it.each([
    ["Muestra las partes que requieren sourcing.", "es"],
    ["Show me parts that require sourcing.", "en"],
    ["\u663e\u793a\u9700\u8981\u91c7\u8d2d\u7684\u96f6\u4ef6\u3002", "zh"]
  ] as const)("routes sourcing equivalently: %s", (question, language) => {
    const detected = detectAssistantIntent(question, language);
    expect(detected.tool).toBe("getOpportunityFinderSummary");
    expect(detected.intent).toBe("opportunity_sourcing");
  });

  it.each([
    ["\u00bfQu\u00e9 diferencia hay entre MPN exacto y cantidad exacta?", "es"],
    ["What is the difference between exact MPN and exact quantity?", "en"],
    ["MPN \u5b8c\u5168\u5339\u914d\u548c\u6570\u91cf\u5b8c\u5168\u76f8\u540c\u6709\u4ec0\u4e48\u533a\u522b\uff1f", "zh"]
  ] as const)("routes indicator help equivalently: %s", (question, language) => {
    expect(detectAssistantIntent(question, language).tool).toBe("getOpportunityFinderHelp");
  });

  it("tolerates accents, case and a small spelling variation", () => {
    expect(detectAssistantIntent("VENTAS COMPLETAS", "es").intent).toBe("opportunity_full_sale");
    expect(detectAssistantIntent("sourcng needed", "en").intent).toBe("opportunity_sourcing");
  });

  it("preserves leading zeros and hyphens in extracted MPN text", () => {
    expect(detectAssistantIntent("Busca MPN 000-AX9-07", "es").parameters.mpn).toBe("000-AX9-07");
  });
});
