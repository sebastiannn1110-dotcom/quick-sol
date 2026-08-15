-- Support deterministic, timeout-safe keyset scans for large upload rebuilds.
create index if not exists business_records_upload_id_keyset_idx
  on public.business_records (upload_batch_id, id desc)
  where archived_at is null;
