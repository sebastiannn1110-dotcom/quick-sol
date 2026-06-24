"use client";

import { useEffect } from "react";
import { clientLogger } from "@/lib/logger/clientLogger";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    clientLogger.reactErrorBoundaryTriggered({
      message: error.message,
      digest: error.digest,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-lg rounded-md border border-slate-200 bg-white p-6 text-center shadow-soft">
        <h1 className="text-xl font-semibold text-slate-950">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">
          The error was recorded with trace details. Please retry or contact an admin if it continues.
        </p>
        <button
          onClick={reset}
          className="focus-ring mt-5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
