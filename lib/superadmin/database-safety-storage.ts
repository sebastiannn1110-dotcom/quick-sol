import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DATABASE_SAFETY_BUSINESS_BUCKETS } from "@/lib/superadmin/database-safety-policy";

export type StorageObjectDescriptor = {
  bucket: string;
  name: string;
  sizeBytes: number;
  contentType: string | null;
  updatedAt: string | null;
};

export type VerifiedStorageObject = StorageObjectDescriptor & {
  sha256: string;
};

export type StorageBackupSource = {
  list(bucket: string): Promise<StorageObjectDescriptor[]>;
  open(bucket: string, name: string): Promise<ReadableStream<Uint8Array>>;
  remove(bucket: string, names: string[]): Promise<void>;
};

export type StorageBackupManifest = {
  version: 1;
  included: true;
  buckets: readonly string[];
  objectCount: number;
  sizeBytes: number;
  objects: VerifiedStorageObject[];
  manifestSha256: string;
  restoreProcedure: "extract-tar-and-upload-verified-object-manifest";
};

function safeObjectName(name: string) {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("STORAGE_OBJECT_PATH_INVALID");
  }
  return normalized;
}

function tarPath(name: string) {
  const normalized = safeObjectName(name);
  if (Buffer.byteLength(normalized) <= 100) return { name: normalized, prefix: "" };
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) throw new Error("BACKUP_TAR_PATH_TOO_LONG");
  const prefix = normalized.slice(0, slash);
  const base = normalized.slice(slash + 1);
  if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error("BACKUP_TAR_PATH_TOO_LONG");
  }
  return { name: base, prefix };
}

function writeText(buffer: Buffer, offset: number, length: number, value: string) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number) {
  const encoded = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeText(buffer, offset, length, `${encoded}\0`);
}

function tarHeader(entryName: string, size: number, modifiedAt = 0) {
  const split = tarPath(entryName);
  const header = Buffer.alloc(512, 0);
  writeText(header, 0, 100, split.name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, modifiedAt);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "quiksol");
  writeText(header, 297, 32, "quiksol");
  writeText(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, "0").slice(-6);
  writeText(header, 148, 8, `${encoded}\0 `);
  return header;
}

export class SafetyBundleWriter {
  private constructor(
    private readonly handle: FileHandle,
    private readonly hash = createHash("sha256"),
    private bytesWritten = 0
  ) {}

  static async create(filePath: string) {
    return new SafetyBundleWriter(await open(filePath, "wx", 0o600));
  }

  private async write(chunk: Uint8Array) {
    const buffer = Buffer.from(chunk);
    await this.handle.write(buffer);
    this.hash.update(buffer);
    this.bytesWritten += buffer.length;
  }

  private async padding(size: number) {
    const remainder = size % 512;
    if (remainder) await this.write(Buffer.alloc(512 - remainder));
  }

  async addBuffer(entryName: string, content: Buffer) {
    await this.write(tarHeader(entryName, content.length));
    await this.write(content);
    await this.padding(content.length);
  }

  async addFile(entryName: string, filePath: string, sizeBytes: number) {
    await this.write(tarHeader(entryName, sizeBytes));
    let observed = 0;
    for await (const chunk of createReadStream(filePath) as ReadStream) {
      const buffer = Buffer.from(chunk as Buffer);
      observed += buffer.length;
      await this.write(buffer);
    }
    if (observed !== sizeBytes) throw new Error("BACKUP_DATABASE_SIZE_CHANGED");
    await this.padding(observed);
  }

  async addStorageObject(entryName: string, stream: ReadableStream<Uint8Array>, expectedSize: number) {
    await this.write(tarHeader(entryName, expectedSize));
    const objectHash = createHash("sha256");
    let observed = 0;
    for await (const chunk of Readable.fromWeb(stream as never)) {
      const buffer = Buffer.from(chunk as Buffer);
      observed += buffer.length;
      objectHash.update(buffer);
      await this.write(buffer);
    }
    if (observed !== expectedSize) throw new Error("STORAGE_OBJECT_SIZE_MISMATCH");
    await this.padding(observed);
    return objectHash.digest("hex");
  }

  async close() {
    await this.write(Buffer.alloc(1024));
    await this.handle.close();
    return { sha256: this.hash.digest("hex"), sizeBytes: this.bytesWritten };
  }

  async abort() {
    await this.handle.close().catch(() => undefined);
  }
}

export async function appendStorageBackup(writer: SafetyBundleWriter, source: StorageBackupSource) {
  const objects: VerifiedStorageObject[] = [];
  for (const bucket of DATABASE_SAFETY_BUSINESS_BUCKETS) {
    const listed = await source.list(bucket);
    for (const object of listed.sort((left, right) => left.name.localeCompare(right.name))) {
      if (object.bucket !== bucket || object.sizeBytes < 0) throw new Error("STORAGE_INVENTORY_INVALID");
      const name = safeObjectName(object.name);
      const stream = await source.open(bucket, name);
      const sha256 = await writer.addStorageObject(`storage/${bucket}/${name}`, stream, object.sizeBytes);
      objects.push({ ...object, name, sha256 });
    }
  }
  objects.sort((left, right) => `${left.bucket}/${left.name}`.localeCompare(`${right.bucket}/${right.name}`));
  const canonical = JSON.stringify(objects);
  return {
    version: 1,
    included: true,
    buckets: DATABASE_SAFETY_BUSINESS_BUCKETS,
    objectCount: objects.length,
    sizeBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    objects,
    manifestSha256: createHash("sha256").update(canonical).digest("hex"),
    restoreProcedure: "extract-tar-and-upload-verified-object-manifest"
  } satisfies StorageBackupManifest;
}

export function createSupabaseStorageBackupSource(service: SupabaseClient): StorageBackupSource {
  return {
    async list(bucket) {
      const result: StorageObjectDescriptor[] = [];
      const prefixes = [""];
      while (prefixes.length) {
        const prefix = prefixes.shift()!;
        for (let offset = 0; ; offset += 100) {
          const { data, error } = await service.storage.from(bucket).list(prefix, {
            limit: 100,
            offset,
            sortBy: { column: "name", order: "asc" }
          });
          if (error) throw new Error("STORAGE_LIST_FAILED");
          const entries = data ?? [];
          for (const entry of entries) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (!entry.id) {
              prefixes.push(name);
              continue;
            }
            const metadata = entry.metadata as Record<string, unknown> | null;
            const sizeBytes = Number(metadata?.size ?? 0);
            if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error("STORAGE_SIZE_INVALID");
            result.push({
              bucket,
              name: safeObjectName(name),
              sizeBytes,
              contentType: typeof metadata?.mimetype === "string" ? metadata.mimetype : null,
              updatedAt: entry.updated_at ?? null
            });
          }
          if (entries.length < 100) break;
        }
      }
      return result;
    },
    async open(bucket, name) {
      const { data, error } = await service.storage.from(bucket).createSignedUrl(safeObjectName(name), 60 * 60);
      if (error || !data?.signedUrl) throw new Error("STORAGE_SIGNED_URL_FAILED");
      const response = await fetch(data.signedUrl, { cache: "no-store", redirect: "error" });
      if (!response.ok || !response.body) throw new Error("STORAGE_STREAM_FAILED");
      return response.body;
    },
    async remove(bucket, names) {
      if (!names.length) return;
      const { error } = await service.storage.from(bucket).remove(names.map(safeObjectName));
      if (error) throw new Error("STORAGE_DELETE_FAILED");
    }
  };
}

export async function purgeBusinessStorage(source: StorageBackupSource, objectKeys: string[]) {
  const grouped = new Map<string, string[]>();
  for (const key of objectKeys) {
    const slash = key.indexOf("/");
    if (slash <= 0) throw new Error("STORAGE_MANIFEST_KEY_INVALID");
    const bucket = key.slice(0, slash);
    const name = safeObjectName(key.slice(slash + 1));
    if (!DATABASE_SAFETY_BUSINESS_BUCKETS.includes(bucket as never)) throw new Error("STORAGE_BUCKET_NOT_DELETABLE");
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), name]);
  }
  let deleted = 0;
  for (const [bucket, names] of grouped) {
    for (let offset = 0; offset < names.length; offset += 100) {
      const chunk = names.slice(offset, offset + 100);
      await source.remove(bucket, chunk);
      deleted += chunk.length;
    }
  }
  return { deletedObjects: deleted, recovery: "Retry exact manifest keys; never delete newly discovered objects." };
}
