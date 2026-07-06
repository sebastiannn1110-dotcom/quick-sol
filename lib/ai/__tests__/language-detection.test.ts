import { describe, expect, it } from "vitest";
import { detectAssistantLanguage, normalizeAssistantLanguage } from "@/lib/ai/language-detection";

describe("AI language detection", () => {
  it("normalizes configured language values", () => {
    expect(normalizeAssistantLanguage("es-CO")).toBe("es");
    expect(normalizeAssistantLanguage("english")).toBe("en");
    expect(normalizeAssistantLanguage("zh-CN")).toBe("zh");
  });

  it("detects Spanish, English and Simplified Chinese from user text", () => {
    expect(detectAssistantLanguage("Muestrame el ultimo Excel subido")).toBe("es");
    expect(detectAssistantLanguage("Find the latest supplier price")).toBe("en");
    expect(detectAssistantLanguage("帮我查找最新供应商价格")).toBe("zh");
  });
});
