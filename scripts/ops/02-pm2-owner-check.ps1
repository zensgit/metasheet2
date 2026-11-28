# 02-pm2-owner-check.ps1 - values-free check that THIS Windows account owns the running
# metasheet-backend (install sheet step 2.3). Windows PowerShell 5.1, read-only.
#
# RUN (in the same PowerShell window that will run 03, then the install):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\02-pm2-owner-check.ps1
#
# owned=true covers two supported hosts. Both are checked from files, the process
# table and the scheduled task. This script never runs pm2: a pm2 command with
# nobody listening starts a new empty God.
#   god          <PM2_HOME>\pm2.pid names a live node.exe whose command line is
#                pm2\lib\Daemon.js, owned by this account; the app pid is live
#                and owned and is not a child of pm2-runtime; the pipe is present.
#                Any other live node.exe is not a God.
#   pm2-runtime  exactly one scheduled task -ScheduledTaskName (default
#                MetaSheet-PM2) is owned by this account and Running or Ready;
#                exactly one node.exe owned by this account has a pm2-runtime /
#                Runtime4Docker command line; the live app pid's parent is that
#                process; the pipe is present; no Daemon.js is in the way; the
#                home already has logs\, pids\, modules\ and module_conf.json.
# PM2_HOME when set is the home. When unset, <profile>\.pm2 is kept if it already
# holds pm2.pid, dump.pm2, or an app pid file. <profile>\.pm2-runtime is used only
# when that confirmed default tree is absent and the one task exists.
# A non-God pm2.pid does not hide the pm2-runtime path. This script never runs
# pm2. Run 03 only after owned=true status=complete. 03 runs jlist only then.
#
# OUTPUT: closed lines only. Never a path, account, PID, command line or value.
#   PM2OWNER pm2_home_set=true|false
#   PM2OWNER pm2_home_exists=true|false
#   PM2OWNER daemon_pid_file=true|false
#   PM2OWNER daemon_alive=true|false          pm2.pid names a live node.exe
#   PM2OWNER daemon_class=god|other|unknown|none
#   PM2OWNER daemon_owner_is_current_user=true|false|unknown
#   PM2OWNER app_pid_file=true|false
#   PM2OWNER app_alive=true|false
#   PM2OWNER app_owner_is_current_user=true|false|unknown
#   PM2OWNER other_user_pm2_process=true|false|unknown
#   PM2OWNER hosting=god|pm2-runtime|none
#   PM2OWNER runtime_task=present|absent|ambiguous|unknown
#   PM2OWNER runtime_task_state=running|ready|other|none|unknown
#   PM2OWNER runtime_process_owned=true|false|unknown
#   PM2OWNER rpc_pipe=present|absent|unknown
#   PM2OWNER stray_god=true|false|unknown
#   then the LAST line
#   PM2OWNER_RESULT owned=true|false status=complete
#   PM2OWNER_RESULT owned=false status=incomplete reason=<word>
# A run with no PM2OWNER_RESULT line did not finish. Never read a missing line as true.
# status=incomplete reasons: owner_unreadable, no_pm2_process, read_error, no_daemon,
# pipe_unknown, stray_daemon, host_ambiguous, task_not_running, app_not_under_runtime,
# app_not_under_god, pm2_home_not_initialized.
# status=complete owned=false means the check was read and this account is not the
# owner (historical). Do not run 03 unless owned=true.
#
# -CiProbe (CI only, never on site): replace the process table, the scheduled task
# and the pipe with a JSON fixture. The first line is then PM2OWNER_PROBE ci=true.
# A log that contains PM2OWNER_PROBE is not a field acceptance.
# -Diag (CI only, never on site): file names directly under the home, and counts.
param(
  [string]$AppName = 'metasheet-backend',
  [string]$ScheduledTaskName = 'MetaSheet-PM2',
  [string]$CiProbe = '',
  [switch]$Diag
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'onprem-live-env-lib.ps1')

function Invoke-Pm2OwnerCheck {
  try {
    if (-not [string]::IsNullOrWhiteSpace($CiProbe)) {
      Import-LiveEnvCiProbe -Path $CiProbe
      'PM2OWNER_PROBE ci=true'
    }
    $facts = Get-LiveEnvHostingFacts -AppName $AppName -ScheduledTaskName $ScheduledTaskName
    $decision = Resolve-LiveEnvHosting -Facts $facts

    'PM2OWNER pm2_home_set=' + (Format-LiveEnvBool ([bool]$facts.HomeSet))
    'PM2OWNER pm2_home_exists=' + (Format-LiveEnvBool ([bool]$facts.HomeExists))
    'PM2OWNER daemon_pid_file=' + (Format-LiveEnvBool ([bool]$facts.DaemonPidFile))
    'PM2OWNER daemon_alive=' + (Format-LiveEnvBool ([bool]$facts.DaemonAlive))
    'PM2OWNER daemon_class=' + [string]$facts.DaemonClass
    'PM2OWNER daemon_owner_is_current_user=' + [string]$facts.DaemonOwner
    'PM2OWNER app_pid_file=' + (Format-LiveEnvBool ([bool]$facts.AppPidFile))
    'PM2OWNER app_alive=' + (Format-LiveEnvBool ([bool]$facts.AppAlive))
    'PM2OWNER app_owner_is_current_user=' + [string]$facts.AppOwner
    'PM2OWNER other_user_pm2_process=' + [string]$facts.OtherUserPm2
    'PM2OWNER hosting=' + [string]$decision.Hosting
    'PM2OWNER runtime_task=' + [string]$facts.RuntimeTask
    'PM2OWNER runtime_task_state=' + [string]$facts.RuntimeTaskState
    'PM2OWNER runtime_process_owned=' + (Get-LiveEnvRuntimeOwnedWord -Facts $facts)
    'PM2OWNER rpc_pipe=' + [string]$facts.Pipe
    'PM2OWNER stray_god=' + [string]$facts.StrayGod

    if ($Diag) {
      $names = @()
      if ([bool]$facts.HomeExists -and -not [string]::IsNullOrWhiteSpace([string]$facts.ResolvedHome)) {
        $names = @(Get-ChildItem -LiteralPath ([string]$facts.ResolvedHome) -Force | ForEach-Object { $_.Name } | Sort-Object)
      }
      'DIAG pm2_home_entries=' + ($names -join ',')
      'DIAG runtime_process_count=' + [string]([int]$facts.RuntimeProcessCount)
    }

    if ([bool]$decision.Owned) {
      'PM2OWNER_RESULT owned=true status=complete'
    } elseif ([string]$decision.OwnerStatus -eq 'incomplete') {
      'PM2OWNER_RESULT owned=false status=incomplete reason=' + [string]$decision.OwnerReason
    } else {
      'PM2OWNER_RESULT owned=false status=complete'
    }
  } catch {
    'PM2OWNER_RESULT owned=false status=incomplete reason=read_error'
    exit 3
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-Pm2OwnerCheck
}
