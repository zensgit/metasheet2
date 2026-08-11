import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

function readScript(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function writeFixtureFile(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
  if (mode) fs.chmodSync(filePath, mode)
}

function createTarArchive(stageRoot, packageName, archivePath) {
  const result = spawnSync('tar', ['-czf', archivePath, '-C', stageRoot, packageName], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

function createNoDepsApplyFixture(startMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-no-deps-apply-'))
  const stageRoot = path.join(root, 'stage')
  const packageName = 'metasheet-no-deps-fixture'
  const packageRoot = path.join(stageRoot, packageName)
  const liveRoot = path.join(root, 'live')
  const archivePath = path.join(root, `${packageName}.tgz`)
  const fakeBin = path.join(root, 'bin')
  const nodeCallMarker = path.join(root, 'node-called.marker')
  const pnpmCallMarker = path.join(root, 'pnpm-called.marker')
  const newStartMarker = path.join(root, 'new-start.marker')
  const oldStartMarker = path.join(root, 'old-start.marker')
  const runtimeStage = path.join(root, 'runtime-stage')

  writeFixtureFile(path.join(packageRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFixtureFile(path.join(packageRoot, 'PACKAGE-METADATA.json'), '{}')
  writeFixtureFile(
    path.join(packageRoot, 'scripts/ops/multitable-onprem-apply-package.ps1'),
    '# package-root marker only',
  )
  writeFixtureFile(path.join(packageRoot, 'payload.txt'), 'new-payload')
  writeFixtureFile(path.join(packageRoot, 'new-only.txt'), 'new-only-payload')
  const newStartTail = startMode === 'throw' ? "throw 'NEW_START_FAILURE'" : '$global:LASTEXITCODE = 0'
  writeFixtureFile(
    path.join(packageRoot, 'scripts/ops/attendance-onprem-start-pm2.ps1'),
    `Set-Content -LiteralPath $env:NEW_START_MARKER -Value 'called' -NoNewline\n${newStartTail}\n`,
  )

  writeFixtureFile(path.join(liveRoot, 'docker/app.env'), 'PORT=8900\n')
  writeFixtureFile(path.join(liveRoot, 'payload.txt'), 'old-payload')
  writeFixtureFile(path.join(liveRoot, 'node_modules/preserved.marker'), 'preserved')
  writeFixtureFile(
    path.join(liveRoot, 'scripts/ops/attendance-onprem-start-pm2.ps1'),
    "Set-Content -LiteralPath $env:OLD_START_MARKER -Value 'called' -NoNewline\n$global:LASTEXITCODE = 0\n",
  )
  writeFixtureFile(
    path.join(fakeBin, 'node'),
    '#!/bin/sh\nprintf called > "$NODE_CALL_MARKER"\nexit 91\n',
    0o755,
  )
  writeFixtureFile(
    path.join(fakeBin, 'pnpm'),
    '#!/bin/sh\nprintf called > "$PNPM_CALL_MARKER"\nexit 92\n',
    0o755,
  )
  createTarArchive(stageRoot, packageName, archivePath)

  return {
    root,
    liveRoot,
    archivePath,
    fakeBin,
    nodeCallMarker,
    pnpmCallMarker,
    newStartMarker,
    oldStartMarker,
    runtimeStage,
  }
}

function runNoDepsApply(
  fixture,
  {
    runHealthcheck,
    baseUrl = 'http://127.0.0.1:1',
    apiBase = 'http://127.0.0.1:1/api',
  },
) {
  const applyHelper = path.join(repoRoot, 'scripts/ops/multitable-onprem-apply-package.ps1')
  return spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      applyHelper,
      '-PackageArchive',
      fixture.archivePath,
      '-RootDir',
      fixture.liveRoot,
      '-StagingRoot',
      fixture.runtimeStage,
      '-InstallDeps',
      '0',
      '-RunMigrations',
      '0',
      '-RestartService',
      '1',
      '-RunHealthcheck',
      runHealthcheck ? '1' : '0',
      '-CheckNginx',
      '0',
      '-BaseUrl',
      baseUrl,
      '-ApiBase',
      apiBase,
      '-HealthcheckAttempts',
      '1',
      '-HealthcheckDelaySec',
      '1',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}`,
        NODE_CALL_MARKER: fixture.nodeCallMarker,
        PNPM_CALL_MARKER: fixture.pnpmCallMarker,
        NEW_START_MARKER: fixture.newStartMarker,
        OLD_START_MARKER: fixture.oldStartMarker,
      },
      encoding: 'utf8',
    },
  )
}

function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    Atomics.wait(sleeper, 0, 0, 25)
  }
  throw new Error(`timed out waiting for ${filePath}`)
}

function startAsymmetricHealthServer(fixture, passingPath) {
  const readyPath = path.join(fixture.root, `health-${passingPath.replaceAll('/', '_')}.port`)
  const serverScript = String.raw`
const fs = require('node:fs')
const http = require('node:http')
const readyPath = process.argv[1]
const oldStartMarker = process.argv[2]
const passingPath = process.argv[3]
const server = http.createServer((request, response) => {
  const restoredRuntime = fs.existsSync(oldStartMarker)
  const ok = restoredRuntime || request.url === passingPath
  response.statusCode = ok ? 200 : 503
  response.end(ok ? 'ok' : 'unavailable')
})
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(readyPath, String(server.address().port))
})
`
  const child = spawn(process.execPath, ['-e', serverScript, readyPath, fixture.oldStartMarker, passingPath], {
    stdio: 'ignore',
  })
  try {
    waitForFile(readyPath)
  } catch (error) {
    child.kill()
    throw error
  }

  const port = Number.parseInt(fs.readFileSync(readyPath, 'utf8'), 10)
  assert.ok(Number.isInteger(port) && port > 0, 'health fixture must publish a valid port')
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop() {
      child.kill()
    },
  }
}

function runNoDepsApplyWithCopyFailure(fixture, { failRestore = false } = {}) {
  const applyHelper = path.join(repoRoot, 'scripts/ops/multitable-onprem-apply-package.ps1')
  const wrapperPath = path.join(fixture.root, 'inject-overlay-copy-failure.ps1')
  writeFixtureFile(
    wrapperPath,
    String.raw`$ErrorActionPreference = 'Stop'
$script:existingDestinationCopied = $false
$script:newDestinationCopied = $false
$script:overlayFailureInjected = $false
$script:restoreFailureInjected = $false

function global:Copy-Item {
  param(
    [string]$LiteralPath,
    [string]$Destination,
    [switch]$Force
  )

  $destinationFull = [System.IO.Path]::GetFullPath($Destination)
  $existingDestination = [System.IO.Path]::GetFullPath($env:INJECT_EXISTING_DESTINATION)
  $newDestination = [System.IO.Path]::GetFullPath($env:INJECT_NEW_DESTINATION)

  if ($script:overlayFailureInjected -and
      -not $script:restoreFailureInjected -and
      $env:INJECT_RESTORE_FAILURE -eq '1' -and
      [System.StringComparer]::OrdinalIgnoreCase.Equals($destinationFull, $existingDestination)) {
    $script:restoreFailureInjected = $true
    throw 'INJECTED_OVERLAY_RESTORE_FAILURE'
  }

  Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force

  if (-not $script:overlayFailureInjected) {
    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($destinationFull, $existingDestination)) {
      $script:existingDestinationCopied = $true
    }
    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($destinationFull, $newDestination)) {
      $script:newDestinationCopied = $true
    }
    if ($script:existingDestinationCopied -and $script:newDestinationCopied) {
      $script:overlayFailureInjected = $true
      throw 'INJECTED_MID_OVERLAY_COPY_FAILURE'
    }
  }
}

& $env:APPLY_HELPER -PackageArchive $env:PACKAGE_ARCHIVE -RootDir $env:LIVE_ROOT -StagingRoot $env:RUNTIME_STAGE -InstallDeps 0 -RunMigrations 0 -RestartService 1 -RunHealthcheck 0 -CheckNginx 0
`,
  )

  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', wrapperPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH}`,
      APPLY_HELPER: applyHelper,
      PACKAGE_ARCHIVE: fixture.archivePath,
      LIVE_ROOT: fixture.liveRoot,
      RUNTIME_STAGE: fixture.runtimeStage,
      INJECT_EXISTING_DESTINATION: path.join(fixture.liveRoot, 'payload.txt'),
      INJECT_NEW_DESTINATION: path.join(fixture.liveRoot, 'new-only.txt'),
      INJECT_RESTORE_FAILURE: failRestore ? '1' : '0',
      NODE_CALL_MARKER: fixture.nodeCallMarker,
      PNPM_CALL_MARKER: fixture.pnpmCallMarker,
      NEW_START_MARKER: fixture.newStartMarker,
      OLD_START_MARKER: fixture.oldStartMarker,
    },
    encoding: 'utf8',
  })
}

function runNoDepsWithMigrations(applyHelper, fixture) {
  return spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      applyHelper,
      '-PackageArchive',
      fixture.archivePath,
      '-RootDir',
      fixture.liveRoot,
      '-InstallDeps',
      '0',
      '-RunMigrations',
      '1',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

test('Windows apply helper bootstraps SYSTEM-safe tool PATH and resolves pnpm from common locations', () => {
  const script = readScript('scripts/ops/multitable-onprem-apply-package.ps1')

  assert.match(script, /function Initialize-WindowsSystemToolPath/)
  assert.match(script, /C:\\Users\\Administrator\\AppData\\Roaming/)
  assert.match(script, /Join-Path \$base 'nodejs'/)
  assert.match(script, /foreach \(\$leaf in @\('pnpm\.exe', 'pnpm\.cmd', 'pnpm\.ps1'\)\)/)
  assert.match(script, /Initialize-WindowsSystemToolPath/)
  assert.match(script, /\$pnpmInstallPath = Initialize-PinnedPnpm/)
  assert.match(script, /-RequiredVersion \$requiredPnpmVersion/)
  assert.match(script, /-WrapperRoot \$extractRoot/)
  assert.match(script, /\$pnpmPath = Resolve-PnpmInstallCommand/)
})

test('Corepack activation uses an exact-version dispatcher instead of a shadowing profile binary', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-corepack-pnpm-'))
  const applyHelper = path.join(repoRoot, 'scripts/ops/multitable-onprem-apply-package.ps1')
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:APPLY_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
$functionText = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
  ForEach-Object { $_.Extent.Text }
Invoke-Expression ($functionText -join [Environment]::NewLine)

$corepackDir = Join-Path $env:TEST_ROOT 'corepack-bin'
$profileDir = Join-Path $env:TEST_ROOT 'profile-bin'
New-Item -ItemType Directory -Path $corepackDir, $profileDir -Force | Out-Null
$corepackPath = Join-Path $corepackDir 'corepack.cmd'
$shadowingPnpmPath = Join-Path $profileDir 'pnpm.cmd'
$wrapperPath = Join-Path $env:TEST_ROOT 'pinned-pnpm.cmd'
Set-Content -LiteralPath $corepackPath -Value '@echo off' -NoNewline
Set-Content -LiteralPath $shadowingPnpmPath -Value '@echo 8.0.0' -NoNewline

$resolved = New-CorepackPnpmCommandWrapper -WrapperPath $wrapperPath -CorepackPath $corepackPath -RequiredVersion '9.15.9'
$wrapper = Get-Content -LiteralPath $resolved -Raw
if (-not $wrapper.Contains([System.IO.Path]::GetFullPath($corepackPath))) { throw 'wrapper does not pin the Corepack path' }
if (-not $wrapper.Contains('pnpm@9.15.9')) { throw 'wrapper does not pin the required pnpm version' }
if (-not $wrapper.Contains('%*')) { throw 'wrapper does not forward pnpm arguments' }
$expectedDispatch = 'call "' + [System.IO.Path]::GetFullPath($corepackPath) + '" "pnpm@9.15.9" %*'
if (-not $wrapper.Contains($expectedDispatch)) { throw "wrapper command is not exact: $wrapper" }
if (-not $wrapper.Contains('set "COREPACK_PNPM_EXIT=%ERRORLEVEL%"')) { throw 'wrapper does not capture the Corepack exit code' }
if (-not $wrapper.Contains('exit /b %COREPACK_PNPM_EXIT%')) { throw 'wrapper does not propagate the Corepack exit code' }
if ($wrapper.Contains([System.IO.Path]::GetFullPath($shadowingPnpmPath))) { throw 'wrapper captured the shadowing profile pnpm' }
`

  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPLY_HELPER: applyHelper,
        TEST_ROOT: tempRoot,
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const script = readScript('scripts/ops/multitable-onprem-apply-package.ps1')
    const initializer = script.slice(
      script.indexOf('function Initialize-PinnedPnpm'),
      script.indexOf('function Convert-PositiveInt'),
    )
    assert.match(initializer, /New-CorepackPnpmCommandWrapper/)
    assert.match(initializer, /-WrapperPath \$corepackWrapperPath/)
    assert.match(initializer, /-CorepackPath \$corepackPath/)
    assert.match(initializer, /-RequiredVersion \$RequiredVersion/)
    assert.match(
      initializer,
      /else \{[\s\S]*\$pnpmPath = Resolve-PnpmInstallCommand/,
      'generic pnpm discovery should remain only as the no-Corepack fallback',
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('on-prem package build and apply use the same exact pnpm version', () => {
  const applyScript = readScript('scripts/ops/multitable-onprem-apply-package.ps1')
  const buildScript = readScript('scripts/ops/multitable-onprem-package-build.sh')
  const verifyScript = readScript('scripts/ops/multitable-onprem-package-verify.sh')
  const workflow = readScript('.github/workflows/multitable-onprem-package-build.yml')

  assert.match(buildScript, /PACKAGE_PNPM_VERSION="9\.15\.9"/)
  assert.match(buildScript, /json\.packageManager = `pnpm@\$\{pnpmVersion\}`/)
  assert.match(buildScript, /"pnpmVersion": "\$\{PACKAGE_PNPM_VERSION\}"/)
  assert.match(workflow, /version: 9\.15\.9/)
  assert.doesNotMatch(workflow, /version: 9\s*(?:\n|$)/)
  assert.match(workflow, /dependency_preflight_package/)
  assert.match(
    workflow,
    /pnpm install --frozen-lockfile --reporter=append-only/,
  )

  assert.match(applyScript, /\$SupportedPackagePnpmVersion = '9\.15\.9'/)
  assert.match(applyScript, /Resolve-PackagePnpmVersion/)
  assert.match(applyScript, /corepackPath prepare "pnpm@\$RequiredVersion" --activate/)
  assert.match(applyScript, /PNPM_VERSION_MISMATCH/)
  assert.match(verifyScript, /packaged root package\.json must pin pnpm@9\.15\.9/)
  assert.match(verifyScript, /PACKAGE-METADATA\.json must pin pnpm 9\.15\.9/)
})

test('Windows apply preflights dependencies before live overlay and rolls activation failures back', () => {
  const script = readScript('scripts/ops/multitable-onprem-apply-package.ps1')
  const preflightCall = script.lastIndexOf("-Description 'Preflight dependencies in staging (pinned pnpm, frozen lockfile)'")
  const overlayCall = script.lastIndexOf('Copy-PackageOverlay -Transaction $overlayTransaction')
  const liveActivationCall = script.lastIndexOf("-Description 'Activate preflighted dependencies in live root (offline, rollback protected)'")

  assert.ok(preflightCall > -1, 'staging dependency preflight must be present')
  assert.ok(overlayCall > preflightCall, 'live package overlay must occur only after the staging preflight')
  assert.ok(liveActivationCall > overlayCall, 'live dependency activation must occur inside the overlay transaction')
  assert.match(script, /-Offline/)
  assert.match(script, /function New-PackageOverlayTransaction/)
  assert.match(script, /function Move-WorkspaceNodeModulesForRollback/)
  assert.match(script, /Restore-WorkspaceNodeModules -Transaction \$modulesTransaction/)
  assert.match(script, /Restore-PackageOverlay -Transaction \$overlayTransaction/)
  assert.match(script, /PACKAGE_DEPENDENCY_ROLLBACK_FAILED/)
  assert.match(script, /Remove-WorkspaceNodeModules -Root \$packageRoot/)
})

test('staging dependency cleanup bypasses PowerShell deep-path traversal', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2 onprem deep cleanup-'))
  const applyHelper = path.join(repoRoot, 'scripts/ops/multitable-onprem-apply-package.ps1')
  const modulesPath = path.join(tempRoot, 'node_modules')
  let deepPath = modulesPath
  for (let index = 0; index < 18; index += 1) {
    deepPath = path.join(deepPath, `pnpm-segment-${index}-${'x'.repeat(18)}`)
  }
  fs.mkdirSync(deepPath, { recursive: true })
  fs.writeFileSync(path.join(deepPath, 'package.json'), '{}')
  assert.ok(deepPath.length > 260, 'fixture must exceed the traditional Windows MAX_PATH boundary')

  const harness = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:APPLY_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
$functionText = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
  ForEach-Object { $_.Extent.Text }
Invoke-Expression ($functionText -join [Environment]::NewLine)

Remove-WorkspaceNodeModules -Root $env:TARGET_ROOT
if (Test-Path -LiteralPath $env:TARGET_PATH) { throw 'deep dependency tree survived cleanup' }
`

  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPLY_HELPER: applyHelper,
        TARGET_ROOT: tempRoot,
        TARGET_PATH: modulesPath,
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const script = readScript('scripts/ops/multitable-onprem-apply-package.ps1')
    assert.match(script, /fs\.rmSync\(target, \{ recursive: true, force: true, maxRetries: 5, retryDelay: 250 \}\)/)
    assert.match(script, /if \(\$exitCode -ne 0\)/)
    assert.match(script, /cleanup did not remove \$Path/)
    const cleanupBlock = script.slice(
      script.indexOf('function Remove-WorkspaceNodeModules'),
      script.indexOf('function New-PackageOverlayTransaction'),
    )
    assert.match(cleanupBlock, /Remove-DirectoryTree -Path \$modulesPath/)
    assert.doesNotMatch(cleanupBlock, /Remove-Item[\s\S]*-Recurse/)

    const restoreBlock = script.slice(
      script.indexOf('function Restore-WorkspaceNodeModules'),
      script.indexOf('function Complete-WorkspaceNodeModulesTransaction'),
    )
    assert.match(restoreBlock, /Remove-DirectoryTree -Path \$entry\.ModulesPath/)
    assert.doesNotMatch(restoreBlock, /Remove-Item[\s\S]*-Recurse/)

    const completeBlock = script.slice(
      script.indexOf('function Complete-WorkspaceNodeModulesTransaction'),
      script.indexOf('function Invoke-HealthcheckOnce'),
    )
    assert.match(completeBlock, /Remove-DirectoryTree -Path \$entry\.BackupPath/)
    assert.doesNotMatch(completeBlock, /Remove-Item[\s\S]*-Recurse/)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('package overlay and workspace dependency rollback restore the previous live tree', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-onprem-rollback-'))
  const applyHelper = path.join(repoRoot, 'scripts/ops/multitable-onprem-apply-package.ps1')
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:APPLY_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
$functionText = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
  ForEach-Object { $_.Extent.Text }
Invoke-Expression ($functionText -join [Environment]::NewLine)

$packageRoot = Join-Path $env:TEST_ROOT 'package'
$liveRoot = Join-Path $env:TEST_ROOT 'live'
$backupRoot = Join-Path $env:TEST_ROOT 'backup'
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'apps/web') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $liveRoot 'apps/web') -Force | Out-Null
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Value '{"name":"root"}' -NoNewline
Set-Content -LiteralPath (Join-Path $packageRoot 'apps/web/package.json') -Value '{"name":"web"}' -NoNewline
Set-Content -LiteralPath (Join-Path $packageRoot 'shared.txt') -Value 'new' -NoNewline
Set-Content -LiteralPath (Join-Path $packageRoot 'package-only.txt') -Value 'new-only' -NoNewline
Set-Content -LiteralPath (Join-Path $liveRoot 'package.json') -Value '{"name":"old-root"}' -NoNewline
Set-Content -LiteralPath (Join-Path $liveRoot 'apps/web/package.json') -Value '{"name":"old-web"}' -NoNewline
Set-Content -LiteralPath (Join-Path $liveRoot 'shared.txt') -Value 'old' -NoNewline
New-Item -ItemType Directory -Path (Join-Path $liveRoot 'node_modules') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $liveRoot 'apps/web/node_modules') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $liveRoot 'node_modules/old-root.txt') -Value 'old-root' -NoNewline
Set-Content -LiteralPath (Join-Path $liveRoot 'apps/web/node_modules/old-web.txt') -Value 'old-web' -NoNewline

$overlay = New-PackageOverlayTransaction -PackageRoot $packageRoot -LiveRoot $liveRoot -BackupRoot $backupRoot
$modules = Move-WorkspaceNodeModulesForRollback -LiveRoot $liveRoot -PackageRoot $packageRoot -TransactionId 'contracttest'
Copy-PackageOverlay -Transaction $overlay
New-Item -ItemType Directory -Path (Join-Path $liveRoot 'node_modules') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $liveRoot 'apps/web/node_modules') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $liveRoot 'node_modules/new.txt') -Value 'new' -NoNewline
Set-Content -LiteralPath (Join-Path $liveRoot 'apps/web/node_modules/new.txt') -Value 'new' -NoNewline

Restore-WorkspaceNodeModules -Transaction $modules
Restore-PackageOverlay -Transaction $overlay

if ((Get-Content -LiteralPath (Join-Path $liveRoot 'shared.txt') -Raw) -ne 'old') { throw 'shared file was not restored' }
if (Test-Path -LiteralPath (Join-Path $liveRoot 'package-only.txt')) { throw 'new package file survived rollback' }
if (-not (Test-Path -LiteralPath (Join-Path $liveRoot 'node_modules/old-root.txt'))) { throw 'root node_modules was not restored' }
if (-not (Test-Path -LiteralPath (Join-Path $liveRoot 'apps/web/node_modules/old-web.txt'))) { throw 'workspace node_modules was not restored' }
if (Test-Path -LiteralPath (Join-Path $liveRoot 'node_modules/new.txt')) { throw 'new root node_modules survived rollback' }
if (Test-Path -LiteralPath (Join-Path $liveRoot 'apps/web/node_modules/new.txt')) { throw 'new workspace node_modules survived rollback' }
`

  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPLY_HELPER: applyHelper,
        TEST_ROOT: tempRoot,
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('on-prem archive contract includes migration 066 and the documented postdeploy smokes', () => {
  const buildScript = readScript('scripts/ops/multitable-onprem-package-build.sh')
  const verifyScript = readScript('scripts/ops/multitable-onprem-package-verify.sh')

  assert.ok(buildScript.includes('"packages/core-backend/migrations"'), 'build must package the full migration directory')
  assert.ok(buildScript.includes('"packages/openapi/dist-sdk"'), 'build must package the web runtime workspace SDK')
  assert.ok(
    verifyScript.includes('"packages/openapi/dist-sdk/package.json"'),
    'verifier must require the web runtime workspace SDK',
  )
  assert.ok(
    buildScript.includes('"scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs"'),
    'build must package the stock-preparation smoke',
  )
  assert.ok(
    buildScript.includes('"scripts/ops/stock-preparation-onprem-acceptance.ps1"'),
    'build must package the stock-preparation one-click acceptance script',
  )
  assert.ok(
    buildScript.includes('"scripts/ops/multitable-permission-lists-postdeploy-smoke.mjs"'),
    'build must package the permission-list closeout smoke',
  )
  for (const relativePath of [
    'packages/core-backend/migrations/066_create_integration_stock_prep_audit.sql',
    'scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs',
    'scripts/ops/stock-preparation-onprem-acceptance.ps1',
    'scripts/ops/multitable-permission-lists-postdeploy-smoke.mjs',
  ]) {
    assert.ok(verifyScript.includes(`"${relativePath}"`), `verifier must require ${relativePath}`)
  }

  assert.match(verifyScript, /function verify_stock_preparation_mvp_contract/)
  assert.match(verifyScript, /auditActionsCovered/)
  assert.match(verifyScript, /selfScanClean/)
  assert.match(verifyScript, /Get-ArchiveProvenanceGitCommit/)
  assert.match(verifyScript, /externalPlmK3ErpWrite/)
})

test('Windows apply helper retries post-PM2 healthcheck during warmup and remains fail-closed', () => {
  const script = readScript('scripts/ops/multitable-onprem-apply-package.ps1')

  assert.match(script, /\[string\]\$HealthcheckAttempts = '12'/)
  assert.match(script, /\[string\]\$HealthcheckDelaySec = '5'/)
  assert.match(script, /function Invoke-HealthcheckOnce/)
  assert.match(script, /function Invoke-Healthcheck/)
  assert.match(script, /for \(\$attempt = 1; \$attempt -le \$Attempts; \$attempt\+\+\)/)
  assert.match(script, /\$allUrlsHealthy = \$true/)
  assert.match(script, /foreach \(\$url in \$Urls\)/)
  assert.match(script, /Invoke-HealthcheckOnce -Url \$url/)
  assert.match(script, /if \(\$allUrlsHealthy\) \{\s+return \$true\s+\}/)
  assert.match(script, /Start-Sleep -Seconds \$DelaySec/)
  assert.match(script, /return \$false/)
  assert.match(script, /Convert-PositiveInt -Value \$HealthcheckAttempts -Label 'HealthcheckAttempts'/)
  assert.match(script, /Convert-PositiveInt -Value \$HealthcheckDelaySec -Label 'HealthcheckDelaySec'/)
  assert.match(script, /Invoke-Healthcheck -Urls @\(\$healthUrl, \$pluginsUrl\) -Attempts \$healthcheckAttemptsValue -DelaySec \$healthcheckDelayValue/)
  assert.match(script, /throw "Healthcheck failed for \$healthUrl and \$pluginsUrl"/)

  const oldSingleProbe = /if \(-not \(Invoke-Healthcheck -Url \$healthUrl\) -and -not \(Invoke-Healthcheck -Url \$pluginsUrl\)\)/
  assert.doesNotMatch(script, oldSingleProbe)
})

test('Windows apply helper resolves extracted package root by package markers, not first child directory', () => {
  const script = readScript('scripts/ops/multitable-onprem-apply-package.ps1')

  assert.match(
    script,
    /function Write-Info \{\s+param\(\[string\]\$Message\)\s+Write-Host "\[multitable-onprem-apply-package\] \$Message"\s+\}/,
    'apply-helper logging must not use Write-Output because success-stream output pollutes helper return values',
  )
  assert.doesNotMatch(
    script,
    /Write-Output "\[multitable-onprem-apply-package\] \$Message"/,
    'apply-helper logging must not emit informational lines on the success output stream',
  )
  assert.match(script, /defaulting to short Windows staging root \$tempBase/)
  assert.match(script, /C:\\ms-tmp/)
  assert.match(script, /System\.IO\.Compression\.ZipFile/)
  assert.match(script, /ExtractToDirectory\(\$ArchivePath, \$TargetDir\)/)
  assert.doesNotMatch(script, /Expand-Archive/)
  assert.match(script, /function Test-OnPremPackageRoot/)
  assert.match(script, /function Resolve-ExtractedPackageRoot/)
  assert.match(script, /pnpm-lock\.yaml/)
  assert.match(script, /PACKAGE-METADATA\.json/)
  assert.match(script, /scripts\\ops\\multitable-onprem-apply-package\.ps1/)
  assert.match(script, /Failed to locate extracted package root/)
  assert.match(script, /Ambiguous extracted package roots/)
  assert.match(script, /Extracted package root: \$packageRoot/)
  assert.doesNotMatch(
    script,
    /Get-ChildItem -LiteralPath \$extractRoot -Directory\s*\|\s*Select-Object -First 1/,
    'the extracted root must not be chosen by first child directory',
  )
})

test('Windows deploy launcher resolves staged package root by package markers, not first child directory', () => {
  const script = readScript('scripts/ops/multitable-onprem-deploy-launcher.ps1')

  assert.match(
    script,
    /function Write-LauncherInfo \{\s+param\(\[string\]\$Message\)\s+# Use the host stream,[\s\S]+Write-Host \("\[multitable-onprem-deploy-launcher\] \{0\}" -f \$Message\)\s+\}/,
    'launcher logging must not use Write-Output because success-stream output pollutes helper return values',
  )
  assert.doesNotMatch(
    script,
    /Write-Output \("\[multitable-onprem-deploy-launcher\] \{0\}" -f \$Message\)/,
    'launcher logging must not emit informational lines on the success output stream',
  )
  assert.match(script, /defaulting to short Windows staging root \$base/)
  assert.match(script, /C:\\ms-tmp/)
  assert.match(script, /System\.IO\.Compression\.ZipFile/)
  assert.match(script, /ExtractToDirectory\(\$Archive, \$Stage\)/)
  assert.doesNotMatch(script, /Expand-Archive/)
  assert.match(script, /function Resolve-StagedPackageRoot/)
  assert.match(script, /pnpm-lock\.yaml/)
  assert.match(script, /PACKAGE-METADATA\.json/)
  assert.match(script, /scripts\\ops\\multitable-onprem-apply-package\.ps1/)
  assert.match(script, /No package root with pnpm-lock\.yaml \/ PACKAGE-METADATA\.json \/ apply helper markers/)
  assert.match(script, /Ambiguous package roots inside staging extraction/)
  assert.doesNotMatch(
    script,
    /Get-ChildItem -LiteralPath \$Stage -Directory[^\n]*\n[^\n]*Select-Object -First 1/,
    'the staged root must not be chosen by first child directory',
  )
})

test('Windows deploy launcher forwards explicit no-dependency and no-migration controls to the staged helper', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-launcher-flags-'))
  const packageName = 'metasheet-launcher-fixture'
  const packageRoot = path.join(tempRoot, 'stage', packageName)
  const archivePath = path.join(tempRoot, `${packageName}.tgz`)
  const liveRoot = path.join(tempRoot, 'live')
  const markerPath = path.join(tempRoot, 'forwarded.marker')

  try {
    writeFixtureFile(path.join(packageRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    writeFixtureFile(path.join(packageRoot, 'PACKAGE-METADATA.json'), '{}')
    writeFixtureFile(
      path.join(packageRoot, 'scripts/ops/multitable-onprem-apply-package.ps1'),
      String.raw`param(
  [string]$PackageArchive,
  [string]$RootDir,
  [string]$StagingRoot,
  [string]$InstallDeps = 'UNSET',
  [string]$RunMigrations = 'UNSET'
)
Set-Content -LiteralPath $env:FORWARDED_MARKER -Value ("{0}|{1}" -f $InstallDeps, $RunMigrations) -NoNewline
`,
    )
    fs.mkdirSync(liveRoot, { recursive: true })
    createTarArchive(path.join(tempRoot, 'stage'), packageName, archivePath)

    const launcher = path.join(repoRoot, 'scripts/ops/multitable-onprem-deploy-launcher.ps1')
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        launcher,
        '-PackageArchive',
        archivePath,
        '-RootDir',
        liveRoot,
        '-StagingRoot',
        path.join(tempRoot, 'runtime-stage'),
        '-InstallDeps',
        '0',
        '-RunMigrations',
        '0',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, FORWARDED_MARKER: markerPath },
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(fs.readFileSync(markerPath, 'utf8'), '0|0')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('no-dependency mode rejects migrations before either launcher or apply helper can stage a package', () => {
  const fixture = createNoDepsApplyFixture('success')
  const launcher = path.join(repoRoot, 'scripts/ops/multitable-onprem-deploy-launcher.ps1')
  const applyHelper = path.join(repoRoot, 'scripts/ops/multitable-onprem-apply-package.ps1')

  try {
    for (const script of [launcher, applyHelper]) {
      const result = runNoDepsWithMigrations(script, fixture)
      assert.notEqual(result.status, 0, `${path.basename(script)} must reject the unsafe flag combination`)
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /PACKAGE_NO_DEPS_REQUIRES_NO_MIGRATIONS/,
        `${path.basename(script)} must fail with the closed policy token`,
      )
    }
    assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'payload.txt'), 'utf8'), 'old-payload')
    assert.equal(fs.existsSync(fixture.newStartMarker), false, 'the package must not reach its restart boundary')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('InstallDeps=0 applies the package overlay while preserving existing node_modules', () => {
  const fixture = createNoDepsApplyFixture('success')
  try {
    const result = runNoDepsApply(fixture, { runHealthcheck: false })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'payload.txt'), 'utf8'), 'new-payload')
    assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'new-only.txt'), 'utf8'), 'new-only-payload')
    assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'node_modules/preserved.marker'), 'utf8'), 'preserved')
    assert.equal(fs.existsSync(fixture.nodeCallMarker), false, 'RunMigrations=0 must never invoke node')
    assert.equal(fs.existsSync(fixture.newStartMarker), true, 'the new runtime must be restarted')
    assert.equal(fs.existsSync(fixture.oldStartMarker), false, 'the old runtime must not restart after a successful apply')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

for (const [name, startMode, runHealthcheck] of [
  ['service restart failure', 'throw', false],
  ['post-restart health failure', 'success', true],
]) {
  test(`InstallDeps=0 restores the previous live tree after ${name}`, () => {
    const fixture = createNoDepsApplyFixture(startMode)
    try {
      const result = runNoDepsApply(fixture, { runHealthcheck })

      assert.notEqual(result.status, 0, 'the injected failure must remain fail-closed')
      assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'payload.txt'), 'utf8'), 'old-payload')
      assert.equal(fs.existsSync(path.join(fixture.liveRoot, 'new-only.txt')), false)
      assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'node_modules/preserved.marker'), 'utf8'), 'preserved')
      assert.equal(fs.existsSync(fixture.nodeCallMarker), false, 'RunMigrations=0 must never invoke node')
      assert.equal(fs.existsSync(fixture.newStartMarker), true, 'the injected new-runtime boundary must execute')
      assert.equal(fs.existsSync(fixture.oldStartMarker), true, 'rollback must restart the restored runtime')
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}

for (const [name, passingPath] of [
  ['base health succeeds but plugin health fails', '/health'],
  ['base health fails but plugin health succeeds', '/api/plugins'],
]) {
  test(`InstallDeps=0 rolls back when ${name}`, () => {
    const fixture = createNoDepsApplyFixture('success')
    const server = startAsymmetricHealthServer(fixture, passingPath)
    try {
      const result = runNoDepsApply(fixture, {
        runHealthcheck: true,
        baseUrl: server.baseUrl,
        apiBase: `${server.baseUrl}/api`,
      })

      assert.notEqual(result.status, 0, 'a partial health result must remain fail-closed')
      assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'payload.txt'), 'utf8'), 'old-payload')
      assert.equal(fs.existsSync(path.join(fixture.liveRoot, 'new-only.txt')), false)
      assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'node_modules/preserved.marker'), 'utf8'), 'preserved')
      assert.equal(fs.existsSync(fixture.nodeCallMarker), false, 'RunMigrations=0 must never invoke node')
      assert.equal(fs.existsSync(fixture.pnpmCallMarker), false, 'InstallDeps=0 must never invoke pnpm')
      assert.equal(fs.existsSync(fixture.newStartMarker), true, 'the new runtime must reach the health boundary')
      assert.equal(fs.existsSync(fixture.oldStartMarker), true, 'rollback must restart the restored runtime')
    } finally {
      server.stop()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}

test('InstallDeps=0 restores and restarts the previous runtime after a deterministic mid-overlay copy failure', () => {
  const fixture = createNoDepsApplyFixture('success')
  try {
    const result = runNoDepsApplyWithCopyFailure(fixture)
    const output = `${result.stdout}\n${result.stderr}`

    assert.notEqual(result.status, 0, 'the injected copy failure must remain fail-closed')
    assert.match(output, /INJECTED_MID_OVERLAY_COPY_FAILURE/)
    assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'payload.txt'), 'utf8'), 'old-payload')
    assert.equal(fs.existsSync(path.join(fixture.liveRoot, 'new-only.txt')), false)
    assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'node_modules/preserved.marker'), 'utf8'), 'preserved')
    assert.equal(fs.existsSync(fixture.nodeCallMarker), false, 'RunMigrations=0 must never invoke node')
    assert.equal(fs.existsSync(fixture.pnpmCallMarker), false, 'InstallDeps=0 must never invoke pnpm')
    assert.equal(fs.existsSync(fixture.newStartMarker), false, 'copy failure must precede new-runtime restart')
    assert.equal(fs.existsSync(fixture.oldStartMarker), true, 'copy rollback must restart the restored runtime')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('InstallDeps=0 preserves the rollback backup when overlay restoration fails', () => {
  const fixture = createNoDepsApplyFixture('success')
  try {
    const result = runNoDepsApplyWithCopyFailure(fixture, { failRestore: true })
    const output = `${result.stdout}\n${result.stderr}`

    assert.notEqual(result.status, 0, 'the injected restore failure must remain fail-closed')
    assert.match(output, /PACKAGE_NO_DEPS_ROLLBACK_FAILED/)
    assert.match(output, /INJECTED_OVERLAY_RESTORE_FAILURE/)
    assert.equal(fs.readFileSync(path.join(fixture.liveRoot, 'node_modules/preserved.marker'), 'utf8'), 'preserved')
    assert.equal(fs.existsSync(fixture.nodeCallMarker), false, 'RunMigrations=0 must never invoke node')
    assert.equal(fs.existsSync(fixture.pnpmCallMarker), false, 'InstallDeps=0 must never invoke pnpm')

    const rollbackRoots = fs.readdirSync(fixture.runtimeStage)
      .filter((entry) => entry.startsWith('mspb-'))
    assert.equal(rollbackRoots.length, 1, 'failed restoration must preserve exactly one rollback root')
    assert.equal(
      fs.readFileSync(path.join(fixture.runtimeStage, rollbackRoots[0], 'files/payload.txt'), 'utf8'),
      'old-payload',
      'preserved rollback backup must retain the pre-change file',
    )
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('PM2 startup helper initializes SYSTEM profile env before invoking PM2', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /function Initialize-WindowsSystemProfileEnv/)
  assert.match(script, /Set-EnvIfMissing -Name 'USERPROFILE'/)
  assert.match(script, /Set-EnvIfMissing -Name 'HOME'/)
  assert.match(script, /Set-EnvIfMissing -Name 'HOMEPATH'/)
  assert.match(script, /Set-EnvIfMissing -Name 'PM2_HOME'/)
  assert.match(script, /\$homeDrive = \$pathRoot\.TrimEnd\('\\'\)/)
  assert.match(script, /\$homePath = \$profileRoot\.Substring\(\$homeDrive\.Length\)/)
  assert.match(script, /-not \$homePath\.StartsWith\('\\'\)/)
  assert.doesNotMatch(script, /\$profileRoot\.Substring\(\$pathRoot\.Length - 1\)/)
  assert.match(script, /Initialize-WindowsSystemToolPath/)
  assert.match(script, /Initialize-WindowsSystemProfileEnv/)
})

test('PM2 startup helper replaces stale app definitions instead of restart-only reuse', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /function Get-Pm2AppProcess/)
  assert.match(script, /function Test-Pm2AppMatchesTarget/)
  assert.match(script, /pm_exec_path/)
  assert.match(script, /pm_cwd/)
  assert.match(script, /packages\\core-backend\\dist\\src\\index\.js/)
  assert.match(script, /deleting stale pm2 app definition/)
  assert.match(script, /delete \$Pm2AppName/)
  assert.match(script, /--update-env/)
})

test('PM2 startup helper retires sensitive test-only env keys absent from app.env', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /\$RetiredSensitiveEnvKeys = @\(/)
  assert.match(script, /'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED'/)
  assert.match(script, /'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'/)
  assert.match(script, /function Get-AppEnvKeySet/)
  assert.match(script, /function Clear-RetiredSensitiveEnvKeysAbsentFromFile/)
  assert.match(script, /Remove-Item -Path \("Env:\{0\}" -f \$key\) -ErrorAction SilentlyContinue/)
  assert.match(script, /function Test-Pm2AppHasRetiredSensitiveEnvKey/)
  assert.match(script, /if \(\$EnvFileKeys\.ContainsKey\(\$key\)\)/)
  assert.match(script, /if \(\$null -ne \$App\.pm2_env\.PSObject\.Properties\[\$key\]\)/)
  assert.match(script, /\$envFileKeys = Get-AppEnvKeySet -EnvFile \$envFile/)
  assert.match(script, /Clear-RetiredSensitiveEnvKeysAbsentFromFile -KeyNames \$RetiredSensitiveEnvKeys -EnvFileKeys \$envFileKeys/)
  assert.match(script, /deleting pm2 app definition for \$Pm2AppName to retire sensitive\/test-only env keys/)
  assert.match(script, /pm2 delete failed while retiring env keys/)
})

test('PM2 startup helper deletes existing app when jlist cannot inspect retired-key state', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /function Test-RetiredSensitiveEnvKeyRetirementRequired/)
  assert.match(script, /if \(-not \$EnvFileKeys\.ContainsKey\(\$key\)\) \{\s+return \$true\s+\}/)
  assert.match(script, /Test-RetiredSensitiveEnvKeyRetirementRequired -KeyNames \$RetiredSensitiveEnvKeys -EnvFileKeys \$envFileKeys/)
  assert.match(script, /pm2 jlist did not return \$Pm2AppName; deleting existing pm2 app definition to retire sensitive\/test-only env keys/)
  assert.match(script, /pm2 delete failed while retiring env keys for \$Pm2AppName after jlist fallback/)

  const fallbackBlockStart = script.indexOf('pm2 jlist did not return $Pm2AppName; deleting existing pm2 app definition')
  const restartBlockStart = script.indexOf('pm2 jlist did not return $Pm2AppName; falling back to restart')
  assert.ok(fallbackBlockStart > -1)
  assert.ok(restartBlockStart > fallbackBlockStart)
})
