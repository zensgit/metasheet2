#requires -Version 5.0
<#
.SYNOPSIS
  Install or manage the MetaSheet readonly Bridge Agent as a Windows Scheduled Task.

.DESCRIPTION
  This helper keeps the BA-M1 readonly Bridge Agent alive after the operator's
  SSH or RDP session ends. It does not change the Bridge Agent protocol or SQL
  safety model; it only registers a localhost agent process to run as SYSTEM at
  startup.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')]
  [string]$Action = 'Install',

  [string]$RootDir = '',

  [string]$ConfigPath = 'C:\ProgramData\MetaSheet\BridgeAgent\config.json',

  [string]$TaskName = 'MetaSheetReadonlyBridgeAgent',

  [string]$TaskPath = '\MetaSheet\',

  [string]$PowerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe",

  [int]$Port = 19091,

  [switch]$StartAfterInstall
)

$ErrorActionPreference = 'Stop'

function Write-BridgeTaskInfo {
  param([string]$Message)
  Write-Host "[bridge-agent-readonly-task] $Message"
}

function Throw-BridgeTaskError {
  param([string]$Message)
  throw "[bridge-agent-readonly-task] ERROR: $Message"
}

function Require-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Throw-BridgeTaskError 'Run this script in an elevated PowerShell window (Run as Administrator).'
  }
}

function Ensure-ScheduledTaskModule {
  foreach ($command in @('Register-ScheduledTask', 'Get-ScheduledTask', 'Get-ScheduledTaskInfo')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
      Throw-BridgeTaskError "ScheduledTasks cmdlet unavailable: $command"
    }
  }
}

function Resolve-RootDirectory {
  if (-not [string]::IsNullOrWhiteSpace($RootDir)) {
    return (Resolve-Path -LiteralPath $RootDir).Path
  }

  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path -LiteralPath (Join-Path $scriptDir '..\..')).Path
}

function Resolve-AgentScript {
  param([string]$ResolvedRootDir)
  $candidate = Join-Path $ResolvedRootDir 'scripts\ops\bridge-agent-readonly.ps1'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    Throw-BridgeTaskError "Readonly Bridge Agent script not found: $candidate"
  }
  return (Resolve-Path -LiteralPath $candidate).Path
}

function Assert-TaskInputs {
  param(
    [string]$ResolvedRootDir,
    [string]$AgentScript
  )

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Throw-BridgeTaskError "Config file not found: $ConfigPath"
  }
  if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) {
    Throw-BridgeTaskError "PowerShell executable not found: $PowerShellPath"
  }
  if ($Port -lt 1 -or $Port -gt 65535) {
    Throw-BridgeTaskError "Port must be between 1 and 65535: $Port"
  }
  if ([string]::IsNullOrWhiteSpace($TaskName)) {
    Throw-BridgeTaskError 'TaskName is required.'
  }
  if ([string]::IsNullOrWhiteSpace($TaskPath)) {
    Throw-BridgeTaskError 'TaskPath is required.'
  }
  if (-not $TaskPath.StartsWith('\')) {
    Throw-BridgeTaskError 'TaskPath must start with a backslash, for example \MetaSheet\.'
  }
  if (-not $TaskPath.EndsWith('\')) {
    Throw-BridgeTaskError 'TaskPath must end with a backslash, for example \MetaSheet\.'
  }

  Write-BridgeTaskInfo "RootDir: $ResolvedRootDir"
  Write-BridgeTaskInfo "Agent script: $AgentScript"
  Write-BridgeTaskInfo "ConfigPath: $ConfigPath"
  Write-BridgeTaskInfo "Task: $TaskPath$TaskName"
}

function Build-AgentArguments {
  param([string]$AgentScript)
  return @(
    '-NoProfile',
    '-ExecutionPolicy Bypass',
    "-File `"$AgentScript`"",
    "-ConfigPath `"$ConfigPath`""
  ) -join ' '
}

function Test-LocalTcpPort {
  param([int]$TargetPort)
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect('127.0.0.1', $TargetPort, $null, $null)
    $connected = $async.AsyncWaitHandle.WaitOne(1000, $false)
    if (-not $connected) { return $false }
    $client.EndConnect($async)
    return $client.Connected
  } catch {
    return $false
  } finally {
    if ($null -ne $client) { $client.Close() }
  }
}

function Get-BridgeTask {
  return Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

function Install-BridgeTask {
  Ensure-ScheduledTaskModule
  $resolvedRootDir = Resolve-RootDirectory
  $agentScript = Resolve-AgentScript -ResolvedRootDir $resolvedRootDir
  Assert-TaskInputs -ResolvedRootDir $resolvedRootDir -AgentScript $agentScript

  $arguments = Build-AgentArguments -AgentScript $agentScript
  Write-BridgeTaskInfo 'Registering scheduled task as SYSTEM.'

  $taskAction = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $arguments -WorkingDirectory $resolvedRootDir
  $taskTrigger = New-ScheduledTaskTrigger -AtStartup
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
  $task = New-ScheduledTask -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings

  if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Register readonly Bridge Agent scheduled task')) {
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null
    Write-BridgeTaskInfo 'Task installed.'
    if ($StartAfterInstall) {
      Start-BridgeTask
    } else {
      Show-BridgeTaskStatus
    }
  }
}

function Start-BridgeTask {
  Ensure-ScheduledTaskModule
  if (-not (Get-BridgeTask)) {
    Throw-BridgeTaskError "Task not found: $TaskPath$TaskName"
  }
  if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Start readonly Bridge Agent task')) {
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Write-BridgeTaskInfo 'Task start requested.'
    Start-Sleep -Seconds 2
    Show-BridgeTaskStatus
  }
}

function Stop-BridgeTask {
  Ensure-ScheduledTaskModule
  if (-not (Get-BridgeTask)) {
    Write-BridgeTaskInfo "Task not found: $TaskPath$TaskName"
    return
  }
  if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Stop readonly Bridge Agent task')) {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Write-BridgeTaskInfo 'Task stop requested.'
    Show-BridgeTaskStatus
  }
}

function Uninstall-BridgeTask {
  Ensure-ScheduledTaskModule
  if (-not (Get-BridgeTask)) {
    Write-BridgeTaskInfo "Task not found: $TaskPath$TaskName"
    return
  }
  if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Unregister readonly Bridge Agent scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    Write-BridgeTaskInfo 'Task removed.'
  }
}

function Show-BridgeTaskStatus {
  Ensure-ScheduledTaskModule
  $task = Get-BridgeTask
  if (-not $task) {
    Write-BridgeTaskInfo "Task not found: $TaskPath$TaskName"
    return
  }

  $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath
  Write-BridgeTaskInfo "Task: $TaskPath$TaskName"
  Write-BridgeTaskInfo "State: $($task.State)"
  Write-BridgeTaskInfo "LastRunTime: $($info.LastRunTime)"
  Write-BridgeTaskInfo "LastTaskResult: $($info.LastTaskResult)"
  Write-BridgeTaskInfo "NextRunTime: $($info.NextRunTime)"

  if (Test-LocalTcpPort -TargetPort $Port) {
    Write-BridgeTaskInfo "Local TCP listener: 127.0.0.1:$Port reachable"
  } else {
    Write-BridgeTaskInfo "Local TCP listener: 127.0.0.1:$Port not reachable"
  }
}

Require-Admin

switch ($Action) {
  'Install' { Install-BridgeTask }
  'Start' { Start-BridgeTask }
  'Stop' { Stop-BridgeTask }
  'Status' { Show-BridgeTaskStatus }
  'Uninstall' { Uninstall-BridgeTask }
  default { Throw-BridgeTaskError "Unknown action: $Action" }
}
