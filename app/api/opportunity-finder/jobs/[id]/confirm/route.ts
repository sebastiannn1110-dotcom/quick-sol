import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import {
  cleanUuid,
  loadOwnedOpportunityJob,
  roleValue
} from "@/lib/opportunity-finder/api";
import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const confirmSchema = z.object({
  files: z.array(z.object({
    id: z.string().uuid(),
    role: z.string(),
    validThrough: z.string().datetime({ offset: true }).optional().nullable()
  })).min(1).max(2)
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
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  const parsed = confirmSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ errorCode: "ROLES_REQUIRED" }, { status: 400 });
  const roles = new Map(parsed.data.files.map((file) => [file.id, roleValue(file.role)]));
  const comparisonMode = job.comparison_mode === "single_file" ? "single_file" : "two_files";
  const expectedRoleCount = comparisonMode === "single_file" ? 1 : 2;
  if (roles.size !== expectedRoleCount || Array.from(roles.values()).some((role) => !role)) {
    return NextResponse.json({ errorCode: "ROLES_REQUIRED" }, { status: 400 });
  }
  const { data: files, error: filesError } = await context.supabase
    .from("opportunity_finder_files")
    .select("id,side,detected_type,storage_deleted_at,source_kind")
    .eq("job_id", jobId)
    .order("side", { ascending: true });
  if (filesError || files?.length !== 2) {
    return NextResponse.json({ errorCode: "EXACTLY_TWO_FILES_REQUIRED" }, { status: 400 });
  }
  const uploadedFiles = files.filter((file) => file.source_kind !== "platform_snapshot");
  if (uploadedFiles.length !== expectedRoleCount) {
    return NextResponse.json({ errorCode: "FILES_REQUIRED_FOR_COMPARISON_MODE" }, { status: 400 });
  }
  if (uploadedFiles.some((file) => file.storage_deleted_at)) {
    return NextResponse.json({ errorCode: "SOURCE_FILE_EXPIRED" }, { status: 410 });
  }
  if (uploadedFiles.some((file) => file.detected_type === "financial")) {
    return NextResponse.json({ errorCode: "FINANCIAL_FILE_INCOMPATIBLE" }, { status: 400 });
  }
  const fileA = files.find((file) => file.side === "A")!;
  const fileB = files.find((file) => file.side === "B")!;
  if (comparisonMode === "single_file") {
    const uploadedFile = uploadedFiles[0];
    const role = roles.get(uploadedFile.id);
    const requestedFile = parsed.data.files.find((file) => file.id === uploadedFile.id);
    if (!role || role === "ignore" || !requestedFile) {
      return NextResponse.json({ errorCode: "ROLES_REQUIRED" }, { status: 400 });
    }
    const { error } = await service.rpc("confirm_opportunity_finder_single_file", {
      job_id: jobId,
      actor_id: context.profile.id,
      uploaded_file_id: uploadedFile.id,
      uploaded_role: role,
      valid_until: requestedFile.validThrough ?? null
    });
    if (error) {
      if (error.code === "P0002") return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
      if (error.code === "55000") return NextResponse.json({ errorCode: "JOB_NOT_AWAITING_ROLES" }, { status: 409 });
      if (error.code === "22023") {
        return NextResponse.json({
          errorCode: /validity/i.test(error.message ?? "") ? "OFFER_VALIDITY_REQUIRED" : "ROLES_REQUIRED"
        }, { status: 400 });
      }
      return NextResponse.json({ errorCode: "ROLE_CONFIRM_FAILED" }, { status: 500 });
    }
    await logAuditEvent(context, "opportunity_finder_roles_confirmed", "opportunity_finder_job", jobId, {
      uploadedRole: role,
      oppositeDatasetRole: role === "demand" ? "stock" : "demand",
      comparisonMode
    });
    return NextResponse.json({
      jobId,
      status: "queued",
      comparisonMode,
      comparisonKind: role === "demand" ? "demand_to_supply" : "supply_to_demand"
    });
  }
  const roleA = roles.get(fileA.id);
  const roleB = roles.get(fileB.id);
  const requestedFileA = parsed.data.files.find((file) => file.id === fileA.id);
  const requestedFileB = parsed.data.files.find((file) => file.id === fileB.id);
  if (!roleA || !roleB || !requestedFileA || !requestedFileB) {
    return NextResponse.json({ errorCode: "ROLES_REQUIRED" }, { status: 400 });
  }
  const compatibility = evaluateOpportunityCompatibility(roleA, roleB);
  if (!compatibility.compatible) {
    return NextResponse.json({
      errorCode: "ROLES_INCOMPATIBLE",
      reasonCode: compatibility.reasonCode,
      recommendedRole: compatibility.recommendedRole
    }, { status: 400 });
  }
  const { error } = await service.rpc("confirm_opportunity_finder_roles", {
    job_id: jobId,
    actor_id: context.profile.id,
    file_a_id: fileA.id,
    file_a_role: roleA,
    file_a_valid_until: requestedFileA.validThrough ?? null,
    file_b_id: fileB.id,
    file_b_role: roleB,
    file_b_valid_until: requestedFileB.validThrough ?? null
  });
  if (error) {
    if (error.code === "P0002") {
      return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
    }
    if (error.code === "55000") {
      const sourceUnavailable = /source_files_unavailable/i.test(error.message ?? "");
      return NextResponse.json({
        errorCode: sourceUnavailable ? "SOURCE_FILE_EXPIRED" : "JOB_NOT_AWAITING_ROLES"
      }, { status: sourceUnavailable ? 410 : 409 });
    }
    if (error.code === "22023") {
      const validity = /validity/i.test(error.message ?? "");
      return NextResponse.json({
        errorCode: validity ? "OFFER_VALIDITY_REQUIRED" : "ROLES_REQUIRED"
      }, { status: 400 });
    }
    return NextResponse.json({ errorCode: "ROLE_CONFIRM_FAILED" }, { status: 500 });
  }
  await logAuditEvent(context, "opportunity_finder_roles_confirmed", "opportunity_finder_job", jobId, {
    roleA,
    roleB,
    comparisonKind: compatibility.comparisonKind
  });
  return NextResponse.json({
    jobId,
    status: "queued",
    comparisonKind: compatibility.comparisonKind
  });
}
