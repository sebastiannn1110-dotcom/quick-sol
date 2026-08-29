// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useVisiblePolling,
  type VisiblePollingContext
} from "@/components/useVisiblePolling";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible"
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useVisiblePolling", () => {
  it("runs immediately, serializes a manual refresh, and waits 12 seconds between polls", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst: (() => void) | null = null;
    const triggers: VisiblePollingContext["trigger"][] = [];
    const task = vi.fn(async ({ trigger }: VisiblePollingContext) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      triggers.push(trigger);
      if (triggers.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      active -= 1;
    });

    const { result } = renderHook(() => useVisiblePolling(task, { intervalMs: 12_000 }));
    await flushPromises();
    expect(task).toHaveBeenCalledTimes(1);

    let refreshPromise: Promise<void> | undefined;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await act(async () => {
      vi.advanceTimersByTime(24_000);
      await Promise.resolve();
    });
    expect(task).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst?.();
      await refreshPromise;
    });
    expect(task).toHaveBeenCalledTimes(2);
    expect(triggers).toEqual(["initial", "manual"]);
    expect(maxActive).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(11_999);
      await Promise.resolve();
    });
    expect(task).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(task).toHaveBeenCalledTimes(3);
    expect(triggers[2]).toBe("interval");
    expect(maxActive).toBe(1);
  });

  it("pauses while hidden and refreshes as soon as the page becomes visible", async () => {
    setVisibility("hidden");
    const triggers: VisiblePollingContext["trigger"][] = [];
    const task = vi.fn(async ({ trigger }: VisiblePollingContext) => {
      triggers.push(trigger);
    });

    renderHook(() => useVisiblePolling(task, { intervalMs: 12_000 }));
    await flushPromises();
    expect(task).not.toHaveBeenCalled();

    act(() => setVisibility("visible"));
    await flushPromises();
    expect(triggers).toEqual(["initial"]);

    await act(async () => {
      vi.advanceTimersByTime(12_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(triggers).toEqual(["initial", "interval"]);

    act(() => setVisibility("hidden"));
    await act(async () => {
      vi.advanceTimersByTime(24_000);
      await Promise.resolve();
    });
    expect(task).toHaveBeenCalledTimes(2);

    act(() => setVisibility("visible"));
    await flushPromises();
    expect(triggers).toEqual(["initial", "interval", "visibility"]);
  });

  it("aborts the active request and clears future polling on cleanup", async () => {
    let observedSignal: AbortSignal | null = null;
    const task = vi.fn(({ signal }: VisiblePollingContext) => {
      observedSignal = signal;
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const view = renderHook(() => useVisiblePolling(task, { intervalMs: 12_000 }));
    await flushPromises();
    expect(task).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(observedSignal?.aborted).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(24_000);
      await Promise.resolve();
    });
    expect(task).toHaveBeenCalledTimes(1);
  });
});
