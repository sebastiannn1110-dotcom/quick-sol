import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";

export const ADMIN_PROVISIONING_PASSWORD_ENV = "QUIKSOL_ADMIN_PROVISIONING_PASSWORD";
export const ADMIN_ROTATION_PASSWORD_ENV = "QUIKSOL_ADMIN_ROTATION_PASSWORD";

const TEMPORARY_SECRET_NAMES = [
  ADMIN_PROVISIONING_PASSWORD_ENV,
  ADMIN_ROTATION_PASSWORD_ENV
] as const;

export type AdminTarget = {
  email: string;
  fullName: string;
  department: string;
  region: string;
  role: "admin" | "super_admin_dev";
};

export type ProvisioningMode = "dry-run" | "inspect" | "apply";

export type ProvisioningOptions = {
  mode: ProvisioningMode;
  idempotencyKey?: string;
  projectRef?: string;
  rotatePassword: boolean;
  targetEmail?: string;
};

export type SafeAuthUser = {
  id: string;
  email?: string;
  authActive?: boolean;
  emailConfirmed?: boolean;
};

export type SafeProfileMetadata = {
  id: string;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
};

export type BeginProvisioningResult = {
  state: "NEW" | "EXISTING_PENDING" | "EXISTING_COMPLETED";
  intentId: string;
  authUserId: string | null;
  role: AdminTarget["role"];
  status: "pending" | "completed";
  attemptCount: number;
};

export type ProvisioningGateway = {
  beginProvisioning(target: AdminTarget, idempotencyKey: string): Promise<BeginProvisioningResult>;
  createUser(target: AdminTarget, password: string, intentId: string): Promise<SafeAuthUser>;
  getProfile(userId: string): Promise<SafeProfileMetadata | null>;
  listUsers(page: number, perPage: number): Promise<SafeAuthUser[]>;
  updateExistingUser(userId: string, password: string): Promise<SafeAuthUser>;
};

type ExecutionDependencies = {
  createGateway(): ProvisioningGateway;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  supabaseUrl: string;
};

export type ProvisionedAuthUserInput = {
  email: string;
  password: string;
  user_metadata: Record<string, unknown> & {
    full_name: string;
    quiksol_provisioning_intent_id: string;
  };
};

/** Guarded Auth creation boundary shared by provisioning and demo seeding. */
export async function createProvisionedAuthUser(
  supabase: SupabaseClient,
  input: ProvisionedAuthUserInput
): Promise<User> {
  const { data, error } = await supabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: input.user_metadata
  });
  if (error || !data.user) throw error ?? new Error("missing created Auth user");
  return data.user;
}

export const ADMIN_TARGETS: readonly AdminTarget[] = Object.freeze([
  Object.freeze({
    email: "admin@quiksol.local",
    fullName: "Quiksol Admin",
    department: "Operations",
    region: "Global",
    role: "admin" as const
  }),
  Object.freeze({
    email: "braian@admin.quiksol",
    fullName: "Braian Admin",
    department: "Administration",
    region: "Global",
    role: "admin" as const
  }),
  Object.freeze({
    email: "sebastianssc01@gmail.com",
    fullName: "Super Admin Dev",
    department: "Engineering",
    region: "Global",
    role: "super_admin_dev" as const
  }),
  Object.freeze({
    email: "user1.test.demo.com@demo.invalid",
    fullName: "user1.test.demo.com",
    department: "Administration",
    region: "Global",
    role: "super_admin_dev" as const
  })
]);

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeIdempotencyKey(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    throw new Error(
      "IDEMPOTENCY_KEY_REQUIRED: --idempotency-key=<UUID> is required for user creation."
    );
  }
  if (!uuidPattern.test(normalized)) {
    throw new Error("IDEMPOTENCY_KEY_INVALID: --idempotency-key must be a UUID.");
  }
  return normalized;
}

function flagValue(args: string[], flagName: string) {
  const prefix = `${flagName}=`;
  const values = args
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length).trim());

  if (values.length > 1) throw new Error(`DUPLICATE_FLAG: ${flagName}`);
  return values[0] || undefined;
}

export function parseProvisioningArgs(args: string[]): ProvisioningOptions {
  if (args.some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    throw new Error("CLI_PASSWORD_FORBIDDEN: passwords must only come from a temporary environment variable.");
  }

  const allowedFlags = new Set([
    "--apply",
    "--dry-run",
    "--inspect",
    "--rotate-password"
  ]);
  for (const argument of args) {
    if (
      allowedFlags.has(argument) ||
      argument.startsWith("--idempotency-key=") ||
      argument.startsWith("--target-email=") ||
      argument.startsWith("--project-ref=")
    ) {
      continue;
    }
    throw new Error(`UNKNOWN_FLAG: ${argument.split("=", 1)[0]}`);
  }

  const apply = args.includes("--apply");
  const explicitDryRun = args.includes("--dry-run");
  const inspect = args.includes("--inspect");
  const rawIdempotencyKey = flagValue(args, "--idempotency-key");
  const rotatePassword = args.includes("--rotate-password");
  const targetEmail = flagValue(args, "--target-email");
  const projectRef = flagValue(args, "--project-ref");

  if (apply && (explicitDryRun || inspect)) {
    throw new Error("CONFLICTING_MODE: --apply cannot be combined with --dry-run or --inspect.");
  }
  if (rotatePassword && !apply) {
    throw new Error("ROTATION_REQUIRES_APPLY: use --apply and --rotate-password together.");
  }

  const mode: ProvisioningMode = apply ? "apply" : inspect ? "inspect" : "dry-run";
  if (mode !== "dry-run" && !targetEmail) {
    throw new Error("TARGET_REQUIRED: provide --target-email=<exact allowlisted email>.");
  }
  if (mode !== "dry-run" && !projectRef) {
    throw new Error("PROJECT_REF_REQUIRED: provide --project-ref=<exact Supabase project ref>.");
  }

  const idempotencyKey = rawIdempotencyKey
    ? normalizeIdempotencyKey(rawIdempotencyKey)
    : undefined;
  if (mode === "apply" && !rotatePassword && !idempotencyKey) {
    normalizeIdempotencyKey(undefined);
  }

  return { mode, idempotencyKey, projectRef, rotatePassword, targetEmail };
}

export function resolveAdminTarget(targetEmail: string) {
  const normalizedTarget = normalizeEmail(targetEmail);
  const matches = ADMIN_TARGETS.filter(
    (candidate) => normalizeEmail(candidate.email) === normalizedTarget
  );

  if (matches.length === 0) {
    throw new Error("TARGET_NOT_ALLOWLISTED: the exact target email is not configured for provisioning.");
  }
  if (matches.length !== 1) {
    throw new Error("TARGET_AMBIGUOUS: the exact target must resolve to one configured account.");
  }
  return matches[0];
}

export function projectRefFromSupabaseUrl(supabaseUrl: string) {
  let hostname: string;
  try {
    hostname = new URL(supabaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("SUPABASE_URL_INVALID: NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }

  const match = hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (!match) {
    throw new Error("SUPABASE_PROJECT_REF_UNAVAILABLE: expected a project-ref Supabase URL.");
  }
  return match[1];
}

export function validateProjectRef(expectedProjectRef: string, supabaseUrl: string) {
  const normalizedExpected = expectedProjectRef.trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(normalizedExpected)) {
    throw new Error("PROJECT_REF_INVALID: expected a 20-character Supabase project ref.");
  }

  const actualProjectRef = projectRefFromSupabaseUrl(supabaseUrl);
  if (actualProjectRef !== normalizedExpected) {
    throw new Error("PROJECT_REF_MISMATCH: refusing to operate on a different Supabase project.");
  }
  return actualProjectRef;
}

function sensitiveEnvironmentValues(env: NodeJS.ProcessEnv) {
  const names = [
    ...TEMPORARY_SECRET_NAMES,
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY"
  ];
  return names
    .map((name) => env[name])
    .filter((value): value is string => Boolean(value && value.length >= 4));
}

export function sanitizeProviderError(error: unknown, env: NodeJS.ProcessEnv = process.env) {
  let message = error instanceof Error ? error.message : String(error);

  for (const value of sensitiveEnvironmentValues(env)) {
    message = message.split(value).join("[REDACTED]");
  }

  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b(?:sk-|sb_secret_)[A-Za-z0-9._-]+\b/gi, "[REDACTED_TOKEN]")
    .replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[REDACTED]@")
    .slice(0, 500);
}

async function providerCall<T>(
  action: string,
  env: NodeJS.ProcessEnv,
  operation: () => Promise<T>
) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${action}: ${sanitizeProviderError(error, env)}`);
  }
}

async function findExactUser(
  gateway: ProvisioningGateway,
  targetEmail: string,
  env: NodeJS.ProcessEnv
) {
  const normalizedTarget = normalizeEmail(targetEmail);
  const matches: SafeAuthUser[] = [];
  const perPage = 1000;

  for (let page = 1; ; page += 1) {
    const users = await providerCall("AUTH_LIST_FAILED", env, () =>
      gateway.listUsers(page, perPage)
    );
    matches.push(
      ...users.filter((user) => user.email && normalizeEmail(user.email) === normalizedTarget)
    );
    if (users.length < perPage) break;
  }

  if (matches.length > 1) {
    throw new Error("AUTH_TARGET_AMBIGUOUS: more than one exact Auth user matched the target.");
  }
  return matches[0] ?? null;
}

function requireTemporarySecret(env: NodeJS.ProcessEnv, variableName: string) {
  const value = env[variableName];
  if (!value || !value.trim()) {
    throw new Error(`TEMPORARY_SECRET_REQUIRED: ${variableName} must be supplied by the process environment.`);
  }
  return value;
}

function rotationTargetIsConsistent(
  user: SafeAuthUser,
  profile: SafeProfileMetadata | null,
  target: AdminTarget
) {
  return Boolean(
    profile &&
      profile.id === user.id &&
      user.email &&
      normalizeEmail(user.email) === normalizeEmail(target.email) &&
      profile.email &&
      normalizeEmail(profile.email) === normalizeEmail(target.email) &&
      profile.role === target.role &&
      profile.is_active === true &&
      user.authActive === true &&
      user.emailConfirmed === true
  );
}

export async function executeProvisioning(
  options: ProvisioningOptions,
  dependencies: ExecutionDependencies
) {
  const { env, log } = dependencies;

  if (options.mode === "dry-run") {
    const targets = options.targetEmail
      ? [resolveAdminTarget(options.targetEmail)]
      : ADMIN_TARGETS;
    log("DRY RUN / PREPARED ONLY / NO CHANGES");
    for (const target of targets) {
      log(`prepared: target=${target.email} role=${target.role}`);
    }
    return { action: "dry-run" as const, changed: false };
  }

  const target = resolveAdminTarget(options.targetEmail ?? "");
  const actualProjectRef = validateProjectRef(options.projectRef ?? "", dependencies.supabaseUrl);
  log(`validated: project_ref=${actualProjectRef} target=${target.email}`);

  const idempotencyKey = options.mode === "apply" && !options.rotatePassword
    ? normalizeIdempotencyKey(options.idempotencyKey)
    : undefined;
  const gateway = dependencies.createGateway();

  if (options.mode === "inspect" || options.rotatePassword) {
    const existingUser = await findExactUser(gateway, target.email, env);
    const profile = existingUser
      ? await providerCall("PROFILE_LOOKUP_FAILED", env, () => gateway.getProfile(existingUser.id))
      : null;

    log(
      existingUser
        ? `inspection: target=${target.email} auth_user=yes user_id=${existingUser.id} auth_active=${existingUser.authActive ?? "unknown"} email_confirmed=${existingUser.emailConfirmed ?? "unknown"} profile=${profile ? "yes" : "no"} profile_active=${profile?.is_active ?? "unknown"} role=${profile?.role ?? "unknown"}`
        : `inspection: target=${target.email} auth_user=no profile=not-applicable`
    );

    if (options.mode === "inspect") {
      log("INSPECT ONLY / NO CHANGES");
      return {
        action: "inspect" as const,
        changed: false,
        existingUser,
        profile,
        target
      };
    }

    if (!existingUser) {
      throw new Error("ROTATION_TARGET_MISSING: rotation is only valid for an existing Auth user.");
    }
    if (!rotationTargetIsConsistent(existingUser, profile, target)) {
      throw new Error(
        "ROTATION_RECONCILIATION_REQUIRED: Auth and Profile must be active, confirmed, present, and exactly match the allowlisted target."
      );
    }

    const rotationSecret = requireTemporarySecret(env, ADMIN_ROTATION_PASSWORD_ENV);
    const updatedUser = await providerCall("AUTH_UPDATE_FAILED", env, () =>
      gateway.updateExistingUser(existingUser.id, rotationSecret)
    );
    log(`completed: target=${target.email} action=password-rotated-profile-unchanged`);
    return {
      action: "rotated" as const,
      changed: true,
      target,
      userId: updatedUser.id
    };
  }

  const begin = await providerCall("INTENT_BEGIN_FAILED", env, () =>
    gateway.beginProvisioning(target, idempotencyKey!)
  );
  if (begin.state === "EXISTING_COMPLETED") {
    log(`completed: target=${target.email} action=user-creation-reused`);
    return {
      action: "created" as const,
      changed: false,
      reused: true,
      target,
      userId: begin.authUserId!
    };
  }

  const creationSecret = requireTemporarySecret(env, ADMIN_PROVISIONING_PASSWORD_ENV);
  let createdUser: SafeAuthUser;
  try {
    createdUser = await providerCall("AUTH_CREATE_FAILED", env, () =>
      gateway.createUser(target, creationSecret, begin.intentId)
    );
  } catch (authError) {
    let recovery: BeginProvisioningResult;
    try {
      recovery = await providerCall("INTENT_RECOVERY_FAILED", env, () =>
        gateway.beginProvisioning(target, idempotencyKey!)
      );
    } catch (recoveryError) {
      throw new Error(
        `PROVISIONING_RETRYABLE: Auth result and intent state are ambiguous. auth=${sanitizeProviderError(authError, env)} recovery=${sanitizeProviderError(recoveryError, env)}`
      );
    }

    if (recovery.state === "EXISTING_COMPLETED") {
      log(`completed: target=${target.email} action=user-creation-recovered`);
      return {
        action: "created" as const,
        changed: false,
        recovered: true,
        reused: true,
        target,
        userId: recovery.authUserId!
      };
    }

    throw new Error(
      `PROVISIONING_RETRYABLE: provisioning intent remains pending after Auth error. ${sanitizeProviderError(authError, env)}`
    );
  }
  log(`completed: target=${target.email} action=user-created-profile-finalized`);
  return {
    action: "created" as const,
    changed: true,
    reused: begin.state === "EXISTING_PENDING",
    target,
    userId: createdUser.id
  };
}

export function loadEnvFile(fileName: string) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return;

  const blockedKeys = new Set<string>(TEMPORARY_SECRET_NAMES);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (blockedKeys.has(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function serviceConfiguration() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SERVICE_CONFIGURATION_MISSING: NEXT_PUBLIC_SUPABASE_URL and a server-only Supabase key are required."
    );
  }
  return { serviceRoleKey, supabaseUrl };
}

function safeAuthUser(user: User): SafeAuthUser {
  const bannedUntil = user.banned_until ? Date.parse(user.banned_until) : Number.NaN;
  return {
    id: user.id,
    email: user.email,
    authActive: !Number.isFinite(bannedUntil) || bannedUntil <= Date.now(),
    emailConfirmed: Boolean(user.email_confirmed_at)
  };
}

function parseBeginProvisioningResult(
  data: unknown,
  target: AdminTarget
): BeginProvisioningResult {
  const candidate = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("invalid begin provisioning result");
  }

  const row = candidate as Record<string, unknown>;
  const state = row.state;
  const intentId = row.intent_id;
  const authUserId = row.auth_user_id;
  const role = row.role;
  const status = row.status;
  const attemptCount = row.attempt_count;
  const stateIsValid =
    state === "NEW" || state === "EXISTING_PENDING" || state === "EXISTING_COMPLETED";
  const authUserIdIsValid = authUserId === null || (
    typeof authUserId === "string" && uuidPattern.test(authUserId)
  );

  if (
    !stateIsValid ||
    typeof intentId !== "string" ||
    !uuidPattern.test(intentId) ||
    !authUserIdIsValid ||
    role !== target.role ||
    (status !== "pending" && status !== "completed") ||
    typeof attemptCount !== "number" ||
    !Number.isInteger(attemptCount) ||
    attemptCount < 0
  ) {
    throw new Error("invalid begin provisioning result");
  }

  if (
    (state === "EXISTING_COMPLETED" && (status !== "completed" || authUserId === null)) ||
    (state !== "EXISTING_COMPLETED" && (status !== "pending" || authUserId !== null))
  ) {
    throw new Error("inconsistent begin provisioning result");
  }

  return {
    state,
    intentId,
    authUserId,
    role: target.role,
    status,
    attemptCount
  };
}

function createSupabaseGateway(supabase: SupabaseClient): ProvisioningGateway {
  return {
    async listUsers(page, perPage) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      return data.users.map(safeAuthUser);
    },

    async getProfile(userId) {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,email,role,is_active")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data as SafeProfileMetadata | null;
    },

    async updateExistingUser(userId, password) {
      const { data, error } = await supabase.auth.admin.updateUserById(userId, { password });
      if (error || !data.user) throw error ?? new Error("missing updated Auth user");
      return safeAuthUser(data.user);
    },

    async beginProvisioning(target, idempotencyKey) {
      const { data, error } = await supabase.rpc(
        "begin_cli_user_provisioning_v2",
        {
          operation_idempotency_key: idempotencyKey,
          requested_email: target.email,
          requested_full_name: target.fullName,
          requested_role: target.role,
          requested_department: target.department,
          requested_region: target.region,
          requested_is_active: true,
          requested_bio: null,
          requested_job_title: null
        }
      );
      if (error) throw error;
      return parseBeginProvisioningResult(data, target);
    },

    async createUser(target, password, intentId) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: target.email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: target.fullName,
          quiksol_provisioning_intent_id: intentId
        }
      });
      if (error || !data.user) throw error ?? new Error("missing created Auth user");
      return safeAuthUser(data.user);
    }
  };
}

export function clearTemporaryProvisioningSecrets(env: NodeJS.ProcessEnv) {
  for (const name of TEMPORARY_SECRET_NAMES) delete env[name];
}

async function main() {
  const options = parseProvisioningArgs(process.argv.slice(2));
  if (options.mode === "dry-run") {
    await executeProvisioning(options, {
      createGateway() {
        throw new Error("DRY_RUN_GATEWAY_FORBIDDEN");
      },
      env: process.env,
      log: console.log,
      supabaseUrl: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co"
    });
    return;
  }

  loadEnvFile(".env.local");
  loadEnvFile(".env");
  const { serviceRoleKey, supabaseUrl } = serviceConfiguration();
  const client = createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());

  await executeProvisioning(options, {
    createGateway: () => createSupabaseGateway(client),
    env: process.env,
    log: console.log,
    supabaseUrl
  });
}

async function runCli() {
  try {
    await main();
  } catch (error) {
    console.error(sanitizeProviderError(error, process.env));
    process.exitCode = 1;
  } finally {
    clearTemporaryProvisioningSecrets(process.env);
  }
}

const directExecutionPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directExecutionPath === fileURLToPath(import.meta.url)) void runCli();
