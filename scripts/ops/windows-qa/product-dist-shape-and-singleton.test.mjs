#!/usr/bin/env node
/**
 * Attendance Windows-native QA v2 — DELIVERED-PACKAGE SHAPE + SINGLE-INSTANCE suite (owner scope
 * ruling B). Needs `pnpm install` (build + tsx) — wired in CI AFTER the install step, unlike the
 * hermetic qa-runtime-resolution.test.mjs.
 *
 * 1. SHAPE: builds core-backend (`pnpm --filter @metasheet/core-backend build`) and asserts every
 *    product module the windows-qa tooling loads exists at `dist/src/<subpath>.js` — the layout
 *    resolveProductModule's node-dist mode expects (tsconfig rootDir "." emits dist/src/**). A
 *    future tsconfig/layout change breaks THIS test, not the Windows field run. The subpath list
 *    is extracted MECHANICALLY from the tooling sources (importProduct/resolveProductModule
 *    literals), with a floor + named-anchor negative control so an empty scan cannot green.
 *
 * 2. SINGLE-INSTANCE: runs harness/singleton-probe.mjs (witness minted through the harness
 *    pipeline must be ACCEPTED by the product's own witness check — module-private WeakSets exist
 *    once) under BOTH modes: plain node (node-dist) and `node --import tsx` (tsx-src — the EXACT
 *    documented macOS invocation; the tsx CLI wires a different pipeline and would not exercise
 *    the documented path). The probe's `--dual-route` flag is the discriminating-power negative
 *    control: re-creating the OLD ESM file-URL import route under `node --import tsx` MUST be
 *    rejected with W4C0_OPERATION_WITNESS_REQUIRED on the Node lines where the dual instance is
 *    real — proving the probe can actually detect a dual instance.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../..')
const CORE_BACKEND = path.join(REPO_ROOT, 'packages/core-backend')
const WINDOWS_QA_DIR = HERE
const PROBE = path.join(HERE, 'harness', 'singleton-probe.mjs')
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

/** Mechanically extract every product-module subpath the windows-qa tooling loads. */
function collectLoadedSubpaths() {
  const subpaths = new Set()
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.runtime' || entry.name === 'node_modules') continue
        walk(abs)
      } else if (entry.isFile() && abs.endsWith('.mjs')) {
        files.push(abs)
      }
    }
  }
  walk(WINDOWS_QA_DIR)
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const match of content.matchAll(/(?:importProduct|resolveProductModule)\(\s*'([^']+)'/g)) {
      subpaths.add(match[1])
    }
  }
  return { subpaths: [...subpaths].sort(), scannedFileCount: files.length }
}

test('delivered-package shape: build emits dist/src/<subpath>.js for every tooling-loaded module', () => {
  execFileSync('pnpm', ['--filter', '@metasheet/core-backend', 'build'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  })

  const { subpaths, scannedFileCount } = collectLoadedSubpaths()
  // Negative controls on the extraction itself: an empty/misrooted scan cannot green.
  assert.ok(scannedFileCount >= 10, `expected to scan the windows-qa tooling tree, saw ${scannedFileCount} files`)
  assert.ok(subpaths.length >= 8, `expected >= 8 distinct product subpaths, got ${subpaths.length}: ${subpaths}`)
  for (const anchor of ['attendance/w4c0-identity', 'attendance/w4c2-scheduled-run', 'db/migrate']) {
    assert.ok(subpaths.includes(anchor), `mechanical extraction must find ${anchor}`)
  }

  for (const subpath of subpaths) {
    const srcTs = path.join(CORE_BACKEND, 'src', `${subpath}.ts`)
    const distJs = path.join(CORE_BACKEND, 'dist', 'src', `${subpath}.js`)
    assert.ok(fs.existsSync(srcTs), `tsx-src path missing for ${subpath}: ${srcTs}`)
    assert.ok(
      fs.existsSync(distJs),
      `node-dist path missing for ${subpath}: ${distJs} — the tsc layout no longer matches ` +
        `resolveProductModule's node-dist mode (dist/src/<subpath>.js); fix the resolver AND this ` +
        `test together, never the field run`,
    )
  }
})

function runProbe(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2 * 60 * 1000,
    })
    return { status: 0, out: out.trim() }
  } catch (error) {
    return { status: error.status ?? -1, out: `${error.stdout ?? ''}`.trim() }
  }
}

test('single-instance: harness pipeline shares ONE w4c0-identity instance in BOTH modes', () => {
  // node-dist (plain node against the dist just built).
  const dist = runProbe(process.execPath, [PROBE])
  assert.equal(dist.status, 0, `node-dist probe failed: ${dist.out}`)
  assert.deepEqual(JSON.parse(dist.out), { mode: 'node-dist', dualRoute: false, verdict: 'single-instance' })

  // tsx-src via the EXACT documented macOS invocation: `node --import tsx <script>`.
  assert.ok(fs.existsSync(TSX_BIN), `tsx missing at ${TSX_BIN} (pnpm install first)`)
  const tsx = runProbe(process.execPath, ['--import', 'tsx', PROBE])
  assert.equal(tsx.status, 0, `tsx-src probe failed: ${tsx.out}`)
  assert.deepEqual(JSON.parse(tsx.out), { mode: 'tsx-src', dualRoute: false, verdict: 'single-instance' })
})

test('single-instance negative control: the OLD ESM file-URL route IS detected as dual under tsx', () => {
  const major = Number(process.versions.node.split('.')[0])
  // Node >= 23 unifies require(esm)/loader pipelines, making the old route coincidentally safe —
  // the control is asserted on the Node lines CI pins (18.x / 20.x), where the dual instance is
  // real. The PRIMARY single-instance assertions above never skip on any version.
  if (major > 22) {
    console.log(`note: dual-route control not asserted on node ${process.versions.node} (unified module pipeline)`)
    return
  }
  const dual = runProbe(process.execPath, ['--import', 'tsx', PROBE, '--dual-route'])
  assert.notEqual(dual.status, 0, `dual-route probe unexpectedly green: ${dual.out}`)
  const parsed = JSON.parse(dual.out)
  assert.equal(parsed.mode, 'tsx-src')
  assert.equal(parsed.dualRoute, true)
  assert.equal(
    parsed.verdict,
    'rejected:W4C0_OPERATION_WITNESS_REQUIRED',
    'the probe must detect the dual instance via the product witness check (discriminating power)',
  )
})
