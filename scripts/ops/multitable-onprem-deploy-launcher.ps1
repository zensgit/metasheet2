param(
  [Parameter(Mandatory = $true)]
  [string]$PackageArchive,
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$StagingRoot = ''
)

$ErrorActionPreference = 'Stop'

# multitable-onprem-deploy-launcher.ps1
#
# Self-bootstrapping launcher for the Windows on-prem apply path.
#
# Why this exists: before this launcher, deploy.bat invoked the
# multitable-onprem-apply-package.ps1 sitting in the already-installed root.
# When upgrading from an older install whose apply helper had a bug, the
# first apply would still execute the stale helper because the new package
# contents only land on disk *after* extraction inside the running apply.
# Operators had to rerun apply ("first fails, second succeeds").
#
# This launcher closes that gap. deploy.bat now calls THIS file, which:
#   1. extracts the supplied package archive into a temp staging directory,
#   2. locates the apply helper *inside the staged extraction*,
#   3. invokes that newest apply helper with -RootDir = installed root,
#   4. cleans up staging on exit and propagates the apply exit code.
#
# The launcher is intentionally small and self-contained. It does not load
# env, does not touch DB, does not call PM2. It is the bootstrap step only.
# All migration / dependency-refresh / PM2 / healthcheck behavior continues
# to live in the staged apply helper (including #1684 wrapper / exit-marker
# and #1696 env loading).

function Write-LauncherInfo {
  param([string]$Message)
  Write-Output ("[multitable-onprem-deploy-launcher] {0}" -f $Message)
}

function Resolve-LauncherPath {
  param([string]$Candidate, [string]$Label)

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw "$Label is empty after normalization"
  }
  if (-not (Test-Path -LiteralPath $trimmed)) {
    throw "$Label not found: $trimmed"
  }
  return (Resolve-Path -LiteralPath $trimmed).Path
}

function Resolve-StagingBase {
  param([string]$Candidate)

  $base = $Candidate
  if ([string]::IsNullOrWhiteSpace($base)) {
    $base = $env:METASHEET_ONPREM_STAGING_ROOT
  }
  if ([string]::IsNullOrWhiteSpace($base)) {
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
      $base = 'C:\ms-tmp'
      Write-LauncherInfo "No staging root override set; defaulting to short Windows staging root $base"
    } else {
      $base = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
    }
  }
  if ([string]::IsNullOrWhiteSpace($base)) {
    throw 'No staging root is available. Set METASHEET_ONPREM_STAGING_ROOT to a short local path such as C:\ms-tmp.'
  }

  $base = [System.IO.Path]::GetFullPath($base.Trim().Trim('"'))
  New-Item -ItemType Directory -Path $base -Force | Out-Null
  return (Resolve-Path -LiteralPath $base).Path
}

function New-StagingDirectory {
  param([string]$BaseRoot)

  $base = Resolve-StagingBase -Candidate $BaseRoot
  $name = 'msdl-' + ([System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  $path = Join-Path $base $name
  New-Item -ItemType Directory -Path $path -Force | Out-Null
  return (Resolve-Path -LiteralPath $path).Path
}

function Expand-StagingArchive {
  param([string]$Archive, [string]$Stage)

  $lower = $Archive.ToLowerInvariant()
  if ($lower.EndsWith('.zip')) {
    Write-LauncherInfo "Extracting zip via System.IO.Compression.ZipFile"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Stage)
    return
  }

  if ($lower.EndsWith('.tgz') -or $lower.EndsWith('.tar.gz')) {
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
      throw "tar command is required to extract tgz/tar.gz archives"
    }
    Write-LauncherInfo "Extracting tar archive via tar -xzf"
    & tar -xzf $Archive -C $Stage
    if ($LASTEXITCODE -ne 0) {
      throw "tar extraction failed with exit code $LASTEXITCODE"
    }
    return
  }

  throw "Unsupported package extension (expected .zip, .tgz, or .tar.gz): $Archive"
}

function Resolve-StagedPackageRoot {
  param([string]$Stage)

  $stageItem = Get-Item -LiteralPath $Stage -ErrorAction Stop
  $candidates = @()
  if (
    (Test-Path -LiteralPath (Join-Path $stageItem.FullName 'pnpm-lock.yaml')) -and
    (Test-Path -LiteralPath (Join-Path $stageItem.FullName 'PACKAGE-METADATA.json')) -and
    (Test-Path -LiteralPath (Join-Path $stageItem.FullName 'scripts\ops\multitable-onprem-apply-package.ps1'))
  ) {
    $candidates += $stageItem
  }
  $candidates += @(
    Get-ChildItem -LiteralPath $Stage -Directory -Recurse -ErrorAction Stop |
      Where-Object {
        (Test-Path -LiteralPath (Join-Path $_.FullName 'pnpm-lock.yaml')) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'PACKAGE-METADATA.json')) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'scripts\ops\multitable-onprem-apply-package.ps1'))
      }
  )

  if ($candidates.Count -lt 1) {
    throw "No package root with pnpm-lock.yaml / PACKAGE-METADATA.json / apply helper markers found inside staging extraction at $Stage"
  }
  if ($candidates.Count -eq 1) {
    return $candidates[0].FullName
  }
  $preferred = @($candidates) | Where-Object { $_.Name -like 'metasheet-multitable-onprem-*' }
  if (@($preferred).Count -eq 1) {
    return @($preferred)[0].FullName
  }
  throw "Ambiguous package roots inside staging extraction at ${Stage}: $(@($candidates | ForEach-Object { $_.FullName }) -join '; ')"
}

$resolvedArchive = Resolve-LauncherPath -Candidate $PackageArchive -Label 'PackageArchive'
$resolvedRoot = Resolve-LauncherPath -Candidate $RootDir -Label 'RootDir'

Write-LauncherInfo "Package archive: $resolvedArchive"
Write-LauncherInfo "Install root:    $resolvedRoot"

$stagingBase = Resolve-StagingBase -Candidate $StagingRoot
Write-LauncherInfo "Staging base:    $stagingBase"

$stage = New-StagingDirectory -BaseRoot $stagingBase
$launcherExit = 1
try {
  Write-LauncherInfo "Staging extraction root: $stage"
  Expand-StagingArchive -Archive $resolvedArchive -Stage $stage

  $packageRoot = Resolve-StagedPackageRoot -Stage $stage
  Write-LauncherInfo "Staged package root: $packageRoot"

  $stagedApply = Join-Path $packageRoot 'scripts\ops\multitable-onprem-apply-package.ps1'
  if (-not (Test-Path -LiteralPath $stagedApply)) {
    throw "Staged package does not contain apply helper at $stagedApply"
  }
  Write-LauncherInfo "Invoking staged apply helper: $stagedApply"

  # apply.ps1's contract is "throw on failure, return on success"
  # ($ErrorActionPreference = 'Stop' in apply.ps1; failures bubble as
  # terminating errors). $LASTEXITCODE for `& <script.ps1>` in-process is
  # NOT a reliable apply signal - it reflects the *last external program*
  # apply.ps1 invoked internally (tar, node migrate.js, pm2, etc.), which
  # could be 0, or could leak a non-fatal sub-program's exit. Trust the
  # try/catch contract instead so a successful apply ("Package deploy
  # complete" + health 200) reliably yields launcher exit 0 and a Last
  # Result of 0 in the outer scheduled task (#1526 follow-up).
  try {
    & $stagedApply -RootDir $resolvedRoot -PackageArchive $resolvedArchive -StagingRoot $stagingBase
    $launcherExit = 0
  }
  catch {
    Write-LauncherInfo ("Apply helper raised an error: {0}" -f $_.Exception.Message)
    $launcherExit = 1
  }
}
finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Stable, parseable last-line marker so deploy-remote.log / scheduled-task
# stdout always carry the captured apply exit code. Outer wrappers also
# echo this; the launcher line is the inner-most source of truth.
Write-LauncherInfo ("apply exit={0}" -f $launcherExit)

exit $launcherExit
