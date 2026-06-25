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
const buildScript = fs.readFileSync(buildScriptPath, 'utf8')
const verifyScript = fs.readFileSync(verifyScriptPath, 'utf8')

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
