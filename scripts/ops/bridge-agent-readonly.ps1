#requires -Version 5.0
<#
.SYNOPSIS
  MetaSheet legacy SQL readonly Bridge Agent (BA-M1 MVP).

.DESCRIPTION
  Standalone localhost-only HTTP/JSON bridge for legacy SQL Server sources.
  The agent uses .NET Framework System.Data.SqlClient from Windows PowerShell
  5.1, keeps credentials in local environment variables, exposes only
  allowlisted objects/fields, and never accepts raw SQL.

  Endpoints:
    GET  /health
    GET  /objects
    GET  /schema/<object>
    POST /query/<object>

  This script intentionally does not integrate with plugin-integration-core.
  MetaSheet product integration is a later BA-M2 step after this runtime
  contract is reviewed on the bridge host.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,

  [switch]$ValidateConfigOnly
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName System.Data

function ConvertTo-RedactedText {
  param(
    [string]$Value,
    [string]$Username = ''
  )

  if ([string]::IsNullOrEmpty($Value)) { return $Value }

  $redactedLogin = '<redacted-login>'
  $patterns = @(
    '(?i)(Password|Pwd)\s*=\s*[^;""'']+',
    '(?i)(User\s*ID|UID|User)\s*=\s*[^;""'']+',
    '(?i)(Data Source|Server|Address|Network Address)\s*=\s*[^;""'']+',
    '(?i)(Initial Catalog|Database)\s*=\s*[^;""'']+',
    '(?i)(Secret|Token|Authorization)\s*[:=]\s*[^;""''\s]+',
    '(?i)Bearer\s+[A-Za-z0-9._~+/=-]{8,}',
    'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
  )

  $redacted = $Value
  foreach ($pattern in $patterns) {
    $redacted = [System.Text.RegularExpressions.Regex]::Replace($redacted, $pattern, '<redacted>')
  }

  $quotePattern = "[`"']"
  $redacted = [System.Text.RegularExpressions.Regex]::Replace(
    $redacted,
    "(?i)(Login failed for user\s+$quotePattern)([^`"']+)($quotePattern)",
    '${1}' + $redactedLogin + '${3}'
  )
  $redacted = [System.Text.RegularExpressions.Regex]::Replace(
    $redacted,
    "((?:用户|使用者|登入名|登录名)\s*$quotePattern)([^`"']+)($quotePattern\s*(?:登录失败|登入失敗|login failed))",
    '${1}' + $redactedLogin + '${3}'
  )

  if (-not [string]::IsNullOrEmpty($Username)) {
    $escapedUsername = [System.Text.RegularExpressions.Regex]::Escape($Username)
    $redacted = [System.Text.RegularExpressions.Regex]::Replace(
      $redacted,
      "($quotePattern)$escapedUsername($quotePattern)",
      '${1}' + $redactedLogin + '${2}',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
  }

  return $redacted
}

function ConvertTo-BridgeError {
  param(
    [System.Exception]$Exception,
    [string]$Username = ''
  )

  $messages = New-Object System.Collections.Generic.List[string]
  $current = $Exception
  $depth = 0
  while ($null -ne $current -and $depth -lt 8) {
    if (-not [string]::IsNullOrWhiteSpace($current.Message)) {
      $messages.Add($current.Message)
    }
    if ($null -ne $current.Data -and $current.Data.Count -gt 0) {
      foreach ($key in $current.Data.Keys) {
        $keyText = [string]$key
        $valueText = [string]$current.Data[$key]
        if ($keyText -match '(?i)password|pwd|secret|token|user|uid|server|database|catalog|connection|string|host') {
          $messages.Add("data[$keyText]=<redacted>")
        } else {
          $messages.Add("data[$keyText]=" + (ConvertTo-RedactedText -Value $valueText -Username $Username))
        }
      }
    }
    $current = $current.InnerException
    $depth++
  }

  return [ordered]@{
    code    = 'BRIDGE_AGENT_ERROR'
    message = ConvertTo-RedactedText -Value (($messages -join "`n").Trim()) -Username $Username
  }
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Config file not found: $Path"
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Assert-Name {
  param(
    [string]$Name,
    [string]$Label
  )
  if ([string]::IsNullOrWhiteSpace($Name)) {
    throw "$Label is required"
  }
  if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "$Label contains unsupported characters: $Name"
  }
}

function ConvertTo-QuotedIdentifier {
  param([string]$Name)
  Assert-Name -Name $Name -Label 'SQL identifier'
  return '[' + ($Name -replace ']', ']]') + ']'
}

function ConvertTo-QuotedSource {
  param([string]$Source)
  if ([string]::IsNullOrWhiteSpace($Source)) {
    throw 'Object source is required'
  }
  $parts = $Source.Split('.')
  if ($parts.Count -gt 2) {
    throw "Object source must be a table/view name or schema-qualified table/view: $Source"
  }
  $quoted = @()
  foreach ($part in $parts) {
    $quoted += ConvertTo-QuotedIdentifier -Name $part
  }
  return ($quoted -join '.')
}

function ConvertTo-Boolean {
  param(
    $Value,
    [bool]$DefaultValue = $false
  )
  if ($null -eq $Value) { return $DefaultValue }
  if ($Value -is [bool]) { return [bool]$Value }
  $text = ([string]$Value).Trim().ToLowerInvariant()
  switch ($text) {
    'true' { return $true }
    '1' { return $true }
    'yes' { return $true }
    'false' { return $false }
    '0' { return $false }
    'no' { return $false }
    default { throw "Invalid boolean value: $Value" }
  }
}

function Get-ObjectProperties {
  param($Object)
  if ($null -eq $Object) { return @() }
  return @($Object.PSObject.Properties)
}

function Get-ConfigValue {
  param(
    $Object,
    [string]$Name,
    $DefaultValue = $null
  )
  if ($null -eq $Object) { return $DefaultValue }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $DefaultValue }
  if ($null -eq $property.Value) { return $DefaultValue }
  return $property.Value
}

function Resolve-BridgeConfig {
  param($Raw)

  $hostName = [string](Get-ConfigValue -Object $Raw.listen -Name 'host' -DefaultValue '127.0.0.1')
  $port = [int](Get-ConfigValue -Object $Raw.listen -Name 'port' -DefaultValue 19091)
  if ($hostName -notin @('127.0.0.1', 'localhost')) {
    throw 'BA-M1 MVP only supports localhost binding. Use 127.0.0.1 or localhost.'
  }
  if ($port -lt 1 -or $port -gt 65535) {
    throw "Invalid listen port: $port"
  }

  $database = $Raw.database
  if ($null -eq $database) { throw 'database config is required' }
  $server = [string](Get-ConfigValue -Object $database -Name 'server' -DefaultValue '')
  $dbName = [string](Get-ConfigValue -Object $database -Name 'database' -DefaultValue '')
  if ([string]::IsNullOrWhiteSpace($server)) { throw 'database.server is required' }
  if ([string]::IsNullOrWhiteSpace($dbName)) { throw 'database.database is required' }

  $integratedSecurity = ConvertTo-Boolean -Value (Get-ConfigValue -Object $database -Name 'integratedSecurity' -DefaultValue $false)
  $usernameEnvVar = [string](Get-ConfigValue -Object $database -Name 'usernameEnvVar' -DefaultValue '')
  $passwordEnvVar = [string](Get-ConfigValue -Object $database -Name 'passwordEnvVar' -DefaultValue '')
  if (-not $integratedSecurity) {
    if ([string]::IsNullOrWhiteSpace($usernameEnvVar)) { throw 'database.usernameEnvVar is required when integratedSecurity=false' }
    if ([string]::IsNullOrWhiteSpace($passwordEnvVar)) { throw 'database.passwordEnvVar is required when integratedSecurity=false' }
  }
  $connectTimeoutSec = [int](Get-ConfigValue -Object $database -Name 'connectTimeoutSec' -DefaultValue 8)
  $queryTimeoutSec = [int](Get-ConfigValue -Object $database -Name 'queryTimeoutSec' -DefaultValue 15)
  if ($connectTimeoutSec -lt 1 -or $connectTimeoutSec -gt 120) {
    throw 'database.connectTimeoutSec must be between 1 and 120'
  }
  if ($queryTimeoutSec -lt 1 -or $queryTimeoutSec -gt 300) {
    throw 'database.queryTimeoutSec must be between 1 and 300'
  }

  $defaultLimit = [int](Get-ConfigValue -Object $Raw.limits -Name 'sampleLimit' -DefaultValue 3)
  $maxLimit = [int](Get-ConfigValue -Object $Raw.limits -Name 'maxLimit' -DefaultValue 20)
  if ($defaultLimit -lt 1) { throw 'limits.sampleLimit must be >= 1' }
  if ($maxLimit -lt $defaultLimit) { throw 'limits.maxLimit must be >= limits.sampleLimit' }
  if ($maxLimit -gt 500) { throw 'limits.maxLimit must be <= 500 for BA-M1 MVP' }

  $objects = @{}
  foreach ($entry in Get-ObjectProperties -Object $Raw.objects) {
    $objectId = [string]$entry.Name
    Assert-Name -Name $objectId -Label 'object id'
    $objectConfig = $entry.Value
    $source = [string](Get-ConfigValue -Object $objectConfig -Name 'source' -DefaultValue '')
    [void](ConvertTo-QuotedSource -Source $source)

    $fieldConfigs = @()
    $fields = Get-ConfigValue -Object $objectConfig -Name 'fields' -DefaultValue $null
    if ($null -ne $fields) {
      foreach ($field in @($fields)) {
        $name = [string](Get-ConfigValue -Object $field -Name 'name' -DefaultValue '')
        Assert-Name -Name $name -Label "field name for $objectId"
        $fieldConfigs += [ordered]@{
          name     = $name
          type     = [string](Get-ConfigValue -Object $field -Name 'type' -DefaultValue 'string')
          required = ConvertTo-Boolean -Value (Get-ConfigValue -Object $field -Name 'required' -DefaultValue $false)
        }
      }
    } else {
      $columns = @(Get-ConfigValue -Object $objectConfig -Name 'columns' -DefaultValue @())
      foreach ($column in $columns) {
        $name = [string]$column
        Assert-Name -Name $name -Label "column name for $objectId"
        $fieldConfigs += [ordered]@{ name = $name; type = 'string'; required = $false }
      }
    }

    if ($fieldConfigs.Count -eq 0) {
      throw "object $objectId must define fields or columns"
    }

    $objects[$objectId] = [ordered]@{
      id       = $objectId
      label    = [string](Get-ConfigValue -Object $objectConfig -Name 'label' -DefaultValue $objectId)
      source   = $source
      keyField = [string](Get-ConfigValue -Object $objectConfig -Name 'keyField' -DefaultValue '')
      fields   = $fieldConfigs
    }
  }
  if ($objects.Count -eq 0) { throw 'objects allowlist cannot be empty' }

  $authMode = [string](Get-ConfigValue -Object $Raw.auth -Name 'mode' -DefaultValue 'shared-secret-header')
  $authHeaderName = [string](Get-ConfigValue -Object $Raw.auth -Name 'headerName' -DefaultValue 'X-MetaSheet-Bridge-Secret')
  $authSecretEnvVar = [string](Get-ConfigValue -Object $Raw.auth -Name 'sharedSecretEnvVar' -DefaultValue '')
  if ($authMode -notin @('shared-secret-header', 'none')) {
    throw "Unsupported auth.mode: $authMode"
  }
  if ($authMode -eq 'shared-secret-header' -and [string]::IsNullOrWhiteSpace($authHeaderName)) {
    throw 'auth.headerName is required for shared-secret-header mode'
  }
  if ($authMode -eq 'shared-secret-header' -and [string]::IsNullOrWhiteSpace($authSecretEnvVar)) {
    throw 'auth.sharedSecretEnvVar is required for shared-secret-header mode'
  }

  return [ordered]@{
    listen = [ordered]@{ host = $hostName; port = $port }
    auth = [ordered]@{
      mode = $authMode
      headerName = $authHeaderName
      sharedSecretEnvVar = $authSecretEnvVar
    }
    database = [ordered]@{
      server = $server
      database = $dbName
      integratedSecurity = $integratedSecurity
      usernameEnvVar = $usernameEnvVar
      passwordEnvVar = $passwordEnvVar
      connectTimeoutSec = $connectTimeoutSec
      queryTimeoutSec = $queryTimeoutSec
      encrypt = ConvertTo-Boolean -Value (Get-ConfigValue -Object $database -Name 'encrypt' -DefaultValue $false)
      trustServerCertificate = ConvertTo-Boolean -Value (Get-ConfigValue -Object $database -Name 'trustServerCertificate' -DefaultValue $true)
    }
    limits = [ordered]@{ sampleLimit = $defaultLimit; maxLimit = $maxLimit }
    objects = $objects
  }
}

function Get-DatabaseUsername {
  param($Config)
  if ($Config.database.integratedSecurity) { return '' }
  $username = [System.Environment]::GetEnvironmentVariable($Config.database.usernameEnvVar)
  if ([string]::IsNullOrWhiteSpace($username)) {
    throw "Environment variable '$($Config.database.usernameEnvVar)' is not set or is empty."
  }
  return $username
}

function New-SqlConnectionString {
  param($Config)

  $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $builder['Data Source'] = $Config.database.server
  $builder['Initial Catalog'] = $Config.database.database
  $builder['Connect Timeout'] = $Config.database.connectTimeoutSec
  $builder['Application Name'] = 'MetaSheetLegacySqlReadonlyBridge'
  $builder['Encrypt'] = [bool]$Config.database.encrypt
  $builder['TrustServerCertificate'] = [bool]$Config.database.trustServerCertificate

  if ($Config.database.integratedSecurity) {
    $builder['Integrated Security'] = $true
  } else {
    $username = Get-DatabaseUsername -Config $Config
    $password = [System.Environment]::GetEnvironmentVariable($Config.database.passwordEnvVar)
    if ([string]::IsNullOrEmpty($password)) {
      throw "Environment variable '$($Config.database.passwordEnvVar)' is not set or is empty."
    }
    $builder['User ID'] = $username
    $builder['Password'] = $password
  }

  return $builder.ConnectionString
}

function Invoke-BridgeSqlQuery {
  param(
    $Config,
    [string]$Sql,
    [array]$Parameters = @()
  )

  $rows = New-Object System.Collections.Generic.List[object]
  $connectionString = New-SqlConnectionString -Config $Config
  $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = $Sql
    $command.CommandType = [System.Data.CommandType]::Text
    $command.CommandTimeout = $Config.database.queryTimeoutSec
    foreach ($parameterSpec in @($Parameters)) {
      $parameterName = [string]$parameterSpec.Name
      if ($parameterName -notmatch '^@p[0-9]+$') {
        throw "Unsafe SQL parameter name: $parameterName"
      }
      $parameterValue = $parameterSpec.Value
      if ($null -eq $parameterValue) { $parameterValue = [System.DBNull]::Value }
      [void]$command.Parameters.AddWithValue($parameterName, $parameterValue)
    }
    $reader = $command.ExecuteReader()
    try {
      while ($reader.Read()) {
        $row = [ordered]@{}
        for ($i = 0; $i -lt $reader.FieldCount; $i++) {
          $name = $reader.GetName($i)
          $value = $reader.GetValue($i)
          if ($value -is [System.DBNull]) { $value = $null }
          $row[$name] = $value
        }
        $rows.Add($row)
      }
    } finally {
      $reader.Close()
    }
  } finally {
    $connection.Close()
    $connection.Dispose()
  }
  return $rows
}

function Test-BridgeConnection {
  param($Config)
  [void](Invoke-BridgeSqlQuery -Config $Config -Sql 'SELECT 1 AS ok')
  return $true
}

function New-ObjectQuerySql {
  param(
    $ObjectConfig,
    [int]$Limit,
    $Filters = $null
  )
  $fieldNames = @($ObjectConfig.fields | ForEach-Object { $_.name })
  $columns = ($fieldNames | ForEach-Object { ConvertTo-QuotedIdentifier -Name $_ }) -join ', '
  $source = ConvertTo-QuotedSource -Source $ObjectConfig.source
  $whereClauses = @()
  $parameters = @()

  if ($null -ne $Filters) {
    $filterProps = @($Filters.PSObject.Properties)
    $index = 0
    foreach ($filter in $filterProps) {
      $fieldName = [string]$filter.Name
      Assert-Name -Name $fieldName -Label 'filter field'
      if ($fieldNames -notcontains $fieldName) {
        throw "filter field is not allowlisted for object $($ObjectConfig.id): $fieldName"
      }
      $value = $filter.Value
      if ($null -eq $value) {
        $whereClauses += "$(ConvertTo-QuotedIdentifier -Name $fieldName) IS NULL"
        continue
      }
      if (-not ($value -is [string] -or $value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [decimal] -or $value -is [bool])) {
        throw "filter value must be a primitive equality value for field $fieldName"
      }
      $parameterName = "@p$index"
      $whereClauses += "$(ConvertTo-QuotedIdentifier -Name $fieldName) = $parameterName"
      $parameters += [ordered]@{ Name = $parameterName; Value = $value }
      $index += 1
    }
  }

  $sql = "SELECT TOP $Limit $columns FROM $source"
  if ($whereClauses.Count -gt 0) {
    $sql += " WHERE " + ($whereClauses -join ' AND ')
  }
  return [ordered]@{ Sql = $sql; Parameters = $parameters }
}

function ConvertTo-JsonResponse {
  param($Value)
  return ($Value | ConvertTo-Json -Depth 20 -Compress)
}

function Send-Json {
  param(
    [System.Net.HttpListenerContext]$Context,
    [int]$StatusCode,
    $Body
  )
  $json = ConvertTo-JsonResponse -Value $Body
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = 'application/json; charset=utf-8'
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

function Read-RequestJson {
  param([System.Net.HttpListenerRequest]$Request)
  if ($Request.HasEntityBody -ne $true) { return $null }
  $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
  try {
    $text = $reader.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
  } finally {
    $reader.Close()
  }
}

function Assert-Authorized {
  param(
    [System.Net.HttpListenerRequest]$Request,
    $Config
  )
  if ($Config.auth.mode -eq 'none') { return }
  if ($Config.auth.mode -ne 'shared-secret-header') {
    throw "Unsupported auth.mode: $($Config.auth.mode)"
  }
  $secretName = $Config.auth.sharedSecretEnvVar
  if ([string]::IsNullOrWhiteSpace($secretName)) {
    throw 'auth.sharedSecretEnvVar is required for shared-secret-header mode'
  }
  $expected = [System.Environment]::GetEnvironmentVariable($secretName)
  if ([string]::IsNullOrEmpty($expected)) {
    throw "Environment variable '$secretName' is not set or is empty."
  }
  $actual = $Request.Headers[$Config.auth.headerName]
  if ([string]::IsNullOrEmpty($actual) -or $actual -ne $expected) {
    $authError = New-Object System.UnauthorizedAccessException('Bridge Agent authentication failed.')
    throw $authError
  }
}

function Invoke-BridgeRequest {
  param(
    [System.Net.HttpListenerContext]$Context,
    $Config
  )

  $request = $Context.Request
  $method = $request.HttpMethod.ToUpperInvariant()
  $path = $request.Url.AbsolutePath.Trim('/')
  $parts = @($path.Split('/') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

  Assert-Authorized -Request $request -Config $Config

  if ($method -eq 'GET' -and $parts.Count -eq 1 -and $parts[0] -eq 'health') {
    $databaseReachable = $false
    $databaseError = $null
    try {
      $databaseReachable = Test-BridgeConnection -Config $Config
    } catch {
      $databaseError = ConvertTo-BridgeError -Exception $_.Exception -Username (Get-DatabaseUsername -Config $Config)
    }
    return [ordered]@{
      status = 200
      body = [ordered]@{
        ok = $true
        service = 'metasheet-legacy-sql-readonly-bridge'
        version = '0.1.0'
        bindHost = $Config.listen.host
        databaseReachable = $databaseReachable
        databaseError = $databaseError
      }
    }
  }

  if ($method -eq 'GET' -and $parts.Count -eq 1 -and $parts[0] -eq 'objects') {
    $objects = @()
    foreach ($key in ($Config.objects.Keys | Sort-Object)) {
      $objectConfig = $Config.objects[$key]
      $objects += [ordered]@{
        id = $objectConfig.id
        label = $objectConfig.label
        readonly = $true
        fieldCount = @($objectConfig.fields).Count
      }
    }
    return [ordered]@{ status = 200; body = [ordered]@{ objects = $objects } }
  }

  if ($method -eq 'GET' -and $parts.Count -eq 2 -and $parts[0] -eq 'schema') {
    $objectId = $parts[1]
    if (-not $Config.objects.Contains($objectId)) {
      return [ordered]@{ status = 404; body = [ordered]@{ error = [ordered]@{ code = 'UNKNOWN_OBJECT'; message = 'Object is not allowlisted.' } } }
    }
    $objectConfig = $Config.objects[$objectId]
    return [ordered]@{
      status = 200
      body = [ordered]@{
        object = $objectId
        fields = @($objectConfig.fields)
      }
    }
  }

  if ($method -eq 'POST' -and $parts.Count -eq 2 -and $parts[0] -eq 'query') {
    $objectId = $parts[1]
    if (-not $Config.objects.Contains($objectId)) {
      return [ordered]@{ status = 404; body = [ordered]@{ error = [ordered]@{ code = 'UNKNOWN_OBJECT'; message = 'Object is not allowlisted.' } } }
    }
    $body = Read-RequestJson -Request $request
    $limit = $Config.limits.sampleLimit
    if ($null -ne $body -and $null -ne $body.PSObject.Properties['limit']) {
      $limit = [int]$body.limit
    }
    if ($limit -lt 1 -or $limit -gt $Config.limits.maxLimit) {
      return [ordered]@{ status = 400; body = [ordered]@{ error = [ordered]@{ code = 'INVALID_LIMIT'; message = "limit must be between 1 and $($Config.limits.maxLimit)." } } }
    }
    if ($null -ne $body -and $null -ne $body.PSObject.Properties['sql']) {
      return [ordered]@{ status = 400; body = [ordered]@{ error = [ordered]@{ code = 'RAW_SQL_REJECTED'; message = 'Raw SQL is not accepted by the readonly Bridge Agent.' } } }
    }

    $objectConfig = $Config.objects[$objectId]
    $filters = $null
    if ($null -ne $body -and $null -ne $body.PSObject.Properties['filters']) {
      $filters = $body.filters
    }
    try {
      $querySpec = New-ObjectQuerySql -ObjectConfig $objectConfig -Limit $limit -Filters $filters
    } catch {
      return [ordered]@{ status = 400; body = [ordered]@{ error = [ordered]@{ code = 'INVALID_FILTERS'; message = 'Filters must be allowlisted primitive equality filters.' } } }
    }
    $rows = Invoke-BridgeSqlQuery -Config $Config -Sql $querySpec.Sql -Parameters $querySpec.Parameters
    return [ordered]@{
      status = 200
      body = [ordered]@{
        object = $objectId
        records = @($rows)
        limit = $limit
        filtersApplied = $null -ne $filters -and @($filters.PSObject.Properties).Count -gt 0
        nextCursor = $null
        done = $true
      }
    }
  }

  return [ordered]@{ status = 404; body = [ordered]@{ error = [ordered]@{ code = 'NOT_FOUND'; message = 'Endpoint not found.' } } }
}

$rawConfig = Read-JsonFile -Path $ConfigPath
$config = Resolve-BridgeConfig -Raw $rawConfig

if ($ValidateConfigOnly) {
  Write-Host '[bridge-agent-readonly] config validation passed'
  exit 0
}

$prefix = "http://$($config.listen.host):$($config.listen.port)/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

Write-Host "[bridge-agent-readonly] starting $prefix"
Write-Host '[bridge-agent-readonly] endpoints: GET /health, GET /objects, GET /schema/<object>, POST /query/<object>'

$listener.Start()
try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      $result = Invoke-BridgeRequest -Context $context -Config $config
      Send-Json -Context $context -StatusCode $result.status -Body $result.body
    } catch [System.UnauthorizedAccessException] {
      Send-Json -Context $context -StatusCode 401 -Body ([ordered]@{ error = [ordered]@{ code = 'UNAUTHORIZED'; message = 'Bridge Agent authentication failed.' } })
    } catch {
      $usernameForRedaction = ''
      try { $usernameForRedaction = Get-DatabaseUsername -Config $config } catch {}
      $errorBody = ConvertTo-BridgeError -Exception $_.Exception -Username $usernameForRedaction
      Send-Json -Context $context -StatusCode 500 -Body ([ordered]@{ error = $errorBody })
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
