-- Run after applying 20260808120000_opportunity_finder_advanced.sql.
-- The fixtures exercise materialization and protected-finance normalization.
-- Every write is rolled back.
begin;

do $$
declare
  test_actor_id uuid := gen_random_uuid();
  test_job_id uuid := gen_random_uuid();
  test_file_a_id uuid := gen_random_uuid();
  test_file_b_id uuid := gen_random_uuid();
  test_lock_token uuid := gen_random_uuid();
  test_untrusted_result_id uuid := gen_random_uuid();
  test_valid_result_id uuid := gen_random_uuid();
  cancelled_stale_job_id uuid := gen_random_uuid();
  canonical_count integer;
  distinct_index_count integer;
  event_count integer;
  option_count integer;
  lot_count integer;
  history_count integer;
  observed_quality text;
  observed_currency text;
  observed_gp numeric;
  observed_margin numeric;
  stale_token_rejected boolean := false;
  stale_generation_rejected boolean := false;
  inactive_status_rejected boolean := false;
  stale_reset_rejected boolean := false;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    test_actor_id,
    test_actor_id::text || '@example.invalid',
    jsonb_build_object('full_name', 'Opportunity Finder DB contract', 'role', 'admin')
  );

  if not exists (
    select 1
    from public.opportunity_finder_tenants tenant
    where tenant.id = test_actor_id
  ) then
    raise exception 'personal Opportunity Finder tenant was not provisioned';
  end if;

  insert into public.opportunity_finder_jobs (
    id,
    created_by,
    tenant_id,
    status,
    current_stage,
    client_context,
    file_a_role,
    file_b_role,
    attempts,
    max_attempts,
    cancel_requested,
    locked_by,
    lock_token,
    processing_fence,
    locked_at,
    heartbeat_at
  )
  values (
    cancelled_stale_job_id,
    test_actor_id,
    test_actor_id,
    'matching',
    'finding_matches',
    null,
    'demand',
    'stock',
    1,
    5,
    true,
    'dead-cancelled-worker',
    gen_random_uuid(),
    1,
    now() - interval '2 hours',
    now() - interval '2 hours'
  );

  perform 1
  from public.claim_opportunity_finder_job(
    'cancel-recovery-contract',
    interval '1 minute'
  );

  if not exists (
    select 1
    from public.opportunity_finder_jobs cancelled_job
    where cancelled_job.id = cancelled_stale_job_id
      and cancelled_job.status = 'cancelled'
      and cancelled_job.cancel_requested = true
      and cancelled_job.error_code = 'JOB_CANCELLED'
      and cancelled_job.cancelled_at is not null
      and cancelled_job.next_retry_at is null
      and cancelled_job.locked_by is null
      and cancelled_job.lock_token is null
  ) then
    raise exception 'stale active cancellation was not finalized';
  end if;

  if not exists (
    select 1
    from public.opportunity_finder_audit_events audit
    where audit.job_id = cancelled_stale_job_id
      and audit.event_type = 'job_cancelled_after_worker_expiry'
  ) then
    raise exception 'stale active cancellation was not audited';
  end if;

  insert into public.opportunity_finder_jobs (
    id,
    created_by,
    tenant_id,
    status,
    current_stage,
    client_context,
    file_a_role,
    file_b_role,
    locked_by,
    lock_token,
    processing_fence
  )
  values (
    test_job_id,
    test_actor_id,
    test_actor_id,
    'parsing',
    'normalizing_mpn',
    '  Context   North  ',
    'demand',
    'stock',
    'advanced-runtime-contract',
    test_lock_token,
    1
  );

  insert into public.opportunity_finder_files (
    id,
    job_id,
    tenant_id,
    side,
    original_file_name,
    storage_path,
    mime_type,
    size_bytes,
    actual_size_bytes,
    content_sha256,
    selected_role,
    detected_type,
    parse_status,
    validation_status
  )
  values
    (
      test_file_a_id,
      test_job_id,
      test_actor_id,
      'A',
      'embedded-offer.xlsx',
      'contract/' || test_job_id::text || '/a.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      100,
      100,
      repeat('a', 64),
      'demand',
      'demand',
      'parsed',
      'verified'
    ),
    (
      test_file_b_id,
      test_job_id,
      test_actor_id,
      'B',
      'stock.xlsx',
      'contract/' || test_job_id::text || '/b.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      100,
      100,
      repeat('b', 64),
      'stock',
      'stock',
      'parsed',
      'verified'
    );

  update public.opportunity_finder_jobs
  set file_a_id = test_file_a_id,
      file_b_id = test_file_b_id
  where id = test_job_id;

  -- One source spreadsheet row can contain both a demand block and an
  -- embedded supplier-offer block. original_index remains the canonical-row
  -- identity while source_row preserves source traceability.
  insert into public.opportunity_finder_rows (
    job_id,
    file_id,
    tenant_id,
    side,
    sheet_name,
    source_row,
    original_index,
    record_role,
    record_kind,
    raw_mpn,
    display_mpn,
    normalized_mpn,
    review_key,
    required_qty,
    demand_event_key,
    option_ordinal,
    is_primary_option,
    is_active_demand,
    raw_quantity,
    required_date_quality,
    unit_of_measure,
    ingestion_lock_token,
    ingestion_fence
  )
  values (
    test_job_id,
    test_file_a_id,
    test_actor_id,
    'A',
    'Snapshot',
    42,
    100,
    'demand',
    'demand_option',
    'ABC-123',
    'ABC-123',
    'ABC-123',
    'ABC123',
    10,
    null,
    1,
    true,
    true,
    '10',
    'missing',
    'EA',
    test_lock_token,
    1
  );

  begin
    insert into public.opportunity_finder_rows (
      job_id, file_id, tenant_id, side, sheet_name, source_row,
      original_index, record_role, record_kind, raw_mpn, display_mpn,
      normalized_mpn, review_key, required_qty, demand_event_key,
      raw_quantity, ingestion_lock_token, ingestion_fence
    )
    values (
      test_job_id, test_file_a_id, test_actor_id, 'A', 'Snapshot', 43,
      102, 'demand', 'demand_option', 'STALE-1', 'STALE-1',
      'STALE-1', 'STALE1', 1, 'stale-event', '1', gen_random_uuid(), 1
    );
  exception
    when sqlstate '40001' then
      stale_token_rejected := true;
  end;

  if not stale_token_rejected then
    raise exception 'staging insert with stale lock token was accepted';
  end if;

  begin
    insert into public.opportunity_finder_rejected_rows (
      tenant_id, job_id, file_id, side, file_name, sheet_name, source_row,
      reason_code, ingestion_lock_token, ingestion_fence
    )
    values (
      test_actor_id, test_job_id, test_file_a_id, 'A', 'embedded-offer.xlsx',
      'Snapshot', 43, 'INVALID_QUANTITY', test_lock_token, 2
    );
  exception
    when sqlstate '40001' then
      stale_generation_rejected := true;
  end;

  if not stale_generation_rejected then
    raise exception 'rejected-row insert with stale processing generation was accepted';
  end if;

  update public.opportunity_finder_jobs
  set status = 'queued'
  where id = test_job_id;

  begin
    insert into public.opportunity_finder_rejected_rows (
      tenant_id, job_id, file_id, side, file_name, sheet_name, source_row,
      reason_code, ingestion_lock_token, ingestion_fence
    )
    values (
      test_actor_id, test_job_id, test_file_a_id, 'A', 'embedded-offer.xlsx',
      'Snapshot', 44, 'INVALID_QUANTITY', test_lock_token, 1
    );
  exception
    when sqlstate '55000' then
      inactive_status_rejected := true;
  end;

  if not inactive_status_rejected then
    raise exception 'rejected-row insert outside an ingestible job status was accepted';
  end if;

  update public.opportunity_finder_jobs
  set status = 'parsing'
  where id = test_job_id;

  insert into public.opportunity_finder_rejected_rows (
    tenant_id, job_id, file_id, side, file_name, sheet_name, source_row,
    reason_code, ingestion_lock_token, ingestion_fence
  )
  values (
    test_actor_id, test_job_id, test_file_a_id, 'A', 'embedded-offer.xlsx',
    'Snapshot', 45, 'INVALID_QUANTITY', test_lock_token, 1
  );

  insert into public.opportunity_finder_rows (
    job_id,
    file_id,
    tenant_id,
    side,
    sheet_name,
    source_row,
    original_index,
    record_role,
    record_kind,
    raw_mpn,
    display_mpn,
    normalized_mpn,
    review_key,
    available_qty,
    supply_lot_key,
    is_live_supply,
    raw_quantity,
    currency,
    currency_status,
    ingestion_lock_token,
    ingestion_fence
  )
  values (
    test_job_id,
    test_file_a_id,
    test_actor_id,
    'A',
    'Snapshot',
    42,
    101,
    'supplier_offer',
    'supply_lot',
    'ABC-123',
    'ABC-123',
    'ABC-123',
    'ABC123',
    8,
    'embedded-lot-1',
    true,
    '8',
    'USD',
    'confirmed',
    test_lock_token,
    1
  );

  select count(*), count(distinct row_data.original_index)
  into canonical_count, distinct_index_count
  from public.opportunity_finder_rows row_data
  where row_data.file_id = test_file_a_id
    and row_data.sheet_name = 'Snapshot'
    and row_data.source_row = 42;

  if canonical_count <> 2 or distinct_index_count <> 2 then
    raise exception
      'embedded blocks did not retain two canonical identities: rows %, indexes %',
      canonical_count,
      distinct_index_count;
  end if;

  select
    materialized.demand_event_count,
    materialized.demand_part_option_count,
    materialized.supply_lot_count,
    materialized.historical_signal_count
  into event_count, option_count, lot_count, history_count
  from public.materialize_opportunity_finder_entities(
    test_job_id,
    'advanced-runtime-contract',
    test_lock_token
  ) materialized;

  if event_count <> 1
     or option_count <> 1
     or lot_count <> 1
     or history_count <> 0 then
    raise exception
      'unexpected materialization counts: events %, options %, lots %, history %',
      event_count,
      option_count,
      lot_count,
      history_count;
  end if;

  if not exists (
    select 1
    from public.opportunity_finder_demand_events event_row
    where event_row.job_id = test_job_id
      and event_row.event_key = concat_ws(chr(31), 'ABC-123', 'Context North', '', 'EA')
      and event_row.client_context = 'Context North'
  ) then
    raise exception 'job client context fallback diverged from generic demand event identity';
  end if;

  if not exists (
    select 1
    from public.opportunity_finder_demand_part_options option_row
    where option_row.job_id = test_job_id
      and option_row.unit_of_measure = 'EA'
      and option_row.source_trace @> jsonb_build_object(
        'sourceRow', 42,
        'originalIndex', 100,
        'optionOrdinal', 1
      )
  ) then
    raise exception 'materialized demand option trace lost physical option identity';
  end if;

  if not exists (
    select 1
    from public.opportunity_finder_supply_lots lot
    where lot.job_id = test_job_id
      and lot.source_trace @> jsonb_build_object(
        'sourceRow', 42,
        'originalIndex', 101
      )
  ) then
    raise exception 'materialized supply lot trace lost physical lot identity';
  end if;

  if not exists (
    select 1
    from public.opportunity_finder_supply_lots lot
    where lot.job_id = test_job_id
      and lot.lot_key = 'embedded-lot-1'
      and lot.supply_role = 'supplier_offer'
      and lot.available_qty = 8
      and lot.remaining_qty = 8
      and lot.is_live_supply = false
  ) then
    raise exception 'supplier offer without a future expiry materialized as live';
  end if;

  insert into public.opportunity_finder_results (
    id,
    job_id,
    tenant_id,
    opportunity_type,
    exact_match,
    display_mpn,
    normalized_mpn,
    reason_code,
    action_code
  )
  values
    (
      test_untrusted_result_id,
      test_job_id,
      test_actor_id,
      'full_sale',
      true,
      'ABC-123',
      'ABC-123',
      'FULL_COVERAGE',
      'CONTACT_CUSTOMER'
    ),
    (
      test_valid_result_id,
      test_job_id,
      test_actor_id,
      'partial_sale',
      true,
      'ABC-123',
      'ABC-123',
      'PARTIAL_COVERAGE',
      'CONTACT_CUSTOMER'
    );

  insert into public.opportunity_finder_result_financials (
    result_id,
    tenant_id,
    job_id,
    unit_cost,
    cost_currency,
    gross_profit,
    gross_margin_percent,
    cost_quality
  )
  values (
    test_untrusted_result_id,
    test_actor_id,
    test_job_id,
    5,
    null,
    100,
    50,
    'valid'
  );

  select
    financial.cost_quality,
    financial.gross_profit,
    financial.gross_margin_percent
  into observed_quality, observed_gp, observed_margin
  from public.opportunity_finder_result_financials financial
  where financial.result_id = test_untrusted_result_id;

  if observed_quality <> 'untrusted'
     or observed_gp is not null
     or observed_margin is not null then
    raise exception
      'cost without currency was not sanitized: quality %, GP %, margin %',
      observed_quality,
      observed_gp,
      observed_margin;
  end if;

  insert into public.opportunity_finder_result_financials (
    result_id,
    tenant_id,
    job_id,
    unit_cost,
    cost_currency,
    gross_profit,
    gross_margin_percent,
    cost_quality
  )
  values (
    test_valid_result_id,
    test_actor_id,
    test_job_id,
    5,
    'USD',
    100,
    50,
    'missing'
  );

  select
    financial.cost_quality,
    financial.cost_currency,
    financial.gross_profit,
    financial.gross_margin_percent
  into observed_quality, observed_currency, observed_gp, observed_margin
  from public.opportunity_finder_result_financials financial
  where financial.result_id = test_valid_result_id;

  if observed_quality <> 'valid'
     or observed_currency <> 'USD'
     or observed_gp <> 100
     or observed_margin <> 50 then
    raise exception
      'valid currency/cost did not remain valid: quality %, currency %, GP %, margin %',
      observed_quality,
      observed_currency,
      observed_gp,
      observed_margin;
  end if;

  begin
    perform public.reset_opportunity_finder_job_attempt(
      test_job_id,
      'advanced-runtime-contract',
      gen_random_uuid(),
      1
    );
  exception
    when sqlstate '40001' then
      stale_reset_rejected := true;
  end;

  if not stale_reset_rejected then
    raise exception 'retry cleanup with a stale token was accepted';
  end if;

  if (select count(*) from public.opportunity_finder_rows where job_id = test_job_id) <> 2
     or (select count(*) from public.opportunity_finder_rejected_rows where job_id = test_job_id) <> 1
     or (select count(*) from public.opportunity_finder_results where job_id = test_job_id) <> 2 then
    raise exception 'failed fenced cleanup changed attempt-owned data';
  end if;

  perform public.reset_opportunity_finder_job_attempt(
    test_job_id,
    'advanced-runtime-contract',
    test_lock_token,
    1
  );

  if exists (select 1 from public.opportunity_finder_rows where job_id = test_job_id)
     or exists (select 1 from public.opportunity_finder_rejected_rows where job_id = test_job_id)
     or exists (select 1 from public.opportunity_finder_results where job_id = test_job_id)
     or exists (select 1 from public.opportunity_finder_supply_lots where job_id = test_job_id)
     or exists (select 1 from public.opportunity_finder_demand_events where job_id = test_job_id) then
    raise exception 'valid fenced cleanup left attempt-owned data behind';
  end if;

  -- The atomic output RPC writes rejected rows internally. It must populate
  -- the same attempt fence so the table trigger does not need a bypass path.
  perform 1
  from public.materialize_opportunity_finder_entities(
    test_job_id,
    'advanced-runtime-contract',
    test_lock_token
  );

  perform public.replace_opportunity_finder_job_output(
    test_job_id,
    'advanced-runtime-contract',
    test_lock_token,
    'runtime-contract-commit-v1',
    '[]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'file_id', test_file_a_id,
      'side', 'A',
      'file_name', 'embedded-offer.xlsx',
      'sheet_name', 'Snapshot',
      'source_row', 46,
      'source_row_hidden', false,
      'reason_code', 'MISSING_MPN',
      'field_name', 'mpn'
    )),
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    1,
    1,
    0
  );

  if not exists (
    select 1
    from public.opportunity_finder_rejected_rows rejected
    where rejected.job_id = test_job_id
      and rejected.source_row = 46
      and rejected.ingestion_lock_token = test_lock_token
      and rejected.ingestion_fence = 1
  ) then
    raise exception 'atomic output RPC did not preserve rejected-row attempt fence';
  end if;
end;
$$;

-- A single result may legitimately reserve more than 10,000 distinct lots.
-- The worker uploads small fenced chunks, nothing is visible before commit,
-- and the final transaction validates the complete per-result allocation sum.
do $$
declare
  bulk_actor_id uuid := gen_random_uuid();
  bulk_job_id uuid := gen_random_uuid();
  bulk_file_a_id uuid := gen_random_uuid();
  bulk_file_b_id uuid := gen_random_uuid();
  bulk_lock_token uuid := gen_random_uuid();
  bulk_event_id uuid := gen_random_uuid();
  bulk_option_id uuid := gen_random_uuid();
  bulk_result_id uuid := gen_random_uuid();
  bulk_candidate_lot_id uuid;
  bulk_commit_key text := 'runtime-bulk-output-10001-v1';
  allocation_batch jsonb;
  chunk_start integer;
  stale_append_rejected boolean := false;
  stale_commit_rejected boolean := false;
  incomplete_manifest_rejected boolean := false;
  late_commit_rejected boolean := false;
  committed_job public.opportunity_finder_jobs%rowtype;
  bulk_started_at timestamptz := clock_timestamp();
  bulk_commit_started_at timestamptz;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    bulk_actor_id,
    bulk_actor_id::text || '@example.invalid',
    jsonb_build_object('full_name', 'Opportunity bulk output contract', 'role', 'admin')
  );

  insert into public.opportunity_finder_jobs (
    id,
    created_by,
    tenant_id,
    status,
    current_stage,
    file_a_role,
    file_b_role,
    locked_by,
    lock_token,
    processing_fence,
    materialized_lock_token,
    materialized_at
  )
  values (
    bulk_job_id,
    bulk_actor_id,
    bulk_actor_id,
    'matching',
    'finding_matches',
    'demand',
    'stock',
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_lock_token,
    now()
  );

  insert into public.opportunity_finder_files (
    id,
    job_id,
    tenant_id,
    side,
    original_file_name,
    storage_path,
    mime_type,
    size_bytes,
    actual_size_bytes,
    content_sha256,
    selected_role,
    detected_type,
    parse_status,
    validation_status
  )
  values
    (
      bulk_file_a_id,
      bulk_job_id,
      bulk_actor_id,
      'A',
      'bulk-demand.csv',
      'placeholder/bulk-demand.csv',
      'text/csv',
      100,
      100,
      repeat('c', 64),
      'demand',
      'demand',
      'parsed',
      'verified'
    ),
    (
      bulk_file_b_id,
      bulk_job_id,
      bulk_actor_id,
      'B',
      'bulk-stock.csv',
      'placeholder/bulk-stock.csv',
      'text/csv',
      100,
      100,
      repeat('d', 64),
      'stock',
      'stock',
      'parsed',
      'verified'
    );

  update public.opportunity_finder_jobs
  set file_a_id = bulk_file_a_id,
      file_b_id = bulk_file_b_id
  where id = bulk_job_id;

  insert into public.opportunity_finder_demand_events (
    id,
    tenant_id,
    job_id,
    file_id,
    event_key,
    required_qty,
    allocated_qty,
    remaining_qty,
    deterministic_order
  )
  values (
    bulk_event_id,
    bulk_actor_id,
    bulk_job_id,
    bulk_file_a_id,
    'bulk-event-10001',
    10001,
    0,
    10001,
    1
  );

  insert into public.opportunity_finder_demand_part_options (
    id,
    tenant_id,
    job_id,
    demand_event_id,
    file_id,
    raw_mpn,
    display_mpn,
    exact_norm,
    search_norm,
    manufacturer_original,
    manufacturer_canonical,
    option_ordinal,
    is_primary_option,
    source_trace
  )
  values (
    bulk_option_id,
    bulk_actor_id,
    bulk_job_id,
    bulk_event_id,
    bulk_file_a_id,
    'BULK-0001',
    'BULK-0001',
    'BULK-0001',
    'BULK0001',
    'ACME COMPONENTS',
    'ACME COMPONENTS',
    1,
    true,
    jsonb_build_object('fileId', bulk_file_a_id, 'sheetName', 'Demand', 'sourceRow', 2)
  );

  insert into public.opportunity_finder_supply_lots (
    tenant_id,
    job_id,
    file_id,
    lot_key,
    supply_role,
    raw_mpn,
    display_mpn,
    exact_norm,
    search_norm,
    manufacturer_original,
    manufacturer_canonical,
    available_qty,
    allocated_qty,
    remaining_qty,
    is_live_supply,
    deterministic_order,
    source_trace
  )
  select
    bulk_actor_id,
    bulk_job_id,
    bulk_file_b_id,
    'bulk-lot-' || lpad(series.number::text, 5, '0'),
    'stock',
    'BULK-0001',
    'BULK-0001',
    'BULK-0001',
    'BULK0001',
    'ACME COMPONENTS',
    'ACME COMPONENTS',
    1,
    0,
    1,
    true,
    series.number,
    jsonb_build_object(
      'fileId', bulk_file_b_id,
      'sheetName', 'Stock',
      'sourceRow', series.number + 1
    )
  from generate_series(1, 10001) series(number);

  select lot.id
  into bulk_candidate_lot_id
  from public.opportunity_finder_supply_lots lot
  where lot.job_id = bulk_job_id
  order by lot.deterministic_order
  limit 1;

  perform public.begin_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key
  );

  perform public.append_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key,
    'results',
    0,
    jsonb_build_array(jsonb_build_object(
      'id', bulk_result_id,
      'result_key', 'bulk-result-10001',
      'opportunity_type', 'full_sale',
      'exact_match', true,
      'exact_mpn_match', true,
      'usable_availability_match', true,
      'exact_quantity_match', true,
      'match_tier', 'exact_mpn_mfg',
      'confidence', 'high',
      'review_status', 'not_required',
      'demand_event_id', bulk_event_id,
      'demand_event_key', 'bulk-event-10001',
      'display_mpn', 'BULK-0001',
      'normalized_mpn', 'BULK-0001',
      'manufacturer', 'ACME COMPONENTS',
      'manufacturer_canonical', 'ACME COMPONENTS',
      'required_qty', 10001,
      'available_qty', 10001,
      'allocated_qty', 10001,
      'remaining_qty', 0,
      'shortage_qty', 0,
      'coverage_percent', 100,
      'reason_code', 'FULL_COVERAGE',
      'action_code', 'CONTACT_CUSTOMER',
      'warnings', jsonb_build_array()
    ))
  );

  perform public.append_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key,
    'rejected_rows',
    0,
    jsonb_build_array(jsonb_build_object(
      'file_id', bulk_file_a_id,
      'side', 'A',
      'file_name', 'bulk-demand.csv',
      'sheet_name', 'Demand',
      'source_row', 10003,
      'source_row_hidden', false,
      'reason_code', 'MISSING_MPN',
      'field_name', 'mpn'
    ))
  );

  perform public.append_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key,
    'possible_matches',
    0,
    jsonb_build_array(jsonb_build_object(
      'candidate_key', 'bulk-possible-match-10001',
      'demand_option_id', bulk_option_id,
      'supply_lot_id', bulk_candidate_lot_id,
      'demand_display_mpn', 'BULK-0001',
      'supply_display_mpn', 'BULK0001',
      'demand_normalized_mpn', 'BULK-0001',
      'supply_normalized_mpn', 'BULK0001',
      'review_key', 'BULK0001',
      'demand_file_id', bulk_file_a_id,
      'supply_file_id', bulk_file_b_id,
      'reason_code', 'symbol_variant',
      'match_tier', 'search_mpn_mfg',
      'confidence', 'review',
      'review_status', 'pending'
    ))
  );

  perform public.append_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key,
    'commercials',
    0,
    jsonb_build_array(jsonb_build_object(
      'result_id', bulk_result_id,
      'target_price', 12,
      'offer_price', 10,
      'target_gap_percent', -16.6667,
      'currency', 'USD',
      'revenue_potential', 100010,
      'pricing_quality', 'confirmed'
    ))
  );

  perform public.append_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key,
    'financials',
    0,
    jsonb_build_array(jsonb_build_object(
      'result_id', bulk_result_id,
      'unit_cost', 8,
      'cost_currency', 'USD',
      'gross_profit', 20002,
      'gross_margin_percent', 20,
      'cost_quality', 'valid',
      'cost_source_trace', jsonb_build_object('source', 'synthetic-runtime'),
      'computed_at', now()
    ))
  );

  for chunk_start in 1..10001 by 500 loop
    select jsonb_agg(
      jsonb_build_object(
        'allocation_key', bulk_result_id::text || ':' || lot.lot_key,
        'result_id', bulk_result_id,
        'demand_event_id', bulk_event_id,
        'demand_event_key', 'bulk-event-10001',
        'demand_part_option_id', bulk_option_id,
        'supply_lot_id', lot.id,
        'supply_lot_key', lot.lot_key,
        'allocated_qty', 1,
        'reserved_qty', 1,
        'deterministic_rank', lot.deterministic_order - 1,
        'decision_trace', jsonb_build_object('matchTier', 'exact_mpn_mfg'),
        'supply_trace', lot.source_trace
      )
      order by lot.deterministic_order
    )
    into allocation_batch
    from public.opportunity_finder_supply_lots lot
    where lot.job_id = bulk_job_id
      and lot.deterministic_order between chunk_start and least(chunk_start + 499, 10001);

    perform public.append_opportunity_finder_output(
      bulk_job_id,
      'bulk-runtime-contract',
      bulk_lock_token,
      7,
      bulk_commit_key,
      'allocations',
      chunk_start - 1,
      allocation_batch
    );
  end loop;

  begin
    perform public.append_opportunity_finder_output(
      bulk_job_id,
      'bulk-runtime-contract',
      bulk_lock_token,
      8,
      bulk_commit_key,
      'commercials',
      0,
      jsonb_build_array(jsonb_build_object('result_id', bulk_result_id))
    );
  exception
    when sqlstate '40001' then
      stale_append_rejected := true;
  end;

  if not stale_append_rejected then
    raise exception 'stale processing fence appended staged output';
  end if;

  begin
    perform public.commit_staged_opportunity_finder_output(
      bulk_job_id,
      'bulk-runtime-contract',
      bulk_lock_token,
      8,
      bulk_commit_key,
      jsonb_build_object(
        'results', 1,
        'possible_matches', 1,
        'rejected_rows', 1,
        'allocations', 10001,
        'commercials', 1,
        'financials', 1
      ),
      jsonb_build_object('exactMatches', 1),
      0,
      0,
      0
    );
  exception
    when sqlstate '40001' then
      stale_commit_rejected := true;
  end;

  if not stale_commit_rejected then
    raise exception 'stale processing fence committed staged output';
  end if;

  if exists (
    select 1 from public.opportunity_finder_results result where result.job_id = bulk_job_id
  ) or exists (
    select 1 from public.opportunity_finder_rejected_rows rejected where rejected.job_id = bulk_job_id
  ) then
    raise exception 'staged output became visible before atomic commit';
  end if;

  begin
    perform public.commit_staged_opportunity_finder_output(
      bulk_job_id,
      'bulk-runtime-contract',
      bulk_lock_token,
      7,
      bulk_commit_key,
      jsonb_build_object(
        'results', 1,
        'possible_matches', 1,
        'rejected_rows', 1,
        'allocations', 10002,
        'commercials', 1,
        'financials', 1
      ),
      jsonb_build_object('exactMatches', 1, 'rejectedRows', 0),
      0,
      0,
      0
    );
  exception
    when sqlstate '23514' then
      incomplete_manifest_rejected := true;
  end;

  if not incomplete_manifest_rejected then
    raise exception 'incomplete staged output manifest was accepted';
  end if;

  if exists (
    select 1 from public.opportunity_finder_results result where result.job_id = bulk_job_id
  ) then
    raise exception 'failed manifest validation published partial output';
  end if;

  -- Force a foreign-key failure after candidates, results and commercials
  -- have been inserted. The subtransaction must roll all publication changes
  -- back while retaining the staged run for a corrected retry.
  update public.opportunity_finder_output_items staged_item
  set payload = jsonb_set(
    staged_item.payload,
    '{result_id}',
    to_jsonb(gen_random_uuid()::text)
  )
  where staged_item.run_id = (
      select run.id
      from public.opportunity_finder_output_runs run
      where run.job_id = bulk_job_id
    )
    and staged_item.output_kind = 'financials'
    and staged_item.item_index = 0;

  begin
    perform public.commit_staged_opportunity_finder_output(
      bulk_job_id,
      'bulk-runtime-contract',
      bulk_lock_token,
      7,
      bulk_commit_key,
      jsonb_build_object(
        'results', 1,
        'possible_matches', 1,
        'rejected_rows', 1,
        'allocations', 10001,
        'commercials', 1,
        'financials', 1
      ),
      jsonb_build_object('exactMatches', 1),
      0,
      0,
      0
    );
  exception
    when foreign_key_violation then
      late_commit_rejected := true;
  end;

  if not late_commit_rejected then
    raise exception 'late staged foreign-key failure was accepted';
  end if;

  if exists (
    select 1 from public.opportunity_finder_results result where result.job_id = bulk_job_id
  ) or exists (
    select 1 from public.opportunity_finder_possible_matches candidate where candidate.job_id = bulk_job_id
  ) or exists (
    select 1 from public.opportunity_finder_result_commercials commercial where commercial.job_id = bulk_job_id
  ) or exists (
    select 1 from public.opportunity_finder_result_financials financial where financial.job_id = bulk_job_id
  ) or exists (
    select 1 from public.opportunity_finder_rejected_rows rejected where rejected.job_id = bulk_job_id
  ) or exists (
    select 1 from public.opportunity_finder_allocations allocation where allocation.job_id = bulk_job_id
  ) then
    raise exception 'late staged failure published partial business output';
  end if;

  if exists (
    select 1
    from public.opportunity_finder_supply_lots lot
    where lot.job_id = bulk_job_id
      and (lot.allocated_qty <> 0 or lot.remaining_qty <> lot.available_qty)
  ) or exists (
    select 1
    from public.opportunity_finder_demand_events event_row
    where event_row.id = bulk_event_id
      and (event_row.allocated_qty <> 0 or event_row.remaining_qty <> event_row.required_qty)
  ) then
    raise exception 'late staged failure did not roll quantity counters back';
  end if;

  if not exists (
    select 1
    from public.opportunity_finder_output_runs run
    where run.job_id = bulk_job_id
  ) or not exists (
    select 1
    from public.opportunity_finder_output_items staged_item
    where staged_item.job_id = bulk_job_id
      and staged_item.output_kind = 'financials'
      and staged_item.item_index = 0
  ) then
    raise exception 'late staged failure removed retryable staging rows';
  end if;

  update public.opportunity_finder_output_items staged_item
  set payload = jsonb_set(
    staged_item.payload,
    '{result_id}',
    to_jsonb(bulk_result_id::text)
  )
  where staged_item.run_id = (
      select run.id
      from public.opportunity_finder_output_runs run
      where run.job_id = bulk_job_id
    )
    and staged_item.output_kind = 'financials'
    and staged_item.item_index = 0;

  bulk_commit_started_at := clock_timestamp();

  select committed.*
  into committed_job
  from public.commit_staged_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key,
    jsonb_build_object(
      'results', 1,
      'possible_matches', 1,
      'rejected_rows', 1,
      'allocations', 10001,
      'commercials', 1,
      'financials', 1
    ),
    jsonb_build_object('exactMatches', 1, 'rejectedRows', 0),
    0,
    0,
    0
  ) committed;

  raise notice 'bulk_10001_setup_seconds=%, bulk_10001_commit_seconds=%',
    round(extract(epoch from (bulk_commit_started_at - bulk_started_at))::numeric, 3),
    round(extract(epoch from (clock_timestamp() - bulk_commit_started_at))::numeric, 3);

  if committed_job.status <> 'completed_with_warnings'
     or committed_job.result_count <> 1 then
    raise exception
      'rejected-only output did not finalize with warnings: status %, result_count %',
      committed_job.status,
      committed_job.result_count;
  end if;

  if (select count(*) from public.opportunity_finder_allocations allocation where allocation.job_id = bulk_job_id) <> 10001
     or (select sum(allocation.allocated_qty) from public.opportunity_finder_allocations allocation where allocation.result_id = bulk_result_id) <> 10001
     or (select allocated_qty from public.opportunity_finder_results result where result.id = bulk_result_id) <> 10001
     or exists (
       select 1
       from public.opportunity_finder_supply_lots lot
       where lot.job_id = bulk_job_id
         and (lot.allocated_qty <> 1 or lot.remaining_qty <> 0)
     )
     or exists (
       select 1
       from public.opportunity_finder_demand_events event_row
       where event_row.id = bulk_event_id
         and (event_row.allocated_qty <> 10001 or event_row.remaining_qty <> 0)
     ) then
    raise exception 'bulk allocation commit violated result, lot or demand invariants';
  end if;

  if (select count(*) from public.opportunity_finder_rejected_rows rejected where rejected.job_id = bulk_job_id) <> 1 then
    raise exception 'bulk staged rejected row was not published';
  end if;

  if (select count(*) from public.opportunity_finder_possible_matches candidate where candidate.job_id = bulk_job_id) <> 1
     or (select count(*) from public.opportunity_finder_result_commercials commercial where commercial.job_id = bulk_job_id) <> 1
     or (select count(*) from public.opportunity_finder_result_financials financial where financial.job_id = bulk_job_id) <> 1 then
    raise exception 'bulk staged six-kind output was not published completely';
  end if;

  if exists (
    select 1 from public.opportunity_finder_output_runs run where run.job_id = bulk_job_id
  ) or exists (
    select 1 from public.opportunity_finder_output_items item where item.job_id = bulk_job_id
  ) then
    raise exception 'committed output staging rows were not removed';
  end if;

  -- Exact replay succeeds after staging cleanup by matching output_commit_key.
  perform public.commit_staged_opportunity_finder_output(
    bulk_job_id,
    'bulk-runtime-contract',
    bulk_lock_token,
    7,
    bulk_commit_key,
    jsonb_build_object(
      'results', 1,
      'possible_matches', 1,
      'rejected_rows', 1,
      'allocations', 10001,
      'commercials', 1,
      'financials', 1
    ),
    jsonb_build_object('exactMatches', 1),
    0,
    0,
    0
  );

  if (select count(*) from public.opportunity_finder_allocations allocation where allocation.job_id = bulk_job_id) <> 10001 then
    raise exception 'idempotent staged-output replay duplicated allocations';
  end if;
end;
$$;

-- Allocation authorization must be derived from durable entity identity and
-- review evidence. A caller-provided review_status is never authoritative.
do $$
<<allocation_identity_runtime>>
declare
  actor_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  demand_file_id uuid := gen_random_uuid();
  supply_file_id uuid := gen_random_uuid();
  lock_token uuid := gen_random_uuid();
  event_id uuid := gen_random_uuid();
  option_id uuid := gen_random_uuid();
  kg_option_id uuid := gen_random_uuid();
  legacy_option_id uuid := gen_random_uuid();
  exact_lot_id uuid := gen_random_uuid();
  alias_lot_id uuid := gen_random_uuid();
  equivalent_lot_id uuid := gen_random_uuid();
  mismatch_lot_id uuid := gen_random_uuid();
  uom_lot_id uuid := gen_random_uuid();
  exact_result_id uuid := gen_random_uuid();
  alias_result_id uuid := gen_random_uuid();
  equivalent_result_id uuid := gen_random_uuid();
  mismatch_result_id uuid := gen_random_uuid();
  uom_result_id uuid := gen_random_uuid();
  manufacturer_version_id uuid := gen_random_uuid();
  manufacturer_id uuid := gen_random_uuid();
  equivalence_version_id uuid := gen_random_uuid();
  spoofed_status_rejected boolean := false;
  inactive_equivalence_rejected boolean := false;
  mismatched_identity_rejected boolean := false;
  mismatched_uom_rejected boolean := false;
  missing_option_rejected boolean := false;
  observed_message text;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    actor_id,
    actor_id::text || '@example.invalid',
    jsonb_build_object('full_name', 'Allocation identity runtime', 'role', 'admin')
  );

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage,
    file_a_role, file_b_role, locked_by, lock_token, processing_fence,
    materialized_lock_token
  ) values (
    job_id, actor_id, actor_id, 'matching', 'finding_matches',
    'demand', 'stock', 'allocation-integrity-runtime', lock_token, 3,
    lock_token
  );

  insert into public.opportunity_finder_files (
    id, job_id, tenant_id, side, original_file_name, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256,
    selected_role, detected_type, parse_status, validation_status
  ) values
    (
      demand_file_id, job_id, actor_id, 'A', 'identity-demand.csv',
      actor_id::text || '/' || job_id::text || '/' || demand_file_id::text || '.csv',
      'text/csv', 100, 100, repeat('c', 64),
      'demand', 'demand', 'parsed', 'verified'
    ),
    (
      supply_file_id, job_id, actor_id, 'B', 'identity-stock.csv',
      actor_id::text || '/' || job_id::text || '/' || supply_file_id::text || '.csv',
      'text/csv', 100, 100, repeat('d', 64),
      'stock', 'stock', 'parsed', 'verified'
    );

  insert into public.opportunity_finder_demand_events (
    id, tenant_id, job_id, file_id, event_key, required_qty,
    allocated_qty, remaining_qty, unit_of_measure, deterministic_order
  ) values (
    event_id, actor_id, job_id, demand_file_id, 'identity-event', 10,
    0, 10, ' EA ', 1
  );

  insert into public.opportunity_finder_demand_part_options (
    id, tenant_id, job_id, demand_event_id, file_id,
    raw_mpn, display_mpn, exact_norm, search_norm,
    manufacturer_original, manufacturer_canonical, unit_of_measure, option_ordinal,
    is_primary_option, source_trace
  ) values
    (
      option_id, actor_id, job_id, event_id, demand_file_id,
      'ABC-123', 'ABC-123', 'ABC-123', 'ABC123',
      'TI', 'TEXAS INSTRUMENTS', ' ＥＡ ', 1, true,
      jsonb_build_object('fileId', demand_file_id, 'sourceRow', 2)
    ),
    (
      kg_option_id, actor_id, job_id, event_id, demand_file_id,
      'ABC-123', 'ABC-123', 'ABC-123', 'ABC123',
      'TI', 'TEXAS INSTRUMENTS', 'KG', 2, false,
      jsonb_build_object('fileId', demand_file_id, 'sourceRow', 3)
    ),
    (
      legacy_option_id, actor_id, job_id, event_id, demand_file_id,
      'ABC-123', 'ABC-123', 'ABC-123', 'ABC123',
      'TI', 'TEXAS INSTRUMENTS', null, 3, false,
      jsonb_build_object('fileId', demand_file_id, 'sourceRow', 4)
    );

  insert into public.opportunity_finder_supply_lots (
    id, tenant_id, job_id, file_id, lot_key, supply_role,
    raw_mpn, display_mpn, exact_norm, search_norm,
    manufacturer_original, manufacturer_canonical, available_qty,
    allocated_qty, remaining_qty, unit_of_measure, is_live_supply,
    deterministic_order, source_trace
  ) values
    (
      exact_lot_id, actor_id, job_id, supply_file_id, 'identity-exact', 'stock',
      'ABC-123', 'ABC-123', 'ABC-123', 'ABC123', 'TI', 'TEXAS INSTRUMENTS',
      2, 0, 2, 'EA', true, 1, jsonb_build_object('sourceRow', 2)
    ),
    (
      alias_lot_id, actor_id, job_id, supply_file_id, 'identity-alias', 'stock',
      'ABC-123', 'ABC-123', 'ABC-123', 'ABC123',
      'Texas Instruments', 'TEXAS INSTRUMENTS',
      2, 0, 2, 'EA', true, 2, jsonb_build_object('sourceRow', 3)
    ),
    (
      equivalent_lot_id, actor_id, job_id, supply_file_id, 'identity-equivalent', 'stock',
      'XYZ-987', 'XYZ-987', 'XYZ-987', 'XYZ987', 'TI', 'TEXAS INSTRUMENTS',
      2, 0, 2, 'EA', true, 3, jsonb_build_object('sourceRow', 4)
    ),
    (
      mismatch_lot_id, actor_id, job_id, supply_file_id, 'identity-mismatch', 'stock',
      'NO-LINK', 'NO-LINK', 'NO-LINK', 'NOLINK', 'TI', 'TEXAS INSTRUMENTS',
      2, 0, 2, 'EA', true, 4, jsonb_build_object('sourceRow', 5)
    ),
    (
      uom_lot_id, actor_id, job_id, supply_file_id, 'identity-uom', 'stock',
      'ABC-123', 'ABC-123', 'ABC-123', 'ABC123', 'TI', 'TEXAS INSTRUMENTS',
      2, 0, 2, 'KG', true, 5, jsonb_build_object('sourceRow', 6)
    );

  if public.opportunity_finder_allocation_identity_kind(
    actor_id, job_id, kg_option_id, exact_lot_id
  ) is not null then
    raise exception 'option-level KG UOM was replaced by the event EA UOM';
  end if;

  if public.opportunity_finder_allocation_identity_kind(
    actor_id, job_id, option_id, exact_lot_id
  ) <> 'exact_mpn_mfg' then
    raise exception 'NFKC-equivalent option/lot UOM was rejected';
  end if;

  if public.opportunity_finder_allocation_identity_kind(
    actor_id, job_id, legacy_option_id, exact_lot_id
  ) <> 'exact_mpn_mfg'
     or public.opportunity_finder_allocation_identity_kind(
       actor_id, job_id, legacy_option_id, uom_lot_id
     ) is not null then
    raise exception 'legacy null option UOM did not fall back to the event UOM';
  end if;

  insert into public.opportunity_finder_manufacturer_registry_versions (
    id, tenant_id, version_tag, status, created_by, approved_by, approved_at
  ) values (
    manufacturer_version_id, actor_id, 'allocation-runtime-mfg-v1', 'draft',
    actor_id, actor_id, now()
  );

  insert into public.opportunity_finder_manufacturers (
    id, tenant_id, version_id, canonical_name, normalized_name, status, created_by
  ) values (
    manufacturer_id, actor_id, manufacturer_version_id,
    'Texas Instruments', 'TEXAS INSTRUMENTS', 'active', actor_id
  );

  insert into public.opportunity_finder_manufacturer_aliases (
    tenant_id, version_id, manufacturer_id, alias_original, alias_normalized,
    approval_status, approved_by, decided_at
  ) values (
    actor_id, manufacturer_version_id, manufacturer_id, 'TI', 'TI',
    'approved', actor_id, now()
  );

  if public.opportunity_finder_allocation_identity_kind(
    actor_id, job_id, option_id, alias_lot_id
  ) is not null then
    raise exception 'draft manufacturer alias version authorized an allocation identity';
  end if;

  update public.opportunity_finder_manufacturer_registry_versions
  set status = 'active'
  where id = manufacturer_version_id;

  if public.opportunity_finder_allocation_identity_kind(
    actor_id, job_id, option_id, alias_lot_id
  ) <> 'exact_mpn_approved_alias' then
    raise exception 'active approved manufacturer alias did not resolve option/lot identity';
  end if;

  insert into public.opportunity_finder_part_equivalence_versions (
    id, tenant_id, version_tag, status, created_by, approved_by, approved_at
  ) values (
    equivalence_version_id, actor_id, 'allocation-runtime-part-v1', 'draft',
    actor_id, actor_id, now()
  );

  insert into public.opportunity_finder_part_equivalences (
    tenant_id, version_id, from_exact_norm, from_manufacturer_normalized,
    to_exact_norm, to_manufacturer_normalized, equivalence_kind,
    approval_status, requires_review, approved_by, decided_at
  ) values (
    actor_id, equivalence_version_id, 'ABC-123', 'TI', 'XYZ-987', 'TI',
    'approved_alternate', 'approved', true, actor_id, now()
  );

  insert into public.opportunity_finder_results (
    id, tenant_id, job_id, result_key, opportunity_type, exact_match,
    exact_mpn_match, match_tier, confidence, review_status, demand_event_id,
    demand_event_key, display_mpn, normalized_mpn, manufacturer,
    manufacturer_canonical, required_qty, available_qty, allocated_qty,
    remaining_qty, shortage_qty, reason_code, action_code
  ) values
    (
      exact_result_id, actor_id, job_id, 'identity-result-exact', 'partial_sale', true,
      true, 'exact_mpn_mfg', 'high', 'not_required', event_id,
      'identity-event', 'ABC-123', 'ABC-123', 'TI', 'TEXAS INSTRUMENTS',
      10, 2, 2, 0, 8, 'FULL_COVERAGE', 'CONTACT_CUSTOMER'
    ),
    (
      alias_result_id, actor_id, job_id, 'identity-result-alias', 'partial_sale', true,
      true, 'exact_mpn_approved_alias', 'review', 'approved', event_id,
      'identity-event', 'ABC-123', 'ABC-123', 'TI', 'TEXAS INSTRUMENTS',
      10, 2, 2, 0, 8, 'MANUFACTURER_ALIAS_REVIEW', 'REVIEW_MANUFACTURER'
    ),
    (
      equivalent_result_id, actor_id, job_id, 'identity-result-equivalent', 'partial_sale', false,
      false, 'search_mpn_mfg', 'review', 'approved', event_id,
      'identity-event', 'ABC-123', 'ABC-123', 'TI', 'TEXAS INSTRUMENTS',
      10, 2, 2, 0, 8, 'SYMBOL_VARIANT', 'REVIEW_CANDIDATE'
    ),
    (
      mismatch_result_id, actor_id, job_id, 'identity-result-mismatch', 'partial_sale', false,
      false, 'search_mpn_mfg', 'review', 'approved', event_id,
      'identity-event', 'ABC-123', 'ABC-123', 'TI', 'TEXAS INSTRUMENTS',
      10, 2, 1, 1, 9, 'SYMBOL_VARIANT', 'REVIEW_CANDIDATE'
    ),
    (
      uom_result_id, actor_id, job_id, 'identity-result-uom', 'partial_sale', true,
      true, 'exact_mpn_mfg', 'high', 'not_required', event_id,
      'identity-event', 'ABC-123', 'ABC-123', 'TI', 'TEXAS INSTRUMENTS',
      10, 2, 1, 1, 9, 'FULL_COVERAGE', 'CONTACT_CUSTOMER'
    );

  perform public.commit_opportunity_finder_allocations(
    job_id, 'allocation-integrity-runtime', lock_token,
    jsonb_build_array(jsonb_build_object(
      'allocation_key', 'identity-allocation-exact',
      'result_id', exact_result_id,
      'demand_event_id', event_id,
      'demand_part_option_id', option_id,
      'supply_lot_id', exact_lot_id,
      'supply_lot_key', 'identity-exact',
      'allocated_qty', 2,
      'reserved_qty', 2
    ))
  );

  begin
    perform public.commit_opportunity_finder_allocations(
      job_id, 'allocation-integrity-runtime', lock_token,
      jsonb_build_array(jsonb_build_object(
        'allocation_key', 'identity-allocation-spoofed-review',
        'result_id', alias_result_id,
        'demand_event_id', event_id,
        'demand_part_option_id', option_id,
        'supply_lot_id', alias_lot_id,
        'supply_lot_key', 'identity-alias',
        'allocated_qty', 2,
        'reserved_qty', 2
      ))
    );
  exception
    when sqlstate '23514' then
      get stacked diagnostics observed_message = message_text;
      spoofed_status_rejected := observed_message = 'durable_review_required_before_allocation';
  end;

  if not spoofed_status_rejected then
    raise exception 'self-declared approved review_status authorized an alias allocation';
  end if;

  insert into public.opportunity_finder_review_decisions (
    tenant_id, job_id, entity_type, entity_id, decision, reviewer_id, decided_at
  ) values (
    actor_id, job_id, 'result', alias_result_id, 'approved', actor_id, now()
  );

  perform public.commit_opportunity_finder_allocations(
    job_id, 'allocation-integrity-runtime', lock_token,
    jsonb_build_array(jsonb_build_object(
      'allocation_key', 'identity-allocation-alias-reviewed',
      'result_id', alias_result_id,
      'demand_event_id', event_id,
      'demand_part_option_id', option_id,
      'supply_lot_id', alias_lot_id,
      'supply_lot_key', 'identity-alias',
      'allocated_qty', 2,
      'reserved_qty', 2
    ))
  );

  insert into public.opportunity_finder_review_decisions (
    tenant_id, job_id, entity_type, entity_id, decision, reviewer_id, decided_at
  ) values
    (actor_id, job_id, 'result', equivalent_result_id, 'approved', actor_id, now()),
    (actor_id, job_id, 'result', mismatch_result_id, 'approved', actor_id, now());

  begin
    perform public.commit_opportunity_finder_allocations(
      job_id, 'allocation-integrity-runtime', lock_token,
      jsonb_build_array(jsonb_build_object(
        'allocation_key', 'identity-allocation-inactive-equivalence',
        'result_id', equivalent_result_id,
        'demand_event_id', event_id,
        'demand_part_option_id', option_id,
        'supply_lot_id', equivalent_lot_id,
        'supply_lot_key', 'identity-equivalent',
        'allocated_qty', 2,
        'reserved_qty', 2
      ))
    );
  exception
    when sqlstate '23514' then
      get stacked diagnostics observed_message = message_text;
      inactive_equivalence_rejected := observed_message = 'allocation_option_lot_identity_mismatch';
  end;

  if not inactive_equivalence_rejected then
    raise exception 'approved equivalence from a draft version authorized an allocation';
  end if;

  update public.opportunity_finder_part_equivalence_versions
  set status = 'active'
  where id = equivalence_version_id;

  perform public.commit_opportunity_finder_allocations(
    job_id, 'allocation-integrity-runtime', lock_token,
    jsonb_build_array(jsonb_build_object(
      'allocation_key', 'identity-allocation-active-equivalence',
      'result_id', equivalent_result_id,
      'demand_event_id', event_id,
      'demand_part_option_id', option_id,
      'supply_lot_id', equivalent_lot_id,
      'supply_lot_key', 'identity-equivalent',
      'allocated_qty', 2,
      'reserved_qty', 2
    ))
  );

  begin
    perform public.commit_opportunity_finder_allocations(
      job_id, 'allocation-integrity-runtime', lock_token,
      jsonb_build_array(jsonb_build_object(
        'allocation_key', 'identity-allocation-mismatch',
        'result_id', mismatch_result_id,
        'demand_event_id', event_id,
        'demand_part_option_id', option_id,
        'supply_lot_id', mismatch_lot_id,
        'supply_lot_key', 'identity-mismatch',
        'allocated_qty', 1,
        'reserved_qty', 1
      ))
    );
  exception
    when sqlstate '23514' then
      get stacked diagnostics observed_message = message_text;
      mismatched_identity_rejected := observed_message = 'allocation_option_lot_identity_mismatch';
  end;

  if not mismatched_identity_rejected then
    raise exception 'durable review authorized an unrelated option/lot pair';
  end if;

  begin
    perform public.commit_opportunity_finder_allocations(
      job_id, 'allocation-integrity-runtime', lock_token,
      jsonb_build_array(jsonb_build_object(
        'allocation_key', 'identity-allocation-uom-mismatch',
        'result_id', uom_result_id,
        'demand_event_id', event_id,
        'demand_part_option_id', kg_option_id,
        'supply_lot_id', exact_lot_id,
        'supply_lot_key', 'identity-exact',
        'allocated_qty', 1,
        'reserved_qty', 1
      ))
    );
  exception
    when sqlstate '23514' then
      get stacked diagnostics observed_message = message_text;
      mismatched_uom_rejected := observed_message = 'allocation_unit_of_measure_mismatch';
  end;

  if not mismatched_uom_rejected then
    raise exception 'KG sibling option was allocated against an EA lot';
  end if;

  begin
    perform public.commit_opportunity_finder_allocations(
      job_id, 'allocation-integrity-runtime', lock_token,
      jsonb_build_array(jsonb_build_object(
        'allocation_key', 'identity-allocation-missing-option',
        'result_id', exact_result_id,
        'demand_event_id', event_id,
        'supply_lot_id', exact_lot_id,
        'supply_lot_key', 'identity-exact',
        'allocated_qty', 1,
        'reserved_qty', 1
      ))
    );
  exception
    when sqlstate '22023' then
      get stacked diagnostics observed_message = message_text;
      missing_option_rejected := observed_message = 'allocation_demand_option_required';
  end;

  if not missing_option_rejected then
    raise exception 'allocation without durable demand option identity was accepted';
  end if;

  if (
       select count(*)
       from public.opportunity_finder_allocations allocation
       where allocation.job_id = allocation_identity_runtime.job_id
     ) <> 3
     or (select allocated_qty from public.opportunity_finder_demand_events where id = event_id) <> 6
     or (select remaining_qty from public.opportunity_finder_supply_lots where id = mismatch_lot_id) <> 2
     or (select remaining_qty from public.opportunity_finder_supply_lots where id = uom_lot_id) <> 2 then
    raise exception 'rejected identity/review allocations changed durable quantities';
  end if;
end;
$$;

-- Candidate review identity is derived from candidate_key, so deleting and
-- atomically replacing output cannot orphan an approved durable decision.
do $$
<<candidate_identity_runtime>>
declare
  actor_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  demand_file_id uuid := gen_random_uuid();
  supply_file_id uuid := gen_random_uuid();
  lock_token uuid := gen_random_uuid();
  result_id uuid := gen_random_uuid();
  candidate_key text := repeat('f', 64);
  candidate_id uuid := 'ffffffff-ffff-5fff-bfff-ffffffffffff'::uuid;
  mismatched_id_rejected boolean := false;
  observed_message text;
  candidate_payload jsonb;
  result_payload jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    actor_id,
    actor_id::text || '@example.invalid',
    jsonb_build_object('full_name', 'Durable candidate runtime', 'role', 'admin')
  );

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage,
    file_a_role, file_b_role, locked_by, lock_token, processing_fence,
    materialized_lock_token
  ) values (
    job_id, actor_id, actor_id, 'matching', 'finding_matches',
    'demand', 'stock', 'candidate-identity-runtime', lock_token, 4,
    lock_token
  );

  insert into public.opportunity_finder_files (
    id, job_id, tenant_id, side, original_file_name, storage_path,
    mime_type, size_bytes, actual_size_bytes, content_sha256,
    selected_role, detected_type, parse_status, validation_status
  ) values
    (
      demand_file_id, job_id, actor_id, 'A', 'candidate-demand.csv',
      actor_id::text || '/' || job_id::text || '/' || demand_file_id::text || '.csv',
      'text/csv', 100, 100, repeat('a', 64),
      'demand', 'demand', 'parsed', 'verified'
    ),
    (
      supply_file_id, job_id, actor_id, 'B', 'candidate-stock.csv',
      actor_id::text || '/' || job_id::text || '/' || supply_file_id::text || '.csv',
      'text/csv', 100, 100, repeat('b', 64),
      'stock', 'stock', 'parsed', 'verified'
    );

  candidate_payload := jsonb_build_object(
    'candidate_key', candidate_key,
    'demand_display_mpn', 'ABC-123',
    'supply_display_mpn', 'ABC123',
    'demand_normalized_mpn', 'ABC-123',
    'supply_normalized_mpn', 'ABC123',
    'review_key', 'ABC123',
    'demand_file_id', demand_file_id,
    'supply_file_id', supply_file_id,
    'reason_code', 'symbol_variant',
    'match_tier', 'search_mpn_mfg',
    'confidence', 'review',
    'review_status', 'pending'
  );

  result_payload := jsonb_build_object(
    'id', result_id,
    'result_key', 'durable-candidate-result',
    'opportunity_type', 'review_required',
    'exact_match', false,
    'exact_mpn_match', false,
    'match_tier', 'search_mpn_mfg',
    'confidence', 'review',
    'review_status', 'pending',
    'candidate_id', candidate_id,
    'display_mpn', 'ABC-123',
    'normalized_mpn', 'ABC-123',
    'required_qty', 1,
    'available_qty', 1,
    'allocated_qty', 0,
    'remaining_qty', 1,
    'shortage_qty', 1,
    'coverage_percent', 0,
    'reason_code', 'SYMBOL_VARIANT',
    'action_code', 'REVIEW_CANDIDATE',
    'warnings', jsonb_build_array()
  );

  begin
    perform public.replace_opportunity_finder_job_output(
      job_id, 'candidate-identity-runtime', lock_token,
      'candidate-id-mismatch',
      jsonb_build_array(),
      jsonb_build_array(candidate_payload || jsonb_build_object('id', gen_random_uuid())),
      jsonb_build_array(), jsonb_build_array(), jsonb_build_array(), jsonb_build_array(),
      '{}'::jsonb, 0, 0, 0
    );
  exception
    when sqlstate '23514' then
      get stacked diagnostics observed_message = message_text;
      mismatched_id_rejected := observed_message = 'candidate_id_key_mismatch';
  end;

  if not mismatched_id_rejected then
    raise exception 'payload candidate id inconsistent with candidate_key was accepted';
  end if;

  perform public.replace_opportunity_finder_job_output(
    job_id, 'candidate-identity-runtime', lock_token,
    'candidate-first-commit',
    jsonb_build_array(result_payload),
    jsonb_build_array(candidate_payload),
    jsonb_build_array(), jsonb_build_array(), jsonb_build_array(), jsonb_build_array(),
    '{}'::jsonb, 0, 0, 0
  );

  if not exists (
    select 1
    from public.opportunity_finder_possible_matches candidate
    where candidate.job_id = candidate_identity_runtime.job_id
      and candidate.id = candidate_identity_runtime.candidate_id
      and candidate.candidate_key = candidate_identity_runtime.candidate_key
  ) or not exists (
    select 1
    from public.opportunity_finder_results result
    where result.id = candidate_identity_runtime.result_id
      and result.candidate_id = candidate_identity_runtime.candidate_id
  ) then
    raise exception 'initial replace did not derive or connect deterministic candidate UUID';
  end if;

  perform set_config('request.jwt.claim.sub', actor_id::text, true);
  perform public.decide_opportunity_finder_review(
    job_id, 'possible_match', candidate_identity_runtime.candidate_id, 'approved', 'durable candidate review'
  );

  update public.opportunity_finder_jobs job
  set status = 'matching',
      current_stage = 'finding_matches',
      completed_at = null,
      locked_by = 'candidate-identity-runtime',
      locked_at = now(),
      lock_token = candidate_identity_runtime.lock_token,
      heartbeat_at = now()
  where job.id = candidate_identity_runtime.job_id;

  perform public.replace_opportunity_finder_job_output(
    job_id, 'candidate-identity-runtime', lock_token,
    'candidate-second-commit',
    jsonb_build_array(result_payload),
    jsonb_build_array(candidate_payload || jsonb_build_object('id', candidate_identity_runtime.candidate_id)),
    jsonb_build_array(), jsonb_build_array(), jsonb_build_array(), jsonb_build_array(),
    '{}'::jsonb, 0, 0, 0
  );

  if (select count(*) from public.opportunity_finder_possible_matches candidate
      where candidate.job_id = candidate_identity_runtime.job_id) <> 1
     or not exists (
       select 1
       from public.opportunity_finder_possible_matches candidate
       where candidate.job_id = candidate_identity_runtime.job_id
         and candidate.id = candidate_identity_runtime.candidate_id
         and candidate.candidate_key = candidate_identity_runtime.candidate_key
         and candidate.review_status = 'approved'
     )
     or not exists (
       select 1
       from public.opportunity_finder_review_decisions decision
       where decision.job_id = candidate_identity_runtime.job_id
         and decision.entity_type = 'possible_match'
         and decision.entity_id = candidate_identity_runtime.candidate_id
         and decision.decision = 'approved'
     )
     or not exists (
       select 1
       from public.opportunity_finder_results result
       where result.id = candidate_identity_runtime.result_id
         and result.candidate_id = candidate_identity_runtime.candidate_id
     ) then
    raise exception 're-replace orphaned candidate review or reset approved status';
  end if;
end;
$$;

do $$
<<state_transition_runtime>>
declare
  actor_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  file_a_id uuid := gen_random_uuid();
  file_b_id uuid := gen_random_uuid();
  valid_until timestamptz := now() + interval '7 days';
  transitioned_job public.opportunity_finder_jobs%rowtype;
  duplicate_confirm_rejected boolean := false;
  missing_validity_rejected boolean := false;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    actor_id,
    actor_id::text || '@example.invalid',
    jsonb_build_object('full_name', 'Opportunity state transition contract', 'role', 'admin')
  );

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage, attempts, max_attempts,
    cancel_requested
  ) values (
    job_id, actor_id, actor_id, 'awaiting_roles', 'confirming_roles', 0, 5, false
  );

  insert into public.opportunity_finder_files (
    id, job_id, tenant_id, side, original_file_name, storage_path, mime_type,
    size_bytes, detected_type, selected_role, parse_status, validation_status,
    profiled_at
  ) values
    (
      file_a_id, job_id, actor_id, 'A', 'demand.xlsx',
      'ignored/' || file_a_id::text || '.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      10, 'demand', null, 'profiled', 'verified', now()
    ),
    (
      file_b_id, job_id, actor_id, 'B', 'offer.xlsx',
      'ignored/' || file_b_id::text || '.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      10, 'supplier_offer', null, 'profiled', 'verified', now()
    );

  update public.opportunity_finder_jobs
  set file_a_id = state_transition_runtime.file_a_id,
      file_b_id = state_transition_runtime.file_b_id
  where id = state_transition_runtime.job_id;

  select transitioned.* into transitioned_job
  from public.confirm_opportunity_finder_roles(
    job_id,
    actor_id,
    file_a_id,
    'demand',
    null,
    file_b_id,
    'supplier_offer',
    valid_until
  ) transitioned;

  if transitioned_job.status <> 'queued'
     or transitioned_job.file_a_role <> 'demand'
     or transitioned_job.file_b_role <> 'supplier_offer'
     or not exists (
       select 1
       from public.opportunity_finder_files file
       where file.id = file_b_id
         and file.selected_role = 'supplier_offer'
         and file.validity_override_expires_at = valid_until
     ) then
    raise exception 'atomic role confirmation did not persist a coherent validity-attested transition';
  end if;

  begin
    perform public.confirm_opportunity_finder_roles(
      job_id, actor_id, file_a_id, 'stock', null,
      file_b_id, 'demand', null
    );
  exception
    when sqlstate '55000' then
      duplicate_confirm_rejected := true;
  end;
  if not duplicate_confirm_rejected then
    raise exception 'a second concurrent-equivalent role confirmation was accepted';
  end if;

  select cancelled.* into transitioned_job
  from public.cancel_opportunity_finder_job(job_id, actor_id) cancelled;
  if transitioned_job.status <> 'cancelled'
     or transitioned_job.cancel_requested <> true then
    raise exception 'atomic cancel did not commit the terminal transition';
  end if;

  select retried.* into transitioned_job
  from public.retry_opportunity_finder_job(job_id, actor_id) retried;
  if transitioned_job.status <> 'queued'
     or transitioned_job.current_stage <> 'normalizing_mpn'
     or transitioned_job.cancel_requested <> false then
    raise exception 'atomic retry did not restore a ready job';
  end if;

  update public.opportunity_finder_jobs
  set status = 'awaiting_roles',
      current_stage = 'confirming_roles',
      file_a_role = null,
      file_b_role = null
  where id = state_transition_runtime.job_id;
  update public.opportunity_finder_files file
  set selected_role = null,
      validity_override_expires_at = null
  where file.job_id = state_transition_runtime.job_id;

  begin
    perform public.confirm_opportunity_finder_roles(
      job_id, actor_id, file_a_id, 'demand', null,
      file_b_id, 'supplier_offer', null
    );
  exception
    when sqlstate '22023' then
      missing_validity_rejected := true;
  end;
  if not missing_validity_rejected then
    raise exception 'supplier offer without durable future validity was confirmed';
  end if;
  if exists (
    select 1
    from public.opportunity_finder_files file
    where file.job_id = state_transition_runtime.job_id
      and file.selected_role is not null
  ) then
    raise exception 'failed role confirmation left a partial file mutation';
  end if;

  if (
    select count(*)
    from public.opportunity_finder_audit_events audit
    where audit.job_id = state_transition_runtime.job_id
      and audit.event_type in ('roles_confirmed', 'job_cancel_requested', 'job_retried')
  ) <> 3 then
    raise exception 'atomic user transitions were not durably audited';
  end if;
end;
$$;

-- Profile queueing, interactive/retention deletion and file retention all use
-- job-first locks plus durable claims. This exercises both the happy path and
-- crash recovery without touching object storage.
do $$
<<deletion_retention_runtime>>
declare
  actor_id uuid := gen_random_uuid();
  queue_job_id uuid := gen_random_uuid();
  queue_file_a_id uuid := gen_random_uuid();
  queue_file_b_id uuid := gen_random_uuid();
  active_job_id uuid := gen_random_uuid();
  retention_job_id uuid := gen_random_uuid();
  retention_file_a_id uuid := gen_random_uuid();
  retention_file_b_id uuid := gen_random_uuid();
  delete_job_id uuid := gen_random_uuid();
  delete_file_a_id uuid := gen_random_uuid();
  delete_file_b_id uuid := gen_random_uuid();
  observed_at timestamptz := clock_timestamp();
  queued_job public.opportunity_finder_jobs%rowtype;
  prepared_job public.opportunity_finder_jobs%rowtype;
  finalized_job_id uuid;
  claimed_file record;
  old_token uuid;
  new_token uuid;
  queue_claim_rejected boolean := false;
  retry_claim_rejected boolean := false;
  confirm_claim_rejected boolean := false;
  active_delete_rejected boolean := false;
  claimed_delete_rejected boolean := false;
  stale_finalize_rejected boolean := false;
  stale_abort_rejected boolean := false;
  stale_job_status_rejected boolean := false;
  deletion_retry_rejected boolean := false;
  claimed_count integer := 0;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    actor_id,
    actor_id::text || '@example.invalid',
    jsonb_build_object('full_name', 'Deletion retention runtime', 'role', 'admin')
  );

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage
  ) values (
    queue_job_id, actor_id, actor_id, 'uploading', 'uploading'
  );
  insert into public.opportunity_finder_files (
    id, job_id, tenant_id, side, original_file_name, storage_path,
    mime_type, size_bytes, parse_status, validation_status
  ) values
    (
      queue_file_a_id, queue_job_id, actor_id, 'A', 'queue-a.csv',
      actor_id::text || '/' || queue_job_id::text || '/' || queue_file_a_id::text || '.csv',
      'text/csv', 10, 'pending_upload', 'pending'
    ),
    (
      queue_file_b_id, queue_job_id, actor_id, 'B', 'queue-b.csv',
      actor_id::text || '/' || queue_job_id::text || '/' || queue_file_b_id::text || '.csv',
      'text/csv', 10, 'pending_upload', 'pending'
    );
  update public.opportunity_finder_jobs job
  set file_a_id = queue_file_a_id,
      file_b_id = queue_file_b_id
  where job.id = queue_job_id;

  select queued.* into queued_job
  from public.queue_opportunity_finder_profile(
    queue_job_id, actor_id, 'uploading', observed_at
  ) queued;
  if queued_job.status <> 'queued'
     or queued_job.current_stage <> 'inspecting_sheets'
     or (select count(*) from public.opportunity_finder_files file
         where file.job_id = queue_job_id
           and file.uploaded_at = observed_at
           and file.parse_status = 'uploaded') <> 2
     or not exists (
       select 1 from public.opportunity_finder_audit_events audit
       where audit.job_id = queue_job_id
         and audit.event_type = 'upload_confirmed_and_queued'
     ) then
    raise exception 'profile queue RPC did not atomically update both files, job and audit';
  end if;

  update public.opportunity_finder_jobs job
  set status = 'failed', error_code = 'TEST_FAILURE'
  where job.id = queue_job_id;
  update public.opportunity_finder_files file
  set storage_deletion_token = gen_random_uuid(),
      storage_deletion_started_at = observed_at
  where file.id = queue_file_a_id;

  begin
    perform public.queue_opportunity_finder_profile(
      queue_job_id, actor_id, 'failed', observed_at
    );
  exception when sqlstate '55000' then
    queue_claim_rejected := true;
  end;
  begin
    perform public.retry_opportunity_finder_job(queue_job_id, actor_id);
  exception when sqlstate '55000' then
    retry_claim_rejected := true;
  end;
  update public.opportunity_finder_jobs job
  set status = 'awaiting_roles', current_stage = 'confirming_roles'
  where job.id = queue_job_id;
  begin
    perform public.confirm_opportunity_finder_roles(
      queue_job_id, actor_id,
      queue_file_a_id, 'demand', null,
      queue_file_b_id, 'stock', null
    );
  exception when sqlstate '55000' then
    confirm_claim_rejected := true;
  end;
  if not queue_claim_rejected or not retry_claim_rejected or not confirm_claim_rejected then
    raise exception 'a source transition accepted a file with an active deletion token';
  end if;
  update public.opportunity_finder_files file
  set storage_deletion_token = null,
      storage_deletion_started_at = null
  where file.id = queue_file_a_id;

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage
  ) values (
    active_job_id, actor_id, actor_id, 'matching', 'finding_matches'
  );
  begin
    perform public.prepare_opportunity_finder_job_deletion(active_job_id, actor_id);
  exception when sqlstate '55000' then
    active_delete_rejected := true;
  end;
  if not active_delete_rejected then
    raise exception 'interactive deletion prepared a worker-active job';
  end if;

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage
  ) values (
    retention_job_id, actor_id, actor_id, 'completed', 'completed'
  );
  insert into public.opportunity_finder_files (
    id, job_id, tenant_id, side, original_file_name, storage_path,
    mime_type, size_bytes, parse_status, validation_status, file_expires_at
  ) values
    (
      retention_file_a_id, retention_job_id, actor_id, 'A', 'retention-a.csv',
      actor_id::text || '/' || retention_job_id::text || '/' || retention_file_a_id::text || '.csv',
      'text/csv', 10, 'parsed', 'verified', observed_at - interval '1 day'
    ),
    (
      retention_file_b_id, retention_job_id, actor_id, 'B', 'retention-b.csv',
      actor_id::text || '/' || retention_job_id::text || '/' || retention_file_b_id::text || '.csv',
      'text/csv', 10, 'parsed', 'verified', observed_at - interval '1 day'
    );

  select claim.* into claimed_file
  from public.claim_opportunity_finder_file_retention(1, observed_at) claim;
  if claimed_file.file_id is distinct from retention_file_a_id
     and claimed_file.file_id is distinct from retention_file_b_id then
    raise exception 'retention claim selected a non-expired/non-terminal file';
  end if;
  old_token := claimed_file.storage_deletion_token;

  update public.opportunity_finder_files file
  set storage_deletion_started_at = observed_at - interval '3 hours'
  where file.storage_deletion_token = old_token;

  select claim.* into claimed_file
  from public.claim_opportunity_finder_file_retention(1, observed_at) claim;
  new_token := claimed_file.storage_deletion_token;
  if claimed_file.file_id is null
     or claimed_file.file_id is distinct from (
       select file.id from public.opportunity_finder_files file
       where file.storage_deletion_token = new_token
     )
     or new_token = old_token
     or not exists (
       select 1 from public.opportunity_finder_audit_events audit
       where audit.job_id = retention_job_id
         and audit.entity_id = claimed_file.file_id
         and audit.event_type = 'source_file_retention_reclaimed'
     ) then
    raise exception 'stale file-retention lease was not reclaimed with a new fence';
  end if;

  begin
    perform public.finalize_opportunity_finder_file_retention(old_token, observed_at);
  exception when sqlstate 'P0002' then
    stale_finalize_rejected := true;
  end;
  begin
    perform public.abort_opportunity_finder_file_retention(
      old_token, 'STORAGE_DELETE_FAILED'
    );
  exception when sqlstate 'P0002' then
    stale_abort_rejected := true;
  end;
  begin
    perform public.prepare_opportunity_finder_job_deletion(retention_job_id, actor_id);
  exception when sqlstate '40001' then
    claimed_delete_rejected := true;
  end;
  if not stale_finalize_rejected or not stale_abort_rejected or not claimed_delete_rejected then
    raise exception 'old retention token or concurrent whole-job deletion escaped fencing';
  end if;

  perform public.finalize_opportunity_finder_file_retention(new_token, observed_at);
  if not exists (
    select 1 from public.opportunity_finder_files file
    where file.id = claimed_file.file_id
      and file.storage_deleted_at = observed_at
      and file.storage_deletion_token is null
  ) or not exists (
    select 1 from public.opportunity_finder_audit_events audit
    where audit.job_id = retention_job_id
      and audit.entity_id = claimed_file.file_id
      and audit.event_type = 'source_file_deleted'
  ) then
    raise exception 'retention finalize did not atomically mark and audit deletion';
  end if;

  select claim.* into claimed_file
  from public.claim_opportunity_finder_file_retention(1, observed_at) claim;
  perform public.abort_opportunity_finder_file_retention(
    claimed_file.storage_deletion_token, 'STORAGE_DELETE_FAILED'
  );
  if exists (
    select 1 from public.opportunity_finder_files file
    where file.id = claimed_file.file_id
      and file.storage_deletion_token is not null
  ) or not exists (
    select 1 from public.opportunity_finder_audit_events audit
    where audit.job_id = retention_job_id
      and audit.entity_id = claimed_file.file_id
      and audit.event_type = 'source_file_deletion_failed'
      and audit.safe_metadata = jsonb_build_object('failureCode', 'STORAGE_DELETE_FAILED')
  ) then
    raise exception 'retention abort did not clear the claim or emitted unsafe audit metadata';
  end if;
  update public.opportunity_finder_files file
  set file_expires_at = observed_at + interval '1 day'
  where file.id = claimed_file.file_id;

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage, expires_at
  ) values (
    delete_job_id, actor_id, actor_id, 'completed', 'completed',
    observed_at - interval '1 day'
  );
  insert into public.opportunity_finder_files (
    id, job_id, tenant_id, side, original_file_name, storage_path,
    mime_type, size_bytes, parse_status, validation_status, file_expires_at
  ) values
    (
      delete_file_a_id, delete_job_id, actor_id, 'A', 'delete-a.csv',
      actor_id::text || '/' || delete_job_id::text || '/' || delete_file_a_id::text || '.csv',
      'text/csv', 10, 'parsed', 'verified', observed_at - interval '1 day'
    ),
    (
      delete_file_b_id, delete_job_id, actor_id, 'B', 'delete-b.csv',
      actor_id::text || '/' || delete_job_id::text || '/' || delete_file_b_id::text || '.csv',
      'text/csv', 10, 'parsed', 'verified', observed_at - interval '1 day'
    );

  begin
    perform public.prepare_opportunity_finder_expired_job_deletion(
      delete_job_id, 'failed', observed_at
    );
  exception when sqlstate '40001' then
    stale_job_status_rejected := true;
  end;
  if not stale_job_status_rejected then
    raise exception 'expired-job retention accepted a stale status snapshot';
  end if;

  select prepared.* into prepared_job
  from public.prepare_opportunity_finder_expired_job_deletion(
    delete_job_id, 'completed', observed_at
  ) prepared;
  if prepared_job.status <> 'cancelled'
     or prepared_job.error_code <> 'JOB_DELETION_REQUESTED'
     or prepared_job.locked_by is not null
     or prepared_job.lock_token is not null then
    raise exception 'expired-job prepare did not make the job terminal and unclaimable';
  end if;

  begin
    perform public.retry_opportunity_finder_job(delete_job_id, actor_id);
  exception when sqlstate '55000' then
    deletion_retry_rejected := true;
  end;
  if not deletion_retry_rejected then
    raise exception 'retry reactivated a prepared deletion';
  end if;

  if exists (
    select 1
    from public.claim_opportunity_finder_file_retention(10, observed_at) claim
    where claim.job_id = delete_job_id
  ) then
    raise exception 'fresh interactive deletion was stolen by file retention';
  end if;

  claimed_count := 0;
  for claimed_file in
    select claim.*
    from public.claim_opportunity_finder_file_retention(
      10, observed_at + interval '3 hours'
    ) claim
    where claim.job_id = delete_job_id
  loop
    claimed_count := claimed_count + 1;
    perform public.finalize_opportunity_finder_file_retention(
      claimed_file.storage_deletion_token, observed_at + interval '3 hours'
    );
  end loop;
  if claimed_count <> 2 then
    raise exception 'stale interactive deletion did not release both files to retention';
  end if;

  finalized_job_id := public.finalize_opportunity_finder_job_deletion(
    delete_job_id, actor_id
  );
  if finalized_job_id is distinct from delete_job_id
     or exists (
       select 1 from public.opportunity_finder_jobs job where job.id = delete_job_id
     )
     or exists (
       select 1 from public.opportunity_finder_files file where file.job_id = delete_job_id
     )
     or not exists (
       select 1 from public.opportunity_finder_audit_events audit
       where audit.job_id is null
         and audit.entity_id = delete_job_id
         and audit.event_type = 'job_deleted'
     ) then
    raise exception 'job finalize did not delete children while preserving append-only audit';
  end if;
end;
$$;

-- Execute owner isolation as the real authenticated role. Static policy/grant
-- inspection cannot catch a policy helper that returns the wrong tenant.
do $$
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (
      '10000000-0000-4000-8000-000000000001'::uuid,
      'rls-a@example.invalid',
      jsonb_build_object('full_name', 'RLS A', 'role', 'admin')
    ),
    (
      '10000000-0000-4000-8000-000000000002'::uuid,
      'rls-b@example.invalid',
      jsonb_build_object('full_name', 'RLS B', 'role', 'admin')
    );

  insert into public.opportunity_finder_jobs (
    id, created_by, tenant_id, status, current_stage
  ) values
    (
      '20000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      'completed', 'completed'
    ),
    (
      '20000000-0000-4000-8000-000000000002'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      'completed', 'completed'
    );

  insert into public.opportunity_finder_files (
    id, job_id, tenant_id, side, original_file_name, storage_path,
    mime_type, size_bytes, parse_status, validation_status
  ) values
    (
      '30000000-0000-4000-8000-000000000001'::uuid,
      '20000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      'A', 'rls-a.csv', 'rls/a.csv', 'text/csv', 10, 'parsed', 'verified'
    ),
    (
      '30000000-0000-4000-8000-000000000002'::uuid,
      '20000000-0000-4000-8000-000000000002'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      'A', 'rls-b.csv', 'rls/b.csv', 'text/csv', 10, 'parsed', 'verified'
    );

  insert into public.opportunity_finder_results (
    id, tenant_id, job_id, result_key, opportunity_type, exact_match,
    display_mpn, normalized_mpn, reason_code, action_code
  ) values
    (
      '40000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '20000000-0000-4000-8000-000000000001'::uuid,
      'rls-a-result', 'sourcing_needed', false,
      'RLS-A', 'RLS-A', 'NO_LIVE_SUPPLY', 'SOURCE_PART'
    ),
    (
      '40000000-0000-4000-8000-000000000002'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      '20000000-0000-4000-8000-000000000002'::uuid,
      'rls-b-result', 'sourcing_needed', false,
      'RLS-B', 'RLS-B', 'NO_LIVE_SUPPLY', 'SOURCE_PART'
    );
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

do $$
begin
  if (select count(*) from public.opportunity_finder_jobs job
      where job.id in (
        '20000000-0000-4000-8000-000000000001'::uuid,
        '20000000-0000-4000-8000-000000000002'::uuid
      )) <> 1
     or not exists (
       select 1 from public.opportunity_finder_jobs job
       where job.id = '20000000-0000-4000-8000-000000000001'::uuid
     )
     or exists (
       select 1 from public.opportunity_finder_jobs job
       where job.id = '20000000-0000-4000-8000-000000000002'::uuid
     )
     or (select count(*) from public.opportunity_finder_files file
         where file.id in (
           '30000000-0000-4000-8000-000000000001'::uuid,
           '30000000-0000-4000-8000-000000000002'::uuid
         )) <> 1
     or not exists (
       select 1 from public.opportunity_finder_files file
       where file.id = '30000000-0000-4000-8000-000000000001'::uuid
     )
     or exists (
       select 1 from public.opportunity_finder_files file
       where file.id = '30000000-0000-4000-8000-000000000002'::uuid
     )
     or (select count(*) from public.opportunity_finder_results result
         where result.id in (
           '40000000-0000-4000-8000-000000000001'::uuid,
           '40000000-0000-4000-8000-000000000002'::uuid
         )) <> 1
     or not exists (
       select 1 from public.opportunity_finder_results result
       where result.id = '40000000-0000-4000-8000-000000000001'::uuid
     )
     or exists (
       select 1 from public.opportunity_finder_results result
       where result.id = '40000000-0000-4000-8000-000000000002'::uuid
     ) then
    raise exception 'authenticated RLS exposed cross-tenant jobs/files/results';
  end if;
end;
$$;

reset role;

rollback;
