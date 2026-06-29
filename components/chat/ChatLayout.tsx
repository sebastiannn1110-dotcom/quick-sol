"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import ChatWindow from "@/components/chat/ChatWindow";
import ConversationList, { conversationTitle } from "@/components/chat/ConversationList";
import CreateGroupDialog from "@/components/chat/CreateGroupDialog";
import type { ChatConversation, ChatMessage, ChatUser } from "@/components/chat/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function ChatLayout() {
  const [currentUser, setCurrentUser] = useState<ChatUser | null>(null);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");

  const loadConversations = useCallback(async () => {
    const response = await fetch("/api/chat/conversations", { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) { setError(payload?.error ?? "No se pudieron cargar las conversaciones."); return; }
    setConversations(payload.conversations ?? []);
    setActiveId((current) => current || payload.conversations?.[0]?.id || "");
  }, []);

  const loadMessages = useCallback(async (conversationId: string, silent = false) => {
    if (!conversationId) { setMessages([]); return; }
    if (!silent) setMessagesLoading(true);
    const response = await fetch(`/api/chat/conversations/${conversationId}/messages`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      setMessages(payload.messages ?? []);
      void fetch(`/api/chat/conversations/${conversationId}/read`, { method: "PATCH" });
    } else setError(payload?.error ?? "No se pudieron cargar los mensajes.");
    if (!silent) setMessagesLoading(false);
  }, []);

  useEffect(() => {
    async function initialLoad() {
      setLoading(true);
      const [profileResponse, usersResponse] = await Promise.all([
        fetch("/api/me", { cache: "no-store" }),
        fetch("/api/chat/users", { cache: "no-store" })
      ]);
      if (profileResponse.ok) setCurrentUser((await profileResponse.json()).profile);
      if (usersResponse.ok) setUsers((await usersResponse.json()).users ?? []);
      await loadConversations();
      setLoading(false);
    }
    void initialLoad();
  }, [loadConversations]);

  useEffect(() => { void loadMessages(activeId); }, [activeId, loadMessages]);

  useEffect(() => {
    if (!activeId) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase?.channel(`chat:${activeId}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: `conversation_id=eq.${activeId}` }, () => {
      void loadMessages(activeId, true);
      void loadConversations();
    }).subscribe();
    const fallback = window.setInterval(() => void loadMessages(activeId, true), 12_000);
    return () => {
      window.clearInterval(fallback);
      if (supabase && channel) void supabase.removeChannel(channel);
    };
  }, [activeId, loadConversations, loadMessages]);

  const activeConversation = conversations.find((conversation) => conversation.id === activeId) ?? null;
  const filteredConversations = useMemo(() => {
    if (!currentUser) return conversations;
    const query = search.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((conversation) => conversationTitle(conversation, currentUser.id).toLowerCase().includes(query));
  }, [conversations, currentUser, search]);

  async function sendMessage(body: string, messageType: "text" | "record_reference" | "upload_reference" = "text", metadata: Record<string, string> = {}) {
    if (!activeId) return;
    setBusy(true); setError("");
    const response = await fetch(`/api/chat/conversations/${activeId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, messageType, metadata }) });
    const payload = await response.json().catch(() => null);
    if (response.ok) { setMessages((current) => [...current, payload.message]); await loadConversations(); }
    else setError(payload?.error ?? "No se pudo enviar el mensaje.");
    setBusy(false);
  }

  async function uploadFile(file: File) {
    if (!activeId) return;
    setBusy(true); setError("");
    const form = new FormData(); form.set("file", file);
    const response = await fetch(`/api/chat/conversations/${activeId}/attachments`, { method: "POST", body: form });
    const payload = await response.json().catch(() => null);
    if (response.ok) { setMessages((current) => [...current, payload.message]); await loadConversations(); }
    else setError(payload?.error ?? "No se pudo adjuntar el archivo.");
    setBusy(false);
  }

  async function created(id: string) {
    setDialogOpen(false);
    await loadConversations();
    setActiveId(id);
  }

  if (loading || !currentUser) return <div className="grid min-h-[620px] animate-pulse rounded-md border border-slate-200 bg-white lg:grid-cols-[320px_1fr]"><div className="border-r border-slate-200 bg-slate-100" /><div className="bg-slate-50" /></div>;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-medium text-brand-700">Colaboracion segura</p><h1 className="text-2xl font-semibold text-slate-950">Chat interno</h1><p className="mt-1 text-sm text-slate-600">Conversaciones privadas y grupos protegidos por membresia.</p></div><button type="button" onClick={() => setDialogOpen(true)} className="flex items-center gap-2 rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white"><MessageSquarePlus className="h-4 w-4" />Nueva conversacion</button></header>
      {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm lg:grid lg:grid-cols-[320px_minmax(0,1fr)]"><ConversationList conversations={filteredConversations} currentUser={currentUser} activeId={activeId} search={search} onSearch={setSearch} onSelect={setActiveId} /><ChatWindow conversation={activeConversation} messages={messages} currentUser={currentUser} loading={messagesLoading} busy={busy} onSend={sendMessage} onFile={uploadFile} /></div>
      {dialogOpen ? <CreateGroupDialog users={users} canCreateGroup={currentUser.role === "admin"} currentUserId={currentUser.id} onClose={() => setDialogOpen(false)} onCreated={(id) => void created(id)} /> : null}
    </div>
  );
}
