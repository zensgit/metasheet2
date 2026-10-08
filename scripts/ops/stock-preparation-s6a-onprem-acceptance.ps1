#requires -Version 5.1
<#
.SYNOPSIS
  Values-free acceptance for the controlled SQL Server sealed-snapshot
  stock-preparation runtime.

.DESCRIPTION
  The runner performs exactly three HTTP calls:
    1. GET /api/integration/health
    2. POST the controlled runtime with a fresh operationId
    3. POST the same operationId again to prove idempotent replay

  The emitted .txt/.json artifacts contain only fixed status fields and
  counts. They never contain source rows, SQL, relation names, credentials,
  endpoints, tenant identifiers, or raw HTTP bodies.
#>
[CmdletBinding()]
param(
  [string]$ApiBase = 'http://127.0.0.1:8900/api',
  [string]$OperationId,
  [string]$AdminTokenEnvVar = 'METASHEET_ADMIN_TOKEN',
  [string]$SummaryPath = 'stock-preparation-s6a-acceptance-summary.txt',
  [string]$ExpectedServiceRuntimeSha,
  [string]$ExpectedPackageSha256,
  [string]$PackageRoot = (
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  ),
  [string]$PackageArchivePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:S6Summary = [ordered]@{
  schema = 'stock-preparation/sqlserver-sealed-snapshot/acceptance/v2'
  capturedAtUtc = 'unavailable'
  serviceRuntimeSha = 'unavailable'
  packageSha256 = 'unavailable'
  machineBindingDigest = 'unavailable'
  operationBindingDigest = 'unavailable'
  customerScope = 'single_customer'
  health = 'FAIL'
  capability = 'FAIL'
  firstRun = 'FAIL'
  replayRun = 'FAIL'
  sourceReadCount = '0'
  businessLineCount = '0'
  externalWrite = 'unknown'
  valuesFree = 'false'
  status = 'FAIL'
  failedStage = 'none'
  failureReason = 'none'
}

function Write-S6Summary {
  param([string]$Path)

  $lines = @()
  foreach ($key in $script:S6Summary.Keys) {
    $lines += "$key=$($script:S6Summary[$key])"
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText(
    $Path,
    ($lines -join [Environment]::NewLine),
    $utf8NoBom
  )
  $jsonPath = [System.IO.Path]::ChangeExtension($Path, '.json')
  [System.IO.File]::WriteAllText(
    $jsonPath,
    ($script:S6Summary | ConvertTo-Json -Depth 3),
    $utf8NoBom
  )
}

function Get-S6Sha256Text {
  param([string]$Text)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    return ([System.BitConverter]::ToString(
      $sha.ComputeHash($bytes)
    )).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-S6FileSha256 {
  param([string]$Path)

  $stream = $null
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    return ([System.BitConverter]::ToString(
      $sha.ComputeHash($stream)
    )).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $sha.Dispose()
  }
}

function Get-S6BuildProvenanceSha {
  param([string]$Root)

  try {
    $path = Join-Path $Root 'BUILD_PROVENANCE.json'
    $parsed = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if (
      $parsed.schema -ne 'metasheet-onprem-build-provenance/v1' -or
      "$($parsed.gitCommit)" -notmatch '^[0-9a-f]{40}$'
    ) {
      throw [System.InvalidOperationException]::new('PROVENANCE_INVALID')
    }
    return "$($parsed.gitCommit)"
  } catch {
    throw [System.InvalidOperationException]::new('PROVENANCE_INVALID')
  }
}

function Test-S6ExactProperties {
  param($Value, [string[]]$Expected)

  if ($null -eq $Value) { return $false }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { return $false }
  for ($index = 0; $index -lt $wanted.Count; $index++) {
    if ($actual[$index] -ne $wanted[$index]) { return $false }
  }
  return $true
}

function Get-S6HttpStatus {
  param($ErrorRecord)

  try {
    $status = [int]$ErrorRecord.Exception.Response.StatusCode
    if ($status -ge 100 -and $status -le 599) { return "$status" }
  } catch {
    # The caller receives a fixed fallback token.
  }
  return 'unavailable'
}

function Invoke-S6HttpJson {
  param(
    [ValidateSet('GET', 'POST')][string]$Method,
    [string]$Uri,
    [hashtable]$Headers,
    [string]$Body
  )

  try {
    $args = @{
      Headers = $Headers
      Method = $Method
      Uri = $Uri
      UseBasicParsing = $true
    }
    if ($Method -eq 'POST') {
      $args.ContentType = 'application/json'
      $args.Body = $Body
    }
    $response = Invoke-WebRequest @args
    return ($response.Content | ConvertFrom-Json)
  } catch {
    $status = Get-S6HttpStatus $_
    throw [System.InvalidOperationException]::new("HTTP_$status")
  }
}

function Test-S6RunResponse {
  param(
    $Response,
    [bool]$ExpectedReplay,
    [string]$ExpectedMode,
    [int]$ExpectedLineCount = -1
  )

  if (-not (Test-S6ExactProperties $Response @('data', 'ok'))) {
    return @{ ok = $false; reason = 'RESPONSE_SHAPE' }
  }
  if ($Response.ok -ne $true) {
    return @{ ok = $false; reason = 'RUN_REFUSED' }
  }
  $data = $Response.data
  if (-not (Test-S6ExactProperties $data @(
    'businessLineCount',
    'externalWrite',
    'mode',
    'replay',
    'sourceReadCount',
    'status',
    'valuesFree'
  ))) {
    return @{ ok = $false; reason = 'RESPONSE_SHAPE' }
  }
  $lineCount = 0
  try { $lineCount = [int]$data.businessLineCount } catch {
    return @{ ok = $false; reason = 'LINE_COUNT' }
  }
  if (
    $data.status -ne 'COMPLETED' -or
    $data.externalWrite -ne $false -or
    $data.valuesFree -ne $true -or
    [int]$data.sourceReadCount -ne 1 -or
    $data.replay -ne $ExpectedReplay -or
    $data.mode -ne $ExpectedMode -or
    $lineCount -lt 1 -or
    $lineCount -gt 24999 -or
    ($ExpectedLineCount -ge 0 -and $lineCount -ne $ExpectedLineCount)
  ) {
    return @{ ok = $false; reason = 'RUN_INVARIANT' }
  }
  return @{ ok = $true; lineCount = $lineCount; reason = 'none' }
}

function Invoke-S6Acceptance {
  param(
    [string]$ResolvedApiBase = $ApiBase,
    [string]$ResolvedOperationId = $OperationId,
    [string]$ResolvedAdminTokenEnvVar = $AdminTokenEnvVar,
    [string]$ResolvedSummaryPath = $SummaryPath,
    [string]$ResolvedServiceRuntimeSha = $ExpectedServiceRuntimeSha,
    [string]$ResolvedPackageSha256 = $ExpectedPackageSha256,
    [string]$ResolvedPackageRoot = $PackageRoot,
    [string]$ResolvedPackageArchivePath = $PackageArchivePath
  )

  foreach ($key in @($script:S6Summary.Keys)) {
    switch ($key) {
      'schema' { $script:S6Summary[$key] = 'stock-preparation/sqlserver-sealed-snapshot/acceptance/v2' }
      'capturedAtUtc' { $script:S6Summary[$key] = 'unavailable' }
      'serviceRuntimeSha' { $script:S6Summary[$key] = 'unavailable' }
      'packageSha256' { $script:S6Summary[$key] = 'unavailable' }
      'machineBindingDigest' { $script:S6Summary[$key] = 'unavailable' }
      'operationBindingDigest' { $script:S6Summary[$key] = 'unavailable' }
      'customerScope' { $script:S6Summary[$key] = 'single_customer' }
      'sourceReadCount' { $script:S6Summary[$key] = '0' }
      'businessLineCount' { $script:S6Summary[$key] = '0' }
      'externalWrite' { $script:S6Summary[$key] = 'unknown' }
      'valuesFree' { $script:S6Summary[$key] = 'false' }
      'failedStage' { $script:S6Summary[$key] = 'none' }
      'failureReason' { $script:S6Summary[$key] = 'none' }
      default { $script:S6Summary[$key] = 'FAIL' }
    }
  }

  $stage = 'input'
  $token = $null
  $headers = $null
  try {
    if (
      -not $ResolvedApiBase -or
      $ResolvedApiBase -notmatch '^https?://[^/]+(?::[0-9]+)?/api/?$' -or
      -not $ResolvedAdminTokenEnvVar -or
      $ResolvedAdminTokenEnvVar -notmatch '^[A-Z][A-Z0-9_]{0,63}$' -or
      $ResolvedServiceRuntimeSha -notmatch '^[0-9a-f]{40}$' -or
      $ResolvedPackageSha256 -notmatch '^[0-9a-f]{64}$' -or
      -not $ResolvedPackageRoot -or
      -not (Test-Path -LiteralPath $ResolvedPackageRoot -PathType Container) -or
      -not $ResolvedPackageArchivePath -or
      -not (Test-Path -LiteralPath $ResolvedPackageArchivePath -PathType Leaf)
    ) {
      throw [System.InvalidOperationException]::new('INPUT_INVALID')
    }
    if (-not $ResolvedOperationId) {
      $ResolvedOperationId = 's6a-' + [guid]::NewGuid().ToString('N')
    }
    if (
      $ResolvedOperationId.Length -gt 128 -or
      $ResolvedOperationId -notmatch '^[A-Za-z0-9._:-]+$'
    ) {
      throw [System.InvalidOperationException]::new('INPUT_INVALID')
    }
    $machineName = [Environment]::MachineName
    if (-not $machineName) {
      throw [System.InvalidOperationException]::new('INPUT_INVALID')
    }
    if (
      (Get-S6BuildProvenanceSha $ResolvedPackageRoot) -ne
        $ResolvedServiceRuntimeSha -or
      (Get-S6FileSha256 $ResolvedPackageArchivePath) -ne
        $ResolvedPackageSha256
    ) {
      throw [System.InvalidOperationException]::new('PROVENANCE_INVALID')
    }
    $script:S6Summary.capturedAtUtc =
      [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $script:S6Summary.serviceRuntimeSha = $ResolvedServiceRuntimeSha
    $script:S6Summary.packageSha256 = $ResolvedPackageSha256
    $script:S6Summary.machineBindingDigest = Get-S6Sha256Text (
      "metasheet.s6a.machine.v1`0$ResolvedServiceRuntimeSha`0" +
      "$ResolvedPackageSha256`0$machineName"
    )
    $script:S6Summary.operationBindingDigest = Get-S6Sha256Text (
      "metasheet.s6a.operation.v1`0$ResolvedServiceRuntimeSha`0" +
      "$ResolvedOperationId"
    )

    $token = [Environment]::GetEnvironmentVariable($ResolvedAdminTokenEnvVar)
    Remove-Item "Env:$ResolvedAdminTokenEnvVar" -ErrorAction SilentlyContinue
    if (-not $token) {
      throw [System.InvalidOperationException]::new('TOKEN_REQUIRED')
    }
    $headers = @{ Authorization = "Bearer $token" }
    $base = $ResolvedApiBase.TrimEnd('/')

    $stage = 'health'
    $health = Invoke-S6HttpJson -Method GET -Uri "$base/integration/health" -Headers $headers
    if (
      -not (Test-S6ExactProperties $health @('capabilities', 'milestone', 'ok', 'phase', 'plugin', 'ts', 'version')) -or
      $health.ok -ne $true
    ) {
      throw [System.InvalidOperationException]::new('HEALTH_INVALID')
    }
    $script:S6Summary.health = 'PASS'
    $capability = $null
    if ($null -ne $health.capabilities) {
      $capability = $health.capabilities.PSObject.Properties[
        'stockPreparationSqlServerSealedSnapshot'
      ]
    }
    if ($null -eq $capability -or $capability.Value -ne $true) {
      throw [System.InvalidOperationException]::new('CAPABILITY_DISABLED')
    }
    $script:S6Summary.capability = 'PASS'

    $body = @{ operationId = $ResolvedOperationId } | ConvertTo-Json -Compress
    $runUri = "$base/integration/internal/stock-preparation/sqlserver-sealed-snapshot/run"

    $stage = 'firstRun'
    $first = Invoke-S6HttpJson -Method POST -Uri $runUri -Headers $headers -Body $body
    $firstVerdict = Test-S6RunResponse -Response $first -ExpectedReplay $false -ExpectedMode 'internal_persist'
    if (-not $firstVerdict.ok) {
      throw [System.InvalidOperationException]::new($firstVerdict.reason)
    }
    $script:S6Summary.firstRun = 'PASS'
    $script:S6Summary.sourceReadCount = '1'
    $script:S6Summary.businessLineCount = "$($firstVerdict.lineCount)"
    $script:S6Summary.externalWrite = 'false'
    $script:S6Summary.valuesFree = 'true'

    $stage = 'replayRun'
    $replay = Invoke-S6HttpJson -Method POST -Uri $runUri -Headers $headers -Body $body
    $replayVerdict = Test-S6RunResponse -Response $replay -ExpectedReplay $true -ExpectedMode 'internal_noop' -ExpectedLineCount $firstVerdict.lineCount
    if (-not $replayVerdict.ok) {
      throw [System.InvalidOperationException]::new($replayVerdict.reason)
    }
    $script:S6Summary.replayRun = 'PASS'
    $script:S6Summary.status = 'PASS'
    Write-S6Summary $ResolvedSummaryPath
    return $true
  } catch {
    $allowed = @(
      'CAPABILITY_DISABLED',
      'HEALTH_INVALID',
      'INPUT_INVALID',
      'LINE_COUNT',
      'PROVENANCE_INVALID',
      'RESPONSE_SHAPE',
      'RUN_INVARIANT',
      'RUN_REFUSED',
      'TOKEN_REQUIRED'
    )
    $reason = "$($_.Exception.Message)"
    if ($reason -notmatch '^HTTP_(unavailable|[1-5][0-9]{2})$' -and $allowed -notcontains $reason) {
      $reason = 'INTERNAL_ERROR'
    }
    $script:S6Summary.failedStage = $stage
    $script:S6Summary.failureReason = $reason
    Write-S6Summary $ResolvedSummaryPath
    return $false
  } finally {
    $headers = $null
    $token = $null
    if ($ResolvedAdminTokenEnvVar -match '^[A-Z][A-Z0-9_]{0,63}$') {
      Remove-Item "Env:$ResolvedAdminTokenEnvVar" -ErrorAction SilentlyContinue
    }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  if (-not (Invoke-S6Acceptance)) { exit 1 }
  exit 0
}
