"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import UserAvatar from "@/components/chat/UserAvatar";

interface AuditMember {
  id: string;
  user_id: string;
  role: string;
  profiles: {
    id: string;
    full_name: string;
    email: string;
    avatar_path?: string | null;
    job_title?: string | null;
  } | null;
}

interface AuditConversation {
  id: string;
  type: "direct" | "group" | "all_company";
  name: string | null;
  description: string | null;
  updated_at: string;
  chat_conversation_members: AuditMember[];
}

interface AuditMessage {
  id: string;
  sender_id: string | null;
  body: string | null;
  message_type: string;
  created_at: string;
  profiles?: { full_name: string; avatar_path?: string | null } | null;
  chat_attachments?: Array<{ id: string; file_name: string; file_size: number; file_type: string }>;
}

function title(conversation: AuditConversation) {
  if (conversation.type === "direct") {
    return conversation.chat_conversation_members.map((member) => member.profiles?.full_name ?? "Usuario").join(" / ");
  }
  return conversation.name || "Grupo sin nombre";
}

export default function AdminChatAuditPage() {
  const [conversations, setConversations] = useState<AuditConversation[]>([]);
  const [messages, setMessages] = useState<AuditMessage[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [type, setType] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (conversationId = "") => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (conversationId) params.set("conversationId", conversationId);
    if (type) params.set("type", type);
    if (userFilter.trim()) params.set("userId", userFilter.trim());
    const response = await fetch(`/api/admin/chat-audit?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      setConversations(payload.conversations ?? []);
      setMessages(payload.messages ?? []);
      setSelectedId((current) => conversationId || current || payload.conversations?.[0]?.id || "");
    } else {
      setError(payload?.error ?? "No se pudo cargar auditoria de chat.");
    }
    setLoading(false);
  }, [type, userFilter]);

  useEffect(() => { void load(""); }, [load]);
  useEffect(() => { if (selectedId) void load(selectedId); }, [load, selectedId]);

  const selected = useMemo(() => conversations.find((conversation) => conversation.id === selectedId) ?? null, [conversations, selectedId]);

  return (
    <AdminGuard>
      <div className="space-y-5">
        <header>
          <p className="text-sm font-medium text-orange-700">Auditoria administrativa</p>
          <h1 className="text-2xl font-semibold text-slate-950">Auditoria de conversaciones</h1>
          <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800">Esta vista es de auditoria administrativa. El chat normal de los usuarios sigue mostrando solo conversaciones donde participan.</p>
        </header>
        {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        <section className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-3">
          <select value={type} onChange={(event) => setType(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">Todos los tipos</option>
            <option value="direct">Privados</option>
            <option value="group">Grupos</option>
            <option value="all_company">Canal general</option>
          </select>
          <input value={userFilter} onChange={(event) => setUserFilter(event.target.value)} placeholder="Filtrar por UUID de usuario" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button type="button" onClick={() => void load(selectedId)} className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white">Actualizar</button>
        </section>

        <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3"><h2 className="font-semibold text-slate-950">Conversaciones</h2></div>
            <div className="max-h-[calc(100vh-300px)] divide-y divide-slate-100 overflow-auto">
              {loading ? <p className="p-4 text-sm text-slate-500">Cargando...</p> : null}
              {conversations.map((conversation) => (
                <button key={conversation.id} type="button" onClick={() => setSelectedId(conversation.id)} className={`block w-full p-4 text-left hover:bg-slate-50 ${selectedId === conversation.id ? "bg-orange-50" : ""}`}>
                  <p className="font-semibold text-slate-950">{title(conversation)}</p>
                  <p className="mt-1 text-xs text-slate-500">{conversation.type} - {conversation.chat_conversation_members.length} miembros - {new Date(conversation.updated_at).toLocaleString()}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold text-slate-950">{selected ? title(selected) : "Selecciona una conversacion"}</h2>
              {selected ? <p className="mt-1 text-xs text-slate-500">{selected.chat_conversation_members.map((member) => member.profiles?.email ?? member.user_id).join(", ")}</p> : null}
            </div>
            <div className="max-h-[calc(100vh-300px)] space-y-3 overflow-auto bg-slate-50 p-4">
              {messages.map((message) => (
                <div key={message.id} className="flex gap-3 rounded-md border border-slate-200 bg-white p-3 text-sm">
                  <UserAvatar name={message.profiles?.full_name ?? "Usuario"} avatarPath={message.profiles?.avatar_path} size="sm" />
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-950">{message.profiles?.full_name ?? "Usuario"}</p>
                    <p className="text-xs text-slate-400">{new Date(message.created_at).toLocaleString()} - {message.message_type}</p>
                    {message.body ? <p className="mt-2 whitespace-pre-wrap text-slate-700">{message.body}</p> : null}
                    {message.chat_attachments?.map((attachment) => <p key={attachment.id} className="mt-2 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">{attachment.file_name}</p>)}
                  </div>
                </div>
              ))}
              {!messages.length ? <p className="p-6 text-center text-sm text-slate-500">No hay mensajes para mostrar.</p> : null}
            </div>
          </section>
        </div>
      </div>
    </AdminGuard>
  );
}
