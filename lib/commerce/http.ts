import { NextResponse } from "next/server";

export type CommerceErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "DATABASE_NOT_CONFIGURED"
  | "COMMERCE_UNAVAILABLE";

export function commerceError(status: number, code: CommerceErrorCode, message: string, details?: unknown) {
  return NextResponse.json({
    error: { code, message, status, ...(details === undefined ? {} : { details }) }
  }, { status, headers: { "cache-control": "no-store" } });
}

export function commerceNoStore<T>(payload: T, init?: { status?: number }) {
  return NextResponse.json(payload, {
    status: init?.status ?? 200,
    headers: { "cache-control": "no-store, max-age=0" }
  });
}
