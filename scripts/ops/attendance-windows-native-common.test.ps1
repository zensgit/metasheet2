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
$pinDir = Join-Path $testRoot 'scripts\ops'
$pinPath = Join-Path $pinDir 'attendance-windows-native-qa-v2.pin.json'
$sourceSha = '0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b'
New-Item -ItemType Directory -Force -Path $pinDir | Out-Null
Set-Content -LiteralPath (Join-Path $testRoot 'SOURCE_SHA') -Value $sourceSha -Encoding ascii

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

  @{
    campaign = 'attendance-windows-native-qa-v2-20260804'
    expectedSourceSha = $sourceSha
    status = 'DRAFT_HOLD'
    deploymentAuthorized = $false
    syntheticDataOnly = $true
  } | ConvertTo-Json | Set-Content -LiteralPath $pinPath -Encoding ascii
  if ((Assert-WindowsNativeExactSourceSha -RootDir $testRoot) -ne $sourceSha) {
    throw 'Valid exact-SHA Draft/HOLD pin was rejected'
  }

  $differentSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  $overrideRejected = $false
  try {
    Assert-WindowsNativeExactSourceSha `
      -RootDir $testRoot `
      -ExpectedSourceSha $differentSha | Out-Null
  }
  catch {
    $overrideRejected = $_.Exception.Message -match 'override must match the QA pin'
  }
  if (-not $overrideRejected) {
    throw 'Explicit exact-SHA override bypassed the QA pin'
  }

  $env:ATTENDANCE_WINDOWS_NATIVE_EXPECTED_SOURCE_SHA = $differentSha
  $envOverrideRejected = $false
  try {
    Assert-WindowsNativeExactSourceSha -RootDir $testRoot | Out-Null
  }
  catch {
    $envOverrideRejected = $_.Exception.Message -match 'override must match the QA pin'
  }
  finally {
    Remove-Item Env:ATTENDANCE_WINDOWS_NATIVE_EXPECTED_SOURCE_SHA -ErrorAction SilentlyContinue
  }
  if (-not $envOverrideRejected) {
    throw 'Environment exact-SHA override bypassed the QA pin'
  }

  foreach ($mutant in @(
    @{
      campaign = 'attendance-windows-native-qa-v2-20260804'
      expectedSourceSha = $sourceSha
      status = 'READY'
      deploymentAuthorized = $false
      syntheticDataOnly = $true
    },
    @{
      campaign = 'attendance-windows-native-qa-v2-20260804'
      expectedSourceSha = $sourceSha
      status = 'DRAFT_HOLD'
      syntheticDataOnly = $true
    },
    @{
      campaign = 'attendance-windows-native-qa-v2-20260804'
      expectedSourceSha = $sourceSha
      status = 'DRAFT_HOLD'
      deploymentAuthorized = $false
    }
  )) {
    $mutant | ConvertTo-Json | Set-Content -LiteralPath $pinPath -Encoding ascii
    $pinRejected = $false
    try {
      Assert-WindowsNativeExactSourceSha -RootDir $testRoot | Out-Null
    }
    catch {
      $pinRejected = $true
    }
    if (-not $pinRejected) {
      throw 'Windows native exact-SHA helper accepted an incomplete or non-HOLD pin'
    }
  }
  Write-Host '[attendance-windows-native-common.test] PASS'
}
finally {
  Remove-Item Env:WINDOWS_NATIVE_IMPORT_PROBE -ErrorAction SilentlyContinue
  Remove-Item Env:ATTENDANCE_WINDOWS_NATIVE_EXPECTED_SOURCE_SHA -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
