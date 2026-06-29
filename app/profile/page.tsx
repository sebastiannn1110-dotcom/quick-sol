"use client";

import { FormEvent, useEffect, useState } from "react";
import UserAvatar from "@/components/chat/UserAvatar";
import type { Profile } from "@/lib/types";

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [bio, setBio] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const response = await fetch("/api/me", { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as { profile: Profile };
    setProfile(payload.profile);
    setBio(payload.profile.bio ?? "");
    setJobTitle(payload.profile.job_title ?? "");
  }

  useEffect(() => { void load(); }, []);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setSaving(true); setError(""); setMessage("");
    const form = new FormData();
    form.set("file", file);
    const response = await fetch("/api/profile/avatar", { method: "POST", body: form });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      setMessage("Foto de perfil actualizada.");
      setFile(null);
      await load();
    } else {
      setError(payload?.error ?? "No se pudo actualizar la foto.");
    }
    setSaving(false);
  }

  async function remove() {
    setSaving(true); setError(""); setMessage("");
    const response = await fetch("/api/profile/avatar", { method: "DELETE" });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      setMessage("Foto eliminada.");
      await load();
    } else {
      setError(payload?.error ?? "No se pudo eliminar la foto.");
    }
    setSaving(false);
  }

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError(""); setMessage("");
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bio, job_title: jobTitle })
    });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      setMessage("Perfil actualizado.");
      setProfile(payload.profile);
    } else {
      setError(payload?.error ?? "No se pudo actualizar tu perfil.");
    }
    setSaving(false);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-700">Cuenta</p>
        <h1 className="text-2xl font-semibold text-slate-950">Mi perfil</h1>
        <p className="mt-2 text-sm text-slate-600">Tu foto, cargo y descripcion se muestran en el chat y directorio interno.</p>
      </header>

      <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
        {profile ? (
          <div className="flex items-center gap-4">
            <UserAvatar name={profile.full_name} avatarPath={profile.avatar_path} size="lg" />
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{profile.full_name}</h2>
              <p className="text-sm text-slate-500">{profile.email}</p>
              <p className="mt-1 text-xs font-semibold uppercase text-slate-500">
                {profile.job_title || profile.role}{profile.department ? ` - ${profile.department}` : ""}
              </p>
              {profile.bio ? <p className="mt-2 max-w-xl text-sm text-slate-600">{profile.bio}</p> : null}
            </div>
          </div>
        ) : (
          <div className="h-20 animate-pulse rounded-md bg-slate-100" />
        )}
        {message ? <p className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p> : null}
        {error ? <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        <form onSubmit={upload} className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Nueva foto
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="rounded-md border border-slate-300 p-2 text-sm font-normal" />
            <span className="text-xs font-normal text-slate-500">JPG, PNG o WebP. Maximo 5 MB.</span>
          </label>
          <button disabled={!file || saving} className="self-start rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Guardando..." : "Actualizar foto"}</button>
        </form>
        {profile?.avatar_path ? <button type="button" disabled={saving} onClick={() => void remove()} className="mt-4 text-sm font-semibold text-red-700">Eliminar foto actual</button> : null}
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Informacion visible para la empresa</h2>
        <p className="mt-1 text-sm text-slate-500">Esto no cambia tu rol real de seguridad. Solo actualiza como te ven tus companeros.</p>
        <form onSubmit={updateProfile} className="mt-4 space-y-4">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Cargo o funcion visible
            <input value={jobTitle} onChange={(event) => setJobTitle(event.target.value.slice(0, 120))} maxLength={120} placeholder="Ej: Compras, ventas, gerente operativo" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Descripcion
            <textarea value={bio} onChange={(event) => setBio(event.target.value.slice(0, 500))} maxLength={500} rows={5} placeholder="Cuenta brevemente que haces en la empresa." className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
            <span className="text-xs font-normal text-slate-500">{bio.length}/500</span>
          </label>
          <button disabled={saving} className="rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Guardando..." : "Guardar perfil"}</button>
        </form>
      </section>
    </div>
  );
}
