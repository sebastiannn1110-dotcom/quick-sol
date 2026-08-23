begin;

-- Ronda 3: the browser can request a lifecycle but only the backend service
-- role can issue evidence or reach destructive primitives.
alter table public.database_safety_state
  add column if not exists storage_version bigint not null default 1 check (storage_version > 0),
  add column if not exists catalog_version text not null default '20260822140000-r3-v1',
  add column if not exists delete_enabled boolean not null default false;

update public.database_safety_state
set catalog_version = '20260822140000-r3-v1'
where singleton;

alter table public.database_backup_manifests
  drop constraint if exists database_backup_manifests_file_name_check,
  drop constraint if exists database_backup_manifests_format_check,
  drop constraint if exists database_backup_manifests_storage_files_included_check,
  drop constraint if exists database_backup_manifests_status_check;

alter table public.database_backup_manifests
  add constraint database_backup_manifests_file_name_check
    check (file_name ~ '^backup-respaldo-(base-datos-general|seguridad-quiksol)-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.(dump|tar)$'),
  add constraint database_backup_manifests_format_check
    check (format in ('postgres-custom', 'quiksol-safety-bundle-v2')),
  add constraint database_backup_manifests_status_check
    check (status in ('creating', 'created', 'verifying', 'verified', 'failed', 'invalid', 'expired')),
  add column if not exists generated_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists storage_version bigint not null default 1,
  add column if not exists catalog_version text not null default 'legacy',
  add column if not exists schema_inventory_hash text,
  add column if not exists database_sha256 text,
  add column if not exists database_size_bytes bigint,
  add column if not exists restore_verified boolean not null default false,
  add column if not exists storage_manifest_sha256 text,
  add column if not exists storage_object_count bigint not null default 0,
  add column if not exists storage_size_bytes bigint not null default 0,
  add column if not exists storage_object_keys text[] not null default '{}'::text[],
  add column if not exists backup_scope jsonb not null default '{}'::jsonb,
  add column if not exists auth_scope text not null default 'PRESERVED_NOT_INCLUDED',
  add column if not exists evidence_hash text,
  add column if not exists backend_evidence_id uuid not null default gen_random_uuid();

create unique index if not exists database_backup_manifests_backend_evidence_uidx
  on public.database_backup_manifests(backend_evidence_id);

update public.database_backup_manifests
set status = 'invalid',
    metadata = metadata || jsonb_build_object('legacyEvidence', true, 'deleteLocked', true)
where format <> 'quiksol-safety-bundle-v2'
   or not storage_files_included
   or not restore_verified;

alter table public.database_destruction_operations
  drop constraint if exists database_destruction_operations_status_check;

alter table public.database_destruction_operations
  add constraint database_destruction_operations_status_check
    check (status in ('pending', 'backup_verified', 'armed', 'executing', 'database_completed', 'completed', 'failed', 'cancelled')),
  add column if not exists storage_version bigint not null default 1,
  add column if not exists catalog_version text not null default 'legacy',
  add column if not exists schema_inventory_hash text,
  add column if not exists evidence_hash text,
  add column if not exists reauth_expires_at timestamptz,
  add column if not exists storage_status text not null default 'pending'
    check (storage_status in ('pending', 'deleting', 'completed', 'failed', 'not_required')),
  add column if not exists storage_result jsonb;

create unique index if not exists database_destruction_challenge_hash_uidx
  on public.database_destruction_operations(challenge_hash);

alter table public.database_safety_audit_events
  add column if not exists manifest_hash text,
  add column if not exists catalog_version text,
  add column if not exists data_version bigint,
  add column if not exists storage_scope jsonb,
  add column if not exists counts_after jsonb;

revoke all on public.database_safety_state from authenticated;
revoke all on public.database_backup_manifests from authenticated;
revoke all on public.database_destruction_operations from authenticated;
revoke all on public.database_safety_audit_events from authenticated;
grant select, insert, update on public.database_safety_state to service_role;
grant select, insert, update on public.database_backup_manifests to service_role;
grant select, insert, update on public.database_destruction_operations to service_role;
grant select, insert on public.database_safety_audit_events to service_role;

create or replace function public.database_safety_table_catalog_v2()
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
set search_path = pg_catalog, public
as $$
  select
    original.schema_name,
    original.table_name,
    case
      when original.table_name in ('password_reset_codes','api_rate_limits','observability_log_outbox') then 'SYSTEM_EPHEMERAL'
      when original.table_name in ('audit_logs','security_events','system_logs','client_logs','performance_logs') then 'AUDIT_DATA'
      else original.category
    end,
    case
      when original.schema_name = 'public' and original.table_name in (
        'password_reset_codes','api_rate_limits','observability_log_outbox',
        'audit_logs','security_events','system_logs','client_logs','performance_logs'
      ) then 'PRESERVE'
      else original.planned_action
    end,
    case
      when original.schema_name = 'public' and original.table_name in (
        'password_reset_codes','api_rate_limits','observability_log_outbox',
        'audit_logs','security_events','system_logs','client_logs','performance_logs'
      ) then null
      else original.delete_order
    end,
    case
      when original.table_name = 'password_reset_codes' then 'Authentication recovery state is preserved.'
      when original.table_name = 'api_rate_limits' then 'Security rate-limit state is preserved and does not stale business backups.'
      when original.table_name = 'observability_log_outbox' then 'Observability delivery state is preserved.'
      when original.table_name in ('audit_logs','security_events','system_logs','client_logs','performance_logs') then 'Security and observability evidence is preserved.'
      else original.reason
    end
  from public.database_safety_table_catalog() original;
$$;

create or replace function public.database_safety_storage_catalog_v2()
returns table (bucket_id text, planned_action text, reason text)
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  values
    ('excel-uploads','BUSINESS_DELETE','Physical source workbooks are business information.'),
    ('chat-attachments','BUSINESS_DELETE','Business chat attachments are business information.'),
    ('email-attachments','BUSINESS_DELETE','Business email attachments are business information.'),
    ('client-assets','BUSINESS_DELETE','Client assets are business information.'),
    ('opportunity-finder','BUSINESS_DELETE','Opportunity Finder files are business information.'),
    ('avatars','PRESERVE','Profile avatars are preserved with authentication identities.');
$$;

create or replace function public.database_safety_catalog_version_v2()
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$ select '20260822140000-r3-v1'::text $$;

create or replace function public.assert_database_safety_backend_actor_v2(input_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'BACKEND_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if input_actor_id is null or not exists (
    select 1 from public.profiles
    where id = input_actor_id and role = 'super_admin_dev' and is_active
  ) then
    raise exception 'SUPER_ADMIN_DEV_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.database_safety_catalog_preflight_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  unclassified text[];
  missing text[];
  inventory_hash text;
begin
  select coalesce(array_agg(format('%I.%I', actual.schema_name, actual.table_name) order by actual.schema_name, actual.table_name), '{}'::text[])
  into unclassified
  from (
    select n.nspname schema_name, c.relname table_name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
  ) actual
  left join public.database_safety_table_catalog_v2() catalog
    on catalog.schema_name = actual.schema_name and catalog.table_name = actual.table_name
  where catalog.table_name is null;

  select coalesce(array_agg(format('%I.%I', catalog.schema_name, catalog.table_name) order by catalog.schema_name, catalog.table_name), '{}'::text[])
  into missing
  from public.database_safety_table_catalog_v2() catalog
  where catalog.schema_name = 'public'
    and to_regclass(format('%I.%I', catalog.schema_name, catalog.table_name)) is null;

  select encode(digest(coalesce(string_agg(inventory.entry, '|' order by inventory.entry), ''), 'sha256'), 'hex')
  into inventory_hash
  from (
    select format('%I.%I(%s)', n.nspname, c.relname, coalesce(string_agg(
      format('%I:%s:%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull),
      ',' order by a.attnum
    ), '')) entry
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r','p')
    group by n.nspname, c.relname
  ) inventory;

  return jsonb_build_object(
    'catalogVersion', public.database_safety_catalog_version_v2(),
    'schemaInventoryHash', inventory_hash,
    'classified', cardinality(unclassified) = 0 and cardinality(missing) = 0,
    'unclassified', to_jsonb(unclassified),
    'missing', to_jsonb(missing),
    'deleteTables', (select coalesce(jsonb_agg(format('%I.%I', schema_name, table_name) order by delete_order, table_name), '[]'::jsonb) from public.database_safety_table_catalog_v2() where planned_action = 'DELETE'),
    'protectedTables', (select coalesce(jsonb_agg(format('%I.%I', schema_name, table_name) order by schema_name, table_name), '[]'::jsonb) from public.database_safety_table_catalog_v2() where planned_action = 'PRESERVE')
  );
end;
$$;

create or replace function public.database_safety_counts_v2(action_filter text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  item record;
  row_count bigint;
  result jsonb := '[]'::jsonb;
begin
  for item in
    select * from public.database_safety_table_catalog_v2()
    where schema_name = 'public' and (action_filter is null or planned_action = action_filter)
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

create or replace function public.database_safety_current_snapshot_v2(input_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  state public.database_safety_state;
  preflight jsonb;
  migration_version text := 'unknown';
  storage_count bigint := null;
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  preflight := public.database_safety_catalog_preflight_v2();
  if not coalesce((preflight->>'classified')::boolean, false) then
    raise exception 'CATALOG_UNCLASSIFIED' using errcode = '55000';
  end if;
  select * into state from public.database_safety_state where singleton;
  begin
    select max(version)::text into migration_version from supabase_migrations.schema_migrations;
  exception when others then
    migration_version := 'unknown';
  end;
  begin
    select count(*) into storage_count from storage.objects
    where bucket_id in (select bucket_id from public.database_safety_storage_catalog_v2() where planned_action = 'BUSINESS_DELETE');
  exception when others then
    storage_count := null;
  end;
  return jsonb_build_object(
    'dataVersion', state.data_version,
    'storageVersion', state.storage_version,
    'catalogVersion', preflight->>'catalogVersion',
    'schemaInventoryHash', preflight->>'schemaInventoryHash',
    'schemaVersion', migration_version,
    'migrationVersion', migration_version,
    'tableCount', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
    'storageObjectCount', storage_count,
    'storageFilesIncluded', true,
    'deleteEnabledInDatabase', state.delete_enabled,
    'databaseScope', jsonb_build_object('schema','public','included',true),
    'storageScope', (select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket_id,'action',planned_action,'reason',reason) order by bucket_id), '[]'::jsonb) from public.database_safety_storage_catalog_v2()),
    'authScope', 'PRESERVED_NOT_INCLUDED',
    'catalog', preflight,
    'tables', (select coalesce(jsonb_agg(jsonb_build_object('schema',schema_name,'table',table_name,'category',category,'action',planned_action,'reason',reason) order by coalesce(delete_order,2147483647),schema_name,table_name), '[]'::jsonb) from public.database_safety_table_catalog_v2())
  );
end;
$$;

create or replace function public.database_safety_dry_run_v2(input_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot jsonb;
begin
  snapshot := public.database_safety_current_snapshot_v2(input_actor_id);
  return jsonb_build_object(
    'dryRun', true,
    'modifiedRows', 0,
    'dataVersion', snapshot->'dataVersion',
    'storageVersion', snapshot->'storageVersion',
    'catalogVersion', snapshot->'catalogVersion',
    'schemaInventoryHash', snapshot->'schemaInventoryHash',
    'wouldDelete', public.database_safety_counts_v2('DELETE'),
    'wouldPreserve', public.database_safety_counts_v2('PRESERVE'),
    'storageScope', snapshot->'storageScope',
    'authScope', snapshot->'authScope',
    'unclassifiedResources', snapshot#>'{catalog,unclassified}'
  );
end;
$$;

-- Every public table that the purge can delete invalidates the database backup.
do $$
declare
  item record;
begin
  for item in select * from public.database_safety_table_catalog_v2() where schema_name='public'
  loop
    if to_regclass(format('%I.%I', item.schema_name, item.table_name)) is null then continue; end if;
    execute format('drop trigger if exists database_safety_watermark on %I.%I', item.schema_name, item.table_name);
    if item.planned_action = 'DELETE' then
      execute format(
        'create trigger database_safety_watermark after insert or update or delete or truncate on %I.%I for each statement execute function public.touch_database_safety_watermark()',
        item.schema_name, item.table_name
      );
    end if;
  end loop;
end;
$$;

create or replace function public.touch_database_safety_storage_watermark_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected_bucket text;
begin
  affected_bucket := case
    when tg_op = 'DELETE' then old.bucket_id
    when tg_op = 'INSERT' then new.bucket_id
    when old.bucket_id in ('excel-uploads','chat-attachments','email-attachments','client-assets','opportunity-finder') then old.bucket_id
    else new.bucket_id
  end;
  if affected_bucket in ('excel-uploads','chat-attachments','email-attachments','client-assets','opportunity-finder') then
    update public.database_safety_state
    set storage_version = storage_version + 1, updated_at = clock_timestamp()
    where singleton;
  end if;
  return null;
end;
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='storage' and table_name='objects' and column_name='bucket_id'
  ) then
    execute 'drop trigger if exists database_safety_storage_watermark_v2 on storage.objects';
    execute 'create trigger database_safety_storage_watermark_v2 after insert or update or delete on storage.objects for each row execute function public.touch_database_safety_storage_watermark_v2()';
  end if;
end;
$$;

create or replace function public.begin_database_backup_manifest_v2(input_actor_id uuid, input_file_name text)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot jsonb;
  created_manifest public.database_backup_manifests;
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  if input_file_name !~ '^backup-respaldo-seguridad-quiksol-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.tar$' then
    raise exception 'BACKUP_FILE_NAME_INVALID' using errcode='22023';
  end if;
  snapshot := public.database_safety_current_snapshot_v2(input_actor_id);
  insert into public.database_backup_manifests (
    created_by, expires_at, file_name, format, sha256, size_bytes, table_count,
    database_project, schema_version, migration_version, data_version,
    restore_list_verified, restore_verified, storage_files_included, status,
    storage_version, catalog_version, schema_inventory_hash, backup_scope, auth_scope,
    generated_at
  ) values (
    input_actor_id, clock_timestamp() + interval '30 minutes', input_file_name,
    'quiksol-safety-bundle-v2', repeat('0',64), 1, (snapshot->>'tableCount')::integer,
    'pending', snapshot->>'schemaVersion', snapshot->>'migrationVersion', (snapshot->>'dataVersion')::bigint,
    false, false, false, 'creating', (snapshot->>'storageVersion')::bigint,
    snapshot->>'catalogVersion', snapshot->>'schemaInventoryHash',
    jsonb_build_object('database',snapshot->'databaseScope','storage',snapshot->'storageScope','auth',snapshot->'authScope'),
    'PRESERVED_NOT_INCLUDED', clock_timestamp()
  ) returning * into created_manifest;
  insert into public.database_safety_audit_events (
    backup_manifest_id, actor_id, event_type, status, catalog_version, data_version, storage_scope
  ) values (
    created_manifest.id, input_actor_id, 'backup_creating', 'started', created_manifest.catalog_version,
    created_manifest.data_version, created_manifest.backup_scope->'storage'
  );
  return created_manifest;
end;
$$;

create or replace function public.record_database_backup_created_v2(
  input_actor_id uuid,
  input_manifest_id uuid,
  input_bundle_sha256 text,
  input_bundle_size_bytes bigint,
  input_database_project text,
  input_schema_version text,
  input_migration_version text,
  input_database_sha256 text,
  input_database_size_bytes bigint,
  input_table_count integer,
  input_storage_manifest_sha256 text,
  input_storage_object_count bigint,
  input_storage_size_bytes bigint,
  input_storage_object_keys text[],
  input_evidence_hash text
)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated_manifest public.database_backup_manifests;
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  if input_bundle_sha256 !~ '^[0-9a-f]{64}$'
     or input_database_sha256 !~ '^[0-9a-f]{64}$'
     or input_storage_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or input_evidence_hash !~ '^[0-9a-f]{64}$'
     or input_bundle_size_bytes <= 0 or input_database_size_bytes <= 0
     or input_table_count <= 0 or input_storage_object_count < 0 or input_storage_size_bytes < 0
     or cardinality(coalesce(input_storage_object_keys,'{}'::text[])) <> input_storage_object_count then
    raise exception 'BACKEND_EVIDENCE_INVALID' using errcode='22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(input_storage_object_keys,'{}'::text[])) key
    where key !~ '^(excel-uploads|chat-attachments|email-attachments|client-assets|opportunity-finder)/[^/].*'
       or key like '%/../%' or key like '../%'
  ) then
    raise exception 'STORAGE_MANIFEST_INVALID' using errcode='22023';
  end if;
  update public.database_backup_manifests
  set status='created', sha256=input_bundle_sha256, size_bytes=input_bundle_size_bytes,
      database_project=input_database_project, schema_version=input_schema_version,
      migration_version=input_migration_version, database_sha256=input_database_sha256,
      database_size_bytes=input_database_size_bytes, table_count=input_table_count,
      restore_list_verified=true, restore_verified=true, storage_files_included=true,
      storage_manifest_sha256=input_storage_manifest_sha256,
      storage_object_count=input_storage_object_count, storage_size_bytes=input_storage_size_bytes,
      storage_object_keys=coalesce(input_storage_object_keys,'{}'::text[]), evidence_hash=input_evidence_hash
  where id=input_manifest_id and created_by=input_actor_id and status='creating'
  returning * into updated_manifest;
  if updated_manifest.id is null then raise exception 'BACKUP_STATE_INVALID' using errcode='55000'; end if;
  insert into public.database_safety_audit_events (
    backup_manifest_id, actor_id, event_type, status, manifest_hash, catalog_version, data_version, storage_scope
  ) values (
    updated_manifest.id, input_actor_id, 'backup_created', 'completed', updated_manifest.evidence_hash,
    updated_manifest.catalog_version, updated_manifest.data_version, updated_manifest.backup_scope->'storage'
  );
  return updated_manifest;
end;
$$;

create or replace function public.verify_database_backup_manifest_v2(input_actor_id uuid, input_manifest_id uuid, input_evidence_hash text)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  manifest public.database_backup_manifests;
  state public.database_safety_state;
  preflight jsonb;
  current_migration_version text := 'unknown';
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  select * into manifest from public.database_backup_manifests
  where id=input_manifest_id and created_by=input_actor_id for update;
  if manifest.id is null or manifest.status <> 'created' or manifest.evidence_hash <> input_evidence_hash then
    raise exception 'BACKUP_STATE_INVALID' using errcode='55000';
  end if;
  update public.database_backup_manifests set status='verifying' where id=manifest.id;
  select * into state from public.database_safety_state where singleton;
  preflight := public.database_safety_catalog_preflight_v2();
  begin
    select max(version)::text into current_migration_version from supabase_migrations.schema_migrations;
  exception when others then current_migration_version := 'unknown'; end;
  if not (preflight->>'classified')::boolean
     or manifest.data_version <> state.data_version
     or manifest.storage_version <> state.storage_version
     or manifest.catalog_version <> preflight->>'catalogVersion'
     or manifest.schema_inventory_hash <> preflight->>'schemaInventoryHash'
     or manifest.migration_version <> current_migration_version
     or manifest.schema_version <> current_migration_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;
  if not manifest.restore_list_verified or not manifest.restore_verified or not manifest.storage_files_included
     or manifest.database_sha256 !~ '^[0-9a-f]{64}$'
     or manifest.storage_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'BACKUP_NOT_VERIFIED' using errcode='55000';
  end if;
  update public.database_backup_manifests
  set status='verified', verified_at=clock_timestamp()
  where id=manifest.id returning * into manifest;
  insert into public.database_safety_audit_events (
    backup_manifest_id, actor_id, event_type, status, manifest_hash, catalog_version, data_version, storage_scope
  ) values (
    manifest.id, input_actor_id, 'backup_verified', 'completed', manifest.evidence_hash,
    manifest.catalog_version, manifest.data_version, manifest.backup_scope->'storage'
  );
  return manifest;
end;
$$;

create or replace function public.fail_database_backup_manifest_v2(input_actor_id uuid, input_manifest_id uuid, input_failure_code text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  update public.database_backup_manifests
  set status='failed', metadata=metadata || jsonb_build_object('safeErrorCode',left(coalesce(input_failure_code,'BACKUP_FAILED'),120))
  where id=input_manifest_id and created_by=input_actor_id and status in ('creating','created','verifying');
  if found then
    insert into public.database_safety_audit_events(backup_manifest_id,actor_id,event_type,status,safe_error_code)
    values(input_manifest_id,input_actor_id,'backup_failed','failed',left(coalesce(input_failure_code,'BACKUP_FAILED'),120));
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.mark_database_backup_downloaded_v2(input_actor_id uuid, input_manifest_id uuid, input_evidence_hash text)
returns public.database_backup_manifests
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  manifest public.database_backup_manifests;
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  update public.database_backup_manifests
  set downloaded_at=clock_timestamp()
  where id=input_manifest_id and created_by=input_actor_id and status='verified'
    and evidence_hash=input_evidence_hash and expires_at>clock_timestamp()
  returning * into manifest;
  if manifest.id is null then raise exception 'BACKUP_INVALID' using errcode='55000'; end if;
  insert into public.database_safety_audit_events(backup_manifest_id,actor_id,event_type,status,manifest_hash,catalog_version,data_version)
  values(manifest.id,input_actor_id,'backup_stream_completed','completed',manifest.evidence_hash,manifest.catalog_version,manifest.data_version);
  return manifest;
end;
$$;

create or replace function public.arm_database_destruction_v2(
  input_actor_id uuid,
  input_backup_manifest_id uuid,
  input_challenge_hash text,
  input_session_binding_hash text,
  input_ip_hash text default null
)
returns public.database_destruction_operations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  manifest public.database_backup_manifests;
  state public.database_safety_state;
  preflight jsonb;
  operation public.database_destruction_operations;
  current_migration_version text := 'unknown';
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  if input_challenge_hash !~ '^[0-9a-f]{64}$' or input_session_binding_hash !~ '^[0-9a-f]{64}$'
     or (input_ip_hash is not null and input_ip_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'CHALLENGE_INVALID' using errcode='22023';
  end if;
  if exists (select 1 from public.database_destruction_operations where challenge_hash=input_challenge_hash) then
    raise exception 'CHALLENGE_ALREADY_USED' using errcode='55000';
  end if;
  select * into manifest from public.database_backup_manifests
  where id=input_backup_manifest_id and created_by=input_actor_id for update;
  if manifest.id is null or manifest.status<>'verified' or not manifest.restore_verified
     or not manifest.storage_files_included or manifest.downloaded_at is null
     or manifest.expires_at <= clock_timestamp() then
    raise exception 'BACKUP_NOT_VERIFIED' using errcode='55000';
  end if;
  select * into state from public.database_safety_state where singleton;
  preflight := public.database_safety_catalog_preflight_v2();
  begin
    select max(version)::text into current_migration_version from supabase_migrations.schema_migrations;
  exception when others then current_migration_version := 'unknown'; end;
  if not (preflight->>'classified')::boolean
     or manifest.data_version<>state.data_version or manifest.storage_version<>state.storage_version
     or manifest.catalog_version<>preflight->>'catalogVersion'
     or manifest.schema_inventory_hash<>preflight->>'schemaInventoryHash'
     or manifest.migration_version<>current_migration_version
     or manifest.schema_version<>current_migration_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;
  update public.database_destruction_operations
  set status='cancelled',cancelled_at=clock_timestamp(),failure_code='SUPERSEDED'
  where created_by=input_actor_id and status in ('pending','backup_verified','armed');
  insert into public.database_destruction_operations(
    created_by,backup_manifest_id,status,challenge_hash,challenge_expires_at,
    session_binding_hash,not_before,reauthenticated_at,reauth_expires_at,backup_sha256,
    data_version,storage_version,catalog_version,schema_inventory_hash,evidence_hash,
    ip_hash,armed_at,storage_status
  ) values (
    input_actor_id,manifest.id,'armed',input_challenge_hash,clock_timestamp()+interval '5 minutes',
    input_session_binding_hash,clock_timestamp()+interval '30 seconds',clock_timestamp(),clock_timestamp()+interval '5 minutes',
    manifest.sha256,manifest.data_version,manifest.storage_version,manifest.catalog_version,
    manifest.schema_inventory_hash,manifest.evidence_hash,input_ip_hash,clock_timestamp(),'pending'
  ) returning * into operation;
  insert into public.database_safety_audit_events(operation_id,backup_manifest_id,actor_id,event_type,status,ip_hash,manifest_hash,catalog_version,data_version,storage_scope)
  values(operation.id,manifest.id,input_actor_id,'destruction_armed','completed',input_ip_hash,manifest.evidence_hash,manifest.catalog_version,manifest.data_version,manifest.backup_scope->'storage');
  return operation;
end;
$$;

create or replace function public.cancel_database_destruction_v2(input_actor_id uuid, input_operation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  update public.database_destruction_operations set status='cancelled',cancelled_at=clock_timestamp()
  where id=input_operation_id and created_by=input_actor_id and status='armed';
  if found then
    insert into public.database_safety_audit_events(operation_id,actor_id,event_type,status)
    values(input_operation_id,input_actor_id,'destruction_cancelled','completed');
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.fail_database_destruction_v2(input_actor_id uuid, input_operation_id uuid, input_failure_code text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  update public.database_destruction_operations
  set status='failed',failed_at=clock_timestamp(),failure_code=left(coalesce(input_failure_code,'DELETE_FAILED'),120)
  where id=input_operation_id and created_by=input_actor_id and status='armed';
  if found then
    insert into public.database_safety_audit_events(operation_id,actor_id,event_type,status,safe_error_code)
    values(input_operation_id,input_actor_id,'destruction_failed','failed',left(coalesce(input_failure_code,'DELETE_FAILED'),120));
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.execute_database_business_purge_v2(
  input_actor_id uuid,
  input_operation_id uuid,
  input_challenge_hash text,
  input_session_binding_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  operation public.database_destruction_operations;
  manifest public.database_backup_manifests;
  state public.database_safety_state;
  preflight jsonb;
  item record;
  before_counts jsonb;
  after_counts jsonb;
  affected text[];
  response jsonb;
  current_migration_version text := 'unknown';
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  if not exists (select 1 from public.database_safety_state where singleton and delete_enabled) then
    raise exception 'DELETE_KILL_SWITCH_DISABLED' using errcode='55000';
  end if;
  select * into operation from public.database_destruction_operations
  where id=input_operation_id and created_by=input_actor_id for update;
  if operation.id is null then raise exception 'OPERATION_NOT_FOUND' using errcode='P0002'; end if;
  if operation.status in ('database_completed','completed') then
    if operation.challenge_hash<>input_challenge_hash then raise exception 'CHALLENGE_INVALID' using errcode='42501'; end if;
    if operation.session_binding_hash<>input_session_binding_hash then raise exception 'SESSION_CHANGED' using errcode='42501'; end if;
    return operation.result;
  end if;
  if operation.status<>'armed' then raise exception 'OPERATION_NOT_ARMED' using errcode='55000'; end if;
  if operation.challenge_used_at is not null then raise exception 'CHALLENGE_ALREADY_USED' using errcode='55000'; end if;
  if operation.challenge_expires_at<=clock_timestamp() then raise exception 'CHALLENGE_EXPIRED' using errcode='55000'; end if;
  if operation.reauth_expires_at is null or operation.reauth_expires_at<=clock_timestamp() then raise exception 'REAUTH_EXPIRED' using errcode='55000'; end if;
  if operation.not_before>clock_timestamp() then raise exception 'COUNTDOWN_ACTIVE' using errcode='55000'; end if;
  if operation.challenge_hash<>input_challenge_hash then raise exception 'CHALLENGE_INVALID' using errcode='42501'; end if;
  if operation.session_binding_hash<>input_session_binding_hash then raise exception 'SESSION_CHANGED' using errcode='42501'; end if;
  select * into manifest from public.database_backup_manifests where id=operation.backup_manifest_id and created_by=input_actor_id for update;
  if manifest.id is null or manifest.status<>'verified' or manifest.evidence_hash<>operation.evidence_hash
     or manifest.downloaded_at is null or manifest.expires_at<=clock_timestamp() then
    raise exception 'BACKUP_NOT_VERIFIED' using errcode='55000';
  end if;
  preflight := public.database_safety_catalog_preflight_v2();
  select * into state from public.database_safety_state where singleton;
  begin
    select max(version)::text into current_migration_version from supabase_migrations.schema_migrations;
  exception when others then current_migration_version := 'unknown'; end;
  if not (preflight->>'classified')::boolean then raise exception 'CATALOG_UNCLASSIFIED' using errcode='55000'; end if;
  if manifest.data_version<>state.data_version or operation.data_version<>state.data_version
     or manifest.storage_version<>state.storage_version or operation.storage_version<>state.storage_version
     or manifest.catalog_version<>preflight->>'catalogVersion'
     or operation.catalog_version<>preflight->>'catalogVersion'
     or manifest.schema_inventory_hash<>preflight->>'schemaInventoryHash'
     or manifest.migration_version<>current_migration_version
     or manifest.schema_version<>current_migration_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;
  for item in select * from public.database_safety_table_catalog_v2() where schema_name='public' and planned_action='DELETE' order by schema_name, table_name
  loop
    execute format('lock table %I.%I in share row exclusive mode',item.schema_name,item.table_name);
  end loop;
  if to_regclass('storage.objects') is not null then lock table storage.objects in share row exclusive mode; end if;
  select * into state from public.database_safety_state where singleton for update;
  if manifest.data_version<>state.data_version or manifest.storage_version<>state.storage_version then
    raise exception 'BACKUP_STALE' using errcode='55000';
  end if;
  before_counts:=public.database_safety_counts_v2('DELETE');
  select array_agg(format('%I.%I',schema_name,table_name) order by delete_order,table_name)
  into affected from public.database_safety_table_catalog_v2() where schema_name='public' and planned_action='DELETE';
  update public.database_destruction_operations
  set status='executing',challenge_used_at=clock_timestamp(),executing_at=clock_timestamp(),counts_before=before_counts,affected_tables=affected
  where id=operation.id;
  for item in select * from public.database_safety_table_catalog_v2() where schema_name='public' and planned_action='DELETE' order by delete_order,table_name
  loop
    execute format('delete from %I.%I',item.schema_name,item.table_name);
    if current_setting('quiksol.database_safety_fail_after_table',true)=item.table_name then
      raise exception 'INJECTED_DELETE_FAILURE' using errcode='P0001';
    end if;
  end loop;
  after_counts:=public.database_safety_counts_v2('DELETE');
  response:=jsonb_build_object('operationId',operation.id,'status','database_completed','countsBefore',before_counts,'countsAfter',after_counts,'affectedTables',affected,'storageStatus','pending','completedAt',clock_timestamp());
  update public.database_destruction_operations
  set status='database_completed',counts_after=after_counts,result=response,storage_status='pending'
  where id=operation.id;
  insert into public.database_safety_audit_events(operation_id,backup_manifest_id,actor_id,event_type,status,ip_hash,table_counts,counts_after,affected_tables,manifest_hash,catalog_version,data_version,storage_scope)
  values(operation.id,manifest.id,input_actor_id,'business_database_deleted','completed',operation.ip_hash,before_counts,after_counts,affected,manifest.evidence_hash,manifest.catalog_version,manifest.data_version,manifest.backup_scope->'storage');
  return response;
end;
$$;

create or replace function public.claim_database_storage_cleanup_v2(input_actor_id uuid, input_operation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  update public.database_destruction_operations
  set storage_status='deleting'
  where id=input_operation_id and created_by=input_actor_id and status='database_completed' and storage_status in ('pending','failed');
  return found;
end;
$$;

create or replace function public.finish_database_storage_cleanup_v2(
  input_actor_id uuid,
  input_operation_id uuid,
  input_success boolean,
  input_deleted_objects integer,
  input_safe_error_code text default null
)
returns public.database_destruction_operations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  operation public.database_destruction_operations;
begin
  perform public.assert_database_safety_backend_actor_v2(input_actor_id);
  select * into operation from public.database_destruction_operations
  where id=input_operation_id and created_by=input_actor_id for update;
  if operation.id is null then raise exception 'OPERATION_NOT_FOUND' using errcode='P0002'; end if;
  if operation.status='completed' then return operation; end if;
  if operation.status<>'database_completed' or operation.storage_status<>'deleting' then raise exception 'STORAGE_CLEANUP_STATE_INVALID' using errcode='55000'; end if;
  if input_success then
    update public.database_destruction_operations
    set status='completed',storage_status='completed',completed_at=clock_timestamp(),
        storage_result=jsonb_build_object('deletedObjects',greatest(coalesce(input_deleted_objects,0),0),'recovery','manifest-keys-retry'),
        result=result || jsonb_build_object('status','completed','storageStatus','completed','deletedStorageObjects',greatest(coalesce(input_deleted_objects,0),0))
    where id=operation.id returning * into operation;
    insert into public.database_safety_audit_events(operation_id,backup_manifest_id,actor_id,event_type,status,manifest_hash,catalog_version,data_version,storage_scope)
    select operation.id,operation.backup_manifest_id,input_actor_id,'business_information_deleted','completed',operation.evidence_hash,operation.catalog_version,operation.data_version,
      manifest.backup_scope->'storage' from public.database_backup_manifests manifest where manifest.id=operation.backup_manifest_id;
  else
    update public.database_destruction_operations
    set storage_status='failed',storage_result=jsonb_build_object('safeErrorCode',left(coalesce(input_safe_error_code,'STORAGE_DELETE_FAILED'),120),'recovery','retry-exact-manifest-keys')
    where id=operation.id returning * into operation;
    insert into public.database_safety_audit_events(operation_id,backup_manifest_id,actor_id,event_type,status,safe_error_code,manifest_hash,catalog_version,data_version)
    values(operation.id,operation.backup_manifest_id,input_actor_id,'storage_cleanup_failed','failed',left(coalesce(input_safe_error_code,'STORAGE_DELETE_FAILED'),120),operation.evidence_hash,operation.catalog_version,operation.data_version);
  end if;
  return operation;
end;
$$;

-- Old caller-controlled contracts are disabled completely.
revoke all on function public.database_safety_current_snapshot() from public,anon,authenticated,service_role;
revoke all on function public.database_safety_dry_run() from public,anon,authenticated,service_role;
revoke all on function public.register_database_backup_manifest(text,text,bigint,integer,text,text,text,bigint,boolean) from public,anon,authenticated,service_role;
revoke all on function public.mark_database_backup_downloaded(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.arm_database_destruction(uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.cancel_database_destruction(uuid) from public,anon,authenticated,service_role;
revoke all on function public.fail_database_destruction(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.execute_database_business_purge(uuid,text,text) from public,anon,authenticated,service_role;

revoke all on function public.database_safety_table_catalog_v2() from public,anon,authenticated;
revoke all on function public.database_safety_storage_catalog_v2() from public,anon,authenticated;
revoke all on function public.database_safety_catalog_version_v2() from public,anon,authenticated;
revoke all on function public.assert_database_safety_backend_actor_v2(uuid) from public,anon,authenticated;
revoke all on function public.database_safety_catalog_preflight_v2() from public,anon,authenticated;
revoke all on function public.database_safety_counts_v2(text) from public,anon,authenticated;
revoke all on function public.database_safety_current_snapshot_v2(uuid) from public,anon,authenticated;
revoke all on function public.database_safety_dry_run_v2(uuid) from public,anon,authenticated;
revoke all on function public.begin_database_backup_manifest_v2(uuid,text) from public,anon,authenticated;
revoke all on function public.record_database_backup_created_v2(uuid,uuid,text,bigint,text,text,text,text,bigint,integer,text,bigint,bigint,text[],text) from public,anon,authenticated;
revoke all on function public.verify_database_backup_manifest_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.fail_database_backup_manifest_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.mark_database_backup_downloaded_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.arm_database_destruction_v2(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.cancel_database_destruction_v2(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_database_destruction_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.execute_database_business_purge_v2(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.claim_database_storage_cleanup_v2(uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_database_storage_cleanup_v2(uuid,uuid,boolean,integer,text) from public,anon,authenticated;

grant execute on function public.database_safety_table_catalog_v2() to service_role;
grant execute on function public.database_safety_storage_catalog_v2() to service_role;
grant execute on function public.database_safety_catalog_version_v2() to service_role;
grant execute on function public.assert_database_safety_backend_actor_v2(uuid) to service_role;
grant execute on function public.database_safety_catalog_preflight_v2() to service_role;
grant execute on function public.database_safety_counts_v2(text) to service_role;
grant execute on function public.database_safety_current_snapshot_v2(uuid) to service_role;
grant execute on function public.database_safety_dry_run_v2(uuid) to service_role;
grant execute on function public.begin_database_backup_manifest_v2(uuid,text) to service_role;
grant execute on function public.record_database_backup_created_v2(uuid,uuid,text,bigint,text,text,text,text,bigint,integer,text,bigint,bigint,text[],text) to service_role;
grant execute on function public.verify_database_backup_manifest_v2(uuid,uuid,text) to service_role;
grant execute on function public.fail_database_backup_manifest_v2(uuid,uuid,text) to service_role;
grant execute on function public.mark_database_backup_downloaded_v2(uuid,uuid,text) to service_role;
grant execute on function public.arm_database_destruction_v2(uuid,uuid,text,text,text) to service_role;
grant execute on function public.cancel_database_destruction_v2(uuid,uuid) to service_role;
grant execute on function public.fail_database_destruction_v2(uuid,uuid,text) to service_role;
grant execute on function public.execute_database_business_purge_v2(uuid,uuid,text,text) to service_role;
grant execute on function public.claim_database_storage_cleanup_v2(uuid,uuid) to service_role;
grant execute on function public.finish_database_storage_cleanup_v2(uuid,uuid,boolean,integer,text) to service_role;

comment on function public.execute_database_business_purge_v2(uuid,uuid,text,text) is
  'Internal backend-only transactional database purge. Physical Storage cleanup is an explicit recoverable saga step.';

commit;
