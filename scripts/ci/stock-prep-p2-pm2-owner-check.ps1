# 02-pm2-owner-check.ps1 - values-free check that THIS Windows account and THIS PM2_HOME own the
# running pm2 app (install sheet step 2.3). Windows PowerShell 5.1, read-only.
#
# RUN (in the same PowerShell window that will run the install):
#   powershell -NoProfile -ExecutionPolicy Bypass -File 02-pm2-owner-check.ps1
#
# WHY: scripts\ops\attendance-onprem-start-pm2.ps1 (:393) runs `pm2 describe <app> *> $null` under
# ErrorActionPreference Stop (:7). When pm2 cannot find the app, Windows PowerShell 5.1 aborts the
# whole start script after the migrations already ran (seen in the Windows install rehearsal #6901).
# The site app is already registered, so installing under the same account and the same PM2_HOME
# avoids it. This script checks that, WITHOUT running any pm2 command: on a machine with no pm2
# daemon, any pm2 command starts a new, empty one.
#
# HOW (files and process table only):
#   effective PM2_HOME   $env:PM2_HOME when set, else USERPROFILE\.pm2 (the same default as
#                        attendance-onprem-start-pm2.ps1:219-225; USERPROFILE empty -> the system
#                        profile, as there)
#   daemon               <PM2_HOME>\pm2.pid names a live node.exe owned by the current account
#   app                  <PM2_HOME>\pids\<app>-<n>.pid names a live node.exe owned by the current account
#   owned=true           only when both hold
#
# OUTPUT: closed lines only, never a path, account name, PID or command line:
#   PM2OWNER pm2_home_set=true|false            is $env:PM2_HOME set in this window
#   PM2OWNER pm2_home_exists=true|false
#   PM2OWNER daemon_pid_file=true|false
#   PM2OWNER daemon_alive=true|false
#   PM2OWNER daemon_owner_is_current_user=true|false|unknown
#   PM2OWNER app_pid_file=true|false
#   PM2OWNER app_alive=true|false
#   PM2OWNER app_owner_is_current_user=true|false|unknown
#   PM2OWNER other_user_pm2_process=true|false|unknown   a node.exe whose command line names pm2,
#                                                        owned by another account
#   then the LAST line
#   PM2OWNER_RESULT owned=true|false status=complete
#   PM2OWNER_RESULT owned=false status=incomplete reason=<word>
# A run with no PM2OWNER_RESULT line did not finish. Never read a missing line as true.
# status=incomplete reasons: owner_unreadable (an owner could not be read: run the window as the
# install account, not elevated as another one), no_pm2_process (no pm2 process at all on this
# machine), read_error.
#
# -Diag (CI only, never on site): also prints DIAG lines with the file names directly under
# PM2_HOME and the pm2 process counts.
param(
  [string]$AppName = 'metasheet-backend',
  [switch]$Diag
)

$ErrorActionPreference = 'Stop'

function Get-ProcessById([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  return (Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $ProcessId) | Select-Object -First 1)
}

# 'true' / 'false' / 'unknown' (the owner could not be read)
function Get-OwnerIsCurrent($proc, [string]$me) {
  if ($null -eq $proc) { return 'false' }
  try {
    $o = Invoke-CimMethod -InputObject $proc -MethodName GetOwner
  } catch { return 'unknown' }
  if ($null -eq $o -or [int]$o.ReturnValue -ne 0 -or [string]::IsNullOrEmpty([string]$o.User)) { return 'unknown' }
  $owner = ([string]$o.Domain + '\' + [string]$o.User)
  if ([string]::Equals($owner, $me, [System.StringComparison]::OrdinalIgnoreCase)) { return 'true' }
  return 'false'
}

function Read-PidFile([string]$path) {
  try {
    $raw = ([string](Get-Content -LiteralPath $path -Raw)).Trim()
  } catch { return 0 }
  if ($raw -match '^\d{1,10}$') { return [int]$raw }
  return 0
}

function Test-NodeProcess($proc) {
  return ($null -ne $proc -and [string]$proc.Name -ieq 'node.exe')
}

function Out-Bool([bool]$b) { if ($b) { return 'true' } return 'false' }

try {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $homeSet = -not [string]::IsNullOrWhiteSpace($env:PM2_HOME)
  if ($homeSet) {
    $pm2Home = $env:PM2_HOME
  } else {
    $profileRoot = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($profileRoot)) {
      $sysRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
      $profileRoot = Join-Path $sysRoot 'System32\config\systemprofile'
    }
    $pm2Home = Join-Path $profileRoot '.pm2'
  }
  $homeExists = Test-Path -LiteralPath $pm2Home -PathType Container

  # daemon
  $daemonPidFile = $homeExists -and (Test-Path -LiteralPath (Join-Path $pm2Home 'pm2.pid') -PathType Leaf)
  $daemonAlive = $false
  $daemonOwner = 'false'
  if ($daemonPidFile) {
    $dproc = Get-ProcessById (Read-PidFile (Join-Path $pm2Home 'pm2.pid'))
    if (Test-NodeProcess $dproc) {
      $daemonAlive = $true
      $daemonOwner = Get-OwnerIsCurrent $dproc $me
    }
  }

  # app
  $appFiles = @()
  $pidsDir = Join-Path $pm2Home 'pids'
  if ($homeExists -and (Test-Path -LiteralPath $pidsDir -PathType Container)) {
    $prefix = $AppName + '-'
    $appFiles = @(Get-ChildItem -LiteralPath $pidsDir -File -Filter '*.pid' | Where-Object {
        $_.Name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        ($_.Name.Substring($prefix.Length) -match '^\d+\.pid$')
      })
  }
  $appAlive = $false
  $appOwner = 'false'
  $appOwners = @()
  foreach ($f in $appFiles) {
    $aproc = Get-ProcessById (Read-PidFile $f.FullName)
    if (Test-NodeProcess $aproc) {
      $appAlive = $true
      $appOwners += (Get-OwnerIsCurrent $aproc $me)
    }
  }
  if ($appAlive) {
    if ($appOwners -contains 'unknown') { $appOwner = 'unknown' }
    elseif ($appOwners -contains 'false') { $appOwner = 'false' }
    else { $appOwner = 'true' }
  }

  # every pm2 process on the machine (daemon and the apps it spawned both name pm2 in the command line)
  $nodes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'")
  $pm2Total = 0; $pm2Mine = 0; $pm2Other = 0; $unreadable = 0
  foreach ($n in $nodes) {
    $cl = [string]$n.CommandLine
    if ([string]::IsNullOrEmpty($cl)) {
      # another account's process in a non-elevated window: neither its command line nor its owner is
      # readable, so it may or may not be pm2
      $unreadable++
      continue
    }
    if ($cl -notmatch '(?i)pm2') { continue }
    $pm2Total++
    $ow = Get-OwnerIsCurrent $n $me
    if ($ow -eq 'true') { $pm2Mine++ } elseif ($ow -eq 'false') { $pm2Other++ } else { $unreadable++ }
  }
  $otherUser = if ($pm2Other -gt 0) { 'true' } elseif ($unreadable -gt 0) { 'unknown' } else { 'false' }

  'PM2OWNER pm2_home_set=' + (Out-Bool $homeSet)
  'PM2OWNER pm2_home_exists=' + (Out-Bool $homeExists)
  'PM2OWNER daemon_pid_file=' + (Out-Bool $daemonPidFile)
  'PM2OWNER daemon_alive=' + (Out-Bool $daemonAlive)
  'PM2OWNER daemon_owner_is_current_user=' + $daemonOwner
  'PM2OWNER app_pid_file=' + (Out-Bool ($appFiles.Count -gt 0))
  'PM2OWNER app_alive=' + (Out-Bool $appAlive)
  'PM2OWNER app_owner_is_current_user=' + $appOwner
  'PM2OWNER other_user_pm2_process=' + $otherUser

  if ($Diag) {
    $names = @()
    if ($homeExists) { $names = @(Get-ChildItem -LiteralPath $pm2Home -Force | ForEach-Object { $_.Name } | Sort-Object) }
    'DIAG pm2_home_entries=' + ($names -join ',')
    'DIAG app_pid_files=' + $appFiles.Count
    'DIAG node_processes=' + $nodes.Count + ' pm2_processes=' + $pm2Total + ' pm2_mine=' + $pm2Mine + ' pm2_other=' + $pm2Other + ' unreadable=' + $unreadable
  }

  $owned = $homeExists -and $daemonAlive -and ($daemonOwner -eq 'true') -and $appAlive -and ($appOwner -eq 'true')
  if ($owned) {
    'PM2OWNER_RESULT owned=true status=complete'
  } elseif ($daemonOwner -eq 'unknown' -or $appOwner -eq 'unknown') {
    'PM2OWNER_RESULT owned=false status=incomplete reason=owner_unreadable'
  } elseif (-not $daemonAlive -and -not $appAlive -and $pm2Total -eq 0 -and $unreadable -eq 0) {
    'PM2OWNER_RESULT owned=false status=incomplete reason=no_pm2_process'
  } else {
    'PM2OWNER_RESULT owned=false status=complete'
  }
} catch {
  'PM2OWNER_RESULT owned=false status=incomplete reason=read_error'
  exit 3
}
