-- Supports timeout-safe keyset pagination for large per-upload reconciliations.
-- Additive only; source records are unchanged.

create index if not exists business_records_upload_keyset_idx
  on public.business_records (upload_batch_id, created_at desc, id desc)
  where archived_at is null;

comment on index public.business_records_upload_keyset_idx is
  'Supports bounded keyset reads for versioned business summary rebuilds.';
