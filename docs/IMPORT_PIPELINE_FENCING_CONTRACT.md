# Import pipeline fencing contract

This contract defines the distinct responsibilities of `generation` and
`lease_token` in the Ronda 4 import pipeline.

## Generation

`generation` is the logical processing generation and staging namespace for an
import job. It starts at `1` and advances only when an authorized explicit retry
starts a new logical processing cycle. Explicit retry clears staging, resets
attempt counters and derived publication state, and increments both
`generation` and `lease_token`.

Staging rows persist the job generation, and every worker mutation supplies and
validates that generation. A result from an earlier logical retry is therefore
superseded and cannot be staged, validated, published, progressed, or failed.

## Lease token

`lease_token` is the monotonic fencing token for a concrete worker ownership
lease. Claim, stale recovery, explicit retry, cancellation, failure, and legacy
safe finalization advance it when they invalidate an existing owner. A claimed
worker must present the current generation, token, owner identity, and an
unexpired lease to mutate the job.

Stale recovery intentionally preserves `generation`: the logical processing
cycle remains the same. It advances `lease_token`, removes the old owner and
lease, and deletes staging for that generation. The following claim advances
the token again and establishes a new owner. The stale worker's old token is
then rejected with `IMPORT_WORKER_FENCED` by stage, progress, validation,
publication, and failure contracts.

`safe_finalize_import_job_v2` is not a worker-lease operation. It is limited to
authorized legacy jobs and rejects backend-issued Ronda 4 jobs, including a job
whose prior worker lease became stale.

## Decision

The design is `LEASE_TOKEN_FENCING_CORRECT`. Incrementing `generation` during
stale recovery is unnecessary because the token is the worker-ownership fence,
and doing so would redefine a lease handoff as a new logical retry. Permanent
database tests exercise stale-worker rejection for every mutating contract,
staging cleanup, and continuation by the newly claimed worker.
