"use client";

import { useRef } from "react";
import { Paperclip } from "lucide-react";

export default function ChatAttachmentUpload({ disabled, onFile }: { disabled: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <><button type="button" disabled={disabled} onClick={() => inputRef.current?.click()} title="Adjuntar archivo" className="focus-ring rounded-md border border-slate-300 p-2.5 text-slate-600 hover:bg-slate-50 disabled:opacity-50"><Paperclip className="h-4 w-4" /></button><input ref={inputRef} className="hidden" type="file" accept=".pdf,.txt,.csv,.xls,.xlsx,image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ""; }} /></>;
}
