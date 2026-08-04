param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [Parameter(Mandatory = $true)]
  [string]$AdminEmail,
  [Parameter(Mandatory = $true)]
  [string]$AdminPassword,
  [string]$AdminName = 'Administrator',
  [string]$PsqlPath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'attendance-windows-native-common.ps1')

$resolvedRoot = Resolve-WindowsNativeRoot -Candidate $RootDir
$envFile = Resolve-WindowsNativeEnvFile -RootDir $resolvedRoot
$envValues = Import-WindowsNativeEnvFile -EnvFile $envFile
$gatewayUrl = Get-WindowsNativeGatewayUrl -EnvValues $envValues
$bootstrapScript = Join-Path $PSScriptRoot 'multitable-onprem-bootstrap-admin.ps1'
if (-not (Test-Path -LiteralPath $bootstrapScript -PathType Leaf)) {
  throw "Missing packaged PowerShell admin bootstrap: $bootstrapScript"
}

& $bootstrapScript `
  -RootDir $resolvedRoot `
  -EnvFile $envFile `
  -ApiBase "$gatewayUrl/api" `
  -PsqlPath $PsqlPath `
  -AdminEmail $AdminEmail `
  -AdminPassword $AdminPassword `
  -AdminName $AdminName `
  -VerifyLogin '1'

Write-Host '[attendance-windows-native-bootstrap-admin] PASS'
Write-Host "  email: $AdminEmail"
Write-Host "  login: $gatewayUrl/login"
