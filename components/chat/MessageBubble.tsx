"use client";

import { FileText } from "lucide-react";
import UserAvatar from "@/components/chat/UserAvatar";
import type { ChatMessage } from "@/components/chat/types";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function MessageBubble({ message, own }: { message: ChatMessage; own: boolean }) {
  if (message.message_type === "system") return <p className="my-3 text-center text-xs text-slate-500">{message.body}</p>;
  return (
    <div className={`flex items-end gap-2 ${own ? "justify-end" : "justify-start"}`}>
      {!own ? <UserAvatar name={message.sender?.full_name || "Usuario"} avatarPath={message.sender?.avatar_path} size="sm" /> : null}
      <div className={`max-w-[85%] rounded-md px-3 py-2 text-sm shadow-sm sm:max-w-[70%] ${own ? "bg-orange-600 text-white" : "border border-slate-200 bg-white text-slate-800"}`}>
        {!own ? <p className="mb-1 text-xs font-semibold text-orange-700">{message.sender?.full_name || "Usuario"}</p> : null}
        {message.body ? <p className="whitespace-pre-wrap break-words">{message.body}</p> : null}
        {message.message_type === "record_reference" || message.message_type === "upload_reference" ? <a href={message.message_type === "record_reference" ? `/records?query=${encodeURIComponent(String(message.metadata.referenceId ?? ""))}` : "/upload"} className={`mt-2 block rounded-md border px-3 py-2 text-xs font-semibold ${own ? "border-orange-300 bg-orange-700" : "border-slate-200 bg-slate-50"}`}>Abrir {message.message_type === "record_reference" ? "registro" : "carga"}: {String(message.metadata.referenceId ?? "referencia")}</a> : null}
        {message.chat_attachments?.map((attachment) => <a key={attachment.id} href={`/api/chat/attachments/${attachment.id}`} target="_blank" rel="noreferrer" className={`mt-2 flex items-center gap-2 rounded-md border px-3 py-2 ${own ? "border-orange-300 bg-orange-700" : "border-slate-200 bg-slate-50"}`}><FileText className="h-4 w-4" /><span className="min-w-0"><span className="block truncate font-semibold">{attachment.file_name}</span><span className="text-xs opacity-75">{formatBytes(attachment.file_size)}</span></span></a>)}
        <p className={`mt-1 text-right text-[10px] ${own ? "text-orange-100" : "text-slate-400"}`}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
      </div>
    </div>
  );
}
