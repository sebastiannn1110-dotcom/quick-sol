"use client";

import { useEffect, useRef } from "react";
import MessageBubble from "@/components/chat/MessageBubble";
import MessageInput from "@/components/chat/MessageInput";
import UserAvatar from "@/components/chat/UserAvatar";
import { conversationTitle } from "@/components/chat/ConversationList";
import type { ChatConversation, ChatMessage, ChatUser } from "@/components/chat/types";

export default function ChatWindow({ conversation, messages, currentUser, loading, busy, onSend, onFile }: { conversation: ChatConversation | null; messages: ChatMessage[]; currentUser: ChatUser; loading: boolean; busy: boolean; onSend: (body: string, type?: "text" | "record_reference" | "upload_reference", metadata?: Record<string, string>) => Promise<void>; onFile: (file: File) => Promise<void> }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);
  if (!conversation) return <section className="flex min-h-[520px] items-center justify-center bg-slate-50 p-6 text-center text-sm text-slate-500">Selecciona una conversacion o inicia un chat nuevo.</section>;
  const title = conversationTitle(conversation, currentUser.id);
  const other = conversation.members.find((member) => member.user_id !== currentUser.id)?.profile;
  return <section className="flex min-h-[620px] flex-col bg-slate-50"><header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3"><UserAvatar name={title} avatarPath={conversation.type === "direct" ? other?.avatar_path : null} /><div className="min-w-0"><h2 className="truncate font-semibold text-slate-950">{title}</h2><p className="text-xs text-slate-500">{conversation.type === "all_company" ? "Toda la empresa" : `${conversation.members.length} miembro${conversation.members.length === 1 ? "" : "s"}`}</p></div></header><div className="flex-1 space-y-3 overflow-y-auto p-4">{loading ? <div className="space-y-3"><div className="h-12 w-2/3 animate-pulse rounded-md bg-slate-200" /><div className="ml-auto h-12 w-1/2 animate-pulse rounded-md bg-orange-100" /></div> : messages.map((message) => <MessageBubble key={message.id} message={message} own={message.sender_id === currentUser.id} />)}{!loading && !messages.length ? <p className="py-10 text-center text-sm text-slate-500">Todavia no hay mensajes. Inicia la conversacion.</p> : null}<div ref={bottomRef} /></div><MessageInput busy={busy} onSend={onSend} onFile={onFile} /></section>;
}
