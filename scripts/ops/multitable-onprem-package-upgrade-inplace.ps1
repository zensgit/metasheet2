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
    2. Raise the maintenance gate (write MaintenanceFlagPath, default
       <RootDir>\output\maintenance.flag — nginx returns 503 + Retry-After for
       /api/* while it exists, see ops/nginx/multitable-onprem.conf.example),
       THEN stop the pm2 app (name parameterized, default metasheet-backend).
       The flag is refused outright if it would live inside any ReplaceDirs
       entry, and a finally block deletes it on every exit path. Between the
       two, probe HealthUrl ONCE while the backend is still up: 503 proves
       this host's nginx really reads the flag, 200 proves it does not (the
       example conf was never hand-synced here) and prints
       MAINTENANCE_GATE_NOT_WIRED. Diagnostic only, never blocks the upgrade —
       without it "maintenance flag: ... (removed)" would read like proof the
       window was shielded on a host where the flag is inert.
    3. Back up docker/, config/, packages/core-backend/dist, apps/web/dist,
       and plugins/ (excluding node_modules) to a timestamped folder. Prints
       the backup path.
    4. Extract the package to a staging dir. Replace
       packages/core-backend/dist, apps/web/dist,
       packages/core-backend/migrations, and plugins/ — plugins by walking
       files, preserving each plugin's own node_modules.
    5. Assert a manifest of must-exist files after the swap (the F22
       tripwire), THEN assert every file under the package's plugins/ tree
       (node_modules excluded) exists on disk with an IDENTICAL SHA-256 —
       the real F22 net, strictly stronger than the file-count comparison
       still printed alongside it for human skimming — THEN assert none of
       the package's own excluded node_modules content leaked to an
       unexpected location (the negative half of the net; the positive hash
       check alone cannot see this). Refuses to proceed on any missing file,
       hash mismatch, or detected leak.
    6. Run migrations with env loaded from docker/app.env into this process
       (pm2 holds stale env otherwise).
    7. Restart pm2 with env reload; poll the BACKEND DIRECTLY
       (http://127.0.0.1:<PORT>/health, PORT read from the env file) until ok
       or timeout; drop the maintenance gate; only then poll the public
       endpoint through nginx. r29 (2026-09-11) proved why the order matters:
       with the gate up, nginx answers 503 to /api/health too, so probing
       nginx first made the script fail its own healthcheck 12 times and exit
       -1 on an upgrade whose backend was already serving. Print a plugins
       summary.
    8. Print a final report: package name, backup path, migration exit,
       health, and the exact operator commands to run next (preflight +
       acceptance bootstrap).

  NO ROLLBACK AUTOMATION in this MVP. Steps 4-7 (the entire mutation window,
  from the first file replaced through the health check) run inside ONE
  failure handler: ANY exception there — a mid-swap failure, a failed
  assertion, a failed migration, a failed pm2 restart, or a failed
  healthcheck — stops pm2 (so a broken build is never left running), prints
  a clearly-boxed restore block naming the backup path and the exact
  copy-back command for every replaced path, then rethrows. It never
  continues past a failure in that window.

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

  # Backend-direct probe, bypassing nginx entirely. Empty = derive
  # http://127.0.0.1:<PORT>/health with PORT read out of the env file (see
  # Get-EnvFileValue / Resolve-BackendHealthUrl). This probe MUST come first:
  # while the maintenance flag is up, nginx answers 503 to /api/* — including
  # this script's own healthcheck. r29 (2026-09-11) burned a window on exactly
  # that: the backend was already healthy, the flag was still up, the nginx
  # probe got 12 x 503, and the script exited -1 on a successful upgrade.
  [string]$BackendHealthUrl = '',

  # Fallback when the env file declares no PORT (matches
  # packages/core-backend/src/config.ts: parseInt(process.env.PORT || '8900')).
  [int]$BackendDefaultPort = 8900,

  [int]$HealthcheckAttempts = 12,

  [int]$HealthcheckDelaySec = 5,

  # The maintenance gate nginx tests for. While this file exists, nginx answers
  # 503 + Retry-After to /api/* and serves the static maintenance page on /, so
  # testers see "维护中" instead of ERR_CONNECTION_RESET during the pm2 restart
  # window. Empty = <RootDir>\output\maintenance.flag. It MUST NOT live under
  # any ReplaceDirs entry (see Assert-MaintenanceFlagOutsideReplaceDirs): those
  # directories are deleted and recopied wholesale mid-upgrade, which would drop
  # the gate at the worst possible moment and leave a flag file that the next
  # upgrade's replace step would silently resurrect or destroy.
  [string]$MaintenanceFlagPath = '',

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

    NON-GOAL, DOCUMENTED RATHER THAN FIXED: this function walks FILES, so a
    genuinely empty directory under $Source is never recreated under
    $Destination. Harmless for this script's actual payloads (dist/,
    migrations/, plugin lib/ trees never ship meaningfully-empty
    directories), but worth stating plainly rather than implying otherwise.
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
    Overlays every plugin directory, AND any loose file, shipped at the
    package's plugins/ root onto the live plugins/ tree, walking files and
    skipping any node_modules path on both sides. The live plugin's
    node_modules is never scanned, never deleted, never written to — this is
    the "preserving each plugin's node_modules" requirement.

    NON-GOAL, DOCUMENTED RATHER THAN FIXED: a directory literally named
    `node_modules` sitting directly at the package's plugins/ root (i.e.
    plugins/node_modules/..., as opposed to plugins/<name>/node_modules/...)
    would be enumerated by the -Directory listing below like any other
    plugin and copied under that name — this function does not special-case
    that shape. It is safe only because
    multitable-onprem-package-build.sh's prune_node_modules sweeps every
    node_modules directory out of the package before it is archived, so a
    package never actually ships that shape. An earlier revision of this
    docstring claimed this function's node_modules handling did not depend
    on that build-time policy; that claim was wrong for this specific case
    and has been corrected here.
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

  # Loose files directly at plugins/ (not inside any plugin subdirectory) are
  # real package content too — a per-directory-only listing silently dropped
  # these. -Force so a hidden loose file is not silently skipped either.
  Get-ChildItem -LiteralPath $packagePluginsDir -File -Force | ForEach-Object {
    $destPath = Join-Path $livePluginsDir $_.Name
    Copy-Item -LiteralPath $_.FullName -Destination $destPath -Force
    Write-Info ("Replaced plugins/{0} (loose file)" -f $_.Name)
  }

  # -Force: a plugin directory marked hidden must not be silently skipped —
  # a directory listing this function trusts must not quietly drop entries,
  # the same lesson F22 taught about copy operations in general.
  Get-ChildItem -LiteralPath $packagePluginsDir -Directory -Force | ForEach-Object {
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

function Assert-PluginTreesMatchPackage {
  <#
    THE REAL F22 NET. Assert-MustExistFiles only proves a FIXED list of
    paths exist; a file-COUNT comparison (Write-PluginLibFileCountReport
    below) is weaker still and actively misleading in the steady state: this
    overlay copy never deletes stale files, so "deployed count > package
    count" is NORMAL after even one prior upgrade — a chronic false
    MISMATCH, not a signal. Neither would catch a same-count,
    different-content regression, a repeat upgrade where a STALE file from a
    prior install happens to satisfy Assert-MustExistFiles by existing at
    the right path with the WRONG content, or any future silent-skip
    regression regardless of what syntax caused it.

    This is the actual gate: for EVERY file under $PackageRoot/plugins
    (walked with Get-ChildItem -Recurse -File -Force, node_modules paths
    excluded via Test-IsNodeModulesRelativePath — never -Exclude), assert
    the matching relative path exists under $RootDir/plugins with an
    IDENTICAL SHA-256 to the package's copy. It does not care HOW a file
    failed to arrive correctly, only THAT it did.

    Throws UPGRADE_PLUGIN_HASH_VERIFICATION_FAILED naming every offending
    relative path (MISSING or HASH_MISMATCH, capped for readability) when
    any file fails to verify. Returns the number of files checked on
    success.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$RootDir
  )

  $packagePluginsDir = Join-Path $PackageRoot 'plugins'
  if (-not (Test-Path -LiteralPath $packagePluginsDir -PathType Container)) {
    throw "PACKAGE_MISSING_PLUGINS_DIR: plugins/ not found under extracted package"
  }
  $packageFull = (Resolve-Path -LiteralPath $packagePluginsDir).Path.TrimEnd('\', '/')
  $liveDir = Join-Path $RootDir 'plugins'

  $problems = @()
  $checked = 0

  Get-ChildItem -LiteralPath $packageFull -Recurse -File -Force | ForEach-Object {
    $relative = $_.FullName.Substring($packageFull.Length).TrimStart('\', '/')
    if (Test-IsNodeModulesRelativePath -RelativePath $relative) {
      return
    }
    $checked += 1
    $deployedPath = Join-Path $liveDir $relative
    if (-not (Test-Path -LiteralPath $deployedPath -PathType Leaf)) {
      $problems += "MISSING: $relative"
      return
    }
    $packageHash = Get-FileSha256Hex -Path $_.FullName
    $deployedHash = Get-FileSha256Hex -Path $deployedPath
    if ($packageHash -ne $deployedHash) {
      $problems += "HASH_MISMATCH: $relative"
    }
  }

  if ($problems.Count -gt 0) {
    $shown = $problems | Select-Object -First 25
    $more = ''
    if ($problems.Count -gt 25) {
      $more = " (+$($problems.Count - 25) more)"
    }
    throw "UPGRADE_PLUGIN_HASH_VERIFICATION_FAILED ($checked files checked): $($shown -join '; ')$more"
  }

  return $checked
}

function Assert-NoNodeModulesContentLeaked {
  <#
    THE NEGATIVE HALF OF THE F22 NET. Assert-PluginTreesMatchPackage is
    strictly one-directional: it proves every file that SHOULD be copied WAS
    copied correctly, but it cannot notice that node_modules content ALSO
    leaked through to some other, wrong location — which is exactly what the
    forbidden `-Exclude` pattern does. `Get-ChildItem -Recurse -Exclude
    'node_modules' | Copy-Item -Recurse` excludes only items literally NAMED
    node_modules from a flat listing; every descendant of an excluded
    node_modules directory is still individually emitted by -Recurse and
    still gets copied — typically to a wrong, flattened path rather than
    being dropped, so the CORRECT files can end up present and correct at
    the same time node_modules content leaks in elsewhere. A pure
    existence+hash check on the package's own file list would not notice.

    Hashes every file under $PackageRoot/plugins whose relative path DOES
    contain a node_modules segment (the files a correct walk skips), then
    asserts none of those hashes appear anywhere under the deployed plugins
    tree OUTSIDE of a node_modules segment (a legitimately preserved LIVE
    node_modules is out of scope for this check by design). Files under 8
    bytes are skipped on both sides to avoid a false positive between two
    unrelated, incidentally-empty/trivial files — real leaked module content
    is never that small. Throws UPGRADE_NODE_MODULES_LEAK_DETECTED naming
    the leaked relative path(s) when found. Returns the number of excluded
    package files it hashed (0 when the package ships no node_modules at
    all, the normal case per build policy).
  #>
  param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$RootDir
  )

  $packagePluginsDir = Join-Path $PackageRoot 'plugins'
  if (-not (Test-Path -LiteralPath $packagePluginsDir -PathType Container)) {
    return 0
  }
  $packageFull = (Resolve-Path -LiteralPath $packagePluginsDir).Path.TrimEnd('\', '/')
  $liveDir = Join-Path $RootDir 'plugins'
  if (-not (Test-Path -LiteralPath $liveDir -PathType Container)) {
    return 0
  }
  $liveFull = (Resolve-Path -LiteralPath $liveDir).Path.TrimEnd('\', '/')

  $excludedHashes = @{}
  Get-ChildItem -LiteralPath $packageFull -Recurse -File -Force | ForEach-Object {
    if ($_.Length -lt 8) {
      return
    }
    $relative = $_.FullName.Substring($packageFull.Length).TrimStart('\', '/')
    if (Test-IsNodeModulesRelativePath -RelativePath $relative) {
      $excludedHashes[(Get-FileSha256Hex -Path $_.FullName)] = $relative
    }
  }
  if ($excludedHashes.Count -eq 0) {
    return 0
  }

  $leaks = @()
  Get-ChildItem -LiteralPath $liveFull -Recurse -File -Force | ForEach-Object {
    if ($_.Length -lt 8) {
      return
    }
    $relative = $_.FullName.Substring($liveFull.Length).TrimStart('\', '/')
    if (Test-IsNodeModulesRelativePath -RelativePath $relative) {
      return
    }
    $hash = Get-FileSha256Hex -Path $_.FullName
    if ($excludedHashes.ContainsKey($hash)) {
      $leaks += ("{0} (leaked package node_modules source: {1})" -f $relative, $excludedHashes[$hash])
    }
  }

  if ($leaks.Count -gt 0) {
    throw "UPGRADE_NODE_MODULES_LEAK_DETECTED: $($leaks -join '; ')"
  }

  return $excludedHashes.Count
}

function Write-PluginLibFileCountReport {
  <#
    INFORMATIONAL ONLY — this is deliberately NOT a gate. A file-count
    comparison chronically false-MISMATCHes in the normal steady state
    (this overlay copy never deletes stale files, so deployed count >
    package count after even one prior upgrade is expected, not a defect),
    and it cannot detect a same-count/different-content regression at all.
    Assert-PluginTreesMatchPackage is the actual gate; this print exists
    only so a human skimming the log sees a side-by-side number.
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

# ── The maintenance gate (flag file read by nginx) ──────────────────────────

function Join-RootRelativePath {
  <#
    Builds an absolute path from RootDir + a repo-style relative path, tolerating
    either separator, WITHOUT requiring the path to exist (Resolve-Path cannot be
    used here: the flag file does not exist yet when it is validated, and the
    ReplaceDirs may not exist on a fresh host).
  #>
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$Relative
  )

  $result = $RootDir
  foreach ($segment in ($Relative -split '[\\/]+')) {
    if ([string]::IsNullOrWhiteSpace($segment)) { continue }
    $result = Join-Path $result $segment
  }
  return [System.IO.Path]::GetFullPath($result)
}

function Resolve-MaintenanceFlagPath {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string]$Candidate = ''
  )

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return (Join-RootRelativePath -RootDir $RootDir -Relative 'output/maintenance.flag')
  }
  if ([System.IO.Path]::IsPathRooted($Candidate)) {
    return [System.IO.Path]::GetFullPath($Candidate)
  }
  return (Join-RootRelativePath -RootDir $RootDir -Relative $Candidate)
}

function Assert-MaintenanceFlagOutsideReplaceDirs {
  <#
    Static, pre-flight refusal: the flag must not live inside any directory this
    upgrade deletes and recopies wholesale (Update-ReplaceDirs). If it did, the
    replace step would delete the raised gate mid-upgrade — traffic would hit a
    down backend with a raw connection reset, which is the exact symptom the gate
    exists to remove — and the post-upgrade removal would then be a no-op against
    a path the package may have repopulated. Refuses BEFORE pm2 is touched.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$FlagPath,
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string[]]$ReplaceDirs = @()
  )

  # OrdinalIgnoreCase on every platform: on a case-sensitive filesystem this only
  # refuses MORE paths than strictly necessary, which is the safe direction for a
  # gate whose failure mode is a silently-dropped maintenance window.
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  $flagFull = [System.IO.Path]::GetFullPath($FlagPath)
  $separator = [System.IO.Path]::DirectorySeparatorChar

  foreach ($rel in $ReplaceDirs) {
    $dirFull = Join-RootRelativePath -RootDir $RootDir -Relative $rel
    $dirPrefix = $dirFull.TrimEnd([char]'\', [char]'/') + $separator
    if ($flagFull.Equals($dirFull.TrimEnd([char]'\', [char]'/'), $comparison) -or $flagFull.StartsWith($dirPrefix, $comparison)) {
      throw "MAINTENANCE_FLAG_PATH_INSIDE_REPLACE_DIR: $flagFull is under the replaced directory '$rel' ($dirFull). Pick a path outside every replaced directory, for example <RootDir>\output\maintenance.flag."
    }
  }

  return $flagFull
}

function New-MaintenanceFlag {
  <#
    Raises the gate. Written BEFORE pm2 is stopped so no request can fall into
    the window between "backend down" and "gate up".
  #>
  param([Parameter(Mandatory = $true)][string]$FlagPath)

  $parent = Split-Path -Parent $FlagPath
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Set-Content -LiteralPath $FlagPath -Value "multitable-onprem-package-upgrade-inplace raised this maintenance flag at $stamp. Delete this file to let traffic through again." -Encoding ASCII
  return $FlagPath
}

function Remove-MaintenanceFlag {
  <#
    Drops the gate. Idempotent on purpose: it is called on the success path (as
    soon as the backend answers directly, BEFORE the nginx probe) and again,
    unconditionally, from the finally block in Main — so a flag raised by a run
    that then died anywhere, at any step, never outlives the script.
  #>
  param([Parameter(Mandatory = $true)][string]$FlagPath)

  if (Test-Path -LiteralPath $FlagPath) {
    Remove-Item -LiteralPath $FlagPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $FlagPath) {
      Write-Err "MAINTENANCE_FLAG_STILL_PRESENT: failed to delete $FlagPath — the site will keep answering 503 until this file is removed by hand."
      return $false
    }
    Write-Info "Maintenance flag removed: $FlagPath"
    return $true
  }
  return $false
}

function Test-MaintenanceGateWired {
  <#
    POSITIVE self-witness for the gate. Writing the flag proves nothing on its
    own: nginx only answers 503 if somebody hand-synced the `if (-f ...)` block
    into THIS host's nginx.conf (ops/nginx/multitable-onprem.conf.example is a
    template — editing the repo has zero effect on a running box). On an
    un-synced host the flag is inert, yet the run would still print
    "maintenance flag: ... (removed)" and leave the operator believing a gate
    was up while testers ate ERR_CONNECTION_RESET for 60-90 seconds.

    Called right after the flag is raised and BEFORE pm2 is stopped, so the
    backend is still serving: a 200 through the public URL at that instant can
    only mean "this nginx does not read that file". 503 = wired. Anything else
    (connection refused, 502 from an already-dead backend, a timeout) is
    inconclusive and reported as such.

    NEVER fails the upgrade: refusing to upgrade a host whose nginx.conf was
    never synced would be worse than upgrading it without the gate. This is a
    diagnostic, not a guard.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$ProbeUrl,
    [Parameter(Mandatory = $true)][string]$FlagPath
  )

  $status = $null
  try {
    # The header is for test fixtures/log readers only — nginx's `if (-f ...)`
    # gate is header-blind, so tagging the probe cannot change what it measures.
    $response = Invoke-WebRequest -Uri $ProbeUrl -UseBasicParsing -TimeoutSec 5 -Headers @{ 'X-Upgrade-Gate-Probe' = '1' }
    $status = [int]$response.StatusCode
  } catch {
    # PS 5.1 throws WebException (.Response is HttpWebResponse), pwsh 7 throws
    # HttpResponseException (.Response is HttpResponseMessage); .StatusCode
    # casts to int on both. A transport failure has no .Response at all.
    $failed = $_.Exception.Response
    if ($failed -and $failed.StatusCode) {
      try { $status = [int]$failed.StatusCode } catch { $status = $null }
    }
  }

  if ($status -eq 503) {
    Write-Info "MAINTENANCE_GATE_WIRED: $ProbeUrl answered 503 while $FlagPath exists — nginx really is reading this flag."
    return 'WIRED'
  }
  if ($status -ge 200 -and $status -lt 400) {
    Write-Err "MAINTENANCE_GATE_NOT_WIRED: $ProbeUrl answered $status while the maintenance flag $FlagPath exists. This nginx does not read that file, so the upgrade window will NOT be shielded: users get ERR_CONNECTION_RESET / Failed to fetch while the backend is down. Sync the 'if (-f <flag>) { return 503; }' blocks from ops/nginx/multitable-onprem.conf.example into this host's nginx.conf (nginx -t, then reload as SYSTEM) — see the runbook section 升级窗口的维护门. The upgrade continues regardless."
    return 'NOT_WIRED'
  }
  $observed = if ($null -eq $status) { 'nothing (transport failure)' } else { "status $status" }
  Write-Info "MAINTENANCE_GATE_UNKNOWN: $ProbeUrl answered $observed while the flag was up — cannot tell whether the gate is wired. Verify by hand (see the runbook)."
  return 'UNKNOWN'
}

function Get-EnvFileValue {
  <#
    Reads ONE key out of a KEY=VALUE env file without importing anything into
    this process (Import-AppEnvFile does that, but only when migrations run —
    the backend port must be resolvable even with -RunMigrations 0).
  #>
  param(
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    return $null
  }
  foreach ($rawLine in Get-Content -LiteralPath $EnvFile) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) { continue }
    if ($parts[0].Trim() -ne $Name) { continue }
    $value = $parts[1].Trim()
    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    return $value
  }
  return $null
}

function Resolve-BackendHealthUrl {
  param(
    [string]$Candidate = '',
    [string]$EnvFile = '',
    [int]$DefaultPort = 8900
  )

  if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
    return $Candidate
  }
  $port = $DefaultPort
  if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
    $declared = Get-EnvFileValue -EnvFile $EnvFile -Name 'PORT'
    $parsed = 0
    if ($declared -and [int]::TryParse($declared, [ref]$parsed) -and $parsed -gt 0) {
      $port = $parsed
    }
  }
  return "http://127.0.0.1:$port/health"
}

# ── Step 7: restart + healthcheck ───────────────────────────────────────────

function Wait-ForHealthOk {
  param(
    [string]$HealthUrl,
    [int]$Attempts = 12,
    [int]$DelaySec = 5,
    [string]$Label = 'Healthcheck'
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
      Write-Info "$Label attempt $attempt/$Attempts returned status $($response.StatusCode)"
    } catch {
      Write-Info "$Label attempt $attempt/$Attempts failed: $($_.Exception.Message)"
    }
    if ($attempt -lt $Attempts) {
      Start-Sleep -Seconds $DelaySec
    }
  }

  return [pscustomobject]@{ Ok = $false; Attempt = $Attempts; StatusCode = $null; Body = $null }
}

# ── Failure handling: the restore block ─────────────────────────────────────

function Write-RestoreBlock {
  <#
    Prints a clearly-boxed, copy-pasteable restore procedure: the backup
    path plus an exact per-directory copy-back command for every path this
    script may have replaced. Called from the SINGLE outer failure handler
    that wraps the entire mutation window (extract through health check) in
    Main below, so ANY exception in that window prints this — not just the
    handful of specific assertions that used to print their own ad-hoc
    message. Before this existed, a mid-swap failure (for example, a thrown
    error from inside Update-ReplaceDirs/Update-Plugins themselves) died
    with a raw, uncaught exception and the backup path existed only in
    scrollback the operator had to scroll back to find.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string[]]$ReplacedRelativePaths = @(),
    [string]$Pm2AppName = 'metasheet-backend',
    [string]$MaintenanceFlagPath = ''
  )

  Write-Host ''
  Write-Host '=========================== RESTORE REQUIRED ==========================='
  Write-Host "Backup path: $BackupPath"
  if (-not [string]::IsNullOrWhiteSpace($MaintenanceFlagPath)) {
    Write-Host "Maintenance flag: $MaintenanceFlagPath"
    Write-Host '  This script deletes that flag on exit. If the site still answers 503 afterwards,'
    Write-Host '  delete it by hand:'
    Write-Host ("  Remove-Item -LiteralPath '{0}' -Force" -f $MaintenanceFlagPath)
  }
  Write-Host ''
  Write-Host 'The upgrade did not complete. Restore each replaced path from the backup,'
  Write-Host 'then restart pm2:'
  foreach ($rel in $ReplacedRelativePaths) {
    $backupSrc = Join-Path $BackupPath $rel
    $liveDst = Join-Path $RootDir $rel
    Write-Host ("  Remove-Item -LiteralPath '{0}' -Recurse -Force -ErrorAction SilentlyContinue" -f $liveDst)
    Write-Host ("  Copy-Item -LiteralPath '{0}' -Destination '{1}' -Recurse -Force" -f $backupSrc, $liveDst)
  }
  Write-Host ("  pm2 restart {0} --update-env" -f $Pm2AppName)
  Write-Host '=========================================================================='
  Write-Host ''
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

  # Resolved and validated BEFORE anything at all happens — no pm2 call, no
  # backup directory, no file touched. A flag path inside a replaced directory
  # is a configuration error that must stop the run, not something to discover
  # halfway through the swap.
  $maintenanceFlagPath = Resolve-MaintenanceFlagPath -RootDir $resolvedRoot -Candidate $MaintenanceFlagPath
  $maintenanceFlagPath = Assert-MaintenanceFlagOutsideReplaceDirs -FlagPath $maintenanceFlagPath -RootDir $resolvedRoot -ReplaceDirs $ReplaceDirs
  $resolvedBackendHealthUrl = Resolve-BackendHealthUrl -Candidate $BackendHealthUrl -EnvFile $resolvedEnvFile -DefaultPort $BackendDefaultPort

  $resolvedBackupRoot = $BackupRoot
  if ([string]::IsNullOrWhiteSpace($resolvedBackupRoot)) {
    $resolvedBackupRoot = Join-Path $resolvedRoot 'output\backups'
  }
  New-Item -ItemType Directory -Force -Path $resolvedBackupRoot | Out-Null

  $pm2Command = Resolve-Pm2Command -BaseDir $resolvedRoot
  # Every path this run may replace, for the restore block below — the
  # replace-in-full dirs plus plugins/ (overlaid, not replaced-in-full, but
  # still a path an operator must be told how to restore).
  $restoredRelativePaths = @($ReplaceDirs) + @('plugins')

  Write-Info '=== Step 1/8: verify package checksum ==='
  $verifiedSha = Test-PackageChecksum -ArchivePath $resolvedArchive
  Write-Info "Package verified: $packageBaseName sha256=$verifiedSha"

  Write-Info '=== Step 2/8: stop pm2 app (maintenance gate raised first) ==='

  $maintenanceGate = 'UNKNOWN'
  try {
    # The gate goes up BEFORE the backend goes down, so no request can land in
    # the gap between "pm2 stopped" and "nginx answering 503": that gap is the
    # ERR_CONNECTION_RESET / Failed to fetch testers reported in four separate
    # upgrade windows.
    #
    # The write is the FIRST statement INSIDE the try, never before it. A flag
    # raised on the pre-try lines would outlive any exception thrown between
    # the write and `try {` — nothing would ever delete it and the site would
    # answer 503 forever. Remove-MaintenanceFlag is idempotent, so putting the
    # write inside costs nothing even when this very line is what threw.
    # Everything from here on runs inside the try/finally below, whose finally
    # drops the gate unconditionally — success, refusal, or an exception
    # raised anywhere in between.
    New-MaintenanceFlag -FlagPath $maintenanceFlagPath | Out-Null
    Write-Host "MAINTENANCE_FLAG=$maintenanceFlagPath"

    # Ask the PUBLIC url once, while the flag is up and the backend is still
    # running: 503 proves nginx really reads this flag on THIS host, 200 proves
    # it does not (the conf was never hand-synced). Diagnostic only — it never
    # blocks the upgrade. Inside the try, so its failure still hits the finally
    # that drops the flag.
    $maintenanceGate = Test-MaintenanceGateWired -ProbeUrl $HealthUrl -FlagPath $maintenanceFlagPath

    Stop-Pm2App -Pm2Command $pm2Command -Name $Pm2AppName

    Write-Info '=== Step 3/8: back up current install ==='
    $backupPath = New-TimestampedBackup -RootDir $resolvedRoot -BackupRoot $resolvedBackupRoot -RelativePaths $BackupPaths
    Write-Host "BACKUP_PATH=$backupPath"

    # THE MUTATION WINDOW. From here through the health check, ANY exception —
    # a mid-swap failure inside Update-ReplaceDirs/Update-Plugins, a failed
    # F22/hash assertion, a failed migration, a failed pm2 restart, or a failed
    # healthcheck (raised as an exception below, deliberately, so it flows
    # through this SAME handler instead of a second, easily-forgotten copy of
    # this logic) — is caught by the single handler at the bottom of this
    # block. That handler stops pm2 (a broken deployment must not be left
    # running; Stop-Pm2App tolerates pm2 already being stopped, which is the
    # normal case for every failure point except a failed healthcheck) and
    # prints the restore block, then rethrows. Nothing past step 3 may fail
    # without telling the operator where the backup is.
    try {
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

        Write-Info '=== Step 5/8: assert must-exist files (F22 tripwire) + per-file hash verification ==='
        Assert-MustExistFiles -RootDir $resolvedRoot -RelativePaths $MustExistManifest | Out-Null
        Write-Info 'Must-exist manifest: OK, all files present'
        $verifiedFileCount = Assert-PluginTreesMatchPackage -PackageRoot $packageRoot -RootDir $resolvedRoot
        Write-Info "Plugin hash verification: OK ($verifiedFileCount files checked)"
        $excludedCheckedCount = Assert-NoNodeModulesContentLeaked -PackageRoot $packageRoot -RootDir $resolvedRoot
        Write-Info "Plugin node_modules leak check: OK ($excludedCheckedCount excluded package files checked)"
        Write-PluginLibFileCountReport -PackageRoot $packageRoot -RootDir $resolvedRoot
      } finally {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
      }

      Write-Info '=== Step 6/8: run migrations ==='
      Set-Location $resolvedRoot
      $migrationExit = 'skipped'
      if ($RunMigrations -ne '0') {
        if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) {
          throw "ENV_FILE_MISSING: $resolvedEnvFile"
        }
        $importedCount = Import-AppEnvFile -EnvFile $resolvedEnvFile
        Write-Info "Loaded $importedCount vars from $resolvedEnvFile (migration/restart/healthcheck inherit these)"

        $migratePath = Join-Path $resolvedRoot 'packages\core-backend\dist\src\db\migrate.js'
        if (-not (Test-Path -LiteralPath $migratePath -PathType Leaf)) {
          throw "MIGRATE_ENTRYPOINT_MISSING: $migratePath"
        }
        Invoke-CheckedCommand "Run database migrations ($migratePath)" { node $migratePath }
        $migrationExit = 0
      } else {
        Write-Info 'RunMigrations=0: skipped'
      }

      Write-Info '=== Step 7/8: restart pm2 + healthcheck (backend direct first, then nginx) ==='
      if ($RestartService -ne '0') {
        & $pm2Command restart $Pm2AppName --update-env
        if ($LASTEXITCODE -ne 0) {
          throw "PM2_RESTART_FAILED: exit=$LASTEXITCODE"
        }
      } else {
        Write-Info 'RestartService=0: skipped'
      }

      $backendHealth = [pscustomobject]@{ Ok = $true; Attempt = 0; StatusCode = $null; Body = 'skipped (RestartService=0)' }
      $health = [pscustomobject]@{ Ok = $true; Attempt = 0; StatusCode = $null; Body = 'skipped (RestartService=0)' }
      if ($RestartService -ne '0') {
        # THE ORDER BELOW IS LOAD-BEARING (r29, 2026-09-11). The maintenance gate
        # makes nginx answer 503 to everything under /api/ — this script's own
        # nginx healthcheck included. Probing nginx first meant 12 x 503 and an
        # exit -1 on an upgrade whose backend had been healthy the whole time.
        # So: prove the backend is up by talking to it DIRECTLY (no nginx in the
        # path, so the gate cannot answer for it), only then drop the gate, and
        # only then probe through nginx — which now also proves the gate is
        # really down, because a 200 through /api/ is impossible while it is up.
        $backendHealth = Wait-ForHealthOk -HealthUrl $resolvedBackendHealthUrl -Attempts $HealthcheckAttempts -DelaySec $HealthcheckDelaySec -Label 'Backend-direct healthcheck'
        if ($backendHealth.Ok) {
          Write-Info "Backend answered directly on attempt $($backendHealth.Attempt) ($resolvedBackendHealthUrl); dropping the maintenance gate before the nginx probe"
          Remove-MaintenanceFlag -FlagPath $maintenanceFlagPath | Out-Null
          $health = Wait-ForHealthOk -HealthUrl $HealthUrl -Attempts $HealthcheckAttempts -DelaySec $HealthcheckDelaySec -Label 'Nginx healthcheck'
        } else {
          $health = [pscustomobject]@{ Ok = $false; Attempt = 0; StatusCode = $null; Body = 'not attempted (the backend never answered directly)' }
        }
      }
      Write-PluginsSummary -RootDir $resolvedRoot

      Write-Info '=== Step 8/8: final report ==='
      Write-Host ''
      Write-Host '===== multitable-onprem-package-upgrade-inplace: final report ====='
      Write-Host "package:          $packageBaseName"
      Write-Host "backup path:      $backupPath"
      Write-Host "migration exit:   $migrationExit"
      Write-Host "backend health:   $(if ($backendHealth.Ok) { 'OK' } else { 'FAILED' }) (attempt=$($backendHealth.Attempt), url=$resolvedBackendHealthUrl)"
      Write-Host "health:           $(if ($health.Ok) { 'OK' } else { 'FAILED' }) (attempt=$($health.Attempt), status=$($health.StatusCode))"
      Write-Host "maintenance flag: $maintenanceFlagPath ($(if (Test-Path -LiteralPath $maintenanceFlagPath) { 'STILL PRESENT - removed on exit; if the site keeps answering 503, delete it by hand' } else { 'removed' }))"
      # "(removed)" above says the file is gone; it does NOT say anyone was
      # reading it. This line is the only place the operator learns whether the
      # window was actually shielded on THIS host.
      Write-Host "maintenance gate: $maintenanceGate (probed $HealthUrl while the flag was up; NOT_WIRED = this nginx.conf never got the gate, the window was unshielded)"
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

      if (-not $backendHealth.Ok) {
        throw "BACKEND_HEALTHCHECK_FAILED after $HealthcheckAttempts attempts against $resolvedBackendHealthUrl (the nginx probe was never attempted)"
      }
      if (-not $health.Ok) {
        throw "HEALTHCHECK_FAILED after $HealthcheckAttempts attempts against $HealthUrl"
      }
    } catch {
      Write-Err $_.Exception.Message
      try {
        Stop-Pm2App -Pm2Command $pm2Command -Name $Pm2AppName
      } catch {
        Write-Err "pm2 stop itself failed while handling the error above: $($_.Exception.Message)"
      }
      Write-RestoreBlock -BackupPath $backupPath -RootDir $resolvedRoot -ReplacedRelativePaths $restoredRelativePaths -Pm2AppName $Pm2AppName -MaintenanceFlagPath $maintenanceFlagPath
      throw
    }
  } finally {
    # UNCONDITIONAL. Remove-MaintenanceFlag is idempotent, so the success path
    # (which drops the gate earlier, right after the backend answers directly)
    # and this net cannot fight each other. A maintenance flag that outlives
    # the script is a site-wide 503 nobody is watching for.
    Remove-MaintenanceFlag -FlagPath $maintenanceFlagPath | Out-Null
  }
}
