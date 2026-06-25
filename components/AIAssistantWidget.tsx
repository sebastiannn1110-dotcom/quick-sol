"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Send, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function AIAssistantWidget({ profile }: { profile: Profile | null }) {
  const { language, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: t("assistant.initial")
    }
  ]);

  const placeholder = useMemo(() => {
    if (profile?.role === "admin") return t("assistant.placeholder.admin");
    return t("assistant.placeholder.employee");
  }, [profile?.role, t]);

  useEffect(() => {
    setMessages((currentMessages) => {
      if (currentMessages.length !== 1 || currentMessages[0]?.role !== "assistant") return currentMessages;
      return [{ role: "assistant", content: t("assistant.initial") }];
    });
  }, [t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    const nextMessages = [...messages, { role: "user" as const, content: trimmed }];
    setMessages(nextMessages);
    setMessage("");
    setLoading(true);

    try {
      const response = await fetch("/api/ai/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, language })
      });
      const payload = (await response.json()) as { answer?: string; error?: string };
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: response.ok
            ? payload.answer ?? t("assistant.noAnswer")
            : payload.error ?? t("assistant.unavailable")
        }
      ]);
    } catch {
      setMessages([
        ...nextMessages,
        { role: "assistant", content: t("assistant.connection") }
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
                <p className="text-sm font-semibold">{t("assistant.title")}</p>
                <p className="text-xs text-slate-300">{profile?.role === "admin" ? t("assistant.modeAdmin") : t("assistant.modeEmployee")}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label={t("assistant.close")}
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
                    ? "whitespace-pre-wrap bg-white text-slate-700 shadow-sm"
                    : "ml-auto whitespace-pre-wrap bg-brand-600 text-white"
                }`}
              >
                {item.content}
              </div>
            ))}
            {loading ? <p className="text-xs text-slate-500">{t("assistant.thinking")}</p> : null}
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
              aria-label={t("assistant.send")}
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
        aria-label={t("assistant.open")}
      >
        <Image src="/logo-ia.png" alt="" width={46} height={46} className="rounded-full object-cover" />
      </button>
    </div>
  );
}
