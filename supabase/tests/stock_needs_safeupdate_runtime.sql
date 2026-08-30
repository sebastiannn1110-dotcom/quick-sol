-- Run only against a disposable database with all migrations applied.
-- The transaction proves the guard remains enabled and rolls back every write.

\set ON_ERROR_STOP on

begin;

set local safeupdate.enabled = 'on';

do $$
declare
  unsafe_update_rejected boolean := false;
  target_profile_id uuid;
begin
  -- Reproduce the original statement shape and require pg-safeupdate to reject
  -- it with the same SQLSTATE reported by the remote demo seed.
  begin
    execute pg_catalog.format(
      'update %I.%I set enabled = enabled',
      'public',
      'business_stock_needs_scopes'
    );
  exception
    when sqlstate '21000' then
      unsafe_update_rejected := true;
  end;

  if not unsafe_update_rejected then
    raise exception 'STOCK_NEEDS_SAFEUPDATE_GUARD_NOT_ACTIVE';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_proc trigger_function on trigger_function.oid = trigger_row.tgfoid
    where namespace.nspname = 'public'
      and relation.relname = 'profiles'
      and trigger_row.tgname = 'business_stock_needs_profile_queue_v1'
      and trigger_function.proname = 'queue_stock_needs_snapshots_v1'
      and not trigger_row.tgisinternal
  ) then
    raise exception 'STOCK_NEEDS_PROFILE_TRIGGER_CHAIN_MISSING';
  end if;

  -- This call reached the formerly unsafe UPDATE directly during the failure.
  perform public.ensure_stock_needs_scopes_v1();

  if not exists (
    select 1
    from public.business_stock_needs_scopes scope
    where scope.scope_key = 'company'
      and scope.enabled
  ) then
    raise exception 'STOCK_NEEDS_COMPANY_SCOPE_NOT_RECONCILED';
  end if;

  -- Exercise the same trigger path used by profile reconciliation when a
  -- fixture profile is available. The direct helper call above is unconditional.
  select profile.id
  into target_profile_id
  from public.profiles profile
  order by profile.id
  limit 1;

  if target_profile_id is not null then
    update public.profiles profile
    set department = profile.department
    where profile.id = target_profile_id;
  end if;
end;
$$;

rollback;
