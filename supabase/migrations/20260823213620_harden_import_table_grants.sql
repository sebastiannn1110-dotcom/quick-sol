begin;

-- Ronda 4.1: import lifecycle reads require an authenticated application
-- context. Anonymous sessions have no legitimate direct table access.
revoke all privileges
on table public.import_jobs
from anon;

revoke all privileges
on table public.upload_batches
from anon;

-- The legacy ALL grant also left TRUNCATE and table-maintenance capabilities
-- on authenticated. Preserve the legitimate read contract and nothing else.
revoke all privileges
on table public.import_jobs
from authenticated;

revoke all privileges
on table public.upload_batches
from authenticated;

grant select
on table public.import_jobs, public.upload_batches
to authenticated;

commit;
