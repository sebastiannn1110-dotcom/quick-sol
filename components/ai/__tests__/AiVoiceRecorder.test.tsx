// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AiVoiceRecorder from "@/components/ai/AiVoiceRecorder";
import type { TranslationKey } from "@/lib/i18n";

describe("AiVoiceRecorder cancellation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("propagates external cancellation to the in-flight voice upload", async () => {
    const external = new AbortController();
    let providerSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input) === "/api/ai/voice/ask") {
        providerSignal = init?.signal ?? undefined;
        return new Promise((_, reject) => {
          providerSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const { container } = render(
      <AiVoiceRecorder
        language="es"
        t={(key: TranslationKey) => key}
        cancelSignal={external.signal}
        onVoiceResult={vi.fn()}
        onErrorMessage={vi.fn()}
      />
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["synthetic-audio"], "synthetic.webm", { type: "audio/webm" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(providerSignal).toBeTruthy());
    external.abort();
    await waitFor(() => expect(providerSignal?.aborted).toBe(true));
  });
});
