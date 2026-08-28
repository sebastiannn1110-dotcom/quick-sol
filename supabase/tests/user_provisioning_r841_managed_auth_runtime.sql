-- Run as the non-superuser role `postgres`, immediately after applying the
-- exact R8.4 migration as that same role in the disposable managed-Auth
-- cluster prepared by user_provisioning_r841_managed_auth_setup.sql.

\set ON_ERROR_STOP on

do $$
declare
  auth_owner name;
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on'
     or session_user <> 'postgres'
     or current_user <> 'postgres' then
    raise exception 'REFUSING_NON_R841_MANAGED_AUTH_MIGRATION_ROLE';
  end if;

  select tableowner
  into auth_owner
  from pg_catalog.pg_tables
  where schemaname = 'auth' and tablename = 'users';

  if auth_owner = current_user
     or (select rolsuper from pg_catalog.pg_roles where rolname = current_user)
     or pg_catalog.pg_has_role(current_user, auth_owner, 'MEMBER')
     or not pg_catalog.has_table_privilege(current_user, 'auth.users', 'SELECT') then
    raise exception 'R841_AUTH_OWNERSHIP_BOUNDARY_INVALID';
  end if;

  if pg_catalog.to_regclass('auth.auth_users_provisioning_email_hash_idx') is not null
     or pg_catalog.to_regclass('auth.auth_users_provisioning_user_intent_locator_idx') is not null
     or pg_catalog.to_regclass('auth.auth_users_provisioning_app_intent_locator_idx') is not null then
    raise exception 'R841_AUTH_MANAGED_DDL_LEAKED';
  end if;

  if pg_catalog.to_regclass('public.user_provisioning_intents_idempotency_uidx') is null
     or pg_catalog.to_regclass('public.user_provisioning_intents_r84_email_uidx') is null
     or pg_catalog.to_regclass('public.profiles_provisioning_email_hash_idx') is null
     or pg_catalog.to_regprocedure(
       'public.begin_user_provisioning_v2(uuid,text,text,text,text,text,boolean,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.preview_user_provisioning_reconciliation_v1(uuid)'
     ) is null then
    raise exception 'R841_PUBLIC_R84_OBJECTS_MISSING';
  end if;

  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R841_R83B_GATE_NOT_TRUE';
  end if;

  perform 1 from auth.users limit 1;
end;
$$;

select
  'USER_PROVISIONING_R841_MANAGED_AUTH_PASS' as result,
  session_user as migration_role,
  (select tableowner from pg_catalog.pg_tables
   where schemaname = 'auth' and tablename = 'users') as auth_users_owner,
  (select count(*) from auth.users) as readable_auth_users;
