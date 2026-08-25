import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import {
  canRequestCompanyWideData,
  getAiPermissionScope
} from "@/lib/ai/ai-permissions";

function managerContext(): AuthContext {
  return {
    user: null,
    supabase: null,
    isDemoMode: true,
    profile: {
      id: "10000000-0000-4000-8000-000000000001",
      full_name: "Synthetic Manager",
      email: "synthetic.manager@example.test",
      role: "manager",
      department: "Synthetic Operations",
      region: "Synthetic Region",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/assistant",
      traceId: "internal-trace",
      requestId: "internal-request"
    }
  };
}

describe("AI acceptance access boundaries", () => {
  it("keeps managers on team scope and denies company-wide AI access", () => {
    expect(getAiPermissionScope(managerContext())).toMatchObject({
      role: "manager",
      mode: "team",
      department: "Synthetic Operations",
      region: "Synthetic Region"
    });
    expect(canRequestCompanyWideData("manager")).toBe(false);
  });

  it("contracts manager team visibility to authenticated RLS department or region", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260624000000_quiksol_platform.sql"),
      "utf8"
    );
    const tools = readFileSync(
      resolve(process.cwd(), "lib/ai/database-tools.ts"),
      "utf8"
    );

    expect(migration).toContain("create or replace function public.can_read_upload(upload_owner uuid)");
    expect(migration).toContain("target.department = public.current_profile_department()");
    expect(migration).toContain("target.region = public.current_profile_region()");
    expect(migration).toContain(
      "create policy business_records_select_allowed on public.business_records"
    );
    expect(migration).toContain("for select using (public.can_read_upload(uploaded_by))");

    expect(tools).toContain("const supabase = requireSupabase(context)");
    expect(tools).not.toMatch(/service.?role|createServiceClient|SUPABASE_SERVICE_ROLE_KEY/i);
  });
});
