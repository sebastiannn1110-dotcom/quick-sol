import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { requestBusinessSummaryRebuild } from "@/lib/performance/summary-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  uploadBatchId: z.string().uuid().nullable().optional(),
  clientId: z.string().uuid().nullable().optional()
}).strict();

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) {
    context.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
    return context;
  }
  if (context.isDemoMode || !context.supabase) {
    return json({ errorCode: "SUMMARY_REBUILD_UNAVAILABLE" }, 503);
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ errorCode: "SUMMARY_REBUILD_SCOPE_INVALID" }, 400);

  try {
    const result = await requestBusinessSummaryRebuild(context.supabase, parsed.data);
    return json(result, result.status === "queued" ? 202 : 200);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code ?? "")
      : "";
    if (code === "42501") return json({ errorCode: "SUMMARY_REBUILD_FORBIDDEN" }, 403);
    if (code === "PGRST202" || code === "42883") {
      return json({ errorCode: "SUMMARY_REBUILD_CONTRACT_UNAVAILABLE" }, 503);
    }
    return json({ errorCode: "SUMMARY_REBUILD_REQUEST_FAILED" }, 500);
  }
}
