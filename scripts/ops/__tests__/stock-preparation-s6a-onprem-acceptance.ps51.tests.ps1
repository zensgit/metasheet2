#requires -Version 5.1
$ErrorActionPreference = 'Stop'

$opsDir = Join-Path $PSScriptRoot '..'
$scriptPath = Join-Path $opsDir 'stock-preparation-s6a-onprem-acceptance.ps1'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("s6a_accept_" + [guid]::NewGuid().ToString('N'))
$pass = 0
$fail = 0

function Check {
  param([string]$Name, [bool]$Ok)
  if ($Ok) {
    $script:pass++
    Write-Host "  PASS  $Name"
  } else {
    $script:fail++
    Write-Host "  FAIL  $Name"
  }
}

Check 'host is Windows PowerShell 5.1 Desktop' (
  $PSVersionTable.PSEdition -eq 'Desktop' -and
  $PSVersionTable.PSVersion.Major -eq 5 -and
  $PSVersionTable.PSVersion.Minor -eq 1
)

function New-FakeResponse {
  param($Value)
  return [pscustomobject]@{ Content = ($Value | ConvertTo-Json -Depth 8 -Compress) }
}

function New-Health {
  param([bool]$Enabled = $true)
  return [ordered]@{
    ok = $true
    plugin = 'plugin-integration-core'
    version = '0.1.0'
    phase = 'integration-core-mvp'
    ts = 1
    milestone = 'integration-core-mvp'
    capabilities = [ordered]@{
      stockPreparationSqlServerSealedSnapshot = $Enabled
    }
  }
}

function New-Run {
  param([bool]$Replay, [string]$Mode, [int]$LineCount = 12)
  return [ordered]@{
    ok = $true
    data = [ordered]@{
      businessLineCount = $LineCount
      externalWrite = $false
      mode = $Mode
      replay = $Replay
      sourceReadCount = 1
      status = 'COMPLETED'
      valuesFree = $true
    }
  }
}

try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $serviceSha = 'a' * 40
  $packageRoot = Join-Path $root 'package'
  $archivePath = Join-Path $root 'package.zip'
  New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $packageRoot 'BUILD_PROVENANCE.json'),
    (@{
      schema = 'metasheet-onprem-build-provenance/v1'
      gitCommit = $serviceSha
    } | ConvertTo-Json -Compress),
    (New-Object System.Text.UTF8Encoding($false))
  )
  [System.IO.File]::WriteAllBytes(
    $archivePath,
    [System.Text.Encoding]::UTF8.GetBytes('s6a-package-fixture')
  )
  $packageSha = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath
  ).Hash.ToLowerInvariant()
  . $scriptPath `
    -ApiBase 'http://127.0.0.1:8900/api' `
    -SummaryPath (Join-Path $root 'unused.txt') `
    -ExpectedServiceRuntimeSha $serviceSha `
    -ExpectedPackageSha256 $packageSha `
    -PackageRoot $packageRoot `
    -PackageArchivePath $archivePath

  $script:requests = @()
  $script:responses = @(
    (New-FakeResponse (New-Health)),
    (New-FakeResponse (New-Run -Replay $false -Mode 'internal_persist')),
    (New-FakeResponse (New-Run -Replay $true -Mode 'internal_noop'))
  )
  function global:Invoke-WebRequest {
    param(
      [string]$Method,
      [string]$Uri,
      [hashtable]$Headers,
      [string]$ContentType,
      [string]$Body,
      [switch]$UseBasicParsing
    )
    $script:requests += [pscustomobject]@{
      Body = $Body
      ContentType = $ContentType
      HasToken = ($Headers.Authorization -eq 'Bearer test-token')
      Method = $Method
      Uri = $Uri
      UseBasicParsing = $UseBasicParsing.IsPresent
    }
    $response = $script:responses[0]
    $script:responses = @($script:responses | Select-Object -Skip 1)
    return $response
  }

  $summaryPath = Join-Path $root 'pass.txt'
  $env:METASHEET_ADMIN_TOKEN = 'test-token'
  $ok = Invoke-S6Acceptance `
    -ResolvedApiBase 'http://127.0.0.1:8900/api' `
    -ResolvedOperationId 'acceptance-1' `
    -ResolvedAdminTokenEnvVar 'METASHEET_ADMIN_TOKEN' `
    -ResolvedSummaryPath $summaryPath
  Check 'happy path passes' $ok
  Check 'exactly health plus two controlled runtime calls' (
    $script:requests.Count -eq 3 -and
    $script:requests[0].Method -eq 'GET' -and
    $script:requests[1].Method -eq 'POST' -and
    $script:requests[2].Method -eq 'POST'
  )
  Check 'both run calls carry only the same operationId' (
    $script:requests[1].Body -eq '{"operationId":"acceptance-1"}' -and
    $script:requests[2].Body -eq $script:requests[1].Body
  )
  Check 'token stays in headers and is scrubbed from process env' (
    @($script:requests | Where-Object { -not $_.HasToken }).Count -eq 0 -and
    -not (Test-Path Env:METASHEET_ADMIN_TOKEN)
  )
  $summary = (Get-Content -LiteralPath $summaryPath -Raw) -replace "`r`n", "`n"
  Check 'summary is values-free and proves bounded replay' (
    $summary -match '(?m)^status=PASS$' -and
    $summary -match "(?m)^serviceRuntimeSha=$serviceSha$" -and
    $summary -match "(?m)^packageSha256=$packageSha$" -and
    $summary -match '(?m)^machineBindingDigest=[0-9a-f]{64}$' -and
    $summary -match '(?m)^operationBindingDigest=[0-9a-f]{64}$' -and
    $summary -match '(?m)^sourceReadCount=1$' -and
    $summary -match '(?m)^businessLineCount=12$' -and
    $summary -match '(?m)^externalWrite=false$' -and
    $summary -notmatch 'test-token|acceptance-1|127\.0\.0\.1'
  )
  $atLimitResponse = (
    New-Run -Replay $false -Mode 'internal_persist' -LineCount 24999 |
      ConvertTo-Json -Depth 8 |
      ConvertFrom-Json
  )
  $overLimitResponse = (
    New-Run -Replay $false -Mode 'internal_persist' -LineCount 25000 |
      ConvertTo-Json -Depth 8 |
      ConvertFrom-Json
  )
  $atLimit = Test-S6RunResponse `
    -Response $atLimitResponse `
    -ExpectedReplay $false `
    -ExpectedMode 'internal_persist'
  $overLimit = Test-S6RunResponse `
    -Response $overLimitResponse `
    -ExpectedReplay $false `
    -ExpectedMode 'internal_persist'
  Check 'line-count boundary accepts 24999 and refuses 25000' (
    $atLimit.ok -eq $true -and
    $overLimit.ok -eq $false -and
    $overLimit.reason -eq 'RUN_INVARIANT'
  )

  $script:requests = @()
  $wrongProvenancePath = Join-Path $root 'wrong-provenance.txt'
  $env:METASHEET_ADMIN_TOKEN = 'test-token'
  $wrongProvenance = Invoke-S6Acceptance `
    -ResolvedApiBase 'http://127.0.0.1:8900/api' `
    -ResolvedOperationId 'acceptance-provenance' `
    -ResolvedAdminTokenEnvVar 'METASHEET_ADMIN_TOKEN' `
    -ResolvedSummaryPath $wrongProvenancePath `
    -ResolvedServiceRuntimeSha ('c' * 40)
  Check 'package provenance mismatch fails before any HTTP call' (
    -not $wrongProvenance -and
    $script:requests.Count -eq 0 -and
    (Get-Content -LiteralPath $wrongProvenancePath -Raw) -match '(?m)^failureReason=PROVENANCE_INVALID$'
  )

  $script:requests = @()
  $script:responses = @((New-FakeResponse (New-Health -Enabled $false)))
  $disabledPath = Join-Path $root 'disabled.txt'
  $env:METASHEET_ADMIN_TOKEN = 'test-token'
  $disabled = Invoke-S6Acceptance `
    -ResolvedApiBase 'http://127.0.0.1:8900/api' `
    -ResolvedOperationId 'acceptance-2' `
    -ResolvedAdminTokenEnvVar 'METASHEET_ADMIN_TOKEN' `
    -ResolvedSummaryPath $disabledPath
  Check 'disabled capability fails before any runtime call' (
    -not $disabled -and
    $script:requests.Count -eq 1 -and
    (Get-Content -LiteralPath $disabledPath -Raw) -match '(?m)^failureReason=CAPABILITY_DISABLED$'
  )

  $script:requests = @()
  $badRun = New-Run -Replay $false -Mode 'internal_persist'
  $badRun.data.rawRows = @('forbidden')
  $script:responses = @(
    (New-FakeResponse (New-Health)),
    (New-FakeResponse $badRun)
  )
  $shapePath = Join-Path $root 'shape.txt'
  $env:METASHEET_ADMIN_TOKEN = 'test-token'
  $shape = Invoke-S6Acceptance `
    -ResolvedApiBase 'http://127.0.0.1:8900/api' `
    -ResolvedOperationId 'acceptance-3' `
    -ResolvedAdminTokenEnvVar 'METASHEET_ADMIN_TOKEN' `
    -ResolvedSummaryPath $shapePath
  Check 'unexpected value-bearing response field fails closed without echo' (
    -not $shape -and
    (Get-Content -LiteralPath $shapePath -Raw) -match '(?m)^failureReason=RESPONSE_SHAPE$' -and
    (Get-Content -LiteralPath $shapePath -Raw) -notmatch 'rawRows|forbidden'
  )
} finally {
  Remove-Item Function:global:Invoke-WebRequest -ErrorAction SilentlyContinue
  Remove-Item Env:METASHEET_ADMIN_TOKEN -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -gt 0) {
  Write-Host "FAILED: $fail check(s); $pass passed"
  exit 1
}
Write-Host "ALL S6-A POWERSHELL CHECKS PASS ($pass checks)"
exit 0
