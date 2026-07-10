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
  [string]$StagingRoot = '',
  [string]$DependencyRefreshTimeoutSec = '1800',
  [string]$DependencyRefreshHeartbeatSec = '60',
  [string]$HealthcheckAttempts = '12',
  [string]$HealthcheckDelaySec = '5'
)

$ErrorActionPreference = 'Stop'
$SupportedPackagePnpmVersion = '9.15.9'

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

function Import-AppEnvFile {
  param([string]$EnvFile)

  # Mirror of scripts/ops/attendance-onprem-start-pm2.ps1 Import-AppEnvFile so
  # migration / restart inherit DATABASE_URL / JWT_SECRET / etc. from the same
  # env file PM2 will source. Without this, `node migrate.js` sees an empty
  # process environment and dies with "DATABASE_URL not set" (#1526 follow-up).
  $applied = 0
  foreach ($rawLine in Get-Content -Path $EnvFile) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
      continue
    }

    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) {
      continue
    }

    $name = $parts[0].Trim()
    if ([string]::IsNullOrWhiteSpace($name)) {
      continue
    }
    $value = $parts[1].Trim()

    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    Set-Item -Path ("Env:{0}" -f $name) -Value $value
    $applied += 1
  }
  return $applied
}

function Write-Info {
  param([string]$Message)
  Write-Host "[multitable-onprem-apply-package] $Message"
}

function Resolve-StagingBase {
  param([string]$Candidate)

  $tempBase = $Candidate
  if ([string]::IsNullOrWhiteSpace($tempBase)) {
    $tempBase = $env:METASHEET_ONPREM_STAGING_ROOT
  }
  if ([string]::IsNullOrWhiteSpace($tempBase)) {
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
      $tempBase = 'C:\ms-tmp'
      Write-Info "No staging root override set; defaulting to short Windows staging root $tempBase"
    } else {
      $tempBase = [System.IO.Path]::GetTempPath()
    }
  }
  if ([string]::IsNullOrWhiteSpace($tempBase)) {
    throw 'Staging root is unavailable. Set METASHEET_ONPREM_STAGING_ROOT to a short local path such as C:\ms-tmp.'
  }

  $tempBase = [System.IO.Path]::GetFullPath($tempBase.Trim().Trim('"'))
  New-Item -ItemType Directory -Path $tempBase -Force | Out-Null
  return (Resolve-Path -LiteralPath $tempBase).Path
}

function New-ShortTempDirectory {
  param(
    [string]$Prefix = 'mspa',
    [string]$BaseRoot = ''
  )

  $tempBase = Resolve-StagingBase -Candidate $BaseRoot

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

function Add-PathEntryIfExists {
  param([string]$PathEntry)

  if ([string]::IsNullOrWhiteSpace($PathEntry) -or -not (Test-Path -LiteralPath $PathEntry)) {
    return
  }

  $currentPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
  $entries = @()
  if (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    $entries = @($currentPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }

  $alreadyPresent = $false
  foreach ($entry in $entries) {
    if ($entry.TrimEnd('\') -ieq $PathEntry.TrimEnd('\')) {
      $alreadyPresent = $true
      break
    }
  }

  if (-not $alreadyPresent) {
    $env:PATH = if ([string]::IsNullOrWhiteSpace($currentPath)) { $PathEntry } else { "$PathEntry;$currentPath" }
  }
}

function Get-WindowsToolPathCandidates {
  $candidates = @()
  $programFiles = [Environment]::GetEnvironmentVariable('ProgramFiles')
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')

  foreach ($base in @($programFiles, $programFilesX86, 'C:\Program Files', 'C:\Program Files (x86)')) {
    if (-not [string]::IsNullOrWhiteSpace($base)) {
      $candidates += (Join-Path $base 'nodejs')
    }
  }

  $npmBases = @($env:APPDATA, 'C:\Users\Administrator\AppData\Roaming')
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $npmBases += (Join-Path $env:USERPROFILE 'AppData\Roaming')
  }

  foreach ($base in $npmBases) {
    if (-not [string]::IsNullOrWhiteSpace($base)) {
      $candidates += (Join-Path $base 'npm')
    }
  }

  $systemRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
  $candidates += @(
    (Join-Path $systemRoot 'System32'),
    $systemRoot
  )

  return $candidates | Select-Object -Unique
}

function Initialize-WindowsSystemToolPath {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    return
  }

  foreach ($candidate in Get-WindowsToolPathCandidates) {
    Add-PathEntryIfExists -PathEntry $candidate
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
  foreach ($dir in Get-WindowsToolPathCandidates) {
    foreach ($leaf in @('pnpm.exe', 'pnpm.cmd', 'pnpm.ps1')) {
      $candidate = Join-Path $dir $leaf
      if (Test-Path -LiteralPath $candidate) {
        return $candidate
      }
    }
  }

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

function Resolve-CorepackCommand {
  foreach ($dir in Get-WindowsToolPathCandidates) {
    foreach ($leaf in @('corepack.exe', 'corepack.cmd', 'corepack.ps1')) {
      $candidate = Join-Path $dir $leaf
      if (Test-Path -LiteralPath $candidate) {
        return $candidate
      }
    }
  }

  foreach ($name in @('corepack.cmd', 'corepack')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
      return $command.Source
    }
  }

  return $null
}

function Resolve-PackagePnpmVersion {
  param([string]$PackageRoot)

  $metadataPath = Join-Path $PackageRoot 'PACKAGE-METADATA.json'
  if (-not (Test-Path -LiteralPath $metadataPath)) {
    throw "Package metadata is missing: $metadataPath"
  }

  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  $version = [string]$metadata.pnpmVersion
  if ($version -ne $SupportedPackagePnpmVersion) {
    throw "Unsupported package pnpm version '$version'; this apply helper accepts only $SupportedPackagePnpmVersion"
  }

  return $version
}

function Initialize-PinnedPnpm {
  param([string]$RequiredVersion)

  # Corrective (#3751 entity-machine rerun, failureClass=PNPM_VERSION_MISMATCH): `corepack prepare
  # --activate` only records the pin in $COREPACK_HOME (it writes NO shim — shims come from
  # `corepack enable`), so ANY PATH-based pnpm resolution can be shadowed by a user/system-profile
  # pnpm of a different version. The fix is to stop resolving pnpm from PATH entirely whenever
  # corepack exists: every pnpm invocation goes THROUGH corepack as `corepack pnpm@<pin> ...`
  # (version-addressed passthrough — corepack itself guarantees the exact pinned version, PATH
  # shadowing becomes irrelevant). The exact-version check stays fail-closed on both paths.
  $corepackPath = Resolve-CorepackCommand
  if (-not [string]::IsNullOrWhiteSpace($corepackPath)) {
    Write-Info "Activate pinned pnpm via corepack prepare pnpm@$RequiredVersion --activate"
    $prepareOutput = & $corepackPath prepare "pnpm@$RequiredVersion" --activate 2>&1
    $prepareExit = $LASTEXITCODE
    @($prepareOutput) | ForEach-Object { Write-Host "[corepack] $_" }
    if ($prepareExit -ne 0) {
      throw "corepack failed to activate pnpm $RequiredVersion (exit=$prepareExit)"
    }

    $specArg = "pnpm@$RequiredVersion"
    $actualVersion = $null
    try {
      $actualVersion = Invoke-PnpmSingleLine -PnpmPath $corepackPath -PnpmSpecArg $specArg -Arguments @('--version')
    } catch {
      throw "PNPM_VERSION_MISMATCH: corepack passthrough '$specArg --version' failed at $corepackPath ($($_.Exception.Message))"
    }
    if ([string]::IsNullOrWhiteSpace($actualVersion) -or $actualVersion.Trim() -ne $RequiredVersion) {
      throw "PNPM_VERSION_MISMATCH: package requires $RequiredVersion but corepack passthrough resolved '$actualVersion' at $corepackPath"
    }

    Write-Info "Pinned pnpm ready via corepack passthrough: version=$RequiredVersion launcher=$corepackPath $specArg"
    return @{ Path = $corepackPath; SpecArg = $specArg }
  }

  # No corepack at all: an already-installed exact pnpm is required (pre-existing posture). The
  # PATH walk here is the LAST resort and stays fail-closed on the exact-version check.
  Write-Info 'corepack is unavailable; an already-installed exact pnpm version is required'
  $pnpmPath = Resolve-PnpmInstallCommand
  $actualVersion = Invoke-PnpmSingleLine -PnpmPath $pnpmPath -Arguments @('--version')
  if ([string]::IsNullOrWhiteSpace($actualVersion) -or $actualVersion.Trim() -ne $RequiredVersion) {
    throw "PNPM_VERSION_MISMATCH: package requires $RequiredVersion but resolved '$actualVersion' at $pnpmPath"
  }

  Write-Info "Pinned pnpm ready: version=$RequiredVersion path=$pnpmPath"
  return @{ Path = $pnpmPath; SpecArg = '' }
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
    [string[]]$Arguments,
    [string]$PnpmSpecArg = ''
  )

  # Corepack passthrough mode: the version-addressed spec token (pnpm@<pin>) rides FIRST so the
  # launcher is corepack itself and PATH shadowing cannot substitute another pnpm. Project-spec
  # lookup is disabled so the probe is cwd-independent (a foreign packageManager pin in the ambient
  # cwd can never fail-close an unrelated corepack passthrough call).
  if (-not [string]::IsNullOrWhiteSpace($PnpmSpecArg)) {
    $Arguments = @($PnpmSpecArg) + $Arguments
    $env:COREPACK_ENABLE_PROJECT_SPEC = '0'
  }

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
    [string]$PnpmSpecArg = '',
    [string]$RootDir,
    [string]$StoreDir,
    [switch]$Offline
  )

  $quotedPnpmPath = ConvertTo-CmdQuoted -Value $PnpmPath
  $quotedStoreDir = ConvertTo-CmdQuoted -Value $StoreDir
  $quotedRootDir = ConvertTo-CmdQuoted -Value $RootDir
  $pnpmPrefix = if ($PnpmPath.ToLowerInvariant().EndsWith('.ps1')) {
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $quotedPnpmPath"
  } else {
    "call $quotedPnpmPath"
  }
  # Corepack passthrough: the spec token (pnpm@<pin>) follows the launcher in every wrapper line,
  # and project-spec lookup is disabled inside the wrapper so the pinned request is cwd-independent.
  $corepackEnvLine = ''
  if (-not [string]::IsNullOrWhiteSpace($PnpmSpecArg)) {
    $pnpmPrefix = "$pnpmPrefix $PnpmSpecArg"
    $corepackEnvLine = 'set "COREPACK_ENABLE_PROJECT_SPEC=0"'
  }
  $offlineFlag = if ($Offline) { ' --offline' } else { '' }

  $lines = @(
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "CI=true"',
    'set "npm_config_yes=true"',
    'set "npm_config_confirm_modules_purge=false"',
    'set "PNPM_CONFIG_CONFIRM_MODULES_PURGE=false"',
    $corepackEnvLine,
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
    "$pnpmPrefix install --frozen-lockfile --reporter=append-only --store-dir $quotedStoreDir$offlineFlag",
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

function Invoke-DependencyInstall {
  param(
    [string]$Description,
    [string]$PnpmPath,
    [string]$PnpmSpecArg = '',
    [string]$RootDir,
    [string]$StoreDir,
    [string]$LogPrefix,
    [int]$TimeoutSec,
    [int]$HeartbeatSec,
    [switch]$Offline
  )

  $wrapperPath = $LogPrefix + '.cmd'
  New-Item -ItemType Directory -Path $StoreDir -Force | Out-Null
  New-DependencyRefreshCommandWrapper `
    -WrapperPath $wrapperPath `
    -PnpmPath $PnpmPath `
    -PnpmSpecArg $PnpmSpecArg `
    -RootDir $RootDir `
    -StoreDir $StoreDir `
    -Offline:$Offline

  $cmdPath = Resolve-CommandPath -Name 'cmd.exe'
  Invoke-LoggedProcess `
    -Description $Description `
    -FilePath $cmdPath `
    -Arguments @('/d', '/s', '/c', ('"' + $wrapperPath + '"')) `
    -WorkingDirectory $RootDir `
    -LogPrefix $LogPrefix `
    -TimeoutSec $TimeoutSec `
    -HeartbeatSec $HeartbeatSec
}

function Expand-PackageArchive {
  param(
    [string]$ArchivePath,
    [string]$TargetDir
  )

  $archiveLower = $ArchivePath.ToLowerInvariant()
  if ($archiveLower.EndsWith('.zip')) {
    Write-Info "Extract package archive via System.IO.Compression.ZipFile ($ArchivePath)"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $TargetDir)
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

function Test-OnPremPackageRoot {
  param([string]$Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return $false
  }
  return (
    (Test-Path -LiteralPath (Join-Path $Candidate 'pnpm-lock.yaml')) -and
    (Test-Path -LiteralPath (Join-Path $Candidate 'PACKAGE-METADATA.json')) -and
    (Test-Path -LiteralPath (Join-Path $Candidate 'scripts\ops\multitable-onprem-apply-package.ps1'))
  )
}

function Resolve-ExtractedPackageRoot {
  param([string]$ExtractRoot)

  $rootItem = Get-Item -LiteralPath $ExtractRoot -ErrorAction Stop
  $candidates = @()
  if (Test-OnPremPackageRoot -Candidate $rootItem.FullName) {
    $candidates += $rootItem
  }
  $candidates += @(
    Get-ChildItem -LiteralPath $ExtractRoot -Directory -Recurse -ErrorAction Stop |
      Where-Object { Test-OnPremPackageRoot -Candidate $_.FullName }
  )

  if ($candidates.Count -lt 1) {
    throw "Failed to locate extracted package root under $ExtractRoot (missing pnpm-lock.yaml / PACKAGE-METADATA.json / apply helper markers)"
  }
  if ($candidates.Count -eq 1) {
    return $candidates[0].FullName
  }

  $preferred = @($candidates) | Where-Object { $_.Name -like 'metasheet-multitable-onprem-*' }
  if (@($preferred).Count -eq 1) {
    return @($preferred)[0].FullName
  }
  throw "Ambiguous extracted package roots under ${ExtractRoot}: $(@($candidates | ForEach-Object { $_.FullName }) -join '; ')"
}

function Get-RelativePathUnderRoot {
  param(
    [string]$Root,
    [string]$Path
  )

  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/')
  $normalizedPath = [System.IO.Path]::GetFullPath($Path)
  $prefix = $normalizedRoot + [System.IO.Path]::DirectorySeparatorChar
  if (-not $normalizedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside expected root: path=$normalizedPath root=$normalizedRoot"
  }

  return $normalizedPath.Substring($prefix.Length)
}

function Get-WorkspaceProjectRelativeRoots {
  param([string]$Root)

  $roots = @('')
  foreach ($group in @('apps', 'packages', 'plugins', 'tools')) {
    $groupPath = Join-Path $Root $group
    if (-not (Test-Path -LiteralPath $groupPath -PathType Container)) {
      continue
    }

    foreach ($child in Get-ChildItem -LiteralPath $groupPath -Directory -Force) {
      if (Test-Path -LiteralPath (Join-Path $child.FullName 'package.json') -PathType Leaf) {
        $roots += (Join-Path $group $child.Name)
      }
    }
  }

  $openapiSdk = Join-Path $Root 'packages\openapi\dist-sdk'
  if (Test-Path -LiteralPath (Join-Path $openapiSdk 'package.json') -PathType Leaf) {
    $roots += 'packages\openapi\dist-sdk'
  }

  return @($roots | Select-Object -Unique)
}

function Remove-WorkspaceNodeModules {
  param([string]$Root)

  $projectRoots = @(Get-WorkspaceProjectRelativeRoots -Root $Root) |
    Sort-Object { $_.Length } -Descending
  foreach ($relativeRoot in $projectRoots) {
    $projectRoot = if ([string]::IsNullOrWhiteSpace($relativeRoot)) { $Root } else { Join-Path $Root $relativeRoot }
    $modulesPath = Join-Path $projectRoot 'node_modules'
    if (Test-Path -LiteralPath $modulesPath) {
      Remove-Item -LiteralPath $modulesPath -Recurse -Force
    }
  }
}

function New-PackageOverlayTransaction {
  param(
    [string]$PackageRoot,
    [string]$LiveRoot,
    [string]$BackupRoot
  )

  $filesBackupRoot = Join-Path $BackupRoot 'files'
  New-Item -ItemType Directory -Path $filesBackupRoot -Force | Out-Null

  $fileEntries = @()
  foreach ($sourceFile in Get-ChildItem -LiteralPath $PackageRoot -File -Recurse -Force) {
    $relativePath = Get-RelativePathUnderRoot -Root $PackageRoot -Path $sourceFile.FullName
    if ($relativePath -match '(^|[\\/])node_modules([\\/]|$)') {
      throw "Package overlay unexpectedly contains node_modules: $relativePath"
    }

    $destinationPath = Join-Path $LiveRoot $relativePath
    if ((Test-Path -LiteralPath $destinationPath) -and -not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
      throw "Package file conflicts with a non-file destination: $relativePath"
    }

    $existed = Test-Path -LiteralPath $destinationPath -PathType Leaf
    $backupPath = $null
    if ($existed) {
      $backupPath = Join-Path $filesBackupRoot $relativePath
      New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
      Copy-Item -LiteralPath $destinationPath -Destination $backupPath -Force
    }

    $fileEntries += [pscustomobject]@{
      RelativePath = $relativePath
      SourcePath = $sourceFile.FullName
      DestinationPath = $destinationPath
      Existed = $existed
      BackupPath = $backupPath
    }
  }

  $createdDirectories = @()
  foreach ($sourceDirectory in Get-ChildItem -LiteralPath $PackageRoot -Directory -Recurse -Force) {
    $relativePath = Get-RelativePathUnderRoot -Root $PackageRoot -Path $sourceDirectory.FullName
    if ($relativePath -match '(^|[\\/])node_modules([\\/]|$)') {
      continue
    }
    $destinationPath = Join-Path $LiveRoot $relativePath
    if (-not (Test-Path -LiteralPath $destinationPath)) {
      $createdDirectories += $destinationPath
    }
  }

  return [pscustomobject]@{
    Files = $fileEntries
    CreatedDirectories = $createdDirectories
  }
}

function Copy-PackageOverlay {
  param([pscustomobject]$Transaction)

  foreach ($entry in @($Transaction.Files)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $entry.DestinationPath) -Force | Out-Null
    Copy-Item -LiteralPath $entry.SourcePath -Destination $entry.DestinationPath -Force
  }
}

function Restore-PackageOverlay {
  param([pscustomobject]$Transaction)

  foreach ($entry in @($Transaction.Files)) {
    if ($entry.Existed) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $entry.DestinationPath) -Force | Out-Null
      Copy-Item -LiteralPath $entry.BackupPath -Destination $entry.DestinationPath -Force
    } elseif (Test-Path -LiteralPath $entry.DestinationPath) {
      Remove-Item -LiteralPath $entry.DestinationPath -Force
    }
  }

  foreach ($directory in @($Transaction.CreatedDirectories) | Sort-Object { $_.Length } -Descending) {
    if ((Test-Path -LiteralPath $directory -PathType Container) -and
        @((Get-ChildItem -LiteralPath $directory -Force)).Count -eq 0) {
      Remove-Item -LiteralPath $directory -Force
    }
  }
}

function Move-WorkspaceNodeModulesForRollback {
  param(
    [string]$LiveRoot,
    [string]$PackageRoot,
    [string]$TransactionId
  )

  $relativeRoots = @(
    @(Get-WorkspaceProjectRelativeRoots -Root $LiveRoot) +
    @(Get-WorkspaceProjectRelativeRoots -Root $PackageRoot)
  ) | Select-Object -Unique
  $entries = @()

  try {
    foreach ($relativeRoot in $relativeRoots) {
      $projectRoot = if ([string]::IsNullOrWhiteSpace($relativeRoot)) { $LiveRoot } else { Join-Path $LiveRoot $relativeRoot }
      $modulesPath = Join-Path $projectRoot 'node_modules'
      $backupPath = "$modulesPath.mspa-backup-$TransactionId"
      if (Test-Path -LiteralPath $backupPath) {
        throw "Dependency rollback path already exists: $backupPath"
      }

      $hadExisting = Test-Path -LiteralPath $modulesPath
      if ($hadExisting) {
        Move-Item -LiteralPath $modulesPath -Destination $backupPath
      }

      $entries += [pscustomobject]@{
        ModulesPath = $modulesPath
        BackupPath = $backupPath
        HadExisting = $hadExisting
      }
    }
  }
  catch {
    foreach ($entry in @($entries) | Sort-Object { $_.ModulesPath.Length } -Descending) {
      if ($entry.HadExisting -and (Test-Path -LiteralPath $entry.BackupPath)) {
        Move-Item -LiteralPath $entry.BackupPath -Destination $entry.ModulesPath
      }
    }
    throw
  }

  return [pscustomobject]@{ Entries = $entries }
}

function Restore-WorkspaceNodeModules {
  param([pscustomobject]$Transaction)

  foreach ($entry in @($Transaction.Entries) | Sort-Object { $_.ModulesPath.Length } -Descending) {
    if (Test-Path -LiteralPath $entry.ModulesPath) {
      Remove-Item -LiteralPath $entry.ModulesPath -Recurse -Force
    }
    if ($entry.HadExisting -and (Test-Path -LiteralPath $entry.BackupPath)) {
      Move-Item -LiteralPath $entry.BackupPath -Destination $entry.ModulesPath
    }
  }
}

function Complete-WorkspaceNodeModulesTransaction {
  param([pscustomobject]$Transaction)

  foreach ($entry in @($Transaction.Entries)) {
    if ($entry.HadExisting -and (Test-Path -LiteralPath $entry.BackupPath)) {
      Remove-Item -LiteralPath $entry.BackupPath -Recurse -Force
    }
  }
}

function Invoke-HealthcheckOnce {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 20
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  }
  catch {
    return $false
  }
}

function Invoke-Healthcheck {
  param(
    [string[]]$Urls,
    [int]$Attempts,
    [int]$DelaySec
  )

  if ($null -eq $Urls -or $Urls.Count -eq 0) {
    throw 'Healthcheck URLs must not be empty'
  }
  if ($Attempts -lt 1) {
    throw 'HealthcheckAttempts must be a positive integer'
  }
  if ($DelaySec -lt 1) {
    throw 'HealthcheckDelaySec must be a positive integer'
  }

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    foreach ($url in $Urls) {
      Write-Info "Healthcheck attempt ${attempt}/${Attempts}: $url"
      if (Invoke-HealthcheckOnce -Url $url) {
        Write-Info "Healthcheck OK ($url)"
        return $true
      }
    }

    if ($attempt -lt $Attempts -and $DelaySec -gt 0) {
      Write-Info "Healthcheck not ready; retrying in ${DelaySec}s"
      Start-Sleep -Seconds $DelaySec
    }
  }

  return $false
}

$resolvedRoot = Resolve-NormalizedPath -Candidate $RootDir -Label 'RootDir'
$resolvedArchive = Resolve-NormalizedPath -Candidate $PackageArchive -Label 'PackageArchive'
$resolvedEnvFile = if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  Join-Path $resolvedRoot 'docker\app.env'
} else {
  Resolve-NormalizedPath -Candidate $EnvFile -Label 'EnvFile'
}

if (-not (Test-Path -LiteralPath $resolvedEnvFile)) {
  throw "EnvFile not found: $resolvedEnvFile. Use -EnvFile <path> or place app.env at docker\app.env under the root."
}

# Load env into this process before migration/restart/healthcheck so child
# processes (node migrate.js, PM2 startup, healthcheck request) inherit
# DATABASE_URL / JWT_SECRET / etc. from the same file PM2 sources. Without
# this load, migrations fail with "DATABASE_URL not set" before PM2 ever
# starts (#1526 official-apply migration env loading follow-up).
$importedEnvCount = Import-AppEnvFile -EnvFile $resolvedEnvFile
Write-Info ("Loaded env from {0} ({1} variables); migration / restart / healthcheck will inherit DATABASE_URL and JWT_SECRET when present in that file" -f $resolvedEnvFile, $importedEnvCount)

Initialize-WindowsSystemToolPath

$outputLogs = Join-Path $resolvedRoot 'output\logs'
New-Item -ItemType Directory -Force -Path $outputLogs | Out-Null
$stagingBase = Resolve-StagingBase -Candidate $StagingRoot
Write-Info "Staging base: $stagingBase"
$extractRoot = New-ShortTempDirectory -Prefix 'mspa' -BaseRoot $stagingBase
$rollbackRoot = $null

try {
  Write-Info "Package archive: $resolvedArchive"
  Write-Info "Deploy root: $resolvedRoot"
  Write-Info "Extract root: $extractRoot"

  Expand-PackageArchive -ArchivePath $resolvedArchive -TargetDir $extractRoot

  $packageRoot = Resolve-ExtractedPackageRoot -ExtractRoot $extractRoot
  Write-Info "Extracted package root: $packageRoot"

  Require-Command -Name 'node'

  if ($InstallDeps -ne '0') {
    $requiredPnpmVersion = Resolve-PackagePnpmVersion -PackageRoot $packageRoot
    $pnpmLauncher = Initialize-PinnedPnpm -RequiredVersion $requiredPnpmVersion
    $pnpmInstallPath = $pnpmLauncher.Path
    $pnpmSpecArg = [string]$pnpmLauncher.SpecArg
    $dependencyTimeoutSec = Convert-PositiveInt -Value $DependencyRefreshTimeoutSec -Label 'DependencyRefreshTimeoutSec'
    $dependencyHeartbeatSec = Convert-PositiveInt -Value $DependencyRefreshHeartbeatSec -Label 'DependencyRefreshHeartbeatSec'
    # The deploy-local content-addressable store is cache-only state. Reusing it
    # avoids a full redownload while keeping package files/runtime dependencies
    # untouched until the staging preflight succeeds.
    $dependencyStoreDir = Join-Path $resolvedRoot '.pnpm-store'
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $preflightLogPrefix = Join-Path $outputLogs ('dependency-preflight-' + $timestamp)
    $dependencyLogPrefix = Join-Path $outputLogs ('dependency-activate-' + $timestamp)
    Write-Info "pnpm launcher: $pnpmInstallPath $pnpmSpecArg"
    Write-Info "pnpm install launcher: $pnpmInstallPath $pnpmSpecArg"
    Write-Info "dependency transaction store: $dependencyStoreDir"
    try {
      $pnpmVersion = Invoke-PnpmSingleLine -PnpmPath $pnpmInstallPath -PnpmSpecArg $pnpmSpecArg -Arguments @('--version')
      if (-not [string]::IsNullOrWhiteSpace($pnpmVersion)) {
        Write-Info "pnpm version: $pnpmVersion"
      }
    }
    catch {
      Write-Info "Unable to read pnpm version before dependency refresh: $($_.Exception.Message)"
    }
    try {
      $pnpmRegistry = Invoke-PnpmSingleLine -PnpmPath $pnpmInstallPath -PnpmSpecArg $pnpmSpecArg -Arguments @('config', 'get', 'registry')
      if (-not [string]::IsNullOrWhiteSpace($pnpmRegistry)) {
        Write-Info "pnpm config registry: $pnpmRegistry"
      }
    }
    catch {
      Write-Info "Unable to read pnpm registry before dependency refresh: $($_.Exception.Message)"
    }
    try {
      $pnpmStoreDir = Invoke-PnpmSingleLine -PnpmPath $pnpmInstallPath -PnpmSpecArg $pnpmSpecArg -Arguments @('config', 'get', 'store-dir')
      if (-not [string]::IsNullOrWhiteSpace($pnpmStoreDir)) {
        Write-Info "pnpm config store-dir: $pnpmStoreDir"
      }
    }
    catch {
      Write-Info "Unable to read pnpm store-dir before dependency refresh: $($_.Exception.Message)"
    }

    # This is the dependency failure boundary: the complete frozen install must
    # succeed in disposable staging before any live-root file or node_modules is
    # touched. It also fills the private store used by the offline activation.
    Invoke-DependencyInstall `
      -Description 'Preflight dependencies in staging (pinned pnpm, frozen lockfile)' `
      -PnpmPath $pnpmInstallPath `
      -PnpmSpecArg $pnpmSpecArg `
      -RootDir $packageRoot `
      -StoreDir $dependencyStoreDir `
      -LogPrefix $preflightLogPrefix `
      -TimeoutSec $dependencyTimeoutSec `
      -HeartbeatSec $dependencyHeartbeatSec

    # node_modules is intentionally not part of the package overlay. The same
    # preflight-populated store is consumed offline in the live transaction.
    Remove-WorkspaceNodeModules -Root $packageRoot

    $transactionId = [System.Guid]::NewGuid().ToString('N').Substring(0, 12)
    $rollbackRoot = New-ShortTempDirectory -Prefix 'mspb' -BaseRoot $stagingBase
    $overlayTransaction = New-PackageOverlayTransaction `
      -PackageRoot $packageRoot `
      -LiveRoot $resolvedRoot `
      -BackupRoot $rollbackRoot
    $modulesTransaction = $null

    try {
      $modulesTransaction = Move-WorkspaceNodeModulesForRollback `
        -LiveRoot $resolvedRoot `
        -PackageRoot $packageRoot `
        -TransactionId $transactionId
      Copy-PackageOverlay -Transaction $overlayTransaction
      Set-Location $resolvedRoot

      Invoke-DependencyInstall `
        -Description 'Activate preflighted dependencies in live root (offline, rollback protected)' `
        -PnpmPath $pnpmInstallPath `
      -PnpmSpecArg $pnpmSpecArg `
        -RootDir $resolvedRoot `
        -StoreDir $dependencyStoreDir `
        -LogPrefix $dependencyLogPrefix `
        -TimeoutSec $dependencyTimeoutSec `
        -HeartbeatSec $dependencyHeartbeatSec `
        -Offline
    }
    catch {
      $activationError = $_
      $rollbackErrors = @()
      Write-Info 'Dependency activation failed; restoring previous package files and workspace node_modules before aborting'

      if ($null -ne $modulesTransaction) {
        try {
          Restore-WorkspaceNodeModules -Transaction $modulesTransaction
        }
        catch {
          $rollbackErrors += "node_modules rollback failed: $($_.Exception.Message)"
        }
      }
      try {
        Restore-PackageOverlay -Transaction $overlayTransaction
      }
      catch {
        $rollbackErrors += "package overlay rollback failed: $($_.Exception.Message)"
      }

      if ($rollbackErrors.Count -gt 0) {
        throw "PACKAGE_DEPENDENCY_ROLLBACK_FAILED after '$($activationError.Exception.Message)': $($rollbackErrors -join '; ')"
      }
      throw $activationError
    }

    try {
      Complete-WorkspaceNodeModulesTransaction -Transaction $modulesTransaction
    }
    catch {
      Write-Info "Dependency activation succeeded but old node_modules cleanup needs manual follow-up: $($_.Exception.Message)"
    }
  } else {
    Write-Info 'InstallDeps=0: dependency preflight and rollback transaction explicitly bypassed by operator'
    foreach ($item in Get-ChildItem -LiteralPath $packageRoot -Force) {
      Copy-Item -LiteralPath $item.FullName -Destination $resolvedRoot -Recurse -Force
    }
  }

  Set-Location $resolvedRoot

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
    $healthcheckAttemptsValue = Convert-PositiveInt -Value $HealthcheckAttempts -Label 'HealthcheckAttempts'
    $healthcheckDelayValue = Convert-PositiveInt -Value $HealthcheckDelaySec -Label 'HealthcheckDelaySec'
    if (-not (Invoke-Healthcheck -Urls @($healthUrl, $pluginsUrl) -Attempts $healthcheckAttemptsValue -DelaySec $healthcheckDelayValue)) {
      throw "Healthcheck failed for $healthUrl and $pluginsUrl"
    }
  }

  Write-Info "Package deploy complete"
  Write-Info "Archive applied: $resolvedArchive"
  Write-Info "Root: $resolvedRoot"
}
finally {
  if ($null -ne $rollbackRoot -and (Test-Path -LiteralPath $rollbackRoot)) {
    Remove-Item -LiteralPath $rollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
