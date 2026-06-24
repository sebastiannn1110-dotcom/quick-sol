import { describe, expect, it } from "vitest";
import { detectHeaderRow } from "@/lib/excel/header-detector";

describe("detectHeaderRow", () => {
  it("detects headers below logo and blank rows", () => {
    const result = detectHeaderRow([
      ["Quiksol logo", null, null],
      [null, null, null],
      ["Line ID", "CUSTOMER", "REQ QTY", "Potential_Amount_USD"],
      ["L-1", "Acme", "100", "1200"]
    ]);

    expect(result.headerRowIndex).toBe(2);
    expect(result.recognizedColumns).toContain("customer");
    expect(result.confidence).toBeGreaterThan(0.3);
  });
});
