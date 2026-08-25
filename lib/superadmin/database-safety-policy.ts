export type DatabaseSafetyCategory =
  | "BUSINESS_DATA"
  | "OPERATIONAL_DATA"
  | "AUDIT_DATA"
  | "AUTH_IDENTITY"
  | "MIGRATIONS_SCHEMA"
  | "SYSTEM_CONFIG"
  | "SYSTEM_EPHEMERAL"
  | "STORAGE_METADATA";

export type DatabaseSafetyAction = "DELETE" | "PRESERVE";

export type DatabaseSafetyTablePolicy = {
  schema: string;
  table: string;
  category: DatabaseSafetyCategory;
  action: DatabaseSafetyAction;
  reason: string;
  deleteOrder: number | null;
};

function deleteTable(
  table: string,
  category: Extract<DatabaseSafetyCategory, "BUSINESS_DATA" | "OPERATIONAL_DATA" | "AUDIT_DATA">,
  deleteOrder: number,
  reason: string
): DatabaseSafetyTablePolicy {
  return { schema: "public", table, category, action: "DELETE", reason, deleteOrder };
}

function preserveTable(
  schema: string,
  table: string,
  category: Exclude<DatabaseSafetyCategory, "BUSINESS_DATA" | "OPERATIONAL_DATA">,
  reason: string
): DatabaseSafetyTablePolicy {
  return { schema, table, category, action: "PRESERVE", reason, deleteOrder: null };
}

// This is an explicit allowlist. The order follows foreign-key dependencies from leaves to roots.
export const DATABASE_SAFETY_TABLE_POLICY: readonly DatabaseSafetyTablePolicy[] = [
  deleteTable("import_job_staging_rows", "OPERATIONAL_DATA", 5, "Transient import staging can contain business data."),
  deleteTable("admin_email_attachments", "BUSINESS_DATA", 10, "Business email attachment metadata."),
  deleteTable("admin_email_messages", "BUSINESS_DATA", 20, "Business email messages."),
  deleteTable("ai_messages", "BUSINESS_DATA", 10, "AI conversation content."),
  deleteTable("ai_conversations", "BUSINESS_DATA", 20, "AI conversation containers."),
  deleteTable("chat_attachments", "BUSINESS_DATA", 10, "Chat attachment metadata."),
  deleteTable("chat_messages", "BUSINESS_DATA", 20, "Business chat content."),
  deleteTable("chat_conversation_members", "BUSINESS_DATA", 30, "Conversation membership data."),
  deleteTable("chat_conversations", "BUSINESS_DATA", 40, "Business conversation containers."),
  deleteTable("email_notification_events", "OPERATIONAL_DATA", 10, "Email delivery events."),
  deleteTable("email_alert_rules", "OPERATIONAL_DATA", 20, "Business notification rules and recipients."),
  deleteTable("opportunity_finder_output_items", "BUSINESS_DATA", 10, "Materialized Opportunity Finder output items."),
  deleteTable("opportunity_finder_output_runs", "BUSINESS_DATA", 20, "Materialized Opportunity Finder output runs."),
  deleteTable("opportunity_finder_allocations", "BUSINESS_DATA", 10, "Supply allocations."),
  deleteTable("opportunity_finder_result_financials", "BUSINESS_DATA", 10, "Restricted result financials."),
  deleteTable("opportunity_finder_result_commercials", "BUSINESS_DATA", 10, "Restricted result commercials."),
  deleteTable("opportunity_finder_review_decisions", "BUSINESS_DATA", 10, "Human review decisions."),
  deleteTable("opportunity_finder_possible_matches", "BUSINESS_DATA", 20, "Possible matching candidates."),
  deleteTable("opportunity_finder_results", "BUSINESS_DATA", 30, "Opportunity results."),
  deleteTable("opportunity_finder_dataset_snapshot_rows", "BUSINESS_DATA", 10, "Virtual dataset snapshot rows."),
  deleteTable("opportunity_finder_dataset_snapshots", "BUSINESS_DATA", 20, "Virtual dataset snapshots."),
  deleteTable("opportunity_finder_demand_part_options", "BUSINESS_DATA", 10, "Demand alternatives."),
  deleteTable("opportunity_finder_demand_events", "BUSINESS_DATA", 20, "Demand events."),
  deleteTable("opportunity_finder_supply_lots", "BUSINESS_DATA", 20, "Supply lots."),
  deleteTable("opportunity_finder_historical_signals", "BUSINESS_DATA", 20, "Historical commercial signals."),
  deleteTable("opportunity_finder_rejected_rows", "BUSINESS_DATA", 20, "Rejected source-row diagnostics."),
  deleteTable("opportunity_finder_rows", "BUSINESS_DATA", 30, "Canonical source rows."),
  deleteTable("opportunity_finder_audit_events", "AUDIT_DATA", 30, "Opportunity-specific audit events may contain business identifiers."),
  deleteTable("opportunity_finder_files", "BUSINESS_DATA", 40, "Opportunity input file metadata."),
  deleteTable("opportunity_finder_jobs", "BUSINESS_DATA", 50, "Opportunity processing jobs."),
  deleteTable("business_summary_mpn_stage", "BUSINESS_DATA", 5, "Version-fenced staged MPN summary aggregates."),
  deleteTable("business_summary_entity_stage", "BUSINESS_DATA", 5, "Version-fenced staged opportunity entities."),
  deleteTable("business_opportunity_entities", "BUSINESS_DATA", 10, "Business entities derived from uploads."),
  deleteTable("business_mpn_summaries", "BUSINESS_DATA", 20, "Aggregated business-part summaries."),
  deleteTable("client_private_details", "BUSINESS_DATA", 10, "Private client identification."),
  deleteTable("client_upload_assignments", "BUSINESS_DATA", 10, "Client-to-upload assignments."),
  deleteTable("clients", "BUSINESS_DATA", 20, "Client master data."),
  deleteTable("import_job_error_summary", "OPERATIONAL_DATA", 10, "Import warning summaries."),
  deleteTable("import_job_errors", "OPERATIONAL_DATA", 10, "Import job errors."),
  deleteTable("import_jobs", "OPERATIONAL_DATA", 20, "Import worker jobs."),
  deleteTable("import_errors", "OPERATIONAL_DATA", 10, "Import validation errors."),
  deleteTable("file_schema_profiles", "OPERATIONAL_DATA", 10, "Detected file schema profiles."),
  deleteTable("business_upload_versions", "OPERATIONAL_DATA", 10, "Upload version state."),
  deleteTable("business_scope_counters", "OPERATIONAL_DATA", 10, "Business cache counters."),
  deleteTable("business_records", "BUSINESS_DATA", 30, "Canonical business records."),
  deleteTable("upload_sheets", "OPERATIONAL_DATA", 40, "Upload sheet metadata."),
  deleteTable("upload_batches", "OPERATIONAL_DATA", 50, "Upload metadata and lifecycle state."),
  preserveTable("public", "profiles", "AUTH_IDENTITY", "Profiles are required to preserve authentication identities, including Super Admin Dev."),
  preserveTable("public", "opportunity_finder_tenants", "SYSTEM_CONFIG", "Tenant scope configuration required for restart."),
  preserveTable("public", "opportunity_finder_tenant_memberships", "SYSTEM_CONFIG", "Tenant authorization configuration required for restart."),
  preserveTable("public", "opportunity_finder_manufacturer_registry_versions", "SYSTEM_CONFIG", "Approved normalization configuration."),
  preserveTable("public", "opportunity_finder_manufacturers", "SYSTEM_CONFIG", "Approved manufacturer registry."),
  preserveTable("public", "opportunity_finder_manufacturer_aliases", "SYSTEM_CONFIG", "Approved manufacturer aliases."),
  preserveTable("public", "opportunity_finder_part_equivalence_versions", "SYSTEM_CONFIG", "Approved equivalence configuration."),
  preserveTable("public", "opportunity_finder_part_equivalences", "SYSTEM_CONFIG", "Approved part equivalences."),
  preserveTable("public", "database_safety_state", "SYSTEM_CONFIG", "Monotonic data watermark."),
  preserveTable("public", "database_backup_manifests", "AUDIT_DATA", "Backup evidence without backup content or secrets."),
  preserveTable("public", "database_destruction_operations", "AUDIT_DATA", "Idempotency and destruction audit state."),
  preserveTable("public", "database_safety_audit_events", "AUDIT_DATA", "Protected append-only safety ledger."),
  preserveTable("public", "password_reset_codes", "SYSTEM_EPHEMERAL", "Authentication recovery state is outside business-data purge scope."),
  preserveTable("public", "api_rate_limits", "SYSTEM_EPHEMERAL", "Security rate-limit state must not invalidate business backups."),
  preserveTable("public", "observability_log_outbox", "SYSTEM_EPHEMERAL", "Observability delivery state is preserved and does not stale business backups."),
  preserveTable("public", "audit_logs", "AUDIT_DATA", "General audit evidence is preserved."),
  preserveTable("public", "security_events", "AUDIT_DATA", "Security evidence is preserved."),
  preserveTable("public", "system_logs", "AUDIT_DATA", "System observability is preserved."),
  preserveTable("public", "client_logs", "AUDIT_DATA", "Client observability is preserved."),
  preserveTable("public", "performance_logs", "AUDIT_DATA", "Performance evidence is preserved."),
  preserveTable("public", "worker_runtime_heartbeats", "SYSTEM_EPHEMERAL", "Worker liveness contains no business payload and is preserved."),
  preserveTable("auth", "users", "AUTH_IDENTITY", "Supabase Auth identities are never part of the purge allowlist."),
  preserveTable("supabase_migrations", "schema_migrations", "MIGRATIONS_SCHEMA", "Migration history is never modified."),
  preserveTable("storage", "objects", "STORAGE_METADATA", "Storage metadata and physical blobs require a separate backup protocol."),
  preserveTable("storage", "buckets", "STORAGE_METADATA", "Storage configuration is preserved.")
] as const;

export const DATABASE_SAFETY_DELETE_TABLES = DATABASE_SAFETY_TABLE_POLICY
  .filter((entry) => entry.action === "DELETE")
  .sort((left, right) => (left.deleteOrder ?? 0) - (right.deleteOrder ?? 0));

export const DATABASE_SAFETY_PROTECTED_TABLES = DATABASE_SAFETY_TABLE_POLICY
  .filter((entry) => entry.action === "PRESERVE");

export const DATABASE_DESTRUCTION_PHRASE = "ELIMINAR INFORMACION QUIKSOL";
export const DATABASE_SAFETY_CATALOG_VERSION = "20260825120000-r7-v1";
export const DATABASE_BACKUP_FORMAT = "quiksol-safety-bundle-v2";
export const DATABASE_BACKUP_MAX_AGE_MS = 30 * 60 * 1000;
export const DATABASE_DESTRUCTION_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const DATABASE_DESTRUCTION_COUNTDOWN_MS = 30 * 1000;

export type DatabaseSafetyStorageAction = "BUSINESS_DELETE" | "PRESERVE" | "SYSTEM";

export const DATABASE_SAFETY_STORAGE_POLICY = [
  { bucket: "excel-uploads", action: "BUSINESS_DELETE", reason: "Physical source workbooks are business information." },
  { bucket: "chat-attachments", action: "BUSINESS_DELETE", reason: "Business chat attachments are business information." },
  { bucket: "email-attachments", action: "BUSINESS_DELETE", reason: "Business email attachments are business information." },
  { bucket: "client-assets", action: "BUSINESS_DELETE", reason: "Client assets are business information." },
  { bucket: "opportunity-finder", action: "BUSINESS_DELETE", reason: "Opportunity Finder inputs and outputs are business information." },
  { bucket: "avatars", action: "PRESERVE", reason: "Profile avatars are preserved with authentication identities." }
] as const satisfies readonly { bucket: string; action: DatabaseSafetyStorageAction; reason: string }[];

export const DATABASE_SAFETY_BUSINESS_BUCKETS = DATABASE_SAFETY_STORAGE_POLICY
  .filter((entry) => entry.action === "BUSINESS_DELETE")
  .map((entry) => entry.bucket);

export function databaseSafetyDeleteEnabled() {
  return process.env.DATABASE_SAFETY_DELETE_ENABLED === "true";
}
