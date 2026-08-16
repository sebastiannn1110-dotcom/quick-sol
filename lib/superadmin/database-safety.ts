import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { DATABASE_BACKUP_FORMAT, DATABASE_BACKUP_MAX_AGE_MS } from "@/lib/superadmin/database-safety-policy";

export type DatabaseBackupManifest = {
  backupVersion: 1;
  createdAt: string;
  databaseProject: string;
  schemaVersion: string;
  migrationVersion: string;
  dataVersion: number;
  format: typeof DATABASE_BACKUP_FORMAT;
  sha256: string;
  sizeBytes: number;
  tableCount: number;
  fileName: string;
  restoreListVerified: true;
  storageFilesIncluded: false;
};

export type PreparedDatabaseBackup = {
  directory: string;
  filePath: string;
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
  return `backup-respaldo-base-datos-general-${timestampForFile(now)}.dump`;
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

async function runPostgresTool(command: string, args: string[], timeoutMs: number) {
  const databaseUrl = process.env.QUIKSOL_BACKUP_DATABASE_URL;
  if (!databaseUrl) throw new DatabaseBackupError("BACKUP_DATABASE_NOT_CONFIGURED");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, PGDATABASE: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const limit = 128 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < limit) stderr += chunk.toString("utf8");
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
      else reject(new DatabaseBackupError(stderr ? "POSTGRES_TOOL_FAILED" : "POSTGRES_TOOL_EXITED"));
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
  const pgRestore = process.env.QUIKSOL_PG_RESTORE_PATH || "pg_restore";
  const output = await runPostgresTool(pgRestore, ["--list", filePath], 5 * 60 * 1000);
  if (!output.trim() || !/TABLE|SCHEMA|FUNCTION|SEQUENCE/i.test(output)) {
    throw new DatabaseBackupError("PG_RESTORE_LIST_INVALID");
  }
  return true;
}

export async function createDatabaseBackup(input: {
  schemaVersion: string;
  migrationVersion: string;
  dataVersion: number;
  tableCount: number;
  now?: Date;
}): Promise<PreparedDatabaseBackup> {
  await cleanupOrphanedDatabaseBackups();
  const now = input.now ?? new Date();
  const directory = path.join(tmpdir(), `quiksol-db-backup-${randomUUID()}`);
  const fileName = databaseBackupFileName(now);
  const filePath = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });

  try {
    const pgDump = process.env.QUIKSOL_PG_DUMP_PATH || "pg_dump";
    await runPostgresTool(
      pgDump,
      ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", `--file=${filePath}`],
      20 * 60 * 1000
    );
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size <= 0) throw new DatabaseBackupError("BACKUP_EMPTY");
    await fs.chmod(filePath, 0o600);
    const sha256 = await sha256File(filePath);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DatabaseBackupError("CHECKSUM_FAILED");
    await verifyPgRestoreList(filePath);

    return {
      directory,
      filePath,
      manifest: {
        backupVersion: 1,
        createdAt: now.toISOString(),
        databaseProject: databaseProjectName(),
        schemaVersion: input.schemaVersion,
        migrationVersion: input.migrationVersion,
        dataVersion: input.dataVersion,
        format: DATABASE_BACKUP_FORMAT,
        sha256,
        sizeBytes: stats.size,
        tableCount: input.tableCount,
        fileName,
        restoreListVerified: true,
        storageFilesIncluded: false
      }
    };
  } catch (error) {
    await removePreparedDatabaseBackup({ directory, filePath }).catch(() => undefined);
    if (error instanceof DatabaseBackupError) throw error;
    throw new DatabaseBackupError("BACKUP_GENERATION_FAILED");
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
  if (stats.size !== backup.manifest.sizeBytes || stats.size <= 0) {
    throw new DatabaseBackupError("BACKUP_SIZE_MISMATCH");
  }
  const sha256 = await sha256File(backup.filePath);
  if (sha256 !== backup.manifest.sha256) throw new DatabaseBackupError("CHECKSUM_MISMATCH");
  await verifyPgRestoreList(backup.filePath);
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
