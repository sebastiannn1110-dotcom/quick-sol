"use client";

import { Archive, ArrowLeft, ImageUp, Link2, Save, Unlink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import type { ClientDetail, ClientUpload } from "@/lib/clients/clients";

type AvailableUpload = {
  id: string;
  original_file_name: string;
  detected_category: string | null;
  status: string;
  created_at: string;
};

type FormState = {
  name: string;
  description: string;
  industry: string;
  region: string;
  website: string;
};

const EMPTY_FORM: FormState = { name: "", description: "", industry: "", region: "", website: "" };

export default function ClientForm({ clientId = null }: { clientId?: string | null }) {
  const router = useRouter();
  const { t } = useLanguage();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [uploads, setUploads] = useState<ClientUpload[]>([]);
  const [availableUploads, setAvailableUploads] = useState<AvailableUpload[]>([]);
  const [selectedUploadId, setSelectedUploadId] = useState("");
  const [logo, setLogo] = useState<File | null>(null);
  const [identification, setIdentification] = useState<File | null>(null);
  const [loading, setLoading] = useState(Boolean(clientId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function refreshUploads() {
    if (!clientId) return;
    const response = await fetch(`/api/clients/${clientId}/uploads`, { cache: "no-store" });
    if (response.ok) setUploads((await response.json() as { uploads: ClientUpload[] }).uploads);
  }

  useEffect(() => {
    async function load() {
      try {
        const requests = [fetch("/api/admin/clients/available-uploads", { cache: "no-store" })];
        if (clientId) {
          requests.push(fetch(`/api/clients/${clientId}`, { cache: "no-store" }));
          requests.push(fetch(`/api/clients/${clientId}/uploads`, { cache: "no-store" }));
        }
        const [availableResponse, clientResponse, uploadsResponse] = await Promise.all(requests);
        if (availableResponse.ok) setAvailableUploads((await availableResponse.json() as { uploads: AvailableUpload[] }).uploads);
        if (clientId && clientResponse?.ok) {
          const client = (await clientResponse.json() as { client: ClientDetail }).client;
          setForm({
            name: client.name,
            description: client.description ?? "",
            industry: client.industry ?? "",
            region: client.region ?? "",
            website: client.website ?? ""
          });
        }
        if (clientId && uploadsResponse?.ok) setUploads((await uploadsResponse.json() as { uploads: ClientUpload[] }).uploads);
      } catch {
        setError(t("clients.error"));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [clientId, t]);

  async function saveClient() {
    setSaving(true);
    setError("");
    const response = await fetch(clientId ? `/api/admin/clients/${clientId}` : "/api/admin/clients", {
      method: clientId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form)
    });
    const payload = await response.json().catch(() => null) as { client?: { id: string } } | null;
    setSaving(false);
    if (!response.ok || !payload?.client) {
      setError(t("adminClient.error"));
      return;
    }
    router.push(`/admin/clients/${payload.client.id}/edit`);
    router.refresh();
  }

  async function uploadImage(kind: "logo" | "identification", file: File | null) {
    if (!clientId || !file) return;
    setSaving(true);
    setError("");
    const body = new FormData();
    body.set("file", file);
    const response = await fetch(`/api/admin/clients/${clientId}/${kind}`, { method: "POST", body });
    setSaving(false);
    if (!response.ok) {
      setError(t("adminClient.error"));
      return;
    }
    if (kind === "logo") setLogo(null);
    else setIdentification(null);
    router.refresh();
  }

  async function assignUpload() {
    if (!clientId || !selectedUploadId) return;
    setSaving(true);
    const response = await fetch(`/api/admin/clients/${clientId}/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadBatchId: selectedUploadId })
    });
    setSaving(false);
    if (!response.ok) {
      setError(t("adminClient.error"));
      return;
    }
    setSelectedUploadId("");
    await refreshUploads();
  }

  async function removeAssignment(uploadBatchId: string) {
    if (!clientId) return;
    setSaving(true);
    const response = await fetch(`/api/admin/clients/${clientId}/assignments?uploadBatchId=${encodeURIComponent(uploadBatchId)}`, { method: "DELETE" });
    setSaving(false);
    if (!response.ok) {
      setError(t("adminClient.error"));
      return;
    }
    await refreshUploads();
  }

  async function archiveClient() {
    if (!clientId) return;
    setSaving(true);
    const response = await fetch(`/api/admin/clients/${clientId}/archive`, { method: "POST" });
    setSaving(false);
    if (!response.ok) {
      setError(t("adminClient.error"));
      return;
    }
    router.push("/admin/clients");
    router.refresh();
  }

  if (loading) return <div className="py-10 text-center text-sm text-slate-500">{t("clients.loading")}</div>;

  return (
    <div className="space-y-6">
      <Link href={clientId ? `/clients/${clientId}` : "/admin/clients"} className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-950">
        <ArrowLeft className="h-4 w-4" />
        {t("clientDetail.back")}
      </Link>
      <div>
        <p className="text-sm font-medium text-orange-700">{t("clients.eyebrow")}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{t(clientId ? "adminClient.title.edit" : "adminClient.title.new")}</h1>
      </div>
      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

      <form
        className="grid gap-4 border-y border-slate-200 bg-white py-5 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void saveClient();
        }}
      >
        <label className="grid gap-1 text-sm font-medium text-slate-700 sm:col-span-2">
          {t("adminClient.name")}
          <input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          {t("adminClient.industry")}
          <input maxLength={160} value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          {t("adminClient.region")}
          <input maxLength={160} value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700 sm:col-span-2">
          {t("adminClient.website")}
          <input type="url" maxLength={320} value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal" placeholder="https://" />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700 sm:col-span-2">
          {t("adminClient.description")}
          <textarea rows={4} maxLength={1200} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
        </label>
        <div className="sm:col-span-2">
          <button disabled={saving} type="submit" className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60 sm:w-auto">
            <Save className="h-4 w-4" />
            {saving ? t("adminClient.saving") : t("adminClient.save")}
          </button>
        </div>
      </form>

      {clientId ? (
        <>
          <section className="grid gap-5 border-b border-slate-200 pb-6 lg:grid-cols-2">
            <div>
              <h2 className="font-semibold text-slate-950">{t("adminClient.logo")}</h2>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setLogo(event.target.files?.[0] ?? null)} className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" />
                <button disabled={!logo || saving} type="button" onClick={() => void uploadImage("logo", logo)} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">
                  <ImageUp className="h-4 w-4" />{t("adminClient.uploadImage")}
                </button>
              </div>
            </div>
            <div>
              <h2 className="font-semibold text-slate-950">{t("adminClient.identification")}</h2>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setIdentification(event.target.files?.[0] ?? null)} className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" />
                <button disabled={!identification || saving} type="button" onClick={() => void uploadImage("identification", identification)} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">
                  <ImageUp className="h-4 w-4" />{t("adminClient.uploadImage")}
                </button>
              </div>
            </div>
          </section>

          <section className="space-y-4 border-b border-slate-200 pb-6">
            <h2 className="font-semibold text-slate-950">{t("adminClient.assignments")}</h2>
            <div className="flex flex-col gap-3 sm:flex-row">
              <select value={selectedUploadId} onChange={(event) => setSelectedUploadId(event.target.value)} className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="">{t("adminClient.uploadId")}</option>
                {availableUploads.map((upload) => <option key={upload.id} value={upload.id}>{upload.original_file_name} · {upload.id}</option>)}
              </select>
              <button disabled={!selectedUploadId || saving} type="button" onClick={() => void assignUpload()} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
                <Link2 className="h-4 w-4" />{t("adminClient.assign")}
              </button>
            </div>
            <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
              {uploads.map((upload) => (
                <div key={upload.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-900">{upload.originalFileName}</p><p className="truncate text-xs text-slate-500">{upload.id}</p></div>
                  <button type="button" onClick={() => void removeAssignment(upload.id)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50" title={t("adminClient.removeAssignment")}>
                    <Unlink className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <button disabled={saving} type="button" onClick={() => void archiveClient()} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
            <Archive className="h-4 w-4" />{t("adminClient.archive")}
          </button>
        </>
      ) : null}
    </div>
  );
}
