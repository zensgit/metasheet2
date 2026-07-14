#requires -Version 7.0
# BEHAVIOURAL tests for stock-preparation-onprem-acceptance.ps1 (#3751 T9).
#
# The sibling *.tests.ps1 file locks STATIC (source-text) invariants. Those cannot catch a fake-PASS
# path — a stage that reports PASS on a skipped / absent check. These tests run the script as a real
# subprocess against crafted fixtures and assert the EMITTED acceptance-summary.json, so a stage that
# fails to fail is caught (#4210 owner review). The stages exercised here (SHA/provenance identity,
# bootstrap selection, migration) are cross-platform (pwsh 7 + tar + node); the pm2/health/smoke stages
# need a live server, so their fail-closed logic is unit-tested by DOT-SOURCING the pure helpers.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..' 'stock-preparation-onprem-acceptance.ps1'
$pass = 0; $fail = 0
function Check { param([string]$Name, [bool]$Ok) if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" } else { $script:fail++; Write-Host "  FAIL  $Name" } }

# A valid 40-hex commit the package claims to be built from (BUILD_PROVENANCE.json.gitCommit is enforced
# to be a full 40-hex by package-verify.sh, and the acceptance script now requires the same).
$GOOD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
$OTHER_SHA = 'ffffffffffffffffffffffffffffffffffffffff'

function New-Fixture {
  param(
    [string]$ProvenanceGitCommit = $null,   # embed BUILD_PROVENANCE.json (with this gitCommit) INSIDE the archive
    [string]$BadProvenance = $null,          # 'short' | 'absent_key' — malformed provenance inside the archive
    [bool]$WithBootstrap = $false,           # write <pkgbase>-deploy-bootstrap.ps1 + its SHA256SUMS entry
    [string]$BootstrapName = $null,          # override the bootstrap FILE name (mixed-package / wrong name)
    [bool]$BootstrapBadChecksum = $false,    # write the bootstrap but a WRONG SHA256SUMS entry for it
    [string]$MetaBootstrapName = $null,      # external metadata windowsFirstHopBootstrap value
    [string]$MigrateBehaviour = $null,       # 'confirm_fails' | 'confirm_ok' | $null (no migrate.js)
    [bool]$NestedOnlyProvenance = $false,    # provenance ONLY in a nested subdir, NOT at the package root (owner P2)
    [bool]$AmbiguousRoot = $false            # TWO top-level dirs in the archive (no single deterministic root)
  )
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("t9accept_" + [guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory -Path $root | Out-Null
  $pkgDir = Join-Path $root 'pkg'; New-Item -ItemType Directory -Path $pkgDir | Out-Null
  $deployRoot = Join-Path $root 'deploy'; New-Item -ItemType Directory -Path $deployRoot | Out-Null
  $pkgBase = 'ms2-onprem'
  $pkg = Join-Path $pkgDir "$pkgBase.tgz"

  # Build a REAL .tgz whose top-level dir carries BUILD_PROVENANCE.json — the same layout the acceptance
  # script extracts. (The old fixture wrote a text stub; the identity fix reads INSIDE the archive.)
  $stage = Join-Path $root 'stage'; $content = Join-Path $stage 'ms2-onprem'
  New-Item -ItemType Directory -Path $content -Force | Out-Null
  Set-Content -Path (Join-Path $content 'README.txt') -Value 'fixture' -NoNewline
  if ($ProvenanceGitCommit -or $BadProvenance) {
    $commit = if ($BadProvenance -eq 'short') { 'abc123' } elseif ($BadProvenance -eq 'absent_key') { $null } else { $ProvenanceGitCommit }
    # CONTRACT: field names mirror the REAL producer, not just the reader — multitable-onprem-package-build.sh:497
    # emits `"schema": "metasheet-onprem-build-provenance/v1"` and `"gitCommit": "..."` (verified 2026-07-14).
    # If that producer renames the field, THIS fixture must change too, or the reader would false-pass here
    # while false-failing on the real RC package.
    $prov = if ($BadProvenance -eq 'absent_key') { @{ schema = 'metasheet-onprem-build-provenance/v1'; builtAt = '2026-07-14' } } else { @{ schema = 'metasheet-onprem-build-provenance/v1'; gitCommit = $commit; builtAt = '2026-07-14' } }
    # NestedOnly: write provenance ONLY into a nested subdir, leaving the package ROOT with no provenance —
    # a recursive first-match reader would wrongly accept this; the root-only reader must reject it.
    $provTarget = if ($NestedOnlyProvenance) { $sub = Join-Path $content 'nested'; New-Item -ItemType Directory -Path $sub -Force | Out-Null; Join-Path $sub 'BUILD_PROVENANCE.json' } else { Join-Path $content 'BUILD_PROVENANCE.json' }
    ($prov | ConvertTo-Json) | Set-Content -Path $provTarget
  }
  if ($AmbiguousRoot) {
    # A SECOND top-level dir → the archive has no single deterministic package root.
    $content2 = Join-Path $stage 'ms2-onprem-extra'; New-Item -ItemType Directory -Path $content2 -Force | Out-Null
    Set-Content -Path (Join-Path $content2 'README.txt') -Value 'second-root' -NoNewline
    & tar -czf $pkg -C $stage 'ms2-onprem' 'ms2-onprem-extra' 2>$null
  } else {
    & tar -czf $pkg -C $stage 'ms2-onprem' 2>$null
  }

  # SHA256SUMS: always the archive; the bootstrap entry when a bootstrap is present.
  $shaLines = @()
  $shaLines += "$((Get-FileHash -Path $pkg -Algorithm SHA256).Hash.ToLower())  $pkgBase.tgz"
  if ($WithBootstrap) {
    $bootName = if ($BootstrapName) { $BootstrapName } else { "$pkgBase-deploy-bootstrap.ps1" }
    $bootPath = Join-Path $pkgDir $bootName
    Set-Content -Path $bootPath -Value 'param($PackagePath,$DeployRoot) exit 0'
    $bootHash = if ($BootstrapBadChecksum) { '0' * 64 } else { (Get-FileHash -Path $bootPath -Algorithm SHA256).Hash.ToLower() }
    $shaLines += "$bootHash  $bootName"
  }
  Set-Content -Path (Join-Path $pkgDir 'SHA256SUMS') -Value ($shaLines -join [Environment]::NewLine)

  if ($MetaBootstrapName) {
    (@{ windowsFirstHopBootstrap = $MetaBootstrapName } | ConvertTo-Json) | Set-Content -Path (Join-Path $pkgDir "$pkgBase.json")
  }

  if ($MigrateBehaviour) {
    $migrateDir = Join-Path $deployRoot 'packages/core-backend/dist/src/db'
    New-Item -ItemType Directory -Path $migrateDir -Force | Out-Null
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
  $out = & pwsh @a 2>&1
  $exit = $LASTEXITCODE
  $jsonPath = [System.IO.Path]::ChangeExtension($Fixture.Summary, '.json')
  $summary = if (Test-Path $jsonPath) { Get-Content $jsonPath -Raw | ConvertFrom-Json } else { $null }
  [pscustomobject]@{ Exit = $exit; Summary = $summary }
}

try {
  # ── D1: -ExpectedGitSha binds to BUILD_PROVENANCE.json INSIDE the archive (owner P1: not a sidecar). ──
  $r = Invoke-Acceptance (New-Fixture) $GOOD_SHA
  Check "ExpectedGitSha + archive has NO provenance -> sha FAIL (provenance_missing)" ($r.Exit -eq 1 -and $r.Summary.packageShaMatch -eq 'FAIL' -and $r.Summary.failedStage -eq 'sha' -and $r.Summary.failDetail.reason -eq 'provenance_missing')

  $r = Invoke-Acceptance (New-Fixture -BadProvenance 'absent_key') $GOOD_SHA
  Check "provenance WITHOUT gitCommit -> sha FAIL (provenance_git_commit_absent)" ($r.Exit -eq 1 -and $r.Summary.failDetail.reason -eq 'provenance_git_commit_absent')

  $r = Invoke-Acceptance (New-Fixture -BadProvenance 'short') $GOOD_SHA
  Check "provenance gitCommit not 40-hex -> sha FAIL (provenance_git_commit_absent)" ($r.Exit -eq 1 -and $r.Summary.failDetail.reason -eq 'provenance_git_commit_absent')

  # owner P2: a malformed package with provenance ONLY nested (no root file) must FAIL, not read the nested one.
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA -NestedOnlyProvenance $true) $GOOD_SHA
  Check "provenance nested-only (no root file) -> sha FAIL (provenance_missing), never reads the nested one" ($r.Exit -eq 1 -and $r.Summary.failedStage -eq 'sha' -and $r.Summary.failDetail.reason -eq 'provenance_missing')

  # owner P2: no single deterministic package root (two top-level dirs) -> FAIL (ambiguous root).
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA -AmbiguousRoot $true) $GOOD_SHA
  Check "ambiguous package root (2 top-level dirs) -> sha FAIL (provenance_root_ambiguous)" ($r.Exit -eq 1 -and $r.Summary.failedStage -eq 'sha' -and $r.Summary.failDetail.reason -eq 'provenance_root_ambiguous')

  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $OTHER_SHA) $GOOD_SHA
  Check "in-archive gitCommit != ExpectedGitSha -> sha FAIL (git_sha_mismatch)" ($r.Exit -eq 1 -and $r.Summary.failDetail.reason -eq 'git_sha_mismatch')

  # MATCH (case-insensitive): stage 1 PASSES, proceeds to install (fails: no bootstrap present).
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA) ($GOOD_SHA.ToUpper())
  Check "in-archive gitCommit == ExpectedGitSha -> sha PASS, stops later at install" ($r.Summary.packageShaMatch -eq 'PASS' -and $r.Summary.failedStage -eq 'install')

  # ── D2: bootstrap selected by EXACT bound name + verified against SHA256SUMS (owner P1). ─────────────
  # Correctly-named bootstrap with a valid checksum: stage 2 PASSES, stops later at migrate (absent).
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA -WithBootstrap $true) $GOOD_SHA
  Check "correct bootstrap name + checksum -> install PASS, stops later at migrate" ($r.Summary.packageShaMatch -eq 'PASS' -and $r.Summary.failedStage -eq 'migrate')

  # A DIFFERENT package's bootstrap in the same dir (wrong name) is NOT run — the derived name is absent.
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA -WithBootstrap $true -BootstrapName 'some-other-pkg-deploy-bootstrap.ps1') $GOOD_SHA
  Check "mixed dir: only a wrong-named bootstrap present -> install FAIL (bootstrap_ps1_missing), never runs it" ($r.Exit -eq 1 -and $r.Summary.failedStage -eq 'install' -and $r.Summary.failDetail.reason -eq 'bootstrap_ps1_missing')

  # Right name, but its bytes do not match the SHA256SUMS entry.
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA -WithBootstrap $true -BootstrapBadChecksum $true) $GOOD_SHA
  Check "bootstrap present but checksum mismatch -> install FAIL (bootstrap_checksum_mismatch)" ($r.Exit -eq 1 -and $r.Summary.failedStage -eq 'install' -and $r.Summary.failDetail.reason -eq 'bootstrap_checksum_mismatch')

  # Metadata names a DIFFERENT bootstrap than the deterministic one -> refuse (honor 'select by metadata').
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA -WithBootstrap $true -MetaBootstrapName 'wrong-deploy-bootstrap.ps1') $GOOD_SHA
  Check "metadata bootstrap name != derived name -> install FAIL (bootstrap_name_metadata_mismatch)" ($r.Exit -eq 1 -and $r.Summary.failedStage -eq 'install' -and $r.Summary.failDetail.reason -eq 'bootstrap_name_metadata_mismatch')

  # ── D3: migration confirm is FAIL-CLOSED (unchanged behaviour, re-checked with the real-archive fixture). ──
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA -WithBootstrap $true -MigrateBehaviour 'confirm_fails') $GOOD_SHA
  Check "migrate --confirm nonzero -> migrationStatus FAIL (target_not_applied)" ($r.Exit -eq 1 -and $r.Summary.migrationStatus -eq 'FAIL' -and $r.Summary.failedStage -eq 'migrate' -and $r.Summary.failDetail.reason -eq 'target_not_applied')

  # ── D4: smoke + pm2 fail-closed logic (DOT-SOURCED pure helpers — cannot drive a live server here). ──
  $tmpDir = [System.IO.Path]::GetTempPath()
  . $scriptPath -PackagePath $tmpDir -DeployRoot $tmpDir *> $null

  $full = "mvpSmoke.pass=true`nauditActionsCovered=8/8`nselfScanClean=true"
  $o = Test-SmokeOutcome $full
  Check "smoke: pass + 8/8 + clean -> ok" ($o.ok -and $o.audit -eq '8/8')

  $o = Test-SmokeOutcome "mvpSmoke.pass=true`nauditActionsCovered=7/8`nselfScanClean=true"
  Check "smoke: audit 7/8 -> FAIL (audit_incomplete), not a silent pass" ((-not $o.ok) -and $o.reason -eq 'audit_incomplete')

  $o = Test-SmokeOutcome "mvpSmoke.pass=true`nselfScanClean=true"
  Check "smoke: auditActionsCovered ABSENT -> FAIL (fail-closed, records N/8)" ((-not $o.ok) -and $o.audit -eq 'N/8' -and $o.reason -eq 'audit_incomplete')

  $o = Test-SmokeOutcome "mvpSmoke.pass=true`nauditActionsCovered=8/8`nselfScanClean=false"
  Check "smoke: selfScanClean=false -> FAIL (self_scan_not_clean)" ((-not $o.ok) -and $o.reason -eq 'self_scan_not_clean')

  $o = Test-SmokeOutcome "mvpSmoke.pass=true`nauditActionsCovered=8/8"
  Check "smoke: selfScanClean ABSENT -> FAIL (fail-closed)" ((-not $o.ok) -and $o.reason -eq 'self_scan_not_clean')

  $base = [pscustomobject]@{ state = 'online'; restartTime = 3; uptime = 1000 }
  Check "pm2: same restart_time + same uptime -> stable" ((Test-Pm2StableSample $base ([pscustomobject]@{ state='online'; restartTime=3; uptime=1000 })).ok)
  Check "pm2: restart_time incremented (crash-loop) -> FAIL (restart_loop)" ((Test-Pm2StableSample $base ([pscustomobject]@{ state='online'; restartTime=4; uptime=1000 })).reason -eq 'restart_loop')
  Check "pm2: pm_uptime moved forward (self-restart) -> FAIL (uptime_reset)" ((Test-Pm2StableSample $base ([pscustomobject]@{ state='online'; restartTime=3; uptime=2000 })).reason -eq 'uptime_reset')
  Check "pm2: sampled state 'errored' -> FAIL" ((Test-Pm2StableSample $base ([pscustomobject]@{ state='errored'; restartTime=3; uptime=1000 })).reason -eq 'state:errored')
  Check "pm2: process missing -> FAIL" ((Test-Pm2StableSample $base $null).reason -eq 'missing')
}
finally {
  Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 't9accept_*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -gt 0) { Write-Host "FAILED: $fail behavioural check(s), $pass passed"; exit 1 } else { Write-Host "ALL $pass BEHAVIOURAL CHECKS PASS"; exit 0 }
