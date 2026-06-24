import { describe, expect, it } from "vitest";
import { detectCategory } from "@/lib/excel/category-detector";

describe("detectCategory", () => {
  it("detects supplier offers", () => {
    const result = detectCategory([
      "Supplier Name",
      "Best Price Offered",
      "MPN Quoted",
      "Manufacturer Quoted",
      "MOQ",
      "SPQ"
    ]);

    expect(result.category).toBe("Supplier Offers");
  });

  it("falls back to Generic when confidence is low", () => {
    const result = detectCategory(["Random A", "Random B"]);
    expect(result.category).toBe("Generic");
  });
});
