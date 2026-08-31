#requires -Version 5.1
<#
.SYNOPSIS
  Idempotent in-place upgrade for a Windows on-prem MetaSheet multitable
  package running under pm2.

.DESCRIPTION
  This codifies the r7 in-place upgrade (2026-08-31), which until now was
  performed by hand with ad-hoc PowerShell, with the F22 lesson applied:

    F22 — the copy step used `Get-ChildItem -Exclude 'node_modules'` during a
    recursive copy. `-Exclude` does not filter directories in recursion, so an
    entire plugin `lib/` directory was silently skipped; the deployment was
    missing `stock-preparation-preflight.cjs` until a hand-check against the
    package caught it (fixed live by walking files instead: 324 -> 326 files).
    Full account:
      docs/development/takeover-beiliao-20260821/first-deployment-lessons-20260831.md
      (Appendix A, F22) and r7-build-manifest.md §2 (the hand-run steps this
      script now replaces).

  This script never uses `-Exclude` on a recursive copy. Every directory that
  must skip `node_modules` is copied by walking files one at a time
  (Copy-TreeExcludingNodeModules / Test-IsNodeModulesRelativePath below) and
  testing each file's own relative path.

  STEPS
    1. Verify the package: SHA-256 of the zip against its `.sha256` sidecar.
       Refuse on mismatch.
    2. Stop the pm2 app (name parameterized, default metasheet-backend).
    3. Back up docker/, config/, packages/core-backend/dist, apps/web/dist,
       and plugins/ (excluding node_modules) to a timestamped folder. Prints
       the backup path.
    4. Extract the package to a staging dir. Replace
       packages/core-backend/dist, apps/web/dist,
       packages/core-backend/migrations, and plugins/ — plugins by walking
       files, preserving each plugin's own node_modules.
    5. Assert a manifest of must-exist files after the swap (the F22
       tripwire) and print a package-vs-deployed file count per plugin
       lib/. Refuses to proceed on any missing file.
    6. Run migrations with env loaded from docker/app.env into this process
       (pm2 holds stale env otherwise).
    7. Restart pm2 with env reload; poll the health endpoint until ok or
       timeout; print a plugins summary.
    8. Print a final report: package name, backup path, migration exit,
       health, and the exact operator commands to run next (preflight +
       acceptance bootstrap).

  NO ROLLBACK AUTOMATION in this MVP. On a failed assertion (checksum
  mismatch, missing file after swap, failed migration, failed restart) this
  script STOPS, prints the backup path, and states what to restore by hand.
  It never continues past a failed assertion.

  Dot-sourceable: `. .\multitable-onprem-package-upgrade-inplace.ps1` (invoke
  with InvocationName '.') defines every function below without running the
  upgrade. That is how the companion test
  (multitable-onprem-package-upgrade-inplace.test.mjs) exercises the
  checksum check, the must-exist assertion, and the walk-files copy filter
  directly, and how it proves the real functions — not a re-implementation —
  refuse on checksum mismatch and on a missing file.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageArchive,

  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [string]$Pm2AppName = 'metasheet-backend',

  [string]$EnvFile = '',

  [string]$BackupRoot = '',

  [string]$StagingRoot = '',

  [string]$HealthUrl = 'http://127.0.0.1/api/health',

  [int]$HealthcheckAttempts = 12,

  [int]$HealthcheckDelaySec = 5,

  [ValidateSet('0', '1')]
  [string]$RunMigrations = '1',

  [ValidateSet('0', '1')]
  [string]$RestartService = '1',

  # The F22 tripwire manifest. Every path here is asserted to exist, as a
  # FILE, on the live root immediately after the plugin/dist swap (step 5).
  # plugin-integration-core/lib/stock-preparation-preflight.cjs is the exact
  # file the live r7 upgrade lost to F22; app.manifest.json is the file that
  # declares the application to the platform and is equally load-bearing.
  [string[]]$MustExistManifest = @(
    'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs',
    'plugins/plugin-integration-core/app.manifest.json',
    'packages/core-backend/dist/src/db/migrate.js',
    'apps/web/dist/index.html'
  ),

  # Backed up (relative to RootDir) before anything is touched. A path that
  # does not exist on this host is skipped with a warning, not a failure —
  # not every on-prem host has a config/ directory.
  [string[]]$BackupPaths = @(
    'docker',
    'config',
    'packages/core-backend/dist',
    'apps/web/dist',
    'plugins'
  ),

  # Runtime paths under the extracted package that fully replace the same
  # path under RootDir (delete-then-copy; these never carry node_modules).
  [string[]]$ReplaceDirs = @(
    'packages/core-backend/dist',
    'apps/web/dist',
    'packages/core-backend/migrations'
  )
)

$ErrorActionPreference = 'Stop'

function Write-Info {
  param([string]$Message)
  Write-Host "[multitable-onprem-upgrade-inplace] $Message"
}

function Write-Err {
  param([string]$Message)
  Write-Host "[multitable-onprem-upgrade-inplace] ERROR: $Message" -ForegroundColor Red
}

# ── Step 1: package verification ──────────────────────────────────────────

function Get-FileSha256Hex {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-PackageChecksum {
  <#
    Verifies $ArchivePath's SHA-256 against a sidecar file in the
    "<hex>  <filename>" sha256sum format (matches write_sha_file in
    multitable-onprem-package-build.sh). Throws on any failure to verify —
    there is no "proceed anyway" path. Returns the verified lowercase hex
    digest on success.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [string]$ShaSidecarPath = ''
  )

  if ([string]::IsNullOrWhiteSpace($ShaSidecarPath)) {
    $ShaSidecarPath = "$ArchivePath.sha256"
  }

  if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
    throw "PACKAGE_ARCHIVE_MISSING: $ArchivePath"
  }
  if (-not (Test-Path -LiteralPath $ShaSidecarPath -PathType Leaf)) {
    throw "PACKAGE_CHECKSUM_SIDECAR_MISSING: $ShaSidecarPath"
  }

  $sidecarLine = Get-Content -LiteralPath $ShaSidecarPath -TotalCount 1
  if ($sidecarLine -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
    throw "PACKAGE_CHECKSUM_SIDECAR_MALFORMED: $ShaSidecarPath"
  }
  $expected = $Matches[1].ToLowerInvariant()
  $actual = Get-FileSha256Hex -Path $ArchivePath

  if ($actual -ne $expected) {
    throw "PACKAGE_CHECKSUM_MISMATCH: expected $expected but computed $actual for $ArchivePath. Refusing to upgrade with an unverified package."
  }

  return $actual
}

# ── Step 2: pm2 control ───────────────────────────────────────────────────

function Resolve-Pm2Command {
  param([string]$BaseDir)
  $localPm2 = Join-Path $BaseDir 'node_modules\.bin\pm2.cmd'
  if (Test-Path -LiteralPath $localPm2) {
    return $localPm2
  }
  return 'pm2'
}

function Stop-Pm2App {
  param(
    [string]$Pm2Command,
    [string]$Name
  )
  Write-Info "Stop pm2 app: $Name"
  & $Pm2Command stop $Name
  if ($LASTEXITCODE -ne 0) {
    Write-Info "pm2 stop reported exit=$LASTEXITCODE for '$Name' (continuing: the app may not have been running yet)"
  }
}

# ── Step 3: backup, and the F22-safe walk-files copy used everywhere ──────

function Test-IsNodeModulesRelativePath {
  <#
    True when any path segment of the given RELATIVE path is exactly
    'node_modules'. Pure string logic, no filesystem access, so this is unit
    testable on its own without touching disk.
  #>
  param([string]$RelativePath)

  $normalized = $RelativePath -replace '\\', '/'
  $segments = $normalized.Split('/') | Where-Object { $_ -ne '' }
  $match = $segments | Where-Object { $_ -eq 'node_modules' }
  return [bool]$match
}

function Copy-TreeExcludingNodeModules {
  <#
    THE F22 FIX. Enumerates every FILE under $Source with
    Get-ChildItem -Recurse -File (never -Exclude), computes each file's path
    relative to $Source, skips any file whose relative path contains a
    'node_modules' segment (Test-IsNodeModulesRelativePath), and copies the
    remainder to the matching relative path under $Destination, creating
    parent directories as needed.

    Do NOT rewrite this as `Copy-Item -Recurse -Exclude 'node_modules'` or as
    `Get-ChildItem -Recurse -Exclude 'node_modules' | Copy-Item ...`. That
    combination is exactly what dropped the entire plugin-integration-core
    lib/ directory during the live r7 upgrade (F22): -Exclude on a recursive
    Get-ChildItem/Copy-Item call does not reliably filter every directory
    produced by recursion, so a sibling directory can be silently skipped
    along with the node_modules directory it was meant to exclude. Walking
    files one at a time and testing each file's own relative path is the fix.

    Returns a [pscustomobject] with Copied and Skipped file counts.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "COPY_SOURCE_MISSING: $Source"
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $sourceFull = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\', '/')

  $copied = 0
  $skipped = 0

  Get-ChildItem -LiteralPath $sourceFull -Recurse -File -Force | ForEach-Object {
    $relative = $_.FullName.Substring($sourceFull.Length).TrimStart('\', '/')
    if (Test-IsNodeModulesRelativePath -RelativePath $relative) {
      $skipped += 1
      return
    }
    $destPath = Join-Path $Destination $relative
    $destParent = Split-Path -Parent $destPath
    if (-not (Test-Path -LiteralPath $destParent)) {
      New-Item -ItemType Directory -Force -Path $destParent | Out-Null
    }
    Copy-Item -LiteralPath $_.FullName -Destination $destPath -Force
    $copied += 1
  }

  return [pscustomobject]@{ Copied = $copied; Skipped = $skipped }
}

function Get-DeployedFileCount {
  <#
    Counts files under $Path, excluding any under a node_modules segment.
    Used only for the informational per-plugin lib/ comparison in step 5 —
    zero if $Path does not exist (a plugin that predates a new lib/ file is
    not itself an error; the manifest assertion is the hard gate).
  #>
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return 0
  }
  $full = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\', '/')
  $files = Get-ChildItem -LiteralPath $full -Recurse -File -Force | Where-Object {
    $relative = $_.FullName.Substring($full.Length).TrimStart('\', '/')
    -not (Test-IsNodeModulesRelativePath -RelativePath $relative)
  }
  return @($files).Count
}

function New-TimestampedBackup {
  <#
    Copies $RelativePaths (relative to $RootDir) into a timestamped folder
    under $BackupRoot, walking files (Copy-TreeExcludingNodeModules) rather
    than a recursive Copy-Item -Exclude — see that function's header for why.
    A path absent on this host is skipped with a warning, not a failure.
    Returns the backup folder's full path.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths,
    [string]$Timestamp = ''
  )

  if ([string]::IsNullOrWhiteSpace($Timestamp)) {
    $Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  }

  $target = Join-Path $BackupRoot "upgrade-backup-$Timestamp"
  New-Item -ItemType Directory -Force -Path $target | Out-Null

  foreach ($rel in $RelativePaths) {
    $src = Join-Path $RootDir $rel
    if (-not (Test-Path -LiteralPath $src)) {
      Write-Info "Backup skip (not present on this host): $rel"
      continue
    }

    $dst = Join-Path $target $rel
    $item = Get-Item -LiteralPath $src
    if ($item.PSIsContainer) {
      $result = Copy-TreeExcludingNodeModules -Source $src -Destination $dst
      Write-Info ("Backed up {0} -> {1} ({2} files, {3} node_modules files preserved-in-place/skipped)" -f $rel, $dst, $result.Copied, $result.Skipped)
    } else {
      $dstParent = Split-Path -Parent $dst
      New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Force
      Write-Info "Backed up $rel -> $dst"
    }
  }

  return $target
}

# ── Step 4: extract + replace ──────────────────────────────────────────────

function Resolve-StagingBase {
  param([string]$Candidate)

  $tempBase = $Candidate
  if ([string]::IsNullOrWhiteSpace($tempBase)) {
    $tempBase = $env:METASHEET_ONPREM_STAGING_ROOT
  }
  if ([string]::IsNullOrWhiteSpace($tempBase)) {
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
      $tempBase = 'C:\ms-tmp'
    } else {
      $tempBase = [System.IO.Path]::GetTempPath()
    }
  }

  $tempBase = [System.IO.Path]::GetFullPath($tempBase.Trim().Trim('"'))
  New-Item -ItemType Directory -Force -Path $tempBase | Out-Null
  return (Resolve-Path -LiteralPath $tempBase).Path
}

function New-ShortTempDirectory {
  param(
    [string]$Prefix = 'mspui',
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

function Expand-UpgradePackage {
  param(
    [string]$ArchivePath,
    [string]$TargetDir
  )
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TargetDir -Force
}

function Resolve-PackageRoot {
  <#
    A package zip contains one top-level directory (the package name). Find
    it, or fail loudly rather than guess.
  #>
  param([string]$ExtractRoot)

  $entries = Get-ChildItem -LiteralPath $ExtractRoot -Directory
  if (@($entries).Count -eq 1) {
    return $entries[0].FullName
  }
  # Some archives are already package-root-flat (no wrapper directory).
  if (Test-Path -LiteralPath (Join-Path $ExtractRoot 'PACKAGE-METADATA.json')) {
    return $ExtractRoot
  }
  throw "PACKAGE_ROOT_AMBIGUOUS: expected exactly one top-level directory under $ExtractRoot, found $(@($entries).Count)"
}

function Update-ReplaceDirs {
  <#
    Full delete-then-copy for build-artifact directories that never carry
    node_modules (dist / migrations). Still walks files rather than trusting
    a bare recursive Copy-Item, for the same reason as everywhere else in
    this script: consistency beats a second code path to audit.
  #>
  param(
    [string]$PackageRoot,
    [string]$RootDir,
    [string[]]$RelativeDirs
  )

  foreach ($rel in $RelativeDirs) {
    $src = Join-Path $PackageRoot $rel
    if (-not (Test-Path -LiteralPath $src -PathType Container)) {
      throw "PACKAGE_MISSING_REPLACE_DIR: $rel not found under extracted package"
    }
    $dst = Join-Path $RootDir $rel
    if (Test-Path -LiteralPath $dst) {
      Remove-Item -LiteralPath $dst -Recurse -Force
    }
    $result = Copy-TreeExcludingNodeModules -Source $src -Destination $dst
    Write-Info ("Replaced {0} ({1} files)" -f $rel, $result.Copied)
  }
}

function Update-Plugins {
  <#
    Overlays every plugin directory shipped in the package onto the live
    plugins/ tree, one plugin at a time, walking files and skipping any
    node_modules path on both sides. The live plugin's node_modules is never
    scanned, never deleted, never written to — this is the "preserving each
    plugin's node_modules" requirement, and it holds even though on-prem
    packages ship no node_modules of their own (build-time policy), because
    this function does not depend on that policy to stay true.
  #>
  param(
    [string]$PackageRoot,
    [string]$RootDir
  )

  $packagePluginsDir = Join-Path $PackageRoot 'plugins'
  if (-not (Test-Path -LiteralPath $packagePluginsDir -PathType Container)) {
    throw "PACKAGE_MISSING_PLUGINS_DIR: plugins/ not found under extracted package"
  }

  $livePluginsDir = Join-Path $RootDir 'plugins'
  New-Item -ItemType Directory -Force -Path $livePluginsDir | Out-Null

  Get-ChildItem -LiteralPath $packagePluginsDir -Directory | ForEach-Object {
    $pluginSrc = $_.FullName
    $pluginName = $_.Name
    $pluginDst = Join-Path $livePluginsDir $pluginName
    $result = Copy-TreeExcludingNodeModules -Source $pluginSrc -Destination $pluginDst
    Write-Info ("Replaced plugins/{0} ({1} files, node_modules preserved)" -f $pluginName, $result.Copied)
  }
}

# ── Step 5: the F22 tripwire ────────────────────────────────────────────────

function Assert-MustExistFiles {
  <#
    THE F22 TRIPWIRE. Every relative path in $RelativePaths must exist as a
    FILE under $RootDir after the swap. Throws UPGRADE_ASSERTION_MISSING_FILES
    naming every missing path when any are absent — this is the check that
    would have caught F22 the day it happened, instead of a hand audit
    catching it afterward.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths
  )

  $missing = @()
  foreach ($rel in $RelativePaths) {
    $full = Join-Path $RootDir $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $missing += $rel
    }
  }

  if ($missing.Count -gt 0) {
    throw "UPGRADE_ASSERTION_MISSING_FILES: $($missing -join ', ')"
  }

  return $true
}

function Write-PluginLibFileCountReport {
  <#
    Informational, not a gate on its own (Assert-MustExistFiles is the gate):
    prints package-declared vs now-deployed file count for each plugin's
    lib/, side by side, so a count regression is visible even when it does
    not happen to touch a manifest path.
  #>
  param(
    [string]$PackageRoot,
    [string]$RootDir
  )

  $packagePluginsDir = Join-Path $PackageRoot 'plugins'
  if (-not (Test-Path -LiteralPath $packagePluginsDir -PathType Container)) {
    return
  }

  Write-Info 'Plugin lib/ file count (package vs deployed):'
  Get-ChildItem -LiteralPath $packagePluginsDir -Directory | ForEach-Object {
    $pluginName = $_.Name
    $packageLib = Join-Path $_.FullName 'lib'
    if (-not (Test-Path -LiteralPath $packageLib -PathType Container)) {
      return
    }
    $deployedLib = Join-Path $RootDir "plugins\$pluginName\lib"
    $packageCount = Get-DeployedFileCount -Path $packageLib
    $deployedCount = Get-DeployedFileCount -Path $deployedLib
    $flag = ''
    if ($packageCount -ne $deployedCount) {
      $flag = '  <-- MISMATCH'
    }
    Write-Info ("  {0,-32} package={1,4}  deployed={2,4}{3}" -f $pluginName, $packageCount, $deployedCount, $flag)
  }
}

function Write-PluginsSummary {
  param([string]$RootDir)

  $pluginsDir = Join-Path $RootDir 'plugins'
  if (-not (Test-Path -LiteralPath $pluginsDir -PathType Container)) {
    return
  }

  Write-Info 'Plugins summary:'
  Get-ChildItem -LiteralPath $pluginsDir -Directory | Sort-Object Name | ForEach-Object {
    $pkgJsonPath = Join-Path $_.FullName 'package.json'
    $version = 'unknown'
    if (Test-Path -LiteralPath $pkgJsonPath -PathType Leaf) {
      try {
        $pkgJson = Get-Content -LiteralPath $pkgJsonPath -Raw | ConvertFrom-Json
        if ($pkgJson.version) {
          $version = [string]$pkgJson.version
        }
      } catch {
        $version = 'unreadable package.json'
      }
    }
    Write-Info ("  {0,-32} version={1}" -f $_.Name, $version)
  }
}

# ── Step 6: migrations with real env ────────────────────────────────────────

function Import-AppEnvFile {
  <#
    Mirror of Import-AppEnvFile in multitable-onprem-apply-package.ps1 /
    attendance-onprem-start-pm2.ps1. Loads KEY=VALUE lines from $EnvFile into
    this process's environment (skipping blank lines and '#' comments,
    stripping a single layer of matching quotes) so a child `node migrate.js`
    inherits DATABASE_URL / JWT_SECRET / etc. pm2 does NOT reliably reload
    env on a bare restart, which is exactly why this step exists — a stale
    pm2-held env is a silent, hard-to-diagnose migration/runtime failure.
  #>
  param([string]$EnvFile)

  $applied = 0
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

function Invoke-CheckedCommand {
  param(
    [string]$Description,
    [scriptblock]$Command
  )

  Write-Info $Description
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed (exit=$LASTEXITCODE)"
  }
}

# ── Step 7: restart + healthcheck ───────────────────────────────────────────

function Wait-ForHealthOk {
  param(
    [string]$HealthUrl,
    [int]$Attempts = 12,
    [int]$DelaySec = 5
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 10
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return [pscustomobject]@{
          Ok         = $true
          Attempt    = $attempt
          StatusCode = $response.StatusCode
          Body       = $response.Content
        }
      }
      Write-Info "Healthcheck attempt $attempt/$Attempts returned status $($response.StatusCode)"
    } catch {
      Write-Info "Healthcheck attempt $attempt/$Attempts failed: $($_.Exception.Message)"
    }
    if ($attempt -lt $Attempts) {
      Start-Sleep -Seconds $DelaySec
    }
  }

  return [pscustomobject]@{ Ok = $false; Attempt = $Attempts; StatusCode = $null; Body = $null }
}

# ── Main (skipped when dot-sourced, so tests can load the functions above
#    without running the upgrade) ───────────────────────────────────────────

if ($MyInvocation.InvocationName -ne '.') {
  $resolvedRoot = (Resolve-Path -LiteralPath $RootDir).Path
  $resolvedArchive = (Resolve-Path -LiteralPath $PackageArchive).Path
  $packageBaseName = Split-Path -Leaf $resolvedArchive

  $resolvedEnvFile = $EnvFile
  if ([string]::IsNullOrWhiteSpace($resolvedEnvFile)) {
    $resolvedEnvFile = Join-Path $resolvedRoot 'docker\app.env'
  } else {
    $resolvedEnvFile = (Resolve-Path -LiteralPath $resolvedEnvFile).Path
  }

  $resolvedBackupRoot = $BackupRoot
  if ([string]::IsNullOrWhiteSpace($resolvedBackupRoot)) {
    $resolvedBackupRoot = Join-Path $resolvedRoot 'output\backups'
  }
  New-Item -ItemType Directory -Force -Path $resolvedBackupRoot | Out-Null

  $pm2Command = Resolve-Pm2Command -BaseDir $resolvedRoot

  Write-Info '=== Step 1/8: verify package checksum ==='
  $verifiedSha = Test-PackageChecksum -ArchivePath $resolvedArchive
  Write-Info "Package verified: $packageBaseName sha256=$verifiedSha"

  Write-Info '=== Step 2/8: stop pm2 app ==='
  Stop-Pm2App -Pm2Command $pm2Command -Name $Pm2AppName

  Write-Info '=== Step 3/8: back up current install ==='
  $backupPath = New-TimestampedBackup -RootDir $resolvedRoot -BackupRoot $resolvedBackupRoot -RelativePaths $BackupPaths
  Write-Host "BACKUP_PATH=$backupPath"

  Write-Info '=== Step 4/8: extract + replace runtime paths ==='
  $stagingBase = Resolve-StagingBase -Candidate $StagingRoot
  $extractRoot = New-ShortTempDirectory -Prefix 'mspui' -BaseRoot $stagingBase
  Write-Info "Staging extract root: $extractRoot"
  try {
    Expand-UpgradePackage -ArchivePath $resolvedArchive -TargetDir $extractRoot
    $packageRoot = Resolve-PackageRoot -ExtractRoot $extractRoot
    Write-Info "Extracted package root: $packageRoot"

    Update-ReplaceDirs -PackageRoot $packageRoot -RootDir $resolvedRoot -RelativeDirs $ReplaceDirs
    Update-Plugins -PackageRoot $packageRoot -RootDir $resolvedRoot

    Write-Info '=== Step 5/8: assert must-exist files (F22 tripwire) ==='
    try {
      Assert-MustExistFiles -RootDir $resolvedRoot -RelativePaths $MustExistManifest | Out-Null
    } catch {
      Write-Err $_.Exception.Message
      Write-Err "STOP. Restore packages/core-backend/dist, apps/web/dist, packages/core-backend/migrations, and plugins/ from: $backupPath"
      throw
    }
    Write-Info 'Must-exist manifest: OK, all files present'
    Write-PluginLibFileCountReport -PackageRoot $packageRoot -RootDir $resolvedRoot
  } finally {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Info '=== Step 6/8: run migrations ==='
  Set-Location $resolvedRoot
  $migrationExit = 'skipped'
  if ($RunMigrations -ne '0') {
    if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) {
      throw "ENV_FILE_MISSING: $resolvedEnvFile. STOP. Restore from: $backupPath"
    }
    $importedCount = Import-AppEnvFile -EnvFile $resolvedEnvFile
    Write-Info "Loaded $importedCount vars from $resolvedEnvFile (migration/restart/healthcheck inherit these)"

    $migratePath = Join-Path $resolvedRoot 'packages\core-backend\dist\src\db\migrate.js'
    if (-not (Test-Path -LiteralPath $migratePath -PathType Leaf)) {
      throw "MIGRATE_ENTRYPOINT_MISSING: $migratePath. STOP. Restore from: $backupPath"
    }
    try {
      Invoke-CheckedCommand "Run database migrations ($migratePath)" { node $migratePath }
      $migrationExit = 0
    } catch {
      Write-Err $_.Exception.Message
      Write-Err "STOP. Migrations failed. Restore packages/core-backend/dist and packages/core-backend/migrations from: $backupPath"
      throw
    }
  } else {
    Write-Info 'RunMigrations=0: skipped'
  }

  Write-Info '=== Step 7/8: restart pm2 + healthcheck ==='
  if ($RestartService -ne '0') {
    & $pm2Command restart $Pm2AppName --update-env
    if ($LASTEXITCODE -ne 0) {
      Write-Err "pm2 restart failed for $Pm2AppName (exit=$LASTEXITCODE)"
      Write-Err "STOP. Service did not restart. Restore from: $backupPath"
      throw "PM2_RESTART_FAILED: exit=$LASTEXITCODE"
    }
  } else {
    Write-Info 'RestartService=0: skipped'
  }

  $health = [pscustomobject]@{ Ok = $true; Attempt = 0; StatusCode = $null; Body = 'skipped (RestartService=0)' }
  if ($RestartService -ne '0') {
    $health = Wait-ForHealthOk -HealthUrl $HealthUrl -Attempts $HealthcheckAttempts -DelaySec $HealthcheckDelaySec
  }
  Write-PluginsSummary -RootDir $resolvedRoot

  Write-Info '=== Step 8/8: final report ==='
  Write-Host ''
  Write-Host '===== multitable-onprem-package-upgrade-inplace: final report ====='
  Write-Host "package:          $packageBaseName"
  Write-Host "backup path:      $backupPath"
  Write-Host "migration exit:   $migrationExit"
  Write-Host "health:           $(if ($health.Ok) { 'OK' } else { 'FAILED' }) (attempt=$($health.Attempt), status=$($health.StatusCode))"
  Write-Host ''
  Write-Host 'Next (do not skip these):'
  Write-Host '  1) Preflight:'
  Write-Host '       GET <base-url>/api/integration/stock-preparation/preflight'
  Write-Host '     Fix every listed blocker with its own fix.run until "ready": true.'
  Write-Host '  2) Acceptance bootstrap (env-only input, see script header for full list):'
  Write-Host '       node scripts/ops/stock-prep-acceptance-bootstrap.mjs'
  Write-Host '     Requires MS_API, MS_TOKEN, MS_PROJECT_NO, MS_PACK_ID, MS_DATA_SOURCE_ID,'
  Write-Host '     MS_EXTERNAL_SYSTEM_ID set in the environment beforehand.'
  Write-Host '===================================================================='

  if (-not $health.Ok) {
    throw "HEALTHCHECK_FAILED after $HealthcheckAttempts attempts against $HealthUrl. STOP. Backup at: $backupPath"
  }
}
