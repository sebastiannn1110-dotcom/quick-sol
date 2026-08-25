create or replace function public.database_safety_catalog_preflight_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  unclassified text[];
  missing text[];
  inventory_hash text;
begin
  select coalesce(array_agg(format('%I.%I', actual.schema_name, actual.table_name) order by actual.schema_name, actual.table_name), '{}'::text[])
  into unclassified
  from (
    select n.nspname schema_name, c.relname table_name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
  ) actual
  left join public.database_safety_table_catalog_v2() catalog
    on catalog.schema_name = actual.schema_name and catalog.table_name = actual.table_name
  where catalog.table_name is null;

  select coalesce(array_agg(format('%I.%I', catalog.schema_name, catalog.table_name) order by catalog.schema_name, catalog.table_name), '{}'::text[])
  into missing
  from public.database_safety_table_catalog_v2() catalog
  where catalog.schema_name = 'public'
    and to_regclass(format('%I.%I', catalog.schema_name, catalog.table_name)) is null;

  select encode(extensions.digest(coalesce(string_agg(inventory.entry, '|' order by inventory.entry), ''), 'sha256'), 'hex')
  into inventory_hash
  from (
    select format('%I.%I(%s)', n.nspname, c.relname, coalesce(string_agg(
      format('%I:%s:%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull),
      ',' order by a.attnum
    ), '')) entry
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r','p')
    group by n.nspname, c.relname
  ) inventory;

  return jsonb_build_object(
    'catalogVersion', public.database_safety_catalog_version_v2(),
    'schemaInventoryHash', inventory_hash,
    'classified', cardinality(unclassified) = 0 and cardinality(missing) = 0,
    'unclassified', to_jsonb(unclassified),
    'missing', to_jsonb(missing),
    'deleteTables', (select coalesce(jsonb_agg(format('%I.%I', schema_name, table_name) order by delete_order, table_name), '[]'::jsonb) from public.database_safety_table_catalog_v2() where planned_action = 'DELETE'),
    'protectedTables', (select coalesce(jsonb_agg(format('%I.%I', schema_name, table_name) order by schema_name, table_name), '[]'::jsonb) from public.database_safety_table_catalog_v2() where planned_action = 'PRESERVE')
  );
end;
$$;
