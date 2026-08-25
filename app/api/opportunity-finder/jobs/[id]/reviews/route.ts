import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { cleanUuid, loadOwnedOpportunityJob } from "@/lib/opportunity-finder/api";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reviewSchema = z.object({
  entityType: z.enum(["result", "possible_match"]),
  entityId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional().nullable()
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  }
  const rate = checkRateLimit({
    key: `opportunity-finder:review:${context.profile.id}`,
    limit: 60,
    windowMs: 60 * 1000
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const parsed = reviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ errorCode: "REVIEW_INVALID" }, { status: 400 });

  const { data: reviewStatus, error: decisionError } = await context.supabase.rpc(
    "decide_opportunity_finder_review",
    {
      job_id: jobId,
      entity_type: parsed.data.entityType,
      entity_id: parsed.data.entityId,
      decision: parsed.data.decision,
      review_note: parsed.data.note || null
    }
  );
  if (decisionError) {
    const status = decisionError.code === "P0002" ? 404 : 500;
    return NextResponse.json({
      errorCode: status === 404 ? "REVIEW_TARGET_NOT_FOUND" : "REVIEW_FAILED"
    }, { status });
  }

  await logAuditEvent(context, "opportunity_finder_review_decided", parsed.data.entityType, parsed.data.entityId, {
    jobId,
    decision: parsed.data.decision
  });
  return NextResponse.json({
    jobId,
    entityId: parsed.data.entityId,
    reviewStatus: reviewStatus ?? parsed.data.decision
  });
}
