"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Mic, PlayCircle, Send, Square, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
  audioError?: string | null;
  detectedLanguage?: string | null;
}

export default function AIAssistantWidget({ profile }: { profile: Profile | null }) {
  const { language, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
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

  useEffect(() => {
    setVoiceSupported(
      typeof window !== "undefined" &&
        typeof navigator !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia) &&
        typeof MediaRecorder !== "undefined"
    );
  }, []);

  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function preferredAudioMimeType() {
    if (typeof MediaRecorder === "undefined") return "";
    return [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
  }

  function playAudio(audioBase64: string, audioMimeType = "audio/mpeg") {
    const audio = new Audio(`data:${audioMimeType};base64,${audioBase64}`);
    void audio.play();
  }

  async function submitVoice(audioBlob: Blob) {
    const formData = new FormData();
    const extension = audioBlob.type.includes("ogg")
      ? "ogg"
      : audioBlob.type.includes("mp4")
        ? "m4a"
        : "webm";
    formData.append("audio", new File([audioBlob], `voice-message.${extension}`, { type: audioBlob.type || "audio/webm" }));
    formData.append("language", language);

    setLoading(true);
    setVoiceStatus(t("assistant.processingAudio"));

    try {
      const response = await fetch("/api/ai/voice/ask", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as {
        transcript?: string;
        answerText?: string;
        error?: string;
        audioBase64?: string | null;
        audioMimeType?: string | null;
        audioError?: string | null;
        detectedLanguage?: string | null;
      };

      if (!response.ok) {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: payload.error ?? t("assistant.unavailable") }
        ]);
        return;
      }

      const nextMessages: ChatMessage[] = [];
      if (payload.transcript) nextMessages.push({ role: "user", content: payload.transcript });
      nextMessages.push({
        role: "assistant",
        content: payload.answerText ?? t("assistant.noAnswer"),
        audioBase64: payload.audioBase64,
        audioMimeType: payload.audioMimeType,
        audioError: payload.audioError,
        detectedLanguage: payload.detectedLanguage
      });

      setMessages((current) => [...current, ...nextMessages]);

      if (payload.audioBase64) {
        setVoiceStatus(t("assistant.generatingVoice"));
        try {
          playAudio(payload.audioBase64, payload.audioMimeType ?? "audio/mpeg");
        } catch {
          // Browser autoplay can fail; the play button remains available.
        }
      }
    } catch {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: t("assistant.connection") }
      ]);
    } finally {
      setLoading(false);
      setVoiceStatus("");
    }
  }

  async function startRecording() {
    if (!voiceSupported || loading || recording) return;

    try {
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = preferredAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        if (blob.size > 0) void submitVoice(blob);
      };

      recorder.start();
      setRecording(true);
      setVoiceStatus(t("assistant.recording"));
    } catch {
      setVoiceStatus(t("assistant.voiceUnavailable"));
      setTimeout(() => setVoiceStatus(""), 3500);
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || loading || recording) return;

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
                {item.audioBase64 ? (
                  <button
                    type="button"
                    onClick={() => playAudio(item.audioBase64!, item.audioMimeType ?? "audio/mpeg")}
                    className="mt-2 flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <PlayCircle className="h-3.5 w-3.5" />
                    {t("assistant.playResponse")}
                  </button>
                ) : null}
                {item.audioError ? <p className="mt-2 text-xs text-amber-700">{item.audioError}</p> : null}
              </div>
            ))}
            {loading ? <p className="text-xs text-slate-500">{t("assistant.thinking")}</p> : null}
            {voiceStatus ? <p className="text-xs text-slate-500">{voiceStatus}</p> : null}
          </div>

          <form onSubmit={handleSubmit} className="flex gap-2 border-t border-slate-200 bg-white p-3">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="focus-ring min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-950"
              placeholder={placeholder}
            />
            <button
              type="button"
              onClick={recording ? stopRecording : startRecording}
              disabled={loading || !voiceSupported}
              className={`focus-ring rounded-md p-2 text-white disabled:cursor-not-allowed disabled:opacity-50 ${
                recording ? "bg-red-600 hover:bg-red-700" : "bg-slate-800 hover:bg-slate-900"
              }`}
              aria-label={recording ? t("assistant.stopRecording") : t("assistant.record")}
              title={!voiceSupported ? t("assistant.voiceUnavailable") : undefined}
            >
              {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
            <button
              type="submit"
              disabled={loading || recording || !message.trim()}
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
