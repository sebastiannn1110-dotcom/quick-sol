import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";
import {
  loadEnvFile,
  sanitizeProviderError,
  validateProjectRef
} from "./provision-admin-users";

export type ReconciliationMode = "preview" | "orphans" | "apply";

export type ReconciliationOptions = {
  mode: ReconciliationMode;
  projectRef: string;
  intentId?: string;
  actorProfileId?: string;
  reason?: string;
};

export type ReconciliationPreviewRow = {
  intent_id: string;
  technical_auth_user_id: string | null;
  classification: string;
  locator_channel: string;
  intent_status: string;
  created_at: string;
  completed_at: string | null;
};

export type OrphanPreviewRow = {
  technical_auth_user_id: string;
  classification: "HISTORICAL_AUTH_NO_PROFILE_NO_INTENT";
  created_at: string;
};

export type ReconciliationGateway = {
  preview(intentId?: string): Promise<ReconciliationPreviewRow[]>;
  previewOrphans(): Promise<OrphanPreviewRow[]>;
  apply(intentId: string, actorProfileId: string, reason: string): Promise<Record<string, unknown>>;
};

type ReconciliationDependencies = {
  createGateway(): ReconciliationGateway;
  log(message: string): void;
  supabaseUrl: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function flagValue(args: string[], flagName: string) {
  const prefix = `${flagName}=`;
  const values = args
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length).trim());
  if (values.length > 1) throw new Error(`DUPLICATE_FLAG: ${flagName}`);
  return values[0] || undefined;
}

function requireUuid(value: string | undefined, code: string) {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(code);
  return value.toLowerCase();
}

export function parseReconciliationArgs(args: string[]): ReconciliationOptions {
  const allowedFlags = new Set(["--preview", "--orphans", "--apply"]);
  for (const argument of args) {
    if (
      allowedFlags.has(argument) ||
      argument.startsWith("--project-ref=") ||
      argument.startsWith("--intent-id=") ||
      argument.startsWith("--actor-profile-id=") ||
      argument.startsWith("--reason=")
    ) {
      continue;
    }
    throw new Error(`UNKNOWN_FLAG: ${argument.split("=", 1)[0]}`);
  }

  const selectedModes = ["--preview", "--orphans", "--apply"].filter((flag) =>
    args.includes(flag)
  );
  if (selectedModes.length > 1) throw new Error("CONFLICTING_MODE");

  const mode: ReconciliationMode = args.includes("--apply")
    ? "apply"
    : args.includes("--orphans")
      ? "orphans"
      : "preview";
  const projectRef = flagValue(args, "--project-ref");
  if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef.toLowerCase())) {
    throw new Error("PROJECT_REF_REQUIRED");
  }

  const intentIdValue = flagValue(args, "--intent-id");
  const actorProfileIdValue = flagValue(args, "--actor-profile-id");
  const reasonValue = flagValue(args, "--reason");
  const intentId = intentIdValue
    ? requireUuid(intentIdValue, "INTENT_ID_INVALID")
    : undefined;

  if (mode === "orphans" && (intentId || actorProfileIdValue || reasonValue)) {
    throw new Error("ORPHAN_PREVIEW_FILTER_FORBIDDEN");
  }
  if (mode !== "apply" && (actorProfileIdValue || reasonValue)) {
    throw new Error("APPLY_ARGUMENT_WITHOUT_APPLY");
  }

  if (mode === "apply") {
    const actorProfileId = requireUuid(actorProfileIdValue, "ACTOR_PROFILE_ID_REQUIRED");
    if (!intentId) throw new Error("INTENT_ID_REQUIRED");
    if (!reasonValue || !reasonValue.trim() || reasonValue.trim().length > 500) {
      throw new Error("RECONCILIATION_REASON_REQUIRED");
    }
    return {
      mode,
      projectRef: projectRef.toLowerCase(),
      intentId,
      actorProfileId,
      reason: reasonValue.trim()
    };
  }

  return { mode, projectRef: projectRef.toLowerCase(), intentId };
}

export async function executeReconciliation(
  options: ReconciliationOptions,
  dependencies: ReconciliationDependencies
) {
  validateProjectRef(options.projectRef, dependencies.supabaseUrl);
  const gateway = dependencies.createGateway();

  if (options.mode === "orphans") {
    const rows = await gateway.previewOrphans();
    dependencies.log(JSON.stringify({ mode: "orphans", changed: false, rows }));
    return { mode: "orphans" as const, changed: false, rows };
  }

  if (options.mode === "preview") {
    const rows = await gateway.preview(options.intentId);
    dependencies.log(JSON.stringify({ mode: "preview", changed: false, rows }));
    return { mode: "preview" as const, changed: false, rows };
  }

  const result = await gateway.apply(
    options.intentId!,
    options.actorProfileId!,
    options.reason!
  );
  dependencies.log(JSON.stringify({ mode: "apply", changed: result.state === "RECONCILED", result }));
  return { mode: "apply" as const, changed: result.state === "RECONCILED", result };
}

function createReconciliationGateway(supabase: SupabaseClient): ReconciliationGateway {
  return {
    async preview(intentId) {
      const { data, error } = await supabase.rpc(
        "preview_user_provisioning_reconciliation_v1",
        { target_intent_id: intentId ?? null }
      );
      if (error) throw error;
      return (data ?? []) as ReconciliationPreviewRow[];
    },

    async previewOrphans() {
      const { data, error } = await supabase.rpc("preview_auth_profile_orphans_v1");
      if (error) throw error;
      return (data ?? []) as OrphanPreviewRow[];
    },

    async apply(intentId, actorProfileId, reason) {
      const { data, error } = await supabase.rpc(
        "reconcile_user_provisioning_intent_v1",
        {
          target_intent_id: intentId,
          reconciliation_actor_profile_id: actorProfileId,
          reconciliation_reason: reason
        }
      );
      if (error) throw error;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("RECONCILIATION_RESULT_INVALID");
      }
      return data as Record<string, unknown>;
    }
  };
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

async function main() {
  const options = parseReconciliationArgs(process.argv.slice(2));
  loadEnvFile(".env.local");
  loadEnvFile(".env");
  const { serviceRoleKey, supabaseUrl } = serviceConfiguration();
  const client = createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());
  await executeReconciliation(options, {
    createGateway: () => createReconciliationGateway(client),
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
  }
}

const directExecutionPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directExecutionPath === fileURLToPath(import.meta.url)) void runCli();
