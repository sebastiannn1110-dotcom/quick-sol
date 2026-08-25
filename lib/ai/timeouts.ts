export class OperationTimeoutError extends Error {
  readonly code: string;
  readonly status = 504;

  constructor(code: string) {
    super("The operation exceeded its configured time limit.");
    this.name = "OperationTimeoutError";
    this.code = code;
  }
}

export function configuredTimeout(name: string, fallbackMs: number, minMs = 100, maxMs = 120_000) {
  const value = Number(process.env[name] ?? fallbackMs);
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.min(Math.max(Math.round(value), minMs), maxMs);
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: string,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let parentAborted = false;
  const abortFromParent = () => {
    parentAborted = true;
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new OperationTimeoutError(code));
    }, timeoutMs);
  });

  try {
    if (controller.signal.aborted) {
      throw new DOMException("The operation was cancelled.", "AbortError");
    }
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (timedOut && isOperationCancellation(error)) {
      throw new OperationTimeoutError(code);
    }
    if (parentAborted && isOperationCancellation(error)) {
      throw new DOMException("The operation was cancelled.", "AbortError");
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export function isOperationTimeout(error: unknown) {
  if (error instanceof OperationTimeoutError) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const text = [record.name, record.code, record.message, record.details]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes("timeout") || text.includes("57014");
}

export function isOperationCancellation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const name = String(record.name ?? "").toLowerCase();
  const code = String(record.code ?? "").toLowerCase();
  const message = String(record.message ?? "").toLowerCase();
  return (
    name === "aborterror" ||
    code === "abort_err" ||
    message.includes("request aborted") ||
    message.includes("operation was cancelled")
  );
}
