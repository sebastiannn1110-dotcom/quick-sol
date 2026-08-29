import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";
import {
  DEMO_APPLY_CONFIRMATION,
  DEMO_DATA_MANIFEST,
  DEMO_SEED_MARKER,
  validateDemoManifest,
  type DemoPerson
} from "./demo-data-manifest";
import { createProvisionedAuthUser } from "./provision-admin-users";

export const DEMO_SEED_ALLOWED_ENV = "QUIKSOL_DEMO_SEED_ALLOWED";
export const DEMO_PROJECT_REF_ENV = "QUIKSOL_DEMO_PROJECT_REF";
export const DEMO_USER_PASSWORD_ENV = "QUIKSOL_DEMO_USER_PASSWORD";

export type DemoSeedOptions = {
  mode: "dry-run" | "apply";
  confirmation?: string;
  projectRef?: string;
};

type DemoAuthUser = Pick<User, "id" | "email" | "user_metadata">;
type PersonIds = Record<DemoPerson["key"], string>;
type UnknownRow = Record<string, unknown>;

const projectRefPattern = /^[a-z0-9]{20}$/;
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
  if (cliRef !== allowlistedRef || cliRef !== urlRef) {
    throw new Error("DEMO_SEED_PROJECT_REF_MISMATCH");
  }

  return { password: validatePassword(env[DEMO_USER_PASSWORD_ENV]), projectRef: cliRef };
}

export function buildDemoDryRunPlan() {
  const manifest = validateDemoManifest();
  return {
    mode: "dry-run",
    networkAccess: false,
    writes: false,
    marker: manifest.marker,
    authUsers: manifest.people.map(({ email, technicalRole, profileBusinessRank }) => ({
      email,
      technicalRole,
      profileBusinessRank
    })),
    records: {
      customer: manifest.customer.externalId,
      rfq: manifest.rfq.externalId,
      product: manifest.product.mpn,
      quote: manifest.quote.number
    },
    expectedMetrics: manifest.expectedMetrics,
    applyRequirements: [
      "--apply",
      `--confirm=${DEMO_APPLY_CONFIRMATION}`,
      "--project-ref=<20-character-ref>",
      `${DEMO_SEED_ALLOWED_ENV}=true`,
      `${DEMO_PROJECT_REF_ENV}=<same-project-ref>`,
      `${DEMO_USER_PASSWORD_ENV}=<strong-temporary-password>`
    ],
    exclusions: [
      "no existing Auth user updates",
      "no super_admin_dev role grants",
      "no employee compensation",
      "no Opportunity Finder data",
      "no revenue or sales records",
      "no deletes"
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
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL_REQUIRED");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY_REQUIRED");
  return { supabaseUrl, serviceRoleKey };
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
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as UnknownRow).demo === true &&
      (value as UnknownRow).seed_marker === DEMO_SEED_MARKER
  );
}

function markerInField(row: UnknownRow, field: string) {
  return typeof row[field] === "string" && row[field].includes(DEMO_SEED_MARKER);
}

async function guardFixedRow(
  supabase: SupabaseClient,
  table: string,
  idColumn: string,
  expectedId: string,
  ownsRow: (row: UnknownRow) => boolean
) {
  const { data, error } = await supabase
    .from(table as never)
    .select("*")
    .eq(idColumn, expectedId)
    .maybeSingle();
  if (error) throw error;
  if (data && !ownsRow(data as UnknownRow)) {
    throw new Error(`DEMO_SEED_FIXED_ID_COLLISION: ${table}.${idColumn}=${expectedId}`);
  }
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

async function collisionPreflight(supabase: SupabaseClient) {
  const { ids, customer, product, rfq, quote } = DEMO_DATA_MANIFEST;
  await guardFixedRow(supabase, "clients", "id", ids.client, (row) => markerInField(row, "description"));
  await guardFixedRow(supabase, "commerce_client_details", "client_id", ids.client, (row) =>
    markerInField(row, "commercial_notes")
  );
  await guardFixedRow(supabase, "commerce_catalog_products", "id", ids.catalogProduct, (row) =>
    markerInField(row, "description")
  );
  await guardFixedRow(supabase, "commerce_rfqs", "id", ids.rfq, (row) =>
    markerInObject(row.contact_snapshot)
  );
  await guardFixedRow(supabase, "commerce_rfq_items", "id", ids.rfqItem, (row) =>
    markerInField(row, "description")
  );
  await guardFixedRow(supabase, "sourcing_requests", "id", ids.sourcingRequest, (row) =>
    markerInField(row, "notes")
  );
  await guardFixedRow(supabase, "sourcing_offers", "id", ids.sourcingOffer, (row) =>
    markerInObject(row.provenance)
  );
  await guardFixedRow(supabase, "commercial_price_approvals", "id", ids.priceApproval, (row) =>
    row.mpn === product.mpn && String(row.manufacturer ?? "").includes("DEMO")
  );
  await guardFixedRow(supabase, "commerce_quotes", "id", ids.quote, (row) =>
    markerInField(row, "notes")
  );
  await guardFixedRow(supabase, "commerce_quote_items", "id", ids.quoteItem, (row) =>
    markerInField(row, "description")
  );

  await guardNaturalKey(supabase, "clients", { external_customer_id: customer.externalId }, ids.client);
  await guardNaturalKey(supabase, "commerce_rfqs", { external_rfq_id: rfq.externalId }, ids.rfq);
  await guardNaturalKey(supabase, "commerce_rfq_items", { rfq_id: ids.rfq, line_number: 1 }, ids.rfqItem);
  await guardNaturalKey(
    supabase,
    "commerce_catalog_products",
    { mpn: product.mpn, manufacturer: product.manufacturer },
    ids.catalogProduct
  );
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
  await guardNaturalKey(supabase, "commerce_quotes", { quote_number: quote.number }, ids.quote);
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

function parseProvisioningResult(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("DEMO_SEED_PROVISIONING_RESULT_INVALID");
  const row = value as UnknownRow;
  const state = row.state;
  const intentId = row.intent_id;
  const authUserId = row.auth_user_id;
  if (
    !["NEW", "EXISTING_PENDING", "EXISTING_COMPLETED"].includes(String(state)) ||
    typeof intentId !== "string" ||
    (authUserId !== null && typeof authUserId !== "string")
  ) {
    throw new Error("DEMO_SEED_PROVISIONING_RESULT_INVALID");
  }
  return { state: String(state), intentId, authUserId: authUserId as string | null };
}

async function profileForPerson(supabase: SupabaseClient, person: DemoPerson, userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name,role,is_active,department,region,bio,job_title,business_rank")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (
    !data ||
    data.email?.trim().toLowerCase() !== person.email ||
    data.full_name !== person.fullName ||
    data.role !== person.technicalRole ||
    data.is_active !== true ||
    data.department !== person.department ||
    data.region !== person.region ||
    data.bio !== DEMO_SEED_MARKER ||
    data.job_title !== person.title
  ) {
    throw new Error(`DEMO_SEED_PROFILE_MISMATCH: ${person.email}`);
  }
  return data as UnknownRow;
}

async function ensureDemoUsers(supabase: SupabaseClient, password: string) {
  const existingUsers = await listAuthUsers(supabase);
  const personIds = {} as PersonIds;

  // Validate the whole Auth namespace before creating the first user, so a
  // protected collision cannot leave a partially provisioned organization.
  for (const person of DEMO_DATA_MANIFEST.people) {
    const matches = existingUsers.filter((user) => user.email?.trim().toLowerCase() === person.email);
    if (matches.length > 1) throw new Error(`DEMO_SEED_DUPLICATE_AUTH_EMAIL: ${person.email}`);
    if (matches[0] && !isSeedOwnedAuthUser(matches[0])) {
      throw new Error(`DEMO_SEED_EXISTING_AUTH_USER_PROTECTED: ${person.email}`);
    }
  }

  for (const person of DEMO_DATA_MANIFEST.people) {
    const matches = existingUsers.filter((user) => user.email?.trim().toLowerCase() === person.email);
    let user = matches[0];

    if (!user) {
      const { data, error } = await supabase.rpc("begin_cli_user_provisioning_v2", {
        operation_idempotency_key: person.idempotencyKey,
        requested_email: person.email,
        requested_full_name: person.fullName,
        requested_role: person.technicalRole,
        requested_department: person.department,
        requested_region: person.region,
        requested_is_active: true,
        requested_bio: DEMO_SEED_MARKER,
        requested_job_title: person.title
      });
      if (error) throw error;
      const provisioning = parseProvisioningResult(data);

      if (provisioning.state === "EXISTING_COMPLETED") {
        if (!provisioning.authUserId) throw new Error("DEMO_SEED_COMPLETED_INTENT_WITHOUT_USER");
        const result = await supabase.auth.admin.getUserById(provisioning.authUserId);
        if (result.error || !result.data.user) throw result.error ?? new Error("DEMO_SEED_AUTH_USER_MISSING");
        user = result.data.user;
        if (user.email?.trim().toLowerCase() !== person.email || !isSeedOwnedAuthUser(user)) {
          throw new Error(`DEMO_SEED_COMPLETED_INTENT_NOT_OWNED: ${person.email}`);
        }
      } else {
        user = await createProvisionedAuthUser(supabase, {
          email: person.email,
          password,
          user_metadata: {
            full_name: person.fullName,
            quiksol_provisioning_intent_id: provisioning.intentId,
            quiksol_demo_seed: DEMO_SEED_MARKER,
            demo: true
          }
        });
      }
    }

    if (!user || !isSeedOwnedAuthUser(user)) throw new Error(`DEMO_SEED_AUTH_OWNERSHIP_FAILED: ${person.email}`);
    const profile = await profileForPerson(supabase, person, user.id);
    if (profile.business_rank !== person.profileBusinessRank) {
      const { error } = await supabase
        .from("profiles")
        .update({ business_rank: person.profileBusinessRank })
        .eq("id", user.id);
      if (error) throw error;
    }
    personIds[person.key] = user.id;
  }

  return personIds;
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

async function ensureOrganization(supabase: SupabaseClient, personIds: PersonIds) {
  const updatedBy = personIds.olivia;
  for (const person of DEMO_DATA_MANIFEST.people) {
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

async function upsertOrThrow(supabase: SupabaseClient, table: string, row: UnknownRow, onConflict: string) {
  const { error } = await supabase.from(table as never).upsert(row, { onConflict });
  if (error) throw new Error(`DEMO_SEED_UPSERT_FAILED: ${table}: ${error.message}`);
}

async function seedBusinessData(supabase: SupabaseClient, personIds: PersonIds) {
  const manifest = DEMO_DATA_MANIFEST;
  const { ids, customer, product, supplierOffer, rfq, quote, fixedTimestamp, validUntil } = manifest;
  const maya = personIds.maya;
  const lin = personIds.lin;

  await upsertOrThrow(
    supabase,
    "clients",
    {
      id: ids.client,
      name: customer.name,
      description: customer.description,
      industry: customer.industry,
      region: customer.region,
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
      commercial_notes: `${DEMO_SEED_MARKER}: fictional contact; never use for real outreach.`,
      created_at: fixedTimestamp
    },
    "client_id"
  );
  await upsertOrThrow(
    supabase,
    "commerce_rfqs",
    {
      id: ids.rfq,
      external_rfq_id: rfq.externalId,
      request_fingerprint: rfq.fingerprint,
      client_id: ids.client,
      contact_snapshot: {
        demo: true,
        seed_marker: DEMO_SEED_MARKER,
        company_name: customer.name,
        contact_name: customer.contactName,
        contact_email: customer.contactEmail,
        preferred_language: customer.language
      },
      assigned_salesperson_id: maya,
      status: "quoted",
      source: "quiksol-web",
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

  const { data: existingEvents, error: eventReadError } = await supabase
    .from("commerce_quote_events")
    .select("event_type,metadata")
    .eq("quote_id", ids.quote);
  if (eventReadError) throw eventReadError;
  const seededEventTypes = new Set(
    (existingEvents ?? [])
      .filter((event) => markerInObject(event.metadata))
      .map((event) => event.event_type)
  );
  const events = [
    { event_type: "created", previous_status: null, new_status: "draft", created_at: fixedTimestamp },
    {
      event_type: "sent",
      previous_status: "draft",
      new_status: "sent",
      created_at: "2026-08-29T12:05:00.000Z"
    },
    {
      event_type: "accepted",
      previous_status: "sent",
      new_status: "accepted",
      created_at: "2026-08-29T12:10:00.000Z"
    }
  ].filter((event) => !seededEventTypes.has(event.event_type));
  if (events.length) {
    const { error } = await supabase.from("commerce_quote_events").insert(
      events.map((event) => ({
        ...event,
        quote_id: ids.quote,
        actor_id: maya,
        metadata: { demo: true, seed_marker: DEMO_SEED_MARKER, deterministic: true }
      }))
    );
    if (error) throw error;
  }
}

export async function applyDemoSeed(supabase: SupabaseClient, password: string) {
  validateDemoManifest();
  await schemaPreflight(supabase);
  await collisionPreflight(supabase);
  const personIds = await ensureDemoUsers(supabase, password);
  await ensureOrganization(supabase, personIds);
  await seedBusinessData(supabase, personIds);
  return {
    marker: DEMO_SEED_MARKER,
    users: DEMO_DATA_MANIFEST.people.length,
    customer: DEMO_DATA_MANIFEST.customer.externalId,
    rfq: DEMO_DATA_MANIFEST.rfq.externalId,
    quote: DEMO_DATA_MANIFEST.quote.number,
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
  const { supabaseUrl, serviceRoleKey } = serviceConfiguration();
  const { password, projectRef } = validateDemoApplyGuards(options, process.env, supabaseUrl);
  const supabase = createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());
  console.log(`Applying ${DEMO_SEED_MARKER} to explicitly allowlisted project ${projectRef}.`);
  const result = await applyDemoSeed(supabase, password);
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
  }
}

const directExecutionPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directExecutionPath === fileURLToPath(import.meta.url)) void runCli();
