#requires -Version 5.1
<#
.SYNOPSIS
  Stock-preparation on-prem one-click acceptance (#3751 T9). Compresses the 8 manual entity-machine
  steps — verify SHA, install, migrate, restart, health, smoke, collect evidence — into ONE command
  that emits a single VALUES-FREE acceptance summary (.txt + .json).

.DESCRIPTION
  Runs, in order, stopping at the first failed stage (never self-healing — no manual dependency
  patching, never MIGRATION_EXCLUDE):
    1. packageShaMatch  — SHA256 of the package vs SHA256SUMS + optional -ExpectedGitSha vs metadata.
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
    * The summary is values-free by construction: it can only ever contain the 9 whitelisted status fields
      each a PASS/FAIL/enum/count/coarse-code — never a drawing number, quantity, unit, material name,
      host, credential, or raw log line. On failure it adds only failedStage + coarse code (migration
      name / SQLSTATE / HTTP status), never a full log.

.PARAMETER PackagePath        Path to the .zip or .tgz on-prem package.
.PARAMETER Sha256SumsPath     Path to the SHA256SUMS sidecar (default: alongside the package).
.PARAMETER DeployRoot         Existing deploy root the bootstrap installs into.
.PARAMETER Port               Backend port for health + smoke (default 8081).
.PARAMETER TenantId           Optional tenant id passed to the smoke (--tenant-id) when the admin
                              token carries no tenant claim.
.PARAMETER TargetMigration    Migration name that MUST be applied after migrate (idempotent confirm).
.PARAMETER ExpectedGitSha     Optional expected git commit SHA; compared to the package metadata SHA.
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
    # An -ExpectedGitSha lock is only meaningful if it is ENFORCED. metadata json rides next to the
    # package as <pkg-basename>.json (see package-build workflow). A missing metadata file, or metadata
    # without a gitSha, is a FAILURE — never a silent pass — otherwise the lock the operator asked for
    # would be a no-op exactly when it matters.
    $metaPath = [System.IO.Path]::ChangeExtension($PackagePath, '.json')
    if (-not (Test-Path $metaPath)) { Stop-WithFailure 'sha' @{ reason = 'metadata_missing' } }
    $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
    $metaSha = if ($meta.PSObject.Properties.Name -contains 'gitSha') { "$($meta.gitSha)".ToLower() } else { '' }
    if (-not $metaSha) { Stop-WithFailure 'sha' @{ reason = 'metadata_git_sha_absent' } }
    if ($metaSha -ne $ExpectedGitSha.ToLower()) { Stop-WithFailure 'sha' @{ reason = 'git_sha_mismatch' } }
  }
  $Summary.packageShaMatch = 'PASS'
  Write-Stage 'stage 1: PASS'
}

# ── Stage 2: install via the package's OWN bootstrap (never re-implemented here) ─────────────────
function Invoke-BootstrapStage {
  Write-Stage 'stage 2: install (package bootstrap)'
  $bootstrap = Get-ChildItem -Path (Split-Path -Parent $PackagePath) -Filter '*-deploy-bootstrap.ps1' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $bootstrap) { Stop-WithFailure 'install' @{ reason = 'bootstrap_ps1_missing' } }
  & $bootstrap.FullName -PackagePath $PackagePath -DeployRoot $DeployRoot
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
function Invoke-Pm2StableStage {
  Write-Stage 'stage 4: pm2 restart + stable-online poll'
  & pm2 restart metasheet-backend 2>&1 | ForEach-Object { Write-Stage "pm2: $_" }
  if ($LASTEXITCODE -ne 0) { Stop-WithFailure 'pm2Restart' @{ reason = 'restart_command_failed' } }
  # Poll: the process must STAY 'online' for the whole window — a crash-loop shows online→errored.
  $deadline = (Get-Date).AddSeconds($StableOnlineSeconds)
  while ((Get-Date) -lt $deadline) {
    $status = (& pm2 jlist 2>$null | ConvertFrom-Json | Where-Object { $_.name -eq 'metasheet-backend' } | Select-Object -First 1)
    $state = if ($status) { "$($status.pm2_env.status)" } else { 'missing' }
    if ($state -ne 'online') { Stop-WithFailure 'pm2StableOnline' @{ pm2State = $state } }
    Start-Sleep -Seconds 2
  }
  $Summary.pm2StableOnline = 'PASS'
  Write-Stage 'stage 4: PASS (stayed online)'
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
  $pass = ($joined -match 'mvpSmoke\.pass=true' -or $joined -match '(?m)^\s*pass=true')
  $audit = if ($joined -match 'auditActionsCovered=(\d+/8)') { $Matches[1] } else { 'N/8' }
  $selfScan = ($joined -match 'selfScanClean=true')
  $Summary['mvpSmoke.pass'] = if ($pass) { 'true' } else { 'false' }
  $Summary.auditActionsCovered = $audit
  $Summary.selfScanClean = if ($selfScan) { 'true' } else { 'false' }
  if ($exit -ne 0 -or -not $pass) { Stop-WithFailure 'smoke' @{ smokeExit = $exit } }
  Write-Stage 'stage 6: PASS'
}

# ── Orchestrate ──────────────────────────────────────────────────────────────────────────────────
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
