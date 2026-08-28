-- Disposable-only ownership setup for the R8.4.1 managed-Auth portability
-- proof. The cluster superuser is deliberately named supabase_auth_admin so
-- auth.users is born under an owner different from the non-superuser migration
-- role. This script transfers only application-owned R8.4 objects.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r83_user_provisioning_test'
     or current_setting('quiksol.allow_r83_user_provisioning_test', true) is distinct from 'on'
     or session_user <> 'supabase_auth_admin' then
    raise exception 'REFUSING_NON_R841_MANAGED_AUTH_TEST_DATABASE';
  end if;

  if (select tableowner from pg_catalog.pg_tables
      where schemaname = 'auth' and tablename = 'users') <> 'supabase_auth_admin' then
    raise exception 'R841_AUTH_USERS_NOT_MANAGED_BY_BOOTSTRAP_OWNER';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres') then
    create role postgres
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication
      nobypassrls;
  end if;
end;
$$;

grant usage, create on schema public to postgres;
grant usage on schema auth, extensions to postgres;
grant select on table auth.users to postgres;
grant execute on function auth.uid() to postgres;
grant execute on function auth.role() to postgres;
-- Earlier migrations revoke helper execution from PUBLIC. Production's
-- application owner can execute its own helper graph; mirror that capability
-- without granting any Auth DDL or Auth ownership.
grant execute on all functions in schema public to postgres;

alter table public.user_provisioning_intents owner to postgres;
alter table public.profiles owner to postgres;
alter table public.audit_logs owner to postgres;
alter function public.handle_new_user() owner to postgres;

do $$
begin
  if (select rolsuper from pg_catalog.pg_roles where rolname = 'postgres')
     or pg_catalog.pg_has_role('postgres', 'supabase_auth_admin', 'MEMBER')
     or not pg_catalog.has_table_privilege('postgres', 'auth.users', 'SELECT')
     or (select tableowner from pg_catalog.pg_tables
         where schemaname = 'auth' and tablename = 'users') = 'postgres' then
    raise exception 'R841_MIGRATION_ROLE_NOT_RESTRICTED';
  end if;
end;
$$;

select
  'R841_MANAGED_AUTH_SETUP_PASS' as result,
  (select tableowner from pg_catalog.pg_tables
   where schemaname = 'auth' and tablename = 'users') as auth_users_owner,
  (select rolsuper from pg_catalog.pg_roles where rolname = 'postgres') as migration_role_superuser;
