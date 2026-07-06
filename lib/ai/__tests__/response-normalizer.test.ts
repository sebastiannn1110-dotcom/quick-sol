import { describe, expect, it } from "vitest";
import { normalizeSpeechResponse, normalizeTextResponse } from "@/lib/ai/response-normalizer";

describe("AI response normalizer", () => {
  it("keeps useful text formatting for screen responses", () => {
    expect(normalizeTextResponse("Hola  \n\n\n- proveedor A")).toBe("Hola\n\n- proveedor A");
  });

  it("removes heavy markdown, tables, urls and ids from speech", () => {
    const speech = normalizeSpeechResponse(`
      ## Resultado
      | id | proveedor |
      | --- | --- |
      | 9d6e7b88-0000-4000-8000-123456789abc | Supplier A |
      - Ver https://example.com/a/very/long/path/that/should/not/be/read
      **Supplier A** tiene mejor precio.
    `);

    expect(speech).not.toContain("|");
    expect(speech).not.toContain("https://");
    expect(speech).not.toContain("9d6e7b88");
    expect(speech).toContain("Supplier A tiene mejor precio");
  });
});
