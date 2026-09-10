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
    STEP3  owner: POST .../external-systems/:id/test                      -> 200 AND data.ok true,
                                                                            then GET shows lastTestedAt,
                                                                            status != 'error', empty lastError
    STEP4  owner: GET  .../stock-preparation/source-binding                -> is the table action bound to
                                                                            THIS run's source? (closed loop)
           owner: GET  .../external-systems/:boundId                       -> connectionId of the bound source
           owner: GET  .../stock-preparation/source-preflight              -> 200 AND data.ok/data.verdict=go
    STEP5  owner: DELETE /api/data-sources/:id (still referenced)          -> 409 DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS
    STEP6  operator: GET .../operator/projects, POST .../table-actions/:id/dry-run
    STEP7  claimless token + x-tenant-id header, create SQL binding        -> 403 OPERATOR_SCOPE_TENANT_REQUIRED
    STEP8  owner, create SQL binding with a foreign tenantId               -> 403 TENANT_MISMATCH
    STEP9  operator: POST /api/data-sources/:id/query                     -> refused (403 or 404)

  CLOSED LOOP vs ENV PROBE. STEP4's preflight and STEP6's dry-run read
  whatever source the deployed table action is bound to -- which is normally
  NOT the throwaway source this run just created. This script never rebinds
  production to close that gap. It READS the binding instead
  (GET /api/integration/stock-preparation/source-binding ->
  effectiveExternalSystemId -> that system's connectionId) and labels both
  steps:
    CLOSED_LOOP  the bound source IS this run's new data source; "new source
                 -> front-line dry-run" was proven end to end.
    ENV_PROBE    the bound source is a pre-existing one; STEP4/STEP6 are then
                 independent probes of the deployment, and the summary says so
                 in as many words. A run like that can never conclude
                 CLOSED_LOOP_PASS.

  Every request is logged values-free: step id, HTTP status, error.code, and
  fixed booleans/counts only. Never the token, credentials, connection
  string, or raw response body -- the pre-existing bound source is named only
  by `boundSourceDigest`, the first 12 hex of SHA-256(id).

  Any FAIL exits 1. A step that expected a 4xx refusal and got a 2xx is
  marked ISOLATION_BREACH and halts every step after it immediately
  (best-effort cleanup still runs).

  CREDENTIAL FILE CONVENTION. -SqlUsernameFile / -SqlPasswordFile are read
  BYTE-EXACT except for ONE optional trailing newline (CRLF or LF): a
  leading or trailing SPACE in a SQL password is part of the password and is
  preserved. Token files (-OwnerTokenFile / -OperatorTokenFile /
  -ClaimlessTokenFile) are whitespace-trimmed at both ends, because a bearer
  token cannot contain whitespace. Write credential files as UTF-8 (BOM
  optional) or ASCII; `Set-Content -NoNewline` and a single trailing newline
  both round-trip identically.

  -SelfTest runs the pure verdict/classifier functions plus the two file
  readers against built-in fixtures, prints one values-free JSON document and
  exits 0. It opens no socket and reads no real credential; the contract test
  (scripts/ops/__tests__/stock-preparation-sql-source-onboarding-acceptance-contract.test.mjs)
  drives it and grades the output.

  Reference reading for every expected status/code lives in:
    packages/core-backend/src/routes/data-sources.ts
    plugins/plugin-integration-core/lib/http-routes.cjs
    plugins/plugin-integration-core/lib/external-systems.cjs
    plugins/plugin-integration-core/lib/stock-preparation-source-preflight.cjs
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
  [switch]$SelfTest,
  [string]$SelfTestFixtureDir,
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
  [ordered]@{ Id = 'STEP4-ACTION-SOURCE-BINDING';                  Method = 'GET';    Path = '/api/integration/stock-preparation/source-binding';       Description = 'owner reads which source the table action is actually bound to' }
  [ordered]@{ Id = 'STEP4-BOUND-SOURCE-CONNECTION';                Method = 'GET';    Path = '/api/integration/external-systems/{boundExternalSystemId}'; Description = 'owner reads the bound systems connectionId to compare it with this runs data source' }
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
# PURE VERDICT FUNCTIONS -- no HTTP, no files, no script-scope state. They sit
# HERE, above `Invoke-Api`, on purpose: PowerShell binds a function name only
# when execution passes its definition, so `-SelfTest` below cannot reach a
# network call even by accident.
#
# Every one of them returns [pscustomobject]@{ Result; Code } where Code comes
# from a fixed vocabulary -- never a message, a lastError, or an id from the
# server.
# ---------------------------------------------------------------------------
function New-Verdict {
  param([string]$Result, [string]$Code)
  return [pscustomobject]@{ Result = $Result; Code = $Code }
}

function Get-JsonField {
  # `Set-StrictMode -Version Latest` turns `$obj.missing` into a TERMINATING
  # PropertyNotFoundException on Windows PowerShell 5.1, so every response
  # field on a payload whose shape is the server's business is read here.
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Test-NonEmptyText {
  param($Value)
  if ($null -eq $Value) { return $false }
  return ("$Value").Trim().Length -gt 0
}

# STEP3 leg 1 -- the business-success half. `externalSystemsTest`
# (http-routes.cjs) answers 200 EVEN WHEN THE CONNECTION FAILED: the adapter
# throw is caught, converted to `testConnectionErrorResult` ({ ok:false, code,
# message }) and handed to `sendOk`. HTTP 200 alone therefore proves only that
# the route ran. `data.ok` must be a REAL boolean true -- absent, "true" and 1
# all fail closed.
function Get-ConnectionTestCallVerdict {
  param([int]$Status, $Data)
  if ($Status -ne 200) { return New-Verdict 'FAIL' 'TEST_CALL_HTTP_NOT_200' }
  $ok = Get-JsonField $Data 'ok'
  if (-not ($ok -is [bool]) -or -not $ok) { return New-Verdict 'FAIL' 'TEST_RESULT_NOT_OK' }
  return New-Verdict 'PASS' 'CONNECTION_TEST_OK'
}

# STEP3 leg 2 -- the persisted half. `persistExternalSystemTestResult` saves a
# FAILED test too: `resolveTestedStatus` writes status='error' and
# `resolveTestError` writes a non-null lastError. Asserting only that
# `lastTestedAt` exists passes on exactly that row, which is the fake-PASS this
# leg closes. status='inactive' is NOT a failure -- an intentionally inactive
# system stays inactive after a good test. lastError is asserted EMPTY and
# never echoed.
function Get-ConnectionReadbackVerdict {
  param([int]$Status, $Data)
  if ($Status -ne 200) { return New-Verdict 'FAIL' 'READBACK_HTTP_NOT_200' }
  if (-not (Test-NonEmptyText (Get-JsonField $Data 'lastTestedAt'))) { return New-Verdict 'FAIL' 'TESTED_AT_ABSENT' }
  if (("$(Get-JsonField $Data 'status')") -eq 'error') { return New-Verdict 'FAIL' 'SOURCE_STATUS_ERROR' }
  if (Test-NonEmptyText (Get-JsonField $Data 'lastError')) { return New-Verdict 'FAIL' 'LAST_ERROR_PRESENT' }
  return New-Verdict 'PASS' 'CONNECTION_VERIFIED'
}

# STEP4 preflight. The real report is
# `{ ok: blockers.length === 0, verdict: 'go' | 'no-go', ... }`
# (stock-preparation-source-preflight.cjs). There is no `ready` key anywhere on
# that route, so an assertion on one reads $null on every deployment and leaves
# HTTP 200 as the only real gate.
function Get-SourcePreflightVerdict {
  param([int]$Status, $Data)
  if ($Status -ne 200) { return New-Verdict 'FAIL' 'PREFLIGHT_HTTP_NOT_200' }
  $ok = Get-JsonField $Data 'ok'
  $verdict = "$(Get-JsonField $Data 'verdict')"
  if (-not ($ok -is [bool]) -or -not (Test-NonEmptyText $verdict)) { return New-Verdict 'FAIL' 'PREFLIGHT_FIELDS_ABSENT' }
  if ($verdict -eq 'no-go') { return New-Verdict 'FAIL' 'PREFLIGHT_VERDICT_NO_GO' }
  if ($verdict -ne 'go') { return New-Verdict 'FAIL' 'PREFLIGHT_VERDICT_UNKNOWN' }
  if (-not $ok) { return New-Verdict 'FAIL' 'PREFLIGHT_NOT_OK' }
  return New-Verdict 'PASS' 'PREFLIGHT_GO'
}

# STEP4/STEP6 scope. READ-ONLY id arithmetic: it answers "is the table action
# the front line will run bound to the source this run just created?" and never
# rebinds anything to make the answer yes. Anything short of a proven match is
# ENV_PROBE, so an unreadable binding degrades the CLAIM, never the gate.
function Get-ActionSourceChainVerdict {
  param(
    [int]$BindingStatus,
    $BindingData,
    [string]$ExpectedActionId,
    [int]$BoundSystemStatus,
    $BoundSystemData,
    [string]$ExpectedDataSourceId
  )
  if ($BindingStatus -eq 401 -or $BindingStatus -eq 403) { return New-Verdict 'ENV_PROBE' 'BINDING_READBACK_FORBIDDEN' }
  if ($BindingStatus -ne 200) { return New-Verdict 'ENV_PROBE' 'BINDING_READBACK_UNAVAILABLE' }
  if (("$(Get-JsonField $BindingData 'actionId')") -ne $ExpectedActionId) { return New-Verdict 'ENV_PROBE' 'ACTION_ID_MISMATCH' }
  if (-not (Test-NonEmptyText (Get-JsonField $BindingData 'effectiveExternalSystemId'))) { return New-Verdict 'ENV_PROBE' 'NO_SOURCE_BOUND' }
  if ($BoundSystemStatus -ne 200) { return New-Verdict 'ENV_PROBE' 'BOUND_SYSTEM_UNREADABLE' }
  $connectionId = "$(Get-JsonField $BoundSystemData 'connectionId')"
  if (-not (Test-NonEmptyText $connectionId)) { return New-Verdict 'ENV_PROBE' 'BOUND_SYSTEM_HAS_NO_CONNECTION' }
  if ($connectionId -ne $ExpectedDataSourceId) { return New-Verdict 'ENV_PROBE' 'BOUND_TO_OTHER_SOURCE' }
  return New-Verdict 'CLOSED_LOOP' 'BOUND_TO_THIS_RUNS_SOURCE'
}

function Get-IdDigest {
  # The values-free way to name a pre-existing source in a report: enough to
  # match against a known id (hash it the same way) and to tell two runs apart,
  # never the id itself.
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return 'n/a' }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))
  } finally {
    $sha256.Dispose()
  }
  return (-join ($bytes | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
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
# Secrets — read from file, never echoed. A missing REQUIRED file throws; a
# missing OPTIONAL file (claimless token, operator token) is the caller's own
# SKIP signal for the negative/operator checks that need it.
#
# TWO readers, not one. A bearer token cannot contain whitespace, so trimming
# it is safe and forgiving. A SQL login or password CAN legitimately begin or
# end with a space, and `.Trim()` silently rewrote it into a different
# credential -- an authentication failure that looks exactly like a wrong
# password. See the file convention in the header block.
# ---------------------------------------------------------------------------
function Read-AcceptanceFileText {
  param([string]$Path, [switch]$Required, [string]$Label)
  if (-not $Path -or $Path.Trim().Length -eq 0) {
    if ($Required) { throw [System.InvalidOperationException]::new("MISSING_REQUIRED_INPUT:$Label") }
    return $null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    if ($Required) { throw [System.InvalidOperationException]::new("FILE_NOT_FOUND:$Label") }
    return $null
  }
  # NOT `Get-Content -Raw`: Windows PowerShell 5.1 decodes a BOM-less file with
  # the ANSI code page, which mangles a UTF-8 password on a zh-CN box.
  # ReadAllText honours a BOM when there is one and decodes UTF-8 when there is
  # not, and it returns the trailing newline instead of eating it.
  $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
  return [System.IO.File]::ReadAllText($resolved, [System.Text.Encoding]::UTF8)
}

function Read-AcceptanceToken {
  # Whitespace-trimmed at BOTH ends: no bearer token contains whitespace, so
  # this can only ever remove an editor's stray newline or indent.
  param([string]$Path, [switch]$Required, [string]$Label)
  $raw = Read-AcceptanceFileText -Path $Path -Required:$Required -Label $Label
  if ($null -eq $raw) { return $null }
  return $raw.Trim()
}

function Read-AcceptanceCredential {
  # Byte-exact apart from ONE trailing newline (CRLF or LF) -- the one nearly
  # every editor appends. Leading/trailing SPACES survive. A SECOND trailing
  # newline also survives, so a double-newline file fails to authenticate
  # loudly instead of being silently repaired into something that works here
  # and nowhere else.
  param([string]$Path, [switch]$Required, [string]$Label)
  $raw = Read-AcceptanceFileText -Path $Path -Required:$Required -Label $Label
  if ($null -eq $raw) { return $null }
  if ($raw.EndsWith("`r`n")) { return $raw.Substring(0, $raw.Length - 2) }
  if ($raw.EndsWith("`n")) { return $raw.Substring(0, $raw.Length - 1) }
  return $raw
}

# ---------------------------------------------------------------------------
# -SelfTest — drive the pure verdict functions above on fixed synthetic
# payloads and the two readers above on caller-supplied FIXTURE files, print
# one values-free JSON document, exit 0. No socket (`Invoke-Api` is not defined
# yet at this point in the file), no server, no real credential:
# -SelfTestFixtureDir is for throwaway probe files written by the contract
# test, never for a real token or password file.
#
# The output says WHAT EACH CLASSIFIER DECIDED and deliberately never says what
# the answer was supposed to be. The expectations live in
# scripts/ops/__tests__/stock-preparation-sql-source-onboarding-acceptance-contract.test.mjs,
# so this script cannot grade its own homework.
# ---------------------------------------------------------------------------
if ($SelfTest) {
  $selfTestCases = New-Object System.Collections.ArrayList
  $selfTestReaders = New-Object System.Collections.ArrayList

  function Add-SelfTestCase {
    param([string]$Id, [string]$Kind, $Verdict)
    [void]$selfTestCases.Add([pscustomobject]([ordered]@{
      id = $Id
      kind = $Kind
      result = $Verdict.Result
      code = $Verdict.Code
    }))
  }

  function ConvertFrom-SelfTestJson {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $null }
    return ($Text | ConvertFrom-Json)
  }

  # --- STEP3 leg 1: the connection-test CALL -----------------------------
  Add-SelfTestCase -Id 'connect-call-ok' -Kind 'connection-test-call' -Verdict (
    Get-ConnectionTestCallVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"ok":true,"status":"connected"}'))
  # The exact production shape the reviewer reproduced: HTTP 200, ok:false.
  Add-SelfTestCase -Id 'connect-call-http200-ok-false' -Kind 'connection-test-call' -Verdict (
    Get-ConnectionTestCallVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"ok":false,"code":"TEST_CONNECTION_FAILED","message":"login failed"}'))
  Add-SelfTestCase -Id 'connect-call-ok-field-absent' -Kind 'connection-test-call' -Verdict (
    Get-ConnectionTestCallVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"status":"connected"}'))
  Add-SelfTestCase -Id 'connect-call-ok-string-true' -Kind 'connection-test-call' -Verdict (
    Get-ConnectionTestCallVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"ok":"true"}'))
  Add-SelfTestCase -Id 'connect-call-http-500' -Kind 'connection-test-call' -Verdict (
    Get-ConnectionTestCallVerdict -Status 500 -Data $null)

  # --- STEP3 leg 2: the persisted READBACK -------------------------------
  Add-SelfTestCase -Id 'connect-readback-clean' -Kind 'connection-test-readback' -Verdict (
    Get-ConnectionReadbackVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"status":"active","lastTestedAt":"2026-09-10T00:00:00.000Z","lastError":null}'))
  # The saved failure: lastTestedAt IS there, and that used to be the whole test.
  Add-SelfTestCase -Id 'connect-readback-status-error' -Kind 'connection-test-readback' -Verdict (
    Get-ConnectionReadbackVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"status":"error","lastTestedAt":"2026-09-10T00:00:00.000Z","lastError":"connection test failed"}'))
  Add-SelfTestCase -Id 'connect-readback-last-error-only' -Kind 'connection-test-readback' -Verdict (
    Get-ConnectionReadbackVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"status":"active","lastTestedAt":"2026-09-10T00:00:00.000Z","lastError":"connection test failed"}'))
  Add-SelfTestCase -Id 'connect-readback-inactive-is-not-a-failure' -Kind 'connection-test-readback' -Verdict (
    Get-ConnectionReadbackVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"status":"inactive","lastTestedAt":"2026-09-10T00:00:00.000Z","lastError":null}'))
  Add-SelfTestCase -Id 'connect-readback-no-tested-at' -Kind 'connection-test-readback' -Verdict (
    Get-ConnectionReadbackVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"status":"active","lastError":null}'))
  Add-SelfTestCase -Id 'connect-readback-http-404' -Kind 'connection-test-readback' -Verdict (
    Get-ConnectionReadbackVerdict -Status 404 -Data $null)

  # --- STEP4: source preflight ------------------------------------------
  Add-SelfTestCase -Id 'preflight-go' -Kind 'source-preflight' -Verdict (
    Get-SourcePreflightVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"ok":true,"verdict":"go","blockers":[]}'))
  Add-SelfTestCase -Id 'preflight-no-go' -Kind 'source-preflight' -Verdict (
    Get-SourcePreflightVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"ok":false,"verdict":"no-go","blockers":[{"code":"X"}]}'))
  # The field that never existed: a `ready`-only body must not pass on 200.
  Add-SelfTestCase -Id 'preflight-ready-field-only' -Kind 'source-preflight' -Verdict (
    Get-SourcePreflightVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"ready":true}'))
  Add-SelfTestCase -Id 'preflight-ok-false-verdict-go' -Kind 'source-preflight' -Verdict (
    Get-SourcePreflightVerdict -Status 200 -Data (ConvertFrom-SelfTestJson '{"ok":false,"verdict":"go"}'))
  Add-SelfTestCase -Id 'preflight-http-409' -Kind 'source-preflight' -Verdict (
    Get-SourcePreflightVerdict -Status 409 -Data $null)

  # --- STEP4/STEP6: is the action bound to THIS run's source? ------------
  $chainBindingJson = '{"actionId":"plm.stock-preparation.pull-bom.v1","effectiveExternalSystemId":"es-1","origin":"persisted"}'
  Add-SelfTestCase -Id 'chain-bound-to-this-run' -Kind 'action-source-chain' -Verdict (
    Get-ActionSourceChainVerdict -BindingStatus 200 -BindingData (ConvertFrom-SelfTestJson $chainBindingJson) -ExpectedActionId 'plm.stock-preparation.pull-bom.v1' -BoundSystemStatus 200 -BoundSystemData (ConvertFrom-SelfTestJson '{"id":"es-1","connectionId":"acc-sql-20260910"}') -ExpectedDataSourceId 'acc-sql-20260910')
  Add-SelfTestCase -Id 'chain-bound-to-other-source' -Kind 'action-source-chain' -Verdict (
    Get-ActionSourceChainVerdict -BindingStatus 200 -BindingData (ConvertFrom-SelfTestJson $chainBindingJson) -ExpectedActionId 'plm.stock-preparation.pull-bom.v1' -BoundSystemStatus 200 -BoundSystemData (ConvertFrom-SelfTestJson '{"id":"es-1","connectionId":"legacy-plm-source"}') -ExpectedDataSourceId 'acc-sql-20260910')
  Add-SelfTestCase -Id 'chain-binding-forbidden' -Kind 'action-source-chain' -Verdict (
    Get-ActionSourceChainVerdict -BindingStatus 403 -BindingData $null -ExpectedActionId 'plm.stock-preparation.pull-bom.v1' -BoundSystemStatus 0 -BoundSystemData $null -ExpectedDataSourceId 'acc-sql-20260910')
  Add-SelfTestCase -Id 'chain-action-id-mismatch' -Kind 'action-source-chain' -Verdict (
    Get-ActionSourceChainVerdict -BindingStatus 200 -BindingData (ConvertFrom-SelfTestJson $chainBindingJson) -ExpectedActionId 'some.other.action.v1' -BoundSystemStatus 200 -BoundSystemData (ConvertFrom-SelfTestJson '{"id":"es-1","connectionId":"acc-sql-20260910"}') -ExpectedDataSourceId 'acc-sql-20260910')
  Add-SelfTestCase -Id 'chain-nothing-bound' -Kind 'action-source-chain' -Verdict (
    Get-ActionSourceChainVerdict -BindingStatus 200 -BindingData (ConvertFrom-SelfTestJson '{"actionId":"plm.stock-preparation.pull-bom.v1","effectiveExternalSystemId":null,"origin":"unconfigured"}') -ExpectedActionId 'plm.stock-preparation.pull-bom.v1' -BoundSystemStatus 0 -BoundSystemData $null -ExpectedDataSourceId 'acc-sql-20260910')
  Add-SelfTestCase -Id 'chain-bound-system-unreadable' -Kind 'action-source-chain' -Verdict (
    Get-ActionSourceChainVerdict -BindingStatus 200 -BindingData (ConvertFrom-SelfTestJson $chainBindingJson) -ExpectedActionId 'plm.stock-preparation.pull-bom.v1' -BoundSystemStatus 404 -BoundSystemData $null -ExpectedDataSourceId 'acc-sql-20260910')

  # --- The two file readers, round-tripped through a real file ----------
  # Reported structurally (length, space counts, "does it still end in a
  # newline") so the proof needs no value in the output. `*.credential.probe`
  # goes through Read-AcceptanceCredential, `*.token.probe` through
  # Read-AcceptanceToken; the contract test writes the bytes and owns the
  # expectations.
  if ($SelfTestFixtureDir -and $SelfTestFixtureDir.Trim().Length -gt 0) {
    if (-not (Test-Path -LiteralPath $SelfTestFixtureDir -PathType Container)) {
      throw [System.InvalidOperationException]::new('FILE_NOT_FOUND:SelfTestFixtureDir')
    }
    $probeFiles = @(Get-ChildItem -LiteralPath $SelfTestFixtureDir -File | Sort-Object -Property Name)
    foreach ($probeFile in $probeFiles) {
      $reader = $null
      if ($probeFile.Name -like '*.credential.probe') { $reader = 'credential' }
      elseif ($probeFile.Name -like '*.token.probe') { $reader = 'token' }
      if (-not $reader) { continue }
      $text = if ($reader -eq 'credential') {
        Read-AcceptanceCredential -Path $probeFile.FullName -Required -Label 'SelfTestFixture'
      } else {
        Read-AcceptanceToken -Path $probeFile.FullName -Required -Label 'SelfTestFixture'
      }
      $leadingSpaces = 0
      while ($leadingSpaces -lt $text.Length -and $text[$leadingSpaces] -eq ' ') { $leadingSpaces++ }
      $trailingSpaces = 0
      while ($trailingSpaces -lt $text.Length -and $text[$text.Length - 1 - $trailingSpaces] -eq ' ') { $trailingSpaces++ }
      [void]$selfTestReaders.Add([pscustomobject]([ordered]@{
        file = $probeFile.Name
        reader = $reader
        length = $text.Length
        leadingSpaces = $leadingSpaces
        trailingSpaces = $trailingSpaces
        endsWithNewline = ($text.EndsWith("`n") -or $text.EndsWith("`r"))
      }))
    }
  }

  $selfTestReport = [ordered]@{
    schema = 'stock-preparation/sql-source-onboarding-acceptance/self-test/v1'
    cases = @($selfTestCases)
    readers = @($selfTestReaders)
  }
  Write-Output ($selfTestReport | ConvertTo-Json -Depth 6)
  exit 0
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
$ownerToken = Read-AcceptanceToken -Path $OwnerTokenFile -Required -Label 'OwnerTokenFile'
$claimlessToken = Read-AcceptanceToken -Path $ClaimlessTokenFile -Label 'ClaimlessTokenFile'
$operatorToken = Read-AcceptanceToken -Path $OperatorTokenFile -Label 'OperatorTokenFile'
# Credentials, NOT tokens: read byte-exact apart from one trailing newline.
$sqlUsername = Read-AcceptanceCredential -Path $SqlUsernameFile -Required -Label 'SqlUsernameFile'
$sqlPassword = Read-AcceptanceCredential -Path $SqlPasswordFile -Required -Label 'SqlPasswordFile'

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
# STEP4/STEP6 scope, resolved by the chain readback below. Until it is proven
# otherwise this run is NOT a closed loop -- fail-closed on the CLAIM.
$script:ChainMode = 'ENV_PROBE'
$script:ChainCode = 'CHAIN_NOT_CHECKED'
$script:BoundSourceDigest = 'n/a'

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
# STEP3 — owner tests the connection, then reads the SAVED result back.
#
# HTTP 200 IS NOT SUCCESS HERE. `externalSystemsTest` catches the adapter's
# throw, wraps it as { ok:false, ... } and still answers 200, and
# `persistExternalSystemTestResult` then saves status='error' + a non-null
# lastError WITH a fresh lastTestedAt. So a source that cannot be reached at
# all produces: 200, lastTestedAt present -- the two things the first version
# of this step asserted. Both legs now assert the business fields:
#   leg 1  data.ok is boolean true
#   leg 2  lastTestedAt present AND status != 'error' AND lastError empty
# The readback runs even when leg 1 failed: it is a GET, and status/lastError
# are the evidence that says WHICH kind of failure this was. lastError is
# never echoed -- only a fixed classification code.
# ---------------------------------------------------------------------------
if (-not $script:Halt -and $script:ExternalSystemCreated) {
  $testUri = Join-ApiUri -Path "/api/integration/external-systems/$($script:ExternalSystemId)/test" -Query @{ workspaceId = $WorkspaceHint }
  $step3 = Invoke-Api -Method POST -Uri $testUri -Token $ownerToken -Body @{}
  $step3Verdict = Get-ConnectionTestCallVerdict -Status $step3.Status -Data (Get-JsonField $step3.Json 'data')
  Add-AcceptanceResult -StepId 'STEP3-TEST-CONNECTION' -Description 'owner tests the bound connection (HTTP 200 AND data.ok)' -Result $step3Verdict.Result -Status $step3.Status -Code $step3Verdict.Code

  $getUri = Join-ApiUri -Path "/api/integration/external-systems/$($script:ExternalSystemId)"
  $step3get = Invoke-Api -Method GET -Uri $getUri -Token $ownerToken
  $step3getVerdict = Get-ConnectionReadbackVerdict -Status $step3get.Status -Data (Get-JsonField $step3get.Json 'data')
  Add-AcceptanceResult -StepId 'STEP3-GET-LAST-TESTED' -Description 'saved test result: lastTestedAt present, status not error, lastError empty' -Result $step3getVerdict.Result -Status $step3get.Status -Code $step3getVerdict.Code
} else {
  Add-AcceptanceResult -StepId 'STEP3-TEST-CONNECTION' -Description 'owner tests the bound connection (skipped, no binding)' -Result 'SKIP' -Status $null -Code $null
  Add-AcceptanceResult -StepId 'STEP3-GET-LAST-TESTED' -Description 'lastTestedAt persisted after test (skipped, no binding)' -Result 'SKIP' -Status $null -Code $null
}

# ---------------------------------------------------------------------------
# STEP4 — WHICH SOURCE IS THE FRONT LINE ACTUALLY GOING TO READ, and is that
# source healthy?
#
# Legs 1+2 answer the first question by READING the deployment, never by
# rewriting it: GET .../stock-preparation/source-binding reports
# `effectiveExternalSystemId` -- literally "what the action will read on the
# next request" -- and that system's `connectionId` is compared with the data
# source this run created in STEP1. Equal => CLOSED_LOOP: STEP4/STEP6 measured
# the new source and the "new source -> front-line dry-run" chain is proven.
# Anything else => ENV_PROBE: STEP4/STEP6 are still worth running, but they
# measured a PRE-EXISTING source, and the summary and the JSON report both say
# so. The bound source is named only by a digest.
#
# The binding GET is `requireAccess(req, 'admin')`. A 401/403 there is a
# permission fact about the token, not a product failure, so it is a WARN that
# still forces ENV_PROBE. A 404/500 IS a product failure and stays a FAIL.
#
# Leg 3 is the preflight itself, and it asserts the fields the route really
# returns: `{ ok: <bool>, verdict: 'go' | 'no-go' }`
# (stock-preparation-source-preflight.cjs). There is no `ready` key on this
# route; asserting one read $null forever and left HTTP 200 as the only gate.
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  $bindingUri = Join-ApiUri -Path '/api/integration/stock-preparation/source-binding'
  $step4a = Invoke-Api -Method GET -Uri $bindingUri -Token $ownerToken
  $bindingData = Get-JsonField $step4a.Json 'data'
  $boundExternalSystemId = "$(Get-JsonField $bindingData 'effectiveExternalSystemId')"
  $script:BoundSourceDigest = Get-IdDigest $boundExternalSystemId

  if ($step4a.Status -eq 200) {
    Add-AcceptanceResult -StepId 'STEP4-ACTION-SOURCE-BINDING' -Description 'owner reads which source the table action is bound to' -Result 'PASS' -Status $step4a.Status -Code $step4a.Code
  } elseif ($step4a.Status -eq 401 -or $step4a.Status -eq 403) {
    Add-AcceptanceResult -StepId 'STEP4-ACTION-SOURCE-BINDING' -Description 'owner reads which source the table action is bound to -- refused, so this run cannot claim a closed loop' -Result 'WARN' -Status $step4a.Status -Code $step4a.Code
  } else {
    Add-AcceptanceResult -StepId 'STEP4-ACTION-SOURCE-BINDING' -Description 'owner reads which source the table action is bound to' -Result 'FAIL' -Status $step4a.Status -Code $step4a.Code
  }

  $step4bStatus = 0
  $step4bData = $null
  if ($step4a.Status -eq 200 -and (Test-NonEmptyText $boundExternalSystemId)) {
    $boundSystemUri = Join-ApiUri -Path "/api/integration/external-systems/$boundExternalSystemId"
    $step4b = Invoke-Api -Method GET -Uri $boundSystemUri -Token $ownerToken
    $step4bStatus = $step4b.Status
    $step4bData = Get-JsonField $step4b.Json 'data'
    if ($step4b.Status -eq 200) {
      Add-AcceptanceResult -StepId 'STEP4-BOUND-SOURCE-CONNECTION' -Description 'owner reads the bound systems connectionId' -Result 'PASS' -Status $step4b.Status -Code $step4b.Code
    } else {
      Add-AcceptanceResult -StepId 'STEP4-BOUND-SOURCE-CONNECTION' -Description 'owner reads the bound systems connectionId -- unreadable, so this run cannot claim a closed loop' -Result 'WARN' -Status $step4b.Status -Code $step4b.Code
    }
  } else {
    Add-AcceptanceResult -StepId 'STEP4-BOUND-SOURCE-CONNECTION' -Description 'owner reads the bound systems connectionId (skipped, no bound source id)' -Result 'SKIP' -Status $null -Code $null
  }

  $chain = Get-ActionSourceChainVerdict -BindingStatus $step4a.Status -BindingData $bindingData -ExpectedActionId $ActionId -BoundSystemStatus $step4bStatus -BoundSystemData $step4bData -ExpectedDataSourceId $DataSourceId
  $script:ChainMode = $chain.Result
  $script:ChainCode = $chain.Code

  $preflightUri = Join-ApiUri -Path '/api/integration/stock-preparation/source-preflight'
  $step4 = Invoke-Api -Method GET -Uri $preflightUri -Token $ownerToken
  $step4Verdict = Get-SourcePreflightVerdict -Status $step4.Status -Data (Get-JsonField $step4.Json 'data')
  $preflightDescription = if ($script:ChainMode -eq 'CLOSED_LOOP') {
    'source-preflight on THIS runs source (data.ok true and verdict go)'
  } else {
    'source-preflight on the PRE-EXISTING bound source, not this runs source (data.ok true and verdict go)'
  }
  Add-AcceptanceResult -StepId 'STEP4-SOURCE-PREFLIGHT' -Description $preflightDescription -Result $step4Verdict.Result -Status $step4.Status -Code $step4Verdict.Code
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
#
# SCOPE: this dry-run runs whatever source STEP4's binding readback found. When
# that is not this run's new data source the step is an ENV_PROBE of the
# deployment, and both the step description and the summary say so -- the one
# thing this script must never do is print "new source -> dry-run passed" for a
# dry-run that never touched the new source.
# ---------------------------------------------------------------------------
if (-not $script:Halt) {
  $dryRunScopeNote = if ($script:ChainMode -eq 'CLOSED_LOOP') {
    'operator dry-runs the pull-bom table action against THIS runs source'
  } else {
    'operator dry-runs the pull-bom table action against the PRE-EXISTING bound source, not this runs source'
  }
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
        Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description $dryRunScopeNote -Result 'PASS' -Status $step6b.Status -Code $step6b.Code
      } elseif ($step6b.Status -eq 400 -and $step6b.Code -eq 'CONNECTION_CANONICAL_UNAVAILABLE') {
        Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description 'operator dry-runs the pull-bom table action -- binding is missing its owner stamp; re-save the binding and retry' -Result 'FAIL' -Status $step6b.Status -Code $step6b.Code
      } else {
        Add-AcceptanceResult -StepId 'STEP6B-OPERATOR-TABLE-ACTION-DRY-RUN' -Description $dryRunScopeNote -Result 'FAIL' -Status $step6b.Status -Code $step6b.Code
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

# THE CONCLUSION, and the one sentence this script exists to keep honest. A
# green run whose STEP4/STEP6 never touched the source STEP1 created is NOT a
# closed-loop pass, and is never reported as one.
$conclusion = if ($script:ExitCode -ne 0) {
  'FAILED'
} elseif ($script:ChainMode -eq 'CLOSED_LOOP') {
  'CLOSED_LOOP_PASS'
} else {
  'ENV_PROBE_PASS'
}
Write-Host ("CHAIN: {0} ({1})" -f $script:ChainMode, $script:ChainCode)
if ($script:ChainMode -ne 'CLOSED_LOOP') {
  Write-Host ("  -> NOT A CLOSED LOOP: the table action is bound to a pre-existing source (boundSourceDigest={0}), not the source this run created. STEP4/STEP6 are independent probes of this deployment; they do NOT prove 'new source -> front-line dry-run'." -f $script:BoundSourceDigest)
}
Write-Host ("CONCLUSION: $conclusion")

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
  # Scope of STEP4/STEP6, values-free. `closedLoop` false means those two steps
  # measured a PRE-EXISTING source; `boundSourceDigest` is sha256(id) truncated
  # to 12 hex, so a reader can match it against a known source id by hashing
  # that id the same way, and can never read the id out of this report.
  chainMode = $script:ChainMode
  chainCode = $script:ChainCode
  closedLoop = ($script:ChainMode -eq 'CLOSED_LOOP')
  boundSourceDigest = $script:BoundSourceDigest
  conclusion = $conclusion
  steps = $reportSteps
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 8), $utf8NoBom)
Write-Host "Report written: $ReportPath"

exit $script:ExitCode
