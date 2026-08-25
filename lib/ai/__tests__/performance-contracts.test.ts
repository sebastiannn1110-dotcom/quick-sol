import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("AI read-only and performance contracts", () => {
  it("keeps Opportunity Finder on persisted V2 results without matcher execution", () => {
    const tool = source("lib/ai/opportunity-finder-tool.ts");
    expect(tool).toContain('.from("opportunity_finder_jobs")');
    expect(tool).toContain('.from("opportunity_finder_results")');
    expect(tool).toContain("OPPORTUNITY_FINDER_PIPELINE_VERSION");
    expect(tool).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(tool).not.toContain("runOpportunity");
    expect(tool).not.toContain("matchOpportunity");
  });

  it("uses one bounded, field-selected stock query for AI", () => {
    const sourceText = source("lib/stock-needs/data-source.ts");
    const tools = source("lib/ai/database-tools.ts");
    expect(sourceText).toContain("AI_SAFE_BUSINESS_RECORD_SELECT");
    expect(sourceText).toContain("loadRecordsInOneQuery");
    expect(tools).toContain("includeRawData: false");
    expect(tools).toContain("singleQueryLimit: 2500");
    const aiSelect = sourceText.match(/AI_SAFE_BUSINESS_RECORD_SELECT[^=]*=\s*"([^"]+)"/)?.[1] ?? "";
    expect(aiSelect).not.toContain("raw_data");
    expect(aiSelect).not.toContain("normalized_data");
    expect(aiSelect).not.toContain("original_file_name");
  });

  it("does not permit writes from assistant data tools", () => {
    const tools = source("lib/ai/database-tools.ts");
    expect(tools).toContain('.rpc("get_dashboard_summary_v1")');
    const withoutAllowlistedReadRpc = tools.replace('.rpc("get_dashboard_summary_v1")', "");
    expect(withoutAllowlistedReadRpc).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(tools).not.toContain("ensureUploadStructureProfile");
  });
});
