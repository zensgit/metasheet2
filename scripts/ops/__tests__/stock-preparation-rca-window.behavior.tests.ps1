#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$opsDir = Join-Path $PSScriptRoot '..'
$scriptPath = Join-Path $opsDir 'stock-preparation-rca-window.ps1'
. $scriptPath
$pass = 0
$fail = 0

function Check {
  param([string]$Name, [bool]$Ok)
  if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" }
  else { $script:fail++; Write-Host "  FAIL  $Name" }
}

function Secure {
  param([string]$Value)
  return ConvertTo-SecureString $Value -AsPlainText -Force
}

Check 'input contract accepts a bare loopback origin only' (
  (Test-InputContract -Origin 'http://127.0.0.1:8900' -Tenant 'tenant') -and
  (Test-InputContract -Origin 'https://localhost:8900' -Tenant 'tenant') -and
  -not (Test-InputContract -Origin 'https://internal.example' -Tenant 'tenant') -and
  -not (Test-InputContract -Origin 'http://127.0.0.1:8900/prefix' -Tenant 'tenant') -and
  -not (Test-InputContract -Origin 'http://user@127.0.0.1:8900' -Tenant 'tenant') -and
  -not (Test-InputContract -Origin 'http://127.0.0.1:8900/?query=1' -Tenant 'tenant') -and
  -not (Test-InputContract -Origin 'http://127.0.0.1:8900/#fragment' -Tenant 'tenant')
)

$firstLock = $false
$secondLock = $false
$reacquiredLock = $false
try {
  $firstLock = Enter-RcaWindowLock
  $secondLock = Enter-RcaWindowLock
} finally {
  Exit-RcaWindowLock
}
try {
  $reacquiredLock = Enter-RcaWindowLock
} finally {
  Exit-RcaWindowLock
}
Check 'real named mutex refuses a second window and is releasable' (
  $firstLock -and -not $secondLock -and $reacquiredLock
)

$lockProbeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rca-window-lock-" + [guid]::NewGuid().ToString('N'))
$lockProbeProcess = $null
$lockProbeAcquired = $false
try {
  New-Item -ItemType Directory -Path $lockProbeDir | Out-Null
  $lockProbeScript = Join-Path $lockProbeDir 'probe.ps1'
  $lockProbeResult = Join-Path $lockProbeDir 'result.txt'
  Set-Content -LiteralPath $lockProbeScript -Encoding ASCII -Value @'
$ErrorActionPreference = 'Stop'
. $env:RCA_WINDOW_LOCK_RUNNER
$acquired = Enter-RcaWindowLock
try {
  [System.IO.File]::WriteAllText(
    $env:RCA_WINDOW_LOCK_RESULT,
    $(if ($acquired) { 'ACQUIRED' } else { 'BLOCKED' })
  )
} finally {
  if ($acquired) { Exit-RcaWindowLock }
}
'@
  $env:RCA_WINDOW_LOCK_RUNNER = $scriptPath
  $env:RCA_WINDOW_LOCK_RESULT = $lockProbeResult
  $lockProbeAcquired = Enter-RcaWindowLock
  $hostPath = (Get-Process -Id $PID).Path
  $lockProbeProcess = Start-Process -FilePath $hostPath -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $lockProbeScript
  ) -PassThru -Wait
  $lockProbeText = if (Test-Path -LiteralPath $lockProbeResult -PathType Leaf) {
    (Get-Content -LiteralPath $lockProbeResult -Raw).Trim()
  } else {
    ''
  }
  Check 'real named mutex blocks a second PowerShell process' (
    $lockProbeAcquired -and $lockProbeProcess.ExitCode -eq 0 -and $lockProbeText -eq 'BLOCKED'
  )
} finally {
  Exit-RcaWindowLock
  Remove-Item Env:RCA_WINDOW_LOCK_RUNNER -ErrorAction SilentlyContinue
  Remove-Item Env:RCA_WINDOW_LOCK_RESULT -ErrorAction SilentlyContinue
  if ($lockProbeProcess) { $lockProbeProcess.Dispose() }
  Remove-Item -LiteralPath $lockProbeDir -Recurse -Force -ErrorAction SilentlyContinue
}

function Complete-SmokeSummary {
  param([string]$Salt = 't1720000000', [string]$PassValue = 'true')
  return @"
STOCK_PREPARATION_PREP_LINE_EXTENDED_SMOKE
salt=$Salt
approvedSourceHttp=201
approvedSourceMode=internal_persist
approvedSourceCreated=batch:1|lines:2|run:1
approvedSourceReplayHttp=200
approvedSourceReplayMode=internal_noop
auditActionsCovered=8/8
leakScanClean=true
selfScanClean=true
externalWrite=false
run2Ready=true
prepLines2RowCount=3
pass=$PassValue
"@
}

try {
  Check 'real frozen helper set copies and verifies' (Prepare-FrozenHelpers -Root $opsDir)
  Check 'prepared helpers share one private temporary directory' (
    $script:PreparedExtendedHelper.StartsWith($script:PreparedHelperDir) -and
    $script:PreparedPm2Helper.StartsWith($script:PreparedHelperDir)
  )
} finally {
  Remove-PreparedHelpers
}

$tampered = Join-Path ([System.IO.Path]::GetTempPath()) ("rca-window-tamper-" + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $tampered | Out-Null
  foreach ($name in $script:FrozenHelperSha256.Keys) {
    Copy-Item -LiteralPath (Join-Path $opsDir $name) -Destination (Join-Path $tampered $name)
  }
  Add-Content -LiteralPath (Join-Path $tampered 'stock-preparation-mvp-postdeploy-smoke.mjs') -Value 'tamper'
  $reason = ''
  try { Prepare-FrozenHelpers -Root $tampered | Out-Null } catch { $reason = $_.Exception.Message }
  Check 'tampered frozen sibling fails before execution' ($reason -eq 'HELPER_DIGEST_MISMATCH')
} finally {
  Remove-PreparedHelpers
  Remove-Item -LiteralPath $tampered -Recurse -Force -ErrorAction SilentlyContinue
}

$fakeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rca-window-smoke-" + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $fakeDir | Out-Null
  $fakeSmoke = Join-Path $fakeDir 'fake-smoke.mjs'
  Set-Content -LiteralPath $fakeSmoke -Encoding ASCII -Value @'
const hasToken = Boolean(process.env.METASHEET_AUTH_TOKEN)
const hasConfig = process.argv.includes("cfg-secret-sentinel")
process.stdout.write("tokenSeen=" + hasToken + "\nconfigSeen=" + hasConfig + "\n")
'@
  $script:PreparedExtendedHelper = $fakeSmoke
  $script:SmokeInvocationCount = 0
  $capture = Invoke-SmokeCapture -Token (Secure 'token-secret-sentinel') -ConfigReference (Secure 'cfg-secret-sentinel') -Origin 'http://127.0.0.1:1' -Tenant 'tenant-secret-sentinel' -Workspace ''
  Check 'real capture gives token and config only to the smoke child' (
    $capture.exit -eq 0 -and $capture.stdout -match 'tokenSeen=true' -and $capture.stdout -match 'configSeen=true'
  )
  Check 'real capture scrubs token carriers immediately' (Test-TokenCarriersEmpty)
  $second = Invoke-SmokeCapture -Token (Secure 'another-token') -ConfigReference (Secure 'another-config') -Origin 'http://127.0.0.1:1' -Tenant 'tenant' -Workspace ''
  Check 'second smoke invocation is refused without running a child' ($second.reason -eq 'SMOKE_ALREADY_INVOKED')
} finally {
  Remove-TokenCarriers
  Remove-Item -LiteralPath $fakeDir -Recurse -Force -ErrorAction SilentlyContinue
  $script:PreparedExtendedHelper = $null
}

$fields = Get-SmokeFieldMap (Complete-SmokeSummary)
$result = New-RcaResult
Check 'complete frozen smoke summary satisfies the exact C-stage projection' (
  (Apply-SmokeVerdict -Result $result -Fields $fields -ExitCode 0) -and
  $result.approvedSourceInitial -eq 'PASS' -and
  $result.approvedSourceReplay -eq 'PASS' -and
  $result.t4ExtendedChain -eq 'PASS' -and
  $result.externalWrite -eq 'false'
)
$duplicate = (Complete-SmokeSummary) + [Environment]::NewLine + 'pass=true'
Check 'duplicate required smoke fields fail closed' ($null -eq (Get-SmokeFieldMap $duplicate))
$duplicateHeader = 'STOCK_PREPARATION_PREP_LINE_EXTENDED_SMOKE' + [Environment]::NewLine + (Complete-SmokeSummary)
Check 'duplicate smoke headers fail closed' ($null -eq (Get-SmokeFieldMap $duplicateHeader))
$tainted = Get-SmokeFieldMap ((Complete-SmokeSummary) -replace 'externalWrite=false', 'externalWrite=true')
$taintedResult = New-RcaResult
Check 'external-write taint cannot pass the smoke verdict' (
  -not (Apply-SmokeVerdict -Result $taintedResult -Fields $tainted -ExitCode 0) -and
  $taintedResult.externalWrite -eq 'true'
)
$zeroCreated = Get-SmokeFieldMap ((Complete-SmokeSummary) -replace 'batch:1\|lines:2\|run:1', 'batch:1|lines:0|run:1')
$zeroCreatedResult = New-RcaResult
Check 'zero created lines cannot satisfy the initial persist contract' (
  -not (Apply-SmokeVerdict -Result $zeroCreatedResult -Fields $zeroCreated -ExitCode 0)
)

$script:Pm2SawDatabaseSecret = $null
$script:Pm2SawCloudSecret = $null
function pm2 {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $script:Pm2SawDatabaseSecret = [bool]$env:RCATEST_DATABASE_PASSWORD
  $script:Pm2SawCloudSecret = [bool]$env:RCATEST_CLOUD_API_KEY
}
$env:RCATEST_DATABASE_PASSWORD = 'database-secret-sentinel'
$env:RCATEST_CLOUD_API_KEY = 'cloud-secret-sentinel'
try {
  $pm2Boundary = Invoke-Pm2NativeCapture -Arguments @('restart', 'metasheet-backend', '--update-env')
  Check 'PM2 native boundary excludes unrelated shell secrets and preserves command success' (
    $pm2Boundary.exit -eq 0 -and
    $script:Pm2SawDatabaseSecret -eq $false -and
    $script:Pm2SawCloudSecret -eq $false
  )
  Check 'PM2 native boundary restores the operator process environment afterward' (
    $env:RCATEST_DATABASE_PASSWORD -eq 'database-secret-sentinel' -and
    $env:RCATEST_CLOUD_API_KEY -eq 'cloud-secret-sentinel'
  )
} finally {
  Remove-Item Function:pm2 -ErrorAction SilentlyContinue
  Remove-Item Env:RCATEST_DATABASE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:RCATEST_CLOUD_API_KEY -ErrorAction SilentlyContinue
}

$realPm2Capture = ${function:Invoke-Pm2NativeCapture}
$realPm2Sample = ${function:Get-Pm2Sample}
$savedSleep = $script:Sleep
$savedStableOnlineSeconds = $script:StableOnlineSeconds
try {
  function Invoke-Pm2NativeCapture { return @{ stdout = @(); exit = 0 } }
  $script:StabilityMode = 'stable'
  $script:StabilitySampleCount = 0
  function Get-Pm2Sample {
    $script:StabilitySampleCount++
    $afterBaseline = $script:StabilitySampleCount -gt 1
    $restartTime = if ($script:StabilityMode -eq 'restart-time' -and $afterBaseline) { 2 } else { 1 }
    $uptime = if ($script:StabilityMode -eq 'uptime' -and $afterBaseline) { 2000 } else { 1000 }
    return [pscustomobject]@{
      state = 'online'
      restartTime = $restartTime
      uptime = $uptime
      authTokenNonEmpty = $false
      adminTokenNonEmpty = $false
      plmAutoPersistEnabledTrue = $true
    }
  }
  $script:StableOnlineSeconds = 1
  $script:Sleep = { param([int]$Seconds) Start-Sleep -Milliseconds 250 }
  $stable = Invoke-Pm2RestartStable -ExpectedFlagTrue $true
  Check 'real PM2 stable-window loop takes more than the baseline sample' (
    $stable.ok -and $script:StabilitySampleCount -gt 1
  )

  $script:StabilityMode = 'restart-time'
  $script:StabilitySampleCount = 0
  $restarted = Invoke-Pm2RestartStable -ExpectedFlagTrue $true
  Check 'real PM2 stable-window loop rejects restart-time drift with stable uptime' (
    -not $restarted.ok -and $restarted.reason -eq 'PM2_UNSTABLE'
  )

  $script:StabilityMode = 'uptime'
  $script:StabilitySampleCount = 0
  $uptimeAdvanced = Invoke-Pm2RestartStable -ExpectedFlagTrue $true
  Check 'real PM2 stable-window loop rejects uptime drift with stable restart time' (
    -not $uptimeAdvanced.ok -and $uptimeAdvanced.reason -eq 'PM2_UNSTABLE'
  )
} finally {
  Set-Item Function:Invoke-Pm2NativeCapture -Value $realPm2Capture
  Set-Item Function:Get-Pm2Sample -Value $realPm2Sample
  $script:Sleep = $savedSleep
  $script:StableOnlineSeconds = $savedStableOnlineSeconds
}

$httpFixtureDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rca-window-http-" + [guid]::NewGuid().ToString('N'))
$httpServer = $null
try {
  New-Item -ItemType Directory -Path $httpFixtureDir | Out-Null
  $httpServerScript = Join-Path $httpFixtureDir 'server.mjs'
  $originFile = Join-Path $httpFixtureDir 'origin.txt'
  $modeFile = Join-Path $httpFixtureDir 'mode.txt'
  Set-Content -LiteralPath $modeFile -Encoding ASCII -NoNewline -Value 'health-ok'
  Set-Content -LiteralPath $httpServerScript -Encoding ASCII -NoNewline -Value @'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const originFile = fileURLToPath(new URL('./origin.txt', import.meta.url))
const modeFile = fileURLToPath(new URL('./mode.txt', import.meta.url))
const respond = (res, status, body = null) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === null ? '' : JSON.stringify(body))
}
const server = http.createServer((req, res) => {
  const mode = fs.readFileSync(modeFile, 'utf8').trim()
  if (req.url === '/api/health') {
    if (mode === 'health-ok') return respond(res, 200, { ok: true })
    if (mode === 'health-no-content') return respond(res, 204)
    if (mode === 'health-redirect') {
      res.writeHead(302, { location: '/api/health?redirected=1' })
      return res.end()
    }
    return respond(res, 503, { ok: false })
  }
  if (req.url === '/api/health?redirected=1') return respond(res, 200, { ok: true })
  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    if (!String(req.headers.authorization || '').startsWith('Bearer ')) {
      return respond(res, 401, { success: false })
    }
    if (mode === 'logout-ok') return respond(res, 200, { success: true })
    if (mode === 'logout-string') return respond(res, 200, { success: 'true' })
    if (mode === 'logout-created') return respond(res, 201, { success: true })
    return respond(res, 401, { success: false })
  }
  return respond(res, 404, { success: false })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  fs.writeFileSync(originFile, `http://127.0.0.1:${address.port}`)
})
'@
  $nodePath = (Get-Command node).Source
  $httpServer = Start-Process -FilePath $nodePath -WorkingDirectory $httpFixtureDir -ArgumentList @('server.mjs') -PassThru
  for ($attempt = 0; $attempt -lt 50 -and -not (Test-Path -LiteralPath $originFile); $attempt++) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $originFile)) { throw 'HTTP_FIXTURE_START_FAILED' }
  $fixtureOrigin = (Get-Content -LiteralPath $originFile -Raw).Trim()

  $healthOk = Invoke-HealthCheck -Origin $fixtureOrigin
  Set-Content -LiteralPath $modeFile -Encoding ASCII -NoNewline -Value 'health-no-content'
  $healthNoContent = Invoke-HealthCheck -Origin $fixtureOrigin
  Check 'real health probe accepts exactly HTTP 200' ($healthOk -and -not $healthNoContent)
  Set-Content -LiteralPath $modeFile -Encoding ASCII -NoNewline -Value 'health-redirect'
  Check 'real health probe refuses redirects even when the target would return 200' (
    -not (Invoke-HealthCheck -Origin $fixtureOrigin)
  )

  $logoutToken = Secure 'logout-token-sentinel'
  Set-Content -LiteralPath $modeFile -Encoding ASCII -NoNewline -Value 'logout-ok'
  $logoutOk = Invoke-TokenLogout -Token $logoutToken -Origin $fixtureOrigin
  Set-Content -LiteralPath $modeFile -Encoding ASCII -NoNewline -Value 'logout-string'
  $logoutString = Invoke-TokenLogout -Token $logoutToken -Origin $fixtureOrigin
  Check 'real logout requires a JSON boolean true response' ($logoutOk -and -not $logoutString)

  Set-Content -LiteralPath $modeFile -Encoding ASCII -NoNewline -Value 'logout-created'
  Check 'real logout requires exactly HTTP 200' (
    -not (Invoke-TokenLogout -Token $logoutToken -Origin $fixtureOrigin)
  )
} finally {
  if ($httpServer) {
    if (-not $httpServer.HasExited) { $httpServer.Kill() }
    [void]$httpServer.WaitForExit(5000)
    $httpServer.Dispose()
  }
  Remove-Item -LiteralPath $httpFixtureDir -Recurse -Force -ErrorAction SilentlyContinue
}

$script:ReadbackMode = 'valid'
function Invoke-AuthenticatedJsonGet {
  param([string]$Uri, [string]$TokenPlain, [string]$Tenant)
  if ($Uri -match '/projects') {
    $rows = @([pscustomobject]@{
      projectId = 'stockprep-t4-approved-t1720000000'
      snapshotBatchCount = 1
    })
    if ($script:ReadbackMode -eq 'duplicate') { $rows += $rows[0] }
    $projectSuccess = if ($script:ReadbackMode -eq 'project-success-string') { 'true' } else { $true }
    return [pscustomobject]@{ success = $projectSuccess; data = [pscustomobject]@{ projects = $rows } }
  }
  $lineCount = if ($script:ReadbackMode -eq 'empty-lines') { 0 } else { 2 }
  $incomplete = ($script:ReadbackMode -eq 'incomplete')
  $batchSuccess = if ($script:ReadbackMode -eq 'batch-success-string') { 'true' } else { $true }
  $incompleteValue = if ($script:ReadbackMode -eq 'incomplete-string') { 'false' } else { $incomplete }
  return [pscustomobject]@{
    success = $batchSuccess
    data = [pscustomobject]@{
      batchCount = 1
      batches = @([pscustomobject]@{
        snapshotBatchId = 'smoke_t4_approved_batch_t1720000000'
        syncRunId = 'smoke_t4_approved_syncrun_t1720000000'
        lineCount = $lineCount
        incomplete = $incompleteValue
      })
    }
  }
}

$readToken = Secure 'read-token-secret'
Check 'physical readback proves project, batch, line, and run presence' (
  Invoke-PhysicalReadback -Token $readToken -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -Salt 't1720000000'
)
foreach ($mode in @('duplicate', 'empty-lines', 'incomplete')) {
  $script:ReadbackMode = $mode
  Check "physical readback fails closed: $mode" (
    -not (Invoke-PhysicalReadback -Token $readToken -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -Salt 't1720000000')
  )
}
foreach ($mode in @('project-success-string', 'batch-success-string', 'incomplete-string')) {
  $script:ReadbackMode = $mode
  Check "physical readback rejects non-boolean JSON fields: $mode" (
    -not (Invoke-PhysicalReadback -Token $readToken -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -Salt 't1720000000')
  )
}

$script:MockMode = 'success'
$script:MockFlag = $false
$script:MockRestarts = @()
$script:MockSmokeCount = 0
$script:MockReadbackCount = 0
$script:MockPreparedCount = 0
$script:MockPm2SampleCount = 0
$script:MockLogoutCount = 0
$script:MockCleanupCount = 0
$script:MockUnlockCount = 0

function Enter-RcaWindowLock { return $true }
function Exit-RcaWindowLock { $script:MockUnlockCount++ }
function Prepare-FrozenHelpers {
  param([string]$Root)
  $script:MockPreparedCount++
  $script:PreparedPm2Helper = 'prepared'
  $script:PreparedExtendedHelper = 'prepared'
  return $true
}
function Remove-PreparedHelpers {
  $script:MockCleanupCount++
  $script:PreparedPm2Helper = $null
  $script:PreparedExtendedHelper = $null
}
function Get-Pm2Sample {
  $script:MockPm2SampleCount++
  if ($script:MockMode -eq 'final-sample-throws' -and $script:MockPm2SampleCount -eq 2) {
    throw 'simulated final sample failure'
  }
  $finalSample = $script:MockPm2SampleCount -eq 2
  $state = if ($finalSample -and $script:MockMode -eq 'final-state-stopped') { 'stopped' } else { 'online' }
  $restartTime = if ($finalSample -and $script:MockMode -eq 'final-restarted') { 2 } else { 1 }
  $flagEnabled = if ($finalSample -and $script:MockMode -eq 'final-flag-on') { $true } else { $script:MockFlag }
  return [pscustomobject]@{
    state = $state
    restartTime = $restartTime
    uptime = 1000
    authTokenNonEmpty = $false
    adminTokenNonEmpty = $false
    plmAutoPersistEnabledTrue = $flagEnabled
  }
}
function Invoke-Pm2RestartStable {
  param([bool]$ExpectedFlagTrue)
  $script:MockRestarts += $ExpectedFlagTrue
  if ($ExpectedFlagTrue -and $env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED -ne 'true') {
    return @{ ok = $false; reason = 'PM2_FLAG_MISMATCH' }
  }
  if (-not $ExpectedFlagTrue -and $env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED -ne 'false') {
    return @{ ok = $false; reason = 'PM2_FLAG_MISMATCH' }
  }
  if (-not $ExpectedFlagTrue -and $script:MockMode -eq 'restore-fails') {
    return @{ ok = $false; reason = 'PM2_RESTART_FAILED' }
  }
  $script:MockFlag = $ExpectedFlagTrue
  return @{
    ok = $true
    reason = 'NONE'
    baseline = [pscustomobject]@{ restartTime = 1; uptime = 1000 }
  }
}
function Invoke-HealthCheck { param([string]$Origin) return $true }
function Invoke-SmokeCapture {
  param([SecureString]$Token, [SecureString]$ConfigReference, [string]$Origin, [string]$Tenant, [string]$Workspace)
  $script:MockSmokeCount++
  Remove-TokenCarriers
  if ($script:MockMode -eq 'helper-disappears') { $script:PreparedPm2Helper = $null }
  if ($script:MockMode -eq 'smoke-fails') {
    return @{ stdout = (Complete-SmokeSummary -PassValue 'false'); exit = 1; reason = 'NONE' }
  }
  return @{ stdout = (Complete-SmokeSummary); exit = 0; reason = 'NONE' }
}
function Invoke-PhysicalReadback {
  param([SecureString]$Token, [string]$Origin, [string]$Tenant, [string]$Workspace, [string]$Salt)
  $script:MockReadbackCount++
  if ($script:MockMode -eq 'readback-fails') { return $false }
  return $true
}
function Invoke-TokenLogout {
  param([SecureString]$Token, [string]$Origin)
  $script:MockLogoutCount++
  return $true
}

function Reset-Mocks {
  $script:MockMode = 'success'
  $script:MockFlag = $false
  $script:MockRestarts = @()
  $script:MockSmokeCount = 0
  $script:MockReadbackCount = 0
  $script:MockPreparedCount = 0
  $script:MockPm2SampleCount = 0
  $script:MockLogoutCount = 0
  $script:MockCleanupCount = 0
  $script:MockUnlockCount = 0
  $script:PreparedPm2Helper = $null
  $script:PreparedExtendedHelper = $null
  Remove-TokenCarriers
  Remove-Item Env:MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED -ErrorAction SilentlyContinue
}

Reset-Mocks
$success = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $true -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
Check 'complete orchestration passes only after ON, one smoke, readback, OFF, and logout' (
  $success.overallAcceptance -eq 'PASS' -and
  (@($script:MockRestarts) -join ',') -eq 'True,False' -and
  $script:MockSmokeCount -eq 1 -and
  $script:MockReadbackCount -eq 1 -and
  $success.flagRestoredOff -eq 'PASS' -and
  $success.tokenRevoked -eq 'PASS'
)
Check 'success output never contains planted token/config/tenant values' (
  (Format-RcaResultBlock $success) -notmatch 'token-secret|config-secret|tenant'
)

Reset-Mocks
$script:MockMode = 'smoke-fails'
$failedSmoke = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $true -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
Check 'smoke failure still restores OFF and never performs readback or retries' (
  $failedSmoke.overallAcceptance -eq 'FAIL' -and
  $failedSmoke.failedStage -eq 'SMOKE' -and
  (@($script:MockRestarts) -join ',') -eq 'True,False' -and
  $script:MockSmokeCount -eq 1 -and
  $script:MockReadbackCount -eq 0 -and
  $failedSmoke.flagRestoredOff -eq 'PASS'
)

Reset-Mocks
$script:MockMode = 'helper-disappears'
$missingHelperDuringWindow = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $true -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
Check 'helper disappearance after ON cannot suppress the literal-false PM2 restart attempt' (
  (@($script:MockRestarts) -join ',') -eq 'True,False' -and
  $script:MockFlag -eq $false -and
  $missingHelperDuringWindow.overallAcceptance -eq 'FAIL'
)

Reset-Mocks
$script:MockMode = 'readback-fails'
$readbackFailure = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $true -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
Check 'a green smoke cannot pass when physical internal-row proof fails' (
  $readbackFailure.overallAcceptance -eq 'FAIL' -and
  $readbackFailure.failedStage -eq 'PHYSICAL_READ' -and
  $readbackFailure.approvedSourceInternalRowsNonEmpty -eq 'FAIL'
)

Reset-Mocks
$script:MockMode = 'restore-fails'
$restoreFailure = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $true -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
Check 'restoration failure overrides a green smoke and fails acceptance' (
  $restoreFailure.overallAcceptance -eq 'FAIL' -and
  $restoreFailure.failedStage -eq 'PM2_RESTORE' -and
  $restoreFailure.flagRestoredOff -eq 'FAIL'
)

Reset-Mocks
$script:MockMode = 'final-sample-throws'
$finalSampleFailure = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $true -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
Check 'final PM2 sampling failure cannot skip logout, helper cleanup, or lock release' (
  $finalSampleFailure.overallAcceptance -eq 'FAIL' -and
  $finalSampleFailure.failedStage -eq 'PM2_RESTORE' -and
  $script:MockLogoutCount -eq 1 -and
  $script:MockCleanupCount -eq 1 -and
  $script:MockUnlockCount -eq 1
)

$finalEvidenceByMode = @{
  'final-flag-on' = 'flagRestoredOff'
  'final-state-stopped' = 'postRestorePm2StableOnline'
  'final-restarted' = 'postRestorePm2StableOnline'
}
foreach ($mode in @($finalEvidenceByMode.Keys)) {
  Reset-Mocks
  $script:MockMode = $mode
  $finalStateDrift = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $true -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
  Check "final PM2 proof fails closed: $mode" (
    $finalStateDrift.overallAcceptance -eq 'FAIL' -and
    $finalStateDrift.failedStage -eq 'PM2_RESTORE' -and
    $finalStateDrift[$finalEvidenceByMode[$mode]] -eq 'FAIL' -and
    $script:MockLogoutCount -eq 1 -and
    $script:MockCleanupCount -eq 1 -and
    $script:MockUnlockCount -eq 1
  )
}

Reset-Mocks
$missingAttestation = Invoke-RcaWindow -Root $opsDir -Origin 'http://127.0.0.1:8900' -Tenant 'tenant' -Workspace '' -ConfigPreflightPassed $false -ProvidedToken (Secure 'token-secret') -ProvidedConfig (Secure 'config-secret')
Check 'missing approved-config attestation blocks before helpers, PM2, or smoke' (
  $missingAttestation.failureReason -eq 'CONFIG_PREFLIGHT_REQUIRED' -and
  $script:MockPreparedCount -eq 0 -and
  $script:MockRestarts.Count -eq 0 -and
  $script:MockSmokeCount -eq 0
)

Write-Host "stock-preparation RC-A window behavior: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
