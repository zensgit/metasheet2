# Windows PowerShell 5.1. Use the cut-time SQL directory with the approved baseline.
# The caller supplies the verified libpq connection in the current shell, never as a script argument.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('R85', 'R84')][string]$Target,
  [Parameter(Mandatory = $true)][ValidateSet('A', 'B', 'C', 'D', 'F')][string]$InstallState,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$SqlDir,
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$ArchiveSha256,
  [Parameter(Mandatory = $true)][string]$Bootstrap,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$BootstrapSha256,
  [Parameter(Mandatory = $true)][ValidateSet('0', '1')][string]$InstallDeps,
  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')][string]$Schema = 'public',
  [switch]$Execute,
  [switch]$OwnerApproved,
  [switch]$WritesQuiesced,
  [switch]$LegacyClassBOff
)

$ErrorActionPreference = 'Stop'
$stage = 'input'

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
    } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Read-Probe([string]$File) {
  $path = (Get-Item -LiteralPath (Join-Path $sqlRoot $File)).FullName
  $lines = @(& $psql -X -w -qAt -v ON_ERROR_STOP=1 -v "schema=$Schema" `
    -c 'SET default_transaction_read_only = on; SET row_security = off;' -f $path 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'probe exited nonzero' }
  return $lines
}

function Get-ProbeLine([string[]]$Lines, [string]$Prefix, [string]$Pattern) {
  $matchesForPrefix = @($Lines | Where-Object { $_.StartsWith($Prefix, [StringComparison]::Ordinal) })
  if ($matchesForPrefix.Count -ne 1 -or $matchesForPrefix[0] -cnotmatch $Pattern) {
    throw 'missing, ambiguous or unexpected probe result'
  }
  return $matchesForPrefix[0]
}

function Read-Ledger {
  $lines = @(Read-Probe 's06-new-migrations.sql')
  $complete = Get-ProbeLine $lines 'MIG_RESULT ' '^MIG_RESULT file=s06-new-migrations\.sql status=complete$'
  if ($lines[-1] -cne $complete) { throw 'ledger did not finish' }
  $count = Get-ProbeLine $lines 'MIG_COUNT ' '^MIG_COUNT kysely_migration=[0-9]+$'
  $names = Get-ProbeLine $lines 'MIG_NAMESET ' "^MIG_NAMESET ledger=$expectedLedger$"
  return @($count, $names)
}

function Write-P5Report {
  try {
    $lines = @(Read-Probe 'p5-switch-off-row-counts.sql')
    $done = Get-ProbeLine $lines 'P5_RESULT ' '^P5_RESULT file=p5-switch-off-row-counts\.sql status=complete$'
    $summary = Get-ProbeLine $lines 'P5_SUMMARY ' '^P5_SUMMARY metrics=[0-9]+ counted=[0-9]+ absent=[0-9]+ no_select=[0-9]+ nonzero=[0-9]+$'
    $verdict = Get-ProbeLine $lines 'P5_VERDICT ' '^P5_VERDICT all_zero=[tf]$'
    $counts = @($lines | Where-Object { $_ -cmatch '^P5_COUNT n=[0-9]+ metric=[a-z_][a-z_0-9]* value=([0-9]+|absent|no_select)$' })
    if ($lines[-1] -cne $done -or $counts.Count -eq 0) { throw 'P5 did not finish' }
    $counts
    $summary
    $verdict
    $done
  } catch {
    'P3_ROLLBACK_REPORT probe=P5 status=unavailable'
  }
}

try {
  if ($Execute -and (-not $OwnerApproved -or -not $WritesQuiesced)) { throw 'authorization or quiet window missing' }
  if ($Target -eq 'R84' -and -not $LegacyClassBOff) { throw 'legacy switch not verified' }
  $root = (Get-Item -LiteralPath $InstallRoot).FullName
  $sqlRoot = (Get-Item -LiteralPath $SqlDir).FullName
  $archiveFile = Get-Item -LiteralPath $Archive
  $bootstrapFile = Get-Item -LiteralPath $Bootstrap
  if (-not (Test-Path -LiteralPath (Join-Path $root 'docker\app.env') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $root 'packages\core-backend\dist\src\index.js') -PathType Leaf) -or
      $archiveFile.Extension -ine '.zip' -or $bootstrapFile.Extension -ine '.ps1') { throw 'invalid overlay inputs' }
  if ([string]::IsNullOrWhiteSpace($env:PGDATABASE) -and [string]::IsNullOrWhiteSpace($env:PGSERVICE)) {
    throw 'no explicit database connection'
  }
  $psql = (Get-Command psql -CommandType Application | Select-Object -First 1).Source

  $stage = 'hash'
  if ((Get-Sha256 $archiveFile.FullName) -ine $ArchiveSha256 -or
      (Get-Sha256 $bootstrapFile.FullName) -ine $BootstrapSha256) { throw 'hash mismatch' }

  $stage = 'ledger_before'
  $expectedLedger = if ($InstallState -in @('C', 'D')) { 'baseline' } else { 'total' }
  $before = @(Read-Ledger)
  $before

  $stage = 'stock_prep'
  $stock = @(Read-Probe 'r2-stock-prep-stop.sql')
  $stockDone = Get-ProbeLine $stock 'STOP_SP_RESULT ' '^STOP_SP_RESULT file=r2-stock-prep-stop\.sql status=complete$'
  if ($stock[-1] -cne $stockDone) { throw 'stock-prep stop probe did not finish' }
  Get-ProbeLine $stock 'STOP_PULLBATCH ' '^STOP_PULLBATCH settings=0 sheet=0 batch=0 execution=0$'
  if ($Target -eq 'R84') {
    Get-ProbeLine $stock 'STOP_SP ' '^STOP_SP q102_claim_active=0 q103_holds_open=0 q103_executions_unfinished=0 q104_plans_confirmed_or_written=0 q106_unsettled=0 q108_repair_running=0$'
  }

  $stage = 'platform'
  try {
    $platform = @(Read-Probe 'r3-platform-stop.sql')
    $platformDone = Get-ProbeLine $platform 'STOP_PLAT_RESULT ' '^STOP_PLAT_RESULT file=r3-platform-stop\.sql status=complete$'
    if ($platform[-1] -cne $platformDone) { throw 'platform stop probe did not finish' }
    $requiredCount = if ($Target -eq 'R84') { '0' } else { '[0-9]+' }
    Get-ProbeLine $platform 'STOP_PLAT ' "^STOP_PLAT handovers_applied_or_finalized=$requiredCount login_repairs_applied=$requiredCount datasource_tokens_encrypted=[0-9]+ users_in_recycle_bin=[0-9]+$"
  } catch {
    if ($Target -eq 'R84') { throw }
    'P3_ROLLBACK_REPORT probe=platform status=unavailable'
  }

  Write-P5Report

  $stage = 'p4'
  $p4 = @(Read-Probe 'p4-include-children-false-rows.sql')
  $p4Done = Get-ProbeLine $p4 'P4_RESULT ' '^P4_RESULT file=p4-include-children-false-rows\.sql status=complete$'
  if ($p4[-1] -cne $p4Done) { throw 'P4 did not finish' }
  $expectedColumns = if ($expectedLedger -eq 'baseline') { 0 } else { 2 }
  Get-ProbeLine $p4 'P4_SUMMARY ' "^P4_SUMMARY tables=2 columns_present=$expectedColumns false_rows_total=0$"
  Get-ProbeLine $p4 'P4_VERDICT ' '^P4_VERDICT blocking=pass$'
  $p4Done

  if (-not $Execute) {
    "P3_ROLLBACK_RESULT status=preflight_pass target=$Target install_state=$InstallState"
    exit 0
  }

  $stage = 'overlay'
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $bootstrapFile.FullName `
    -RootDir $root -PackageArchive $archiveFile.FullName -InstallDeps $InstallDeps -RunMigrations 0 *> $null
  if ($LASTEXITCODE -ne 0) { throw 'overlay failed' }

  $stage = 'ledger_after'
  $after = @(Read-Ledger)
  if ($before[0] -cne $after[0] -or $before[1] -cne $after[1]) { throw 'ledger changed' }
  $after
  "P3_ROLLBACK_RESULT status=overlay_complete target=$Target install_state=$InstallState"
  exit 0
} catch {
  "P3_ROLLBACK_RESULT status=STOP stage=$stage"
  exit 2
}
