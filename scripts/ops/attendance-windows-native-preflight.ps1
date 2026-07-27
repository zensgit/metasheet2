param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [bool]$RequireRedis = $false
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'attendance-windows-native-common.ps1')

$resolvedRoot = Resolve-WindowsNativeRoot -Candidate $RootDir
$envFile = Resolve-WindowsNativeEnvFile -RootDir $resolvedRoot
$envValues = Import-WindowsNativeEnvFile -EnvFile $envFile

foreach ($requiredName in @(
  'DATABASE_URL',
  'JWT_SECRET',
  'HOST',
  'PORT',
  'PRODUCT_MODE',
  'DEPLOYMENT_MODEL',
  'ATTENDANCE_IMPORT_UPLOAD_DIR',
  'WINDOWS_NATIVE_GATEWAY_HOST',
  'WINDOWS_NATIVE_GATEWAY_PORT',
  'WINDOWS_NATIVE_BACKEND_ORIGIN'
)) {
  if (-not $envValues.ContainsKey($requiredName) -or [string]::IsNullOrWhiteSpace($envValues[$requiredName])) {
    throw "Missing required environment value: $requiredName"
  }
  if ($envValues[$requiredName] -match '(?i)change-me|replace-me|<.+>') {
    throw "Placeholder value is not allowed for $requiredName"
  }
}

if ($envValues['PRODUCT_MODE'] -ne 'attendance') {
  throw 'PRODUCT_MODE must be attendance'
}
if ($envValues['DEPLOYMENT_MODEL'] -ne 'onprem') {
  throw 'DEPLOYMENT_MODEL must be onprem'
}
if ($envValues['JWT_SECRET'].Length -lt 32) {
  throw 'JWT_SECRET must be at least 32 characters'
}
if (-not $envValues.ContainsKey('BCRYPT_SALT_ROUNDS') -or $envValues['BCRYPT_SALT_ROUNDS'] -notmatch '^[0-9]+$') {
  throw 'BCRYPT_SALT_ROUNDS must be numeric'
}
if ([int]$envValues['BCRYPT_SALT_ROUNDS'] -lt 12) {
  throw 'BCRYPT_SALT_ROUNDS must be at least 12'
}

Assert-WindowsNativeLoopbackHost -Label 'HOST' -HostName $envValues['HOST']
Assert-WindowsNativeLoopbackHost `
  -Label 'WINDOWS_NATIVE_GATEWAY_HOST' `
  -HostName $envValues['WINDOWS_NATIVE_GATEWAY_HOST']

$backendPort = 0
$gatewayPort = 0
if (-not [int]::TryParse($envValues['PORT'], [ref]$backendPort) -or $backendPort -lt 1 -or $backendPort -gt 65535) {
  throw 'PORT must be an integer between 1 and 65535'
}
if (
  -not [int]::TryParse($envValues['WINDOWS_NATIVE_GATEWAY_PORT'], [ref]$gatewayPort) -or
  $gatewayPort -lt 1 -or
  $gatewayPort -gt 65535
) {
  throw 'WINDOWS_NATIVE_GATEWAY_PORT must be an integer between 1 and 65535'
}
if ($backendPort -eq $gatewayPort) {
  throw 'PORT and WINDOWS_NATIVE_GATEWAY_PORT must be different'
}

$backendOrigin = [System.Uri]$envValues['WINDOWS_NATIVE_BACKEND_ORIGIN']
Assert-WindowsNativeLoopbackHost `
  -Label 'WINDOWS_NATIVE_BACKEND_ORIGIN' `
  -HostName $backendOrigin.Host
if (
  $backendOrigin.Scheme -ne 'http' -or
  $backendOrigin.Port -ne $backendPort -or
  $backendOrigin.AbsolutePath -ne '/' -or
  -not [string]::IsNullOrWhiteSpace($backendOrigin.Query) -or
  -not [string]::IsNullOrWhiteSpace($backendOrigin.Fragment) -or
  -not [string]::IsNullOrWhiteSpace($backendOrigin.UserInfo)
) {
  throw 'WINDOWS_NATIVE_BACKEND_ORIGIN must be the local HTTP backend origin with no path, query, credentials, or fragment'
}

$allowedAttendanceEnv = @(
  'ATTENDANCE_IMPORT_REQUIRE_TOKEN',
  'ATTENDANCE_IMPORT_UPLOAD_DIR',
  'ATTENDANCE_IMPORT_CSV_MAX_ROWS',
  'ATTENDANCE_IMPORT_HEAVY_QUERY_TIMEOUT_MS',
  'ATTENDANCE_IMPORT_JSON_LIMIT'
)
$forbiddenExternalPrefixes = @(
  'DINGTALK_',
  'FEISHU_',
  'WECOM_',
  'MULTITABLE_EMAIL_SMTP_'
)
$forbiddenExternalNames = @(
  'ALERT_WEBHOOK_URL',
  'DIRECTORY_SYNC_ALERT_WEBHOOK',
  'DIRECTORY_SYNC_ALERT_WEBHOOK_SECRET',
  'ENABLE_WEBHOOK'
)
foreach ($name in $envValues.Keys) {
  $value = [string]$envValues[$name]
  if ([string]::IsNullOrWhiteSpace($value)) {
    continue
  }
  if ($name.StartsWith('ATTENDANCE_') -and $name -notin $allowedAttendanceEnv) {
    throw "Attendance opt-in is forbidden in the Windows internal QA package: $name"
  }
  foreach ($prefix in $forbiddenExternalPrefixes) {
    if ($name.StartsWith($prefix)) {
      throw "External integration configuration is forbidden in the Windows internal QA package: $name"
    }
  }
  if ($name -in $forbiddenExternalNames) {
    throw "External delivery configuration is forbidden in the Windows internal QA package: $name"
  }
}

Require-WindowsNativeCommand -Name 'node' | Out-Null
Require-WindowsNativeCommand -Name 'pnpm' | Out-Null
Resolve-WindowsNativePm2Command -RootDir $resolvedRoot | Out-Null
Assert-WindowsNativeTcpPortAvailable -Label 'Backend' -Port $backendPort
Assert-WindowsNativeTcpPortAvailable -Label 'Gateway' -Port $gatewayPort

$nodeVersion = (& node --version | Out-String).Trim()
$pnpmVersion = (& pnpm --version | Out-String).Trim()
Assert-WindowsNativeMinimumMajor -Label 'Node.js' -Version $nodeVersion -MinimumMajor 20
Assert-WindowsNativeMinimumMajor -Label 'pnpm' -Version $pnpmVersion -MinimumMajor 9

$databaseEndpoint = Resolve-WindowsNativeDatabaseEndpoint -DatabaseUrl $envValues['DATABASE_URL']
if (-not (Test-WindowsNativeTcpEndpoint -HostName $databaseEndpoint.HostName -Port $databaseEndpoint.Port)) {
  throw "PostgreSQL is unreachable at $($databaseEndpoint.HostName):$($databaseEndpoint.Port)"
}

if ($RequireRedis) {
  $redisEndpoint = Resolve-WindowsNativeRedisEndpoint -EnvValues $envValues
  if (-not (Test-WindowsNativeTcpEndpoint -HostName $redisEndpoint.HostName -Port $redisEndpoint.Port)) {
    throw "Redis-compatible service is unreachable at $($redisEndpoint.HostName):$($redisEndpoint.Port)"
  }
}

$uploadDir = $envValues['ATTENDANCE_IMPORT_UPLOAD_DIR']
if (-not [System.IO.Path]::IsPathRooted($uploadDir)) {
  $uploadDir = Join-Path $resolvedRoot $uploadDir
}
New-Item -ItemType Directory -Force -Path $uploadDir | Out-Null

$webEntry = Join-Path $resolvedRoot 'apps\web\dist\index.html'
$backendEntry = Join-Path $resolvedRoot 'packages\core-backend\dist\src\index.js'
$migrationEntry = Join-Path $resolvedRoot 'packages\core-backend\dist\src\db\migrate.js'
$gatewayEntry = Join-Path $resolvedRoot 'scripts\ops\attendance-windows-native-gateway.mjs'
foreach ($entry in @($webEntry, $backendEntry, $migrationEntry, $gatewayEntry)) {
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "Package entrypoint is missing: $entry"
  }
}

Write-Host '[attendance-windows-native-preflight] OK'
Write-Host "  root: $resolvedRoot"
Write-Host "  node: $nodeVersion"
Write-Host "  pnpm: $pnpmVersion"
Write-Host "  postgres: $($databaseEndpoint.HostName):$($databaseEndpoint.Port)"
if ($RequireRedis) {
  $redisEndpoint = Resolve-WindowsNativeRedisEndpoint -EnvValues $envValues
  Write-Host "  redis: $($redisEndpoint.HostName):$($redisEndpoint.Port)"
}
Write-Host "  gateway: $(Get-WindowsNativeGatewayUrl -EnvValues $envValues)"
