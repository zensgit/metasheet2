#requires -Version 5.1
<#
.SYNOPSIS
  Stock-preparation on-prem one-click acceptance (#3751 T9). Compresses the 8 manual entity-machine
  steps — verify SHA, install, migrate, restart, health, smoke, collect evidence — into ONE command
  that emits a single VALUES-FREE acceptance summary (.txt + .json).

.DESCRIPTION
  Runs, in order, stopping at the first failed stage (never self-healing — no manual dependency
  patching, never MIGRATION_EXCLUDE):
    1. packageShaMatch  — SHA256 of the package vs SHA256SUMS + optional -ExpectedGitSha vs the archive's
                          own BUILD_PROVENANCE.json.gitCommit (read from inside the checksummed archive).
    2. (install)        — the package's own *-deploy-bootstrap.ps1 (never re-implemented here).
    3. migrationStatus  — node dist/src/db/migrate.js, then confirm the target migration is applied.
    4. pm2StableOnline  — pm2 restart, then POLL that the process stays 'online' (not just that the
                          restart COMMAND returned 0 — a command success is not a stable service).
    5. healthcheck      — GET /api/health.
    6. mvpSmoke         — the in-package stock-preparation smoke (postdeploy-smoke.mjs).
    7. summary          — one values-free acceptance-summary.txt + .json: the 9 whitelisted status
                          fields ALWAYS, plus — only on failure — a values-free failDetail block
                          (failedStage + at most a migration name / SQLSTATE / HTTP code, never a value).

  SECURITY:
    * The admin token is read ONLY from an environment variable (-AdminTokenEnvVar, default
      METASHEET_ADMIN_TOKEN) or, if absent, an interactive Read-Host -AsSecureString. It is NEVER
      written to the command line, to a file, to a log, to the summary, or into any Start-Process
      ArgumentList. It is handed to the child smoke ONLY through a scoped process env var that is
      cleared in a finally block.
    * The values-free guarantee is scoped to the SUMMARY ARTIFACTS (acceptance-summary.txt / .json): those
      can only ever contain the 9 whitelisted status fields — each a PASS/FAIL/enum/count/coarse-code —
      never a drawing number, quantity, unit, material name, host, credential, or raw log line. On failure
      they add only failedStage + a coarse code (migration name / SQLSTATE / HTTP status / coarse reason),
      never a full log. The values-free construction is: only whitelisted fields are ever assigned into
      $Summary/$FailDetail, and raw child output (pm2 / migrate / smoke stdout) is parsed for those fields
      and then DISCARDED — never written into the artifacts.
    * The interactive CONSOLE TRANSCRIPT (stdout) is NOT part of this guarantee: it carries operator-facing
      stage progress and may include tool status lines. It is coarsened (raw pm2 restart output is
      suppressed; the smoke's raw $out is never echoed), but it is not a values-free artifact — only the
      .txt/.json summary is. Do not treat captured stdout as a safe-to-share evidence surface; ship the
      summary artifacts.

.PARAMETER PackagePath        Path to the .zip or .tgz on-prem package.
.PARAMETER Sha256SumsPath     Path to the SHA256SUMS sidecar (default: alongside the package).
.PARAMETER DeployRoot         Existing deploy root the bootstrap installs into.
.PARAMETER Port               Backend port for health + smoke (default 8081).
.PARAMETER TenantId           Optional tenant id passed to the smoke (--tenant-id) when the admin
                              token carries no tenant claim.
.PARAMETER TargetMigration    Migration name that MUST be applied after migrate (idempotent confirm).
.PARAMETER ExpectedGitSha     Optional expected git commit SHA; compared to BUILD_PROVENANCE.json.gitCommit
                              read from INSIDE the archive (the checksummed bytes), not an external sidecar.
.PARAMETER AdminTokenEnvVar   Env var holding the admin token (default METASHEET_ADMIN_TOKEN).
.PARAMETER SummaryPath        Output path for acceptance-summary.txt (default ./acceptance-summary.txt).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [string]$Sha256SumsPath,
  [Parameter(Mandatory = $true)][string]$DeployRoot,
  [int]$Port = 8081,
  [string]$TenantId,
  [string]$TargetMigration = '066_create_integration_stock_prep_audit',
  [string]$ExpectedGitSha,
  [string]$AdminTokenEnvVar = 'METASHEET_ADMIN_TOKEN',
  [string]$SummaryPath = 'acceptance-summary.txt',
  [int]$StableOnlineSeconds = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── The values-free acceptance state. ONLY these keys are ever emitted. ──────────────────────────
$Summary = [ordered]@{
  packageShaMatch        = 'FAIL'
  migrationStatus        = 'FAIL'
  pm2StableOnline        = 'FAIL'
  healthcheck            = 'FAIL'
  'mvpSmoke.pass'        = 'false'
  auditActionsCovered    = 'N/8'
  selfScanClean          = 'false'
  externalPlmK3ErpWrite  = 'false'   # invariant: this line NEVER touches an external write.
  failedStage            = 'none'
}
# Coarse failure detail (values-free): failedStage + at most a migration name / SQLSTATE / HTTP code.
$FailDetail = [ordered]@{}

function Write-Stage { param([string]$Msg) Write-Host "[acceptance] $Msg" }

function Stop-WithFailure {
  param([string]$Stage, [hashtable]$Coarse)
  $Summary.failedStage = $Stage
  if ($Coarse) { foreach ($k in $Coarse.Keys) { $FailDetail[$k] = $Coarse[$k] } }
  Emit-Summary
  Write-Stage "FAILED at stage: $Stage"
  exit 1
}

function Emit-Summary {
  # Build the .txt (9 whitelisted lines) + optional coarse fail detail, and a matching .json.
  $lines = @()
  foreach ($k in $Summary.Keys) { $lines += "$k=$($Summary[$k])" }
  if ($FailDetail.Count -gt 0) { foreach ($k in $FailDetail.Keys) { $lines += "$k=$($FailDetail[$k])" } }
  Set-Content -Path $SummaryPath -Value ($lines -join [Environment]::NewLine) -Encoding utf8
  $jsonPath = [System.IO.Path]::ChangeExtension($SummaryPath, '.json')
  $jsonObj = [ordered]@{}
  foreach ($k in $Summary.Keys) { $jsonObj[$k] = $Summary[$k] }
  if ($FailDetail.Count -gt 0) { $jsonObj['failDetail'] = $FailDetail }
  ($jsonObj | ConvertTo-Json -Depth 4) | Set-Content -Path $jsonPath -Encoding utf8
  Write-Stage "summary written: $SummaryPath / $jsonPath"
}

function Get-Sha256Hex { param([string]$Path) (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower() }

# ── Verify one file against its SHA256SUMS entry by EXACT basename (not first-match / substring). ────
# Returns @{ ok; reason }. Used to bind the bootstrap sidecar we are about to EXECUTE to the manifest,
# so a stray/older bootstrap left in a mixed-package directory cannot be run in its place (owner P1).
function Test-Sha256SumsEntry {
  param([string]$FilePath, [string]$Sha256SumsPath, [string]$ExpectedName)
  if (-not (Test-Path $FilePath)) { return @{ ok = $false; reason = 'file_missing' } }
  if (-not (Test-Path $Sha256SumsPath)) { return @{ ok = $false; reason = 'sha256sums_missing' } }
  $actual = Get-Sha256Hex $FilePath
  foreach ($line in Get-Content $Sha256SumsPath) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -ne 2) { continue }
    $name = Split-Path -Leaf ($parts[1].Trim())
    if ($name -ne $ExpectedName) { continue }
    if ($parts[0].ToLower() -eq $actual) { return @{ ok = $true; reason = 'match' } }
    return @{ ok = $false; reason = 'checksum_mismatch' }   # named, but the bytes differ
  }
  return @{ ok = $false; reason = 'checksum_absent' }        # no SHA256SUMS line for this exact name
}

# ── Package identity: read gitCommit from BUILD_PROVENANCE.json INSIDE the checksummed archive. ──────
# The -ExpectedGitSha lock must bind to the bytes we are about to install, not to a swappable sidecar.
# The old code read <pkg-basename>.json, an EXTERNAL file the build workflow writes gitSha into AFTER the
# archive is built — so an old archive next to a freshly-written .json would pass the lock (owner P1).
# BUILD_PROVENANCE.json rides INSIDE the archive (package-build.sh writes ${PACKAGE_ROOT}/BUILD_PROVENANCE.json,
# and package-verify.sh already enforces a full 40-hex gitCommit), so extracting it from $PackagePath — the
# same bytes Stage 1 just matched against SHA256SUMS — ties the lock to the real package. Returns the
# lowercase gitCommit, or throws with a coarse reason (never a value/log body).
function Get-ArchiveProvenanceGitCommit {
  param([string]$ArchivePath)
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("t9prov_" + [guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $ext = [System.IO.Path]::GetExtension($ArchivePath).ToLower()
    if ($ext -eq '.zip') {
      try { Expand-Archive -Path $ArchivePath -DestinationPath $tmp -Force -ErrorAction Stop } catch { throw 'provenance_archive_unreadable' }
    } else {
      # .tgz/.tar.gz — bsdtar ships on Windows 10+ and macOS; extract all to the temp dir.
      & tar -xzf $ArchivePath -C $tmp 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'provenance_archive_unreadable' }
    }
    # Read ONLY <package-root>/BUILD_PROVENANCE.json — a well-formed package has exactly ONE top-level
    # directory (package-build.sh: `tar -C $stage <PACKAGE_ROOT>`). A recursive first-match would accept a
    # MALFORMED package whose ONLY provenance is buried in a nested path with no root file — a fake-PASS
    # identity path (owner P2). So: require a single deterministic root, and read the root file exactly.
    $topLevel = @(Get-ChildItem -Path $tmp -Force)
    $topDirs = @($topLevel | Where-Object { $_.PSIsContainer })
    if ($topDirs.Count -ne 1) { throw 'provenance_root_ambiguous' }   # 0 or >1 top-level dirs = not a single package root
    $prov = Join-Path $topDirs[0].FullName 'BUILD_PROVENANCE.json'
    if (-not (Test-Path $prov -PathType Leaf)) { throw 'provenance_missing' }  # nested-only / absent root file
    $json = Get-Content $prov -Raw | ConvertFrom-Json
    $commit = if ($json.PSObject.Properties.Name -contains 'gitCommit') { "$($json.gitCommit)".ToLower() } else { '' }
    if (-not $commit -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'provenance_git_commit_absent' }
    return $commit
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# ── PM2 crash-loop detection (pure, unit-testable). A status='online' SAMPLE cannot catch a loop that
# cycles online→errored→online BETWEEN samples; the restart_time counter and pm_uptime baseline can.
# Given the baseline captured right after our deliberate restart, any later increase in restart_time,
# or a pm_uptime that moved backwards (a fresh start resets it), means the process restarted on its own.
# Returns @{ ok = $bool; reason = <coarse> }.
function Test-Pm2StableSample {
  param($Baseline, $Sample)
  if (-not $Sample) { return @{ ok = $false; reason = 'missing' } }
  $state = "$($Sample.state)"
  if ($state -ne 'online') { return @{ ok = $false; reason = "state:$state" } }
  if ($null -ne $Baseline) {
    if ([int]$Sample.restartTime -gt [int]$Baseline.restartTime) { return @{ ok = $false; reason = 'restart_loop' } }
    # pm_uptime is an epoch-ms start time; a self-restart makes it LATER than the baseline start.
    if ([long]$Sample.uptime -gt [long]$Baseline.uptime) { return @{ ok = $false; reason = 'uptime_reset' } }
  }
  return @{ ok = $true; reason = 'stable' }
}

# ── Smoke outcome (pure, unit-testable). The smoke prints values-free summary fields; a real steady
# state requires ALL THREE: mvpSmoke.pass=true AND auditActionsCovered=8/8 AND selfScanClean=true.
# Absent/unparseable audit or selfScan is a FAILURE, never a silent record of 'N/8' that still passes
# (owner P2 — fail-closed on absence). Returns @{ pass; audit; selfScan; ok; reason }.
function Test-SmokeOutcome {
  param([string]$Joined)
  $pass = ($Joined -match 'mvpSmoke\.pass=true' -or $Joined -match '(?m)^\s*pass=true')
  $audit = if ($Joined -match 'auditActionsCovered=(\d+/8)') { $Matches[1] } else { 'N/8' }
  $selfScan = ($Joined -match 'selfScanClean=true')
  $ok = $true; $reason = 'ok'
  if (-not $pass) { $ok = $false; $reason = 'smoke_not_pass' }
  elseif ($audit -ne '8/8') { $ok = $false; $reason = 'audit_incomplete' }
  elseif (-not $selfScan) { $ok = $false; $reason = 'self_scan_not_clean' }
  return @{ pass = $pass; audit = $audit; selfScan = $selfScan; ok = $ok; reason = $reason }
}

# ── Read the admin token WITHOUT ever exposing it (env var, else secure prompt). ─────────────────
function Read-AdminTokenSecure {
  $fromEnv = [Environment]::GetEnvironmentVariable($AdminTokenEnvVar)
  if ($fromEnv) {
    $secure = ConvertTo-SecureString $fromEnv -AsPlainText -Force
    # Best-effort scrub of the plaintext env var so it does not linger in this process env.
    Remove-Item "Env:$AdminTokenEnvVar" -ErrorAction SilentlyContinue
    return $secure
  }
  return (Read-Host -AsSecureString "Admin token (input hidden)")
}

# ── Stage 1: package SHA256 vs SHA256SUMS (+ optional git-sha vs metadata) ───────────────────────
function Invoke-ShaStage {
  Write-Stage 'stage 1: package SHA256'
  if (-not (Test-Path $PackagePath)) { Stop-WithFailure 'sha' @{ reason = 'package_missing' } }
  if (-not $Sha256SumsPath) { $Sha256SumsPath = Join-Path (Split-Path -Parent $PackagePath) 'SHA256SUMS' }
  if (-not (Test-Path $Sha256SumsPath)) { Stop-WithFailure 'sha' @{ reason = 'sha256sums_missing' } }
  $actual = Get-Sha256Hex $PackagePath
  $name = Split-Path -Leaf $PackagePath
  $matched = $false
  foreach ($line in Get-Content $Sha256SumsPath) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[0].ToLower() -eq $actual -and ($parts[1].Trim() -match [regex]::Escape($name))) { $matched = $true; break }
  }
  if (-not $matched) { Stop-WithFailure 'sha' @{ reason = 'checksum_mismatch' } }

  if ($ExpectedGitSha) {
    # The -ExpectedGitSha lock must bind to the ARCHIVE we just checksummed, not to a swappable sidecar.
    # Read gitCommit from BUILD_PROVENANCE.json INSIDE $PackagePath — an old archive carries its OWN old
    # gitCommit, so it can no longer be laundered past the lock by writing a fresh external .json.
    try {
      $archiveCommit = Get-ArchiveProvenanceGitCommit $PackagePath
    } catch {
      Stop-WithFailure 'sha' @{ reason = "$($_.Exception.Message)" }
    }
    if ($archiveCommit -ne $ExpectedGitSha.ToLower()) { Stop-WithFailure 'sha' @{ reason = 'git_sha_mismatch' } }
  }
  $Summary.packageShaMatch = 'PASS'
  Write-Stage 'stage 1: PASS'
}

# ── Stage 2: install via the package's OWN bootstrap (never re-implemented here) ─────────────────
function Invoke-BootstrapStage {
  Write-Stage 'stage 2: install (package bootstrap)'
  # Select the bootstrap by its EXACT bound name, never "first *-deploy-bootstrap.ps1" — in a directory
  # holding more than one package the first-match could run a DIFFERENT package's installer (owner P1).
  # The name is deterministic: <package-basename>-deploy-bootstrap.ps1 (package-build.sh). When the
  # sidecar metadata is present we also assert its windowsFirstHopBootstrap agrees (honor the operator's
  # "select by bound metadata"), and we verify the chosen file against its SHA256SUMS entry by exact name.
  $pkgDir = Split-Path -Parent $PackagePath
  $pkgBase = [System.IO.Path]::GetFileNameWithoutExtension($PackagePath)
  $bootstrapName = "$pkgBase-deploy-bootstrap.ps1"

  $metaPath = [System.IO.Path]::ChangeExtension($PackagePath, '.json')
  if (Test-Path $metaPath) {
    $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
    $metaBoot = if ($meta.PSObject.Properties.Name -contains 'windowsFirstHopBootstrap') { Split-Path -Leaf "$($meta.windowsFirstHopBootstrap)" } else { '' }
    if ($metaBoot -and $metaBoot -ne $bootstrapName) { Stop-WithFailure 'install' @{ reason = 'bootstrap_name_metadata_mismatch' } }
  }

  $bootstrapPath = Join-Path $pkgDir $bootstrapName
  if (-not (Test-Path $bootstrapPath)) { Stop-WithFailure 'install' @{ reason = 'bootstrap_ps1_missing' } }
  $shaPath = if ($Sha256SumsPath) { $Sha256SumsPath } else { Join-Path $pkgDir 'SHA256SUMS' }
  $verdict = Test-Sha256SumsEntry $bootstrapPath $shaPath $bootstrapName
  if (-not $verdict.ok) { Stop-WithFailure 'install' @{ reason = "bootstrap_$($verdict.reason)" } }

  & $bootstrapPath -PackagePath $PackagePath -DeployRoot $DeployRoot
  if ($LASTEXITCODE -ne 0) { Stop-WithFailure 'install' @{ exitCode = $LASTEXITCODE } }
  Write-Stage 'stage 2: PASS'
}

# ── Stage 3: migrate + confirm the target migration is applied ──────────────────────────────────
function Invoke-MigrationStage {
  Write-Stage 'stage 3: migrate'
  $migrate = Join-Path $DeployRoot 'packages/core-backend/dist/src/db/migrate.js'
  if (-not (Test-Path $migrate)) { Stop-WithFailure 'migrate' @{ reason = 'migrate_entrypoint_missing' } }
  # NOTE: NEVER set MIGRATION_EXCLUDE here — it is not a valid acceptance path.
  & node $migrate 2>&1 | ForEach-Object { Write-Stage "migrate: $_" }
  if ($LASTEXITCODE -ne 0) { Stop-WithFailure 'migrate' @{ migration = $TargetMigration } }
  # Confirm the target migration is actually in the ledger — migrate exit 0 is NOT proof (an empty
  # pending set, an excluded/no-op entry, or a partially-applied history all exit 0). Uses the SAME
  # migrate entrypoint's read-only --confirm mode (exit 0 = applied / 1 = pending / 2 = unknown). This
  # is FAIL-CLOSED: if the confirmation cannot be run or does not report 'applied', migrationStatus is
  # never marked PASS (the old code silently PASSed when the confirm step was absent).
  & node $migrate --confirm $TargetMigration
  if ($LASTEXITCODE -ne 0) { Stop-WithFailure 'migrate' @{ migration = $TargetMigration; reason = 'target_not_applied' } }
  $Summary.migrationStatus = 'PASS'
  Write-Stage 'stage 3: PASS'
}

# ── Stage 4: pm2 restart + POLL stable-online (command success != stable service) ────────────────
# Normalize one `pm2 jlist` entry to @{ state; restartTime; uptime } (values-free: no raw jlist echoed).
function Get-Pm2Sample {
  $entry = (& pm2 jlist 2>$null | ConvertFrom-Json | Where-Object { $_.name -eq 'metasheet-backend' } | Select-Object -First 1)
  if (-not $entry) { return $null }
  [pscustomobject]@{
    state       = "$($entry.pm2_env.status)"
    restartTime = [int]($entry.pm2_env.restart_time)
    uptime      = [long]($entry.pm2_env.pm_uptime)
  }
}

function Invoke-Pm2StableStage {
  Write-Stage 'stage 4: pm2 restart + stable-online poll'
  # Coarsen the restart output (do not echo raw pm2 lines) — the values-free guarantee covers the summary
  # artifacts; keep the transcript free of raw tool output too.
  & pm2 restart metasheet-backend *> $null
  if ($LASTEXITCODE -ne 0) { Stop-WithFailure 'pm2Restart' @{ reason = 'restart_command_failed' } }
  # Baseline captured right AFTER our deliberate restart. A crash-loop that flickers online→errored→online
  # between 2s samples would pass a bare status check — but each self-restart bumps restart_time and moves
  # pm_uptime forward, so comparing against this baseline catches it (owner P2).
  Start-Sleep -Seconds 1
  $baseline = Get-Pm2Sample
  if (-not $baseline -or $baseline.state -ne 'online') {
    Stop-WithFailure 'pm2StableOnline' @{ pm2State = $(if ($baseline) { $baseline.state } else { 'missing' }) }
  }
  $deadline = (Get-Date).AddSeconds($StableOnlineSeconds)
  while ((Get-Date) -lt $deadline) {
    $verdict = Test-Pm2StableSample $baseline (Get-Pm2Sample)
    if (-not $verdict.ok) { Stop-WithFailure 'pm2StableOnline' @{ pm2State = $verdict.reason } }
    Start-Sleep -Seconds 2
  }
  $Summary.pm2StableOnline = 'PASS'
  Write-Stage 'stage 4: PASS (stayed online, no restart-loop)'
}

# ── Stage 5: /api/health ─────────────────────────────────────────────────────────────────────────
function Invoke-HealthStage {
  Write-Stage 'stage 5: /api/health'
  try {
    $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 15
    if ($resp.StatusCode -ne 200) { Stop-WithFailure 'healthcheck' @{ httpStatus = $resp.StatusCode } }
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    Stop-WithFailure 'healthcheck' @{ httpStatus = $code }
  }
  $Summary.healthcheck = 'PASS'
  Write-Stage 'stage 5: PASS'
}

# ── Stage 6: in-package stock-preparation smoke (token via scoped env, cleared in finally) ───────
function Invoke-SmokeStage {
  param([SecureString]$Token)
  Write-Stage 'stage 6: stock-preparation smoke'
  $smoke = Join-Path $DeployRoot 'scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs'
  if (-not (Test-Path $smoke)) { Stop-WithFailure 'smoke' @{ reason = 'smoke_script_missing' } }
  $args = @($smoke, '--base-url', "http://localhost:$Port")
  if ($TenantId) { $args += @('--tenant-id', $TenantId) }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
  try {
    # Token crosses to the child ONLY as a scoped env var — never on the command line / ArgumentList.
    $env:METASHEET_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $out = & node @args 2>&1
    $exit = $LASTEXITCODE
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Item Env:METASHEET_AUTH_TOKEN -ErrorAction SilentlyContinue
  }
  # Parse ONLY the values-free summary fields the smoke prints; never echo the raw $out.
  $joined = ($out | Out-String)
  $outcome = Test-SmokeOutcome $joined
  $Summary['mvpSmoke.pass'] = if ($outcome.pass) { 'true' } else { 'false' }
  $Summary.auditActionsCovered = $outcome.audit
  $Summary.selfScanClean = if ($outcome.selfScan) { 'true' } else { 'false' }
  # Fail-closed: a green exit is NOT a steady state unless the audit surface is fully covered (8/8) and
  # the self-scan is clean. An absent/unparseable field records 'N/8'/'false' and FAILS here — it never
  # passes silently (owner P2).
  if ($exit -ne 0) { Stop-WithFailure 'smoke' @{ smokeExit = $exit } }
  if (-not $outcome.ok) { Stop-WithFailure 'smoke' @{ reason = $outcome.reason } }
  Write-Stage 'stage 6: PASS'
}

# ── Orchestrate ──────────────────────────────────────────────────────────────────────────────────
# Entry-point guard: when the script is DOT-SOURCED (InvocationName '.') only the functions are defined,
# so the behavioural tests can exercise the pure helpers (Test-SmokeOutcome / Test-Pm2StableSample) with
# crafted inputs — the pm2/health/smoke stages cannot be driven end-to-end off a Windows host + live pm2.
if ($MyInvocation.InvocationName -ne '.') {
  try {
    Invoke-ShaStage
    Invoke-BootstrapStage
    Invoke-MigrationStage
    Invoke-Pm2StableStage
    Invoke-HealthStage
    $token = Read-AdminTokenSecure
    Invoke-SmokeStage -Token $token
    Emit-Summary
    Write-Stage 'ACCEPTANCE PASS — all stages green'
    exit 0
  } catch {
    # An unexpected error at a stage that did not itself Stop-WithFailure: record coarse, never the message body.
    if ($Summary.failedStage -eq 'none') { $Summary.failedStage = 'unexpected'; $FailDetail['errorType'] = $_.Exception.GetType().Name }
    Emit-Summary
    Write-Stage 'ACCEPTANCE FAILED (unexpected)'
    exit 1
  }
}
