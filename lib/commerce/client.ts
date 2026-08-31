"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export class CommerceApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, options: { code?: string; status?: number; details?: unknown } = {}) {
    super(message);
    this.name = "CommerceApiError";
    this.code = options.code ?? "COMMERCE_UNAVAILABLE";
    this.status = options.status ?? 500;
    this.details = options.details;
  }
}

export async function commerceRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) {
    throw new CommerceApiError("Commerce authentication is not configured.", {
      code: "DATABASE_NOT_CONFIGURED",
      status: 503
    });
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new CommerceApiError("Your employee session has expired.", {
      code: "SESSION_EXPIRED",
      status: 401
    });
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = payload && typeof payload === "object"
      ? (payload as { error?: { code?: string; message?: string; details?: unknown } }).error
      : undefined;
    throw new CommerceApiError(error?.message ?? "The Commerce request could not be completed.", {
      code: error?.code,
      status: response.status,
      details: error?.details
    });
  }
  return payload as T;
}
