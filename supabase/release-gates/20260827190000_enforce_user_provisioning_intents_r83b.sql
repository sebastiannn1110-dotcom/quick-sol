-- R8.3B release gate. DO NOT move this file into supabase/migrations: A and B
-- must never be auto-applied by the same db push. Apply only after the new web
-- application and provisioning CLI are live and the R8.3 cutover checks pass.

begin;

create or replace function public.user_provisioning_intent_required_v1()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$ select true $$;

revoke all on function public.user_provisioning_intent_required_v1() from public, anon, authenticated, service_role;
alter function public.user_provisioning_intent_required_v1() owner to postgres;

do $$
begin
  if public.user_provisioning_intent_required_v1() is distinct from true then
    raise exception 'R83B_PROVISIONING_INTENT_GATE_NOT_ENABLED';
  end if;
end;
$$;

commit;
