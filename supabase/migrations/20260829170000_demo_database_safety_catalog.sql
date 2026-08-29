begin;

-- Fail closed: the demo commerce, sourcing, organization, and compensation
-- schema is visible to Database Safety, but it is not eligible for deletion
-- until a separate backup/purge policy review is explicitly authorized.
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
  union all select 'public','user_provisioning_intents','AUTH_IDENTITY','PRESERVE',null,'Durable authorization and completion evidence for Auth/Profile creation.'
  union all select 'public','commerce_client_details','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commerce_catalog_products','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commerce_rfqs','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commerce_rfq_items','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commerce_quotes','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commerce_quote_items','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commerce_quote_events','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commerce_quote_shares','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','sourcing_requests','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','sourcing_offers','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','sourcing_offer_attachments','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','commercial_price_approvals','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','organization_members','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.'
  union all select 'public','employee_compensation','BUSINESS_DATA','PRESERVE',null,'Demo schema preserved pending a separately authorized backup/purge policy review.';
$$;

create or replace function public.database_safety_storage_catalog_v2()
returns table (bucket_id text, planned_action text, reason text)
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  values
    ('excel-uploads','BUSINESS_DELETE','Physical source workbooks are business information.'),
    ('chat-attachments','BUSINESS_DELETE','Business chat attachments are business information.'),
    ('email-attachments','BUSINESS_DELETE','Business email attachments are business information.'),
    ('client-assets','BUSINESS_DELETE','Client assets are business information.'),
    ('opportunity-finder','BUSINESS_DELETE','Opportunity Finder files are business information.'),
    ('sourcing-private','PRESERVE','Demo schema preserved pending a separately authorized backup/purge policy review.'),
    ('avatars','PRESERVE','Profile avatars are preserved with authentication identities.');
$$;

create or replace function public.database_safety_catalog_version_v2()
returns text language sql immutable security definer set search_path = pg_catalog
as $$ select '20260829170000-demo-preserve-v1'::text $$;

update public.database_safety_state
set catalog_version = '20260829170000-demo-preserve-v1', updated_at = pg_catalog.clock_timestamp()
where singleton;

revoke all on function public.database_safety_table_catalog_v2() from public, anon, authenticated, service_role;
revoke all on function public.database_safety_storage_catalog_v2() from public, anon, authenticated, service_role;
revoke all on function public.database_safety_catalog_version_v2() from public, anon, authenticated, service_role;
grant execute on function public.database_safety_table_catalog_v2() to service_role;
grant execute on function public.database_safety_storage_catalog_v2() to service_role;
grant execute on function public.database_safety_catalog_version_v2() to service_role;

commit;
