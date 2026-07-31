"use client";

import Image from "next/image";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Copy,
  History,
  RefreshCcw,
  Send,
  Square,
  Trash2,
  X
} from "lucide-react";
import AiAudioPlayer from "@/components/ai/AiAudioPlayer";
import AiVoiceRecorder, { type AiVoiceResult } from "@/components/ai/AiVoiceRecorder";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
  audioError?: string | null;
  detectedLanguage?: string | null;
  basedOnData?: boolean;
  generatedWithAi?: boolean;
  source?: string | null;
  timings?: {
    transcriptionMs?: number;
    dataLookupMs?: number;
    llmMs?: number;
    ttsMs?: number;
    totalMs?: number;
  };
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  sourceType?: string;
}

interface CompletedStreamPayload {
  answer?: string;
  timings?: ChatMessage["timings"];
  metadata?: {
    basedOnData?: boolean;
    generatedWithAi?: boolean;
    source?: string | null;
  };
}

const SAFE_ASSISTANT_FALLBACK =
  "No pude obtener todos los detalles en este momento, pero puedo mostrarte el resumen disponible.";

const TECHNICAL_LEAK_RE =
  /\b(OPEN_IA|OPENAI_MODEL|OPENAI_API_KEY|Render|Supabase|Postgres|statement timeout|service role|stack trace|DATABASE_TIMEOUT|57014|PGRST|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)\b/i;

function safeAssistantText(value: string | null | undefined, fallback: string) {
  const text = value?.trim() || fallback;
  return TECHNICAL_LEAK_RE.test(text) ? SAFE_ASSISTANT_FALLBACK : text;
}

function sourceFromStoredMessage(sourceType: string | undefined) {
  if (sourceType === "opportunity_finder") return "Opportunity Finder";
  if (sourceType === "stock_needs") return "Stock Needs";
  if (sourceType === "latest_upload") return "Latest upload";
  if (sourceType === "authorized_database") return "Authorized database";
  return null;
}

export default function AIAssistantWidget({ profile }: { profile: Profile | null }) {
  const { language, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [progressStage, setProgressStage] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [voiceAbortController, setVoiceAbortController] = useState(
    () => new AbortController()
  );
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: t("assistant.initial") }
  ]);
  const abortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const ux = useMemo(() => {
    if (language === "en") {
      return {
        history: "Conversation history",
        deleteConversation: "Delete conversation",
        copy: "Copy response",
        cancel: "Cancel request",
        inputLabel: "Message for the AI assistant",
        basedOnData: "Data-based response",
        generatedWithAi: "AI-generated response",
        voiceConsent: "Voice consent: audio is sent to OpenAI for transcription, and response text may be sent to ElevenLabs for speech.",
        validating: "Validating request…",
        searching: "Searching authorized data…",
        processing: "Processing results…",
        generating: "Generating response…",
        completed: "Completed",
        noHistory: "No saved conversations yet."
      };
    }
    if (language === "zh") {
      return {
        history: "对话历史",
        deleteConversation: "删除对话",
        copy: "复制回复",
        cancel: "取消请求",
        inputLabel: "发送给人工智能助手的消息",
        basedOnData: "基于数据的回复",
        generatedWithAi: "人工智能生成的回复",
        voiceConsent: "语音同意说明：音频将发送给 OpenAI 进行转写，回复文本可能发送给 ElevenLabs 生成语音。",
        validating: "正在验证请求…",
        searching: "正在搜索授权数据…",
        processing: "正在处理结果…",
        generating: "正在生成回复…",
        completed: "已完成",
        noHistory: "尚无已保存的对话。"
      };
    }
    return {
      history: "Historial de conversaciones",
      deleteConversation: "Eliminar conversación",
      copy: "Copiar respuesta",
      cancel: "Cancelar solicitud",
      inputLabel: "Mensaje para el asistente de IA",
      basedOnData: "Respuesta basada en datos",
      generatedWithAi: "Respuesta generada con IA",
      voiceConsent: "Consentimiento de voz: el audio se envía a OpenAI para transcribirlo y el texto de respuesta puede enviarse a ElevenLabs para generar voz.",
      validating: "Validando solicitud…",
      searching: "Buscando datos autorizados…",
      processing: "Procesando resultados…",
      generating: "Generando respuesta…",
      completed: "Completado",
      noHistory: "Todavía no hay conversaciones guardadas."
    };
  }, [language]);

  const placeholder = useMemo(() => {
    if (profile?.role === "admin") return t("assistant.placeholder.admin");
    return t("assistant.placeholder.employee");
  }, [profile?.role, t]);

  const progressText = progressStage
    ? ux[progressStage as keyof typeof ux] ?? progressStage
    : null;

  const loadConversationList = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/conversations", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { conversations?: ConversationSummary[] };
      setConversations(payload.conversations ?? []);
    } catch {
      // History is optional; the active assistant remains available.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadConversationList();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [loadConversationList, open]);

  useEffect(() => {
    setMessages((currentMessages) => {
      if (activeConversationId || currentMessages.length !== 1 || currentMessages[0]?.role !== "assistant") {
        return currentMessages;
      }
      return [{ role: "assistant", content: t("assistant.initial") }];
    });
  }, [activeConversationId, t]);

  const cancelRequest = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    voiceAbortController.abort();
    setVoiceAbortController(new AbortController());
    setLoading(false);
    setProgressStage(null);
  }, [voiceAbortController]);

  const closeDialog = useCallback(() => {
    cancelRequest();
    setOpen(false);
    setHistoryOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [cancelRequest]);

  function resetConversation() {
    cancelRequest();
    setActiveConversationId(null);
    setMessages([{ role: "assistant", content: t("assistant.initial") }]);
    setMessage("");
    setHistoryOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function createConversation(title: string, signal?: AbortSignal) {
    const response = await fetch("/api/ai/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.slice(0, 80), language }),
      signal
    });
    if (!response.ok) throw new Error("conversation_create_failed");
    const payload = (await response.json()) as { conversation?: ConversationSummary };
    if (!payload.conversation?.id) throw new Error("conversation_create_failed");
    setActiveConversationId(payload.conversation.id);
    return payload.conversation.id;
  }

  async function ensureConversation(title: string, signal?: AbortSignal) {
    return activeConversationId ?? createConversation(title, signal);
  }

  async function loadConversation(conversationId: string) {
    cancelRequest();
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, {
      cache: "no-store"
    });
    if (!response.ok) return;
    const payload = (await response.json()) as {
      messages?: StoredMessage[];
    };
    const storedMessages = (payload.messages ?? []).map<ChatMessage>((item) => {
      const source = sourceFromStoredMessage(item.sourceType);
      return {
        role: item.role,
        content: item.content,
        source,
        basedOnData: Boolean(source)
      };
    });
    setActiveConversationId(conversationId);
    setMessages(storedMessages.length ? storedMessages : [{ role: "assistant", content: t("assistant.initial") }]);
    setHistoryOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function deleteConversation(conversationId: string) {
    cancelRequest();
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE"
    });
    if (!response.ok) return;
    setConversations((current) => current.filter((item) => item.id !== conversationId));
    if (activeConversationId === conversationId) resetConversation();
  }

  async function appendStoredMessage(
    conversationId: string,
    storedMessage: {
      role: "user" | "assistant";
      content: string;
      sourceType: "user" | "assistant";
    }
  ) {
    await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...storedMessage, language })
    });
  }

  async function handleVoiceResult(payload: AiVoiceResult) {
    const nextMessages: ChatMessage[] = [];
    if (payload.transcript) nextMessages.push({ role: "user", content: payload.transcript });
    nextMessages.push({
      role: "assistant",
      content: safeAssistantText(payload.answerText, t("assistant.noAnswer")),
      audioBase64: payload.audioBase64,
      audioMimeType: payload.audioMimeType,
      audioError: payload.audioError
        ? safeAssistantText(payload.audioError, t("assistant.audioUnavailable"))
        : null,
      detectedLanguage: payload.detectedLanguage,
      generatedWithAi: Boolean(payload.timings?.llmMs),
      timings: payload.timings
    });
    setMessages((current) => [...current, ...nextMessages]);

    try {
      const conversationId = await ensureConversation(payload.transcript || t("assistant.title"));
      if (payload.transcript) {
        await appendStoredMessage(conversationId, {
          role: "user",
          content: payload.transcript,
          sourceType: "user"
        });
      }
      await appendStoredMessage(conversationId, {
        role: "assistant",
        content: safeAssistantText(payload.answerText, t("assistant.noAnswer")),
        sourceType: "assistant"
      });
      await loadConversationList();
    } catch {
      // Voice response remains usable even if optional history persistence fails.
    }
  }

  function handleVoiceError(errorMessage: string) {
    setMessages((current) => [
      ...current,
      { role: "assistant", content: safeAssistantText(errorMessage, t("assistant.microphoneError")) }
    ]);
  }

  async function copyResponse(content: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Clipboard access can be denied by the browser.
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || loading || voiceBusy) return;

    setMessages((current) => [...current, { role: "user", content: trimmed }]);
    setMessage("");
    setLoading(true);
    setProgressStage("validating");
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const conversationId = await ensureConversation(trimmed, abortController.signal);
      if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await fetch("/api/ai/assistant/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, language, conversationId }),
        signal: abortController.signal
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "assistant_unavailable");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed: CompletedStreamPayload | null = null;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const eventName = block
            .split("\n")
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          const payload = JSON.parse(data) as CompletedStreamPayload & {
            stage?: string;
            error?: string;
          };
          if (eventName === "progress" && payload.stage) setProgressStage(payload.stage);
          if (eventName === "error") throw new Error(payload.error || "assistant_unavailable");
          if (eventName === "completed") completed = payload;
        }
      }
      if (!completed?.answer) throw new Error("assistant_no_answer");
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: safeAssistantText(completed?.answer, t("assistant.noAnswer")),
          timings: completed?.timings,
          basedOnData: completed?.metadata?.basedOnData,
          generatedWithAi: completed?.metadata?.generatedWithAi,
          source: completed?.metadata?.source
        }
      ]);
      await loadConversationList();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: t("assistant.connection") }
        ]);
      }
    } finally {
      if (abortRef.current === abortController) abortRef.current = null;
      setLoading(false);
      setProgressStage(null);
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {open ? (
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-assistant-dialog-title"
          onKeyDown={handleDialogKeyDown}
          className="mb-3 flex h-[min(75dvh,620px)] w-[min(calc(100vw-2rem),420px)] flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between gap-1 border-b border-slate-200 bg-slate-950 px-3 py-3 text-white">
            <div className="mr-auto flex min-w-0 items-center gap-3">
              <Image src="/logo-ia.png" alt="" width={32} height={32} className="rounded-md bg-white object-cover" />
              <div className="min-w-0">
                <p id="ai-assistant-dialog-title" className="truncate text-sm font-semibold">
                  {t("assistant.title")}
                </p>
                <p className="truncate text-xs text-slate-300">
                  {profile?.role === "admin" ? t("assistant.modeAdmin") : t("assistant.modeEmployee")}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="focus-ring rounded-md p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label={ux.history}
              aria-expanded={historyOpen}
            >
              <History className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={resetConversation}
              className="focus-ring rounded-md p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label={t("assistant.newQuestion")}
              title={t("assistant.newQuestion")}
            >
              <RefreshCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={closeDialog}
              className="focus-ring rounded-md p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label={t("assistant.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {historyOpen ? (
            <div className="max-h-52 overflow-y-auto border-b border-slate-200 bg-white p-3" aria-label={ux.history}>
              {conversations.length ? (
                <ul className="space-y-1">
                  {conversations.map((conversation) => (
                    <li key={conversation.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void loadConversation(conversation.id)}
                        className="focus-ring min-w-0 flex-1 truncate rounded-md px-2 py-2 text-left text-sm hover:bg-slate-100"
                      >
                        {conversation.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteConversation(conversation.id)}
                        className="focus-ring rounded-md p-2 text-red-600 hover:bg-red-50"
                        aria-label={`${ux.deleteConversation}: ${conversation.title}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">{ux.noHistory}</p>
              )}
            </div>
          ) : null}

          <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4" aria-live="polite" aria-relevant="additions text">
            {messages.map((item, index) => (
              <div
                key={`${item.role}-${index}`}
                className={`group max-w-[90%] rounded-md px-3 py-2 text-sm ${
                  item.role === "assistant"
                    ? "whitespace-pre-wrap bg-white text-slate-700 shadow-sm"
                    : "ml-auto whitespace-pre-wrap bg-brand-600 text-white"
                }`}
              >
                {item.content}
                {item.role === "assistant" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
                    {item.basedOnData ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                        {ux.basedOnData}
                      </span>
                    ) : null}
                    {item.generatedWithAi ? (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">
                        {ux.generatedWithAi}
                      </span>
                    ) : null}
                    {item.source ? (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                        {item.source}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void copyResponse(item.content)}
                      className="focus-ring ml-auto rounded p-1 text-slate-500 hover:bg-slate-100"
                      aria-label={ux.copy}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
                {item.audioBase64 ? (
                  <AiAudioPlayer audioBase64={item.audioBase64} audioMimeType={item.audioMimeType} t={t} />
                ) : null}
                {item.audioError ? <p className="mt-2 text-xs text-amber-700">{item.audioError}</p> : null}
                {item.timings?.totalMs ? (
                  <p className="mt-2 text-[11px] text-slate-500">
                    {t("assistant.processingTime")}: {(item.timings.totalMs / 1000).toFixed(1)}s
                    {item.timings.ttsMs ? ` · voz ${(item.timings.ttsMs / 1000).toFixed(1)}s` : ""}
                  </p>
                ) : null}
              </div>
            ))}
            {loading && progressText ? (
              <p role="status" className="text-xs text-slate-500">
                {progressText}
              </p>
            ) : null}
          </div>

          <div className="border-t border-slate-200 bg-white">
            <p className="px-3 pt-2 text-[11px] leading-4 text-slate-500">
              {ux.voiceConsent}
            </p>
          <form onSubmit={handleSubmit} className="flex gap-2 p-3 pt-2">
            <label htmlFor="ai-assistant-input" className="sr-only">
              {ux.inputLabel}
            </label>
            <input
              ref={inputRef}
              id="ai-assistant-input"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={loading || voiceBusy}
              maxLength={2_000}
              className="focus-ring min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-950"
              placeholder={placeholder}
            />
            {loading || voiceBusy ? (
              <button
                type="button"
                onClick={cancelRequest}
                className="focus-ring rounded-md border border-red-200 p-2 text-red-700 hover:bg-red-50"
                aria-label={ux.cancel}
              >
                <Square className="h-4 w-4" />
              </button>
            ) : null}
            {!loading ? (
              <AiVoiceRecorder
                disabled={loading}
                language={language}
                t={t}
                cancelSignal={voiceAbortController.signal}
                onBusyChange={setVoiceBusy}
                onVoiceResult={handleVoiceResult}
                onErrorMessage={handleVoiceError}
              />
            ) : null}
            <button
              type="submit"
              disabled={loading || voiceBusy || !message.trim()}
              className="focus-ring rounded-md bg-brand-600 p-2 text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t("assistant.send")}
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
          </div>
        </section>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="focus-ring flex h-14 w-14 items-center justify-center rounded-full border border-slate-200 bg-white p-1 shadow-xl transition hover:scale-105"
        aria-label={t("assistant.open")}
        aria-expanded={open}
      >
        <Image src="/logo-ia.png" alt="" width={46} height={46} className="rounded-full object-cover" />
      </button>
    </div>
  );
}
