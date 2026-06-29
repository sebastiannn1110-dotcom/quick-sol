import { describe, expect, it } from "vitest";
import { ANALYTICS_PROFILE_SELECT, ANALYTICS_RECORD_SELECT, ANALYTICS_UPLOAD_SELECT } from "@/lib/platform/query-columns";

describe("analytics query columns", () => {
  it("keeps analytics profile select compatible with older profile schemas", () => {
    expect(ANALYTICS_PROFILE_SELECT.split(",")).toEqual([
      "id",
      "full_name",
      "email",
      "role",
      "department",
      "region",
      "is_active",
      "created_at",
      "updated_at"
    ]);
    expect(ANALYTICS_PROFILE_SELECT).not.toContain("avatar_path");
  });

  it("does not request heavy raw record payloads for dashboard analytics", () => {
    expect(ANALYTICS_RECORD_SELECT).not.toContain("raw_data");
    expect(ANALYTICS_RECORD_SELECT).not.toContain("searchable_text");
    expect(ANALYTICS_UPLOAD_SELECT).toContain("data_quality_score");
  });
});
