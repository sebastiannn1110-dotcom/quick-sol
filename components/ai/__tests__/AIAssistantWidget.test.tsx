// @vitest-environment jsdom
/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AIAssistantWidget from "@/components/AIAssistantWidget";
import { LanguageProvider } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />
}));

vi.mock("@/components/ai/AiVoiceRecorder", () => ({
  default: () => <button type="button" aria-label="Synthetic microphone">Mic</button>
}));

vi.mock("@/components/ai/AiAudioPlayer", () => ({
  default: () => <div>Audio</div>
}));

const profile = {
  id: "10000000-0000-4000-8000-000000000001",
  full_name: "Synthetic Employee",
  email: "synthetic@example.test",
  role: "employee",
  department: "QA",
  region: "Synthetic",
  is_active: true,
  created_at: "2026-07-30T00:00:00.000Z",
  updated_at: "2026-07-30T00:00:00.000Z"
} as Profile;

const conversationId = "20000000-0000-4000-8000-000000000002";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function streamResponse() {
  const body = [
    'event: progress\ndata: {"stage":"validating"}\n\n',
    'event: progress\ndata: {"stage":"searching"}\n\n',
    'event: progress\ndata: {"stage":"processing"}\n\n',
    'event: progress\ndata: {"stage":"generating"}\n\n',
    'event: completed\ndata: {"stage":"completed","answer":"Synthetic stock answer","timings":{"totalMs":25,"llmMs":10},"metadata":{"basedOnData":true,"generatedWithAi":true,"source":"Stock Needs"}}\n\n'
  ].join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }
  );
}

function renderWidget() {
  return render(
    <LanguageProvider>
      <AIAssistantWidget profile={profile} />
    </LanguageProvider>
  );
}

describe("AIAssistantWidget streaming experience", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) }
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("provides dialog semantics, streams a response, exposes evidence, and copies it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/ai/conversations" && init?.method === "POST") {
        return jsonResponse({
          conversation: {
            id: conversationId,
            title: "Synthetic stock question",
            updatedAt: "2026-07-30T00:00:00.000Z"
          }
        }, 201);
      }
      if (url === "/api/ai/assistant/stream") return streamResponse();
      if (url === "/api/ai/conversations") {
        return jsonResponse({
          conversations: [
            {
              id: conversationId,
              title: "Synthetic history",
              updatedAt: "2026-07-30T00:00:00.000Z"
            }
          ]
        });
      }
      return jsonResponse({});
    });

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Abrir asistente IA" }));
    expect(screen.getByRole("dialog", { name: "Asistente de Electronic Parts" })).toBeTruthy();
    expect(screen.getByText(/Consentimiento de voz: el audio se env/)).toBeTruthy();
    const input = screen.getByLabelText("Mensaje para el asistente de IA");
    fireEvent.change(input, { target: { value: "¿Qué MPN sintéticos tienen stock?" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje" }));

    expect(await screen.findByText("Synthetic stock answer")).toBeTruthy();
    expect(screen.getByText("Respuesta basada en datos")).toBeTruthy();
    expect(screen.getByText("Respuesta generada con IA")).toBeTruthy();
    expect(screen.getByText("Stock Needs")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Copiar respuesta" }).at(-1)!);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Synthetic stock answer");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/assistant/stream",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    fireEvent.click(screen.getByRole("button", { name: "Historial de conversaciones" }));
    expect(await screen.findByText("Synthetic history")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("continues with a stateless streamed answer when conversation memory is unavailable", async () => {
    let streamedRequest: Record<string, unknown> | null = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/ai/conversations") {
        return jsonResponse({ conversations: [], persistenceAvailable: false });
      }
      if (url === "/api/ai/assistant/stream") {
        streamedRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return streamResponse();
      }
      return jsonResponse({});
    });

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Abrir asistente IA" }));
    fireEvent.change(screen.getByLabelText("Mensaje para el asistente de IA"), {
      target: { value: "Stateless synthetic question" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje" }));

    expect(await screen.findByText("Synthetic stock answer")).toBeTruthy();
    expect(streamedRequest).toEqual(expect.objectContaining({
      message: "Stateless synthetic question",
      conversationId: null
    }));
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/ai/conversations",
      expect.objectContaining({ method: "POST" })
    );
    expect(document.body.textContent).not.toContain("No se pudo conectar");
  });

  it("aborts an in-flight request from the cancel button without showing a connection error", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/ai/conversations" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({
          conversation: {
            id: conversationId,
            title: "Synthetic cancellation",
            updatedAt: "2026-07-30T00:00:00.000Z"
          }
        }, 201));
      }
      if (url === "/api/ai/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      if (url === "/api/ai/assistant/stream") {
        observedSignal = init?.signal ?? undefined;
        return new Promise((_, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Abrir asistente IA" }));
    fireEvent.change(screen.getByLabelText("Mensaje para el asistente de IA"), {
      target: { value: "Cancel synthetic request" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje" }));
    const cancelButton = await screen.findByRole("button", { name: "Cancelar solicitud" });
    await waitFor(() => expect(observedSignal).toBeTruthy());
    fireEvent.click(cancelButton);

    expect(observedSignal?.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Cancelar solicitud" })).toBeNull();
    });
    expect(document.body.textContent).not.toContain("No se pudo conectar");
  });

  it("deletes a saved owned conversation and starts a new conversation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/ai/conversations") {
        return jsonResponse({
          conversations: [
            {
              id: conversationId,
              title: "Synthetic history",
              updatedAt: "2026-07-30T00:00:00.000Z"
            }
          ]
        });
      }
      if (url.endsWith(conversationId) && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({});
    });

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Abrir asistente IA" }));
    fireEvent.click(screen.getByRole("button", { name: "Historial de conversaciones" }));
    const deleteButton = await screen.findByRole("button", {
      name: "Eliminar conversación: Synthetic history"
    });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(screen.queryByText("Synthetic history")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/ai/conversations/${conversationId}`,
      { method: "DELETE" }
    );
    fireEvent.click(screen.getByRole("button", { name: "Nueva pregunta" }));
    expect(screen.getByText(/Hola. Soy el asistente/)).toBeTruthy();
  });

  it("keeps the dialog bounded at emulated iPad dimensions", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 768 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1024 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ conversations: [] }));
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Abrir asistente IA" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("w-[min(calc(100vw-2rem),420px)]");
    expect(dialog.className).toContain("h-[min(75dvh,620px)]");
  });

  it("traps Tab and Shift+Tab focus inside the dialog", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ conversations: [] }));
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Abrir asistente IA" }));
    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    ));
    const first = focusable[0];
    const last = focusable.at(-1);

    expect(first).toBeTruthy();
    expect(last).toBeTruthy();
    last!.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first!.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
