export function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function isExpectedAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted && isAbortError(error);
}

export function requestAbortError(message: string) {
  return new DOMException(message, "AbortError");
}

export function abortRequest(controller: AbortController | null, message: string) {
  if (controller && !controller.signal.aborted) {
    controller.abort(requestAbortError(message));
  }
}

export function throwIfRequestAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  throw isAbortError(signal.reason)
    ? signal.reason
    : requestAbortError("Request aborted.");
}
