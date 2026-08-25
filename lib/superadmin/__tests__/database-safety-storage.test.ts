import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SafetyBundleWriter,
  appendStorageBackup,
  purgeBusinessStorage,
  type StorageBackupSource
} from "@/lib/superadmin/database-safety-storage";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function stream(value: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    }
  });
}

describe("Database Safety Storage bundle", () => {
  it("streams all five business buckets into a deterministic manifest without loading files into RAM", async () => {
    const directory = path.join(tmpdir(), `quiksol-storage-test-${randomUUID()}`);
    directories.push(directory);
    await fs.mkdir(directory);
    const filePath = path.join(directory, "bundle.tar");
    const source: StorageBackupSource = {
      list: vi.fn(async (bucket) => bucket === "excel-uploads"
        ? [{ bucket, name: "synthetic/file.xlsx", sizeBytes: 4, contentType: "application/octet-stream", updatedAt: null }]
        : []),
      open: vi.fn(async () => stream("SAFE")),
      remove: vi.fn(async () => undefined)
    };

    const writer = await SafetyBundleWriter.create(filePath);
    const manifest = await appendStorageBackup(writer, source);
    await writer.addBuffer("manifest/storage.json", Buffer.from(JSON.stringify(manifest)));
    const bundle = await writer.close();

    expect(source.list).toHaveBeenCalledTimes(5);
    expect(manifest.objectCount).toBe(1);
    expect(manifest.sizeBytes).toBe(4);
    expect(manifest.objects[0]).toMatchObject({ bucket: "excel-uploads", name: "synthetic/file.xlsx" });
    expect(manifest.objects[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.restoreProcedure).toBe("extract-tar-and-upload-verified-object-manifest");
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await fs.stat(filePath)).size).toBe(bundle.sizeBytes);
  });

  it("deletes only exact manifest keys in bounded chunks and supports retry", async () => {
    const remove = vi.fn(async () => undefined);
    const source: StorageBackupSource = {
      list: vi.fn(async () => []),
      open: vi.fn(async () => stream("")),
      remove
    };
    const keys = Array.from({ length: 205 }, (_, index) => `excel-uploads/synthetic/${index}.xlsx`);
    const result = await purgeBusinessStorage(source, keys);

    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 5]);
    expect(result).toEqual({
      deletedObjects: 205,
      recovery: "Retry exact manifest keys; never delete newly discovered objects."
    });
  });

  it("refuses path traversal and buckets outside the explicit BUSINESS_DELETE policy", async () => {
    const source: StorageBackupSource = {
      list: vi.fn(async () => []),
      open: vi.fn(async () => stream("")),
      remove: vi.fn(async () => undefined)
    };
    await expect(purgeBusinessStorage(source, ["avatars/profile.png"])).rejects.toThrow("STORAGE_BUCKET_NOT_DELETABLE");
    await expect(purgeBusinessStorage(source, ["excel-uploads/../secret"])).rejects.toThrow("STORAGE_OBJECT_PATH_INVALID");
  });
});
