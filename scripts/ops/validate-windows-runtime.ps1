#Requires -Version 5.1
<#
.SYNOPSIS
  C3-env validation kit — probe a native-Windows host for MetaSheet backend readiness
  (Lane C tier C). VALIDATION FIRST: by default this script only PROBES (read-only) and prints a
  pass/fail/evidence report. The default run makes NO system or service-config change.

.DESCRIPTION
  This is a VALIDATION kit, not a one-click installer. It deliberately does not silently
  install heavy dependencies or change the host, so it never prematurely freezes a customer
  environment. Every state-changing action is OFF by default and requires an explicit switch:

    (default)           probe only  -> pass / fail / evidence + exit code (0 all-pass, 1 any-fail).
                                       No system/service-config change. (The Redis probe is PING-only
                                       by default — it does not write any key.)
    -RedisWriteProbe    write probe -> additionally SET/GET/DEL a unique transient key on Redis to
                                       prove read/write command support (e.g. on Garnet). The key is
                                       namespaced + immediately deleted; no other state changes.
    -RegisterService    MUTATION    -> register the backend as an nssm Windows service + set its
                                       service env (honors -WhatIf / -Confirm). Requires nssm on PATH.
    -Install            guidance    -> print copy-pasteable acquisition steps for any missing
                                       dependency (nssm / PostgreSQL / Garnet|Memurai). Prints only;
                                       dependency install stays operator-driven by design.

  Secret values are NEVER printed: env-var checks report "set" / "MISSING" only, and connection
  passwords are used to authenticate probes but never echoed.

.PARAMETER BaseUrl
  Optional backend base URL. If set, the script probes reachability. With -Token + -DataSourceId
  it also runs the read-only data-source smoke (GET /api/data-sources/:id/test).
.PARAMETER Token
  Optional bearer token for the credentialed data-source read smoke.
.PARAMETER DataSourceId
  Optional data source id for the read smoke.
.PARAMETER NodeEntry
  Path to the backend entry used for -RegisterService. Default: the built dist entry.
.PARAMETER ServiceName
  nssm service name used for -RegisterService. Default: MetaSheetBackend.
.PARAMETER Install
  Print dependency-acquisition guidance (no execution).
.PARAMETER RegisterService
  Register the backend as an nssm Windows service (mutation; ShouldProcess-gated).
.PARAMETER RedisWriteProbe
  Additionally SET/GET/DEL a transient probe key on Redis to prove read/write (off by default).

.EXAMPLE
  .\validate-windows-runtime.ps1
  # probe-only; full pass/fail/evidence report

.EXAMPLE
  .\validate-windows-runtime.ps1 -BaseUrl https://host:8900 -Token $tok -DataSourceId k3
  # also runs the credentialed read-only data-source smoke

.EXAMPLE
  .\validate-windows-runtime.ps1 -RegisterService -WhatIf
  # preview the nssm service registration without performing it
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$BaseUrl,
  [string]$Token,
  [string]$DataSourceId,
  [string]$NodeEntry = 'packages\core-backend\dist\src\index.js',
  [string]$ServiceName = 'MetaSheetBackend',
  [switch]$Install,
  [switch]$RegisterService,
  [switch]$RedisWriteProbe
)

$ErrorActionPreference = 'Stop'
$script:results = @()

function Add-Check {
  param([string]$Name, [ValidateSet('PASS', 'FAIL', 'WARN', 'SKIP')][string]$Status, [string]$Evidence)
  $script:results += [pscustomobject]@{ Check = $Name; Status = $Status; Evidence = $Evidence }
}

# Windows PowerShell 5.1-compatible HTTP status probe. (-SkipHttpErrorCheck is PS7+ only; on 5.1
# Invoke-WebRequest throws on a non-2xx, so read the code off the WebException's response instead.)
# Returns the HTTP status code; rethrows on a genuine connection error (no HTTP response at all).
function Get-HttpStatus {
  param([string]$Url, [hashtable]$Headers = @{}, [int]$TimeoutSec = 15)
  try {
    return [int](Invoke-WebRequest -Uri $Url -Method Get -Headers $Headers -TimeoutSec $TimeoutSec -UseBasicParsing).StatusCode
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return [int]$resp.StatusCode }
    throw
  }
}

# --- Probe: Node present + version >= 18 -------------------------------------------------------
try {
  $nodeVer = (& node --version) 2>$null
  if ($nodeVer -match 'v(\d+)\.') {
    $major = [int]$Matches[1]
    Add-Check 'Node >= 18' ($(if ($major -ge 18) { 'PASS' } else { 'FAIL' })) "node $nodeVer"
  } else {
    Add-Check 'Node >= 18' 'FAIL' 'node not found on PATH'
  }
} catch { Add-Check 'Node >= 18' 'FAIL' 'node not found on PATH' }

# --- Probe: OS temp dir is usable (C1 workDir = os.tmpdir()\sandbox) ----------------------------
# Transient: create a UNIQUE probe dir under the OS temp dir, round-trip a file, then remove it.
# Proves the temp dir is writable WITHOUT leaving the real sandbox dir behind. Use
# [Path]::GetTempPath() (not $env:TEMP) — it mirrors Node's os.tmpdir() resolution and is robust if
# TEMP is unset.
try {
  $tempRoot = [System.IO.Path]::GetTempPath()
  $probeDir = Join-Path $tempRoot ("msv-probe-" + ([guid]::NewGuid().ToString('N')))
  New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
  $probeFile = Join-Path $probeDir 'worker.probe'
  'ok' | Set-Content -Path $probeFile -Encoding ascii
  $readBack = Get-Content -Path $probeFile -Raw
  Remove-Item -Path $probeDir -Recurse -Force
  $sandbox = Join-Path $tempRoot 'sandbox'
  Add-Check 'Sandbox workDir writable (os temp)' ($(if ($readBack.Trim() -eq 'ok') { 'PASS' } else { 'FAIL' })) "would resolve to $sandbox"
} catch { Add-Check 'Sandbox workDir writable (os temp)' 'FAIL' $_.Exception.Message }

# --- Probe: Python resolvable (C3-code: PYTHON_BIN || win32 'python') --------------------------
$pyBin = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { 'python' }
try {
  $pyVer = (& $pyBin --version) 2>&1
  if ($LASTEXITCODE -eq 0) {
    Add-Check 'Python resolvable' 'PASS' "$pyBin -> $pyVer"
  } else {
    Add-Check 'Python resolvable' 'WARN' "'$pyBin' not runnable; set PYTHON_BIN to a full python.exe path (only needed for workflow Python script nodes)"
  }
} catch { Add-Check 'Python resolvable' 'WARN' "'$pyBin' not found; set PYTHON_BIN if workflow Python nodes are used" }

# --- Probe: required env vars PRESENT (never print the value) ----------------------------------
# NOTE: these read THIS shell's environment (session-scoped), NOT the registered service's env. Run
# the kit in the shell where the env is configured (i.e. BEFORE -RegisterService, which captures it
# into the service). Post-deploy, the SERVICE env is authoritative — verify it via
# `nssm get <ServiceName> AppEnvironmentExtra`. Missing here is therefore a WARN, not a FAIL: it must
# not red-flag a correctly-configured host whose env lives in the service rather than the shell.
# Known default/weak sentinels from the codebase (encrypted-secrets.ts, auth-runtime-config.ts):
# "set but obviously insecure" (empty / a known default / too short) is a WARN — A1 keys are a red
# line (runbook §2.2). Still session-scoped, so WARN not FAIL; the VALUE is never printed.
# Full set: auth-runtime-config.ts INSECURE_JWT_SECRET_VALUES + encrypted-secrets.ts key/salt defaults.
# Keep this in sync with auth-runtime-config.ts if that list grows.
$weakSecrets = @(
  'test', 'dev-secret', 'dev-secret-key', 'fallback-development-secret-change-in-production',
  'change-me', 'change-me-in-production', 'your-secret-key-here', 'your-dev-secret-key-here',
  'default-key-change-in-production', 'default-salt-change-in-production'
)
$sensitive = @('JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT')
foreach ($name in @('DATABASE_URL', 'REDIS_HOST', 'JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT')) {
  $item = Get-Item "env:$name" -ErrorAction SilentlyContinue
  if (-not $item) {
    Add-Check "env $name (this shell)" 'WARN' 'MISSING in this shell — session-scoped; set here before -RegisterService, or verify the service env'
    continue
  }
  if ($sensitive -notcontains $name) {
    Add-Check "env $name (this shell)" 'PASS' 'set'
    continue
  }
  # Sensitive secret: inspect the value for obviously-insecure forms WITHOUT printing it.
  $val = [string]$item.Value
  if ([string]::IsNullOrWhiteSpace($val)) {
    Add-Check "env $name (this shell)" 'WARN' 'set but EMPTY'
  } elseif ($weakSecrets -contains $val) {
    Add-Check "env $name (this shell)" 'WARN' 'set but matches a KNOWN DEFAULT/weak sentinel — replace before production'
  } elseif (($name -ne 'ENCRYPTION_SALT') -and ($val.Length -lt 32)) {
    Add-Check "env $name (this shell)" 'WARN' 'set but short (<32 chars; backend requires >=32 for JWT_SECRET) — use a strong random value'
  } else {
    Add-Check "env $name (this shell)" 'PASS' 'set (non-default)'
  }
}

# --- Probe: PostgreSQL reachable (TCP; host:port parsed from DATABASE_URL) ---------------------
try {
  $pgHost = $null; $pgPort = 5432
  if ($env:DATABASE_URL -match '@([^:/?]+)(?::(\d+))?') {
    $pgHost = $Matches[1]
    if ($Matches[2]) { $pgPort = [int]$Matches[2] }
  }
  if ($pgHost) {
    $tcp = Test-NetConnection -ComputerName $pgHost -Port $pgPort -WarningAction SilentlyContinue
    Add-Check 'PostgreSQL reachable' ($(if ($tcp.TcpTestSucceeded) { 'PASS' } else { 'FAIL' })) "$pgHost`:$pgPort"
  } else {
    Add-Check 'PostgreSQL reachable' 'SKIP' 'DATABASE_URL host not parseable'
  }
} catch { Add-Check 'PostgreSQL reachable' 'FAIL' $_.Exception.Message }

# --- Probe: Redis/Garnet/Memurai RESP — PING by default; SET/GET/DEL only under -RedisWriteProbe -
# PING proves the server is up (read-only). With -RedisWriteProbe, also SET/GET/DEL a unique transient
# key to prove read/write command support (the Garnet command-coverage concern). That key is
# namespaced + immediately deleted, but it IS a write — so it is OFF by default to keep the default
# run write-free. The password authenticates the probe but is never echoed.
$redisLabel = if ($RedisWriteProbe) { 'Redis/Garnet RESP (PING + SET/GET/DEL)' } else { 'Redis/Garnet RESP (PING)' }
try {
  $rHost = if ($env:REDIS_HOST) { $env:REDIS_HOST } else { '127.0.0.1' }
  $rPort = if ($env:REDIS_PORT) { [int]$env:REDIS_PORT } else { 6379 }
  $probeKey = 'msv:probe:' + ([guid]::NewGuid().ToString('N'))
  $probeVal = ([guid]::NewGuid().ToString('N'))
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect($rHost, $rPort)
  $stream = $client.GetStream()
  $cmd = ''
  if ($env:REDIS_PASSWORD) { $cmd += "AUTH $($env:REDIS_PASSWORD)`r`n" }
  $cmd += "PING`r`n"
  if ($RedisWriteProbe) { $cmd += "SET $probeKey $probeVal`r`nGET $probeKey`r`nDEL $probeKey`r`n" }
  $bytes = [Text.Encoding]::ASCII.GetBytes($cmd)
  $stream.Write($bytes, 0, $bytes.Length)
  Start-Sleep -Milliseconds 300
  $resp = ''
  $buf = New-Object byte[] 512
  while ($stream.DataAvailable) { $resp += [Text.Encoding]::ASCII.GetString($buf, 0, $stream.Read($buf, 0, $buf.Length)) }
  $client.Close()
  $pong = $resp -match '\+PONG'
  if (-not $pong) {
    Add-Check $redisLabel 'FAIL' "$rHost`:$rPort -> $($resp.Trim() -replace '[\r\n]+', ' ')"
  } elseif (-not $RedisWriteProbe) {
    Add-Check $redisLabel 'PASS' "$rHost`:$rPort — PING ok (read/write not probed; pass -RedisWriteProbe to verify command coverage)"
  } else {
    $rw = ($resp -match '\+OK') -and ($resp -match [regex]::Escape($probeVal)) -and ($resp -match ':1')
    Add-Check $redisLabel ($(if ($rw) { 'PASS' } else { 'WARN' })) ($(if ($rw) { "$rHost`:$rPort — PING + read/write ok" } else { "$rHost`:$rPort — PING ok but SET/GET/DEL not confirmed (verify command coverage)" }))
  }
} catch { Add-Check $redisLabel 'FAIL' $_.Exception.Message }

# --- Probe: backend reachability + optional credentialed data-source read smoke ----------------
if ($BaseUrl) {
  try {
    $code = Get-HttpStatus -Url $BaseUrl -TimeoutSec 10
    # Any HTTP response (even 4xx) means the backend is reachable.
    Add-Check 'Backend reachable' 'PASS' "$BaseUrl -> HTTP $code"
  } catch { Add-Check 'Backend reachable' 'FAIL' $_.Exception.Message }

  if ($Token -and $DataSourceId) {
    try {
      $u = "$($BaseUrl.TrimEnd('/'))/api/data-sources/$DataSourceId/test"
      # IMPORTANT: /test returns HTTP 200 even when the CONNECTION fails — `ok:true` is request-layer;
      # the real outcome is `data.success`, with a redacted cause in `data.error.message`. A 200-only
      # check would falsely PASS an unreachable DB, so parse the body and require ok && data.success.
      $body = $null
      try {
        $body = (Invoke-WebRequest -Uri $u -Method Get -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 20 -UseBasicParsing).Content
      } catch {
        $r = $_.Exception.Response
        if ($r) { $body = (New-Object IO.StreamReader($r.GetResponseStream())).ReadToEnd() } else { throw }
      }
      $json = $body | ConvertFrom-Json
      if ($json.ok -eq $true -and $json.data.success -eq $true) {
        Add-Check 'Data-source read smoke' 'PASS' 'ok && data.success=true (read-only connectivity confirmed)'
      } else {
        $cause = if ($json.data.error.message) { $json.data.error.message } else { 'data.success != true' }
        # data.error.message is already redacted by the backend (A3), so it is safe to surface.
        Add-Check 'Data-source read smoke' 'FAIL' "connection failed (redacted): $cause"
      }
    } catch { Add-Check 'Data-source read smoke' 'FAIL' $_.Exception.Message }
  } else {
    Add-Check 'Data-source read smoke' 'SKIP' 'pass -Token + -DataSourceId to run the credentialed read smoke'
  }
} else {
  Add-Check 'Backend reachable' 'SKIP' 'pass -BaseUrl to probe the running backend'
}

# --- Probe: nssm present (only relevant for -RegisterService) ----------------------------------
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
Add-Check 'nssm on PATH' ($(if ($nssm) { 'PASS' } else { 'WARN' })) ($(if ($nssm) { $nssm.Source } else { 'not found (only needed for -RegisterService)' }))

# === Report ===================================================================================
Write-Host ''
Write-Host 'MetaSheet C3-env validation — evidence' -ForegroundColor Cyan
$script:results | Format-Table -AutoSize Check, Status, Evidence | Out-String | Write-Host
$failed = @($script:results | Where-Object { $_.Status -eq 'FAIL' })
Write-Host ("Summary: {0} pass, {1} fail, {2} warn, {3} skip" -f `
  (@($script:results | Where-Object Status -eq 'PASS').Count), $failed.Count, `
  (@($script:results | Where-Object Status -eq 'WARN').Count), `
  (@($script:results | Where-Object Status -eq 'SKIP').Count))

# === Guidance (-Install) — prints only; never installs ========================================
if ($Install) {
  Write-Host ''
  Write-Host 'Dependency acquisition guidance (this kit validates; it does NOT install):' -ForegroundColor Yellow
  Write-Host '  nssm (Node-as-service, default): https://nssm.cc/  (or `choco install nssm`)'
  Write-Host '  PostgreSQL (Windows):            official EDB installer'
  Write-Host '  Redis-on-Windows (RESP):         Garnet (MIT, OSS first) https://github.com/microsoft/garnet  |  Memurai (commercial)'
  Write-Host '  See docs/research/windows-deploy-oss-references-20260529.md for licenses + selection rationale.'
}

# === Mutation (-RegisterService) — gated + ShouldProcess ======================================
if ($RegisterService) {
  if (-not $nssm) {
    Write-Host ''
    Write-Host 'ERROR: -RegisterService requires nssm on PATH. Install nssm (see -Install) and re-run.' -ForegroundColor Red
    exit 2
  }
  $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodePath) {
    Write-Host ''
    Write-Host 'ERROR: -RegisterService requires node on PATH.' -ForegroundColor Red
    exit 2
  }
  # nssm's default startup directory is the PROGRAM's dir (node.exe's), NOT the repo — so a RELATIVE
  # entry would not be found at service start, and process.cwd() (e.g. the uploads path) would be
  # wrong. Resolve the entry to an absolute path AND set AppDirectory to the repo root. Run this from
  # the repo root, or pass an absolute -NodeEntry.
  $repoRoot = (Get-Location).Path
  $absEntry = if ([System.IO.Path]::IsPathRooted($NodeEntry)) { $NodeEntry } else { Join-Path $repoRoot $NodeEntry }
  if (-not (Test-Path $absEntry)) {
    Write-Host ''
    Write-Host "ERROR: backend entry not found: $absEntry" -ForegroundColor Red
    Write-Host '       Run from the repo root after building (pnpm --filter @metasheet/core-backend build), or pass an absolute -NodeEntry.' -ForegroundColor Red
    exit 2
  }
  if ($PSCmdlet.ShouldProcess($ServiceName, "nssm install $ServiceName -> node $absEntry (AppDirectory $repoRoot)")) {
    & nssm install $ServiceName $nodePath $absEntry
    & nssm set $ServiceName AppDirectory $repoRoot
    # Service env: collect ALL present names into ONE AppEnvironmentExtra call. nssm `set` REPLACES
    # the parameter, so setting it once per var would keep only the last — pass them all together.
    # Values pass through nssm and are never printed here.
    $envPairs = @()
    foreach ($name in @('DATABASE_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT', 'PYTHON_BIN', 'PORT')) {
      $val = (Get-Item "env:$name" -ErrorAction SilentlyContinue)
      if ($val) { $envPairs += ('{0}={1}' -f $name, $val.Value) }
    }
    if ($envPairs.Count -gt 0) { & nssm set $ServiceName AppEnvironmentExtra @envPairs }
    Write-Host "Registered service '$ServiceName' (entry: $absEntry, AppDirectory: $repoRoot). Start with: nssm start $ServiceName" -ForegroundColor Green
  }
}

if ($failed.Count -gt 0) { exit 1 } else { exit 0 }
