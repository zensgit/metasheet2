param(
  [ValidateSet("Install", "Uninstall", "Status", "RunNow")]
  [string]$Action = "Install",
  [string]$TaskName = "MetaSheet-WSL-PortProxy-Refresh",
  [string]$Distro = "Ubuntu-22.04",
  [string]$ListenAddress = "0.0.0.0",
  [int[]]$Ports = @(80, 443),
  [int]$DelaySeconds = 20,
  [switch]$SkipFirewall,
  [string]$RefreshScriptPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) {
  Write-Host "[attendance-wsl-portproxy-task] $Message"
}

function Throw-Err([string]$Message) {
  throw "[attendance-wsl-portproxy-task] ERROR: $Message"
}

function Require-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Throw-Err "Run this script in an elevated PowerShell window (Run as Administrator)."
  }
}

function Resolve-RefreshScriptPath([string]$InputPath) {
  if ($InputPath -and $InputPath.Trim().Length -gt 0) {
    return (Resolve-Path $InputPath).Path
  }
  $selfDir = Split-Path -Parent $PSCommandPath
  $candidate = Join-Path $selfDir "attendance-wsl-portproxy-refresh.ps1"
  if (-not (Test-Path $candidate)) {
    Throw-Err "Cannot find refresh script: $candidate. Use -RefreshScriptPath to specify it."
  }
  return (Resolve-Path $candidate).Path
}

function Build-RefreshArguments([string]$ScriptPath) {
  if (-not $Ports -or $Ports.Count -eq 0) {
    Throw-Err "Ports cannot be empty."
  }

  foreach ($port in $Ports) {
    if ($port -lt 1 -or $port -gt 65535) {
      Throw-Err "Invalid port: $port"
    }
  }

  if ($DelaySeconds -lt 0 -or $DelaySeconds -gt 3600) {
    Throw-Err "DelaySeconds must be between 0 and 3600."
  }

  $portArg = ($Ports | ForEach-Object { [string]$_ }) -join " "
  $args = @(
    "-NoProfile"
    "-ExecutionPolicy Bypass"
    "-File `"$ScriptPath`""
    "-Distro `"$Distro`""
    "-ListenAddress `"$ListenAddress`""
    "-Ports $portArg"
  )

  if ($SkipFirewall) {
    $args += "-SkipFirewall"
  }

  return ($args -join " ")
}

function Ensure-ScheduledTaskModule {
  if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    Throw-Err "ScheduledTasks module/cmdlets are not available on this host."
  }
}

function Install-Task {
  Ensure-ScheduledTaskModule
  $refreshScript = Resolve-RefreshScriptPath -InputPath $RefreshScriptPath
  $arguments = Build-RefreshArguments -ScriptPath $refreshScript

  Write-Info "Registering scheduled task '$TaskName'"
  Write-Info "Target refresh script: $refreshScript"
  Write-Info "Arguments: $arguments"

  $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
  $taskTrigger = New-ScheduledTaskTrigger -AtStartup
  if ($DelaySeconds -gt 0) {
    $taskTrigger.Delay = "PT${DelaySeconds}S"
  }

  $taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable
  $task = New-ScheduledTask -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings

  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  Write-Info "Task installed."
  Show-Status
}

function Uninstall-Task {
  Ensure-ScheduledTaskModule
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Info "Task removed: $TaskName"
  } else {
    Write-Info "Task not found: $TaskName"
  }
}

function Show-Status {
  Ensure-ScheduledTaskModule
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Info "Task not found: $TaskName"
    return
  }

  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Info "Task: $TaskName"
  Write-Info "State: $($task.State)"
  Write-Info "LastRunTime: $($info.LastRunTime)"
  Write-Info "LastTaskResult: $($info.LastTaskResult)"
  Write-Info "NextRunTime: $($info.NextRunTime)"
}

function Run-TaskNow {
  Ensure-ScheduledTaskModule
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Throw-Err "Task not found: $TaskName"
  }
  Start-ScheduledTask -TaskName $TaskName
  Write-Info "Task triggered: $TaskName"
}

Require-Admin

switch ($Action) {
  "Install" { Install-Task }
  "Uninstall" { Uninstall-Task }
  "Status" { Show-Status }
  "RunNow" { Run-TaskNow }
  default { Throw-Err "Unknown action: $Action" }
}
