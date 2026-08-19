#requires -Version 5.1
# Tests for scripts/ops/multitable-onprem-s6a-artifact-root-acl.ps1 — follow-up 1 of
# docs/development/stock-preparation-s6a-windows-runtime-parity-20260818.md.
#
# Three layers, because none of them substitutes for the others:
#   1. STATIC wiring — the apply helper really invokes the step before the PM2
#      restart, both entry points expose the escape hatch, the package ships the file.
#   2. INJECTED icacls / ACL facts — proves the argument vector, the fail-closed
#      branches, and that no attestation is ever written on a failure. A fake cannot
#      prove the ACL is real, which is why layer 3 exists.
#   3. REAL icacls against a throwaway directory under the process TEMP dir — proves
#      the applied ACL actually verifies, that a re-run is idempotent, and that a
#      tampered ACL retracts the attestation.
#
# Runs under Windows PowerShell 5.1 and pwsh 7. On a non-Windows host layers 2 and 3
# are skipped and the not-applicable branch is asserted instead.
$ErrorActionPreference = 'Stop'

$opsDir = Join-Path $PSScriptRoot '..'
$helperPath = Join-Path $opsDir 'multitable-onprem-s6a-artifact-root-acl.ps1'
$applyPath = Join-Path $opsDir 'multitable-onprem-apply-package.ps1'
$launcherPath = Join-Path $opsDir 'multitable-onprem-deploy-launcher.ps1'
$packageBuildPath = Join-Path $opsDir 'multitable-onprem-package-build.sh'

$pass = 0
$fail = 0
$skip = 0

function Check {
  param([string]$Name, [bool]$Ok)
  if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" }
  else { $script:fail++; Write-Host "  FAIL  $Name" }
}
function Skip {
  param([string]$Name)
  $script:skip++
  Write-Host "  SKIP  $Name"
}

$isWindowsHost = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)

# ── Layer 1: static wiring ───────────────────────────────────────────────────────
$helperTokens = $null; $helperErrors = $null
$helperAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $helperPath, [ref]$helperTokens, [ref]$helperErrors)
$applyTokens = $null; $applyErrors = $null
$applyAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $applyPath, [ref]$applyTokens, [ref]$applyErrors)
$launcherTokens = $null; $launcherErrors = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $launcherPath, [ref]$launcherTokens, [ref]$launcherErrors)

Check 'helper, apply helper and launcher all parse without errors' (
  $helperErrors.Count -eq 0 -and $applyErrors.Count -eq 0 -and $launcherErrors.Count -eq 0
)

function Get-ParameterDefault {
  param($Ast, [string]$Name)
  $parameter = @($Ast.ParamBlock.Parameters |
    Where-Object { $_.Name.VariablePath.UserPath -eq $Name })
  if ($parameter.Count -ne 1) { return $null }
  if ($null -eq $parameter[0].DefaultValue) { return $null }
  return $parameter[0].DefaultValue.Extent.Text
}

Check 'apply helper exposes -S6aArtifactRootAcl defaulting to auto' (
  (Get-ParameterDefault -Ast $applyAst -Name 'S6aArtifactRootAcl') -eq "'auto'"
)
Check 'launcher exposes -S6aArtifactRootAcl defaulting to auto' (
  (Get-ParameterDefault -Ast $launcherAst -Name 'S6aArtifactRootAcl') -eq "'auto'"
)

$applySrc = Get-Content -LiteralPath $applyPath -Raw
$aclStepIndex = $applySrc.IndexOf('Invoke-S6aArtifactRootAclStep `')
$pm2StartIndex = $applySrc.IndexOf("Write-Info 'Start or restart PM2 service'")
Check 'apply helper runs the ACL/attestation step BEFORE the PM2 restart' (
  $aclStepIndex -gt 0 -and $pm2StartIndex -gt 0 -and $aclStepIndex -lt $pm2StartIndex
)
Check 'apply helper gates the step on the sealed-snapshot flag, not on a bare switch' (
  $applySrc -match 'Test-S6aSealedSnapshotFlagEnabled' -and
  $applySrc -match 'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED'
)
Check 'apply helper fails closed when the ACL step reports a non-zero exit' (
  $applySrc -match "throw 'S6A_ARTIFACT_ROOT_ACL_ATTESTATION_FAILED'"
)
Check 'on-prem package build requires the ACL helper as a package file' (
  (Get-Content -LiteralPath $packageBuildPath -Raw) -match
    '"scripts/ops/multitable-onprem-s6a-artifact-root-acl\.ps1"'
)

# The runtime gate and this helper must agree on the exact env names and on the
# untrimmed / un-case-folded attestation literal.
$runtimeConfigPath = Join-Path $opsDir '..\..\plugins\plugin-integration-core\lib\sealed-export\stock-preparation-runtime-config.cjs'
$helperSrc = Get-Content -LiteralPath $helperPath -Raw
if (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf) {
  $runtimeSrc = Get-Content -LiteralPath $runtimeConfigPath -Raw
  Check 'helper writes exactly the env name and literal the runtime gate reads' (
    $runtimeSrc -match "MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED" -and
    $helperSrc -match "MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED" -and
    $helperSrc -match "\`$S6aAttestationValue = 'true'"
  )
} else {
  Skip 'helper writes exactly the env name and literal the runtime gate reads'
}

# ── Load the helper without running it ───────────────────────────────────────────
. $helperPath

$realInvokeIcacls = (Get-Command Invoke-S6aIcacls).ScriptBlock
$realGetFacts = (Get-Command Get-S6aArtifactRootAclFacts).ScriptBlock
$realResolveAccount = (Get-Command Resolve-S6aServiceAccount).ScriptBlock

$script:icaclsCalls = @()
$script:icaclsMode = 'real'
$script:fakeIcaclsExit = 0
$script:factsMode = 'real'
$script:fakeFactsOk = $true
$script:accountMode = 'real'

function Invoke-S6aIcacls {
  param([string[]]$Arguments)
  $script:icaclsCalls += , @($Arguments)
  if ($script:icaclsMode -eq 'real') {
    return (& $script:realInvokeIcacls -Arguments $Arguments)
  }
  return [pscustomobject]@{ ExitCode = $script:fakeIcaclsExit; LineCount = 0 }
}

function Get-S6aArtifactRootAclFacts {
  param([string]$Path, [string]$ServiceAccountSid)
  if ($script:factsMode -eq 'real') {
    return (& $script:realGetFacts -Path $Path -ServiceAccountSid $ServiceAccountSid)
  }
  return [pscustomobject]@{
    Ok = $script:fakeFactsOk
    InheritanceDisabled = $script:fakeFactsOk
    NoInheritedAce = $script:fakeFactsOk
    NoForbiddenPrincipal = $script:fakeFactsOk
    ServiceAceFullControl = $script:fakeFactsOk
    SystemAceFullControl = $script:fakeFactsOk
  }
}

function Resolve-S6aServiceAccount {
  if ($script:accountMode -eq 'real') { return (& $script:realResolveAccount) }
  return [pscustomobject]@{ Ok = $false; Sid = ''; Elevated = $false }
}

function Reset-Fakes {
  $script:icaclsCalls = @()
  $script:icaclsMode = 'real'
  $script:fakeIcaclsExit = 0
  $script:factsMode = 'real'
  $script:fakeFactsOk = $true
  $script:accountMode = 'real'
}

$ATTEST_KEY = 'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED'
$FLAG_KEY = 'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED'
$ROOT_KEY = 'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT'

$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('s6a_acl_' + [guid]::NewGuid().ToString('N').Substring(0, 12))

function New-Fixture {
  param(
    [string]$Enabled = 'true',
    [string]$ArtifactRoot = $null,
    [string]$PreExistingAttestation = $null,
    [switch]$OmitArtifactRoot
  )
  $dir = Join-Path $sandbox ([guid]::NewGuid().ToString('N').Substring(0, 10))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $envFile = Join-Path $dir 'app.env'
  $root = if ($ArtifactRoot) { $ArtifactRoot } else { Join-Path $dir 'artifacts' }
  $lines = @(
    '# fixture app.env',
    'DATABASE_URL=postgres://fixture/db',
    "$FLAG_KEY=$Enabled"
  )
  if (-not $OmitArtifactRoot) { $lines += "$ROOT_KEY=$root" }
  if ($PreExistingAttestation) { $lines += "$ATTEST_KEY=$PreExistingAttestation" }
  $lines += 'JWT_SECRET=fixture-secret'
  [System.IO.File]::WriteAllText(
    $envFile, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  return [pscustomobject]@{ Dir = $dir; EnvFile = $envFile; ArtifactRoot = $root }
}

function Get-EnvValue {
  param([string]$EnvFile, [string]$Name)
  $map = Get-S6aAppEnvMap -EnvFile $EnvFile
  return [string]$map[$Name]
}

function Test-LinesValuesFree {
  param([string[]]$Lines, [string[]]$Secrets)
  foreach ($line in $Lines) {
    if ($line -notmatch '^s6a[A-Za-z0-9]+=[A-Za-z0-9_]+$') { return $false }
    foreach ($secret in $Secrets) {
      if ([string]::IsNullOrWhiteSpace($secret)) { continue }
      if ($line.ToLowerInvariant().Contains($secret.ToLowerInvariant())) { return $false }
    }
  }
  return $true
}

try {
  New-Item -ItemType Directory -Path $sandbox -Force | Out-Null

  # ── Contract of the emitted lines (host independent) ───────────────────────────
  Reset-Fakes
  $offFixture = New-Fixture
  $offBefore = [System.IO.File]::ReadAllBytes($offFixture.EnvFile)
  $offResult = Invoke-S6aArtifactRootAclAttestation `
    -EnvFile $offFixture.EnvFile -AttestationMode 'off' -PlatformIsWindows $isWindowsHost
  $offAfter = [System.IO.File]::ReadAllBytes($offFixture.EnvFile)
  Check 'emitted contract is exactly the four documented keys, in order' (
    $offResult.Lines.Count -eq 4 -and
    $offResult.Lines[0] -match '^s6aArtifactRootAclApplied=(YES|NO)$' -and
    $offResult.Lines[1] -match '^s6aArtifactRootAclVerified=(PASS|FAIL|SKIP)$' -and
    $offResult.Lines[2] -match '^s6aWin32ArtifactAclAttested=(YES|NO)$' -and
    $offResult.Lines[3] -match '^s6aArtifactRootAclReason=[A-Z0-9_]+|none$'
  )
  Check 'opt-out (-AttestationMode off) leaves the env file byte-identical' (
    $offResult.Applied -eq 'NO' -and
    $offResult.Verified -eq 'SKIP' -and
    $offResult.Attested -eq 'NO' -and
    $offResult.Reason -eq 'S6A_ARTIFACT_ROOT_ACL_DISABLED_BY_OPERATOR' -and
    $offResult.Ok -and
    (-not $offResult.Applicable) -and
    (@(Compare-Object $offBefore $offAfter -SyncWindow 0)).Count -eq 0 -and
    (-not (Test-Path -LiteralPath $offFixture.ArtifactRoot))
  )

  Reset-Fakes
  $disabledFixture = New-Fixture -Enabled 'false' -PreExistingAttestation 'true'
  $disabledBefore = [System.IO.File]::ReadAllBytes($disabledFixture.EnvFile)
  $disabledResult = Invoke-S6aArtifactRootAclAttestation `
    -EnvFile $disabledFixture.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
  $disabledAfter = [System.IO.File]::ReadAllBytes($disabledFixture.EnvFile)
  Check 'a host that never enables the sealed-snapshot flag is not touched at all' (
    (-not $disabledResult.Applicable) -and
    $disabledResult.Applied -eq 'NO' -and
    $disabledResult.Verified -eq 'SKIP' -and
    $disabledResult.Reason -eq 'S6A_ARTIFACT_ROOT_ACL_NOT_APPLICABLE' -and
    $disabledResult.Ok -and
    $script:icaclsCalls.Count -eq 0 -and
    (@(Compare-Object $disabledBefore $disabledAfter -SyncWindow 0)).Count -eq 0 -and
    (-not (Test-Path -LiteralPath $disabledFixture.ArtifactRoot))
  )

  Reset-Fakes
  $posixFixture = New-Fixture
  $posixBefore = [System.IO.File]::ReadAllBytes($posixFixture.EnvFile)
  $posixResult = Invoke-S6aArtifactRootAclAttestation `
    -EnvFile $posixFixture.EnvFile -AttestationMode 'auto' -PlatformIsWindows $false
  $posixAfter = [System.IO.File]::ReadAllBytes($posixFixture.EnvFile)
  Check 'a non-win32 host is never attested and never touched (POSIX modes still rule)' (
    (-not $posixResult.Applicable) -and
    $posixResult.Attested -eq 'NO' -and
    $posixResult.Reason -eq 'S6A_ARTIFACT_ROOT_ACL_NOT_APPLICABLE' -and
    $script:icaclsCalls.Count -eq 0 -and
    (@(Compare-Object $posixBefore $posixAfter -SyncWindow 0)).Count -eq 0
  )

  if (-not $isWindowsHost) {
    Skip 'injected-icacls happy path (Windows only)'
    Skip 'injected-icacls argument vector (Windows only)'
    Skip 'apply failure never attests (Windows only)'
    Skip 'verify failure never attests and retracts a stale attestation (Windows only)'
    Skip 'unknown service account fails closed before icacls (Windows only)'
    Skip 'malformed artifact root fails closed (Windows only)'
    Skip 'real icacls apply + verify + attest (Windows only)'
    Skip 'real icacls run is idempotent (Windows only)'
    Skip 'tampered real ACL retracts the attestation (Windows only)'
  }
  else {
    $account = & $realResolveAccount
    $accountSid = if ($account.Ok) { $account.Sid } else { '' }

    # ── Layer 2: injected icacls / ACL facts ────────────────────────────────────
    Reset-Fakes
    $script:icaclsMode = 'fake'
    $script:factsMode = 'fake'
    $happy = New-Fixture
    $happyResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $happy.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    Check 'injected-icacls happy path applies, verifies and attests' (
      $happyResult.Applicable -and
      $happyResult.Applied -eq 'YES' -and
      $happyResult.Verified -eq 'PASS' -and
      $happyResult.Attested -eq 'YES' -and
      $happyResult.Reason -eq 'none' -and
      $happyResult.Ok -and
      (Test-Path -LiteralPath $happy.ArtifactRoot -PathType Container) -and
      (Get-EnvValue -EnvFile $happy.EnvFile -Name $ATTEST_KEY) -eq 'true' -and
      (Get-EnvValue -EnvFile $happy.EnvFile -Name 'JWT_SECRET') -eq 'fixture-secret' -and
      $env:MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED -eq 'true'
    )
    $happyArgs = @($script:icaclsCalls[0])
    Check 'injected-icacls argument vector is the specified hardening command' (
      $script:icaclsCalls.Count -eq 1 -and
      $happyArgs[0] -eq $happy.ArtifactRoot -and
      $happyArgs[1] -eq '/inheritance:r' -and
      $happyArgs[2] -eq '/grant:r' -and
      ($happyArgs -contains '*S-1-5-18:(OI)(CI)F') -and
      ($happyArgs -contains ('*' + $accountSid + ':(OI)(CI)F')) -and
      (@($happyArgs | Where-Object { $_ -match '^\*S-1-5-32-545|^\*S-1-5-11|^\*S-1-1-0' }).Count -eq 0)
    )
    Check 'emitted lines carry no path, no SID and no account name' (
      Test-LinesValuesFree -Lines $happyResult.Lines -Secrets @(
        $happy.ArtifactRoot, $happy.EnvFile, $accountSid, $env:USERNAME
      )
    )

    # Idempotent: the same run again must leave the env file byte-identical.
    $happyBytes = [System.IO.File]::ReadAllBytes($happy.EnvFile)
    $script:icaclsCalls = @()
    $happyAgain = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $happy.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    Check 'injected-icacls re-run is idempotent (env file unchanged, same verdict)' (
      $happyAgain.Attested -eq 'YES' -and
      $happyAgain.Reason -eq 'none' -and
      (@(Compare-Object $happyBytes ([System.IO.File]::ReadAllBytes($happy.EnvFile)) -SyncWindow 0)).Count -eq 0
    )

    Reset-Fakes
    $script:icaclsMode = 'fake'
    $script:fakeIcaclsExit = 5
    $script:factsMode = 'fake'
    $applyFail = New-Fixture -PreExistingAttestation 'true'
    $applyFailResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $applyFail.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    Check 'a failed icacls apply never attests and retracts a stale attestation' (
      $applyFailResult.Applicable -and
      $applyFailResult.Applied -eq 'NO' -and
      $applyFailResult.Verified -eq 'SKIP' -and
      $applyFailResult.Attested -eq 'NO' -and
      $applyFailResult.Reason -eq 'S6A_ARTIFACT_ROOT_ACL_APPLY_FAILED' -and
      (-not $applyFailResult.Ok) -and
      (Get-EnvValue -EnvFile $applyFail.EnvFile -Name $ATTEST_KEY) -eq '' -and
      (Get-EnvValue -EnvFile $applyFail.EnvFile -Name 'JWT_SECRET') -eq 'fixture-secret' -and
      (-not (Test-Path Env:MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED))
    )

    Reset-Fakes
    $script:icaclsMode = 'fake'
    $script:factsMode = 'fake'
    $script:fakeFactsOk = $false
    $verifyFail = New-Fixture -PreExistingAttestation 'true'
    $verifyFailResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $verifyFail.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    Check 'a failed verify never attests and retracts a stale attestation' (
      $verifyFailResult.Applied -eq 'YES' -and
      $verifyFailResult.Verified -eq 'FAIL' -and
      $verifyFailResult.Attested -eq 'NO' -and
      $verifyFailResult.Reason -eq 'S6A_ARTIFACT_ROOT_ACL_VERIFY_FAILED' -and
      (-not $verifyFailResult.Ok) -and
      (Get-EnvValue -EnvFile $verifyFail.EnvFile -Name $ATTEST_KEY) -eq '' -and
      (Get-EnvValue -EnvFile $verifyFail.EnvFile -Name 'DATABASE_URL') -eq 'postgres://fixture/db'
    )

    Reset-Fakes
    $script:icaclsMode = 'fake'
    $script:factsMode = 'fake'
    $script:accountMode = 'fake'
    $noAccount = New-Fixture
    $noAccountResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $noAccount.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    Check 'an underivable service account fails closed BEFORE icacls runs' (
      $noAccountResult.Applied -eq 'NO' -and
      $noAccountResult.Attested -eq 'NO' -and
      $noAccountResult.Reason -eq 'S6A_ARTIFACT_ROOT_ACL_SERVICE_ACCOUNT_UNKNOWN' -and
      (-not $noAccountResult.Ok) -and
      $script:icaclsCalls.Count -eq 0 -and
      (Get-EnvValue -EnvFile $noAccount.EnvFile -Name $ATTEST_KEY) -eq ''
    )

    Reset-Fakes
    $script:icaclsMode = 'fake'
    $script:factsMode = 'fake'
    $relative = New-Fixture -ArtifactRoot 'artifacts\sealed'
    $relativeResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $relative.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    $unset = New-Fixture -OmitArtifactRoot
    $unsetResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $unset.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    Check 'a relative or missing artifact root fails closed with its own token' (
      $relativeResult.Reason -eq 'S6A_ARTIFACT_ROOT_NOT_ABSOLUTE' -and
      (-not $relativeResult.Ok) -and $relativeResult.Attested -eq 'NO' -and
      $unsetResult.Reason -eq 'S6A_ARTIFACT_ROOT_UNSET' -and
      (-not $unsetResult.Ok) -and $unsetResult.Attested -eq 'NO' -and
      $script:icaclsCalls.Count -eq 0
    )

    # ── Layer 3: REAL icacls against a throwaway directory under TEMP ───────────
    Reset-Fakes
    $real = New-Fixture
    $realResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $real.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    $realAcl = if (Test-Path -LiteralPath $real.ArtifactRoot) { Get-Acl -LiteralPath $real.ArtifactRoot } else { $null }
    $realSids = if ($null -ne $realAcl) {
      @($realAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
        ForEach-Object { [string]$_.IdentityReference.Value })
    } else { @() }
    Check 'real icacls apply + Get-Acl verify + attestation write' (
      $realResult.Applied -eq 'YES' -and
      $realResult.Verified -eq 'PASS' -and
      $realResult.Attested -eq 'YES' -and
      $realResult.Reason -eq 'none' -and
      $realResult.Ok -and
      (Get-EnvValue -EnvFile $real.EnvFile -Name $ATTEST_KEY) -eq 'true'
    )
    Check 'the real ACL has inheritance disabled and no Users/Authenticated Users/Everyone ACE' (
      $null -ne $realAcl -and
      $realAcl.AreAccessRulesProtected -and
      $realSids.Count -ge 2 -and
      ($realSids -contains 'S-1-5-18') -and
      ($realSids -contains $accountSid) -and
      (@($realSids | Where-Object { @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546') -contains $_ }).Count -eq 0)
    )

    $realBytes = [System.IO.File]::ReadAllBytes($real.EnvFile)
    $realAgain = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $real.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    $realAclAgain = Get-Acl -LiteralPath $real.ArtifactRoot
    Check 'real re-run is idempotent (same verdict, same ACL, byte-identical env file)' (
      $realAgain.Verified -eq 'PASS' -and
      $realAgain.Attested -eq 'YES' -and
      (@(Compare-Object $realBytes ([System.IO.File]::ReadAllBytes($real.EnvFile)) -SyncWindow 0)).Count -eq 0 -and
      $realAclAgain.Sddl -eq $realAcl.Sddl
    )

    # Tamper with the real ACL: an explicit Everyone grant survives /grant:r, so the
    # verify must fail and the attestation written a moment ago must be retracted.
    $tamper = & $realInvokeIcacls -Arguments @($real.ArtifactRoot, '/grant', '*S-1-1-0:(OI)(CI)F')
    $tamperResult = Invoke-S6aArtifactRootAclAttestation `
      -EnvFile $real.EnvFile -AttestationMode 'auto' -PlatformIsWindows $true
    Check 'a tampered real ACL fails verify and retracts the attestation' (
      $tamper.ExitCode -eq 0 -and
      $tamperResult.Applied -eq 'YES' -and
      $tamperResult.Verified -eq 'FAIL' -and
      $tamperResult.Attested -eq 'NO' -and
      $tamperResult.Reason -eq 'S6A_ARTIFACT_ROOT_ACL_VERIFY_FAILED' -and
      (-not $tamperResult.Ok) -and
      (Get-EnvValue -EnvFile $real.EnvFile -Name $ATTEST_KEY) -eq ''
    )
  }
}
finally {
  Remove-Item Env:MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $sandbox) {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($fail -gt 0) {
  Write-Host "FAILED: $fail check(s); $pass passed; $skip skipped"
  exit 1
}
Write-Host "ALL S6-A ARTIFACT-ROOT ACL CHECKS PASS ($pass checks; $skip skipped)"
exit 0
