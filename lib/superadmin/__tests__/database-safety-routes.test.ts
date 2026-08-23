import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routes = [
  "app/api/admindev/database-safety/status/route.ts",
  "app/api/admindev/database-safety/dry-run/route.ts",
  "app/api/admindev/database-safety/backups/route.ts",
  "app/api/admindev/database-safety/backups/[id]/verify/route.ts",
  "app/api/admindev/database-safety/backups/[id]/download/route.ts",
  "app/api/admindev/database-safety/backups/[id]/manifest/route.ts",
  "app/api/admindev/database-safety/arm/route.ts",
  "app/api/admindev/database-safety/operations/[id]/cancel/route.ts",
  "app/api/admindev/database-safety/execute/route.ts"
] as const;

const mutating = routes.filter((route) => !route.endsWith("status/route.ts") && !route.endsWith("manifest/route.ts"));
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Database Safety API trust boundary", () => {
  it.each(routes)("protects %s through the exclusive Super Admin Dev session guard", (route) => {
    expect(source(route)).toContain("requireSuperadmin(request)");
  });

  it.each(mutating)("requires same-origin on %s", (route) => {
    expect(source(route)).toContain("assertCriticalSameOrigin(request)");
  });

  it("uses backend-only v2 RPCs and never invokes caller-controlled destructive RPCs", () => {
    const corpus = routes.map(source).join("\n");
    for (const rpc of [
      "begin_database_backup_manifest_v2",
      "record_database_backup_created_v2",
      "verify_database_backup_manifest_v2",
      "mark_database_backup_downloaded_v2",
      "arm_database_destruction_v2",
      "execute_database_business_purge_v2",
      "claim_database_storage_cleanup_v2",
      "finish_database_storage_cleanup_v2"
    ]) expect(corpus).toContain(rpc);
    expect(corpus).not.toMatch(/context\.supabase\.rpc\("(?:register_database_backup_manifest|arm_database_destruction|execute_database_business_purge)"/);
  });

  it("keeps reauthentication, session binding, a CSPRNG challenge and both kill-switch authorities", () => {
    const arm = source("app/api/admindev/database-safety/arm/route.ts");
    const execute = source("app/api/admindev/database-safety/execute/route.ts");
    const auth = source("lib/superadmin/auth.ts");
    const migration = source("supabase/migrations/20260822140000_harden_database_safety_backend_evidence.sql");
    expect(arm).toContain("reauthenticateSuperAdmin");
    expect(arm).toContain("createDestructionChallenge");
    expect(auth).toContain("randomBytes(32).toString");
    expect(execute).toContain("databaseSafetyDeleteEnabled()");
    expect(migration).toContain("delete_enabled boolean not null default false");
    expect(migration).toContain("DELETE_KILL_SWITCH_DISABLED");
  });

  it("never accepts manifest hashes, restore evidence or catalog versions from browser request bodies", () => {
    const backup = source("app/api/admindev/database-safety/backups/route.ts");
    const verify = source("app/api/admindev/database-safety/backups/[id]/verify/route.ts");
    expect(backup).not.toContain("request.json");
    expect(verify).not.toContain("request.json");
    expect(backup).toContain("manifest.database.sha256");
    expect(backup).toContain("manifest.storage.manifestSha256");
    expect(backup).toContain("manifest.evidenceHash");
  });

  it("defines a recoverable, exact-key Storage saga after the transactional database purge", () => {
    const execute = source("app/api/admindev/database-safety/execute/route.ts");
    const storage = source("lib/superadmin/database-safety-storage.ts");
    expect(execute.indexOf('rpc("execute_database_business_purge_v2"')).toBeLessThan(execute.indexOf("await purgeBusinessStorage("));
    expect(execute).toContain("recoveryPending: true");
    expect(storage).toContain("Retry exact manifest keys; never delete newly discovered objects.");
    expect(storage).toContain("offset += 100");
  });
});
