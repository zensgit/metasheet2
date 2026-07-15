import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const buildScriptPath = path.join(repoRoot, 'scripts/ops/multitable-onprem-package-build.sh')
const verifyScriptPath = path.join(repoRoot, 'scripts/ops/multitable-onprem-package-verify.sh')
const packageWorkflowPath = path.join(repoRoot, '.github/workflows/multitable-onprem-package-build.yml')
const buildScript = fs.readFileSync(buildScriptPath, 'utf8')
const verifyScript = fs.readFileSync(verifyScriptPath, 'utf8')
const packageWorkflow = fs.readFileSync(packageWorkflowPath, 'utf8')

test('on-prem verifier requires the superseded audit migration marker', () => {
  assert.match(
    verifyScript,
    /search_fixed_string '20250926_create_audit_tables' "\$provider"/,
    'the package verifier must reject builds that could replay the non-idempotent legacy audit SQL',
  )
})

function runVerifierFunction(functionName, listEntries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-package-list-'))
  const listPath = path.join(dir, 'archive-list.txt')
  fs.writeFileSync(listPath, `${listEntries.join('\n')}\n`)
  const result = spawnSync(
    'bash',
    ['-lc', 'source "$VERIFY"; "$VERIFY_FUNCTION" "$LIST"'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VERIFY: verifyScriptPath,
        VERIFY_FUNCTION: functionName,
        LIST: listPath,
      },
      encoding: 'utf8',
    },
  )
  fs.rmSync(dir, { recursive: true, force: true })
  return result
}

function runVerifierListCheck(listEntries) {
  return runVerifierFunction('verify_no_bundled_node_modules', listEntries)
}

function runVerifierMacMetadataCheck(listEntries) {
  return runVerifierFunction('verify_no_macos_metadata_entries', listEntries)
}

function runStockPreparationVerifier(root) {
  return spawnSync(
    'bash',
    ['-lc', 'source "$VERIFY"; verify_stock_preparation_mvp_contract "$PACKAGE_ROOT"'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VERIFY: verifyScriptPath,
        PACKAGE_ROOT: root,
      },
      encoding: 'utf8',
    },
  )
}

function runNativeBcryptVerifier(packageJson, lockfile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-package-native-bcrypt-'))
  const backendRoot = path.join(root, 'packages/core-backend')
  fs.mkdirSync(backendRoot, { recursive: true })
  fs.writeFileSync(path.join(backendRoot, 'package.json'), JSON.stringify(packageJson, null, 2))
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), lockfile)
  const result = spawnSync(
    'bash',
    ['-lc', 'source "$VERIFY"; verify_no_native_bcrypt_dependency "$PACKAGE_ROOT"'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VERIFY: verifyScriptPath,
        PACKAGE_ROOT: root,
      },
      encoding: 'utf8',
    },
  )
  fs.rmSync(root, { recursive: true, force: true })
  return result
}

test('on-prem package build prunes copied workspace node_modules before archiving', () => {
  assert.match(
    buildScript,
    /function prune_node_modules\(\)/,
    'the build script must define an explicit node_modules pruning helper',
  )
  assert.match(
    buildScript,
    /find "\$root" -name node_modules -prune -print0/,
    'the pruning helper must find directories or symlinks named node_modules without traversing them',
  )
  assert.match(
    buildScript,
    /prune_node_modules "\$dst"/,
    'each copied directory should be pruned immediately',
  )
  assert.match(
    buildScript,
    /prune_node_modules "\$PACKAGE_ROOT"/,
    'the final package root should be swept before archive creation',
  )
})

test('on-prem verifier rejects native bcrypt build dependencies', () => {
  const clean = runNativeBcryptVerifier(
    {
      dependencies: { bcryptjs: '^3.0.3' },
      devDependencies: {},
    },
    "lockfileVersion: '9.0'\n",
  )
  assert.equal(clean.status, 0, clean.stderr)

  const nativeManifest = runNativeBcryptVerifier(
    {
      dependencies: { bcrypt: '^5.1.1', bcryptjs: '^3.0.3' },
      devDependencies: { '@types/bcrypt': '^5.0.2' },
    },
    "lockfileVersion: '9.0'\n",
  )
  assert.notEqual(nativeManifest.status, 0, 'native bcrypt manifest entries must fail verification')
  assert.match(nativeManifest.stderr, /must not depend on native bcrypt/)

  const nativeTypeManifest = runNativeBcryptVerifier(
    {
      dependencies: { bcryptjs: '^3.0.3' },
      devDependencies: { '@types/bcrypt': '^5.0.2' },
    },
    "lockfileVersion: '9.0'\n",
  )
  assert.notEqual(nativeTypeManifest.status, 0, 'unused native bcrypt type entries must fail verification')
  assert.match(nativeTypeManifest.stderr, /must not depend on native bcrypt/)

  const staleLock = runNativeBcryptVerifier(
    {
      dependencies: { bcryptjs: '^3.0.3' },
      devDependencies: {},
    },
    "lockfileVersion: '9.0'\n\npackages:\n\n  bcrypt@5.1.1:\n    resolution: {}\n",
  )
  assert.notEqual(staleLock.status, 0, 'native bcrypt lockfile entries must fail verification')
  assert.match(staleLock.stderr, /lockfile must not contain native bcrypt/)

  const staleTypeLock = runNativeBcryptVerifier(
    {
      dependencies: { bcryptjs: '^3.0.3' },
      devDependencies: {},
    },
    "lockfileVersion: '9.0'\n\npackages:\n\n  '@types/bcrypt@5.0.2':\n    resolution: {}\n",
  )
  assert.notEqual(staleTypeLock.status, 0, 'native bcrypt type lockfile entries must fail verification')
  assert.match(staleTypeLock.stderr, /lockfile must not contain native bcrypt/)
})

test('on-prem verifier rejects archive lists that contain node_modules entries', () => {
  const clean = runVerifierListCheck([
    'package/package.json',
    'package/packages/mssql-readonly-utils/package.json',
    'package/packages/mssql-readonly-utils/index.cjs',
  ])
  assert.equal(clean.status, 0, clean.stderr)

  const bad = runVerifierListCheck([
    'package/package.json',
    'package/packages/mssql-readonly-utils/node_modules/typescript/package.json',
  ])
  assert.notEqual(bad.status, 0, 'node_modules entries must fail package verification')
  assert.match(
    bad.stderr,
    /Package must not contain node_modules entries/,
    'failure should explain that dependencies are refreshed during apply',
  )
  assert.match(
    bad.stderr,
    /packages\/mssql-readonly-utils\/node_modules\/typescript/,
    'failure should show a sample offending entry for diagnostics',
  )
})

test('on-prem package build and verifier reject macOS AppleDouble metadata entries', () => {
  assert.match(
    buildScript,
    /export COPYFILE_DISABLE=1/,
    'the build script should disable macOS resource-fork sidecar generation',
  )
  assert.ok(
    buildScript.includes('find "$PACKAGE_ROOT" \\( -name \'._*\' -o -name \'__MACOSX\' \\) -prune -exec rm -rf {} +'),
    'the build script should prune copied AppleDouble metadata before archiving',
  )
  assert.match(
    buildScript,
    /tar --no-xattrs -czf "\$ARCHIVE_TGZ_TMP_PATH"/,
    'tgz creation should suppress extended attributes',
  )
  assert.match(
    buildScript,
    /zip -X -qr/,
    'zip creation should exclude extra file attributes',
  )
  assert.match(
    buildScript,
    /assert_no_macos_metadata_entries "\$ARCHIVE_TGZ_TMP_PATH" tgz "tgz package"/,
    'tgz archives should be inspected before publish',
  )
  assert.match(
    buildScript,
    /assert_no_macos_metadata_entries "\$ARCHIVE_ZIP_TMP_PATH" zip "zip package"/,
    'zip archives should be inspected before publish',
  )

  const clean = runVerifierMacMetadataCheck([
    'package/package.json',
    'package/packages/core-backend/migrations/057_create_integration_core_tables.sql',
  ])
  assert.equal(clean.status, 0, clean.stderr)

  const badAppleDouble = runVerifierMacMetadataCheck([
    'package/package.json',
    'package/packages/core-backend/migrations/._057_create_integration_core_tables.sql',
  ])
  assert.notEqual(badAppleDouble.status, 0, 'AppleDouble entries must fail package verification')
  assert.match(badAppleDouble.stderr, /AppleDouble\/resource-fork metadata entries/)
  assert.match(badAppleDouble.stderr, /migrations\/\._057_create_integration_core_tables\.sql/)

  const badMacosx = runVerifierMacMetadataCheck([
    'package/package.json',
    'package/__MACOSX/package/._package.json',
  ])
  assert.notEqual(badMacosx.status, 0, '__MACOSX entries must fail package verification')
  assert.match(badMacosx.stderr, /AppleDouble\/resource-fork metadata entries/)
  assert.match(badMacosx.stderr, /__MACOSX/)
})

test('on-prem zip verifier fallback lists full archive depth', () => {
  assert.match(
    verifyScript,
    /find "\$EXTRACT_ROOT" -mindepth 1 -print/,
    'zip fallback must scan the full extracted package tree',
  )
  assert.doesNotMatch(
    verifyScript,
    /find "\$EXTRACT_ROOT" -mindepth 1 -maxdepth 3/,
    'zip fallback must not stop before nested workspace node_modules paths',
  )
})

test('on-prem zip verifier smokes Windows ZipFile package-root layout', () => {
  assert.match(
    verifyScript,
    /function verify_windows_zip_zipfile_smoke\(\)/,
    'zip verification should include a Windows ZipFile smoke',
  )
  assert.match(
    verifyScript,
    /\[System\.IO\.Compression\.ZipFile\]::ExtractToDirectory\(\$env:PACKAGE_ARCHIVE, \$env:EXTRACT_ROOT\)/,
    'the smoke should use the same PowerShell extraction primitive as Windows deploy',
  )
  assert.match(
    verifyScript,
    /Expected exactly one Windows-expanded package root/,
    'the smoke should fail when package-root marker detection is ambiguous or absent',
  )
  assert.match(
    verifyScript,
    /pnpm-lock\.yaml/,
    'package-root detection should require pnpm-lock.yaml',
  )
  assert.match(
    verifyScript,
    /PACKAGE-METADATA\.json/,
    'package-root detection should require package metadata',
  )
  assert.match(
    verifyScript,
    /multitable-onprem-apply-package\.ps1/,
    'package-root detection should require the apply helper from the package',
  )
})

test('on-prem package build emits first-hop Windows bootstrap sidecar assets', () => {
  assert.match(
    buildScript,
    /BOOTSTRAP_PS1_PATH="\$\{OUTPUT_DIR\}\/\$\{PACKAGE_NAME\}-deploy-bootstrap\.ps1"/,
    'the build should emit a release-sidecar PowerShell bootstrap',
  )
  assert.match(
    buildScript,
    /BOOTSTRAP_BAT_PATH="\$\{OUTPUT_DIR\}\/\$\{PACKAGE_NAME\}-deploy-bootstrap\.bat"/,
    'the build should emit a release-sidecar batch wrapper',
  )
  assert.match(
    buildScript,
    /cp "\$\{ROOT_DIR\}\/scripts\/ops\/multitable-onprem-deploy-launcher\.ps1" "\$BOOTSTRAP_PS1_TMP_PATH"/,
    'the bootstrap PowerShell sidecar should reuse the current launcher implementation',
  )
  assert.match(
    buildScript,
    /multitable-onprem-deploy-bootstrap/,
    'the bootstrap wrapper should emit its own parseable apply-exit marker',
  )
  assert.match(
    buildScript,
    /write_sha_file "\$BOOTSTRAP_PS1_TMP_PATH"/,
    'the PowerShell sidecar should get a sha256 file',
  )
  assert.match(
    buildScript,
    /add_checksum_entry "\$BOOTSTRAP_BAT_TMP_PATH" >> "\$checksum_tmp"/,
    'the batch sidecar should be listed in SHA256SUMS',
  )
  assert.match(
    buildScript,
    /"windowsFirstHopBootstrap": "\$\(basename "\$BOOTSTRAP_PS1_PATH"\)"/,
    'external metadata should name the first-hop bootstrap sidecar',
  )
  assert.match(
    verifyScript,
    /first-hop bootstrap release sidecar/,
    'package verifier should require the package metadata to describe the bootstrap sidecar',
  )
})

test('on-prem release and workflow artifacts publish both first-hop bootstrap sidecars', () => {
  assert.match(
    packageWorkflow,
    /pkg_bootstrap_ps1="\$\{pkg_tgz%\.tgz\}-deploy-bootstrap\.ps1"/,
    'the workflow should derive the PowerShell sidecar from the selected package name',
  )
  assert.match(
    packageWorkflow,
    /pkg_bootstrap_bat="\$\{pkg_tgz%\.tgz\}-deploy-bootstrap\.bat"/,
    'the workflow should derive the batch sidecar from the selected package name',
  )
  const releaseAssetsMatch = packageWorkflow.match(/assets=\(\n([\s\S]*?)\n\s+\)/)
  assert.ok(releaseAssetsMatch, 'the workflow should declare a GitHub Release asset list')
  const releaseAssets = releaseAssetsMatch[1]
  for (const asset of [
    '"$PACKAGE_BOOTSTRAP_PS1"',
    '"$PACKAGE_BOOTSTRAP_BAT"',
    '"${PACKAGE_BOOTSTRAP_PS1}.sha256"',
    '"${PACKAGE_BOOTSTRAP_BAT}.sha256"',
  ]) {
    assert.ok(
      releaseAssets.includes(asset),
      `the GitHub Release asset list should include ${asset}`,
    )
  }
  assert.match(
    packageWorkflow,
    /output\/releases\/multitable-onprem\/\*-deploy-bootstrap\.ps1/,
    'the workflow artifact should retain the PowerShell bootstrap sidecar',
  )
  assert.match(
    packageWorkflow,
    /output\/releases\/multitable-onprem\/\*-deploy-bootstrap\.bat/,
    'the workflow artifact should retain the batch bootstrap sidecar',
  )
})

test('on-prem verifier rejects packages missing the stock-preparation acceptance contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-stock-prep-package-'))
  const migrationPath = path.join(root, 'packages/core-backend/migrations/066_create_integration_stock_prep_audit.sql')
  const smokePath = path.join(root, 'scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs')
  const acceptancePath = path.join(root, 'scripts/ops/stock-preparation-onprem-acceptance.ps1')
  fs.mkdirSync(path.dirname(migrationPath), { recursive: true })
  fs.mkdirSync(path.dirname(smokePath), { recursive: true })
  fs.writeFileSync(migrationPath, 'CREATE TABLE integration_stock_prep_audit ();\n')
  fs.writeFileSync(smokePath, 'S.auditActionsCovered = "8/8"\nS.selfScanClean = true\nS.pass = true\n')
  fs.writeFileSync(
    acceptancePath,
    [
      'function Get-ArchiveProvenanceGitCommit {}',
      '$Summary.pm2StableOnline = "PASS"',
      '$Summary.auditActionsCovered = "8/8"',
      '$Summary.selfScanClean = "true"',
      '$Summary.externalPlmK3ErpWrite = "false"',
    ].join('\n'),
  )

  try {
    const clean = runStockPreparationVerifier(root)
    assert.equal(clean.status, 0, clean.stderr)

    fs.rmSync(acceptancePath)
    const missingAcceptance = runStockPreparationVerifier(root)
    assert.notEqual(missingAcceptance.status, 0)
    assert.match(missingAcceptance.stderr, /stock-preparation one-click acceptance/)

    fs.writeFileSync(acceptancePath, '$Summary.pm2StableOnline = "PASS"\n')
    const incompleteAcceptance = runStockPreparationVerifier(root)
    assert.notEqual(incompleteAcceptance.status, 0)
    assert.match(incompleteAcceptance.stderr, /in-archive provenance/)

    fs.writeFileSync(
      acceptancePath,
      [
        'function Get-ArchiveProvenanceGitCommit {}',
        '$Summary.pm2StableOnline = "PASS"',
        '$Summary.auditActionsCovered = "8/8"',
        '$Summary.selfScanClean = "true"',
        '$Summary.externalPlmK3ErpWrite = "false"',
      ].join('\n'),
    )
    fs.rmSync(smokePath)
    const missing = runStockPreparationVerifier(root)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /stock-preparation MVP postdeploy smoke/)

    fs.writeFileSync(smokePath, 'S.auditActionsCovered = "8/8"\nS.pass = true\n')
    const incomplete = runStockPreparationVerifier(root)
    assert.notEqual(incomplete.status, 0)
    assert.match(incomplete.stderr, /values-free self scan/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
