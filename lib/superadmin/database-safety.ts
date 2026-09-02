import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  DATABASE_BACKUP_FORMAT,
  DATABASE_BACKUP_MAX_AGE_MS,
  DATABASE_SAFETY_BUSINESS_BUCKETS,
  DATABASE_SAFETY_CATALOG_VERSION
} from "@/lib/superadmin/database-safety-policy";
import {
  SafetyBundleWriter,
  appendStorageBackup,
  type StorageBackupSource
} from "@/lib/superadmin/database-safety-storage";

export type DatabaseBackupManifest = {
  backupVersion: 2;
  createdAt: string;
  expiresAt: string;
  databaseProject: string;
  schemaVersion: string;
  migrationVersion: string;
  dataVersion: number;
  storageVersion: number;
  catalogVersion: string;
  schemaInventoryHash: string;
  format: typeof DATABASE_BACKUP_FORMAT;
  sha256: string;
  sizeBytes: number;
  tableCount: number;
  fileName: string;
  evidenceHash: string;
  database: {
    format: "postgres-custom";
    schema: "public";
    sha256: string;
    sizeBytes: number;
    restoreListVerified: true;
    restoreVerified: true;
  };
  storage: {
    included: true;
    scope: "BUSINESS_DELETE";
    buckets: readonly string[];
    manifestSha256: string;
    objectCount: number;
    sizeBytes: number;
    recovery: "manifest-keys-retry";
    restoreProcedure: "extract-tar-and-upload-verified-object-manifest";
  };
  auth: {
    identities: "PRESERVED_NOT_INCLUDED";
  };
  system: {
    migrations: "PRESERVED_NOT_INCLUDED";
    securityAudit: "PRESERVED_NOT_INCLUDED";
  };
};

export type PreparedDatabaseBackup = {
  directory: string;
  filePath: string;
  databaseDumpPath: string;
  storageObjectKeys: string[];
  manifest: DatabaseBackupManifest;
};

type RetainedDatabaseBackup = PreparedDatabaseBackup & {
  manifestId: string;
  ownerId: string;
  expiresAt: number;
};

type BackupRegistry = Map<string, RetainedDatabaseBackup>;

const globalRegistry = globalThis as typeof globalThis & {
  __quiksolDatabaseBackups?: BackupRegistry;
};

function registry() {
  globalRegistry.__quiksolDatabaseBackups ??= new Map();
  return globalRegistry.__quiksolDatabaseBackups;
}

export class DatabaseBackupError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DatabaseBackupError";
  }
}

function timestampForFile(now: Date) {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

export function databaseBackupFileName(now = new Date()) {
  return `backup-respaldo-seguridad-electronic-parts-${timestampForFile(now)}.tar`;
}

function databaseDumpFileName(now = new Date()) {
  return `database-public-${timestampForFile(now)}.dump`;
}

export function databaseProjectName() {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return "unconfigured";
  try {
    const host = new URL(configured).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : host;
  } catch {
    return "invalid-project-url";
  }
}

function postgresEnv(databaseUrl: string, databaseOverride?: string) {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new DatabaseBackupError("BACKUP_DATABASE_URL_INVALID");
  }
  if (!parsed.hostname || !parsed.username) throw new DatabaseBackupError("BACKUP_DATABASE_URL_INVALID");
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: databaseOverride ?? decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    PGSSLMODE: parsed.searchParams.get("sslmode") ?? process.env.PGSSLMODE ?? "prefer"
  };
}

async function runPostgresTool(
  command: string,
  args: string[],
  timeoutMs: number,
  databaseUrl: string,
  databaseOverride?: string,
  extraEnv: Record<string, string | undefined> = {}
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: { ...postgresEnv(databaseUrl, databaseOverride), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderrSeen = false;
    const limit = 128 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {
      stderrSeen = true;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new DatabaseBackupError("POSTGRES_TOOL_TIMEOUT"));
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new DatabaseBackupError("BACKUP_UNAVAILABLE"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new DatabaseBackupError(stderrSeen ? "POSTGRES_TOOL_FAILED" : "POSTGRES_TOOL_EXITED"));
    });
  });
}

export async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  const input = createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function verifyPgRestoreList(filePath: string) {
  const databaseUrl = process.env.QUIKSOL_BACKUP_DATABASE_URL;
  if (!databaseUrl) throw new DatabaseBackupError("BACKUP_DATABASE_NOT_CONFIGURED");
  const pgRestore = process.env.QUIKSOL_PG_RESTORE_PATH || "pg_restore";
  const output = await runPostgresTool(pgRestore, ["--list", filePath], 5 * 60 * 1000, databaseUrl);
  if (!output.trim() || !/TABLE|SCHEMA|FUNCTION|SEQUENCE/i.test(output)) {
    throw new DatabaseBackupError("PG_RESTORE_LIST_INVALID");
  }
  return true;
}

export async function verifyPgRestoreRoundTrip(filePath: string, expectedTableCount: number) {
  const verificationUrl = process.env.QUIKSOL_BACKUP_VERIFY_DATABASE_URL;
  if (!verificationUrl) throw new DatabaseBackupError("RESTORE_VERIFY_DATABASE_NOT_CONFIGURED");
  const createdb = process.env.QUIKSOL_CREATEDB_PATH || "createdb";
  const dropdb = process.env.QUIKSOL_DROPDB_PATH || "dropdb";
  const pgRestore = process.env.QUIKSOL_PG_RESTORE_PATH || "pg_restore";
  const psql = process.env.QUIKSOL_PSQL_PATH || "psql";
  const databaseName = `quiksol_verify_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await runPostgresTool(createdb, [databaseName], 60_000, verificationUrl);
    created = true;
    const bootstrap = [
      "drop schema if exists public",
      "create schema if not exists auth",
      "create schema if not exists storage",
      "create schema if not exists supabase_migrations",
      "create table if not exists auth.users(id uuid primary key)",
      "create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$",
      "create or replace function auth.role() returns text language sql stable as $$ select current_user::text $$",
      "create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$",
      "do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end $$"
    ].join(";");
    await runPostgresTool(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-c", bootstrap], 60_000, verificationUrl, databaseName);
    await runPostgresTool(
      pgRestore,
      ["--exit-on-error", "--no-owner", "--no-privileges", "--section=pre-data", `--dbname=${databaseName}`, filePath],
      10 * 60 * 1000,
      verificationUrl,
      databaseName,
      { PGOPTIONS: "-c check_function_bodies=off" }
    );
    await runPostgresTool(
      psql,
      ["-X", "-v", "ON_ERROR_STOP=1", "-c", "create extension if not exists pgcrypto with schema public; create extension if not exists pg_trgm with schema public"],
      60_000,
      verificationUrl,
      databaseName
    );
    await runPostgresTool(
      pgRestore,
      ["--exit-on-error", "--no-owner", "--no-privileges", "--section=data", `--dbname=${databaseName}`, filePath],
      10 * 60 * 1000,
      verificationUrl,
      databaseName
    );
    await runPostgresTool(
      psql,
      ["-X", "-v", "ON_ERROR_STOP=1", "-c", "insert into auth.users(id) select id from public.profiles on conflict do nothing; insert into auth.users(id) select user_id from public.password_reset_codes where user_id is not null on conflict do nothing"],
      60_000,
      verificationUrl,
      databaseName
    );
    await runPostgresTool(
      pgRestore,
      ["--exit-on-error", "--no-owner", "--no-privileges", "--section=post-data", `--dbname=${databaseName}`, filePath],
      10 * 60 * 1000,
      verificationUrl,
      databaseName,
      { PGOPTIONS: "-c check_function_bodies=off" }
    );
    const output = await runPostgresTool(
      psql,
      ["-X", "-v", "ON_ERROR_STOP=1", "-Atc", "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')"],
      60_000,
      verificationUrl,
      databaseName
    );
    const restoredTables = Number(output.trim());
    if (!Number.isSafeInteger(restoredTables) || restoredTables < expectedTableCount) {
      throw new DatabaseBackupError("PG_RESTORE_STRUCTURE_INVALID");
    }
    return true;
  } catch (error) {
    if (error instanceof DatabaseBackupError) throw error;
    throw new DatabaseBackupError("PG_RESTORE_ROUNDTRIP_FAILED");
  } finally {
    if (created) {
      await runPostgresTool(dropdb, ["--if-exists", databaseName], 60_000, verificationUrl).catch(() => undefined);
    }
  }
}

export async function createDatabaseBackup(input: {
  schemaVersion: string;
  migrationVersion: string;
  dataVersion: number;
  storageVersion: number;
  catalogVersion: string;
  schemaInventoryHash: string;
  tableCount: number;
  storageSource: StorageBackupSource;
  now?: Date;
}): Promise<PreparedDatabaseBackup> {
  await cleanupOrphanedDatabaseBackups();
  if (input.catalogVersion !== DATABASE_SAFETY_CATALOG_VERSION) {
    throw new DatabaseBackupError("CATALOG_VERSION_MISMATCH");
  }
  const databaseUrl = process.env.QUIKSOL_BACKUP_DATABASE_URL;
  if (!databaseUrl) throw new DatabaseBackupError("BACKUP_DATABASE_NOT_CONFIGURED");
  const now = input.now ?? new Date();
  const directory = path.join(tmpdir(), `quiksol-db-backup-${randomUUID()}`);
  const fileName = databaseBackupFileName(now);
  const filePath = path.join(directory, fileName);
  const databaseDumpPath = path.join(directory, databaseDumpFileName(now));
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  let writer: SafetyBundleWriter | null = null;

  try {
    const pgDump = process.env.QUIKSOL_PG_DUMP_PATH || "pg_dump";
    await runPostgresTool(
      pgDump,
      ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", `--file=${databaseDumpPath}`],
      20 * 60 * 1000,
      databaseUrl
    );
    const databaseStats = await fs.stat(databaseDumpPath);
    if (!databaseStats.isFile() || databaseStats.size <= 0) throw new DatabaseBackupError("BACKUP_EMPTY");
    await fs.chmod(databaseDumpPath, 0o600);
    const databaseSha256 = await sha256File(databaseDumpPath);
    await verifyPgRestoreList(databaseDumpPath);
    await verifyPgRestoreRoundTrip(databaseDumpPath, input.tableCount);

    writer = await SafetyBundleWriter.create(filePath);
    await writer.addFile("database/public.dump", databaseDumpPath, databaseStats.size);
    const storage = await appendStorageBackup(writer, input.storageSource);
    const componentManifest = {
      backupVersion: 2,
      database: {
        schema: "public",
        format: "postgres-custom",
        sha256: databaseSha256,
        sizeBytes: databaseStats.size,
        restoreListVerified: true,
        restoreVerified: true
      },
      storage,
      auth: { identities: "PRESERVED_NOT_INCLUDED" },
      catalogVersion: input.catalogVersion,
      schemaInventoryHash: input.schemaInventoryHash,
      dataVersion: input.dataVersion,
      storageVersion: input.storageVersion
    };
    await writer.addBuffer("manifest/components.json", Buffer.from(JSON.stringify(componentManifest, null, 2)));
    const bundle = await writer.close();
    writer = null;
    await fs.chmod(filePath, 0o600);
    const evidenceHash = createHash("sha256").update(JSON.stringify({
      bundleSha256: bundle.sha256,
      databaseSha256,
      storageManifestSha256: storage.manifestSha256,
      dataVersion: input.dataVersion,
      storageVersion: input.storageVersion,
      catalogVersion: input.catalogVersion,
      schemaInventoryHash: input.schemaInventoryHash
    })).digest("hex");
    const expiresAt = new Date(now.getTime() + DATABASE_BACKUP_MAX_AGE_MS).toISOString();
    return {
      directory,
      filePath,
      databaseDumpPath,
      storageObjectKeys: storage.objects.map((object) => `${object.bucket}/${object.name}`),
      manifest: {
        backupVersion: 2,
        createdAt: now.toISOString(),
        expiresAt,
        databaseProject: databaseProjectName(),
        schemaVersion: input.schemaVersion,
        migrationVersion: input.migrationVersion,
        dataVersion: input.dataVersion,
        storageVersion: input.storageVersion,
        catalogVersion: input.catalogVersion,
        schemaInventoryHash: input.schemaInventoryHash,
        format: DATABASE_BACKUP_FORMAT,
        sha256: bundle.sha256,
        sizeBytes: bundle.sizeBytes,
        tableCount: input.tableCount,
        fileName,
        evidenceHash,
        database: {
          format: "postgres-custom",
          schema: "public",
          sha256: databaseSha256,
          sizeBytes: databaseStats.size,
          restoreListVerified: true,
          restoreVerified: true
        },
        storage: {
          included: true,
          scope: "BUSINESS_DELETE",
          buckets: DATABASE_SAFETY_BUSINESS_BUCKETS,
          manifestSha256: storage.manifestSha256,
          objectCount: storage.objectCount,
          sizeBytes: storage.sizeBytes,
          recovery: "manifest-keys-retry",
          restoreProcedure: storage.restoreProcedure
        },
        auth: { identities: "PRESERVED_NOT_INCLUDED" },
        system: {
          migrations: "PRESERVED_NOT_INCLUDED",
          securityAudit: "PRESERVED_NOT_INCLUDED"
        }
      }
    };
  } catch (error) {
    if (writer) await writer.abort().catch(() => undefined);
    await removePreparedDatabaseBackup({ directory, filePath }).catch(() => undefined);
    if (error instanceof DatabaseBackupError) throw error;
    const safeCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "BACKUP_GENERATION_FAILED";
    throw new DatabaseBackupError(safeCode);
  }
}

export async function removePreparedDatabaseBackup(backup: Pick<PreparedDatabaseBackup, "directory" | "filePath">) {
  const resolvedDirectory = path.resolve(backup.directory);
  const allowedRoot = path.resolve(tmpdir());
  if (!resolvedDirectory.startsWith(`${allowedRoot}${path.sep}`) || !path.basename(resolvedDirectory).startsWith("quiksol-db-backup-")) {
    throw new DatabaseBackupError("TEMP_PATH_REJECTED");
  }
  await fs.rm(resolvedDirectory, { recursive: true, force: true });
}

export async function cleanupExpiredDatabaseBackups(now = Date.now()) {
  const removals: Promise<void>[] = [];
  for (const [manifestId, backup] of registry()) {
    if (backup.expiresAt <= now) {
      registry().delete(manifestId);
      removals.push(removePreparedDatabaseBackup(backup).catch(() => undefined));
    }
  }
  await Promise.all(removals);
  await cleanupOrphanedDatabaseBackups(now);
}

export async function cleanupOrphanedDatabaseBackups(now = Date.now()) {
  const root = tmpdir();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("quiksol-db-backup-"))
    .map(async (entry) => {
      const directory = path.join(root, entry.name);
      const stats = await fs.stat(directory).catch(() => null);
      if (!stats || now - stats.mtimeMs <= DATABASE_BACKUP_MAX_AGE_MS + 5 * 60 * 1000) return;
      await removePreparedDatabaseBackup({ directory, filePath: "" }).catch(() => undefined);
    }));
}

export async function retainDatabaseBackup(manifestId: string, ownerId: string, backup: PreparedDatabaseBackup) {
  await cleanupExpiredDatabaseBackups();
  registry().set(manifestId, {
    ...backup,
    manifestId,
    ownerId,
    expiresAt: Date.now() + DATABASE_BACKUP_MAX_AGE_MS
  });
}

export async function getRetainedDatabaseBackup(manifestId: string, ownerId: string) {
  await cleanupExpiredDatabaseBackups();
  const backup = registry().get(manifestId);
  if (!backup || backup.ownerId !== ownerId) return null;
  return backup;
}

export async function consumeRetainedDatabaseBackup(manifestId: string, ownerId: string) {
  const backup = await getRetainedDatabaseBackup(manifestId, ownerId);
  if (!backup) return null;
  registry().delete(manifestId);
  return backup;
}

export async function discardRetainedDatabaseBackup(manifestId: string, ownerId: string) {
  const backup = await consumeRetainedDatabaseBackup(manifestId, ownerId);
  if (!backup) return false;
  await removePreparedDatabaseBackup(backup).catch(() => undefined);
  return true;
}

export async function verifyRetainedDatabaseBackup(manifestId: string, ownerId: string) {
  const backup = await getRetainedDatabaseBackup(manifestId, ownerId);
  if (!backup) throw new DatabaseBackupError("BACKUP_TEMP_FILE_MISSING");
  const stats = await fs.stat(backup.filePath);
  if (stats.size !== backup.manifest.sizeBytes || stats.size <= 0) throw new DatabaseBackupError("BACKUP_SIZE_MISMATCH");
  const sha256 = await sha256File(backup.filePath);
  if (sha256 !== backup.manifest.sha256) throw new DatabaseBackupError("CHECKSUM_MISMATCH");
  const databaseStats = await fs.stat(backup.databaseDumpPath);
  if (databaseStats.size !== backup.manifest.database.sizeBytes) throw new DatabaseBackupError("DATABASE_BACKUP_SIZE_MISMATCH");
  const databaseSha256 = await sha256File(backup.databaseDumpPath);
  if (databaseSha256 !== backup.manifest.database.sha256) throw new DatabaseBackupError("DATABASE_CHECKSUM_MISMATCH");
  await verifyPgRestoreList(backup.databaseDumpPath);
  await verifyPgRestoreRoundTrip(backup.databaseDumpPath, backup.manifest.tableCount);
  return backup;
}

export function nodeFileStream(filePath: string) {
  return createReadStream(filePath) as Readable;
}

export function webFileStream(stream: Readable) {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export function backupManifestJson(manifest: DatabaseBackupManifest) {
  return JSON.stringify(manifest, null, 2);
}
