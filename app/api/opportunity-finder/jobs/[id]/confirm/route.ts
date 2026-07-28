import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import {
  cleanUuid,
  loadOwnedOpportunityJob,
  roleValue
} from "@/lib/opportunity-finder/api";
import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const confirmSchema = z.object({
  files: z.array(z.object({
    id: z.string().uuid(),
    role: z.string()
  })).length(2)
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  }
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  if (job.status !== "awaiting_roles") {
    return NextResponse.json({ errorCode: "JOB_NOT_AWAITING_ROLES" }, { status: 409 });
  }
  const parsed = confirmSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ errorCode: "ROLES_REQUIRED" }, { status: 400 });
  const roles = new Map(parsed.data.files.map((file) => [file.id, roleValue(file.role)]));
  if (roles.size !== 2 || Array.from(roles.values()).some((role) => !role)) {
    return NextResponse.json({ errorCode: "ROLES_REQUIRED" }, { status: 400 });
  }
  const { data: files, error: filesError } = await context.supabase
    .from("opportunity_finder_files")
    .select("id,side,detected_type,storage_deleted_at")
    .eq("job_id", jobId)
    .order("side", { ascending: true });
  if (filesError || files?.length !== 2) {
    return NextResponse.json({ errorCode: "EXACTLY_TWO_FILES_REQUIRED" }, { status: 400 });
  }
  if (files.some((file) => file.storage_deleted_at)) {
    return NextResponse.json({ errorCode: "SOURCE_FILE_EXPIRED" }, { status: 410 });
  }
  if (files.some((file) => file.detected_type === "financial")) {
    return NextResponse.json({ errorCode: "FINANCIAL_FILE_INCOMPATIBLE" }, { status: 400 });
  }
  const fileA = files.find((file) => file.side === "A")!;
  const fileB = files.find((file) => file.side === "B")!;
  const roleA = roles.get(fileA.id)!;
  const roleB = roles.get(fileB.id)!;
  const compatibility = evaluateOpportunityCompatibility(roleA, roleB);
  if (!compatibility.compatible) {
    return NextResponse.json({
      errorCode: "ROLES_INCOMPATIBLE",
      reasonCode: compatibility.reasonCode,
      recommendedRole: compatibility.recommendedRole
    }, { status: 400 });
  }
  const updates = files.map((file) =>
    context.supabase!
      .from("opportunity_finder_files")
      .update({ selected_role: roles.get(file.id) })
      .eq("id", file.id)
      .eq("job_id", jobId)
  );
  const results = await Promise.all(updates);
  if (results.some((result) => result.error)) {
    return NextResponse.json({ errorCode: "ROLE_CONFIRM_FAILED" }, { status: 500 });
  }
  const { error } = await context.supabase
    .from("opportunity_finder_jobs")
    .update({
      file_a_role: roleA,
      file_b_role: roleB,
      status: "queued",
      current_stage: "normalizing_mpn",
      progress_percent: 26,
      attempts: 0,
      error_code: null,
      cancel_requested: false,
      next_retry_at: null
    })
    .eq("id", jobId)
    .eq("created_by", context.profile.id);
  if (error) return NextResponse.json({ errorCode: "JOB_QUEUE_FAILED" }, { status: 500 });
  return NextResponse.json({
    jobId,
    status: "queued",
    comparisonKind: compatibility.comparisonKind
  });
}
