\set ON_ERROR_STOP on

begin;

do $$
declare
  actual_columns text[];
  missing_prior_indexes text[];
  stage_definition text;
begin
  select array_agg(attribute.attname order by key_position.ordinality)
  into actual_columns
  from pg_catalog.pg_class index_relation
  join pg_catalog.pg_index index_metadata
    on index_metadata.indexrelid = index_relation.oid
  join pg_catalog.pg_class table_relation
    on table_relation.oid = index_metadata.indrelid
  join pg_catalog.pg_namespace table_namespace
    on table_namespace.oid = table_relation.relnamespace
  cross join lateral unnest(index_metadata.indkey::smallint[])
    with ordinality as key_position(attribute_number, ordinality)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid = table_relation.oid
   and attribute.attnum = key_position.attribute_number
  where table_namespace.nspname = 'public'
    and table_relation.relname = 'business_stock_needs_snapshot_rows'
    and index_relation.relname = 'business_stock_needs_snapshot_chunk_idx'
    and index_metadata.indisvalid
    and index_metadata.indisready
    and index_metadata.indnkeyatts = 4;

  if actual_columns is distinct from array[
    'data_scope_id', 'generation', 'chunk_sequence', 'normalized_mpn'
  ]::text[] then
    raise exception 'R741_CHUNK_INDEX_CONTRACT_FAILED:%', actual_columns;
  end if;

  select array_agg(expected.index_name order by expected.index_name)
  into missing_prior_indexes
  from unnest(array[
    'business_stock_needs_scopes_claim_idx',
    'business_stock_needs_snapshot_default_page_idx',
    'business_stock_needs_snapshot_mpn_trgm_idx',
    'business_stock_needs_snapshot_customer_trgm_idx',
    'business_stock_needs_snapshot_supplier_trgm_idx',
    'business_stock_needs_snapshot_manufacturer_trgm_idx',
    'business_stock_needs_snapshot_statuses_idx',
    'business_stock_needs_snapshot_sources_page_idx'
  ]::text[]) expected(index_name)
  where to_regclass('public.' || expected.index_name) is null;

  if missing_prior_indexes is not null then
    raise exception 'R741_PRIOR_INDEX_MISSING:%', missing_prior_indexes;
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.stage_stock_needs_snapshot_chunk_v1(uuid,text,uuid,bigint,bigint,integer,integer)'::regprocedure
  ) into stage_definition;
  if position('row_data.data_scope_id = input_scope_id' in stage_definition) = 0
     or position('row_data.generation = input_generation' in stage_definition) = 0
     or position('row_data.chunk_sequence = input_chunk_sequence' in stage_definition) = 0
     or position('STOCK_SNAPSHOT_WORKER_FENCED' in stage_definition) = 0
     or position('STOCK_SNAPSHOT_SERVICE_ROLE_REQUIRED' in stage_definition) = 0 then
    raise exception 'R741_STAGE_CONTRACT_CHANGED';
  end if;

  if not (
       select relrowsecurity and relforcerowsecurity
       from pg_catalog.pg_class
       where oid = 'public.business_stock_needs_snapshot_rows'::regclass
     )
     or has_table_privilege('authenticated', 'public.business_stock_needs_snapshot_rows', 'select')
     or has_table_privilege('service_role', 'public.business_stock_needs_snapshot_rows', 'select')
     or not has_function_privilege(
       'service_role',
       'public.stage_stock_needs_snapshot_chunk_v1(uuid,text,uuid,bigint,bigint,integer,integer)',
       'execute'
     ) then
    raise exception 'R741_RLS_OR_ACL_BOUNDARY_FAILED';
  end if;

  if not exists (
       select 1 from public.database_safety_table_catalog_v2()
       where schema_name = 'public'
         and table_name = 'business_stock_needs_snapshot_rows'
         and category = 'BUSINESS_DATA'
         and planned_action = 'DELETE'
     )
     or not exists (
       select 1 from public.database_safety_table_catalog_v2()
       where schema_name = 'public'
         and table_name = 'business_stock_needs_snapshot_sources'
         and category = 'BUSINESS_DATA'
         and planned_action = 'DELETE'
     ) then
    raise exception 'R741_DATABASE_SAFETY_CLASSIFICATION_FAILED';
  end if;
end;
$$;

select 1 as definitive_index, 8 as prior_indexes, 'PASS' as result;

rollback;
