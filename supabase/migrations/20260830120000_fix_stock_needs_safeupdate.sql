-- Keep Stock Needs scope reconciliation compatible with pg-safeupdate.
--
-- The R7.4 helper intentionally refreshes every known scope, but its UPDATE
-- had no root WHERE clause. WHERE clauses inside the CASE/EXISTS expressions
-- do not qualify the UPDATE itself, so pg-safeupdate rejected profile writes
-- that reached this helper through business_stock_needs_profile_queue_v1.

begin;

create or replace function public.ensure_stock_needs_scopes_v1()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.business_stock_needs_scopes(scope_type, scope_key)
  values ('company', 'company')
  on conflict (scope_key) do update set enabled = true, updated_at = clock_timestamp();

  insert into public.business_stock_needs_scopes(scope_type, scope_key, owner_id)
  select 'owner', 'owner:' || profile.id::text, profile.id
  from public.profiles profile
  where profile.is_active
  on conflict (scope_key) do update
    set owner_id = excluded.owner_id, enabled = true, updated_at = clock_timestamp();

  insert into public.business_stock_needs_scopes(scope_type, scope_key, department, region)
  select distinct 'team', public.stock_needs_team_scope_key_v1(profile.department, profile.region),
    profile.department, profile.region
  from public.profiles profile
  where profile.is_active and profile.role = 'manager'
    and (profile.department is not null or profile.region is not null)
  on conflict (scope_key) do update
    set department = excluded.department, region = excluded.region,
        enabled = true, updated_at = clock_timestamp();

  insert into public.business_stock_needs_scopes(scope_type, scope_key, upload_batch_id)
  select 'upload', 'upload:' || upload.id::text, upload.id
  from public.upload_batches upload
  where upload.archived_at is null
    and upload.status in ('completed', 'completed_with_warnings')
  on conflict (scope_key) do update
    set upload_batch_id = excluded.upload_batch_id, enabled = true,
        updated_at = clock_timestamp();

  with desired_scope_state as materialized (
    select
      scope.id,
      case scope.scope_type
        when 'company' then true
        when 'owner' then exists (
          select 1
          from public.profiles profile
          where profile.id = scope.owner_id
            and profile.is_active
        )
        when 'team' then exists (
          select 1
          from public.profiles profile
          where profile.is_active
            and profile.role = 'manager'
            and profile.department is not distinct from scope.department
            and profile.region is not distinct from scope.region
        )
        when 'upload' then exists (
          select 1
          from public.upload_batches upload
          where upload.id = scope.upload_batch_id
            and upload.archived_at is null
            and upload.status in ('completed', 'completed_with_warnings')
        )
      end as desired_enabled
    from public.business_stock_needs_scopes scope
  )
  update public.business_stock_needs_scopes scope
  set enabled = desired.desired_enabled,
      updated_at = clock_timestamp()
  from desired_scope_state desired
  where scope.id = desired.id;
end;
$$;

revoke all on function public.ensure_stock_needs_scopes_v1()
from public, anon, authenticated, service_role;

commit;
