import { describe, expect, it } from "vitest";
import {
  isOperationCancellation,
  isOperationTimeout,
  OperationTimeoutError,
  withTimeout
} from "@/lib/ai/timeouts";

describe("assistant timeout and cancellation semantics", () => {
  it("does not classify a user cancellation as a timeout", () => {
    const cancellation = new DOMException("The operation was cancelled.", "AbortError");
    expect(isOperationCancellation(cancellation)).toBe(true);
    expect(isOperationTimeout(cancellation)).toBe(false);
  });

  it("preserves configured timeouts when the operation rejects on abort", async () => {
    await expect(withTimeout(
      (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Request aborted.", "AbortError")),
          { once: true }
        );
      }),
      10,
      "SYNTHETIC_TIMEOUT"
    )).rejects.toEqual(expect.objectContaining({
      name: "OperationTimeoutError",
      code: "SYNTHETIC_TIMEOUT",
      status: 504
    }));
  });

  it("propagates a parent cancellation without converting it to 504", async () => {
    const parent = new AbortController();
    const pending = withTimeout(
      (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Request aborted.", "AbortError")),
          { once: true }
        );
      }),
      5_000,
      "SHOULD_NOT_TIMEOUT",
      parent.signal
    );

    parent.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await pending.catch((error) => {
      expect(error).not.toBeInstanceOf(OperationTimeoutError);
      expect(isOperationTimeout(error)).toBe(false);
    });
  });
});
