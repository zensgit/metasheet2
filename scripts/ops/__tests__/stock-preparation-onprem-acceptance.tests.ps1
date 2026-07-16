#requires -Version 5.1
# Static contract tests for stock-preparation-onprem-acceptance.ps1 (#3751 T9).
# The full deploy path is Windows-only and cannot run in CI/sandbox, so these lock the two
# security-critical, statically-verifiable invariants: (1) the summary is values-free by construction
# (exactly the 9 whitelisted fields), (2) the admin token never crosses into the summary / a file /
# a log — it only ever rides a scoped process env var that is cleared in a finally.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..' 'stock-preparation-onprem-acceptance.ps1'
$src = Get-Content $script -Raw
$launcher = Join-Path $PSScriptRoot '..' 'multitable-onprem-deploy-launcher.ps1'
$pm2SampleHelper = Join-Path $PSScriptRoot '..' 'stock-preparation-pm2-sample.mjs'
$opsDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$repoRoot = Resolve-Path (Join-Path $opsDir '../..')
$packageBuild = Join-Path $opsDir 'multitable-onprem-package-build.sh'
$onPremEnvTemplate = Join-Path $repoRoot 'docker/app.env.multitable-onprem.template'
$fail = 0
function Check { param([string]$Name, [bool]$Ok) if ($Ok) { Write-Host "  PASS  $Name" } else { Write-Host "  FAIL  $Name"; $script:fail++ } }

# Parse both sides of the bootstrap boundary. A fixture that copies the caller's
# parameter names can let caller and test drift together while the release sidecar
# has a different contract, which is exactly what the RC-0 entity-machine run found.
$acceptanceTokens = $null; $acceptanceErrors = $null
$acceptanceAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $script, [ref]$acceptanceTokens, [ref]$acceptanceErrors
)
$launcherTokens = $null; $launcherErrors = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $launcher, [ref]$launcherTokens, [ref]$launcherErrors
)
$launcherParams = @($launcherAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
$bootstrapCalls = @($acceptanceAst.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and
    $node.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
    $node.CommandElements.Count -gt 0 -and
    $node.CommandElements[0].Extent.Text -eq '$bootstrapPath'
}, $true))
$bootstrapCallParams = if ($bootstrapCalls.Count -eq 1) {
  @($bootstrapCalls[0].CommandElements |
    Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
    ForEach-Object { $_.ParameterName })
} else { @() }

Check "acceptance and launcher scripts parse without errors" (
  $acceptanceErrors.Count -eq 0 -and $launcherErrors.Count -eq 0
)
Check "release launcher exposes PackageArchive and RootDir" (
  'PackageArchive' -in $launcherParams -and 'RootDir' -in $launcherParams
)
Check "acceptance calls the release launcher with its canonical parameter names" (
  $bootstrapCalls.Count -eq 1 -and
  $bootstrapCallParams.Count -eq 2 -and
  'PackageArchive' -in $bootstrapCallParams -and
  'RootDir' -in $bootstrapCallParams -and
  'PackagePath' -notin $bootstrapCallParams -and
  'DeployRoot' -notin $bootstrapCallParams
)

# The package template and acceptance runner are one operator contract. A stale default makes a healthy
# service look down, as the corrective-1 entity run proved (configured 8900 vs runner default 8081).
$portParam = @($acceptanceAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Port' })
$templatePortMatch = [regex]::Match((Get-Content $onPremEnvTemplate -Raw), '(?m)^PORT=([0-9]+)\s*$')
Check "acceptance default port matches the packaged on-prem environment template" (
  $portParam.Count -eq 1 -and
  $templatePortMatch.Success -and
  $portParam[0].DefaultValue.Extent.Text -eq $templatePortMatch.Groups[1].Value
)

# ── corrective-3: stage-6 must DELEGATE the smoke run to the summary-only helper (stdout-only, 2>$null),
# never invoke node directly or MERGE stderr (2>&1). The behaviour test exercises the helper in isolation,
# so it cannot catch a revert of the STAGE wiring back to `& node ... 2>&1`; pin that wiring in the AST here
# (the RC-0 POWERSHELL_NATIVE_STDERR_PROMOTION regression, where merged native stderr aborted the capture).
$smokeStageAst = @($acceptanceAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-SmokeStage' }, $true))[0]
$smokeCaptureAst = @($acceptanceAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-SmokeCapture' }, $true))[0]
$stageCallsCapture = $null -ne $smokeStageAst -and @($smokeStageAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Invoke-SmokeCapture' }, $true)).Count -ge 1
$stageInvokesNode = $null -ne $smokeStageAst -and @($smokeStageAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'node' }, $true)).Count -gt 0
Check "corrective-3: stage-6 delegates the smoke run to Invoke-SmokeCapture and never invokes node directly" (
  $stageCallsCapture -and -not $stageInvokesNode
)
$captureNode = if ($null -ne $smokeCaptureAst) { @($smokeCaptureAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'node' }, $true)) } else { @() }
$captureRedirs = if ($captureNode.Count -ge 1) { $captureNode[0].Redirections } else { @() }
$hasErrToFile = @($captureRedirs | Where-Object { $_ -is [System.Management.Automation.Language.FileRedirectionAst] -and $_.FromStream -eq [System.Management.Automation.Language.RedirectionStream]::Error }).Count -ge 1
$hasErrMerged = @($captureRedirs | Where-Object { $_ -is [System.Management.Automation.Language.MergingRedirectionAst] }).Count -ge 1
Check "corrective-3: the smoke capture redirects stderr away (2>`$null), never merges it (2>&1)" (
  $captureNode.Count -ge 1 -and $hasErrToFile -and -not $hasErrMerged
)

# Windows PowerShell rejects ordinary PM2 payloads containing case-variant environment keys such as
# Path/PATH. The raw document must cross a Node projection boundary before PowerShell deserializes it,
# and that projection helper must be a required package asset.
$packageBuildSrc = Get-Content $packageBuild -Raw
Check "PM2 jlist is projected by the packaged Node helper before ConvertFrom-Json" (
  (Test-Path -LiteralPath $pm2SampleHelper -PathType Leaf) -and
  $src -match '&\s+node\s+\$pm2SampleHelper' -and
  -not ($src -match 'pm2\s+jlist[^\r\n]*ConvertFrom-Json')
)
Check "PM2 projection helper is required by the on-prem package build" (
  $packageBuildSrc -match '"scripts/ops/stock-preparation-pm2-sample\.mjs"'
)

# ── 1. Summary is values-free by construction: exactly the 9 whitelisted keys, nothing else. ─────
$expected9 = @(
  'packageShaMatch','migrationStatus','pm2StableOnline','healthcheck',
  'mvpSmoke.pass','auditActionsCovered','selfScanClean','externalPlmK3ErpWrite','failedStage'
)
$summaryBlock = if ($src -match "(?s)\`$Summary = \[ordered\]@\{(.*?)\}") { $Matches[1] } else { '' }
$foundKeys = [regex]::Matches($summaryBlock, "(?m)^\s*'?([A-Za-z0-9.]+)'?\s*=") | ForEach-Object { $_.Groups[1].Value }
Check "summary declares exactly the 9 whitelisted fields" (
  ($foundKeys.Count -eq 9) -and (($expected9 | Where-Object { $_ -notin $foundKeys }).Count -eq 0)
)
Check "summary has NO value-plane field (drawing/qty/unit/material/host/token)" (
  -not ($summaryBlock -match '(?i)drawing|qty|quantity|unit|material|host|token|password|secret|projectName')
)

# ── 2. Token discipline. ─────────────────────────────────────────────────────────────────────────
Check "token env var is REMOVED after use (finally scrub)" (
  $src -match 'Remove-Item\s+Env:METASHEET_AUTH_TOKEN'
)
Check "token is NEVER written to the summary file (no Set-Content of the token)" (
  -not ($src -match '(?i)Set-Content[^\n]*METASHEET_AUTH_TOKEN') -and
  -not ($src -match '(?i)Set-Content[^\n]*\$token')
)
Check "token is NEVER passed on a command line / ArgumentList" (
  -not ($src -match '(?i)ArgumentList[^\n]*token') -and
  -not ($src -match '(?i)node @args[^\n]*token')
)
Check "the plaintext token only crosses via a scoped `$env:METASHEET_AUTH_TOKEN assignment" (
  $src -match '\$env:METASHEET_AUTH_TOKEN\s*='
)

# ── 3. Failure discipline: no MIGRATION_EXCLUDE, no self-heal. ───────────────────────────────────
# The script may MENTION MIGRATION_EXCLUDE in a prohibition comment (good — it documents the ban);
# what must never happen is an ASSIGNMENT that actually sets it.
Check "never ASSIGNS MIGRATION_EXCLUDE (comment mentioning the ban is fine)" (
  -not ($src -match '(?i)\$env:MIGRATION_EXCLUDE\s*=') -and
  -not ($src -match '(?im)^\s*MIGRATION_EXCLUDE\s*=')
)
Check "pm2 stage polls stable-online, not just restart-command success" (
  ($src -match 'pm2StableOnline') -and ($src -match "status.*-ne\s+'online'|-ne\s+'online'")
)

# ── 4. Acceptance criteria fields present ────────────────────────────────────────────────────────
foreach ($f in @('externalPlmK3ErpWrite','auditActionsCovered','pm2StableOnline')) {
  Check "criterion field present: $f" ($src -match [regex]::Escape($f))
}

if ($fail -gt 0) { Write-Host "FAILED: $fail check(s)"; exit 1 } else { Write-Host 'ALL CONTRACT CHECKS PASS'; exit 0 }
