"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DATABASE_DESTRUCTION_PHRASE } from "@/lib/superadmin/database-safety-policy";

type TableState = {
  schema: string;
  table: string;
  count: number | null;
  category: string;
  action: "DELETE" | "PRESERVE";
  reason: string;
};

type BackupRow = {
  id: string;
  created_at: string;
  expires_at: string;
  downloaded_at: string | null;
  file_name: string;
  sha256: string;
  size_bytes: number;
  data_version: number;
  storage_version: number;
  catalog_version: string;
  schema_inventory_hash: string;
  restore_list_verified: boolean;
  restore_verified: boolean;
  storage_files_included: boolean;
  storage_manifest_sha256: string | null;
  storage_object_count: number;
  evidence_hash: string | null;
  auth_scope: string;
  status: string;
};

type StatusPayload = {
  snapshot: {
    dataVersion: number;
    storageVersion: number;
    catalogVersion: string;
    schemaInventoryHash: string;
    schemaVersion: string;
    migrationVersion: string;
    tableCount: number;
    storageObjectCount: number | null;
    storageFilesIncluded: true;
    deleteEnabledInDatabase: boolean;
    storageScope: Array<{ bucket: string; action: string; reason: string }>;
    authScope: string;
    tables: TableState[];
  };
  latestBackup: BackupRow | null;
  config: { deleteEnabled: boolean; backupDatabaseConfigured: boolean; restoreVerificationDatabaseConfigured: boolean };
  scopeNotice: string;
};

type ArmedOperation = {
  operationId: string;
  challenge: string;
  notBefore: string;
  expiresAt: string;
  countdownSeconds: number;
};

const SAFE_BLOB_FALLBACK_MAX_BYTES = 100 * 1024 * 1024;

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error ?? "REQUEST_FAILED"));
  return payload as T;
}

function bytes(value: number | undefined) {
  if (!value) return "0 B";
  return new Intl.NumberFormat("es", { style: "unit", unit: "megabyte", maximumFractionDigits: 2 }).format(value / 1024 / 1024);
}

function count(value: number | null) {
  return value === null ? "no disponible" : new Intl.NumberFormat("es").format(value);
}

export default function DatabaseSafetyCenter() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [dryRun, setDryRun] = useState<{ wouldDelete: TableState[]; wouldPreserve: TableState[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadConfirmed, setDownloadConfirmed] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [armed, setArmed] = useState<ArmedOperation | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [clock, setClock] = useState(0);

  const refresh = useCallback(async () => {
    const next = await jsonRequest<StatusPayload>("/api/admindev/database-safety/status");
    setStatus(next);
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "STATUS_FAILED"));
  }, [refresh]);

  useEffect(() => {
    const update = () => setClock(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!armed) {
      setSeconds(null);
      return;
    }
    const update = () => setSeconds(Math.max(0, Math.ceil((new Date(armed.notBefore).getTime() - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [armed]);

  const backup = status?.latestBackup ?? null;
  const backupCurrent = Boolean(
    backup &&
    backup.status === "verified" &&
    backup.restore_list_verified &&
    backup.restore_verified &&
    backup.storage_files_included &&
    Boolean(backup.storage_manifest_sha256) &&
    backup.auth_scope === "PRESERVED_NOT_INCLUDED" &&
    backup.downloaded_at &&
    new Date(backup.expires_at).getTime() > clock &&
    backup.data_version === status?.snapshot.dataVersion &&
    backup.storage_version === status?.snapshot.storageVersion &&
    backup.catalog_version === status?.snapshot.catalogVersion &&
    backup.schema_inventory_hash === status?.snapshot.schemaInventoryHash
  );
  const deleteReady = backupCurrent && status?.config.deleteEnabled === true && status?.snapshot.deleteEnabledInDatabase === true;
  const canArm = deleteReady && downloadConfirmed && phrase === DATABASE_DESTRUCTION_PHRASE && password.length > 0 && !armed;
  const totalBusinessRows = useMemo(
    () => dryRun?.wouldDelete.reduce((sum, table) => sum + (table.count ?? 0), 0) ?? null,
    [dryRun]
  );

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "REQUEST_FAILED");
    } finally {
      setBusy(null);
    }
  }

  async function generateBackup() {
    await run("backup", async () => {
      const created = await jsonRequest<{ backupId: string; manifest: { fileName: string; sha256: string; sizeBytes: number } }>(
        "/api/admindev/database-safety/backups",
        { method: "POST", body: "{}" }
      );
      setDownloadConfirmed(false);
      setMessage(`Bundle creado: ${created.manifest.fileName} (${bytes(created.manifest.sizeBytes)}). Verifícalo antes de descargar.`);
      await refresh();
    });
  }

  async function verifyBackup() {
    if (!backup) return;
    await run("verify", async () => {
      await jsonRequest(`/api/admindev/database-safety/backups/${backup.id}/verify`, { method: "POST", body: "{}" });
      setMessage("SHA-256, pg_restore --list, restore estructural y cobertura Storage verificados nuevamente.");
    });
  }

  async function downloadBackup() {
    if (!backup) return;
    await run("download", async () => {
      const browser = window as typeof window & {
        showSaveFilePicker?: (options: {
          suggestedName: string;
          types: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<{ createWritable: () => Promise<WritableStream> }>;
      };
      const handle = browser.showSaveFilePicker
        ? await browser.showSaveFilePicker({
          suggestedName: backup.file_name,
          types: [{ description: "QuikSol Safety Bundle", accept: { "application/x-tar": [".tar"] } }]
        })
        : null;
      if (!browser.showSaveFilePicker && backup.size_bytes > SAFE_BLOB_FALLBACK_MAX_BYTES) {
        throw new Error("BACKUP_TOO_LARGE_FOR_BLOB_FALLBACK: usa un navegador compatible con descarga directa a disco.");
      }
      const response = await fetch(`/api/admindev/database-safety/backups/${backup.id}/download`, { method: "POST", cache: "no-store", credentials: "same-origin" });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(String(payload.error ?? "BACKUP_DOWNLOAD_FAILED"));
      }
      if (browser.showSaveFilePicker) {
        try {
          const writable = await handle!.createWritable();
          await response.body.pipeTo(writable);
        } catch (cause) {
          await response.body.cancel().catch(() => undefined);
          throw cause;
        }
      } else {
        const contentLength = Number(response.headers.get("content-length"));
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > SAFE_BLOB_FALLBACK_MAX_BYTES) {
          await response.body.cancel().catch(() => undefined);
          throw new Error("BACKUP_TOO_LARGE_FOR_BLOB_FALLBACK: usa un navegador compatible con descarga directa a disco.");
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = backup.file_name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }
      setMessage("El servidor terminó de transmitir el bundle. Confirma manualmente que el archivo continúa guardado en tu PC; el servidor no puede demostrarlo después de la descarga.");
      await refresh();
    });
  }

  async function simulate() {
    await run("dry-run", async () => {
      const payload = await jsonRequest<{ wouldDelete: TableState[]; wouldPreserve: TableState[] }>(
        "/api/admindev/database-safety/dry-run",
        { method: "POST", body: "{}" }
      );
      setDryRun(payload);
      setMessage("Simulación terminada: cero filas modificadas.");
    });
  }

  async function armDeletion() {
    if (!backup) return;
    await run("arm", async () => {
      const operation = await jsonRequest<ArmedOperation>("/api/admindev/database-safety/arm", {
        method: "POST",
        body: JSON.stringify({ backupId: backup.id, phrase, password, downloadConfirmed: true })
      });
      setPassword("");
      setArmed(operation);
      setMessage("Reautenticación correcta. La operación está armada y puede cancelarse durante el countdown.");
    });
  }

  async function cancelDeletion() {
    if (!armed) return;
    await run("cancel", async () => {
      await jsonRequest(`/api/admindev/database-safety/operations/${armed.operationId}/cancel`, { method: "POST", body: "{}" });
      setArmed(null);
      setMessage("Operación cancelada. No se eliminó información.");
    });
  }

  async function executeDeletion() {
    if (!armed || seconds !== 0) return;
    await run("execute", async () => {
      const payload = await jsonRequest<{ result: Record<string, unknown> }>("/api/admindev/database-safety/execute", {
        method: "POST",
        body: JSON.stringify({ operationId: armed.operationId, challenge: armed.challenge })
      });
      setResult(payload.result);
      setArmed(null);
      setMessage("Eliminación empresarial transaccional completada.");
      await refresh();
    });
  }

  return (
    <section className="rounded-lg border border-amber-700 bg-slate-900 p-4 shadow-lg" aria-labelledby="database-safety-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold tracking-[0.18em] text-amber-300">DATABASE SAFETY CENTER</p>
          <h2 id="database-safety-title" className="mt-1 text-xl font-semibold">Respaldo y eliminación de datos</h2>
          <p className="mt-1 text-sm text-slate-400">Acceso exclusivo para el rol Super Admin Dev.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${deleteReady ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}>
          {deleteReady ? "READY — todas las condiciones verificadas" : "DELETE LOCKED"}
        </span>
      </div>

      {error ? <p role="alert" className="mt-4 rounded border border-red-800 bg-red-950 p-3 text-sm text-red-200">{error}</p> : null}
      {message ? <p className="mt-4 rounded border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">{message}</p> : null}

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded border border-slate-700 bg-slate-950 p-3"><p className="text-xs text-slate-400">Registros a eliminar</p><p className="text-xl font-semibold">{totalBusinessRows === null ? "Ejecuta la simulación" : count(totalBusinessRows)}</p></div>
        <div className="rounded border border-slate-700 bg-slate-950 p-3"><p className="text-xs text-slate-400">Versión de datos</p><p className="text-xl font-semibold">{status?.snapshot.dataVersion ?? "…"}</p></div>
        <div className="rounded border border-slate-700 bg-slate-950 p-3"><p className="text-xs text-slate-400">Objetos en Storage (aprox.)</p><p className="text-xl font-semibold">{count(status?.snapshot.storageObjectCount ?? null)}</p></div>
      </div>

      <div className="mt-4 rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-100">
        <strong>Alcance exacto:</strong> database schema <code>public</code> incluido; archivos de Storage empresarial incluidos por streaming; Supabase Auth identities, migrations, perfiles y auditoría de seguridad PRESERVED / NOT INCLUDED. No se describe como un backup completo de Supabase.
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="rounded border border-slate-700 p-4">
          <h3 className="font-semibold">Bundle: Database + Business Storage</h3>
          {backup ? <div className="mt-2 space-y-1 break-all text-sm text-slate-300">
            <p>Archivo: {backup.file_name}</p><p>Tamaño: {bytes(backup.size_bytes)}</p><p>SHA-256: <code>{backup.sha256}</code></p>
            <p>Manifest hash: <code>{backup.evidence_hash ?? "pendiente"}</code></p>
            <p>Catalog version: {backup.catalog_version}</p><p>Data version: {backup.data_version}</p><p>Storage version: {backup.storage_version}</p>
            <p>Restore verified: {backup.restore_verified ? "sí" : "no"}</p><p>Storage coverage: {backup.storage_files_included ? `${backup.storage_object_count} objetos` : "incompleta"}</p>
            <p>Auth: {backup.auth_scope}</p><p>Fecha: {new Date(backup.created_at).toLocaleString()}</p><p>Stream completado por servidor: {backup.downloaded_at ? "sí" : "no"}</p>
          </div> : <p className="mt-2 text-sm text-slate-400">Último backup: ninguno.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={Boolean(busy)} onClick={generateBackup} className="rounded bg-amber-600 px-3 py-2 text-sm font-bold disabled:opacity-50">GENERAR BACKUP LOCAL</button>
            <button disabled={!backup || Boolean(busy)} onClick={verifyBackup} className="rounded bg-slate-700 px-3 py-2 text-sm disabled:opacity-50">Verificar respaldo</button>
            <button disabled={!backup || backup.status !== "verified" || Boolean(busy)} onClick={downloadBackup} className="rounded bg-emerald-800 px-3 py-2 text-sm disabled:opacity-50">Descargar .tar</button>
            {backup ? <a href={`/api/admindev/database-safety/backups/${backup.id}/manifest`} className="rounded bg-slate-700 px-3 py-2 text-sm">Descargar manifest</a> : null}
            <button disabled={Boolean(busy)} onClick={() => void refresh()} className="rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-50">Actualizar estado</button>
          </div>
        </section>

        <section className="rounded border border-slate-700 p-4">
          <h3 className="font-semibold">Simulación</h3>
          <p className="mt-1 text-sm text-slate-400">Cuenta la allowlist exacta sin modificar datos.</p>
          <button disabled={Boolean(busy)} onClick={simulate} className="mt-3 rounded bg-slate-700 px-3 py-2 text-sm font-semibold disabled:opacity-50">SIMULAR ELIMINACIÓN</button>
          {dryRun ? <div className="mt-3 max-h-64 overflow-auto text-xs">
            <p className="font-bold text-red-300">Se eliminarían</p>
            {dryRun.wouldDelete.map((table) => <p key={`${table.schema}.${table.table}`}>{table.schema}.{table.table}: {count(table.count)}</p>)}
            <p className="mt-2 font-bold text-emerald-300">Se conservarían</p>
            {dryRun.wouldPreserve.map((table) => <p key={`${table.schema}.${table.table}`}>{table.schema}.{table.table}: {count(table.count)}</p>)}
          </div> : null}
        </section>
      </div>

      <section className="mt-5 rounded border-2 border-red-700 bg-red-950/30 p-4">
        <p className="text-xs font-bold tracking-[0.18em] text-red-300">DANGER ZONE</p>
        <h3 className="mt-1 text-lg font-semibold">Eliminar información empresarial</h3>
        <p className="mt-1 text-sm text-red-100">Elimina datos empresariales de Database y los cinco buckets empresariales respaldados. Preserva estructura, migrations, Auth, perfiles, avatars, configuración y auditoría de seguridad.</p>
        {!status?.config.deleteEnabled ? <p className="mt-3 rounded border border-red-700 p-2 text-sm font-bold">DELETE LOCKED: DATABASE_SAFETY_DELETE_ENABLED no está habilitado en el servidor.</p> : null}

        <div className="mt-4 grid gap-3">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={downloadConfirmed} onChange={(event) => setDownloadConfirmed(event.target.checked)} />Confirmo que he descargado y guardado el respaldo en un lugar seguro.</label>
          <label className="grid gap-1 text-sm">Escribe exactamente <code>{DATABASE_DESTRUCTION_PHRASE}</code><input value={phrase} onChange={(event) => setPhrase(event.target.value)} className="rounded border border-red-800 bg-slate-950 px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Reautenticación del Super Admin Dev<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" className="rounded border border-red-800 bg-slate-950 px-3 py-2" /></label>
          <button disabled={!canArm || Boolean(busy)} onClick={armDeletion} className="w-fit rounded bg-red-800 px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40">ELIMINAR INFORMACIÓN EMPRESARIAL</button>
        </div>

        {armed ? <div role="dialog" aria-modal="true" className="mt-4 rounded border border-red-500 bg-slate-950 p-4">
          <p className="font-semibold">Esta acción eliminará datos empresariales de QuikSol.</p>
          <p className="mt-2 text-sm">Backup: {backup?.file_name}</p><p className="break-all text-sm">SHA-256: {backup?.sha256}</p>
          <p className="mt-2 text-sm">Escribiste correctamente: {DATABASE_DESTRUCTION_PHRASE}</p>
          {seconds && seconds > 0 ? <p className="mt-3 text-lg font-bold text-amber-300">La eliminación comenzará en {seconds} segundos.</p> : <p className="mt-3 text-lg font-bold text-red-300">Countdown terminado. Revisa todo antes de ejecutar.</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={cancelDeletion} disabled={Boolean(busy)} className="rounded bg-slate-700 px-4 py-2 text-sm font-bold">Cancelar</button>
            <button onClick={executeDeletion} disabled={seconds !== 0 || Boolean(busy)} className="rounded bg-red-700 px-4 py-2 text-sm font-bold disabled:opacity-40">ELIMINAR DEFINITIVAMENTE</button>
          </div>
        </div> : null}
        {result ? <pre className="mt-4 max-h-64 overflow-auto rounded bg-slate-950 p-3 text-xs">{JSON.stringify(result, null, 2)}</pre> : null}
      </section>
    </section>
  );
}
