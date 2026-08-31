import { NextResponse } from "next/server";

export type CommerceErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "SESSION_EXPIRED"
  | "PROFILE_INACTIVE"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_TRANSITION"
  | "CLIENT_REQUIRED"
  | "PRICING_REQUIRED"
  | "RATE_LIMITED"
  | "INTEGRATION_AUTH_FAILED"
  | "DATABASE_NOT_CONFIGURED"
  | "COMMERCE_UNAVAILABLE";

export function commerceError(
  status: number,
  code: CommerceErrorCode,
  message: string,
  details?: unknown
) {
  return NextResponse.json({
    error: {
      code,
      message,
      status,
      ...(details === undefined ? {} : { details })
    }
  }, { status, headers: { "cache-control": "no-store" } });
}

export function commerceNoStore<T>(payload: T, init?: { status?: number }) {
  return NextResponse.json(payload, {
    status: init?.status ?? 200,
    headers: { "cache-control": "no-store, max-age=0" }
  });
}

export function databaseErrorResponse(error: { code?: string; message?: string } | null | undefined) {
  const message = error?.message ?? "";
  if (message.includes("COMMERCE_VERSION_CONFLICT") || error?.code === "40001") {
    return commerceError(409, "VERSION_CONFLICT", "The quote changed. Refresh it before saving again.");
  }
  if (message.includes("COMMERCE_RFQ_IDEMPOTENCY_CONFLICT")) {
    return commerceError(409, "IDEMPOTENCY_CONFLICT", "That RFQ id was already used with different data.");
  }
  if (message.includes("COMMERCE_RFQ_CLIENT_REQUIRED")) {
    return commerceError(422, "CLIENT_REQUIRED", "Create or link a client before creating the quote.");
  }
  if (message.includes("COMMERCE_RFQ_CLIENT_MISMATCH")) {
    return commerceError(422, "VALIDATION_ERROR", "The quote client must match the client linked to the RFQ.");
  }
  if (message.includes("COMMERCE_QUOTE_CLIENT_IMMUTABLE")) {
    return commerceError(422, "VALIDATION_ERROR", "The client linked to an RFQ quote cannot be changed.");
  }
  if (message.includes("COMMERCE_QUOTE_RFQ_ITEMS_IMMUTABLE")) {
    return commerceError(422, "VALIDATION_ERROR", "The products and line order of an RFQ quote cannot be changed.");
  }
  if (message.includes("COMMERCE_RFQ_WORKFLOW_REQUIRED")) {
    return commerceError(422, "VALIDATION_ERROR", "Create RFQ quotes through the RFQ workflow.");
  }
  if (message.includes("COMMERCE_RFQ_QUOTE_INTEGRITY")) {
    return commerceError(422, "VALIDATION_ERROR", "The RFQ quote link is inconsistent.");
  }
  if (message.includes("COMMERCE_QUOTE_VALIDITY_EXPIRED")) {
    return commerceError(422, "INVALID_TRANSITION", "The quote validity date must be current before sending.");
  }
  if (message.includes("COMMERCE_QUOTE_PRICING_REQUIRED")) {
    return commerceError(422, "PRICING_REQUIRED", "Authorized pricing is required before the quote can be sent.");
  }
  if (
    message.includes("COMMERCE_TRANSITION_INVALID")
    || message.includes("COMMERCE_RFQ_TRANSITION_INVALID")
    || error?.code === "55000"
  ) {
    return commerceError(422, "INVALID_TRANSITION", "The requested Commerce transition is not allowed.");
  }
  if (message.includes("COMMERCE_NOT_FOUND") || error?.code === "P0002") {
    return commerceError(404, "NOT_FOUND", "The requested commerce record was not found.");
  }
  if (error?.code === "42501") {
    return commerceError(403, "FORBIDDEN", "You do not have permission for this commerce record.");
  }
  if (error?.code === "22023" || error?.code === "23514") {
    return commerceError(422, "VALIDATION_ERROR", "The commerce data is invalid.");
  }
  return commerceError(500, "COMMERCE_UNAVAILABLE", "The commerce service could not complete the operation.");
}
