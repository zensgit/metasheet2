param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'attendance-windows-native-common.ps1')

$resolvedRoot = Resolve-WindowsNativeRoot -Candidate $RootDir
$pm2Command = Resolve-WindowsNativePm2Command -RootDir $resolvedRoot

# PM2 writes non-fatal warnings to stderr on Windows PowerShell 5.1. Native
# command success remains fail-closed through the explicit exit-code checks.
$ErrorActionPreference = 'Continue'
$changed = $false

foreach ($appName in @('metasheet-windows-gateway', 'metasheet-backend')) {
  $app = Get-WindowsNativePm2Process -Pm2Command $pm2Command -AppName $appName
  if ($null -eq $app) {
    Write-Host "[attendance-windows-native-stop] already stopped: $appName"
    continue
  }
  & $pm2Command delete $appName
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to stop PM2 app: $appName"
  }
  $changed = $true
  Write-Host "[attendance-windows-native-stop] stopped: $appName"
}

if ($changed) {
  & $pm2Command save
  if ($LASTEXITCODE -ne 0) {
    throw 'pm2 save failed'
  }
}

Write-Host '[attendance-windows-native-stop] DONE'
