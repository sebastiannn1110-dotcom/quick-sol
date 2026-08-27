-- Disposable vanilla-PostgreSQL bootstrap for the complete R8.2 migration
-- chain. The exact database name and opt-in GUC are both mandatory so this
-- synthetic Supabase surface cannot be applied accidentally to shared data.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() <> 'quiksol_r82_admin_invariant_test'
     or current_setting('quiksol.allow_r82_admin_invariant_test', true) is distinct from 'on' then
    raise exception 'REFUSING_NON_R82_ADMIN_INVARIANT_TEST_DATABASE';
  end if;
end;
$$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create publication supabase_realtime;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists supabase_migrations;

create or replace function auth.uid()
returns uuid
language sql
stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;

create or replace function storage.foldername(input_name text)
returns text[]
language sql
stable
set search_path = pg_catalog
as $$
  select string_to_array(input_name, '/')
$$;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  banned_until timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  confirmation_token text,
  email_change text,
  email_change_token_new text,
  recovery_token text
);

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz,
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[] default '{}',
  name text
);

grant usage on schema auth, storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

select 'R82_DISPOSABLE_BOOTSTRAP_PASS' as result;
