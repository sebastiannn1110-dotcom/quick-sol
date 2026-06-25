"use client";

import Image from "next/image";
import { FormEvent, useMemo, useState } from "react";
import { Send, X } from "lucide-react";
import type { Profile } from "@/lib/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function AIAssistantWidget({ profile }: { profile: Profile | null }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Hola. Soy el asistente de Quiksol. Puedo ayudarte a encontrar datos o explicar como usar el programa."
    }
  ]);

  const placeholder = useMemo(() => {
    if (profile?.role === "admin") return "Pregunta por datos, empleados, uploads o uso del panel...";
    return "Pregunta por tus archivos, registros o como usar el programa...";
  }, [profile?.role]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    const nextMessages = [...messages, { role: "user" as const, content: trimmed }];
    setMessages(nextMessages);
    setMessage("");
    setLoading(true);

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed })
      });
      const payload = (await response.json()) as { answer?: string; error?: string };
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: response.ok
            ? payload.answer ?? "No pude generar una respuesta."
            : payload.error ?? "El asistente no esta disponible ahora."
        }
      ]);
    } catch {
      setMessages([
        ...nextMessages,
        { role: "assistant", content: "No pude conectarme con el asistente. Intenta de nuevo." }
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {open ? (
        <section className="mb-3 flex h-[min(70vh,560px)] w-[min(calc(100vw-2rem),380px)] flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-950 px-4 py-3 text-white">
            <div className="flex items-center gap-3">
              <Image src="/logo-ia.png" alt="" width={32} height={32} className="rounded-md bg-white object-cover" />
              <div>
                <p className="text-sm font-semibold">Asistente Quiksol</p>
                <p className="text-xs text-slate-300">{profile?.role === "admin" ? "Modo admin" : "Modo empleado"}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label="Cerrar asistente"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">
            {messages.map((item, index) => (
              <div
                key={`${item.role}-${index}`}
                className={`max-w-[90%] rounded-md px-3 py-2 text-sm ${
                  item.role === "assistant"
                    ? "bg-white text-slate-700 shadow-sm"
                    : "ml-auto bg-brand-600 text-white"
                }`}
              >
                {item.content}
              </div>
            ))}
            {loading ? <p className="text-xs text-slate-500">Pensando...</p> : null}
          </div>

          <form onSubmit={handleSubmit} className="flex gap-2 border-t border-slate-200 bg-white p-3">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="focus-ring min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-950"
              placeholder={placeholder}
            />
            <button
              type="submit"
              disabled={loading || !message.trim()}
              className="focus-ring rounded-md bg-brand-600 p-2 text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Enviar mensaje"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="focus-ring flex h-14 w-14 items-center justify-center rounded-full border border-slate-200 bg-white p-1 shadow-xl transition hover:scale-105"
        aria-label="Abrir asistente IA"
      >
        <Image src="/logo-ia.png" alt="" width={46} height={46} className="rounded-full object-cover" />
      </button>
    </div>
  );
}
