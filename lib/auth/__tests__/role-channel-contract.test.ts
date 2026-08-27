import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("role x channel x capability contract", () => {
  it("keeps /admin inherited and /admindev exclusive in UI, proxy and API", () => {
    const roles = source("lib/auth/roles.ts");
    const proxy = source("proxy.ts");
    const sidebar = source("components/Sidebar.tsx");
    const adminContext = source("lib/auth/context.ts");
    const superadminAuth = source("lib/superadmin/auth.ts");

    expect(roles).toContain('role === ADMIN_ROLE || role === SUPER_ADMIN_DEV_ROLE');
    expect(roles).toContain('role === SUPER_ADMIN_DEV_ROLE');
    expect(proxy).toContain("canAccessAdmin(profile.role)");
    expect(proxy).toContain("canAccessAdminDev(profile.role)");
    expect(sidebar).toContain('roles: ["admin"]');
    expect(sidebar).toContain('roles: ["super_admin_dev"]');
    expect(adminContext).toContain('return requireRole(request, ["admin"])');
    expect(superadminAuth).toContain("requireRole(request, [SUPER_ADMIN_DEV_ROLE])");
  });

  it("keeps profile security behind the audited RPC instead of table updates", () => {
    const route = source("app/api/admin/users/route.ts");
    const roleMigration = source(
      "supabase/migrations/20260822120000_harden_profile_roles_and_superadmin_inheritance.sql"
    );
    const invariantMigration = source(
      "supabase/migrations/20260827120000_last_effective_admin_invariant.sql"
    );

    expect(route).not.toContain('.from("profiles")\n    .update(');
    expect(route).not.toMatch(/count:\s*["']exact["']/);
    expect(route).not.toContain('.rpc("update_profile_admin_v1"');
    expect(route).toContain('.rpc("update_profile_admin_v2"');
    expect(route).toContain('error?.code === lastEffectiveAdminSqlState');
    expect(route).toContain('const lastEffectiveAdminSqlState = "QS821"');
    expect(route).toContain('const lastEffectiveAdminPublicCode = "LAST_EFFECTIVE_ADMIN_REQUIRED"');
    expect(route).toContain('error?.code === adminMutationForbiddenSqlState');
    expect(route).toContain('const adminMutationForbiddenSqlState = "42501"');
    expect(route).toContain('const adminMutationForbiddenPublicCode = "ADMIN_MUTATION_FORBIDDEN"');
    expect(route).toContain("Only Super Admin Dev can promote");
    expect(roleMigration).toContain("revoke update on table public.profiles from public, anon, authenticated");
    expect(roleMigration).toContain("SUPER_ADMIN_DEV_REQUIRED");
    expect(invariantMigration).toContain("create or replace function public.update_profile_admin_v2");
    expect(invariantMigration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(invariantMigration).toContain("select public.update_profile_admin_v2(");
    expect(invariantMigration).toContain("LAST_EFFECTIVE_ADMIN_REQUIRED");
    expect(invariantMigration).toContain("superadmin_managed_privileged_profile");
  });

  it("keeps Storage ownership/membership rules while inheriting admin helpers", () => {
    const base = source("supabase/migrations/20260624000000_quiksol_platform.sql");
    const clients = source("supabase/migrations/20260723190000_clients_opportunities_access.sql");
    const chat = source("supabase/migrations/20260629000000_enterprise_mvp.sql");
    const opportunityFinder = source("supabase/migrations/20260808120000_opportunity_finder_advanced.sql");

    expect(base).toContain("excel_uploads_select_own_or_admin");
    expect(base).toContain("public.is_admin()");
    expect(clients).toContain("client_assets_insert_manager");
    expect(clients).toContain("public.can_manage_clients()");
    expect(chat).toContain("public.is_conversation_member");
    expect(chat).toContain("avatars_update_own");
    expect(opportunityFinder).toContain("opportunity_finder_storage_insert_own");
    expect(opportunityFinder).toContain("(storage.foldername(name))[1] = auth.uid()::text");
  });
});
