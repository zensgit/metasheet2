param(
  [string]$Distro = "Ubuntu-22.04",
  [string]$ListenAddress = "0.0.0.0",
  [int[]]$Ports = @(80, 443),
  [switch]$SkipFirewall,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) {
  Write-Host "[attendance-wsl-portproxy-refresh] $Message"
}

function Throw-Err([string]$Message) {
  throw "[attendance-wsl-portproxy-refresh] ERROR: $Message"
}

function Require-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Throw-Err "Run this script in an elevated PowerShell window (Run as Administrator)."
  }
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Throw-Err "Missing required command: $Name"
  }
}

function Resolve-WslIp([string]$TargetDistro) {
  $raw = & wsl -d $TargetDistro -- hostname -I 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
    Throw-Err "Unable to resolve WSL IP for distro '$TargetDistro'. Ensure the distro exists and is running."
  }
  $token = (($raw -split "\s+") | Where-Object { $_ -and $_.Trim().Length -gt 0 } | Select-Object -First 1)
  if (-not $token) {
    Throw-Err "WSL IP output is empty for distro '$TargetDistro'."
  }
  if ($token -notmatch '^(?:\d{1,3}\.){3}\d{1,3}$') {
    Throw-Err "Invalid IPv4 from WSL: '$token'"
  }
  return $token
}

function Reset-PortProxy([string]$Addr, [int]$Port, [string]$TargetIp, [switch]$PreviewOnly) {
  $deleteCmd = "netsh interface portproxy delete v4tov4 listenaddress=$Addr listenport=$Port"
  $addCmd = "netsh interface portproxy add v4tov4 listenaddress=$Addr listenport=$Port connectaddress=$TargetIp connectport=$Port"

  Write-Info "Port $Port -> deleting old mapping (if exists)"
  if ($PreviewOnly) {
    Write-Host "  [what-if] $deleteCmd"
  } else {
    cmd /c $deleteCmd *> $null
  }

  Write-Info "Port $Port -> adding mapping to $TargetIp:$Port"
  if ($PreviewOnly) {
    Write-Host "  [what-if] $addCmd"
  } else {
    cmd /c $addCmd *> $null
  }
}

function Ensure-FirewallRule([int]$Port, [switch]$PreviewOnly) {
  $ruleName = "MetaSheet WSL TCP $Port"
  $delCmd = "netsh advfirewall firewall delete rule name=""$ruleName"""
  $addCmd = "netsh advfirewall firewall add rule name=""$ruleName"" dir=in action=allow protocol=TCP localport=$Port"

  Write-Info "Firewall port $Port -> resetting rule '$ruleName'"
  if ($PreviewOnly) {
    Write-Host "  [what-if] $delCmd"
    Write-Host "  [what-if] $addCmd"
  } else {
    cmd /c $delCmd *> $null
    cmd /c $addCmd *> $null
  }
}

function Show-CurrentMapping {
  Write-Info "Current portproxy rules:"
  netsh interface portproxy show v4tov4
}

Require-Admin
Require-Command "wsl"
Require-Command "netsh"

if (-not $Ports -or $Ports.Count -eq 0) {
  Throw-Err "Ports cannot be empty."
}

$wslIp = Resolve-WslIp -TargetDistro $Distro
Write-Info "Resolved WSL IP for '$Distro': $wslIp"

foreach ($port in $Ports) {
  if ($port -lt 1 -or $port -gt 65535) {
    Throw-Err "Invalid port: $port"
  }
  Reset-PortProxy -Addr $ListenAddress -Port $port -TargetIp $wslIp -PreviewOnly:$WhatIfOnly
  if (-not $SkipFirewall) {
    Ensure-FirewallRule -Port $port -PreviewOnly:$WhatIfOnly
  }
}

if (-not $WhatIfOnly) {
  Show-CurrentMapping
}

Write-Info "Done. Ports [$($Ports -join ',')] now point to WSL '$Distro' ($wslIp)."
