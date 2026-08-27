begin;

create index if not exists business_stock_needs_snapshot_chunk_idx
  on public.business_stock_needs_snapshot_rows
  (data_scope_id, generation, chunk_sequence, normalized_mpn);

commit;
