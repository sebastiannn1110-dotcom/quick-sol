import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEMO_DATA_MANIFEST,
  DEMO_SEED_MARKER,
  validateDemoManifest,
  type DemoPerson
} from "../demo-data-manifest";
import {
  DEMO_BASE_PROJECT_REF,
  DEMO_OWNER_PASSWORD_ENV,
  buildDemoQuoteEventSeeds,
  buildDemoDryRunPlan,
  demoPeopleInHierarchyOrder,
  ensureDemoUsersWithGateway,
  legacyDemoOwnerInternalEmail,
  parseDemoSeedArgs,
  projectRefFromSupabaseUrl,
  validateDemoApplyGuards,
  validateDemoOwnerPassword,
  validateExistingDemoQuoteEvents,
  validateLinkedDemoProjectRef,
  type DemoAuthUser,
  type DemoUserProvisioningGateway
} from "../seed-demo-data";

const strongPassword = "Strong-Demo-Only-42!";
const ownerPassword = "owner-password-test-value";

function validApplyEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    QUIKSOL_DEMO_SEED_ALLOWED: "true",
    QUIKSOL_DEMO_PROJECT_REF: DEMO_BASE_PROJECT_REF,
    QUIKSOL_DEMO_USER_PASSWORD: strongPassword,
    [DEMO_OWNER_PASSWORD_ENV]: ownerPassword,
    ...overrides
  };
}

function demoUser(person: DemoPerson, index: number): DemoAuthUser {
  return {
    id: `d2000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    email: person.email,
    user_metadata: {
      full_name: person.fullName,
      quiksol_provisioning_intent_id: person.idempotencyKey,
      quiksol_demo_seed: DEMO_SEED_MARKER,
      demo: true
    }
  };
}

function fakeUserGateway(initialPeople: readonly DemoPerson[] = []) {
  const users = new Map(
    initialPeople.map((person) => [
      person.email.trim().toLowerCase(),
      demoUser(person, DEMO_DATA_MANIFEST.people.indexOf(person))
    ])
  );
  const calls = {
    cli: [] as DemoPerson[],
    admin: [] as DemoPerson[],
    create: [] as Array<{ person: DemoPerson; password: string }>,
    authenticate: [] as Array<{ person: DemoPerson; expectedUserId: string }>,
    verifyOwner: [] as Array<{ person: DemoPerson; password: string; expectedUserId: string }>,
    verifyOwnership: [] as Array<{ person: DemoPerson; user: DemoAuthUser }>,
    release: 0,
    profiles: [] as DemoPerson[],
    sequence: [] as string[]
  };

  function decision(person: DemoPerson) {
    return {
      state: "NEW" as const,
      intentId: person.idempotencyKey,
      authUserId: null,
      role: person.technicalRole,
      status: "pending" as const,
      attemptCount: 1
    };
  }

  const gateway: DemoUserProvisioningGateway = {
    async listAuthUsers() {
      return [...users.values()];
    },
    async verifyExistingSeedOwnership(person, user) {
      calls.verifyOwnership.push({ person, user });
      calls.sequence.push(`ownership:${person.key}`);
    },
    async getAuthUserById(userId) {
      const user = [...users.values()].find((candidate) => candidate.id === userId);
      if (!user) throw new Error("missing fake user");
      return user;
    },
    async beginCliProvisioning(person) {
      calls.cli.push(person);
      return decision(person);
    },
    async beginAdminProvisioning(person) {
      calls.admin.push(person);
      return decision(person);
    },
    async createAuthUser(person, password) {
      calls.create.push({ person, password });
      const user = demoUser(person, DEMO_DATA_MANIFEST.people.indexOf(person));
      users.set(person.email.trim().toLowerCase(), user);
      return user;
    },
    async authenticateSeedAdmin(person, _password, expectedUserId) {
      calls.authenticate.push({ person, expectedUserId });
      calls.sequence.push(`authenticate:${person.key}`);
      if (users.get(person.email.trim().toLowerCase())?.id !== expectedUserId) {
        throw new Error("fake admin mismatch");
      }
    },
    async releaseSeedAdminSession() {
      calls.release += 1;
    },
    async verifySeedOwnerLogin(person, password, expectedUserId) {
      calls.verifyOwner.push({ person, password, expectedUserId });
      calls.sequence.push(`verify-owner:${person.key}`);
      if (users.get(person.email.trim().toLowerCase())?.id !== expectedUserId) {
        throw new Error("DEMO_SEED_OWNER_AUTH_FAILED");
      }
    },
    async ensureSeedProfile(person) {
      calls.profiles.push(person);
      calls.sequence.push(`profile:${person.key}`);
    }
  };

  return { calls, gateway, users };
}

describe("DEMO data manifest", () => {
  it("is internally consistent and uses the presentation owner technical email only in seed data", () => {
    expect(validateDemoManifest()).toBe(DEMO_DATA_MANIFEST);
    expect(DEMO_DATA_MANIFEST.people).toHaveLength(28);
    expect(DEMO_DATA_MANIFEST.people.find((person) => person.key === "demoOwner")).toEqual(
      expect.objectContaining({ email: "user.test.demo.com@demo.invalid", fullName: "user.test.demo.com" })
    );
    expect(DEMO_DATA_MANIFEST.people.every((person) => person.key === "demoOwner"
      ? person.email === "user.test.demo.com@demo.invalid"
      : person.email.endsWith("@quiksol.demo.invalid"))).toBe(true);
    expect(DEMO_DATA_MANIFEST.clients).toHaveLength(19);
    expect(DEMO_DATA_MANIFEST.clients.every((target) => target.contactEmail.endsWith(".demo.invalid"))).toBe(true);
  });

  it("uses the exact 19 explicitly fictitious demo account names", () => {
    expect(DEMO_DATA_MANIFEST.clients.map((target) => target.name)).toEqual([
      "Amazon-demo", "Google-demo", "Microsoft-demo", "Apple-demo", "Nvidia-demo",
      "Intel-demo", "Samsung-demo", "Sony-demo", "Dell-demo", "HP-demo", "IBM-demo",
      "Cisco-demo", "Oracle-demo", "Qualcomm-demo", "Siemens-demo", "Bosch-demo",
      "Panasonic-demo", "Meta-demo", "Tesla-demo"
    ]);
    expect(DEMO_DATA_MANIFEST.clients.every((target) => target.name.endsWith("-demo"))).toBe(true);
  });

  it("keeps historical employee media but assigns photos to only the other 27 employees", () => {
    const employeeMedia = DEMO_DATA_MANIFEST.people.flatMap((person) => person.media ? [person.media] : []);
    const companyMedia = DEMO_DATA_MANIFEST.clients.map((target) => target.media);
    const allMedia = [...employeeMedia, ...companyMedia];

    expect(employeeMedia).toHaveLength(27);
    expect(companyMedia).toHaveLength(19);
    expect(new Set(employeeMedia.map((asset) => asset.localPath)).size).toBe(27);
    expect(new Set(employeeMedia.map((asset) => asset.sha256)).size).toBe(27);
    expect(new Set(allMedia.map((asset) => asset.localPath)).size).toBe(46);
    expect(new Set(allMedia.map((asset) => asset.sourcePageUrl)).size).toBe(46);
    expect(new Set(allMedia.map((asset) => asset.sha256)).size).toBe(46);
    expect(allMedia.every((asset) =>
      asset.assetType === "conventional-stock-photo" &&
      asset.aiGenerated === false &&
      Boolean(asset.credit) &&
      Boolean(asset.licenseUrl)
    )).toBe(true);

    for (const asset of allMedia) {
      const filePath = path.resolve(process.cwd(), "public", asset.localPath);
      expect(fs.existsSync(filePath), asset.localPath).toBe(true);
      expect(createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"), asset.localPath)
        .toBe(asset.sha256);
    }

    const demoOwner = DEMO_DATA_MANIFEST.people.find((person) => person.key === "demoOwner");
    expect(demoOwner?.avatarPath).toBeNull();
    expect(DEMO_DATA_MANIFEST.people.filter((person) => person.avatarPath)).toHaveLength(27);
    expect(DEMO_DATA_MANIFEST.people
      .filter((person) => person.key !== "demoOwner")
      .every((person) => person.avatarPath === person.media?.localPath)).toBe(true);
    expect(demoOwner?.media).toBeNull();
    expect(fs.existsSync(path.resolve(process.cwd(), "public/demo/people/demo-owner.webp"))).toBe(false);
  });

  it("uses 19 unique generic stock images and no brand-named official logo asset", () => {
    const companyMedia = DEMO_DATA_MANIFEST.clients.map((target) => target.media);
    const officialBrandPath = /(?:amazon|google|microsoft|apple|nvidia|intel|samsung|sony|dell|hp|ibm|cisco|oracle|qualcomm|siemens|bosch|panasonic|meta|tesla)/i;

    expect(companyMedia).toHaveLength(19);
    expect(new Set(companyMedia.map((asset) => asset.localPath)).size).toBe(19);
    expect(companyMedia.every((asset) =>
      asset.assetType === "conventional-stock-photo" &&
      asset.aiGenerated === false &&
      !officialBrandPath.test(asset.localPath)
    )).toBe(true);
  });

  it("keeps the original commercial row and expanded metrics deterministic", () => {
    expect(DEMO_DATA_MANIFEST.quote).toMatchObject({
      number: "EPD-DEMO-0001",
      subtotal: 5580,
      tax: 390.6,
      total: 5970.6,
      status: "accepted"
    });
    expect(DEMO_DATA_MANIFEST.rfqs).toHaveLength(19);
    expect(DEMO_DATA_MANIFEST.quotes).toHaveLength(45);
    expect(DEMO_DATA_MANIFEST.expectedMetrics).toMatchObject({
      employees: 28,
      clients: 19,
      rfqs: 19,
      createdQuotes: 45,
      quoteItems: 45,
      quoteEvents: 117,
      sentQuotes: 39,
      acceptedQuotes: 22,
      rejectedQuotes: 8,
      expiredQuotes: 3,
      draftQuotes: 6,
      openSentQuotes: 6,
      activeSellers: 9,
      conversionRatePercent: 56.41,
      quotedValueUsd: 954365.1,
      acceptedQuoteValueUsd: 495121.1,
      compensationRows: 28
    });
  });

  it("uses only fixed technical roles and makes presentation owner the sole root and owner", () => {
    expect(new Set(DEMO_DATA_MANIFEST.people.map((person) => person.technicalRole))).toEqual(
      new Set(["admin", "manager", "employee"])
    );
    expect(DEMO_DATA_MANIFEST.people.find((person) => person.key === "demoOwner")).toMatchObject({
      fullName: "user.test.demo.com",
      technicalRole: "admin",
      profileBusinessRank: "owner",
      organizationRank: "owner",
      managerKey: null,
      avatarPath: null
    });
    expect(DEMO_DATA_MANIFEST.people.find((person) => person.key === "olivia")).toMatchObject({
      technicalRole: "admin",
      profileBusinessRank: "executive",
      organizationRank: "executive",
      managerKey: "demoOwner"
    });
    expect(DEMO_DATA_MANIFEST.people.filter((person) => person.organizationRank === "owner")).toHaveLength(1);
  });

  it("covers multiple countries and all requested departments with current compensation", () => {
    expect(new Set(DEMO_DATA_MANIFEST.people.map((person) => person.country)).size).toBe(17);
    expect(new Set(DEMO_DATA_MANIFEST.people.map((person) => person.department))).toEqual(
      new Set(["Executive", "Sales", "Sourcing", "Operations", "Customer Success"])
    );
    expect(DEMO_DATA_MANIFEST.compensations).toHaveLength(28);
    expect(DEMO_DATA_MANIFEST.compensations.every((row) => row.currency === "USD" && row.periodicity === "annual")).toBe(true);
    expect(new Set(DEMO_DATA_MANIFEST.quotes.map((quote) => quote.sellerKey)).size).toBe(9);
  });

  it("orders the hierarchy with presentation owner first and every manager before direct reports", () => {
    const ordered = demoPeopleInHierarchyOrder();
    const position = new Map(ordered.map((person, index) => [person.key, index]));
    expect(ordered[0]?.key).toBe("demoOwner");
    for (const person of ordered) {
      if (person.managerKey) {
        expect(position.get(person.managerKey)).toBeLessThan(position.get(person.key)!);
      }
    }
  });

  it("builds the complete immutable event lifecycle without duplicate seed keys", () => {
    const events = buildDemoQuoteEventSeeds();
    expect(events).toHaveLength(DEMO_DATA_MANIFEST.expectedMetrics.quoteEvents);
    expect(new Set(events.map((event) => event.key)).size).toBe(events.length);
    expect(events.filter((event) => event.eventType === "created")).toHaveLength(45);
    expect(events.filter((event) => event.eventType === "sent")).toHaveLength(39);
    expect(events.filter((event) => event.eventType === "accepted")).toHaveLength(22);
    expect(events.filter((event) => event.eventType === "rejected")).toHaveLength(8);
    expect(events.filter((event) => event.eventType === "expired")).toHaveLength(3);
  });

  it("recognizes a complete event set on the second pass and rejects foreign history", () => {
    const events = buildDemoQuoteEventSeeds();
    const rows = events.map((event) => ({
      quote_id: event.quoteId,
      actor_id: null,
      event_type: event.eventType,
      previous_status: event.previousStatus,
      new_status: event.newStatus,
      created_at: event.createdAt,
      metadata: {
        demo: true,
        seed_marker: DEMO_SEED_MARKER,
        seed_event_key: event.key
      }
    }));
    const existingKeys = validateExistingDemoQuoteEvents(rows);
    expect(existingKeys.size).toBe(events.length);
    expect(events.filter((event) => !existingKeys.has(event.key))).toHaveLength(0);
    expect(() => validateExistingDemoQuoteEvents([
      { ...rows[0], metadata: { source: "foreign" } }
    ])).toThrow("DEMO_SEED_NON_DEMO_EVENT_COLLISION");
    expect(() => validateExistingDemoQuoteEvents([
      { ...rows[0], quote_id: DEMO_DATA_MANIFEST.quotes[1].id }
    ])).toThrow("DEMO_SEED_IMMUTABLE_EVENT_MISMATCH");
  });
});

describe("DEMO seed CLI safety", () => {
  it("is a disconnected dry-run by default", () => {
    expect(parseDemoSeedArgs([])).toEqual({ mode: "dry-run", confirmation: undefined, projectRef: undefined });
    expect(buildDemoDryRunPlan()).toMatchObject({
      mode: "dry-run",
      networkAccess: false,
      writes: false,
      marker: DEMO_SEED_MARKER,
      records: {
        employees: 28,
        employeePhotos: 27,
        clients: 19,
        companyPhotos: 19,
        rfqs: 19,
        compensations: 28,
        quotes: 45
      },
      legacyOwnerReconciliation: {
        exactSeedOwnedIdentityOnly: true,
        reassignsProfileReferences: true,
        removesLegacyProfileAndAuthIdentity: true
      }
    });
  });

  it("rejects password flags, unknown flags, and ambiguous modes", () => {
    expect(() => parseDemoSeedArgs(["--password=do-not-log-this"])).toThrow("DEMO_SEED_PASSWORD_FLAG_FORBIDDEN");
    expect(() => parseDemoSeedArgs(["--force"])).toThrow("DEMO_SEED_UNKNOWN_FLAG");
    expect(() => parseDemoSeedArgs(["--apply", "--dry-run"])).toThrow("DEMO_SEED_CONFLICTING_MODES");
    expect(() => parseDemoSeedArgs(["--apply", "--apply"])).toThrow("DEMO_SEED_DUPLICATE_MODE_FLAG");
  });

  it("rejects missing or unapproved owner secrets without embedding the approved secret", () => {
    expect(() => validateDemoOwnerPassword(undefined)).toThrow(`${DEMO_OWNER_PASSWORD_ENV}_REQUIRED`);
    expect(() => validateDemoOwnerPassword(ownerPassword)).toThrow(`${DEMO_OWNER_PASSWORD_ENV}_NOT_APPROVED`);
    expect(() => validateDemoOwnerPassword("Another-valid-looking-demo-password-42!")).toThrow(
      `${DEMO_OWNER_PASSWORD_ENV}_NOT_APPROVED`
    );
    expect(validateDemoOwnerPassword("password.tets.demo.com")).toBe("password.tets.demo.com");
  });

  it("recognizes only the retired seed-owner identity without spelling it in fixtures", () => {
    expect(legacyDemoOwnerInternalEmail()).toBe(["ja", "sonBoss@quiksol.com"].join("").toLowerCase());
  });

  it("requires confirmation, exact demo ref, and both password boundaries", () => {
    const options = parseDemoSeedArgs([
      "--apply",
      "--confirm=QUIKSOL_DEMO_DATA_ONLY",
      `--project-ref=${DEMO_BASE_PROJECT_REF}`
    ]);
    expect(() => validateDemoApplyGuards(
      options,
      validApplyEnv(),
      `https://${DEMO_BASE_PROJECT_REF}.supabase.co`
    )).toThrow(`${DEMO_OWNER_PASSWORD_ENV}_NOT_APPROVED`);
    expect(() => validateDemoApplyGuards(
      options,
      validApplyEnv({ QUIKSOL_DEMO_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" }),
      `https://${DEMO_BASE_PROJECT_REF}.supabase.co`
    )).toThrow("DEMO_SEED_PROJECT_REF_MISMATCH");
  });

  it("cannot be redirected even when every supplied ref agrees", () => {
    const otherRef = "abcdefghijklmnopqrst";
    const options = parseDemoSeedArgs(["--apply", "--confirm=QUIKSOL_DEMO_DATA_ONLY", `--project-ref=${otherRef}`]);
    expect(() => validateDemoApplyGuards(
      options,
      validApplyEnv({ QUIKSOL_DEMO_PROJECT_REF: otherRef }),
      `https://${otherRef}.supabase.co`
    )).toThrow("DEMO_SEED_PROJECT_REF_MISMATCH");
    expect(validateLinkedDemoProjectRef(DEMO_BASE_PROJECT_REF)).toBe(DEMO_BASE_PROJECT_REF);
    expect(() => validateLinkedDemoProjectRef(otherRef)).toThrow("DEMO_SEED_LINKED_PROJECT_REF_MISMATCH");
  });

  it("requires a strong global provisioning password and exact confirmation", () => {
    const base = { mode: "apply" as const, projectRef: DEMO_BASE_PROJECT_REF, confirmation: "wrong" };
    expect(() => validateDemoApplyGuards(base, validApplyEnv({ QUIKSOL_DEMO_USER_PASSWORD: "weak" }), `https://${DEMO_BASE_PROJECT_REF}.supabase.co`)).toThrow("DEMO_SEED_CONFIRMATION_REQUIRED");
    expect(() => validateDemoApplyGuards(
      { ...base, confirmation: "QUIKSOL_DEMO_DATA_ONLY" },
      validApplyEnv({ QUIKSOL_DEMO_USER_PASSWORD: "weak" }),
      `https://${DEMO_BASE_PROJECT_REF}.supabase.co`
    )).toThrow("QUIKSOL_DEMO_USER_PASSWORD_WEAK");
  });

  it("accepts only a standard HTTPS Supabase URL", () => {
    expect(projectRefFromSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co")).toBe("abcdefghijklmnopqrst");
    expect(() => projectRefFromSupabaseUrl("http://abcdefghijklmnopqrst.supabase.co")).toThrow("DEMO_SEED_HTTPS_REQUIRED");
    expect(() => projectRefFromSupabaseUrl("https://example.com")).toThrow("DEMO_SEED_STANDARD_SUPABASE_URL_REQUIRED");
  });
});

describe("DEMO seed R8 provisioning flow", () => {
  const [olivia, ...team] = DEMO_DATA_MANIFEST.people;
  const originalKeys = new Set(["olivia", "daniel", "maya", "jordan", "lin", "aya", "chen"]);

  it("bootstraps only Olivia through CLI and provisions all others through her admin session", async () => {
    const { calls, gateway, users } = fakeUserGateway();
    const personIds = await ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword);
    expect(calls.cli.map((person) => person.key)).toEqual(["olivia"]);
    expect(calls.admin.map((person) => person.key)).toEqual(team.map((person) => person.key));
    expect(calls.admin.find((person) => person.key === "demoOwner")?.technicalRole).toBe("admin");
    expect(calls.create.map(({ person }) => person.key)).toEqual(DEMO_DATA_MANIFEST.people.map((person) => person.key));
    expect(calls.create.find(({ person }) => person.key === "demoOwner")?.password).toBe(ownerPassword);
    expect(calls.create.filter(({ person, password }) => person.key !== "demoOwner" && password === strongPassword)).toHaveLength(27);
    expect(calls.authenticate).toEqual([{ person: olivia, expectedUserId: personIds.olivia }]);
    expect(calls.verifyOwner).toEqual([{ person: team.find((person) => person.key === "demoOwner"), password: ownerPassword, expectedUserId: personIds.demoOwner }]);
    expect(calls.sequence.indexOf("authenticate:olivia")).toBeLessThan(calls.sequence.indexOf("verify-owner:demoOwner"));
    expect(calls.sequence.indexOf("verify-owner:demoOwner")).toBeLessThan(calls.sequence.indexOf("profile:olivia"));
    expect(calls.release).toBe(1);
    expect(users.size).toBe(28);
    expect(calls.create.some(({ person }) => String(person.technicalRole) === "super_admin_dev")).toBe(false);
  });

  it("reuses the seven original users and creates only the 21 additions", async () => {
    const initial = DEMO_DATA_MANIFEST.people.filter((person) => originalKeys.has(person.key));
    const { calls, gateway, users } = fakeUserGateway(initial);
    await ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword);
    expect(calls.cli).toHaveLength(0);
    expect(calls.create).toHaveLength(21);
    expect(calls.create.map(({ person }) => person.key)).toEqual(
      DEMO_DATA_MANIFEST.people.filter((person) => !originalKeys.has(person.key)).map((person) => person.key)
    );
    expect(users.size).toBe(28);
    expect(calls.verifyOwnership).toHaveLength(7);
  });

  it("resumes an Olivia plus presentation-owner partial apply without duplicates", async () => {
    const presentationOwner = team.find((person) => person.key === "demoOwner");
    if (!presentationOwner) throw new Error("TEST_DEMO_OWNER_MISSING");
    const { calls, gateway, users } = fakeUserGateway([olivia, presentationOwner]);

    const personIds = await ensureDemoUsersWithGateway(
      gateway,
      strongPassword,
      ownerPassword
    );

    expect(calls.cli).toHaveLength(0);
    expect(calls.admin).toHaveLength(26);
    expect(calls.create).toHaveLength(26);
    expect(calls.create.some(({ person }) => person.key === "olivia")).toBe(false);
    expect(calls.create.some(({ person }) => person.key === "demoOwner")).toBe(false);
    expect(calls.verifyOwnership).toHaveLength(2);
    expect(calls.verifyOwner).toEqual([
      {
        person: presentationOwner,
        password: ownerPassword,
        expectedUserId: personIds.demoOwner
      }
    ]);
    expect(calls.profiles).toHaveLength(28);
    expect(users.size).toBe(28);
  });

  it("is a no-create no-begin operation on the second run, including mixed-case presentation owner email", async () => {
    const { calls, gateway, users } = fakeUserGateway([olivia]);
    const firstIds = await ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword);
    const counts = { cli: calls.cli.length, admin: calls.admin.length, create: calls.create.length, authenticate: calls.authenticate.length, release: calls.release };
    const secondIds = await ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword);
    expect(secondIds).toEqual(firstIds);
    expect(users.size).toBe(28);
    expect({ cli: calls.cli.length, admin: calls.admin.length, create: calls.create.length, authenticate: calls.authenticate.length, release: calls.release }).toEqual(counts);
    expect(calls.verifyOwner).toHaveLength(2);
    expect(calls.verifyOwnership).toHaveLength(29);
  });

  it("fails closed for a non-seed Olivia before opening an admin session", async () => {
    const { calls, gateway, users } = fakeUserGateway([olivia]);
    users.set(olivia.email, { ...users.get(olivia.email)!, user_metadata: { full_name: olivia.fullName } });
    await expect(ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword)).rejects.toThrow(`DEMO_SEED_EXISTING_AUTH_USER_PROTECTED: ${olivia.email}`);
    expect(calls.cli).toHaveLength(0);
    expect(calls.admin).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
    expect(calls.profiles).toHaveLength(0);
  });

  it("does not create the expanded team when Olivia cannot authenticate", async () => {
    const { calls, gateway, users } = fakeUserGateway([olivia]);
    gateway.authenticateSeedAdmin = async (person, _password, expectedUserId) => {
      calls.authenticate.push({ person, expectedUserId });
      throw new Error("DEMO_SEED_ADMIN_AUTH_FAILED");
    };
    await expect(ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword)).rejects.toThrow("DEMO_SEED_ADMIN_AUTH_FAILED");
    expect(calls.admin).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
    expect(calls.release).toBe(1);
    expect(users.size).toBe(1);
    expect(calls.profiles).toHaveLength(0);
  });

  it("fails closed when the exact owner login cannot be verified", async () => {
    const { calls, gateway } = fakeUserGateway(DEMO_DATA_MANIFEST.people);
    gateway.verifySeedOwnerLogin = async (person, password, expectedUserId) => {
      calls.verifyOwner.push({ person, password, expectedUserId });
      throw new Error("DEMO_SEED_OWNER_AUTH_FAILED");
    };
    await expect(ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword)).rejects.toThrow("DEMO_SEED_OWNER_AUTH_FAILED");
    expect(calls.cli).toHaveLength(0);
    expect(calls.admin).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
    expect(calls.verifyOwner).toHaveLength(1);
    expect(calls.profiles).toHaveLength(0);
  });

  it("requires durable provisioning evidence before reusing an existing demo-marked Auth user", async () => {
    const { calls, gateway } = fakeUserGateway([olivia]);
    gateway.verifyExistingSeedOwnership = async () => {
      throw new Error(`DEMO_SEED_EXISTING_AUTH_USER_PROTECTED: ${olivia.email}`);
    };
    await expect(ensureDemoUsersWithGateway(gateway, strongPassword, ownerPassword)).rejects.toThrow(
      `DEMO_SEED_EXISTING_AUTH_USER_PROTECTED: ${olivia.email}`
    );
    expect(calls.cli).toHaveLength(0);
    expect(calls.admin).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
    expect(calls.profiles).toHaveLength(0);
  });
});

describe("DEMO seed source boundary", () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(testDirectory, "../seed-demo-data.ts"), "utf8");

  it("never rotates existing Auth users or grants super-admin roles", () => {
    expect(source).not.toContain("updateUserById");
    expect(source).not.toMatch(/auth\.admin\.createUser\s*\(/);
    expect(source).toContain("createProvisionedAuthUser");
    expect(source).not.toContain('requested_role: "super_admin_dev"');
  });

  it("does not seed Opportunity Finder, revenue, or sales tables", () => {
    const businessSeed = source.slice(
      source.indexOf("async function seedBusinessData"),
      source.indexOf("export async function applyDemoSeed")
    );
    expect(businessSeed).not.toContain('.from("opportunity_finder_');
    expect(source).not.toMatch(/\.from\("(?:revenue|sales)/);
    expect(source).toContain('.from("employee_compensation")');
    expect(source).toContain("DEMO_SEED_LEGACY_OWNER_PROTECTED");
    expect(source).not.toContain("purge_uploaded_business_data");
  });

  it("reconciles only deterministic local demo media paths into existing columns", () => {
    expect(source).toContain("avatar_path: person.avatarPath");
    expect(source.match(/employeePhotos: .*avatarPath/g)).toHaveLength(2);
    expect(source).toContain("logo_path: customer.media.localPath");
    expect(source).toContain("logo_path: target.media.localPath");
    expect(source).not.toContain('.from("storage.objects")');
  });

  it("reconciles seeded RFQ snapshots to the canonical intake contact shape", () => {
    expect(source).toContain("companyOrName: customer.name");
    expect(source).toContain("contact: customer.contactName");
    expect(source).toContain("email: customer.contactEmail");
    expect(source).toContain("preferredLanguage: customer.language");
    expect(source).toContain("country: targetClient.country");
    expect(source).toContain("typeof row.notes === \"string\" && row.notes.includes(DEMO_SEED_MARKER)");
    expect(source).not.toMatch(/^\s*company_name:\s*customer\.name/m);
    expect(source).not.toMatch(
      /^\s*contact_email:\s*targetClient\.contactEmail/m,
    );
  });

  it("returns from dry-run before loading environment files or creating Supabase", () => {
    const dryRunReturn = source.indexOf("console.log(JSON.stringify(buildDemoDryRunPlan(), null, 2));");
    const environmentLoad = source.indexOf('loadEnvFile(".env.local")');
    const serviceClientCreation = source.indexOf("const service = createClient");
    expect(dryRunReturn).toBeGreaterThan(0);
    expect(environmentLoad).toBeGreaterThan(dryRunReturn);
    expect(serviceClientCreation).toBeGreaterThan(environmentLoad);
  });

  it("checks existing seeded events before inserting immutable history", () => {
    expect(source.indexOf('select("quote_id,actor_id,event_type,previous_status,new_status,metadata,created_at")')).toBeGreaterThan(0);
    expect(source.indexOf("seed_event_key")).toBeGreaterThan(0);
    expect(source.indexOf('.from("commerce_quote_events").insert')).toBeGreaterThan(0);
  });
});
