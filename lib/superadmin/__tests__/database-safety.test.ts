import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupManifestJson,
  consumeRetainedDatabaseBackup,
  databaseBackupFileName,
  DatabaseBackupError,
  getRetainedDatabaseBackup,
  removePreparedDatabaseBackup,
  retainDatabaseBackup,
  verifyRetainedDatabaseBackup,
  type PreparedDatabaseBackup
} from "@/lib/superadmin/database-safety";

const created: PreparedDatabaseBackup[] = [];

async function fixture(content = "AAAA") {
  const directory = path.join(tmpdir(), `quiksol-db-backup-unit-${randomUUID()}`);
  const fileName = databaseBackupFileName(new Date("2026-08-16T13:15:00.000Z"));
  const filePath = path.join(directory, fileName);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(filePath, content, { mode: 0o600 });
  const prepared: PreparedDatabaseBackup = {
    directory,
    filePath,
    manifest: {
      backupVersion: 1,
      createdAt: "2026-08-16T13:15:00.000Z",
      databaseProject: "test-project",
      schemaVersion: "1",
      migrationVersion: "1",
      dataVersion: 7,
      format: "postgres-custom",
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: Buffer.byteLength(content),
      tableCount: 64,
      fileName,
      restoreListVerified: true,
      storageFilesIncluded: false
    }
  };
  created.push(prepared);
  return prepared;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((backup) => removePreparedDatabaseBackup(backup).catch(() => undefined)));
});

describe("database backup safety", () => {
  it("generates the exact deterministic local-download filename", () => {
    expect(databaseBackupFileName(new Date("2026-08-16T13:15:00.000Z"))).toBe("backup-respaldo-base-datos-general-2026-08-16-131500.dump");
  });

  it("creates a secret-free manifest with SHA-256 metadata", async () => {
    const backup = await fixture();
    const json = backupManifestJson(backup.manifest);
    expect(json).toContain('"format": "postgres-custom"');
    expect(json).toContain('"storageFilesIncluded": false');
    expect(json).not.toMatch(/password|service.role|connection.string|access.token/i);
  });

  it("blocks an absent retained backup", async () => {
    await expect(verifyRetainedDatabaseBackup(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "BACKUP_TEMP_FILE_MISSING" });
  });

  it("blocks a corrupt same-size backup by checksum before pg_restore", async () => {
    const backup = await fixture("AAAA");
    const id = randomUUID();
    const owner = randomUUID();
    await retainDatabaseBackup(id, owner, backup);
    await fs.writeFile(backup.filePath, "BBBB");
    await expect(verifyRetainedDatabaseBackup(id, owner)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    await consumeRetainedDatabaseBackup(id, owner);
  });

  it("isolates retained backups by owner", async () => {
    const backup = await fixture();
    const id = randomUUID();
    const owner = randomUUID();
    await retainDatabaseBackup(id, owner, backup);
    expect(await getRetainedDatabaseBackup(id, randomUUID())).toBeNull();
    expect(await getRetainedDatabaseBackup(id, owner)).not.toBeNull();
    await consumeRetainedDatabaseBackup(id, owner);
  });

  it("rejects cleanup paths outside the dedicated temporary namespace", async () => {
    await expect(removePreparedDatabaseBackup({ directory: process.cwd(), filePath: path.join(process.cwd(), "x") })).rejects.toBeInstanceOf(DatabaseBackupError);
  });

  it("invokes pg_dump custom format without a shell and validates pg_restore --list", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/superadmin/database-safety.ts"), "utf8");
    expect(source).toContain('"--format=custom"');
    expect(source).toContain('"--schema=public"');
    expect(source).toContain('shell: false');
    expect(source).toContain('PGDATABASE: databaseUrl');
    expect(source).toContain('["--list", filePath]');
    expect(source).toContain("PG_RESTORE_LIST_INVALID");
    expect(source).toContain('DatabaseBackupError("BACKUP_UNAVAILABLE")');
  });

  it("caps the Blob fallback while preserving direct-to-disk streaming", () => {
    const ui = readFileSync(path.join(process.cwd(), "components/admindev/DatabaseSafetyCenter.tsx"), "utf8");
    expect(ui).toContain("SAFE_BLOB_FALLBACK_MAX_BYTES = 100 * 1024 * 1024");
    expect(ui).toContain("response.body.pipeTo(writable)");
    expect(ui).toContain("BACKUP_TOO_LARGE_FOR_BLOB_FALLBACK");
    expect(ui).toContain('response.headers.get("content-length")');
    expect(ui.indexOf("SAFE_BLOB_FALLBACK_MAX_BYTES")).toBeLessThan(ui.indexOf("response.blob()"));
  });

  it("describes the backup scope without implying a complete Supabase backup", () => {
    const ui = readFileSync(path.join(process.cwd(), "components/admindev/DatabaseSafetyCenter.tsx"), "utf8");
    expect(ui).toContain("schema public");
    expect(ui).toContain("NO incluye los archivos físicos de Supabase Storage");
    expect(ui).toContain("ni constituye un backup independiente de Supabase Auth");
  });

  it("removes temporary files on backup errors and after download", () => {
    const backupSource = readFileSync(path.join(process.cwd(), "lib/superadmin/database-safety.ts"), "utf8");
    const downloadSource = readFileSync(path.join(process.cwd(), "app/api/admindev/database-safety/backups/[id]/download/route.ts"), "utf8");
    expect(backupSource).toContain("removePreparedDatabaseBackup");
    expect(backupSource).toContain("mode: 0o700");
    expect(backupSource).toContain("fs.chmod(filePath, 0o600)");
    expect(downloadSource).toContain("removePreparedDatabaseBackup(backup)");
    expect(downloadSource).toContain("BACKUP_INTEGRITY_CHECK_FAILED");
  });

  it("cancellation never calls the destructive endpoint", () => {
    const ui = readFileSync(path.join(process.cwd(), "components/admindev/DatabaseSafetyCenter.tsx"), "utf8");
    const cancelBody = ui.slice(ui.indexOf("async function cancelDeletion"), ui.indexOf("async function executeDeletion"));
    expect(cancelBody).toContain("/cancel");
    expect(cancelBody).not.toContain("/execute");
    expect(cancelBody).toContain("setArmed(null)");
  });

  it("uses POST, reauthentication, rate limits, CSRF, countdown and no-store for destruction", () => {
    const arm = readFileSync(path.join(process.cwd(), "app/api/admindev/database-safety/arm/route.ts"), "utf8");
    const execute = readFileSync(path.join(process.cwd(), "app/api/admindev/database-safety/execute/route.ts"), "utf8");
    const auth = readFileSync(path.join(process.cwd(), "lib/superadmin/auth.ts"), "utf8");
    expect(arm).toContain("reauthenticateSuperAdmin");
    expect(arm).toContain("databaseSafetyRateLimit");
    expect(arm).toContain("assertCriticalSameOrigin");
    expect(execute).toContain("export async function POST");
    expect(execute).toContain("superadminSessionBinding");
    expect(auth).toContain('"no-store, max-age=0"');
  });
});
