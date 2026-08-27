begin;

-- R8.3A / Error 40. Durable, one-use authorization for creating an Auth user
-- and its final Profile in the same auth.users INSERT transaction. This
-- additive stage intentionally retains the R8.1 employee fallback until the
-- application and CLI consumers have been deployed.

create table public.user_provisioning_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  status text not null default 'pending'
    constraint user_provisioning_intents_status_check
    check (status in ('pending', 'completed')),
  source text not null
    constraint user_provisioning_intents_source_check
    check (source in ('admin_api', 'provision_admin_cli')),
  actor_profile_id uuid references public.profiles(id) on delete restrict,
  requested_email_hash bytea not null
    constraint user_provisioning_intents_email_hash_check
    check (pg_catalog.octet_length(requested_email_hash) = 32),
  requested_role text not null
    constraint user_provisioning_intents_role_check
    check (requested_role in ('admin', 'manager', 'employee', 'super_admin_dev')),
  requested_full_name text not null
    constraint user_provisioning_intents_full_name_check
    check (pg_catalog.btrim(requested_full_name) <> ''),
  requested_department text,
  requested_region text,
  requested_is_active boolean not null default true,
  requested_bio text
    constraint user_provisioning_intents_bio_length_check
    check (requested_bio is null or pg_catalog.char_length(requested_bio) <= 500),
  requested_job_title text
    constraint user_provisioning_intents_job_title_length_check
    check (requested_job_title is null or pg_catalog.char_length(requested_job_title) <= 120),
  auth_user_id uuid unique references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  constraint user_provisioning_intents_actor_source_check check (
    (source = 'admin_api' and actor_profile_id is not null)
    or (source = 'provision_admin_cli' and actor_profile_id is null)
  ),
  constraint user_provisioning_intents_lifecycle_check check (
    (status = 'pending' and auth_user_id is null and completed_at is null)
    or (status = 'completed' and auth_user_id is not null and completed_at is not null)
  )
);

comment on table public.user_provisioning_intents is
  'R8.3 durable one-use authorization. PRESERVE identity lifecycle evidence; never stores email plaintext, passwords, tokens, or credentials.';
comment on column public.user_provisioning_intents.requested_email_hash is
  'SHA-256 of lower(btrim(email)); the plaintext email is intentionally not retained.';

alter table public.user_provisioning_intents owner to postgres;
alter table public.user_provisioning_intents enable row level security;
revoke all on table public.user_provisioning_intents from public, anon, authenticated, service_role;

-- Internal constructor used only by the two source-specific wrappers below.
create or replace function public.create_user_provisioning_intent_internal_v1(
  input_source text,
  input_actor_profile_id uuid,
  input_email text,
  input_full_name text,
  input_role text,
  input_department text,
  input_region text,
  input_is_active boolean,
  input_bio text,
  input_job_title text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_email text;
  normalized_full_name text;
  actor_profile public.profiles%rowtype;
  created_intent_id uuid;
begin
  normalized_email := pg_catalog.lower(pg_catalog.btrim(input_email));
  normalized_full_name := pg_catalog.btrim(input_full_name);

  if input_source not in ('admin_api', 'provision_admin_cli') then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_SOURCE_INVALID';
  end if;
  if normalized_email is null
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_EMAIL_INVALID';
  end if;
  if normalized_full_name is null or normalized_full_name = '' then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_FULL_NAME_INVALID';
  end if;
  if input_role is null
     or input_role not in ('admin', 'manager', 'employee', 'super_admin_dev') then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_ROLE_INVALID';
  end if;
  if input_is_active is null then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_ACTIVE_INVALID';
  end if;
  if input_bio is not null and pg_catalog.char_length(input_bio) > 500 then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_BIO_INVALID';
  end if;
  if input_job_title is not null and pg_catalog.char_length(input_job_title) > 120 then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_JOB_TITLE_INVALID';
  end if;

  if input_source = 'admin_api' then
    if input_actor_profile_id is null or input_actor_profile_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
    end if;

    select profile.*
    into actor_profile
    from public.profiles profile
    join auth.users auth_user on auth_user.id = profile.id
    where profile.id = input_actor_profile_id
      and profile.is_active is true
      and public.profile_role_has_capability(profile.role, 'ADMIN')
      and auth_user.email_confirmed_at is not null
      and (
        auth_user.banned_until is null
        or auth_user.banned_until <= pg_catalog.now()
      )
    for share of profile;

    if not found then
      raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
    end if;
    if input_role = 'super_admin_dev'
       and not public.profile_role_has_capability(actor_profile.role, 'SUPERADMIN') then
      raise exception using errcode = '42501', message = 'SUPER_ADMIN_DEV_REQUIRED';
    end if;
  elsif input_actor_profile_id is not null then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_CLI_ACTOR_INVALID';
  elsif input_role not in ('admin', 'super_admin_dev') then
    raise exception using errcode = '22023', message = 'PROVISIONING_INTENT_CLI_ROLE_INVALID';
  end if;

  insert into public.user_provisioning_intents (
    source,
    actor_profile_id,
    requested_email_hash,
    requested_role,
    requested_full_name,
    requested_department,
    requested_region,
    requested_is_active,
    requested_bio,
    requested_job_title
  )
  values (
    input_source,
    input_actor_profile_id,
    extensions.digest(normalized_email, 'sha256'),
    input_role,
    normalized_full_name,
    nullif(pg_catalog.btrim(input_department), ''),
    nullif(pg_catalog.btrim(input_region), ''),
    input_is_active,
    nullif(pg_catalog.btrim(input_bio), ''),
    nullif(pg_catalog.btrim(input_job_title), '')
  )
  returning id into created_intent_id;

  return created_intent_id;
end;
$$;

create or replace function public.create_user_provisioning_intent_v1(
  requested_email text,
  requested_full_name text,
  requested_role text,
  requested_department text default null,
  requested_region text default null,
  requested_is_active boolean default true,
  requested_bio text default null,
  requested_job_title text default null
)
returns uuid
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select public.create_user_provisioning_intent_internal_v1(
    'admin_api',
    auth.uid(),
    requested_email,
    requested_full_name,
    requested_role,
    requested_department,
    requested_region,
    requested_is_active,
    requested_bio,
    requested_job_title
  )
$$;

create or replace function public.create_cli_user_provisioning_intent_v1(
  requested_email text,
  requested_full_name text,
  requested_role text,
  requested_department text default null,
  requested_region text default null,
  requested_is_active boolean default true,
  requested_bio text default null,
  requested_job_title text default null
)
returns uuid
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select public.create_user_provisioning_intent_internal_v1(
    'provision_admin_cli',
    null,
    requested_email,
    requested_full_name,
    requested_role,
    requested_department,
    requested_region,
    requested_is_active,
    requested_bio,
    requested_job_title
  )
$$;

revoke all on function public.create_user_provisioning_intent_internal_v1(text, uuid, text, text, text, text, text, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.create_user_provisioning_intent_v1(text, text, text, text, text, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.create_cli_user_provisioning_intent_v1(text, text, text, text, text, boolean, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_user_provisioning_intent_v1(text, text, text, text, text, boolean, text, text) to authenticated;
grant execute on function public.create_cli_user_provisioning_intent_v1(text, text, text, text, text, boolean, text, text) to service_role;

alter function public.create_user_provisioning_intent_internal_v1(text, uuid, text, text, text, text, text, boolean, text, text) owner to postgres;
alter function public.create_user_provisioning_intent_v1(text, text, text, text, text, boolean, text, text) owner to postgres;
alter function public.create_cli_user_provisioning_intent_v1(text, text, text, text, text, boolean, text, text) owner to postgres;

-- A is explicitly compatible with the old application. R8.3B replaces this
-- routine with an immutable TRUE gate only after every createUser caller uses
-- the intent protocol.
create or replace function public.user_provisioning_intent_required_v1()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$ select false $$;

revoke all on function public.user_provisioning_intent_required_v1() from public, anon, authenticated, service_role;
alter function public.user_provisioning_intent_required_v1() owner to postgres;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  raw_intent_id text;
  target_intent_id uuid;
  target_intent public.user_provisioning_intents%rowtype;
  normalized_auth_email text;
begin
  raw_intent_id := nullif(
    pg_catalog.btrim(new.raw_app_meta_data->>'quiksol_provisioning_intent_id'),
    ''
  );

  if raw_intent_id is null then
    if public.user_provisioning_intent_required_v1() then
      raise exception using errcode = 'QS831', message = 'PROVISIONING_INTENT_REQUIRED';
    end if;

    -- R8.3A compatibility only: exact R8.1 least-privilege behavior.
    insert into public.profiles (id, full_name, email, role, department, region)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'full_name', pg_catalog.split_part(new.email, '@', 1), 'Quiksol User'),
      coalesce(new.email, ''),
      'employee',
      null,
      null
    )
    on conflict (id) do nothing;
    return new;
  end if;

  begin
    target_intent_id := raw_intent_id::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'QS832', message = 'PROVISIONING_INTENT_ID_INVALID';
  end;

  select intent.*
  into target_intent
  from public.user_provisioning_intents intent
  where intent.id = target_intent_id
  for update;

  if not found then
    raise exception using errcode = 'QS833', message = 'PROVISIONING_INTENT_NOT_FOUND';
  end if;
  if target_intent.status <> 'pending'
     or target_intent.auth_user_id is not null
     or target_intent.completed_at is not null then
    raise exception using errcode = 'QS834', message = 'PROVISIONING_INTENT_ALREADY_CONSUMED';
  end if;
  if target_intent.source not in ('admin_api', 'provision_admin_cli')
     or target_intent.requested_role not in ('admin', 'manager', 'employee', 'super_admin_dev')
     or nullif(pg_catalog.btrim(target_intent.requested_full_name), '') is null
     or target_intent.requested_is_active is null
     or pg_catalog.octet_length(target_intent.requested_email_hash) <> 32 then
    raise exception using errcode = 'QS836', message = 'PROVISIONING_INTENT_PAYLOAD_INVALID';
  end if;

  normalized_auth_email := pg_catalog.lower(pg_catalog.btrim(new.email));
  if normalized_auth_email is null
     or extensions.digest(normalized_auth_email, 'sha256') <> target_intent.requested_email_hash then
    raise exception using errcode = 'QS835', message = 'PROVISIONING_INTENT_EMAIL_MISMATCH';
  end if;

  -- This INSERT and the intent completion are part of the surrounding
  -- auth.users INSERT transaction. Any failure rolls back all three states.
  insert into public.profiles (
    id,
    full_name,
    email,
    role,
    department,
    region,
    bio,
    job_title,
    is_active
  )
  values (
    new.id,
    pg_catalog.btrim(target_intent.requested_full_name),
    normalized_auth_email,
    target_intent.requested_role,
    target_intent.requested_department,
    target_intent.requested_region,
    target_intent.requested_bio,
    target_intent.requested_job_title,
    target_intent.requested_is_active
  );

  update public.user_provisioning_intents intent
  set status = 'completed',
      auth_user_id = new.id,
      completed_at = pg_catalog.clock_timestamp()
  where intent.id = target_intent_id
    and intent.status = 'pending';

  if not found then
    raise exception using errcode = 'QS834', message = 'PROVISIONING_INTENT_ALREADY_CONSUMED';
  end if;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
alter function public.handle_new_user() owner to postgres;

-- Database Safety: provisioning intents are durable identity evidence and are
-- never included in business-data destruction.
create or replace function public.database_safety_table_catalog_v2()
returns table(schema_name text, table_name text, category text, planned_action text, delete_order integer, reason text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select original.schema_name, original.table_name,
    case when original.table_name in ('password_reset_codes','api_rate_limits','observability_log_outbox')
      then 'SYSTEM_EPHEMERAL' else original.category end,
    case when original.schema_name='public' and original.table_name in (
      'password_reset_codes','api_rate_limits','observability_log_outbox',
      'audit_logs','security_events','system_logs','client_logs','performance_logs'
    ) then 'PRESERVE' else original.planned_action end,
    case when original.schema_name='public' and original.table_name in (
      'password_reset_codes','api_rate_limits','observability_log_outbox',
      'audit_logs','security_events','system_logs','client_logs','performance_logs'
    ) then null else original.delete_order end,
    case
      when original.table_name='password_reset_codes' then 'Authentication recovery state is preserved.'
      when original.table_name='api_rate_limits' then 'Security rate-limit state is preserved and does not stale business backups.'
      when original.table_name='observability_log_outbox' then 'Observability delivery state is preserved.'
      when original.table_name in ('audit_logs','security_events','system_logs','client_logs','performance_logs')
        then 'Security and observability evidence is preserved.'
      when original.table_name='database_safety_state'
        then 'Database Safety configuration; authoritative watermarks are sequence-backed.'
      else original.reason end
  from public.database_safety_table_catalog() original
  union all select 'public','import_job_staging_rows','OPERATIONAL_DATA','DELETE',5,'Transient import staging can contain business data.'
  union all select 'public','worker_runtime_heartbeats','SYSTEM_EPHEMERAL','PRESERVE',null,'Worker liveness contains no business payload and is preserved.'
  union all select 'public','business_summary_mpn_stage','BUSINESS_DATA','DELETE',5,'Version-fenced staged MPN summary aggregates.'
  union all select 'public','business_summary_entity_stage','BUSINESS_DATA','DELETE',5,'Version-fenced staged opportunity entities.'
  union all select 'public','business_stock_needs_scopes','OPERATIONAL_DATA','DELETE',20,'Versioned Stock Needs scope readiness and fenced build state.'
  union all select 'public','business_stock_needs_snapshot_rows','BUSINESS_DATA','DELETE',5,'Published and hidden staged Stock Needs snapshot rows.'
  union all select 'public','business_stock_needs_snapshot_sources','BUSINESS_DATA','DELETE',4,'Bounded authorized source provenance for Stock Needs pages.'
  union all select 'public','user_provisioning_intents','AUTH_IDENTITY','PRESERVE',null,'Durable authorization and completion evidence for Auth/Profile creation.';
$$;

create or replace function public.database_safety_catalog_version_v2()
returns text language sql immutable security definer set search_path = pg_catalog
as $$ select '20260827180000-r83a-v1'::text $$;

update public.database_safety_state
set catalog_version = '20260827180000-r83a-v1', updated_at = pg_catalog.clock_timestamp()
where singleton;

revoke all on function public.database_safety_table_catalog_v2() from public, anon, authenticated, service_role;
revoke all on function public.database_safety_catalog_version_v2() from public, anon, authenticated, service_role;
grant execute on function public.database_safety_table_catalog_v2() to service_role;
grant execute on function public.database_safety_catalog_version_v2() to service_role;

commit;
