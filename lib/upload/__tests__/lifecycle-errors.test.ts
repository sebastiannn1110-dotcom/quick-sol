import { describe, expect, it } from "vitest";
import { importLifecycleError } from "@/lib/upload/lifecycle-errors";

describe("import lifecycle error mapping", () => {
  it.each([
    ["IMPORT_JOB_NOT_FOUND", 404],
    ["IMPORT_JOB_ACCESS_DENIED", 403],
    ["IMPORT_PROVENANCE_INVALID", 403],
    ["IMPORT_CANCEL_STATE_INVALID", 409],
    ["IMPORT_RETRY_STATE_INVALID", 409],
    ["IMPORT_STORAGE_OBJECT_MISSING", 409],
    ["unexpected", 500]
  ])("maps %s without exposing backend diagnostics", (message, status) => {
    const result = importLifecycleError({ code: "P0001", message }, "Safe fallback.");
    expect(result.status).toBe(status);
    expect(result.error).not.toContain("P0001");
    if (status === 500) expect(result.error).toBe("Safe fallback.");
  });
});
