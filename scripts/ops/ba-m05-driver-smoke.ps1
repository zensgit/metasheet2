param(
  [ValidateSet('SqlClient', 'Odbc', 'OleDb')]
  [string]$Driver = 'SqlClient',
  [string]$EnvFile = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

# ba-m05-driver-smoke.ps1
#
# BA-M0.5 driver smoke gate for the legacy SQL readonly Bridge Agent plan
# (docs/development/data-factory-legacy-sql-readonly-bridge-agent-plan-20260520.md).
#
# Purpose: prove that the customer-approved SQL client driver can reach the
# legacy SQL Server endpoint and run ONE read-only query, BEFORE any Bridge
# Agent MVP (BA-M1) implementation is started.
#
# This harness:
#   - reads connection parameters from a 0600 env file OUTSIDE the repo;
#   - never accepts a connection string / host / password as a CLI argument;
#   - composes the connection string in-process and never logs it;
#   - runs exactly one query: SELECT @@VERSION;
#   - reads NO business tables and issues NO writes;
#   - emits a redacted JSON + MD evidence pair.
#
# It is intentionally NOT the Bridge Agent. It does not expose HTTP, does not
# touch plugin-integration-core, the MetaSheet runtime, the API, or the DB.
#
# Run on Windows PowerShell 5.1 (built into Windows Server) so the
# System.Data.SqlClient / System.Data.Odbc / System.Data.OleDb providers
# resolve from the .NET Framework GAC.

function Write-SmokeInfo {
  param([string]$Message)
  Write-Output ("[ba-m05-driver-smoke] {0}" -f $Message)
}

function Read-EnvFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "EnvFile not found: $Path. See ba-m05-driver-smoke-runbook.md for the required keys."
  }
  $map = @{}
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) { continue }
    $name = $parts[0].Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $value = $parts[1].Trim()
    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    $map[$name] = $value
  }
  return $map
}

# Redaction: strip anything host/credential-shaped from any text that will be
# written to evidence. Applied to both the @@VERSION echo and error text.
function Protect-Text {
  param(
    [string]$Text,
    [string[]]$Literals
  )
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $out = $Text
  foreach ($lit in $Literals) {
    if (-not [string]::IsNullOrWhiteSpace($lit)) {
      $out = $out.Replace($lit, '<redacted>')
    }
  }
  # IPv4 addresses
  $out = [System.Text.RegularExpressions.Regex]::Replace($out, '\b\d{1,3}(\.\d{1,3}){3}\b', '<redacted-ip>')
  # UNC paths
  $out = [System.Text.RegularExpressions.Regex]::Replace($out, '\\\\[^\s]+', '<redacted-unc>')
  # connection-string-shaped key=value secrets, if any leak into an error
  $out = [System.Text.RegularExpressions.Regex]::Replace($out, '(?i)(password|pwd|user id|uid|server|data source|address|addr|network address)\s*=\s*[^;]+', '$1=<redacted>')
  return $out
}

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  $EnvFile = Join-Path (Get-Location).Path 'ba-m05-driver-smoke.env'
}
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path (Get-Location).Path 'ba-m05-evidence'
}
if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$cfg = Read-EnvFile -Path $EnvFile

$server   = $cfg['BA_M05_SQL_SERVER']
$database = $cfg['BA_M05_SQL_DATABASE']
$auth     = if ($cfg.ContainsKey('BA_M05_SQL_AUTH')) { $cfg['BA_M05_SQL_AUTH'].ToLowerInvariant() } else { 'windows' }
$username = $cfg['BA_M05_SQL_USERNAME']
$password = $cfg['BA_M05_SQL_PASSWORD']
$encrypt  = if ($cfg.ContainsKey('BA_M05_SQL_ENCRYPT')) { $cfg['BA_M05_SQL_ENCRYPT'] } else { '' }
$trust    = if ($cfg.ContainsKey('BA_M05_SQL_TRUST_CERT')) { $cfg['BA_M05_SQL_TRUST_CERT'] } else { '' }
$extra    = $cfg['BA_M05_SQL_EXTRA']

if ([string]::IsNullOrWhiteSpace($server)) {
  throw 'BA_M05_SQL_SERVER is required in the env file.'
}
if ([string]::IsNullOrWhiteSpace($database)) {
  # @@VERSION does not need a user database; default to master.
  $database = 'master'
}

# Literals that must never appear in evidence.
$redactLiterals = @($server, $database, $username, $password) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

# Compose the connection string in-process. It is never logged or written.
function New-SqlClientConnString {
  $sb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $sb['Data Source'] = $server
  $sb['Initial Catalog'] = $database
  $sb['Connect Timeout'] = 15
  if ($auth -eq 'windows') {
    $sb['Integrated Security'] = $true
  } else {
    $sb['User ID'] = $username
    $sb['Password'] = $password
  }
  if (-not [string]::IsNullOrWhiteSpace($encrypt)) { $sb['Encrypt'] = [System.Convert]::ToBoolean($encrypt) }
  if (-not [string]::IsNullOrWhiteSpace($trust)) { $sb['TrustServerCertificate'] = [System.Convert]::ToBoolean($trust) }
  return $sb.ConnectionString
}

function New-KeyValueConnString {
  param([string]$DriverOrProviderKey, [string]$DriverOrProviderValue)
  $segments = New-Object System.Collections.Generic.List[string]
  $segments.Add(("{0}={1}" -f $DriverOrProviderKey, $DriverOrProviderValue))
  $segments.Add(("Server={0}" -f $server))
  $segments.Add(("Database={0}" -f $database))
  if ($auth -eq 'windows') {
    $segments.Add('Trusted_Connection=yes')
  } else {
    $segments.Add(("Uid={0}" -f $username))
    $segments.Add(("Pwd={0}" -f $password))
  }
  if (-not [string]::IsNullOrWhiteSpace($extra)) { $segments.Add($extra) }
  return [string]::Join(';', $segments)
}

$evidence = [ordered]@{
  tool             = 'ba-m05-driver-smoke'
  step             = 'BA-M0.5'
  driver           = $Driver
  ok               = $false
  connected        = $false
  driverAssembly   = ''
  sqlServerVersion = ''
  errorType        = ''
  errorNumber      = ''
  errorSummary     = ''
  query            = 'SELECT @@VERSION'
  timestamp        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

Write-SmokeInfo ("driver={0} envFile={1}" -f $Driver, $EnvFile)
Write-SmokeInfo 'connecting (connection string is composed in-process and never logged)'

$connection = $null
try {
  switch ($Driver) {
    'SqlClient' {
      $connection = New-Object System.Data.SqlClient.SqlConnection (New-SqlClientConnString)
      $evidence.driverAssembly = [System.Data.SqlClient.SqlConnection].Assembly.FullName
    }
    'Odbc' {
      $odbcDriver = $cfg['BA_M05_ODBC_DRIVER']
      if ([string]::IsNullOrWhiteSpace($odbcDriver)) { throw 'BA_M05_ODBC_DRIVER is required for the Odbc path.' }
      $connection = New-Object System.Data.Odbc.OdbcConnection (New-KeyValueConnString -DriverOrProviderKey 'Driver' -DriverOrProviderValue $odbcDriver)
      $evidence.driverAssembly = [System.Data.Odbc.OdbcConnection].Assembly.FullName
    }
    'OleDb' {
      $provider = $cfg['BA_M05_OLEDB_PROVIDER']
      if ([string]::IsNullOrWhiteSpace($provider)) { throw 'BA_M05_OLEDB_PROVIDER is required for the OleDb path.' }
      $connection = New-Object System.Data.OleDb.OleDbConnection (New-KeyValueConnString -DriverOrProviderKey 'Provider' -DriverOrProviderValue $provider)
      $evidence.driverAssembly = [System.Data.OleDb.OleDbConnection].Assembly.FullName
    }
  }

  $connection.Open()
  $evidence.connected = $true
  Write-SmokeInfo 'connection opened; running SELECT @@VERSION'

  $command = $connection.CreateCommand()
  $command.CommandText = 'SELECT @@VERSION'
  $command.CommandTimeout = 15
  $raw = [string]$command.ExecuteScalar()

  $evidence.sqlServerVersion = Protect-Text -Text $raw -Literals $redactLiterals
  $evidence.ok = $true
  Write-SmokeInfo 'SELECT @@VERSION succeeded'
}
catch {
  $ex = $_.Exception
  $evidence.errorType = $ex.GetType().FullName
  $num = $null
  try { $num = $ex.Number } catch { $num = $null }
  if ($null -eq $num) {
    try { $num = $ex.ErrorCode } catch { $num = $null }
  }
  if ($null -ne $num) { $evidence.errorNumber = [string]$num }
  $summary = $ex.Message
  if ($summary.Length -gt 240) { $summary = $summary.Substring(0, 240) + ' ...' }
  $evidence.errorSummary = Protect-Text -Text $summary -Literals $redactLiterals
  Write-SmokeInfo ('connection/query failed: {0}' -f $evidence.errorType)
}
finally {
  if ($null -ne $connection) {
    try { $connection.Close() } catch { }
    try { $connection.Dispose() } catch { }
  }
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$jsonPath = Join-Path $OutDir ("ba-m05-driver-smoke-{0}-{1}.json" -f $Driver, $stamp)
$mdPath   = Join-Path $OutDir ("ba-m05-driver-smoke-{0}-{1}.md"   -f $Driver, $stamp)

($evidence | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine('# BA-M0.5 Driver Smoke Evidence')
[void]$md.AppendLine('')
[void]$md.AppendLine(('- tool: `{0}`' -f $evidence.tool))
[void]$md.AppendLine(('- driver: `{0}`' -f $evidence.driver))
[void]$md.AppendLine(('- driverAssembly: `{0}`' -f $evidence.driverAssembly))
[void]$md.AppendLine(('- connected: `{0}`' -f $evidence.connected))
[void]$md.AppendLine(('- ok: `{0}`' -f $evidence.ok))
[void]$md.AppendLine(('- query: `{0}`' -f $evidence.query))
[void]$md.AppendLine(('- timestamp: `{0}`' -f $evidence.timestamp))
[void]$md.AppendLine('')
if ($evidence.ok) {
  [void]$md.AppendLine('## SQL Server version (redacted)')
  [void]$md.AppendLine('')
  [void]$md.AppendLine('```text')
  [void]$md.AppendLine([string]$evidence.sqlServerVersion)
  [void]$md.AppendLine('```')
} else {
  [void]$md.AppendLine('## Failure (redacted)')
  [void]$md.AppendLine('')
  [void]$md.AppendLine(('- errorType: `{0}`' -f $evidence.errorType))
  [void]$md.AppendLine(('- errorNumber: `{0}`' -f $evidence.errorNumber))
  [void]$md.AppendLine(('- errorSummary: {0}' -f $evidence.errorSummary))
}
[void]$md.AppendLine('')
[void]$md.AppendLine('No business tables were read. No write statement was issued. No connection string, host, or credential is recorded in this evidence.')
$md.ToString() | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-SmokeInfo ('evidence JSON: {0}' -f $jsonPath)
Write-SmokeInfo ('evidence MD:   {0}' -f $mdPath)
Write-SmokeInfo ('ba-m05 result ok={0}' -f $evidence.ok)

if ($evidence.ok) { exit 0 } else { exit 1 }
