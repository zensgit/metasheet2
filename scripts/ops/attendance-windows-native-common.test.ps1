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

@'
param(
  [string]$Action,
  [string]$Name
)

switch ($Action) {
  'jlist' {
    Write-Output '[{"name":"metasheet-backend","pm2_env":{"status":"online"}},{"name":"metasheet-windows-gateway","pm2_env":{"status":"online"}}]'
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

try {
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
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
