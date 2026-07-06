import { describe, expect, it } from "vitest";
import { canRequestCompanyWideData, mustForceOwnerScope, questionRequestsCompanyWideData } from "@/lib/ai/ai-permissions";

describe("AI database permissions", () => {
  it("only grants company-wide intent to admins", () => {
    expect(canRequestCompanyWideData("admin")).toBe(true);
    expect(canRequestCompanyWideData("manager")).toBe(false);
    expect(canRequestCompanyWideData("employee")).toBe(false);
  });

  it("forces employees to their own rows", () => {
    expect(mustForceOwnerScope("employee")).toBe(true);
    expect(mustForceOwnerScope("manager")).toBe(false);
  });

  it("detects explicit global questions", () => {
    expect(questionRequestsCompanyWideData("Resume todos los registros de la empresa")).toBe(true);
    expect(questionRequestsCompanyWideData("显示所有记录")).toBe(true);
    expect(questionRequestsCompanyWideData("Resume mis registros")).toBe(false);
  });
});
