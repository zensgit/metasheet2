#requires -Version 5.1
<#
.SYNOPSIS
  No-Git, fail-safe RC-A C-stage runner for #4437.
.DESCRIPTION
  Runs one controlled OFF -> ON -> exact-SHA extended smoke -> physical readback -> OFF window.
  It never patches or redeploys the product package. It verifies and privately copies the frozen
  d87e086fd smoke helpers, runs the smoke at most once, and restores the flag in a finally path.
  Only a fixed values-free result block is emitted.
#>
[CmdletBinding()]
param(
  [string]$SidecarDir = $PSScriptRoot,
  [string]$BaseUrl = 'http://127.0.0.1:8900',
  [string]$TenantId,
  [string]$WorkspaceId,
  [switch]$ApprovedConfigPreflightPassed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:FlagName = 'MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED'
$script:AuthCarrier = 'METASHEET_AUTH_TOKEN'
$script:AdminCarrier = 'METASHEET_ADMIN_TOKEN'
$script:ConfigCarrier = 'METASHEET_APPROVED_SOURCE_CONFIG_ID'
$script:ProjectPrefix = 'stockprep-t4'
$script:StableOnlineSeconds = 12
$script:PreparedHelperDir = $null
$script:PreparedExtendedHelper = $null
$script:PreparedPm2Helper = $null
$script:WindowLock = $null
$script:WindowLockPath = $null
$script:SmokeInvocationCount = 0
$script:Sleep = { param([int]$Seconds) Start-Sleep -Seconds $Seconds }
$script:Pm2EnvironmentAllowlist = @(
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG',
  'LC_ALL', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PM2_HOME',
  'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'USERPROFILE',
  'WINDIR', $script:FlagName
)

$script:FrozenHelperSha256 = [ordered]@{
  'stock-preparation-prep-line-extended-smoke.mjs' = '912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049'
  'stock-preparation-mvp-postdeploy-smoke.mjs' = 'e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4'
  'stock-preparation-rca-window-pm2-sample.mjs' = '09cc76024bd98fd4ce86cfa834eea3b94680482d0d0970600da008a19a6731ec'
}

$script:ResultVocabulary = [ordered]@{
  executionState = @('COMPLETE', 'BLOCKED')
  clientContentVerified = @('PASS', 'FAIL')
  approvedSourceInitial = @('PASS', 'FAIL', 'NOT_RUN')
  approvedSourceReplay = @('PASS', 'FAIL', 'NOT_RUN')
  approvedSourceInternalRowsNonEmpty = @('PASS', 'FAIL', 'NOT_RUN')
  t4ExtendedChain = @('PASS', 'FAIL', 'NOT_RUN')
  selfScanClean = @('PASS', 'FAIL', 'NOT_RUN')
  externalWrite = @('false', 'true', 'UNAVAILABLE')
  tokenScrubbed = @('PASS', 'FAIL')
  tokenRevoked = @('PASS', 'FAIL', 'NOT_RUN')
  flagRestoredOff = @('PASS', 'FAIL')
  postRestorePm2StableOnline = @('PASS', 'FAIL')
  postRestoreHealth = @('PASS', 'FAIL')
  postRestoreCredentialHygiene = @('PASS', 'FAIL')
  overallAcceptance = @('PASS', 'FAIL')
  failedStage = @(
    'NONE', 'PRECONDITION', 'HELPER_VERIFY', 'PM2_ENABLE', 'HEALTH_ENABLE',
    'SMOKE', 'PHYSICAL_READ', 'FLAG_RESTORE', 'PM2_RESTORE', 'HEALTH_RESTORE',
    'TOKEN_REVOKE', 'INTERNAL'
  )
  failureReason = @(
    'NONE', 'INPUT_INVALID', 'CONFIG_PREFLIGHT_REQUIRED', 'TOKEN_MISSING', 'CONFIG_MISSING',
    'MULTIPLE_TOKEN_CARRIERS', 'WINDOW_ALREADY_RUNNING', 'HELPER_MISSING',
    'HELPER_REPARSE_POINT', 'HELPER_DIGEST_MISMATCH', 'PM2_SAMPLE_INVALID',
    'PM2_NOT_ONLINE', 'PM2_FLAG_NOT_OFF', 'PM2_RESTART_FAILED', 'PM2_UNSTABLE',
    'PM2_FLAG_MISMATCH', 'PM2_TOKEN_PRESENT', 'HEALTH_FAILED', 'SMOKE_ALREADY_INVOKED',
    'SMOKE_EXIT_NONZERO', 'SMOKE_CONTRACT_INVALID', 'PHYSICAL_READ_FAILED',
    'FLAG_RESTORE_FAILED', 'TOKEN_LOGOUT_FAILED', 'UNEXPECTED'
  )
}

function New-RcaResult {
  return [ordered]@{
    executionState = 'BLOCKED'
    clientContentVerified = 'FAIL'
    approvedSourceInitial = 'NOT_RUN'
    approvedSourceReplay = 'NOT_RUN'
    approvedSourceInternalRowsNonEmpty = 'NOT_RUN'
    t4ExtendedChain = 'NOT_RUN'
    selfScanClean = 'NOT_RUN'
    externalWrite = 'UNAVAILABLE'
    tokenScrubbed = 'FAIL'
    tokenRevoked = 'NOT_RUN'
    flagRestoredOff = 'FAIL'
    postRestorePm2StableOnline = 'FAIL'
    postRestoreHealth = 'FAIL'
    postRestoreCredentialHygiene = 'FAIL'
    overallAcceptance = 'FAIL'
    failedStage = 'NONE'
    failureReason = 'NONE'
  }
}

function Set-RcaFailure {
  param([System.Collections.IDictionary]$Result, [string]$Stage, [string]$Reason, [switch]$SafetyCritical)
  if ($SafetyCritical -or $Result.failedStage -eq 'NONE') {
    $Result.failedStage = $Stage
    $Result.failureReason = $Reason
  }
  $Result.executionState = 'BLOCKED'
  $Result.overallAcceptance = 'FAIL'
}

function Stop-RcaStage {
  param([System.Collections.IDictionary]$Result, [string]$Stage, [string]$Reason)
  Set-RcaFailure -Result $Result -Stage $Stage -Reason $Reason
  throw 'RCA_WINDOW_STOP'
}

function Test-RcaResultVocabulary {
  param([System.Collections.IDictionary]$Result)
  if ($Result.Count -ne $script:ResultVocabulary.Count) { return $false }
  foreach ($key in $script:ResultVocabulary.Keys) {
    if (-not $Result.Contains($key)) { return $false }
    if ($script:ResultVocabulary[$key] -notcontains "$($Result[$key])") { return $false }
  }
  return $true
}

function Format-RcaResultBlock {
  param([System.Collections.IDictionary]$Result)
  if (-not (Test-RcaResultVocabulary $Result)) {
    $Result = New-RcaResult
    $Result.failedStage = 'INTERNAL'
    $Result.failureReason = 'UNEXPECTED'
  }
  $lines = @('STOCK_PREPARATION_RCA_WINDOW')
  foreach ($key in $script:ResultVocabulary.Keys) { $lines += "$key=$($Result[$key])" }
  return ($lines -join [Environment]::NewLine)
}

function Get-Sha256Hex {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-IsReparsePoint {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force
  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Enter-RcaWindowLock {
  $path = Join-Path ([System.IO.Path]::GetTempPath()) 'metasheet-stock-preparation-rca-window.lock'
  try {
    $script:WindowLock = [System.IO.File]::Open(
      $path,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    $script:WindowLockPath = $path
    return $true
  } catch {
    return $false
  }
}

function Exit-RcaWindowLock {
  if ($script:WindowLock) { $script:WindowLock.Dispose(); $script:WindowLock = $null }
  # Keep the empty lock inode stable. Deleting it after dispose permits two processes to lock
  # different inodes on platforms where an open file can be unlinked.
  $script:WindowLockPath = $null
}

function Prepare-FrozenHelpers {
  param([string]$Root)
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("metasheet_rca_window_" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  try {
    foreach ($name in $script:FrozenHelperSha256.Keys) {
      $source = Join-Path $Root $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'HELPER_MISSING' }
      if (Test-IsReparsePoint $source) { throw 'HELPER_REPARSE_POINT' }
      $destination = Join-Path $temp $name
      [System.IO.File]::Copy($source, $destination, $false)
      if ((Get-Sha256Hex $destination) -ne $script:FrozenHelperSha256[$name]) {
        throw 'HELPER_DIGEST_MISMATCH'
      }
    }
    $script:PreparedHelperDir = $temp
    $script:PreparedExtendedHelper = Join-Path $temp 'stock-preparation-prep-line-extended-smoke.mjs'
    $script:PreparedPm2Helper = Join-Path $temp 'stock-preparation-rca-window-pm2-sample.mjs'
    return $true
  } catch {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Remove-PreparedHelpers {
  if ($script:PreparedHelperDir) {
    Remove-Item -LiteralPath $script:PreparedHelperDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $script:PreparedHelperDir = $null
  $script:PreparedExtendedHelper = $null
  $script:PreparedPm2Helper = $null
}

function Remove-TokenCarriers {
  Remove-Item "Env:$($script:AuthCarrier)" -ErrorAction SilentlyContinue
  Remove-Item "Env:$($script:AdminCarrier)" -ErrorAction SilentlyContinue
}

function Test-TokenCarriersEmpty {
  return (
    -not [Environment]::GetEnvironmentVariable($script:AuthCarrier) -and
    -not [Environment]::GetEnvironmentVariable($script:AdminCarrier)
  )
}

function Read-EntrySecrets {
  param([System.Collections.IDictionary]$Result)
  $authValue = [Environment]::GetEnvironmentVariable($script:AuthCarrier)
  $adminValue = [Environment]::GetEnvironmentVariable($script:AdminCarrier)
  $configValue = [Environment]::GetEnvironmentVariable($script:ConfigCarrier)
  Remove-TokenCarriers
  Remove-Item "Env:$($script:ConfigCarrier)" -ErrorAction SilentlyContinue
  if ($authValue -and $adminValue) {
    Stop-RcaStage -Result $Result -Stage 'PRECONDITION' -Reason 'MULTIPLE_TOKEN_CARRIERS'
  }
  $token = if ($authValue) { ConvertTo-SecureString $authValue -AsPlainText -Force } else { $null }
  $config = if ($configValue) { ConvertTo-SecureString $configValue -AsPlainText -Force } else { $null }
  $authValue = $null
  $adminValue = $null
  $configValue = $null
  return @{ token = $token; config = $config }
}

function Suspend-UnsafePm2Environment {
  $snapshot = @()
  foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $name = [string]$entry.Key
    if ($script:Pm2EnvironmentAllowlist -contains $name) { continue }
    $snapshot += [pscustomobject]@{ name = $name; value = [string]$entry.Value }
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  return $snapshot
}

function Restore-Pm2Environment {
  param([object[]]$Snapshot)
  foreach ($entry in @($Snapshot)) {
    [Environment]::SetEnvironmentVariable([string]$entry.name, [string]$entry.value, 'Process')
  }
}

function Invoke-Pm2NativeCapture {
  param([string[]]$Arguments)
  $oldPreference = $ErrorActionPreference
  $output = @()
  $exitCode = 1
  $environmentSnapshot = @()
  try {
    # Windows PowerShell 5.1 can promote native stderr to a terminating NativeCommandError even
    # when stderr is redirected. Scope Continue around only the native boundary and preserve exit.
    # PM2 --update-env snapshots its caller environment into the app, so every PM2 invocation also
    # runs under a fixed minimum environment and restores the operator process immediately after.
    $environmentSnapshot = @(Suspend-UnsafePm2Environment)
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = 0
    $output = @(& pm2 @Arguments 2>$null)
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } catch {
    $output = @()
    $exitCode = 1
  } finally {
    $ErrorActionPreference = $oldPreference
    try { Restore-Pm2Environment -Snapshot $environmentSnapshot } catch { $exitCode = 1 }
  }
  return @{ stdout = $output; exit = $exitCode }
}

function Invoke-Pm2Projection {
  param([object[]]$InputLines)
  $oldPreference = $ErrorActionPreference
  $output = @()
  $exitCode = 1
  try {
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = 0
    $output = @(@($InputLines) | & node $script:PreparedPm2Helper 2>$null)
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } catch {
    $output = @()
    $exitCode = 1
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  return @{ stdout = $output; exit = $exitCode }
}

function Get-Pm2Sample {
  if (-not $script:PreparedPm2Helper -or -not (Test-Path -LiteralPath $script:PreparedPm2Helper -PathType Leaf)) {
    return $null
  }
  $pm2Result = Invoke-Pm2NativeCapture -Arguments @('jlist')
  if ($pm2Result.exit -ne 0 -or @($pm2Result.stdout).Count -eq 0) { return $null }
  $projection = Invoke-Pm2Projection -InputLines @($pm2Result.stdout)
  $safeJson = $projection.stdout
  if ($projection.exit -ne 0 -or @($safeJson).Count -eq 0) { return $null }
  try {
    $entry = $safeJson | ConvertFrom-Json
    foreach ($name in @('authTokenNonEmpty', 'adminTokenNonEmpty', 'plmAutoPersistEnabledTrue')) {
      $property = $entry.PSObject.Properties[$name]
      if (-not $property -or -not ($property.Value -is [bool])) { return $null }
    }
    return [pscustomobject]@{
      state = "$($entry.state)"
      restartTime = [long]$entry.restartTime
      uptime = [long]$entry.uptime
      authTokenNonEmpty = [bool]$entry.authTokenNonEmpty
      adminTokenNonEmpty = [bool]$entry.adminTokenNonEmpty
      plmAutoPersistEnabledTrue = [bool]$entry.plmAutoPersistEnabledTrue
    }
  } catch {
    return $null
  }
}

function Test-Pm2Sample {
  param($Sample, [bool]$ExpectedFlagTrue, $Baseline)
  if (-not $Sample) { return @{ ok = $false; reason = 'PM2_SAMPLE_INVALID' } }
  if ($Sample.state -ne 'online') { return @{ ok = $false; reason = 'PM2_NOT_ONLINE' } }
  if ($Sample.authTokenNonEmpty -or $Sample.adminTokenNonEmpty) {
    return @{ ok = $false; reason = 'PM2_TOKEN_PRESENT' }
  }
  if ([bool]$Sample.plmAutoPersistEnabledTrue -ne $ExpectedFlagTrue) {
    return @{ ok = $false; reason = 'PM2_FLAG_MISMATCH' }
  }
  if ($Baseline) {
    if ([long]$Sample.restartTime -gt [long]$Baseline.restartTime) {
      return @{ ok = $false; reason = 'PM2_UNSTABLE' }
    }
    if ([long]$Sample.uptime -gt [long]$Baseline.uptime) {
      return @{ ok = $false; reason = 'PM2_UNSTABLE' }
    }
  }
  return @{ ok = $true; reason = 'NONE' }
}

function Invoke-Pm2RestartStable {
  param([bool]$ExpectedFlagTrue)
  if (-not (Test-TokenCarriersEmpty)) { return @{ ok = $false; reason = 'PM2_TOKEN_PRESENT' } }
  # --update-env imports only the fixed allowlisted environment established by the native boundary;
  # arbitrary operator-shell variables are restored to this process after PM2 exits, never persisted.
  $restart = Invoke-Pm2NativeCapture -Arguments @('restart', 'metasheet-backend', '--update-env')
  if ($restart.exit -ne 0) { return @{ ok = $false; reason = 'PM2_RESTART_FAILED' } }
  & $script:Sleep 1
  $baseline = Get-Pm2Sample
  $first = Test-Pm2Sample -Sample $baseline -ExpectedFlagTrue $ExpectedFlagTrue -Baseline $null
  if (-not $first.ok) { return $first }
  $deadline = [DateTime]::UtcNow.AddSeconds($script:StableOnlineSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $sample = Get-Pm2Sample
    $verdict = Test-Pm2Sample -Sample $sample -ExpectedFlagTrue $ExpectedFlagTrue -Baseline $baseline
    if (-not $verdict.ok) { return $verdict }
    & $script:Sleep 2
  }
  return @{ ok = $true; reason = 'NONE' }
}

function Invoke-HealthCheck {
  param([string]$Origin)
  $oldProtocol = [System.Net.ServicePointManager]::SecurityProtocol
  try {
    [System.Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    $response = Invoke-WebRequest -Uri "$Origin/api/health" -UseBasicParsing -TimeoutSec 15
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  } finally {
    [System.Net.ServicePointManager]::SecurityProtocol = $oldProtocol
  }
}

function Invoke-SmokeCapture {
  param(
    [SecureString]$Token,
    [SecureString]$ConfigReference,
    [string]$Origin,
    [string]$Tenant,
    [string]$Workspace
  )
  if ($script:SmokeInvocationCount -ne 0) {
    return @{ stdout = ''; exit = 2; reason = 'SMOKE_ALREADY_INVOKED' }
  }
  $script:SmokeInvocationCount++
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
  $configBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ConfigReference)
  $oldPreference = $ErrorActionPreference
  try {
    $env:METASHEET_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
    $configPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($configBstr)
    $args = @(
      $script:PreparedExtendedHelper,
      '--base-url', $Origin,
      '--tenant-id', $Tenant,
      '--project-prefix', $script:ProjectPrefix,
      '--timeout-ms', '15000',
      '--approved-source-config-id', $configPlain
    )
    if ($Workspace) { $args += @('--workspace-id', $Workspace) }
    try {
      $ErrorActionPreference = 'Continue'
      $out = & node @args 2>$null
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $oldPreference
    }
    return @{ stdout = ($out | Out-String); exit = $exitCode; reason = 'NONE' }
  } finally {
    $configPlain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($configBstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
    Remove-TokenCarriers
  }
}

function Get-SmokeFieldMap {
  param([string]$Text)
  $required = @(
    'salt', 'approvedSourceHttp', 'approvedSourceMode', 'approvedSourceCreated',
    'approvedSourceReplayHttp', 'approvedSourceReplayMode', 'auditActionsCovered',
    'leakScanClean', 'selfScanClean', 'externalWrite', 'run2Ready', 'prepLines2RowCount', 'pass'
  )
  $map = @{}
  $headerCount = 0
  foreach ($line in ($Text -split '[\r\n]+')) {
    if ($line -eq 'STOCK_PREPARATION_PREP_LINE_EXTENDED_SMOKE') { $headerCount++; continue }
    if ($line -notmatch '^([A-Za-z][A-Za-z0-9.]*)=(.*)$') { continue }
    $key = $Matches[1]
    if ($required -notcontains $key) { continue }
    if ($map.ContainsKey($key)) { return $null }
    $map[$key] = $Matches[2]
  }
  if ($headerCount -ne 1) { return $null }
  foreach ($key in $required) { if (-not $map.ContainsKey($key)) { return $null } }
  return $map
}

function Apply-SmokeVerdict {
  param([System.Collections.IDictionary]$Result, [hashtable]$Fields, [int]$ExitCode)
  if (-not $Fields) { return $false }
  $initial = (
    $Fields.approvedSourceHttp -eq '201' -and
    $Fields.approvedSourceMode -eq 'internal_persist' -and
    $Fields.approvedSourceCreated -match '^batch:1\|lines:[1-9][0-9]*\|run:1$'
  )
  $replay = (
    $Fields.approvedSourceReplayHttp -eq '200' -and
    $Fields.approvedSourceReplayMode -eq 'internal_noop'
  )
  $selfScan = ($Fields.selfScanClean -eq 'true' -and $Fields.leakScanClean -eq 'true')
  $chain = (
    $ExitCode -eq 0 -and $Fields.pass -eq 'true' -and $Fields.run2Ready -eq 'true' -and
    $Fields.prepLines2RowCount -match '^[1-9][0-9]*$' -and
    $Fields.auditActionsCovered -eq '8/8'
  )
  $Result.approvedSourceInitial = if ($initial) { 'PASS' } else { 'FAIL' }
  $Result.approvedSourceReplay = if ($replay) { 'PASS' } else { 'FAIL' }
  $Result.selfScanClean = if ($selfScan) { 'PASS' } else { 'FAIL' }
  $Result.t4ExtendedChain = if ($chain) { 'PASS' } else { 'FAIL' }
  $Result.externalWrite = if ($Fields.externalWrite -eq 'false') { 'false' } elseif ($Fields.externalWrite -eq 'true') { 'true' } else { 'UNAVAILABLE' }
  return ($initial -and $replay -and $selfScan -and $chain -and $Result.externalWrite -eq 'false')
}

function Get-ObjectProperty {
  param($Object, [string]$Name)
  if (-not $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if (-not $property) { return $null }
  return $property.Value
}

function Test-JsonIntegerAtLeast {
  param($Value, [long]$Minimum)
  if (-not ($Value -is [int] -or $Value -is [long])) { return $false }
  return ([long]$Value -ge $Minimum)
}

function Test-JsonBoolean {
  param($Value, [bool]$Expected)
  return ($Value -is [bool] -and [bool]$Value -eq $Expected)
}

function Invoke-AuthenticatedJsonGet {
  param([string]$Uri, [string]$TokenPlain, [string]$Tenant)
  $headers = @{ Accept = 'application/json'; Authorization = "Bearer $TokenPlain" }
  if ($Tenant) { $headers['x-tenant-id'] = $Tenant }
  try {
    $response = Invoke-WebRequest -Uri $Uri -Headers $headers -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 0
    if ($response.StatusCode -ne 200) { return $null }
    return ($response.Content | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Invoke-PhysicalReadback {
  param(
    [SecureString]$Token,
    [string]$Origin,
    [string]$Tenant,
    [string]$Workspace,
    [string]$Salt
  )
  if ($Salt -notmatch '^t[1-9][0-9]{8,15}$') { return $false }
  $projectId = "$($script:ProjectPrefix)-approved-$Salt"
  $batchId = "smoke_t4_approved_batch_$Salt"
  $runId = "smoke_t4_approved_syncrun_$Salt"
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
  try {
    $tokenPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
    $projectQuery = if ($Workspace) { "?workspaceId=$([uri]::EscapeDataString($Workspace))" } else { '' }
    $projectsEnvelope = Invoke-AuthenticatedJsonGet -Uri "$Origin/api/integration/stock-preparation/projects$projectQuery" -TokenPlain $tokenPlain -Tenant $Tenant
    if (-not (Test-JsonBoolean (Get-ObjectProperty $projectsEnvelope 'success') $true)) { return $false }
    $projectsData = Get-ObjectProperty $projectsEnvelope 'data'
    $projects = @(Get-ObjectProperty $projectsData 'projects')
    $projectMatches = @($projects | Where-Object { (Get-ObjectProperty $_ 'projectId') -eq $projectId })
    if ($projectMatches.Count -ne 1) { return $false }
    if (-not (Test-JsonIntegerAtLeast (Get-ObjectProperty $projectMatches[0] 'snapshotBatchCount') 1)) { return $false }

    $queryParts = @("projectId=$([uri]::EscapeDataString($projectId))")
    if ($Workspace) { $queryParts += "workspaceId=$([uri]::EscapeDataString($Workspace))" }
    $batchesEnvelope = Invoke-AuthenticatedJsonGet -Uri "$Origin/api/integration/stock-preparation/snapshot-batches?$($queryParts -join '&')" -TokenPlain $tokenPlain -Tenant $Tenant
    if (-not (Test-JsonBoolean (Get-ObjectProperty $batchesEnvelope 'success') $true)) { return $false }
    $batchesData = Get-ObjectProperty $batchesEnvelope 'data'
    if (-not (Test-JsonIntegerAtLeast (Get-ObjectProperty $batchesData 'batchCount') 1)) { return $false }
    $batches = @(Get-ObjectProperty $batchesData 'batches')
    $batchMatches = @($batches | Where-Object { (Get-ObjectProperty $_ 'snapshotBatchId') -eq $batchId })
    if ($batchMatches.Count -ne 1) { return $false }
    $batch = $batchMatches[0]
    return (
      (Get-ObjectProperty $batch 'syncRunId') -eq $runId -and
      (Test-JsonIntegerAtLeast (Get-ObjectProperty $batch 'lineCount') 1) -and
      (Test-JsonBoolean (Get-ObjectProperty $batch 'incomplete') $false)
    )
  } finally {
    $tokenPlain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
  }
}

function Invoke-TokenLogout {
  param([SecureString]$Token, [string]$Origin)
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
  try {
    $tokenPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
    $headers = @{ Accept = 'application/json'; Authorization = "Bearer $tokenPlain" }
    $response = Invoke-WebRequest -Uri "$Origin/api/auth/logout" -Method Post -Headers $headers -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 0
    if ($response.StatusCode -ne 200) { return $false }
    $body = $response.Content | ConvertFrom-Json
    return (Test-JsonBoolean (Get-ObjectProperty $body 'success') $true)
  } catch {
    return $false
  } finally {
    $tokenPlain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
  }
}

function Test-InputContract {
  param([string]$Origin, [string]$Tenant)
  if (-not $Tenant) { return $false }
  try {
    $uri = [uri]$Origin
    if (-not $uri.IsAbsoluteUri) { return $false }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return $false }
    if (-not $uri.IsLoopback) { return $false }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { return $false }
    if ($uri.AbsolutePath -ne '/') { return $false }
    return $true
  } catch {
    return $false
  }
}

function Invoke-RcaWindow {
  param(
    [string]$Root,
    [string]$Origin,
    [string]$Tenant,
    [string]$Workspace,
    [bool]$ConfigPreflightPassed,
    [SecureString]$ProvidedToken,
    [SecureString]$ProvidedConfig
  )
  $result = New-RcaResult
  $token = $ProvidedToken
  $config = $ProvidedConfig
  $restoreRequired = $false
  $tokenUsed = $false
  $preflightSample = $null
  $script:SmokeInvocationCount = 0
  Remove-Item "Env:$($script:FlagName)" -ErrorAction SilentlyContinue
  Remove-TokenCarriers

  try {
    if (-not $ConfigPreflightPassed) { Stop-RcaStage $result 'PRECONDITION' 'CONFIG_PREFLIGHT_REQUIRED' }
    if (-not (Test-InputContract -Origin $Origin -Tenant $Tenant)) { Stop-RcaStage $result 'PRECONDITION' 'INPUT_INVALID' }
    if (-not $token) { Stop-RcaStage $result 'PRECONDITION' 'TOKEN_MISSING' }
    if (-not $config) { Stop-RcaStage $result 'PRECONDITION' 'CONFIG_MISSING' }
    if (-not (Enter-RcaWindowLock)) { Stop-RcaStage $result 'PRECONDITION' 'WINDOW_ALREADY_RUNNING' }

    try {
      Prepare-FrozenHelpers -Root $Root | Out-Null
      $result.clientContentVerified = 'PASS'
    } catch {
      $reason = "$($_.Exception.Message)"
      if ($script:ResultVocabulary.failureReason -notcontains $reason) { $reason = 'HELPER_DIGEST_MISMATCH' }
      Stop-RcaStage $result 'HELPER_VERIFY' $reason
    }

    $preflightSample = Get-Pm2Sample
    if (-not $preflightSample) { Stop-RcaStage $result 'PRECONDITION' 'PM2_SAMPLE_INVALID' }
    if ($preflightSample.state -ne 'online') { Stop-RcaStage $result 'PRECONDITION' 'PM2_NOT_ONLINE' }
    if ($preflightSample.authTokenNonEmpty -or $preflightSample.adminTokenNonEmpty) {
      Stop-RcaStage $result 'PRECONDITION' 'PM2_TOKEN_PRESENT'
    }
    if ($preflightSample.plmAutoPersistEnabledTrue) {
      $restoreRequired = $true
      Stop-RcaStage $result 'PRECONDITION' 'PM2_FLAG_NOT_OFF'
    }
    if (-not (Invoke-HealthCheck $Origin)) { Stop-RcaStage $result 'PRECONDITION' 'HEALTH_FAILED' }

    $env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED = 'true'
    $restoreRequired = $true
    $enabled = Invoke-Pm2RestartStable -ExpectedFlagTrue $true
    if (-not $enabled.ok) { Stop-RcaStage $result 'PM2_ENABLE' $enabled.reason }
    if (-not (Invoke-HealthCheck $Origin)) { Stop-RcaStage $result 'HEALTH_ENABLE' 'HEALTH_FAILED' }

    $tokenUsed = $true
    $captured = Invoke-SmokeCapture -Token $token -ConfigReference $config -Origin $Origin -Tenant $Tenant -Workspace $Workspace
    if ($captured.reason -eq 'SMOKE_ALREADY_INVOKED') { Stop-RcaStage $result 'SMOKE' 'SMOKE_ALREADY_INVOKED' }
    $fields = Get-SmokeFieldMap $captured.stdout
    $smokeOk = Apply-SmokeVerdict -Result $result -Fields $fields -ExitCode $captured.exit
    if ($captured.exit -ne 0) { Stop-RcaStage $result 'SMOKE' 'SMOKE_EXIT_NONZERO' }
    if (-not $smokeOk) { Stop-RcaStage $result 'SMOKE' 'SMOKE_CONTRACT_INVALID' }

    $readbackOk = Invoke-PhysicalReadback -Token $token -Origin $Origin -Tenant $Tenant -Workspace $Workspace -Salt $fields.salt
    $result.approvedSourceInternalRowsNonEmpty = if ($readbackOk) { 'PASS' } else { 'FAIL' }
    if (-not $readbackOk) { Stop-RcaStage $result 'PHYSICAL_READ' 'PHYSICAL_READ_FAILED' }
  } catch {
    if ($_.Exception.Message -ne 'RCA_WINDOW_STOP' -and $result.failedStage -eq 'NONE') {
      Set-RcaFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
    }
  } finally {
    try {
      Remove-TokenCarriers
      $result.tokenScrubbed = if (Test-TokenCarriersEmpty) { 'PASS' } else { 'FAIL' }
    } catch {
      $result.tokenScrubbed = 'FAIL'
      Set-RcaFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
    }

    if ($restoreRequired) {
      try {
        $env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED = 'false'
        $restored = Invoke-Pm2RestartStable -ExpectedFlagTrue $false
        if ($restored.ok) {
          $result.flagRestoredOff = 'PASS'
          $result.postRestorePm2StableOnline = 'PASS'
        } else {
          Set-RcaFailure -Result $result -Stage 'PM2_RESTORE' -Reason 'FLAG_RESTORE_FAILED' -SafetyCritical
        }
      } catch {
        Set-RcaFailure -Result $result -Stage 'FLAG_RESTORE' -Reason 'FLAG_RESTORE_FAILED' -SafetyCritical
      }
    } elseif ($preflightSample -and -not $preflightSample.plmAutoPersistEnabledTrue) {
      $result.flagRestoredOff = 'PASS'
      $result.postRestorePm2StableOnline = 'PASS'
    }

    try {
      Remove-Item "Env:$($script:FlagName)" -ErrorAction SilentlyContinue
      Remove-TokenCarriers
    } catch {
      $result.tokenScrubbed = 'FAIL'
      Set-RcaFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
    }

    try {
      $finalSample = if ($script:PreparedPm2Helper) { Get-Pm2Sample } else { $null }
      if ($finalSample -and -not $finalSample.plmAutoPersistEnabledTrue) { $result.flagRestoredOff = 'PASS' }
      if ($finalSample -and -not $finalSample.authTokenNonEmpty -and -not $finalSample.adminTokenNonEmpty) {
        $result.postRestoreCredentialHygiene = 'PASS'
      }
      if ($restoreRequired -and -not $finalSample) {
        Set-RcaFailure -Result $result -Stage 'PM2_RESTORE' -Reason 'FLAG_RESTORE_FAILED' -SafetyCritical
      }
    } catch {
      Set-RcaFailure -Result $result -Stage 'PM2_RESTORE' -Reason 'FLAG_RESTORE_FAILED' -SafetyCritical
    }

    try {
      $result.tokenScrubbed = if (Test-TokenCarriersEmpty) { 'PASS' } else { 'FAIL' }
    } catch {
      $result.tokenScrubbed = 'FAIL'
      Set-RcaFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
    }

    try {
      if ($script:PreparedPm2Helper -and (Invoke-HealthCheck $Origin)) {
        $result.postRestoreHealth = 'PASS'
      } elseif ($restoreRequired) {
        Set-RcaFailure -Result $result -Stage 'HEALTH_RESTORE' -Reason 'HEALTH_FAILED' -SafetyCritical
      }
    } catch {
      if ($restoreRequired) {
        Set-RcaFailure -Result $result -Stage 'HEALTH_RESTORE' -Reason 'HEALTH_FAILED' -SafetyCritical
      }
    }

    try {
      if ($tokenUsed -and $token) {
        $result.tokenRevoked = if (Invoke-TokenLogout -Token $token -Origin $Origin) { 'PASS' } else { 'FAIL' }
        if ($result.tokenRevoked -ne 'PASS') {
          Set-RcaFailure -Result $result -Stage 'TOKEN_REVOKE' -Reason 'TOKEN_LOGOUT_FAILED'
        }
      }
    } catch {
      $result.tokenRevoked = 'FAIL'
      Set-RcaFailure -Result $result -Stage 'TOKEN_REVOKE' -Reason 'TOKEN_LOGOUT_FAILED'
    }

    try { Remove-PreparedHelpers } catch {
      Set-RcaFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
    }
    try { Exit-RcaWindowLock } catch {
      Set-RcaFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
    }
  }

  $allPass = (
    $result.failedStage -eq 'NONE' -and
    $result.clientContentVerified -eq 'PASS' -and
    $result.approvedSourceInitial -eq 'PASS' -and
    $result.approvedSourceReplay -eq 'PASS' -and
    $result.approvedSourceInternalRowsNonEmpty -eq 'PASS' -and
    $result.t4ExtendedChain -eq 'PASS' -and
    $result.selfScanClean -eq 'PASS' -and
    $result.externalWrite -eq 'false' -and
    $result.tokenScrubbed -eq 'PASS' -and
    $result.tokenRevoked -eq 'PASS' -and
    $result.flagRestoredOff -eq 'PASS' -and
    $result.postRestorePm2StableOnline -eq 'PASS' -and
    $result.postRestoreHealth -eq 'PASS' -and
    $result.postRestoreCredentialHygiene -eq 'PASS'
  )
  if ($allPass) {
    $result.executionState = 'COMPLETE'
    $result.overallAcceptance = 'PASS'
    $result.failedStage = 'NONE'
    $result.failureReason = 'NONE'
  }
  return $result
}

if ($MyInvocation.InvocationName -ne '.') {
  $result = New-RcaResult
  try {
    $entry = Read-EntrySecrets -Result $result
    $token = $entry.token
    $config = $entry.config
    if (-not $token) { $token = Read-Host -AsSecureString 'Authentication token (input hidden)' }
    if (-not $config) { $config = Read-Host -AsSecureString 'Approved config reference (input hidden)' }
    $normalizedBaseUrl = $BaseUrl.TrimEnd('/')
    $result = Invoke-RcaWindow -Root $SidecarDir -Origin $normalizedBaseUrl -Tenant $TenantId -Workspace $WorkspaceId -ConfigPreflightPassed $ApprovedConfigPreflightPassed.IsPresent -ProvidedToken $token -ProvidedConfig $config
  } catch {
    if ($result.failedStage -eq 'NONE') { Set-RcaFailure $result 'INTERNAL' 'UNEXPECTED' }
    Remove-TokenCarriers
    Remove-Item "Env:$($script:ConfigCarrier)" -ErrorAction SilentlyContinue
    Remove-Item "Env:$($script:FlagName)" -ErrorAction SilentlyContinue
  }
  [Console]::Out.WriteLine((Format-RcaResultBlock $result))
  if ($result.overallAcceptance -eq 'PASS') { exit 0 }
  exit 2
}
