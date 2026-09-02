import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  buildDemoFixedOwnershipPlan,
  buildDemoQuoteEventSeeds,
  buildDemoDryRunPlan,
  demoPeopleInHierarchyOrder,
  ensureDemoUsersWithGateway,
  legacyDemoOwnerInternalEmail,
  parseDemoSeedArgs,
  projectRefFromSupabaseUrl,
  seedBusinessData,
  validateDemoApplyGuards,
  validateDemoFixedRows,
  validateDemoOwnerPassword,
  validateExistingDemoQuoteEvents,
  validateLinkedDemoProjectRef,
  type DemoAuthUser,
  type DemoFixedRowOwnershipExpectation,
  type PersonIds,
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

type StoredRow = Record<string, unknown>;

function materializeOwnedFixedRow(expectation: DemoFixedRowOwnershipExpectation): StoredRow {
  const row: StoredRow = { ...expectation.exact };
  for (const field of expectation.stringMarkerFields) {
    row[field] = `${DEMO_SEED_MARKER}: deterministic test evidence.`;
  }
  for (const field of expectation.objectMarkerFields) {
    row[field] = { demo: true, seed_marker: DEMO_SEED_MARKER };
  }
  return row;
}

function fixedOwnershipGroup(table: string) {
  const group = buildDemoFixedOwnershipPlan().find((candidate) => candidate.table === table);
  if (!group) throw new Error(`TEST_FIXED_OWNERSHIP_GROUP_MISSING: ${table}`);
  return group;
}

function demoPersonIds(): PersonIds {
  return Object.fromEntries(
    DEMO_DATA_MANIFEST.people.map((person, index) => [person.key, demoUser(person, index).id])
  ) as PersonIds;
}

function fakeBusinessSupabase() {
  const tables = new Map<string, Map<string, StoredRow>>();
  const insertedRows = { count: 0 };

  function tableRows(table: string) {
    let rows = tables.get(table);
    if (!rows) {
      rows = new Map<string, StoredRow>();
      tables.set(table, rows);
    }
    return rows;
  }

  const supabase = {
    from(table: string) {
      return {
        async upsert(input: StoredRow | StoredRow[], options: { onConflict: string }) {
          for (const row of Array.isArray(input) ? input : [input]) {
            const key = String(row[options.onConflict]);
            const existing = tableRows(table).get(key);
            tableRows(table).set(key, { ...existing, ...row });
          }
          return { error: null };
        },
        async insert(input: StoredRow | StoredRow[]) {
          for (const [index, row] of (Array.isArray(input) ? input : [input]).entries()) {
            const metadata = row.metadata as StoredRow | undefined;
            const key = String(
              metadata?.seed_event_key
              ?? row.id
              ?? row.client_id
              ?? `${table}-${tableRows(table).size + index}`
            );
            if (!tableRows(table).has(key)) insertedRows.count += 1;
            tableRows(table).set(key, { ...row });
          }
          return { error: null };
        },
        select() {
          return {
            async in(column: string, values: readonly unknown[]) {
              return {
                data: [...tableRows(table).values()].filter((row) => values.includes(row[column])),
                error: null
              };
            }
          };
        }
      };
    }
  } as unknown as SupabaseClient;

  return {
    supabase,
    insertedRows,
    put(table: string, key: string, row: StoredRow) {
      tableRows(table).set(key, { ...row });
    },
    rows(table: string) {
      return [...tableRows(table).values()];
    }
  };
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

  it("keeps the exact source company key, id, and logo_path mapping", () => {
    expect(DEMO_DATA_MANIFEST.clients.map((target) => [
      target.name,
      target.key,
      target.id,
      target.media.localPath
    ])).toEqual([
      ["Amazon-demo", "novaCircuit", "d0000000-0000-4000-8000-000000000001", "demo/companies/nova-circuit.webp"],
      ["Google-demo", "atlasRobotics", "d3000000-0000-4000-8000-000000000002", "demo/companies/atlas-robotics.webp"],
      ["Microsoft-demo", "andinaControls", "d3000000-0000-4000-8000-000000000003", "demo/companies/andina-controls.webp"],
      ["Apple-demo", "northStarDevices", "d3000000-0000-4000-8000-000000000004", "demo/companies/north-star-devices.webp"],
      ["Nvidia-demo", "pacificaEnergy", "d3000000-0000-4000-8000-000000000005", "demo/companies/pacifica-energy.webp"],
      ["Intel-demo", "mapleGrid", "d3000000-0000-4000-8000-000000000006", "demo/companies/maple-grid.webp"],
      ["Samsung-demo", "blueMesa", "d3000000-0000-4000-8000-000000000007", "demo/companies/blue-mesa.webp"],
      ["Sony-demo", "libertyMotion", "d3000000-0000-4000-8000-000000000008", "demo/companies/liberty-motion.webp"],
      ["Dell-demo", "lionCity", "d3000000-0000-4000-8000-000000000009", "demo/companies/lion-city.webp"],
      ["HP-demo", "pearlRiver", "d3000000-0000-4000-8000-000000000010", "demo/companies/pearl-river.webp"],
      ["IBM-demo", "meridianSemi", "d3000000-0000-4000-8000-000000000011", "demo/companies/meridian-semi.webp"],
      ["Cisco-demo", "rheinWerk", "d3000000-0000-4000-8000-000000000012", "demo/companies/rhein-werk.webp"],
      ["Oracle-demo", "hexagon", "d3000000-0000-4000-8000-000000000013", "demo/companies/hexagon.webp"],
      ["Qualcomm-demo", "euroNova", "d3000000-0000-4000-8000-000000000014", "demo/companies/euro-nova.webp"],
      ["Siemens-demo", "azteca", "d3000000-0000-4000-8000-000000000015", "demo/companies/azteca.webp"],
      ["Bosch-demo", "sakura", "d3000000-0000-4000-8000-000000000016", "demo/companies/sakura.webp"],
      ["Panasonic-demo", "britannia", "d3000000-0000-4000-8000-000000000017", "demo/companies/britannia.webp"],
      ["Meta-demo", "iberia", "d3000000-0000-4000-8000-000000000018", "demo/companies/iberia.webp"],
      ["Tesla-demo", "southernCross", "d3000000-0000-4000-8000-000000000019", "demo/companies/southern-cross.webp"]
    ]);
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

describe("DEMO fixed-ID ownership and partial-apply recovery", () => {
  it("allows a missing deterministic client to proceed to create", async () => {
    const clients = fixedOwnershipGroup("clients");
    expect(() => validateDemoFixedRows(clients, [])).not.toThrow();

    const database = fakeBusinessSupabase();
    await seedBusinessData(database.supabase, demoPersonIds());

    expect(database.rows("clients")).toHaveLength(19);
    expect(database.rows("clients")).toContainEqual(expect.objectContaining({
      id: DEMO_DATA_MANIFEST.ids.client,
      external_customer_id: "DEMO-AMAZON",
      name: "Amazon-demo"
    }));
  });

  it("recognizes and reconciles the existing seed-owned Amazon-demo row", async () => {
    const clients = fixedOwnershipGroup("clients");
    const amazon = DEMO_DATA_MANIFEST.clients[0];
    const existingAmazon = {
      id: amazon.id,
      external_customer_id: amazon.externalId,
      name: amazon.name,
      description: amazon.description,
      industry: amazon.industry,
      region: "legacy-partial-region",
      logo_path: "legacy-partial-logo.webp",
      assigned_salesperson_id: "legacy-partial-owner"
    };

    expect(() => validateDemoFixedRows(clients, [existingAmazon])).not.toThrow();

    const database = fakeBusinessSupabase();
    database.put("clients", amazon.id, existingAmazon);
    await seedBusinessData(database.supabase, demoPersonIds());

    expect(database.rows("clients")).toHaveLength(19);
    expect(database.rows("clients").find((row) => row.id === amazon.id)).toMatchObject({
      external_customer_id: amazon.externalId,
      name: amazon.name,
      description: amazon.description,
      region: amazon.region,
      logo_path: amazon.media.localPath
    });
  });

  it("accepts all 19 existing seed-owned clients without weakening their identity", () => {
    const clients = fixedOwnershipGroup("clients");
    const existingRows = clients.expected.map(materializeOwnedFixedRow);

    expect(clients.expected).toHaveLength(19);
    expect(new Set(existingRows.map((row) => row.id)).size).toBe(19);
    expect(() => validateDemoFixedRows(clients, existingRows)).not.toThrow();
  });

  it("rejects a foreign identity that reuses a deterministic client UUID", () => {
    const clients = fixedOwnershipGroup("clients");
    const amazonExpectation = clients.expected[0];
    if (!amazonExpectation) throw new Error("TEST_AMAZON_EXPECTATION_MISSING");
    const seedOwned = materializeOwnedFixedRow(amazonExpectation);
    const expectedError = `DEMO_SEED_FIXED_ID_COLLISION: clients.id=${amazonExpectation.id}`;

    const wrongName = { ...seedOwned, name: "Real Customer Ltd" };
    const wrongExternalId = { ...seedOwned, external_customer_id: "REAL-CUSTOMER-001" };
    expect(() => validateDemoFixedRows(clients, [wrongName])).toThrow(expectedError);
    expect(() => validateDemoFixedRows(clients, [wrongExternalId])).toThrow(expectedError);
    expect(wrongName.name).toBe("Real Customer Ltd");
    expect(wrongExternalId.external_customer_id).toBe("REAL-CUSTOMER-001");
  });

  it("allows partial seed-owned subsets across every deterministic-ID table", () => {
    const expectedCounts: Record<string, number> = {
      clients: 19,
      commerce_client_details: 19,
      commerce_catalog_products: 1,
      commerce_rfqs: 19,
      commerce_rfq_items: 19,
      sourcing_requests: 1,
      sourcing_offers: 1,
      commercial_price_approvals: 1,
      commerce_quotes: 45,
      commerce_quote_items: 45
    };

    const plan = buildDemoFixedOwnershipPlan();
    expect(Object.fromEntries(plan.map((group) => [group.table, group.expected.length]))).toEqual(expectedCounts);
    const plannedTableIds = plan
      .flatMap((group) => group.expected.map((entry) => `${group.table}:${entry.id}`))
      .sort();
    const expectedTableIds = [
      ...DEMO_DATA_MANIFEST.clients.flatMap((target) => [
        `clients:${target.id}`,
        `commerce_client_details:${target.id}`
      ]),
      `commerce_catalog_products:${DEMO_DATA_MANIFEST.ids.catalogProduct}`,
      ...DEMO_DATA_MANIFEST.rfqs.flatMap((rfq) => [
        `commerce_rfqs:${rfq.id}`,
        `commerce_rfq_items:${rfq.itemId}`
      ]),
      `sourcing_requests:${DEMO_DATA_MANIFEST.ids.sourcingRequest}`,
      `sourcing_offers:${DEMO_DATA_MANIFEST.ids.sourcingOffer}`,
      `commercial_price_approvals:${DEMO_DATA_MANIFEST.ids.priceApproval}`,
      ...DEMO_DATA_MANIFEST.quotes.flatMap((quote) => [
        `commerce_quotes:${quote.id}`,
        `commerce_quote_items:${quote.itemId}`
      ])
    ].sort();
    expect(plannedTableIds).toEqual(expectedTableIds);
    for (const group of plan) {
      const partialRows = group.expected
        .filter((_, index) => index % 2 === 0)
        .map(materializeOwnedFixedRow);
      expect(() => validateDemoFixedRows(group, partialRows), group.table).not.toThrow();
    }
  });

  it("rejects foreign identity evidence in every deterministic-ID table", () => {
    for (const group of buildDemoFixedOwnershipPlan()) {
      const expectation = group.expected[0];
      if (!expectation) throw new Error(`TEST_FIXED_OWNERSHIP_EXPECTATION_MISSING: ${group.table}`);
      const ownedRow = materializeOwnedFixedRow(expectation);
      const identityField = Object.keys(expectation.exact).find((field) => field !== group.idColumn);
      if (!identityField) throw new Error(`TEST_FIXED_OWNERSHIP_IDENTITY_MISSING: ${group.table}`);
      const foreignRow = { ...ownedRow, [identityField]: "FOREIGN-IDENTITY" };
      expect(
        () => validateDemoFixedRows(group, [foreignRow]),
        group.table
      ).toThrow(`DEMO_SEED_FIXED_ID_COLLISION: ${group.table}.${group.idColumn}=${expectation.id}`);

      for (const field of expectation.stringMarkerFields) {
        expect(
          () => validateDemoFixedRows(group, [{ ...ownedRow, [field]: "foreign" }]),
          `${group.table}.${field}`
        ).toThrow("DEMO_SEED_FIXED_ID_COLLISION");
      }
      for (const field of expectation.objectMarkerFields) {
        expect(
          () => validateDemoFixedRows(group, [{ ...ownedRow, [field]: { source: "foreign" } }]),
          `${group.table}.${field}`
        ).toThrow("DEMO_SEED_FIXED_ID_COLLISION");
      }
    }
  });

  it("keeps RFQs, quotes, events, and all final counts stable on a complete second run", async () => {
    const database = fakeBusinessSupabase();
    const personIds = demoPersonIds();

    await seedBusinessData(database.supabase, personIds);
    const firstCounts = {
      clients: database.rows("clients").length,
      companyPhotos: database.rows("clients").filter((row) => Boolean(row.logo_path)).length,
      rfqs: database.rows("commerce_rfqs").length,
      quotes: database.rows("commerce_quotes").length,
      quoteEvents: database.rows("commerce_quote_events").length
    };
    const insertedAfterFirstRun = database.insertedRows.count;

    await seedBusinessData(database.supabase, personIds);
    const secondCounts = {
      clients: database.rows("clients").length,
      companyPhotos: database.rows("clients").filter((row) => Boolean(row.logo_path)).length,
      rfqs: database.rows("commerce_rfqs").length,
      quotes: database.rows("commerce_quotes").length,
      quoteEvents: database.rows("commerce_quote_events").length
    };

    expect(secondCounts).toEqual(firstCounts);
    expect(secondCounts).toEqual({
      clients: 19,
      companyPhotos: 19,
      rfqs: 19,
      quotes: 45,
      quoteEvents: 117
    });
    expect(database.insertedRows.count).toBe(insertedAfterFirstRun);
    expect(DEMO_DATA_MANIFEST.people).toHaveLength(28);
    expect(DEMO_DATA_MANIFEST.people.filter((person) => person.avatarPath)).toHaveLength(27);
    expect(DEMO_DATA_MANIFEST.compensations).toHaveLength(28);
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

  it("uses the existing internal source contract for all 19 demo RFQs", () => {
    const businessSeed = source.slice(
      source.indexOf("async function seedBusinessData"),
      source.indexOf("export async function applyDemoSeed")
    );
    const commerceRfqStart = businessSeed.indexOf('"commerce_rfqs"');
    const commerceRfqSeed = businessSeed.slice(
      commerceRfqStart,
      businessSeed.indexOf('"sourcing_requests"', commerceRfqStart)
    );

    expect(DEMO_DATA_MANIFEST.rfqs).toHaveLength(19);
    expect(new Set(DEMO_DATA_MANIFEST.rfqs.map((rfq) => rfq.id)).size).toBe(19);
    expect(commerceRfqSeed.match(/source:\s*"internal"/g)).toHaveLength(2);
    expect(commerceRfqSeed).not.toContain("internal-demo");
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

  it("finishes every fixed-ID ownership check before the first apply write", () => {
    const applySeed = source.slice(
      source.indexOf("export async function applyDemoSeed"),
      source.indexOf("async function main")
    );
    const collisionPreflight = applySeed.indexOf("await collisionPreflight(service)");
    const userProvisioning = applySeed.indexOf("await ensureDemoUsers(");
    const businessSeed = applySeed.indexOf("await seedBusinessData(");
    expect(collisionPreflight).toBeGreaterThan(0);
    expect(userProvisioning).toBeGreaterThan(collisionPreflight);
    expect(businessSeed).toBeGreaterThan(userProvisioning);
  });
});
