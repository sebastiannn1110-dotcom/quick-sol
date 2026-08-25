import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { executiveSearchDomains } from "@/lib/search/executive-domains";
import { parseExecutiveQuery } from "@/lib/search/executive-query-parser";

describe("executiveSearchDomains", () => {
  it.each([
    ["MPN SN74LVC2G74", ["records"]],
    ["errores de commission", ["errors"]],
    ["uploads recientes", ["uploads"]],
    ["usuario Ana", ["users"]],
    ["resumen dashboard", ["records", "uploads"]]
  ])("routes %s only to relevant domains", (query, domains) => {
    expect(executiveSearchDomains(parseExecutiveQuery(query))).toEqual(domains);
  });

  it("uses one ranked RPC for pure MPN searches and keeps role redaction", () => {
    const route = fs.readFileSync(path.resolve("app/api/executive-search/route.ts"), "utf8");
    const migration = fs.readFileSync(path.resolve("supabase/migrations/20260813120000_performance_scalability.sql"), "utf8");
    const privacyMigration = fs.readFileSync(path.resolve("supabase/migrations/20260824120000_privacy_authorization_boundary.sql"), "utf8");

    expect(route).toContain('rpc("search_executive_mpn_safe_v2"');
    expect(route).not.toContain('rpc("search_executive_mpn_v1"');
    expect(route).toContain("redactSensitiveFieldsForRole(recordsResult.data");
    expect(migration).toContain("when public.normalize_business_mpn_v1(coalesce(record.mpn, '')) = input.normalized_mpn");
    expect(migration).toContain("order by match_rank, created_at desc, id desc");
    expect(privacyMigration).toContain("revoke all on function public.search_executive_mpn_v1(text, integer, integer)");
    expect(privacyMigration).toContain("grant execute on function public.search_executive_mpn_safe_v2(text, integer, integer)");
    expect(privacyMigration).toContain("to authenticated, service_role");
  });
});
