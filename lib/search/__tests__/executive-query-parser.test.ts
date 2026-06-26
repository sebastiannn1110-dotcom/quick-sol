import { describe, expect, it } from "vitest";
import { parseExecutiveQuery } from "@/lib/search/executive-query-parser";

const fixedDate = new Date("2026-06-25T12:00:00Z");

describe("parseExecutiveQuery", () => {
  it("detects customer and GP greater than 25 percent", () => {
    const parsed = parseExecutiveQuery("Muestrame todos los MPN de Tesla con GP mayor al 25%", fixedDate);

    expect(parsed.filters.customer).toBe("Tesla");
    expect(parsed.filters.gpRate).toMatchObject({ operator: "gt", value: 0.25 });
    expect(parsed.detectedTerms).toContain("gp_rate");
  });

  it("detects price comparison intent and MPN", () => {
    const parsed = parseExecutiveQuery("Que proveedor tiene mejor precio para SN74LVC2G74?", fixedDate);

    expect(parsed.intent).toBe("price_comparison");
    expect(parsed.filters.mpn).toBe("SN74LVC2G74");
  });

  it("detects employee and current week", () => {
    const parsed = parseExecutiveQuery("Que subio Luis esta semana?", fixedDate);

    expect(parsed.intent).toBe("uploads");
    expect(parsed.filters.employee).toBe("Luis");
    expect(parsed.filters.dateRange?.preset).toBe("current_week");
  });

  it("detects commission import errors", () => {
    const parsed = parseExecutiveQuery("Donde hay errores de comision?", fixedDate);

    expect(parsed.intent).toBe("errors");
    expect(parsed.filters.errorField).toBe("commission");
    expect(parsed.filters.hasErrors).toBe(true);
  });
});
