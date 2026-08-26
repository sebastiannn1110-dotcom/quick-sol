param(
  [string]$Database = 'quiksol_privacy_round5_test_r74c',
  [int]$Port = 55479,
  [string]$ActorId = 'd7340000-0000-4000-8000-000000000000',
  [int[]]$Clients = @(20),
  [ValidateSet('pages','filters')]
  [string]$ScenarioSet = 'pages'
)

$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$fixed=Join-Path $root 'supabase\tests\stock_needs_r74_readers.pgbench.sql'
$random=Join-Path $root 'supabase\tests\stock_needs_r74_random_readers.pgbench.sql'
$scenarios=if($ScenarioSet-eq 'filters'){
  @(
    [pscustomobject]@{Name='filter_mpn';Offset=$null;Script=(Join-Path $root 'supabase\tests\stock_needs_r74_filter_mpn_readers.pgbench.sql')},
    [pscustomobject]@{Name='filter_upload';Offset=$null;Script=(Join-Path $root 'supabase\tests\stock_needs_r74_filter_upload_readers.pgbench.sql')},
    [pscustomobject]@{Name='filter_customer';Offset=$null;Script=(Join-Path $root 'supabase\tests\stock_needs_r74_filter_customer_readers.pgbench.sql')},
    [pscustomobject]@{Name='filter_status';Offset=$null;Script=(Join-Path $root 'supabase\tests\stock_needs_r74_filter_status_readers.pgbench.sql')},
    [pscustomobject]@{Name='filter_coverage';Offset=$null;Script=(Join-Path $root 'supabase\tests\stock_needs_r74_filter_coverage_readers.pgbench.sql')}
  )
}else{
  @(
    [pscustomobject]@{Name='first';Offset=0;Script=$fixed},
    [pscustomobject]@{Name='middle';Offset=150000;Script=$fixed},
    [pscustomobject]@{Name='last';Offset=299900;Script=$fixed},
    [pscustomobject]@{Name='empty';Offset=300000;Script=$fixed},
    [pscustomobject]@{Name='random';Offset=$null;Script=$random}
  )
}
function Scalar([string]$sql){
  $v=& 'C:\Program Files\PostgreSQL\16\bin\psql.exe' -X -qAt -h 127.0.0.1 -p $Port -U postgres -d $Database -v ON_ERROR_STOP=1 -c $sql
  if($LASTEXITCODE-ne 0){throw 'metric query failed'}; return (($v-join "`n").Trim())
}
function Percentile([double[]]$values,[double]$p){
  if(!$values.Count){return $null}; return $values[[Math]::Max(0,[Math]::Ceiling($p*$values.Count)-1)]
}
$results=@()
foreach($scenario in $scenarios){foreach($clientCount in $Clients){
  $requested=$clientCount*5
  $before=(Scalar "select temp_files||'|'||temp_bytes||'|'||deadlocks from pg_stat_database where datname=current_database()")-split '\|'
  $prefix=Join-Path ([IO.Path]::GetTempPath()) ("quiksol-r74-{0}-{1}-{2}-"-f $PID,$scenario.Name,$clientCount)
  $args=@('-n','-c',$clientCount,'-j',([Math]::Min(4,$clientCount)),'-t','5','-r','-l',"--log-prefix=$prefix",'--random-seed=740004','-h','127.0.0.1','-p',$Port,'-U','postgres','-D',"actor_id='$ActorId'")
  if($null-ne $scenario.Offset){$args+=@('-D',"page_offset=$($scenario.Offset)")};$args+=@('-f',$scenario.Script,$Database)
  $timer=[Diagnostics.Stopwatch]::StartNew();$old=$ErrorActionPreference;$ErrorActionPreference='Continue'
  $output=(& 'C:\Program Files\PostgreSQL\16\bin\pgbench.exe' @args 2>&1|Out-String);$code=$LASTEXITCODE;$ErrorActionPreference=$old;$timer.Stop()
  $after=(Scalar "select temp_files||'|'||temp_bytes||'|'||deadlocks||'|'||(select count(*) from pg_locks where not granted) from pg_stat_database where datname=current_database()")-split '\|'
  $latencies=@();$logs=@(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter ((Split-Path $prefix -Leaf)+'*') -File)
  foreach($log in $logs){foreach($line in Get-Content -LiteralPath $log.FullName){$f=$line-split '\s+';if($f.Count-ge 3){$latencies+=([double]$f[2]/1000)}};Remove-Item -LiteralPath $log.FullName -Force}
  $sorted=@($latencies|Sort-Object);$processed=[regex]::Match($output,'number of transactions actually processed:\s*(\d+)/(\d+)')
  $completed=if($processed.Success){[int]$processed.Groups[1].Value}else{$sorted.Count};$timeouts=[regex]::Matches($output,'statement timeout').Count
  $results+=[pscustomobject]@{Scenario=$scenario.Name;Clients=$clientCount;Requested=$requested;Completed=$completed;Timeouts=$timeouts;ExitCode=$code;ErrorDetail=if($code-ne 0){$output.Trim()}else{$null};TPS=[Math]::Round($completed/[Math]::Max($timer.Elapsed.TotalSeconds,.001),3);AverageMs=if($sorted.Count){[Math]::Round(($sorted|Measure-Object -Average).Average,3)}else{$null};P50Ms=if($sorted.Count){[Math]::Round((Percentile $sorted .5),3)}else{$null};P95Ms=if($sorted.Count){[Math]::Round((Percentile $sorted .95),3)}else{$null};P99Ms=if($sorted.Count){[Math]::Round((Percentile $sorted .99),3)}else{$null};MaxMs=if($sorted.Count){[Math]::Round($sorted[-1],3)}else{$null};TempFiles=[long]$after[0]-[long]$before[0];TempBytes=[long]$after[1]-[long]$before[1];Deadlocks=[long]$after[2]-[long]$before[2];WaitingLocks=[long]$after[3]}
}}
$results|ConvertTo-Json -Depth 4
