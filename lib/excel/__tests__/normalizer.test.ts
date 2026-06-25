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

  it("maps MPN variants and falls back to MPN Quoted", () => {
    expect(normalizeRow({ "P/N": "PN-100" }).columns.mpn).toBe("PN-100");
    expect(normalizeRow({ "Mfr Part Number": "MFR-200" }).columns.mpn).toBe("MFR-200");
    expect(normalizeRow({ Component: "CMP-300" }).columns.mpn).toBe("CMP-300");
    expect(normalizeRow({ "MPN Quoted": "QT-400" }).columns.mpn).toBe("QT-400");
  });

  it("preserves extra columns without creating import errors", () => {
    const result = normalizeRow({
      Customer: "Sanmina",
      Supplier: "Arrow",
      MPN: "ABC123",
      QTY: 100,
      Cost: 1,
      Price: 1.25,
      "GP rate": 0.2,
      Region: "North America",
      Status: "Clean",
      Category: "Sales Margin"
    });

    expect(result.normalizedData.region).toBe("North America");
    expect(result.normalizedData.status).toBe("Clean");
    expect(result.normalizedData.category).toBe("Sales Margin");
    expect(result.issues).toEqual([]);
  });
});
