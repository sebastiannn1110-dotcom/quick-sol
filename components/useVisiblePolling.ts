"use client";

import { useCallback, useEffect, useRef } from "react";

export type VisiblePollingTrigger = "initial" | "interval" | "visibility" | "manual";

export type VisiblePollingContext = {
  signal: AbortSignal;
  trigger: VisiblePollingTrigger;
};

type VisiblePollingOptions = {
  enabled?: boolean;
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 12_000;

/**
 * Runs one request at a time, polls only while the page is visible, and aborts
 * the active request when polling pauses or the consumer unmounts.
 */
export function useVisiblePolling(
  task: (context: VisiblePollingContext) => Promise<void> | void,
  { enabled = true, intervalMs = DEFAULT_INTERVAL_MS }: VisiblePollingOptions = {}
) {
  const taskRef = useRef(task);
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const execute = useCallback(async (trigger: VisiblePollingTrigger) => {
    if (!mountedRef.current || !enabledRef.current) return;
    if (trigger !== "manual" && document.visibilityState !== "visible") return;

    let activeRequest = inFlightRef.current;
    while (activeRequest) {
      await activeRequest.catch(() => undefined);
      if (
        trigger === "interval"
        || !mountedRef.current
        || !enabledRef.current
        || (trigger !== "manual" && document.visibilityState !== "visible")
      ) {
        return;
      }
      activeRequest = inFlightRef.current;
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    const request = Promise.resolve()
      .then(() => taskRef.current({ signal: controller.signal, trigger }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      })
      .finally(() => {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (inFlightRef.current === request) inFlightRef.current = null;
      });

    inFlightRef.current = request;
    await request;
  }, []);

  const refresh = useCallback(async () => {
    await execute("manual").catch(() => undefined);
  }, [execute]);

  useEffect(() => {
    if (!enabled) return;

    mountedRef.current = true;
    let stopped = false;
    let timer: number | null = null;
    let hasStarted = false;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        void cycle("interval");
      }, intervalMs);
    };

    const cycle = async (trigger: VisiblePollingTrigger) => {
      if (stopped || document.visibilityState !== "visible") return;
      hasStarted = true;
      await execute(trigger).catch(() => undefined);
      schedule();
    };

    const onVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "hidden") {
        controllerRef.current?.abort();
        return;
      }
      void cycle(hasStarted ? "visibility" : "initial");
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "visible") void cycle("initial");

    return () => {
      stopped = true;
      mountedRef.current = false;
      clearTimer();
      controllerRef.current?.abort();
      controllerRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, execute, intervalMs]);

  return { refresh };
}
