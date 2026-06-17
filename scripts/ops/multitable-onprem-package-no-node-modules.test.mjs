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

function runVerifierListCheck(listEntries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-package-list-'))
  const listPath = path.join(dir, 'archive-list.txt')
  fs.writeFileSync(listPath, `${listEntries.join('\n')}\n`)
  const result = spawnSync(
    'bash',
    ['-lc', 'source "$VERIFY"; verify_no_bundled_node_modules "$LIST"'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VERIFY: verifyScriptPath,
        LIST: listPath,
      },
      encoding: 'utf8',
    },
  )
  fs.rmSync(dir, { recursive: true, force: true })
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
