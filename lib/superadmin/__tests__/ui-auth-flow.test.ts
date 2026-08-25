import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("single Supabase Auth flow for /admindev", () => {
  it("does not call the retired parallel login from the UI", () => {
    const page = source("app/admindev/page.tsx");
    expect(page).not.toContain('fetch("/api/superadmin/login"');
    expect(page).toContain('href="/login?redirect=/admindev"');
  });

  it("sends same-origin Supabase cookies without copying access tokens", () => {
    const page = source("app/admindev/page.tsx");
    const safety = source("components/admindev/DatabaseSafetyCenter.tsx");
    const profile = source("components/ProfileProvider.tsx");
    for (const current of [page, safety, profile]) expect(current).toContain('credentials: "same-origin"');
    expect(page).not.toMatch(/authorization\s*:/i);
    expect(page).not.toMatch(/localStorage|access_token|bearer/i);
  });

  it("uses the same server-side Supabase role guard for all technical endpoints", () => {
    for (const name of ["health", "traffic", "security", "imports", "ai", "chat"]) {
      expect(source(`app/api/superadmin/${name}/route.ts`)).toContain("requireSuperadmin(request)");
    }
    const auth = source("lib/superadmin/auth.ts");
    expect(auth).toContain("requireRole(request, [SUPER_ADMIN_DEV_ROLE])");
    expect(auth).not.toMatch(/SUPERADMIN_SESSION|verifySuperadminSession|attemptSuperadminLogin/);
  });
});
