import { NextResponse } from "next/server";

export function sourcingNoStore<T>(payload: T, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "no-store, max-age=0" }
  });
}

export function sourcingError(status: number, code: string, message: string, details?: unknown) {
  return sourcingNoStore({
    error: { code, message, ...(details === undefined ? {} : { details }) }
  }, status);
}

export function sourcingDatabaseError(error: { code?: string; message?: string } | null | undefined) {
  const message = error?.message ?? "";
  if (error?.code === "42501" || message.includes("SOURCING_FORBIDDEN")) {
    return sourcingError(403, "SOURCING_FORBIDDEN", "You do not have permission for raw sourcing data.");
  }
  if (error?.code === "P0002" || message.includes("SOURCING_NOT_FOUND")) {
    return sourcingError(404, "SOURCING_NOT_FOUND", "The sourcing record was not found.");
  }
  if (error?.code === "55000" || message.includes("SOURCING_INVALID_STATE")) {
    return sourcingError(409, "SOURCING_INVALID_STATE", "The sourcing record is not in a valid state for this action.");
  }
  if (error?.code === "22023" || error?.code === "23514") {
    return sourcingError(422, "SOURCING_VALIDATION_ERROR", "The sourcing data is invalid.");
  }
  return sourcingError(500, "SOURCING_UNAVAILABLE", "The sourcing service could not complete the operation.");
}
