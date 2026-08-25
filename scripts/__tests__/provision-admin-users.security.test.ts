import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const provisioningPath = path.join(process.cwd(), "scripts/provision-admin-users.ts");
const provisioningSource = readFileSync(provisioningPath, "utf8");
const packageSource = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
const envExampleSource = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");

describe("admin provisioning source security", () => {
  it("contains no literal password assigned to provisioning payloads or seeds", () => {
    expect(/password\s*:\s*["'][^"']+["']/i.test(provisioningSource)).toBe(false);
    const targetBlock = provisioningSource.match(
      /export const ADMIN_TARGETS[\s\S]*?function normalizeEmail/
    )?.[0];
    expect(targetBlock).toBeDefined();
    expect(/\bpassword\b/i.test(targetBlock ?? "")).toBe(false);
  });

  it("does not provide a non-empty fallback for secret environment variables", () => {
    expect(
      /process\.env(?:\.[A-Z0-9_]+|\[[^\]]+\])\s*(?:\?\?|\|\|)\s*["'][^"']+["']/.test(
        provisioningSource
      )
    ).toBe(false);
  });

  it("requires explicit apply intent before any service client or mutation path", () => {
    const dryRunGuard = provisioningSource.indexOf('if (options.mode === "dry-run")');
    const serviceConfiguration = provisioningSource.indexOf("serviceConfiguration();");
    expect(provisioningSource.includes('args.includes("--apply")')).toBe(true);
    expect(dryRunGuard).toBeGreaterThan(-1);
    expect(serviceConfiguration).toBeGreaterThan(dryRunGuard);
  });

  it("does not couple an existing-user update to a seed password", () => {
    expect(
      /updateUserById\([\s\S]*?password\s*:\s*admin\.password/.test(provisioningSource)
    ).toBe(false);
  });

  it("contains no literal provider token, service-role value, JWT, or connection credential", () => {
    const inspectedSource = [provisioningSource, packageSource, envExampleSource].join("\n");
    const sensitivePatterns = [
      /(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)\s*[:=]\s*["'][^"']+["']/,
      /\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/,
      /\b(?:sk-|sb_secret_)[A-Za-z0-9._-]{8,}\b/i,
      /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/i
    ];
    for (const pattern of sensitivePatterns) {
      expect(pattern.test(inspectedSource)).toBe(false);
    }
  });

  it("keeps secret examples empty and never accepts a password through an npm script", () => {
    expect(envExampleSource).toMatch(/^QUIKSOL_ADMIN_PROVISIONING_PASSWORD=$/m);
    expect(envExampleSource).toMatch(/^QUIKSOL_ADMIN_ROTATION_PASSWORD=$/m);
    expect(/--password(?:=|\s)/.test(packageSource)).toBe(false);
  });
});
