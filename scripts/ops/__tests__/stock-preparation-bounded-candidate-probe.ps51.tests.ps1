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

function New-FixtureSqlException {
  param(
    [int[]]$Numbers,
    [string]$Message
  )
  Add-Type -AssemblyName System.Data
  $flags = [System.Reflection.BindingFlags]::Instance -bor
    [System.Reflection.BindingFlags]::NonPublic
  $errorConstructor = [System.Data.SqlClient.SqlError].GetConstructors($flags) |
    Where-Object { $_.GetParameters().Count -in @(8, 9) } |
    Sort-Object { $_.GetParameters().Count } -Descending |
    Select-Object -First 1
  $exceptionConstructor = [System.Data.SqlClient.SqlException].GetConstructors($flags) |
    Where-Object { $_.GetParameters().Count -eq 4 } |
    Select-Object -First 1
  $addMethod = [System.Data.SqlClient.SqlErrorCollection].GetMethod('Add', $flags)
  if ($null -eq $errorConstructor -or $null -eq $exceptionConstructor -or $null -eq $addMethod) {
    throw 'TEST_SQL_EXCEPTION_FACTORY_UNAVAILABLE'
  }
  $errors = [Activator]::CreateInstance([System.Data.SqlClient.SqlErrorCollection], $true)
  foreach ($number in @($Numbers)) {
    $arguments = if ($errorConstructor.GetParameters().Count -eq 9) {
      @([int]$number, [byte]0, [byte]0, 'private-server', $Message, 'private-proc', 1, [uint32]0, $null)
    } else {
      @([int]$number, [byte]0, [byte]0, 'private-server', $Message, 'private-proc', 1, $null)
    }
    $sqlError = $errorConstructor.Invoke([object[]]$arguments)
    [void]$addMethod.Invoke($errors, [object[]]@($sqlError))
  }
  return $exceptionConstructor.Invoke(
    [object[]]@($Message, $errors, $null, [guid]::NewGuid())
  )
}

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

function New-FixtureCountObservation {
  param(
    [string]$FailureReason = 'NONE',
    [long]$Count = 0L,
    [string]$SourceCountFailureClass = 'OTHER',
    [string]$SourceBoundLimitControlFailureClass = 'OTHER',
    [string]$RequestedFilterValueType = 'STRING',
    [string]$SourceColumnTypeClass = 'TEXT',
    [string]$SourceColumnMetadataFailureClass = 'OTHER',
    [string]$SourceTypeRelation = 'DIRECT_CLASS'
  )
  $observation = [ordered]@{
    state = 'BLOCKED'
    failureReason = $FailureReason
    count = $null
    sourceCredentialEnv = 'NOT_RUN'
    sourceConnectionAttempted = 'NO'
    sourceConnection = 'NOT_RUN'
    sourceBoundLimitControlAttempted = 'NO'
    sourceBoundLimitControl = 'NOT_RUN'
    sourceBoundLimitControlFailureClass = 'NOT_RUN'
    sourceParameterFailureRole = 'NOT_RUN'
    requestedFilterValueType = $RequestedFilterValueType
    sourceColumnMetadataAttempted = 'NO'
    sourceColumnMetadata = 'NOT_RUN'
    sourceColumnMetadataFailureClass = 'NOT_RUN'
    sourceColumnTypeClass = 'NOT_RUN'
    sourceTypeRelation = 'NOT_RUN'
    sourceCountStatementAttempted = 'NO'
    sourceCountStatement = 'NOT_RUN'
    sourceCountFailureClass = 'NOT_RUN'
    sourceCountResult = 'NOT_RUN'
  }
  switch ($FailureReason) {
    'NONE' {
      $observation.state = 'COMPLETE'
      $observation['count'] = $Count
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'PASS'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceParameterFailureRole = 'NONE'
      $observation.sourceColumnMetadataAttempted = 'YES'
      $observation.sourceColumnMetadata = 'PASS'
      $observation.sourceColumnMetadataFailureClass = 'NONE'
      $observation.sourceColumnTypeClass = $SourceColumnTypeClass
      $observation.sourceTypeRelation = 'DIRECT_CLASS'
      $observation.sourceCountStatementAttempted = 'YES'
      $observation.sourceCountStatement = 'PASS'
      $observation.sourceCountFailureClass = 'NONE'
      $observation.sourceCountResult = 'PASS'
    }
    'SOURCE_CREDENTIAL_UNAVAILABLE' {
      $observation.sourceCredentialEnv = 'FAIL'
    }
    'SOURCE_CONNECTION_FAILED' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'FAIL'
    }
    'SOURCE_BOUND_LIMIT_CONTROL_FAILED' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'FAIL'
      $observation.sourceBoundLimitControlFailureClass = $SourceBoundLimitControlFailureClass
      $observation.sourceParameterFailureRole = if (
        $SourceBoundLimitControlFailureClass -in @('PARAMETER_OR_TYPE', 'SYNTAX_OR_DIALECT')
      ) {
        'BOUND_LIMIT'
      } else {
        'UNDETERMINED'
      }
    }
    'SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'FAIL'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceParameterFailureRole = 'UNDETERMINED'
    }
    'SOURCE_COLUMN_METADATA_FAILED' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'PASS'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceParameterFailureRole = 'NONE'
      $observation.sourceColumnMetadataAttempted = 'YES'
      $observation.sourceColumnMetadata = 'FAIL'
      $observation.sourceColumnMetadataFailureClass = $SourceColumnMetadataFailureClass
      $observation.sourceColumnTypeClass = 'NOT_RUN'
      $observation.sourceTypeRelation = 'UNKNOWN'
    }
    'SOURCE_COLUMN_METADATA_RESULT_INVALID' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'PASS'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceParameterFailureRole = 'NONE'
      $observation.sourceColumnMetadataAttempted = 'YES'
      $observation.sourceColumnMetadata = 'FAIL'
      $observation.sourceColumnMetadataFailureClass = 'NONE'
      $observation.sourceColumnTypeClass = 'NOT_RUN'
      $observation.sourceTypeRelation = 'UNKNOWN'
    }
    'SOURCE_TYPE_RELATION_CROSS_CLASS' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'PASS'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceParameterFailureRole = 'NONE'
      $observation.sourceColumnMetadataAttempted = 'YES'
      $observation.sourceColumnMetadata = 'PASS'
      $observation.sourceColumnMetadataFailureClass = 'NONE'
      $observation.sourceColumnTypeClass = $SourceColumnTypeClass
      $observation.sourceTypeRelation = 'CROSS_CLASS'
    }
    'SOURCE_TYPE_RELATION_UNKNOWN' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'PASS'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceParameterFailureRole = 'NONE'
      $observation.sourceColumnMetadataAttempted = 'YES'
      $observation.sourceColumnMetadata = 'PASS'
      $observation.sourceColumnMetadataFailureClass = 'NONE'
      $observation.sourceColumnTypeClass = 'OTHER'
      $observation.sourceTypeRelation = 'UNKNOWN'
    }
    'SOURCE_COUNT_STATEMENT_FAILED' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'PASS'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceColumnMetadataAttempted = 'YES'
      $observation.sourceColumnMetadata = 'PASS'
      $observation.sourceColumnMetadataFailureClass = 'NONE'
      $observation.sourceColumnTypeClass = $SourceColumnTypeClass
      $observation.sourceTypeRelation = 'DIRECT_CLASS'
      $observation.sourceCountStatementAttempted = 'YES'
      $observation.sourceCountStatement = 'FAIL'
      $observation.sourceCountFailureClass = $SourceCountFailureClass
      $observation.sourceParameterFailureRole = if ($SourceCountFailureClass -eq 'PARAMETER_OR_TYPE') {
        'PREDICATE_OR_SOURCE'
      } else {
        'NONE'
      }
    }
    'SOURCE_COUNT_RESULT_INVALID' {
      $observation.sourceCredentialEnv = 'PASS'
      $observation.sourceConnectionAttempted = 'YES'
      $observation.sourceConnection = 'PASS'
      $observation.sourceBoundLimitControlAttempted = 'YES'
      $observation.sourceBoundLimitControl = 'PASS'
      $observation.sourceBoundLimitControlFailureClass = 'NONE'
      $observation.sourceParameterFailureRole = 'NONE'
      $observation.sourceColumnMetadataAttempted = 'YES'
      $observation.sourceColumnMetadata = 'PASS'
      $observation.sourceColumnMetadataFailureClass = 'NONE'
      $observation.sourceColumnTypeClass = $SourceColumnTypeClass
      $observation.sourceTypeRelation = 'DIRECT_CLASS'
      $observation.sourceCountStatementAttempted = 'YES'
      $observation.sourceCountStatement = 'PASS'
      $observation.sourceCountFailureClass = 'NONE'
      $observation.sourceCountResult = 'FAIL'
    }
    default { throw 'TEST_FAILURE_REASON_INVALID' }
  }
  return $observation
}

function Reset-Fixture {
  $script:ProbeRunCount = 0
  $script:CountCalls = 0
  $script:BridgeCalls = 0
  $script:SourceConnectionCalls = 0
  $script:SourceControlCalls = 0
  $script:SourceMetadataCalls = 0
  $script:SourceStatementCalls = 0
  $script:SourceCleanupCalls = 0
  $script:SourceCallOrder = @()
  $script:OpenConnection = $null
  $script:MockCount = 3L
  $script:MockControlValue = 1L
  $script:MockMetadataTypeName = 'nvarchar'
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
    param($Config, $Value, $ValueType)
    $script:CountCalls += 1
    if ($Value -ne $privateValue) { throw $privateError }
    return Invoke-SamePredicateCount `
      -Config $Config `
      -FilterValue $Value `
      -FilterValueType $ValueType
  }
  $script:SourceConnectionProvider = {
    param($Config, $Username, $Password)
    $script:SourceConnectionCalls += 1
    $script:SourceCallOrder += 'connect'
    if ($Username -ne 'fixture-user' -or $Password -ne 'fixture-password') {
      throw $privateError
    }
    $script:OpenConnection = [pscustomobject]@{ state = 'open'; id = [guid]::NewGuid().ToString('N') }
    return $script:OpenConnection
  }
  $script:SourceBoundLimitControlCommandProvider = {
    param($Connection, $Config)
    $script:SourceControlCalls += 1
    $script:SourceCallOrder += 'control'
    if ($null -eq $Connection -or
      $null -eq $script:OpenConnection -or
      $Connection.id -cne $script:OpenConnection.id -or
      $Connection.state -ne 'open') {
      throw $privateError
    }
    return [long]$script:MockControlValue
  }
  $script:SourceColumnMetadataCommandProvider = {
    param($Connection, $Config)
    $script:SourceMetadataCalls += 1
    $script:SourceCallOrder += 'metadata'
    if ($null -eq $Connection -or
      $null -eq $script:OpenConnection -or
      $Connection.id -cne $script:OpenConnection.id -or
      $Connection.state -ne 'open') {
      throw $privateError
    }
    return [string]$script:MockMetadataTypeName
  }
  $script:SourceCountCommandProvider = {
    param($Connection, $Config, $Value)
    $script:SourceStatementCalls += 1
    $script:SourceCallOrder += 'count'
    if ($null -eq $Connection -or
      $null -eq $script:OpenConnection -or
      $Connection.id -cne $script:OpenConnection.id -or
      $Connection.state -ne 'open' -or
      $Value -ne $privateValue) {
      throw $privateError
    }
    return [long]$script:MockCount
  }
  $script:SourceConnectionCleanupProvider = {
    param($Connection)
    $script:SourceCleanupCalls += 1
    $script:SourceCallOrder += 'cleanup'
    if ($null -eq $Connection -or
      $null -eq $script:OpenConnection -or
      $Connection.id -cne $script:OpenConnection.id) {
      throw $privateError
    }
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
  [Environment]::SetEnvironmentVariable(
    'METASHEET_BRIDGE_SQL_USERNAME',
    'fixture-user',
    'Process'
  )
  [Environment]::SetEnvironmentVariable(
    'METASHEET_BRIDGE_SQL_PASSWORD',
    'fixture-password',
    'Process'
  )
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

function New-FixtureScalarConnection {
  param([long]$ScalarValue)
  Add-Type -AssemblyName System.Data
  $parameters = [pscustomobject]@{ added = @() }
  $parameters | Add-Member -MemberType ScriptMethod -Name AddWithValue -Value {
    param($Name, $Value)
    $this.added += ,([pscustomobject]@{ name = $Name; value = $Value })
    return $null
  }
  $command = [pscustomobject]@{
    CommandType = $null
    CommandTimeout = 0
    CommandText = ''
    Parameters = $parameters
    ScalarValue = $ScalarValue
  }
  $command | Add-Member -MemberType ScriptMethod -Name ExecuteScalar -Value {
    return $this.ScalarValue
  }
  $connection = [pscustomobject]@{ Command = $command }
  $connection | Add-Member -MemberType ScriptMethod -Name CreateCommand -Value {
    return $this.Command
  }
  return $connection
}

function New-FixtureSchemaOnlyConnection {
  param(
    [int]$FieldCount = 1,
    [string]$DataTypeName = 'nvarchar',
    [switch]$ThrowOnExecute,
    [switch]$ThrowOnGetDataTypeName
  )
  Add-Type -AssemblyName System.Data
  $reader = [pscustomobject]@{
    FieldCount = $FieldCount
    DataTypeName = $DataTypeName
    ThrowOnGetDataTypeName = [bool]$ThrowOnGetDataTypeName
    ReadCalled = $false
    Disposed = $false
  }
  $reader | Add-Member -MemberType ScriptMethod -Name GetDataTypeName -Value {
    param([int]$Ordinal)
    if ($this.ThrowOnGetDataTypeName) { throw 'PRIVATE-METADATA-TYPE-ERROR' }
    if ($Ordinal -ne 0) { throw 'PRIVATE-ORDINAL-ERROR' }
    return $this.DataTypeName
  }
  $reader | Add-Member -MemberType ScriptMethod -Name Read -Value {
    $this.ReadCalled = $true
    return $false
  }
  $reader | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $this.Disposed = $true
  }
  $command = [pscustomobject]@{
    CommandType = $null
    CommandTimeout = 0
    CommandText = ''
    Reader = $reader
    ThrowOnExecute = [bool]$ThrowOnExecute
    LastBehavior = $null
    Disposed = $false
  }
  $command | Add-Member -MemberType ScriptMethod -Name ExecuteReader -Value {
    param($Behavior)
    $this.LastBehavior = $Behavior
    if ($this.ThrowOnExecute) {
      throw (New-FixtureSqlException -Numbers ([int[]]@(208)) -Message 'PRIVATE-METADATA-SQL-ERROR')
    }
    return $this.Reader
  }
  $command | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $this.Disposed = $true
  }
  $connection = [pscustomobject]@{ Command = $command }
  $connection | Add-Member -MemberType ScriptMethod -Name CreateCommand -Value {
    return $this.Command
  }
  return $connection
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
    $possible.sourceCredentialEnv -eq 'PASS' -and
    $possible.sourceConnectionAttempted -eq 'YES' -and
    $possible.sourceConnection -eq 'PASS' -and
    $possible.sourceBoundLimitControlAttempted -eq 'YES' -and
    $possible.sourceBoundLimitControl -eq 'PASS' -and
    $possible.sourceBoundLimitControlFailureClass -eq 'NONE' -and
    $possible.sourceParameterFailureRole -eq 'NONE' -and
    $possible.requestedFilterValueType -eq 'STRING' -and
    $possible.sourceColumnMetadataAttempted -eq 'YES' -and
    $possible.sourceColumnMetadata -eq 'PASS' -and
    $possible.sourceColumnMetadataFailureClass -eq 'NONE' -and
    $possible.sourceColumnTypeClass -eq 'TEXT' -and
    $possible.sourceTypeRelation -eq 'DIRECT_CLASS' -and
    $possible.sourceCountStatementAttempted -eq 'YES' -and
    $possible.sourceCountStatement -eq 'PASS' -and
    $possible.sourceCountFailureClass -eq 'NONE' -and
    $possible.sourceCountResult -eq 'PASS' -and
    $possible.pageRelationToLimit -eq 'LT' -and
    $possible.countRelationToLimit -eq 'LT' -and
    $script:CountCalls -eq 1 -and
    $script:SourceConnectionCalls -eq 1 -and
    $script:SourceControlCalls -eq 1 -and
    $script:SourceMetadataCalls -eq 1 -and
    $script:SourceStatementCalls -eq 1 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 1 -and
    (@($script:SourceCallOrder) -join ',') -eq 'connect,control,metadata,count,cleanup'
  )
  Check 'successful output is closed and omits private value, source, field, host, path, and counts' (
    $possibleText -notmatch [regex]::Escape($privateValue) -and
    $possibleText -notmatch 'BomView|ProjectId|fixture-server|fixture-db' -and
    $possibleText -notmatch [regex]::Escape($configPath) -and
    $possibleText -notmatch 'nvarchar|varchar|uniqueidentifier' -and
    @($possibleText -split '\r?\n' | Where-Object {
      $_ -eq 'sourceCountFailureClass=NONE'
    }).Count -eq 1 -and
    @($possibleText -split '\r?\n' | Where-Object {
      $_ -eq 'sourceBoundLimitControl=PASS'
    }).Count -eq 1 -and
    @($possibleText -split '\r?\n' | Where-Object {
      $_ -eq 'sourceParameterFailureRole=NONE'
    }).Count -eq 1 -and
    @($possibleText -split '\r?\n' | Where-Object {
      $_ -eq 'sourceTypeRelation=DIRECT_CLASS'
    }).Count -eq 1 -and
    @($possibleText -split '\r?\n' | Where-Object {
      $_ -eq 'sourceColumnTypeClass=TEXT'
    }).Count -eq 1 -and
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
  [Environment]::SetEnvironmentVariable('METASHEET_BRIDGE_SQL_USERNAME', $null, 'Process')
  $credentialFailure = Invoke-FixtureProbe
  $credentialFailureText = Format-DiscoveryResultBlock -Result $credentialFailure
  Check 'missing SQL-auth environment blocks before connection or statement attempt' (
    $credentialFailure.failedStage -eq 'SOURCE_COUNT' -and
    $credentialFailure.failureReason -eq 'SOURCE_CREDENTIAL_UNAVAILABLE' -and
    $credentialFailure.sourceCredentialEnv -eq 'FAIL' -and
    $credentialFailure.sourceConnectionAttempted -eq 'NO' -and
    $credentialFailure.sourceConnection -eq 'NOT_RUN' -and
    $credentialFailure.sourceBoundLimitControlAttempted -eq 'NO' -and
    $credentialFailure.sourceBoundLimitControl -eq 'NOT_RUN' -and
    $credentialFailure.sourceBoundLimitControlFailureClass -eq 'NOT_RUN' -and
    $credentialFailure.sourceParameterFailureRole -eq 'NOT_RUN' -and
    $credentialFailure.requestedFilterValueType -eq 'STRING' -and
    $credentialFailure.sourceColumnMetadataAttempted -eq 'NO' -and
    $credentialFailure.sourceColumnMetadata -eq 'NOT_RUN' -and
    $credentialFailure.sourceTypeRelation -eq 'NOT_RUN' -and
    $credentialFailure.sourceCountStatementAttempted -eq 'NO' -and
    $credentialFailure.sourceCountStatement -eq 'NOT_RUN' -and
    $credentialFailure.sourceCountResult -eq 'NOT_RUN' -and
    $script:SourceConnectionCalls -eq 0 -and
    $script:SourceControlCalls -eq 0 -and
    $script:SourceMetadataCalls -eq 0 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:BridgeCalls -eq 0 -and
    $credentialFailureText -notmatch 'fixture-user|fixture-password'
  )

  Reset-Fixture
  [Environment]::SetEnvironmentVariable('METASHEET_BRIDGE_SQL_PASSWORD', $null, 'Process')
  $passwordFailure = Invoke-FixtureProbe
  Check 'missing SQL-auth password blocks before connection or statement attempt' (
    $passwordFailure.failedStage -eq 'SOURCE_COUNT' -and
    $passwordFailure.failureReason -eq 'SOURCE_CREDENTIAL_UNAVAILABLE' -and
    $passwordFailure.sourceCredentialEnv -eq 'FAIL' -and
    $passwordFailure.sourceConnectionAttempted -eq 'NO' -and
    $passwordFailure.sourceBoundLimitControlAttempted -eq 'NO' -and
    $passwordFailure.sourceParameterFailureRole -eq 'NOT_RUN' -and
    $passwordFailure.sourceColumnMetadataAttempted -eq 'NO' -and
    $passwordFailure.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceConnectionCalls -eq 0 -and
    $script:SourceControlCalls -eq 0 -and
    $script:SourceMetadataCalls -eq 0 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 0 -and
    $script:BridgeCalls -eq 0
  )

  Reset-Fixture
  $script:SourceConnectionProvider = {
    param($Config, $Username, $Password)
    $script:SourceConnectionCalls += 1
    $script:SourceCallOrder += 'connect'
    throw $privateError
  }
  $connectionFailure = Invoke-FixtureProbe
  $connectionFailureText = Format-DiscoveryResultBlock -Result $connectionFailure
  Check 'connection-open failure is distinct, closed, and skips the count statement' (
    $connectionFailure.failureReason -eq 'SOURCE_CONNECTION_FAILED' -and
    $connectionFailure.sourceCredentialEnv -eq 'PASS' -and
    $connectionFailure.sourceConnectionAttempted -eq 'YES' -and
    $connectionFailure.sourceConnection -eq 'FAIL' -and
    $connectionFailure.sourceBoundLimitControlAttempted -eq 'NO' -and
    $connectionFailure.sourceBoundLimitControl -eq 'NOT_RUN' -and
    $connectionFailure.sourceBoundLimitControlFailureClass -eq 'NOT_RUN' -and
    $connectionFailure.sourceParameterFailureRole -eq 'NOT_RUN' -and
    $connectionFailure.sourceColumnMetadataAttempted -eq 'NO' -and
    $connectionFailure.sourceTypeRelation -eq 'NOT_RUN' -and
    $connectionFailure.sourceCountStatementAttempted -eq 'NO' -and
    $connectionFailure.sourceCountStatement -eq 'NOT_RUN' -and
    $connectionFailure.sourceCountFailureClass -eq 'NOT_RUN' -and
    $connectionFailure.sourceCountResult -eq 'NOT_RUN' -and
    $script:SourceConnectionCalls -eq 1 -and
    $script:SourceControlCalls -eq 0 -and
    $script:SourceMetadataCalls -eq 0 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 0 -and
    $script:BridgeCalls -eq 0 -and
    $connectionFailureText -notmatch [regex]::Escape($privateError)
  )

  $classificationCases = @(
    [pscustomobject]@{
      name = 'permission'
      numbers = [int[]]@(229)
      expected = 'SELECT_PERMISSION'
    },
    [pscustomobject]@{
      name = 'object or column resolution'
      numbers = [int[]]@(208)
      expected = 'OBJECT_OR_COLUMN_RESOLUTION'
    },
    [pscustomobject]@{
      name = 'parameter or type'
      numbers = [int[]]@(245)
      expected = 'PARAMETER_OR_TYPE'
    },
    [pscustomobject]@{
      name = 'syntax or dialect'
      numbers = [int[]]@(102)
      expected = 'SYNTAX_OR_DIALECT'
    },
    [pscustomobject]@{
      name = 'timeout or resource'
      numbers = [int[]]@(-2)
      expected = 'TIMEOUT_OR_RESOURCE'
    },
    [pscustomobject]@{
      name = 'unclassified'
      numbers = [int[]]@(50000)
      expected = 'OTHER'
    }
  )
  foreach ($case in $classificationCases) {
    $sqlException = New-FixtureSqlException -Numbers $case.numbers -Message $privateError
    $actualClass = $null
    try {
      throw $sqlException
    } catch {
      $actualClass = Get-SourceCountFailureClass -ErrorRecord $_
    }
    Check "SQL error classification closes $($case.name) without driver text" (
      $actualClass -eq $case.expected
    )
  }

  $nonSqlClass = $null
  try {
    throw $privateError
  } catch {
    $nonSqlClass = Get-SourceCountFailureClass -ErrorRecord $_
  }
  Check 'non-SQL statement errors fail closed to OTHER' ($nonSqlClass -eq 'OTHER')

  $wrappedClass = $null
  $wrappedSqlException = New-FixtureSqlException -Numbers ([int[]]@(207)) -Message $privateError
  try {
    throw ([System.Exception]::new('PRIVATE-WRAPPER', $wrappedSqlException))
  } catch {
    $wrappedClass = Get-SourceCountFailureClass -ErrorRecord $_
  }
  Check 'SQL error classification traverses a wrapper without publishing wrapper text' (
    $wrappedClass -eq 'OBJECT_OR_COLUMN_RESOLUTION' -and
    $wrappedClass -notmatch 'PRIVATE'
  )

  $multiErrorClass = $null
  try {
    throw (New-FixtureSqlException -Numbers ([int[]]@(50000, 208, 229)) -Message $privateError)
  } catch {
    $multiErrorClass = Get-SourceCountFailureClass -ErrorRecord $_
  }
  Check 'SQL error classification examines the full collection with frozen precedence' (
    $multiErrorClass -eq 'SELECT_PERMISSION'
  )

  Reset-Fixture
  $script:SourceCountCommandProvider = {
    param($Connection, $Config, $Value)
    $script:SourceStatementCalls += 1
    $script:SourceCallOrder += 'count'
    throw (New-FixtureSqlException -Numbers ([int[]]@(208)) -Message $privateError)
  }
  $statementFailure = Invoke-FixtureProbe
  $statementFailureText = Format-DiscoveryResultBlock -Result $statementFailure
  Check 'count-statement failure is distinct, closed, and cleans up the connection' (
    $statementFailure.failureReason -eq 'SOURCE_COUNT_STATEMENT_FAILED' -and
    $statementFailure.sourceCredentialEnv -eq 'PASS' -and
    $statementFailure.sourceConnection -eq 'PASS' -and
    $statementFailure.sourceBoundLimitControlAttempted -eq 'YES' -and
    $statementFailure.sourceBoundLimitControl -eq 'PASS' -and
    $statementFailure.sourceBoundLimitControlFailureClass -eq 'NONE' -and
    $statementFailure.sourceParameterFailureRole -eq 'NONE' -and
    $statementFailure.sourceColumnMetadata -eq 'PASS' -and
    $statementFailure.sourceTypeRelation -eq 'DIRECT_CLASS' -and
    $statementFailure.sourceCountStatementAttempted -eq 'YES' -and
    $statementFailure.sourceCountStatement -eq 'FAIL' -and
    $statementFailure.sourceCountFailureClass -eq 'OBJECT_OR_COLUMN_RESOLUTION' -and
    $statementFailure.sourceCountResult -eq 'NOT_RUN' -and
    $script:SourceConnectionCalls -eq 1 -and
    $script:SourceControlCalls -eq 1 -and
    $script:SourceMetadataCalls -eq 1 -and
    $script:SourceStatementCalls -eq 1 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 0 -and
    (@($script:SourceCallOrder) -join ',') -eq 'connect,control,metadata,count,cleanup' -and
    $statementFailureText -notmatch [regex]::Escape($privateError)
  )

  Reset-Fixture
  $script:SourceCountCommandProvider = {
    param($Connection, $Config, $Value)
    $script:SourceStatementCalls += 1
    $script:SourceCallOrder += 'count'
    return '3'
  }
  $resultFailure = Invoke-FixtureProbe
  Check 'non-int64 count result is a distinct closed failure after statement success' (
    $resultFailure.failureReason -eq 'SOURCE_COUNT_RESULT_INVALID' -and
    $resultFailure.sourceCredentialEnv -eq 'PASS' -and
    $resultFailure.sourceConnection -eq 'PASS' -and
    $resultFailure.sourceBoundLimitControl -eq 'PASS' -and
    $resultFailure.sourceParameterFailureRole -eq 'NONE' -and
    $resultFailure.sourceCountStatement -eq 'PASS' -and
    $resultFailure.sourceCountFailureClass -eq 'NONE' -and
    $resultFailure.sourceCountResult -eq 'FAIL' -and
    $script:SourceControlCalls -eq 1 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 0
  )

  Reset-Fixture
  $script:CountProvider = {
    param($Config, $Value)
    $script:CountCalls += 1
    return [ordered]@{
      state = 'COMPLETE'
      failureReason = 'NONE'
      count = 3L
      sourceCredentialEnv = 'PASS'
    }
  }
  $malformedObservation = Invoke-FixtureProbe
  Check 'malformed source-count observation fails as INTERNAL and cannot claim a source stage' (
    $malformedObservation.failedStage -eq 'INTERNAL' -and
    $malformedObservation.failureReason -eq 'UNEXPECTED' -and
    $malformedObservation.sourceCredentialEnv -eq 'NOT_RUN' -and
    $malformedObservation.sourceConnectionAttempted -eq 'NO' -and
    $malformedObservation.sourceBoundLimitControlAttempted -eq 'NO' -and
    $malformedObservation.sourceColumnMetadataAttempted -eq 'NO' -and
    $malformedObservation.sourceCountStatementAttempted -eq 'NO' -and
    $script:BridgeCalls -eq 0
  )

  $illegalSuccessObservation = New-FixtureCountObservation -Count 3L
  $illegalSuccessObservation.sourceConnection = 'FAIL'
  $illegalCredentialObservation = New-FixtureCountObservation `
    -FailureReason 'SOURCE_CREDENTIAL_UNAVAILABLE'
  $illegalCredentialObservation.sourceConnectionAttempted = 'YES'
  $illegalStatementObservation = New-FixtureCountObservation `
    -FailureReason 'SOURCE_COUNT_STATEMENT_FAILED'
  $illegalStatementObservation.sourceCountFailureClass = 'NONE'
  $illegalNotRunObservation = New-FixtureCountObservation `
    -FailureReason 'SOURCE_COUNT_STATEMENT_FAILED'
  $illegalNotRunObservation.sourceCountFailureClass = 'NOT_RUN'
  $illegalControlRoleObservation = New-FixtureCountObservation `
    -FailureReason 'SOURCE_BOUND_LIMIT_CONTROL_FAILED' `
    -SourceBoundLimitControlFailureClass 'PARAMETER_OR_TYPE'
  $illegalControlRoleObservation.sourceParameterFailureRole = 'PREDICATE_OR_SOURCE'
  $illegalActualRoleObservation = New-FixtureCountObservation `
    -FailureReason 'SOURCE_COUNT_STATEMENT_FAILED' `
    -SourceCountFailureClass 'PARAMETER_OR_TYPE'
  $illegalActualRoleObservation.sourceParameterFailureRole = 'BOUND_LIMIT'
  $illegalControlResultObservation = New-FixtureCountObservation `
    -FailureReason 'SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID'
  $illegalControlResultObservation.sourceBoundLimitControlFailureClass = 'OTHER'
  Check 'source-count observation validator rejects cross-stage contradictory tuples' (
    -not (Test-SourceCountObservation -Observation $illegalSuccessObservation) -and
    -not (Test-SourceCountObservation -Observation $illegalCredentialObservation) -and
    -not (Test-SourceCountObservation -Observation $illegalStatementObservation) -and
    -not (Test-SourceCountObservation -Observation $illegalNotRunObservation) -and
    -not (Test-SourceCountObservation -Observation $illegalControlRoleObservation) -and
    -not (Test-SourceCountObservation -Observation $illegalActualRoleObservation) -and
    -not (Test-SourceCountObservation -Observation $illegalControlResultObservation)
  )

  Reset-Fixture
  $script:SourceBoundLimitControlCommandProvider = {
    param($Connection, $Config)
    $script:SourceControlCalls += 1
    $script:SourceCallOrder += 'control'
    throw (New-FixtureSqlException -Numbers ([int[]]@(245)) -Message $privateError)
  }
  $controlParameterFailure = Invoke-FixtureProbe
  $controlParameterFailureText = Format-DiscoveryResultBlock -Result $controlParameterFailure
  Check 'bound-limit control PARAMETER_OR_TYPE maps BOUND_LIMIT and skips actual count' (
    $controlParameterFailure.failedStage -eq 'SOURCE_BOUND_LIMIT_CONTROL' -and
    $controlParameterFailure.failureReason -eq 'SOURCE_BOUND_LIMIT_CONTROL_FAILED' -and
    $controlParameterFailure.sourceBoundLimitControlAttempted -eq 'YES' -and
    $controlParameterFailure.sourceBoundLimitControl -eq 'FAIL' -and
    $controlParameterFailure.sourceBoundLimitControlFailureClass -eq 'PARAMETER_OR_TYPE' -and
    $controlParameterFailure.sourceParameterFailureRole -eq 'BOUND_LIMIT' -and
    $controlParameterFailure.sourceColumnMetadataAttempted -eq 'NO' -and
    $controlParameterFailure.sourceTypeRelation -eq 'NOT_RUN' -and
    $controlParameterFailure.sourceCountStatementAttempted -eq 'NO' -and
    $controlParameterFailure.sourceCountStatement -eq 'NOT_RUN' -and
    $controlParameterFailure.sourceCountFailureClass -eq 'NOT_RUN' -and
    $controlParameterFailure.sourceCountResult -eq 'NOT_RUN' -and
    $script:SourceConnectionCalls -eq 1 -and
    $script:SourceControlCalls -eq 1 -and
    $script:SourceMetadataCalls -eq 0 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 0 -and
    (@($script:SourceCallOrder) -join ',') -eq 'connect,control,cleanup' -and
    $controlParameterFailureText -notmatch [regex]::Escape($privateError) -and
    $controlParameterFailureText -notmatch '245|SqlException|probe_marker'
  )

  Reset-Fixture
  $script:SourceBoundLimitControlCommandProvider = {
    param($Connection, $Config)
    $script:SourceControlCalls += 1
    $script:SourceCallOrder += 'control'
    throw (New-FixtureSqlException -Numbers ([int[]]@(102)) -Message $privateError)
  }
  $controlSyntaxFailure = Invoke-FixtureProbe
  Check 'bound-limit control SYNTAX_OR_DIALECT maps BOUND_LIMIT while preserving raw class' (
    $controlSyntaxFailure.failureReason -eq 'SOURCE_BOUND_LIMIT_CONTROL_FAILED' -and
    $controlSyntaxFailure.sourceBoundLimitControlFailureClass -eq 'SYNTAX_OR_DIALECT' -and
    $controlSyntaxFailure.sourceParameterFailureRole -eq 'BOUND_LIMIT' -and
    $controlSyntaxFailure.sourceColumnMetadataAttempted -eq 'NO' -and
    $controlSyntaxFailure.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceMetadataCalls -eq 0 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 0
  )

  Reset-Fixture
  $script:SourceBoundLimitControlCommandProvider = {
    param($Connection, $Config)
    $script:SourceControlCalls += 1
    $script:SourceCallOrder += 'control'
    throw (New-FixtureSqlException -Numbers ([int[]]@(229)) -Message $privateError)
  }
  $controlOtherFailure = Invoke-FixtureProbe
  Check 'other control failures map UNDETERMINED while preserving raw class' (
    $controlOtherFailure.failureReason -eq 'SOURCE_BOUND_LIMIT_CONTROL_FAILED' -and
    $controlOtherFailure.sourceBoundLimitControlFailureClass -eq 'SELECT_PERMISSION' -and
    $controlOtherFailure.sourceParameterFailureRole -eq 'UNDETERMINED' -and
    $controlOtherFailure.sourceColumnMetadataAttempted -eq 'NO' -and
    $controlOtherFailure.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceMetadataCalls -eq 0 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1
  )

  Reset-Fixture
  $script:MockControlValue = 2L
  $controlResultInvalid = Invoke-FixtureProbe
  Check 'control scalar must be exactly long 1 or result is invalid and undetermined' (
    $controlResultInvalid.failedStage -eq 'SOURCE_BOUND_LIMIT_CONTROL' -and
    $controlResultInvalid.failureReason -eq 'SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID' -and
    $controlResultInvalid.sourceBoundLimitControlAttempted -eq 'YES' -and
    $controlResultInvalid.sourceBoundLimitControl -eq 'FAIL' -and
    $controlResultInvalid.sourceBoundLimitControlFailureClass -eq 'NONE' -and
    $controlResultInvalid.sourceParameterFailureRole -eq 'UNDETERMINED' -and
    $controlResultInvalid.sourceColumnMetadataAttempted -eq 'NO' -and
    $controlResultInvalid.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceControlCalls -eq 1 -and
    $script:SourceMetadataCalls -eq 0 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 0
  )

  Reset-Fixture
  $script:SourceBoundLimitControlCommandProvider = {
    param($Connection, $Config)
    $script:SourceControlCalls += 1
    $script:SourceCallOrder += 'control'
    return '1'
  }
  $controlTypeInvalid = Invoke-FixtureProbe
  Check 'non-long control scalar is closed as RESULT_INVALID without running actual count' (
    $controlTypeInvalid.failureReason -eq 'SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID' -and
    $controlTypeInvalid.sourceParameterFailureRole -eq 'UNDETERMINED' -and
    $script:SourceStatementCalls -eq 0 -and
    $script:BridgeCalls -eq 0
  )

  Reset-Fixture
  $script:SourceCountCommandProvider = {
    param($Connection, $Config, $Value)
    $script:SourceStatementCalls += 1
    $script:SourceCallOrder += 'count'
    throw (New-FixtureSqlException -Numbers ([int[]]@(245)) -Message $privateError)
  }
  $actualParameterAfterControl = Invoke-FixtureProbe
  $actualParameterAfterControlText = Format-DiscoveryResultBlock -Result $actualParameterAfterControl
  Check 'control PASS plus actual PARAMETER_OR_TYPE maps PREDICATE_OR_SOURCE' (
    $actualParameterAfterControl.failedStage -eq 'SOURCE_COUNT' -and
    $actualParameterAfterControl.failureReason -eq 'SOURCE_COUNT_STATEMENT_FAILED' -and
    $actualParameterAfterControl.sourceBoundLimitControl -eq 'PASS' -and
    $actualParameterAfterControl.sourceBoundLimitControlFailureClass -eq 'NONE' -and
    $actualParameterAfterControl.sourceTypeRelation -eq 'DIRECT_CLASS' -and
    $actualParameterAfterControl.sourceCountFailureClass -eq 'PARAMETER_OR_TYPE' -and
    $actualParameterAfterControl.sourceParameterFailureRole -eq 'PREDICATE_OR_SOURCE' -and
    $script:SourceControlCalls -eq 1 -and
    $script:SourceMetadataCalls -eq 1 -and
    $script:SourceStatementCalls -eq 1 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 0 -and
    (@($script:SourceCallOrder) -join ',') -eq 'connect,control,metadata,count,cleanup' -and
    $actualParameterAfterControlText -notmatch [regex]::Escape($privateError)
  )

  Reset-Fixture
  $script:SourceCountCommandProvider = {
    param($Connection, $Config, $Value)
    $script:SourceStatementCalls += 1
    $script:SourceCallOrder += 'count'
    throw (New-FixtureSqlException -Numbers ([int[]]@(102)) -Message $privateError)
  }
  $actualSyntaxAfterControl = Invoke-FixtureProbe
  Check 'control PASS plus non-PARAMETER actual class keeps raw class and role NONE' (
    $actualSyntaxAfterControl.failureReason -eq 'SOURCE_COUNT_STATEMENT_FAILED' -and
    $actualSyntaxAfterControl.sourceBoundLimitControl -eq 'PASS' -and
    $actualSyntaxAfterControl.sourceCountFailureClass -eq 'SYNTAX_OR_DIALECT' -and
    $actualSyntaxAfterControl.sourceParameterFailureRole -eq 'NONE'
  )

  Check 'valid control and count observation tuples remain accepted' (
    (Test-SourceCountObservation -Observation (
      New-FixtureCountObservation -Count 3L
    )) -and
    (Test-SourceCountObservation -Observation (
      New-FixtureCountObservation -FailureReason 'SOURCE_BOUND_LIMIT_CONTROL_FAILED' `
        -SourceBoundLimitControlFailureClass 'PARAMETER_OR_TYPE'
    )) -and
    (Test-SourceCountObservation -Observation (
      New-FixtureCountObservation -FailureReason 'SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID'
    )) -and
    (Test-SourceCountObservation -Observation (
      New-FixtureCountObservation -FailureReason 'SOURCE_COLUMN_METADATA_FAILED' `
        -SourceColumnMetadataFailureClass 'OBJECT_OR_COLUMN_RESOLUTION'
    )) -and
    (Test-SourceCountObservation -Observation (
      New-FixtureCountObservation -FailureReason 'SOURCE_TYPE_RELATION_CROSS_CLASS' `
        -SourceColumnTypeClass 'INTEGER'
    )) -and
    (Test-SourceCountObservation -Observation (
      New-FixtureCountObservation -FailureReason 'SOURCE_TYPE_RELATION_UNKNOWN'
    )) -and
    (Test-SourceCountObservation -Observation (
      New-FixtureCountObservation -FailureReason 'SOURCE_COUNT_STATEMENT_FAILED' `
        -SourceCountFailureClass 'PARAMETER_OR_TYPE'
    ))
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
  $controlSpec = New-BoundLimitControlSpec -Config $config
  Check 'bound-limit control is source-free and reuses limit-plus-one on @p1 only' (
    $controlSpec.sql -eq 'SELECT TOP (@p1) CAST(1 AS BIGINT) AS [probe_marker]' -and
    $controlSpec.sql -notmatch 'FROM \[|WHERE |@p0|BomView|ProjectId' -and
    @($controlSpec.parameters).Count -eq 1 -and
    $controlSpec.parameters[0].name -eq '@p1' -and
    $controlSpec.parameters[0].value -eq 8L
  )
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
    $spec.parameters[1].value -eq 8L -and
    $spec.parameters[1].value -eq $controlSpec.parameters[0].value
  )
  $controlConnection = New-FixtureScalarConnection -ScalarValue 1L
  $controlScalar = Invoke-ProbeBoundLimitControlCommand `
    -Connection $controlConnection `
    -Config $config
  $countConnection = New-FixtureScalarConnection -ScalarValue 3L
  $countScalar = Invoke-ProbeCountCommand `
    -Connection $countConnection `
    -Config $config `
    -FilterValue $privateValue
  Check 'production scalar binder executes control and count with their exact parameter sets' (
    $controlScalar -eq 1L -and
    $controlConnection.Command.CommandType -eq [System.Data.CommandType]::Text -and
    $controlConnection.Command.CommandTimeout -eq 15 -and
    $controlConnection.Command.CommandText -eq $controlSpec.sql -and
    @($controlConnection.Command.Parameters.added).Count -eq 1 -and
    $controlConnection.Command.Parameters.added[0].name -eq '@p1' -and
    $controlConnection.Command.Parameters.added[0].value -eq 8L -and
    $countScalar -eq 3L -and
    $countConnection.Command.CommandType -eq [System.Data.CommandType]::Text -and
    $countConnection.Command.CommandTimeout -eq 15 -and
    $countConnection.Command.CommandText -eq $spec.sql -and
    @($countConnection.Command.Parameters.added).Count -eq 2 -and
    $countConnection.Command.Parameters.added[0].name -eq '@p0' -and
    $countConnection.Command.Parameters.added[0].value -eq $privateValue -and
    $countConnection.Command.Parameters.added[1].name -eq '@p1' -and
    $countConnection.Command.Parameters.added[1].value -eq 8L
  )

  $metadataSpec = New-ColumnMetadataSpec -Config $config
  Check 'column metadata SQL is TOP 0 over quoted identifiers only' (
    $metadataSpec.sql -eq 'SELECT TOP (0) [ProjectId] FROM [dbo].[BomView]' -and
    $metadataSpec.sql -notmatch 'sys\.columns|OBJECT_ID|@p0|@p1' -and
    $metadataSpec.sql -notmatch [regex]::Escape($privateValue)
  )
  $schemaConnection = New-FixtureSchemaOnlyConnection -FieldCount 1 -DataTypeName 'nvarchar'
  $schemaTypeName = Invoke-ProbeColumnMetadataCommand `
    -Connection $schemaConnection `
    -Config $config
  Check 'schema-only metadata reader uses SchemaOnly, one field, and never Read()' (
    $schemaTypeName -eq 'nvarchar' -and
    $schemaConnection.Command.CommandType -eq [System.Data.CommandType]::Text -and
    $schemaConnection.Command.CommandTimeout -eq 15 -and
    $schemaConnection.Command.CommandText -eq $metadataSpec.sql -and
    $schemaConnection.Command.LastBehavior -eq [System.Data.CommandBehavior]::SchemaOnly -and
    -not $schemaConnection.Command.Reader.ReadCalled -and
    $schemaConnection.Command.Reader.Disposed -and
    $schemaConnection.Command.Disposed
  )

  $typeClassCases = @(
    [pscustomobject]@{ name = 'char'; expected = 'TEXT' },
    [pscustomobject]@{ name = 'varchar'; expected = 'TEXT' },
    [pscustomobject]@{ name = 'nchar'; expected = 'TEXT' },
    [pscustomobject]@{ name = 'nvarchar'; expected = 'TEXT' },
    [pscustomobject]@{ name = 'tinyint'; expected = 'INTEGER' },
    [pscustomobject]@{ name = 'smallint'; expected = 'INTEGER' },
    [pscustomobject]@{ name = 'int'; expected = 'INTEGER' },
    [pscustomobject]@{ name = 'bigint'; expected = 'INTEGER' },
    [pscustomobject]@{ name = 'bit'; expected = 'BOOLEAN' },
    [pscustomobject]@{ name = 'uniqueidentifier'; expected = 'GUID' },
    [pscustomobject]@{ name = 'date'; expected = 'DATE_TIME' },
    [pscustomobject]@{ name = 'time'; expected = 'DATE_TIME' },
    [pscustomobject]@{ name = 'smalldatetime'; expected = 'DATE_TIME' },
    [pscustomobject]@{ name = 'datetime'; expected = 'DATE_TIME' },
    [pscustomobject]@{ name = 'datetime2'; expected = 'DATE_TIME' },
    [pscustomobject]@{ name = 'datetimeoffset'; expected = 'DATE_TIME' },
    [pscustomobject]@{ name = 'decimal'; expected = 'DECIMAL' },
    [pscustomobject]@{ name = 'numeric'; expected = 'DECIMAL' },
    [pscustomobject]@{ name = 'smallmoney'; expected = 'DECIMAL' },
    [pscustomobject]@{ name = 'money'; expected = 'DECIMAL' },
    [pscustomobject]@{ name = 'real'; expected = 'OTHER' },
    [pscustomobject]@{ name = 'float'; expected = 'OTHER' },
    [pscustomobject]@{ name = 'binary'; expected = 'BINARY' },
    [pscustomobject]@{ name = 'varbinary'; expected = 'BINARY' },
    [pscustomobject]@{ name = 'image'; expected = 'BINARY' },
    [pscustomobject]@{ name = 'timestamp'; expected = 'BINARY' },
    [pscustomobject]@{ name = 'rowversion'; expected = 'BINARY' },
    [pscustomobject]@{ name = 'xml'; expected = 'OTHER' },
    [pscustomobject]@{ name = 'geometry'; expected = 'OTHER' }
  )
  $typeClassAllMatch = $true
  foreach ($case in $typeClassCases) {
    if ((Resolve-SourceColumnTypeClass -DataTypeName $case.name) -cne $case.expected) {
      $typeClassAllMatch = $false
      break
    }
  }
  Check 'every closed source column type class maps exactly and unknown names are OTHER' (
    $typeClassAllMatch
  )

  Check 'DIRECT_CLASS is only STRING+TEXT, INT64+INTEGER, BOOLEAN+BOOLEAN' (
    (Resolve-SourceTypeRelation -RequestedType 'STRING' -SourceTypeClass 'TEXT') -eq 'DIRECT_CLASS' -and
    (Resolve-SourceTypeRelation -RequestedType 'INT64' -SourceTypeClass 'INTEGER') -eq 'DIRECT_CLASS' -and
    (Resolve-SourceTypeRelation -RequestedType 'BOOLEAN' -SourceTypeClass 'BOOLEAN') -eq 'DIRECT_CLASS' -and
    (Resolve-SourceTypeRelation -RequestedType 'STRING' -SourceTypeClass 'INTEGER') -eq 'CROSS_CLASS' -and
    (Resolve-SourceTypeRelation -RequestedType 'INT64' -SourceTypeClass 'TEXT') -eq 'CROSS_CLASS' -and
    (Resolve-SourceTypeRelation -RequestedType 'STRING' -SourceTypeClass 'GUID') -eq 'CROSS_CLASS' -and
    (Resolve-SourceTypeRelation -RequestedType 'STRING' -SourceTypeClass 'OTHER') -eq 'UNKNOWN'
  )

  Reset-Fixture
  $script:SourceColumnMetadataCommandProvider = {
    param($Connection, $Config)
    $script:SourceMetadataCalls += 1
    $script:SourceCallOrder += 'metadata'
    throw (New-FixtureSqlException -Numbers ([int[]]@(208)) -Message $privateError)
  }
  $metadataFailure = Invoke-FixtureProbe
  $metadataFailureText = Format-DiscoveryResultBlock -Result $metadataFailure
  Check 'metadata exception fails closed before count/bridge and cleans up' (
    $metadataFailure.failedStage -eq 'SOURCE_COLUMN_METADATA' -and
    $metadataFailure.failureReason -eq 'SOURCE_COLUMN_METADATA_FAILED' -and
    $metadataFailure.sourceBoundLimitControl -eq 'PASS' -and
    $metadataFailure.sourceColumnMetadataAttempted -eq 'YES' -and
    $metadataFailure.sourceColumnMetadata -eq 'FAIL' -and
    $metadataFailure.sourceColumnMetadataFailureClass -eq 'OBJECT_OR_COLUMN_RESOLUTION' -and
    $metadataFailure.sourceColumnTypeClass -eq 'NOT_RUN' -and
    $metadataFailure.sourceTypeRelation -eq 'UNKNOWN' -and
    $metadataFailure.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceControlCalls -eq 1 -and
    $script:SourceMetadataCalls -eq 1 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1 -and
    $script:BridgeCalls -eq 0 -and
    (@($script:SourceCallOrder) -join ',') -eq 'connect,control,metadata,cleanup' -and
    $metadataFailureText -notmatch [regex]::Escape($privateError) -and
    $metadataFailureText -notmatch '208|SqlException|nvarchar'
  )

  Reset-Fixture
  $script:MockMetadataTypeName = ''
  $metadataMalformedEmpty = Invoke-FixtureProbe
  Check 'empty metadata type name is RESULT_INVALID with UNKNOWN relation' (
    $metadataMalformedEmpty.failedStage -eq 'SOURCE_COLUMN_METADATA' -and
    $metadataMalformedEmpty.failureReason -eq 'SOURCE_COLUMN_METADATA_RESULT_INVALID' -and
    $metadataMalformedEmpty.sourceColumnMetadata -eq 'FAIL' -and
    $metadataMalformedEmpty.sourceColumnMetadataFailureClass -eq 'NONE' -and
    $metadataMalformedEmpty.sourceTypeRelation -eq 'UNKNOWN' -and
    $metadataMalformedEmpty.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceStatementCalls -eq 0 -and
    $script:BridgeCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1
  )

  $schemaMalformed = New-FixtureSchemaOnlyConnection -FieldCount 2 -DataTypeName 'nvarchar'
  $schemaMalformedType = Invoke-ProbeColumnMetadataCommand `
    -Connection $schemaMalformed `
    -Config $config
  Check 'metadata FieldCount other than 1 yields empty type for RESULT_INVALID gating' (
    $schemaMalformedType -eq '' -and
    -not $schemaMalformed.Command.Reader.ReadCalled -and
    $schemaMalformed.Command.Reader.Disposed -and
    $schemaMalformed.Command.Disposed
  )

  $schemaExecuteFailure = New-FixtureSchemaOnlyConnection -ThrowOnExecute
  $schemaExecuteFailureCaught = $false
  try {
    [void](Invoke-ProbeColumnMetadataCommand `
      -Connection $schemaExecuteFailure `
      -Config $config)
  } catch {
    $schemaExecuteFailureCaught = $true
  }
  Check 'metadata command is disposed when ExecuteReader fails before a reader exists' (
    $schemaExecuteFailureCaught -and
    -not $schemaExecuteFailure.Command.Reader.Disposed -and
    $schemaExecuteFailure.Command.Disposed
  )

  $schemaTypeFailure = New-FixtureSchemaOnlyConnection -ThrowOnGetDataTypeName
  $schemaTypeFailureCaught = $false
  try {
    [void](Invoke-ProbeColumnMetadataCommand `
      -Connection $schemaTypeFailure `
      -Config $config)
  } catch {
    $schemaTypeFailureCaught = $true
  }
  Check 'metadata reader and command are disposed when GetDataTypeName fails' (
    $schemaTypeFailureCaught -and
    $schemaTypeFailure.Command.Reader.Disposed -and
    $schemaTypeFailure.Command.Disposed
  )

  Reset-Fixture
  $script:MockMetadataTypeName = 'int'
  $crossClass = Invoke-FixtureProbe
  $crossClassText = Format-DiscoveryResultBlock -Result $crossClass
  Check 'CROSS_CLASS relation blocks count and bridge without claiming config error text' (
    $crossClass.failedStage -eq 'SOURCE_COLUMN_METADATA' -and
    $crossClass.failureReason -eq 'SOURCE_TYPE_RELATION_CROSS_CLASS' -and
    $crossClass.requestedFilterValueType -eq 'STRING' -and
    $crossClass.sourceColumnMetadata -eq 'PASS' -and
    $crossClass.sourceColumnTypeClass -eq 'INTEGER' -and
    $crossClass.sourceTypeRelation -eq 'CROSS_CLASS' -and
    $crossClass.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceMetadataCalls -eq 1 -and
    $script:SourceStatementCalls -eq 0 -and
    $script:BridgeCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1 -and
    (@($script:SourceCallOrder) -join ',') -eq 'connect,control,metadata,cleanup' -and
    $crossClassText -notmatch 'config error|implementation defect' -and
    $crossClassText -notmatch 'nvarchar|bigint|uniqueidentifier|\bint\b' -and
    @($crossClassText -split '\r?\n' | Where-Object {
      $_ -eq 'sourceTypeRelation=CROSS_CLASS'
    }).Count -eq 1 -and
    @($crossClassText -split '\r?\n' | Where-Object {
      $_ -eq 'sourceColumnTypeClass=INTEGER'
    }).Count -eq 1
  )

  Reset-Fixture
  $script:MockMetadataTypeName = 'xml'
  $unknownRelation = Invoke-FixtureProbe
  $unknownRelationText = Format-DiscoveryResultBlock -Result $unknownRelation
  Check 'OTHER source class maps UNKNOWN and blocks count/bridge' (
    $unknownRelation.failedStage -eq 'SOURCE_COLUMN_METADATA' -and
    $unknownRelation.failureReason -eq 'SOURCE_TYPE_RELATION_UNKNOWN' -and
    $unknownRelation.sourceColumnTypeClass -eq 'OTHER' -and
    $unknownRelation.sourceTypeRelation -eq 'UNKNOWN' -and
    $unknownRelation.sourceCountStatementAttempted -eq 'NO' -and
    $script:SourceStatementCalls -eq 0 -and
    $script:BridgeCalls -eq 0 -and
    $script:SourceCleanupCalls -eq 1 -and
    $unknownRelationText -notmatch 'xml'
  )

  Reset-Fixture
  [Environment]::SetEnvironmentVariable($filterEnv, '42', 'Process')
  $script:MockMetadataTypeName = 'bigint'
  $script:CountProvider = {
    param($Config, $Value, $ValueType)
    $script:CountCalls += 1
    if ($Value -ne 42L -or $ValueType -ne 'INT64') { throw $privateError }
    return Invoke-SamePredicateCount `
      -Config $Config `
      -FilterValue $Value `
      -FilterValueType $ValueType
  }
  $script:SourceCountCommandProvider = {
    param($Connection, $Config, $Value)
    $script:SourceStatementCalls += 1
    $script:SourceCallOrder += 'count'
    if ($Value -ne 42L) { throw $privateError }
    return [long]$script:MockCount
  }
  $script:BridgePageProvider = {
    param($Config, $Value)
    $script:BridgeCalls += 1
    if ($Value -ne 42L) { throw $privateError }
    return [ordered]@{
      filtersApplied = $script:MockFiltersApplied
      limit = $script:MockPageLimit
      recordCount = $script:MockPageCount
    }
  }
  $int64Direct = Invoke-BoundedCandidateDiscovery `
    -BridgeConfigPath $configPath `
    -RequestedObjectId 'bom' `
    -RequestedFilterField 'ProjectId' `
    -RequestedFilterValueType 'INT64' `
    -RequestedFilterValueEnvVar $filterEnv `
    -Root $opsDir
  Check 'INT64+INTEGER is DIRECT_CLASS and permits the unchanged count path' (
    $int64Direct.executionState -eq 'COMPLETE' -and
    $int64Direct.requestedFilterValueType -eq 'INT64' -and
    $int64Direct.sourceColumnTypeClass -eq 'INTEGER' -and
    $int64Direct.sourceTypeRelation -eq 'DIRECT_CLASS' -and
    $script:SourceStatementCalls -eq 1 -and
    $script:BridgeCalls -eq 1 -and
    (@($script:SourceCallOrder) -join ',') -eq 'connect,control,metadata,count,cleanup'
  )

  Reset-Fixture
  [Environment]::SetEnvironmentVariable($filterEnv, 'true', 'Process')
  $script:MockMetadataTypeName = 'bit'
  $script:CountProvider = {
    param($Config, $Value, $ValueType)
    $script:CountCalls += 1
    if ($Value -ne $true -or $ValueType -ne 'BOOLEAN') { throw $privateError }
    return Invoke-SamePredicateCount `
      -Config $Config `
      -FilterValue $Value `
      -FilterValueType $ValueType
  }
  $script:SourceCountCommandProvider = {
    param($Connection, $Config, $Value)
    $script:SourceStatementCalls += 1
    $script:SourceCallOrder += 'count'
    if ($Value -ne $true) { throw $privateError }
    return [long]$script:MockCount
  }
  $script:BridgePageProvider = {
    param($Config, $Value)
    $script:BridgeCalls += 1
    if ($Value -ne $true) { throw $privateError }
    return [ordered]@{
      filtersApplied = $script:MockFiltersApplied
      limit = $script:MockPageLimit
      recordCount = $script:MockPageCount
    }
  }
  $boolDirect = Invoke-BoundedCandidateDiscovery `
    -BridgeConfigPath $configPath `
    -RequestedObjectId 'bom' `
    -RequestedFilterField 'ProjectId' `
    -RequestedFilterValueType 'BOOLEAN' `
    -RequestedFilterValueEnvVar $filterEnv `
    -Root $opsDir
  Check 'BOOLEAN+BOOLEAN is DIRECT_CLASS and permits the unchanged count path' (
    $boolDirect.executionState -eq 'COMPLETE' -and
    $boolDirect.requestedFilterValueType -eq 'BOOLEAN' -and
    $boolDirect.sourceColumnTypeClass -eq 'BOOLEAN' -and
    $boolDirect.sourceTypeRelation -eq 'DIRECT_CLASS' -and
    $script:SourceStatementCalls -eq 1 -and
    $script:BridgeCalls -eq 1
  )

  $illegalMetadataRole = New-FixtureCountObservation `
    -FailureReason 'SOURCE_COLUMN_METADATA_FAILED' `
    -SourceColumnMetadataFailureClass 'PARAMETER_OR_TYPE'
  $illegalMetadataRole.sourceTypeRelation = 'DIRECT_CLASS'
  $illegalCrossAsDirect = New-FixtureCountObservation `
    -FailureReason 'SOURCE_TYPE_RELATION_CROSS_CLASS' `
    -SourceColumnTypeClass 'INTEGER'
  $illegalCrossAsDirect.sourceTypeRelation = 'DIRECT_CLASS'
  Check 'metadata and relation observation validator rejects contradictory tuples' (
    -not (Test-SourceCountObservation -Observation $illegalMetadataRole) -and
    -not (Test-SourceCountObservation -Observation $illegalCrossAsDirect)
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
  [Environment]::SetEnvironmentVariable('METASHEET_BRIDGE_SQL_USERNAME', $null, 'Process')
  [Environment]::SetEnvironmentVariable('METASHEET_BRIDGE_SQL_PASSWORD', $null, 'Process')
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "stock-preparation bounded-candidate probe PS5.1: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
exit 0
