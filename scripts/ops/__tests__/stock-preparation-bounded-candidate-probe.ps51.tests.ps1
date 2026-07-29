#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$opsDir = Join-Path $PSScriptRoot '..'
$scriptPath = Join-Path $opsDir 'stock-preparation-bounded-candidate-probe.ps1'
$pass = 0
$fail = 0

function Check {
  param([string]$Name, [bool]$Ok)
  if ($Ok) {
    $script:pass += 1
    Write-Host "  PASS  $Name"
  } else {
    $script:fail += 1
    Write-Host "  FAIL  $Name"
  }
}

Check 'host is Windows PowerShell 5.1 Desktop' (
  $PSVersionTable.PSEdition -eq 'Desktop' -and
  $PSVersionTable.PSVersion.Major -eq 5 -and
  $PSVersionTable.PSVersion.Minor -eq 1
)

. $scriptPath `
  -ConfigPath 'fixture.json' `
  -ObjectId 'bom' `
  -FilterField 'ProjectId' `
  -FilterValueType 'STRING' `
  -FilterValueEnvVar 'METASHEET_DISCOVERY_FILTER_TEST'

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("bounded_discovery_ps51_" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $root 'bridge-config.json'
$filterEnv = 'METASHEET_DISCOVERY_FILTER_TEST'
$privateValue = 'PRIVATE-BOM-42'
$privateError = 'PRIVATE-SQL-ERROR-TEXT'

function Write-FixtureConfig {
  param([string]$Path, [string]$FieldName = 'ProjectId')
  $json = @"
{
  "listen": { "host": "127.0.0.1", "port": 19091 },
  "auth": {
    "mode": "shared-secret-header",
    "headerName": "X-MetaSheet-Bridge-Secret",
    "sharedSecretEnvVar": "METASHEET_BRIDGE_SHARED_SECRET"
  },
  "database": {
    "server": "fixture-server",
    "database": "fixture-db",
    "integratedSecurity": false,
    "usernameEnvVar": "METASHEET_BRIDGE_SQL_USERNAME",
    "passwordEnvVar": "METASHEET_BRIDGE_SQL_PASSWORD",
    "connectTimeoutSec": 8,
    "queryTimeoutSec": 15,
    "encrypt": false,
    "trustServerCertificate": true
  },
  "limits": { "sampleLimit": 3, "maxLimit": 7 },
  "objects": {
    "bom": {
      "source": "dbo.BomView",
      "fields": [
        { "name": "RecordId", "type": "string" },
        { "name": "$FieldName", "type": "string" }
      ]
    }
  }
}
"@
  Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function Reset-Fixture {
  $script:ProbeRunCount = 0
  $script:CountCalls = 0
  $script:BridgeCalls = 0
  $script:MockCount = 3L
  $script:MockPageCount = 3
  $script:MockPageLimit = 7
  $script:MockFiltersApplied = $true
  $script:Pm2SampleProvider = {
    param($HelperPath)
    return [pscustomobject]@{
      state = 'online'
      authTokenNonEmpty = $false
      adminTokenNonEmpty = $false
      plmAutoPersistEnabledTrue = $false
    }
  }
  $script:CountProvider = {
    param($Config, $Value)
    $script:CountCalls += 1
    if ($Value -ne $privateValue) { throw $privateError }
    return $script:MockCount
  }
  $script:BridgePageProvider = {
    param($Config, $Value)
    $script:BridgeCalls += 1
    if ($Value -ne $privateValue) { throw $privateError }
    return [ordered]@{
      filtersApplied = $script:MockFiltersApplied
      limit = $script:MockPageLimit
      recordCount = $script:MockPageCount
    }
  }
  [Environment]::SetEnvironmentVariable($filterEnv, $privateValue, 'Process')
}

function Invoke-FixtureProbe {
  return Invoke-BoundedCandidateDiscovery `
    -BridgeConfigPath $configPath `
    -RequestedObjectId 'bom' `
    -RequestedFilterField 'ProjectId' `
    -RequestedFilterValueType 'STRING' `
    -RequestedFilterValueEnvVar $filterEnv `
    -Root $opsDir
}

try {
  New-Item -ItemType Directory -Path $root | Out-Null
  Write-FixtureConfig -Path $configPath

  $hostExecutable = if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Join-Path $PSHOME 'powershell.exe'
  } else {
    Join-Path $PSHOME 'pwsh'
  }
  $entrypointOutput = @(
    & $hostExecutable -NoProfile -File $scriptPath `
      -ConfigPath 'unused.json' `
      -ObjectId 'bom' `
      -FilterField 'ProjectId' `
      -FilterValueType 'STRING' `
      -FilterValueEnvVar 'PATH' `
      -SidecarDir $opsDir
  )
  $entrypointExit = $LASTEXITCODE
  Check 'file entrypoint emits one closed block and exits blocked for invalid input' (
    $entrypointExit -eq 2 -and
    @($entrypointOutput | Where-Object { $_ -eq 'STOCK_PREPARATION_BOUNDED_DISCOVERY' }).Count -eq 1 -and
    @($entrypointOutput | Where-Object { $_ -eq 'failureReason=INPUT_INVALID' }).Count -eq 1 -and
    @($entrypointOutput | Where-Object { $_ -match 'unused|ProjectId|PATH' }).Count -eq 0
  )

  $pm2PrivateCarrier = 'METASHEET_DISCOVERY_PRIVATE_PM2_SENTINEL'
  [Environment]::SetEnvironmentVariable($pm2PrivateCarrier, $privateValue, 'Process')
  $pm2EnvironmentSnapshot = @(Suspend-UnsafePm2Environment)
  $pm2CarrierHidden = [string]::IsNullOrEmpty(
    [Environment]::GetEnvironmentVariable($pm2PrivateCarrier)
  )
  Restore-Pm2Environment -Snapshot $pm2EnvironmentSnapshot
  Check 'PM2 native boundary hides and restores non-allowlisted private environment values' (
    $pm2CarrierHidden -and
    [Environment]::GetEnvironmentVariable($pm2PrivateCarrier) -eq $privateValue
  )
  [Environment]::SetEnvironmentVariable($pm2PrivateCarrier, $null, 'Process')

  $fakePm2Path = Join-Path $root 'pm2.ps1'
  @'
param([string]$Command)
if ($Command -ne 'jlist') { return }
if (-not [string]::IsNullOrEmpty(
  [Environment]::GetEnvironmentVariable('METASHEET_DISCOVERY_PRIVATE_PM2_SENTINEL')
)) { return }
Write-Output '[{"name":"metasheet-backend","pm2_env":{"status":"online","restart_time":0,"pm_uptime":1,"env":{}}}]'
'@ | Set-Content -LiteralPath $fakePm2Path -Encoding UTF8
  $oldPath = [Environment]::GetEnvironmentVariable('PATH')
  try {
    [Environment]::SetEnvironmentVariable('PATH', "$root$([IO.Path]::PathSeparator)$oldPath", 'Process')
    [Environment]::SetEnvironmentVariable($pm2PrivateCarrier, $privateValue, 'Process')
    $realPm2Sample = Get-Pm2FlagOffSample -HelperPath (Join-Path $opsDir $script:Pm2HelperName)
    Check 'real PM2 capture boundary hides private env, parses safe output, and restores the env' (
      $null -ne $realPm2Sample -and
      $realPm2Sample.state -eq 'online' -and
      -not $realPm2Sample.plmAutoPersistEnabledTrue -and
      [Environment]::GetEnvironmentVariable($pm2PrivateCarrier) -eq $privateValue
    )
  } finally {
    [Environment]::SetEnvironmentVariable('PATH', $oldPath, 'Process')
    [Environment]::SetEnvironmentVariable($pm2PrivateCarrier, $null, 'Process')
  }

  Reset-Fixture
  $possible = Invoke-FixtureProbe
  $possibleText = Format-DiscoveryResultBlock -Result $possible
  Check 'bounded non-empty candidate completes with one count and one bridge query' (
    $possible.executionState -eq 'COMPLETE' -and
    $possible.boundedCandidateSignal -eq 'POSSIBLE' -and
    $possible.pageRelationToLimit -eq 'LT' -and
    $possible.countRelationToLimit -eq 'LT' -and
    $script:CountCalls -eq 1 -and
    $script:BridgeCalls -eq 1
  )
  Check 'successful output is closed and omits private value, source, field, host, path, and counts' (
    $possibleText -notmatch [regex]::Escape($privateValue) -and
    $possibleText -notmatch 'BomView|ProjectId|fixture-server|fixture-db' -and
    $possibleText -notmatch [regex]::Escape($configPath) -and
    -not (@($possibleText -split '\r?\n') | Where-Object { $_ -match '^[^=]+=(3|7)$' })
  )
  Check 'filter input is scrubbed after success' (
    $possible.filterInputScrubbed -eq 'PASS' -and
    [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($filterEnv))
  )

  Reset-Fixture
  $script:MockCount = 0L
  $script:MockPageCount = 0
  $empty = Invoke-FixtureProbe
  Check 'zero-row scope is disclosed as EMPTY, never POSSIBLE' (
    $empty.executionState -eq 'COMPLETE' -and
    $empty.boundedCandidateSignal -eq 'EMPTY'
  )

  Reset-Fixture
  $script:MockCount = 7L
  $script:MockPageCount = 7
  $equal = Invoke-FixtureProbe
  Check 'exactly-full page is NOT_BOUNDED because SHORT_PAGE is unavailable' (
    $equal.executionState -eq 'COMPLETE' -and
    $equal.boundedCandidateSignal -eq 'NOT_BOUNDED' -and
    $equal.countRelationToLimit -eq 'EQ'
  )

  Reset-Fixture
  $script:MockCount = 12L
  $script:MockPageCount = 7
  $over = Invoke-FixtureProbe
  Check 'over-limit scope is NOT_BOUNDED without exposing the count' (
    $over.executionState -eq 'COMPLETE' -and
    $over.boundedCandidateSignal -eq 'NOT_BOUNDED' -and
    $over.countRelationToLimit -eq 'GT'
  )

  Reset-Fixture
  $script:MockCount = 4L
  $script:MockPageCount = 3
  $mismatch = Invoke-FixtureProbe
  Check 'count/page mismatch fails closed as an inconclusive observation' (
    $mismatch.executionState -eq 'BLOCKED' -and
    $mismatch.failedStage -eq 'CONSISTENCY_CHECK' -and
    $mismatch.failureReason -eq 'OBSERVATION_MISMATCH' -and
    $mismatch.countMatchesExpectedPage -eq 'FAIL'
  )

  Reset-Fixture
  $script:MockFiltersApplied = $false
  $unconfirmedFilter = Invoke-FixtureProbe
  Check 'bridge filter echo must be positively confirmed' (
    $unconfirmedFilter.executionState -eq 'BLOCKED' -and
    $unconfirmedFilter.failureReason -eq 'BRIDGE_FILTER_UNCONFIRMED'
  )

  Reset-Fixture
  $script:MockPageLimit = 6
  $unconfirmedLimit = Invoke-FixtureProbe
  Check 'bridge applied-limit echo must equal the requested clamp' (
    $unconfirmedLimit.executionState -eq 'BLOCKED' -and
    $unconfirmedLimit.failureReason -eq 'BRIDGE_LIMIT_UNCONFIRMED'
  )

  Reset-Fixture
  $script:Pm2SampleProvider = {
    param($HelperPath)
    return [pscustomobject]@{
      state = 'online'
      authTokenNonEmpty = $false
      adminTokenNonEmpty = $false
      plmAutoPersistEnabledTrue = $true
    }
  }
  $flagOn = Invoke-FixtureProbe
  Check 'flag-ON state blocks before any source or bridge read' (
    $flagOn.executionState -eq 'BLOCKED' -and
    $flagOn.failureReason -eq 'PM2_FLAG_NOT_OFF' -and
    $script:CountCalls -eq 0 -and
    $script:BridgeCalls -eq 0
  )

  Reset-Fixture
  $integratedConfig = (Get-Content -LiteralPath $configPath -Raw).Replace(
    '"integratedSecurity": false',
    '"integratedSecurity": true'
  )
  Set-Content -LiteralPath $configPath -Value $integratedConfig -Encoding UTF8
  $integratedBlocked = Invoke-FixtureProbe
  Check 'integrated security blocks when bridge and probe principal parity cannot be proven' (
    $integratedBlocked.executionState -eq 'BLOCKED' -and
    $integratedBlocked.failedStage -eq 'CONFIG_READ' -and
    $integratedBlocked.failureReason -eq 'SOURCE_PRINCIPAL_PARITY_UNPROVEN' -and
    $script:CountCalls -eq 0 -and
    $script:BridgeCalls -eq 0
  )
  Write-FixtureConfig -Path $configPath

  Reset-Fixture
  $script:CountProvider = {
    param($Config, $Value)
    $script:CountCalls += 1
    throw $privateError
  }
  $countFailure = Invoke-FixtureProbe
  $countFailureText = Format-DiscoveryResultBlock -Result $countFailure
  Check 'driver failure maps to a closed reason and never leaks private error text' (
    $countFailure.failureReason -eq 'SOURCE_COUNT_FAILED' -and
    $countFailureText -notmatch [regex]::Escape($privateError)
  )

  Reset-Fixture
  $script:BridgePageProvider = {
    param($Config, $Value)
    $script:BridgeCalls += 1
    throw $privateError
  }
  $bridgeFailure = Invoke-FixtureProbe
  $bridgeFailureText = Format-DiscoveryResultBlock -Result $bridgeFailure
  Check 'bridge failure maps to a closed reason and never leaks private error text' (
    $bridgeFailure.failureReason -eq 'BRIDGE_QUERY_FAILED' -and
    $bridgeFailureText -notmatch [regex]::Escape($privateError)
  )

  Reset-Fixture
  $missingField = Invoke-BoundedCandidateDiscovery `
    -BridgeConfigPath $configPath `
    -RequestedObjectId 'bom' `
    -RequestedFilterField 'MissingField' `
    -RequestedFilterValueType 'STRING' `
    -RequestedFilterValueEnvVar $filterEnv `
    -Root $opsDir
  Check 'non-allowlisted filter field blocks before external reads' (
    $missingField.failureReason -eq 'FILTER_NOT_ALLOWLISTED' -and
    $script:CountCalls -eq 0 -and
    $script:BridgeCalls -eq 0
  )

  Reset-Fixture
  $pathBeforeInvalidCarrier = [Environment]::GetEnvironmentVariable('PATH')
  $invalidCarrier = Invoke-BoundedCandidateDiscovery `
    -BridgeConfigPath $configPath `
    -RequestedObjectId 'bom' `
    -RequestedFilterField 'ProjectId' `
    -RequestedFilterValueType 'STRING' `
    -RequestedFilterValueEnvVar 'PATH' `
    -Root $opsDir
  Check 'rejected carrier name cannot delete an unrelated process environment variable' (
    $invalidCarrier.failureReason -eq 'INPUT_INVALID' -and
    [Environment]::GetEnvironmentVariable('PATH') -eq $pathBeforeInvalidCarrier
  )

  Reset-Fixture
  $first = Invoke-FixtureProbe
  [Environment]::SetEnvironmentVariable($filterEnv, $privateValue, 'Process')
  $second = Invoke-FixtureProbe
  Check 'one loaded sidecar process cannot execute a second discovery run' (
    $first.executionState -eq 'COMPLETE' -and
    $second.executionState -eq 'BLOCKED' -and
    $second.failedStage -eq 'PRECONDITION' -and
    $script:CountCalls -eq 1 -and
    $script:BridgeCalls -eq 1
  )

  $config = Read-ProbeConfig `
    -Path $configPath `
    -RequestedObjectId 'bom' `
    -RequestedFilterField 'ProjectId'
  $spec = New-SamePredicateCountSpec -Config $config -FilterValue $privateValue
  Check 'same-predicate count is capped at limit plus one and parameterizes private inputs' (
    $spec.sql -eq (
      'SELECT COUNT_BIG(1) FROM (SELECT TOP (@p1) 1 AS [probe_marker] ' +
      'FROM [dbo].[BomView] WHERE [ProjectId] = @p0) AS [bounded_probe]'
    ) -and
    $spec.sql -notmatch [regex]::Escape($privateValue) -and
    @($spec.parameters).Count -eq 2 -and
    $spec.parameters[0].name -eq '@p0' -and
    $spec.parameters[0].value -eq $privateValue -and
    $spec.parameters[1].name -eq '@p1' -and
    $spec.parameters[1].value -eq 8L
  )

  $validPayload = '{"object":"bom","records":[{"id":1}],"limit":7,"filtersApplied":true}' |
    ConvertFrom-Json
  $validatedPayload = ConvertFrom-BridgePagePayload -Payload $validPayload -Config $config
  Check 'production bridge payload validator accepts the exact object/filter/limit shape' (
    $validatedPayload.filtersApplied -and
    $validatedPayload.limit -eq 7 -and
    $validatedPayload.recordCount -eq 1
  )
  $wrongObjectRejected = $false
  try {
    $wrongPayload = '{"object":"other","records":[],"limit":7,"filtersApplied":true}' |
      ConvertFrom-Json
    [void](ConvertFrom-BridgePagePayload -Payload $wrongPayload -Config $config)
  } catch {
    $wrongObjectRejected = $_.Exception.Message -eq 'BRIDGE_RESPONSE_INVALID'
  }
  Check 'production bridge payload validator rejects a mismatched object identity' $wrongObjectRejected

  foreach ($invalidPayload in @(
    [pscustomobject]@{
      object = 'bom'
      records = $null
      limit = 7
      filtersApplied = $true
    },
    [pscustomobject]@{
      object = 'bom'
      records = @($null)
      limit = 7
      filtersApplied = $true
    },
    [pscustomobject]@{
      object = 'bom'
      records = @()
      limit = '7'
      filtersApplied = $true
    }
  )) {
    $invalidPayloadRejected = $false
    try {
      [void](ConvertFrom-BridgePagePayload -Payload $invalidPayload -Config $config)
    } catch {
      $invalidPayloadRejected = $_.Exception.Message -eq 'BRIDGE_RESPONSE_INVALID'
    }
    Check 'production bridge payload validator rejects null, non-row, and non-numeric shapes' (
      $invalidPayloadRejected
    )
  }

  $invalid = New-DiscoveryResult
  $invalid.unexpected = 'PRIVATE-UNSAFE'
  $fallbackText = Format-DiscoveryResultBlock -Result $invalid
  Check 'invalid result shape fails to a closed values-free fallback' (
    $fallbackText -match 'valuesFree=FAIL' -and
    $fallbackText -notmatch 'PRIVATE-UNSAFE'
  )
} finally {
  [Environment]::SetEnvironmentVariable($filterEnv, $null, 'Process')
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "stock-preparation bounded-candidate probe PS5.1: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
exit 0
