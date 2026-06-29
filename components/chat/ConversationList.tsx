"use client";

import { Search } from "lucide-react";
import UserAvatar from "@/components/chat/UserAvatar";
import type { ChatConversation, ChatUser } from "@/components/chat/types";

export function conversationTitle(conversation: ChatConversation, currentUserId: string) {
  if (conversation.type !== "direct") return conversation.name || "Grupo sin nombre";
  return conversation.members.find((member) => member.user_id !== currentUserId)?.profile?.full_name || "Conversacion directa";
}

export default function ConversationList({ conversations, currentUser, activeId, search, onSearch, onSelect }: { conversations: ChatConversation[]; currentUser: ChatUser; activeId: string; search: string; onSearch: (value: string) => void; onSelect: (id: string) => void }) {
  return (
    <aside className="border-b border-slate-200 bg-white lg:border-b-0 lg:border-r">
      <div className="border-b border-slate-200 p-3"><label className="relative block"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar conversaciones" className="focus-ring w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm" /></label></div>
      <div className="max-h-64 overflow-auto lg:max-h-[calc(100vh-260px)]">
        {conversations.map((conversation) => {
          const title = conversationTitle(conversation, currentUser.id);
          const other = conversation.members.find((member) => member.user_id !== currentUser.id)?.profile;
          const me = conversation.members.find((member) => member.user_id === currentUser.id);
          const unread = Boolean(conversation.latestMessage && conversation.latestMessage.sender_id !== currentUser.id && (!me?.last_read_at || new Date(conversation.latestMessage.created_at) > new Date(me.last_read_at)));
          return <button type="button" key={conversation.id} onClick={() => onSelect(conversation.id)} className={`flex w-full items-start gap-3 border-b border-slate-100 p-3 text-left transition ${activeId === conversation.id ? "bg-orange-50" : "hover:bg-slate-50"}`}><UserAvatar name={title} avatarPath={conversation.type === "direct" ? other?.avatar_path : null} /><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-slate-950">{title}</span>{conversation.latestMessage ? <span className="shrink-0 text-[11px] text-slate-400">{new Date(conversation.latestMessage.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}</span><span className="mt-1 flex items-center justify-between gap-2"><span className="truncate text-xs text-slate-500">{conversation.latestMessage?.body || (conversation.type === "all_company" ? "Canal de toda la empresa" : "Sin mensajes")}</span>{unread ? <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-orange-500" aria-label="Mensaje no leido" /> : null}</span></span></button>;
        })}
        {!conversations.length ? <p className="p-6 text-center text-sm text-slate-500">No hay conversaciones todavia.</p> : null}
      </div>
    </aside>
  );
}
