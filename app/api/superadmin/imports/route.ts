import { NextResponse } from "next/server";
import { requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { buildSuperadminImports } from "@/lib/superadmin/metrics";
import { logger } from "@/lib/logger/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const startedAt = performance.now();
  try {
    const imports = await buildSuperadminImports(context.service);
    return superadminJson({ imports });
  } catch (error) {
    await logger.error({
      ...context.requestMeta,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      module: "api",
      action: "superadmin_imports_failed",
      message: "Superadmin imports module failed.",
      status: "failed",
      statusCode: 500,
      durationMs: Math.round(performance.now() - startedAt),
      error
    });
    return superadminJson({ error: "SUPERADMIN_IMPORTS_UNAVAILABLE" }, { status: 500 });
  }
}
