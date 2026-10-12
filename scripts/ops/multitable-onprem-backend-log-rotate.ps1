<#
.SYNOPSIS
  Archive and prune the on-prem backend's pm2 logs (output\logs\metasheet-backend.{out,err}-<pm_id>.log).
  Windows PowerShell 5.1 compatible. Runbook: docs/development/takeover-beiliao-20260821/runbook-backend-log-rotation-20261012.md

  Default is a DRY RUN: it prints the plan and changes nothing. -Apply rotates. -Register (+ -Apply)
  registers the daily scheduled task 'MetaSheet-LogRotate' under the account of the 'MetaSheet-PM2' task.

  -Mode Rename (default): rename each live file into -ArchiveDir (instant, same volume required), then
  `pm2 reloadLogs` so the pm2 God process (pm2-runtime in no-daemon mode) reopens a fresh live file.
  pm2 is only called when its RPC endpoint already exists (Windows: \\.\pipe\rpc.sock, shared by EVERY
  PM2_HOME): a pm2 CLI call that finds no daemon spawns one, reports "All logs reloaded" and exits 0.
    - no pm2 endpoint            -> this run uses CopyTruncate instead (pm2 is never called);
    - a rename throws            -> that file falls back to CopyTruncate;
    - reloadLogs fails, or a live file is not back within -ReopenTimeoutSec
                                 -> every renamed file whose live name is still absent is moved BACK,
                                    so the backend keeps writing to the file it always had (exit 4).
  -Mode CopyTruncate: copy the live file into -ArchiveDir, then truncate it in place (pm2 opens it in
  append mode, so the next write lands at offset 0). Lines written between copy and truncate are lost.

  The live file is never deleted. Only archives named <stream>.<yyyyMMdd-HHmmss>.log beyond -Keep per
  stream (and rotate-<yyyyMMdd>.log beyond -Keep) are deleted, oldest first by the name's timestamp.

  Exit codes: 0 ok / dry run / nothing to do; 2 usage or configuration error (nothing changed);
  3 -Register refused (nothing registered); 4 reloadLogs failed, renames rolled back;
  5 a file operation failed (read the rotate log; a live file may need attention).
#>
param(
  [string]$InstallRoot = '',
  [string]$ArchiveDir = '',
  [int]$Keep = 14,
  [int]$MinSizeMB = 64,
  [string]$Pm2Home = '',
  [ValidateSet('Rename', 'CopyTruncate')][string]$Mode = 'Rename',
  [string]$Pm2Command = '',
  [int]$ReopenTimeoutSec = 10,
  [switch]$DryRun,
  [switch]$Apply,
  [switch]$Register,
  [string]$At = '03:30',
  [string]$HostTaskName = 'MetaSheet-PM2',
  [string]$TaskName = 'MetaSheet-LogRotate'
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$script:LogFile = ''

function Write-Step([string]$Message) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
  Write-Host $line
  if ($script:LogFile) { [System.IO.File]::AppendAllText($script:LogFile, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false))) }
}

function Test-IsWindowsHost { return ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) }

function Test-Pm2PipePresent([string]$Pm2HomeDir) {
  # Asks for the ONE name (listing \\.\pipe\ throws under 5.1 when any pipe name holds '<' or '|').
  if (-not (Test-IsWindowsHost)) { return (Test-Path -LiteralPath (Join-Path $Pm2HomeDir 'rpc.sock')) }
  try { return (@([System.IO.Directory]::GetFiles('\\.\pipe\', 'rpc.sock')).Count -gt 0) } catch { return $false }
}

function Invoke-Pm2ReloadLogs([string]$Command, [string]$Pm2HomeDir) {
  $previous = $env:PM2_HOME
  $ErrorActionPreference = 'Continue'
  try {
    $env:PM2_HOME = $Pm2HomeDir
    $raw = & $Command 'reloadLogs' 2>&1
    $code = $LASTEXITCODE
  } catch { $raw = @($_.Exception.Message); $code = 1 } finally { $env:PM2_HOME = $previous }
  $text = (@($raw) | ForEach-Object { [string]$_ }) -join ' | '
  return [pscustomobject]@{ Ok = (($code -eq 0) -and ($text -notmatch 'Spawning PM2 daemon')); Code = $code; Text = $text }
}

function Get-LiveLogs([string]$LogsDir) {
  # pm2 inserts the pm_id before the extension: metasheet-backend.out-0.log / .err-0.log.
  return @(Get-ChildItem -LiteralPath $LogsDir -File | Where-Object { $_.Name -match '^metasheet-backend\.(out|err)-\d+\.log$' } | Sort-Object Name)
}

function Invoke-CopyTruncate([string]$Live, [string]$Archive) {
  Copy-Item -LiteralPath $Live -Destination $Archive
  $fs = [System.IO.File]::Open($Live, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
  try { $fs.SetLength(0) } finally { $fs.Close() }
}

function Remove-OldArchives([string]$Dir, [int]$KeepCount, [bool]$DoIt) {
  $groups = @{}
  foreach ($f in @(Get-ChildItem -LiteralPath $Dir -File)) {
    $m = [regex]::Match($f.Name, '^(metasheet-backend\.(?:out|err)-\d+)\.(\d{8}-\d{6})\.log$')
    if (-not $m.Success) { $m = [regex]::Match($f.Name, '^(rotate)-(\d{8})\.log$') }
    if (-not $m.Success) { continue }
    $key = $m.Groups[1].Value
    if (-not $groups.ContainsKey($key)) { $groups[$key] = @() }
    $groups[$key] += [pscustomobject]@{ Stamp = $m.Groups[2].Value; File = $f }
  }
  foreach ($key in @($groups.Keys | Sort-Object)) {
    $old = @($groups[$key] | Sort-Object Stamp -Descending | Select-Object -Skip $KeepCount)
    foreach ($o in @($old | Sort-Object Stamp)) {
      if ($DoIt) { Remove-Item -LiteralPath $o.File.FullName -Force; Write-Step ("pruned " + $o.File.Name) }
      else { Write-Step ("[dry-run] would prune " + $o.File.Name) }
    }
  }
}

function Get-HostTaskPrincipal([string]$Name) {
  $ErrorActionPreference = 'Continue'
  try { $raw = & schtasks /query /tn $Name /xml 2>&1; $code = $LASTEXITCODE } catch { return $null }
  if ($code -ne 0) { return $null }
  try {
    $xml = [xml]((@($raw) | ForEach-Object { [string]$_ }) -join "`n")
    $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $p = $xml.SelectSingleNode('/t:Task/t:Principals/t:Principal', $ns)
  } catch { return $null }
  if ($null -eq $p) { return $null }
  return [pscustomobject]@{ UserId = [string]$p.UserId; LogonType = [string]$p.LogonType; RunLevel = [string]$p.RunLevel }
}

function Invoke-RegisterTask($Cfg) {
  $principal = Get-HostTaskPrincipal $Cfg.HostTaskName
  if ($null -eq $principal -or [string]::IsNullOrWhiteSpace($principal.UserId)) {
    Write-Step ("REFUSED: scheduled task '" + $Cfg.HostTaskName + "' not found (or has no user principal); nothing registered. The rotate task must run as the account that hosts pm2-runtime.")
    return 3
  }
  if ($Cfg.At -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { Write-Step ("REFUSED: -At '" + $Cfg.At + "' is not HH:mm"); return 3 }
  foreach ($c in @('Register-ScheduledTask', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'New-ScheduledTask')) {
    if (-not (Get-Command -Name $c -ErrorAction SilentlyContinue)) { Write-Step ("REFUSED: " + $c + " is unavailable (ScheduledTasks module)"); return 3 }
  }
  $logon = 'S4U'
  if ($principal.UserId -match '^(S-1-5-(18|19|20)|SYSTEM|NT AUTHORITY\\.*)$') { $logon = 'ServiceAccount' }
  elseif ($principal.LogonType -eq 'InteractiveToken') { $logon = 'Interactive' }
  $runLevel = 'Limited'
  if ($principal.RunLevel -eq 'HighestAvailable') { $runLevel = 'Highest' }
  $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -ArchiveDir "{2}" -Pm2Home "{3}" -Pm2Command "{4}" -Keep {5} -MinSizeMB {6} -Mode {7} -Apply' -f $Cfg.ScriptPath, $Cfg.InstallRoot, $Cfg.ArchiveDir, $Cfg.Pm2Home, $Cfg.Pm2Command, $Cfg.Keep, $Cfg.MinSizeMB, $Cfg.Mode
  Write-Step ("task '" + $Cfg.TaskName + "': daily " + $Cfg.At + ", user " + $principal.UserId + " (host LogonType '" + $principal.LogonType + "' -> " + $logon + ", RunLevel " + $runLevel + ")")
  Write-Step ("task action: powershell.exe " + $argLine)
  if (-not $Cfg.DoIt) { Write-Step '[dry-run] nothing registered; add -Apply to register'; return 0 }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
  $trigger = New-ScheduledTaskTrigger -Daily -At $Cfg.At
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $principal.UserId -LogonType $logon -RunLevel $runLevel
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings
  Register-ScheduledTask -TaskName $Cfg.TaskName -InputObject $task -Force | Out-Null
  Write-Step ("registered '" + $Cfg.TaskName + "'")
  return 0
}

function Invoke-Main {
  $script:LogFile = ''
  if ($DryRun -and $Apply) { Write-Step 'USAGE: -DryRun and -Apply are mutually exclusive'; return 2 }
  $doIt = [bool]$Apply
  if ([string]::IsNullOrWhiteSpace($InstallRoot) -or -not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { Write-Step 'USAGE: -InstallRoot <existing install root> is required'; return 2 }
  $root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
  $logsDir = Join-Path (Join-Path $root 'output') 'logs'
  $archive = $ArchiveDir
  if ([string]::IsNullOrWhiteSpace($archive)) { $archive = Join-Path $logsDir 'archive' }
  $archive = [System.IO.Path]::GetFullPath($archive).TrimEnd('\', '/')
  $pm2HomeDir = $Pm2Home
  if ([string]::IsNullOrWhiteSpace($pm2HomeDir)) { $pm2HomeDir = $env:PM2_HOME }
  if ([string]::IsNullOrWhiteSpace($pm2HomeDir)) { Write-Step 'STOP: -Pm2Home is not set and PM2_HOME is empty. Pass the pm2-runtime home (<service account profile>\.pm2-runtime); this script never guesses it.'; return 2 }
  if (-not (Test-Path -LiteralPath $pm2HomeDir -PathType Container)) { Write-Step ("STOP: -Pm2Home '" + $pm2HomeDir + "' is not an existing directory"); return 2 }
  $pm2HomeDir = [System.IO.Path]::GetFullPath($pm2HomeDir).TrimEnd('\', '/')
  if ($Keep -lt 1 -or $MinSizeMB -lt 0) { Write-Step 'USAGE: -Keep must be >= 1 and -MinSizeMB >= 0'; return 2 }
  if (-not (Test-Path -LiteralPath $logsDir -PathType Container)) { Write-Step ("STOP: logs directory not found: " + $logsDir); return 2 }
  $cmd = $Pm2Command
  if ([string]::IsNullOrWhiteSpace($cmd)) {
    $cmd = Join-Path (Join-Path (Join-Path $root 'node_modules') '.bin') 'pm2.cmd'
    if (-not (Test-Path -LiteralPath $cmd)) { $cmd = 'pm2'; $found = Get-Command 'pm2' -ErrorAction SilentlyContinue; if ($found) { $cmd = $found.Source } }
  }
  if ($Register) {
    $self = $PSCommandPath
    if (-not $self) { $self = $MyInvocation.ScriptName }
    return (Invoke-RegisterTask @{ HostTaskName = $HostTaskName; TaskName = $TaskName; At = $At; ScriptPath = $self; InstallRoot = $root; ArchiveDir = $archive; Pm2Home = $pm2HomeDir; Pm2Command = $cmd; Keep = $Keep; MinSizeMB = $MinSizeMB; Mode = $Mode; DoIt = $doIt })
  }
  if ($Mode -eq 'Rename' -and [System.IO.Path]::GetPathRoot($archive) -ne [System.IO.Path]::GetPathRoot($logsDir)) { Write-Step 'STOP: -Mode Rename needs -ArchiveDir on the same volume as output\logs'; return 2 }
  if ($doIt) {
    if (-not (Test-Path -LiteralPath $archive)) { New-Item -ItemType Directory -Path $archive | Out-Null }
    $script:LogFile = Join-Path $archive ('rotate-' + (Get-Date -Format 'yyyyMMdd') + '.log')
  }
  $label = '[dry-run] '
  if ($doIt) { $label = '' }
  $effectiveMode = $Mode
  if ($Mode -eq 'Rename' -and -not (Test-Pm2PipePresent $pm2HomeDir)) {
    $effectiveMode = 'CopyTruncate'
    Write-Step 'FALLBACK: no pm2 RPC endpoint (rpc.sock) on this host, so pm2 is not called (it would spawn a stray daemon); using CopyTruncate for this run'
  }
  Write-Step ("{0}rotate: logs={1} archive={2} mode={3} keep={4} minSizeMB={5} pm2Home={6} pm2={7}" -f $label, $logsDir, $archive, $effectiveMode, $Keep, $MinSizeMB, $pm2HomeDir, $cmd)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $renamed = @()
  $failed = $false
  foreach ($f in (Get-LiveLogs $logsDir)) {
    $sizeMB = [math]::Round($f.Length / 1MB, 1)
    if ($f.Length -lt ([int64]$MinSizeMB * 1MB)) { Write-Step ("{0}skip {1} ({2} MB < {3} MB)" -f $label, $f.Name, $sizeMB, $MinSizeMB); continue }
    $target = Join-Path $archive ($f.BaseName + '.' + $stamp + '.log')
    if (-not $doIt) { Write-Step ("[dry-run] would {0} {1} ({2} MB) -> {3}" -f $effectiveMode, $f.Name, $sizeMB, $target); continue }
    if (Test-Path -LiteralPath $target) { Write-Step ("FAILED: archive already exists: " + $target); $failed = $true; continue }
    try {
      if ($effectiveMode -eq 'Rename') {
        try { [System.IO.File]::Move($f.FullName, $target); $renamed += [pscustomobject]@{ Live = $f.FullName; Archive = $target }; Write-Step ("renamed {0} ({1} MB) -> {2}" -f $f.Name, $sizeMB, $target) }
        catch [System.IO.IOException] { Write-Step ("FALLBACK: rename of {0} failed ({1}); using CopyTruncate" -f $f.Name, $_.Exception.Message); Invoke-CopyTruncate $f.FullName $target; Write-Step ("copied+truncated " + $f.Name + " -> " + $target) }
      } else { Invoke-CopyTruncate $f.FullName $target; Write-Step ("copied+truncated {0} ({1} MB) -> {2}" -f $f.Name, $sizeMB, $target) }
    } catch { Write-Step ("FAILED: {0}: {1}" -f $f.Name, $_.Exception.Message); $failed = $true }
  }
  $code = 0
  if ($renamed.Count -gt 0) {
    $reload = Invoke-Pm2ReloadLogs $cmd $pm2HomeDir
    Write-Step ("pm2 reloadLogs exit={0}: {1}" -f $reload.Code, $reload.Text)
    if ($reload.Text -match 'Spawning PM2 daemon') { Write-Step 'WARNING: pm2 spawned a new pm2 daemon (it could not reach pm2-runtime). Do NOT run pm2 kill here (the pipe is machine-wide); report it and check the MetaSheet-PM2 task.' }
    $missing = @($renamed)
    if ($reload.Ok) {
      # God.reloadLogs answers before it reopens the files, so wait for every live file to come back.
      $deadline = (Get-Date).AddSeconds($ReopenTimeoutSec)
      do { $missing = @($renamed | Where-Object { -not (Test-Path -LiteralPath $_.Live) }); if ($missing.Count -gt 0) { Start-Sleep -Milliseconds 250 } } while ($missing.Count -gt 0 -and (Get-Date) -lt $deadline)
    }
    if ($missing.Count -gt 0) {
      $code = 4
      foreach ($r in $missing) {
        try {
          if (-not (Test-Path -LiteralPath $r.Live)) { [System.IO.File]::Move($r.Archive, $r.Live); Write-Step ("ROLLED BACK: {0} moved back to {1}; the backend keeps writing to it" -f $r.Archive, $r.Live) }
        } catch { Write-Step ("FAILED: rollback of {0}: {1}" -f $r.Archive, $_.Exception.Message); $code = 5 }
      }
      Write-Step 'pm2 did not reopen the live log(s); check -Pm2Home, that this runs as the pm2-runtime account, and that the MetaSheet-PM2 task is running'
    } else { Write-Step 'live log(s) reopened by pm2' }
  }
  if ($failed) { $code = 5 }
  if (Test-Path -LiteralPath $archive) { Remove-OldArchives $archive $Keep $doIt }
  Write-Step ("{0}done, exit {1}" -f $label, $code)
  return $code
}

if ($MyInvocation.InvocationName -eq '.') { return }
exit (Invoke-Main)
