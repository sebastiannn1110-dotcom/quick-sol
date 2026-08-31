"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useVisiblePolling } from "@/components/useVisiblePolling";
import { commerceRequest } from "@/lib/commerce/client";
import { commerceCopy } from "@/lib/commerce/ui-i18n";
import {
  isPendingRfq,
  parseRfqListPayload,
  type CommerceRfqSummary
} from "@/lib/commerce/ui-model";

const SEEN_STORAGE_KEY = "quiksol-commerce-rfq-seen-v2";
const MAX_SEEN_IDS = 200;

export type RfqPollMergeResult = {
  seenIds: string[];
  toasts: CommerceRfqSummary[];
  toast: CommerceRfqSummary | null;
};

export function mergeRfqPoll(
  previousIds: Iterable<string>,
  hasBaseline: boolean,
  rfqs: CommerceRfqSummary[]
): RfqPollMergeResult {
  const previous = new Set(previousIds);
  const toasts = hasBaseline
    ? rfqs.filter((rfq) => rfq.id && !previous.has(rfq.id) && isPendingRfq(rfq))
    : [];
  return {
    seenIds: Array.from(new Set([...rfqs.map((rfq) => rfq.id).filter(Boolean), ...previous])).slice(0, MAX_SEEN_IDS),
    toasts,
    toast: toasts[0] ?? null
  };
}

function storageKey(profileId: string) {
  return `${SEEN_STORAGE_KEY}:${profileId}`;
}

function readSeenIds(profileId: string) {
  if (typeof window === "undefined") return { ids: [] as string[], hasBaseline: false };
  try {
    const stored = window.sessionStorage.getItem(storageKey(profileId));
    if (stored === null) return { ids: [] as string[], hasBaseline: false };
    const parsed = JSON.parse(stored) as unknown;
    return {
      ids: Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [],
      hasBaseline: true
    };
  } catch {
    return { ids: [] as string[], hasBaseline: false };
  }
}

function writeSeenIds(profileId: string, ids: string[]) {
  try {
    window.sessionStorage.setItem(storageKey(profileId), JSON.stringify(ids));
  } catch {
    // Storage can be disabled by browser policy; polling and the badge must
    // continue with the in-memory deduplication state for this mount.
  }
}

export function useRfqNotifications(profileId: string | null | undefined) {
  const [pendingCount, setPendingCount] = useState(0);
  const [toastQueue, setToastQueue] = useState<CommerceRfqSummary[]>([]);
  const seenIdsRef = useRef<string[]>([]);
  const hasBaselineRef = useRef(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    seenIdsRef.current = [];
    hasBaselineRef.current = false;
    initializedRef.current = false;
    setPendingCount(0);
    setToastQueue([]);
  }, [profileId]);

  const poll = useCallback(async ({ signal }: { signal: AbortSignal }) => {
    if (!profileId) return;
    if (!initializedRef.current) {
      const stored = readSeenIds(profileId);
      seenIdsRef.current = stored.ids;
      hasBaselineRef.current = stored.hasBaseline;
      initializedRef.current = true;
    }
    const payload = await commerceRequest<unknown>("/api/commerce/rfqs?limit=50", { signal });
    const next = parseRfqListPayload(payload);
    const merged = mergeRfqPoll(seenIdsRef.current, hasBaselineRef.current, next.rfqs);
    seenIdsRef.current = merged.seenIds;
    hasBaselineRef.current = true;
    writeSeenIds(profileId, merged.seenIds);
    setPendingCount(next.pendingCount);
    if (merged.toasts.length) {
      setToastQueue((current) => {
        const queuedIds = new Set(current.map((rfq) => rfq.id));
        const additions = merged.toasts.filter((rfq) => !queuedIds.has(rfq.id));
        return additions.length ? [...current, ...additions] : current;
      });
    }
  }, [profileId]);

  useVisiblePolling(poll, { enabled: Boolean(profileId), intervalMs: 12_000, restartKey: profileId });

  const toast = toastQueue[0] ?? null;
  const dismissToast = useCallback(() => {
    setToastQueue((current) => current.slice(1));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, 8_000);
    return () => window.clearTimeout(timer);
  }, [dismissToast, toast]);

  return { pendingCount, toast, dismissToast };
}

export function RfqToast({
  rfq,
  onDismiss
}: {
  rfq: CommerceRfqSummary;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const { language } = useLanguage();
  const copy = commerceCopy(language);
  return (
    <div
      className="fixed bottom-4 right-4 z-[80] w-[calc(100vw-2rem)] max-w-sm rounded-xl border border-brand-200 bg-white p-4 text-left shadow-2xl"
      role="status"
      aria-live="polite"
      data-testid="rfq-toast"
    >
      <button
        type="button"
        aria-label={copy.close}
        className="absolute right-2 top-2 rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        onClick={onDismiss}
      >
        <X className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex w-full items-start gap-3 pr-8 text-left"
        onClick={() => {
          onDismiss();
          router.push(`/admin/rfqs/${encodeURIComponent(rfq.id)}`);
        }}
      >
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
          <FileText className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-950">{copy.newRfqReceived}</span>
          <span className="mt-1 block truncate text-sm text-slate-700">{rfq.companyOrName || "—"}</span>
          <span className="mt-0.5 block truncate text-xs font-semibold text-brand-700">{rfq.primaryMpn || "—"}</span>
        </span>
      </button>
    </div>
  );
}
