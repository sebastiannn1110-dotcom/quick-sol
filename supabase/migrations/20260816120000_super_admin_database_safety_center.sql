begin;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'manager', 'employee', 'super_admin_dev')) not valid;
alter table public.profiles validate constraint profiles_role_check;

create or replace function public.is_super_admin_dev()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and role = 'super_admin_dev'
  );
$$;

revoke all on function public.is_super_admin_dev() from public;
grant execute on function public.is_super_admin_dev() to authenticated;

create table public.database_safety_state (
  singleton boolean primary key default true check (singleton),
  data_version bigint not null default 1 check (data_version > 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.database_safety_state (singleton, data_version)
values (true, 1)
on conflict (singleton) do nothing;

create table public.database_backup_manifests (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  downloaded_at timestamptz,
  file_name text not null check (file_name ~ '^backup-respaldo-base-datos-general-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.dump$'),
  format text not null check (format = 'postgres-custom'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  table_count integer not null check (table_count > 0),
  database_project text not null,
  schema_version text not null,
  migration_version text not null,
  data_version bigint not null,
  restore_list_verified boolean not null default false,
  storage_files_included boolean not null default false check (storage_files_included = false),
  status text not null default 'verified' check (status in ('verified', 'invalid', 'expired')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create table public.database_destruction_operations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  backup_manifest_id uuid not null references public.database_backup_manifests(id) on delete restrict,
  status text not null check (status in ('pending', 'backup_verified', 'armed', 'executing', 'completed', 'failed', 'cancelled')),
  action text not null default 'delete_business_information' check (action = 'delete_business_information'),
  challenge_hash text not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_expires_at timestamptz not null,
  challenge_used_at timestamptz,
  session_binding_hash text not null check (session_binding_hash ~ '^[0-9a-f]{64}$'),
  not_before timestamptz not null,
  reauthenticated_at timestamptz not null,
  backup_sha256 text not null check (backup_sha256 ~ '^[0-9a-f]{64}$'),
  data_version bigint not null,
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  counts_before jsonb,
  counts_after jsonb,
  affected_tables text[],
  result jsonb,
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  armed_at timestamptz,
  executing_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz
);

create unique index database_destruction_one_active_uidx
  on public.database_destruction_operations(created_by)
  where status in ('pending', 'backup_verified', 'armed', 'executing');

create table public.database_safety_audit_events (
  id bigint generated always as identity primary key,
  operation_id uuid references public.database_destruction_operations(id) on delete restrict,
  backup_manifest_id uuid references public.database_backup_manifests(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  event_type text not null,
  status text not null,
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  table_counts jsonb,
  affected_tables text[],
  safe_error_code text,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.database_safety_state enable row level security;
alter table public.database_safety_state force row level security;
alter table public.database_backup_manifests enable row level security;
alter table public.database_backup_manifests force row level security;
alter table public.database_destruction_operations enable row level security;
alter table public.database_destruction_operations force row level security;
alter table public.database_safety_audit_events enable row level security;
alter table public.database_safety_audit_events force row level security;

create policy database_safety_state_super_admin_read
  on public.database_safety_state for select to authenticated
  using (public.is_super_admin_dev());
create policy database_backup_manifests_super_admin_read
  on public.database_backup_manifests for select to authenticated
  using (public.is_super_admin_dev() and created_by = auth.uid());
create policy database_destruction_operations_super_admin_read
  on public.database_destruction_operations for select to authenticated
  using (public.is_super_admin_dev() and created_by = auth.uid());
create policy database_safety_audit_events_super_admin_read
  on public.database_safety_audit_events for select to authenticated
  using (public.is_super_admin_dev());

revoke all on public.database_safety_state from anon, authenticated;
revoke all on public.database_backup_manifests from anon, authenticated;
revoke all on public.database_destruction_operations from anon, authenticated;
revoke all on public.database_safety_audit_events from anon, authenticated;
grant select on public.database_safety_state to authenticated;
grant select on public.database_backup_manifests to authenticated;
grant select on public.database_destruction_operations to authenticated;
grant select on public.database_safety_audit_events to authenticated;

create or replace function public.database_safety_table_catalog()
returns table (
  schema_name text,
  table_name text,
  category text,
  planned_action text,
  delete_order integer,
  reason text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select * from (values
    ('public','admin_email_attachments','BUSINESS_DATA','DELETE',10,'Business email attachment metadata.'),
    ('public','admin_email_messages','BUSINESS_DATA','DELETE',20,'Business email messages.'),
    ('public','ai_messages','BUSINESS_DATA','DELETE',10,'AI conversation content.'),
    ('public','ai_conversations','BUSINESS_DATA','DELETE',20,'AI conversation containers.'),
    ('public','chat_attachments','BUSINESS_DATA','DELETE',10,'Chat attachment metadata.'),
    ('public','chat_messages','BUSINESS_DATA','DELETE',20,'Business chat content.'),
    ('public','chat_conversation_members','BUSINESS_DATA','DELETE',30,'Conversation membership data.'),
    ('public','chat_conversations','BUSINESS_DATA','DELETE',40,'Business conversation containers.'),
    ('public','email_notification_events','OPERATIONAL_DATA','DELETE',10,'Email delivery events.'),
    ('public','email_alert_rules','OPERATIONAL_DATA','DELETE',20,'Business notification rules and recipients.'),
    ('public','opportunity_finder_output_items','BUSINESS_DATA','DELETE',10,'Materialized output items.'),
    ('public','opportunity_finder_output_runs','BUSINESS_DATA','DELETE',20,'Materialized output runs.'),
    ('public','opportunity_finder_allocations','BUSINESS_DATA','DELETE',10,'Supply allocations.'),
    ('public','opportunity_finder_result_financials','BUSINESS_DATA','DELETE',10,'Restricted result financials.'),
    ('public','opportunity_finder_result_commercials','BUSINESS_DATA','DELETE',10,'Restricted result commercials.'),
    ('public','opportunity_finder_review_decisions','BUSINESS_DATA','DELETE',10,'Human review decisions.'),
    ('public','opportunity_finder_possible_matches','BUSINESS_DATA','DELETE',20,'Possible matching candidates.'),
    ('public','opportunity_finder_results','BUSINESS_DATA','DELETE',30,'Opportunity results.'),
    ('public','opportunity_finder_dataset_snapshot_rows','BUSINESS_DATA','DELETE',10,'Virtual dataset snapshot rows.'),
    ('public','opportunity_finder_dataset_snapshots','BUSINESS_DATA','DELETE',20,'Virtual dataset snapshots.'),
    ('public','opportunity_finder_demand_part_options','BUSINESS_DATA','DELETE',10,'Demand alternatives.'),
    ('public','opportunity_finder_demand_events','BUSINESS_DATA','DELETE',20,'Demand events.'),
    ('public','opportunity_finder_supply_lots','BUSINESS_DATA','DELETE',20,'Supply lots.'),
    ('public','opportunity_finder_historical_signals','BUSINESS_DATA','DELETE',20,'Historical commercial signals.'),
    ('public','opportunity_finder_rejected_rows','BUSINESS_DATA','DELETE',20,'Rejected row diagnostics.'),
    ('public','opportunity_finder_rows','BUSINESS_DATA','DELETE',30,'Canonical source rows.'),
    ('public','opportunity_finder_audit_events','AUDIT_DATA','DELETE',30,'Opportunity audit data may contain business identifiers.'),
    ('public','opportunity_finder_files','BUSINESS_DATA','DELETE',40,'Opportunity input file metadata.'),
    ('public','opportunity_finder_jobs','BUSINESS_DATA','DELETE',50,'Opportunity processing jobs.'),
    ('public','business_opportunity_entities','BUSINESS_DATA','DELETE',10,'Business entities derived from uploads.'),
    ('public','business_mpn_summaries','BUSINESS_DATA','DELETE',20,'Aggregated business-part summaries.'),
    ('public','client_private_details','BUSINESS_DATA','DELETE',10,'Private client identification.'),
    ('public','client_upload_assignments','BUSINESS_DATA','DELETE',10,'Client-to-upload assignments.'),
    ('public','clients','BUSINESS_DATA','DELETE',20,'Client master data.'),
    ('public','import_job_error_summary','OPERATIONAL_DATA','DELETE',10,'Import warning summaries.'),
    ('public','import_job_errors','OPERATIONAL_DATA','DELETE',10,'Import job errors.'),
    ('public','import_jobs','OPERATIONAL_DATA','DELETE',20,'Import worker jobs.'),
    ('public','import_errors','OPERATIONAL_DATA','DELETE',10,'Import validation errors.'),
    ('public','file_schema_profiles','OPERATIONAL_DATA','DELETE',10,'Detected file schema profiles.'),
    ('public','business_upload_versions','OPERATIONAL_DATA','DELETE',10,'Upload version state.'),
    ('public','business_scope_counters','OPERATIONAL_DATA','DELETE',10,'Business cache counters.'),
    ('public','business_records','BUSINESS_DATA','DELETE',30,'Canonical business records.'),
    ('public','upload_sheets','OPERATIONAL_DATA','DELETE',40,'Upload sheet metadata.'),
    ('public','upload_batches','OPERATIONAL_DATA','DELETE',50,'Upload metadata and lifecycle state.'),
    ('public','password_reset_codes','OPERATIONAL_DATA','DELETE',10,'Ephemeral reset codes.'),
    ('public','api_rate_limits','OPERATIONAL_DATA','DELETE',10,'Ephemeral rate-limit buckets.'),
    ('public','observability_log_outbox','OPERATIONAL_DATA','DELETE',10,'Pending observability queue.'),
    ('public','audit_logs','AUDIT_DATA','DELETE',10,'General audit metadata may reference business entities.'),
    ('public','security_events','AUDIT_DATA','DELETE',10,'Security events outside the safety ledger.'),
    ('public','system_logs','AUDIT_DATA','DELETE',10,'Technical logs may contain correlation metadata.'),
    ('public','client_logs','AUDIT_DATA','DELETE',10,'Browser logs may contain correlation metadata.'),
    ('public','performance_logs','AUDIT_DATA','DELETE',10,'Performance traces may contain correlation metadata.'),
    ('public','profiles','AUTH_IDENTITY','PRESERVE',null,'Authentication profiles, including Super Admin Dev.'),
    ('public','opportunity_finder_tenants','SYSTEM_CONFIG','PRESERVE',null,'Tenant scope configuration.'),
    ('public','opportunity_finder_tenant_memberships','SYSTEM_CONFIG','PRESERVE',null,'Tenant authorization configuration.'),
    ('public','opportunity_finder_manufacturer_registry_versions','SYSTEM_CONFIG','PRESERVE',null,'Approved normalization configuration.'),
    ('public','opportunity_finder_manufacturers','SYSTEM_CONFIG','PRESERVE',null,'Approved manufacturer registry.'),
    ('public','opportunity_finder_manufacturer_aliases','SYSTEM_CONFIG','PRESERVE',null,'Approved manufacturer aliases.'),
    ('public','opportunity_finder_part_equivalence_versions','SYSTEM_CONFIG','PRESERVE',null,'Approved equivalence configuration.'),
    ('public','opportunity_finder_part_equivalences','SYSTEM_CONFIG','PRESERVE',null,'Approved part equivalences.'),
    ('public','database_safety_state','SYSTEM_CONFIG','PRESERVE',null,'Monotonic data watermark.'),
    ('public','database_backup_manifests','AUDIT_DATA','PRESERVE',null,'Backup evidence without backup content.'),
    ('public','database_destruction_operations','AUDIT_DATA','PRESERVE',null,'Idempotency and destruction state.'),
    ('public','database_safety_audit_events','AUDIT_DATA','PRESERVE',null,'Protected safety ledger.'),
    ('auth','users','AUTH_IDENTITY','PRESERVE',null,'Supabase Auth identities are never purged.'),
    ('supabase_migrations','schema_migrations','MIGRATIONS_SCHEMA','PRESERVE',null,'Migration history is never modified.'),
    ('storage','objects','STORAGE_METADATA','PRESERVE',null,'Storage blobs require a separate backup protocol.'),
    ('storage','buckets','STORAGE_METADATA','PRESERVE',null,'Storage configuration is preserved.')
  ) as policy(schema_name, table_name, category, planned_action, delete_order, reason);
$$;

revoke all on function public.database_safety_table_catalog() from public, anon, authenticated;

create or replace function public.touch_database_safety_watermark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.database_safety_state
  set data_version = data_version + 1, updated_at = clock_timestamp()
  where singleton;
  return null;
end;
$$;

do $$
declare
  item record;
begin
  for item in
    select * from public.database_safety_table_catalog()
    where schema_name = 'public'
      and planned_action = 'DELETE'
      and category in ('BUSINESS_DATA', 'OPERATIONAL_DATA')
      and table_name not in ('api_rate_limits', 'password_reset_codes', 'observability_log_outbox')
  loop
    execute format('drop trigger if exists database_safety_watermark on %I.%I', item.schema_name, item.table_name);
    execute format(
      'create trigger database_safety_watermark after insert or update or delete or truncate on %I.%I for each statement execute function public.touch_database_safety_watermark()',
      item.schema_name,
      item.table_name
    );
  end loop;
end;
$$;

create or replace function public.database_safety_counts(action_filter text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  item record;
  row_count bigint;
  result jsonb := '[]'::jsonb;
begin
  for item in
    select * from public.database_safety_table_catalog()
    where action_filter is null or planned_action = action_filter
    order by coalesce(delete_order, 2147483647), schema_name, table_name
  loop
    if to_regclass(format('%I.%I', item.schema_name, item.table_name)) is null then
      row_count := null;
    else
      execute format('select count(*) from %I.%I', item.schema_name, item.table_name) into row_count;
    end if;
    result := result || jsonb_build_array(jsonb_build_object(
      'schema', item.schema_name,
      'table', item.table_name,
      'count', row_count,
      'category', item.category,
      'action', item.planned_action,
      'reason', item.reason
    ));
  end loop;
  return result;
end;
$$;

create or replace function public.database_safety_current_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  current_version bigint;
  migration_version text := 'unknown';
  storage_count bigint := null;
begin
  if not public.is_super_admin_dev() then
    raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501';
  end if;
  select data_version into current_version from public.database_safety_state where singleton;
  begin
    select max(version)::text into migration_version from supabase_migrations.schema_migrations;
  exception when others then
    migration_version := 'unknown';
  end;
  select greatest(c.reltuples, 0)::bigint into storage_count
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects';
  return jsonb_build_object(
    'dataVersion', current_version,
    'schemaVersion', migration_version,
    'migrationVersion', migration_version,
    'tableCount', (select count(*) from public.database_safety_table_catalog() where schema_name = 'public'),
    'storageObjectCount', storage_count,
    'storageFilesIncluded', false,
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'schema', schema_name,
        'table', table_name,
        'count', null,
        'category', category,
        'action', planned_action,
        'reason', reason
      ) order by coalesce(delete_order, 2147483647), schema_name, table_name), '[]'::jsonb)
      from public.database_safety_table_catalog()
    )
  );
end;
$$;

create or replace function public.database_safety_dry_run()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  current_version bigint;
begin
  if not public.is_super_admin_dev() then
    raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501';
  end if;
  select data_version into current_version from public.database_safety_state where singleton;
  return jsonb_build_object(
    'dryRun', true,
    'modifiedRows', 0,
    'dataVersion', current_version,
    'tables', public.database_safety_counts(null)
  );
end;
$$;

create or replace function public.register_database_backup_manifest(
  input_file_name text,
  input_sha256 text,
  input_size_bytes bigint,
  input_table_count integer,
  input_database_project text,
  input_schema_version text,
  input_migration_version text,
  input_data_version bigint,
  input_restore_list_verified boolean
)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  current_version bigint;
  created_manifest public.database_backup_manifests;
begin
  if not public.is_super_admin_dev() then raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501'; end if;
  select data_version into current_version from public.database_safety_state where singleton;
  if current_version <> input_data_version then raise exception 'BACKUP_STALE' using errcode = '55000'; end if;
  if input_size_bytes <= 0 or input_sha256 !~ '^[0-9a-f]{64}$' or not input_restore_list_verified then
    raise exception 'BACKUP_INVALID' using errcode = '22023';
  end if;
  insert into public.database_backup_manifests (
    created_by, expires_at, file_name, format, sha256, size_bytes, table_count,
    database_project, schema_version, migration_version, data_version,
    restore_list_verified, storage_files_included, status
  ) values (
    auth.uid(), clock_timestamp() + interval '30 minutes', input_file_name, 'postgres-custom',
    input_sha256, input_size_bytes, input_table_count, input_database_project,
    input_schema_version, input_migration_version, input_data_version, true, false, 'verified'
  ) returning * into created_manifest;
  insert into public.database_safety_audit_events (
    backup_manifest_id, actor_id, event_type, status
  ) values (created_manifest.id, auth.uid(), 'backup_verified', 'completed');
  return created_manifest;
end;
$$;

create or replace function public.mark_database_backup_downloaded(input_manifest_id uuid, input_sha256 text)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_manifest public.database_backup_manifests;
begin
  if not public.is_super_admin_dev() then raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501'; end if;
  update public.database_backup_manifests
  set downloaded_at = clock_timestamp()
  where id = input_manifest_id
    and created_by = auth.uid()
    and sha256 = input_sha256
    and status = 'verified'
    and restore_list_verified
    and expires_at > clock_timestamp()
  returning * into updated_manifest;
  if updated_manifest.id is null then raise exception 'BACKUP_INVALID' using errcode = '55000'; end if;
  insert into public.database_safety_audit_events (
    backup_manifest_id, actor_id, event_type, status
  ) values (updated_manifest.id, auth.uid(), 'backup_downloaded', 'completed');
  return updated_manifest;
end;
$$;

create or replace function public.arm_database_destruction(
  input_backup_manifest_id uuid,
  input_challenge_hash text,
  input_session_binding_hash text,
  input_ip_hash text default null
)
returns public.database_destruction_operations
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  manifest public.database_backup_manifests;
  current_version bigint;
  current_migration_version text := 'unknown';
  created_operation public.database_destruction_operations;
begin
  if not public.is_super_admin_dev() then raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501'; end if;
  select * into manifest from public.database_backup_manifests
  where id = input_backup_manifest_id and created_by = auth.uid() for update;
  if manifest.id is null or manifest.status <> 'verified' or not manifest.restore_list_verified
     or manifest.downloaded_at is null or manifest.expires_at <= clock_timestamp() then
    raise exception 'BACKUP_NOT_VERIFIED' using errcode = '55000';
  end if;
  select data_version into current_version from public.database_safety_state where singleton;
  if manifest.data_version <> current_version then raise exception 'BACKUP_STALE' using errcode = '55000'; end if;
  begin
    select max(version)::text into current_migration_version from supabase_migrations.schema_migrations;
  exception when others then
    current_migration_version := 'unknown';
  end;
  if manifest.migration_version <> current_migration_version then raise exception 'BACKUP_STALE' using errcode = '55000'; end if;
  if input_challenge_hash !~ '^[0-9a-f]{64}$' or input_session_binding_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'CHALLENGE_INVALID' using errcode = '22023';
  end if;
  update public.database_destruction_operations
  set status = 'cancelled', cancelled_at = clock_timestamp(), failure_code = 'SUPERSEDED'
  where created_by = auth.uid() and status in ('pending', 'backup_verified', 'armed');
  insert into public.database_destruction_operations (
    created_by, backup_manifest_id, status, challenge_hash, challenge_expires_at,
    session_binding_hash, not_before, reauthenticated_at, backup_sha256,
    data_version, ip_hash, armed_at
  ) values (
    auth.uid(), manifest.id, 'armed', input_challenge_hash, clock_timestamp() + interval '5 minutes',
    input_session_binding_hash, clock_timestamp() + interval '30 seconds', clock_timestamp(),
    manifest.sha256, manifest.data_version, input_ip_hash, clock_timestamp()
  ) returning * into created_operation;
  insert into public.database_safety_audit_events (
    operation_id, backup_manifest_id, actor_id, event_type, status, ip_hash
  ) values (created_operation.id, manifest.id, auth.uid(), 'destruction_armed', 'completed', input_ip_hash);
  return created_operation;
end;
$$;

create or replace function public.cancel_database_destruction(input_operation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin_dev() then raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501'; end if;
  update public.database_destruction_operations
  set status = 'cancelled', cancelled_at = clock_timestamp()
  where id = input_operation_id and created_by = auth.uid() and status = 'armed';
  if found then
    insert into public.database_safety_audit_events (
      operation_id, actor_id, event_type, status
    ) values (input_operation_id, auth.uid(), 'destruction_cancelled', 'completed');
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.fail_database_destruction(input_operation_id uuid, input_failure_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin_dev() then raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501'; end if;
  update public.database_destruction_operations
  set status = 'failed', failed_at = clock_timestamp(), failure_code = left(coalesce(input_failure_code, 'DELETE_FAILED'), 120)
  where id = input_operation_id and created_by = auth.uid() and status = 'armed';
  if found then
    insert into public.database_safety_audit_events (
      operation_id, actor_id, event_type, status, safe_error_code
    ) values (input_operation_id, auth.uid(), 'destruction_failed', 'failed', left(coalesce(input_failure_code, 'DELETE_FAILED'), 120));
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.execute_database_business_purge(
  input_operation_id uuid,
  input_challenge_hash text,
  input_session_binding_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  operation public.database_destruction_operations;
  manifest public.database_backup_manifests;
  item record;
  before_counts jsonb;
  after_counts jsonb;
  current_version bigint;
  current_migration_version text := 'unknown';
  affected text[];
  response jsonb;
begin
  if not public.is_super_admin_dev() then raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501'; end if;
  select * into operation from public.database_destruction_operations
  where id = input_operation_id and created_by = auth.uid() for update;
  if operation.id is null then raise exception 'OPERATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if operation.status = 'completed' then return operation.result; end if;
  if operation.status <> 'armed' then raise exception 'OPERATION_NOT_ARMED' using errcode = '55000'; end if;
  if operation.challenge_used_at is not null then raise exception 'CHALLENGE_ALREADY_USED' using errcode = '55000'; end if;
  if operation.challenge_expires_at <= clock_timestamp() then raise exception 'CHALLENGE_EXPIRED' using errcode = '55000'; end if;
  if operation.not_before > clock_timestamp() then raise exception 'COUNTDOWN_ACTIVE' using errcode = '55000'; end if;
  if operation.challenge_hash <> input_challenge_hash then raise exception 'CHALLENGE_INVALID' using errcode = '42501'; end if;
  if operation.session_binding_hash <> input_session_binding_hash then raise exception 'SESSION_CHANGED' using errcode = '42501'; end if;
  select * into manifest from public.database_backup_manifests where id = operation.backup_manifest_id for update;
  select data_version into current_version from public.database_safety_state where singleton;
  if manifest.status <> 'verified' or not manifest.restore_list_verified or manifest.downloaded_at is null
     or manifest.expires_at <= clock_timestamp() then raise exception 'BACKUP_NOT_VERIFIED' using errcode = '55000'; end if;
  if manifest.data_version <> current_version or operation.data_version <> current_version then
    raise exception 'BACKUP_STALE' using errcode = '55000';
  end if;
  begin
    select max(version)::text into current_migration_version from supabase_migrations.schema_migrations;
  exception when others then
    current_migration_version := 'unknown';
  end;
  if manifest.migration_version <> current_migration_version then
    raise exception 'BACKUP_STALE' using errcode = '55000';
  end if;
  -- Freeze writes to every allowlisted table. Existing writers finish first and
  -- move the watermark; new writers wait until this transaction completes.
  for item in
    select * from public.database_safety_table_catalog()
    where schema_name = 'public' and planned_action = 'DELETE'
    order by schema_name, table_name
  loop
    execute format('lock table %I.%I in share row exclusive mode', item.schema_name, item.table_name);
  end loop;
  select data_version into current_version from public.database_safety_state where singleton for update;
  if manifest.data_version <> current_version or operation.data_version <> current_version then
    raise exception 'BACKUP_STALE' using errcode = '55000';
  end if;
  before_counts := public.database_safety_counts('DELETE');
  select array_agg(format('%I.%I', schema_name, table_name) order by delete_order, table_name)
    into affected from public.database_safety_table_catalog() where planned_action = 'DELETE';
  update public.database_destruction_operations
  set status = 'executing', challenge_used_at = clock_timestamp(), executing_at = clock_timestamp(),
      counts_before = before_counts, affected_tables = affected
  where id = operation.id;
  for item in
    select * from public.database_safety_table_catalog()
    where schema_name = 'public' and planned_action = 'DELETE'
    order by delete_order, table_name
  loop
    execute format('delete from %I.%I', item.schema_name, item.table_name);
  end loop;
  after_counts := public.database_safety_counts('DELETE');
  response := jsonb_build_object(
    'operationId', operation.id,
    'status', 'completed',
    'countsBefore', before_counts,
    'countsAfter', after_counts,
    'affectedTables', affected,
    'completedAt', clock_timestamp()
  );
  update public.database_destruction_operations
  set status = 'completed', completed_at = clock_timestamp(), counts_after = after_counts, result = response
  where id = operation.id;
  insert into public.database_safety_audit_events (
    operation_id, backup_manifest_id, actor_id, event_type, status, ip_hash,
    table_counts, affected_tables
  ) values (
    operation.id, manifest.id, auth.uid(), 'business_information_deleted', 'completed',
    operation.ip_hash, before_counts, affected
  );
  return response;
end;
$$;

revoke all on function public.database_safety_counts(text) from public, anon, authenticated;
revoke all on function public.database_safety_current_snapshot() from public, anon;
revoke all on function public.database_safety_dry_run() from public, anon;
revoke all on function public.register_database_backup_manifest(text,text,bigint,integer,text,text,text,bigint,boolean) from public, anon;
revoke all on function public.mark_database_backup_downloaded(uuid,text) from public, anon;
revoke all on function public.arm_database_destruction(uuid,text,text,text) from public, anon;
revoke all on function public.cancel_database_destruction(uuid) from public, anon;
revoke all on function public.fail_database_destruction(uuid,text) from public, anon;
revoke all on function public.execute_database_business_purge(uuid,text,text) from public, anon;

grant execute on function public.database_safety_current_snapshot() to authenticated;
grant execute on function public.database_safety_dry_run() to authenticated;
grant execute on function public.register_database_backup_manifest(text,text,bigint,integer,text,text,text,bigint,boolean) to authenticated;
grant execute on function public.mark_database_backup_downloaded(uuid,text) to authenticated;
grant execute on function public.arm_database_destruction(uuid,text,text,text) to authenticated;
grant execute on function public.cancel_database_destruction(uuid) to authenticated;
grant execute on function public.fail_database_destruction(uuid,text) to authenticated;
grant execute on function public.execute_database_business_purge(uuid,text,text) to authenticated;

commit;
