"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Square, Upload } from "lucide-react";
import type { TranslationKey } from "@/lib/i18n";

export type RecorderState =
  | "idle"
  | "requesting_permission"
  | "recording"
  | "stopping"
  | "uploading"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export interface AiVoiceResult {
  transcript?: string;
  answerText?: string;
  error?: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
  audioError?: string | null;
  detectedLanguage?: string | null;
}

interface AiVoiceRecorderProps {
  disabled?: boolean;
  language: string;
  t: (key: TranslationKey) => string;
  onBusyChange?: (busy: boolean) => void;
  onVoiceResult: (result: AiVoiceResult) => void;
  onErrorMessage: (message: string) => void;
  onPlayAudio?: (audioBase64: string, audioMimeType?: string) => Promise<void>;
}

const AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg;codecs=opus"
];

const BUSY_STATES = new Set<RecorderState>([
  "requesting_permission",
  "recording",
  "stopping",
  "uploading",
  "transcribing",
  "thinking",
  "speaking"
]);

function getBestSupportedAudioMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  return AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function createRecorder(stream: MediaStream) {
  const mimeType = getBestSupportedAudioMimeType();
  return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
}

function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function canUseLiveMicrophone() {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function isSecureMicContext() {
  if (typeof window === "undefined") return false;
  return window.isSecureContext || isLocalhost(window.location.hostname);
}

function getErrorName(error: unknown) {
  if (error instanceof DOMException) return error.name;
  if (error instanceof Error) return error.name;
  return "";
}

function getMicrophoneErrorMessage(error: unknown, t: (key: TranslationKey) => string) {
  switch (getErrorName(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return t("assistant.permissionBlocked");
    case "NotFoundError":
    case "DevicesNotFoundError":
      return t("assistant.noMicrophone");
    case "NotReadableError":
    case "TrackStartError":
      return t("assistant.microphoneBusy");
    case "SecurityError":
      return t("assistant.microphoneSecurity");
    case "AbortError":
      return t("assistant.captureCancelled");
    default:
      return t("assistant.microphoneError");
  }
}

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function normalizeAudioMimeType(mimeType: string) {
  return mimeType.split(";")[0]?.trim().toLowerCase() || "audio/webm";
}

async function logClientVoiceEvent(action: string, message: string, metadata?: Record<string, unknown>, level: "info" | "warn" | "error" = "info") {
  if (typeof window === "undefined") return;
  try {
    await fetch("/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level,
        action,
        message,
        route: window.location.pathname,
        metadata
      })
    });
  } catch {
    // Client-side logging must never interrupt recording.
  }
}

export default function AiVoiceRecorder({
  disabled = false,
  language,
  t,
  onBusyChange,
  onVoiceResult,
  onErrorMessage,
  onPlayAudio
}: AiVoiceRecorderProps) {
  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [humanError, setHumanError] = useState("");
  const [showFallback, setShowFallback] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const elapsedSecondsRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = BUSY_STATES.has(recorderState);

  useEffect(() => {
    setShowFallback(!canUseLiveMicrophone());
  }, []);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (recorderState !== "recording") {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }

    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    timerRef.current = window.setInterval(() => {
      if (!startedAtRef.current) return;
      const nextElapsedSeconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
      elapsedSecondsRef.current = nextElapsedSeconds;
      setElapsedSeconds(nextElapsedSeconds);
    }, 1000);

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [recorderState]);

  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      stopMediaStream(streamRef.current);
    };
  }, []);

  const statusLabel = useMemo(() => {
    if (humanError) return humanError;
    if (autoplayBlocked) return t("assistant.autoplayBlocked");
    switch (recorderState) {
      case "requesting_permission":
        return t("assistant.requestingPermission");
      case "recording":
        return `${t("assistant.recording")} ${elapsedSeconds}s`;
      case "stopping":
        return t("assistant.stoppingRecording");
      case "uploading":
        return t("assistant.uploadingAudio");
      case "transcribing":
        return t("assistant.transcribingAudio");
      case "thinking":
        return t("assistant.thinking");
      case "speaking":
        return t("assistant.speaking");
      case "error":
        return humanError || t("assistant.microphoneError");
      default:
        return "";
    }
  }, [autoplayBlocked, elapsedSeconds, humanError, recorderState, t]);

  function resetRecorderRefs() {
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    startedAtRef.current = null;
    elapsedSecondsRef.current = 0;
    setElapsedSeconds(0);
  }

  async function submitAudio(audioBlob: Blob) {
    const rawMimeType = audioBlob.type || "audio/webm";
    const mimeType = normalizeAudioMimeType(rawMimeType);
    const extension = extensionForMimeType(mimeType);
    const formData = new FormData();
    formData.append("audio", new File([audioBlob], `voice-message.${extension}`, { type: mimeType }));
    formData.append("language", language);

    setAutoplayBlocked(false);
    setHumanError("");
    setRecorderState("uploading");
    await logClientVoiceEvent("voice_audio_upload_started", "Voice audio upload started.", {
      fileSize: audioBlob.size,
      fileType: mimeType,
      rawFileType: rawMimeType
    });

    try {
      const request = fetch("/api/ai/voice/ask", {
        method: "POST",
        body: formData
      });
      setRecorderState("transcribing");
      const response = await request;
      setRecorderState("thinking");
      const payload = (await response.json()) as AiVoiceResult;

      if (!response.ok) {
        const errorMessage = payload.error ?? t("assistant.transcriptionFailed");
        setRecorderState("error");
        setHumanError(errorMessage);
        onErrorMessage(errorMessage);
        await logClientVoiceEvent(
          "voice_audio_upload_failed",
          "Voice audio upload failed.",
          { status: response.status, error: errorMessage },
          "warn"
        );
        return;
      }

      onVoiceResult(payload);

      if (payload.audioBase64 && onPlayAudio) {
        setRecorderState("speaking");
        try {
          await onPlayAudio(payload.audioBase64, payload.audioMimeType ?? "audio/mpeg");
        } catch {
          setAutoplayBlocked(true);
        }
      }

      setRecorderState("idle");
    } catch (error) {
      const errorMessage = t("assistant.connection");
      setRecorderState("error");
      setHumanError(errorMessage);
      onErrorMessage(errorMessage);
      await logClientVoiceEvent(
        "voice_audio_upload_failed",
        "Voice audio upload failed.",
        { error: error instanceof Error ? error.message : "unknown_error" },
        "error"
      );
    }
  }

  async function handleRecorderStop() {
    const recorder = recorderRef.current;
    const chunks = chunksRef.current;
    const mimeType = recorder?.mimeType || chunks[0]?.type || "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });
    const durationSeconds = elapsedSecondsRef.current;

    resetRecorderRefs();
    setRecorderState("uploading");

    await logClientVoiceEvent("voice_recording_stopped", "Voice recording stopped.", {
      durationSeconds,
      chunks: chunks.length
    });

    if (!blob.size) {
      const errorMessage = t("assistant.emptyRecording");
      setRecorderState("error");
      setHumanError(errorMessage);
      onErrorMessage(errorMessage);
      return;
    }

    await logClientVoiceEvent("voice_audio_blob_created", "Voice audio blob created.", {
      fileSize: blob.size,
      fileType: blob.type
    });
    await submitAudio(blob);
  }

  async function startRecording() {
    if (disabled || busy) return;
    setAutoplayBlocked(false);
    setHumanError("");

    if (!isSecureMicContext()) {
      const errorMessage = t("assistant.recordingRequiresHttps");
      setRecorderState("error");
      setHumanError(errorMessage);
      setShowFallback(true);
      onErrorMessage(errorMessage);
      return;
    }

    if (!canUseLiveMicrophone()) {
      const errorMessage = t("assistant.voiceUnavailable");
      setRecorderState("error");
      setHumanError(errorMessage);
      setShowFallback(true);
      onErrorMessage(errorMessage);
      return;
    }

    setRecorderState("requesting_permission");
    await logClientVoiceEvent("voice_permission_requested", "Voice microphone permission requested.");

    try {
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      await logClientVoiceEvent("voice_permission_granted", "Voice microphone permission granted.");

      const recorder = createRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = (event) => {
        const message = event.error?.message || t("assistant.microphoneError");
        setRecorderState("error");
        setHumanError(message);
        setShowFallback(true);
        onErrorMessage(message);
      };
      recorder.onstop = () => {
        void handleRecorderStop();
      };

      recorder.start();
      setRecorderState("recording");
      await logClientVoiceEvent("voice_recording_started", "Voice recording started.", {
        mimeType: recorder.mimeType || "browser_default"
      });
    } catch (error) {
      resetRecorderRefs();
      const errorMessage = getMicrophoneErrorMessage(error, t);
      setRecorderState("error");
      setHumanError(errorMessage);
      setShowFallback(true);
      onErrorMessage(errorMessage);
      await logClientVoiceEvent(
        "voice_permission_denied",
        "Voice microphone permission failed.",
        { errorName: getErrorName(error) || "unknown_error" },
        "warn"
      );
    }
  }

  function stopRecording() {
    if (!recorderRef.current || recorderRef.current.state === "inactive") return;
    setRecorderState("stopping");
    recorderRef.current.stop();
  }

  function openAudioFallback() {
    fileInputRef.current?.click();
  }

  function handleAudioFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || disabled || busy) return;
    void submitAudio(file);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/webm,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/m4a,audio/ogg,video/webm"
          capture
          className="hidden"
          onChange={handleAudioFileChange}
        />
        <button
          type="button"
          onClick={recorderState === "recording" ? stopRecording : startRecording}
          disabled={disabled || (busy && recorderState !== "recording")}
          className={`focus-ring rounded-md p-2 text-white disabled:cursor-not-allowed disabled:opacity-50 ${
            recorderState === "recording" ? "bg-red-600 hover:bg-red-700" : "bg-slate-800 hover:bg-slate-900"
          }`}
          aria-label={recorderState === "recording" ? t("assistant.stopRecording") : t("assistant.record")}
        >
          {recorderState === "recording" ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        {showFallback || recorderState === "error" ? (
          <button
            type="button"
            onClick={openAudioFallback}
            disabled={disabled || busy}
            className="focus-ring rounded-md border border-slate-300 p-2 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t("assistant.uploadAudioFile")}
            title={t("assistant.uploadAudioFile")}
          >
            <Upload className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {statusLabel ? (
        <p className={`max-w-[12rem] text-xs ${recorderState === "error" ? "text-red-700" : "text-slate-500"}`}>
          {statusLabel}
        </p>
      ) : null}
    </div>
  );
}
