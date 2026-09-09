#requires -Version 5.1
<#
.SYNOPSIS
  Values-free acceptance for the SQL Server "source onboarding" chain — the
  positive path an owner walks to bind a read-only SQL data source into
  stock-preparation, and the negative paths that must refuse.

.DESCRIPTION
  Nine numbered checks (plus two negative sub-checks, 1' and 2') against a
  deployed instance:

    STEP1  owner: POST /api/data-sources (sqlserver, read-only)            -> 201
    STEP1B claimless token, same request                                  -> 401 AUTHENTICATED_TENANT_REQUIRED
    STEP2  owner: POST /api/integration/external-systems (sql-readonly)    -> 201, then GET echoes connectionId
    STEP2B owner: same body + credentials                                 -> 400 CONNECTION_BINDING_CREDENTIALS_FORBIDDEN
    STEP3  owner: POST .../external-systems/:id/test                      -> 200, then GET shows lastTestedAt
    STEP4  owner: GET  .../stock-preparation/source-preflight              -> 200 (records data.ready)
    STEP5  owner: DELETE /api/data-sources/:id (still referenced)          -> 409 DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS
    STEP6  operator: GET .../operator/projects, POST .../table-actions/:id/dry-run
    STEP7  claimless token + x-tenant-id header, create SQL binding        -> 403 OPERATOR_SCOPE_TENANT_REQUIRED
    STEP8  owner, create SQL binding with a foreign tenantId               -> 403 TENANT_MISMATCH
    STEP9  operator: POST /api/data-sources/:id/query                     -> refused (403 or 404)

  Every request is logged values-free: step id, HTTP status, error.code, and
  fixed booleans/counts only. Never the token, credentials, connection
  string, or raw response body. Any FAIL exits 1. A step that expected a 4xx
  refusal and got a 2xx is marked ISOLATION_BREACH and halts every step
  after it immediately (best-effort cleanup still runs).

  Reference reading for every expected status/code lives in:
    packages/core-backend/src/routes/data-sources.ts
    plugins/plugin-integration-core/lib/http-routes.cjs
    plugins/plugin-integration-core/lib/external-systems.cjs
    plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://127.0.0.1',
  [string]$OwnerTokenFile,
  [string]$OperatorTokenFile,
  [string]$ClaimlessTokenFile,
  [string]$TenantId,
  [string]$OtherTenantId = 'tenant-acceptance-other',
  [string]$DataSourceId = ('acc-sql-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')),
  [string]$SqlHost,
  [int]$SqlPort = 1433,
  [string]$SqlDatabase,
  [string]$SqlUsernameFile,
  [string]$SqlPasswordFile,
  [string]$WorkspaceHint = 'default',
  [string]$ActionId = 'plm.stock-preparation.pull-bom.v1',
  [string]$ProjectNo,
  [switch]$DryRun,
  [switch]$KeepFixtures,
  [string]$ReportPath = (Join-Path (Get-Location).Path (
    'sql-source-onboarding-acceptance-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '.json'
  ))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# THE PLAN — one entry per HTTP call this script can make. Used verbatim for
# -DryRun (nothing below this array fires a request in that mode) and as the
# single source of truth for step ids/descriptions everywhere else, so the
# printed plan and the printed results can never drift apart.
# ---------------------------------------------------------------------------
$script:Plan = @(
  [ordered]@{ Id = 'STEP1-OWNER-CREATE-DATA-SOURCE';               Method = 'POST';   Path = '/api/data-sources';                                        Description = 'owner creates a read-only sqlserver data source' }
  [ordered]@{ Id = 'STEP1B-CLAIMLESS-CREATE-DATA-SOURCE';          Method = 'POST';   Path = '/api/data-sources';                                        Description = 'claimless token replays the same create request' }
  [ordered]@{ Id = 'STEP2-OWNER-CREATE-EXTERNAL-SYSTEM';           Method = 'POST';   Path = '/api/integration/external-systems';                        Description = 'owner binds a sql-readonly external system to the data source' }
  [ordered]@{ Id = 'STEP2-OWNER-GET-EXTERNAL-SYSTEM';              Method = 'GET';    Path = '/api/integration/external-systems/{externalSystemId}';    Description = 'owner reads the binding back and checks connectionId echoes' }
  [ordered]@{ Id = 'STEP2B-CREDENTIALS-FORBIDDEN';                 Method = 'POST';   Path = '/api/integration/external-systems';                        Description = 'owner replays the binding with a credentials document attached' }
  [ordered]@{ Id = 'STEP3-TEST-CONNECTION';                        Method = 'POST';   Path = '/api/integration/external-systems/{externalSystemId}/test'; Description = 'owner tests the bound connection' }
  [ordered]@{ Id = 'STEP3-GET-LAST-TESTED';                        Method = 'GET';    Path = '/api/integration/external-systems/{externalSystemId}';    Description = 'owner confirms lastTestedAt was persisted' }
  [ordered]@{ Id = 'STEP4-SOURCE-PREFLIGHT';                       Method = 'GET';    Path = '/api/integration/stock-preparation/source-preflight';     Description = 'owner reads the source-preflight report' }
  [ordered]@{ Id = 'STEP5-DELETE-REFERENCED-CONFLICT';             Method = 'DELETE'; Path = '/api/data-sources/{dataSourceId}';                         Description = 'owner tries to delete the still-referenced data source' }
  [ordered]@{ Id = 'STEP6A-OPERATOR-PROJECT-DIRECTORY';            Method = 'GET';    Path = '/api/integration/stock-preparation/operator/projects';    Description = 'operator reads the project directory' }
  [ordered]@{ Id = 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN';         Method = 'POST';   Path = '/api/integration/table-actions/{actionId}/dry-run';       Description = 'operator dry-runs the pull-bom table action for one project' }
  [ordered]@{ Id = 'STEP7-CLAIMLESS-TENANT-HEADER-SQL-BINDING';    Method = 'POST';   Path = '/api/integration/external-systems';                        Description = 'claimless token + x-tenant-id header tries to create a sql binding' }
  [ordered]@{ Id = 'STEP8-TENANT-MISMATCH-SQL-BINDING';            Method = 'POST';   Path = '/api/integration/external-systems';                        Description = 'owner tries to create a sql binding under a foreign tenantId' }
  [ordered]@{ Id = 'STEP9-OPERATOR-RAW-QUERY-FORBIDDEN';           Method = 'POST';   Path = '/api/data-sources/{dataSourceId}/query';                   Description = 'operator tries a raw SQL query against the data source' }
  [ordered]@{ Id = 'CLEANUP-DELETE-EXTERNAL-SYSTEM';               Method = 'DELETE'; Path = '/api/integration/external-systems/{externalSystemId}';    Description = 'owner removes the acceptance external-system fixture' }
  [ordered]@{ Id = 'CLEANUP-DELETE-DATA-SOURCE';                   Method = 'DELETE'; Path = '/api/data-sources/{dataSourceId}';                         Description = 'owner removes the acceptance data-source fixture' }
)

if ($DryRun) {
  Write-Host 'DRY-RUN: step plan only, no HTTP requests will be sent.'
  foreach ($step in $script:Plan) {
    Write-Host ("  {0,-6} {1,-58} {2}" -f $step.Method, $step.Path, $step.Id)
  }
  exit 0
}

# ---------------------------------------------------------------------------
# Result bookkeeping — values-free by construction: Description strings below
# are fixed literals (never interpolated with a token, credential, connection
# string, tenant id, project number, or raw response body).
# ---------------------------------------------------------------------------
$script:Results = @()
$script:ExitCode = 0
$script:Halt = $false
$script:IsolationBreach = $false

function Add-AcceptanceResult {
  param(
    [string]$StepId,
    [string]$Description,
    [ValidateSet('PASS', 'FAIL', 'SKIP', 'WARN', 'ISOLATION_BREACH')]
    [string]$Result,
    $Status,
    $Code
  )
  $statusText = 'n/a'
  if ($null -ne $Status) { $statusText = "$Status" }
  $codeText = 'n/a'
  if ($Code) { $codeText = "$Code" }
  $entry = [ordered]@{
    stepId = $StepId
    description = $Description
    result = $Result
    status = $statusText
    code = $codeText
  }
  $script:Results += [pscustomobject]$entry
  Write-Host ("[{0,-16}] {1,-40} status={2} code={3}" -f $Result, $StepId, $statusText, $codeText)
  if ($Result -eq 'FAIL' -or $Result -eq 'ISOLATION_BREACH') {
    $script:ExitCode = 1
  }
  if ($Result -eq 'ISOLATION_BREACH') {
    $script:IsolationBreach = $true
    $script:Halt = $true
    Write-Host "  -> ISOLATION_BREACH: an expected 4xx refusal returned 2xx instead. Halting remaining steps."
  }
}

# ---------------------------------------------------------------------------
# Secrets — read from file, trimmed, never echoed. A missing REQUIRED file
# throws; a missing OPTIONAL file (claimless token, operator token) is the
# caller's own SKIP signal for the negative/operator checks that need it.
# ---------------------------------------------------------------------------
function Read-AcceptanceSecret {
  param([string]$Path, [switch]$Required, [string]$Label)
  if (-not $Path -or $Path.Trim().Length -eq 0) {
    if ($Required) { throw [System.InvalidOperationException]::new("MISSING_REQUIRED_INPUT:$Label") }
    return $null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    if ($Required) { throw [System.InvalidOperationException]::new("FILE_NOT_FOUND:$Label") }
    return $null
  }
  $raw = Get-Content -LiteralPath $Path -Raw
  if ($null -eq $raw) { return '' }
  return $raw.Trim()
}

# ---------------------------------------------------------------------------
# HTTP — Invoke-WebRequest -UseBasicParsing only. PS 5.1 throws on a non-2xx
# response (System.Net.WebException wrapping an HttpWebResponse); status and
# a values-free error.code are pulled from that response, never the raw body.
# ---------------------------------------------------------------------------
function Invoke-Api {
  param(
    [ValidateSet('GET', 'POST', 'DELETE')][string]$Method,
    [string]$Uri,
    [string]$Token,
    [hashtable]$ExtraHeaders,
    $Body
  )
  $headers = @{}
  if ($Token) { $headers['Authorization'] = "Bearer $Token" }
  if ($ExtraHeaders) {
    foreach ($key in $ExtraHeaders.Keys) { $headers[$key] = $ExtraHeaders[$key] }
  }
  $requestArgs = @{
    Method = $Method
    Uri = $Uri
    Headers = $headers
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $requestArgs.ContentType = 'application/json'
    $requestArgs.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
  }
  try {
    $response = Invoke-WebRequest @requestArgs
    $status = [int]$response.StatusCode
    $json = $null
    if ($response.Content) {
      try { $json = $response.Content | ConvertFrom-Json } catch { $json = $null }
    }
    $code = $null
    if ($json -and $json.PSObject.Properties['error'] -and $json.error -and $json.error.PSObject.Properties['code']) {
      $code = "$($json.error.code)"
    }
    return [pscustomobject]@{ Status = $status; Code = $code; Json = $json }
  } catch {
    $status = 0
    $json = $null
    $webResponse = $null
    if ($_.Exception -and $_.Exception.PSObject.Properties['Response']) {
      $webResponse = $_.Exception.Response
    }
    if ($webResponse) {
      try { $status = [int]$webResponse.StatusCode } catch { $status = 0 }
      try {
        $stream = $webResponse.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $bodyText = $reader.ReadToEnd()
          $reader.Close()
          if ($bodyText) {
            try { $json = $bodyText | ConvertFrom-Json } catch { $json = $null }
          }
        }
      } catch {
        $json = $null
      }
    }
    $code = $null
    if ($json -and $json.PSObject.Properties['error'] -and $json.error -and $json.error.PSObject.Properties['code']) {
      $code = "$($json.error.code)"
    }
    return [pscustomobject]@{ Status = $status; Code = $code; Json = $json }
  }
}

# Generic classifier for a step that EXPECTS one of a closed set of 4xx
# refusals. A 2xx is always ISOLATION_BREACH regardless of what was expected.
function Test-ExpectedRefusal {
  param(
    [string]$StepId,
    [string]$Description,
    $ApiResult,
    [int[]]$ExpectedStatuses,
    [string[]]$ExpectedCodes
  )
  if ($ApiResult.Status -ge 200 -and $ApiResult.Status -lt 300) {
    Add-AcceptanceResult -StepId $StepId -Description $Description -Result 'ISOLATION_BREACH' -Status $ApiResult.Status -Code $ApiResult.Code
    return $false
  }
  if ($ExpectedStatuses -contains $ApiResult.Status) {
    if (-not $ExpectedCodes -or $ExpectedCodes.Count -eq 0 -or ($ApiResult.Code -and ($ExpectedCodes -contains $ApiResult.Code))) {
      Add-AcceptanceResult -StepId $StepId -Description $Description -Result 'PASS' -Status $ApiResult.Status -Code $ApiResult.Code
      return $true
    }
  }
  Add-AcceptanceResult -StepId $StepId -Description $Description -Result 'FAIL' -Status $ApiResult.Status -Code $ApiResult.Code
  return $false
}

function Join-ApiUri {
  param([string]$Path, [hashtable]$Query)
  $base = $BaseUrl.TrimEnd('/')
  $uri = "$base$Path"
  if ($Query -and $Query.Count -gt 0) {
    $pairs = @()
    foreach ($key in $Query.Keys) {
      $pairs += ("{0}={1}" -f [uri]::EscapeDataString($key), [uri]::EscapeDataString("$($Query[$key])"))
    }
    $uri = "$uri`?" + ($pairs -join '&')
  }
  return $uri
}

# ---------------------------------------------------------------------------
# Input validation — required inputs throw before any HTTP call. Optional
# inputs (claimless/operator tokens, ProjectNo) only gate individual SKIPs.
# ---------------------------------------------------------------------------
$ownerToken = Read-AcceptanceSecret -Path $OwnerTokenFile -Required -Label 'OwnerTokenFile'
$claimlessToken = Read-AcceptanceSecret -Path $ClaimlessTokenFile -Label 'ClaimlessTokenFile'
$operatorToken = Read-AcceptanceSecret -Path $OperatorTokenFile -Label 'OperatorTokenFile'
$sqlUsername = Read-AcceptanceSecret -Path $SqlUsernameFile -Required -Label 'SqlUsernameFile'
$sqlPassword = Read-AcceptanceSecret -Path $SqlPasswordFile -Required -Label 'SqlPasswordFile'

if (-not $TenantId -or $TenantId.Trim().Length -eq 0) {
  throw [System.InvalidOperationException]::new('MISSING_REQUIRED_INPUT:TenantId')
}
if (-not $SqlHost -or $SqlHost.Trim().Length -eq 0) {
  throw [System.InvalidOperationException]::new('MISSING_REQUIRED_INPUT:SqlHost')
}
if (-not $SqlDatabase -or $SqlDatabase.Trim().Length -eq 0) {
  throw [System.InvalidOperationException]::new('MISSING_REQUIRED_INPUT:SqlDatabase')
}

$hasClaimlessToken = [bool]$claimlessToken
$hasOperatorToken = [bool]$operatorToken
$hasProjectNo = [bool]($ProjectNo -and $ProjectNo.Trim().Length -gt 0)

$script:ExternalSystemId = $null
$script:ExternalSystemId7 = $null
$script:ExternalSystemId8 = $null
$script:DataSourceCreated = $false
$script:ExternalSystemCreated = $false

# ---------------------------------------------------------------------------
# STEP1 — owner creates a read-only sqlserver data source.
# packages/core-backend/src/routes/data-sources.ts: POST /api/data-sources
# validated by DataSourceCreateSchema, 201 on success.
# ---------------------------------------------------------------------------
$dataSourceBody = @{
  id = $DataSourceId
  name = "acceptance-sql-source-$DataSourceId"
  type = 'sqlserver'
  connection = @{
    host = $SqlHost
    port = $SqlPort
    database = $SqlDatabase
  }
  options = @{ readOnly = $true }
  credentials = @{ username = $sqlUsername; password = $sqlPassword }
}
$dataSourceUri = Join-ApiUri -Path '/api/data-sources'
$step1 = Invoke-Api -Method POST -Uri $dataSourceUri -Token $ownerToken -Body $dataSourceBody
if ($step1.Status -eq 201) {
  Add-AcceptanceResult -StepId 'STEP1-OWNER-CREATE-DATA-SOURCE' -Description 'owner creates read-only sqlserver data source' -Result 'PASS' -Status $step1.Status -Code $step1.Code
  $script:DataSourceCreated = $true
} else {
  Add-AcceptanceResult -StepId 'STEP1-OWNER-CREATE-DATA-SOURCE' -Description 'owner creates read-only sqlserver data source' -Result 'FAIL' -Status $step1.Status -Code $step1.Code
}

# ---------------------------------------------------------------------------
# STEP1B — claimless token, the same create request. Expect 401
# AUTHENTICATED_TENANT_REQUIRED (resolveAuthenticatedTenantId reads ONLY the
# verified-token tenant claim, never a header — data-sources.ts line ~222).
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  if ($hasClaimlessToken) {
    $step1b = Invoke-Api -Method POST -Uri $dataSourceUri -Token $claimlessToken -Body $dataSourceBody
    Test-ExpectedRefusal -StepId 'STEP1B-CLAIMLESS-CREATE-DATA-SOURCE' -Description 'claimless token replays the same create request' -ApiResult $step1b -ExpectedStatuses @(401) -ExpectedCodes @('AUTHENTICATED_TENANT_REQUIRED') | Out-Null
  } else {
    Add-AcceptanceResult -StepId 'STEP1B-CLAIMLESS-CREATE-DATA-SOURCE' -Description 'claimless token replays the same create request (no -ClaimlessTokenFile provided)' -Result 'SKIP' -Status $null -Code $null
  }
}

# ---------------------------------------------------------------------------
# STEP2 — owner binds a sql-readonly external system to the data source.
# plugin-integration-core/lib/http-routes.cjs externalSystemsUpsert: 201 for
# kind 'data-source:sql-readonly'. connectionId must equal the data source id
# and tenantId/workspaceId are derived server-side (scopedAuthenticatedWriteInput).
# ---------------------------------------------------------------------------
$externalSystemsUri = Join-ApiUri -Path '/api/integration/external-systems'
if (-not $script:Halt -and $script:DataSourceCreated) {
  $externalSystemBody = @{
    name = "acceptance-sql-binding-$DataSourceId"
    kind = 'data-source:sql-readonly'
    role = 'source'
    status = 'active'
    connectionId = $DataSourceId
    config = @{ schema = 'dbo' }
  }
  $step2 = Invoke-Api -Method POST -Uri $externalSystemsUri -Token $ownerToken -Body $externalSystemBody
  if ($step2.Status -eq 201 -and $step2.Json -and $step2.Json.data -and $step2.Json.data.id) {
    $script:ExternalSystemId = "$($step2.Json.data.id)"
    $script:ExternalSystemCreated = $true
    Add-AcceptanceResult -StepId 'STEP2-OWNER-CREATE-EXTERNAL-SYSTEM' -Description 'owner binds a sql-readonly external system' -Result 'PASS' -Status $step2.Status -Code $step2.Code
  } elseif ($step2.Status -ge 200 -and $step2.Status -lt 300) {
    Add-AcceptanceResult -StepId 'STEP2-OWNER-CREATE-EXTERNAL-SYSTEM' -Description 'owner binds a sql-readonly external system (2xx but no id echoed)' -Result 'FAIL' -Status $step2.Status -Code $step2.Code
  } else {
    Add-AcceptanceResult -StepId 'STEP2-OWNER-CREATE-EXTERNAL-SYSTEM' -Description 'owner binds a sql-readonly external system' -Result 'FAIL' -Status $step2.Status -Code $step2.Code
  }

  if ($script:ExternalSystemCreated) {
    $getUri = Join-ApiUri -Path "/api/integration/external-systems/$($script:ExternalSystemId)"
    $step2get = Invoke-Api -Method GET -Uri $getUri -Token $ownerToken
    $connectionIdMatches = $step2get.Status -eq 200 -and $step2get.Json -and $step2get.Json.data -and ("$($step2get.Json.data.connectionId)" -eq $DataSourceId)
    if ($connectionIdMatches) {
      Add-AcceptanceResult -StepId 'STEP2-OWNER-GET-EXTERNAL-SYSTEM' -Description 'binding readback echoes connectionId' -Result 'PASS' -Status $step2get.Status -Code $step2get.Code
    } else {
      Add-AcceptanceResult -StepId 'STEP2-OWNER-GET-EXTERNAL-SYSTEM' -Description 'binding readback echoes connectionId' -Result 'FAIL' -Status $step2get.Status -Code $step2get.Code
    }
  }
} else {
  Add-AcceptanceResult -StepId 'STEP2-OWNER-CREATE-EXTERNAL-SYSTEM' -Description 'owner binds a sql-readonly external system (skipped, no data source)' -Result 'SKIP' -Status $null -Code $null
}

# ---------------------------------------------------------------------------
# STEP2B — same body, plus a credentials document. Expect 400
# CONNECTION_BINDING_CREDENTIALS_FORBIDDEN (external-systems.cjs: a
# sql-readonly binding's credentials live only on the canonical Connection).
# ---------------------------------------------------------------------------
if (-not $script:Halt -and $script:ExternalSystemCreated) {
  $credentialsBody = @{
    name = "acceptance-sql-binding-$DataSourceId"
    kind = 'data-source:sql-readonly'
    role = 'source'
    status = 'active'
    connectionId = $DataSourceId
    config = @{ schema = 'dbo' }
    credentials = @{ username = 'x'; password = 'y' }
  }
  $step2b = Invoke-Api -Method POST -Uri $externalSystemsUri -Token $ownerToken -Body $credentialsBody
  Test-ExpectedRefusal -StepId 'STEP2B-CREDENTIALS-FORBIDDEN' -Description 'binding replay with an attached credentials document' -ApiResult $step2b -ExpectedStatuses @(400) -ExpectedCodes @('CONNECTION_BINDING_CREDENTIALS_FORBIDDEN') | Out-Null
} else {
  Add-AcceptanceResult -StepId 'STEP2B-CREDENTIALS-FORBIDDEN' -Description 'binding replay with an attached credentials document (skipped, no binding)' -Result 'SKIP' -Status $null -Code $null
}

# ---------------------------------------------------------------------------
# STEP3 — owner tests the connection, then confirms lastTestedAt persisted
# (the "read back after save" fix — #5534).
# ---------------------------------------------------------------------------
if (-not $script:Halt -and $script:ExternalSystemCreated) {
  $testUri = Join-ApiUri -Path "/api/integration/external-systems/$($script:ExternalSystemId)/test" -Query @{ workspaceId = $WorkspaceHint }
  $step3 = Invoke-Api -Method POST -Uri $testUri -Token $ownerToken -Body @{}
  if ($step3.Status -eq 200) {
    Add-AcceptanceResult -StepId 'STEP3-TEST-CONNECTION' -Description 'owner tests the bound connection' -Result 'PASS' -Status $step3.Status -Code $step3.Code
    $getUri = Join-ApiUri -Path "/api/integration/external-systems/$($script:ExternalSystemId)"
    $step3get = Invoke-Api -Method GET -Uri $getUri -Token $ownerToken
    $lastTestedPresent = $step3get.Status -eq 200 -and $step3get.Json -and $step3get.Json.data -and $step3get.Json.data.lastTestedAt
    if ($lastTestedPresent) {
      Add-AcceptanceResult -StepId 'STEP3-GET-LAST-TESTED' -Description 'lastTestedAt persisted after test' -Result 'PASS' -Status $step3get.Status -Code $step3get.Code
    } else {
      Add-AcceptanceResult -StepId 'STEP3-GET-LAST-TESTED' -Description 'lastTestedAt persisted after test' -Result 'FAIL' -Status $step3get.Status -Code $step3get.Code
    }
  } else {
    Add-AcceptanceResult -StepId 'STEP3-TEST-CONNECTION' -Description 'owner tests the bound connection' -Result 'FAIL' -Status $step3.Status -Code $step3.Code
    Add-AcceptanceResult -StepId 'STEP3-GET-LAST-TESTED' -Description 'lastTestedAt persisted after test (skipped, test call failed)' -Result 'SKIP' -Status $null -Code $null
  }
} else {
  Add-AcceptanceResult -StepId 'STEP3-TEST-CONNECTION' -Description 'owner tests the bound connection (skipped, no binding)' -Result 'SKIP' -Status $null -Code $null
  Add-AcceptanceResult -StepId 'STEP3-GET-LAST-TESTED' -Description 'lastTestedAt persisted after test (skipped, no binding)' -Result 'SKIP' -Status $null -Code $null
}

# ---------------------------------------------------------------------------
# STEP4 — source-preflight report. Only `data.ready` is RECORDED, not
# asserted true: the configured table-action source may not be this run's
# newly-created binding.
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  $preflightUri = Join-ApiUri -Path '/api/integration/stock-preparation/source-preflight'
  $step4 = Invoke-Api -Method GET -Uri $preflightUri -Token $ownerToken
  if ($step4.Status -eq 200) {
    $ready = $null
    if ($step4.Json -and $step4.Json.data -and $step4.Json.data.PSObject.Properties['ready']) {
      $ready = [bool]$step4.Json.data.ready
    }
    Add-AcceptanceResult -StepId 'STEP4-SOURCE-PREFLIGHT' -Description "source-preflight report (ready=$ready)" -Result 'PASS' -Status $step4.Status -Code $step4.Code
  } else {
    Add-AcceptanceResult -StepId 'STEP4-SOURCE-PREFLIGHT' -Description 'source-preflight report' -Result 'FAIL' -Status $step4.Status -Code $step4.Code
  }
}

# ---------------------------------------------------------------------------
# STEP5 — delete the data source while it is still referenced. Expect 409
# DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS (DataSourceManager.ts).
# ---------------------------------------------------------------------------
$dataSourceItemUri = Join-ApiUri -Path "/api/data-sources/$DataSourceId"
if (-not $script:Halt -and $script:ExternalSystemCreated) {
  $step5 = Invoke-Api -Method DELETE -Uri $dataSourceItemUri -Token $ownerToken
  Test-ExpectedRefusal -StepId 'STEP5-DELETE-REFERENCED-CONFLICT' -Description 'owner tries to delete the still-referenced data source' -ApiResult $step5 -ExpectedStatuses @(409) -ExpectedCodes @('DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS') | Out-Null
} else {
  Add-AcceptanceResult -StepId 'STEP5-DELETE-REFERENCED-CONFLICT' -Description 'owner tries to delete the still-referenced data source (skipped, no binding)' -Result 'SKIP' -Status $null -Code $null
}

# ---------------------------------------------------------------------------
# STEP6 — the front-line operator: project directory read, then a dry-run
# trial. Body shape read from stock-preparation-table-actions.cjs
# normalizeActionParameters: { parameters: { projectNo } }, projectNo required.
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  if ($hasOperatorToken) {
    $projectsUri = Join-ApiUri -Path '/api/integration/stock-preparation/operator/projects'
    $step6a = Invoke-Api -Method GET -Uri $projectsUri -Token $operatorToken
    if ($step6a.Status -eq 200) {
      Add-AcceptanceResult -StepId 'STEP6A-OPERATOR-PROJECT-DIRECTORY' -Description 'operator reads the project directory' -Result 'PASS' -Status $step6a.Status -Code $step6a.Code
    } else {
      Add-AcceptanceResult -StepId 'STEP6A-OPERATOR-PROJECT-DIRECTORY' -Description 'operator reads the project directory' -Result 'FAIL' -Status $step6a.Status -Code $step6a.Code
    }

    if ($hasProjectNo) {
      $dryRunUri = Join-ApiUri -Path "/api/integration/table-actions/$ActionId/dry-run"
      $dryRunBody = @{ parameters = @{ projectNo = $ProjectNo } }
      $step6b = Invoke-Api -Method POST -Uri $dryRunUri -Token $operatorToken -Body $dryRunBody
      if ($step6b.Status -eq 200) {
        Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description 'operator dry-runs the pull-bom table action' -Result 'PASS' -Status $step6b.Status -Code $step6b.Code
      } elseif ($step6b.Status -eq 400 -and $step6b.Code -eq 'CONNECTION_CANONICAL_UNAVAILABLE') {
        Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description 'operator dry-runs the pull-bom table action -- binding is missing its owner stamp; re-save the binding and retry' -Result 'FAIL' -Status $step6b.Status -Code $step6b.Code
      } else {
        Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description 'operator dry-runs the pull-bom table action' -Result 'FAIL' -Status $step6b.Status -Code $step6b.Code
      }
    } else {
      Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description 'operator dry-runs the pull-bom table action (no -ProjectNo provided)' -Result 'SKIP' -Status $null -Code $null
    }
  } else {
    Add-AcceptanceResult -StepId 'STEP6A-OPERATOR-PROJECT-DIRECTORY' -Description 'operator reads the project directory (no -OperatorTokenFile provided)' -Result 'SKIP' -Status $null -Code $null
    Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description 'operator dry-runs the pull-bom table action (no -OperatorTokenFile provided)' -Result 'SKIP' -Status $null -Code $null
  }
}

# ---------------------------------------------------------------------------
# STEP7 — claimless token, plus an x-tenant-id header, tries to create a SQL
# binding. Classification (http-routes.cjs resolveAuthUserTenantId /
# assertVerifiedTenantClaim, the W4 tenant-claim hard door):
#   403 OPERATOR_SCOPE_TENANT_REQUIRED  -> PASS  (W4 flag on)
#   201                                 -> ISOLATION_BREACH
#   400 TENANT_REQUIRED                 -> WARN  (W4 flag off; not a FAIL)
#   anything else                       -> FAIL
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  if ($hasClaimlessToken) {
    $step7Body = @{
      name = "acceptance-sql-binding-tenant-probe-$DataSourceId"
      kind = 'data-source:sql-readonly'
      role = 'source'
      status = 'active'
      connectionId = $DataSourceId
      config = @{ schema = 'dbo' }
    }
    $step7 = Invoke-Api -Method POST -Uri $externalSystemsUri -Token $claimlessToken -ExtraHeaders @{ 'x-tenant-id' = $TenantId } -Body $step7Body
    if ($step7.Status -ge 200 -and $step7.Status -lt 300) {
      if ($step7.Json -and $step7.Json.data -and $step7.Json.data.id) { $script:ExternalSystemId7 = "$($step7.Json.data.id)" }
      Add-AcceptanceResult -StepId 'STEP7-CLAIMLESS-TENANT-HEADER-SQL-BINDING' -Description 'claimless token + x-tenant-id header creates a sql binding' -Result 'ISOLATION_BREACH' -Status $step7.Status -Code $step7.Code
    } elseif ($step7.Status -eq 403 -and $step7.Code -eq 'OPERATOR_SCOPE_TENANT_REQUIRED') {
      Add-AcceptanceResult -StepId 'STEP7-CLAIMLESS-TENANT-HEADER-SQL-BINDING' -Description 'claimless token + x-tenant-id header creates a sql binding' -Result 'PASS' -Status $step7.Status -Code $step7.Code
    } elseif ($step7.Status -eq 400 -and $step7.Code -eq 'TENANT_REQUIRED') {
      Add-AcceptanceResult -StepId 'STEP7-CLAIMLESS-TENANT-HEADER-SQL-BINDING' -Description 'claimless token + x-tenant-id header creates a sql binding -- W4 tenant-claim door appears OFF on this deployment (400 TENANT_REQUIRED, not 403 OPERATOR_SCOPE_TENANT_REQUIRED)' -Result 'WARN' -Status $step7.Status -Code $step7.Code
    } else {
      Add-AcceptanceResult -StepId 'STEP7-CLAIMLESS-TENANT-HEADER-SQL-BINDING' -Description 'claimless token + x-tenant-id header creates a sql binding' -Result 'FAIL' -Status $step7.Status -Code $step7.Code
    }
  } else {
    Add-AcceptanceResult -StepId 'STEP7-CLAIMLESS-TENANT-HEADER-SQL-BINDING' -Description 'claimless token + x-tenant-id header creates a sql binding (no -ClaimlessTokenFile provided)' -Result 'SKIP' -Status $null -Code $null
  }
}

# ---------------------------------------------------------------------------
# STEP8 — owner, but the body carries a foreign tenantId. Expect 403
# TENANT_MISMATCH (http-routes.cjs resolveAuthenticatedWriteTenantId).
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  $step8Body = @{
    name = "acceptance-sql-binding-mismatch-$DataSourceId"
    kind = 'data-source:sql-readonly'
    role = 'source'
    status = 'active'
    connectionId = $DataSourceId
    config = @{ schema = 'dbo' }
    tenantId = $OtherTenantId
  }
  $step8 = Invoke-Api -Method POST -Uri $externalSystemsUri -Token $ownerToken -Body $step8Body
  if ($step8.Status -ge 200 -and $step8.Status -lt 300 -and $step8.Json -and $step8.Json.data -and $step8.Json.data.id) {
    $script:ExternalSystemId8 = "$($step8.Json.data.id)"
  }
  Test-ExpectedRefusal -StepId 'STEP8-TENANT-MISMATCH-SQL-BINDING' -Description 'owner creates a sql binding under a foreign tenantId' -ApiResult $step8 -ExpectedStatuses @(403) -ExpectedCodes @('TENANT_MISMATCH') | Out-Null
}

# ---------------------------------------------------------------------------
# STEP9 — the operator tries a raw SQL query against the data source.
# packages/core-backend/src/routes/data-sources.ts POST /:id/query uses the
# bare-user-id (owner-only) actor shape: a non-owner either fails the
# rbacGuard('data_sources','execute') tier first (403, flat `{error:string}`
# body -- no error.code) or clears it and hits DataSourceManager.assertAccess,
# which throws the SAME "not found" wording for a non-owner as for a missing
# id (404 NOT_FOUND) so existence cannot be inferred either way. Both are a
# correct refusal; this accepts either and records exactly which fired.
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  if ($hasOperatorToken) {
    $queryUri = Join-ApiUri -Path "/api/data-sources/$DataSourceId/query"
    $step9 = Invoke-Api -Method POST -Uri $queryUri -Token $operatorToken -Body @{ sql = 'select 1' }
    if ($step9.Status -ge 200 -and $step9.Status -lt 300) {
      Add-AcceptanceResult -StepId 'STEP9-OPERATOR-RAW-QUERY-FORBIDDEN' -Description 'operator tries a raw SQL query against the data source' -Result 'ISOLATION_BREACH' -Status $step9.Status -Code $step9.Code
    } elseif ($step9.Status -eq 403 -or ($step9.Status -eq 404 -and $step9.Code -eq 'NOT_FOUND')) {
      Add-AcceptanceResult -StepId 'STEP9-OPERATOR-RAW-QUERY-FORBIDDEN' -Description 'operator tries a raw SQL query against the data source' -Result 'PASS' -Status $step9.Status -Code $step9.Code
    } else {
      Add-AcceptanceResult -StepId 'STEP9-OPERATOR-RAW-QUERY-FORBIDDEN' -Description 'operator tries a raw SQL query against the data source' -Result 'FAIL' -Status $step9.Status -Code $step9.Code
    }
  } else {
    Add-AcceptanceResult -StepId 'STEP9-OPERATOR-RAW-QUERY-FORBIDDEN' -Description 'operator tries a raw SQL query against the data source (no -OperatorTokenFile provided)' -Result 'SKIP' -Status $null -Code $null
  }
}

# ---------------------------------------------------------------------------
# CLEANUP — best-effort, runs even after a halt/breach unless -KeepFixtures.
# A failure here is a WARN, never a FAIL: an acceptance run must not itself
# leave the exit code green or red purely on teardown noise.
# ---------------------------------------------------------------------------
if (-not $KeepFixtures) {
  $cleanupIds = @()
  if ($script:ExternalSystemId) { $cleanupIds += $script:ExternalSystemId }
  if ($script:ExternalSystemId7) { $cleanupIds += $script:ExternalSystemId7 }
  if ($script:ExternalSystemId8) { $cleanupIds += $script:ExternalSystemId8 }
  foreach ($id in $cleanupIds) {
    $deleteUri = Join-ApiUri -Path "/api/integration/external-systems/$id"
    $cleanupExt = Invoke-Api -Method DELETE -Uri $deleteUri -Token $ownerToken
    if ($cleanupExt.Status -ge 200 -and $cleanupExt.Status -lt 300) {
      Add-AcceptanceResult -StepId 'CLEANUP-DELETE-EXTERNAL-SYSTEM' -Description 'owner removes an acceptance external-system fixture' -Result 'PASS' -Status $cleanupExt.Status -Code $cleanupExt.Code
    } else {
      Add-AcceptanceResult -StepId 'CLEANUP-DELETE-EXTERNAL-SYSTEM' -Description 'owner removes an acceptance external-system fixture' -Result 'WARN' -Status $cleanupExt.Status -Code $cleanupExt.Code
    }
  }
  if ($script:DataSourceCreated) {
    $cleanupDs = Invoke-Api -Method DELETE -Uri $dataSourceItemUri -Token $ownerToken
    if ($cleanupDs.Status -ge 200 -and $cleanupDs.Status -lt 300) {
      Add-AcceptanceResult -StepId 'CLEANUP-DELETE-DATA-SOURCE' -Description 'owner removes the acceptance data-source fixture' -Result 'PASS' -Status $cleanupDs.Status -Code $cleanupDs.Code
    } else {
      Add-AcceptanceResult -StepId 'CLEANUP-DELETE-DATA-SOURCE' -Description 'owner removes the acceptance data-source fixture' -Result 'WARN' -Status $cleanupDs.Status -Code $cleanupDs.Code
    }
  }
} else {
  Add-AcceptanceResult -StepId 'CLEANUP-DELETE-EXTERNAL-SYSTEM' -Description 'owner removes acceptance fixtures (skipped, -KeepFixtures)' -Result 'SKIP' -Status $null -Code $null
  Add-AcceptanceResult -StepId 'CLEANUP-DELETE-DATA-SOURCE' -Description 'owner removes acceptance fixtures (skipped, -KeepFixtures)' -Result 'SKIP' -Status $null -Code $null
}

# ---------------------------------------------------------------------------
# SUMMARY — printed table, then a values-free JSON report on disk.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '===== SQL SOURCE ONBOARDING ACCEPTANCE SUMMARY ====='
Write-Host ("{0,-42} {1,-16} {2,-8} {3}" -f 'STEP', 'RESULT', 'STATUS', 'CODE')
foreach ($result in $script:Results) {
  Write-Host ("{0,-42} {1,-16} {2,-8} {3}" -f $result.stepId, $result.result, $result.status, $result.code)
}
Write-Host ("EXIT CODE: $script:ExitCode  ISOLATION_BREACH: $script:IsolationBreach")

$reportSteps = @()
foreach ($result in $script:Results) {
  $reportSteps += [ordered]@{
    stepId = $result.stepId
    description = $result.description
    result = $result.result
    status = $result.status
    code = $result.code
  }
}
$report = [ordered]@{
  schema = 'stock-preparation/sql-source-onboarding-acceptance/v1'
  capturedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  dryRun = $false
  keepFixtures = [bool]$KeepFixtures
  isolationBreach = $script:IsolationBreach
  exitCode = $script:ExitCode
  steps = $reportSteps
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 8), $utf8NoBom)
Write-Host "Report written: $ReportPath"

exit $script:ExitCode
