import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F22 (2026-08-31): the live r7 upgrade used `Get-ChildItem -Exclude 'node_modules'`
// during a recursive copy. `-Exclude` does not filter directories in recursion, so an
// entire plugin lib/ directory was silently skipped — the deployment was missing
// stock-preparation-preflight.cjs until a hand-check against the package caught it.
// See docs/development/takeover-beiliao-20260821/first-deployment-lessons-20260831.md
// (Appendix A, F22) and r7-build-manifest.md §2.
//
// This test file exercises scripts/ops/multitable-onprem-package-upgrade-inplace.ps1
// three ways, because none of them substitutes for the others:
//   1. STATIC — the forbidden -Exclude+-Recurse pattern can never reappear in the
//      script text, and the must-exist manifest still names the exact file F22 lost.
//   2. UNIT — the real walk-files copy / checksum / must-exist-assertion functions,
//      dot-sourced and called directly against disposable fixtures.
//   3. END-TO-END — the whole script, invoked exactly as an operator would invoke it
//      (pwsh -File, real archive, a fake pm2 + a real `node` migration stub + a real
//      HTTP health endpoint), proving the checksum gate and the F22 tripwire both
//      refuse BEFORE any live file is touched, and that a clean upgrade actually
//      replaces files while preserving each plugin's node_modules.

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scriptPath = path.join(repoRoot, 'scripts/ops/multitable-onprem-package-upgrade-inplace.ps1')
const scriptSource = fs.readFileSync(scriptPath, 'utf8')

// Strips PowerShell `<# ... #>` block comments (used here for rich, deliberately
// quotes-the-forbidden-syntax documentation of WHY -Exclude is banned) before the
// static tripwire below scans for live code. Without this, the script's own
// explanation of F22 ("do not rewrite this as ... -Exclude ...") would trip its
// own tripwire — the goal is banning the pattern from CODE, not from prose that
// quotes it as a warning.
function stripPowerShellBlockComments(source) {
  return source.replace(/<#[\s\S]*?#>/g, '')
}
const scriptCodeOnly = stripPowerShellBlockComments(scriptSource)

const PREFLIGHT_FILE = 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'
const MANIFEST_FILE = 'plugins/plugin-integration-core/app.manifest.json'

// ── 1. STATIC ────────────────────────────────────────────────────────────────────

test('never combines -Exclude with a recursive copy (the F22 tripwire)', () => {
  // Broad, deliberately dumb regex tripwire: no LIVE CODE line may contain
  // -Exclude at all (block-comment prose that quotes the forbidden syntax as a
  // warning is stripped first — see stripPowerShellBlockComments). F22 was
  // caused by -Exclude on a recursive copy not filtering directories; the fix
  // (Copy-TreeExcludingNodeModules) walks files instead and has no legitimate
  // code-level use for -Exclude anywhere in this script.
  assert.doesNotMatch(
    scriptCodeOnly,
    /-Exclude/i,
    'the script must not use -Exclude in live code — F22 was caused by -Exclude on a recursive copy not filtering directories; the fix walks files instead and has no legitimate use for -Exclude',
  )

  // Narrower, more targeted variant in case -Exclude is ever reintroduced for an
  // unrelated reason: fail specifically when -Exclude and -Recurse co-occur on
  // what looks like a single Copy-Item/Get-ChildItem statement.
  const lines = scriptCodeOnly.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const window = lines.slice(i, i + 3).join(' ')
    if (/(Copy-Item|Get-ChildItem)[^\n]*-Recurse/i.test(window) && /-Exclude/i.test(window)) {
      assert.fail(
        `forbidden pattern near line ${i + 1}: a recursive Copy-Item/Get-ChildItem combined with -Exclude ` +
          `(this is exactly the F22 defect — -Exclude does not filter directories during recursion)`,
      )
    }
  }
})

test('walk-files copy is implemented by enumerating files, not by filtering a recursive listing', () => {
  assert.match(
    scriptSource,
    /function Copy-TreeExcludingNodeModules/,
    'the F22-safe copy helper must exist as a named, testable function',
  )
  assert.match(
    scriptSource,
    /Get-ChildItem -LiteralPath \$sourceFull -Recurse -File -Force/,
    'the copy helper must enumerate FILES (not directories) recursively and test each one individually',
  )
  assert.match(
    scriptSource,
    /Test-IsNodeModulesRelativePath/,
    'the copy helper must delegate the node_modules decision to the standalone, unit-testable predicate',
  )
})

test('must-exist manifest defaults to the exact file F22 lost, plus the app manifest', () => {
  const manifestBlock = scriptSource.match(
    /\[string\[\]\]\$MustExistManifest = @\(([\s\S]*?)\)/,
  )
  assert.ok(manifestBlock, 'the script must declare a parameterized $MustExistManifest default array')

  assert.match(
    manifestBlock[1],
    /plugins\/plugin-integration-core\/lib\/stock-preparation-preflight\.cjs/,
    'the default manifest must include the exact file F22 silently dropped',
  )
  assert.match(
    manifestBlock[1],
    /plugins\/plugin-integration-core\/app\.manifest\.json/,
    'the default manifest must include app.manifest.json',
  )
})

test('the F22 tripwire assertion refuses to proceed on any missing file', () => {
  assert.match(
    scriptSource,
    /function Assert-MustExistFiles/,
    'the must-exist assertion must be a standalone, unit-testable function',
  )
  assert.match(
    scriptSource,
    /throw "UPGRADE_ASSERTION_MISSING_FILES/,
    'a missing file must throw a specific, greppable error naming what is missing',
  )
})

test('package checksum is verified before anything else runs', () => {
  const step1Index = scriptSource.indexOf('Step 1/8: verify package checksum')
  const step2Index = scriptSource.indexOf('Step 2/8: stop pm2 app')
  assert.ok(step1Index > -1 && step2Index > -1, 'both step markers must be present')
  assert.ok(step1Index < step2Index, 'checksum verification must run before the pm2 app is stopped')
  assert.match(
    scriptSource,
    /throw "PACKAGE_CHECKSUM_MISMATCH/,
    'a checksum mismatch must throw a specific, greppable error and refuse to proceed',
  )
})

// ── 2. UNIT (dot-source the real script, call the real functions) ────────────────

function runPwshHarness(harness) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], {
    encoding: 'utf8',
  })
  return result
}

function dotSourcePrelude(scratchDir) {
  // -PackageArchive is mandatory but irrelevant when only defining functions;
  // pass a harmless placeholder and an explicit -RootDir so the RootDir
  // parameter default (which resolves PSScriptRoot) is never evaluated.
  return `. '${scriptPath}' -PackageArchive 'unused' -RootDir '${scratchDir}' *> $null\n`
}

test('Test-IsNodeModulesRelativePath matches only an exact node_modules path segment', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const harness =
      dotSourcePrelude(scratch) +
      [
        "Write-Host ('A=' + (Test-IsNodeModulesRelativePath -RelativePath 'lib\\node_modules\\pkg\\x.js'))",
        "Write-Host ('B=' + (Test-IsNodeModulesRelativePath -RelativePath 'node_modules\\pkg\\x.js'))",
        "Write-Host ('C=' + (Test-IsNodeModulesRelativePath -RelativePath 'lib\\stock-preparation-preflight.cjs'))",
        "Write-Host ('D=' + (Test-IsNodeModulesRelativePath -RelativePath 'lib\\my-node_modules-lookalike\\x.js'))",
      ].join('\n')
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /A=True/)
    assert.match(result.stdout, /B=True/)
    assert.match(result.stdout, /C=False/)
    // A directory merely named similarly to node_modules (not an exact path
    // segment match) must NOT be treated as node_modules.
    assert.match(result.stdout, /D=False/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Copy-TreeExcludingNodeModules copies real files but skips every node_modules path (RED-witnessed)', () => {
  // RED WITNESS: with the forbidden `Get-ChildItem -Recurse -Exclude 'node_modules'`
  // pattern (the literal F22 defect), a plugin's OTHER top-level directories can be
  // silently skipped alongside node_modules. This test asserts the actual, positive
  // behavior the fix must have: lib/ files ARE copied, node_modules files are NOT.
  // It was run against the intentionally-reintroduced -Exclude variant (see the
  // "static -Exclude tripwire" RED/GREEN cycle in this PR's description) and failed
  // there before this walk-files implementation replaced it.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const src = path.join(scratch, 'src')
    fs.mkdirSync(path.join(src, 'lib'), { recursive: true })
    fs.mkdirSync(path.join(src, 'node_modules', 'pkg'), { recursive: true })
    fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(src, 'lib', 'stock-preparation-preflight.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(src, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(src, 'scripts', 'tool.mjs'), 'export {}\n')
    fs.writeFileSync(path.join(src, 'app.manifest.json'), '{}\n')

    const dst = path.join(scratch, 'dst')
    const harness =
      dotSourcePrelude(scratch) +
      [
        `$result = Copy-TreeExcludingNodeModules -Source '${src}' -Destination '${dst}'`,
        "Write-Host ('Copied=' + $result.Copied)",
        "Write-Host ('Skipped=' + $result.Skipped)",
      ].join('\n')
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Copied=3/, 'lib, scripts, and root files (3 total) must be copied')
    assert.match(result.stdout, /Skipped=1/, 'exactly the one node_modules file must be skipped')

    assert.ok(
      fs.existsSync(path.join(dst, 'lib', 'stock-preparation-preflight.cjs')),
      'F22 regression: the preflight file must survive the copy',
    )
    assert.ok(fs.existsSync(path.join(dst, 'scripts', 'tool.mjs')), 'sibling directories must not be dropped')
    assert.ok(fs.existsSync(path.join(dst, 'app.manifest.json')))
    assert.ok(
      !fs.existsSync(path.join(dst, 'node_modules', 'pkg', 'index.js')),
      'node_modules must never be copied by this helper',
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Test-PackageChecksum refuses a mismatched sidecar and accepts a matching one (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const archivePath = path.join(scratch, 'pkg.zip')
    fs.writeFileSync(archivePath, 'not-really-a-zip-but-bytes-are-bytes')
    const actualHash = createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')

    fs.writeFileSync(`${archivePath}.sha256`, `${actualHash}  pkg.zip\n`)
    const okHarness =
      dotSourcePrelude(scratch) +
      `try { $h = Test-PackageChecksum -ArchivePath '${archivePath}'; Write-Host "OK=$h" } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const okResult = runPwshHarness(okHarness)
    assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout)
    assert.match(okResult.stdout, new RegExp(`OK=${actualHash}`), 'a matching sidecar must verify and return the digest')

    // RED case: corrupt the sidecar digest. The function must throw, by name,
    // a PACKAGE_CHECKSUM_MISMATCH error — never silently proceed.
    fs.writeFileSync(`${archivePath}.sha256`, `${'0'.repeat(64)}  pkg.zip\n`)
    const badHarness =
      dotSourcePrelude(scratch) +
      `try { Test-PackageChecksum -ArchivePath '${archivePath}'; Write-Host "DID_NOT_THROW" } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const badResult = runPwshHarness(badHarness)
    assert.equal(badResult.status, 0, badResult.stderr || badResult.stdout)
    assert.doesNotMatch(badResult.stdout, /DID_NOT_THROW/, 'a mismatched checksum must throw, never proceed silently')
    assert.match(badResult.stdout, /THREW=PACKAGE_CHECKSUM_MISMATCH/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Assert-MustExistFiles passes when complete and names every missing file otherwise (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    fs.mkdirSync(path.join(scratch, 'plugins/plugin-integration-core/lib'), { recursive: true })
    fs.writeFileSync(path.join(scratch, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'), '{}')
    fs.writeFileSync(path.join(scratch, 'plugins/plugin-integration-core/app.manifest.json'), '{}')

    const okHarness =
      dotSourcePrelude(scratch) +
      `try { Assert-MustExistFiles -RootDir '${scratch}' -RelativePaths @('${PREFLIGHT_FILE}', '${MANIFEST_FILE}') | Out-Null; Write-Host 'OK' } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const okResult = runPwshHarness(okHarness)
    assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout)
    assert.match(okResult.stdout, /^OK/m)

    // RED case: the exact F22 failure mode — the preflight file is absent.
    fs.rmSync(path.join(scratch, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'))
    const badHarness =
      dotSourcePrelude(scratch) +
      `try { Assert-MustExistFiles -RootDir '${scratch}' -RelativePaths @('${PREFLIGHT_FILE}', '${MANIFEST_FILE}') | Out-Null; Write-Host 'DID_NOT_THROW' } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const badResult = runPwshHarness(badHarness)
    assert.equal(badResult.status, 0, badResult.stderr || badResult.stdout)
    assert.doesNotMatch(badResult.stdout, /DID_NOT_THROW/)
    assert.match(badResult.stdout, /THREW=UPGRADE_ASSERTION_MISSING_FILES/)
    assert.match(badResult.stdout, new RegExp(PREFLIGHT_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

// ── 3. END-TO-END (real pwsh -File invocation of the whole script) ───────────────

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function buildFixturePackageStage(stageDir, { omitPreflightFile = false } = {}) {
  const write = (rel, contents) => {
    const abs = path.join(stageDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, contents)
  }

  write('PACKAGE-METADATA.json', JSON.stringify({ name: 'fixture-package' }, null, 2))
  write('apps/web/dist/index.html', '<html>NEW WEB DIST</html>\n')
  write(
    'packages/core-backend/dist/src/db/migrate.js',
    [
      "const fs = require('fs')",
      "const marker = process.env.UPGRADE_TEST_ENV_MARKER || 'MISSING'",
      "fs.writeFileSync(process.env.UPGRADE_TEST_MIGRATE_MARKER_PATH, marker)",
      "console.log('migrate-ok marker=' + marker)",
    ].join('\n'),
  )
  write('packages/core-backend/migrations/001_new.sql', 'select 1;\n')
  write('plugins/plugin-integration-core/index.cjs', "module.exports = { name: 'plugin-integration-core' }\n")
  write('plugins/plugin-integration-core/app.manifest.json', JSON.stringify({ id: 'plugin-integration-core' }))
  if (!omitPreflightFile) {
    write('plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs', 'module.exports = {}\n')
  }
  write('plugins/plugin-integration-core/lib/other-module.cjs', 'module.exports = {}\n')
}

function buildFixtureLiveRoot(liveRoot, { pm2LogPath }) {
  const write = (rel, contents) => {
    const abs = path.join(liveRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, contents)
  }

  write('docker/app.env', 'UPGRADE_TEST_ENV_MARKER=from-app-env\n# a comment\n\nJWT_SECRET="quoted-value"\n')
  write('apps/web/dist/index.html', '<html>OLD WEB DIST</html>\n')
  write('packages/core-backend/dist/src/db/migrate.js', "console.log('stale pre-upgrade migrate.js')\n")
  write('packages/core-backend/migrations/000_old.sql', 'select 0;\n')
  write('plugins/plugin-integration-core/index.cjs', "module.exports = { name: 'stale' }\n")
  write('plugins/plugin-integration-core/app.manifest.json', JSON.stringify({ id: 'stale' }))
  write('plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs', 'module.exports = { stale: true }\n')
  write('plugins/plugin-integration-core/node_modules/some-dep/index.js', 'module.exports = {}\n')

  // Fake local pm2 binary — Resolve-Pm2Command in the script prefers
  // <RootDir>/node_modules/.bin/pm2.cmd over a bare `pm2` on PATH.
  const pm2CmdPath = path.join(liveRoot, 'node_modules/.bin/pm2.cmd')
  fs.mkdirSync(path.dirname(pm2CmdPath), { recursive: true })
  fs.writeFileSync(
    pm2CmdPath,
    ['@echo off', `echo %* >> "${pm2LogPath}"`, 'exit /b 0', ''].join('\r\n'),
  )
}

function buildFixtureArchive(root, { omitPreflightFile = false } = {}) {
  const stageParent = path.join(root, 'stage')
  const packageName = 'fixture-multitable-onprem-package'
  const stageDir = path.join(stageParent, packageName)
  buildFixturePackageStage(stageDir, { omitPreflightFile })

  const archivePath = path.join(root, `${packageName}.zip`)
  const compress = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${stageDir}' -DestinationPath '${archivePath}' -Force`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(compress.status, 0, compress.stderr || compress.stdout)

  const digest = sha256File(archivePath)
  fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${path.basename(archivePath)}\n`)

  return { archivePath, digest }
}

function startHealthServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}/api/health` })
    })
  })
}

function runUpgradeScript(args, envOverrides = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  })
}

// Async variant, required whenever the script under test will call OUT to an
// HTTP server that lives in THIS SAME Node process (the health check server
// below): child_process.spawnSync blocks the entire Node event loop until the
// child exits, so a same-process http.Server cannot accept the script's own
// healthcheck connections while spawnSync is blocking — every request would
// hang until the client's own timeout. spawn (async) keeps the event loop
// live so the health server can actually answer.
function runUpgradeScriptAsync(args, envOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
      env: { ...process.env, ...envOverrides },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('end-to-end: a clean upgrade replaces dist/migrations/plugins, preserves node_modules, backs up first, and reports health OK', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-e2e-'))
  const health = await startHealthServer()
  try {
    const liveRoot = path.join(root, 'live')
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')
    const migrateMarkerPath = path.join(root, 'migrate-marker.txt')

    buildFixtureLiveRoot(liveRoot, { pm2LogPath })
    const { archivePath } = buildFixtureArchive(root)

    const result = await runUpgradeScriptAsync(
      [
        '-PackageArchive', archivePath,
        '-RootDir', liveRoot,
        '-Pm2AppName', 'metasheet-backend',
        '-EnvFile', path.join(liveRoot, 'docker/app.env'),
        '-BackupRoot', backupRoot,
        '-StagingRoot', stagingRoot,
        '-HealthUrl', health.url,
        '-HealthcheckAttempts', '3',
        '-HealthcheckDelaySec', '1',
      ],
      { UPGRADE_TEST_MIGRATE_MARKER_PATH: migrateMarkerPath },
    )

    if (result.status !== 0) {
      assert.fail(`expected a clean upgrade to succeed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    // New content replaced the old.
    assert.match(fs.readFileSync(path.join(liveRoot, 'apps/web/dist/index.html'), 'utf8'), /NEW WEB DIST/)
    assert.match(
      fs.readFileSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'), 'utf8'),
      /module\.exports = \{\}/,
    )
    assert.ok(fs.existsSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/other-module.cjs')))
    assert.ok(fs.existsSync(path.join(liveRoot, 'packages/core-backend/migrations/001_new.sql')))

    // node_modules for the plugin must survive untouched (the F22 "preserving
    // each plugin's node_modules" requirement).
    assert.ok(
      fs.existsSync(path.join(liveRoot, 'plugins/plugin-integration-core/node_modules/some-dep/index.js')),
      'plugin node_modules must be preserved across the upgrade',
    )

    // Backup snapshot captured the OLD content before replacement.
    const backupDirs = fs.readdirSync(backupRoot)
    assert.equal(backupDirs.length, 1)
    const backupPath = path.join(backupRoot, backupDirs[0])
    assert.match(fs.readFileSync(path.join(backupPath, 'apps/web/dist/index.html'), 'utf8'), /OLD WEB DIST/)
    assert.match(
      fs.readFileSync(path.join(backupPath, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'), 'utf8'),
      /stale: true/,
    )

    // The reported backup path in stdout matches the folder actually written.
    assert.match(result.stdout, /BACKUP_PATH=/)
    const printedBackupLine = result.stdout.split('\n').find((line) => line.startsWith('BACKUP_PATH='))
    assert.equal(path.resolve(printedBackupLine.slice('BACKUP_PATH='.length).trim()), path.resolve(backupPath))

    // pm2 was stopped, then restarted with --update-env.
    const pm2Log = fs.readFileSync(pm2LogPath, 'utf8')
    assert.match(pm2Log, /stop metasheet-backend/)
    assert.match(pm2Log, /restart metasheet-backend --update-env/)

    // Migrations ran with env loaded from docker/app.env into THIS process,
    // not whatever pm2 happened to be holding: the marker's VALUE came from
    // UPGRADE_TEST_ENV_MARKER, which only docker/app.env defines (never the
    // parent test process or pm2).
    assert.ok(fs.existsSync(migrateMarkerPath), 'migrate stub should have run and written its marker')
    assert.equal(fs.readFileSync(migrateMarkerPath, 'utf8').trim(), 'from-app-env')

    // Final report names package, backup, migration exit, and health OK, plus
    // the exact operator follow-up commands.
    assert.match(result.stdout, /package:\s+fixture-multitable-onprem-package\.zip/)
    assert.match(result.stdout, /migration exit:\s+0/)
    assert.match(result.stdout, /health:\s+OK/)
    assert.match(result.stdout, /stock-preparation\/preflight/)
    assert.match(result.stdout, /stock-prep-acceptance-bootstrap\.mjs/)
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end: a checksum mismatch refuses BEFORE touching pm2 or any live file (RED-witnessed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-e2e-'))
  try {
    const liveRoot = path.join(root, 'live')
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildFixtureLiveRoot(liveRoot, { pm2LogPath })
    const { archivePath } = buildFixtureArchive(root)
    // Corrupt the sidecar after a legitimate archive was built.
    fs.writeFileSync(`${archivePath}.sha256`, `${'0'.repeat(64)}  ${path.basename(archivePath)}\n`)

    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-RestartService', '0',
    ])

    assert.notEqual(result.status, 0, 'a checksum mismatch must be a non-zero exit')
    assert.match(result.stderr + result.stdout, /PACKAGE_CHECKSUM_MISMATCH/)

    // Nothing downstream of the checksum gate ran: pm2 was never invoked, no
    // backup was written, and the stale plugin file is still the stale one.
    assert.ok(!fs.existsSync(pm2LogPath), 'pm2 must never be invoked when the checksum gate refuses')
    assert.ok(!fs.existsSync(backupRoot) || fs.readdirSync(backupRoot).length === 0, 'no backup should be written')
    assert.match(
      fs.readFileSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'), 'utf8'),
      /stale: true/,
      'the live plugin file must be untouched',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end: a package missing the preflight file fails the F22 tripwire and still reports the backup path (RED-witnessed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-e2e-'))
  try {
    const liveRoot = path.join(root, 'live')
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildFixtureLiveRoot(liveRoot, { pm2LogPath })
    // Reproduce F22 directly: the package never shipped the preflight file
    // (as if a bad copy step had dropped it), so post-swap the live root will
    // not have it either, once the (correct, present-in-fixture) stale copy is
    // gone — model this by removing the live stale file BEFORE the swap so
    // the fixture's package is the only possible source, and it is missing.
    fs.rmSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'))
    const { archivePath } = buildFixtureArchive(root, { omitPreflightFile: true })

    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-RestartService', '0',
    ])

    assert.notEqual(result.status, 0, 'a missing must-exist file must be a non-zero exit')
    const combined = result.stderr + result.stdout
    assert.match(combined, /UPGRADE_ASSERTION_MISSING_FILES/)
    assert.match(combined, /stock-preparation-preflight\.cjs/)
    assert.match(combined, /STOP/)

    // The backup DID happen (it runs before the swap) — the operator must be
    // told where to restore from even when the upgrade refuses mid-flight.
    assert.match(combined, /BACKUP_PATH=/)
    const backupDirs = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []
    assert.equal(backupDirs.length, 1, 'a backup snapshot must exist even though the upgrade ultimately refused')

    // Migrations must never have run past a failed assertion.
    assert.ok(!pm2LogAsksForRestart(pm2LogPath), 'pm2 restart must never be reached after the tripwire fires')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function pm2LogAsksForRestart(pm2LogPath) {
  if (!fs.existsSync(pm2LogPath)) return false
  return /restart/.test(fs.readFileSync(pm2LogPath, 'utf8'))
}
