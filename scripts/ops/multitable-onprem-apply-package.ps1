param(
  [Parameter(Mandatory = $true)]
  [string]$PackageArchive,
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$EnvFile = '',
  [string]$ApiBase = 'http://127.0.0.1/api',
  [string]$BaseUrl = 'http://127.0.0.1',
  [string]$CheckNginx = '1',
  [string]$RunHealthcheck = '1',
  [string]$InstallDeps = '1',
  [string]$BuildWeb = '0',
  [string]$BuildBackend = '0',
  [string]$RunMigrations = '1',
  [string]$RestartService = '1',
  [string]$DependencyRefreshTimeoutSec = '1800',
  [string]$DependencyRefreshHeartbeatSec = '60'
)

$ErrorActionPreference = 'Stop'

function Resolve-NormalizedPath {
  param(
    [string]$Candidate,
    [string]$Label = 'Path'
  )

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw "$Label is empty after normalization"
  }

  if (-not (Test-Path -LiteralPath $trimmed)) {
    throw "$Label does not exist: $trimmed"
  }

  return [System.IO.Path]::GetFullPath($trimmed)
}

function Write-Info {
  param([string]$Message)
  Write-Host "[multitable-onprem-apply-package] $Message"
}

function New-ShortTempDirectory {
  param([string]$Prefix = 'mspa')

  $tempBase = [System.IO.Path]::GetTempPath()
  if ([string]::IsNullOrWhiteSpace($tempBase) -or -not (Test-Path -LiteralPath $tempBase)) {
    throw 'System temp directory is unavailable'
  }

  for ($index = 0; $index -lt 5; $index += 1) {
    $candidate = Join-Path $tempBase ($Prefix + '-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
    if (-not (Test-Path -LiteralPath $candidate)) {
      New-Item -ItemType Directory -Force -Path $candidate | Out-Null
      return $candidate
    }
  }

  throw "Failed to allocate a temporary directory under $tempBase"
}

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Resolve-CommandPath {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) {
    throw "Missing required command: $Name"
  }

  return $command.Source
}

function Convert-PositiveInt {
  param(
    [string]$Value,
    [string]$Label
  )

  $parsed = 0
  if (-not [int]::TryParse($Value, [ref]$parsed) -or $parsed -lt 1) {
    throw "$Label must be a positive integer: $Value"
  }

  return $parsed
}

function Invoke-CheckedCommand {
  param(
    [string]$Description,
    [scriptblock]$Command
  )

  Write-Info $Description
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed"
  }
}

function Write-LogTail {
  param(
    [string]$Path,
    [string]$Label,
    [int]$LineCount = 20
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Info "$Label log is unavailable: $Path"
    return
  }

  Write-Info "$Label log tail ($Path):"
  Get-Content -LiteralPath $Path -Tail $LineCount | ForEach-Object {
    Write-Host "  $_"
  }
}

function Invoke-LoggedProcess {
  param(
    [string]$Description,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [string]$LogPrefix,
    [int]$TimeoutSec,
    [int]$HeartbeatSec
  )

  $stdoutLog = "$LogPrefix.stdout.log"
  $stderrLog = "$LogPrefix.stderr.log"
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

  Write-Info $Description
  Write-Info "Command: $FilePath $($Arguments -join ' ')"
  Write-Info "Working directory: $WorkingDirectory"
  Write-Info "Timeout: ${TimeoutSec}s; heartbeat: ${HeartbeatSec}s"
  Write-Info "stdout log: $stdoutLog"
  Write-Info "stderr log: $stderrLog"

  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  $startedAt = Get-Date
  $nextHeartbeatAt = $startedAt.AddSeconds($HeartbeatSec)

  while (-not $process.HasExited) {
    Start-Sleep -Seconds 5
    $now = Get-Date
    $elapsedSec = [int]($now - $startedAt).TotalSeconds

    if ($elapsedSec -ge $TimeoutSec) {
      try {
        $process.Kill()
      }
      catch {
        Write-Info "Failed to kill timed-out process pid=$($process.Id): $($_.Exception.Message)"
      }

      Write-LogTail -Path $stdoutLog -Label 'stdout'
      Write-LogTail -Path $stderrLog -Label 'stderr'
      throw "$Description timed out after ${TimeoutSec}s; inspect logs: $stdoutLog ; $stderrLog"
    }

    if ($now -ge $nextHeartbeatAt) {
      Write-Info "$Description still running after ${elapsedSec}s (pid=$($process.Id)); logs: $stdoutLog ; $stderrLog"
      $nextHeartbeatAt = $now.AddSeconds($HeartbeatSec)
    }
  }

  $exitCode = $process.ExitCode
  $elapsedTotalSec = [int]((Get-Date) - $startedAt).TotalSeconds
  Write-Info "$Description finished with exit code $exitCode after ${elapsedTotalSec}s"

  if ($exitCode -ne 0) {
    Write-LogTail -Path $stdoutLog -Label 'stdout'
    Write-LogTail -Path $stderrLog -Label 'stderr'
    throw "$Description failed with exit code $exitCode; inspect logs: $stdoutLog ; $stderrLog"
  }
}

function Expand-PackageArchive {
  param(
    [string]$ArchivePath,
    [string]$TargetDir
  )

  $archiveLower = $ArchivePath.ToLowerInvariant()
  if ($archiveLower.EndsWith('.zip')) {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TargetDir -Force
    return
  }

  if ($archiveLower.EndsWith('.tgz') -or $archiveLower.EndsWith('.tar.gz')) {
    Require-Command -Name 'tar'
    Invoke-CheckedCommand "Extract package archive via tar ($ArchivePath)" {
      tar -xzf $ArchivePath -C $TargetDir
    }
    return
  }

  throw "Unsupported package extension (expected .zip, .tgz, or .tar.gz): $ArchivePath"
}

function Invoke-Healthcheck {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 20
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  }
  catch {
    return $false
  }
}

$resolvedRoot = Resolve-NormalizedPath -Candidate $RootDir -Label 'RootDir'
$resolvedArchive = Resolve-NormalizedPath -Candidate $PackageArchive -Label 'PackageArchive'
$resolvedEnvFile = if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  Join-Path $resolvedRoot 'docker\app.env'
} else {
  Resolve-NormalizedPath -Candidate $EnvFile -Label 'EnvFile'
}

if (-not (Test-Path -LiteralPath $resolvedEnvFile)) {
  throw "EnvFile not found: $resolvedEnvFile"
}

$outputLogs = Join-Path $resolvedRoot 'output\logs'
New-Item -ItemType Directory -Force -Path $outputLogs | Out-Null
$extractRoot = New-ShortTempDirectory -Prefix 'mspa'

try {
  Write-Info "Package archive: $resolvedArchive"
  Write-Info "Deploy root: $resolvedRoot"
  Write-Info "Extract root: $extractRoot"

  Expand-PackageArchive -ArchivePath $resolvedArchive -TargetDir $extractRoot

  $packageRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $packageRoot) {
    throw "Failed to locate extracted package root in $extractRoot"
  }

  foreach ($item in Get-ChildItem -LiteralPath $packageRoot.FullName -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $resolvedRoot -Recurse -Force
  }

  Set-Location $resolvedRoot

  Require-Command -Name 'node'
  $pnpmPath = Resolve-CommandPath -Name 'pnpm'

  if ($InstallDeps -ne '0') {
    $dependencyTimeoutSec = Convert-PositiveInt -Value $DependencyRefreshTimeoutSec -Label 'DependencyRefreshTimeoutSec'
    $dependencyHeartbeatSec = Convert-PositiveInt -Value $DependencyRefreshHeartbeatSec -Label 'DependencyRefreshHeartbeatSec'
    $dependencyLogPrefix = Join-Path $outputLogs ('dependency-refresh-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Write-Info "pnpm path: $pnpmPath"
    try {
      $pnpmVersion = (& $pnpmPath --version 2>$null | Select-Object -First 1)
      if (-not [string]::IsNullOrWhiteSpace($pnpmVersion)) {
        Write-Info "pnpm version: $pnpmVersion"
      }
    }
    catch {
      Write-Info "Unable to read pnpm version before dependency refresh: $($_.Exception.Message)"
    }
    Invoke-LoggedProcess `
      -Description 'Refresh dependencies (pnpm install --frozen-lockfile)' `
      -FilePath $pnpmPath `
      -Arguments @('install', '--frozen-lockfile') `
      -WorkingDirectory $resolvedRoot `
      -LogPrefix $dependencyLogPrefix `
      -TimeoutSec $dependencyTimeoutSec `
      -HeartbeatSec $dependencyHeartbeatSec
  }

  if ($RunMigrations -ne '0') {
    $migratePath = Join-Path $resolvedRoot 'packages\core-backend\dist\src\db\migrate.js'
    if (-not (Test-Path -LiteralPath $migratePath)) {
      throw "Missing backend migration entrypoint: $migratePath"
    }
    Invoke-CheckedCommand "Run database migrations ($migratePath)" {
      node $migratePath
    }
  }

  if ($RestartService -ne '0') {
    $startScript = Join-Path $resolvedRoot 'scripts\ops\attendance-onprem-start-pm2.ps1'
    if (-not (Test-Path -LiteralPath $startScript)) {
      throw "Missing PM2 startup helper: $startScript"
    }

    Write-Info 'Start or restart PM2 service'
    & $startScript -RootDir $resolvedRoot
    if ($LASTEXITCODE -ne 0) {
      throw 'pm2 startup failed'
    }
  }

  if ($RunHealthcheck -ne '0') {
    $healthUrl = ($BaseUrl.TrimEnd('/')) + '/health'
    $pluginsUrl = ($ApiBase.TrimEnd('/')) + '/plugins'
    if (-not (Invoke-Healthcheck -Url $healthUrl) -and -not (Invoke-Healthcheck -Url $pluginsUrl)) {
      throw "Healthcheck failed for $healthUrl and $pluginsUrl"
    }
    Write-Info "Healthcheck OK ($healthUrl or $pluginsUrl)"
  }

  Write-Info "Package deploy complete"
  Write-Info "Archive applied: $resolvedArchive"
  Write-Info "Root: $resolvedRoot"
}
finally {
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
