import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("API sensitive field permission integration", () => {
  it("redacts records and search API responses by role", () => {
    expect(source("app/api/records/route.ts")).toContain("redactSensitiveFieldsForRole");
    expect(source("app/api/records/route.ts")).toContain("permissionScopedFilters");
    expect(source("app/api/search/route.ts")).toContain("redactSensitiveFieldsForRole");
  });

  it("keeps admin records and stock-needs responses behind the shared redactor", () => {
    expect(source("app/api/admin/records/route.ts")).toContain("redactSensitiveFieldsForRole");
    expect(source("app/api/admin/stock-needs/route.ts")).toContain("redactSensitiveFieldsForRole");
    expect(source("lib/stock-needs/stock-needs.ts")).not.toContain("UNIT COST:");
  });

  it("protects AI tool payloads and LLM input from sensitive fields", () => {
    expect(source("lib/ai/database-tools.ts")).toContain("redactSensitiveFieldsForRole");
    expect(source("lib/ai/database-tools.ts")).toContain("SENSITIVE_DATA_DENIED_MESSAGE");
    expect(source("lib/ai/assistantCore.ts")).toContain("redactSensitiveFieldsForLlm");
  });
});
