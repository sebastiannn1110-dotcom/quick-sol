-- Publish fenced Opportunity Finder output directly from the private staging
-- relation. The legacy JSON-array RPC remains available for compatibility, but
-- the production staged path no longer materializes an entire output kind in a
-- PostgreSQL backend JSONB value before inserting it.

create or replace function public.replace_opportunity_finder_job_output_from_stage(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  processing_fence bigint,
  commit_key text,
  run_id uuid,
  summary jsonb default '{}'::jsonb,
  warning_count integer default 0,
  missing_mpn_rows integer default 0,
  invalid_quantity_rows integer default 0
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
set work_mem = '32MB'
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_processing_fence alias for $4;
  input_commit_key alias for $5;
  input_run_id alias for $6;
  input_summary alias for $7;
  input_warning_count alias for $8;
  input_missing_mpn_rows alias for $9;
  input_invalid_quantity_rows alias for $10;
  locked_job public.opportunity_finder_jobs%rowtype;
  locked_run public.opportunity_finder_output_runs%rowtype;
  replaced_job public.opportunity_finder_jobs%rowtype;
  allocation_count bigint := 0;
  database_allocation_count bigint := 0;
  result_count bigint := 0;
  rejected_count bigint := 0;
  allocation_offset bigint := 0;
  allocation_end bigint;
  allocation_chunk jsonb;
  allocation_chunk_row_limit constant integer := 10000;
  allocation_chunk_byte_limit constant bigint := 8388608;
begin
  if input_summary is null or jsonb_typeof(input_summary) <> 'object' then
    raise exception using errcode = '22023', message = 'summary_must_be_json_object';
  end if;

  if input_warning_count < 0
     or input_missing_mpn_rows < 0
     or input_invalid_quantity_rows < 0 then
    raise exception using errcode = '22023', message = 'invalid_job_counters';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  if locked_job.output_commit_key = input_commit_key
     and locked_job.status in ('completed', 'completed_with_warnings') then
    return locked_job;
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.processing_fence is distinct from input_processing_fence
     or locked_job.materialized_lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_replaceable';
  end if;

  select run.*
  into locked_run
  from public.opportunity_finder_output_runs run
  where run.id = input_run_id
    and run.job_id = input_job_id
    and run.commit_key = input_commit_key
  for update;

  if not found
     or locked_run.worker_id is distinct from input_worker_id
     or locked_run.lock_token is distinct from input_lock_token
     or locked_run.processing_fence is distinct from input_processing_fence
     or locked_run.tenant_id is distinct from locked_job.tenant_id then
    raise exception using errcode = '40001', message = 'stale_opportunity_output_run';
  end if;

  -- This delete/reset/insert/allocation/finalize sequence is one transaction.
  -- Other sessions continue to see the previous committed output until success.
  delete from public.opportunity_finder_results result
  where result.job_id = input_job_id;
  delete from public.opportunity_finder_possible_matches candidate
  where candidate.job_id = input_job_id;
  delete from public.opportunity_finder_rejected_rows rejected
  where rejected.job_id = input_job_id;

  update public.opportunity_finder_supply_lots lot
  set allocated_qty = 0,
      remaining_qty = lot.available_qty,
      updated_at = now()
  where lot.job_id = input_job_id
    and (
      lot.allocated_qty is distinct from 0
      or lot.remaining_qty is distinct from lot.available_qty
    );

  update public.opportunity_finder_demand_events event_row
  set allocated_qty = 0,
      remaining_qty = event_row.required_qty,
      updated_at = now()
  where event_row.job_id = input_job_id
    and (
      event_row.allocated_qty is distinct from 0
      or event_row.remaining_qty is distinct from event_row.required_qty
    );

  if exists (
    select 1
    from public.opportunity_finder_output_items staged_item
    cross join lateral jsonb_to_record(staged_item.payload) as candidate(
      id uuid,
      candidate_key text,
      demand_normalized_mpn text,
      supply_normalized_mpn text,
      demand_option_id uuid,
      supply_lot_id uuid,
      demand_file_id uuid,
      supply_file_id uuid,
      reason_code text
    )
    cross join lateral (
      select coalesce(
        nullif(trim(candidate.candidate_key), ''),
        encode(
          digest(
            concat_ws(
              '|',
              input_job_id::text,
              candidate.demand_normalized_mpn,
              candidate.supply_normalized_mpn,
              coalesce(candidate.demand_option_id::text, candidate.demand_file_id::text),
              coalesce(candidate.supply_lot_id::text, candidate.supply_file_id::text),
              coalesce(candidate.reason_code, 'symbol_variant')
            ),
            'sha256'
          ),
          'hex'
        )
      ) as value
    ) candidate_key
    where staged_item.run_id = input_run_id
      and staged_item.job_id = input_job_id
      and staged_item.tenant_id = locked_job.tenant_id
      and staged_item.output_kind = 'possible_matches'
      and candidate.id is not null
      and candidate.id is distinct from
        public.opportunity_finder_candidate_uuid(candidate_key.value)
  ) then
    raise exception using errcode = '23514', message = 'candidate_id_key_mismatch';
  end if;

  insert into public.opportunity_finder_possible_matches (
    id,
    tenant_id,
    job_id,
    candidate_key,
    demand_option_id,
    supply_lot_id,
    demand_display_mpn,
    supply_display_mpn,
    demand_normalized_mpn,
    supply_normalized_mpn,
    review_key,
    demand_file_id,
    supply_file_id,
    reason_code,
    match_tier,
    confidence,
    explanation,
    manufacturer_compatible,
    review_status,
    demand_trace,
    supply_trace
  )
  select
    candidate_identity.id,
    locked_job.tenant_id,
    input_job_id,
    candidate_key.value,
    candidate.demand_option_id,
    candidate.supply_lot_id,
    candidate.demand_display_mpn,
    candidate.supply_display_mpn,
    candidate.demand_normalized_mpn,
    candidate.supply_normalized_mpn,
    candidate.review_key,
    candidate.demand_file_id,
    candidate.supply_file_id,
    coalesce(candidate.reason_code, 'symbol_variant'),
    coalesce(candidate.match_tier, 'search_mpn_mfg'),
    coalesce(candidate.confidence, 'review'),
    candidate.explanation,
    candidate.manufacturer_compatible,
    coalesce(durable_review.decision, candidate.review_status, 'pending'),
    coalesce(candidate.demand_trace, '{}'::jsonb),
    coalesce(candidate.supply_trace, '{}'::jsonb)
  from public.opportunity_finder_output_items staged_item
  cross join lateral jsonb_to_record(staged_item.payload) as candidate(
    id uuid,
    candidate_key text,
    demand_option_id uuid,
    supply_lot_id uuid,
    demand_display_mpn text,
    supply_display_mpn text,
    demand_normalized_mpn text,
    supply_normalized_mpn text,
    review_key text,
    demand_file_id uuid,
    supply_file_id uuid,
    reason_code text,
    match_tier text,
    confidence text,
    explanation text,
    manufacturer_compatible boolean,
    review_status text,
    demand_trace jsonb,
    supply_trace jsonb
  )
  cross join lateral (
    select coalesce(
      nullif(trim(candidate.candidate_key), ''),
      encode(
        digest(
          concat_ws(
            '|',
            input_job_id::text,
            candidate.demand_normalized_mpn,
            candidate.supply_normalized_mpn,
            coalesce(candidate.demand_option_id::text, candidate.demand_file_id::text),
            coalesce(candidate.supply_lot_id::text, candidate.supply_file_id::text),
            coalesce(candidate.reason_code, 'symbol_variant')
          ),
          'sha256'
        ),
        'hex'
      )
    ) as value
  ) candidate_key
  cross join lateral (
    select public.opportunity_finder_candidate_uuid(candidate_key.value) as id
  ) candidate_identity
  left join public.opportunity_finder_review_decisions durable_review
    on durable_review.job_id = input_job_id
   and durable_review.tenant_id = locked_job.tenant_id
   and durable_review.entity_type = 'possible_match'
   and durable_review.entity_id = candidate_identity.id
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'possible_matches'
  order by staged_item.item_index;

  if exists (
    select 1
    from public.opportunity_finder_output_items staged_item
    cross join lateral jsonb_to_record(staged_item.payload) as result(candidate_id uuid)
    left join public.opportunity_finder_possible_matches candidate
      on candidate.id = result.candidate_id
     and candidate.job_id = input_job_id
     and candidate.tenant_id = locked_job.tenant_id
    where staged_item.run_id = input_run_id
      and staged_item.job_id = input_job_id
      and staged_item.tenant_id = locked_job.tenant_id
      and staged_item.output_kind = 'results'
      and result.candidate_id is not null
      and candidate.id is null
  ) then
    raise exception using errcode = '23503', message = 'result_candidate_not_found_for_job';
  end if;

  insert into public.opportunity_finder_results (
    id,
    tenant_id,
    job_id,
    result_key,
    opportunity_type,
    exact_match,
    exact_mpn_match,
    usable_availability_match,
    exact_quantity_match,
    match_tier,
    confidence,
    match_explanation,
    review_status,
    demand_event_id,
    demand_event_key,
    candidate_id,
    demand_mpn_original,
    supply_mpn_original,
    display_mpn,
    normalized_mpn,
    manufacturer,
    manufacturer_canonical,
    customer_context,
    supplier_context,
    required_qty,
    available_qty,
    allocated_qty,
    remaining_qty,
    shortage_qty,
    coverage_percent,
    required_date,
    unit_of_measure,
    moq,
    spq,
    date_code,
    coo,
    lead_time_weeks,
    condition,
    expires_at,
    demand_file_id,
    demand_file_name,
    demand_sheet_name,
    supply_file_id,
    supply_file_name,
    supply_sheet_name,
    demand_source_rows,
    supply_source_rows,
    demand_traces,
    supply_traces,
    allocations_trace,
    reason_code,
    action_code,
    warnings
  )
  select
    result.id,
    locked_job.tenant_id,
    input_job_id,
    coalesce(nullif(trim(result.result_key), ''), result.id::text),
    result.opportunity_type,
    coalesce(result.exact_match, result.exact_mpn_match, false),
    coalesce(result.exact_mpn_match, result.exact_match, false),
    coalesce(result.usable_availability_match, false),
    coalesce(result.exact_quantity_match, false),
    result.match_tier,
    result.confidence,
    result.match_explanation,
    coalesce(result.review_status, 'not_required'),
    result.demand_event_id,
    result.demand_event_key,
    result.candidate_id,
    result.demand_mpn_original,
    result.supply_mpn_original,
    result.display_mpn,
    result.normalized_mpn,
    result.manufacturer,
    result.manufacturer_canonical,
    result.customer_context,
    result.supplier_context,
    result.required_qty,
    result.available_qty,
    result.allocated_qty,
    result.remaining_qty,
    result.shortage_qty,
    result.coverage_percent,
    result.required_date,
    result.unit_of_measure,
    result.moq,
    result.spq,
    result.date_code,
    result.coo,
    result.lead_time_weeks,
    result.condition,
    result.expires_at,
    result.demand_file_id,
    result.demand_file_name,
    result.demand_sheet_name,
    result.supply_file_id,
    result.supply_file_name,
    result.supply_sheet_name,
    coalesce(result.demand_source_rows, 0),
    coalesce(result.supply_source_rows, 0),
    coalesce(result.demand_traces, '[]'::jsonb),
    coalesce(result.supply_traces, '[]'::jsonb),
    coalesce(result.allocations_trace, '[]'::jsonb),
    result.reason_code,
    result.action_code,
    coalesce(result.warnings, '[]'::jsonb)
  from public.opportunity_finder_output_items staged_item
  cross join lateral jsonb_to_record(staged_item.payload) as result(
    id uuid,
    result_key text,
    opportunity_type text,
    exact_match boolean,
    exact_mpn_match boolean,
    usable_availability_match boolean,
    exact_quantity_match boolean,
    match_tier text,
    confidence text,
    match_explanation text,
    review_status text,
    demand_event_id uuid,
    demand_event_key text,
    candidate_id uuid,
    demand_mpn_original text,
    supply_mpn_original text,
    display_mpn text,
    normalized_mpn text,
    manufacturer text,
    manufacturer_canonical text,
    customer_context text,
    supplier_context text,
    required_qty numeric,
    available_qty numeric,
    allocated_qty numeric,
    remaining_qty numeric,
    shortage_qty numeric,
    coverage_percent numeric,
    required_date date,
    unit_of_measure text,
    moq numeric,
    spq numeric,
    date_code text,
    coo text,
    lead_time_weeks numeric,
    condition text,
    expires_at timestamptz,
    demand_file_id uuid,
    demand_file_name text,
    demand_sheet_name text,
    supply_file_id uuid,
    supply_file_name text,
    supply_sheet_name text,
    demand_source_rows integer,
    supply_source_rows integer,
    demand_traces jsonb,
    supply_traces jsonb,
    allocations_trace jsonb,
    reason_code text,
    action_code text,
    warnings jsonb
  )
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'results'
    and result.id is not null
  order by staged_item.item_index;

  select count(*)
  into result_count
  from public.opportunity_finder_output_items staged_item
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'results';

  if (select count(*) from public.opportunity_finder_results result where result.job_id = input_job_id)
     <> result_count then
    raise exception using errcode = '23514', message = 'every_result_requires_unique_id';
  end if;

  insert into public.opportunity_finder_result_commercials (
    result_id,
    tenant_id,
    job_id,
    target_price,
    offer_price,
    target_gap_percent,
    currency,
    revenue_potential,
    pricing_quality
  )
  select
    commercial.result_id,
    locked_job.tenant_id,
    input_job_id,
    commercial.target_price,
    commercial.offer_price,
    commercial.target_gap_percent,
    commercial.currency,
    commercial.revenue_potential,
    coalesce(commercial.pricing_quality, 'unconfirmed')
  from public.opportunity_finder_output_items staged_item
  cross join lateral jsonb_to_record(staged_item.payload) as commercial(
    result_id uuid,
    target_price numeric,
    offer_price numeric,
    target_gap_percent numeric,
    currency text,
    revenue_potential numeric,
    pricing_quality text
  )
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'commercials'
  order by staged_item.item_index;

  insert into public.opportunity_finder_result_financials (
    result_id,
    tenant_id,
    job_id,
    unit_cost,
    cost_currency,
    gross_profit,
    gross_margin_percent,
    cost_quality,
    cost_source_trace,
    computed_at
  )
  select
    financial.result_id,
    locked_job.tenant_id,
    input_job_id,
    financial.unit_cost,
    financial.cost_currency,
    financial.gross_profit,
    financial.gross_margin_percent,
    coalesce(financial.cost_quality, 'missing'),
    coalesce(financial.cost_source_trace, '{}'::jsonb),
    financial.computed_at
  from public.opportunity_finder_output_items staged_item
  cross join lateral jsonb_to_record(staged_item.payload) as financial(
    result_id uuid,
    unit_cost numeric,
    cost_currency text,
    gross_profit numeric,
    gross_margin_percent numeric,
    cost_quality text,
    cost_source_trace jsonb,
    computed_at timestamptz
  )
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'financials'
  order by staged_item.item_index;

  insert into public.opportunity_finder_rejected_rows (
    id,
    tenant_id,
    job_id,
    file_id,
    side,
    file_name,
    sheet_name,
    source_row,
    source_row_hidden,
    reason_code,
    field_name,
    source_column,
    safe_raw_value,
    source_trace,
    ingestion_lock_token,
    ingestion_fence
  )
  select
    coalesce(rejected.id, gen_random_uuid()),
    locked_job.tenant_id,
    input_job_id,
    rejected.file_id,
    rejected.side,
    rejected.file_name,
    rejected.sheet_name,
    rejected.source_row,
    coalesce(rejected.source_row_hidden, rejected.hidden, false),
    rejected.reason_code,
    rejected.field_name,
    rejected.source_column,
    rejected.safe_raw_value,
    coalesce(rejected.source_trace, '{}'::jsonb),
    input_lock_token,
    locked_job.processing_fence
  from public.opportunity_finder_output_items staged_item
  cross join lateral jsonb_to_record(staged_item.payload) as rejected(
    id uuid,
    file_id uuid,
    side text,
    file_name text,
    sheet_name text,
    source_row integer,
    source_row_hidden boolean,
    hidden boolean,
    reason_code text,
    field_name text,
    source_column text,
    safe_raw_value text,
    source_trace jsonb
  )
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'rejected_rows'
  order by staged_item.item_index;

  select count(*)
  into rejected_count
  from public.opportunity_finder_output_items staged_item
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'rejected_rows';

  select count(*)
  into allocation_count
  from public.opportunity_finder_output_items staged_item
  where staged_item.run_id = input_run_id
    and staged_item.job_id = input_job_id
    and staged_item.tenant_id = locked_job.tenant_id
    and staged_item.output_kind = 'allocations';

  -- Cross-chunk duplicates must retain the all-at-once rejection semantics of
  -- commit_opportunity_finder_allocations.
  if exists (
    select 1
    from public.opportunity_finder_output_items staged_item
    cross join lateral jsonb_to_record(staged_item.payload) as allocation(allocation_key text)
    where staged_item.run_id = input_run_id
      and staged_item.job_id = input_job_id
      and staged_item.tenant_id = locked_job.tenant_id
      and staged_item.output_kind = 'allocations'
    group by allocation.allocation_key
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'duplicate_allocation_key_in_payload';
  end if;

  -- The worker limits each complete RPC payload to 4 MiB. Keep a defensive
  -- per-item ceiling so a privileged malformed caller cannot defeat bounded
  -- allocation batches by staging one pathological JSON object.
  if exists (
    select 1
    from public.opportunity_finder_output_items staged_item
    where staged_item.run_id = input_run_id
      and staged_item.job_id = input_job_id
      and staged_item.tenant_id = locked_job.tenant_id
      and staged_item.output_kind = 'allocations'
      and octet_length(staged_item.payload::text) > 65536
  ) then
    raise exception using errcode = '54000', message = 'staged_allocation_item_too_large';
  end if;

  -- Bound each internal batch independently by rows and encoded payload bytes.
  -- This avoids a whole-kind JSONB aggregate without paying one temp-table
  -- setup per small upload chunk. Before each partial allocation commit, expose
  -- the cumulative expected result total to the legacy invariant engine;
  -- finalization then proves the complete totals.
  if allocation_count > 0 then
    while allocation_offset < allocation_count loop
      select max(bounded.item_index)
      into allocation_end
      from (
        select
          allocation_item.item_index,
          sum(octet_length(allocation_item.payload::text)) over (
            order by allocation_item.item_index
          ) as accumulated_payload_bytes
        from public.opportunity_finder_output_items allocation_item
        where allocation_item.run_id = input_run_id
          and allocation_item.job_id = input_job_id
          and allocation_item.tenant_id = locked_job.tenant_id
          and allocation_item.output_kind = 'allocations'
          and allocation_item.item_index >= allocation_offset
        order by allocation_item.item_index
        limit allocation_chunk_row_limit
      ) bounded
      where bounded.accumulated_payload_bytes <= allocation_chunk_byte_limit;

      if allocation_end is null then
        raise exception using
          errcode = '54000',
          message = 'staged_allocation_batch_cannot_be_bounded';
      end if;

      select coalesce(
        jsonb_agg(allocation_item.payload order by allocation_item.item_index),
        '[]'::jsonb
      )
      into allocation_chunk
      from public.opportunity_finder_output_items allocation_item
      where allocation_item.run_id = input_run_id
        and allocation_item.job_id = input_job_id
        and allocation_item.tenant_id = locked_job.tenant_id
        and allocation_item.output_kind = 'allocations'
        and allocation_item.item_index between allocation_offset and allocation_end;

      with chunk_totals as (
        select allocation.result_id, sum(allocation.allocated_qty) as allocated_qty
        from jsonb_to_recordset(allocation_chunk) as allocation(
          result_id uuid,
          allocated_qty numeric
        )
        group by allocation.result_id
      ), committed_totals as (
        select allocation.result_id, sum(allocation.allocated_qty) as allocated_qty
        from public.opportunity_finder_allocations allocation
        join chunk_totals target on target.result_id = allocation.result_id
        where allocation.job_id = input_job_id
        group by allocation.result_id
      )
      update public.opportunity_finder_results result
      set allocated_qty = coalesce(committed.allocated_qty, 0) + chunk.allocated_qty
      from chunk_totals chunk
      left join committed_totals committed on committed.result_id = chunk.result_id
      where result.id = chunk.result_id
        and result.job_id = input_job_id
        and result.tenant_id = locked_job.tenant_id;

      perform 1
      from public.commit_opportunity_finder_allocations(
        input_job_id,
        input_worker_id,
        input_lock_token,
        allocation_chunk
      );

      allocation_offset := allocation_end + 1;
    end loop;
  end if;

  select count(*)
  into database_allocation_count
  from public.opportunity_finder_allocations allocation
  where allocation.job_id = input_job_id;

  if database_allocation_count <> allocation_count then
    raise exception using errcode = '23514', message = 'allocation_manifest_count_mismatch';
  end if;

  if exists (
    select 1
    from public.opportunity_finder_output_items staged_item
    cross join lateral jsonb_to_record(staged_item.payload) as expected(
      id uuid,
      allocated_qty numeric
    )
    join public.opportunity_finder_results result
      on result.id = expected.id
     and result.job_id = input_job_id
     and result.tenant_id = locked_job.tenant_id
    where staged_item.run_id = input_run_id
      and staged_item.job_id = input_job_id
      and staged_item.tenant_id = locked_job.tenant_id
      and staged_item.output_kind = 'results'
      and coalesce(result.allocated_qty, 0) <> coalesce(expected.allocated_qty, 0)
  ) then
    raise exception using errcode = '23514', message = 'result_allocation_total_mismatch';
  end if;

  select finalized.*
  into replaced_job
  from public.finalize_opportunity_finder_job(
    input_job_id,
    input_worker_id,
    input_lock_token,
    input_commit_key,
    input_summary || jsonb_build_object('rejectedRows', rejected_count),
    input_warning_count,
    input_missing_mpn_rows,
    input_invalid_quantity_rows
  ) finalized;

  return replaced_job;
end;
$$;

revoke all on function public.replace_opportunity_finder_job_output_from_stage(
  uuid, text, uuid, bigint, text, uuid, jsonb, integer, integer, integer
) from public, anon, authenticated, service_role;

create or replace function public.commit_staged_opportunity_finder_output(
  job_id uuid,
  worker_id text,
  lock_token uuid,
  processing_fence bigint,
  commit_key text,
  expected_counts jsonb,
  summary jsonb,
  warning_count integer,
  missing_mpn_rows integer,
  invalid_quantity_rows integer
)
returns public.opportunity_finder_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  input_job_id alias for $1;
  input_worker_id alias for $2;
  input_lock_token alias for $3;
  input_processing_fence alias for $4;
  input_commit_key alias for $5;
  input_expected_counts alias for $6;
  input_summary alias for $7;
  input_warning_count alias for $8;
  input_missing_mpn_rows alias for $9;
  input_invalid_quantity_rows alias for $10;
  locked_job public.opportunity_finder_jobs%rowtype;
  staged_run public.opportunity_finder_output_runs%rowtype;
  replaced_job public.opportunity_finder_jobs%rowtype;
  expected_kind text;
  expected_count bigint;
  actual_count bigint;
  first_index bigint;
  last_index bigint;
begin
  if input_expected_counts is null or jsonb_typeof(input_expected_counts) <> 'object'
     or input_summary is null or jsonb_typeof(input_summary) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_output_manifest';
  end if;

  if input_warning_count < 0
     or input_missing_mpn_rows < 0
     or input_invalid_quantity_rows < 0 then
    raise exception using errcode = '22023', message = 'invalid_job_counters';
  end if;

  select job.*
  into locked_job
  from public.opportunity_finder_jobs job
  where job.id = input_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'opportunity_job_not_found';
  end if;

  -- Exact replay remains a no-op after successful staging cleanup and lock
  -- release. This check must precede the output-run lookup.
  if locked_job.output_commit_key = input_commit_key
     and locked_job.status in ('completed', 'completed_with_warnings') then
    return locked_job;
  end if;

  if locked_job.locked_by is distinct from input_worker_id
     or locked_job.lock_token is distinct from input_lock_token
     or locked_job.processing_fence is distinct from input_processing_fence
     or locked_job.materialized_lock_token is distinct from input_lock_token then
    raise exception using errcode = '40001', message = 'stale_opportunity_worker_fence';
  end if;

  if locked_job.status not in ('parsing', 'matching')
     or locked_job.cancel_requested then
    raise exception using errcode = '55000', message = 'opportunity_job_not_committable';
  end if;

  select run.*
  into staged_run
  from public.opportunity_finder_output_runs run
  where run.job_id = input_job_id
    and run.commit_key = input_commit_key
  for update;

  if not found
     or staged_run.worker_id is distinct from input_worker_id
     or staged_run.lock_token is distinct from input_lock_token
     or staged_run.processing_fence is distinct from input_processing_fence
     or staged_run.tenant_id is distinct from locked_job.tenant_id then
    raise exception using errcode = '40001', message = 'stale_opportunity_output_run';
  end if;

  foreach expected_kind in array array[
    'results',
    'possible_matches',
    'rejected_rows',
    'allocations',
    'commercials',
    'financials'
  ] loop
    if jsonb_typeof(input_expected_counts -> expected_kind) is distinct from 'number'
       or (input_expected_counts ->> expected_kind) !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'invalid_output_expected_count';
    end if;

    expected_count := (input_expected_counts ->> expected_kind)::bigint;
    select count(*), min(item.item_index), max(item.item_index)
    into actual_count, first_index, last_index
    from public.opportunity_finder_output_items item
    where item.run_id = staged_run.id
      and item.output_kind = expected_kind;

    if actual_count <> expected_count
       or (expected_count > 0 and (first_index <> 0 or last_index <> expected_count - 1))
       or (expected_count = 0 and (first_index is not null or last_index is not null)) then
      raise exception using errcode = '23514', message = 'incomplete_opportunity_output_manifest';
    end if;
  end loop;

  select replaced.*
  into replaced_job
  from public.replace_opportunity_finder_job_output_from_stage(
    input_job_id,
    input_worker_id,
    input_lock_token,
    input_processing_fence,
    input_commit_key,
    staged_run.id,
    input_summary || jsonb_build_object(
      'rejectedRows', (input_expected_counts ->> 'rejected_rows')::bigint
    ),
    input_warning_count,
    input_missing_mpn_rows,
    input_invalid_quantity_rows
  ) replaced;

  -- The run is deleted only after a successful publication. Any late error
  -- rolls the business replacement back and retains pre-existing staged rows.
  delete from public.opportunity_finder_output_runs run
  where run.id = staged_run.id;

  return replaced_job;
end;
$$;

revoke all on function public.commit_staged_opportunity_finder_output(
  uuid, text, uuid, bigint, text, jsonb, jsonb, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.commit_staged_opportunity_finder_output(
  uuid, text, uuid, bigint, text, jsonb, jsonb, integer, integer, integer
) to service_role;

comment on function public.replace_opportunity_finder_job_output_from_stage(
  uuid, text, uuid, bigint, text, uuid, jsonb, integer, integer, integer
) is
  'Private set-based staged publisher. It preserves worker fencing and atomic output replacement without whole-kind JSONB aggregation.';
