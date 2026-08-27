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

export type ProvisioningGateway = {
  createProvisioningIntent(target: AdminTarget): Promise<string>;
  createUser(target: AdminTarget, password: string, intentId: string): Promise<SafeAuthUser>;
  getProfile(userId: string): Promise<SafeProfileMetadata | null>;
  listUsers(page: number, perPage: number): Promise<SafeAuthUser[]>;
  updateExistingUser(
    userId: string,
    target: AdminTarget,
    password?: string
  ): Promise<SafeAuthUser>;
  upsertProfile(user: SafeAuthUser, target: AdminTarget): Promise<void>;
};

type ExecutionDependencies = {
  createGateway(): ProvisioningGateway;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  supabaseUrl: string;
};

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
  })
]);

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
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

  return { mode, projectRef, rotatePassword, targetEmail };
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

  const gateway = dependencies.createGateway();
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

  if (existingUser) {
    // R8.4 legacy compatibility only: reconciling a pre-existing Auth user is
    // not a new-user lifecycle and still repairs/upserts its existing Profile.
    const rotationSecret = options.rotatePassword
      ? requireTemporarySecret(env, ADMIN_ROTATION_PASSWORD_ENV)
      : undefined;
    const updatedUser = await providerCall("AUTH_UPDATE_FAILED", env, () =>
      gateway.updateExistingUser(existingUser.id, target, rotationSecret)
    );
    await providerCall("PROFILE_UPSERT_FAILED", env, () =>
      gateway.upsertProfile(updatedUser, target)
    );
    log(
      `completed: target=${target.email} action=${options.rotatePassword ? "profile-updated-password-rotated" : "profile-updated-password-preserved"}`
    );
    return {
      action: options.rotatePassword ? ("rotated" as const) : ("updated" as const),
      changed: true,
      target,
      userId: updatedUser.id
    };
  }

  if (options.rotatePassword) {
    throw new Error("ROTATION_TARGET_MISSING: rotation is only valid for an existing Auth user.");
  }

  const creationSecret = requireTemporarySecret(env, ADMIN_PROVISIONING_PASSWORD_ENV);
  const intentId = await providerCall("INTENT_CREATE_FAILED", env, () =>
    gateway.createProvisioningIntent(target)
  );
  const createdUser = await providerCall("AUTH_CREATE_FAILED", env, () =>
    gateway.createUser(target, creationSecret, intentId)
  );
  log(`completed: target=${target.email} action=user-created-profile-finalized`);
  return {
    action: "created" as const,
    changed: true,
    target,
    userId: createdUser.id
  };
}

function loadEnvFile(fileName: string) {
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

function userMetadata(target: AdminTarget) {
  return {
    full_name: target.fullName,
    role: target.role,
    department: target.department,
    region: target.region
  };
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

    async updateExistingUser(userId, target, password) {
      const attributes: {
        email: string;
        email_confirm: boolean;
        password?: string;
        user_metadata: ReturnType<typeof userMetadata>;
      } = {
        email: target.email,
        email_confirm: true,
        user_metadata: userMetadata(target)
      };
      if (password) attributes.password = password;

      const { data, error } = await supabase.auth.admin.updateUserById(userId, attributes);
      if (error || !data.user) throw error ?? new Error("missing updated Auth user");
      return safeAuthUser(data.user);
    },

    async createProvisioningIntent(target) {
      const { data, error } = await supabase.rpc(
        "create_cli_user_provisioning_intent_v1",
        {
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
      if (typeof data !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data)) {
        throw new Error("missing provisioning intent id");
      }
      return data;
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
    },

    async upsertProfile(user, target) {
      const { error } = await supabase.from("profiles").upsert({
        id: user.id,
        full_name: target.fullName,
        email: target.email,
        role: target.role,
        department: target.department,
        region: target.region,
        is_active: true
      });
      if (error) throw error;
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
