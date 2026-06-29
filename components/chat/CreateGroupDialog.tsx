"use client";

import { FormEvent, useMemo, useState } from "react";
import { X } from "lucide-react";
import UserAvatar from "@/components/chat/UserAvatar";
import type { ChatUser } from "@/components/chat/types";

export default function CreateGroupDialog({
  users,
  canCreateGroup,
  currentUserId,
  onClose,
  onCreated
}: {
  users: ChatUser[];
  canCreateGroup: boolean;
  currentUserId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [type, setType] = useState<"direct" | "group">("direct");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visible = useMemo(() => {
    const query = search.toLowerCase();
    return users.filter((user) =>
      user.id !== currentUserId &&
      [user.full_name, user.email, user.department, user.region, user.job_title]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [currentUserId, search, users]);

  function toggle(id: string) {
    setSelected((current) => type === "direct" ? [id] : current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, name, description, participantIds: selected })
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error ?? "No se pudo crear el chat.");
      return;
    }
    onCreated(payload.conversationId);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <form onSubmit={submit} className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-md bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-950">Nueva conversacion</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-500"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={() => { setType("direct"); setSelected([]); }} className={`rounded-md px-3 py-2 text-sm font-semibold ${type === "direct" ? "bg-orange-600 text-white" : "bg-slate-100 text-slate-700"}`}>Chat directo</button>
          {canCreateGroup ? <button type="button" onClick={() => { setType("group"); setSelected([]); }} className={`rounded-md px-3 py-2 text-sm font-semibold ${type === "group" ? "bg-orange-600 text-white" : "bg-slate-100 text-slate-700"}`}>Grupo</button> : null}
        </div>
        {type === "group" ? (
          <>
            <label className="mt-4 grid gap-1 text-sm font-medium text-slate-700">
              Nombre del grupo
              <input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2" />
            </label>
            <label className="mt-3 grid gap-1 text-sm font-medium text-slate-700">
              Descripcion
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2" />
            </label>
          </>
        ) : null}
        <label className="mt-4 grid gap-1 text-sm font-medium text-slate-700">
          Buscar personas
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nombre, correo, cargo o departamento" className="rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <p className="mt-2 text-xs text-slate-500">{selected.length} persona{selected.length === 1 ? "" : "s"} seleccionada{selected.length === 1 ? "" : "s"}</p>
        <div className="mt-3 max-h-64 divide-y divide-slate-100 overflow-auto border-y">
          {visible.map((user) => (
            <label key={user.id} className="flex cursor-pointer items-start gap-3 py-3 text-sm">
              <input type={type === "direct" ? "radio" : "checkbox"} checked={selected.includes(user.id)} onChange={() => toggle(user.id)} className="mt-3" />
              <UserAvatar name={user.full_name} avatarPath={user.avatar_path} size="sm" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-slate-950">{user.full_name}</span>
                <span className="block truncate text-slate-500">{user.job_title || user.email}{user.department ? ` - ${user.department}` : ""}</span>
              </span>
            </label>
          ))}
        </div>
        {error ? <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Cancelar</button>
          <button disabled={busy || selected.length === 0 || (type === "direct" && selected.length !== 1)} className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Creando..." : "Crear"}</button>
        </div>
      </form>
    </div>
  );
}
