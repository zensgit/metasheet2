$ErrorActionPreference = 'Stop'

function Resolve-WindowsNativeRoot {
  param([string]$Candidate)

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw 'RootDir is empty after normalization'
  }
  if (-not (Test-Path -LiteralPath $trimmed -PathType Container)) {
    throw "RootDir does not exist: $trimmed"
  }
  return [System.IO.Path]::GetFullPath($trimmed)
}

function Resolve-WindowsNativeEnvFile {
  param([string]$RootDir)

  foreach ($candidate in @(
    (Join-Path $RootDir 'docker\app.env'),
    (Join-Path $RootDir 'app.env')
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw "Missing docker\app.env. Copy docker\app.env.attendance-windows-native.qa.example first."
}

function Import-WindowsNativeEnvFile {
  param(
    [string]$EnvFile,
    [switch]$NoExport
  )

  $values = @{}
  foreach ($rawLine in Get-Content -LiteralPath $EnvFile) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
      continue
    }
    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) {
      continue
    }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    $values[$name] = $value
    if (-not $NoExport) {
      Set-Item -Path ("Env:{0}" -f $name) -Value $value
    }
  }
  return $values
}

function Require-WindowsNativeCommand {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw "Missing required command: $Name"
  }
  return $command
}

function Resolve-WindowsNativePm2Command {
  param([string]$RootDir)

  $localPm2 = Join-Path $RootDir 'node_modules\.bin\pm2.cmd'
  if (Test-Path -LiteralPath $localPm2 -PathType Leaf) {
    return $localPm2
  }
  $command = Get-Command 'pm2.cmd' -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $command = Get-Command 'pm2' -ErrorAction SilentlyContinue
  }
  if ($null -eq $command) {
    throw 'Missing pm2. Install it with: npm install --global pm2'
  }
  return $command.Source
}

function Assert-WindowsNativeMinimumMajor {
  param(
    [string]$Label,
    [string]$Version,
    [int]$MinimumMajor
  )

  $normalized = $Version.Trim().TrimStart('v')
  $majorText = ($normalized -split '\.')[0]
  $major = 0
  if (-not [int]::TryParse($majorText, [ref]$major)) {
    throw "Unable to parse $Label version: $Version"
  }
  if ($major -lt $MinimumMajor) {
    throw "$Label $Version is unsupported; major version $MinimumMajor or newer is required"
  }
}

function Test-WindowsNativeTcpEndpoint {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 3000
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    if (-not $task.Wait($TimeoutMs)) {
      return $false
    }
    return $client.Connected
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

function Assert-WindowsNativeLoopbackHost {
  param(
    [string]$Label,
    [string]$HostName
  )

  if ($HostName -notin @('127.0.0.1', 'localhost', '::1')) {
    throw "$Label must use a loopback host; got: $HostName"
  }
}

function Assert-WindowsNativeTcpPortAvailable {
  param(
    [string]$Label,
    [int]$Port
  )

  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new(
      [System.Net.IPAddress]::Loopback,
      $Port
    )
    $listener.Start()
  }
  catch {
    throw "$Label port is unavailable on 127.0.0.1:${Port}"
  }
  finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

function Resolve-WindowsNativeDatabaseEndpoint {
  param([string]$DatabaseUrl)

  $match = [regex]::Match(
    $DatabaseUrl,
    '^postgres(?:ql)?://[^@/]+@(?<host>\[[^\]]+\]|[^:/]+)(?::(?<port>\d+))?/'
  )
  if (-not $match.Success) {
    throw 'DATABASE_URL must be an explicit postgres://user:password@host:port/database URL'
  }
  $hostName = $match.Groups['host'].Value.Trim('[', ']')
  $port = 5432
  if ($match.Groups['port'].Success) {
    $port = [int]$match.Groups['port'].Value
  }
  return @{
    HostName = $hostName
    Port = $port
  }
}

function Resolve-WindowsNativeRedisEndpoint {
  param([hashtable]$EnvValues)

  if ($EnvValues.ContainsKey('REDIS_URL') -and -not [string]::IsNullOrWhiteSpace($EnvValues['REDIS_URL'])) {
    $uri = [System.Uri]$EnvValues['REDIS_URL']
    $port = if ($uri.Port -gt 0) { $uri.Port } else { 6379 }
    return @{
      HostName = $uri.Host
      Port = $port
    }
  }

  $hostName = if ($EnvValues.ContainsKey('REDIS_HOST')) { $EnvValues['REDIS_HOST'] } else { '127.0.0.1' }
  $port = if ($EnvValues.ContainsKey('REDIS_PORT')) { [int]$EnvValues['REDIS_PORT'] } else { 6379 }
  return @{
    HostName = $hostName
    Port = $port
  }
}

function Get-WindowsNativeGatewayUrl {
  param([hashtable]$EnvValues)

  $hostName = if ($EnvValues.ContainsKey('WINDOWS_NATIVE_GATEWAY_HOST')) {
    $EnvValues['WINDOWS_NATIVE_GATEWAY_HOST']
  } else {
    '127.0.0.1'
  }
  if ($hostName -eq '0.0.0.0') {
    $hostName = '127.0.0.1'
  }
  $port = if ($EnvValues.ContainsKey('WINDOWS_NATIVE_GATEWAY_PORT')) {
    [int]$EnvValues['WINDOWS_NATIVE_GATEWAY_PORT']
  } else {
    8080
  }
  return "http://${hostName}:${port}"
}

function Get-WindowsNativePm2Process {
  param(
    [string]$Pm2Command,
    [string]$AppName
  )

  $raw = (& $Pm2Command jlist 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }
  try {
    return @($raw | ConvertFrom-Json) |
      Where-Object { $_.name -eq $AppName } |
      Select-Object -First 1
  }
  catch {
    return $null
  }
}

function Remove-WindowsNativePm2Apps {
  param(
    [string]$Pm2Command,
    [string[]]$AppNames
  )

  $cleanupErrors = New-Object System.Collections.Generic.List[string]
  foreach ($appName in $AppNames) {
    if ($null -eq (Get-WindowsNativePm2Process -Pm2Command $Pm2Command -AppName $appName)) {
      continue
    }
    & $Pm2Command delete $appName *> $null
    if ($LASTEXITCODE -ne 0) {
      $cleanupErrors.Add("pm2 delete failed for $appName (exit $LASTEXITCODE)")
    }
  }

  & $Pm2Command save *> $null
  if ($LASTEXITCODE -ne 0) {
    $cleanupErrors.Add("pm2 save failed (exit $LASTEXITCODE)")
  }

  if ($cleanupErrors.Count -gt 0) {
    throw "PM2 cleanup failed: $($cleanupErrors -join '; ')"
  }
}
