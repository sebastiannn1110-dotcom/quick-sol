import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { organizationMemberPatchSchema } from "@/lib/organization/contracts";
import { loadOrganizationDirectory } from "@/lib/organization/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ profileId: string }> };

function rpcError(error: { message?: string; code?: string }) {
  const message = `${error.message || ""} ${error.code || ""}`;
  if (message.includes("VERSION")) {
    return NextResponse.json(
      { error: "The organization changed. Reload and try again.", code: "VERSION_CONFLICT" },
      { status: 409 }
    );
  }
  if (message.includes("CYCLE") || message.includes("SELF_MANAGER")) {
    return NextResponse.json(
      { error: "That manager assignment would create an invalid hierarchy.", code: "HIERARCHY_CONFLICT" },
      { status: 409 }
    );
  }
  if (message.includes("FORBIDDEN") || message.includes("OUTSIDE_SUBTREE")) {
    return NextResponse.json(
      { error: "You cannot move or edit this employee.", code: "ORGANIZATION_FORBIDDEN" },
      { status: 403 }
    );
  }
  if (message.includes("NOT_FOUND")) {
    return NextResponse.json(
      { error: "Organization member not found.", code: "ORGANIZATION_MEMBER_NOT_FOUND" },
      { status: 404 }
    );
  }
  return NextResponse.json(
    { error: "Unable to update team structure.", code: "ORGANIZATION_UPDATE_FAILED" },
    { status: 500 }
  );
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const { profileId: rawProfileId } = await params;
  const profileId = z.string().uuid().safeParse(rawProfileId);
  const payload = organizationMemberPatchSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!profileId.success || !payload.success) {
    return NextResponse.json(
      { error: "Invalid organization update.", code: "INVALID_PAYLOAD" },
      { status: 400 }
    );
  }
  if (!context.supabase) {
    return NextResponse.json(
      { error: "Team editing requires Supabase.", code: "ORGANIZATION_UNAVAILABLE" },
      { status: 503 }
    );
  }

  const before = await loadOrganizationDirectory(context);
  const target = before.members.find((member) => member.profileId === profileId.data);
  if (!target) {
    return NextResponse.json(
      { error: "Organization member not found.", code: "ORGANIZATION_MEMBER_NOT_FOUND" },
      { status: 404 }
    );
  }
  if (!target.canEdit) {
    return NextResponse.json(
      { error: "You cannot move or edit this employee.", code: "ORGANIZATION_FORBIDDEN" },
      { status: 403 }
    );
  }

  const input = payload.data;
  const { error } = await context.supabase.rpc("update_organization_member_v1", {
    input_profile_id: profileId.data,
    input_manager_id: input.managerId,
    input_business_title: input.businessTitle,
    input_business_rank: input.businessRank,
    input_department: input.department,
    input_country: input.country,
    input_location: input.location,
    input_responsibilities: input.responsibilities,
    input_expected_version: input.expectedVersion
  });
  if (error) return rpcError(error);

  await logAuditEvent(context, "organization_member_updated", "organization_member", profileId.data, {
    previousVersion: input.expectedVersion,
    managerId: input.managerId,
    businessRank: input.businessRank
  });

  const after = await loadOrganizationDirectory(context);
  return NextResponse.json(
    { member: after.members.find((member) => member.profileId === profileId.data) ?? null },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}
