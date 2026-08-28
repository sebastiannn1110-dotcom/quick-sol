-- R8.4 sequential PostgreSQL proof: schema compatibility, idempotent lifecycle,
-- conservative reconciliation, audit deduplication, ACL/RLS and safe orphan
-- diagnostics. This file is disposable-only and never contacts Supabase Auth.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R83_USER_PROVISIONING_TEST_DATABASE';
  end if;
  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R84_REQUIRES_R83B_GATE';
  end if;
end;
$$;

-- Seed one confirmed, active Super Admin Dev without invoking the B-gated Auth
-- trigger. This bypass is tightly delimited to synthetic fixture creation.
set session_replication_role = replica;

insert into auth.users (
  id, email, email_confirmed_at, banned_until, raw_app_meta_data, raw_user_meta_data
) values (
  '84000000-0000-4000-8000-000000000001',
  'r84_runtime_actor@example.invalid',
  pg_catalog.now(),
  null,
  '{}'::jsonb,
  '{"full_name":"R84 Runtime Actor"}'::jsonb
)
on conflict (id) do nothing;

insert into public.profiles (
  id, full_name, email, role, department, region, is_active
) values (
  '84000000-0000-4000-8000-000000000001',
  'R84 Runtime Actor',
  'r84_runtime_actor@example.invalid',
  'super_admin_dev',
  'Security',
  'Disposable',
  true
)
on conflict (id) do nothing;

set session_replication_role = origin;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '84000000-0000-4000-8000-000000000001',
  false
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

create temporary table r84_runtime_ids (
  fixture_name text primary key,
  intent_id uuid,
  auth_user_id uuid,
  idempotency_key uuid
) on commit preserve rows;

-- Schema, legacy compatibility and deterministic non-secret fingerprint.
do $$
declare
  legacy_intent_id uuid;
  fingerprint_a bytea;
  fingerprint_b bytea;
  invalid_fingerprint_rejected boolean := false;
  invalid_version_rejected boolean := false;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_provisioning_intents'
      and column_name = 'idempotency_key'
      and udt_name = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_provisioning_intents'
      and column_name = 'request_fingerprint'
      and udt_name = 'bytea'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_provisioning_intents'
      and column_name = 'fingerprint_version'
      and udt_name = 'int2'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_provisioning_intents'
      and column_name = 'attempt_count'
      and udt_name = 'int4'
      and is_nullable = 'NO'
  ) then
    raise exception 'R84_SCHEMA_COLUMNS_INVALID';
  end if;

  if pg_catalog.to_regclass('public.profiles_provisioning_email_hash_idx') is null then
    raise exception 'R84_PUBLIC_LOOKUP_INDEX_MISSING';
  end if;

  if pg_catalog.to_regclass('auth.auth_users_provisioning_email_hash_idx') is not null
     or pg_catalog.to_regclass('auth.auth_users_provisioning_user_intent_locator_idx') is not null
     or pg_catalog.to_regclass('auth.auth_users_provisioning_app_intent_locator_idx') is not null then
    raise exception 'R841_AUTH_MANAGED_INDEX_UNEXPECTED';
  end if;

  begin
    insert into public.user_provisioning_intents (
      source, actor_profile_id, requested_email_hash, requested_role,
      requested_full_name, requested_is_active, idempotency_key,
      request_fingerprint, fingerprint_version, attempt_count, last_attempt_at
    ) values (
      'admin_api', '84000000-0000-4000-8000-000000000001',
      extensions.digest('r84-invalid-null-fingerprint@example.invalid', 'sha256'),
      'employee', 'Invalid Null Fingerprint', true,
      '84000000-0000-4000-8200-000000000001', null, 1, 1,
      pg_catalog.clock_timestamp()
    );
  exception when check_violation then
    invalid_fingerprint_rejected := true;
  end;

  begin
    insert into public.user_provisioning_intents (
      source, actor_profile_id, requested_email_hash, requested_role,
      requested_full_name, requested_is_active, idempotency_key,
      request_fingerprint, fingerprint_version, attempt_count, last_attempt_at
    ) values (
      'admin_api', '84000000-0000-4000-8000-000000000001',
      extensions.digest('r84-invalid-null-version@example.invalid', 'sha256'),
      'employee', 'Invalid Null Version', true,
      '84000000-0000-4000-8200-000000000002',
      extensions.digest('r84-invalid-version-fingerprint', 'sha256'),
      null, 1, pg_catalog.clock_timestamp()
    );
  exception when check_violation then
    invalid_version_rejected := true;
  end;

  if not invalid_fingerprint_rejected or not invalid_version_rejected then
    raise exception 'R84_NULL_FINGERPRINT_OR_VERSION_ACCEPTED';
  end if;

  legacy_intent_id := public.create_user_provisioning_intent_v1(
    'r84_legacy_nulls@example.invalid',
    'R84 Legacy Nulls',
    'employee',
    null,
    null,
    true,
    null,
    null
  );

  if not exists (
    select 1
    from public.user_provisioning_intents intent
    where intent.id = legacy_intent_id
      and intent.idempotency_key is null
      and intent.request_fingerprint is null
      and intent.fingerprint_version is null
      and intent.attempt_count = 0
      and intent.last_attempt_at is null
  ) then
    raise exception 'R84_LEGACY_NULL_STRATEGY_FAILED';
  end if;

  fingerprint_a := public.user_provisioning_request_fingerprint_v1(
    ' R84_Fingerprint@Example.Invalid ',
    '  Fingerprint User  ',
    'employee',
    ' ',
    ' North ',
    true,
    null,
    '  Analyst '
  );
  fingerprint_b := public.user_provisioning_request_fingerprint_v1(
    'r84_fingerprint@example.invalid',
    'Fingerprint User',
    'employee',
    null,
    'North',
    true,
    '',
    'Analyst'
  );

  if fingerprint_a is distinct from fingerprint_b
     or pg_catalog.octet_length(fingerprint_a) <> 32 then
    raise exception 'R84_FINGERPRINT_NOT_DETERMINISTIC';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc routine
    cross join lateral unnest(coalesce(routine.proargnames, '{}'::text[])) argument_name
    where routine.oid = any (array[
      'public.user_provisioning_request_fingerprint_v1(text,text,text,text,text,boolean,text,text)'::regprocedure,
      'public.begin_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)'::regprocedure,
      'public.begin_cli_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)'::regprocedure
    ]::oid[])
      and pg_catalog.lower(argument_name) ~ '(password|token|secret|credential)'
  ) or exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_provisioning_intents'
      and pg_catalog.lower(column_name) ~ '(password|token|secret|credential)'
  ) then
    raise exception 'R84_PASSWORD_OR_SECRET_PERSISTENCE_SURFACE';
  end if;
end;
$$;

-- RLS, grants, ownership, hardened routines and Database Safety classification.
do $$
declare
  unclassified_count bigint;
begin
  if not (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid = 'public.user_provisioning_intents'::regclass
  ) then
    raise exception 'R84_INTENT_RLS_DISABLED';
  end if;

  if exists (
    select 1
    from (values ('anon'), ('authenticated'), ('service_role')) role_name(name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) privilege_name(name)
    where pg_catalog.has_table_privilege(
      role_name.name,
      'public.user_provisioning_intents',
      privilege_name.name
    )
  ) or exists (
    select 1
    from pg_catalog.pg_class relation
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) acl
    where relation.oid = 'public.user_provisioning_intents'::regclass
      and acl.grantee = 0
      and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'R84_INTENT_DIRECT_TABLE_ACL_EXPOSED';
  end if;

  if (select count(*) from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'user_provisioning_intents') <> 0 then
    raise exception 'R84_INTENT_POLICY_EXPOSED';
  end if;

  if not pg_catalog.has_function_privilege(
      'authenticated',
      'public.begin_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'anon',
      'public.begin_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',
      'public.begin_cli_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.begin_cli_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.preview_user_provisioning_reconciliation_v1(uuid)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.reconcile_user_provisioning_intent_v1(uuid,uuid,text)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.preview_auth_profile_orphans_v1()',
      'EXECUTE'
    ) then
    raise exception 'R84_FUNCTION_ACL_INVALID';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc routine
    where routine.oid = any (array[
      'public.user_provisioning_request_fingerprint_v1(text,text,text,text,text,boolean,text,text)'::regprocedure,
      'public.guard_user_provisioning_intent_insert_v2()'::regprocedure,
      'public.begin_user_provisioning_internal_v2(text,uuid,uuid,text,text,text,text,text,boolean,text,text)'::regprocedure,
      'public.begin_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)'::regprocedure,
      'public.begin_cli_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)'::regprocedure,
      'public.handle_new_user()'::regprocedure,
      'public.classify_user_provisioning_intent_v1(uuid)'::regprocedure,
      'public.preview_user_provisioning_reconciliation_v1(uuid)'::regprocedure,
      'public.reconcile_user_provisioning_intent_v1(uuid,uuid,text)'::regprocedure,
      'public.preview_auth_profile_orphans_v1()'::regprocedure
    ]::oid[])
      and pg_catalog.pg_get_userbyid(routine.proowner) <> 'postgres'
  ) then
    raise exception 'R84_FUNCTION_OWNER_INVALID';
  end if;

  if not exists (
    select 1
    from public.database_safety_table_catalog_v2()
    where schema_name = 'public'
      and table_name = 'user_provisioning_intents'
      and category = 'AUTH_IDENTITY'
      and planned_action = 'PRESERVE'
      and delete_order is null
  ) then
    raise exception 'R84_DATABASE_SAFETY_CLASSIFICATION_INVALID';
  end if;

  select count(*)
  into unclassified_count
  from pg_catalog.pg_tables table_info
  left join public.database_safety_table_catalog_v2() catalog
    on catalog.schema_name = table_info.schemaname
   and catalog.table_name = table_info.tablename
  where table_info.schemaname = 'public'
    and catalog.table_name is null;

  if unclassified_count <> 0 then
    raise exception 'R84_DATABASE_SAFETY_UNCLASSIFIED:%', unclassified_count;
  end if;
end;
$$;

-- NEW, pending replay, same-key conflict, same-email conflict and completion.
do $$
declare
  first_result jsonb;
  pending_result jsonb;
  created_intent_id uuid;
  key_conflict_rejected boolean := false;
  email_conflict_rejected boolean := false;
begin
  first_result := public.begin_user_provisioning_v2(
    '84000000-0000-4000-8100-000000000001',
    'r84_lifecycle@example.invalid',
    'R84 Lifecycle',
    'employee',
    'Operations',
    'North',
    true,
    'Lifecycle Bio',
    'Lifecycle Job'
  );
  created_intent_id := (first_result->>'intent_id')::uuid;

  if first_result->>'state' <> 'NEW'
     or (first_result->>'attempt_count')::integer <> 1 then
    raise exception 'R84_NEW_RESULT_INVALID:%', first_result;
  end if;

  pending_result := public.begin_user_provisioning_v2(
    '84000000-0000-4000-8100-000000000001',
    ' R84_LIFECYCLE@EXAMPLE.INVALID ',
    ' R84 Lifecycle ',
    'employee',
    'Operations',
    'North',
    true,
    'Lifecycle Bio',
    'Lifecycle Job'
  );

  if pending_result->>'state' <> 'EXISTING_PENDING'
     or (pending_result->>'intent_id')::uuid <> created_intent_id
     or (pending_result->>'attempt_count')::integer <> 2 then
    raise exception 'R84_PENDING_REPLAY_INVALID:%', pending_result;
  end if;

  begin
    perform public.begin_user_provisioning_v2(
      '84000000-0000-4000-8100-000000000001',
      'r84_lifecycle@example.invalid',
      'Changed Logical Payload',
      'manager',
      'Operations',
      'North',
      true,
      null,
      null
    );
  exception when sqlstate 'QS841' then
    key_conflict_rejected := true;
  end;

  begin
    perform public.begin_user_provisioning_v2(
      '84000000-0000-4000-8100-000000000002',
      'r84_lifecycle@example.invalid',
      'R84 Lifecycle',
      'employee',
      'Operations',
      'North',
      true,
      'Lifecycle Bio',
      'Lifecycle Job'
    );
  exception when sqlstate 'QS843' then
    email_conflict_rejected := true;
  end;

  if not key_conflict_rejected or not email_conflict_rejected then
    raise exception 'R84_EXPECTED_CONFLICT_NOT_REJECTED:%:%',
      key_conflict_rejected, email_conflict_rejected;
  end if;

  if (select count(*) from public.user_provisioning_intents
      where requested_email_hash = extensions.digest('r84_lifecycle@example.invalid', 'sha256')) <> 1 then
    raise exception 'R84_LOGICAL_OPERATION_DUPLICATED';
  end if;

  insert into r84_runtime_ids (fixture_name, intent_id, auth_user_id, idempotency_key)
  values (
    'lifecycle',
    created_intent_id,
    '84000000-0000-4000-8200-000000000001',
    '84000000-0000-4000-8100-000000000001'
  );
end;
$$;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
)
select
  fixture.auth_user_id,
  'r84_lifecycle@example.invalid',
  pg_catalog.now(),
  '{}'::jsonb,
  pg_catalog.jsonb_build_object(
    'quiksol_provisioning_intent_id', fixture.intent_id,
    'full_name', 'client metadata is not authoritative',
    'role', 'super_admin_dev'
  )
from r84_runtime_ids fixture
where fixture.fixture_name = 'lifecycle';

do $$
declare
  replay_result jsonb;
  fixture r84_runtime_ids%rowtype;
begin
  select * into fixture from r84_runtime_ids where fixture_name = 'lifecycle';

  replay_result := public.begin_user_provisioning_v2(
    fixture.idempotency_key,
    'r84_lifecycle@example.invalid',
    'R84 Lifecycle',
    'employee',
    'Operations',
    'North',
    true,
    'Lifecycle Bio',
    'Lifecycle Job'
  );

  if replay_result->>'state' <> 'EXISTING_COMPLETED'
     or (replay_result->>'intent_id')::uuid <> fixture.intent_id
     or (replay_result->>'auth_user_id')::uuid <> fixture.auth_user_id
     or (replay_result->>'attempt_count')::integer <> 3 then
    raise exception 'R84_COMPLETED_REPLAY_INVALID:%', replay_result;
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.user_provisioning_intents intent on intent.auth_user_id = profile.id
    where intent.id = fixture.intent_id
      and intent.status = 'completed'
      and profile.id = fixture.auth_user_id
      and profile.role = 'employee'
      and profile.department = 'Operations'
      and profile.region = 'North'
  ) then
    raise exception 'R84_COMPLETED_STATE_INVALID';
  end if;

  if (select count(*) from public.audit_logs audit
      where audit.action = 'user_provisioning_completed'
        and audit.entity_type = 'user_provisioning_intent'
        and audit.entity_id = fixture.intent_id) <> 1 then
    raise exception 'R84_COMPLETION_AUDIT_NOT_EXACTLY_ONCE';
  end if;
end;
$$;

-- Create legacy intents while the authenticated Super Admin actor is current.
do $$
declare
  created_id uuid;
begin
  created_id := public.create_user_provisioning_intent_v1(
    'r84_completed_consistent@example.invalid', 'Completed Consistent', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'completed_consistent', created_id,
    '84000000-0000-4000-8300-000000000001', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_pending_no_auth@example.invalid', 'Pending No Auth', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values ('pending_no_auth', created_id, null, null);

  created_id := public.create_user_provisioning_intent_v1(
    'r84_pending_match_user@example.invalid', 'Pending Match User', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'pending_match_user', created_id,
    '84000000-0000-4000-8300-000000000002', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_pending_match_app@example.invalid', 'Pending Match App', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'pending_match_app', created_id,
    '84000000-0000-4000-8300-000000000003', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_pending_no_profile@example.invalid', 'Pending No Profile', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'pending_no_profile', created_id,
    '84000000-0000-4000-8300-000000000004', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_pending_mismatch@example.invalid', 'Pending Mismatch', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'pending_mismatch', created_id,
    '84000000-0000-4000-8300-000000000005', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_pending_email_expected@example.invalid', 'Pending Email Mismatch', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'pending_email_mismatch', created_id,
    '84000000-0000-4000-8300-000000000009', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_pending_cross_locator@example.invalid', 'Pending Cross Locator', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'pending_cross_locator', created_id,
    '84000000-0000-4000-8300-000000000010', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_completed_auth_missing@example.invalid', 'Completed Auth Missing', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'completed_auth_missing', created_id,
    '84000000-0000-4000-8300-000000000099', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_completed_profile_missing@example.invalid', 'Completed Profile Missing', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'completed_profile_missing', created_id,
    '84000000-0000-4000-8300-000000000006', null
  );

  created_id := public.create_user_provisioning_intent_v1(
    'r84_ambiguous@example.invalid', 'Ambiguous Fixture', 'employee',
    'Fixture Department', 'Fixture Region', true, 'Fixture Bio', 'Fixture Job'
  );
  insert into r84_runtime_ids values (
    'ambiguous', created_id,
    '84000000-0000-4000-8300-000000000007', null
  );
end;
$$;

-- Materialize historical states which cannot be produced by the current B
-- trigger. No production routine is disabled, and origin is restored at once.
set session_replication_role = replica;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
)
select
  fixture.auth_user_id,
  case fixture.fixture_name
    when 'completed_consistent' then 'r84_completed_consistent@example.invalid'
    when 'pending_match_user' then 'r84_pending_match_user@example.invalid'
    when 'pending_match_app' then 'r84_pending_match_app@example.invalid'
    when 'pending_no_profile' then 'r84_pending_no_profile@example.invalid'
    when 'pending_mismatch' then 'r84_pending_mismatch@example.invalid'
    when 'pending_email_mismatch' then 'r84_pending_email_actual@example.invalid'
    when 'pending_cross_locator' then 'r84_pending_cross_locator@example.invalid'
    when 'completed_profile_missing' then 'r84_completed_profile_missing@example.invalid'
  end,
  pg_catalog.now(),
  case
    when fixture.fixture_name = 'pending_match_app'
      then pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', fixture.intent_id)
    when fixture.fixture_name = 'pending_cross_locator'
      then pg_catalog.jsonb_build_object(
        'quiksol_provisioning_intent_id',
        '84000000-0000-4000-9999-000000000010'
      )
    else '{}'::jsonb
  end,
  case
    when fixture.fixture_name = 'pending_match_app' then '{}'::jsonb
    else pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', fixture.intent_id)
  end
from r84_runtime_ids fixture
where fixture.fixture_name in (
  'completed_consistent',
  'pending_match_user',
  'pending_match_app',
  'pending_no_profile',
  'pending_mismatch',
  'pending_email_mismatch',
  'pending_cross_locator',
  'completed_profile_missing'
);

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
)
select
  fixture.auth_user_id,
  'r84_ambiguous_a@example.invalid',
  pg_catalog.now(),
  '{}'::jsonb,
  pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', fixture.intent_id)
from r84_runtime_ids fixture
where fixture.fixture_name = 'ambiguous';

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
)
select
  '84000000-0000-4000-8300-000000000008',
  'r84_ambiguous_b@example.invalid',
  pg_catalog.now(),
  pg_catalog.jsonb_build_object('quiksol_provisioning_intent_id', fixture.intent_id),
  '{}'::jsonb
from r84_runtime_ids fixture
where fixture.fixture_name = 'ambiguous';

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
) values (
  '84000000-0000-4000-8300-000000000090',
  'r84_historical_orphan@example.invalid',
  pg_catalog.now(),
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.profiles (
  id, full_name, email, role, department, region, bio, job_title, is_active
)
select
  fixture.auth_user_id,
  case fixture.fixture_name
    when 'completed_consistent' then 'Completed Consistent'
    when 'pending_match_user' then 'Pending Match User'
    when 'pending_match_app' then 'Pending Match App'
    when 'pending_mismatch' then 'Pending Mismatch'
    when 'pending_cross_locator' then 'Pending Cross Locator'
  end,
  case fixture.fixture_name
    when 'completed_consistent' then 'r84_completed_consistent@example.invalid'
    when 'pending_match_user' then 'r84_pending_match_user@example.invalid'
    when 'pending_match_app' then 'r84_pending_match_app@example.invalid'
    when 'pending_mismatch' then 'r84_pending_mismatch@example.invalid'
    when 'pending_cross_locator' then 'r84_pending_cross_locator@example.invalid'
  end,
  case when fixture.fixture_name = 'pending_mismatch' then 'manager' else 'employee' end,
  case when fixture.fixture_name = 'pending_mismatch'
    then 'Wrong Department' else 'Fixture Department' end,
  'Fixture Region',
  'Fixture Bio',
  'Fixture Job',
  true
from r84_runtime_ids fixture
where fixture.fixture_name in (
  'completed_consistent',
  'pending_match_user',
  'pending_match_app',
  'pending_mismatch',
  'pending_cross_locator'
);

update public.user_provisioning_intents intent
set status = 'completed',
    auth_user_id = fixture.auth_user_id,
    completed_at = pg_catalog.clock_timestamp()
from r84_runtime_ids fixture
where intent.id = fixture.intent_id
  and fixture.fixture_name in ('completed_consistent', 'completed_profile_missing');

update public.user_provisioning_intents intent
set status = 'completed',
    auth_user_id = fixture.auth_user_id,
    completed_at = pg_catalog.clock_timestamp()
from r84_runtime_ids fixture
where intent.id = fixture.intent_id
  and fixture.fixture_name = 'completed_auth_missing';

set session_replication_role = origin;

select pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

-- Preview must classify every minimum state, including both locator channels.
do $$
declare
  expected record;
  actual record;
begin
  for expected in
    select *
    from (values
      ('completed_consistent', 'COMPLETED_CONSISTENT', 'USER_METADATA'),
      ('pending_no_auth', 'PENDING_NO_AUTH', 'NONE'),
      ('pending_match_user', 'PENDING_AUTH_PROFILE_MATCH', 'USER_METADATA'),
      ('pending_match_app', 'PENDING_AUTH_PROFILE_MATCH', 'APP_METADATA'),
      ('pending_no_profile', 'PENDING_AUTH_NO_PROFILE', 'USER_METADATA'),
      ('pending_mismatch', 'PENDING_AUTH_PROFILE_MISMATCH', 'USER_METADATA'),
      ('pending_email_mismatch', 'AMBIGUOUS', 'USER_METADATA'),
      ('pending_cross_locator', 'AMBIGUOUS', 'USER_METADATA'),
      ('completed_auth_missing', 'COMPLETED_AUTH_MISSING', 'NONE'),
      ('completed_profile_missing', 'COMPLETED_PROFILE_MISSING', 'USER_METADATA'),
      ('ambiguous', 'AMBIGUOUS', 'NONE')
    ) as expected_values(fixture_name, classification, locator_channel)
  loop
    select preview.*
    into actual
    from r84_runtime_ids fixture
    cross join lateral public.preview_user_provisioning_reconciliation_v1(fixture.intent_id) preview
    where fixture.fixture_name = expected.fixture_name;

    if not found
       or actual.classification is distinct from expected.classification
       or actual.locator_channel is distinct from expected.locator_channel then
      raise exception 'R84_RECONCILIATION_CLASSIFICATION_INVALID:%:%:%',
        expected.fixture_name,
        coalesce(actual.classification, '<missing>'),
        coalesce(actual.locator_channel, '<missing>');
    end if;
  end loop;
end;
$$;

-- Exact historical match reconciles once; second apply is idempotent.
do $$
declare
  target_fixture r84_runtime_ids%rowtype;
  first_apply jsonb;
  second_apply jsonb;
  mismatch_rejected boolean := false;
  email_mismatch_rejected boolean := false;
  cross_locator_rejected boolean := false;
  pending_result jsonb;
begin
  select * into target_fixture
  from r84_runtime_ids where fixture_name = 'pending_match_app';

  first_apply := public.reconcile_user_provisioning_intent_v1(
    target_fixture.intent_id,
    '84000000-0000-4000-8000-000000000001',
    'R84 disposable exact-match reconciliation proof'
  );
  second_apply := public.reconcile_user_provisioning_intent_v1(
    target_fixture.intent_id,
    '84000000-0000-4000-8000-000000000001',
    'R84 disposable exact-match reconciliation proof'
  );

  if first_apply->>'state' <> 'RECONCILED'
     or second_apply->>'state' <> 'ALREADY_COMPLETED'
     or (first_apply->>'auth_user_id')::uuid <> target_fixture.auth_user_id
     or (second_apply->>'auth_user_id')::uuid <> target_fixture.auth_user_id then
    raise exception 'R84_RECONCILIATION_NOT_IDEMPOTENT:%:%', first_apply, second_apply;
  end if;

  if (select count(*) from public.audit_logs audit
      where audit.action = 'user_provisioning_reconciled'
        and audit.entity_type = 'user_provisioning_intent'
        and audit.entity_id = target_fixture.intent_id) <> 1 then
    raise exception 'R84_RECONCILIATION_AUDIT_NOT_EXACTLY_ONCE';
  end if;

  select * into target_fixture
  from r84_runtime_ids where fixture_name = 'pending_mismatch';
  begin
    perform public.reconcile_user_provisioning_intent_v1(
      target_fixture.intent_id,
      '84000000-0000-4000-8000-000000000001',
      'R84 mismatch must not mutate'
    );
  exception when sqlstate 'QS846' then
    mismatch_rejected := true;
  end;

  if not mismatch_rejected
     or not exists (
       select 1 from public.user_provisioning_intents intent
       where intent.id = target_fixture.intent_id
         and intent.status = 'pending'
         and intent.auth_user_id is null
         and intent.completed_at is null
     ) then
    raise exception 'R84_MISMATCH_MUTATED_OR_ACCEPTED';
  end if;

  select * into target_fixture
  from r84_runtime_ids where fixture_name = 'pending_email_mismatch';
  begin
    perform public.reconcile_user_provisioning_intent_v1(
      target_fixture.intent_id,
      '84000000-0000-4000-8000-000000000001',
      'R84 email mismatch must not mutate'
    );
  exception when sqlstate 'QS846' then
    email_mismatch_rejected := true;
  end;

  if not email_mismatch_rejected
     or not exists (
       select 1 from public.user_provisioning_intents intent
       where intent.id = target_fixture.intent_id
         and intent.status = 'pending'
         and intent.auth_user_id is null
         and intent.completed_at is null
     ) then
    raise exception 'R84_EMAIL_MISMATCH_MUTATED_OR_ACCEPTED';
  end if;

  select * into target_fixture
  from r84_runtime_ids where fixture_name = 'pending_cross_locator';
  begin
    perform public.reconcile_user_provisioning_intent_v1(
      target_fixture.intent_id,
      '84000000-0000-4000-8000-000000000001',
      'R84 cross-locator conflict must not mutate'
    );
  exception when sqlstate 'QS846' then
    cross_locator_rejected := true;
  end;

  if not cross_locator_rejected
     or not exists (
       select 1 from public.user_provisioning_intents intent
       where intent.id = target_fixture.intent_id
         and intent.status = 'pending'
         and intent.auth_user_id is null
         and intent.completed_at is null
     ) then
    raise exception 'R84_CROSS_LOCATOR_MUTATED_OR_ACCEPTED';
  end if;

  select * into target_fixture
  from r84_runtime_ids where fixture_name = 'pending_no_auth';
  pending_result := public.reconcile_user_provisioning_intent_v1(
    target_fixture.intent_id,
    '84000000-0000-4000-8000-000000000001',
    'R84 pending without Auth remains retryable'
  );

  if pending_result->>'state' <> 'NO_CHANGE'
     or pending_result->>'code' <> 'PROVISIONING_RETRYABLE'
     or not exists (
       select 1 from public.user_provisioning_intents intent
       where intent.id = target_fixture.intent_id
         and intent.status = 'pending'
         and intent.auth_user_id is null
         and intent.completed_at is null
     ) then
    raise exception 'R84_PENDING_NO_AUTH_MUTATED:%', pending_result;
  end if;
end;
$$;

-- Historical orphan preview exposes only a technical UUID/classification/time
-- and cannot create a Profile or route to an orphan repair function.
do $$
begin
  if not exists (
    select 1
    from public.preview_auth_profile_orphans_v1() orphan
    where orphan.technical_auth_user_id = '84000000-0000-4000-8300-000000000090'
      and orphan.classification = 'HISTORICAL_AUTH_NO_PROFILE_NO_INTENT'
  ) then
    raise exception 'R84_HISTORICAL_ORPHAN_NOT_DIAGNOSED';
  end if;

  if exists (
    select 1 from public.profiles
    where id = '84000000-0000-4000-8300-000000000090'
  ) then
    raise exception 'R84_HISTORICAL_ORPHAN_AUTO_REPAIRED';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and routine.proname ~* '(repair.*orphan|orphan.*repair)'
  ) then
    raise exception 'R84_ORPHAN_REPAIR_SURFACE_UNEXPECTED';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc routine
    cross join lateral unnest(coalesce(routine.proallargtypes, routine.proargtypes::oid[]))
      with ordinality argument_type(type_oid, ordinal_position)
    cross join lateral unnest(coalesce(routine.proargnames, '{}'::text[]))
      with ordinality argument_name(name, ordinal_position)
    where routine.oid = 'public.preview_auth_profile_orphans_v1()'::regprocedure
      and argument_type.ordinal_position = argument_name.ordinal_position
      and pg_catalog.lower(argument_name.name) like '%email%'
  ) then
    raise exception 'R84_ORPHAN_PREVIEW_EXPOSES_EMAIL';
  end if;
end;
$$;

-- Reproducible plan/timing evidence for the two locator channels and a warm,
-- targeted reconciliation preview. auth.users is Supabase-managed, so a
-- sequential read is expected and accepted here; R8.4 must not add an index
-- merely to force this administrative lookup onto an index plan.
explain (analyze, buffers, timing, summary)
select auth_user.id
from auth.users auth_user
where nullif(
    pg_catalog.btrim(auth_user.raw_user_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = '84000000-0000-4000-9999-000000000099'
   or nullif(
    pg_catalog.btrim(auth_user.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  ) = '84000000-0000-4000-9999-000000000099';

explain (analyze, buffers, timing, summary)
select preview.*
from r84_runtime_ids fixture
cross join lateral public.preview_user_provisioning_reconciliation_v1(fixture.intent_id) preview
where fixture.fixture_name = 'pending_no_auth';

select
  (select count(*) from public.user_provisioning_intents
   where idempotency_key is not null) as r84_idempotent_intents,
  (select count(*) from public.audit_logs
   where action = 'user_provisioning_completed') as completion_audits,
  (select count(*) from public.audit_logs
   where action = 'user_provisioning_reconciled') as reconciliation_audits;

select 'USER_PROVISIONING_R84_RUNTIME_PASS' as result;
