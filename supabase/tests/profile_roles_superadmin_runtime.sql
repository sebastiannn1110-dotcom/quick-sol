-- Run only against a disposable local Supabase database after applying
-- 20260822120000_harden_profile_roles_and_superadmin_inheritance.sql.
-- All synthetic writes are rolled back.
begin;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values
  (
    'd2000000-0000-4000-8000-000000000001',
    'employee-role-contract@example.invalid',
    pg_catalog.now(),
    '{"full_name":"Employee Contract","role":"super_admin_dev","department":"Forged","region":"Forged"}'::jsonb
  ),
  (
    'd2000000-0000-4000-8000-000000000002',
    'manager-role-contract@example.invalid',
    pg_catalog.now(),
    '{"full_name":"Manager Contract","role":"admin"}'::jsonb
  ),
  (
    'd2000000-0000-4000-8000-000000000003',
    'admin-role-contract@example.invalid',
    pg_catalog.now(),
    '{"full_name":"Admin Contract","role":"manager"}'::jsonb
  ),
  (
    'd2000000-0000-4000-8000-000000000004',
    'superadmin-role-contract@example.invalid',
    pg_catalog.now(),
    '{"full_name":"Superadmin Contract","role":"super_admin_dev"}'::jsonb
  ),
  (
    'd2000000-0000-4000-8000-000000000005',
    'target-role-contract@example.invalid',
    pg_catalog.now(),
    '{"full_name":"Target Contract"}'::jsonb
  ),
  (
    'd2000000-0000-4000-8000-000000000006',
    'privileged-target-contract@example.invalid',
    pg_catalog.now(),
    '{"full_name":"Privileged Target Contract"}'::jsonb
  );

do $$
begin
  if exists (
    select 1
    from public.profiles profile
    where profile.id in (
      'd2000000-0000-4000-8000-000000000001',
      'd2000000-0000-4000-8000-000000000002',
      'd2000000-0000-4000-8000-000000000003',
      'd2000000-0000-4000-8000-000000000004'
    )
      and (
        profile.role <> 'employee'
        or profile.department is not null
        or profile.region is not null
      )
  ) then
    raise exception 'SIGNUP_METADATA_ASSIGNED_AUTHORIZATION';
  end if;
end;
$$;

-- Establish synthetic actors as the trusted database owner. This is fixture
-- setup, not the path under test.
update public.profiles set role = 'manager', department = 'North' where id = 'd2000000-0000-4000-8000-000000000002';
update public.profiles set role = 'admin' where id = 'd2000000-0000-4000-8000-000000000003';
update public.profiles set role = 'super_admin_dev' where id in (
  'd2000000-0000-4000-8000-000000000004',
  'd2000000-0000-4000-8000-000000000006'
);

insert into public.opportunity_finder_tenant_memberships (tenant_id, user_id, membership_role)
values
  ('d2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002', 'admin'),
  ('d2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000003', 'admin'),
  ('d2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000004', 'admin')
on conflict (tenant_id, user_id) do update set membership_role = excluded.membership_role;

-- Employee: self visibility remains; role and administrative RPC are denied.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd2000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  denied boolean := false;
begin
  if public.is_admin() or public.can_manage_clients() or public.is_super_admin_dev() then
    raise exception 'EMPLOYEE_GAINED_ADMIN_CAPABILITY';
  end if;
  if (select count(*) from public.profiles) <> 1 then
    raise exception 'EMPLOYEE_PROFILE_SCOPE_CHANGED';
  end if;
  begin
    update public.profiles
    set role = 'admin'
    where id = auth.uid();
  exception when sqlstate '42501' then
    denied := true;
  end;
  if not denied then raise exception 'EMPLOYEE_DIRECT_ROLE_UPDATE_ALLOWED'; end if;
  denied := false;
  begin
    perform public.update_profile_admin_v1(
      'd2000000-0000-4000-8000-000000000005',
      '{"role":"admin"}'::jsonb
    );
  exception when sqlstate '42501' then
    denied := true;
  end;
  if not denied then raise exception 'EMPLOYEE_ADMIN_RPC_ALLOWED'; end if;
end;
$$;

reset role;

-- Manager: existing client-management capability remains, but profile
-- security and Opportunity Finder tenant-admin remain denied.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd2000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  denied boolean := false;
begin
  if public.is_admin() or public.is_super_admin_dev() or not public.can_manage_clients() then
    raise exception 'MANAGER_CAPABILITY_REGRESSION';
  end if;
  if public.is_opportunity_finder_tenant_admin('d2000000-0000-4000-8000-000000000001') then
    raise exception 'MANAGER_GAINED_OF_TENANT_ADMIN';
  end if;
  begin
    update public.profiles
    set role = 'admin'
    where id = auth.uid();
  exception when sqlstate '42501' then
    denied := true;
  end;
  if not denied then raise exception 'MANAGER_DIRECT_ROLE_UPDATE_ALLOWED'; end if;
end;
$$;

reset role;

-- Admin: admin and clients/OF capabilities remain. Direct security writes,
-- privileged promotion and all edits of Super Admin Dev are denied.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd2000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  denied boolean := false;
  changed_rows bigint;
begin
  if not public.is_admin() or public.is_super_admin_dev() or not public.can_manage_clients() then
    raise exception 'ADMIN_CAPABILITY_REGRESSION';
  end if;
  if not public.is_opportunity_finder_tenant_admin('d2000000-0000-4000-8000-000000000001') then
    raise exception 'ADMIN_OF_TENANT_ADMIN_MISSING';
  end if;

  update public.profiles
  set full_name = 'Target Contract Updated'
  where id = 'd2000000-0000-4000-8000-000000000005';
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception 'ADMIN_PUBLIC_PROFILE_UPDATE_REGRESSION'; end if;

  update public.profiles
  set full_name = 'Forbidden Privileged Edit'
  where id = 'd2000000-0000-4000-8000-000000000006';
  get diagnostics changed_rows = row_count;
  if changed_rows <> 0 then raise exception 'ADMIN_MODIFIED_SUPERADMIN_PROFILE'; end if;

  begin
    update public.profiles
    set role = 'super_admin_dev'
    where id = 'd2000000-0000-4000-8000-000000000005';
  exception when sqlstate '42501' then
    denied := true;
  end;
  if not denied then raise exception 'ADMIN_DIRECT_SUPERADMIN_PROMOTION_ALLOWED'; end if;

  denied := false;
  begin
    perform public.update_profile_admin_v1(
      'd2000000-0000-4000-8000-000000000005',
      '{"role":"super_admin_dev"}'::jsonb
    );
  exception when sqlstate '42501' then
    denied := true;
  end;
  if not denied then raise exception 'ADMIN_RPC_SUPERADMIN_PROMOTION_ALLOWED'; end if;

  denied := false;
  begin
    perform public.update_profile_admin_v1(
      'd2000000-0000-4000-8000-000000000006',
      '{"department":"Forbidden"}'::jsonb
    );
  exception when sqlstate '42501' then
    denied := true;
  end;
  if not denied then raise exception 'ADMIN_RPC_MODIFIED_SUPERADMIN'; end if;

  perform public.update_profile_admin_v1(
    'd2000000-0000-4000-8000-000000000005',
    '{"role":"manager","department":"North"}'::jsonb
  );
end;
$$;

reset role;

-- Super Admin Dev: inherits every admin capability, retains the exclusive
-- gate, respects tenant membership, and can use the audited privileged RPC.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd2000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  if not public.is_admin()
     or not public.is_super_admin_dev()
     or not public.can_manage_clients() then
    raise exception 'SUPERADMIN_DID_NOT_INHERIT_ADMIN';
  end if;
  if not public.is_opportunity_finder_tenant_admin('d2000000-0000-4000-8000-000000000001') then
    raise exception 'SUPERADMIN_OF_TENANT_ADMIN_MISSING';
  end if;
  if public.is_opportunity_finder_tenant_admin('d2000000-0000-4000-8000-000000000005') then
    raise exception 'SUPERADMIN_BYPASSED_OF_TENANT_MEMBERSHIP';
  end if;

  perform public.update_profile_admin_v1(
    'd2000000-0000-4000-8000-000000000005',
    '{"role":"super_admin_dev","department":"Privileged"}'::jsonb
  );

  if not exists (
    select 1
    from public.audit_logs audit
    where audit.actor_id = auth.uid()
      and audit.entity_id = 'd2000000-0000-4000-8000-000000000005'
      and audit.action = 'superadmin_managed_privileged_profile'
  ) then
    raise exception 'SUPERADMIN_PRIVILEGED_TRANSITION_NOT_AUDITED';
  end if;
end;
$$;

reset role;

-- Storage authorization inherits through the corrected helpers. Membership-
-- and ownership-based buckets intentionally remain independent of global role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'excel_uploads_select_own_or_admin'
      and qual like '%is_admin%'
  ) then raise exception 'EXCEL_STORAGE_ADMIN_CONTRACT_CHANGED'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'client_assets_insert_manager'
      and with_check like '%can_manage_clients%'
  ) then raise exception 'CLIENT_STORAGE_ADMIN_CONTRACT_CHANGED'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'email_attachments_storage_select_admin'
      and qual like '%is_admin%'
  ) then raise exception 'EMAIL_STORAGE_ADMIN_CONTRACT_CHANGED'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'chat_attachments_storage_select_member'
      and qual like '%is_conversation_member%'
  ) then raise exception 'CHAT_STORAGE_MEMBERSHIP_CONTRACT_CHANGED'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'avatars_update_own'
      and qual like '%auth.uid%'
  ) then raise exception 'AVATAR_STORAGE_OWNER_CONTRACT_CHANGED'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'opportunity_finder_storage_insert_own'
      and with_check like '%auth.uid%'
  ) then raise exception 'OF_STORAGE_OWNER_CONTRACT_CHANGED'; end if;
end;
$$;

rollback;
