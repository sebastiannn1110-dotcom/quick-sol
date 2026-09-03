import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";
import {
  DEMO_APPLY_CONFIRMATION,
  DEMO_DATA_MANIFEST,
  DEMO_SEED_MARKER,
  validateDemoManifest,
  type DemoPerson,
  type DemoPersonKey,
  type DemoQuoteStatus
} from "./demo-data-manifest";
import { createProvisionedAuthUser } from "./provision-admin-users";

export const DEMO_SEED_ALLOWED_ENV = "QUIKSOL_DEMO_SEED_ALLOWED";
export const DEMO_PROJECT_REF_ENV = "QUIKSOL_DEMO_PROJECT_REF";
export const DEMO_USER_PASSWORD_ENV = "QUIKSOL_DEMO_USER_PASSWORD";
export const DEMO_OWNER_PASSWORD_ENV = "QUIKSOL_DEMO_OWNER_PASSWORD";
export const DEMO_BASE_PROJECT_REF = "niaqaiiiphjfcysmxeqj";
const DEMO_OWNER_PASSWORD_APPROVED_SHA256 = "76a2474c182db3e3ff30571318a6746cd980b9cdaeb4e5b0a0d1c290ca741a9f";

export type DemoSeedOptions = {
  mode: "dry-run" | "apply";
  confirmation?: string;
  projectRef?: string;
};

export type DemoAuthUser = Pick<User, "id" | "email" | "user_metadata">;
export type PersonIds = Record<DemoPerson["key"], string>;
type UnknownRow = Record<string, unknown>;

type DemoProvisioningResult = {
  state: "NEW" | "EXISTING_PENDING" | "EXISTING_COMPLETED";
  intentId: string;
  authUserId: string | null;
  role: DemoPerson["technicalRole"];
  status: "pending" | "completed";
  attemptCount: number;
};

export type DemoUserProvisioningGateway = {
  listAuthUsers(): Promise<DemoAuthUser[]>;
  verifyExistingSeedOwnership(person: DemoPerson, user: DemoAuthUser): Promise<void>;
  getAuthUserById(userId: string): Promise<DemoAuthUser>;
  beginCliProvisioning(person: DemoPerson): Promise<DemoProvisioningResult>;
  beginAdminProvisioning(person: DemoPerson): Promise<DemoProvisioningResult>;
  createAuthUser(person: DemoPerson, password: string, intentId: string): Promise<DemoAuthUser>;
  authenticateSeedAdmin(person: DemoPerson, password: string, expectedUserId: string): Promise<void>;
  releaseSeedAdminSession(): Promise<void>;
  verifySeedOwnerLogin(person: DemoPerson, password: string, expectedUserId: string): Promise<void>;
  ensureSeedProfile(person: DemoPerson, userId: string): Promise<void>;
};

const projectRefPattern = /^[a-z0-9]{20}$/;
const provisioningUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function readFlag(args: string[], flag: string) {
  const prefix = `${flag}=`;
  const values = args.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length > 1) throw new Error(`DEMO_SEED_DUPLICATE_FLAG: ${flag}`);
  return values[0]?.trim() || undefined;
}

export function parseDemoSeedArgs(args: string[]): DemoSeedOptions {
  if (args.some((arg) => /^--(?:user-)?password(?:=|$)/i.test(arg))) {
    throw new Error(`DEMO_SEED_PASSWORD_FLAG_FORBIDDEN: use ${DEMO_USER_PASSWORD_ENV}.`);
  }

  const known = new Set(["--apply", "--dry-run"]);
  for (const arg of args) {
    if (known.has(arg) || arg.startsWith("--confirm=") || arg.startsWith("--project-ref=")) continue;
    throw new Error(`DEMO_SEED_UNKNOWN_FLAG: ${arg}`);
  }

  const applyCount = args.filter((arg) => arg === "--apply").length;
  const dryRunCount = args.filter((arg) => arg === "--dry-run").length;
  if (applyCount > 1 || dryRunCount > 1) throw new Error("DEMO_SEED_DUPLICATE_MODE_FLAG");
  if (applyCount && dryRunCount) throw new Error("DEMO_SEED_CONFLICTING_MODES");

  return {
    mode: applyCount === 1 ? "apply" : "dry-run",
    confirmation: readFlag(args, "--confirm"),
    projectRef: readFlag(args, "--project-ref")?.toLowerCase()
  };
}

export function projectRefFromSupabaseUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("DEMO_SEED_SUPABASE_URL_INVALID");
  }
  if (parsed.protocol !== "https:") throw new Error("DEMO_SEED_HTTPS_REQUIRED");
  const match = /^([a-z0-9]{20})\.supabase\.co$/i.exec(parsed.hostname);
  if (!match) throw new Error("DEMO_SEED_STANDARD_SUPABASE_URL_REQUIRED");
  return match[1].toLowerCase();
}

export function validateLinkedDemoProjectRef(rawRef: string) {
  const linkedRef = rawRef.trim().toLowerCase();
  if (linkedRef !== DEMO_BASE_PROJECT_REF) {
    throw new Error("DEMO_SEED_LINKED_PROJECT_REF_MISMATCH");
  }
  return linkedRef;
}

function validatePassword(password: string | undefined) {
  if (
    !password ||
    password.length < 16 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error(
      `${DEMO_USER_PASSWORD_ENV}_WEAK: require at least 16 characters with upper, lower, number and symbol.`
    );
  }
  return password;
}

export function validateDemoOwnerPassword(
  password: string | undefined
) {
  if (!password) throw new Error(`${DEMO_OWNER_PASSWORD_ENV}_REQUIRED`);
  const expected = Buffer.from(DEMO_OWNER_PASSWORD_APPROVED_SHA256, "hex");
  const actual = createHash("sha256").update(password, "utf8").digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`${DEMO_OWNER_PASSWORD_ENV}_NOT_APPROVED`);
  }
  return password;
}

export function validateDemoApplyGuards(
  options: DemoSeedOptions,
  env: NodeJS.ProcessEnv,
  supabaseUrl: string
) {
  if (options.mode !== "apply") throw new Error("DEMO_SEED_APPLY_MODE_REQUIRED");
  if (options.confirmation !== DEMO_APPLY_CONFIRMATION) {
    throw new Error(`DEMO_SEED_CONFIRMATION_REQUIRED: --confirm=${DEMO_APPLY_CONFIRMATION}`);
  }
  if (env[DEMO_SEED_ALLOWED_ENV] !== "true") {
    throw new Error(`DEMO_SEED_NOT_ALLOWLISTED: set ${DEMO_SEED_ALLOWED_ENV}=true explicitly.`);
  }

  const cliRef = options.projectRef;
  const allowlistedRef = env[DEMO_PROJECT_REF_ENV]?.trim().toLowerCase();
  if (!cliRef || !projectRefPattern.test(cliRef)) {
    throw new Error("DEMO_SEED_PROJECT_REF_REQUIRED: --project-ref=<20-character-ref>");
  }
  if (!allowlistedRef || !projectRefPattern.test(allowlistedRef)) {
    throw new Error(`${DEMO_PROJECT_REF_ENV}_REQUIRED`);
  }
  const urlRef = projectRefFromSupabaseUrl(supabaseUrl);
  if (
    cliRef !== DEMO_BASE_PROJECT_REF ||
    allowlistedRef !== DEMO_BASE_PROJECT_REF ||
    urlRef !== DEMO_BASE_PROJECT_REF
  ) {
    throw new Error("DEMO_SEED_PROJECT_REF_MISMATCH");
  }

  return {
    password: validatePassword(env[DEMO_USER_PASSWORD_ENV]),
    ownerPassword: validateDemoOwnerPassword(env[DEMO_OWNER_PASSWORD_ENV]),
    projectRef: cliRef
  };
}

export function buildDemoDryRunPlan() {
  const manifest = validateDemoManifest();
  return {
    mode: "dry-run",
    networkAccess: false,
    writes: false,
    projectRef: DEMO_BASE_PROJECT_REF,
    marker: manifest.marker,
    authUsers: manifest.people.map(({ email, technicalRole, profileBusinessRank }) => ({
      email,
      technicalRole,
      profileBusinessRank
    })),
    ownerAdmin: {
      email: manifest.ownerAdmin.email,
      technicalRole: manifest.ownerAdmin.technicalRole,
      profileBusinessRank: manifest.ownerAdmin.profileBusinessRank,
      avatar: "U"
    },
    records: {
      visibleEmployees: manifest.visibleEmployees.length,
      employeePhotos: manifest.visibleEmployees.filter((person) => Boolean(person.avatarPath)).length,
      clients: manifest.clients.length,
      companyPhotos: manifest.clients.filter((target) => Boolean(target.media.localPath)).length,
      rfqs: manifest.rfqs.length,
      compensations: manifest.compensations.length,
      quotes: manifest.quotes.length,
      product: manifest.product.mpn,
      quoteStatuses: {
        accepted: manifest.quotes.filter((quote) => quote.status === "accepted").length,
        rejected: manifest.quotes.filter((quote) => quote.status === "rejected").length,
        expired: manifest.quotes.filter((quote) => quote.status === "expired").length,
        sent: manifest.quotes.filter((quote) => quote.status === "sent").length,
        draft: manifest.quotes.filter((quote) => quote.status === "draft").length
      }
    },
    expectedMetrics: manifest.expectedMetrics,
    legacyOwnerReconciliation: {
      exactSeedOwnedIdentityOnly: true,
      reassignsProfileReferences: true,
      removesLegacyProfileAndAuthIdentity: true
    },
    applyRequirements: [
      "--apply",
      `--confirm=${DEMO_APPLY_CONFIRMATION}`,
      `--project-ref=${DEMO_BASE_PROJECT_REF}`,
      `${DEMO_SEED_ALLOWED_ENV}=true`,
      `${DEMO_PROJECT_REF_ENV}=${DEMO_BASE_PROJECT_REF}`,
      `${DEMO_USER_PASSWORD_ENV}=<strong-temporary-password>`,
      `${DEMO_OWNER_PASSWORD_ENV}=<approved-owner-password-from-secret-manager>`
    ],
    exclusions: [
      "no existing Auth user updates",
      "no super_admin_dev role grants",
      "no Opportunity Finder data",
      "no revenue or sales records",
      "dry-run performs no deletes"
    ]
  };
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const sourceLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const name = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || process.env[name] !== undefined) continue;
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

function serviceConfiguration() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const publishableKey = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL_REQUIRED");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY_REQUIRED");
  if (!publishableKey) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY_REQUIRED");
  return { supabaseUrl, serviceRoleKey, publishableKey };
}

async function schemaPreflight(supabase: SupabaseClient) {
  async function check(
    table: string,
    query: PromiseLike<{ error: { message: string } | null }>
  ) {
    const { error } = await query;
    if (error) throw new Error(`DEMO_SEED_SCHEMA_MISMATCH: ${table}: ${error.message}`);
  }

  await check(
    "profiles",
    supabase
      .from("profiles")
      .select("id,email,full_name,role,is_active,department,region,bio,job_title,business_rank", {
        head: true
      })
      .limit(1)
  );
  await check(
    "organization_members",
    supabase
      .from("organization_members")
      .select(
        "profile_id,manager_id,business_title,business_rank,department,country,location,responsibilities,version",
        { head: true }
      )
      .limit(1)
  );
  await check(
    "employee_compensation",
    supabase
      .from("employee_compensation")
      .select("employee_id,amount,currency,periodicity,updated_by,updated_at", { head: true })
      .limit(1)
  );
  await check(
    "clients",
    supabase
      .from("clients")
      .select("id,name,description,external_customer_id,assigned_salesperson_id", { head: true })
      .limit(1)
  );
  await check(
    "commerce_client_details",
    supabase
      .from("commerce_client_details")
      .select("client_id,contact_name,contact_email,commercial_notes", { head: true })
      .limit(1)
  );
  await check(
    "commerce_catalog_products",
    supabase
      .from("commerce_catalog_products")
      .select("id,mpn,manufacturer,description,commercial_price_approval_id,publish_to_catalog", {
        head: true
      })
      .limit(1)
  );
  await check(
    "commerce_rfqs",
    supabase
      .from("commerce_rfqs")
      .select("id,external_rfq_id,request_fingerprint,contact_snapshot", { head: true })
      .limit(1)
  );
  await check(
    "commerce_rfq_items",
    supabase
      .from("commerce_rfq_items")
      .select("id,rfq_id,line_number,mpn,quantity,target_price,description", { head: true })
      .limit(1)
  );
  await check(
    "sourcing_requests",
    supabase
      .from("sourcing_requests")
      .select("id,commerce_rfq_item_id,mpn,requested_quantity,notes", { head: true })
      .limit(1)
  );
  await check(
    "sourcing_offers",
    supabase
      .from("sourcing_offers")
      .select(
        "id,sourcing_request_id,mpn,supplier_name,raw_unit_cost,minimum_order_quantity,provenance,notes",
        { head: true }
      )
      .limit(1)
  );
  await check(
    "commercial_price_approvals",
    supabase
      .from("commercial_price_approvals")
      .select("id,sourcing_request_id,sourcing_offer_id,mpn,normalized_mpn,authorized_unit_price", {
        head: true
      })
      .limit(1)
  );
  await check(
    "commerce_quotes",
    supabase
      .from("commerce_quotes")
      .select("id,quote_number,rfq_id,client_id,seller_id,status,total,notes", { head: true })
      .limit(1)
  );
  await check(
    "commerce_quote_items",
    supabase
      .from("commerce_quote_items")
      .select("id,quote_id,mpn,quantity,seller_unit_price,line_total,description", { head: true })
      .limit(1)
  );
  await check(
    "commerce_quote_events",
    supabase
      .from("commerce_quote_events")
      .select("id,quote_id,event_type,metadata", { head: true })
      .limit(1)
  );
}

function markerInObject(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const row = value as UnknownRow;
  return Boolean(
    (row.demo === true && row.seed_marker === DEMO_SEED_MARKER) ||
      row.seedMarker === DEMO_SEED_MARKER ||
      (typeof row.notes === "string" && row.notes.includes(DEMO_SEED_MARKER))
  );
}

function markerInField(row: UnknownRow, field: string) {
  return typeof row[field] === "string" && row[field].includes(DEMO_SEED_MARKER);
}

export type DemoFixedRowOwnershipExpectation = Readonly<{
  id: string;
  exact: Readonly<Record<string, unknown>>;
  stringMarkerFields: readonly string[];
  objectMarkerFields: readonly string[];
}>;

export type DemoFixedOwnershipGroup = Readonly<{
  table: string;
  idColumn: string;
  expected: readonly DemoFixedRowOwnershipExpectation[];
}>;

function fixedOwnershipExpectation(
  id: string,
  exact: Record<string, unknown>,
  options: {
    stringMarkerFields?: readonly string[];
    objectMarkerFields?: readonly string[];
  } = {}
): DemoFixedRowOwnershipExpectation {
  return Object.freeze({
    id,
    exact: Object.freeze(exact),
    stringMarkerFields: Object.freeze([...(options.stringMarkerFields ?? [])]),
    objectMarkerFields: Object.freeze([...(options.objectMarkerFields ?? [])])
  });
}

export function buildDemoFixedOwnershipPlan(): DemoFixedOwnershipGroup[] {
  const { ids, clients, product, supplierOffer, rfqs, quotes } = DEMO_DATA_MANIFEST;
  const clientByKey = new Map(clients.map((target) => [target.key, target]));
  const rfqByKey = new Map(rfqs.map((target) => [target.key, target]));

  return [
    {
      table: "clients",
      idColumn: "id",
      expected: clients.map((target) => fixedOwnershipExpectation(target.id, {
        id: target.id,
        external_customer_id: target.externalId,
        name: target.name,
        description: target.description
      }))
    },
    {
      table: "commerce_client_details",
      idColumn: "client_id",
      expected: clients.map((target) => fixedOwnershipExpectation(target.id, {
        client_id: target.id,
        legal_company_name: target.name,
        contact_email: target.contactEmail
      }, { stringMarkerFields: ["commercial_notes"] }))
    },
    {
      table: "commerce_catalog_products",
      idColumn: "id",
      expected: [fixedOwnershipExpectation(ids.catalogProduct, {
        id: ids.catalogProduct,
        mpn: product.mpn,
        manufacturer: product.manufacturer,
        description: product.description,
        category: "DEMO",
        commercial_price_approval_id: ids.priceApproval
      })]
    },
    {
      table: "commerce_rfqs",
      idColumn: "id",
      expected: rfqs.map((rfq) => {
        const client = clientByKey.get(rfq.clientKey);
        if (!client) throw new Error(`DEMO_SEED_RFQ_CLIENT_MISSING: ${rfq.key}`);
        return fixedOwnershipExpectation(rfq.id, {
          id: rfq.id,
          external_rfq_id: rfq.externalId,
          request_fingerprint: rfq.fingerprint,
          client_id: client.id
        }, { objectMarkerFields: ["contact_snapshot"] });
      })
    },
    {
      table: "commerce_rfq_items",
      idColumn: "id",
      expected: rfqs.map((rfq) => fixedOwnershipExpectation(rfq.itemId, {
        id: rfq.itemId,
        rfq_id: rfq.id,
        line_number: 1,
        mpn: rfq.mpn,
        description: rfq.description
      }))
    },
    {
      table: "sourcing_requests",
      idColumn: "id",
      expected: [fixedOwnershipExpectation(ids.sourcingRequest, {
        id: ids.sourcingRequest,
        commerce_rfq_id: ids.rfq,
        commerce_rfq_item_id: ids.rfqItem,
        source: "commerce_rfq",
        mpn: product.mpn,
        normalized_mpn: product.normalizedMpn
      }, { stringMarkerFields: ["notes"] })]
    },
    {
      table: "sourcing_offers",
      idColumn: "id",
      expected: [fixedOwnershipExpectation(ids.sourcingOffer, {
        id: ids.sourcingOffer,
        sourcing_request_id: ids.sourcingRequest,
        mpn: product.mpn,
        normalized_mpn: product.normalizedMpn,
        supplier_name: supplierOffer.supplierName,
        supplier_reference: supplierOffer.reference
      }, { objectMarkerFields: ["provenance"] })]
    },
    {
      table: "commercial_price_approvals",
      idColumn: "id",
      expected: [fixedOwnershipExpectation(ids.priceApproval, {
        id: ids.priceApproval,
        sourcing_request_id: ids.sourcingRequest,
        sourcing_offer_id: ids.sourcingOffer,
        mpn: product.mpn,
        normalized_mpn: product.normalizedMpn,
        manufacturer: product.manufacturer
      })]
    },
    {
      table: "commerce_quotes",
      idColumn: "id",
      expected: quotes.map((quote) => {
        const client = clientByKey.get(quote.clientKey);
        const rfq = rfqByKey.get(quote.rfqKey);
        if (!client || !rfq) throw new Error(`DEMO_SEED_QUOTE_RELATION_MISSING: ${quote.key}`);
        return fixedOwnershipExpectation(quote.id, {
          id: quote.id,
          quote_number: quote.number,
          rfq_id: rfq.id,
          client_id: client.id
        }, { stringMarkerFields: ["notes"] });
      })
    },
    {
      table: "commerce_quote_items",
      idColumn: "id",
      expected: quotes.map((quote) => {
        const rfq = rfqByKey.get(quote.rfqKey);
        if (!rfq) throw new Error(`DEMO_SEED_QUOTE_RELATION_MISSING: ${quote.key}`);
        return fixedOwnershipExpectation(quote.itemId, {
          id: quote.itemId,
          quote_id: quote.id,
          line_number: 1,
          mpn: rfq.mpn,
          description: rfq.description
        });
      })
    }
  ];
}

export function isDemoFixedRowSeedOwned(
  row: UnknownRow,
  expectation: DemoFixedRowOwnershipExpectation
) {
  return Object.entries(expectation.exact).every(([field, value]) => row[field] === value)
    && expectation.stringMarkerFields.every((field) => markerInField(row, field))
    && expectation.objectMarkerFields.every((field) => markerInObject(row[field]));
}

export function validateDemoFixedRows(
  group: DemoFixedOwnershipGroup,
  rows: readonly UnknownRow[]
) {
  const expectationById = new Map(group.expected.map((entry) => [entry.id, entry]));
  for (const row of rows) {
    const id = String(row[group.idColumn]);
    const expectation = expectationById.get(id);
    if (!expectation || !isDemoFixedRowSeedOwned(row, expectation)) {
      throw new Error(`DEMO_SEED_FIXED_ID_COLLISION: ${group.table}.${group.idColumn}=${id}`);
    }
  }
}

async function guardFixedOwnershipGroup(
  supabase: SupabaseClient,
  group: DemoFixedOwnershipGroup
) {
  const { data, error } = await supabase
    .from(group.table as never)
    .select("*")
    .in(group.idColumn, group.expected.map((entry) => entry.id));
  if (error) throw error;
  validateDemoFixedRows(group, (data ?? []) as unknown as UnknownRow[]);
}

async function guardNaturalKey(
  supabase: SupabaseClient,
  table: string,
  filters: Record<string, string | number>,
  expectedId: string,
  idColumn = "id"
) {
  const { data, error } = await supabase.from(table as never).select(idColumn).match(filters);
  if (error) throw error;
  const conflicting = (data ?? []).find(
    (row) => String((row as unknown as UnknownRow)[idColumn]) !== expectedId
  );
  if (conflicting) throw new Error(`DEMO_SEED_NATURAL_KEY_COLLISION: ${table}`);
}

async function guardNaturalRows(
  supabase: SupabaseClient,
  table: string,
  naturalColumn: string,
  expected: readonly { value: string; id: string }[],
  idColumn = "id"
) {
  const { data, error } = await supabase
    .from(table as never)
    .select("*")
    .in(naturalColumn, expected.map((entry) => entry.value));
  if (error) throw error;
  const expectedIdByValue = new Map(expected.map((entry) => [entry.value, entry.id]));
  const conflicting = ((data ?? []) as unknown as UnknownRow[]).find(
    (row) => expectedIdByValue.get(String(row[naturalColumn])) !== String(row[idColumn])
  );
  if (conflicting) throw new Error(`DEMO_SEED_NATURAL_KEY_COLLISION: ${table}`);
}

async function guardCaseInsensitivePair(
  supabase: SupabaseClient,
  table: string,
  leftColumn: string,
  leftValue: string,
  rightColumn: string,
  rightValue: string,
  expectedId: string
) {
  const { data, error } = await supabase
    .from(table as never)
    .select("id")
    .ilike(leftColumn, leftValue)
    .ilike(rightColumn, rightValue);
  if (error) throw error;
  const conflicting = ((data ?? []) as unknown as UnknownRow[]).find(
    (row) => String(row.id) !== expectedId
  );
  if (conflicting) throw new Error(`DEMO_SEED_NATURAL_KEY_COLLISION: ${table}`);
}

async function guardLineOneRows(
  supabase: SupabaseClient,
  table: string,
  parentColumn: string,
  expected: readonly { parentId: string; id: string }[]
) {
  const { data, error } = await supabase
    .from(table as never)
    .select(`id,${parentColumn},line_number`)
    .in(parentColumn, expected.map((entry) => entry.parentId))
    .eq("line_number", 1);
  if (error) throw error;
  const expectedIdByParent = new Map(expected.map((entry) => [entry.parentId, entry.id]));
  const conflicting = ((data ?? []) as unknown as UnknownRow[]).find(
    (row) => expectedIdByParent.get(String(row[parentColumn])) !== String(row.id)
  );
  if (conflicting) throw new Error(`DEMO_SEED_NATURAL_KEY_COLLISION: ${table}`);
}

async function collisionPreflight(supabase: SupabaseClient) {
  const { ids, clients, product, rfqs, quotes } = DEMO_DATA_MANIFEST;
  for (const group of buildDemoFixedOwnershipPlan()) {
    await guardFixedOwnershipGroup(supabase, group);
  }

  await guardNaturalRows(supabase, "clients", "external_customer_id", clients.map((target) => ({ value: target.externalId, id: target.id })));
  await guardNaturalRows(supabase, "commerce_rfqs", "external_rfq_id", rfqs.map((rfq) => ({ value: rfq.externalId, id: rfq.id })));
  await guardNaturalRows(supabase, "commerce_quotes", "quote_number", quotes.map((quote) => ({ value: quote.number, id: quote.id })));
  await guardLineOneRows(supabase, "commerce_rfq_items", "rfq_id", rfqs.map((rfq) => ({ parentId: rfq.id, id: rfq.itemId })));
  await guardLineOneRows(supabase, "commerce_quote_items", "quote_id", quotes.map((quote) => ({ parentId: quote.id, id: quote.itemId })));
  await guardCaseInsensitivePair(
    supabase,
    "commerce_catalog_products",
    "mpn",
    product.mpn,
    "manufacturer",
    product.manufacturer,
    ids.catalogProduct
  );
  await readAndValidateSeedQuoteEvents(supabase);
  await guardNaturalKey(supabase, "commerce_rfqs", { external_rfq_id: rfqs[0].externalId }, ids.rfq);
  await guardNaturalKey(supabase, "commerce_rfq_items", { rfq_id: ids.rfq, line_number: 1 }, ids.rfqItem);
  await guardNaturalKey(
    supabase,
    "sourcing_requests",
    { commerce_rfq_item_id: ids.rfqItem },
    ids.sourcingRequest
  );
  await guardNaturalKey(
    supabase,
    "commercial_price_approvals",
    { normalized_mpn: product.normalizedMpn, status: "active" },
    ids.priceApproval
  );
  await guardNaturalKey(supabase, "commerce_quote_items", { quote_id: ids.quote, line_number: 1 }, ids.quoteItem);
}

async function listAuthUsers(supabase: SupabaseClient) {
  const users: DemoAuthUser[] = [];
  const perPage = 1000;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    users.push(...data.users.map(({ id, email, user_metadata }) => ({ id, email, user_metadata })));
    if (data.users.length < perPage) return users;
  }
  throw new Error("DEMO_SEED_AUTH_USER_SCAN_LIMIT_EXCEEDED");
}

function isSeedOwnedAuthUser(user: DemoAuthUser) {
  return user.user_metadata?.quiksol_demo_seed === DEMO_SEED_MARKER && user.user_metadata?.demo === true;
}

export function legacyDemoOwnerInternalEmail() {
  return ["ja", "sonBoss@quiksol.com"].join("").toLowerCase();
}

const LEGACY_PROFILE_REFERENCES = Object.freeze([
  ["admin_email_attachments", "uploaded_by"],
  ["admin_email_messages", "sender_user_id"],
  ["ai_conversations", "user_id"],
  ["ai_messages", "user_id"],
  ["audit_logs", "actor_id"],
  ["business_mpn_summaries", "owner_id"],
  ["business_opportunity_entities", "owner_id"],
  ["business_records", "uploaded_by"],
  ["business_scope_counters", "owner_id"],
  ["business_stock_needs_scopes", "owner_id"],
  ["business_summary_entity_stage", "owner_id"],
  ["business_summary_mpn_stage", "owner_id"],
  ["business_upload_versions", "owner_id"],
  ["chat_attachments", "uploaded_by"],
  ["chat_conversations", "created_by"],
  ["chat_messages", "sender_id"],
  ["client_logs", "user_id"],
  ["client_private_details", "updated_by"],
  ["client_upload_assignments", "assigned_by"],
  ["clients", "created_by"],
  ["clients", "updated_by"],
  ["clients", "assigned_salesperson_id"],
  ["commerce_catalog_products", "created_by"],
  ["commerce_catalog_products", "updated_by"],
  ["commerce_quote_events", "actor_id"],
  ["commerce_quote_shares", "created_by"],
  ["commerce_quotes", "seller_id"],
  ["commerce_rfqs", "assigned_salesperson_id"],
  ["commercial_price_approvals", "approved_by"],
  ["database_backup_manifests", "created_by"],
  ["database_destruction_operations", "created_by"],
  ["database_safety_audit_events", "actor_id"],
  ["email_alert_rules", "created_by"],
  ["employee_compensation", "updated_by"],
  ["import_jobs", "uploaded_by"],
  ["opportunity_finder_audit_events", "actor_user_id"],
  ["opportunity_finder_dataset_snapshots", "created_by"],
  ["opportunity_finder_jobs", "created_by"],
  ["opportunity_finder_manufacturer_aliases", "approved_by"],
  ["opportunity_finder_manufacturer_aliases", "suggested_by"],
  ["opportunity_finder_manufacturer_registry_versions", "approved_by"],
  ["opportunity_finder_manufacturer_registry_versions", "created_by"],
  ["opportunity_finder_manufacturers", "created_by"],
  ["opportunity_finder_part_equivalence_versions", "approved_by"],
  ["opportunity_finder_part_equivalence_versions", "created_by"],
  ["opportunity_finder_part_equivalences", "approved_by"],
  ["opportunity_finder_part_equivalences", "suggested_by"],
  ["opportunity_finder_review_decisions", "reviewer_id"],
  ["opportunity_finder_tenants", "created_by"],
  ["organization_members", "manager_id"],
  ["organization_members", "updated_by"],
  ["security_events", "actor_id"],
  ["sourcing_offer_attachments", "uploaded_by"],
  ["sourcing_offers", "created_by"],
  ["sourcing_offers", "decided_by"],
  ["sourcing_requests", "assigned_to"],
  ["sourcing_requests", "requested_by"],
  ["system_logs", "user_id"],
  ["upload_batches", "uploaded_by"],
  ["user_provisioning_intents", "actor_profile_id"]
] as const);

function isMissingSchemaReference(error: { code?: string } | null) {
  return Boolean(error && ["42P01", "42703", "PGRST204", "PGRST205"].includes(String(error.code)));
}

async function reassignProfileReference(
  supabase: SupabaseClient,
  table: string,
  column: string,
  legacyId: string,
  replacementId: string
) {
  const { error } = await supabase
    .from(table as never)
    .update({ [column]: replacementId } as never)
    .eq(column, legacyId);
  if (error && !isMissingSchemaReference(error)) {
    throw new Error(`DEMO_SEED_LEGACY_REFERENCE_REASSIGN_FAILED: ${table}.${column}: ${error.code ?? "unknown"}`);
  }
}

async function reassignMembershipReference(
  supabase: SupabaseClient,
  table: string,
  scopeColumn: string,
  userColumn: string,
  legacyId: string,
  replacementId: string
) {
  const legacyRows = await supabase
    .from(table as never)
    .select(scopeColumn)
    .eq(userColumn, legacyId);
  if (legacyRows.error) {
    if (isMissingSchemaReference(legacyRows.error)) return;
    throw legacyRows.error;
  }
  for (const rawRow of (legacyRows.data ?? []) as unknown as UnknownRow[]) {
    const scopeId = rawRow[scopeColumn];
    if (typeof scopeId !== "string") throw new Error("DEMO_SEED_LEGACY_MEMBERSHIP_SCOPE_INVALID");
    const replacement = await supabase
      .from(table as never)
      .select(scopeColumn)
      .eq(scopeColumn, scopeId)
      .eq(userColumn, replacementId)
      .maybeSingle();
    if (replacement.error) throw replacement.error;
    const mutation = replacement.data
      ? supabase.from(table as never).delete().eq(scopeColumn, scopeId).eq(userColumn, legacyId)
      : supabase.from(table as never).update({ [userColumn]: replacementId } as never).eq(scopeColumn, scopeId).eq(userColumn, legacyId);
    const { error } = await mutation;
    if (error) throw error;
  }
}

export async function retireLegacyDemoOwner(
  supabase: SupabaseClient,
  replacementId: string
) {
  const email = legacyDemoOwnerInternalEmail();
  const replacementEmail = DEMO_DATA_MANIFEST.people.find((person) => person.key === "demoOwner")?.email;
  if (!replacementEmail) throw new Error("DEMO_SEED_OWNER_MISSING");
  const matches = (await listAuthUsers(supabase)).filter(
    (user) => user.email?.trim().toLowerCase() === email
  );
  if (matches.length === 0) return false;
  if (matches.length !== 1 || !isSeedOwnedAuthUser(matches[0])) {
    throw new Error("DEMO_SEED_LEGACY_OWNER_PROTECTED");
  }
  const legacyId = matches[0].id;
  if (legacyId === replacementId) throw new Error("DEMO_SEED_LEGACY_OWNER_ID_COLLISION");

  const profile = await supabase
    .from("profiles")
    .select("id,email,bio")
    .eq("id", legacyId)
    .eq("bio", DEMO_SEED_MARKER)
    .maybeSingle();
  if (profile.error || !profile.data || profile.data.email?.trim().toLowerCase() !== email) {
    throw profile.error ?? new Error("DEMO_SEED_LEGACY_OWNER_PROFILE_PROTECTED");
  }

  await reassignMembershipReference(supabase, "chat_conversation_members", "conversation_id", "user_id", legacyId, replacementId);
  await reassignMembershipReference(supabase, "opportunity_finder_tenant_memberships", "tenant_id", "user_id", legacyId, replacementId);
  for (const [table, column] of LEGACY_PROFILE_REFERENCES) {
    await reassignProfileReference(supabase, table, column, legacyId, replacementId);
  }

  const tenantRename = await supabase
    .from("opportunity_finder_tenants")
    .update({ display_name: "Electronic Parts Demo workspace" })
    .eq("id", legacyId);
  if (tenantRename.error && !isMissingSchemaReference(tenantRename.error)) throw tenantRename.error;

  for (const [table, column] of [["audit_logs", "actor_email"], ["system_logs", "user_email"]] as const) {
    const result = await supabase
      .from(table as never)
      .update({ [column]: replacementEmail } as never)
      .eq(column, email);
    if (result.error && !isMissingSchemaReference(result.error)) throw result.error;
  }

  const compensation = await supabase.from("employee_compensation").delete().eq("employee_id", legacyId);
  if (compensation.error && !isMissingSchemaReference(compensation.error)) throw compensation.error;
  const organization = await supabase.from("organization_members").delete().eq("profile_id", legacyId);
  if (organization.error && !isMissingSchemaReference(organization.error)) throw organization.error;
  const deletedProfile = await supabase
    .from("profiles")
    .delete()
    .eq("id", legacyId)
    .eq("bio", DEMO_SEED_MARKER)
    .select("id")
    .maybeSingle();
  if (deletedProfile.error || !deletedProfile.data) {
    throw deletedProfile.error ?? new Error("DEMO_SEED_LEGACY_OWNER_PROFILE_DELETE_FAILED");
  }
  const deletedAuth = await supabase.auth.admin.deleteUser(legacyId);
  if (deletedAuth.error) throw deletedAuth.error;
  return true;
}

function parseProvisioningResult(value: unknown, person: DemoPerson): DemoProvisioningResult {
  if (!value || typeof value !== "object") throw new Error("DEMO_SEED_PROVISIONING_RESULT_INVALID");
  const row = value as UnknownRow;
  const state = row.state;
  const intentId = row.intent_id;
  const authUserId = row.auth_user_id;
  const status = row.status;
  const attemptCount = row.attempt_count;
  if (
    !["NEW", "EXISTING_PENDING", "EXISTING_COMPLETED"].includes(String(state)) ||
    typeof intentId !== "string" ||
    !provisioningUuidPattern.test(intentId) ||
    (authUserId !== null &&
      (typeof authUserId !== "string" || !provisioningUuidPattern.test(authUserId))) ||
    row.role !== person.technicalRole ||
    !["pending", "completed"].includes(String(status)) ||
    typeof attemptCount !== "number" ||
    !Number.isInteger(attemptCount) ||
    attemptCount < 1 ||
    (state === "EXISTING_COMPLETED" && (status !== "completed" || authUserId === null)) ||
    (state !== "EXISTING_COMPLETED" && (status !== "pending" || authUserId !== null))
  ) {
    throw new Error("DEMO_SEED_PROVISIONING_RESULT_INVALID");
  }
  return {
    state: state as DemoProvisioningResult["state"],
    intentId,
    authUserId: authUserId as string | null,
    role: person.technicalRole,
    status: status as DemoProvisioningResult["status"],
    attemptCount
  };
}

async function profileForPerson(supabase: SupabaseClient, person: DemoPerson, userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name,role,is_active,department,region,bio,job_title,business_rank,avatar_path")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (
    !data ||
    data.email?.trim().toLowerCase() !== person.email.trim().toLowerCase() ||
    data.role !== person.technicalRole ||
    data.is_active !== true ||
    data.bio !== DEMO_SEED_MARKER
  ) {
    throw new Error(`DEMO_SEED_PROFILE_MISMATCH: ${person.email}`);
  }
  const desired = {
    full_name: person.fullName,
    department: person.department,
    region: person.region,
    job_title: person.title,
    business_rank: person.profileBusinessRank,
    avatar_path: person.avatarPath
  };
  const profileRow = data as UnknownRow;
  if (Object.entries(desired).every(([field, value]) => profileRow[field] === value)) {
    return data as UnknownRow;
  }
  const updated = await supabase
    .from("profiles")
    .update(desired)
    .eq("id", userId)
    .eq("bio", DEMO_SEED_MARKER)
    .eq("role", person.technicalRole)
    .select("id,email,full_name,role,is_active,department,region,bio,job_title,business_rank,avatar_path")
    .maybeSingle();
  if (updated.error || !updated.data ||
      updated.data.email?.trim().toLowerCase() !== person.email.trim().toLowerCase() ||
      !Object.entries(desired).every(([field, value]) => (updated.data as UnknownRow | null)?.[field] === value)) {
    throw updated.error ?? new Error(`DEMO_SEED_PROFILE_RECONCILIATION_FAILED: ${person.email}`);
  }
  return updated.data as UnknownRow;
}

function provisioningArguments(person: DemoPerson) {
  return {
    operation_idempotency_key: person.idempotencyKey,
    requested_email: person.email,
    requested_full_name: person.fullName,
    requested_role: person.technicalRole,
    requested_department: person.department,
    requested_region: person.region,
    requested_is_active: true,
    requested_bio: DEMO_SEED_MARKER,
    requested_job_title: person.title
  };
}

function createDemoUserProvisioningGateway(
  service: SupabaseClient,
  adminActor: SupabaseClient,
  ownerVerifier: SupabaseClient
): DemoUserProvisioningGateway {
  return {
    listAuthUsers: () => listAuthUsers(service),
    async verifyExistingSeedOwnership(person, user) {
      const intentId = user.user_metadata?.quiksol_provisioning_intent_id;
      if (typeof intentId !== "string" || !provisioningUuidPattern.test(intentId)) {
        throw new Error(`DEMO_SEED_EXISTING_AUTH_USER_PROTECTED: ${person.email}`);
      }
      const { data: preview, error: previewError } = await service.rpc(
        "preview_user_provisioning_reconciliation_v1",
        { target_intent_id: intentId }
      );
      const rows = Array.isArray(preview) ? preview : preview ? [preview] : [];
      const evidence = rows.length === 1 && rows[0] && typeof rows[0] === "object"
        ? rows[0] as UnknownRow
        : null;
      const { data: profile, error: profileError } = await service
        .from("profiles")
        .select("id,email,role,is_active,bio")
        .eq("id", user.id)
        .maybeSingle();
      if (
        previewError ||
        profileError ||
        !evidence ||
        evidence.intent_id !== intentId ||
        evidence.technical_auth_user_id !== user.id ||
        evidence.classification !== "COMPLETED_CONSISTENT" ||
        evidence.intent_status !== "completed" ||
        !["USER_METADATA", "BOTH"].includes(String(evidence.locator_channel)) ||
        !profile ||
        profile.id !== user.id ||
        profile.email?.trim().toLowerCase() !== person.email.trim().toLowerCase() ||
        profile.role !== person.technicalRole ||
        profile.is_active !== true ||
        profile.bio !== DEMO_SEED_MARKER
      ) {
        throw new Error(`DEMO_SEED_EXISTING_AUTH_USER_PROTECTED: ${person.email}`);
      }
    },
    async getAuthUserById(userId) {
      const { data, error } = await service.auth.admin.getUserById(userId);
      if (error || !data.user) throw error ?? new Error("DEMO_SEED_AUTH_USER_MISSING");
      return data.user;
    },
    async beginCliProvisioning(person) {
      const { data, error } = await service.rpc(
        "begin_cli_user_provisioning_v2",
        provisioningArguments(person)
      );
      if (error) throw error;
      return parseProvisioningResult(data, person);
    },
    async beginAdminProvisioning(person) {
      const { data, error } = await adminActor.rpc(
        "begin_user_provisioning_v2",
        provisioningArguments(person)
      );
      if (error) throw error;
      return parseProvisioningResult(data, person);
    },
    async createAuthUser(person, password, intentId) {
      return createProvisionedAuthUser(service, {
        email: person.email,
        password,
        user_metadata: {
          full_name: person.fullName,
          quiksol_provisioning_intent_id: intentId,
          quiksol_demo_seed: DEMO_SEED_MARKER,
          demo: true
        }
      });
    },
    async authenticateSeedAdmin(person, password, expectedUserId) {
      const { data, error } = await adminActor.auth.signInWithPassword({
        email: person.email,
        password
      });
      const user = data.user;
      if (
        error ||
        !data.session?.access_token ||
        !user ||
        user.id !== expectedUserId ||
        user.email?.trim().toLowerCase() !== person.email.trim().toLowerCase() ||
        !isSeedOwnedAuthUser(user)
      ) {
        await adminActor.auth.signOut({ scope: "local" }).catch(() => undefined);
        throw new Error("DEMO_SEED_ADMIN_AUTH_FAILED");
      }
    },
    async releaseSeedAdminSession() {
      await adminActor.auth.signOut({ scope: "local" }).catch(() => undefined);
    },
    async verifySeedOwnerLogin(person, password, expectedUserId) {
      try {
        const { data, error } = await ownerVerifier.auth.signInWithPassword({
          email: person.email,
          password
        });
        const user = data.user;
        if (
          error ||
          !data.session?.access_token ||
          !user ||
          user.id !== expectedUserId ||
          user.email?.trim().toLowerCase() !== person.email.trim().toLowerCase() ||
          !isSeedOwnedAuthUser(user)
        ) {
          throw new Error("DEMO_SEED_OWNER_AUTH_FAILED");
        }
      } finally {
        await ownerVerifier.auth.signOut({ scope: "local" }).catch(() => undefined);
      }
    },
    async ensureSeedProfile(person, userId) {
      await profileForPerson(service, person, userId);
    }
  };
}

export async function ensureDemoUsersWithGateway(
  gateway: DemoUserProvisioningGateway,
  password: string,
  ownerPassword: string
) {
  const existingUsers = await gateway.listAuthUsers();
  const usersByEmail = new Map<string, DemoAuthUser>();
  const personIds = {} as PersonIds;

  // Validate the whole Auth namespace before creating the first user, so a
  // protected collision cannot leave a partially provisioned organization.
  for (const person of DEMO_DATA_MANIFEST.people) {
    const normalizedEmail = person.email.trim().toLowerCase();
    const matches = existingUsers.filter((user) => user.email?.trim().toLowerCase() === normalizedEmail);
    if (matches.length > 1) throw new Error(`DEMO_SEED_DUPLICATE_AUTH_EMAIL: ${person.email}`);
    if (matches[0] && !isSeedOwnedAuthUser(matches[0])) {
      throw new Error(`DEMO_SEED_EXISTING_AUTH_USER_PROTECTED: ${person.email}`);
    }
    if (matches[0]) {
      await gateway.verifyExistingSeedOwnership(person, matches[0]);
      usersByEmail.set(normalizedEmail, matches[0]);
    }
  }

  async function ensurePerson(
    person: DemoPerson,
    beginProvisioning: (target: DemoPerson) => Promise<DemoProvisioningResult>,
    authPassword = password,
    reconcileProfile = true
  ) {
    const normalizedEmail = person.email.trim().toLowerCase();
    let user = usersByEmail.get(normalizedEmail);

    if (!user) {
      const provisioning = await beginProvisioning(person);

      if (provisioning.state === "EXISTING_COMPLETED") {
        if (!provisioning.authUserId) throw new Error("DEMO_SEED_COMPLETED_INTENT_WITHOUT_USER");
        user = await gateway.getAuthUserById(provisioning.authUserId);
      } else {
        try {
          user = await gateway.createAuthUser(person, authPassword, provisioning.intentId);
        } catch {
          const recovery = await beginProvisioning(person);
          if (recovery.state !== "EXISTING_COMPLETED" || !recovery.authUserId) {
            throw new Error(`DEMO_SEED_PROVISIONING_RETRYABLE: ${person.email}`);
          }
          user = await gateway.getAuthUserById(recovery.authUserId);
        }
      }
      usersByEmail.set(normalizedEmail, user);
    }

    if (
      user.email?.trim().toLowerCase() !== normalizedEmail ||
      !isSeedOwnedAuthUser(user)
    ) {
      throw new Error(`DEMO_SEED_AUTH_OWNERSHIP_FAILED: ${person.email}`);
    }
    personIds[person.key] = user.id;
    if (reconcileProfile) await gateway.ensureSeedProfile(person, user.id);
  }

  const [olivia, ...team] = DEMO_DATA_MANIFEST.people;
  if (!olivia || olivia.key !== "olivia") throw new Error("DEMO_SEED_BOOTSTRAP_OWNER_MISSING");
  const owner = team.find((person) => person.key === "demoOwner");
  if (!owner) throw new Error("DEMO_SEED_OWNER_MISSING");
  const verifiedOwner = owner;
  const remainingTeam = team.filter((person) => person.key !== "demoOwner");
  await ensurePerson(olivia, (person) => gateway.beginCliProvisioning(person), password, false);

  const needsAdminProvisioning = team.some(
    (person) => !usersByEmail.has(person.email.trim().toLowerCase())
  );

  async function provisionVerifiedTeam() {
    await ensurePerson(
      verifiedOwner,
      (target) => gateway.beginAdminProvisioning(target),
      ownerPassword,
      false
    );
    if (!personIds.demoOwner) throw new Error("DEMO_SEED_OWNER_MISSING");
    await gateway.verifySeedOwnerLogin(verifiedOwner, ownerPassword, personIds.demoOwner);

    // No seed-owned profile or downstream record is reconciled until both
    // privileged demo identities have authenticated successfully.
    await gateway.ensureSeedProfile(olivia, personIds.olivia);
    await gateway.ensureSeedProfile(verifiedOwner, personIds.demoOwner);
    for (const person of remainingTeam) {
      await ensurePerson(
        person,
        (target) => gateway.beginAdminProvisioning(target),
        password
      );
    }
  }

  if (needsAdminProvisioning) {
    try {
      await gateway.authenticateSeedAdmin(olivia, password, personIds.olivia);
      await provisionVerifiedTeam();
    } finally {
      await gateway.releaseSeedAdminSession();
    }
  } else {
    await provisionVerifiedTeam();
  }

  return personIds;
}

async function ensureDemoUsers(
  service: SupabaseClient,
  adminActor: SupabaseClient,
  ownerVerifier: SupabaseClient,
  password: string,
  ownerPassword: string
) {
  return ensureDemoUsersWithGateway(
    createDemoUserProvisioningGateway(service, adminActor, ownerVerifier),
    password,
    ownerPassword
  );
}

function sameOrganizationValues(row: UnknownRow, values: UnknownRow) {
  return [
    "manager_id",
    "business_title",
    "business_rank",
    "department",
    "country",
    "location",
    "responsibilities"
  ].every((field) => (row[field] ?? null) === (values[field] ?? null));
}

export function demoPeopleInHierarchyOrder() {
  const byKey = new Map(DEMO_DATA_MANIFEST.people.map((person) => [person.key, person]));
  const depthByKey = new Map<DemoPerson["key"], number>();

  function depth(person: DemoPerson, lineage = new Set<DemoPerson["key"]>()): number {
    const cached = depthByKey.get(person.key);
    if (cached !== undefined) return cached;
    if (!person.managerKey) {
      depthByKey.set(person.key, 0);
      return 0;
    }
    if (lineage.has(person.key)) throw new Error("DEMO_SEED_ORGANIZATION_CYCLE");
    const manager = byKey.get(person.managerKey);
    if (!manager) throw new Error("DEMO_SEED_ORGANIZATION_MANAGER_MISSING");
    const nextLineage = new Set(lineage).add(person.key);
    const value = depth(manager, nextLineage) + 1;
    depthByKey.set(person.key, value);
    return value;
  }

  return [...DEMO_DATA_MANIFEST.people].sort(
    (left, right) => depth(left) - depth(right)
      || DEMO_DATA_MANIFEST.people.indexOf(left) - DEMO_DATA_MANIFEST.people.indexOf(right)
  );
}

async function ensureOrganization(supabase: SupabaseClient, personIds: PersonIds) {
  const updatedBy = personIds.demoOwner;
  for (const person of demoPeopleInHierarchyOrder()) {
    const values: UnknownRow = {
      manager_id: person.managerKey ? personIds[person.managerKey] : null,
      business_title: person.title,
      business_rank: person.organizationRank,
      department: person.department,
      country: person.country,
      location: person.location,
      responsibilities: person.responsibilities,
      updated_by: updatedBy
    };
    const { data, error } = await supabase
      .from("organization_members")
      .select("profile_id,manager_id,business_title,business_rank,department,country,location,responsibilities,version")
      .eq("profile_id", personIds[person.key])
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const inserted = await supabase
        .from("organization_members")
        .insert({ profile_id: personIds[person.key], ...values, version: 1 });
      if (inserted.error) throw inserted.error;
    } else if (!sameOrganizationValues(data as UnknownRow, values)) {
      const updated = await supabase
        .from("organization_members")
        .update({ ...values, version: Number(data.version) + 1 })
        .eq("profile_id", personIds[person.key])
        .eq("version", data.version);
      if (updated.error) throw updated.error;
    }
  }
}

async function ensureCompensations(supabase: SupabaseClient, personIds: PersonIds) {
  const updatedBy = personIds.demoOwner;
  for (const compensation of DEMO_DATA_MANIFEST.compensations) {
    const employeeId = personIds[compensation.personKey];
    if (!employeeId) throw new Error(`DEMO_SEED_COMPENSATION_EMPLOYEE_MISSING: ${compensation.personKey}`);
    const desired = {
      amount: compensation.amount,
      currency: compensation.currency,
      periodicity: compensation.periodicity,
      updated_by: updatedBy
    };
    const { data, error } = await supabase
      .from("employee_compensation")
      .select("employee_id,amount,currency,periodicity,updated_by")
      .eq("employee_id", employeeId)
      .maybeSingle();
    if (error) throw error;

    const matches = data
      && Number(data.amount) === desired.amount
      && data.currency === desired.currency
      && data.periodicity === desired.periodicity
      && data.updated_by === desired.updated_by;
    if (matches) continue;

    if (!data) {
      const inserted = await supabase
        .from("employee_compensation")
        .insert({ employee_id: employeeId, ...desired, updated_at: new Date().toISOString() });
      if (inserted.error) throw inserted.error;
      continue;
    }

    const updated = await supabase
      .from("employee_compensation")
      .update({ ...desired, updated_at: new Date().toISOString() })
      .eq("employee_id", employeeId)
      .select("employee_id,amount,currency,periodicity,updated_by")
      .maybeSingle();
    if (
      updated.error ||
      !updated.data ||
      Number(updated.data.amount) !== desired.amount ||
      updated.data.currency !== desired.currency ||
      updated.data.periodicity !== desired.periodicity ||
      updated.data.updated_by !== desired.updated_by
    ) {
      throw updated.error ?? new Error(`DEMO_SEED_COMPENSATION_RECONCILIATION_FAILED: ${compensation.personKey}`);
    }
  }
}

async function upsertOrThrow(supabase: SupabaseClient, table: string, row: UnknownRow, onConflict: string) {
  const { error } = await supabase.from(table as never).upsert(row, { onConflict });
  if (error) throw new Error(`DEMO_SEED_UPSERT_FAILED: ${table}: ${error.message}`);
}

export type DemoQuoteEventSeed = Readonly<{
  key: string;
  quoteId: string;
  quoteNumber: string;
  sellerKey: DemoPersonKey;
  eventType: "created" | "sent" | "accepted" | "rejected" | "expired";
  previousStatus: DemoQuoteStatus | null;
  newStatus: DemoQuoteStatus;
  createdAt: string;
}>;

function addMinutesToIso(iso: string, minutes: number) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function buildDemoQuoteEventSeeds(): DemoQuoteEventSeed[] {
  const events: DemoQuoteEventSeed[] = [];
  for (const quote of DEMO_DATA_MANIFEST.quotes) {
    events.push(Object.freeze({
      key: `${quote.number}:created`,
      quoteId: quote.id,
      quoteNumber: quote.number,
      sellerKey: quote.sellerKey,
      eventType: "created",
      previousStatus: null,
      newStatus: "draft",
      createdAt: quote.createdAt
    }));
    if (quote.status === "draft") continue;

    events.push(Object.freeze({
      key: `${quote.number}:sent`,
      quoteId: quote.id,
      quoteNumber: quote.number,
      sellerKey: quote.sellerKey,
      eventType: "sent",
      previousStatus: "draft",
      newStatus: "sent",
      createdAt: quote.sentAt ?? addMinutesToIso(quote.createdAt, 5)
    }));
    if (quote.status === "sent") continue;

    events.push(Object.freeze({
      key: `${quote.number}:${quote.status}`,
      quoteId: quote.id,
      quoteNumber: quote.number,
      sellerKey: quote.sellerKey,
      eventType: quote.status,
      previousStatus: "sent",
      newStatus: quote.status,
      createdAt: addMinutesToIso(quote.createdAt, 10)
    }));
  }
  return events;
}

export function validateExistingDemoQuoteEvents(
  existingEvents: readonly UnknownRow[],
  personIds?: PersonIds
) {
  const quoteById = new Map(DEMO_DATA_MANIFEST.quotes.map((target) => [target.id, target]));
  const expectedEventByKey = new Map(buildDemoQuoteEventSeeds().map((event) => [event.key, event]));
  const existingSeedEventKeys = new Set<string>();

  for (const rawEvent of existingEvents) {
    if (!markerInObject(rawEvent.metadata)) {
      throw new Error(`DEMO_SEED_NON_DEMO_EVENT_COLLISION: ${String(rawEvent.quote_id)}`);
    }
    const targetQuote = quoteById.get(String(rawEvent.quote_id));
    if (!targetQuote) throw new Error("DEMO_SEED_EVENT_QUOTE_MISMATCH");
    const metadata = rawEvent.metadata as UnknownRow;
    const key = typeof metadata.seed_event_key === "string"
      ? metadata.seed_event_key
      : `${targetQuote.number}:${String(rawEvent.event_type)}`;
    const expected = expectedEventByKey.get(key);
    if (
      !expected ||
      existingSeedEventKeys.has(key) ||
      String(rawEvent.quote_id) !== expected.quoteId ||
      rawEvent.event_type !== expected.eventType ||
      (rawEvent.previous_status ?? null) !== expected.previousStatus ||
      rawEvent.new_status !== expected.newStatus ||
      (personIds !== undefined && rawEvent.actor_id !== personIds[expected.sellerKey]) ||
      Date.parse(String(rawEvent.created_at)) !== Date.parse(expected.createdAt)
    ) {
      throw new Error(`DEMO_SEED_IMMUTABLE_EVENT_MISMATCH: ${key}`);
    }
    existingSeedEventKeys.add(key);
  }
  return existingSeedEventKeys;
}

async function readAndValidateSeedQuoteEvents(
  supabase: SupabaseClient,
  personIds?: PersonIds
) {
  const { data, error } = await supabase
    .from("commerce_quote_events")
    .select("quote_id,actor_id,event_type,previous_status,new_status,metadata,created_at")
    .in("quote_id", DEMO_DATA_MANIFEST.quotes.map((target) => target.id));
  if (error) throw error;
  return validateExistingDemoQuoteEvents(
    (data ?? []) as unknown as UnknownRow[],
    personIds
  );
}

export async function seedBusinessData(supabase: SupabaseClient, personIds: PersonIds) {
  const manifest = DEMO_DATA_MANIFEST;
  const { ids, customer, product, supplierOffer, rfq, quote, fixedTimestamp, validUntil } = manifest;
  const maya = personIds.maya;
  const lin = personIds.lin;
  const clientByKey = new Map(manifest.clients.map((target) => [target.key, target]));
  const rfqByKey = new Map(manifest.rfqs.map((target) => [target.key, target]));

  await upsertOrThrow(
    supabase,
    "clients",
    {
      id: ids.client,
      name: customer.name,
      description: customer.description,
      industry: customer.industry,
      region: customer.region,
      logo_path: customer.media.localPath,
      website: null,
      status: "active",
      created_by: maya,
      updated_by: maya,
      external_customer_id: customer.externalId,
      assigned_salesperson_id: maya,
      created_at: fixedTimestamp,
      archived_at: null
    },
    "id"
  );
  await upsertOrThrow(
    supabase,
    "commerce_client_details",
    {
      client_id: ids.client,
      legal_company_name: customer.name,
      contact_name: customer.contactName,
      contact_email: customer.contactEmail,
      country: customer.country,
      city: customer.city,
      preferred_language: customer.language,
      commercial_notes: `${DEMO_SEED_MARKER}: fictitious demo account; no commercial affiliation implied. Never use for real outreach.`,
      created_at: fixedTimestamp
    },
    "client_id"
  );

  for (const target of manifest.clients.slice(1)) {
    const sellerId = personIds[target.sellerKey];
    await upsertOrThrow(
      supabase,
      "clients",
      {
        id: target.id,
        name: target.name,
        description: target.description,
        industry: target.industry,
        region: target.region,
        logo_path: target.media.localPath,
        website: null,
        status: "active",
        created_by: sellerId,
        updated_by: sellerId,
        external_customer_id: target.externalId,
        assigned_salesperson_id: sellerId,
        created_at: fixedTimestamp,
        archived_at: null
      },
      "id"
    );
    await upsertOrThrow(
      supabase,
      "commerce_client_details",
      {
        client_id: target.id,
        legal_company_name: target.name,
        contact_name: target.contactName,
        contact_email: target.contactEmail,
        country: target.country,
        city: target.city,
        preferred_language: target.language,
        commercial_notes: `${DEMO_SEED_MARKER}: fictitious demo account; no commercial affiliation implied. Never use for real outreach.`,
        created_at: fixedTimestamp
      },
      "client_id"
    );
  }
  await upsertOrThrow(
    supabase,
    "commerce_rfqs",
    {
      id: ids.rfq,
      external_rfq_id: rfq.externalId,
      request_fingerprint: rfq.fingerprint,
      client_id: ids.client,
      contact_snapshot: {
        companyOrName: customer.name,
        contact: customer.contactName,
        email: customer.contactEmail,
        phone: "",
        country: customer.country,
        city: customer.city,
        preferredLanguage: customer.language,
        notes: `${DEMO_SEED_MARKER}: fictional demo request.`
      },
      assigned_salesperson_id: maya,
      status: "quoted",
      source: "internal",
      created_at: fixedTimestamp
    },
    "id"
  );
  await upsertOrThrow(
    supabase,
    "commerce_rfq_items",
    {
      id: ids.rfqItem,
      rfq_id: ids.rfq,
      line_number: 1,
      mpn: product.mpn,
      manufacturer: product.manufacturer,
      description: product.description,
      quantity: product.demandQuantity,
      target_price: product.targetUnitPrice,
      created_at: fixedTimestamp
    },
    "id"
  );

  for (const targetRfq of manifest.rfqs.slice(1)) {
    const targetClient = clientByKey.get(targetRfq.clientKey);
    if (!targetClient) throw new Error(`DEMO_SEED_RFQ_CLIENT_MISSING: ${targetRfq.key}`);
    const sellerId = personIds[targetRfq.sellerKey];
    await upsertOrThrow(
      supabase,
      "commerce_rfqs",
      {
        id: targetRfq.id,
        external_rfq_id: targetRfq.externalId,
        request_fingerprint: targetRfq.fingerprint,
        client_id: targetClient.id,
        contact_snapshot: {
          companyOrName: targetClient.name,
          contact: targetClient.contactName,
          email: targetClient.contactEmail,
          phone: "",
          country: targetClient.country,
          city: targetClient.city,
          preferredLanguage: targetClient.language,
          notes: `${DEMO_SEED_MARKER}: fictional demo request.`
        },
        assigned_salesperson_id: sellerId,
        status: "quoted",
        source: "internal",
        created_at: fixedTimestamp
      },
      "id"
    );
    await upsertOrThrow(
      supabase,
      "commerce_rfq_items",
      {
        id: targetRfq.itemId,
        rfq_id: targetRfq.id,
        line_number: 1,
        mpn: targetRfq.mpn,
        manufacturer: targetRfq.manufacturer,
        description: targetRfq.description,
        quantity: targetRfq.quantity,
        target_price: targetRfq.targetPrice,
        created_at: fixedTimestamp
      },
      "id"
    );
  }
  await upsertOrThrow(
    supabase,
    "sourcing_requests",
    {
      id: ids.sourcingRequest,
      commerce_rfq_id: ids.rfq,
      commerce_rfq_item_id: ids.rfqItem,
      source: "commerce_rfq",
      mpn: product.mpn,
      normalized_mpn: product.normalizedMpn,
      manufacturer: product.manufacturer,
      requested_quantity: product.demandQuantity,
      unit_of_measure: "EA",
      customer_context: `${customer.name}; target USD ${product.targetUnitPrice.toFixed(2)} — DEMO`,
      priority: "normal",
      status: "approved",
      notes: `${DEMO_SEED_MARKER}: deterministic fictional demand.`,
      requested_by: maya,
      assigned_to: lin,
      created_at: fixedTimestamp
    },
    "id"
  );
  await upsertOrThrow(
    supabase,
    "sourcing_offers",
    {
      id: ids.sourcingOffer,
      sourcing_request_id: ids.sourcingRequest,
      mpn: product.mpn,
      normalized_mpn: product.normalizedMpn,
      manufacturer: product.manufacturer,
      supplier_name: supplierOffer.supplierName,
      supplier_reference: supplierOffer.reference,
      available_quantity: product.availableQuantity,
      unit_of_measure: "EA",
      raw_unit_cost: supplierOffer.rawUnitCost,
      currency: product.currency,
      lead_time_days: product.leadTimeDays,
      minimum_order_quantity: product.minimumOrderQuantity,
      standard_pack_quantity: product.minimumOrderQuantity,
      condition: supplierOffer.condition,
      country_of_origin: supplierOffer.countryOfOrigin,
      expires_at: validUntil,
      status: "approved",
      notes: `${DEMO_SEED_MARKER}: raw cost is internal and must never reach public Commerce.`,
      provenance: { demo: true, seed_marker: DEMO_SEED_MARKER, source: "deterministic_manifest" },
      created_by: lin,
      decided_by: lin,
      decided_at: fixedTimestamp,
      decision_reason: "Fictional DEMO approval only.",
      created_at: fixedTimestamp
    },
    "id"
  );
  await upsertOrThrow(
    supabase,
    "commercial_price_approvals",
    {
      id: ids.priceApproval,
      sourcing_request_id: ids.sourcingRequest,
      sourcing_offer_id: ids.sourcingOffer,
      mpn: product.mpn,
      normalized_mpn: product.normalizedMpn,
      manufacturer: product.manufacturer,
      authorized_unit_price: product.authorizedUnitPrice,
      currency: product.currency,
      coarse_availability: "available",
      lead_time_days: product.leadTimeDays,
      minimum_order_quantity: product.minimumOrderQuantity,
      status: "active",
      publish_to_catalog: true,
      valid_from: fixedTimestamp,
      valid_until: validUntil,
      version: 1,
      approved_by: lin,
      created_at: fixedTimestamp
    },
    "id"
  );
  await upsertOrThrow(
    supabase,
    "commerce_catalog_products",
    {
      id: ids.catalogProduct,
      source_record_id: null,
      mpn: product.mpn,
      manufacturer: product.manufacturer,
      description: product.description,
      category: "DEMO",
      image_url: null,
      authorized_unit_price: product.authorizedUnitPrice,
      currency: product.currency,
      available_quantity: product.availableQuantity,
      availability_status: "available",
      minimum_order_quantity: product.minimumOrderQuantity,
      lead_time_days: product.leadTimeDays,
      revision: 1,
      is_active: true,
      publish_to_catalog: true,
      commercial_price_approval_id: ids.priceApproval,
      created_by: lin,
      updated_by: lin,
      created_at: fixedTimestamp
    },
    "id"
  );
  await upsertOrThrow(
    supabase,
    "commerce_quotes",
    {
      id: ids.quote,
      quote_number: quote.number,
      rfq_id: ids.rfq,
      client_id: ids.client,
      seller_id: maya,
      status: quote.status,
      currency: product.currency,
      subtotal: quote.subtotal,
      tax_rate: quote.taxRate,
      tax: quote.tax,
      total: quote.total,
      valid_until: manifest.quoteValidUntil,
      notes: `${DEMO_SEED_MARKER}: fictional accepted quote for analytics.`,
      commercial_terms: "DEMO only. No commercial commitment or fulfillment obligation.",
      version: quote.version,
      created_at: fixedTimestamp,
      sent_at: "2026-08-29T12:05:00.000Z"
    },
    "id"
  );
  await upsertOrThrow(
    supabase,
    "commerce_quote_items",
    {
      id: ids.quoteItem,
      quote_id: ids.quote,
      line_number: 1,
      product_id: ids.catalogProduct,
      mpn: product.mpn,
      manufacturer: product.manufacturer,
      description: product.description,
      quantity: quote.quantity,
      authorized_unit_price: product.authorizedUnitPrice,
      seller_unit_price: quote.unitPrice,
      discount_percent: 0,
      currency: product.currency,
      line_total: quote.subtotal,
      availability_revision: 1,
      sourcing_offer_id: ids.sourcingOffer,
      created_at: fixedTimestamp
    },
    "id"
  );

  for (const targetQuote of manifest.quotes.slice(1)) {
    const targetClient = clientByKey.get(targetQuote.clientKey);
    const targetRfq = rfqByKey.get(targetQuote.rfqKey);
    if (!targetClient || !targetRfq) {
      throw new Error(`DEMO_SEED_QUOTE_RELATION_MISSING: ${targetQuote.key}`);
    }
    const sellerId = personIds[targetQuote.sellerKey];
    await upsertOrThrow(
      supabase,
      "commerce_quotes",
      {
        id: targetQuote.id,
        quote_number: targetQuote.number,
        rfq_id: targetRfq.id,
        client_id: targetClient.id,
        seller_id: sellerId,
        status: targetQuote.status,
        currency: "USD",
        subtotal: targetQuote.subtotal,
        tax_rate: targetQuote.taxRate,
        tax: targetQuote.tax,
        total: targetQuote.total,
        valid_until: targetQuote.validUntil,
        notes: `${DEMO_SEED_MARKER}: deterministic fictional quote for employee analytics.`,
        commercial_terms: "DEMO only. No commercial commitment or fulfillment obligation.",
        version: targetQuote.version,
        created_at: targetQuote.createdAt,
        sent_at: targetQuote.sentAt
      },
      "id"
    );
    await upsertOrThrow(
      supabase,
      "commerce_quote_items",
      {
        id: targetQuote.itemId,
        quote_id: targetQuote.id,
        line_number: 1,
        product_id: null,
        mpn: targetRfq.mpn,
        manufacturer: targetRfq.manufacturer,
        description: targetRfq.description,
        quantity: targetQuote.quantity,
        authorized_unit_price: Number((targetQuote.unitPrice * 0.82).toFixed(4)),
        seller_unit_price: targetQuote.unitPrice,
        discount_percent: 0,
        currency: "USD",
        line_total: targetQuote.subtotal,
        availability_revision: 1,
        sourcing_offer_id: null,
        created_at: targetQuote.createdAt
      },
      "id"
    );
  }

  const expectedEvents = buildDemoQuoteEventSeeds();
  const existingSeedEventKeys = await readAndValidateSeedQuoteEvents(supabase, personIds);

  const missingEvents = expectedEvents.filter((event) => !existingSeedEventKeys.has(event.key));
  if (missingEvents.length) {
    const { error } = await supabase.from("commerce_quote_events").insert(
      missingEvents.map((event) => ({
        quote_id: event.quoteId,
        actor_id: personIds[event.sellerKey],
        event_type: event.eventType,
        previous_status: event.previousStatus,
        new_status: event.newStatus,
        created_at: event.createdAt,
        metadata: {
          demo: true,
          seed_marker: DEMO_SEED_MARKER,
          deterministic: true,
          seed_event_key: event.key,
          quote_number: event.quoteNumber
        }
      }))
    );
    if (error) throw error;
  }
}

export async function applyDemoSeed(
  service: SupabaseClient,
  adminActor: SupabaseClient,
  ownerVerifier: SupabaseClient,
  password: string,
  ownerPassword: string
) {
  validateDemoManifest();
  await schemaPreflight(service);
  await collisionPreflight(service);
  const personIds = await ensureDemoUsers(service, adminActor, ownerVerifier, password, ownerPassword);
  await ensureOrganization(service, personIds);
  await ensureCompensations(service, personIds);
  await seedBusinessData(service, personIds);
  const legacyOwnerRetired = await retireLegacyDemoOwner(service, personIds.demoOwner);
  return {
    marker: DEMO_SEED_MARKER,
    authUsers: DEMO_DATA_MANIFEST.people.length,
    visibleEmployees: DEMO_DATA_MANIFEST.visibleEmployees.length,
    ownerAdmin: DEMO_DATA_MANIFEST.ownerAdmin.email,
    employeePhotos: DEMO_DATA_MANIFEST.visibleEmployees.filter((person) => Boolean(person.avatarPath)).length,
    clients: DEMO_DATA_MANIFEST.clients.length,
    companyPhotos: DEMO_DATA_MANIFEST.clients.length,
    rfqs: DEMO_DATA_MANIFEST.rfqs.length,
    quotes: DEMO_DATA_MANIFEST.quotes.length,
    quoteEvents: buildDemoQuoteEventSeeds().length,
    compensations: DEMO_DATA_MANIFEST.compensations.length,
    ownerLoginValidated: true,
    legacyOwnerRetired,
    expectedMetrics: DEMO_DATA_MANIFEST.expectedMetrics
  };
}

async function main() {
  const options = parseDemoSeedArgs(process.argv.slice(2));
  if (options.mode === "dry-run") {
    console.log(JSON.stringify(buildDemoDryRunPlan(), null, 2));
    return;
  }

  loadEnvFile(".env.local");
  loadEnvFile(".env");
  const linkedRefPath = path.resolve(process.cwd(), "supabase/.temp/project-ref");
  if (!fs.existsSync(linkedRefPath)) throw new Error("DEMO_SEED_LINKED_PROJECT_REF_REQUIRED");
  validateLinkedDemoProjectRef(fs.readFileSync(linkedRefPath, "utf8"));
  const { supabaseUrl, serviceRoleKey, publishableKey } = serviceConfiguration();
  const { password, ownerPassword, projectRef } = validateDemoApplyGuards(options, process.env, supabaseUrl);
  const service = createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());
  const adminActor = createClient(supabaseUrl, publishableKey, serverSupabaseClientOptions());
  const ownerVerifier = createClient(supabaseUrl, publishableKey, serverSupabaseClientOptions());
  console.log(`Applying ${DEMO_SEED_MARKER} to explicitly allowlisted project ${projectRef}.`);
  const result = await applyDemoSeed(service, adminActor, ownerVerifier, password, ownerPassword);
  console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
}

async function runCli() {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`DEMO_SEED_FAILED: ${message}`);
    process.exitCode = 1;
  } finally {
    delete process.env[DEMO_USER_PASSWORD_ENV];
    delete process.env[DEMO_OWNER_PASSWORD_ENV];
  }
}

const directExecutionPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directExecutionPath === fileURLToPath(import.meta.url)) void runCli();
