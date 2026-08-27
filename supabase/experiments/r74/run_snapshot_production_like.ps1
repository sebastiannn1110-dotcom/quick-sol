param(
  [string]$Database = 'quiksol_privacy_round5_test_r74c',
  [int]$Port = 55479,
  [int]$ExpectedRows = 300000,
  [int]$ChunkSize = 500,
  [int]$StageTimeoutSeconds = 15,
  [int]$LeaseSeconds = 900,
  [int]$InterruptAfterChunks = 17,
  [int]$MaxTotalSeconds = 1800
)

$ErrorActionPreference = 'Stop'
$psql = 'C:\Program Files\PostgreSQL\16\bin\psql.exe'
$firstWorker = 'r741-production-like-before-interruption'
$resumedWorker = 'r741-production-like-after-lease-expiry'
$baseArgs = @(
  '-X', '-qAt', '-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres',
  '-d', $Database, '-v', 'ON_ERROR_STOP=1'
)

if ($ChunkSize -lt 1 -or $ChunkSize -gt 2000) { throw 'R741_CHUNK_SIZE_OUT_OF_RANGE' }
if ($StageTimeoutSeconds -lt 1 -or $StageTimeoutSeconds -gt 60) { throw 'R741_STAGE_TIMEOUT_OUT_OF_RANGE' }
if ($LeaseSeconds -lt 30 -or $LeaseSeconds -gt 900) { throw 'R741_LEASE_OUT_OF_RANGE' }
if ($InterruptAfterChunks -lt 1) { throw 'R741_INTERRUPTION_MUST_FOLLOW_A_STAGED_CHUNK' }

function Invoke-Sql([string]$Sql) {
  $output = & $psql @baseArgs '-c' $Sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw (($output | Out-String).Trim()) }
  return @($output | ForEach-Object { "$_".Trim() } | Where-Object { $_ -ne '' })
}

function Invoke-ExpectedFailure([string]$Sql, [string]$ExpectedMessage) {
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psql @baseArgs '-c' $Sql 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  $message = ($output | Out-String).Trim()
  if ($exitCode -eq 0 -or $message -notlike "*$ExpectedMessage*") {
    throw "R741_EXPECTED_FAILURE_MISSING:$ExpectedMessage`n$message"
  }
}

function Service-Sql([string]$Body, [int]$TimeoutMs = 0) {
  $prefix = "select set_config('request.jwt.claim.role','service_role',false);" +
    "select set_config('request.jwt.claim.sub','',false);"
  if ($TimeoutMs -gt 0) { $prefix += "set statement_timeout='${TimeoutMs}ms';" }
  return "$prefix$Body"
}

function Claim-Build([string]$WorkerId) {
  $sql = Service-Sql @"
select concat_ws('|', scope_id::text, rebuild_id::text, build_generation::text,
  fence_token::text, lease_expires_at::text, evaluation_at::text,
  next_chunk_sequence::text)
from public.claim_stock_needs_snapshot_rebuild_v1('$WorkerId', $LeaseSeconds);
"@ 15000
  $line = Invoke-Sql $sql | Where-Object { $_ -match '\|' } | Select-Object -Last 1
  if (-not $line) { throw 'R741_BUILD_SCOPE_NOT_CLAIMED' }
  $parts = $line -split '\|'
  if ($parts.Count -ne 7) { throw "R741_CLAIM_INVALID_OUTPUT:$line" }
  return [pscustomobject]@{
    ScopeId = $parts[0]
    RebuildId = $parts[1]
    Generation = [long]$parts[2]
    FenceToken = [long]$parts[3]
    LeaseExpiresAt = $parts[4]
    EvaluationAt = $parts[5]
    NextChunkSequence = [int]$parts[6]
    WorkerId = $WorkerId
  }
}

function Heartbeat-Build($Claim) {
  Invoke-Sql (Service-Sql @"
select public.heartbeat_stock_needs_snapshot_rebuild_v1(
  '$($Claim.ScopeId)'::uuid, '$($Claim.WorkerId)', '$($Claim.RebuildId)'::uuid,
  $($Claim.Generation)::bigint, $($Claim.FenceToken)::bigint, $LeaseSeconds);
"@ 15000) | Out-Null
}

function Stage-Chunk($Claim, [int]$Sequence) {
  Heartbeat-Build $Claim
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    $lines = Invoke-Sql (Service-Sql @"
select public.stage_stock_needs_snapshot_chunk_v1(
  '$($Claim.ScopeId)'::uuid, '$($Claim.WorkerId)', '$($Claim.RebuildId)'::uuid,
  $($Claim.Generation)::bigint, $($Claim.FenceToken)::bigint,
  '${Sequence}'::integer, $ChunkSize)::text;
"@ ($StageTimeoutSeconds * 1000))
  } finally {
    $timer.Stop()
  }
  if ($timer.Elapsed.TotalSeconds -gt $StageTimeoutSeconds + 1) {
    throw "R741_CHUNK_EXCEEDED_WALL_LIMIT:${Sequence}:$($timer.Elapsed.TotalSeconds)"
  }
  $line = $lines | Where-Object { $_ -like '{*' } | Select-Object -Last 1
  if (-not $line) { throw "R741_STAGE_INVALID_OUTPUT:$Sequence" }
  return [pscustomobject]@{
    Receipt = $line | ConvertFrom-Json
    Seconds = $timer.Elapsed.TotalSeconds
  }
}

if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw 'R741_PSQL_16_NOT_FOUND' }
$identity = @(Invoke-Sql "select current_database() || '|' || coalesce(inet_server_addr()::text, 'local-socket');")
$identityParts = $identity[-1] -split '\|'
if ($identityParts[0] -notmatch '^quiksol_privacy_round5_test_r74[a-z0-9_]*$' -or
    $identityParts[1] -notmatch '^127\.0\.0\.1(?:/32)?$') {
  throw "REFUSING_NON_R74_DISPOSABLE_DATABASE:$($identity[-1])"
}

$indexColumns = @(Invoke-Sql @"
select string_agg(attribute.attname, ',' order by key_position.ordinality)
from pg_catalog.pg_class index_relation
join pg_catalog.pg_index index_metadata on index_metadata.indexrelid=index_relation.oid
join pg_catalog.pg_class table_relation on table_relation.oid=index_metadata.indrelid
cross join lateral unnest(index_metadata.indkey::smallint[])
  with ordinality key_position(attribute_number,ordinality)
join pg_catalog.pg_attribute attribute
  on attribute.attrelid=table_relation.oid and attribute.attnum=key_position.attribute_number
where index_relation.oid='public.business_stock_needs_snapshot_chunk_idx'::regclass
  and index_metadata.indisvalid and index_metadata.indisready
  and index_metadata.indnkeyatts=4;
"@)
if ($indexColumns[-1] -ne 'data_scope_id,generation,chunk_sequence,normalized_mpn') {
  throw "R741_DEFINITIVE_INDEX_INVALID:$($indexColumns[-1])"
}
if (@(Invoke-Sql "select count(*) from pg_catalog.pg_class where relname like 'business_stock_needs_snapshot_chunk_diag%';")[-1] -ne '0') {
  throw 'R741_DIAGNOSTIC_INDEX_PRESENT'
}

Invoke-Sql @"
update public.business_stock_needs_scopes set enabled=(scope_key='company');
update public.business_stock_needs_scopes
set required_version=required_version+1, snapshot_status='queued',
    build_id=null, build_locked_by=null, build_lease_expires_at=null,
    build_next_retry_at=null, build_attempts=0, last_failure_code=null,
    updated_at=clock_timestamp()
where scope_key='company';
"@ | Out-Null

$sourceCounts = @(Invoke-Sql (Service-Sql @"
with company_scope as (
  select id from public.business_stock_needs_scopes where scope_key='company'
), visible_uploads as materialized (
  select visible.* from company_scope
  cross join lateral public.stock_needs_scope_uploads_v1(company_scope.id) visible
)
select count(*)::text || '|' || count(distinct summary.normalized_mpn)::text
from public.business_mpn_summaries summary
join visible_uploads visible on visible.upload_batch_id=summary.upload_batch_id
  and visible.summary_version=summary.data_version and not visible.dirty;
"@ 30000))
$sourceParts = $sourceCounts[-1] -split '\|'
if ([long]$sourceParts[0] -ne $ExpectedRows -or [long]$sourceParts[1] -ne $ExpectedRows) {
  throw "R741_SCALE_PRECONDITION_FAILED:$($sourceCounts[-1]):expected=$ExpectedRows"
}

$deadlocksBefore = [long](@(Invoke-Sql "select deadlocks from pg_stat_database where datname=current_database();")[-1])
$activeBefore = @(Invoke-Sql "select coalesce(active_generation::text,'NULL') || '|' || total_items::text from public.business_stock_needs_scopes where scope_key='company';")[-1]
$claim = Claim-Build $firstWorker
if ($claim.NextChunkSequence -ne 0) { throw "R741_FRESH_BUILD_DID_NOT_START_AT_ZERO:$($claim.NextChunkSequence)" }

$totalTimer = [Diagnostics.Stopwatch]::StartNew()
$sequence = 0
$chunks = 0
$maxChunkSeconds = 0.0
$resumeVerified = $false

Write-Host '===== R7.4.1 PRODUCTION-LIKE 300K SCALE GATE ====='
Write-Host "database=$Database expectedRows=$ExpectedRows chunkSize=$ChunkSize stageTimeout=${StageTimeoutSeconds}s"
Write-Host "generation=$($claim.Generation) activeBefore=$activeBefore"

while ($true) {
  if ($totalTimer.Elapsed.TotalSeconds -gt $MaxTotalSeconds) {
    throw "R741_TOTAL_TIME_LIMIT_EXCEEDED:$MaxTotalSeconds"
  }
  $stage = Stage-Chunk $claim $sequence
  $receipt = $stage.Receipt
  $maxChunkSeconds = [Math]::Max($maxChunkSeconds, $stage.Seconds)
  Write-Host ("chunk={0} rows={1} totalRows={2} cursor={3} time={4:N3}s" -f
    $sequence,
    $(if ($null -eq $receipt.chunkRows) { 0 } else { $receipt.chunkRows }),
    $(if ($null -eq $receipt.rowsBuilt) { '?' } else { $receipt.rowsBuilt }),
    $receipt.cursorMpn,
    $stage.Seconds)

  if ($receipt.done -eq $true) { break }
  $chunks++
  $sequence++

  if (-not $resumeVerified -and $chunks -eq $InterruptAfterChunks) {
    $partialState = @(Invoke-Sql "select coalesce(active_generation::text,'NULL') || '|' || total_items::text from public.business_stock_needs_scopes where id='$($claim.ScopeId)'::uuid;")[-1]
    if ($partialState -ne $activeBefore) { throw "R741_PARTIAL_BUILD_BECAME_ACTIVE:$partialState" }

    Invoke-Sql "update public.business_stock_needs_scopes set build_lease_expires_at=clock_timestamp()-interval '1 second' where id='$($claim.ScopeId)'::uuid;" | Out-Null
    $resumed = Claim-Build $resumedWorker
    if ($resumed.ScopeId -ne $claim.ScopeId -or $resumed.RebuildId -ne $claim.RebuildId -or
        $resumed.Generation -ne $claim.Generation -or $resumed.EvaluationAt -ne $claim.EvaluationAt -or
        $resumed.NextChunkSequence -ne $sequence) {
      throw "R741_RESUME_STATE_LOST:expectedSequence=${sequence}:actualSequence=$($resumed.NextChunkSequence)"
    }
    Invoke-ExpectedFailure (Service-Sql @"
select public.stage_stock_needs_snapshot_chunk_v1(
  '$($claim.ScopeId)'::uuid, '$($claim.WorkerId)', '$($claim.RebuildId)'::uuid,
  $($claim.Generation)::bigint, $($claim.FenceToken)::bigint,
  '${sequence}'::integer, $ChunkSize);
"@ 15000) 'STOCK_SNAPSHOT_WORKER_FENCED'
    $claim = $resumed
    $resumeVerified = $true
    Write-Host "resume=PASS nextChunk=$sequence oldWorkerFenced=PASS"
  }
}

if (-not $resumeVerified) { throw 'R741_RESUME_GATE_NOT_EXERCISED' }
Heartbeat-Build $claim
$publish = @(Invoke-Sql (Service-Sql @"
select public.publish_stock_needs_snapshot_rebuild_v1(
  '$($claim.ScopeId)'::uuid, '$($claim.WorkerId)', '$($claim.RebuildId)'::uuid,
  $($claim.Generation)::bigint, $($claim.FenceToken)::bigint)::text;
"@ 30000))
$totalTimer.Stop()

$validation = @(Invoke-Sql @"
select snapshot_status || '|' || active_generation::text || '|' || total_items::text
from public.business_stock_needs_scopes where scope_key='company';
select count(*)::text
from public.business_stock_needs_snapshot_rows snapshot_row
join public.business_stock_needs_scopes scope
  on scope.active_data_scope_id=snapshot_row.data_scope_id
 and scope.active_generation=snapshot_row.generation
where scope.scope_key='company';
"@)
$stateParts = $validation[-2] -split '\|'
$activeRows = [long]$validation[-1]
$deadlocksAfter = [long](@(Invoke-Sql "select deadlocks from pg_stat_database where datname=current_database();")[-1])

if ($stateParts[0] -ne 'ready' -or [long]$stateParts[2] -ne $ExpectedRows -or $activeRows -ne $ExpectedRows) {
  throw "R741_FINAL_STATE_INVALID:state=$($validation[-2]):activeRows=$activeRows"
}
if ($deadlocksAfter -ne $deadlocksBefore) { throw "R741_DEADLOCK_DETECTED:$($deadlocksAfter-$deadlocksBefore)" }
if ($maxChunkSeconds -gt $StageTimeoutSeconds) { throw "R741_CHUNK_LIMIT_FAILED:$maxChunkSeconds" }

[pscustomobject]@{
  Result = 'PASS'
  Database = $Database
  Generation = $claim.Generation
  ExpectedRows = $ExpectedRows
  ActiveRows = $activeRows
  Chunks = $chunks
  ChunkSize = $ChunkSize
  StageTimeoutSeconds = $StageTimeoutSeconds
  MaxChunkSeconds = [Math]::Round($maxChunkSeconds, 3)
  TotalSeconds = [Math]::Round($totalTimer.Elapsed.TotalSeconds, 3)
  ResumeAfterLeaseExpiry = $resumeVerified
  Deadlocks = $deadlocksAfter - $deadlocksBefore
  Published = ($publish[-1] | ConvertFrom-Json)
} | ConvertTo-Json -Depth 5
