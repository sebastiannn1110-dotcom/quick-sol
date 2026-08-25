import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, CRITICAL_CACHE_CONTROL, superadminJson } from "@/lib/superadmin/auth";
import { consumeRetainedDatabaseBackup, discardRetainedDatabaseBackup, nodeFileStream, removePreparedDatabaseBackup, verifyRetainedDatabaseBackup, webFileStream } from "@/lib/superadmin/database-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const { data: manifestRow, error: manifestError } = await context.service
    .from("database_backup_manifests")
    .select("id,status,created_by,evidence_hash")
    .eq("id", id)
    .eq("created_by", context.user.id)
    .maybeSingle();
  if (manifestError || !manifestRow || manifestRow.status !== "verified") {
    return superadminJson({ error: "BACKUP_NOT_VERIFIED", deleteLocked: true }, { status: 409 });
  }
  try {
    await verifyRetainedDatabaseBackup(id, context.user.id);
  } catch {
    await discardRetainedDatabaseBackup(id, context.user.id);
    return superadminJson({ error: "BACKUP_INTEGRITY_CHECK_FAILED", deleteLocked: true }, { status: 409 });
  }
  const backup = await consumeRetainedDatabaseBackup(id, context.user.id);
  if (!backup) return superadminJson({ error: "BACKUP_DOWNLOAD_UNAVAILABLE", deleteLocked: true }, { status: 404 });

  const stream = nodeFileStream(backup.filePath);
  let finalized = false;
  let streamEnded = false;
  const cleanup = async (downloaded: boolean) => {
    if (finalized) return;
    finalized = true;
    if (downloaded) {
      try {
        await context.service.rpc("mark_database_backup_downloaded_v2", {
          input_actor_id: context.user.id,
          input_manifest_id: id,
          input_evidence_hash: backup.manifest.evidenceHash
        });
      } catch {
        // The file must still be removed. A missing DB acknowledgement keeps deletion locked.
      }
    }
    await removePreparedDatabaseBackup(backup).catch(() => undefined);
  };
  stream.once("end", () => {
    streamEnded = true;
  });
  stream.once("error", () => void cleanup(false));
  stream.once("close", () => void cleanup(streamEnded && stream.readableEnded));

  return new Response(webFileStream(stream), {
    status: 200,
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Length": String(backup.manifest.sizeBytes),
      "Content-Disposition": `attachment; filename="${backup.manifest.fileName}"`,
      "Cache-Control": CRITICAL_CACHE_CONTROL,
      Pragma: "no-cache",
      Digest: `sha-256=${Buffer.from(backup.manifest.sha256, "hex").toString("base64")}`,
      "X-Backup-SHA256": backup.manifest.sha256,
      "X-Content-Type-Options": "nosniff"
    }
  });
}
