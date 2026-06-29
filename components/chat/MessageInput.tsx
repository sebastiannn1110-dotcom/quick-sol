"use client";

import { FormEvent, useState } from "react";
import { Link2, Send } from "lucide-react";
import ChatAttachmentUpload from "@/components/chat/ChatAttachmentUpload";

export default function MessageInput({ busy, onSend, onFile }: { busy: boolean; onSend: (body: string, messageType?: "text" | "record_reference" | "upload_reference", metadata?: Record<string, string>) => Promise<void>; onFile: (file: File) => Promise<void> }) {
  const [body, setBody] = useState("");
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceType, setReferenceType] = useState<"record_reference" | "upload_reference">("record_reference");
  const [referenceId, setReferenceId] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const value = body.trim(); if (!value || busy) return; await onSend(value); setBody(""); }
  async function shareReference() { if (!referenceId.trim() || busy) return; await onSend(`Comparto ${referenceType === "record_reference" ? "el registro" : "la carga"} ${referenceId.trim()}.`, referenceType, { referenceId: referenceId.trim() }); setReferenceId(""); setReferenceOpen(false); }
  return <div className="border-t border-slate-200 bg-white p-3">{referenceOpen ? <div className="mb-3 grid gap-2 rounded-md bg-slate-50 p-3 sm:grid-cols-[160px_1fr_auto]"><select value={referenceType} onChange={(event) => setReferenceType(event.target.value as typeof referenceType)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="record_reference">Registro</option><option value="upload_reference">Excel / carga</option></select><input value={referenceId} onChange={(event) => setReferenceId(event.target.value)} placeholder="ID o referencia" className="rounded-md border border-slate-300 px-3 py-2 text-sm" /><button type="button" onClick={() => void shareReference()} className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Compartir</button></div> : null}<form onSubmit={submit} className="flex items-end gap-2"><ChatAttachmentUpload disabled={busy} onFile={(file) => void onFile(file)} /><button type="button" onClick={() => setReferenceOpen((open) => !open)} title="Compartir registro o carga" className="focus-ring rounded-md border border-slate-300 p-2.5 text-slate-600 hover:bg-slate-50"><Link2 className="h-4 w-4" /></button><textarea rows={1} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Escribe un mensaje" className="focus-ring max-h-32 min-h-10 flex-1 resize-y rounded-md border border-slate-300 px-3 py-2.5 text-sm" /><button disabled={busy || !body.trim()} className="focus-ring rounded-md bg-orange-600 p-2.5 text-white disabled:opacity-50" title="Enviar"><Send className="h-4 w-4" /></button></form></div>;
}
