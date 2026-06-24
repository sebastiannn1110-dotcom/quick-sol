import { describe, expect, it } from "vitest";
import { normalizeRow } from "@/lib/excel/normalizer";

describe("normalizeRow", () => {
  it("maps Quiksol sales margin columns", () => {
    const result = normalizeRow({
      Cliente: "Sanmina",
      Supplier: "Arrow",
      MPN: "ABC123",
      QTY: "1,000",
      Cost: "$2.50",
      Price: "$3.25",
      "GP rate": "23%",
      Comision: "10"
    });

    expect(result.columns.customer).toBe("Sanmina");
    expect(result.columns.supplier).toBe("Arrow");
    expect(result.columns.mpn).toBe("ABC123");
    expect(result.columns.qty).toBe(1000);
    expect(result.columns.cost).toBe(2.5);
    expect(result.columns.price).toBe(3.25);
    expect(result.columns.gp_rate).toBeCloseTo(0.23);
    expect(result.columns.commission).toBe(10);
  });

  it("captures formula errors", () => {
    const result = normalizeRow({
      "Total Price": "#VALUE!"
    });

    expect(result.issues.some((issue) => issue.errorType === "formula_error")).toBe(true);
  });
});
