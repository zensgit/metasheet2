param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [bool]$RequireRedis = $false,
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'attendance-windows-native-common.ps1')

$resolvedRoot = Resolve-WindowsNativeRoot -Candidate $RootDir
Set-Location $resolvedRoot

& (Join-Path $PSScriptRoot 'attendance-windows-native-preflight.ps1') `
  -RootDir $resolvedRoot `
  -RequireRedis $RequireRedis

$envFile = Resolve-WindowsNativeEnvFile -RootDir $resolvedRoot
$envValues = Import-WindowsNativeEnvFile -EnvFile $envFile
$pm2Command = Resolve-WindowsNativePm2Command -RootDir $resolvedRoot

# Windows PowerShell 5.1 promotes native stderr warnings to error records when
# Stop is active. Every PM2 call below is guarded by an explicit exit-code check.
$ErrorActionPreference = 'Continue'

foreach ($appName in @('metasheet-backend', 'metasheet-windows-gateway')) {
  if ($null -ne (Get-WindowsNativePm2Process -Pm2Command $pm2Command -AppName $appName)) {
    throw "PM2 app already exists: $appName. Run windows-native-stop.bat before starting again."
  }
}

$gatewayConfig = Join-Path $resolvedRoot 'ecosystem.windows-native.config.cjs'
try {
  & (Join-Path $PSScriptRoot 'attendance-onprem-deploy-run.ps1') `
    -RootDir $resolvedRoot `
    -RunLabel 'windows-native-qa'

  if (-not (Test-Path -LiteralPath $gatewayConfig -PathType Leaf)) {
    throw "Missing Windows gateway PM2 config: $gatewayConfig"
  }

  & $pm2Command start $gatewayConfig `
    --only 'metasheet-windows-gateway' `
    --env production `
    --update-env
  if ($LASTEXITCODE -ne 0) {
    throw 'Windows native gateway startup failed'
  }

  & $pm2Command save
  if ($LASTEXITCODE -ne 0) {
    throw 'pm2 save failed'
  }

  $gatewayUrl = Get-WindowsNativeGatewayUrl -EnvValues $envValues
  $healthScript = Join-Path $PSScriptRoot 'attendance-windows-native-healthcheck.ps1'
  $lastError = $null
  for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    try {
      & $healthScript -RootDir $resolvedRoot -Quiet
      $lastError = $null
      break
    }
    catch {
      $lastError = $_
      Start-Sleep -Seconds 1
    }
  }
  if ($null -ne $lastError) {
    throw "Windows native healthcheck did not become ready: $($lastError.Exception.Message)"
  }

  Write-Host '[attendance-windows-native-start] READY'
  Write-Host "  attendance: $gatewayUrl/attendance"
  Write-Host "  health: $gatewayUrl/health"
  Write-Host '  stop: windows-native-stop.bat'

  if ($OpenBrowser) {
    Start-Process "$gatewayUrl/attendance"
  }
}
catch {
  $startupError = $_
  try {
    Remove-WindowsNativePm2Apps `
      -Pm2Command $pm2Command `
      -AppNames @('metasheet-windows-gateway', 'metasheet-backend')
  }
  catch {
    throw "Windows native startup failed: $($startupError.Exception.Message). Cleanup also failed: $($_.Exception.Message)"
  }
  throw $startupError
}
