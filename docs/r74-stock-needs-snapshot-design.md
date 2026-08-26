# R7.4 Stock Needs snapshot design

Status: local implementation for review. No production apply, deploy or cutover.

## Authorization and canonical scopes

Stock Needs has no independent tenant column. Its authoritative visibility is
derived from the active profile and upload ownership:

- `super_admin_dev` and `admin`: the shared `company` scope.
- `manager`: one `team` scope keyed by the exact `(department, region)` pair;
  the policy-visible owner set is department OR region. Managers with the same
  pair reuse one snapshot. A manager with both values null resolves to `owner`.
- `employee`: `owner:<profile id>` and therefore only owned uploads.
- An explicit authorized upload: `upload:<upload id>`, shared by every actor
  allowed to read that upload. The RPC still masks commercial names for an
  employee.

`client_upload_assignments` does not grant upload visibility and Stock Needs has
no client filter. Assignment changes therefore do not change this snapshot
scope. A future client filter would require a separate canonical client scope;
it must not reinterpret an assignment as authorization.

The number of materialized scopes is:

`1 company + active upload scopes + active owner scopes + unique active manager team keys`.

Users do not receive a new scope when an equivalent canonical key already
exists. With 10, 100 or 1,000 users, administrators add zero row copies,
managers add at most the number of unique team keys, and employees partition
the owner-visible source rows rather than each duplicating the 300,000-row
company universe. Upload scopes also partition the source rows. Team overlap is
the remaining amplification risk and must be measured from production metadata
before cutover; a population approaching one full 300,000-row snapshot per
manager blocks deployment.

## State-machine integration

R7.4 selects consumer-specific readiness (option B). The existing business
summary remains authoritative and Clients/Opportunities do not wait for Stock
Needs. The same `business-summary-worker` process claims both job types and uses
the existing service-role-only claim/lease/heartbeat/fence/error pattern.

Source writes, summary publication, upload archive/status/metadata changes,
file-profile changes and authorization-profile changes increment affected scope
versions and fence an old builder. A rebuild can resume the same generation
after an expired lease when the required version and source fingerprint did not
change. A new write queues a new generation; an old worker cannot publish it.

## Data and build

`business_stock_needs_scopes` holds canonical scope readiness, build cursor,
lease/fence, persisted totals and the active generation pointer.
`business_stock_needs_snapshot_rows` contains narrow MPN aggregates and a
per-coverage ordinal. `business_stock_needs_snapshot_sources` contains at most
five authorized source uploads per MPN.

The builder pages by normalized MPN, aggregates at most 2,000 keys per call,
stages rows/sources transactionally, persists its cursor and validates the
source fingerprint before atomic publication. Partial generations have no
active pointer and are invisible. The previous generation remains physically
available but is never reported READY after `required_version` changes. The
scope header retains exactly the active and immediately previous published
generations. The same worker deletes older derived rows through a
service-role-only RPC in batches of at most 2,000; source rows cascade from the
same bounded batch. Active readers, donor scopes and an in-progress generation
are excluded from cleanup.

The default deep-OFFSET path converts the offset to at most five indexed
coverage-ordinal ranges. It does not re-group, globally sort or linearly skip
300,000 MPN. Filtered totals scan only narrow snapshot rows and use trigram,
coverage or status indexes where applicable.

## Local validation evidence (2026-08-26)

The final migration installed from an empty disposable PostgreSQL database as
36/36 local migrations. The deterministic comparison produced 52/52 identical
canonical SHA-256 payloads and `UNEXPECTED_DIFFERENCE=0`. The runtime also
passed chunk idempotency, heartbeat, fixed evaluation time, lease/reclaim,
resume, stale worker/generation fencing, dirty-during-build fencing, hidden
partial staging, duplicate publish, retry/max-attempts, two-generation
retention, source limit and ACL/RLS checks. Two simultaneous PostgreSQL
connections competing for one scope produced one claim and one `NONE`.

Build measurements (disposable local PostgreSQL, no production data):

| MPN | Chunk | Time | Chunks | Peak backend memory | Peak staged bytes | Temp bytes | Physical snapshot tables |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1,000 | 71.082 s | 10 | 4,604,808 | 372,272 | 0 | 60,137,472 bytes rows+sources; 66,723,840 incl. scopes |
| 100,000 | 2,000 | 89.200 s | 50 | 4,580,232 | 744,536 | 13,860,864 | 172,392,448 bytes rows+sources |
| 300,000 | 2,000 | 172.826 s | 150 | 4,572,040 | 744,536 | 577,509,296 | 422,281,216 bytes rows+sources |

The 300k run executed 305 RPC/heartbeat operations, wrote 300,000 narrow rows
and 300,000 source rows, published one active generation and moved the driver
RSS from 73,351,168 to 77,697,024 bytes. The builder runs in PostgreSQL, so a
Node heap figure is not applicable to this SQL harness; backend memory and
driver RSS are the measured bounded-memory evidence.

The original combined read CTE was rejected by the gate: its actual plan
scanned all 300,000 rows and all sources, produced about 2.23 GB temporary I/O
per 100-read scenario, and random offsets completed only 95/100. The final
unfiltered plan performs five constant-rank probes on
`business_stock_needs_snapshot_default_page_idx` and 100 indexed LATERAL probes
on `business_stock_needs_snapshot_sources_page_idx`; the captured plan showed
100 result rows, 100 source-index loops and no sequential snapshot scan.

Index sizes after the 315k-row company+owner fixture were: default page
112,279,552 bytes; MPN trigram 10,862,592; customer trigram 14,860,288;
supplier trigram 15,851,520; manufacturer trigram 13,459,456; status GIN
4,333,568; source page 33,644,544. Primary/unique indexes enforce immutable
row/source identity and occupied 32,817,152 bytes on rows and 77,414,400 bytes
on sources. The default/source indexes serve deep OFFSET and page provenance;
the four trigram indexes serve the existing substring filters; the status GIN
serves the existing status-array filter. These indexes are scoped by the
physical data scope/generation where applicable and never change authorization.

At 20 clients x 5 transactions, all fixed and random admin, manager and
employee scenarios completed 100/100 with no timeout, error, deadlock, waiting
lock or temp I/O. Admin p95 ranged 383.347-543.738 ms (max 700.743 ms), manager
416.377-642.534 ms (max 889.205 ms), and employee 633.567-1,231.509 ms (max
1,294.341 ms). MPN, explicit upload, customer, status and coverage filters also
completed 100/100 with zero temp I/O; the worst filter was status at p95
4,364.501 ms and max 6,104.848 ms, below the mandatory 7/8-second gate.

## Scope and storage projection

The 300k physical company generation is approximately 422.3 MB including row,
source and index storage. Two retained generations are approximately 844.6 MB.
Equivalent team/company or owner/upload scopes reuse the same immutable
generation and add header rows only. In the scale fixture, four READY logical
scopes (`company`, `team`, `owner`, `upload`) used two physical datasets totaling
315k MPN rows rather than 630k.

- 10, 100 or 1,000 admins add zero physical datasets beyond company.
- Disjoint employee owner scopes partition the company universe; together they
  add about one company-equivalent dataset, not one 300k copy per employee.
- 10 or 100 clients add zero Stock Needs datasets because client assignment is
  not a visibility grant and the endpoint has no client filter.
- Unique overlapping manager team keys are the amplification term. Ten fully
  overlapping unique teams project to about 4.22 GB per generation; 100 to
  42.2 GB; 1,000 to 422 GB. Such production metadata blocks cutover.
- The current product has no Stock Needs tenant dimension. Adding tenants later
  requires tenant in the canonical key and a new cross-tenant review; R7.4 does
  not infer tenant access from clients.

## Compatibility and cutover

`get_stock_needs_page_v1` remains unchanged for application rollback. New code
uses `get_stock_needs_snapshot_state_v1` before and after
`get_stock_needs_snapshot_page_v1`. Missing R7.4 contracts fail closed as
`CONTRACT_UNAVAILABLE`; no v1/global fallback exists in R7.4 code.

Safe order: apply the additive migration, deploy R7.4 code, let the existing
business-summary-worker build queued scopes, verify READY and gates, then leave
Maintenance Mode only after smoke tests. Application rollback points back to v1
and leaves R7.4 tables inert; no destructive down-migration is required.
