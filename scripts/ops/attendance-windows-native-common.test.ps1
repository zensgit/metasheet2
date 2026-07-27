param(
  [string]$CommonScriptPath = (Join-Path $PSScriptRoot 'attendance-windows-native-common.ps1')
)

$ErrorActionPreference = 'Stop'
. $CommonScriptPath

$testRoot = Join-Path (
  [System.IO.Path]::GetTempPath()
) ("attendance-windows-native-common-test-{0}" -f [System.Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$fakePm2 = Join-Path $testRoot 'fake-pm2.ps1'
$envFixture = Join-Path $testRoot 'app.env'

@'
param(
  [string]$Action,
  [string]$Name
)

switch ($Action) {
  'jlist' {
    Write-Output '[{"name":"metasheet-backend","pm2_env":{"status":"online","username":"lower","USERNAME":"upper"}},{"name":"metasheet-windows-gateway","pm2_env":{"status":"online","username":"lower","USERNAME":"upper"}}]'
    exit 0
  }
  'describe' {
    if ($Name -in @('metasheet-backend', 'metasheet-windows-gateway')) {
      exit 0
    }
    exit 1
  }
  'pid' {
    if ($Name -eq 'metasheet-backend') {
      Write-Output '4242'
    } else {
      Write-Output '0'
    }
    exit 0
  }
  'delete' {
    exit 23
  }
  'save' {
    exit 0
  }
  default {
    exit 0
  }
}
'@ | Set-Content -LiteralPath $fakePm2 -Encoding utf8
'WINDOWS_NATIVE_IMPORT_PROBE=file-value' |
  Set-Content -LiteralPath $envFixture -Encoding ascii

try {
  $env:WINDOWS_NATIVE_IMPORT_PROBE = 'parent-value'
  $parsed = Import-WindowsNativeEnvFile -EnvFile $envFixture -NoExport
  if (
    $parsed['WINDOWS_NATIVE_IMPORT_PROBE'] -ne 'file-value' -or
    $env:WINDOWS_NATIVE_IMPORT_PROBE -ne 'parent-value'
  ) {
    throw 'NoExport changed the caller process environment'
  }
  Import-WindowsNativeEnvFile -EnvFile $envFixture | Out-Null
  if ($env:WINDOWS_NATIVE_IMPORT_PROBE -ne 'file-value') {
    throw 'Normal env import did not export the parsed value'
  }
  if (-not (Test-WindowsNativePm2AppExists -Pm2Command $fakePm2 -AppName 'metasheet-backend')) {
    throw 'PM2 existence probe rejected an existing app'
  }
  if (Test-WindowsNativePm2AppExists -Pm2Command $fakePm2 -AppName 'missing-app') {
    throw 'PM2 existence probe accepted a missing app'
  }
  if (-not (Test-WindowsNativePm2AppOnline -Pm2Command $fakePm2 -AppName 'metasheet-backend')) {
    throw 'PM2 online probe rejected a positive PID'
  }
  if (Test-WindowsNativePm2AppOnline -Pm2Command $fakePm2 -AppName 'metasheet-windows-gateway') {
    throw 'PM2 online probe accepted PID zero'
  }

  $failedClosed = $false
  try {
    Remove-WindowsNativePm2Apps `
      -Pm2Command $fakePm2 `
      -AppNames @('metasheet-windows-gateway', 'metasheet-backend')
  }
  catch {
    $failedClosed = (
      $_.Exception.Message -match 'PM2 cleanup failed' -and
      $_.Exception.Message -match 'metasheet-windows-gateway' -and
      $_.Exception.Message -match 'metasheet-backend' -and
      $_.Exception.Message -match 'exit 23'
    )
  }
  if (-not $failedClosed) {
    throw 'PM2 delete failure was not surfaced by Windows native cleanup'
  }
  Write-Host '[attendance-windows-native-common.test] PASS'
}
finally {
  Remove-Item Env:WINDOWS_NATIVE_IMPORT_PROBE -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
