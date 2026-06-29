import { describe, expect, it } from "vitest";
import { isMissingSchemaError, missingMigrationMessage, schemaErrorMetadata } from "@/lib/supabase/schema-errors";

describe("Supabase schema error helpers", () => {
  it("detects missing tables, functions and columns", () => {
    expect(isMissingSchemaError({ code: "PGRST205", message: "Could not find the table" })).toBe(true);
    expect(isMissingSchemaError({ code: "PGRST202", message: "Could not find the function" })).toBe(true);
    expect(isMissingSchemaError({ code: "42703", message: "column profiles.avatar_path does not exist" })).toBe(true);
    expect(isMissingSchemaError({ code: "23505", message: "duplicate key" })).toBe(false);
  });

  it("builds safe operator-facing migration details", () => {
    const metadata = schemaErrorMetadata(
      { code: "PGRST205", message: "Could not find the table", hint: "Perhaps you meant another table" },
      "20260629000000_enterprise_mvp.sql"
    );

    expect(metadata).toMatchObject({
      requiredMigration: "20260629000000_enterprise_mvp.sql",
      code: "PGRST205"
    });
    expect(missingMigrationMessage("chat interno")).toContain("chat interno");
  });
});
