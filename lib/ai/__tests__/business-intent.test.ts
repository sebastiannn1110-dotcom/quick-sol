import { describe, expect, it } from "vitest";
import {
  detectExplicitBusinessIntent,
  isEmployeePerformanceFollowUp
} from "@/lib/ai/business-intent";

describe("business intent concepts", () => {
  it.each([
    ["quien es el mejor vendedor", "employee_quote_metrics"],
    ["de los empleados en la base de datos quien tiene las mejores metricas", "employee_quote_metrics"],
    ["quien tiene mayor conversion", "employee_quote_metrics"],
    ["cuales son los 5 mejores vendedores", "employee_quote_metrics"],
    ["compara Maya con Daniel", "employee_quote_metrics"],
    ["Compara a Maya con Daniel", "employee_quote_metrics"],
    ["¿Cómo está funcionando el equipo de ventas?", "employee_quote_metrics"],
    ["cuantas cotizaciones aceptadas tenemos", "employee_quote_metrics"],
    ["who is the best salesperson", "employee_quote_metrics"],
    ["show me the top 5 sellers", "employee_quote_metrics"],
    ["who has the highest conversion rate", "employee_quote_metrics"],
    ["Who performs better, Maya or Daniel?", "employee_quote_metrics"],
    ["谁是表现最好的销售人员？", "employee_quote_metrics"],
    ["谁的转化率最高？", "employee_quote_metrics"],
    ["比较 Maya 和 Daniel", "employee_quote_metrics"],
    ["cuantos RFQs nuevos tenemos", "rfq_summary"],
    ["muestrame los RFQs sin asignar", "rfq_summary"],
    ["busca Amazon-demo", "client_lookup"],
    ["que RFQs tiene Microsoft-demo", "client_lookup"]
  ] as const)("routes %s to %s", (question, expected) => {
    expect(detectExplicitBusinessIntent(question)).toBe(expected);
  });

  it("keeps a truly ambiguous best-question unresolved", () => {
    expect(detectExplicitBusinessIntent("quien es el mejor")).toBeNull();
  });

  it.each([
    "que oportunidades tienen alta confianza",
    "compara el stock del MPN ABC123",
    "muestrame costos y margen",
    "What offers do we have for QKS-DEMO-MCU-042?"
  ])("does not steal unrelated or sensitive routing: %s", (question) => {
    expect(detectExplicitBusinessIntent(question)).toBeNull();
  });

  it("uses immediate conversation history for ordinal ranking follow-ups", () => {
    const history = [
      { role: "user", content: "quien es el mejor vendedor" },
      { role: "assistant", content: "Maya lidera el ranking autorizado." }
    ];
    expect(isEmployeePerformanceFollowUp("y el segundo?", history)).toBe(true);
    expect(isEmployeePerformanceFollowUp("and the next four?", history)).toBe(true);
    expect(isEmployeePerformanceFollowUp("y el segundo?", [
      { role: "user", content: "cual es el mejor" }
    ])).toBe(false);
    expect(isEmployeePerformanceFollowUp("y el segundo?", [
      { role: "user", content: "quien es el mejor vendedor" },
      { role: "assistant", content: "Maya lidera." },
      { role: "user", content: "busca MPN ABC123" },
      { role: "assistant", content: "Encontré ABC123." }
    ])).toBe(false);
  });
});
