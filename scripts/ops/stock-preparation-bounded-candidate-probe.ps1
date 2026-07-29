#requires -Version 5.1
<#
.SYNOPSIS
  One-shot, flag-OFF bounded-candidate discovery for the readonly SQL Server bridge.
.DESCRIPTION
  Reads the existing bridge allowlist/config without modifying it, verifies the stock-preparation
  feature flag is OFF, executes one allowlisted bridge equality-filter query, and executes one
  parameterized COUNT_BIG query capped at limit + 1 over the same source predicate.

  The fixed stdout block is values-free. This probe can identify a possible bounded candidate; it
  is not a completeness proof and does not replace approved-config preflight.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,

  [Parameter(Mandatory = $true)]
  [string]$ObjectId,

  [Parameter(Mandatory = $true)]
  [string]$FilterField,

  [Parameter(Mandatory = $true)]
  [ValidateSet('STRING', 'INT64', 'BOOLEAN')]
  [string]$FilterValueType,

  [Parameter(Mandatory = $true)]
  [string]$FilterValueEnvVar,

  [string]$SidecarDir = $PSScriptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Pm2HelperName = 'stock-preparation-rca-window-pm2-sample.mjs'
$script:Pm2HelperSha256 = '09cc76024bd98fd4ce86cfa834eea3b94680482d0d0970600da008a19a6731ec'
$script:ProbeRunCount = 0
$script:Pm2EnvironmentAllowlist = @(
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG',
  'LC_ALL', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PM2_HOME',
  'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'USERPROFILE',
  'WINDIR'
)
$script:SourceCountFailureNumberSets = [ordered]@{
  SELECT_PERMISSION = @(229, 297)
  OBJECT_OR_COLUMN_RESOLUTION = @(207, 208, 4104, 4121)
  PARAMETER_OR_TYPE = @(137, 174, 201, 206, 241, 242, 245, 257, 8114, 8115)
  SYNTAX_OR_DIALECT = @(102, 105, 156, 170, 195, 319)
  TIMEOUT_OR_RESOURCE = @(-2, 701, 1101, 1105, 1204, 1205, 1222, 8645, 8651, 10928, 10929)
}
$script:SourceCountFailureClasses = @($script:SourceCountFailureNumberSets.Keys) + @('OTHER')

$script:ResultVocabulary = [ordered]@{
  executionState = @('COMPLETE', 'BLOCKED')
  failedStage = @(
    'NONE', 'PRECONDITION', 'PM2_CHECK', 'CONFIG_READ', 'INPUT_VALIDATE',
    'SOURCE_COUNT', 'BRIDGE_QUERY', 'CONSISTENCY_CHECK', 'CLEANUP', 'INTERNAL'
  )
  failureReason = @(
    'NONE', 'INPUT_INVALID', 'PM2_HELPER_INVALID', 'PM2_SAMPLE_INVALID',
    'PM2_NOT_ONLINE', 'PM2_FLAG_NOT_OFF', 'PM2_TOKEN_PRESENT', 'CONFIG_INVALID',
    'SOURCE_PRINCIPAL_PARITY_UNPROVEN',
    'OBJECT_NOT_ALLOWLISTED', 'FILTER_NOT_ALLOWLISTED', 'FILTER_VALUE_UNAVAILABLE',
    'SOURCE_CREDENTIAL_UNAVAILABLE', 'SOURCE_CONNECTION_FAILED',
    'SOURCE_COUNT_STATEMENT_FAILED', 'SOURCE_COUNT_RESULT_INVALID',
    'BRIDGE_QUERY_FAILED', 'BRIDGE_FILTER_UNCONFIRMED',
    'BRIDGE_LIMIT_UNCONFIRMED', 'BRIDGE_RESULT_INVALID', 'OBSERVATION_MISMATCH',
    'FILTER_INPUT_SCRUB_FAILED', 'UNEXPECTED'
  )
  flagStateOff = @('PASS', 'FAIL')
  configMutation = @('false')
  externalWrite = @('false')
  probeRunCount = @('ZERO', 'ONE')
  sourceCredentialEnv = @('PASS', 'FAIL', 'NOT_RUN')
  sourceConnectionAttempted = @('YES', 'NO')
  sourceConnection = @('PASS', 'FAIL', 'NOT_RUN')
  sourceCountStatementAttempted = @('YES', 'NO')
  sourceCountStatement = @('PASS', 'FAIL', 'NOT_RUN')
  sourceCountFailureClass = @('NONE', 'NOT_RUN') + $script:SourceCountFailureClasses
  sourceCountResult = @('PASS', 'FAIL', 'NOT_RUN')
  filtersApplied = @('PASS', 'FAIL', 'NOT_RUN')
  appliedLimitEcho = @('PASS', 'FAIL', 'NOT_RUN')
  samePredicateCount = @('PASS', 'FAIL', 'NOT_RUN')
  pageRelationToLimit = @('LT', 'EQ', 'NOT_RUN')
  countRelationToLimit = @('LT', 'EQ', 'GT', 'NOT_RUN')
  countMatchesExpectedPage = @('PASS', 'FAIL', 'NOT_RUN')
  boundedCandidateSignal = @('POSSIBLE', 'EMPTY', 'NOT_BOUNDED', 'INCONCLUSIVE')
  filterInputScrubbed = @('PASS', 'FAIL')
  valuesFree = @('PASS', 'FAIL')
}

function New-DiscoveryResult {
  return [ordered]@{
    executionState = 'BLOCKED'
    failedStage = 'NONE'
    failureReason = 'NONE'
    flagStateOff = 'FAIL'
    configMutation = 'false'
    externalWrite = 'false'
    probeRunCount = 'ZERO'
    sourceCredentialEnv = 'NOT_RUN'
    sourceConnectionAttempted = 'NO'
    sourceConnection = 'NOT_RUN'
    sourceCountStatementAttempted = 'NO'
    sourceCountStatement = 'NOT_RUN'
    sourceCountFailureClass = 'NOT_RUN'
    sourceCountResult = 'NOT_RUN'
    filtersApplied = 'NOT_RUN'
    appliedLimitEcho = 'NOT_RUN'
    samePredicateCount = 'NOT_RUN'
    pageRelationToLimit = 'NOT_RUN'
    countRelationToLimit = 'NOT_RUN'
    countMatchesExpectedPage = 'NOT_RUN'
    boundedCandidateSignal = 'INCONCLUSIVE'
    filterInputScrubbed = 'FAIL'
    valuesFree = 'PASS'
  }
}

function Set-DiscoveryFailure {
  param(
    [System.Collections.IDictionary]$Result,
    [string]$Stage,
    [string]$Reason,
    [switch]$SafetyCritical
  )
  if ($SafetyCritical -or $Result.failedStage -eq 'NONE') {
    $Result.failedStage = $Stage
    $Result.failureReason = $Reason
  }
  $Result.executionState = 'BLOCKED'
  $Result.boundedCandidateSignal = 'INCONCLUSIVE'
}

function Test-DiscoveryResultVocabulary {
  param([System.Collections.IDictionary]$Result)
  if ($Result.Count -ne $script:ResultVocabulary.Count) { return $false }
  foreach ($key in $script:ResultVocabulary.Keys) {
    if (-not $Result.Contains($key)) { return $false }
    if ($script:ResultVocabulary[$key] -notcontains "$($Result[$key])") { return $false }
  }
  return $true
}

function Format-DiscoveryResultBlock {
  param([System.Collections.IDictionary]$Result)
  if (-not (Test-DiscoveryResultVocabulary -Result $Result)) {
    $Result = New-DiscoveryResult
    $Result.failedStage = 'INTERNAL'
    $Result.failureReason = 'UNEXPECTED'
    $Result.valuesFree = 'FAIL'
  }
  $lines = @('STOCK_PREPARATION_BOUNDED_DISCOVERY')
  foreach ($key in $script:ResultVocabulary.Keys) {
    $lines += "$key=$($Result[$key])"
  }
  return ($lines -join [Environment]::NewLine)
}

function Get-PropertyValue {
  param(
    $Object,
    [string]$Name,
    $DefaultValue = $null
  )
  if ($null -eq $Object) { return $DefaultValue }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $DefaultValue }
  return $property.Value
}

function Assert-SafeIdentifier {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw 'IDENTIFIER_INVALID'
  }
}

function ConvertTo-QuotedIdentifier {
  param([string]$Value)
  Assert-SafeIdentifier -Value $Value
  return '[' + ($Value -replace ']', ']]') + ']'
}

function ConvertTo-QuotedSource {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'SOURCE_INVALID' }
  $parts = @($Value.Split('.'))
  if ($parts.Count -lt 1 -or $parts.Count -gt 2) { throw 'SOURCE_INVALID' }
  return (($parts | ForEach-Object { ConvertTo-QuotedIdentifier -Value $_ }) -join '.')
}

function ConvertTo-StrictBoolean {
  param($Value)
  if ($Value -is [bool]) { return [bool]$Value }
  switch (([string]$Value).Trim().ToLowerInvariant()) {
    'true' { return $true }
    '1' { return $true }
    'yes' { return $true }
    'false' { return $false }
    '0' { return $false }
    'no' { return $false }
    default { throw 'BOOLEAN_INVALID' }
  }
}

function ConvertTo-ProbeFilterValue {
  param(
    [string]$RawValue,
    [string]$ValueType
  )
  if ([string]::IsNullOrEmpty($RawValue)) { throw 'FILTER_VALUE_INVALID' }
  switch ($ValueType) {
    'STRING' { return $RawValue }
    'INT64' {
      $parsed = 0L
      if (-not [long]::TryParse(
        $RawValue,
        [System.Globalization.NumberStyles]::Integer,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [ref]$parsed
      )) { throw 'FILTER_VALUE_INVALID' }
      return $parsed
    }
    'BOOLEAN' { return ConvertTo-StrictBoolean -Value $RawValue }
    default { throw 'FILTER_VALUE_INVALID' }
  }
}

function Test-IsReparsePoint {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force
  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Read-ProbeConfig {
  param(
    [string]$Path,
    [string]$RequestedObjectId,
    [string]$RequestedFilterField
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Test-IsReparsePoint -Path $Path)) {
    throw 'CONFIG_INVALID'
  }
  $raw = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  Assert-SafeIdentifier -Value $RequestedObjectId
  Assert-SafeIdentifier -Value $RequestedFilterField

  $listenHost = [string](Get-PropertyValue -Object $raw.listen -Name 'host' -DefaultValue '127.0.0.1')
  $listenPort = [int](Get-PropertyValue -Object $raw.listen -Name 'port' -DefaultValue 19091)
  if ($listenHost -notin @('127.0.0.1', 'localhost') -or $listenPort -lt 1 -or $listenPort -gt 65535) {
    throw 'CONFIG_INVALID'
  }

  $sampleLimit = [int](Get-PropertyValue -Object $raw.limits -Name 'sampleLimit' -DefaultValue 3)
  $maxLimit = [int](Get-PropertyValue -Object $raw.limits -Name 'maxLimit' -DefaultValue 20)
  if ($sampleLimit -lt 1 -or $maxLimit -lt $sampleLimit -or $maxLimit -gt 500) {
    throw 'CONFIG_INVALID'
  }

  $objectProperty = if ($null -eq $raw.objects) { $null } else {
    $raw.objects.PSObject.Properties[$RequestedObjectId]
  }
  if ($null -eq $objectProperty) { throw 'OBJECT_NOT_ALLOWLISTED' }
  $objectConfig = $objectProperty.Value
  $source = [string](Get-PropertyValue -Object $objectConfig -Name 'source' -DefaultValue '')
  [void](ConvertTo-QuotedSource -Value $source)
  $fieldNames = @()
  $fields = Get-PropertyValue -Object $objectConfig -Name 'fields' -DefaultValue $null
  if ($null -ne $fields) {
    foreach ($field in @($fields)) {
      $fieldName = [string](Get-PropertyValue -Object $field -Name 'name' -DefaultValue '')
      Assert-SafeIdentifier -Value $fieldName
      $fieldNames += $fieldName
    }
  } else {
    foreach ($column in @(Get-PropertyValue -Object $objectConfig -Name 'columns' -DefaultValue @())) {
      $fieldName = [string]$column
      Assert-SafeIdentifier -Value $fieldName
      $fieldNames += $fieldName
    }
  }
  if ($fieldNames.Count -eq 0 -or $fieldNames -notcontains $RequestedFilterField) {
    throw 'FILTER_NOT_ALLOWLISTED'
  }

  $database = $raw.database
  if ($null -eq $database) { throw 'CONFIG_INVALID' }
  $server = [string](Get-PropertyValue -Object $database -Name 'server' -DefaultValue '')
  $databaseName = [string](Get-PropertyValue -Object $database -Name 'database' -DefaultValue '')
  if ([string]::IsNullOrWhiteSpace($server) -or [string]::IsNullOrWhiteSpace($databaseName)) {
    throw 'CONFIG_INVALID'
  }
  $integratedSecurity = ConvertTo-StrictBoolean -Value (
    Get-PropertyValue -Object $database -Name 'integratedSecurity' -DefaultValue $false
  )
  if ($integratedSecurity) { throw 'SOURCE_PRINCIPAL_PARITY_UNPROVEN' }
  $usernameEnvVar = [string](Get-PropertyValue -Object $database -Name 'usernameEnvVar' -DefaultValue '')
  $passwordEnvVar = [string](Get-PropertyValue -Object $database -Name 'passwordEnvVar' -DefaultValue '')
  if (
    [string]::IsNullOrWhiteSpace($usernameEnvVar) -or
    [string]::IsNullOrWhiteSpace($passwordEnvVar)
  ) { throw 'CONFIG_INVALID' }

  $connectTimeoutSec = [int](Get-PropertyValue -Object $database -Name 'connectTimeoutSec' -DefaultValue 8)
  $queryTimeoutSec = [int](Get-PropertyValue -Object $database -Name 'queryTimeoutSec' -DefaultValue 15)
  if ($connectTimeoutSec -lt 1 -or $connectTimeoutSec -gt 120) { throw 'CONFIG_INVALID' }
  if ($queryTimeoutSec -lt 1 -or $queryTimeoutSec -gt 300) { throw 'CONFIG_INVALID' }

  $authMode = [string](Get-PropertyValue -Object $raw.auth -Name 'mode' -DefaultValue 'shared-secret-header')
  $authHeaderName = [string](
    Get-PropertyValue -Object $raw.auth -Name 'headerName' -DefaultValue 'X-MetaSheet-Bridge-Secret'
  )
  $authSecretEnvVar = [string](Get-PropertyValue -Object $raw.auth -Name 'sharedSecretEnvVar' -DefaultValue '')
  if ($authMode -notin @('shared-secret-header', 'none')) { throw 'CONFIG_INVALID' }
  if ($authMode -eq 'shared-secret-header' -and (
    [string]::IsNullOrWhiteSpace($authHeaderName) -or
    [string]::IsNullOrWhiteSpace($authSecretEnvVar)
  )) { throw 'CONFIG_INVALID' }

  return [ordered]@{
    bridgeBaseUrl = "http://${listenHost}:$listenPort"
    auth = [ordered]@{
      mode = $authMode
      headerName = $authHeaderName
      secretEnvVar = $authSecretEnvVar
    }
    database = [ordered]@{
      server = $server
      database = $databaseName
      integratedSecurity = $integratedSecurity
      usernameEnvVar = $usernameEnvVar
      passwordEnvVar = $passwordEnvVar
      connectTimeoutSec = $connectTimeoutSec
      queryTimeoutSec = $queryTimeoutSec
      encrypt = ConvertTo-StrictBoolean -Value (
        Get-PropertyValue -Object $database -Name 'encrypt' -DefaultValue $false
      )
      trustServerCertificate = ConvertTo-StrictBoolean -Value (
        Get-PropertyValue -Object $database -Name 'trustServerCertificate' -DefaultValue $true
      )
    }
    objectId = $RequestedObjectId
    source = $source
    filterField = $RequestedFilterField
    limit = $maxLimit
  }
}

function New-ProbeConnectionString {
  param(
    $Config,
    [string]$Username,
    [string]$Password
  )
  $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $builder['Data Source'] = $Config.database.server
  $builder['Initial Catalog'] = $Config.database.database
  $builder['Connect Timeout'] = $Config.database.connectTimeoutSec
  $builder['Application Name'] = 'MetaSheetBoundedCandidateDiscovery'
  $builder['Encrypt'] = [bool]$Config.database.encrypt
  $builder['TrustServerCertificate'] = [bool]$Config.database.trustServerCertificate
  $builder['User ID'] = $Username
  $builder['Password'] = $Password
  return $builder.ConnectionString
}

function New-SamePredicateCountSpec {
  param(
    $Config,
    $FilterValue
  )
  $source = ConvertTo-QuotedSource -Value $Config.source
  $field = ConvertTo-QuotedIdentifier -Value $Config.filterField
  return [ordered]@{
    sql = (
      "SELECT COUNT_BIG(1) FROM (SELECT TOP (@p1) 1 AS [probe_marker] " +
      "FROM $source WHERE $field = @p0) AS [bounded_probe]"
    )
    parameters = @(
      [ordered]@{ name = '@p0'; value = $FilterValue },
      [ordered]@{ name = '@p1'; value = ([long]$Config.limit + 1L) }
    )
  }
}

function Open-ProbeSqlConnection {
  param(
    $Config,
    [string]$Username,
    [string]$Password
  )
  Add-Type -AssemblyName System.Data
  $connectionString = New-ProbeConnectionString `
    -Config $Config `
    -Username $Username `
    -Password $Password
  $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
  try {
    $connection.Open()
    return $connection
  } catch {
    $connection.Dispose()
    throw
  }
}

function Invoke-ProbeCountCommand {
  param(
    $Connection,
    $Config,
    $FilterValue
  )
  $spec = New-SamePredicateCountSpec -Config $Config -FilterValue $FilterValue
  $command = $Connection.CreateCommand()
  $command.CommandType = [System.Data.CommandType]::Text
  $command.CommandTimeout = $Config.database.queryTimeoutSec
  $command.CommandText = $spec.sql
  foreach ($parameter in @($spec.parameters)) {
    [void]$command.Parameters.AddWithValue($parameter.name, $parameter.value)
  }
  return $command.ExecuteScalar()
}

function Resolve-SourceCountFailureClass {
  param([int[]]$ErrorNumbers)
  foreach ($className in $script:SourceCountFailureNumberSets.Keys) {
    foreach ($number in @($ErrorNumbers)) {
      if ($script:SourceCountFailureNumberSets[$className] -contains $number) {
        return $className
      }
    }
  }
  return 'OTHER'
}

function Get-SourceCountFailureClass {
  param($ErrorRecord)
  try {
    $numbers = @()
    $current = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) {
      $ErrorRecord.Exception
    } else {
      $ErrorRecord
    }
    for ($depth = 0; $depth -lt 8 -and $null -ne $current; $depth += 1) {
      if ($current -is [System.Data.SqlClient.SqlException]) {
        $countBeforeCurrentException = $numbers.Count
        foreach ($sqlError in @($current.Errors)) {
          $numbers += [int]$sqlError.Number
        }
        if ($numbers.Count -eq $countBeforeCurrentException) {
          $numbers += [int]$current.Number
        }
      }
      if (-not ($current -is [System.Exception])) { break }
      $current = $current.InnerException
    }
    return Resolve-SourceCountFailureClass -ErrorNumbers $numbers
  } catch {
    return 'OTHER'
  }
}

function Close-ProbeSqlConnection {
  param($Connection)
  $Connection.Close()
  $Connection.Dispose()
}

function New-SourceCountObservation {
  return [ordered]@{
    state = 'BLOCKED'
    failureReason = 'SOURCE_COUNT_RESULT_INVALID'
    count = $null
    sourceCredentialEnv = 'NOT_RUN'
    sourceConnectionAttempted = 'NO'
    sourceConnection = 'NOT_RUN'
    sourceCountStatementAttempted = 'NO'
    sourceCountStatement = 'NOT_RUN'
    sourceCountFailureClass = 'NOT_RUN'
    sourceCountResult = 'NOT_RUN'
  }
}

function Test-SourceCountObservation {
  param($Observation)
  if ($null -eq $Observation -or -not ($Observation -is [System.Collections.IDictionary])) {
    return $false
  }
  $keys = @(
    'state', 'failureReason', 'count', 'sourceCredentialEnv',
    'sourceConnectionAttempted', 'sourceConnection',
    'sourceCountStatementAttempted', 'sourceCountStatement', 'sourceCountFailureClass',
    'sourceCountResult'
  )
  if ($Observation.Keys.Count -ne $keys.Count) { return $false }
  foreach ($key in $keys) {
    if (-not $Observation.Contains($key)) { return $false }
  }

  $isSuccess = (
    $Observation.state -eq 'COMPLETE' -and
    $Observation.failureReason -eq 'NONE' -and
    $Observation['count'] -is [long] -and
    [long]$Observation['count'] -ge 0 -and
    $Observation.sourceCredentialEnv -eq 'PASS' -and
    $Observation.sourceConnectionAttempted -eq 'YES' -and
    $Observation.sourceConnection -eq 'PASS' -and
    $Observation.sourceCountStatementAttempted -eq 'YES' -and
    $Observation.sourceCountStatement -eq 'PASS' -and
    $Observation.sourceCountFailureClass -eq 'NONE' -and
    $Observation.sourceCountResult -eq 'PASS'
  )
  if ($isSuccess) { return $true }
  if ($Observation.state -ne 'BLOCKED' -or $null -ne $Observation['count']) { return $false }

  switch ($Observation.failureReason) {
    'SOURCE_CREDENTIAL_UNAVAILABLE' {
      return (
        $Observation.sourceCredentialEnv -eq 'FAIL' -and
        $Observation.sourceConnectionAttempted -eq 'NO' -and
        $Observation.sourceConnection -eq 'NOT_RUN' -and
        $Observation.sourceCountStatementAttempted -eq 'NO' -and
        $Observation.sourceCountStatement -eq 'NOT_RUN' -and
        $Observation.sourceCountFailureClass -eq 'NOT_RUN' -and
        $Observation.sourceCountResult -eq 'NOT_RUN'
      )
    }
    'SOURCE_CONNECTION_FAILED' {
      return (
        $Observation.sourceCredentialEnv -eq 'PASS' -and
        $Observation.sourceConnectionAttempted -eq 'YES' -and
        $Observation.sourceConnection -eq 'FAIL' -and
        $Observation.sourceCountStatementAttempted -eq 'NO' -and
        $Observation.sourceCountStatement -eq 'NOT_RUN' -and
        $Observation.sourceCountFailureClass -eq 'NOT_RUN' -and
        $Observation.sourceCountResult -eq 'NOT_RUN'
      )
    }
    'SOURCE_COUNT_STATEMENT_FAILED' {
      return (
        $Observation.sourceCredentialEnv -eq 'PASS' -and
        $Observation.sourceConnectionAttempted -eq 'YES' -and
        $Observation.sourceConnection -eq 'PASS' -and
        $Observation.sourceCountStatementAttempted -eq 'YES' -and
        $Observation.sourceCountStatement -eq 'FAIL' -and
        $script:SourceCountFailureClasses -contains $Observation.sourceCountFailureClass -and
        $Observation.sourceCountResult -eq 'NOT_RUN'
      )
    }
    'SOURCE_COUNT_RESULT_INVALID' {
      return (
        $Observation.sourceCredentialEnv -eq 'PASS' -and
        $Observation.sourceConnectionAttempted -eq 'YES' -and
        $Observation.sourceConnection -eq 'PASS' -and
        $Observation.sourceCountStatementAttempted -eq 'YES' -and
        $Observation.sourceCountStatement -eq 'PASS' -and
        $Observation.sourceCountFailureClass -eq 'NONE' -and
        $Observation.sourceCountResult -eq 'FAIL'
      )
    }
    default { return $false }
  }
}

function Invoke-SamePredicateCount {
  param(
    $Config,
    $FilterValue
  )
  $observation = New-SourceCountObservation
  $username = [Environment]::GetEnvironmentVariable($Config.database.usernameEnvVar)
  $password = [Environment]::GetEnvironmentVariable($Config.database.passwordEnvVar)
  if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrEmpty($password)) {
    $observation.failureReason = 'SOURCE_CREDENTIAL_UNAVAILABLE'
    $observation.sourceCredentialEnv = 'FAIL'
    return $observation
  }
  $observation.sourceCredentialEnv = 'PASS'
  $observation.sourceConnectionAttempted = 'YES'

  $connection = $null
  try {
    try {
      $connection = & $script:SourceConnectionProvider $Config $username $password
      if ($null -eq $connection) { throw 'CONNECTION_INVALID' }
      $observation.sourceConnection = 'PASS'
    } catch {
      $observation.failureReason = 'SOURCE_CONNECTION_FAILED'
      $observation.sourceConnection = 'FAIL'
      return $observation
    }

    $observation.sourceCountStatementAttempted = 'YES'
    try {
      $value = & $script:SourceCountCommandProvider $connection $Config $FilterValue
      $observation.sourceCountStatement = 'PASS'
      $observation.sourceCountFailureClass = 'NONE'
    } catch {
      $observation.failureReason = 'SOURCE_COUNT_STATEMENT_FAILED'
      $observation.sourceCountStatement = 'FAIL'
      $observation.sourceCountFailureClass = Get-SourceCountFailureClass -ErrorRecord $_
      return $observation
    }

    try {
      if ($null -eq $value -or $value -is [System.DBNull]) { throw 'COUNT_INVALID' }
      if (-not ($value -is [long])) { throw 'COUNT_INVALID' }
      $count = [long]$value
      if ($count -lt 0) { throw 'COUNT_INVALID' }
      $observation.state = 'COMPLETE'
      $observation.failureReason = 'NONE'
      $observation['count'] = $count
      $observation.sourceCountResult = 'PASS'
      return $observation
    } catch {
      $observation.failureReason = 'SOURCE_COUNT_RESULT_INVALID'
      $observation.sourceCountResult = 'FAIL'
      return $observation
    }
  } finally {
    if ($null -ne $connection) {
      & $script:SourceConnectionCleanupProvider $connection
    }
  }
}

function ConvertFrom-BridgePagePayload {
  param(
    $Payload,
    $Config
  )
  $objectProperty = $Payload.PSObject.Properties['object']
  $recordsProperty = $Payload.PSObject.Properties['records']
  $limitProperty = $Payload.PSObject.Properties['limit']
  $filtersAppliedProperty = $Payload.PSObject.Properties['filtersApplied']
  if ($null -eq $objectProperty -or
    -not ($objectProperty.Value -is [string]) -or
    [string]$objectProperty.Value -cne [string]$Config.objectId -or
    $null -eq $recordsProperty -or
    -not ($recordsProperty.Value -is [System.Array]) -or
    $null -eq $limitProperty -or
    $null -eq $filtersAppliedProperty) {
    throw 'BRIDGE_RESPONSE_INVALID'
  }
  if (-not ($filtersAppliedProperty.Value -is [bool])) { throw 'BRIDGE_RESPONSE_INVALID' }
  if (-not (
    $limitProperty.Value -is [int] -or
    $limitProperty.Value -is [long]
  )) { throw 'BRIDGE_RESPONSE_INVALID' }
  $rawLimit = [long]$limitProperty.Value
  if ($rawLimit -lt 1 -or $rawLimit -gt 500) { throw 'BRIDGE_RESPONSE_INVALID' }
  $returnedLimit = [int]$rawLimit
  foreach ($record in @($recordsProperty.Value)) {
    if ($null -eq $record -or -not ($record -is [pscustomobject])) {
      throw 'BRIDGE_RESPONSE_INVALID'
    }
  }
  $recordCount = @($recordsProperty.Value).Count
  if ($recordCount -lt 0 -or $recordCount -gt $Config.limit) { throw 'BRIDGE_RESPONSE_INVALID' }
  return [ordered]@{
    filtersApplied = [bool]$filtersAppliedProperty.Value
    limit = $returnedLimit
    recordCount = $recordCount
  }
}

function Invoke-BridgeFilteredPage {
  param(
    $Config,
    $FilterValue
  )
  $headers = @{}
  if ($Config.auth.mode -eq 'shared-secret-header') {
    $secret = [Environment]::GetEnvironmentVariable($Config.auth.secretEnvVar)
    if ([string]::IsNullOrEmpty($secret)) { throw 'BRIDGE_SECRET_UNAVAILABLE' }
    $headers[$Config.auth.headerName] = $secret
  }
  $filters = [ordered]@{}
  $filters[$Config.filterField] = $FilterValue
  $body = [ordered]@{ limit = $Config.limit; filters = $filters } | ConvertTo-Json -Depth 8 -Compress
  $uri = "$($Config.bridgeBaseUrl)/query/$([Uri]::EscapeDataString($Config.objectId))"
  $response = Invoke-WebRequest `
    -Uri $uri `
    -Method Post `
    -Headers $headers `
    -ContentType 'application/json; charset=utf-8' `
    -Body $body `
    -UseBasicParsing `
    -TimeoutSec $Config.database.queryTimeoutSec `
    -MaximumRedirection 0
  if ($response.StatusCode -ne 200) { throw 'BRIDGE_RESPONSE_INVALID' }
  $payload = $response.Content | ConvertFrom-Json
  return ConvertFrom-BridgePagePayload -Payload $payload -Config $Config
}

function Suspend-UnsafePm2Environment {
  $snapshot = @()
  foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $name = [string]$entry.Key
    if ([string]::IsNullOrEmpty($name) -or
      $name.Contains('=') -or
      $script:Pm2EnvironmentAllowlist -contains $name) {
      continue
    }
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
  $oldPreference = $ErrorActionPreference
  $snapshot = @()
  try {
    $snapshot = @(Suspend-UnsafePm2Environment)
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = 0
    $output = @(& pm2 jlist 2>$null)
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    return @{ stdout = $output; exit = $exitCode }
  } catch {
    return @{ stdout = @(); exit = 1 }
  } finally {
    $ErrorActionPreference = $oldPreference
    Restore-Pm2Environment -Snapshot $snapshot
  }
}

function Get-Pm2FlagOffSample {
  param([string]$HelperPath)
  $pm2Result = Invoke-Pm2NativeCapture
  if ($pm2Result.exit -ne 0 -or @($pm2Result.stdout).Count -eq 0) { return $null }
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = 0
    $safeJson = @(@($pm2Result.stdout) | & node $HelperPath 2>$null)
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    if ($exitCode -ne 0 -or $safeJson.Count -eq 0) { return $null }
    $entry = $safeJson | ConvertFrom-Json
    foreach ($name in @('authTokenNonEmpty', 'adminTokenNonEmpty', 'plmAutoPersistEnabledTrue')) {
      $property = $entry.PSObject.Properties[$name]
      if ($null -eq $property -or -not ($property.Value -is [bool])) { return $null }
    }
    return [pscustomobject]@{
      state = [string]$entry.state
      authTokenNonEmpty = [bool]$entry.authTokenNonEmpty
      adminTokenNonEmpty = [bool]$entry.adminTokenNonEmpty
      plmAutoPersistEnabledTrue = [bool]$entry.plmAutoPersistEnabledTrue
    }
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $oldPreference
  }
}

$script:SourceConnectionProvider = {
  param($Config, $Username, $Password)
  Open-ProbeSqlConnection -Config $Config -Username $Username -Password $Password
}
$script:SourceCountCommandProvider = {
  param($Connection, $Config, $Value)
  Invoke-ProbeCountCommand -Connection $Connection -Config $Config -FilterValue $Value
}
$script:SourceConnectionCleanupProvider = {
  param($Connection)
  Close-ProbeSqlConnection -Connection $Connection
}
$script:Pm2SampleProvider = { param($HelperPath) Get-Pm2FlagOffSample -HelperPath $HelperPath }
$script:CountProvider = { param($Config, $Value) Invoke-SamePredicateCount -Config $Config -FilterValue $Value }
$script:BridgePageProvider = { param($Config, $Value) Invoke-BridgeFilteredPage -Config $Config -FilterValue $Value }

function Invoke-BoundedCandidateDiscovery {
  param(
    [string]$BridgeConfigPath,
    [string]$RequestedObjectId,
    [string]$RequestedFilterField,
    [string]$RequestedFilterValueType,
    [string]$RequestedFilterValueEnvVar,
    [string]$Root
  )
  $result = New-DiscoveryResult
  $filterCarrierAccepted = $false
  try {
    if ($script:ProbeRunCount -ne 0) {
      Set-DiscoveryFailure -Result $result -Stage 'PRECONDITION' -Reason 'INPUT_INVALID'
      return $result
    }
    if ($RequestedFilterValueEnvVar -notmatch '^METASHEET_DISCOVERY_FILTER_[A-Z0-9_]{1,48}$') {
      Set-DiscoveryFailure -Result $result -Stage 'INPUT_VALIDATE' -Reason 'INPUT_INVALID'
      return $result
    }
    $filterCarrierAccepted = $true

    $helperPath = Join-Path $Root $script:Pm2HelperName
    try {
      if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf) -or
        (Test-IsReparsePoint -Path $helperPath) -or
        (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $script:Pm2HelperSha256) {
        throw 'PM2_HELPER_INVALID'
      }
    } catch {
      Set-DiscoveryFailure -Result $result -Stage 'PRECONDITION' -Reason 'PM2_HELPER_INVALID'
      return $result
    }

    $pm2Sample = & $script:Pm2SampleProvider $helperPath
    if ($null -eq $pm2Sample) {
      Set-DiscoveryFailure -Result $result -Stage 'PM2_CHECK' -Reason 'PM2_SAMPLE_INVALID'
      return $result
    }
    if ($pm2Sample.state -ne 'online') {
      Set-DiscoveryFailure -Result $result -Stage 'PM2_CHECK' -Reason 'PM2_NOT_ONLINE'
      return $result
    }
    if ($pm2Sample.authTokenNonEmpty -or $pm2Sample.adminTokenNonEmpty) {
      Set-DiscoveryFailure -Result $result -Stage 'PM2_CHECK' -Reason 'PM2_TOKEN_PRESENT'
      return $result
    }
    if ($pm2Sample.plmAutoPersistEnabledTrue) {
      Set-DiscoveryFailure -Result $result -Stage 'PM2_CHECK' -Reason 'PM2_FLAG_NOT_OFF'
      return $result
    }
    $result.flagStateOff = 'PASS'

    try {
      $config = Read-ProbeConfig `
        -Path $BridgeConfigPath `
        -RequestedObjectId $RequestedObjectId `
        -RequestedFilterField $RequestedFilterField
    } catch {
      $reason = if ($_.Exception.Message -eq 'OBJECT_NOT_ALLOWLISTED') {
        'OBJECT_NOT_ALLOWLISTED'
      } elseif ($_.Exception.Message -eq 'FILTER_NOT_ALLOWLISTED') {
        'FILTER_NOT_ALLOWLISTED'
      } elseif ($_.Exception.Message -eq 'SOURCE_PRINCIPAL_PARITY_UNPROVEN') {
        'SOURCE_PRINCIPAL_PARITY_UNPROVEN'
      } else {
        'CONFIG_INVALID'
      }
      Set-DiscoveryFailure -Result $result -Stage 'CONFIG_READ' -Reason $reason
      return $result
    }

    $rawFilterValue = [Environment]::GetEnvironmentVariable($RequestedFilterValueEnvVar)
    if ([string]::IsNullOrEmpty($rawFilterValue)) {
      Set-DiscoveryFailure -Result $result -Stage 'INPUT_VALIDATE' -Reason 'FILTER_VALUE_UNAVAILABLE'
      return $result
    }
    try {
      $filterValue = ConvertTo-ProbeFilterValue -RawValue $rawFilterValue -ValueType $RequestedFilterValueType
    } catch {
      Set-DiscoveryFailure -Result $result -Stage 'INPUT_VALIDATE' -Reason 'INPUT_INVALID'
      return $result
    }

    $script:ProbeRunCount += 1
    $result.probeRunCount = 'ONE'
    try {
      $countObservation = & $script:CountProvider $config $filterValue
      if (-not (Test-SourceCountObservation -Observation $countObservation)) {
        throw 'SOURCE_COUNT_OBSERVATION_INVALID'
      }
    } catch {
      Set-DiscoveryFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
      return $result
    }
    foreach ($name in @(
      'sourceCredentialEnv', 'sourceConnectionAttempted', 'sourceConnection',
      'sourceCountStatementAttempted', 'sourceCountStatement', 'sourceCountFailureClass',
      'sourceCountResult'
    )) {
      $result[$name] = $countObservation[$name]
    }
    if ($countObservation.state -eq 'BLOCKED') {
      $result.samePredicateCount = 'FAIL'
      Set-DiscoveryFailure `
        -Result $result `
        -Stage 'SOURCE_COUNT' `
        -Reason $countObservation.failureReason
      return $result
    }
    $count = [long]$countObservation['count']
    $result.samePredicateCount = 'PASS'

    try {
      $page = & $script:BridgePageProvider $config $filterValue
    } catch {
      Set-DiscoveryFailure -Result $result -Stage 'BRIDGE_QUERY' -Reason 'BRIDGE_QUERY_FAILED'
      return $result
    }
    if ($null -eq $page) {
      Set-DiscoveryFailure -Result $result -Stage 'BRIDGE_QUERY' -Reason 'BRIDGE_RESULT_INVALID'
      return $result
    }
    if (-not [bool]$page.filtersApplied) {
      $result.filtersApplied = 'FAIL'
      Set-DiscoveryFailure -Result $result -Stage 'BRIDGE_QUERY' -Reason 'BRIDGE_FILTER_UNCONFIRMED'
      return $result
    }
    $result.filtersApplied = 'PASS'
    if ([int]$page.limit -ne [int]$config.limit) {
      $result.appliedLimitEcho = 'FAIL'
      Set-DiscoveryFailure -Result $result -Stage 'BRIDGE_QUERY' -Reason 'BRIDGE_LIMIT_UNCONFIRMED'
      return $result
    }
    $result.appliedLimitEcho = 'PASS'

    $pageCount = [int]$page.recordCount
    if ($pageCount -lt 0 -or $pageCount -gt [int]$config.limit) {
      Set-DiscoveryFailure -Result $result -Stage 'BRIDGE_QUERY' -Reason 'BRIDGE_RESULT_INVALID'
      return $result
    }
    $result.pageRelationToLimit = if ($pageCount -lt [int]$config.limit) { 'LT' } else { 'EQ' }
    $result.countRelationToLimit = if ($count -lt [long]$config.limit) {
      'LT'
    } elseif ($count -eq [long]$config.limit) {
      'EQ'
    } else {
      'GT'
    }
    $expectedPageCount = [Math]::Min([long]$config.limit, $count)
    if ([long]$pageCount -ne $expectedPageCount) {
      $result.countMatchesExpectedPage = 'FAIL'
      Set-DiscoveryFailure -Result $result -Stage 'CONSISTENCY_CHECK' -Reason 'OBSERVATION_MISMATCH'
      return $result
    }
    $result.countMatchesExpectedPage = 'PASS'
    $result.boundedCandidateSignal = if ($count -eq 0) {
      'EMPTY'
    } elseif ($count -lt [long]$config.limit) {
      'POSSIBLE'
    } else {
      'NOT_BOUNDED'
    }
    $result.executionState = 'COMPLETE'
    $result.failedStage = 'NONE'
    $result.failureReason = 'NONE'
    return $result
  } catch {
    Set-DiscoveryFailure -Result $result -Stage 'INTERNAL' -Reason 'UNEXPECTED'
    return $result
  } finally {
    if (-not $filterCarrierAccepted) {
      $result.filterInputScrubbed = 'PASS'
    } else {
      try {
        [Environment]::SetEnvironmentVariable($RequestedFilterValueEnvVar, $null, 'Process')
        if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($RequestedFilterValueEnvVar))) {
          $result.filterInputScrubbed = 'PASS'
        } else {
          Set-DiscoveryFailure -Result $result -Stage 'CLEANUP' -Reason 'FILTER_INPUT_SCRUB_FAILED' -SafetyCritical
        }
      } catch {
        Set-DiscoveryFailure -Result $result -Stage 'CLEANUP' -Reason 'FILTER_INPUT_SCRUB_FAILED' -SafetyCritical
      }
    }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $result = Invoke-BoundedCandidateDiscovery `
    -BridgeConfigPath $ConfigPath `
    -RequestedObjectId $ObjectId `
    -RequestedFilterField $FilterField `
    -RequestedFilterValueType $FilterValueType `
    -RequestedFilterValueEnvVar $FilterValueEnvVar `
    -Root $SidecarDir
  [Console]::Out.WriteLine((Format-DiscoveryResultBlock -Result $result))
  if ($result.executionState -eq 'COMPLETE') { exit 0 }
  exit 2
}
