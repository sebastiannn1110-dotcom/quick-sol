-- PREPARED ONLY. DO NOT RUN UNTIL THE REMOTE CLEANUP IS EXPLICITLY APPROVED.
-- Exact target: project niaqaiiiphjfcysmxeqj, QUIKSOL_DEMO_DATA_V1 only.
-- The transaction aborts on identity drift or on any unreviewed FK dependency.

begin;

create temporary table demo_employee_keep_allowlist (
  id uuid primary key,
  email text not null unique,
  full_name text not null unique,
  is_owner boolean not null default false
) on commit drop;

insert into demo_employee_keep_allowlist (id, email, full_name, is_owner) values
  ('558ea357-446a-4233-9057-727d0dd19798', 'olivia.mercer@quiksol.demo.invalid', 'Olivia Mercer — DEMO', false),
  ('b660eb04-615b-4627-bc54-f824e207d6a3', 'user.test.demo.com@demo.invalid', 'user.test.demo.com', true),
  ('bcbda603-4cbc-4e47-90de-cc50b56b5535', 'daniel.brooks@quiksol.demo.invalid', 'Daniel Brooks — DEMO', false),
  ('4b5a97cd-a381-4e14-8b8e-e1628c575253', 'maya.torres@quiksol.demo.invalid', 'Maya Torres — DEMO', false),
  ('c6cf16c7-21f1-420e-bd2a-5b393a65b5eb', 'jordan.lee@quiksol.demo.invalid', 'Jordan Lee — DEMO', false),
  ('de7cd5ba-aa99-4882-b651-ccefb6169ef5', 'sofia.ramirez@quiksol.demo.invalid', 'Sofia Ramirez — DEMO', false),
  ('7483bf29-d42f-4d33-9523-30038a0de235', 'lucas.almeida@quiksol.demo.invalid', 'Lucas Almeida — DEMO', false),
  ('3c2b4c81-808f-4165-9d3e-05ca2aac2672', 'emma.clarke@quiksol.demo.invalid', 'Emma Clarke — DEMO', false),
  ('4bf30ed2-f1ea-4403-b10d-6329bd27cac4', 'priya.nair@quiksol.demo.invalid', 'Priya Nair — DEMO', false),
  ('03ac4ac3-46e7-459c-87fd-69a4a5964318', 'ethan.tan@quiksol.demo.invalid', 'Ethan Tan — DEMO', false),
  ('2d9b20d3-7940-4b2e-8582-0db32ed4d15a', 'li.na@quiksol.demo.invalid', 'Li Na — DEMO', false),
  ('22570a70-866d-4f87-a0c2-b408df6aea06', 'haruto.sato@quiksol.demo.invalid', 'Haruto Sato — DEMO', false),
  ('686dd95d-7b82-4a02-9418-870dae247c5a', 'minjun.park@quiksol.demo.invalid', 'Min-jun Park — DEMO', false),
  ('a3c2e266-37ac-4268-8ceb-082382273484', 'chloe.wilson@quiksol.demo.invalid', 'Chloe Wilson — DEMO', false),
  ('fd591788-8479-45e9-aecd-48b7d6e61d75', 'lukas.weber@quiksol.demo.invalid', 'Lukas Weber — DEMO', false),
  ('85581b02-28cf-49f0-ab7c-1723d3dc562f', 'hannah.fischer@quiksol.demo.invalid', 'Hannah Fischer — DEMO', false),
  ('e3b1d6b9-ea11-4765-9eb9-848393b28890', 'camille.laurent@quiksol.demo.invalid', 'Camille Laurent — DEMO', false),
  ('0c110410-86b9-4e31-995b-9128bbf29fc8', 'oliver.bennett@quiksol.demo.invalid', 'Oliver Bennett — DEMO', false),
  ('ce3730d4-c66b-448b-8aee-3a9262818987', 'lucia.garcia@quiksol.demo.invalid', 'Lucia Garcia — DEMO', false),
  ('e4c668b7-820a-4178-9cc0-7056b07224df', 'lin.wei@quiksol.demo.invalid', 'Lin Wei — DEMO', false);

create temporary table demo_employee_remove_allowlist (
  id uuid primary key,
  email text not null unique,
  full_name text not null unique,
  replacement_id uuid not null references demo_employee_keep_allowlist(id)
) on commit drop;

insert into demo_employee_remove_allowlist (id, email, full_name, replacement_id) values
  ('d1e452b6-9646-45ed-9b56-5f93784bcdcc', 'aya.nakamura@quiksol.demo.invalid', 'Aya Nakamura — DEMO', 'e4c668b7-820a-4178-9cc0-7056b07224df'),
  ('6916b768-2c4f-4317-a457-eeacbd0b72bc', 'chen.rui@quiksol.demo.invalid', 'Chen Rui — DEMO', 'e4c668b7-820a-4178-9cc0-7056b07224df'),
  ('bb4412b9-2c57-45d4-9f58-b0f8bca46a4d', 'wei.ming@quiksol.demo.invalid', 'Wei Ming — DEMO', 'e4c668b7-820a-4178-9cc0-7056b07224df'),
  ('2ed15341-e577-4e2e-92f3-15dd7f3c9d09', 'zhao.lian@quiksol.demo.invalid', 'Zhao Lian — DEMO', 'e4c668b7-820a-4178-9cc0-7056b07224df'),
  ('fdec5eae-ff47-4a0b-804e-e3c0c423a76b', 'mei.chen@quiksol.demo.invalid', 'Mei Chen — DEMO', 'e4c668b7-820a-4178-9cc0-7056b07224df'),
  ('2d4502dc-d872-4152-8bc5-a4d832518b79', 'yuki.tanaka@quiksol.demo.invalid', 'Yuki Tanaka — DEMO', 'e4c668b7-820a-4178-9cc0-7056b07224df'),
  ('4d064756-de2a-41ad-ac5b-53fc28a69adc', 'noah.williams@quiksol.demo.invalid', 'Noah Williams — DEMO', '558ea357-446a-4233-9057-727d0dd19798'),
  ('dfc3d326-7869-4f24-8e28-303531cc3662', 'isabella.rossi@quiksol.demo.invalid', 'Isabella Rossi — DEMO', '558ea357-446a-4233-9057-727d0dd19798');

do $$
declare
  invalid_count integer;
  fk record;
  has_rows boolean;
  remove_ids uuid[];
begin
  select array_agg(id order by id) into remove_ids from demo_employee_remove_allowlist;

  select count(*) into invalid_count
  from demo_employee_keep_allowlist expected
  left join public.profiles profile
    on profile.id = expected.id
   and lower(profile.email) = expected.email
   and profile.full_name = expected.full_name
   and profile.bio = 'QUIKSOL_DEMO_DATA_V1'
   and profile.is_active = true
   and (
     (expected.is_owner and profile.role = 'admin' and profile.business_rank = 'owner' and profile.avatar_path is null)
     or
     (not expected.is_owner and profile.avatar_path is not null)
   )
  where profile.id is null;
  if invalid_count <> 0 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_KEEP_IDENTITY_DRIFT: %', invalid_count;
  end if;

  select count(*) into invalid_count
  from demo_employee_remove_allowlist expected
  left join public.profiles profile
    on profile.id = expected.id
   and lower(profile.email) = expected.email
   and profile.full_name = expected.full_name
   and profile.bio = 'QUIKSOL_DEMO_DATA_V1'
  where profile.id is null;
  if invalid_count <> 0 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_REMOVE_IDENTITY_DRIFT: %', invalid_count;
  end if;

  select count(*) into invalid_count
  from demo_employee_remove_allowlist expected
  left join auth.users auth_user
    on auth_user.id = expected.id
   and lower(auth_user.email) = expected.email
   and auth_user.raw_user_meta_data ->> 'quiksol_demo_seed' = 'QUIKSOL_DEMO_DATA_V1'
  where auth_user.id is null;
  if invalid_count <> 0 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_AUTH_IDENTITY_DRIFT: %', invalid_count;
  end if;

  select count(*) into invalid_count
  from demo_employee_remove_allowlist expected
  left join public.user_provisioning_intents intent
    on intent.auth_user_id = expected.id
   and intent.status = 'completed'
   and intent.requested_bio = 'QUIKSOL_DEMO_DATA_V1'
  where intent.id is null;
  if invalid_count <> 0 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_PROVISIONING_INTENT_DRIFT: %', invalid_count;
  end if;

  select count(*) into invalid_count
  from public.profiles profile
  where profile.bio = 'QUIKSOL_DEMO_DATA_V1'
    and not exists (select 1 from demo_employee_keep_allowlist expected where expected.id = profile.id)
    and not exists (select 1 from demo_employee_remove_allowlist expected where expected.id = profile.id);
  if invalid_count <> 0 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_UNEXPECTED_SEED_PROFILE: %', invalid_count;
  end if;

  if (select count(*) from public.profiles where bio = 'QUIKSOL_DEMO_DATA_V1') <> 28 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_EXPECTED_28_SEED_PROFILES';
  end if;
  if (select count(*) from public.clients where external_customer_id like 'DEMO-%' and status = 'active' and archived_at is null) <> 19 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_EXPECTED_19_CLIENTS';
  end if;

  -- Discover the live FK graph. Only the four relationships proven by the
  -- read-only audit may contain REMOVE ids; any new dependency aborts.
  for fk in
    select
      source_ns.nspname as source_schema,
      source_table.relname as source_table,
      source_column.attname as source_column,
      target_ns.nspname as target_schema,
      target_table.relname as target_table
    from pg_constraint constraint_row
    join pg_class source_table on source_table.oid = constraint_row.conrelid
    join pg_namespace source_ns on source_ns.oid = source_table.relnamespace
    join pg_class target_table on target_table.oid = constraint_row.confrelid
    join pg_namespace target_ns on target_ns.oid = target_table.relnamespace
    join lateral unnest(constraint_row.conkey) with ordinality source_key(attnum, position) on true
    join lateral unnest(constraint_row.confkey) with ordinality target_key(attnum, position)
      on target_key.position = source_key.position
    join pg_attribute source_column
      on source_column.attrelid = source_table.oid and source_column.attnum = source_key.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid in (
        'auth.users'::regclass,
        'public.profiles'::regclass,
        'public.organization_members'::regclass
      )
  loop
    execute format(
      'select exists (select 1 from %I.%I where %I = any ($1))',
      fk.source_schema,
      fk.source_table,
      fk.source_column
    ) into has_rows using remove_ids;

    if has_rows and format('%s.%s.%s', fk.source_schema, fk.source_table, fk.source_column) not in (
      'public.opportunity_finder_tenants.created_by',
      'public.opportunity_finder_tenant_memberships.user_id',
      'public.organization_members.profile_id',
      'public.employee_compensation.employee_id',
      'public.profiles.id',
      'public.user_provisioning_intents.auth_user_id'
    ) then
      raise exception 'DEMO_EMPLOYEE_CLEANUP_UNREVIEWED_FK: %.%.%',
        fk.source_schema, fk.source_table, fk.source_column;
    end if;
  end loop;

  if exists (select 1 from public.password_reset_codes where user_id = any (remove_ids)) then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_PASSWORD_RESET_DEPENDENCY';
  end if;
end
$$;

-- Preserve each empty personal Opportunity Finder tenant. Only ownership and
-- membership are moved; no job, dataset, file, result, or commercial row changes.
insert into public.opportunity_finder_tenant_memberships (tenant_id, user_id, membership_role)
select tenant.id, removal.replacement_id, 'owner'
from public.opportunity_finder_tenants tenant
join demo_employee_remove_allowlist removal on removal.id = tenant.created_by
on conflict (tenant_id, user_id) do update set membership_role = excluded.membership_role;

update public.opportunity_finder_tenants tenant
set created_by = removal.replacement_id
from demo_employee_remove_allowlist removal
where tenant.created_by = removal.id;

delete from public.opportunity_finder_tenant_memberships membership
using demo_employee_remove_allowlist removal
where membership.user_id = removal.id;

-- A completed provisioning intent cannot retain its lifecycle invariant after
-- its Auth user is removed. Delete only the eight exact seed-owned intents.
delete from public.user_provisioning_intents intent
using demo_employee_remove_allowlist removal
where intent.auth_user_id = removal.id
  and intent.status = 'completed'
  and intent.requested_bio = 'QUIKSOL_DEMO_DATA_V1';

delete from public.employee_compensation compensation
using demo_employee_remove_allowlist removal
where compensation.employee_id = removal.id;

-- The owner remains the technical root, but is not an employee and therefore
-- does not keep an employee-compensation row in the consolidated dataset.
delete from public.employee_compensation
where employee_id = 'b660eb04-615b-4627-bc54-f824e207d6a3';

delete from public.organization_members member
using demo_employee_remove_allowlist removal
where member.profile_id = removal.id;

delete from public.profiles profile
using demo_employee_remove_allowlist removal
where profile.id = removal.id
  and lower(profile.email) = removal.email
  and profile.full_name = removal.full_name
  and profile.bio = 'QUIKSOL_DEMO_DATA_V1';

delete from auth.users auth_user
using demo_employee_remove_allowlist removal
where auth_user.id = removal.id
  and lower(auth_user.email) = removal.email
  and auth_user.raw_user_meta_data ->> 'quiksol_demo_seed' = 'QUIKSOL_DEMO_DATA_V1';

do $$
begin
  if (select count(*) from public.profiles where bio = 'QUIKSOL_DEMO_DATA_V1') <> 20 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_FINAL_SEED_PROFILE_COUNT';
  end if;
  if (select count(*) from public.profiles profile join demo_employee_keep_allowlist keep on keep.id = profile.id where not keep.is_owner) <> 19 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_FINAL_VISIBLE_EMPLOYEE_COUNT';
  end if;
  if (select count(*) from public.employee_compensation compensation join demo_employee_keep_allowlist keep on keep.id = compensation.employee_id where not keep.is_owner) <> 19
     or exists (select 1 from public.employee_compensation where employee_id = 'b660eb04-615b-4627-bc54-f824e207d6a3') then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_FINAL_COMPENSATION_COUNT';
  end if;
  if exists (select 1 from public.profiles profile join demo_employee_remove_allowlist removal on removal.id = profile.id) then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_PROFILE_DELETE_INCOMPLETE';
  end if;
  if exists (select 1 from auth.users auth_user join demo_employee_remove_allowlist removal on removal.id = auth_user.id) then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_AUTH_DELETE_INCOMPLETE';
  end if;
  if exists (select 1 from public.user_provisioning_intents intent join demo_employee_remove_allowlist removal on removal.id = intent.auth_user_id) then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_PROVISIONING_INTENT_DELETE_INCOMPLETE';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = 'b660eb04-615b-4627-bc54-f824e207d6a3'
      and profile.email = 'user.test.demo.com@demo.invalid'
      and profile.role = 'admin'
      and profile.business_rank = 'owner'
  ) then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_OWNER_NOT_PRESERVED';
  end if;
  if (select count(*) from public.clients where external_customer_id like 'DEMO-%' and status = 'active' and archived_at is null) <> 19 then
    raise exception 'DEMO_EMPLOYEE_CLEANUP_CLIENT_COUNT_CHANGED';
  end if;
end
$$;

commit;
