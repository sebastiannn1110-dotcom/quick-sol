import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/AppError";
import type { LogContext, LogModule } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";

export async function handleRouteError(
  error: unknown,
  context: LogContext,
  input?: {
    module?: LogModule;
    action?: string;
    fallbackMessage?: string;
  }
) {
  const appError =
    error instanceof AppError
      ? error
      : new AppError({
          code: "UNKNOWN_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
          statusCode: 500,
          severity: "high",
          safeMessage: input?.fallbackMessage ?? "Unexpected server error."
        });

  await logger.error({
    ...context,
    module: input?.module ?? "api",
    action: input?.action ?? "route_failed",
    message: appError.internalMessage,
    status: "failed",
    metadata: appError.details,
    error: appError
  });

  return NextResponse.json(
    {
      error: appError.safeMessage,
      code: appError.code,
      traceId: context.traceId
    },
    { status: appError.statusCode }
  );
}
