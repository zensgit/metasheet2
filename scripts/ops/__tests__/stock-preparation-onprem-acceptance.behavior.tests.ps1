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
$pm2SampleHelper = Join-Path $PSScriptRoot '..' 'stock-preparation-pm2-sample.mjs'
$pass = 0; $fail = 0
function Check { param([string]$Name, [bool]$Ok) if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" } else { $script:fail++; Write-Host "  FAIL  $Name" } }

function Invoke-Pm2Projection {
  param([string]$Json)
  $raw = $Json | & node $pm2SampleHelper 2>$null
  $exit = $LASTEXITCODE
  $sample = if ($exit -eq 0 -and $raw) { $raw | ConvertFrom-Json } else { $null }
  [pscustomobject]@{ Exit = $exit; Raw = "$raw"; Sample = $sample }
}

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
    [bool]$AmbiguousRoot = $false,           # TWO top-level dirs in the archive (no single deterministic root)
    [string]$MalformedProvenanceRaw = $null  # write literal (invalid) JSON at the root provenance path (owner P2)
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
  if ($MalformedProvenanceRaw) {
    # Literal invalid JSON at the ROOT provenance path — ConvertFrom-Json throws with a message that
    # echoes this text; the summary must not carry it.
    Set-Content -Path (Join-Path $content 'BUILD_PROVENANCE.json') -Value $MalformedProvenanceRaw -NoNewline
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
    # Mirror the REAL release sidecar contract (multitable-onprem-deploy-launcher.ps1),
    # not the acceptance caller. Requiring both named arguments prevents caller and
    # fixture from drifting together while the packaged sidecar rejects the call.
    $bootstrapSource = @'
param(
  [Parameter(Mandatory = $true)][string]$PackageArchive,
  [Parameter(Mandatory = $true)][string]$RootDir
)
if (-not (Test-Path -LiteralPath $PackageArchive -PathType Leaf)) { exit 81 }
if (-not (Test-Path -LiteralPath $RootDir -PathType Container)) { exit 82 }
Set-Content -Path (Join-Path $RootDir 'bootstrap-contract.marker') -Value (Split-Path -Leaf $PackageArchive) -NoNewline
exit 0
'@
    Set-Content -Path $bootPath -Value $bootstrapSource
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
  [pscustomobject]@{
    Root = $root
    Package = $pkg
    DeployRoot = $deployRoot
    Summary = (Join-Path $root 'acceptance-summary.txt')
    BootstrapMarker = (Join-Path $deployRoot 'bootstrap-contract.marker')
  }
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

  # owner P2: malformed provenance JSON must map to a FIXED reason, never echo the input (a secret in the
  # bad JSON) into the values-free summary. Version note: on Windows PowerShell 5.1 (the production runtime,
  # #requires -Version 5.1) ConvertFrom-Json's error message echoes the offending JSON text verbatim — that
  # was the leak. PS 7 (this test runner) does NOT echo it, so a raw string-scan of the summary would be
  # VACUOUS here (green whether or not the clamp exists). The load-bearing, version-INDEPENDENT invariant is
  # instead asserted directly: failDetail.reason must be one of the FIXED coarse tokens — so the summary can
  # structurally never carry the free-form parse message (hence never any input), on any PowerShell version.
  $KNOWN_PROV_REASONS = @('provenance_archive_unreadable', 'provenance_missing', 'provenance_root_ambiguous', 'provenance_invalid', 'provenance_git_commit_absent', 'provenance_error')
  $secret = 'MAT-001-SECRET'
  $fx = New-Fixture -MalformedProvenanceRaw ('{ "gitCommit": "' + $secret + '", oops-not-json ')
  $r = Invoke-Acceptance $fx $GOOD_SHA
  $txt = if (Test-Path $fx.Summary) { Get-Content $fx.Summary -Raw } else { '' }
  $rawJsonPath = [System.IO.Path]::ChangeExtension($fx.Summary, '.json')
  $jsonTxt = if (Test-Path $rawJsonPath) { Get-Content $rawJsonPath -Raw } else { '' }
  Check "malformed provenance JSON -> sha FAIL (provenance_invalid), fixed reason not the parse message" ($r.Exit -eq 1 -and $r.Summary.failedStage -eq 'sha' -and $r.Summary.failDetail.reason -eq 'provenance_invalid')
  # Load-bearing (goes RED under the raw-message mutation on any PS version): reason is a fixed token.
  Check "malformed provenance: failDetail.reason is a FIXED coarse token, never the free-form parse message" ($KNOWN_PROV_REASONS -contains "$($r.Summary.failDetail.reason)")
  # Belt (meaningful on PS 5.1 where the message echoes; vacuous-but-true on PS 7): the secret is absent.
  Check "malformed provenance: the secret never appears in the summary .txt/.json" (-not ($txt -match $secret) -and -not ($jsonTxt -match $secret))

  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $OTHER_SHA) $GOOD_SHA
  Check "in-archive gitCommit != ExpectedGitSha -> sha FAIL (git_sha_mismatch)" ($r.Exit -eq 1 -and $r.Summary.failDetail.reason -eq 'git_sha_mismatch')

  # MATCH (case-insensitive): stage 1 PASSES, proceeds to install (fails: no bootstrap present).
  $r = Invoke-Acceptance (New-Fixture -ProvenanceGitCommit $GOOD_SHA) ($GOOD_SHA.ToUpper())
  Check "in-archive gitCommit == ExpectedGitSha -> sha PASS, stops later at install" ($r.Summary.packageShaMatch -eq 'PASS' -and $r.Summary.failedStage -eq 'install')

  # ── D2: bootstrap selected by EXACT bound name + verified against SHA256SUMS (owner P1). ─────────────
  # Correctly-named bootstrap with a valid checksum: stage 2 PASSES, stops later at migrate (absent).
  $fx = New-Fixture -ProvenanceGitCommit $GOOD_SHA -WithBootstrap $true
  $r = Invoke-Acceptance $fx $GOOD_SHA
  Check "correct bootstrap name + checksum -> install PASS, stops later at migrate" ($r.Summary.packageShaMatch -eq 'PASS' -and $r.Summary.failedStage -eq 'migrate')
  Check "bootstrap receives the archive file and deploy root through the release-sidecar contract" (
    (Test-Path $fx.BootstrapMarker -PathType Leaf) -and
    (Get-Content $fx.BootstrapMarker -Raw) -eq (Split-Path -Leaf $fx.Package)
  )

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

  # ── D5 (corrective-3): the stage-6 smoke capture is stdout-ONLY (2>$null), never merged (2>&1). A child
  # that writes noise to stderr AND a valid values-free summary to stdout must NOT abort the capture (the
  # RC-0 POWERSHELL_NATIVE_STDERR_PROMOTION failure — where 2>&1 promoted native stderr to a terminating
  # error and the smoke's summary was never read), must NOT let the stderr text contaminate the parsed
  # summary, and must still parse PASS. Mutation guards: flip 2>$null back to 2>&1 and the sentinel check reds;
  # hard-code the captured exit to zero and the non-zero preservation + stage fail-closed checks red.
  $fakeSmokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("t9accept_fakesmoke_" + [guid]::NewGuid().ToString('N').Substring(0, 12))
  $fakeSmokeOps = Join-Path $fakeSmokeRoot 'scripts/ops'
  New-Item -ItemType Directory -Path $fakeSmokeOps -Force | Out-Null
  $fakeSmoke = Join-Path $fakeSmokeOps 'stock-preparation-mvp-postdeploy-smoke.mjs'
  $sentinel = 'STDERR-LEAK-SENTINEL-7788'
  $fakeLines = @(
    "process.stderr.write('$sentinel\n')",
    "process.stderr.write('(node:1) ExperimentalWarning: stderr noise the runner must not capture\n')",
    "process.stdout.write('mvpSmoke.pass=true\n')",
    "process.stdout.write('auditActionsCovered=8/8\n')",
    "process.stdout.write('selfScanClean=true\n')",
    "process.exit(0)"
  )
  Set-Content -LiteralPath $fakeSmoke -Encoding utf8 -Value ($fakeLines -join "`n")
  $dummyToken = ConvertTo-SecureString 'dummy-not-a-real-token' -AsPlainText -Force
  $smokeThrew = $false
  $cap = $null
  try { $cap = Invoke-SmokeCapture -NodeArgs @($fakeSmoke) -Token $dummyToken } catch { $smokeThrew = $true }
  Check "corrective-3: a stderr-writing child does NOT abort the capture (no native stderr promotion)" ((-not $smokeThrew) -and $null -ne $cap)
  Check "corrective-3: the stderr sentinel is NOT captured into the parsed summary (2>`$null, not 2>&1)" ($null -ne $cap -and -not ("$($cap.stdout)" -match [regex]::Escape($sentinel)))
  $capOutcome = Test-SmokeOutcome "$($cap.stdout)"
  Check "corrective-3: the stdout values-free summary still parses to PASS (8/8, clean)" ($capOutcome.ok -and $capOutcome.pass -and $capOutcome.audit -eq '8/8' -and $capOutcome.selfScan)
  Check "corrective-3: exit code preserved (0) and the token env var is cleared after capture" ($null -ne $cap -and $cap.exit -eq 0 -and -not (Test-Path Env:METASHEET_AUTH_TOKEN))

  $nonzeroLines = @(
    "process.stdout.write('mvpSmoke.pass=true\n')",
    "process.stdout.write('auditActionsCovered=8/8\n')",
    "process.stdout.write('selfScanClean=true\n')",
    'process.exit(7)'
  )
  Set-Content -LiteralPath $fakeSmoke -Encoding utf8 -Value ($nonzeroLines -join "`n")
  $nonzeroCap = Invoke-SmokeCapture -NodeArgs @($fakeSmoke) -Token $dummyToken
  Check "corrective-3: non-zero native exit code is preserved exactly (7), never normalized to success" (
    $nonzeroCap.exit -eq 7 -and -not (Test-Path Env:METASHEET_AUTH_TOKEN)
  )

  # Exercise the real stage boundary in a child pwsh process because Stop-WithFailure intentionally exits.
  # A valid-looking summary with native exit 7 must still fail the stage and retain only the coarse exit code.
  $stageHarness = Join-Path $fakeSmokeRoot 'invoke-smoke-stage.ps1'
  $stageSummary = Join-Path $fakeSmokeRoot 'stage-summary.txt'
  Set-Content -LiteralPath $stageHarness -Encoding utf8 -Value @'
param(
  [Parameter(Mandatory = $true)][string]$AcceptanceScript,
  [Parameter(Mandatory = $true)][string]$DeployRoot,
  [Parameter(Mandatory = $true)][string]$SummaryPath
)
$ErrorActionPreference = 'Stop'
. $AcceptanceScript -PackagePath $DeployRoot -DeployRoot $DeployRoot -SummaryPath $SummaryPath *> $null
$token = ConvertTo-SecureString 'dummy-not-a-real-token' -AsPlainText -Force
Invoke-SmokeStage -Token $token
'@
  $stageOutput = & pwsh -NoProfile -File $stageHarness -AcceptanceScript $scriptPath -DeployRoot $fakeSmokeRoot -SummaryPath $stageSummary 2>&1
  $stageExit = $LASTEXITCODE
  $stageSummaryJsonPath = [System.IO.Path]::ChangeExtension($stageSummary, '.json')
  $stageSummaryJson = if (Test-Path $stageSummaryJsonPath) { Get-Content $stageSummaryJsonPath -Raw | ConvertFrom-Json } else { $null }
  Check "corrective-3: the real smoke stage fails closed on exit 7 and records only the coarse exit" (
    $stageExit -eq 1 -and
    $null -ne $stageSummaryJson -and
    $stageSummaryJson.failedStage -eq 'smoke' -and
    $stageSummaryJson.failDetail.smokeExit -eq 7 -and
    "$stageOutput" -notmatch 'dummy-not-a-real-token'
  )

  $base = [pscustomobject]@{ state = 'online'; restartTime = 3; uptime = 1000 }

  # Entity corrective-1 reproduction: PM2 includes process.env in jlist; on Windows it commonly carries
  # both Path and PATH. PowerShell ConvertFrom-Json rejects those case-variant keys, so the Node boundary
  # must consume the raw payload and return only a fixed coarse projection.
  $pm2Secret = 'MAT-001-SECRET'
  $pm2WithDuplicateCaseKeys = '[{"name":"metasheet-backend","pm2_env":{"status":"online","restart_time":3,"pm_uptime":1000,"env":{"Path":"first","PATH":"second","MATERIAL":"' + $pm2Secret + '"}}}]'
  $projected = Invoke-Pm2Projection $pm2WithDuplicateCaseKeys
  Check "pm2 projection: Path/PATH duplicate-case payload parses into the three-field sample" (
    $projected.Exit -eq 0 -and
    $projected.Sample.state -eq 'online' -and
    $projected.Sample.restartTime -eq 3 -and
    $projected.Sample.uptime -eq 1000
  )
  Check "pm2 projection: environment and sentinel values never cross the projection" (
    $projected.Raw -notmatch $pm2Secret -and
    @($projected.Sample.PSObject.Properties.Name).Count -eq 3
  )

  # Exercise the actual Get-Pm2Sample native-command pipeline, not only the helper in isolation. This
  # catches regressions in `$LASTEXITCODE handling or accidentally moving ConvertFrom-Json before Node.
  $fakePm2Dir = Join-Path ([System.IO.Path]::GetTempPath()) ("t9accept_pm2_" + [guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory -Path $fakePm2Dir | Out-Null
  $fakePm2Js = Join-Path $fakePm2Dir 'pm2-fixture.mjs'
  Set-Content -Path $fakePm2Js -Value @'
#!/usr/bin/env node
if (process.argv[2] !== 'jlist') process.exit(2)
process.stdout.write(process.env.T9_PM2_JLIST || '')
'@ -NoNewline
  if ($IsWindows) {
    Set-Content -Path (Join-Path $fakePm2Dir 'pm2.cmd') -Value @'
@echo off
node "%~dp0pm2-fixture.mjs" %*
'@ -NoNewline
  } else {
    $fakePm2 = Join-Path $fakePm2Dir 'pm2'
    Set-Content -Path $fakePm2 -Value @'
#!/bin/sh
exec node "$(dirname "$0")/pm2-fixture.mjs" "$@"
'@ -NoNewline
    & chmod +x $fakePm2
  }
  $oldPath = $env:PATH
  try {
    $env:PATH = "$fakePm2Dir$([IO.Path]::PathSeparator)$oldPath"
    $env:T9_PM2_JLIST = $pm2WithDuplicateCaseKeys
    $actualSample = Get-Pm2Sample
    Check "pm2 projection: Get-Pm2Sample survives duplicate-case keys through the native pipeline" (
      $actualSample.state -eq 'online' -and $actualSample.restartTime -eq 3 -and $actualSample.uptime -eq 1000
    )
  } finally {
    $env:PATH = $oldPath
    Remove-Item Env:T9_PM2_JLIST -ErrorAction SilentlyContinue
  }

  $unknownState = Invoke-Pm2Projection '[{"name":"metasheet-backend","pm2_env":{"status":"MAT-001-SECRET","restart_time":0,"pm_uptime":1}}]'
  Check "pm2 projection: unknown free-form state is clamped to a coarse token" (
    $unknownState.Exit -eq 0 -and $unknownState.Sample.state -eq 'unknown' -and $unknownState.Raw -notmatch 'MAT-001-SECRET'
  )

  $duplicateTarget = Invoke-Pm2Projection '[{"name":"metasheet-backend","pm2_env":{"status":"online","restart_time":0,"pm_uptime":1}},{"name":"metasheet-backend","pm2_env":{"status":"online","restart_time":0,"pm_uptime":1}}]'
  Check "pm2 projection: duplicate target processes fail closed with no output" (
    $duplicateTarget.Exit -ne 0 -and -not $duplicateTarget.Raw
  )

  $invalidCounters = Invoke-Pm2Projection '[{"name":"metasheet-backend","pm2_env":{"status":"online","restart_time":"3","pm_uptime":1000}}]'
  Check "pm2 projection: malformed counters fail closed with no output" (
    $invalidCounters.Exit -ne 0 -and -not $invalidCounters.Raw
  )

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
