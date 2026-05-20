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

function Resolve-PnpmInstallCommand {
  $cmdCommand = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmdCommand -and -not [string]::IsNullOrWhiteSpace($cmdCommand.Source)) {
    return $cmdCommand.Source
  }

  $command = Get-Command 'pnpm' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command -or [string]::IsNullOrWhiteSpace($command.Source)) {
    throw 'Missing required command: pnpm'
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

function ConvertTo-CmdQuoted {
  param([string]$Value)

  return '"' + ($Value -replace '"', '""') + '"'
}

function Invoke-PnpmSingleLine {
  param(
    [string]$PnpmPath,
    [string[]]$Arguments
  )

  if ($PnpmPath.ToLowerInvariant().EndsWith('.ps1')) {
    $output = powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PnpmPath @Arguments 2>$null
    $firstLine = $output | Select-Object -First 1
    return $firstLine
  }

  $output = & $PnpmPath @Arguments 2>$null
  $firstLine = $output | Select-Object -First 1
  return $firstLine
}

function New-DependencyRefreshCommandWrapper {
  param(
    [string]$WrapperPath,
    [string]$PnpmPath,
    [string]$RootDir,
    [string]$StoreDir
  )

  $quotedPnpmPath = ConvertTo-CmdQuoted -Value $PnpmPath
  $quotedStoreDir = ConvertTo-CmdQuoted -Value $StoreDir
  $quotedRootDir = ConvertTo-CmdQuoted -Value $RootDir
  $pnpmPrefix = if ($PnpmPath.ToLowerInvariant().EndsWith('.ps1')) {
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $quotedPnpmPath"
  } else {
    "call $quotedPnpmPath"
  }

  $lines = @(
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "CI=true"',
    'set "npm_config_yes=true"',
    'set "npm_config_confirm_modules_purge=false"',
    'set "PNPM_CONFIG_CONFIRM_MODULES_PURGE=false"',
    'echo [dependency-refresh-wrapper] wrapper entered',
    'echo [dependency-refresh-wrapper] non-interactive env: CI=true npm_config_confirm_modules_purge=false PNPM_CONFIG_CONFIRM_MODULES_PURGE=false',
    "echo [dependency-refresh-wrapper] root=$quotedRootDir",
    'echo [dependency-refresh-wrapper] cwd before cd=%CD%',
    "cd /d $quotedRootDir",
    'echo [dependency-refresh-wrapper] cwd after cd=%CD%',
    'echo [dependency-refresh-wrapper] user:',
    'whoami',
    'echo [dependency-refresh-wrapper] node path:',
    'where node',
    'echo [dependency-refresh-wrapper] pnpm path:',
    'where pnpm',
    'echo [dependency-refresh-wrapper] pnpm command:',
    "echo $quotedPnpmPath",
    'echo [dependency-refresh-wrapper] pnpm version:',
    "$pnpmPrefix --version",
    'echo [dependency-refresh-wrapper] pnpm config registry:',
    "$pnpmPrefix config get registry",
    'echo [dependency-refresh-wrapper] pnpm config store-dir:',
    "$pnpmPrefix config get store-dir",
    "echo [dependency-refresh-wrapper] local store-dir=$quotedStoreDir",
    "if not exist $quotedStoreDir mkdir $quotedStoreDir",
    'echo [dependency-refresh-wrapper] pnpm install starting',
    "$pnpmPrefix install --frozen-lockfile --reporter=append-only --store-dir $quotedStoreDir",
    'set "DEPENDENCY_REFRESH_EXIT=%ERRORLEVEL%"',
    'echo [dependency-refresh-wrapper] pnpm install exit=%DEPENDENCY_REFRESH_EXIT%',
    'exit /b %DEPENDENCY_REFRESH_EXIT%'
  )

  Set-Content -LiteralPath $WrapperPath -Value $lines -Encoding ASCII
}

function Get-DependencyRefreshExitCodeFromLog {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  $exitLine = Get-Content -LiteralPath $Path -Tail 80 |
    Where-Object { $_ -match '\[dependency-refresh-wrapper\] pnpm install exit=(\d+)' } |
    Select-Object -Last 1
  if ($exitLine -and $exitLine -match 'exit=(\d+)') {
    return [int]$matches[1]
  }

  return $null
}

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)

  $taskkill = Get-Command 'taskkill.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($taskkill -and -not [string]::IsNullOrWhiteSpace($taskkill.Source)) {
    Write-Info "Killing process tree pid=$($Process.Id) via taskkill.exe"
    & $taskkill.Source /PID $Process.Id /T /F | ForEach-Object {
      Write-Info "taskkill: $_"
    }
    if ($LASTEXITCODE -eq 0) {
      return
    }
    Write-Info "taskkill.exe returned exit code $LASTEXITCODE; falling back to Process.Kill()"
  }

  try {
    $Process.Kill()
  }
  catch {
    Write-Info "Failed to kill timed-out process pid=$($Process.Id): $($_.Exception.Message)"
  }
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
      Stop-ProcessTree -Process $process

      Write-LogTail -Path $stdoutLog -Label 'stdout'
      Write-LogTail -Path $stderrLog -Label 'stderr'
      throw "$Description timed out after ${TimeoutSec}s; inspect logs: $stdoutLog ; $stderrLog"
    }

    if ($now -ge $nextHeartbeatAt) {
      $stdoutSize = if (Test-Path -LiteralPath $stdoutLog) { (Get-Item -LiteralPath $stdoutLog).Length } else { 0 }
      $stderrSize = if (Test-Path -LiteralPath $stderrLog) { (Get-Item -LiteralPath $stderrLog).Length } else { 0 }
      Write-Info "$Description still running after ${elapsedSec}s (pid=$($process.Id)); stdout=${stdoutSize}B stderr=${stderrSize}B; logs: $stdoutLog ; $stderrLog"
      $nextHeartbeatAt = $now.AddSeconds($HeartbeatSec)
    }
  }

  try {
    $process.WaitForExit()
  }
  catch {
    Write-Info "Failed while waiting for process exit confirmation pid=$($process.Id): $($_.Exception.Message)"
  }
  try {
    $process.Refresh()
  }
  catch {
    Write-Info "Failed to refresh process state pid=$($process.Id): $($_.Exception.Message)"
  }

  $exitCode = $null
  try {
    $exitCode = $process.ExitCode
  }
  catch {
    Write-Info "Unable to read process exit code pid=$($process.Id): $($_.Exception.Message)"
  }
  if ($null -eq $exitCode -or [string]::IsNullOrWhiteSpace([string]$exitCode)) {
    $wrapperExitCode = Get-DependencyRefreshExitCodeFromLog -Path $stdoutLog
    if ($null -ne $wrapperExitCode) {
      $exitCode = $wrapperExitCode
      Write-Info "$Description using wrapper exit marker $exitCode from stdout log"
    }
  }

  $elapsedTotalSec = [int]((Get-Date) - $startedAt).TotalSeconds
  if ($null -eq $exitCode -or [string]::IsNullOrWhiteSpace([string]$exitCode)) {
    Write-LogTail -Path $stdoutLog -Label 'stdout'
    Write-LogTail -Path $stderrLog -Label 'stderr'
    throw "$Description finished without a readable process exit code after ${elapsedTotalSec}s; inspect logs: $stdoutLog ; $stderrLog"
  }

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
  $pnpmInstallPath = Resolve-PnpmInstallCommand

  if ($InstallDeps -ne '0') {
    $dependencyTimeoutSec = Convert-PositiveInt -Value $DependencyRefreshTimeoutSec -Label 'DependencyRefreshTimeoutSec'
    $dependencyHeartbeatSec = Convert-PositiveInt -Value $DependencyRefreshHeartbeatSec -Label 'DependencyRefreshHeartbeatSec'
    $dependencyLogPrefix = Join-Path $outputLogs ('dependency-refresh-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $dependencyWrapperPath = $dependencyLogPrefix + '.cmd'
    $dependencyStoreDir = Join-Path $resolvedRoot '.pnpm-store'
    New-Item -ItemType Directory -Force -Path $dependencyStoreDir | Out-Null
    Write-Info "pnpm path: $pnpmPath"
    Write-Info "pnpm install path: $pnpmInstallPath"
    Write-Info "dependency refresh wrapper: $dependencyWrapperPath"
    Write-Info "dependency refresh local store: $dependencyStoreDir"
    try {
      $pnpmVersion = Invoke-PnpmSingleLine -PnpmPath $pnpmInstallPath -Arguments @('--version')
      if (-not [string]::IsNullOrWhiteSpace($pnpmVersion)) {
        Write-Info "pnpm version: $pnpmVersion"
      }
    }
    catch {
      Write-Info "Unable to read pnpm version before dependency refresh: $($_.Exception.Message)"
    }
    try {
      $pnpmRegistry = Invoke-PnpmSingleLine -PnpmPath $pnpmInstallPath -Arguments @('config', 'get', 'registry')
      if (-not [string]::IsNullOrWhiteSpace($pnpmRegistry)) {
        Write-Info "pnpm config registry: $pnpmRegistry"
      }
    }
    catch {
      Write-Info "Unable to read pnpm registry before dependency refresh: $($_.Exception.Message)"
    }
    try {
      $pnpmStoreDir = Invoke-PnpmSingleLine -PnpmPath $pnpmInstallPath -Arguments @('config', 'get', 'store-dir')
      if (-not [string]::IsNullOrWhiteSpace($pnpmStoreDir)) {
        Write-Info "pnpm config store-dir: $pnpmStoreDir"
      }
    }
    catch {
      Write-Info "Unable to read pnpm store-dir before dependency refresh: $($_.Exception.Message)"
    }
    New-DependencyRefreshCommandWrapper `
      -WrapperPath $dependencyWrapperPath `
      -PnpmPath $pnpmInstallPath `
      -RootDir $resolvedRoot `
      -StoreDir $dependencyStoreDir

    $cmdPath = Resolve-CommandPath -Name 'cmd.exe'
    Invoke-LoggedProcess `
      -Description 'Refresh dependencies (cmd.exe /c pnpm install --frozen-lockfile)' `
      -FilePath $cmdPath `
      -Arguments @('/d', '/s', '/c', ('"' + $dependencyWrapperPath + '"')) `
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
