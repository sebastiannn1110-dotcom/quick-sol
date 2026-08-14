# QuikSol performance comparison

## What changed

The interactive Stock and Opportunities paths now read exact, versioned canonical summaries. Source JSON remains in `business_records` for audit/detail and is fetched lazily. Each source mutation marks its upload version dirty; only a fully rebuilt matching version can be published. A durable worker reclaims stale rebuilds and retries failures.

The records list now uses `(created_at DESC, id DESC)` keyset pagination, explicit scalar columns and a separate lazy detail endpoint. Executive MPN search routes only to records. Clients render independently from their opportunity summary and use one exact client-metrics RPC; signed images are generated only when a visible image requests them. Opportunity Finder polls one minimal row and fetches terminal result families concurrently.

## Measured local results

| Measurement | Before | After | Change |
|---|---:|---:|---:|
| 100k keyset page SQL execution | 73.429 ms | 0.204 ms | -99.72% |
| 100k `%NEEDLE%` MPN SQL execution | 50.689 ms | 6.550 ms | -87.08% |
| Opportunity aggregation, 5k synthetic | 377.434 ms | 150.453 ms | 2.51x |
| Opportunity aggregation, 10k synthetic | 1,322.624 ms | 348.223 ms | 3.80x |
| Current aggregation, 50k synthetic | unsafe legacy run omitted | 2,376.916 ms | linear implementation completed |
| Current aggregation, 100k synthetic | unsafe legacy run omitted | 2,981.552 ms | linear implementation completed |

Keyset page execution remained effectively flat as the synthetic table grew: 0.085 ms at 10k, 0.055 ms at 100k, 0.069 ms at 500k, and 0.060 ms at 1M rows. Each query returned 25 rows and touched only 4–5 shared buffers. At 1M rows the complete test table plus all indexes occupied 1,089 MiB; the keyset index occupied 69 MiB. Insert timings are intentionally not presented as interactive latency because the benchmark created and indexed the synthetic corpus inside one rollback transaction.

The intentionally quadratic legacy run was not executed at 50k/100k because doing so would deliberately consume excessive CPU. This is recorded as `null`, not extrapolated.

## Query budgets after

| Flow | Budget |
|---|---:|
| Clients initial including secondary summary | 5 |
| Records page | 2 |
| Executive exact MPN | 1 |
| Stock ready page | 1 |
| Opportunities ready page | 2 |
| Opportunity Finder status | 1 |
| Opportunity Finder terminal (permission-dependent maximum) | 7 |
| Assistant dashboard summary | 2 |

## EXPLAIN evidence

On 100,000 synthetic rows, the unindexed keyset query used `Parallel Seq Scan -> Sort -> Gather Merge` and touched 1,686 shared buffers. With `business_records_active_keyset_idx` it used an `Index Scan`, returned 25 rows, and touched 28 buffers. The test index occupied 3,992 KiB.

The contains query changed from a sequential scan removing 99,900 rows to `Bitmap Index Scan -> Bitmap Heap Scan` on `business_records_active_mpn_trgm_idx`. It touched 109 buffers after optimization; the test index occupied 2,192 KiB.

## Integrity and security

- The 999/1000/1001/5000/10000 page-boundary tests return every row once.
- Summary publication is version-fenced; dirty or incomplete versions are never served.
- Exact counters are updated transactionally for inserts, deletes, archives and corrections.
- RLS runtime testing as `authenticated` proves that user A sees one own summary and cannot see user B's summary.
- Derived summaries contain no raw spreadsheet JSON, prices or cost fields.
- The observability outbox is service-only; critical audit/security logs remain synchronous.

## Measurement limitations

No migration was applied to remote Supabase and no production data was changed. Therefore post-change end-to-end route latencies, transferred bytes and backend CPU on a production-equivalent dataset are deliberately left `null`. They must be collected in staging after applying the local migration and completing reconciliation. The before values remain the verified audit baseline.
