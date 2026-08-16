-- Synthetic bootstrap for validating the Database Safety Center migration with
-- vanilla PostgreSQL. Never run against an existing or production database.

do $$
begin
  if current_database() !~ '^quiksol_.*_test$' then
    raise exception 'REFUSING_NON_TEST_DATABASE';
  end if;
end;
$$;

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end;
$$;

create schema auth;
create schema storage;
create schema supabase_migrations;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  confirmation_token text,
  email_change text,
  email_change_token_new text,
  recovery_token text
);

create table storage.objects (id uuid primary key default gen_random_uuid());
create table storage.buckets (id text primary key);
create table supabase_migrations.schema_migrations (version text primary key);
insert into supabase_migrations.schema_migrations(version) values ('20260815120000');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null,
  is_active boolean not null default true,
  constraint profiles_role_check check (role in ('admin','manager','employee'))
);

create table public.system_logs (
  id uuid primary key default gen_random_uuid(),
  level text not null,
  module text not null,
  action text not null,
  message text not null
);

do $$
declare
  table_name text;
  tables text[] := array[
    'admin_email_attachments','admin_email_messages','ai_conversations','ai_messages','api_rate_limits',
    'audit_logs','business_mpn_summaries','business_opportunity_entities','business_records','business_scope_counters',
    'business_upload_versions','chat_attachments','chat_conversation_members','chat_conversations','chat_messages',
    'client_logs','client_private_details','client_upload_assignments','clients','email_alert_rules',
    'email_notification_events','file_schema_profiles','import_errors','import_job_error_summary','import_job_errors',
    'import_jobs','observability_log_outbox','opportunity_finder_allocations','opportunity_finder_audit_events',
    'opportunity_finder_dataset_snapshot_rows','opportunity_finder_dataset_snapshots','opportunity_finder_demand_events',
    'opportunity_finder_demand_part_options','opportunity_finder_files','opportunity_finder_historical_signals',
    'opportunity_finder_jobs','opportunity_finder_manufacturer_aliases','opportunity_finder_manufacturer_registry_versions',
    'opportunity_finder_manufacturers','opportunity_finder_output_items','opportunity_finder_output_runs',
    'opportunity_finder_part_equivalence_versions','opportunity_finder_part_equivalences','opportunity_finder_possible_matches',
    'opportunity_finder_rejected_rows','opportunity_finder_result_commercials','opportunity_finder_result_financials',
    'opportunity_finder_results','opportunity_finder_review_decisions','opportunity_finder_rows',
    'opportunity_finder_supply_lots','opportunity_finder_tenant_memberships','opportunity_finder_tenants',
    'password_reset_codes','performance_logs','security_events','upload_batches','upload_sheets'
  ];
begin
  foreach table_name in array tables loop
    execute format('create table public.%I (id uuid primary key default gen_random_uuid())', table_name);
  end loop;
end;
$$;

alter database quiksol_migration_test set quiksol.allow_destructive_runtime_test = 'on';
