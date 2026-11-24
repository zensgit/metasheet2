# Test 03-live-env-check.ps1 under Windows PowerShell 5.1 with a MOCK pm2 (no real pm2 runs).
# Derived from the R85 harness (release-p2/install-pack/test/test-live-env.ps1): cases 1-15 and mutants
# M1-M7 are kept, with expected lines updated for the v2 suffix (kind= gate= verdict=), the new state
# words (blank, literal-false) and the LIVEENV_GATE line. Cases 16-19 and mutants M8-M13 are new.
# Judge fixes 2026-11-17: case 20 (several lines for one key in one file: the worst line, F1), case 21
# (LIVEENV_DBURL relation), mutants M14-M18, and a baseline that the unmutated tool passes every mutant
# check (so a stale expected line cannot make a mutant look KILLED). Case 2's root TASKS_ENABLED is now
# literal-true (true then false in the root file: the worst line, no longer the last).
# Judge round 2, 2026-11-17: case 21 rows carry the LIVEENV_DBURL_PROCESS word and gate; cases 21o-21q
# (two values inside one file while the other file lacks the line: differs); case 22 (LIVEENV_DBURL_PROCESS,
# the pm2 env DATABASE_URL vs docker\app.env's); mutants M19a-c (the old early returns put back), M20-M27;
# M17/M18 re-anchored on the rewritten function. App takes an optional 4th argument: the top-level
# pm2_env DATABASE_URL ($null leaves it out).
# The jlist shape is SYNTHETIC: an array of apps with name / pm_id / pm2_env (env keys merged at the top
# level plus an `env` bag), modelled on what the start script reads and on the header of
# stock-preparation-pm2-sample.mjs (Path and PATH both present). It is not a capture of real pm2.
# All fixtures live in a unique temporary directory, removed at the end.
param([Parameter(Mandatory = $true)][string]$Script, [switch]$Mutants)
$ErrorActionPreference = 'Stop'
'PSVersion=' + $PSVersionTable.PSVersion.ToString() + ' Edition=' + $PSVersionTable.PSEdition
'SCRIPT_SHA256=' + (Get-FileHash -LiteralPath $Script -Algorithm SHA256).Hash.ToLowerInvariant()
$script = $Script
$base = Join-Path ([IO.Path]::GetTempPath()) ('p3envrun-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $base | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$utf8bom = New-Object System.Text.UTF8Encoding($true)

# no real pm2 can be reached: PATH holds only Windows and node
$nodeDir = Split-Path -Parent ((Get-Command node.exe).Source)
$env:Path = (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot + ';' + $PSHOME + ';' + $nodeDir
if (@(Get-Command pm2.cmd -ErrorAction SilentlyContinue).Count -ne 0) { 'ABORT a pm2.cmd is reachable on the test PATH'; exit 9 }
$emptyAppData = Join-Path $base 'appdata-empty'; New-Item -ItemType Directory -Force -Path $emptyAppData | Out-Null
$env:APPDATA = $emptyAppData
foreach ($d in @('C:\Users\Administrator\AppData\Roaming\npm', (Join-Path $env:USERPROFILE 'AppData\Roaming\npm'), 'C:\Program Files\nodejs', 'C:\Program Files (x86)\nodejs')) {
  if (Test-Path -LiteralPath (Join-Path $d 'pm2.cmd')) { 'ABORT a pm2.cmd exists in a folder the start script adds to PATH'; exit 9 }
}
# machine/user columns: the harness never writes machine or user env; it only checks they are absent for
# every key it uses, so every expected line below can say machine=absent user=absent
$allTestKeys = @('AUTOMATION_CLASSB_OUTBOUND_ENABLED', 'NODE_ENV', 'MULTITABLE_EMAIL_TRANSPORT', 'TASKS_ENABLED', 'RBAC_BYPASS',
  'DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED', 'INTEGRATION_YIDA_RECONCILE_READ_ENABLED', 'AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED',
  'INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED', 'INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS', 'INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS',
  'INTEGRATION_CORE_STOCK_PREPARATION_PILOT_PATH', 'INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED',
  'INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED', 'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON', 'SOME_OTHER_FLAG', 'ANOTHER_ABSENT_FLAG',
  'DELEGATED_SCOPE_ACTIVATION_ENABLED', 'EXTERNAL_LOGIN_STRICT_SESSION_MAX_AGE_SECONDS', 'DIRECTORY_DEPROVISION_REVOKE_CREDENTIALS_ENABLED', 'INTEGRATION_YIDA_SHEET_SOURCE_ENABLED')
foreach ($k in $allTestKeys) {
  foreach ($scope in @('Machine', 'User')) {
    if ($null -ne [Environment]::GetEnvironmentVariable($k, $scope)) { 'ABORT ' + $scope + ' env holds a test key'; exit 9 }
  }
}

# a live node.exe owned by this account stands in for the pm2 daemon
$dummy = Start-Process -FilePath (Join-Path $nodeDir 'node.exe') -ArgumentList '-e', 'setTimeout(function(){},900000)' -PassThru -WindowStyle Hidden
$homeAlive = Join-Path $base 'pm2home-alive'; New-Item -ItemType Directory -Force -Path $homeAlive | Out-Null
[System.IO.File]::WriteAllText((Join-Path $homeAlive 'pm2.pid'), [string]$dummy.Id, $utf8)
$homeStale = Join-Path $base 'pm2home-stale'; New-Item -ItemType Directory -Force -Path $homeStale | Out-Null
[System.IO.File]::WriteAllText((Join-Path $homeStale 'pm2.pid'), '999999', $utf8)
$homeEmpty = Join-Path $base 'pm2home-empty'; New-Item -ItemType Directory -Force -Path $homeEmpty | Out-Null

function J([string]$s) { return '"' + ($s.Replace('\', '\\').Replace('"', '\"')) + '"' }
function Obj($pairs) {
  $parts = @()
  for ($i = 0; $i -lt $pairs.Count; $i += 2) {
    $v = $pairs[$i + 1]
    if ($v -is [string]) { $vs = J $v } elseif ($null -eq $v) { $vs = 'null' } elseif ($v -is [bool]) { $vs = $(if ($v) { 'true' } else { 'false' }) } elseif ($v -is [int]) { $vs = [string]$v } else { $vs = [string]$v.raw }
    $parts += ((J $pairs[$i]) + ':' + $vs)
  }
  return @{ raw = ('{' + ($parts -join ',') + '}') }
}
$zh = [string]([char]0x4E2D) + [char]0x6587 + [char]0x503C
$big = 'SENTINELBIG' + ('x' * 3000000)

function App([string]$name, $topExtra, $envExtra, $topDb = 'postgres://SENTINELUSER:SENTINELPW@SENTINELHOST/db') {
  $envPairs = @('Path', 'C:\Windows;SENTINELPATH1', 'PATH', 'C:\Windows;SENTINELPATH2', 'PM2_HOME', 'C:\SENTINELHOME') + $envExtra
  $dbPair = @(); if ($null -ne $topDb) { $dbPair = @('DATABASE_URL', $topDb) }
  $top = @('Path', 'C:\Windows;SENTINELPATH1', 'PATH', 'C:\Windows;SENTINELPATH2', 'status', 'online', 'restart_time', 3,
    'pm_exec_path', 'C:\SENTINELROOT\packages\core-backend\dist\src\index.js', 'pm_cwd', 'C:\SENTINELROOT') + $dbPair + @('JWT_SECRET', 'SENTINELJWT',
    'NOTE_ZH', ($zh + 'SENTINELZH'), 'versioning', $null, 'autorestart', $true,
    'axm_options', (Obj @('isModule', $false, 'metrics', (Obj @('a', 1)))), 'env', (Obj $envPairs)) + $topExtra
  return (Obj @('pid', 4242, 'name', $name, 'pm_id', 0, 'monit', (Obj @('memory', 1, 'cpu', 0)), 'pm2_env', (Obj $top))).raw
}

$noise = '>>>> In-memory PM2 is out-of-date, do:' + "`r`n" + '>>>> $ pm2 update' + "`r`n" + '[PM2] notice SENTINELNOISE' + "`r`n"

function New-Root([string]$name, [string]$jlist, [bool]$bom, $rootEnv, $dockerEnv, [int]$exitCode, [bool]$slow, [bool]$withPm2) {
  $r = Join-Path $base $name
  New-Item -ItemType Directory -Force -Path (Join-Path $r 'docker') | Out-Null
  if ($null -ne $rootEnv) { [System.IO.File]::WriteAllText((Join-Path $r 'app.env'), $rootEnv, $utf8) }
  if ($null -ne $dockerEnv) { [System.IO.File]::WriteAllText((Join-Path $r 'docker\app.env'), $dockerEnv, $utf8) }
  if ($withPm2) { New-MockPm2 (Join-Path $r 'node_modules\.bin') $jlist $bom $exitCode $slow }
  return $r
}
# the fake pm2: a .cmd that logs its arguments and types a canned `pm2 jlist` document
function New-MockPm2([string]$bin, [string]$jlist, [bool]$bom, [int]$exitCode, [bool]$slow) {
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $enc = if ($bom) { $utf8bom } else { $utf8 }
  [System.IO.File]::WriteAllText((Join-Path $bin 'jlist.out'), $jlist, $enc)
  $cmd = @('@echo off', 'echo %*>>"%~dp0invoked.txt"')
  if ($slow) { $cmd += 'ping -n 15 127.0.0.1 >nul' }
  $cmd += 'type "%~dp0jlist.out"'
  $cmd += ('exit /b ' + $exitCode)
  [System.IO.File]::WriteAllText((Join-Path $bin 'pm2.cmd'), (($cmd -join "`r`n") + "`r`n"), (New-Object System.Text.ASCIIEncoding))
}

$pass = 0; $fail = 0
function Check([string]$label, [string[]]$out, [string[]]$want, [string[]]$absentLines) {
  foreach ($w in $want) { if ($out -contains $w) { $script:pass++ } else { $script:fail++; ('  FAIL ' + $label + ': missing line: ' + $w) } }
  foreach ($w in $absentLines) { if ($out -notcontains $w) { $script:pass++ } else { $script:fail++; ('  FAIL ' + $label + ': unexpected line: ' + $w) } }
  $leak = @($out | Where-Object { $_ -match 'SENTINEL|postgres|p3envrun|[A-Za-z]:\\|4242' -or $_ -match [regex]::Escape($zh) })
  if ($leak.Count -eq 0) { $script:pass++ } else { $script:fail++; ('  FAIL ' + $label + ': value leaked') }
  $bad = @($out | Where-Object { $_ -notmatch '^LIVEENV(_FILE|_DBURL|_DBURL_PROCESS|_PM2|_BACKEND|_GATE|_RESULT)? [a-z0-9_]+=[A-Za-z0-9_.-]+( [a-z0-9_]+=[A-Za-z0-9_.-]+)*$' })
  if ($bad.Count -eq 0) { $script:pass++ } else { $script:fail++; ('  FAIL ' + $label + ': line outside grammar: ' + $bad[0]) }
  $last = if ($out.Count -gt 0) { $out[$out.Count - 1] } else { '' }
  if ($last -like 'LIVEENV_RESULT *') { $script:pass++ } else { $script:fail++; ('  FAIL ' + $label + ': last line is not LIVEENV_RESULT') }
}
function Run([string]$scriptPath, [string]$root, [string]$pm2Home, [string[]]$extra) {
  $env:PM2_HOME = $pm2Home
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath, '-InstallRoot', $root) + $extra
  $o = @(& (Join-Path $PSHOME 'powershell.exe') @args2)
  $script:lastExit = $LASTEXITCODE
  return $o
}
function Show([string]$title, [string[]]$out) { ('== ' + $title + ' exit=' + $script:lastExit); $out | ForEach-Object { '   ' + $_ } }
function Invoked([string]$root) { return (Test-Path -LiteralPath (Join-Path $root 'node_modules\.bin\invoked.txt')) }
# expected key line; machine and user are always absent in this harness
function L([string]$k, [string]$p, [string]$r, [string]$d, [string]$dup, [string]$pdup, [string]$kind, [string]$gate, [string]$v, [string]$launch = 'absent') {
  return ('LIVEENV key={0} process={1} launch={9} root={2} docker={3} machine=absent user=absent dup={4} pdup={5} kind={6} gate={7} verdict={8}' -f $k, $p, $r, $d, $dup, $pdup, $kind, $gate, $v, $launch)
}

$classbKeys = @('-Keys', 'AUTOMATION_CLASSB_OUTBOUND_ENABLED,NODE_ENV,MULTITABLE_EMAIL_TRANSPORT,TASKS_ENABLED,RBAC_BYPASS')
$CB = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'

# ---------- Case 1: the #6905 hazard. Line deleted from the file, the value still in the pm2 env. ----------
$j1 = $noise + '[' + (App 'pm2-logrotate' @() @()) + ',' + (App 'metasheet-backend' @('AUTOMATION_CLASSB_OUTBOUND_ENABLED', 'true', 'NODE_ENV', 'production', 'MULTITABLE_EMAIL_TRANSPORT', 'mock', 'BIG_JSON', $big) @('AUTOMATION_CLASSB_OUTBOUND_ENABLED', 'true', 'NODE_ENV', 'production')) + ']' + "`r`n"
$r1 = New-Root 'root1' $j1 $true $null ("NODE_ENV=production`r`n# AUTOMATION_CLASSB_OUTBOUND_ENABLED=true`r`nDATABASE_URL=postgres://SENTINELUSER:SENTINELPW@SENTINELHOST/db`r`n") 0 $false $true
'fixture1 jlist chars=' + $j1.Length + ' (BOM, noise lines, Path+PATH, a value over 2,097,152 chars, Chinese)'
$o1 = Run $script $r1 $homeAlive $classbKeys
Show 'case 1 (#6905 hazard: absent in files, literal-true in pm2)' $o1
Check 'case1' $o1 @(
  'LIVEENV_FILE root=absent docker=found start_script_uses=docker',
  'LIVEENV_PM2 pm2_home_set=true daemon_alive=true daemon_owner_is_current_user=true pm2_cmd=local read=ok app_matches=1',
  (L $CB 'literal-true' 'absent' 'absent' 'none' 'same' 'boolean' 'record' '-'),
  (L 'NODE_ENV' 'literal-production' 'absent' 'literal-production' 'none' 'same' 'enum' 'record' '-'),
  (L 'MULTITABLE_EMAIL_TRANSPORT' 'literal-mock' 'absent' 'absent' 'none' 'none' 'enum' 'record' '-'),
  (L 'TASKS_ENABLED' 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L 'RBAC_BYPASS' 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'nonfalse-stops' 'off'),
  'LIVEENV_GATE on=0 review=0 unknown=0 off=2 record=3',
  'LIVEENV_RESULT keys=5 status=complete') @()
if ((Get-Content -LiteralPath (Join-Path $r1 'node_modules\.bin\invoked.txt') -Raw).Trim() -eq 'jlist') { $pass++ } else { $fail++; '  FAIL case1: pm2 not called with exactly: jlist' }

# ---------- Case 2: both files, dup lines, case variants, env bag only, no BOM ----------
$j2 = '[' + (App 'metasheet-backend' @('TASKS_ENABLED', 'TRUE', 'AUTOMATION_CLASSB_OUTBOUND_ENABLED', 'false', 'RBAC_BYPASS', '') @('tasks_enabled', 'true', 'AUTOMATION_CLASSB_OUTBOUND_ENABLED', 'false')) + ']'
$r2 = New-Root 'root2' $j2 $false ("AUTOMATION_CLASSB_OUTBOUND_ENABLED=false`nTASKS_ENABLED=true`nTASKS_ENABLED=false`n") ("AUTOMATION_CLASSB_OUTBOUND_ENABLED=true`nRBAC_BYPASS=`"`"`n") 0 $false $true
$o2 = Run $script $r2 $homeAlive $classbKeys
Show 'case 2 (both files; root wins for the start script; case variants; =false is literal-false)' $o2
Check 'case2' $o2 @(
  'LIVEENV_FILE root=found docker=found start_script_uses=root',
  (L $CB 'literal-false' 'literal-false' 'literal-true' 'none' 'same' 'boolean' 'record' '-'),
  (L 'TASKS_ENABLED' 'literal-true' 'literal-true' 'absent' 'differs' 'differs' 'boolean' 'true-stops' 'on'),
  (L 'RBAC_BYPASS' 'empty' 'absent' 'empty' 'none' 'none' 'boolean' 'nonfalse-stops' 'on'),
  'LIVEENV_GATE on=2 review=0 unknown=0 off=0 record=3',
  'LIVEENV_RESULT keys=5 status=complete') @()

# ---------- Case 3/4: no daemon -> pm2 must NOT run ----------
$r3 = New-Root 'root3' $j1 $false $null "X=1`n" 0 $false $true
$o3 = Run $script $r3 $homeStale $classbKeys
Show 'case 3 (pm2.pid names no live process)' $o3
Check 'case3' $o3 @(
  'LIVEENV_PM2 pm2_home_set=true daemon_alive=false daemon_owner_is_current_user=false pm2_cmd=local read=skipped app_matches=-',
  (L $CB 'unknown' 'absent' 'absent' 'none' 'none' 'boolean' 'record' '-'),
  (L 'TASKS_ENABLED' 'unknown' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'unknown'),
  'LIVEENV_GATE on=0 review=0 unknown=2 off=0 record=3',
  'LIVEENV_RESULT keys=5 status=incomplete reason=no_daemon') @()
if (-not (Invoked $r3)) { $pass++ } else { $fail++; '  FAIL case3: pm2 was invoked without a daemon' }
$o4 = Run $script $r3 $homeEmpty $classbKeys
Show 'case 4 (no pm2.pid)' $o4
Check 'case4' $o4 @('LIVEENV_RESULT keys=5 status=incomplete reason=no_daemon') @()
if (-not (Invoked $r3)) { $pass++ } else { $fail++; '  FAIL case4: pm2 was invoked without a daemon' }

# ---------- Case 5: pm2 exits 1 ----------
$r5 = New-Root 'root5' $j1 $false $null "X=1`n" 1 $false $true
$o5 = Run $script $r5 $homeAlive $classbKeys
Show 'case 5 (pm2 exit 1)' $o5
Check 'case5' $o5 @('LIVEENV_RESULT keys=5 status=incomplete reason=pm2_failed') @()

# ---------- Case 6: truncated JSON ----------
$r6 = New-Root 'root6' ($j2.Substring(0, 400)) $false $null "X=1`n" 0 $false $true
$o6 = Run $script $r6 $homeAlive $classbKeys
Show 'case 6 (truncated JSON)' $o6
Check 'case6' $o6 @('LIVEENV_RESULT keys=5 status=incomplete reason=parse_failed') @()

# ---------- Case 7: zero / two matching apps; empty list ----------
$r7 = New-Root 'root7' ('[' + (App 'other-app' @() @()) + ']') $false $null "X=1`n" 0 $false $true
$o7 = Run $script $r7 $homeAlive $classbKeys
Show 'case 7a (no metasheet-backend)' $o7
Check 'case7a' $o7 @('LIVEENV_RESULT keys=5 status=incomplete reason=app_count') @()
if ($o7 -match 'app_matches=0') { $pass++ } else { $fail++; '  FAIL case7a: app_matches=0' }
$r7b = New-Root 'root7b' ('[' + (App 'metasheet-backend' @() @()) + ',' + (App 'metasheet-backend' @() @()) + ']') $false $null "X=1`n" 0 $false $true
$o7b = Run $script $r7b $homeAlive $classbKeys
Show 'case 7b (two metasheet-backend)' $o7b
Check 'case7b' $o7b @('LIVEENV_RESULT keys=5 status=incomplete reason=app_count') @()
$r7c = New-Root 'root7c' "[]`r`n" $false $null "X=1`n" 0 $false $true
$o7c = Run $script $r7c $homeAlive $classbKeys
Show 'case 7c (empty list)' $o7c
Check 'case7c' $o7c @('LIVEENV_RESULT keys=5 status=incomplete reason=app_count') @()

# ---------- Case 8: no pm2 anywhere ----------
$r8 = New-Root 'root8' '' $false $null "X=1`n" 0 $false $false
$o8 = Run $script $r8 $homeAlive $classbKeys
Show 'case 8 (no local pm2, none on PATH)' $o8
Check 'case8' $o8 @('LIVEENV_RESULT keys=5 status=incomplete reason=pm2_not_found') @()

# ---------- Case 9-11: arguments ----------
$o9 = Run $script $r2 $homeAlive @('-Keys', 'BAD-KEY')
Show 'case 9 (bad key)' $o9
Check 'case9' $o9 @('LIVEENV_RESULT keys=0 status=incomplete reason=bad_key') @()
$o10 = Run $script $r2 $homeAlive @()
Show 'case 10 (default key list)' $o10
Check 'case10' $o10 @('LIVEENV_RESULT keys=39 status=complete') @()
$keyLines10 = @($o10 | Where-Object { $_ -like 'LIVEENV key=*' })
if ($keyLines10.Count -eq 39) { $pass++ } else { $fail++; ('  FAIL case10: key lines=' + $keyLines10.Count) }
$gl = @($o10 | Where-Object { $_ -like 'LIVEENV_GATE *' })
if ($gl.Count -eq 1 -and $gl[0] -match '^LIVEENV_GATE on=(\d+) review=(\d+) unknown=(\d+) off=(\d+) record=(\d+)$' -and ([int]$matches[1] + [int]$matches[2] + [int]$matches[3] + [int]$matches[4]) -eq 32 -and [int]$matches[5] -eq 7) { $pass++ } else { $fail++; '  FAIL case10: gate sum' }
foreach ($nk in @('INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED kind=boolean', 'INTEGRATION_YIDA_RECONCILE_READ_ENABLED kind=boolean', 'AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED kind=boolean',
    'INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED kind=boolean', 'INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED kind=boolean', 'DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED kind=boolean',
    'INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS kind=list', 'INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS kind=list')) {
  $parts = $nk -split ' '
  $hit = @($keyLines10 | Where-Object { $_ -like ('LIVEENV key=' + $parts[0] + ' *') -and $_ -like ('* ' + $parts[1] + ' *') })
  if ($hit.Count -eq 1) { $pass++ } else { $fail++; ('  FAIL case10: new key line ' + $nk) }
}
$o11 = Run $script (Join-Path $base 'nope') $homeAlive $classbKeys
Show 'case 11 (install root missing)' $o11
Check 'case11' $o11 @('LIVEENV_RESULT keys=5 status=incomplete reason=install_root_not_found') @()

# ---------- Case 12: pm2 hangs ----------
$r12 = New-Root 'root12' $j2 $false $null "X=1`n" 0 $true $true
$o12 = Run $script $r12 $homeAlive ($classbKeys + @('-TimeoutSeconds', '3'))
Show 'case 12 (pm2 hangs, 3 s timeout)' $o12
Check 'case12' $o12 @('LIVEENV_RESULT keys=5 status=incomplete reason=pm2_timeout') @()

# ---------- Case 13: pm2.cmd found on PATH (no local copy): the fake pm2 is put FIRST on PATH ----------
$r13 = New-Root 'root13' '' $false $null "X=1`n" 0 $false $false
$pathDir = Join-Path $base 'pathbin'
New-MockPm2 $pathDir $j2 $false 0 $false
$savedPath = $env:Path
$env:Path = $pathDir + ';' + $savedPath
$o13 = Run $script $r13 $homeAlive $classbKeys
$env:Path = $savedPath
Show 'case 13 (pm2.cmd first on PATH)' $o13
Check 'case13' $o13 @(
  'LIVEENV_PM2 pm2_home_set=true daemon_alive=true daemon_owner_is_current_user=true pm2_cmd=path read=ok app_matches=1',
  (L $CB 'literal-false' 'absent' 'absent' 'none' 'same' 'boolean' 'record' '-'),
  (L 'TASKS_ENABLED' 'literal-true' 'absent' 'absent' 'none' 'differs' 'boolean' 'true-stops' 'on'),
  'LIVEENV_RESULT keys=5 status=complete') @()

# ---------- Case 14: pm2.cmd only in APPDATA\npm (not on PATH): the start script adds that folder first ----------
$appData14 = Join-Path $base 'appdata14'
New-MockPm2 (Join-Path $appData14 'npm') $j2 $false 0 $false
$env:APPDATA = $appData14
$o14 = Run $script $r13 $homeAlive $classbKeys
$env:APPDATA = $emptyAppData
Show 'case 14 (pm2.cmd only in APPDATA\npm)' $o14
Check 'case14' $o14 @(
  'LIVEENV_PM2 pm2_home_set=true daemon_alive=true daemon_owner_is_current_user=true pm2_cmd=path read=ok app_matches=1',
  'LIVEENV_RESULT keys=5 status=complete') @()

# ---------- Case 15: pm2_env parses but carries no environment (canary PATH missing) ----------
$j15 = '[{"pid":1,"name":"metasheet-backend","pm_id":0,"pm2_env":{"status":"online","restart_time":0,"AUTOMATION_CLASSB_OUTBOUND_ENABLED":"true","env":{"NODE_ENV":"production"}}}]'
$r15 = New-Root 'root15' $j15 $false $null "X=1`n" 0 $false $true
$o15 = Run $script $r15 $homeAlive $classbKeys
Show 'case 15 (no PATH in either bag)' $o15
Check 'case15' $o15 @(
  'LIVEENV_PM2 pm2_home_set=true daemon_alive=true daemon_owner_is_current_user=true pm2_cmd=local read=failed app_matches=1',
  (L $CB 'unknown' 'absent' 'absent' 'none' 'none' 'boolean' 'record' '-'),
  'LIVEENV_RESULT keys=5 status=incomplete reason=env_not_visible') @()

# ================= v2 cases =================
$DS = 'DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED'; $RR = 'INTEGRATION_YIDA_RECONCILE_READ_ENABLED'; $SP = 'AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED'
$RA = 'INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED'; $IR = 'INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS'; $UR = 'INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS'
$PP = 'INTEGRATION_CORE_STOCK_PREPARATION_PILOT_PATH'; $PW = 'INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED'; $WB = 'INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED'
$CJ = 'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'
$k16 = @('-Keys', (@($DS, $RR, $SP, $RA, $IR, $UR, $PP, $PW, $WB, 'RBAC_BYPASS', $CJ) -join ','))

# ---------- Case 16a: process column. absent / =false / =true / blank / list with a value / list blank /
#                       path blank / boolean empty / loose true / RBAC_BYPASS=false / json empty ----------
$j16 = '[' + (App 'metasheet-backend' @($RR, 'false', $SP, 'true', $RA, ' ', $IR, 'SENTINELREF1,SENTINELREF2', $UR, ' ', $PP, ' ', $PW, '', $WB, 'TRUE', 'RBAC_BYPASS', 'false', $CJ, '') @()) + ']'
$r16a = New-Root 'root16a' $j16 $false $null "X=1`n" 0 $false $true
$o16a = Run $script $r16a $homeAlive $k16
Show 'case 16a (new states in the process column)' $o16a
Check 'case16a' $o16a @(
  (L $DS 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L $RR 'literal-false' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L $SP 'literal-true' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on'),
  (L $RA 'blank' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'review'),
  (L $IR 'exists' 'absent' 'absent' 'none' 'none' 'list' 'value-stops' 'on'),
  (L $UR 'blank' 'absent' 'absent' 'none' 'none' 'list' 'value-stops' 'off'),
  (L $PP 'blank' 'absent' 'absent' 'none' 'none' 'path' 'value-stops' 'off'),
  (L $PW 'empty' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'review'),
  (L $WB 'loose-true' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'review'),
  (L 'RBAC_BYPASS' 'literal-false' 'absent' 'absent' 'none' 'none' 'boolean' 'nonfalse-stops' 'off'),
  (L $CJ 'empty' 'absent' 'absent' 'none' 'none' 'json' 'value-stops' 'review'),
  'LIVEENV_GATE on=2 review=4 unknown=0 off=5 record=0',
  'LIVEENV_RESULT keys=11 status=complete') @()

# ---------- Case 16b: file columns. KEY=" " and KEY=' ' are blank, KEY= (even with a trailing space) is
#                       empty; a list key =false and a path key with a value stop ----------
$root16b = ($RR + "=false`r`n") + ($SP + "=true`r`n") + ($RA + "=`" `"`r`n") + ($IR + "=SENTINELREF1,SENTINELREF2`r`n") + ($UR + "=`" `"`r`n") + ($PP + "=' '`r`n") + ($PW + "= `r`n") + ($WB + "=TRUE`r`n") + "RBAC_BYPASS=false`r`n" + ($CJ + "=`" `"`r`n")
$docker16b = ($UR + "=false`n") + ($PP + "=C:\SENTINELPILOT\pilot.json`n") + ($DS + "=false`n")
$j16b = '[' + (App 'metasheet-backend' @() @()) + ']'
$r16b = New-Root 'root16b' $j16b $false $root16b $docker16b 0 $false $true
$o16b = Run $script $r16b $homeAlive $k16
Show 'case 16b (new states in the file columns)' $o16b
Check 'case16b' $o16b @(
  'LIVEENV_FILE root=found docker=found start_script_uses=root',
  (L $DS 'absent' 'absent' 'literal-false' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L $RR 'absent' 'literal-false' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L $SP 'absent' 'literal-true' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on'),
  (L $RA 'absent' 'blank' 'absent' 'none' 'none' 'boolean' 'true-stops' 'review'),
  (L $IR 'absent' 'exists' 'absent' 'none' 'none' 'list' 'value-stops' 'on'),
  (L $UR 'absent' 'blank' 'literal-false' 'none' 'none' 'list' 'value-stops' 'on'),
  (L $PP 'absent' 'blank' 'exists' 'none' 'none' 'path' 'value-stops' 'on'),
  (L $PW 'absent' 'empty' 'absent' 'none' 'none' 'boolean' 'true-stops' 'review'),
  (L $WB 'absent' 'loose-true' 'absent' 'none' 'none' 'boolean' 'true-stops' 'review'),
  (L 'RBAC_BYPASS' 'absent' 'literal-false' 'absent' 'none' 'none' 'boolean' 'nonfalse-stops' 'off'),
  (L $CJ 'absent' 'blank' 'absent' 'none' 'none' 'json' 'value-stops' 'off'),
  'LIVEENV_GATE on=4 review=3 unknown=0 off=4 record=0',
  'LIVEENV_RESULT keys=11 status=complete') @()

# ---------- Case 17: divergence (file shows the off form, the process still holds the old value) and
#                     two occurrences in the process (the worst verdict is shown) ----------
$k17 = @('-Keys', (@($SP, $IR, $RA, $UR) -join ','))
$j17 = '[' + (App 'metasheet-backend' @($SP, 'true', $IR, 'SENTINELREF9', $RA, 'false', $UR, ' ') @($RA, ' ', $UR.ToLowerInvariant(), 'SENTINELREF3')) + ']'
$root17 = ($SP + "=false`n") + ($IR + "=`" `"`n") + ($RA + "=false`n") + ($UR + "=`" `"`n")
$r17 = New-Root 'root17' $j17 $false $root17 $null 0 $false $true
$o17 = Run $script $r17 $homeAlive $k17
Show 'case 17 (file off form, process still on; worst of two process occurrences)' $o17
Check 'case17' $o17 @(
  (L $SP 'literal-true' 'literal-false' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on'),
  (L $IR 'exists' 'blank' 'absent' 'none' 'none' 'list' 'value-stops' 'on'),
  (L $RA 'blank' 'literal-false' 'absent' 'none' 'differs' 'boolean' 'true-stops' 'review'),
  (L $UR 'exists' 'blank' 'absent' 'none' 'differs' 'list' 'value-stops' 'on'),
  'LIVEENV_GATE on=3 review=1 unknown=0 off=0 record=0',
  'LIVEENV_RESULT keys=4 status=complete') @()

# ---------- Case 18: the switch-off forms everywhere (what the sheet expects after the start script) ----------
$k18 = @('-Keys', (@($SP, $IR, $UR, $PP, 'RBAC_BYPASS') -join ','))
$j18 = '[' + (App 'metasheet-backend' @($SP, 'false', $IR, ' ', $UR, ' ', $PP, ' ', 'RBAC_BYPASS', 'false') @()) + ']'
$root18 = ($SP + "=false`n") + ($IR + "=`" `"`n") + ($UR + "=`" `"`n") + ($PP + "=`" `"`n") + "RBAC_BYPASS=false`n"
$r18 = New-Root 'root18' $j18 $false $root18 $null 0 $false $true
$o18 = Run $script $r18 $homeAlive $k18
Show 'case 18 (all switched off the documented way)' $o18
Check 'case18' $o18 @(
  (L $SP 'literal-false' 'literal-false' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L $IR 'blank' 'blank' 'absent' 'none' 'none' 'list' 'value-stops' 'off'),
  (L $UR 'blank' 'blank' 'absent' 'none' 'none' 'list' 'value-stops' 'off'),
  (L $PP 'blank' 'blank' 'absent' 'none' 'none' 'path' 'value-stops' 'off'),
  (L 'RBAC_BYPASS' 'literal-false' 'literal-false' 'absent' 'none' 'none' 'boolean' 'nonfalse-stops' 'off'),
  'LIVEENV_GATE on=0 review=0 unknown=0 off=5 record=0',
  'LIVEENV_RESULT keys=5 status=complete') @()

# ---------- Case 19: a -Keys name that is not in the built-in table ----------
$j19 = '[' + (App 'metasheet-backend' @('SOME_OTHER_FLAG', 'SENTINELX') @()) + ']'
$r19 = New-Root 'root19' $j19 $false $null "X=1`n" 0 $false $true
$o19 = Run $script $r19 $homeAlive @('-Keys', 'SOME_OTHER_FLAG,ANOTHER_ABSENT_FLAG')
Show 'case 19 (unlisted keys)' $o19
Check 'case19' $o19 @(
  (L 'SOME_OTHER_FLAG' 'exists' 'absent' 'absent' 'none' 'none' 'unlisted' 'unlisted' 'review'),
  (L 'ANOTHER_ABSENT_FLAG' 'absent' 'absent' 'absent' 'none' 'none' 'unlisted' 'unlisted' 'off'),
  'LIVEENV_GATE on=0 review=1 unknown=0 off=1 record=0',
  'LIVEENV_RESULT keys=2 status=complete') @()

# ---------- Case 20 (F1): several lines for one key in ONE file. apply-package and the start script let
#                     the last line win, the ecosystem loader lets the first line win (docker\app.env),
#                     so the file column must show the worst line, never just the last one ----------
$k20 = @('-Keys', (@($SP, $IR, $RA, $DS, $CB) -join ','))
$j20 = '[' + (App 'metasheet-backend' @() @()) + ']'
$root20 = ($DS + "=false`r`n") + ($DS + "=false`r`n")
$docker20 = ($SP + "=true`r`n") + ($SP + "=false`r`n") + ($IR + "=SENTINELREF5`r`n") + ($IR + "=`" `"`r`n") + ($RA + "=`" `"`r`n") + ($RA + "=false`r`n") + ($CB + "=true`r`n") + ($CB + "=false`r`n")
$r20 = New-Root 'root20' $j20 $false $root20 $docker20 0 $false $true
$o20 = Run $script $r20 $homeAlive $k20
Show 'case 20 (F1: docker KEY=true then KEY=false, and other duplicate lines)' $o20
Check 'case20' $o20 @(
  'LIVEENV_FILE root=found docker=found start_script_uses=root',
  'LIVEENV_DBURL relation=docker_absent',
  (L $SP 'absent' 'absent' 'literal-true' 'differs' 'none' 'boolean' 'true-stops' 'on'),
  (L $IR 'absent' 'absent' 'exists' 'differs' 'none' 'list' 'value-stops' 'on'),
  (L $RA 'absent' 'absent' 'blank' 'differs' 'none' 'boolean' 'true-stops' 'review'),
  (L $DS 'absent' 'literal-false' 'absent' 'same' 'none' 'boolean' 'true-stops' 'off'),
  (L $CB 'absent' 'absent' 'literal-true' 'differs' 'none' 'boolean' 'record' '-'),
  'LIVEENV_GATE on=2 review=1 unknown=0 off=1 record=1',
  'LIVEENV_RESULT keys=5 status=complete') @()
# the judge's exact case, stated as the rule: the docker true-then-false key is not off
$sp20 = @($o20 | Where-Object { $_ -like ('LIVEENV key=' + $SP + ' *') })
if ($sp20.Count -eq 1 -and $sp20[0] -notlike '* verdict=off') { $pass++ } else { $fail++; '  FAIL case20: docker KEY=true then KEY=false gave verdict=off' }

# ---------- Case 21: LIVEENV_DBURL (root app.env vs docker\app.env DATABASE_URL, compared in memory) ----------
$k21 = @('-Keys', 'TASKS_ENABLED')
$j21 = '[' + (App 'metasheet-backend' @() @()) + ']'
$UA = 'DATABASE_URL=postgres://SENTINELUSER:SENTINELPW@SENTINELHOST/db'
$UAq = 'DATABASE_URL="postgres://SENTINELUSER:SENTINELPW@SENTINELHOST/db"'
$UB = 'DATABASE_URL=postgres://SENTINELUSER:SENTINELPW@SENTINELHOST/db2'
$UC = 'DATABASE_URL=postgres://SENTINELUSER:SENTINELpw@SENTINELHOST/db'
$T21off = (L 'TASKS_ENABLED' 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off')
$G21pass = 'LIVEENV_GATE on=0 review=0 unknown=0 off=1 record=0'
$G21stop = 'LIVEENV_GATE on=0 review=1 unknown=0 off=1 record=0'
$G21stop2 = 'LIVEENV_GATE on=0 review=2 unknown=0 off=1 record=0'
# The pm2 env of $j21 holds DATABASE_URL at the top level with the value of $UA (App's default), so the
# process word follows from the docker file: same when docker holds only that value, differs when it holds
# another one too, unknown when docker has no line. Every row was worked out by hand before the run.
# name, root file, docker file, expected relation, expected process word, expected gate line
$c21 = @(
  @('21a same (quoted in docker, plain in root)', ($UA + "`r`nX=1`r`n"), ("X=1`r`n" + $UAq + "`r`n"), 'same', 'same', $G21pass),
  @('21b differs (another database)', ($UA + "`r`n"), ($UB + "`r`n"), 'differs', 'differs', $G21stop2),
  @('21c differs only in case', ($UA + "`r`n"), ($UC + "`r`n"), 'differs', 'differs', $G21stop2),
  @('21d differs inside docker (first line differs, last line equal)', ($UA + "`r`n"), ($UB + "`r`n" + $UA + "`r`n"), 'differs', 'differs', $G21stop2),
  @('21e root file absent', $null, ($UA + "`r`n"), 'root_absent', 'same', $G21pass),
  @('21f root file without DATABASE_URL', "X=1`r`n", ($UA + "`r`n"), 'root_absent', 'same', $G21pass),
  @('21g docker file absent', ($UA + "`r`n"), $null, 'docker_absent', 'unknown', $G21pass),
  @('21h docker file without DATABASE_URL', ($UA + "`r`n"), "X=1`r`n", 'docker_absent', 'unknown', $G21pass),
  @('21i neither file has DATABASE_URL', "X=1`r`n", "X=1`r`n", 'docker_absent', 'unknown', $G21pass),
  @('21j empty value in root, value in docker', "DATABASE_URL=`r`n", ($UA + "`r`n"), 'differs', 'same', $G21stop),
  @('21k same value twice in each file', ($UA + "`r`n" + $UA + "`r`n"), ($UAq + "`r`n" + $UA + "`r`n"), 'same', 'same', $G21pass),
  @('21o docker A,B and a root file without DATABASE_URL', "X=1`r`n", ($UA + "`r`n" + $UB + "`r`n"), 'differs', 'differs', $G21stop2),
  @('21p docker A,B and no root file', $null, ($UA + "`r`n" + $UB + "`r`n"), 'differs', 'differs', $G21stop2),
  @('21q root A,B and a docker file without DATABASE_URL', ($UA + "`r`n" + $UB + "`r`n"), "X=1`r`n", 'differs', 'unknown', $G21stop)
)
$r21 = @{}
foreach ($c in $c21) {
  $id = ($c[0] -split ' ')[0]
  $root21 = New-Root ('root' + $id) $j21 $false $c[1] $c[2] 0 $false $true
  $r21[$id] = $root21
  $o = Run $script $root21 $homeAlive $k21
  Show ('case ' + $c[0]) $o
  Check ('case' + $id) $o @(('LIVEENV_DBURL relation=' + $c[3]), ('LIVEENV_DBURL_PROCESS process=' + $c[4]), $T21off, $c[5], 'LIVEENV_RESULT keys=1 status=complete') @()
  # the line comes right after LIVEENV_FILE
  $fi = [array]::IndexOf([string[]]$o, ('LIVEENV_DBURL relation=' + $c[3]))
  if ($fi -ge 1 -and $o[$fi - 1] -like 'LIVEENV_FILE *') { $pass++ } else { $fail++; ('  FAIL case' + $id + ': LIVEENV_DBURL not right after LIVEENV_FILE') }
  # the process line comes right after LIVEENV_PM2, exactly once
  $pi = [array]::IndexOf([string[]]$o, ('LIVEENV_DBURL_PROCESS process=' + $c[4]))
  if ($pi -ge 1 -and $o[$pi - 1] -like 'LIVEENV_PM2 *' -and @($o | Where-Object { $_ -like 'LIVEENV_DBURL_PROCESS *' }).Count -eq 1) { $pass++ } else { $fail++; ('  FAIL case' + $id + ': LIVEENV_DBURL_PROCESS not once, right after LIVEENV_PM2') }
}
# printed on an incomplete read too (no daemon): the relation is a file fact; the process word is unknown
$o21n = Run $script $r21['21b'] $homeStale $k21
Show 'case 21n (differs, no daemon)' $o21n
Check 'case21n' $o21n @('LIVEENV_DBURL relation=differs', 'LIVEENV_DBURL_PROCESS process=unknown', 'LIVEENV_GATE on=0 review=1 unknown=1 off=0 record=0', 'LIVEENV_RESULT keys=1 status=incomplete reason=no_daemon') @()

# ---------- Case 22: LIVEENV_DBURL_PROCESS (pm2 env DATABASE_URL vs docker\app.env's, compared in memory) ----------
$PA = 'postgres://SENTINELUSER:SENTINELPW@SENTINELHOST/db'
$PB = 'postgres://SENTINELUSER:SENTINELPW@SENTINELHOST/db2'
$PC = 'postgres://SENTINELUSER:SENTINELpw@SENTINELHOST/db'
# name, jlist, root file, docker file, expected relation, expected process word, expected gate line
$c22 = @(
  @('22a same, held in both pm2_env bags', ('[' + (App 'metasheet-backend' @() @('DATABASE_URL', $PA) $PA) + ']'), $null, ($UAq + "`r`n"), 'root_absent', 'same', $G21pass),
  @('22b differs: root without the key, pm2 keeps another database (the judge scenario)', ('[' + (App 'metasheet-backend' @() @() $PA) + ']'), "X=1`r`n", ($UB + "`r`n"), 'root_absent', 'differs', $G21stop),
  @('22c differs only in case', ('[' + (App 'metasheet-backend' @() @() $PC) + ']'), $null, ($UA + "`r`n"), 'root_absent', 'differs', $G21stop),
  @('22d differs in the env bag only', ('[' + (App 'metasheet-backend' @() @('DATABASE_URL', $PB) $PA) + ']'), $null, ($UA + "`r`n"), 'root_absent', 'differs', $G21stop),
  @('22e differs under a lower-case key name', ('[' + (App 'metasheet-backend' @() @('database_url', $PB) $PA) + ']'), $null, ($UA + "`r`n"), 'root_absent', 'differs', $G21stop),
  @('22f no DATABASE_URL in the process env', ('[' + (App 'metasheet-backend' @() @() $null) + ']'), $null, ($UA + "`r`n"), 'root_absent', 'absent', $G21pass),
  @('22g docker file without DATABASE_URL', ('[' + (App 'metasheet-backend' @() @() $PA) + ']'), ($UA + "`r`n"), "X=1`r`n", 'docker_absent', 'unknown', $G21pass),
  @('22h files agree, process holds another database', ('[' + (App 'metasheet-backend' @() @() $PB) + ']'), ($UA + "`r`n"), ($UA + "`r`n"), 'same', 'differs', $G21stop)
)
$r22 = @{}
foreach ($c in $c22) {
  $id = ($c[0] -split ' ')[0]
  $root22 = New-Root ('root' + $id) $c[1] $false $c[2] $c[3] 0 $false $true
  $r22[$id] = $root22
  $o = Run $script $root22 $homeAlive $k21
  Show ('case ' + $c[0]) $o
  Check ('case' + $id) $o @(('LIVEENV_DBURL relation=' + $c[4]), ('LIVEENV_DBURL_PROCESS process=' + $c[5]), $T21off, $c[6], 'LIVEENV_RESULT keys=1 status=complete') @()
  $pi = [array]::IndexOf([string[]]$o, ('LIVEENV_DBURL_PROCESS process=' + $c[5]))
  if ($pi -ge 1 -and $o[$pi - 1] -like 'LIVEENV_PM2 *' -and @($o | Where-Object { $_ -like 'LIVEENV_DBURL_PROCESS *' }).Count -eq 1) { $pass++ } else { $fail++; ('  FAIL case' + $id + ': LIVEENV_DBURL_PROCESS not once, right after LIVEENV_PM2') }
}
# no daemon: the process env is not read, so unknown (not absent), and pm2 is not invoked
Remove-Item -LiteralPath (Join-Path $r22['22b'] 'node_modules\.bin\invoked.txt') -ErrorAction SilentlyContinue
$o22n = Run $script $r22['22b'] $homeStale $k21
Show 'case 22n (process differs, no daemon)' $o22n
Check 'case22n' $o22n @('LIVEENV_DBURL relation=root_absent', 'LIVEENV_DBURL_PROCESS process=unknown', 'LIVEENV_GATE on=0 review=0 unknown=1 off=0 record=0', 'LIVEENV_RESULT keys=1 status=incomplete reason=no_daemon') @()
if (-not (Invoked $r22['22b'])) { $pass++ } else { $fail++; '  FAIL case22n: pm2 was invoked without a daemon' }

# Case 23: the default list includes all new keys, and their gates distinguish runtime-active values.
$activationKey = 'DELEGATED_SCOPE_ACTIVATION_ENABLED'
$maxAgeKey = 'EXTERNAL_LOGIN_STRICT_SESSION_MAX_AGE_SECONDS'
$revocationKey = 'DIRECTORY_DEPROVISION_REVOKE_CREDENTIALS_ENABLED'
$keys23 = @('-Keys', ($activationKey, $maxAgeKey, $revocationKey -join ','))
Check 'case10-new-defaults' $o10 @(
  (L $activationKey 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L $maxAgeKey 'absent' 'absent' 'absent' 'none' 'none' 'numeric' 'numeric-stops' 'off'),
  (L $revocationKey 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off'),
  (L 'INTEGRATION_YIDA_SHEET_SOURCE_ENABLED' 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off')
) @()
foreach ($numeric in @(
  @('300', 'valid-integer', 'on'), @('2592000', 'valid-integer', 'on'),
  @('299', 'exists', 'review'), @('2592001', 'exists', 'review'),
  @('0300', 'exists', 'review'), @('3e2', 'exists', 'review'), @('false', 'literal-false', 'review'),
  @(' ', 'blank', 'review'), @('9223372036854775808', 'exists', 'review')
)) {
  $jlist = '[' + (App 'metasheet-backend' @($maxAgeKey, $numeric[0]) @($revocationKey, 'true')) + ']'
  $root23 = New-Root ('root23-' + [guid]::NewGuid().ToString('N')) $jlist $false "$activationKey=true" $null 0 $false $true
  $o = Run $script $root23 $homeAlive $keys23
  Check 'case23' $o @(
    (L $activationKey 'absent' 'literal-true' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on'),
    (L $maxAgeKey $numeric[1] 'absent' 'absent' 'none' 'none' 'numeric' 'numeric-stops' $numeric[2]),
    (L $revocationKey 'literal-true' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on')
  ) @()
}

$sheetSourceKey = 'INTEGRATION_YIDA_SHEET_SOURCE_ENABLED'
$sheetSourceOn = '[' + (App 'metasheet-backend' @() @($sheetSourceKey, 'true')) + ']'
$root24 = New-Root 'root24' $sheetSourceOn $false $null $null 0 $false $true
$o24 = Run $script $root24 $homeAlive @('-Keys', $sheetSourceKey)
Check 'case24-sheet-source-after-file-removal' $o24 @(
  (L $sheetSourceKey 'literal-true' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on'),
  'LIVEENV_GATE on=1 review=0 unknown=0 off=0 record=0'
) @()

# The running backend and both files are clear; only the launch environment is on.
$shellKey = 'INTEGRATION_YIDA_CONNECTION_TEST_ENABLED'
$previous = [Environment]::GetEnvironmentVariable($shellKey, 'Process')
try {
  [Environment]::SetEnvironmentVariable($shellKey, 'true', 'Process')
  $o25 = Run $script $r2 $homeAlive @('-Keys', $shellKey)
  Check 'case25-launch-only' $o25 @(
    (L $shellKey 'absent' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on' 'literal-true'),
    'LIVEENV_GATE on=1 review=0 unknown=0 off=0 record=0'
  ) @()
} finally { [Environment]::SetEnvironmentVariable($shellKey, $previous, 'Process') }

# Use the harness's real, synthetic Node process with canned PM2 metadata.
$genRoot = Join-Path $base 'generation'
$genExec = Join-Path $genRoot 'packages\core-backend\dist\src\index.js'
$genJson = '[{"name":"metasheet-backend","pid":' + $dummy.Id +
  ',"pm2_env":{"PATH":"fixture","status":"online","pm_exec_path":' + (J $genExec) + '}}]'
$null = New-Root 'generation' $genJson $false $null $null 0 $false $true
New-Item -ItemType Directory -Path (Split-Path -Parent $genExec) -Force | Out-Null
[IO.File]::WriteAllText($genExec, '// fixture')
foreach ($case in @(@('fresh', $dummy.StartTime.AddSeconds(-1), 0), @('stale', [DateTime]::UtcNow, 2))) {
  $cutoff = ([DateTimeOffset]$case[1]).ToUniversalTime().ToString('o')
  $o26 = Run $script $genRoot $homeAlive @('-Keys', $shellKey, '-StartedAfterUtc', $cutoff)
  $exit26 = $script:lastExit
  Check ('case26-' + $case[0]) $o26 @('LIVEENV_BACKEND generation=' + $case[0]) @()
  if ($exit26 -eq $case[2]) { $pass++ } else { $fail++; '  FAIL case26: wrong generation exit' }
}

# ---------- Mutants: each must turn a case red ----------
# GroupOk = the checks a mutant must break. The baseline below proves the unmutated tool passes each one,
# so a KILLED verdict means the mutation broke it, not that the expected line was stale.
function GroupOk([string]$scriptUnderTest, [string]$g) {
  switch ($g) {
    'r1' {
      $o = Run $scriptUnderTest $r1 $homeAlive $classbKeys
      return (($o -contains (L $CB 'literal-true' 'absent' 'absent' 'none' 'same' 'boolean' 'record' '-')) -and ($o -contains 'LIVEENV_RESULT keys=5 status=complete'))
    }
    'r2' {
      $o = Run $scriptUnderTest $r2 $homeAlive $classbKeys
      return ($o -contains (L 'TASKS_ENABLED' 'literal-true' 'literal-true' 'absent' 'differs' 'differs' 'boolean' 'true-stops' 'on'))
    }
    'r15' {
      $o = Run $scriptUnderTest $r15 $homeAlive $classbKeys
      return ($o -contains 'LIVEENV_RESULT keys=5 status=incomplete reason=env_not_visible')
    }
    'r14' {
      $env:APPDATA = $appData14
      $o = Run $scriptUnderTest $r13 $homeAlive $classbKeys
      $env:APPDATA = $emptyAppData
      return ($o -contains 'LIVEENV_RESULT keys=5 status=complete')
    }
    'r3' {
      Remove-Item -LiteralPath (Join-Path $r3 'node_modules\.bin\invoked.txt') -ErrorAction SilentlyContinue
      $o = Run $scriptUnderTest $r3 $homeStale $classbKeys
      return ((-not (Invoked $r3)) -and ($o -contains 'LIVEENV_RESULT keys=5 status=incomplete reason=no_daemon'))
    }
    'r16a' {
      $o = Run $scriptUnderTest $r16a $homeAlive $k16
      return (($o -contains (L $UR 'blank' 'absent' 'absent' 'none' 'none' 'list' 'value-stops' 'off')) -and
        ($o -contains (L $RR 'literal-false' 'absent' 'absent' 'none' 'none' 'boolean' 'true-stops' 'off')) -and
        ($o -contains 'LIVEENV_GATE on=2 review=4 unknown=0 off=5 record=0'))
    }
    'r17' {
      $o = Run $scriptUnderTest $r17 $homeAlive $k17
      return (($o -contains (L $SP 'literal-true' 'literal-false' 'absent' 'none' 'none' 'boolean' 'true-stops' 'on')) -and
        ($o -contains (L $RA 'blank' 'literal-false' 'absent' 'none' 'differs' 'boolean' 'true-stops' 'review')))
    }
    'r18' {
      $o = Run $scriptUnderTest $r18 $homeAlive $k18
      return ($o -contains 'LIVEENV_GATE on=0 review=0 unknown=0 off=5 record=0')
    }
    'r20' {
      $o = Run $scriptUnderTest $r20 $homeAlive $k20
      return (($o -contains (L $SP 'absent' 'absent' 'literal-true' 'differs' 'none' 'boolean' 'true-stops' 'on')) -and
        ($o -contains (L $IR 'absent' 'absent' 'exists' 'differs' 'none' 'list' 'value-stops' 'on')) -and
        ($o -contains 'LIVEENV_GATE on=2 review=1 unknown=0 off=1 record=1'))
    }
    'r21b' {
      $o = Run $scriptUnderTest $r21['21b'] $homeAlive $k21
      return (($o -contains 'LIVEENV_DBURL relation=differs') -and ($o -contains $G21stop2))
    }
    'r21o' {
      $o = Run $scriptUnderTest $r21['21o'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL relation=differs')
    }
    'r21p' {
      $o = Run $scriptUnderTest $r21['21p'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL relation=differs')
    }
    'r21q' {
      $o = Run $scriptUnderTest $r21['21q'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL relation=differs')
    }
    'r22b' {
      $o = Run $scriptUnderTest $r22['22b'] $homeAlive $k21
      return (($o -contains 'LIVEENV_DBURL_PROCESS process=differs') -and ($o -contains $G21stop))
    }
    'r22c' {
      $o = Run $scriptUnderTest $r22['22c'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL_PROCESS process=differs')
    }
    'r22d' {
      $o = Run $scriptUnderTest $r22['22d'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL_PROCESS process=differs')
    }
    'r22e' {
      $o = Run $scriptUnderTest $r22['22e'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL_PROCESS process=differs')
    }
    'r22f' {
      $o = Run $scriptUnderTest $r22['22f'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL_PROCESS process=absent')
    }
    'r22g' {
      $o = Run $scriptUnderTest $r22['22g'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL_PROCESS process=unknown')
    }
    'r22n' {
      $o = Run $scriptUnderTest $r22['22b'] $homeStale $k21
      return ($o -contains 'LIVEENV_DBURL_PROCESS process=unknown')
    }
    'r21c' {
      $o = Run $scriptUnderTest $r21['21c'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL relation=differs')
    }
    'r21d' {
      $o = Run $scriptUnderTest $r21['21d'] $homeAlive $k21
      return ($o -contains 'LIVEENV_DBURL relation=differs')
    }
  }
  return $false
}

if ($Mutants) {
  $src = [System.IO.File]::ReadAllText($script)
  $oldEarly = '  if ($null -eq $dockerFile -or -not $dockerFile.ContainsKey($dk)) { return ''docker_absent'' }' + "`n" +
    '  if ($null -eq $rootFile -or -not $rootFile.ContainsKey($dk)) { return ''root_absent'' }' + "`n" +
    '  $cmp = [System.StringComparer]::Ordinal'
  $mut = @(
    @('M1 ignore the pm2_env.env bag', '$bags += , $pm2Env[''env'']', '$null = 0', 'r2'),
    @('M2 case-sensitive key match', '[string]::Equals([string]$bk, $name, [System.StringComparison]::OrdinalIgnoreCase)', '[string]::Equals([string]$bk, $name, [System.StringComparison]::Ordinal)', 'r2'),
    @('M3 ConvertFrom-Json instead of JavaScriptSerializer', '$parsed = $ser.DeserializeObject($text.Substring($m.Index, $end - $m.Index + 1))', '$parsed = ($text.Substring($m.Index, $end - $m.Index + 1) | ConvertFrom-Json)', 'r1'),
    @('M4 no daemon guard', 'if (-not $daemonAlive) { $resultLine = ''no_daemon'' }', 'if ($false) { }', 'r3'),
    @('M5 files only (old method)', 'if ($readState -eq ''ok'') {', 'if ($false) {', 'r1'),
    @('M6 no PATH canary', 'if ($visible) { $pm2Env = $cand', 'if ($true) { $pm2Env = $cand', 'r15'),
    @('M7 no start-script folders', 'if (-not $present) { $pathEntries.Insert(0, $cand) }', '$null = $present', 'r14'),
    @('M8 no blank state (R85 behaviour)', 'if ($s.Trim().Length -eq 0) { return ''blank'' }', '$null = 0', 'r16a'),
    @('M9 no literal-false state (R85 behaviour)', 'if ($s -ceq ''false'') { return ''literal-false'' }', '$null = 0', 'r16a'),
    @('M10 kind lookup broken', 'OrdinalIgnoreCase)) { return $Spec[$k] }', 'OrdinalIgnoreCase)) { $null = $k }', 'r16a'),
    @('M11 last column wins instead of worst', 'if ($VRank[$b] -gt $VRank[$a]) { return $b } return $a', 'return $b', 'r17'),
    @('M12 process occurrence by rank only', 'if ($vf -gt $vp -or ($vf -eq $vp -and $Rank[$f] -gt $Rank[$pstate])) { $pstate = $f }', 'if ($Rank[$f] -gt $Rank[$pstate]) { $pstate = $f }', 'r17'),
    @('M13 blank list/path still stops (R85 any-value rule)', 'if ($state -eq ''absent'' -or $state -eq ''blank'') { return ''off'' }', 'if ($state -eq ''absent'') { return ''off'' }', 'r18'),
    @('M14 file column takes the last line (pre-F1 behaviour)', 'if ($vf -gt $vp -or ($vf -eq $vp -and $Rank[$f] -gt $Rank[$fs])) { $fs = $f }', '$fs = $fstates[$fstates.Count - 1]', 'r20'),
    @('M15 DBURL relation never differs', 'if ($n -eq 1) { return ''same'' }', 'return ''same''', 'r21b'),
    @('M16 DBURL differs not counted in the gate', 'if ($dbRel -eq ''differs'') { $gateCount[''review''] += 1 }', '$null = 0', 'r21b'),
    @('M17 DBURL compared case-insensitively', '$cmp = [System.StringComparer]::Ordinal', '$cmp = [System.StringComparer]::OrdinalIgnoreCase', 'r21c'),
    @('M18 DBURL compares only the last line of each file', 'foreach ($dv in @($fm[$dk])) {', 'foreach ($dv in @(@($fm[$dk])[-1])) {', 'r21d'),
    @('M19a DBURL early returns put back (docker A,B, root without line)', '  $cmp = [System.StringComparer]::Ordinal', $oldEarly, 'r21o'),
    @('M19b DBURL early returns put back (docker A,B, no root file)', '  $cmp = [System.StringComparer]::Ordinal', $oldEarly, 'r21p'),
    @('M19c DBURL early returns put back (root A,B, docker without line)', '  $cmp = [System.StringComparer]::Ordinal', $oldEarly, 'r21q'),
    @('M20 process never differs', 'if ($pall -eq 1) { return ''same'' }', 'return ''same''', 'r22b'),
    @('M21 process differs not counted in the gate', 'if ($dbProc -eq ''differs'') { $gateCount[''review''] += 1 }', '$null = 0', 'r22b'),
    @('M22 process compare reads the top-level bag only', 'foreach ($bag in @($envBags)) {', 'foreach ($bag in @(@($envBags)[0])) {', 'r22d'),
    @('M23 process compared case-insensitively', '$pcmp = [System.StringComparer]::Ordinal', '$pcmp = [System.StringComparer]::OrdinalIgnoreCase', 'r22c'),
    @('M24 process key name matched case-sensitively', '[string]::Equals([string]$bk, $dk, [System.StringComparison]::OrdinalIgnoreCase)', '[string]::Equals([string]$bk, $dk, [System.StringComparison]::Ordinal)', 'r22e'),
    @('M25 process unknown guard removed (unread env reads as absent)', 'if ($pm2Read -ne ''ok'') { return ''unknown'' }', 'if ($false) { }', 'r22n'),
    @('M26 process absent word removed', 'if ($pn -eq 0) { return ''absent'' }', 'if ($false) { }', 'r22f'),
    @('M27 process unknown on a docker file without the line removed', 'if ($dn -eq 0) { return ''unknown'' }', 'if ($false) { }', 'r22g')
  )
  # baseline: the unmutated tool must pass every group a mutant is judged by
  foreach ($g in @($mut | ForEach-Object { $_[3] } | Select-Object -Unique)) {
    if (GroupOk $script $g) { $pass++; ('BASELINE ' + $g + ' ok') } else { $fail++; ('  FAIL BASELINE ' + $g + ': the unmutated tool fails this mutant check') }
  }
  foreach ($m in $mut) {
    $n = ([regex]::Matches($src, [regex]::Escape($m[1]))).Count
    if ($n -ne 1) { ('MUTANT ' + $m[0] + ' anchor_count=' + $n + ' (not applied)'); $fail++; continue }
    $mp = Join-Path $base ('mutant-' + [guid]::NewGuid().ToString('N') + '.ps1')
    [System.IO.File]::WriteAllText($mp, $src.Replace($m[1], $m[2]), $utf8)
    $ok = GroupOk $mp $m[3]
    $verdict = if ($ok) { 'SURVIVED' } else { 'KILLED' }
    ('MUTANT ' + $m[0] + ' -> ' + $verdict)
    if ($ok) { $fail++ } else { $pass++ }
  }
}

try { Stop-Process -Id $dummy.Id -Force } catch { }
Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
'LEFTOVER base_exists=' + (Test-Path -LiteralPath $base)
'LIVEENV_TEST pass=' + $pass + ' fail=' + $fail
if ($fail -gt 0) { exit 1 }
