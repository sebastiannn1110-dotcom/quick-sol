-- Run ONLY against an isolated disposable Supabase/PostgreSQL test database after applying
-- 20260816120000_super_admin_database_safety_center.sql.
-- The transaction is rolled back, but the explicit guard is still mandatory:
--   alter database <temporary_test_db> set quiksol.allow_destructive_runtime_test = 'on';

begin;

do $$
begin
  if current_setting('quiksol.allow_destructive_runtime_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_DISPOSABLE_DATABASE';
  end if;
  if (select count(*) from public.database_safety_table_catalog()) <> 68 then
    raise exception 'SAFETY_CATALOG_COUNT_INVALID';
  end if;
  if (select count(*) from public.database_safety_table_catalog() where planned_action = 'DELETE') <> 52 then
    raise exception 'DELETE_ALLOWLIST_COUNT_INVALID';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('database_safety_state','database_backup_manifests','database_destruction_operations','database_safety_audit_events')
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  ) then
    raise exception 'RLS_NOT_FORCED';
  end if;
end;
$$;

-- Synthetic identity only; no real credentials or business data.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000099',
  'authenticated', 'authenticated', 'database-safety@example.test', crypt(gen_random_uuid()::text, gen_salt('bf')), now(),
  '{}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''
);

insert into public.profiles (id, full_name, email, role, is_active)
values ('00000000-0000-4000-8000-000000000099', 'Synthetic Safety Test', 'database-safety@example.test', 'super_admin_dev', true);

insert into public.system_logs (level, module, action, message)
values ('info', 'database_safety_test', 'synthetic_fixture', 'Synthetic fixture without business content.');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000099';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  snapshot jsonb;
  manifest public.database_backup_manifests;
  operation public.database_destruction_operations;
begin
  snapshot := public.database_safety_current_snapshot();
  manifest := public.register_database_backup_manifest(
    'backup-respaldo-base-datos-general-2026-08-16-131500.dump',
    repeat('a', 64), 128, (snapshot->>'tableCount')::integer, 'temporary-test',
    snapshot->>'schemaVersion', snapshot->>'migrationVersion', (snapshot->>'dataVersion')::bigint, true
  );
  perform public.mark_database_backup_downloaded(manifest.id, manifest.sha256);
  operation := public.arm_database_destruction(manifest.id, repeat('b',64), repeat('c',64), repeat('d',64));
  perform set_config('quiksol.runtime_operation_id', operation.id::text, true);
end;
$$;

reset role;
update public.database_destruction_operations
set not_before = clock_timestamp() - interval '1 second'
where id = current_setting('quiksol.runtime_operation_id')::uuid;
set local role authenticated;

do $$
declare
  first_result jsonb;
  second_result jsonb;
begin
  first_result := public.execute_database_business_purge(
    current_setting('quiksol.runtime_operation_id')::uuid, repeat('b',64), repeat('c',64)
  );
  second_result := public.execute_database_business_purge(
    current_setting('quiksol.runtime_operation_id')::uuid, repeat('b',64), repeat('c',64)
  );
  if first_result <> second_result then raise exception 'DOUBLE_POST_NOT_IDEMPOTENT'; end if;
end;
$$;

reset role;

do $$
begin
  if exists (select 1 from public.system_logs where module = 'database_safety_test') then
    raise exception 'BUSINESS_TABLE_NOT_CLEAN';
  end if;
  if not exists (select 1 from public.profiles where id = '00000000-0000-4000-8000-000000000099' and role = 'super_admin_dev') then
    raise exception 'PROTECTED_IDENTITY_REMOVED';
  end if;
  if not exists (select 1 from public.database_safety_audit_events where event_type = 'business_information_deleted') then
    raise exception 'PROTECTED_AUDIT_MISSING';
  end if;
end;
$$;

rollback;
