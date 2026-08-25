import { describe, expect, it } from "vitest";
import { parseAssistantRequest } from "@/lib/ai/request-schema";

function request(body: string, headers: Record<string, string> = {}) {
  return new Request("https://synthetic.test/api/assistant", {
    method: "POST",
    body,
    headers
  });
}

describe("assistant HTTP request schema", () => {
  it("accepts a strict valid multilingual request", async () => {
    const parsed = await parseAssistantRequest(request(
      JSON.stringify({
        message: "Show exact MPN matches.",
        language: "en",
        jobId: "10000000-0000-4000-8000-000000000001"
      }),
      { "Content-Type": "application/json" }
    ));
    expect(parsed).toMatchObject({ ok: true });
  });

  it("returns 400 for the wrong content type or an empty body", async () => {
    await expect(parseAssistantRequest(request("{}", { "Content-Type": "text/plain" })))
      .resolves.toMatchObject({ ok: false, status: 400, code: "INVALID_CONTENT_TYPE" });
    await expect(parseAssistantRequest(request(
      JSON.stringify({ message: "   " }),
      { "Content-Type": "application/json" }
    ))).resolves.toMatchObject({ ok: false, status: 400, code: "EMPTY_MESSAGE" });
  });

  it("returns 413 for a message over 2,000 characters", async () => {
    await expect(parseAssistantRequest(request(
      JSON.stringify({ message: "x".repeat(2_001) }),
      { "Content-Type": "application/json" }
    ))).resolves.toMatchObject({ ok: false, status: 413, code: "MESSAGE_TOO_LARGE" });
  });

  it("returns 422 for invalid language, UUID, or unknown properties", async () => {
    for (const body of [
      { message: "hello", language: "fr" },
      { message: "hello", jobId: "not-a-uuid" },
      { message: "hello", userId: "must-not-be-accepted" }
    ]) {
      await expect(parseAssistantRequest(request(
        JSON.stringify(body),
        { "Content-Type": "application/json" }
      ))).resolves.toMatchObject({ ok: false, status: 422, code: "INVALID_PARAMETERS" });
    }
  });
});
