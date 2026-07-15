import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

function readScript(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
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
  assert.match(script, /foreach \(\$url in \$Urls\)/)
  assert.match(script, /Invoke-HealthcheckOnce -Url \$url/)
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
