import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEMO_DATA_MANIFEST,
  DEMO_SEED_MARKER,
  validateDemoManifest
} from "../demo-data-manifest";
import {
  buildDemoDryRunPlan,
  parseDemoSeedArgs,
  projectRefFromSupabaseUrl,
  validateDemoApplyGuards
} from "../seed-demo-data";

describe("DEMO data manifest", () => {
  it("is internally consistent and contains only reserved demo email domains", () => {
    expect(validateDemoManifest()).toBe(DEMO_DATA_MANIFEST);
    expect(DEMO_DATA_MANIFEST.people).toHaveLength(7);
    expect(DEMO_DATA_MANIFEST.people.every((person) => person.email.endsWith(".demo.invalid"))).toBe(true);
    expect(DEMO_DATA_MANIFEST.customer.contactEmail.endsWith(".demo.invalid")).toBe(true);
  });

  it("keeps price, quantity and quote metrics deterministic", () => {
    expect(DEMO_DATA_MANIFEST.product).toMatchObject({
      mpn: "QKS-DEMO-MCU-042",
      manufacturer: "Asterion Microdevices — DEMO",
      demandQuantity: 1200,
      targetUnitPrice: 4.8,
      authorizedUnitPrice: 4.65,
      minimumOrderQuantity: 500,
      leadTimeDays: 7
    });
    expect(DEMO_DATA_MANIFEST.supplierOffer.rawUnitCost).toBe(3.1);
    expect(DEMO_DATA_MANIFEST.quote).toMatchObject({
      number: "QKS-DEMO-0001",
      subtotal: 5580,
      tax: 390.6,
      total: 5970.6,
      status: "accepted"
    });
    expect(DEMO_DATA_MANIFEST.expectedMetrics).toEqual({
      createdQuotes: 1,
      sentQuotes: 1,
      acceptedQuotes: 1,
      conversionRatePercent: 100,
      acceptedQuoteValueUsd: 5970.6
    });
  });

  it("uses the fixed technical capabilities without adding business titles to Auth", () => {
    expect(new Set(DEMO_DATA_MANIFEST.people.map((person) => person.technicalRole))).toEqual(
      new Set(["admin", "manager", "employee"])
    );
    expect(DEMO_DATA_MANIFEST.people.find((person) => person.key === "olivia")).toMatchObject({
      fullName: "Olivia Mercer — DEMO",
      technicalRole: "admin",
      profileBusinessRank: "owner",
      organizationRank: "owner"
    });
    expect(DEMO_DATA_MANIFEST.people.map((person) => person.fullName)).toEqual([
      "Olivia Mercer — DEMO",
      "Daniel Brooks — DEMO",
      "Maya Torres — DEMO",
      "Jordan Lee — DEMO",
      "Lin Wei — DEMO",
      "Aya Nakamura — DEMO",
      "Chen Rui — DEMO"
    ]);
  });
});

describe("DEMO seed CLI safety", () => {
  it("is a disconnected dry-run by default", () => {
    expect(parseDemoSeedArgs([])).toEqual({
      mode: "dry-run",
      confirmation: undefined,
      projectRef: undefined
    });
    expect(buildDemoDryRunPlan()).toMatchObject({
      mode: "dry-run",
      networkAccess: false,
      writes: false,
      marker: DEMO_SEED_MARKER
    });
  });

  it("rejects password flags and unknown flags", () => {
    expect(() => parseDemoSeedArgs(["--password=do-not-log-this"])).toThrow(
      "DEMO_SEED_PASSWORD_FLAG_FORBIDDEN"
    );
    expect(() => parseDemoSeedArgs(["--force"])).toThrow("DEMO_SEED_UNKNOWN_FLAG");
  });

  it("rejects ambiguous or duplicate modes", () => {
    expect(() => parseDemoSeedArgs(["--apply", "--dry-run"])).toThrow(
      "DEMO_SEED_CONFLICTING_MODES"
    );
    expect(() => parseDemoSeedArgs(["--apply", "--apply"])).toThrow(
      "DEMO_SEED_DUPLICATE_MODE_FLAG"
    );
  });

  it("requires confirmation and the explicit project allowlist", () => {
    const options = parseDemoSeedArgs([
      "--apply",
      "--confirm=QUIKSOL_DEMO_DATA_ONLY",
      "--project-ref=abcdefghijklmnopqrst"
    ]);
    const env = {
      QUIKSOL_DEMO_SEED_ALLOWED: "true",
      QUIKSOL_DEMO_PROJECT_REF: "abcdefghijklmnopqrst",
      QUIKSOL_DEMO_USER_PASSWORD: "Strong-Demo-Only-42!"
    };
    expect(
      validateDemoApplyGuards(options, env, "https://abcdefghijklmnopqrst.supabase.co")
    ).toEqual({ password: "Strong-Demo-Only-42!", projectRef: "abcdefghijklmnopqrst" });
    expect(() =>
      validateDemoApplyGuards(options, { ...env, QUIKSOL_DEMO_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" }, "https://abcdefghijklmnopqrst.supabase.co")
    ).toThrow("DEMO_SEED_PROJECT_REF_MISMATCH");
  });

  it("requires a strong password and exact confirmation", () => {
    const base = {
      mode: "apply" as const,
      projectRef: "abcdefghijklmnopqrst",
      confirmation: "wrong"
    };
    const env = {
      QUIKSOL_DEMO_SEED_ALLOWED: "true",
      QUIKSOL_DEMO_PROJECT_REF: "abcdefghijklmnopqrst",
      QUIKSOL_DEMO_USER_PASSWORD: "weak"
    };
    expect(() =>
      validateDemoApplyGuards(base, env, "https://abcdefghijklmnopqrst.supabase.co")
    ).toThrow("DEMO_SEED_CONFIRMATION_REQUIRED");
    expect(() =>
      validateDemoApplyGuards(
        { ...base, confirmation: "QUIKSOL_DEMO_DATA_ONLY" },
        env,
        "https://abcdefghijklmnopqrst.supabase.co"
      )
    ).toThrow("QUIKSOL_DEMO_USER_PASSWORD_WEAK");
  });

  it("accepts only a standard HTTPS Supabase URL", () => {
    expect(projectRefFromSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co")).toBe(
      "abcdefghijklmnopqrst"
    );
    expect(() => projectRefFromSupabaseUrl("http://abcdefghijklmnopqrst.supabase.co")).toThrow(
      "DEMO_SEED_HTTPS_REQUIRED"
    );
    expect(() => projectRefFromSupabaseUrl("https://example.com")).toThrow(
      "DEMO_SEED_STANDARD_SUPABASE_URL_REQUIRED"
    );
  });
});

describe("DEMO seed source boundary", () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(testDirectory, "../seed-demo-data.ts"), "utf8");

  it("never mutates existing Auth users or grants super-admin roles", () => {
    expect(source).not.toContain("updateUserById");
    expect(source).not.toMatch(/auth\.admin\.createUser\s*\(/);
    expect(source).toContain("createProvisionedAuthUser");
    expect(source).not.toContain('requested_role: "admin"');
    expect(source).not.toContain('requested_role: "super_admin_dev"');
  });

  it("does not seed compensation, Opportunity Finder, revenue or sales tables", () => {
    expect(source).not.toContain('.from("employee_compensation")');
    expect(source).not.toContain('.from("opportunity_finder_');
    expect(source).not.toMatch(/\.from\("(?:revenue|sales)/);
  });

  it("returns from dry-run before loading environment files or creating Supabase", () => {
    const dryRunReturn = source.indexOf('console.log(JSON.stringify(buildDemoDryRunPlan(), null, 2));');
    const environmentLoad = source.indexOf('loadEnvFile(".env.local")');
    const clientCreation = source.indexOf("const supabase = createClient");
    expect(dryRunReturn).toBeGreaterThan(0);
    expect(environmentLoad).toBeGreaterThan(dryRunReturn);
    expect(clientCreation).toBeGreaterThan(environmentLoad);
  });

  it("checks existing seeded events before inserting immutable event history", () => {
    const eventRead = source.indexOf('select("event_type,metadata")');
    const eventInsert = source.indexOf('.from("commerce_quote_events").insert');
    expect(eventRead).toBeGreaterThan(0);
    expect(eventInsert).toBeGreaterThan(eventRead);
  });
});
