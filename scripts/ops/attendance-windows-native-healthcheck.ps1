param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'attendance-windows-native-common.ps1')

$resolvedRoot = Resolve-WindowsNativeRoot -Candidate $RootDir
$envFile = Resolve-WindowsNativeEnvFile -RootDir $resolvedRoot
$envValues = Import-WindowsNativeEnvFile -EnvFile $envFile
$pm2Command = Resolve-WindowsNativePm2Command -RootDir $resolvedRoot

foreach ($appName in @('metasheet-backend', 'metasheet-windows-gateway')) {
  if (-not (Test-WindowsNativePm2AppOnline -Pm2Command $pm2Command -AppName $appName)) {
    throw "PM2 app is not online: $appName"
  }
}

$gatewayUrl = Get-WindowsNativeGatewayUrl -EnvValues $envValues
$health = Invoke-WebRequest `
  -Uri "$gatewayUrl/health" `
  -UseBasicParsing `
  -TimeoutSec 10
if ($health.StatusCode -ne 200) {
  throw "Gateway health returned HTTP $($health.StatusCode)"
}
$healthPayload = $health.Content | ConvertFrom-Json
if ($healthPayload.status -ne 'ok') {
  throw 'Backend health payload does not report status=ok'
}

$attendance = Invoke-WebRequest `
  -Uri "$gatewayUrl/attendance" `
  -UseBasicParsing `
  -TimeoutSec 10
if ($attendance.StatusCode -ne 200) {
  throw "Attendance page returned HTTP $($attendance.StatusCode)"
}
if ($attendance.Content -notmatch '<div id="app"></div>') {
  throw 'Attendance page does not contain the packaged Vue application root'
}

if (-not $Quiet) {
  Write-Host '[attendance-windows-native-healthcheck] PASS'
  Write-Host "  health: $gatewayUrl/health"
  Write-Host "  attendance: $gatewayUrl/attendance"
}
