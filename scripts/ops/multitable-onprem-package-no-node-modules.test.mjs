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

test('on-prem package ships the verifier but keeps the builder repository-only', () => {
  assert.match(
    buildScript,
    /"scripts\/ops\/multitable-onprem-package-verify\.sh"/,
  )
  const requiredPaths = buildScript.match(
    /REQUIRED_PATHS=\(\n([\s\S]*?)\n\)/,
  )
  assert.ok(requiredPaths)
  assert.doesNotMatch(
    requiredPaths[1],
    /"scripts\/ops\/multitable-onprem-package-build\.sh"/,
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
    /set "INSTALL_DEPS=%~3"[\s\S]*if "%INSTALL_DEPS%"=="" set "INSTALL_DEPS=1"/,
    'the bootstrap wrapper should accept an explicit dependency-install control while preserving its default',
  )
  assert.match(
    buildScript,
    /set "RUN_MIGRATIONS=%~4"[\s\S]*if "%RUN_MIGRATIONS%"=="" set "RUN_MIGRATIONS=1"/,
    'the bootstrap wrapper should accept an explicit migration control while preserving its default',
  )
  assert.match(
    buildScript,
    /-InstallDeps "%INSTALL_DEPS%" -RunMigrations "%RUN_MIGRATIONS%"/,
    'the bootstrap wrapper should forward both controls to the fresh launcher sidecar',
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

test('on-prem verifier rejects packages missing the stock-preparation acceptance runtime contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-stock-prep-package-'))
  const migrationPath = path.join(root, 'packages/core-backend/migrations/066_create_integration_stock_prep_audit.sql')
  const sealedMigrationPath = path.join(root, 'packages/core-backend/migrations/073_create_sealed_export_stock_prep_runtime_authority.sql')
  const smokePath = path.join(root, 'scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs')
  const acceptancePath = path.join(root, 'scripts/ops/stock-preparation-onprem-acceptance.ps1')
  const sealedAcceptancePath = path.join(root, 'scripts/ops/stock-preparation-s6a-onprem-acceptance.ps1')
  const sealedRunbookPath = path.join(root, 'docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md')
  const pm2SamplePath = path.join(root, 'scripts/ops/stock-preparation-pm2-sample.mjs')
  fs.mkdirSync(path.dirname(migrationPath), { recursive: true })
  fs.mkdirSync(path.dirname(smokePath), { recursive: true })
  fs.mkdirSync(path.dirname(sealedRunbookPath), { recursive: true })
  fs.writeFileSync(migrationPath, 'CREATE TABLE integration_stock_prep_audit ();\n')
  fs.writeFileSync(
    sealedMigrationPath,
    [
      'CREATE TABLE integration_sealed_export_stock_prep_bindings ();',
      'CREATE TABLE integration_sealed_export_stock_prep_runs ();',
    ].join('\n'),
  )
  fs.writeFileSync(smokePath, 'S.auditActionsCovered = "8/8"\nS.selfScanClean = true\nS.pass = true\n')
  fs.writeFileSync(
    acceptancePath,
    [
      'function Get-ArchiveProvenanceGitCommit {}',
      '$Summary.pm2StableOnline = "PASS"',
      '$Summary.auditActionsCovered = "8/8"',
      '$Summary.selfScanClean = "true"',
      '$Summary.externalPlmK3ErpWrite = "false"',
      'stock-preparation-pm2-sample.mjs',
      ].join('\n'),
  )
  fs.writeFileSync(
    sealedAcceptancePath,
    [
      'stock-preparation/sqlserver-sealed-snapshot/acceptance/v2',
      'internal/stock-preparation/sqlserver-sealed-snapshot/run',
      'internal_noop',
      '24999',
      'machineBindingDigest',
      'operationBindingDigest',
      'ExpectedServiceRuntimeSha',
      'ExpectedPackageSha256',
      'BUILD_PROVENANCE.json',
      'Get-S6FileSha256',
    ].join('\n'),
  )
  fs.writeFileSync(
    sealedRunbookPath,
    [
      'Create PostgreSQL Roles Before Migration 073',
      'Unconditional Flag-Off Restoration',
      'nextTestMachineAction=STOP_AND_WAIT',
    ].join('\n'),
  )
  fs.writeFileSync(pm2SamplePath, "const APP_NAME = 'metasheet-backend'\n")

  try {
    const clean = runStockPreparationVerifier(root)
    assert.equal(clean.status, 0, clean.stderr)

    fs.rmSync(pm2SamplePath)
    const missingPm2Sample = runStockPreparationVerifier(root)
    assert.notEqual(missingPm2Sample.status, 0)
    assert.match(missingPm2Sample.stderr, /PM2 safe projection helper/)
    fs.writeFileSync(pm2SamplePath, "const APP_NAME = 'metasheet-backend'\n")

    fs.rmSync(sealedAcceptancePath)
    const missingSealedAcceptance = runStockPreparationVerifier(root)
    assert.notEqual(missingSealedAcceptance.status, 0)
    assert.match(missingSealedAcceptance.stderr, /S6-A acceptance/)
    fs.writeFileSync(
      sealedAcceptancePath,
      [
        'stock-preparation/sqlserver-sealed-snapshot/acceptance/v2',
        'internal/stock-preparation/sqlserver-sealed-snapshot/run',
        'internal_noop',
        '24999',
        'machineBindingDigest',
        'operationBindingDigest',
        'ExpectedServiceRuntimeSha',
        'ExpectedPackageSha256',
        'BUILD_PROVENANCE.json',
        'Get-S6FileSha256',
      ].join('\n'),
    )

    fs.rmSync(sealedRunbookPath)
    const missingSealedRunbook = runStockPreparationVerifier(root)
    assert.notEqual(missingSealedRunbook.status, 0)
    assert.match(missingSealedRunbook.stderr, /S6-A runbook/)
    fs.writeFileSync(
      sealedRunbookPath,
      [
        'Create PostgreSQL Roles Before Migration 073',
        'Unconditional Flag-Off Restoration',
        'nextTestMachineAction=STOP_AND_WAIT',
      ].join('\n'),
    )

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
        'stock-preparation-pm2-sample.mjs',
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

test('package build workflow runs this contract test and emits the paste-ready freeze block', () => {
  // Normalised locally: a core.autocrlf=true checkout hands this file CRLF, and
  // the ordering/roster assertions below are newline-anchored.
  const workflow = packageWorkflow.replace(/\r\n/g, '\n')

  const contractTestStep = workflow.indexOf(
    'node --test scripts/ops/multitable-onprem-package-no-node-modules.test.mjs',
  )
  assert.ok(
    contractTestStep > -1,
    'the build lane must run this archive contract test, not leave it to plugin-tests.yml alone',
  )

  const freezeStep = workflow.indexOf('- name: Emit paste-ready freeze block')
  const releaseStep = workflow.indexOf('- name: Publish GitHub Release')
  assert.ok(freezeStep > -1, 'the build lane must emit the freeze block')
  assert.ok(releaseStep > -1, 'the release step should still exist')
  assert.ok(
    contractTestStep < releaseStep && freezeStep < releaseStep,
    'a regressed archive contract or an unbuildable freeze block must be caught BEFORE the release publishes',
  )

  // The digest is read out of the built package by the product's own verifier.
  // A re-implementation here (or a bare sha256sum of the pins vector) would
  // silently drift from sealed-export-package-provenance.cjs.
  assert.match(
    workflow,
    /verifier\.verifySealedExportRuntimePackageProvenance\(\{\n\s*repoRoot: root,\n\s*\}\)/,
    'packageProvenanceManifestDigest must come from the packaged provenance module',
  )
  assert.match(
    workflow,
    /console\.log\(result\.frozenManifestDigest\)/,
    'the emitted digest must be the module\'s frozenManifestDigest',
  )

  // Exactly the eight fields #4708 / #4693 consume, in order, values-free.
  const freezeBlockFields = workflow.match(/echo "serviceRuntimeSha=[\s\S]*?echo "externalWrite=false"/)
  assert.ok(freezeBlockFields, 'the freeze block must be written as one contiguous emission')
  const emitted = freezeBlockFields[0]
    .split('\n')
    .map((line) => line.trim().match(/^echo "([A-Za-z][A-Za-z0-9]*)=/))
    .filter(Boolean)
    .map((match) => match[1])
  assert.deepEqual(emitted, [
    'serviceRuntimeSha',
    'releaseTag',
    'packageFile',
    'packageSha256',
    'packageProvenanceManifestDigest',
    'customerScope',
    'sourceMode',
    'externalWrite',
  ])

  assert.match(
    workflow,
    /resolved_release_tag="NOT_PUBLISHED"/,
    'an unpublished build must emit the closed token, never an invented release tag',
  )
  assert.match(
    workflow,
    /echo "packageTgzSha256=\$\{tgz_sha256\}"/,
    'the .tgz digest must also be emitted alongside the block',
  )
  assert.match(
    workflow,
    /output\/releases\/multitable-onprem\/freeze-block\.txt/,
    'the freeze block must ship inside the uploaded artifact',
  )
})

test('package build workflow validates and asserts the front-end base path before build, package, and release (r12-r16 white-screen guard)', () => {
  // 2026-09-07 incident: dispatching this workflow from Git Bash with
  // `-f base_path=/` let MSYS path conversion silently rewrite the bare '/'
  // into a Windows path ('C:/Program Files/Git/'), which flowed unchecked
  // into VITE_BASE_PATH. Five packages (r12-r16) shipped with every asset
  // URL prefixed 'C:/Program Files/Git/assets/...' and sat broken a full day
  // because nothing in this workflow ever looked at what it received. This
  // test pins the three-guard fix: reject the input, then prove twice (once
  // on the loose dist tree, once on the bytes actually inside the archive)
  // that what was built matches what was validated -- all three BEFORE the
  // package can reach a GitHub Release or the uploaded artifact.
  const workflow = packageWorkflow.replace(/\r\n/g, '\n')

  const checkoutStep = workflow.indexOf('- name: Checkout')
  const validateStep = workflow.indexOf('- name: Validate base_path input')
  const buildWebStep = workflow.indexOf('- name: Build web/backend dist')
  const postBuildAssertStep = workflow.indexOf(
    '- name: Assert built web dist references use the validated base path',
  )
  const buildPackageStep = workflow.indexOf('- name: Build on-prem package')
  const postPackageAssertStep = workflow.indexOf(
    '- name: Assert packaged web dist references use the validated base path',
  )
  const uploadStep = workflow.indexOf('- name: Upload package artifacts')
  const releaseStep = workflow.indexOf('- name: Publish GitHub Release')

  assert.ok(checkoutStep > -1, 'sanity: Checkout step should exist')
  assert.ok(
    validateStep > -1,
    'GUARD 1 missing: the workflow must validate inputs.base_path (a new "Validate base_path input" step) before it can reach Vite',
  )
  assert.ok(
    postBuildAssertStep > -1,
    'GUARD 2 missing: the workflow must assert apps/web/dist/index.html asset references immediately after the web build',
  )
  assert.ok(
    postPackageAssertStep > -1,
    'GUARD 3 missing: the workflow must assert the packaged archive\'s index.html asset references after "Build on-prem package"',
  )

  // Keyword contracts, scoped to each guard step's own body (up to the next
  // "- name:" step) so a keyword appearing elsewhere in the file cannot
  // launder a deleted or gutted guard step.
  const nextStepBoundary = (fromIdx) => {
    const next = workflow.indexOf('\n      - name:', fromIdx + 1)
    return next === -1 ? workflow.length : next
  }
  const validateBody = workflow.slice(validateStep, nextStepBoundary(validateStep))
  const postBuildBody = workflow.slice(postBuildAssertStep, nextStepBoundary(postBuildAssertStep))
  const postPackageBody = workflow.slice(postPackageAssertStep, nextStepBoundary(postPackageAssertStep))

  assert.ok(
    validateBody.includes('WEB_BASE_PATH'),
    'GUARD 1 must normalize the validated value into WEB_BASE_PATH via GITHUB_ENV',
  )
  assert.ok(
    validateBody.includes('^/([A-Za-z0-9._-]+/)*$'),
    'GUARD 1 must pin the canonical base-path shape ^/([A-Za-z0-9._-]+/)*$',
  )
  assert.ok(
    validateBody.includes('/../') && validateBody.includes('/./'),
    "GUARD 1 must additionally reject '.' and '..' segments -- both are members of the [A-Za-z0-9._-] class, so the regex alone would let '/../' through",
  )
  assert.match(
    workflow,
    /VITE_BASE_PATH:\s*\$\{\{\s*env\.WEB_BASE_PATH\s*\}\}/,
    'the web build step must consume the GUARD-1-validated WEB_BASE_PATH, never the raw inputs.base_path',
  )
  assert.ok(
    !/VITE_BASE_PATH:\s*\$\{\{\s*inputs\.base_path\s*\}\}/.test(workflow),
    'no step may feed Vite the raw inputs.base_path -- that is the exact line the r12-r16 incident came through',
  )

  // The guards' teeth, not just their names. A step that still says
  // "assets/" but no longer exits non-zero is worse than no step at all, so
  // pin the whole failing contract: the validated prefix, the empty-list
  // rejection, and a real non-zero exit.
  for (const [label, body] of [['GUARD 2', postBuildBody], ['GUARD 3', postPackageBody]]) {
    assert.ok(
      body.includes('${base}assets/'),
      `${label} must build its expected prefix from the validated base, i.e. \`\${base}assets/\``,
    )
    assert.ok(
      body.includes('jsRefs.length < 1'),
      `${label} must treat an empty .js reference list as a failure, not a pass`,
    )
    assert.ok(
      body.includes('process.exit(1)'),
      `${label} must actually exit non-zero when the assertion fails`,
    )
    assert.ok(
      body.includes('WEB_BASE_PATH:?'),
      `${label} must fail closed with a named cause when GUARD 1 never ran and WEB_BASE_PATH is unset`,
    )
  }
  assert.ok(
    postPackageBody.includes('unzip -p'),
    'GUARD 3 must read the packaged index.html out of the built zip with `unzip -p`, proving the bytes that would ship are the bytes that were asserted',
  )

  // GUARD 3's entire value rests on running GUARD 2's *same* assertion over
  // the packaged bytes. The two node bodies are duplicated inline (a workflow
  // step cannot import), so pin them byte-identical: whoever edits one is
  // forced to edit the other.
  const nodeBody = (body, label) => {
    const m = body.match(/<<'NODE'\n([\s\S]*?)\n {10}NODE\n/)
    assert.ok(m, `${label} must run its assertion as an inline node heredoc`)
    return m[1]
  }
  assert.equal(
    nodeBody(postBuildBody, 'GUARD 2'),
    nodeBody(postPackageBody, 'GUARD 3'),
    "GUARD 2 and GUARD 3 must run byte-identical assertion scripts (only the argv label differs) -- GUARD 3's whole point is that the packaged bytes clear the same bar as the built ones, and two hand-maintained copies drift",
  )

  // Neutered-but-present guards: `continue-on-error: true` or `if: false` on
  // any of the three leaves every step name and keyword in place while the
  // job stays green. Step-level keys sit at 8-space indentation; the shell
  // and JS `if (` / `if [[` inside a run block are indented deeper, so this
  // cannot false-positive on the guard logic itself.
  for (const [label, body] of [
    ['GUARD 1', validateBody],
    ['GUARD 2', postBuildBody],
    ['GUARD 3', postPackageBody],
  ]) {
    assert.ok(
      !/\n {8}continue-on-error:/.test(body),
      `${label} must not carry continue-on-error -- a guard that cannot fail the job is not a guard`,
    )
    assert.ok(
      !/\n {8}if:/.test(body),
      `${label} must not be conditional -- it has to run on every dispatch, from every shell, by every human`,
    )
  }

  // Ordering: validate before the value can reach Vite; each build-then-
  // assert pair stays adjacent; and every guard sits before both places a
  // package can leave this job (upload artifact, GitHub Release).
  assert.ok(
    checkoutStep < validateStep,
    'GUARD 1 must run after Checkout (it needs the repository) and therefore cannot be hoisted above it',
  )
  assert.ok(validateStep < buildWebStep, 'GUARD 1 must run before the web build consumes base_path')
  assert.ok(
    buildWebStep < postBuildAssertStep && postBuildAssertStep < buildPackageStep,
    'GUARD 2 must run directly between the web build and the on-prem package build',
  )
  assert.ok(
    buildPackageStep < postPackageAssertStep,
    'GUARD 3 must run after "Build on-prem package" produced the archive',
  )
  assert.ok(uploadStep > -1 && releaseStep > -1, 'sanity: upload and release steps should still exist')
  assert.ok(
    postPackageAssertStep < uploadStep && postPackageAssertStep < releaseStep,
    'GUARD 3 must run before the package can be uploaded as an artifact or published to a GitHub Release',
  )
})

test('every workflow that feeds Vite a base path is a known one (second packaging lane is an open, tracked gap)', () => {
  // The three guards above live in THIS workflow only. A second lane,
  // .github/workflows/stock-prep-main-package-verify.yml, inlines the same
  // steps (its own comment says so), takes the same base_path input, calls
  // the same scripts/ops/multitable-onprem-package-build.sh, and uploads the
  // resulting zip as a downloadable artifact -- and is NOT guarded. Closing
  // it is an owner call tracked outside this test; what this assertion buys
  // is that a THIRD lane cannot appear silently: adding any new workflow that
  // sets VITE_BASE_PATH reds this test until someone decides whether it needs
  // the guards too.
  const workflowsDir = path.join(repoRoot, '.github/workflows')
  const viteBaseConsumers = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .filter((name) => fs.readFileSync(path.join(workflowsDir, name), 'utf8').includes('VITE_BASE_PATH'))
    .sort()

  assert.deepEqual(
    viteBaseConsumers,
    ['multitable-onprem-package-build.yml', 'stock-prep-main-package-verify.yml'],
    'a workflow that feeds Vite a base path can ship a white-screen package. Exactly two are known: multitable-onprem-package-build.yml (guarded by the test above) and stock-prep-main-package-verify.yml (KNOWN GAP -- inlines the same steps unguarded). If this list changed, either guard the new lane the same way or update this inventory deliberately',
  )
})
