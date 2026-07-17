import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("admin uploads presentation UI", () => {
  it("keeps /admin/uploads limited to Excel actions", () => {
    const table = source("components/AdminUploadsTable.tsx");

    expect(table).toContain("history.openExcel");
    expect(table).toContain("Download Excel");
    expect(table).not.toContain("View records");
    expect(table).not.toContain("View errors");
    expect(table).not.toContain("View trace");
    expect(table).not.toContain("View diagnostics");
    expect(table).not.toContain("Safe finalize");
    expect(table).not.toContain("Retry technical failure");
    expect(table).not.toContain("Cancel job");
  });
});
