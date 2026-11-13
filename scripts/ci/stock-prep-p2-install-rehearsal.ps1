# stock-prep-p2-install-rehearsal.ps1
#
# CI-only harness for .github/workflows/stock-prep-p2-install-path-rehearsal.yml.
# It is NOT packaged (scripts/ci is not a package root) and it never runs on a
# site or a dev machine: it starts services, installs pm2 globally and lets the
# package's own deploy-bootstrap run corepack. Only a disposable GitHub-hosted
# Windows runner may run it.
#
# Every operator step is the package's own deploy-bootstrap .bat, run unchanged:
#   <bootstrap.bat> <zip> <root> 1 1   (install-deps 1, run-migrations 1)
# Everything else here is observation: hashes, counts, codes, timings, booleans.
# Results are values-free: no secrets, no hostnames beyond 127.0.0.1.
#
# Target shell: Windows PowerShell 5.1. Native commands are run through small
# .cmd files with stderr redirected inside cmd.exe, because 5.1 turns redirected
# native stderr into terminating errors under ErrorActionPreference=Stop.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Prepare', 'Preflight', 'Install', 'Sample', 'AssertLeg4', 'Summary', 'Diag', 'Verdict')]
  [string]$Action,
  [string]$Work = '',
  [string]$Label = '',
  [string]$Bat = '',
  [string]$Zip = '',
  [string]$ExpectCommit = '',
  [int]$ExpectApplied = -1,
  [int]$ExpectExecuted = -1,
  [ValidateSet('zero', 'nonzero')]
  [string]$ExpectExit = 'zero',
  [ValidateSet('none', 'health-port-blocked')]
  [string]$Inject = 'none',
  [string]$R84Dir = '',
  [string]$FDir = '',
  [string]$LogPath = '',
  [string]$CsvPath = '',
  [string]$StopFile = '',
  [int]$OldPid = 0,
  [int]$OperatorTimeoutMin = 20,
  [switch]$RegisterOnFreshPm2Defect
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$AppRole = 'p2reh_app'
$AppDb = 'p2reh'
$Pm2App = 'metasheet-backend'
$BackendPort = 8900
$StagingBase = 'C:\ms-tmp'

function Write-H { param([string]$m) Write-Host ("[p2reh] {0}" -f $m) }

function Resolve-Work {
  if (-not [string]::IsNullOrWhiteSpace($Work)) { return $Work }
  if (-not [string]::IsNullOrWhiteSpace($env:P2REH_WORK)) { return $env:P2REH_WORK }
  if (Test-Path -LiteralPath 'D:\') { return 'D:\p2reh' }
  return 'C:\p2reh'
}

$W = Resolve-Work
$Root = Join-Path $W 'root'
$H = Join-Path $W 'h'
$Out = Join-Path $W 'out'
foreach ($d in @($W, $H, $Out)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

if ([string]::IsNullOrWhiteSpace($env:PM2_HOME) -and -not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
  # Same default attendance-onprem-start-pm2.ps1 applies (USERPROFILE\.pm2).
  $env:PM2_HOME = Join-Path $env:USERPROFILE '.pm2'
}

# ---------------------------------------------------------------- helpers

function Write-T { param([string]$m) Write-Host ("[p2reh] {0} {1}" -f ([DateTime]::UtcNow.ToString('HH:mm:ss')), $m) }

function Start-Detached {
  # Starts a .cmd file through ShellExecute (Start-Process without redirection), so the child
  # inherits none of this process's handles. A daemon it spawns (pm2) therefore cannot hold the
  # step's output pipe open, and the caller waits on the process itself, never on a pipe EOF.
  param([string]$CmdFile)
  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList @('/d', '/c', $CmdFile) -WindowStyle Hidden -PassThru
  $null = $p.Handle
  return $p
}

function Stop-Tree {
  param([int]$ProcessId)
  $null = & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $ProcessId /T /F 2>&1
}

function Invoke-CmdLine {
  # Runs one cmd.exe command line from a .cmd file, detached, stdout and stderr to files, bounded.
  param([string]$CommandLine, [string]$Cwd = '', [int]$TimeoutSec = 90)
  $id = [System.Guid]::NewGuid().ToString('N').Substring(0, 10)
  $cmdFile = Join-Path $H ("c-$id.cmd")
  $outFile = Join-Path $H ("c-$id.out")
  $errFile = Join-Path $H ("c-$id.err")
  $lines = @('@echo off')
  if (-not [string]::IsNullOrWhiteSpace($Cwd)) { $lines += ('cd /d "' + $Cwd + '"') }
  $codeFile = Join-Path $H ("c-$id.code")
  # 'call' so a batch command (pm2.cmd, npm.cmd, corepack.cmd) returns here and the exit code line runs.
  $lines += ('call ' + $CommandLine + ' >"' + $outFile + '" 2>"' + $errFile + '"')
  $lines += ('>"' + $codeFile + '" echo %ERRORLEVEL%')
  $lines += 'exit /b 0'
  Set-Content -LiteralPath $cmdFile -Value $lines -Encoding ASCII
  if ($script:TraceCmd) { Write-T ('cmd start: ' + $CommandLine.Split(' ')[0].Trim('"').Split('\')[-1]) }
  # Exit code comes from a file the .cmd writes last; the wait is a bounded poll, never WaitForExit.
  $p = Start-Detached -CmdFile $cmdFile
  $code = $null
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $codeFile) {
      $raw = ''
      try { $raw = ([string](Get-Content -LiteralPath $codeFile -Raw)).Trim() } catch { $raw = '' }
      if ($raw -match '^-?\d+$') { $code = [int]$raw; break }
    }
    Start-Sleep -Milliseconds 200
  }
  if ($null -eq $code) {
    Write-T ("command timed out after {0}s (first token: {1})" -f $TimeoutSec, ($CommandLine.Split(' ')[0].Trim('"').Split('\')[-1]))
    Stop-Tree -ProcessId $p.Id
    $code = -9
  }
  Remove-Item -LiteralPath $codeFile -Force -ErrorAction SilentlyContinue
  $stdout = @()
  # ReadAllLines gives plain strings; Get-Content strings carry PSPath/PSDrive/PSProvider notes, which
  # Windows PowerShell 5.1 ConvertTo-Json walks deeply enough to stall the harness.
  if (Test-Path -LiteralPath $outFile) { $stdout = @([System.IO.File]::ReadAllLines($outFile)) }
  $stderr = ''
  if (Test-Path -LiteralPath $errFile) { $stderr = [string](Get-Content -LiteralPath $errFile -Raw) }
  Remove-Item -LiteralPath $cmdFile, $outFile, $errFile -Force -ErrorAction SilentlyContinue
  if ($script:TraceCmd) { Write-T ('cmd end: exit ' + $code) }
  return [pscustomobject]@{ Code = $code; Out = $stdout; Err = $stderr }
}

function Write-ProcessSnapshot {
  # Values-free process view for a hang: names and pids, and command lines cut to the script name.
  $names = @('node.exe', 'cmd.exe', 'powershell.exe', 'corepack.exe', 'pnpm.exe', 'psql.exe')
  foreach ($pr in @(Get-CimInstance -ClassName Win32_Process | Where-Object { $names -contains $_.Name })) {
    $cl = [string]$pr.CommandLine
    $tokens = @([regex]::Matches($cl, '[A-Za-z0-9_.@-]+\.(js|cjs|mjs|ps1|cmd|bat)\b|\b(install|prepare|jlist|start|restart|save|ping|--offline|--frozen-lockfile|--version)\b') | ForEach-Object { $_.Value } | Select-Object -First 8)
    Write-T ("proc pid={0} ppid={1} {2} {3}" -f $pr.ProcessId, $pr.ParentProcessId, $pr.Name, ($tokens -join ' '))
  }
}

function Read-AppEnv {
  $map = [ordered]@{}
  $envFile = Join-Path $Root 'docker\app.env'
  if (-not (Test-Path -LiteralPath $envFile)) { return $map }
  foreach ($raw in Get-Content -LiteralPath $envFile) {
    $line = $raw.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) { continue }
    $map[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $map
}

function Invoke-WithAppEnv {
  # Runs a scriptblock with docker\app.env loaded into this process, then removes those keys again,
  # so the deploy-bootstrap child never inherits values the operator's shell would not have.
  param([scriptblock]$Block)
  $map = Read-AppEnv
  $saved = @{}
  foreach ($k in $map.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, [string]$map[$k], 'Process')
  }
  try { return (& $Block) }
  finally {
    foreach ($k in $map.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
}

function Get-PgBin {
  $state = Join-Path $H 'pgbin.txt'
  if (Test-Path -LiteralPath $state) { return (Get-Content -LiteralPath $state -Raw).Trim() }
  return $env:PGBIN
}

function Invoke-AppSql {
  # Runs SQL as the throwaway application role; returns trimmed stdout lines (psql -tA).
  param([string]$Sql)
  $map = Read-AppEnv
  $url = [string]$map['DATABASE_URL']
  $m = [regex]::Match($url, '^postgres(?:ql)?://([^:]+):([^@]+)@')
  if (-not $m.Success) { throw 'DATABASE_URL in the harness app.env has an unexpected shape' }
  $sqlFile = Join-Path $H ('q-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8) + '.sql')
  Set-Content -LiteralPath $sqlFile -Value $Sql -Encoding ASCII
  $prev = $env:PGPASSWORD
  $env:PGPASSWORD = $m.Groups[2].Value
  try {
    $psql = Join-Path (Get-PgBin) 'psql.exe'
    $r = Invoke-CmdLine -CommandLine ('"' + $psql + '" -h 127.0.0.1 -p 5432 -U ' + $AppRole + ' -d ' + $AppDb + ' -w -X -q -tA -v ON_ERROR_STOP=1 -f "' + $sqlFile + '"')
  }
  finally {
    $env:PGPASSWORD = $prev
    Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
  }
  return $r
}

function Get-KyselyState {
  param([string]$AfterTs = '')
  $exists = Invoke-AppSql -Sql "SELECT to_regclass('public.kysely_migration') IS NOT NULL;"
  if ($exists.Code -ne 0) { return [pscustomobject]@{ Ok = $false; Count = -1; MaxTs = ''; NewCount = -1; NewMin = ''; NewMax = '' } }
  if ((@($exists.Out) -join '').Trim() -ne 't') {
    return [pscustomobject]@{ Ok = $true; Count = 0; MaxTs = ''; NewCount = 0; NewMin = ''; NewMax = '' }
  }
  $safeTs = $AfterTs -replace "'", ''
  $r = Invoke-AppSql -Sql ("SELECT count(*) || '|' || coalesce(max(timestamp), '') FROM kysely_migration; " +
    "SELECT count(*) || '|' || coalesce(min(timestamp), '') || '|' || coalesce(max(timestamp), '') FROM kysely_migration WHERE timestamp > '" + $safeTs + "';")
  if ($r.Code -ne 0) { return [pscustomobject]@{ Ok = $false; Count = -1; MaxTs = ''; NewCount = -1; NewMin = ''; NewMax = '' } }
  $rows = @($r.Out | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $a = ([string]$rows[0]).Split('|')
  $b = ([string]$rows[1]).Split('|')
  return [pscustomobject]@{ Ok = $true; Count = [int]$a[0]; MaxTs = $a[1]; NewCount = [int]$b[0]; NewMin = $b[1]; NewMax = $b[2] }
}

function Get-MigrateList {
  $migrate = Join-Path $Root 'packages\core-backend\dist\src\db\migrate.js'
  if (-not (Test-Path -LiteralPath $migrate)) { return [pscustomobject]@{ Code = -1; Applied = -1; Pending = -1 } }
  $r = Invoke-WithAppEnv { Invoke-CmdLine -CommandLine ('node "' + $migrate + '" --list') -Cwd $Root }
  $text = (@($r.Out) -join "`n")
  $applied = -1; $pending = -1
  $ma = [regex]::Match($text, 'Applied:\s*(\d+)')
  $mp = [regex]::Match($text, 'Pending:\s*(\d+)')
  if ($ma.Success) { $applied = [int]$ma.Groups[1].Value }
  if ($mp.Success) { $pending = [int]$mp.Groups[1].Value }
  return [pscustomobject]@{ Code = $r.Code; Applied = $applied; Pending = $pending }
}

function Get-WebErrorCode {
  # HTTP status from a failed request (502, 404, ...), 0 when nothing answered. PowerShell wraps the
  # WebException (MethodInvocationException), so walk the inner exceptions.
  param($ErrorRecord)
  $ex = $ErrorRecord.Exception
  while ($null -ne $ex) {
    if ($ex -is [System.Net.WebException]) {
      if ($null -ne $ex.Response) { try { return [int]$ex.Response.StatusCode } catch { return -1 } }
      return 0
    }
    $ex = $ex.InnerException
  }
  return 0
}

function Get-Health {
  param([string]$Url, [string]$Commit = '')
  $code = 0; $commitMatch = $false; $commitPresent = $false
  try {
    # HttpWebRequest with both timeouts, so neither connect nor body read can block for long.
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Timeout = 5000
    $req.ReadWriteTimeout = 5000
    $req.Proxy = $null
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $content = $sr.ReadToEnd()
    $sr.Dispose(); $resp.Close()
    try {
      $j = $content | ConvertFrom-Json
      if ($null -ne $j.build -and -not [string]::IsNullOrWhiteSpace([string]$j.build.commit)) {
        $commitPresent = $true
        $commitMatch = ([string]$j.build.commit -eq $Commit)
      }
    } catch { }
  }
  catch {
    $code = Get-WebErrorCode -ErrorRecord $_
  }
  return [pscustomobject]@{ Code = $code; CommitPresent = $commitPresent; CommitMatchesExpected = $commitMatch }
}

function Get-Pm2State {
  # pm2 jlist carries each app's environment; on Windows it can hold keys that differ only in case
  # (Path / PATH), which Windows PowerShell 5.1 ConvertFrom-Json rejects. Parse it in node instead.
  $js = Join-Path $H 'pm2state.cjs'
  if (-not (Test-Path -LiteralPath $js)) {
    $src = @'
const { execSync } = require('node:child_process')
let raw = ''
try {
  raw = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 60000 })
} catch (e) { console.log('ERR|jlist'); process.exit(3) }
const line = raw.split(/\r?\n/).filter((l) => /^\s*\[\s*(\{|\])/.test(l)).pop()
if (!line) { console.log('ERR|nojson'); process.exit(4) }
let apps
try { apps = JSON.parse(line) } catch (e) { console.log('ERR|parse'); process.exit(5) }
const app = apps.find((a) => a.name === process.argv[2])
if (!app) { console.log('ABSENT|' + apps.length); process.exit(0) }
const env = app.pm2_env || {}
const restarts = typeof env.restart_time === 'number' ? env.restart_time : -1
console.log(['PRESENT', env.status || '', app.pid || 0, restarts, env.pm_uptime || 0, env.pm_exec_path || ''].join('|'))
'@
    Set-Content -LiteralPath $js -Value $src -Encoding ASCII
  }
  $r = Invoke-CmdLine -CommandLine ('node "' + $js + '" ' + $Pm2App)
  $present = $false; $status = ''; $procId = 0; $restarts = -1; $uptime = 0; $underRoot = $false
  $line = [string](@($r.Out | Where-Object { $_ -match '^(PRESENT|ABSENT|ERR)\|' }) | Select-Object -Last 1)
  $parts = $line.Split('|')
  if ($parts[0] -eq 'PRESENT' -and $parts.Length -ge 6) {
    $present = $true
    $status = $parts[1]
    $procId = [int]$parts[2]
    $restarts = [int]$parts[3]
    $uptime = [long]$parts[4]
    $underRoot = $parts[5].StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)
  }
  return [pscustomobject]@{ jlistExit = $r.Code; reader = $parts[0]; present = $present; status = $status; pid = $procId; restarts = $restarts; uptimeMs = $uptime; execUnderRoot = $underRoot }
}

function Get-CorepackState {
  $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
  $cv = Invoke-CmdLine -CommandLine 'corepack --version'
  $pv = Invoke-CmdLine -CommandLine 'pnpm --version'
  $wp = Invoke-CmdLine -CommandLine 'where pnpm'
  $cpHome = $env:COREPACK_HOME
  if ([string]::IsNullOrWhiteSpace($cpHome)) { $cpHome = Join-Path $env:LOCALAPPDATA 'node\corepack' }
  $cached = @()
  $pnpmCache = Join-Path $cpHome 'v1\pnpm'
  if (-not (Test-Path -LiteralPath $pnpmCache)) { $pnpmCache = Join-Path $cpHome 'pnpm' }
  if (Test-Path -LiteralPath $pnpmCache) { $cached = @(Get-ChildItem -LiteralPath $pnpmCache -Directory | ForEach-Object { $_.Name } | Sort-Object) }
  $lkg = ''
  $lkgFile = Join-Path $cpHome 'lastKnownGood.json'
  if (Test-Path -LiteralPath $lkgFile) {
    try { $lkg = [string]((Get-Content -LiteralPath $lkgFile -Raw | ConvertFrom-Json).pnpm) } catch { $lkg = 'unreadable' }
  }
  return [pscustomobject][ordered]@{
    corepackVersion = ((@($cv.Out) -join '').Trim())
    pnpmOnPathVersion = $(if ($pv.Code -eq 0) { ((@($pv.Out) | Select-Object -First 1) -join '').Trim() } else { 'absent' })
    pnpmOnPathCount = $(if ($wp.Code -eq 0) { @($wp.Out | Where-Object { $_ }).Count } else { 0 })
    pnpmShimInNodeDir = (Test-Path -LiteralPath (Join-Path $nodeDir 'pnpm.cmd'))
    corepackPnpmCachedVersions = $cached
    corepackLastKnownGoodPnpm = $lkg
  }
}

function Test-PortListening {
  param([int]$Port)
  $c = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  return ($c.Count -gt 0)
}

function Start-Proxy {
  # Harness stand-in for the site's nginx: the apply health-checks http://127.0.0.1/health and
  # http://127.0.0.1/api/plugins (port 80, apply-package.ps1 -BaseUrl/-ApiBase defaults), and neither
  # the launcher nor the .bat forwards an override. 127.0.0.1:80 -> 127.0.0.1:8900, 502 when down.
  if (Test-PortListening -Port 80) { return (@(Get-Port80Owners) -contains 'node') }
  $proxyJs = Join-Path $H 'proxy.cjs'
  $proxyCmd = Join-Path $H 'proxy-start.cmd'
  $proxyLog = Join-Path $H 'proxy.log'
  if (-not (Test-Path -LiteralPath $proxyJs)) {
    $js = @'
const http = require('node:http')
const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: '127.0.0.1', port: 8900, method: req.method, path: req.url, headers: req.headers },
    (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res) },
  )
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.pipe(upstream)
})
server.listen(80, '127.0.0.1')
'@
    Set-Content -LiteralPath $proxyJs -Value $js -Encoding ASCII
    Set-Content -LiteralPath $proxyCmd -Value @('@echo off', ('node "' + $proxyJs + '" >"' + $proxyLog + '" 2>&1')) -Encoding ASCII
  }
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $proxyCmd) -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-PortListening -Port 80) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Get-Port80Owners {
  $names = @()
  foreach ($c in @(Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($null -ne $p) { $names += [string]$p.ProcessName } else { $names += ('pid' + $c.OwningProcess) }
  }
  return @($names | Select-Object -Unique)
}

function Clear-RunnerPort80 {
  # The windows image can hold 127.0.0.1:80 itself (http.sys under the System process, IIS).
  # This runner is disposable, so the harness frees the port before it puts its nginx stand-in there.
  $steps = @()
  foreach ($svc in @('W3SVC', 'WAS', 'IISADMIN')) {
    if ($null -ne (Get-Service -Name $svc -ErrorAction SilentlyContinue)) {
      Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
      $steps += ('stop-' + $svc)
    }
  }
  Start-Sleep -Seconds 2
  if ((Test-PortListening -Port 80) -and (@(Get-Port80Owners) -contains 'System')) {
    $r = Invoke-CmdLine -CommandLine 'net stop http /y'
    $steps += ('net-stop-http-exit-' + $r.Code)
    Start-Sleep -Seconds 2
  }
  return $steps
}

function Stop-Proxy {
  # Only the harness's own node proxy is stopped; never a system process.
  foreach ($c in @(Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($null -ne $p -and $p.ProcessName -eq 'node') { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-PortListening -Port 80)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Get-StagingLeftovers {
  $res = [ordered]@{ msdl = 0; mspa = 0; mspb = 0; other = 0 }
  if (-not (Test-Path -LiteralPath $StagingBase)) { return [pscustomobject]$res }
  foreach ($d in @(Get-ChildItem -LiteralPath $StagingBase -Force)) {
    if ($d.Name -like 'msdl-*') { $res['msdl'] += 1 }
    elseif ($d.Name -like 'mspa-*') { $res['mspa'] += 1 }
    elseif ($d.Name -like 'mspb-*') { $res['mspb'] += 1 }
    else { $res['other'] += 1 }
  }
  return [pscustomobject]$res
}

function Get-NodeModulesBackups {
  $count = 0
  $dirs = @($Root)
  foreach ($g in @('apps', 'packages', 'plugins', 'tools')) {
    $gp = Join-Path $Root $g
    if (Test-Path -LiteralPath $gp) { $dirs += @(Get-ChildItem -LiteralPath $gp -Directory | ForEach-Object { $_.FullName }) }
  }
  foreach ($d in $dirs) {
    $count += @(Get-ChildItem -LiteralPath $d -Directory -Force -Filter 'node_modules.mspa-backup-*' -ErrorAction SilentlyContinue).Count
  }
  return $count
}

function Get-FileSha {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-TreeMap {
  param([string]$Dir)
  $map = @{}
  $base = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\')
  foreach ($f in @(Get-ChildItem -LiteralPath $base -File -Recurse -Force)) {
    $rel = $f.FullName.Substring($base.Length + 1)
    $map[$rel] = Get-FileSha -Path $f.FullName
  }
  return $map
}

function Write-Json {
  param([object]$Value, [string]$Path)
  $Value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Read-Json {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Get-OperatorTail {
  param([string]$Log, [int]$Count = 14)
  if (-not (Test-Path -LiteralPath $Log)) { return @() }
  $lines = @([System.IO.File]::ReadAllLines($Log) | Where-Object {
      $_ -match '^\[multitable-onprem-(apply-package|deploy-launcher|deploy-bootstrap)\]'
    })
  $tail = @($lines | Select-Object -Last $Count)
  # Values-free: keep only lines whose URLs are loopback; drop anything else that names a host.
  return @($tail | Where-Object { $_ -notmatch '://(?!127\.0\.0\.1|localhost)' })
}

# ---------------------------------------------------------------- actions

function Invoke-Prepare {
  $checks = [ordered]@{}
  $fail = @()
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) { Add-Content -LiteralPath $env:GITHUB_ENV -Value ('P2REH_WORK=' + $W) -Encoding ASCII }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $sets = @(
    @{ key = 'r84'; dir = $R84Dir; pkg = $env:R84_PKG; commit = $env:R84_COMMIT; pins = @{ zip = $env:R84_ZIP_SHA256; ps1 = $env:R84_PS1_SHA256; bat = $env:R84_BAT_SHA256 } },
    @{ key = 'f'; dir = $FDir; pkg = $env:F_PKG; commit = $env:F_COMMIT; pins = @{ zip = $env:F_ZIP_SHA256; ps1 = $env:F_PS1_SHA256; bat = $env:F_BAT_SHA256 } }
  )
  foreach ($s in $sets) {
    $sums = @{}
    $sumsFile = Join-Path $s.dir 'SHA256SUMS'
    if (Test-Path -LiteralPath $sumsFile) {
      foreach ($l in Get-Content -LiteralPath $sumsFile) {
        $m = [regex]::Match($l, '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$')
        if ($m.Success) { $sums[$m.Groups[2].Value] = $m.Groups[1].Value.ToLowerInvariant() }
      }
    }
    $files = @{ zip = ($s.pkg + '.zip'); ps1 = ($s.pkg + '-deploy-bootstrap.ps1'); bat = ($s.pkg + '-deploy-bootstrap.bat') }
    foreach ($kind in @('zip', 'ps1', 'bat')) {
      $name = $files[$kind]
      $path = Join-Path $s.dir $name
      $present = Test-Path -LiteralPath $path
      $actual = ''
      if ($present) { $actual = Get-FileSha -Path $path }
      $sidecar = ''
      $sidecarFile = $path + '.sha256'
      if (Test-Path -LiteralPath $sidecarFile) { $sidecar = ((Get-Content -LiteralPath $sidecarFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant() }
      $okSums = $present -and $sums.ContainsKey($name) -and ($sums[$name] -eq $actual)
      $okSidecar = $present -and ($sidecar -eq $actual)
      $okPin = $present -and ($actual -eq ([string]$s.pins[$kind]).ToLowerInvariant())
      $checks[($s.key + '_' + $kind + '_present')] = $present
      $checks[($s.key + '_' + $kind + '_matches_SHA256SUMS')] = $okSums
      $checks[($s.key + '_' + $kind + '_matches_sidecar')] = $okSidecar
      $checks[($s.key + '_' + $kind + '_matches_pin')] = $okPin
      if (-not ($present -and $okSums -and $okSidecar -and $okPin)) { $fail += ($s.key + ' ' + $kind + ' integrity') }
    }
    $zipPath = Join-Path $s.dir $files['zip']
    $provOk = $false; $metaPnpm = ''
    if (Test-Path -LiteralPath $zipPath) {
      $za = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
      try {
        $pe = $za.GetEntry($s.pkg + '/BUILD_PROVENANCE.json')
        if ($null -ne $pe) {
          $sr = New-Object System.IO.StreamReader($pe.Open())
          try { $pj = $sr.ReadToEnd() | ConvertFrom-Json } finally { $sr.Dispose() }
          $provOk = ([string]$pj.gitCommit -eq $s.commit)
        }
        $me = $za.GetEntry($s.pkg + '/PACKAGE-METADATA.json')
        if ($null -ne $me) {
          $sr = New-Object System.IO.StreamReader($me.Open())
          try { $metaPnpm = [string](($sr.ReadToEnd() | ConvertFrom-Json).pnpmVersion) } finally { $sr.Dispose() }
        }
      } finally { $za.Dispose() }
    }
    $checks[($s.key + '_provenance_commit_matches')] = $provOk
    $checks[($s.key + '_package_pnpm_version')] = $metaPnpm
    if (-not $provOk) { $fail += ($s.key + ' provenance commit') }

    $x = Join-Path $W ('x\' + $s.key)
    if (Test-Path -LiteralPath $x) { Remove-Item -LiteralPath $x -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $x | Out-Null
    if (Test-Path -LiteralPath $zipPath) { [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $x) }
  }

  $r84Map = Get-TreeMap -Dir (Join-Path $W ('x\r84\' + $env:R84_PKG))
  $fMap = Get-TreeMap -Dir (Join-Path $W ('x\f\' + $env:F_PKG))
  $onlyR84 = @($r84Map.Keys | Where-Object { -not $fMap.ContainsKey($_) } | Sort-Object)
  $onlyF = @($fMap.Keys | Where-Object { -not $r84Map.ContainsKey($_) } | Sort-Object)
  $changed = @($fMap.Keys | Where-Object { $r84Map.ContainsKey($_) -and $r84Map[$_] -ne $fMap[$_] } | Sort-Object)
  $diff = [ordered]@{ onlyR84 = @(); onlyF = @(); changed = @() }
  foreach ($k in $onlyR84) { $diff.onlyR84 += [pscustomobject]@{ p = $k; r84 = $r84Map[$k] } }
  foreach ($k in $onlyF) { $diff.onlyF += [pscustomobject]@{ p = $k; f = $fMap[$k] } }
  foreach ($k in $changed) { $diff.changed += [pscustomobject]@{ p = $k; r84 = $r84Map[$k]; f = $fMap[$k] } }
  Write-Json -Value $diff -Path (Join-Path $H 'package-diff.json')
  $checks['r84_file_count'] = $r84Map.Count
  $checks['f_file_count'] = $fMap.Count
  $checks['files_only_in_r84'] = $onlyR84.Count
  $checks['files_only_in_f'] = $onlyF.Count
  $checks['files_changed_r84_to_f'] = $changed.Count
  $checks['f_new_compiled_migrations'] = @($onlyF | Where-Object { $_ -like 'packages\core-backend\dist\src\db\migrations\*.js' }).Count
  $checks['f_new_sql_migrations'] = @($onlyF | Where-Object { $_ -like 'packages\core-backend\migrations\*.sql' }).Count
  $checks['failures'] = $fail
  Write-Json -Value $checks -Path (Join-Path $Out 'prepare.json')
  foreach ($k in $checks.Keys) { Write-H ("{0} = {1}" -f $k, (@($checks[$k]) -join ',')) }
  if ($fail.Count -gt 0) { Write-H ('PREPARE FAILED: ' + ($fail -join '; ')); exit 1 }
}

function New-Secret {
  param([int]$Bytes)
  $b = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b)
  $rng.Dispose()
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Invoke-Preflight {
  $res = [ordered]@{}
  $fail = @()
  $res['work_drive'] = $W.Substring(0, 1)
  $res['powershell_version'] = $PSVersionTable.PSVersion.ToString()
  $nv = Invoke-CmdLine -CommandLine 'node --version'
  $res['node_version'] = ((@($nv.Out) -join '').Trim())
  $wn = Invoke-CmdLine -CommandLine 'where node'
  $firstNode = ((@($wn.Out) | Select-Object -First 1) -join '').Trim()
  $res['node_in_program_files'] = ($firstNode -like ($env:ProgramFiles + '\nodejs\*'))
  $res['corepack_path_in_program_files'] = (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'nodejs\corepack.cmd'))

  $res['port80_free_before'] = -not (Test-PortListening -Port 80)
  $res['port80_owners_before'] = @(Get-Port80Owners)
  $res['port80_clear_steps'] = @()
  if (-not $res['port80_free_before']) { $res['port80_clear_steps'] = @(Clear-RunnerPort80) }
  $res['port80_free_after_clear'] = -not (Test-PortListening -Port 80)
  $res['port8900_free_before'] = -not (Test-PortListening -Port $BackendPort)
  if (-not $res['port80_free_after_clear']) { $fail += ('port 80 still in use on the runner by ' + ((@(Get-Port80Owners)) -join '/')) }
  if (-not $res['port8900_free_before']) { $fail += 'port 8900 already in use on the runner' }

  $pm = Invoke-CmdLine -CommandLine ('npm install -g pm2@' + $env:PM2_VERSION + ' --no-audit --no-fund') -TimeoutSec 600
  $res['pm2_global_install_exit'] = $pm.Code
  $pv = Invoke-CmdLine -CommandLine 'pm2 --version'
  $res['pm2_version'] = ((@($pv.Out) | Select-Object -Last 1) -join '').Trim()
  if ($pm.Code -ne 0 -or $pv.Code -ne 0) { $fail += 'pm2 global install' }
  # A site already runs the pm2 daemon before an install; start it here the same way, detached.
  $ping = Invoke-CmdLine -CommandLine 'pm2 ping' -TimeoutSec 120
  $res['pm2_daemon_ping_exit'] = $ping.Code
  if ($ping.Code -ne 0) { $fail += 'pm2 daemon did not start' }

  # PostgreSQL that the windows image ships (service postgresql-x64-NN, disabled by default).
  $svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
  $res['pg_service_found'] = ($null -ne $svc)
  $pgBin = $env:PGBIN
  if ($null -ne $svc) {
    if ([string]::IsNullOrWhiteSpace($pgBin)) {
      $wmi = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $svc.Name + "'")
      $mm = [regex]::Match([string]$wmi.PathName, '^"?(.+?)\\pg_ctl\.exe')
      if ($mm.Success) { $pgBin = $mm.Groups[1].Value }
    }
    Set-Service -Name $svc.Name -StartupType Manual
    Start-Service -Name $svc.Name
    (Get-Service -Name $svc.Name).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
    $res['pg_service_running'] = ((Get-Service -Name $svc.Name).Status -eq 'Running')
  } else {
    $res['pg_service_running'] = $false
  }
  $res['pg_bin_found'] = (-not [string]::IsNullOrWhiteSpace($pgBin)) -and (Test-Path -LiteralPath (Join-Path $pgBin 'psql.exe'))
  if (-not $res['pg_service_running'] -or -not $res['pg_bin_found']) {
    $fail += 'preinstalled PostgreSQL is not usable on this runner image'
    $res['failures'] = $fail
    Write-Json -Value $res -Path (Join-Path $Out 'preflight.json')
    Write-H ('PREFLIGHT FAILED: ' + ($fail -join '; '))
    exit 1
  }
  Set-Content -LiteralPath (Join-Path $H 'pgbin.txt') -Value $pgBin -Encoding ASCII

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    $pr = Invoke-CmdLine -CommandLine ('"' + (Join-Path $pgBin 'pg_isready.exe') + '" -h 127.0.0.1 -p 5432')
    if ($pr.Code -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  $res['pg_ready'] = $ready

  # Throwaway role + database. Synthetic only; the password never leaves this runner.
  $dbPass = New-Secret -Bytes 24
  $jwt = New-Secret -Bytes 32
  $encKey = New-Secret -Bytes 32
  $encSalt = New-Secret -Bytes 16
  foreach ($v in @($dbPass, $jwt, $encKey, $encSalt)) { Write-Host ('::add-mask::' + $v) }
  $suUser = $env:PGUSER
  if ([string]::IsNullOrWhiteSpace($suUser)) { $suUser = 'postgres' }
  $suPass = $env:PGPASSWORD
  if ([string]::IsNullOrWhiteSpace($suPass)) { $suPass = 'root' }
  $sqlFile = Join-Path $H 'create-role.sql'
  Set-Content -LiteralPath $sqlFile -Encoding ASCII -Value @(
    ("CREATE ROLE " + $AppRole + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '" + $dbPass + "';"),
    ("CREATE DATABASE " + $AppDb + " OWNER " + $AppRole + " ENCODING 'UTF8' TEMPLATE template0;")
  )
  $prev = $env:PGPASSWORD
  $env:PGPASSWORD = $suPass
  $cr = Invoke-CmdLine -CommandLine ('"' + (Join-Path $pgBin 'psql.exe') + '" -h 127.0.0.1 -p 5432 -U ' + $suUser + ' -d postgres -w -X -q -v ON_ERROR_STOP=1 -f "' + $sqlFile + '"')
  $ver = Invoke-CmdLine -CommandLine ('"' + (Join-Path $pgBin 'psql.exe') + '" -h 127.0.0.1 -p 5432 -U ' + $suUser + ' -d postgres -w -X -tA -c "SHOW server_version_num"')
  $env:PGPASSWORD = $prev
  Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
  $res['pg_role_db_create_exit'] = $cr.Code
  $res['pg_server_version_num'] = ((@($ver.Out) -join '').Trim())
  if ($cr.Code -ne 0) { $fail += 'could not create the throwaway role/database'; Write-H ('psql stderr: ' + ($cr.Err -replace [regex]::Escape($dbPass), '***')) }

  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'docker') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\attendance-import') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\attachments') | Out-Null
  Set-Content -LiteralPath (Join-Path $Root 'docker\app.env') -Encoding ASCII -Value @(
    '# Synthetic rehearsal env written by scripts/ci/stock-prep-p2-install-rehearsal.ps1 (CI only).',
    'NODE_ENV=production',
    'PRODUCT_MODE=platform',
    'DEPLOYMENT_MODEL=onprem',
    'HOST=127.0.0.1',
    ('PORT=' + $BackendPort),
    ('JWT_SECRET=' + $jwt),
    ('ENCRYPTION_KEY=' + $encKey),
    ('ENCRYPTION_SALT=' + $encSalt),
    ('DATABASE_URL=postgres://' + $AppRole + ':' + $dbPass + '@127.0.0.1:5432/' + $AppDb),
    'DB_SSL=false',
    'ATTENDANCE_IMPORT_REQUIRE_TOKEN=1',
    ('ATTENDANCE_IMPORT_UPLOAD_DIR=' + (Join-Path $Root 'data\attendance-import')),
    ('ATTACHMENT_PATH=' + (Join-Path $Root 'data\attachments')),
    'ATTACHMENT_STORAGE_BASE_URL=http://127.0.0.1/files'
  )
  $su = Invoke-AppSql -Sql 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user;'
  $res['app_role_connects'] = ($su.Code -eq 0)
  $res['app_role_is_superuser'] = ((@($su.Out) -join '').Trim() -eq 't')
  if ($su.Code -ne 0) { $fail += 'app role cannot connect' }

  $res['proxy_started'] = Start-Proxy
  $probe = Get-Health -Url 'http://127.0.0.1/health'
  $res['proxy_probe_code_without_backend'] = $probe.Code
  if (-not $res['proxy_started']) { $fail += 'harness proxy on port 80 did not start' }
  $res['corepack_before_any_install'] = Get-CorepackState
  $res['failures'] = $fail
  Write-Json -Value $res -Path (Join-Path $Out 'preflight.json')
  foreach ($k in $res.Keys) { Write-H ("{0} = {1}" -f $k, (($res[$k] | Out-String).Trim() -replace '\s+', ' ')) }
  if ($fail.Count -gt 0) { Write-H ('PREFLIGHT FAILED: ' + ($fail -join '; ')); exit 1 }
}

function Invoke-Sample {
  $deadline = (Get-Date).AddMinutes(90)
  $lastLen = -1; $mig = 0; $rst = 0
  while (-not (Test-Path -LiteralPath $StopFile) -and (Get-Date) -lt $deadline) {
    $ts = [DateTime]::UtcNow.ToString('o')
    $code = 0
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $BackendPort + '/health') -TimeoutSec 2
      $code = [int]$r.StatusCode
    } catch {
      $code = Get-WebErrorCode -ErrorRecord $_
    }
    $alive = 0
    if ($OldPid -gt 0 -and $null -ne (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { $alive = 1 }
    if (Test-Path -LiteralPath $LogPath) {
      $len = (Get-Item -LiteralPath $LogPath).Length
      if ($len -ne $lastLen) {
        $lastLen = $len
        try {
          $fs = [System.IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
          $sr = New-Object System.IO.StreamReader($fs)
          $text = $sr.ReadToEnd()
          $sr.Dispose()
          if ($text.Contains('Run database migrations')) { $mig = 1 }
          if ($text.Contains('Start or restart PM2 service')) { $rst = 1 }
        } catch { }
      }
    }
    Add-Content -LiteralPath $CsvPath -Value ("{0},{1},{2},{3},{4}" -f $ts, $code, $alive, $mig, $rst) -Encoding ASCII
    Start-Sleep -Milliseconds 300
  }
}

function ConvertTo-Utc {
  param([string]$s)
  return [DateTime]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

function Invoke-Install {
  $res = [ordered]@{ leg = $Label; inject = $Inject }
  $fail = @()
  $log = Join-Path $H ($Label + '-bootstrap.log')
  $csv = Join-Path $H ($Label + '-samples.csv')
  $stop = Join-Path $H ($Label + '-sampler.stop')
  Remove-Item -LiteralPath $log, $csv, $stop -Force -ErrorAction SilentlyContinue

  Write-T ($Label + ': reading the before-state')
  $preK = Get-KyselyState
  $prePm2 = Get-Pm2State
  $preCore = Get-CorepackState
  $preHealth = Get-Health -Url ('http://127.0.0.1:' + $BackendPort + '/api/health')
  $res['before'] = [ordered]@{
    kysely_count = $preK.Count
    pm2_present = $prePm2.present; pm2_status = $prePm2.status; pm2_restarts = $prePm2.restarts
    backend_health_code = $preHealth.Code
  }

  if ($Inject -eq 'health-port-blocked') {
    # Injected post-migration failure: take the harness port-80 proxy away, so the apply's own
    # health check (after migrate + pm2 restart) cannot pass. Nothing in the package is changed.
    $res['inject_port80_closed'] = Stop-Proxy
    if (-not $res['inject_port80_closed']) { $fail += 'could not close port 80 for the injection' }
  } else {
    $res['proxy_up'] = Start-Proxy
    if (-not $res['proxy_up']) { $fail += 'harness proxy on port 80 is not up' }
  }

  $oldPid = 0
  if ($prePm2.present -and $prePm2.status -eq 'online') { $oldPid = $prePm2.pid }
  $samplerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Action', 'Sample',
    '-Work', $W, '-LogPath', $log, '-CsvPath', $csv, '-StopFile', $stop, '-OldPid', [string]$oldPid)
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $samplerArgs -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2

  # The operator step, unchanged: <bootstrap.bat> <zip> <root> <install-deps=1> <run-migrations=1>.
  $wrapper = Join-Path $H ($Label + '-operator.cmd')
  Set-Content -LiteralPath $wrapper -Encoding ASCII -Value @(
    '@echo off',
    ('call "' + $Bat + '" "' + $Zip + '" "' + $Root + '" 1 1 >"' + $log + '" 2>&1'),
    'exit /b %ERRORLEVEL%'
  )
  Write-T ($Label + ': operator step starts (deploy-bootstrap .bat, install-deps 1, run-migrations 1)')
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $op = Start-Detached -CmdFile $wrapper
  $timedOut = $false
  $nextBeat = 60
  while (-not $op.WaitForExit(5000)) {
    $el = [int]$sw.Elapsed.TotalSeconds
    if ($el -ge $nextBeat) {
      $nextBeat += 60
      $lastLine = ''
      if (Test-Path -LiteralPath $log) {
        $lastLine = [string](@(Get-Content -LiteralPath $log | Where-Object { $_ -match '^\[(multitable-onprem-|corepack|node-rm)' }) | Select-Object -Last 1)
      }
      $depLog = Get-ChildItem -LiteralPath (Join-Path $Root 'output\logs') -Filter 'dependency-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
      $depInfo = ''
      if ($null -ne $depLog) { $depInfo = ('{0} {1}B' -f $depLog.Name, $depLog.Length) }
      Write-T ("{0}: running {1}s; last: {2}; dep log: {3}" -f $Label, $el, $lastLine, $depInfo)
    }
    if ($el -ge ($OperatorTimeoutMin * 60)) {
      $timedOut = $true
      Write-T ("{0}: operator step still running after {1} min; snapshot then stop" -f $Label, $OperatorTimeoutMin)
      Write-ProcessSnapshot
      Invoke-Diag
      Stop-Tree -ProcessId $op.Id
      break
    }
  }
  $exit = -9
  if (-not $timedOut) { $exit = $op.ExitCode }
  $sw.Stop()
  Write-T ("{0}: operator step ended exit={1} after {2}s" -f $Label, $exit, [int]$sw.Elapsed.TotalSeconds)
  $res['operator_timed_out'] = $timedOut
  if ($timedOut) { $fail += ('operator step did not finish within ' + $OperatorTimeoutMin + ' min') }
  New-Item -ItemType File -Force -Path $stop | Out-Null
  Start-Sleep -Seconds 2
  $res['exit_code'] = $exit
  $res['wall_s'] = [int][Math]::Round($sw.Elapsed.TotalSeconds)

  $text = ''
  if (Test-Path -LiteralPath $log) { $text = [string](Get-Content -LiteralPath $log -Raw) }
  $executed = @([regex]::Matches($text, 'migration "([^"]+)" was executed successfully') | ForEach-Object { $_.Groups[1].Value })
  $failedMig = @([regex]::Matches($text, 'failed to execute migration "([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  $bootMarker = [regex]::Match($text, '\[multitable-onprem-deploy-bootstrap\] apply exit=(\d+)')
  $launchMarker = [regex]::Match($text, '\[multitable-onprem-deploy-launcher\] apply exit=(\d+)')
  $pinned = [regex]::Match($text, 'Pinned pnpm ready: version=(\S+)')
  $pre = [regex]::Match($text, 'Preflight dependencies in staging[^\r\n]*finished with exit code (\d+) after (\d+)s')
  $act = [regex]::Match($text, 'Activate preflighted dependencies[^\r\n]*finished with exit code (\d+) after (\d+)s')
  $res['migrations_executed'] = $executed.Count
  $res['migrations_failed'] = $failedMig.Count
  $res['executed_names'] = $executed
  $res['modified_migration_reexecuted'] = [bool]($executed -contains 'zzzz20260918110000_add_attendance_requests_approval_workflow_key')
  $res['bootstrap_marker_exit'] = $(if ($bootMarker.Success) { [int]$bootMarker.Groups[1].Value } else { -1 })
  $res['launcher_marker_exit'] = $(if ($launchMarker.Success) { [int]$launchMarker.Groups[1].Value } else { -1 })
  $res['package_deploy_complete_line'] = $text.Contains('Package deploy complete')
  $res['healthcheck_failed_line'] = $text.Contains('Healthcheck failed for')
  $res['migration_step_started_line'] = $text.Contains('Run database migrations')
  $res['pm2_restart_step_line'] = $text.Contains('Start or restart PM2 service')
  $res['any_restore_line'] = [bool]($text -match '(?i)restoring|Rollback backup preserved|RESTORE REQUIRED')
  $res['corepack_prepare_invoked'] = $text.Contains('corepack prepare pnpm@')
  $res['corepack_output_lines'] = @([regex]::Matches($text, '(?m)^\[corepack\]')).Count
  $res['corepack_unavailable_line'] = $text.Contains('corepack is unavailable')
  $res['pinned_pnpm_version'] = $(if ($pinned.Success) { $pinned.Groups[1].Value } else { '' })
  $res['dep_preflight_s'] = $(if ($pre.Success) { [int]$pre.Groups[2].Value } else { -1 })
  $res['dep_activate_s'] = $(if ($act.Success) { [int]$act.Groups[2].Value } else { -1 })
  $res['operator_tail'] = Get-OperatorTail -Log $log

  # Known install-script defect on a host where pm2 has never registered the app (a fresh root):
  # attendance-onprem-start-pm2.ps1:393 runs 'pm2 describe <app> *> $null' under
  # ErrorActionPreference=Stop (:7). In Windows PowerShell 5.1 pm2's "[PM2][WARN] <app> doesn't
  # exist" on stderr becomes a terminating error, so the Start-Pm2App branch (:395) never runs and
  # the apply exits 1 after the migrations. A site that runs the backend already has the app
  # registered, so this does not apply there. For the baseline only, the harness registers the
  # app with the exact command Start-Pm2App would have run, then lets the upgrade legs run on the
  # site-shaped state.
  $freshDefect = ($exit -ne 0) -and $text.Contains('Start or restart PM2 service') -and ($text -match "\[PM2\]\[WARN\] \S+ doesn't exist")
  $res['fresh_host_pm2_describe_defect'] = [bool]$freshDefect
  $res['harness_registered_app'] = $false
  if ($freshDefect -and $RegisterOnFreshPm2Defect) {
    Write-T ($Label + ': fresh-host pm2 describe defect seen; registering the app as Start-Pm2App would')
    $eco = Join-Path $Root 'ecosystem.config.cjs'
    $reg = Invoke-WithAppEnv { Invoke-CmdLine -CommandLine ('pm2 start "' + $eco + '" --only ' + $Pm2App + ' --env production --update-env') -Cwd $Root -TimeoutSec 120 }
    $sav = Invoke-CmdLine -CommandLine 'pm2 save' -TimeoutSec 60
    $res['harness_register_exit'] = $reg.Code
    $res['harness_pm2_save_exit'] = $sav.Code
    $res['harness_registered_app'] = ($reg.Code -eq 0 -and $sav.Code -eq 0)
    for ($i = 0; $i -lt 45; $i++) {
      if ((Get-Health -Url ('http://127.0.0.1:' + $BackendPort + '/health')).Code -eq 200) { break }
      Start-Sleep -Seconds 2
    }
  }

  Write-T ($Label + ': reading the after-state')
  $script:TraceCmd = $true
  $postK = Get-KyselyState -AfterTs $preK.MaxTs
  Write-T ('after-state: kysely ' + $postK.Count)
  $list = Get-MigrateList
  Write-T ('after-state: migrate --list applied ' + $list.Applied + ' pending ' + $list.Pending)
  $res['kysely_count_after'] = $postK.Count
  $res['kysely_new_rows'] = $postK.NewCount
  $res['migrate_list_exit'] = $list.Code
  $res['migrate_list_applied'] = $list.Applied
  $res['migrate_list_pending'] = $list.Pending
  $postPm2 = Get-Pm2State
  Write-T ('after-state: pm2 reader ' + $postPm2.reader + ' status ' + $postPm2.status + ' under root ' + $postPm2.execUnderRoot)
  $res['after_pm2'] = [ordered]@{
    present = $postPm2.present; status = $postPm2.status; restarts = $postPm2.restarts
    pid_changed = ($prePm2.present -and $postPm2.present -and $prePm2.pid -ne $postPm2.pid)
    exec_under_root = $postPm2.execUnderRoot
  }
  $hb = Get-Health -Url ('http://127.0.0.1:' + $BackendPort + '/api/health') -Commit $ExpectCommit
  $hp = Get-Health -Url 'http://127.0.0.1/api/health' -Commit $ExpectCommit
  $res['health_backend_code'] = $hb.Code
  $res['health_backend_commit_is_expected'] = $hb.CommitMatchesExpected
  $res['health_via_port80_code'] = $hp.Code
  Write-T ('after-state: health ' + $hb.Code + ' / ' + $hp.Code)

  $watchdog = Start-Watchdog -Minutes 8
  $prov = Read-Json -Path (Join-Path $Root 'BUILD_PROVENANCE.json')
  $rootProvIsExpected = ($null -ne $prov -and [string]$prov.gitCommit -eq $ExpectCommit)
  $res['root_provenance_commit_is_expected'] = $rootProvIsExpected

  # Expectations (legs 1-3 gate here; leg 4 is asserted by AssertLeg4).
  if ($ExpectExit -eq 'zero') {
    if (-not ($freshDefect -and $res['harness_registered_app'])) {
      if ($exit -ne 0) { $fail += "deploy-bootstrap exit $exit" }
      if ($res['bootstrap_marker_exit'] -ne 0) { $fail += 'bootstrap marker is not apply exit=0' }
      if (-not $res['package_deploy_complete_line']) { $fail += 'no Package deploy complete line' }
    }
    if ($ExpectExecuted -ge 0 -and $executed.Count -ne $ExpectExecuted) { $fail += ("executed {0}, expected {1}" -f $executed.Count, $ExpectExecuted) }
    if ($ExpectApplied -ge 0 -and $postK.Count -ne $ExpectApplied) { $fail += ("kysely_migration {0}, expected {1}" -f $postK.Count, $ExpectApplied) }
    if ($ExpectApplied -ge 0 -and $list.Applied -ne $ExpectApplied) { $fail += ("migrate --list Applied {0}, expected {1}" -f $list.Applied, $ExpectApplied) }
    if ($list.Pending -ne 0) { $fail += ("migrate --list Pending {0}" -f $list.Pending) }
    if ($ExpectExecuted -ge 0 -and $postK.NewCount -ne $ExpectExecuted) { $fail += ("new kysely rows {0}, expected {1}" -f $postK.NewCount, $ExpectExecuted) }
    if ($hb.Code -ne 200) { $fail += ("backend health {0}" -f $hb.Code) }
    if (-not $hb.CommitMatchesExpected) { $fail += 'build.commit is not the expected commit' }
    if (-not ($postPm2.present -and $postPm2.status -eq 'online')) { $fail += 'pm2 app not online' }
    if (-not $rootProvIsExpected) { $fail += 'root BUILD_PROVENANCE.json is not the expected commit' }
  }
  $res['failures'] = $fail
  Write-Json -Value $res -Path (Join-Path $Out ($Label + '.json'))
  Write-H ("{0}: exit={1} wall_s={2} executed={3} kysely={4} applied={5} pending={6} health={7} commit_ok={8} pm2={9}" -f $Label, $exit, $res['wall_s'], $executed.Count, $postK.Count, $list.Applied, $list.Pending, $hb.Code, $hb.CommitMatchesExpected, $postPm2.status)
  foreach ($l in $res['operator_tail']) { Write-H ('operator> ' + $l) }
  # Core numbers are on disk before the extended analysis, so a stall there cannot lose them.
  Write-T ($Label + ': core result written; extended analysis')
  $script:TraceCmd = $true

  # Was the previous backend running while the migrations executed? Same clock for all three:
  # sampler rows (UTC), kysely_migration.timestamp of the new rows (node, UTC) and the old pm2 pid.
  $samples = @()
  if (Test-Path -LiteralPath $csv) {
    foreach ($l in Get-Content -LiteralPath $csv) {
      $p = $l.Split(',')
      if ($p.Length -ge 5) { $samples += [pscustomobject]@{ t = (ConvertTo-Utc $p[0]); code = [int]$p[1]; alive = [int]$p[2]; mig = [int]$p[3]; rst = [int]$p[4] } }
    }
  }
  $res['samples'] = $samples.Count
  $run = [ordered]@{ old_backend_online_before = ($oldPid -gt 0); evaluated = $false }
  if ($oldPid -gt 0 -and $postK.NewCount -gt 0 -and $postK.NewMin -and $postK.NewMax) {
    $tMin = ConvertTo-Utc $postK.NewMin
    $tMax = ConvertTo-Utc $postK.NewMax
    $before = @($samples | Where-Object { $_.t -lt $tMin }) | Select-Object -Last 1
    $after = @($samples | Where-Object { $_.t -gt $tMax }) | Select-Object -First 1
    $inside = @($samples | Where-Object { $_.t -ge $tMin -and $_.t -le $tMax })
    $run['evaluated'] = $true
    $run['migration_window_ms'] = [int]($tMax - $tMin).TotalMilliseconds
    $run['old_pid_alive_last_sample_before'] = ($null -ne $before -and $before.alive -eq 1)
    $run['old_backend_health_200_last_sample_before'] = ($null -ne $before -and $before.code -eq 200)
    $run['old_pid_alive_first_sample_after'] = ($null -ne $after -and $after.alive -eq 1)
    $run['samples_inside_window'] = $inside.Count
    $run['samples_inside_window_health_200'] = @($inside | Where-Object { $_.code -eq 200 }).Count
    $mw = @($samples | Where-Object { $_.mig -eq 1 -and $_.rst -eq 0 })
    $run['samples_between_migrate_and_restart_lines'] = $mw.Count
    $run['samples_between_migrate_and_restart_old_pid_alive'] = @($mw | Where-Object { $_.alive -eq 1 }).Count
    $run['samples_between_migrate_and_restart_health_200'] = @($mw | Where-Object { $_.code -eq 200 }).Count
    # A pid cannot come back, so alive before the first new row and after the last one means alive throughout.
    $run['backend_running_during_migrate'] = ($run['old_pid_alive_last_sample_before'] -and $run['old_pid_alive_first_sample_after'])
  }
  $res['running_during_migrate'] = $run

  Write-T ($Label + ': samples parsed')
  $postCore = Get-CorepackState
  $res['corepack_before'] = $preCore
  $res['corepack_after'] = $postCore
  $res['corepack_global_state_changed'] = (($preCore | ConvertTo-Json -Compress) -ne ($postCore | ConvertTo-Json -Compress))

  Write-T ($Label + ': corepack state read')
  # Which files does the root hold now: R84's or F's? And what does R84 leave behind?
  $diff = Read-Json -Path (Join-Path $H 'package-diff.json')
  $fileView = [ordered]@{ changed_total = 0; changed_root_is_f = 0; changed_root_is_r84 = 0; changed_root_other_or_missing = 0
    onlyF_total = 0; onlyF_present = 0; onlyR84_total = 0; onlyR84_left_in_root = 0; onlyR84_left_compiled_migrations = 0 }
  $leftList = @()
  if ($null -ne $diff) {
    foreach ($e in @($diff.changed)) {
      $fileView['changed_total'] += 1
      $rp = Join-Path $Root $e.p
      if (Test-Path -LiteralPath $rp) {
        $fileHash = Get-FileSha -Path $rp
        if ($fileHash -eq $e.f) { $fileView['changed_root_is_f'] += 1 } elseif ($fileHash -eq $e.r84) { $fileView['changed_root_is_r84'] += 1 } else { $fileView['changed_root_other_or_missing'] += 1 }
      } else { $fileView['changed_root_other_or_missing'] += 1 }
    }
    foreach ($e in @($diff.onlyF)) { $fileView['onlyF_total'] += 1; if (Test-Path -LiteralPath (Join-Path $Root $e.p)) { $fileView['onlyF_present'] += 1 } }
    foreach ($e in @($diff.onlyR84)) {
      $fileView['onlyR84_total'] += 1
      if (Test-Path -LiteralPath (Join-Path $Root $e.p)) {
        $fileView['onlyR84_left_in_root'] += 1
        $leftList += $e.p
        if ($e.p -like 'packages\core-backend\dist\src\db\migrations\*') { $fileView['onlyR84_left_compiled_migrations'] += 1 }
      }
    }
  }
  $fileView['root_provenance_commit_is_expected'] = $rootProvIsExpected
  $res['files'] = $fileView
  $res['files_left_from_r84'] = $leftList
  Write-T ($Label + ': file view done')
  $res['staging_leftovers'] = Get-StagingLeftovers
  $res['node_modules_backups_left'] = Get-NodeModulesBackups
  $res['root_node_modules_present'] = (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))

  Write-T ($Label + ': extended analysis done')
  Write-Json -Value $res -Path (Join-Path $Out ($Label + '.json'))
  if ($null -ne $watchdog) { Stop-Process -Id $watchdog.Id -Force -ErrorAction SilentlyContinue }
  if ($ExpectExit -eq 'nonzero') {
    # Injected failure leg: report the bootstrap's own exit code so the workflow step shows it.
    if ($exit -eq 0) { exit 0 }
    exit $exit
  }
  if ($fail.Count -gt 0) { Write-H ('LEG FAILED: ' + ($fail -join '; ')); exit 1 }
}

function Invoke-AssertLeg4 {
  $j = Read-Json -Path (Join-Path $Out 'leg4.json')
  if ($null -eq $j) { Write-H 'leg4.json missing'; exit 1 }
  $a = [ordered]@{}
  $a['exit_nonzero'] = ([int]$j.exit_code -ne 0)
  $a['last_marker_is_apply_exit_1'] = ([int]$j.bootstrap_marker_exit -eq 1)
  $a['failed_at_health_check'] = [bool]$j.healthcheck_failed_line
  $a['migrations_ran_before_failure'] = ([int]$j.migrations_executed -eq [int]$env:F_NEW_MIGRATIONS)
  $a['db_left_at_f_count'] = ([int]$j.kysely_count_after -eq [int]$env:F_APPLIED)
  $a['pm2_restart_step_ran'] = [bool]$j.pm2_restart_step_line
  # Documented caveat (apply-package.ps1 post-migration catch only restores when InstallDeps=0):
  $a['caveat_files_not_restored'] = ([int]$j.files.changed_root_is_f -eq [int]$j.files.changed_total -and [int]$j.files.changed_root_is_r84 -eq 0)
  $a['caveat_no_restore_message'] = (-not [bool]$j.any_restore_line)
  $a['caveat_file_backup_deleted'] = ([int]$j.staging_leftovers.mspb -eq 0)
  $obs = [ordered]@{
    root_provenance_is_f = [bool]$j.files.root_provenance_commit_is_expected
    backend_after_failure_status = [string]$j.after_pm2.status
    backend_after_failure_serves_f_commit = [bool]$j.health_backend_commit_is_expected
    backend_after_failure_health_code = [int]$j.health_backend_code
    files_left_from_r84 = [int]$j.files.onlyR84_left_in_root
    node_modules_backups_left = [int]$j.node_modules_backups_left
  }
  $out = [ordered]@{ asserts = $a; observations = $obs }
  Write-Json -Value $out -Path (Join-Path $Out 'leg4-assert.json')
  $bad = @($a.Keys | Where-Object { -not $a[$_] })
  foreach ($k in $a.Keys) { Write-H ("assert {0} = {1}" -f $k, $a[$k]) }
  foreach ($k in $obs.Keys) { Write-H ("observe {0} = {1}" -f $k, $obs[$k]) }
  if ($bad.Count -gt 0) { Write-H ('LEG 4 OBSERVATION DIFFERS FROM THE DOCUMENTED CAVEAT: ' + ($bad -join ', ')); exit 1 }
}

function Start-Watchdog {
  # A detached process that ends this harness process if the extended analysis stalls. The core
  # result is already on disk; the step verdict reads it (Action Verdict), so the leg still counts.
  param([int]$Minutes)
  $cmd = ('Start-Sleep -Seconds ' + ($Minutes * 60) + '; Stop-Process -Id ' + $PID + ' -Force')
  return (Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile', '-Command', $cmd) -WindowStyle Hidden -PassThru)
}

function Invoke-Verdict {
  $j = Read-Json -Path (Join-Path $Out ($Label + '.json'))
  if ($null -eq $j) { Write-H ($Label + ': no result file'); exit 1 }
  if ($ExpectExit -eq 'nonzero') {
    Write-H ($Label + ': injected-failure leg, bootstrap exit ' + $j.exit_code)
    if ([int]$j.exit_code -eq 0) { exit 0 }
    exit 1
  }
  $f = @($j.failures | Where-Object { $_ })
  if ($f.Count -gt 0) { Write-H ($Label + ' FAILED: ' + ($f -join '; ')); exit 1 }
  Write-H ($Label + ': passed')
}

function Format-B { param($v) if ($v -is [bool]) { if ($v) { return 'yes' } else { return 'no' } } return [string]$v }

function Invoke-Summary {
  $md = New-Object System.Collections.Generic.List[string]
  $md.Add('## Package-2 install path rehearsal (' + $Label + ')')
  $md.Add('')
  $md.Add('Synthetic data only. Disposable GitHub-hosted Windows runner, Windows PowerShell 5.1, the package''s own deploy-bootstrap `.bat` with install-deps 1 and run-migrations 1.')
  $md.Add('')
  $prep = Read-Json -Path (Join-Path $Out 'prepare.json')
  if ($null -ne $prep) {
    $md.Add('**Inputs:** R84 zip/ps1/bat sha256 match SHA256SUMS, sidecars and pins: ' + (Format-B ($prep.r84_zip_matches_pin -and $prep.r84_ps1_matches_pin -and $prep.r84_bat_matches_pin -and $prep.r84_zip_matches_SHA256SUMS -and $prep.r84_ps1_matches_SHA256SUMS -and $prep.r84_bat_matches_SHA256SUMS)) +
      '; F zip/ps1/bat: ' + (Format-B ($prep.f_zip_matches_pin -and $prep.f_ps1_matches_pin -and $prep.f_bat_matches_pin -and $prep.f_zip_matches_SHA256SUMS -and $prep.f_ps1_matches_SHA256SUMS -and $prep.f_bat_matches_SHA256SUMS)) +
      '; provenance R84 / F: ' + (Format-B $prep.r84_provenance_commit_matches) + ' / ' + (Format-B $prep.f_provenance_commit_matches) +
      '; files R84 ' + $prep.r84_file_count + ', F ' + $prep.f_file_count + ', only-R84 ' + $prep.files_only_in_r84 + ', only-F ' + $prep.files_only_in_f + ', changed ' + $prep.files_changed_r84_to_f + '.')
    $md.Add('')
  }
  $pf = Read-Json -Path (Join-Path $Out 'preflight.json')
  if ($null -ne $pf) {
    $md.Add('**Runner:** PowerShell ' + $pf.powershell_version + ', node ' + $pf.node_version + ' (Program Files: ' + (Format-B $pf.node_in_program_files) + '), pm2 ' + $pf.pm2_version + ', PostgreSQL ' + $pf.pg_server_version_num + ', app role superuser: ' + (Format-B $pf.app_role_is_superuser) + ', corepack ' + $pf.corepack_before_any_install.corepackVersion + '.')
    $md.Add('')
  }
  $md.Add('| leg | exit | wall s | executed | kysely after | --list applied/pending | health | build.commit ok | pm2 | backend ran during migrate | files left from R84 |')
  $md.Add('|---|---|---|---|---|---|---|---|---|---|---|')
  foreach ($leg in @('leg1', 'leg2', 'leg3', 'leg4')) {
    $j = Read-Json -Path (Join-Path $Out ($leg + '.json'))
    if ($null -eq $j) { continue }
    $ran = 'n/a'
    if ($j.running_during_migrate.evaluated) { $ran = Format-B $j.running_during_migrate.backend_running_during_migrate }
    $md.Add(('| {0} | {1} | {2} | {3} | {4} | {5}/{6} | {7} | {8} | {9} (restarts {10}) | {11} | {12} |' -f
        $leg, $j.exit_code, $j.wall_s, $j.migrations_executed, $j.kysely_count_after, $j.migrate_list_applied, $j.migrate_list_pending,
        $j.health_backend_code, (Format-B $j.health_backend_commit_is_expected), $j.after_pm2.status, $j.after_pm2.restarts, $ran, $j.files.onlyR84_left_in_root))
  }
  $md.Add('')
  $j1 = Read-Json -Path (Join-Path $Out 'leg1.json')
  if ($null -ne $j1 -and $j1.fresh_host_pm2_describe_defect) {
    $md.Add('**Leg 1 finding:** on the empty root the R84 deploy-bootstrap ran all migrations, then exited 1 at the pm2 start: `attendance-onprem-start-pm2.ps1` runs `pm2 describe <app> *> $null` under ErrorActionPreference Stop, and in PowerShell 5.1 the pm2 "doesn''t exist" warning on stderr aborts the script before it registers the app. The harness then registered the app with the same pm2 start command (registered: ' + (Format-B $j1.harness_registered_app) + '), which is the state a running site already has.')
    $md.Add('')
  }
  foreach ($leg in @('leg2', 'leg3', 'leg4')) {
    $j = Read-Json -Path (Join-Path $Out ($leg + '.json'))
    if ($null -eq $j) { continue }
    $r = $j.running_during_migrate
    $md.Add('**' + $leg + ' detail:** dependency preflight ' + $j.dep_preflight_s + ' s, activation ' + $j.dep_activate_s + ' s' +
      '; corepack prepare invoked: ' + (Format-B $j.corepack_prepare_invoked) + ', pinned pnpm ' + $j.pinned_pnpm_version +
      ', corepack global state changed: ' + (Format-B $j.corepack_global_state_changed) +
      ', pnpm shim in node dir after: ' + (Format-B $j.corepack_after.pnpmShimInNodeDir) +
      ', corepack last-known-good pnpm after: ' + $j.corepack_after.corepackLastKnownGoodPnpm +
      '; modified migration re-executed: ' + (Format-B $j.modified_migration_reexecuted) +
      '; changed files now F/R84/other: ' + $j.files.changed_root_is_f + '/' + $j.files.changed_root_is_r84 + '/' + $j.files.changed_root_other_or_missing + ' of ' + $j.files.changed_total +
      '; R84-only files left: ' + $j.files.onlyR84_left_in_root + ' (compiled migrations ' + $j.files.onlyR84_left_compiled_migrations + ')' +
      '; staging leftovers msdl/mspa/mspb: ' + $j.staging_leftovers.msdl + '/' + $j.staging_leftovers.mspa + '/' + $j.staging_leftovers.mspb +
      '; node_modules backups left: ' + $j.node_modules_backups_left + '.')
    if ($r.evaluated) {
      $md.Add('  Migration window ' + $r.migration_window_ms + ' ms; old pid alive before/after: ' + (Format-B $r.old_pid_alive_last_sample_before) + '/' + (Format-B $r.old_pid_alive_first_sample_after) +
        '; old backend health 200 just before: ' + (Format-B $r.old_backend_health_200_last_sample_before) +
        '; samples between the migrate and restart log lines: ' + $r.samples_between_migrate_and_restart_lines + ' (old pid alive ' + $r.samples_between_migrate_and_restart_old_pid_alive + ', health 200 ' + $r.samples_between_migrate_and_restart_health_200 + ').')
    }
    $md.Add('')
  }
  $a = Read-Json -Path (Join-Path $Out 'leg4-assert.json')
  if ($null -ne $a) {
    $md.Add('**Leg 4 (injected post-migration failure: health-check port closed):**')
    foreach ($p in $a.asserts.PSObject.Properties) { $md.Add('- assert ' + $p.Name + ': ' + (Format-B $p.Value)) }
    foreach ($p in $a.observations.PSObject.Properties) { $md.Add('- observed ' + $p.Name + ': ' + (Format-B $p.Value)) }
    $j4 = Read-Json -Path (Join-Path $Out 'leg4.json')
    if ($null -ne $j4) {
      $md.Add('')
      $md.Add('What the operator sees (last apply/launcher/bootstrap lines):')
      $md.Add('')
      $md.Add('```')
      foreach ($l in @($j4.operator_tail)) { $md.Add([string]$l) }
      $md.Add('```')
    }
  }
  $text = ($md -join "`n")
  Set-Content -LiteralPath (Join-Path $Out ('summary-' + $Label + '.md')) -Value $text -Encoding UTF8
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $text -Encoding UTF8 }
}

function Invoke-Diag {
  Write-H 'diagnostics (tails; secrets are masked by the runner)'
  foreach ($f in @(Get-ChildItem -LiteralPath $H -Filter '*-bootstrap.log' -ErrorAction SilentlyContinue)) {
    Write-H ('--- ' + $f.Name); Get-Content -LiteralPath $f.FullName -Tail 80 | ForEach-Object { Write-Host $_ }
  }
  $logs = Join-Path $Root 'output\logs'
  if (Test-Path -LiteralPath $logs) {
    foreach ($f in @(Get-ChildItem -LiteralPath $logs -File | Sort-Object LastWriteTime | Select-Object -Last 8)) {
      Write-H ('--- output\logs\' + $f.Name); Get-Content -LiteralPath $f.FullName -Tail 40 | ForEach-Object { Write-Host $_ }
    }
  }
  $pm = Get-Pm2State
  Write-H ('pm2: ' + ($pm | ConvertTo-Json -Compress))
  if (Test-Path -LiteralPath (Join-Path $H 'proxy.log')) { Write-H '--- proxy.log'; Get-Content -LiteralPath (Join-Path $H 'proxy.log') -Tail 20 | ForEach-Object { Write-Host $_ } }
}

switch ($Action) {
  'Prepare' { Invoke-Prepare }
  'Preflight' { Invoke-Preflight }
  'Install' { Invoke-Install }
  'Sample' { Invoke-Sample }
  'AssertLeg4' { Invoke-AssertLeg4 }
  'Summary' { Invoke-Summary }
  'Diag' { Invoke-Diag }
  'Verdict' { Invoke-Verdict }
}
exit 0
