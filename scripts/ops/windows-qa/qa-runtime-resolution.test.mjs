#!/usr/bin/env node
/**
 * Attendance Windows-native QA v2 — resolveProductModule resolution contract (owner scope ruling B).
 *
 * Hermetic (node builtins only — safe in the pre-`pnpm install` CI step): every case drives
 * resolveProductModule against a FIXTURE core-backend root built in a temp dir, plus the real
 * repo tree for the mode-table row that needs no build. Pins:
 *   1. the RESOLUTION TABLE — tsx-src -> src/<subpath>.ts ; node-dist -> dist/src/<subpath>.js
 *      (the REAL tsc layout: rootDir "." emits dist/src/**, never dist/<subpath>.js);
 *   2. NO CROSS-MODE FALLBACK — a mode whose path is missing throws its mode-specific error even
 *      when the OTHER mode's file exists right next to it;
 *   3. SYMLINKS REFUSED — a symlinked dist/, a symlinked module file, and a wholesale-symlinked
 *      core-backend root are each rejected (the historical `ln -sfn` workaround must be
 *      impossible, not merely unnecessary);
 *   4. MODE DETECTION — plain node resolves to node-dist; QA_FORCE_TSX=1 forces tsx-src.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { productModuleMode, resolveProductModule, runningUnderTsx } = await import(
  pathToFileURL(path.join(HERE, 'harness', 'qa-runtime.mjs')).href
)

function makeFixtureRoot({ withSrc = true, withDist = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resolution-fixture-'))
  if (withSrc) {
    fs.mkdirSync(path.join(root, 'src', 'attendance'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'attendance', 'w4c0-identity.ts'), 'export const x = 1\n')
  }
  if (withDist) {
    fs.mkdirSync(path.join(root, 'dist', 'src', 'attendance'), { recursive: true })
    fs.writeFileSync(path.join(root, 'dist', 'src', 'attendance', 'w4c0-identity.js'), 'module.exports = { x: 1 }\n')
  }
  return root
}

test('resolution table: tsx-src -> src/<subpath>.ts, node-dist -> dist/src/<subpath>.js', () => {
  const root = makeFixtureRoot()
  assert.equal(
    resolveProductModule('attendance/w4c0-identity', { mode: 'tsx-src', coreBackendRoot: root }),
    path.join(root, 'src', 'attendance', 'w4c0-identity.ts'),
  )
  assert.equal(
    resolveProductModule('attendance/w4c0-identity', { mode: 'node-dist', coreBackendRoot: root }),
    path.join(root, 'dist', 'src', 'attendance', 'w4c0-identity.js'),
  )
  // The OLD (broken) dist layout must never be consulted: plant dist/<subpath>.js and remove the
  // real dist/src file — node-dist must FAIL, not quietly find the wrong-layout file.
  fs.mkdirSync(path.join(root, 'dist', 'attendance'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist', 'attendance', 'w4c0-identity.js'), 'module.exports = {}\n')
  fs.rmSync(path.join(root, 'dist', 'src', 'attendance', 'w4c0-identity.js'))
  assert.throws(
    () => resolveProductModule('attendance/w4c0-identity', { mode: 'node-dist', coreBackendRoot: root }),
    /node-dist mode: compiled module .* is missing/,
    'the legacy dist/<subpath>.js layout must not satisfy node-dist',
  )
})

test('no cross-mode fallback: each mode fails on its missing path even when the other exists', () => {
  const srcOnly = makeFixtureRoot({ withDist: false })
  assert.equal(
    resolveProductModule('attendance/w4c0-identity', { mode: 'tsx-src', coreBackendRoot: srcOnly }),
    path.join(srcOnly, 'src', 'attendance', 'w4c0-identity.ts'),
  )
  assert.throws(
    () => resolveProductModule('attendance/w4c0-identity', { mode: 'node-dist', coreBackendRoot: srcOnly }),
    /node-dist mode: compiled module .* does NOT fall back/s,
    'node-dist with only src present must throw, never fall back to the .ts source',
  )

  const distOnly = makeFixtureRoot({ withSrc: false })
  assert.equal(
    resolveProductModule('attendance/w4c0-identity', { mode: 'node-dist', coreBackendRoot: distOnly }),
    path.join(distOnly, 'dist', 'src', 'attendance', 'w4c0-identity.js'),
  )
  assert.throws(
    () => resolveProductModule('attendance/w4c0-identity', { mode: 'tsx-src', coreBackendRoot: distOnly }),
    /tsx-src mode: product source .* does NOT fall back/s,
    'tsx-src with only dist present must throw, never fall back to dist',
  )

  assert.throws(
    () => resolveProductModule('attendance/w4c0-identity', { mode: 'both', coreBackendRoot: srcOnly }),
    /Unknown product-module mode/,
  )
})

test('symlinks are refused at every level of the resolution path', () => {
  // (a) dist -> elsewhere (the historical `ln -sfn` workaround shape).
  const rootA = makeFixtureRoot({ withDist: false })
  const realDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resolution-realdist-'))
  fs.mkdirSync(path.join(realDist, 'src', 'attendance'), { recursive: true })
  fs.writeFileSync(path.join(realDist, 'src', 'attendance', 'w4c0-identity.js'), 'module.exports = {}\n')
  fs.symlinkSync(realDist, path.join(rootA, 'dist'))
  assert.throws(
    () => resolveProductModule('attendance/w4c0-identity', { mode: 'node-dist', coreBackendRoot: rootA }),
    /traverses a SYMLINK/,
    'a symlinked dist/ must refuse',
  )

  // (b) the module FILE itself is a symlink.
  const rootB = makeFixtureRoot()
  const realFile = path.join(rootB, 'dist', 'src', 'attendance', 'w4c0-identity.js')
  const aside = `${realFile}.real`
  fs.renameSync(realFile, aside)
  fs.symlinkSync(aside, realFile)
  assert.throws(
    () => resolveProductModule('attendance/w4c0-identity', { mode: 'node-dist', coreBackendRoot: rootB }),
    /traverses a SYMLINK/,
    'a symlinked module file must refuse',
  )
  // src side unaffected by the dist symlink:
  assert.equal(
    resolveProductModule('attendance/w4c0-identity', { mode: 'tsx-src', coreBackendRoot: rootB }),
    path.join(rootB, 'src', 'attendance', 'w4c0-identity.ts'),
  )

  // (c) the whole core-backend root is a symlink.
  const rootC = makeFixtureRoot()
  const linkRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resolution-link-')), 'core-backend')
  fs.symlinkSync(rootC, linkRoot)
  assert.throws(
    () => resolveProductModule('attendance/w4c0-identity', { mode: 'node-dist', coreBackendRoot: linkRoot }),
    /traverses a SYMLINK/,
    'a wholesale-symlinked core-backend root must refuse',
  )
})

test('mode detection: plain node => node-dist; QA_FORCE_TSX=1 => tsx-src', () => {
  // This test file runs under plain `node --test` (no tsx loader) in CI.
  assert.equal(runningUnderTsx(), false, 'plain node must not read as tsx')
  assert.equal(productModuleMode(), 'node-dist')
  const prior = process.env.QA_FORCE_TSX
  try {
    process.env.QA_FORCE_TSX = '1'
    assert.equal(productModuleMode(), 'tsx-src')
  } finally {
    if (prior === undefined) delete process.env.QA_FORCE_TSX
    else process.env.QA_FORCE_TSX = prior
  }
  // A script ARGUMENT containing "tsx" must NOT flip the mode (the old argv heuristic did).
  const priorArgv = process.argv
  try {
    process.argv = [...priorArgv, '--evidence-dir', '/tmp/tsx-evidence']
    assert.equal(productModuleMode(), 'node-dist', 'argv content must not affect mode detection')
  } finally {
    process.argv = priorArgv
  }
})
