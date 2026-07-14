#requires -Version 7.0
# BEHAVIOURAL tests for stock-preparation-onprem-acceptance.ps1 (#3751 T9).
#
# The sibling *.tests.ps1 file locks STATIC (source-text) invariants. Those cannot catch a fake-PASS
# path — a stage that reports PASS on a skipped / absent check. These tests run the script as a real
# subprocess against crafted fixtures and assert the EMITTED acceptance-summary.json, so a stage that
# fails to fail is caught (#4210 owner review). They are cross-platform (pwsh 7 + node only — the SHA
# and migration stages under test never touch pm2 / Invoke-WebRequest / the Windows deploy path).
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..' 'stock-preparation-onprem-acceptance.ps1'
$pass = 0; $fail = 0
function Check { param([string]$Name, [bool]$Ok) if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" } else { $script:fail++; Write-Host "  FAIL  $Name" } }

function New-Fixture {
  param(
    [bool]$WithMetadata = $false, [string]$MetaGitSha = $null, [bool]$MetaNoGitShaKey = $false,
    [bool]$WithBootstrap = $false, [string]$MigrateBehaviour = $null  # 'confirm_fails' | 'confirm_ok' | $null (no migrate.js)
  )
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("t9accept_" + [guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory -Path $root | Out-Null
  $pkgDir = Join-Path $root 'pkg'; New-Item -ItemType Directory -Path $pkgDir | Out-Null
  $deployRoot = Join-Path $root 'deploy'; New-Item -ItemType Directory -Path $deployRoot | Out-Null
  # A real "package" file + a correct SHA256SUMS so stage-1 checksum always passes; the tests exercise
  # the SEPARATE ExpectedGitSha / migration branches, not the checksum branch.
  $pkg = Join-Path $pkgDir 'ms2-onprem.tgz'
  Set-Content -Path $pkg -Value 'fixture-package-bytes' -NoNewline
  $sha = (Get-FileHash -Path $pkg -Algorithm SHA256).Hash.ToLower()
  Set-Content -Path (Join-Path $pkgDir 'SHA256SUMS') -Value "$sha  ms2-onprem.tgz"
  if ($WithMetadata) {
    $meta = if ($MetaNoGitShaKey) { @{ builtAt = '2026-07-13' } } else { @{ gitSha = $MetaGitSha } }
    ($meta | ConvertTo-Json) | Set-Content -Path (Join-Path $pkgDir 'ms2-onprem.json')
  }
  if ($WithBootstrap) {
    Set-Content -Path (Join-Path $pkgDir 'ms2-deploy-bootstrap.ps1') -Value 'param($PackagePath,$DeployRoot) exit 0'
  }
  if ($MigrateBehaviour) {
    $migrateDir = Join-Path $deployRoot 'packages/core-backend/dist/src/db'
    New-Item -ItemType Directory -Path $migrateDir -Force | Out-Null
    # migrate: plain run exits 0 (apply ok); --confirm exits per the behaviour under test.
    $confirmExit = if ($MigrateBehaviour -eq 'confirm_fails') { 1 } else { 0 }
    $js = "const a=process.argv.slice(2); if(a.includes('--confirm')){process.exit($confirmExit)} process.exit(0)"
    Set-Content -Path (Join-Path $migrateDir 'migrate.js') -Value $js
  }
  [pscustomobject]@{ Root = $root; Package = $pkg; DeployRoot = $deployRoot; Summary = (Join-Path $root 'acceptance-summary.txt') }
}

function Invoke-Acceptance {
  param([object]$Fixture, [string]$ExpectedGitSha)
  $a = @('-NoProfile', '-File', $scriptPath, '-PackagePath', $Fixture.Package, '-DeployRoot', $Fixture.DeployRoot,
    '-SummaryPath', $Fixture.Summary, '-AdminTokenEnvVar', 'T9_NO_SUCH_TOKEN_VAR')
  if ($ExpectedGitSha) { $a += @('-ExpectedGitSha', $ExpectedGitSha) }
  # Never reaches the token prompt (fails earlier); stdin is redirected so a stray Read-Host can't hang.
  $out = & pwsh @a 2>&1
  $exit = $LASTEXITCODE
  $jsonPath = [System.IO.Path]::ChangeExtension($Fixture.Summary, '.json')
  $summary = if (Test-Path $jsonPath) { Get-Content $jsonPath -Raw | ConvertFrom-Json } else { $null }
  [pscustomobject]@{ Exit = $exit; Summary = $summary }
}

try {
  # ── D1: -ExpectedGitSha lock is ENFORCED (was a silent pass on missing metadata / absent gitSha). ──
  $r = Invoke-Acceptance (New-Fixture) 'abc123'
  Check "ExpectedGitSha + NO metadata -> sha FAIL (not a silent pass)" ($r.Exit -eq 1 -and $r.Summary.packageShaMatch -eq 'FAIL' -and $r.Summary.failedStage -eq 'sha' -and $r.Summary.failDetail.reason -eq 'metadata_missing')

  $r = Invoke-Acceptance (New-Fixture -WithMetadata $true -MetaNoGitShaKey $true) 'abc123'
  Check "ExpectedGitSha + metadata WITHOUT gitSha -> sha FAIL" ($r.Exit -eq 1 -and $r.Summary.packageShaMatch -eq 'FAIL' -and $r.Summary.failDetail.reason -eq 'metadata_git_sha_absent')

  $r = Invoke-Acceptance (New-Fixture -WithMetadata $true -MetaGitSha 'deadbeef') 'abc123'
  Check "ExpectedGitSha MISMATCH -> sha FAIL" ($r.Exit -eq 1 -and $r.Summary.failDetail.reason -eq 'git_sha_mismatch')

  # Match: stage 1 PASSES (proceeds to install, which fails here because no bootstrap ps1 is present).
  $r = Invoke-Acceptance (New-Fixture -WithMetadata $true -MetaGitSha 'ABC123') 'abc123'
  Check "ExpectedGitSha MATCH (case-insensitive) -> sha PASS, stops later at install" ($r.Summary.packageShaMatch -eq 'PASS' -and $r.Summary.failedStage -eq 'install')

  # ── D2: migration confirm is FAIL-CLOSED (was PASS when the confirm step was absent). ──────────────
  $r = Invoke-Acceptance (New-Fixture -WithMetadata $true -MetaGitSha 'abc' -WithBootstrap $true -MigrateBehaviour 'confirm_fails') 'abc'
  Check "migrate --confirm exits nonzero -> migrationStatus FAIL, failedStage migrate" ($r.Exit -eq 1 -and $r.Summary.migrationStatus -eq 'FAIL' -and $r.Summary.failedStage -eq 'migrate' -and $r.Summary.failDetail.reason -eq 'target_not_applied')

  # Confirm OK: migrationStatus PASS (then stops later at pm2, which is absent) — proves the PASS path.
  $r = Invoke-Acceptance (New-Fixture -WithMetadata $true -MetaGitSha 'abc' -WithBootstrap $true -MigrateBehaviour 'confirm_ok') 'abc'
  Check "migrate --confirm exits 0 -> migrationStatus PASS (stops later past migrate)" ($r.Summary.migrationStatus -eq 'PASS' -and $r.Summary.failedStage -ne 'migrate')
}
finally {
  Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 't9accept_*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -gt 0) { Write-Host "FAILED: $fail behavioural check(s), $pass passed"; exit 1 } else { Write-Host "ALL $pass BEHAVIOURAL CHECKS PASS"; exit 0 }
