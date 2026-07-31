// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiAudioPlayer from "@/components/ai/AiAudioPlayer";
import type { TranslationKey } from "@/lib/i18n";

describe("AiAudioPlayer", () => {
  const play = vi.fn(async () => undefined);
  const pause = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:synthetic-audio"),
      revokeObjectURL: vi.fn()
    });
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: play
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: pause
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("creates a local audio URL and supports play and replay controls", () => {
    render(
      <AiAudioPlayer
        audioBase64="U1lOVEhFVElD"
        audioMimeType="audio/mpeg"
        t={(key: TranslationKey) => key}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "assistant.playResponse" }));
    fireEvent.click(screen.getByRole("button", { name: "assistant.replayResponse" }));
    expect(play).toHaveBeenCalledTimes(2);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
