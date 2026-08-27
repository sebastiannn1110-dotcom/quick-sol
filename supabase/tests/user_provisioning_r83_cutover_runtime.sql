-- R8.3 A/B compatibility proof in one disposable database. This is the only
-- test that activates the separately staged R8.3B release gate.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R83_USER_PROVISIONING_TEST_DATABASE';
  end if;
  if public.user_provisioning_intent_required_v1() is distinct from false then
    raise exception 'R83A_COMPATIBILITY_GATE_NOT_FALSE';
  end if;
end;
$$;

-- Bootstrap one effective Super Admin Dev through the exact R8.1-compatible
-- path. All addresses are local disposable fixtures under .invalid.
insert into auth.users (
  id, email, email_confirmed_at, banned_until, raw_app_meta_data, raw_user_meta_data
) values (
  '83000000-0000-4000-8000-000000000001',
  'r83_actor@example.invalid',
  pg_catalog.now(),
  null,
  '{}'::jsonb,
  '{"full_name":"R83 Actor"}'::jsonb
);

update public.profiles
set role = 'super_admin_dev', department = 'Security', region = 'Test'
where id = '83000000-0000-4000-8000-000000000001';

-- Matrix: old application + DB A. The old second upsert remains operational
-- during A, even though the trigger first creates the least-privileged row.
insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
) values (
  '83000000-0000-4000-8000-000000000010',
  'r83_old_a@example.invalid',
  pg_catalog.now(),
  '{}'::jsonb,
  '{"full_name":"Old App A"}'::jsonb
);

insert into public.profiles (id, full_name, email, role, department, region, is_active)
values (
  '83000000-0000-4000-8000-000000000010',
  'Old App A',
  'r83_old_a@example.invalid',
  'manager',
  'Legacy',
  'Test',
  true
)
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email,
    role = excluded.role,
    department = excluded.department,
    region = excluded.region,
    is_active = excluded.is_active;

do $$
declare
  created_intent uuid;
begin
  if not exists (
    select 1 from public.profiles
    where id = '83000000-0000-4000-8000-000000000010'
      and role = 'manager'
      and department = 'Legacy'
  ) then
    raise exception 'R83_OLD_APP_DB_A_FAILED';
  end if;

  -- Matrix: new application + DB A.
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '83000000-0000-4000-8000-000000000001',
    false
  );
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

  created_intent := public.create_user_provisioning_intent_v1(
    'R83_New_A@Example.Invalid',
    'New App A',
    'admin',
    'Operations',
    'North',
    true,
    'Atomic profile A',
    'Administrator'
  );

  insert into auth.users (
    id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
  ) values (
    '83000000-0000-4000-8000-000000000011',
    'r83_new_a@example.invalid',
    pg_catalog.now(),
    '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'quiksol_provisioning_intent_id', created_intent,
      'full_name', 'tampered',
      'role', 'super_admin_dev',
      'department', 'evil',
      'is_active', false
    )
  );

  if not exists (
    select 1
    from public.profiles profile
    join public.user_provisioning_intents intent
      on intent.auth_user_id = profile.id
    where profile.id = '83000000-0000-4000-8000-000000000011'
      and profile.email = 'r83_new_a@example.invalid'
      and profile.full_name = 'New App A'
      and profile.role = 'admin'
      and profile.department = 'Operations'
      and profile.region = 'North'
      and profile.bio = 'Atomic profile A'
      and profile.job_title = 'Administrator'
      and profile.is_active is true
      and intent.id = created_intent
      and intent.status = 'completed'
      and intent.completed_at is not null
  ) then
    raise exception 'R83_NEW_APP_DB_A_FAILED';
  end if;
end;
$$;

-- Deliberately separate operational step: never part of automatic migrations.
\ir ../release-gates/20260827190000_enforce_user_provisioning_intents_r83b.sql

do $$
declare
  created_intent uuid;
  rejected boolean := false;
begin
  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R83B_GATE_NOT_TRUE';
  end if;

  -- Matrix: new application + DB B.
  created_intent := public.create_user_provisioning_intent_v1(
    'r83_new_b@example.invalid',
    'New App B',
    'admin',
    'Operations',
    'South',
    true,
    null,
    null
  );

  insert into auth.users (
    id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
  ) values (
    '83000000-0000-4000-8000-000000000012',
    'r83_new_b@example.invalid',
    pg_catalog.now(),
    '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'quiksol_provisioning_intent_id', created_intent,
      'role', 'super_admin_dev',
      'department', 'evil',
      'is_active', false
    )
  );

  if not exists (
    select 1
    from public.profiles profile
    join public.user_provisioning_intents intent on intent.auth_user_id = profile.id
    where profile.id = '83000000-0000-4000-8000-000000000012'
      and profile.role = 'admin'
      and profile.department = 'Operations'
      and intent.id = created_intent
      and intent.status = 'completed'
  ) then
    raise exception 'R83_NEW_APP_DB_B_FAILED';
  end if;

  -- Matrix: old application + DB B is intentionally incompatible and must
  -- fail closed before either Auth or Profile can persist.
  begin
    insert into auth.users (
      id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
    ) values (
      '83000000-0000-4000-8000-000000000013',
      'r83_old_b@example.invalid',
      pg_catalog.now(),
      '{}'::jsonb,
      '{"full_name":"Old App B"}'::jsonb
    );
  exception when sqlstate 'QS831' then
    rejected := true;
  end;

  if not rejected
     or exists (select 1 from auth.users where id = '83000000-0000-4000-8000-000000000013')
     or exists (select 1 from public.profiles where id = '83000000-0000-4000-8000-000000000013') then
    raise exception 'R83_OLD_APP_DB_B_NOT_REJECTED_ATOMICALLY';
  end if;
end;
$$;

select 'USER_PROVISIONING_R83_CUTOVER_PASS' as result,
  public.user_provisioning_intent_required_v1() as intent_required,
  (select count(*) from public.user_provisioning_intents where status = 'completed') as completed_intents;
