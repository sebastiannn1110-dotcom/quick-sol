param(
  [string]$Database = 'quiksol_privacy_round5_test_r74c',
  [int]$Port = 55479,
  [string]$WorkerId = 'r74-build-benchmark',
  [int]$ChunkSize = 1000
)

$ErrorActionPreference = 'Stop'
$psql = 'C:\Program Files\PostgreSQL\16\bin\psql.exe'

function Invoke-Lines([string]$Sql) {
  $value = & $psql -X -qAt -h 127.0.0.1 -p $Port -U postgres -d $Database -v ON_ERROR_STOP=1 -c $Sql
  if ($LASTEXITCODE -ne 0) { throw 'R74 build SQL failed.' }
  return @($value)
}

$databaseCheck = @(Invoke-Lines "select current_database() ~ '^quiksol_privacy_round5_test_r74[a-z0-9_]*$'")[0]
if ($databaseCheck -ne 't') { throw 'REFUSING_NON_R74_DISPOSABLE_DATABASE' }

$statsBefore = (@(Invoke-Lines "select temp_files||'|'||temp_bytes from pg_stat_database where datname=current_database()")[0]) -split '\|'
$driverBefore = Get-Process -Id $PID
$timer = [Diagnostics.Stopwatch]::StartNew()
$claimSql = @"
select set_config('request.jwt.claim.role','service_role',false);
select concat_ws('|',scope_id,rebuild_id,build_generation,fence_token,next_chunk_sequence)
from public.claim_stock_needs_snapshot_rebuild_v1('$WorkerId',120);
"@
$claimLine = (Invoke-Lines $claimSql | Where-Object { $_ -match '\|' } | Select-Object -Last 1)
if (-not $claimLine) { throw 'R74_BUILD_SCOPE_NOT_CLAIMED' }
$claim = $claimLine -split '\|'
$scopeId = $claim[0]
$rebuildId = $claim[1]
$generation = [long]$claim[2]
$fence = [long]$claim[3]
$sequence = [int]$claim[4]
$chunks = 0
$rows = 0L
$sources = 0L
$bytes = 0L
$peakRows = 0
$peakBytes = 0L
$peakBackendMemory = 0L
$queries = 1

while ($true) {
  $stageSql = @"
select set_config('request.jwt.claim.role','service_role',false);
select public.heartbeat_stock_needs_snapshot_rebuild_v1('$scopeId','$WorkerId','$rebuildId',$generation,$fence,120);
select public.stage_stock_needs_snapshot_chunk_v1('$scopeId','$WorkerId','$rebuildId',$generation,$fence,$sequence,$ChunkSize)::text;
select coalesce(sum(total_bytes),0) from pg_backend_memory_contexts;
"@
  $stageLines = @(Invoke-Lines $stageSql)
  $receiptLine = $stageLines | Where-Object { $_ -like '{*' } | Select-Object -Last 1
  $memoryLine = $stageLines | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1
  $receipt = $receiptLine | ConvertFrom-Json
  $queries += 2
  if ($memoryLine) { $peakBackendMemory = [Math]::Max($peakBackendMemory,[long]$memoryLine) }
  if ($receipt.done -eq $true) { break }
  $chunkRows = [long]$receipt.chunkRows
  $chunkSources = [long]$receipt.chunkSources
  $chunkBytes = [long]$receipt.chunkBytes
  $chunks += 1
  $rows += $chunkRows
  $sources += $chunkSources
  $bytes += $chunkBytes
  $peakRows = [Math]::Max($peakRows,$chunkRows)
  $peakBytes = [Math]::Max($peakBytes,$chunkBytes)
  $sequence += 1
}

$publishSql = @"
select set_config('request.jwt.claim.role','service_role',false);
select public.heartbeat_stock_needs_snapshot_rebuild_v1('$scopeId','$WorkerId','$rebuildId',$generation,$fence,120);
select public.publish_stock_needs_snapshot_rebuild_v1('$scopeId','$WorkerId','$rebuildId',$generation,$fence)::text;
"@
$publishLine = (Invoke-Lines $publishSql | Where-Object { $_ -like '{*' } | Select-Object -Last 1)
$publish = $publishLine | ConvertFrom-Json
$queries += 2
$timer.Stop()
$statsAfter = (@(Invoke-Lines "select temp_files||'|'||temp_bytes from pg_stat_database where datname=current_database()")[0]) -split '\|'
$sizes = (@(Invoke-Lines "select pg_total_relation_size('public.business_stock_needs_scopes')||'|'||pg_total_relation_size('public.business_stock_needs_snapshot_rows')||'|'||pg_total_relation_size('public.business_stock_needs_snapshot_sources')")[0]) -split '\|'
$generations = [long](@(Invoke-Lines "select count(distinct generation) from public.business_stock_needs_snapshot_rows where data_scope_id='$scopeId'")[0])
$driverAfter = Get-Process -Id $PID

[pscustomobject]@{
  Database=$Database; ScopeId=$scopeId; Generation=$generation
  TotalSeconds=[Math]::Round($timer.Elapsed.TotalSeconds,3)
  Chunks=$chunks; ChunkSize=$ChunkSize; Rows=$rows; Sources=$sources
  PayloadBytes=$bytes; PeakChunkRows=$peakRows; PeakChunkBytes=$peakBytes
  Queries=$queries; PeakBackendMemoryBytes=$peakBackendMemory
  DriverWorkingSetStart=$driverBefore.WorkingSet64; DriverWorkingSetEnd=$driverAfter.WorkingSet64
  TempFiles=([long]$statsAfter[0]-[long]$statsBefore[0])
  TempBytes=([long]$statsAfter[1]-[long]$statsBefore[1])
  ScopeTableBytes=[long]$sizes[0]; RowsTableBytes=[long]$sizes[1]; SourcesTableBytes=[long]$sizes[2]
  GenerationCount=$generations; Published=$publish
} | ConvertTo-Json -Depth 5
