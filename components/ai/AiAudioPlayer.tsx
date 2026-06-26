"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import type { TranslationKey } from "@/lib/i18n";

interface AiAudioPlayerProps {
  audioBase64: string;
  audioMimeType?: string | null;
  t: (key: TranslationKey) => string;
}

function base64ToBytes(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export default function AiAudioPlayer({ audioBase64, audioMimeType, t }: AiAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const mimeType = audioMimeType || "audio/mpeg";

  useEffect(() => {
    setError("");
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);

    try {
      const bytes = base64ToBytes(audioBase64);
      const blob = new Blob([bytes], { type: mimeType });
      const nextUrl = URL.createObjectURL(blob);
      setAudioUrl(nextUrl);
      return () => {
        URL.revokeObjectURL(nextUrl);
      };
    } catch {
      setAudioUrl("");
      setError(t("assistant.audioUnavailable"));
      return undefined;
    }
  }, [audioBase64, mimeType, t]);

  const progress = useMemo(() => {
    if (!duration) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
  }, [currentTime, duration]);

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;

    try {
      if (audio.paused) {
        await audio.play();
      } else {
        audio.pause();
      }
    } catch {
      setError(t("assistant.audioUnavailable"));
    }
  }

  async function replay() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    try {
      await audio.play();
    } catch {
      setError(t("assistant.audioUnavailable"));
    }
  }

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={() => setError(t("assistant.audioUnavailable"))}
          className="hidden"
        />
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void togglePlayback()}
          disabled={!audioUrl}
          className="focus-ring flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={isPlaying ? t("assistant.pauseResponse") : t("assistant.playResponse")}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-brand-600" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {formatTime(currentTime)} / {formatTime(duration)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void replay()}
          disabled={!audioUrl}
          className="focus-ring rounded-md border border-slate-300 p-1.5 text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t("assistant.replayResponse")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
