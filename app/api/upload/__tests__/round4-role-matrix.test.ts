import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Ronda 4 import API role matrix", () => {
  it.each([
    "app/api/upload/initiate/route.ts",
    "app/api/upload/finalize/route.ts",
    "app/api/upload/jobs/[id]/route.ts",
    "app/api/upload/jobs/[id]/cancel/route.ts",
    "app/api/upload/jobs/[id]/retry/route.ts"
  ])("requires an active authenticated profile for %s", (route) => {
    const code = source(route);
    expect(code).toContain("getAuthContext(request)");
    expect(code).toContain("context instanceof NextResponse");
  });

  it.each([
    "app/api/admin/imports/jobs/[id]/cancel/route.ts",
    "app/api/admin/imports/jobs/[id]/retry/route.ts",
    "app/api/admin/imports/jobs/[id]/safe-finalize/route.ts"
  ])("keeps admin import operations behind requireAdmin for %s", (route) => {
    expect(source(route)).toContain("requireAdmin(request)");
  });

  it.each([
    "app/api/superadmin/jobs/[id]/cancel/route.ts",
    "app/api/superadmin/jobs/[id]/retry/route.ts",
    "app/api/superadmin/jobs/[id]/safe-finalize/route.ts"
  ])("keeps superadmin operations exact-role and same-origin for %s", (route) => {
    const code = source(route);
    expect(code).toContain("assertCriticalSameOrigin(request)");
    expect(code).toContain("requireSuperadmin(request)");
  });

  it("uses backend actor checks without granting lifecycle RPCs to browser roles", () => {
    const migration = source("supabase/migrations/20260823120000_harden_import_job_pipeline.sql");
    expect(migration).toContain("profile.id = input_owner_id or profile.role in ('admin','super_admin_dev')");
    expect(migration).toContain("from public,anon,authenticated");
    expect(migration).not.toMatch(/grant execute on function public\.(?:create_import_upload_v2|finalize_import_upload_v2|request_import_job_cancel_v2|request_import_job_retry_v2)[^;]+to (?:anon|authenticated)/);
  });
});
