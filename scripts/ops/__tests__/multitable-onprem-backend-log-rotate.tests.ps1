#requires -Version 5.1
# Behaviour + static tests for scripts/ops/multitable-onprem-backend-log-rotate.ps1.
# Runs under Windows PowerShell 5.1 and pwsh 7 (Windows or Linux). Hermetic: no pm2, no real
# scheduled task, no network. The script is dot-sourced (its last lines return before Invoke-Main
# when dot-sourced) so pm2 / schtasks / the pipe probe / the ScheduledTasks cmdlets can be replaced
# by functions in the calling scope. Exit 1 on any failure.
param(
  [string]$ScriptUnderTest = '',
  [string]$WorkRoot = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') '..'))
if (-not $ScriptUnderTest) { $ScriptUnderTest = Join-Path (Join-Path $repoRoot 'scripts') (Join-Path 'ops' 'multitable-onprem-backend-log-rotate.ps1') }
if (-not $WorkRoot) { $WorkRoot = [System.IO.Path]::GetTempPath() }
$isWin = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
$pass = 0
$fail = 0

function Check([string]$Name, [bool]$Ok) {
  if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" } else { $script:fail++; Write-Host "  FAIL  $Name" }
}

function New-Lab([hashtable]$Live) {
  $root = Join-Path $WorkRoot ('logrot-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $logs = Join-Path (Join-Path $root 'output') 'logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'pm2home') | Out-Null
  foreach ($name in $Live.Keys) {
    $bytes = New-Object byte[] ([int]$Live[$name])
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [byte](65 + ($i % 26)) }
    [System.IO.File]::WriteAllBytes((Join-Path $logs $name), $bytes)
  }
  return [pscustomobject]@{ Root = $root; Logs = $logs; Archive = (Join-Path $logs 'archive'); Pm2Home = (Join-Path $root 'pm2home') }
}

function Get-Sha([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($Path))) } finally { $sha.Dispose() }
}

# Dot-sources the script with $Params in a fresh scope, applies $Overrides (dot-sourced, so the
# functions it defines shadow the script's), runs Invoke-Main. Returns Code, Out, and $calls.
function Invoke-Rotate([hashtable]$Params, [scriptblock]$Overrides) {
  $calls = New-Object System.Collections.ArrayList
  $lines = & {
    . $ScriptUnderTest @Params
    if ($Overrides) { . $Overrides }
    try { $code = Invoke-Main } catch { Write-Host ('THREW: ' + $_.Exception.Message); $code = -99 }
    'EXIT=' + $code
  } 6>&1 | ForEach-Object { [string]$_ }
  $exitLine = @($lines | Where-Object { $_ -like 'EXIT=*' } | Select-Object -Last 1)
  $code = -1
  if ($exitLine.Count -eq 1) { $code = [int]$exitLine[0].Substring(5) }
  return [pscustomobject]@{ Code = $code; Out = ($lines -join "`n"); Calls = $calls }
}

$mb = 1024 * 1024

Write-Host '== static'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptUnderTest, [ref]$tokens, [ref]$errors)
Check 'script parses' ($errors.Count -eq 0)
$ps7Only = @($ast.FindAll({ param($n) $n.GetType().Name -in @('TernaryExpressionAst', 'PipelineChainAst') -or ($n -is [System.Management.Automation.Language.BinaryExpressionAst] -and [string]$n.Operator -eq 'QuestionQuestion') -or ($n -is [System.Management.Automation.Language.AssignmentStatementAst] -and [string]$n.Operator -eq 'QuestionQuestionEquals') }, $true))
Check 'no PowerShell 7-only syntax (ternary, && / ||, ??, ??=)' ($ps7Only.Count -eq 0)
$raw = [System.IO.File]::ReadAllBytes($ScriptUnderTest)
Check 'script is ASCII-only with LF line endings' (@($raw | Where-Object { $_ -gt 127 -or $_ -eq 13 }).Count -eq 0)
$workflow = [System.IO.File]::ReadAllText((Join-Path $repoRoot '.github/workflows/plugin-tests.yml'))
# A `shell: pwsh` step only fails on the LAST command's exit code, so the run line must be
# followed by its own exit check (or be the step's last command).
Check 'wired into the plugin-tests pwsh step, with its own exit check' ($workflow -match '(?m)^ +\./scripts/ops/__tests__/multitable-onprem-backend-log-rotate\.tests\.ps1\r?\n +if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}\r?$')

Write-Host '== dry run changes nothing'
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb; 'metasheet-backend.err-0.log' = 2 * $mb }
$before = Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Pm2Command = 'Stub-Pm2' } {
  function Test-Pm2PipePresent { $true }
  function Stub-Pm2 { [void]$calls.Add('pm2'); $global:LASTEXITCODE = 0 }
}
Check 'dry run exits 0' ($r.Code -eq 0)
Check 'dry run prints the plan for both streams' (($r.Out -match '\[dry-run\] would Rename metasheet-backend\.out-0\.log') -and ($r.Out -match '\[dry-run\] would Rename metasheet-backend\.err-0\.log'))
Check 'dry run does not create the archive dir or touch the live file' ((-not (Test-Path $lab.Archive)) -and ((Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')) -eq $before))
Check 'dry run never calls pm2' ($r.Calls.Count -eq 0)
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; DryRun = $true; Apply = $true } $null
Check '-DryRun with -Apply is a usage error (2)' ($r.Code -eq 2)
New-Item -ItemType Directory -Force -Path $lab.Archive | Out-Null
for ($d = 1; $d -le 4; $d++) { Set-Content -LiteralPath (Join-Path $lab.Archive ('metasheet-backend.out-0.2026090{0}-033000.log' -f $d)) -Value 'old' }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Keep = 2 } { function Test-Pm2PipePresent { $true } }
Check 'dry run with archives beyond -Keep lists them and deletes nothing' ($r.Code -eq 0 -and $r.Out -match '\[dry-run\] would prune metasheet-backend\.out-0\.20260901-033000\.log' -and $r.Out -match '\[dry-run\] would prune metasheet-backend\.out-0\.20260902-033000\.log' -and @(Get-ChildItem -LiteralPath $lab.Archive).Count -eq 4)

Write-Host '== -Apply -Mode CopyTruncate rotates and prunes to -Keep'
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb; 'metasheet-backend.err-0.log' = 2 * $mb; 'metasheet-backend.out.log' = 2 * $mb }
New-Item -ItemType Directory -Force -Path $lab.Archive | Out-Null
for ($d = 1; $d -le 5; $d++) { Set-Content -LiteralPath (Join-Path $lab.Archive ('metasheet-backend.out-0.2026090{0}-033000.log' -f $d)) -Value 'old' }
Set-Content -LiteralPath (Join-Path $lab.Archive 'keep-me.txt') -Value 'x'
$before = Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Keep = 3; Mode = 'CopyTruncate'; Apply = $true } $null
$outArchives = @(Get-ChildItem -LiteralPath $lab.Archive -Filter 'metasheet-backend.out-0.*.log' | Sort-Object Name)
$newest = $outArchives | Select-Object -Last 1
Check 'apply exits 0' ($r.Code -eq 0)
Check 'live files still exist and are truncated to 0' (((Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 0) -and ((Get-Item (Join-Path $lab.Logs 'metasheet-backend.err-0.log')).Length -eq 0))
Check 'the new archive holds the original bytes' ($null -ne $newest -and (Get-Sha $newest.FullName) -eq $before -and $newest.Name -notlike '*2026090*')
Check 'out-0 archives pruned to -Keep 3, oldest first' ($outArchives.Count -eq 3 -and (@($outArchives | Where-Object { $_.Name -like '*20260901*' -or $_.Name -like '*20260902*' -or $_.Name -like '*20260903*' }).Count -eq 0))
Check 'unrelated files and the non-pm_id log are untouched' ((Test-Path (Join-Path $lab.Archive 'keep-me.txt')) -and ((Get-Item (Join-Path $lab.Logs 'metasheet-backend.out.log')).Length -eq 2 * $mb))
Check 'rotate-<yyyyMMdd>.log written in the archive dir' (@(Get-ChildItem -LiteralPath $lab.Archive -Filter 'rotate-*.log').Count -eq 1)

Write-Host '== -MinSizeMB skip'
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 100 * 1024 }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Mode = 'CopyTruncate'; Apply = $true } $null
Check 'small live file is skipped and left as is' ($r.Code -eq 0 -and $r.Out -match 'skip metasheet-backend\.out-0\.log' -and (Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 100 * 1024 -and @(Get-ChildItem -LiteralPath $lab.Archive -Filter 'metasheet-backend.*').Count -eq 0)

Write-Host '== refusal when -Pm2Home is unset'
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
$savedHome = $env:PM2_HOME
try {
  Remove-Item -LiteralPath 'Env:PM2_HOME' -ErrorAction SilentlyContinue
  $r = Invoke-Rotate @{ InstallRoot = $lab.Root; MinSizeMB = 0; Mode = 'CopyTruncate'; Apply = $true } $null
  Check 'no -Pm2Home and no PM2_HOME -> exit 2, STOP message, nothing changed' ($r.Code -eq 2 -and $r.Out -match 'STOP: -Pm2Home is not set' -and -not (Test-Path $lab.Archive) -and (Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 2 * $mb)
  $shell = (Get-Process -Id $PID).Path
  $null = & $shell -NoProfile -ExecutionPolicy Bypass -File $ScriptUnderTest -InstallRoot $lab.Root -Apply 2>&1
  Check 'same refusal through -File: process exit code 2' ($LASTEXITCODE -eq 2 -and -not (Test-Path $lab.Archive))
} finally { if ($null -ne $savedHome) { $env:PM2_HOME = $savedHome } }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = (Join-Path $lab.Root 'no-such-home'); Apply = $true } $null
Check 'non-existent -Pm2Home -> exit 2' ($r.Code -eq 2)

Write-Host '== Rename + reloadLogs'
$stubOk = {
  function Test-Pm2PipePresent { $true }
  function Stub-Pm2 { [void]$calls.Add($env:PM2_HOME); foreach ($n in 'metasheet-backend.out-0.log', 'metasheet-backend.err-0.log') { [System.IO.File]::WriteAllText((Join-Path $lab.Logs $n), '') }; $global:LASTEXITCODE = 0; 'All logs reloaded' }
}
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb; 'metasheet-backend.err-0.log' = 2 * $mb }
$before = Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2' } $stubOk
$arch = @(Get-ChildItem -LiteralPath $lab.Archive -Filter 'metasheet-backend.out-0.*.log')
Check 'rename + reload: exit 0, pm2 called once with PM2_HOME = -Pm2Home' ($r.Code -eq 0 -and $r.Calls.Count -eq 1 -and $r.Calls[0] -eq $lab.Pm2Home)
Check 'rename + reload: archive holds the original bytes, fresh live file present' ($arch.Count -eq 1 -and (Get-Sha $arch[0].FullName) -eq $before -and (Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 0)

$failures = [ordered]@{
  'reloadLogs exits non-zero' = { function Test-Pm2PipePresent { $true }; function Stub-Pm2 { [void]$calls.Add('x'); $global:LASTEXITCODE = 1; 'connect EPERM' } }
  'reloadLogs spawned a daemon' = { function Test-Pm2PipePresent { $true }; function Stub-Pm2 { [void]$calls.Add('x'); $global:LASTEXITCODE = 0; 'Spawning PM2 daemon with pm2_home=x'; 'All logs reloaded' } }
  'reloadLogs ok but no live file reappears' = { function Test-Pm2PipePresent { $true }; function Stub-Pm2 { [void]$calls.Add('x'); $global:LASTEXITCODE = 0; 'All logs reloaded' } }
}
foreach ($case in $failures.Keys) {
  $lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
  $before = Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')
  $r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2'; ReopenTimeoutSec = 1 } $failures[$case]
  Check ("$case -> exit 4, live file moved back with its bytes, no archive left") ($r.Code -eq 4 -and $r.Out -match 'ROLLED BACK' -and (Test-Path (Join-Path $lab.Logs 'metasheet-backend.out-0.log')) -and (Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')) -eq $before -and @(Get-ChildItem -LiteralPath $lab.Archive -Filter 'metasheet-backend.*').Count -eq 0)
}

$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2' } {
  function Test-Pm2PipePresent { $true }
  function Stub-Pm2 { [System.IO.File]::WriteAllText((Join-Path $lab.Logs 'metasheet-backend.out-0.log'), ''); $global:LASTEXITCODE = 1; 'error' }
}
Check 'reloadLogs exits non-zero even though a live file exists -> exit 4 (not reported as rotated)' ($r.Code -eq 4 -and $r.Out -notmatch 'live log\(s\) reopened')
Check 'live file back after the wait -> LATE REOPEN logged, archive kept, nothing moved back' ($r.Out -match 'LATE REOPEN: .*metasheet-backend\.out-0\.log came back' -and $r.Out -notmatch 'ROLLED BACK' -and @(Get-ChildItem -LiteralPath $lab.Archive -Filter 'metasheet-backend.out-0.*.log').Count -eq 1)
$spawnStub = {
  function Test-Pm2PipePresent { $true }
  function Stub-Pm2 { [System.IO.File]::WriteAllText((Join-Path $lab.Logs 'metasheet-backend.out-0.log'), ''); $global:LASTEXITCODE = 0; 'Spawning PM2 daemon with pm2_home=x'; 'All logs reloaded' }
}
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2' } ([scriptblock]::Create($spawnStub.ToString() + "`nfunction Find-StrayPm2Daemon { param(`$Since) [void]`$calls.Add(`$Since); 4242 }"))
Check 'reloadLogs printed "Spawning PM2 daemon" (exit 0, live file exists) -> exit 4, warning names the stray pid, never pm2 kill' ($r.Code -eq 4 -and $r.Out -match 'spawned a stray pm2 daemon; stray daemon pid 4242\. Do NOT run pm2 kill' -and $r.Out -notmatch 'live log\(s\) reopened' -and $r.Calls.Count -eq 2 -and $r.Calls[1] -eq [datetime]::MinValue)
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2' } ([scriptblock]::Create($spawnStub.ToString() + "`nfunction Find-StrayPm2Daemon { param(`$Since) @() }"))
Check 'stray daemon pid not found -> the warning says so' ($r.Code -eq 4 -and $r.Out -match 'its pid was not found')


Write-Host '== exit 4 names every Daemon.js process (also ones that predate the call); never kills'
$noSpawnFail = 'function Test-Pm2PipePresent { $true }; function Stub-Pm2 { [void]$calls.Add(''x''); $global:LASTEXITCODE = 1; ''connect EPERM'' }'
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2'; ReopenTimeoutSec = 1 } ([scriptblock]::Create($noSpawnFail + "`nfunction Find-StrayPm2Daemon { param(`$Since) [void]`$calls.Add(`$Since); 777, 888 }"))
Check 'exit 4 without "Spawning PM2 daemon": a pre-existing Daemon.js pid is named, scanned without a time filter' ($r.Code -eq 4 -and $r.Out -match 'present now: pid 777, 888' -and $r.Out -notmatch 'spawned a stray pm2 daemon' -and $r.Calls.Count -eq 2 -and $r.Calls[1] -eq [datetime]::MinValue)
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2'; ReopenTimeoutSec = 1 } ([scriptblock]::Create($noSpawnFail + "`nfunction Find-StrayPm2Daemon { param(`$Since) @() }"))
Check 'exit 4 with no Daemon.js process: the log says none' ($r.Code -eq 4 -and $r.Out -match 'present now: none')

Write-Host '== external pm2 program: bounded call (-Pm2TimeoutSec), output via files'
$stubDir = Join-Path $WorkRoot ('logrot-test-stub-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $stubDir | Out-Null
$okStub = Join-Path $stubDir 'pm2-ok'
$slowStub = Join-Path $stubDir 'pm2-slow'
$pidFile = Join-Path $stubDir 'slow.pid'
$marker = 1200 + (Get-Random -Maximum 700)
if ($isWin) {
  $okStub += '.cmd'; $slowStub += '.cmd'
  [System.IO.File]::WriteAllText($okStub, "@echo off`r`ntype nul > `"%LOGROT_LIVE%`"`r`necho All logs reloaded`r`nexit /b 0`r`n")
  [System.IO.File]::WriteAllText($slowStub, "@echo off`r`nping -n $marker 127.0.0.1 >nul`r`nexit /b 0`r`n")
} else {
  [System.IO.File]::WriteAllText($okStub, "#!/bin/sh`n: > `"`$LOGROT_LIVE`"`necho All logs reloaded`nexit 0`n")
  [System.IO.File]::WriteAllText($slowStub, "#!/bin/sh`necho `$`$ > '$pidFile'`nexec sleep $marker`n")
  $null = & chmod +x $okStub $slowStub
}
$stubCanRun = $true
if (-not $isWin -and -not (Test-Path '/bin/sh')) { $stubCanRun = $false }
if (-not $stubCanRun) { Write-Host '  SKIP  external-program timeout cases (no /bin/sh)' }
else {
  $okOver = { function Test-Pm2PipePresent { $true } }
  $lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
  $env:LOGROT_LIVE = Join-Path $lab.Logs 'metasheet-backend.out-0.log'
  $r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = $okStub; Pm2TimeoutSec = 30 } $okOver
  Check 'external stub (normal case): exit 0, output read from the redirect files, live file back, archive kept' ($r.Code -eq 0 -and $r.Out -match 'pm2 reloadLogs exit=0: All logs reloaded' -and $r.Out -match 'live log\(s\) reopened' -and @(Get-ChildItem -LiteralPath $lab.Archive -Filter 'metasheet-backend.out-0.*.log').Count -eq 1)
  $lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
  $before = Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = $slowStub; Pm2TimeoutSec = 1; ReopenTimeoutSec = 1 } ([scriptblock]::Create($okOver.ToString() + "`nfunction Find-StrayPm2Daemon { param(`$Since) @() }"))
  $sw.Stop()
  Check 'pm2 call longer than -Pm2TimeoutSec 1 -> exit 4, "pm2 call timed out after 1 s", archive moved back with its bytes' ($r.Code -eq 4 -and $r.Out -match 'pm2 call timed out after 1 s' -and $r.Out -match 'ROLLED BACK' -and (Get-Sha (Join-Path $lab.Logs 'metasheet-backend.out-0.log')) -eq $before -and @(Get-ChildItem -LiteralPath $lab.Archive -Filter 'metasheet-backend.*').Count -eq 0 -and $sw.Elapsed.TotalSeconds -lt ($marker / 2))
  Start-Sleep -Milliseconds 500
  $alive = $true
  if ($isWin) { $alive = (@(Get-CimInstance Win32_Process | Where-Object { [string]$_.CommandLine -match ('ping(\.exe)?"? -n ' + $marker + ' ') }).Count -gt 0) }
  elseif (Test-Path $pidFile) { $alive = ($null -ne (Get-Process -Id ([int]([System.IO.File]::ReadAllText($pidFile).Trim())) -ErrorAction SilentlyContinue)) }
  Check 'the timed-out stub process was killed' (-not $alive)
  Remove-Item Env:LOGROT_LIVE -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $stubDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '== archive name collision, -Keep 0'
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
New-Item -ItemType Directory -Force -Path $lab.Archive | Out-Null
$existing = Join-Path $lab.Archive 'metasheet-backend.out-0.20261012-033000.log'
Set-Content -LiteralPath $existing -Value 'earlier archive'
$before = Get-Sha $existing
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Mode = 'CopyTruncate' } { function Get-RotateStamp { '20261012-033000' } }
Check 'archive name already taken -> exit 5, existing archive and live file untouched' ($r.Code -eq 5 -and $r.Out -match 'FAILED: archive already exists' -and (Get-Sha $existing) -eq $before -and (Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 2 * $mb)
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; Keep = 0; Apply = $true; Mode = 'CopyTruncate' } $null
Check '-Keep 0 -> exit 2, nothing pruned' ($r.Code -eq 2 -and (Test-Path -LiteralPath $existing))

if ($isWin) {
  $lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
  $otherDrive = 'Z:\'
  if ([System.IO.Path]::GetPathRoot($lab.Root) -eq $otherDrive) { $otherDrive = 'Y:\' }
  $r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; ArchiveDir = ($otherDrive + 'archive'); Pm2Command = 'Stub-Pm2' } { function Test-Pm2PipePresent { $true }; function Stub-Pm2 { [void]$calls.Add('x') } }
  Check 'Windows: Rename with -ArchiveDir on another volume -> exit 2, nothing touched' ($r.Code -eq 2 -and $r.Calls.Count -eq 0 -and (Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 2 * $mb)
} else { Write-Host '  SKIP  cross-volume -ArchiveDir (Windows only)' }

$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2' } {
  function Test-Pm2PipePresent { $false }
  function Stub-Pm2 { [void]$calls.Add('x'); $global:LASTEXITCODE = 0 }
}
Check 'no pm2 endpoint: falls back to CopyTruncate and never calls pm2' ($r.Code -eq 0 -and $r.Out -match 'FALLBACK: no pm2 RPC endpoint' -and $r.Calls.Count -eq 0 -and (Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 0)

if ($isWin) {
  $lab = New-Lab @{ 'metasheet-backend.out-0.log' = 2 * $mb }
  $holder = [System.IO.File]::Open((Join-Path $lab.Logs 'metasheet-backend.out-0.log'), 'Open', 'ReadWrite', 'ReadWrite')
  try {
    $r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; MinSizeMB = 1; Apply = $true; Pm2Command = 'Stub-Pm2' } {
      function Test-Pm2PipePresent { $true }
      function Stub-Pm2 { [void]$calls.Add('x'); $global:LASTEXITCODE = 0 }
    }
  } finally { $holder.Close() }
  Check 'Windows: rename sharing violation falls back to CopyTruncate, pm2 not called' ($r.Code -eq 0 -and $r.Out -match 'FALLBACK: rename of metasheet-backend\.out-0\.log' -and $r.Calls.Count -eq 0 -and (Get-Item (Join-Path $lab.Logs 'metasheet-backend.out-0.log')).Length -eq 0)
} else { Write-Host '  SKIP  rename sharing violation (Windows only)' }

Write-Host '== -Register'
$taskXml = '<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="Author"><UserId>svc-user</UserId><LogonType>Password</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals></Task>'
$taskMocks = {
  function New-ScheduledTaskAction { param($Execute, $Argument) @{ Execute = $Execute; Argument = $Argument } }
  function New-ScheduledTaskTrigger { param([switch]$Daily, $At) @{ At = $At } }
  function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) @{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel } }
  function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable, $MultipleInstances, $ExecutionTimeLimit) @{} }
  function New-ScheduledTask { param($Action, $Trigger, $Principal, $Settings) @{ Action = $Action; Trigger = $Trigger; Principal = $Principal } }
  function Register-ScheduledTask { param($TaskName, $InputObject, [switch]$Force) [void]$calls.Add(@{ TaskName = $TaskName; Task = $InputObject }) }
}
$lab = New-Lab @{ 'metasheet-backend.out-0.log' = 10 }
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; Register = $true; Apply = $true } ([scriptblock]::Create($taskMocks.ToString() + "`nfunction schtasks { `$global:LASTEXITCODE = 1; 'ERROR: The system cannot find the file specified.' }"))
Check 'host task missing -> exit 3, nothing registered' ($r.Code -eq 3 -and $r.Out -match "REFUSED: scheduled task 'MetaSheet-PM2' not found" -and $r.Calls.Count -eq 0)
$withHost = [scriptblock]::Create($taskMocks.ToString() + "`nfunction schtasks { `$global:LASTEXITCODE = 0; '$taskXml' }")
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; Register = $true } $withHost
Check '-Register without -Apply prints the task and registers nothing' ($r.Code -eq 0 -and $r.Out -match 'nothing registered' -and $r.Calls.Count -eq 0)
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; Register = $true; Apply = $true } $withHost
$reg = $null
if ($r.Calls.Count -eq 1) { $reg = $r.Calls[0] }
Check '-Register -Apply registers MetaSheet-LogRotate as the host task user (S4U, Highest), daily 03:30, running -Apply' ($r.Code -eq 0 -and $null -ne $reg -and $reg.TaskName -eq 'MetaSheet-LogRotate' -and $reg.Task.Principal.UserId -eq 'svc-user' -and $reg.Task.Principal.LogonType -eq 'S4U' -and $reg.Task.Principal.RunLevel -eq 'Highest' -and $reg.Task.Trigger.At -eq '03:30' -and $reg.Task.Action.Argument -match ' -Apply$' -and $reg.Task.Action.Argument -match [regex]::Escape('-Pm2Home "' + $lab.Pm2Home + '"'))
$r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; Register = $true; Apply = $true; At = '3pm' } $withHost
Check 'bad -At -> exit 3, nothing registered' ($r.Code -eq 3 -and $r.Calls.Count -eq 0)
$withHostCounted = [scriptblock]::Create($taskMocks.ToString() + "`nfunction schtasks { [void]`$calls.Add('schtasks'); `$global:LASTEXITCODE = 0; '$taskXml' }")
foreach ($name in @('MetaSheet-PM2', ' metasheet-pm2 ', '')) {
  $r = Invoke-Rotate @{ InstallRoot = $lab.Root; Pm2Home = $lab.Pm2Home; Register = $true; Apply = $true; TaskName = $name } $withHostCounted
  Check ("-TaskName '$name' (the host task, or empty) -> exit 3 before any schtasks / Register call") ($r.Code -eq 3 -and $r.Out -match 'REFUSED: -TaskName' -and $r.Calls.Count -eq 0)
}

Get-ChildItem -LiteralPath $WorkRoot -Directory -Filter 'logrot-test-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("multitable-onprem-backend-log-rotate tests: {0} passed, {1} failed (PowerShell {2})" -f $pass, $fail, $PSVersionTable.PSVersion)
if ($fail -gt 0) { exit 1 }
exit 0
