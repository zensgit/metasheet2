#requires -Version 5.0
<#
.SYNOPSIS
  Bridge Agent driver smoke harness (BA-M0.5 gate).

.DESCRIPTION
  Minimal read-only smoke test that proves the customer-approved SQL Server
  driver on the chosen bridge machine can open a connection to the legacy
  SQL Server endpoint and execute exactly one read-only query
  (`SELECT @@VERSION`). Produces a redacted JSON + Markdown evidence pair.

  This script does NOT:
    - read any business table (no t_ICItem, no t_ICBOM, no t_ICBomChild),
    - run any write / DDL / Submit / Audit statement,
    - log the connection string, password, or any credential-shaped value,
    - emit row data from business tables.

  This script is the gate for issue #1710 BA-M0.5. BA-M1 implementation
  does not start until this smoke is signed off green.

.PARAMETER Server
  SQL Server host[\instance] or host,port. Not echoed into evidence files;
  only its presence is recorded.

.PARAMETER Database
  Database name. Not echoed into evidence files.

.PARAMETER Username
  SQL login. Required unless -IntegratedSecurity is set. Not echoed.

.PARAMETER PasswordEnvVar
  Name of an environment variable holding the SQL login password. The
  variable is read once and its value is never written to disk by this
  script. If neither -PasswordEnvVar nor -IntegratedSecurity is provided,
  the script prompts interactively via Read-Host -AsSecureString.

.PARAMETER IntegratedSecurity
  Use Windows Integrated Security (Trusted_Connection=true). No password
  is needed.

.PARAMETER Provider
  SqlClient (default) | Odbc | OleDb. Picks which managed provider the
  smoke uses, mirroring the runtime/driver options the customer may
  accept (see Bridge Agent plan, BA-M0).

.PARAMETER OutDir
  Directory where the redacted evidence pair is written. Created if
  missing.

.PARAMETER ConnectTimeoutSec
  Connection timeout in seconds. Default 8.

.PARAMETER QueryTimeoutSec
  Query timeout in seconds. Default 8.

.EXAMPLE
  .\bridge-agent-driver-smoke.ps1 `
    -Server '<host>' -Database '<db>' -Username '<readonly_user>' `
    -PasswordEnvVar BRIDGE_SMOKE_DB_PASSWORD `
    -OutDir 'C:\metasheet\bridge-evidence' `
    -Provider SqlClient

.EXAMPLE
  .\bridge-agent-driver-smoke.ps1 `
    -Server '<host>' -Database '<db>' -IntegratedSecurity `
    -OutDir 'C:\metasheet\bridge-evidence' `
    -Provider Odbc
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Server,

  [Parameter(Mandatory = $true)]
  [string]$Database,

  [string]$Username,

  [string]$PasswordEnvVar,

  [switch]$IntegratedSecurity,

  [ValidateSet('SqlClient', 'Odbc', 'OleDb')]
  [string]$Provider = 'SqlClient',

  # ODBC driver name as it appears in the customer's installed ODBC stack.
  # Default targets ODBC Driver 17. Override to the customer-approved
  # legacy driver if BA-M0 picked one, e.g.
  #   -OdbcDriverName 'SQL Server Native Client 11.0'
  #   -OdbcDriverName 'ODBC Driver 18 for SQL Server'
  #   -OdbcDriverName 'SQL Server'
  [string]$OdbcDriverName = 'ODBC Driver 17 for SQL Server',

  # OLE DB provider name as installed on the customer host. Default
  # targets MSOLEDBSQL. Override to the customer-approved legacy provider
  # if BA-M0 picked one, e.g.
  #   -OleDbProviderName 'SQLNCLI11'
  #   -OleDbProviderName 'SQLOLEDB'
  [string]$OleDbProviderName = 'MSOLEDBSQL',

  [Parameter(Mandatory = $true)]
  [string]$OutDir,

  [int]$ConnectTimeoutSec = 8,

  [int]$QueryTimeoutSec = 8
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Redaction helpers
# ---------------------------------------------------------------------------

# Mask credential-shaped substrings in any free-text error message. We
# explicitly avoid putting credential values into the script's variables to
# begin with, but defense-in-depth catches drivers that echo the connection
# string into their exception messages.
function ConvertTo-RedactedText {
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return $Value }
  $patterns = @(
    '(?i)(Password|Pwd)\s*=\s*[^;""'']+',
    '(?i)(User\s*ID|UID|User)\s*=\s*[^;""'']+',
    '(?i)(Data Source|Server|Address|Network Address)\s*=\s*[^;""'']+',
    '(?i)(Initial Catalog|Database)\s*=\s*[^;""'']+',
    '(?i)Bearer\s+[A-Za-z0-9._~+/=-]{8,}',
    'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
  )
  $redacted = $Value
  foreach ($p in $patterns) {
    $redacted = [System.Text.RegularExpressions.Regex]::Replace($redacted, $p, '<redacted>')
  }
  return $redacted
}

function Get-RedactedErrorRecord {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)
  if ($null -eq $ErrorRecord) { return $null }
  $top = $ErrorRecord.Exception
  $class = if ($null -ne $top) { $top.GetType().FullName } else { 'unknown' }

  # Walk InnerException chain and also flatten the Data dictionary, because
  # some SQL Server providers surface the original connection string inside
  # InnerException.Message or Exception.Data on pre-login TLS failures.
  # Concatenate everything into one buffer, then run a single redaction pass.
  #
  # Exception.Data is key/value, so the regex redactor (which keys off
  # `Password=...` / `Server=...` shapes) would miss e.g. Data["Password"]
  # entries because they serialize as `data[Password]=xxx` and the equals
  # sign is preceded by `]`, not whitespace. Apply key-aware masking BEFORE
  # concatenation: if the Data key name itself names a sensitive concept,
  # mask the whole value; otherwise still run the value through the regex
  # redactor for defense in depth.
  $sensitiveKeyPattern = '(?i)^(password|pwd|secret|token|user|user[\s_-]*id|uid|server|data[\s_-]*source|database|initial[\s_-]*catalog|connection[\s_-]*string|connstring|address|host|hostname|network[\s_-]*address)$'
  $buf = New-Object System.Text.StringBuilder
  $current = $top
  $depth = 0
  while ($null -ne $current -and $depth -lt 8) {
    if (-not [string]::IsNullOrEmpty($current.Message)) {
      [void]$buf.AppendLine($current.Message)
    }
    if ($null -ne $current.Data -and $current.Data.Count -gt 0) {
      foreach ($k in $current.Data.Keys) {
        $v = $current.Data[$k]
        if ($null -eq $v) { continue }
        $kStr = [string]$k
        if ($kStr -match $sensitiveKeyPattern) {
          [void]$buf.AppendLine("data[$kStr]=<redacted>")
        } else {
          $vStr = [string]$v
          [void]$buf.AppendLine("data[$kStr]=" + (ConvertTo-RedactedText -Value $vStr))
        }
      }
    }
    $current = $current.InnerException
    $depth++
  }
  $combined = $buf.ToString().TrimEnd()
  return [ordered]@{
    class   = $class
    message = ConvertTo-RedactedText -Value $combined
  }
}

# ---------------------------------------------------------------------------
# Password acquisition (never written to disk by this script)
# ---------------------------------------------------------------------------

function Get-SmokePassword {
  if ($IntegratedSecurity) { return $null }
  if (-not [string]::IsNullOrEmpty($PasswordEnvVar)) {
    $val = [System.Environment]::GetEnvironmentVariable($PasswordEnvVar)
    if ([string]::IsNullOrEmpty($val)) {
      throw "Environment variable '$PasswordEnvVar' is not set or is empty."
    }
    return $val
  }
  $secure = Read-Host -Prompt "SQL login password for $Username (input hidden)" -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

# ---------------------------------------------------------------------------
# Connection-string builders (kept in memory only; never written or logged)
# ---------------------------------------------------------------------------

function New-SqlClientConnectionString {
  param([string]$Pwd)
  $sb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $sb['Data Source'] = $Server
  $sb['Initial Catalog'] = $Database
  $sb['Connect Timeout'] = $ConnectTimeoutSec
  if ($IntegratedSecurity) {
    $sb['Integrated Security'] = $true
  } else {
    $sb['User ID'] = $Username
    $sb['Password'] = $Pwd
  }
  $sb['Application Name'] = 'metasheet-bridge-agent-driver-smoke'
  return $sb.ConnectionString
}

function New-OdbcConnectionString {
  param([string]$Pwd)
  $parts = New-Object System.Collections.Generic.List[string]
  # Driver name comes from the -OdbcDriverName parameter so the smoke
  # exercises the *customer-approved* driver, not a baked-in modern one.
  $parts.Add('Driver={' + $OdbcDriverName + '}')
  $parts.Add("Server=$Server")
  $parts.Add("Database=$Database")
  if ($IntegratedSecurity) {
    $parts.Add('Trusted_Connection=Yes')
  } else {
    $parts.Add("UID=$Username")
    $parts.Add("PWD=$Pwd")
  }
  $parts.Add("Connection Timeout=$ConnectTimeoutSec")
  return ($parts -join ';')
}

function New-OleDbConnectionString {
  param([string]$Pwd)
  $parts = New-Object System.Collections.Generic.List[string]
  # Provider name comes from the -OleDbProviderName parameter so the
  # smoke exercises the *customer-approved* OLE DB provider, not a
  # baked-in modern one.
  $parts.Add("Provider=$OleDbProviderName")
  $parts.Add("Data Source=$Server")
  $parts.Add("Initial Catalog=$Database")
  if ($IntegratedSecurity) {
    $parts.Add('Integrated Security=SSPI')
  } else {
    $parts.Add("User ID=$Username")
    $parts.Add("Password=$Pwd")
  }
  $parts.Add("Connect Timeout=$ConnectTimeoutSec")
  return ($parts -join ';')
}

# ---------------------------------------------------------------------------
# Smoke runner
# ---------------------------------------------------------------------------

function Invoke-SmokeWithProvider {
  param([string]$Pwd)

  $checks = New-Object System.Collections.Generic.List[object]
  $driverInfo = [ordered]@{
    provider      = $Provider
    typeName      = $null
    assemblyVersion = $null
  }

  switch ($Provider) {
    'SqlClient' {
      $cs = New-SqlClientConnectionString -Pwd $Pwd
      $connType = [System.Data.SqlClient.SqlConnection]
      $driverInfo['typeName'] = $connType.FullName
      $driverInfo['assemblyVersion'] = $connType.Assembly.GetName().Version.ToString()
      $conn = New-Object System.Data.SqlClient.SqlConnection($cs)
    }
    'Odbc' {
      $cs = New-OdbcConnectionString -Pwd $Pwd
      Add-Type -AssemblyName System.Data
      $connType = [System.Data.Odbc.OdbcConnection]
      $driverInfo['typeName'] = $connType.FullName
      $driverInfo['assemblyVersion'] = $connType.Assembly.GetName().Version.ToString()
      $conn = New-Object System.Data.Odbc.OdbcConnection($cs)
    }
    'OleDb' {
      $cs = New-OleDbConnectionString -Pwd $Pwd
      Add-Type -AssemblyName System.Data
      $connType = [System.Data.OleDb.OleDbConnection]
      $driverInfo['typeName'] = $connType.FullName
      $driverInfo['assemblyVersion'] = $connType.Assembly.GetName().Version.ToString()
      $conn = New-Object System.Data.OleDb.OleDbConnection($cs)
    }
  }

  # check 1: open connection
  $openCheck = [ordered]@{
    name       = 'open-connection'
    status     = 'PENDING'
    elapsed_ms = 0
    error      = $null
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $conn.Open()
    $openCheck['status'] = 'PASS'
  } catch {
    $openCheck['status'] = 'FAIL'
    $openCheck['error'] = Get-RedactedErrorRecord -ErrorRecord $_
  } finally {
    $sw.Stop()
    $openCheck['elapsed_ms'] = [int]$sw.ElapsedMilliseconds
  }
  $checks.Add([pscustomobject]$openCheck) | Out-Null

  $versionEcho = $null

  if ($openCheck['status'] -eq 'PASS') {
    # check 2: SELECT @@VERSION (the ONLY query this harness runs)
    $verCheck = [ordered]@{
      name       = 'select-version'
      status     = 'PENDING'
      elapsed_ms = 0
      error      = $null
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      $cmd = $conn.CreateCommand()
      $cmd.CommandText = 'SELECT @@VERSION'
      $cmd.CommandTimeout = $QueryTimeoutSec
      $result = $cmd.ExecuteScalar()
      if ($null -ne $result) {
        # @@VERSION is a product banner; safe to capture but pass it through
        # the redactor anyway in case a customised banner embeds anything
        # secret-shaped.
        $versionEcho = ConvertTo-RedactedText -Value ([string]$result)
        $verCheck['status'] = 'PASS'
      } else {
        $verCheck['status'] = 'FAIL'
        $verCheck['error'] = [ordered]@{ class = 'NoResult'; message = 'SELECT @@VERSION returned null' }
      }
    } catch {
      $verCheck['status'] = 'FAIL'
      $verCheck['error'] = Get-RedactedErrorRecord -ErrorRecord $_
    } finally {
      $sw.Stop()
      $verCheck['elapsed_ms'] = [int]$sw.ElapsedMilliseconds
    }
    $checks.Add([pscustomobject]$verCheck) | Out-Null
  }

  if ($conn.State -ne 'Closed') {
    try { $conn.Close() } catch { } # best-effort cleanup
  }

  return @{
    driver       = $driverInfo
    checks       = $checks
    versionEcho  = $versionEcho
  }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

if (-not $IntegratedSecurity -and [string]::IsNullOrEmpty($Username)) {
  throw 'Username is required unless -IntegratedSecurity is set.'
}

$pwd = Get-SmokePassword

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$smokeResult = $null
try {
  $smokeResult = Invoke-SmokeWithProvider -Pwd $pwd
} finally {
  # Zero out the in-memory password promptly.
  if ($null -ne $pwd) {
    $pwd = $null
    [System.GC]::Collect()
  }
}

$decision = if ($smokeResult.checks | Where-Object { $_.status -ne 'PASS' }) { 'FAIL' } else { 'PASS' }
$barrier = if ($decision -eq 'PASS') {
  'BA-M1 may proceed once a maintainer signs off this evidence.'
} else {
  'BA-M1 blocked: driver did not complete the smoke against the chosen endpoint.'
}

$evidence = [ordered]@{
  spec        = 'ba-m0.5-driver-smoke'
  specVersion = '1.0'
  timestamp   = $timestamp
  runner      = [ordered]@{
    os                = [System.Environment]::OSVersion.VersionString
    powerShellVersion = $PSVersionTable.PSVersion.ToString()
    clrVersion        = [System.Environment]::Version.ToString()
  }
  target      = [ordered]@{
    provider          = $Provider
    # Record the customer-approved driver/provider name actually used
    # for the smoke. Non-secret product identifier (e.g.
    # "SQL Server Native Client 11.0", "MSOLEDBSQL"); reviewers need
    # it to know which driver actually negotiated.
    odbcDriverName    = if ($Provider -eq 'Odbc')  { $OdbcDriverName    } else { $null }
    oleDbProviderName = if ($Provider -eq 'OleDb') { $OleDbProviderName } else { $null }
    serverPresent     = -not [string]::IsNullOrEmpty($Server)
    databasePresent   = -not [string]::IsNullOrEmpty($Database)
    integratedSecurity= [bool]$IntegratedSecurity
  }
  driver      = $smokeResult.driver
  checks      = $smokeResult.checks
  sqlServerVersionRedacted = $smokeResult.versionEcho
  decision    = $decision
  nextStep    = $barrier
}

$jsonPath = Join-Path $OutDir 'ba-m0_5-driver-smoke.json'
$mdPath   = Join-Path $OutDir 'ba-m0_5-driver-smoke.md'

# JSON evidence
$evidence | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $jsonPath -Encoding utf8 -Force

# Human-readable Markdown evidence (no secrets — mirrors JSON content)
$mdLines = @()
$mdLines += '# BA-M0.5 Driver Smoke Evidence'
$mdLines += ''
$mdLines += "- spec: $($evidence.spec) v$($evidence.specVersion)"
$mdLines += "- timestamp (UTC): $($evidence.timestamp)"
$mdLines += "- decision: **$($evidence.decision)**"
$mdLines += "- next step: $($evidence.nextStep)"
$mdLines += ''
$mdLines += '## Runner'
$mdLines += ''
$mdLines += "- OS: $($evidence.runner.os)"
$mdLines += "- PowerShell: $($evidence.runner.powerShellVersion)"
$mdLines += "- CLR: $($evidence.runner.clrVersion)"
$mdLines += ''
$mdLines += '## Target (no host / DB / user values recorded)'
$mdLines += ''
$mdLines += "- provider: $($evidence.target.provider)"
if ($null -ne $evidence.target.odbcDriverName) {
  $mdLines += "- ODBC driver name: ``$($evidence.target.odbcDriverName)``"
}
if ($null -ne $evidence.target.oleDbProviderName) {
  $mdLines += "- OLE DB provider name: ``$($evidence.target.oleDbProviderName)``"
}
$mdLines += "- server present: $($evidence.target.serverPresent)"
$mdLines += "- database present: $($evidence.target.databasePresent)"
$mdLines += "- integrated security: $($evidence.target.integratedSecurity)"
$mdLines += ''
$mdLines += '## Driver'
$mdLines += ''
$mdLines += "- typeName: ``$($evidence.driver.typeName)``"
$mdLines += "- assembly version: $($evidence.driver.assemblyVersion)"
$mdLines += ''
$mdLines += '## Checks'
$mdLines += ''
foreach ($c in $evidence.checks) {
  $err = if ($null -ne $c.error) { " | error.class=$($c.error.class) | error.message=$($c.error.message)" } else { '' }
  $mdLines += "- $($c.name): **$($c.status)** ($($c.elapsed_ms) ms)$err"
}
$mdLines += ''
$mdLines += '## SQL Server `@@VERSION` echo (redacted defensively)'
$mdLines += ''
if ($null -ne $evidence.sqlServerVersionRedacted) {
  $mdLines += '```text'
  $mdLines += $evidence.sqlServerVersionRedacted
  $mdLines += '```'
} else {
  $mdLines += '_(no version returned; see Checks section for failure mode)_'
}
$mdLines += ''
$mdLines += '## Hand-off note'
$mdLines += ''
$mdLines += 'This file contains no connection string, host, database name, username, or password. Hand to a maintainer through the secure channel agreed with the customer.'

$mdLines -join [Environment]::NewLine | Out-File -LiteralPath $mdPath -Encoding utf8 -Force

Write-Output "[bridge-agent-driver-smoke] decision=$decision"
Write-Output "[bridge-agent-driver-smoke] evidence json: $jsonPath"
Write-Output "[bridge-agent-driver-smoke] evidence md:   $mdPath"

if ($decision -ne 'PASS') {
  exit 1
}
