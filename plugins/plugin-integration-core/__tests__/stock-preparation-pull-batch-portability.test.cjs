'use strict'

// 批次标识 BI-1a (register R-65; design §12.2, S6 C-1) — THE PORTABLE FILES. The pure module requires nothing but
// node:crypto; the ledger store requires only the pure module and node:crypto. No lock, governance, continuation,
// refresh, audit, planner, table-action, manual-rows or templates module — so both files can be copied byte-identical
// onto the R maintenance line, and what differs per line (the holder assert, the audit append) is injected. A scan of
// the `require(` calls in the SOURCE text (comments stripped), so a lazy require inside a function is caught too.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const tests = []
const test = (name, fn) => tests.push([name, fn])

function requiresOf(file) {
  const text = fs.readFileSync(path.join(LIB, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
  const out = []
  for (const match of text.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) out.push(match[1].trim())
  return out
}

test('PT-1 the pure module requires node:crypto only', () => {
  assert.deepEqual(requiresOf('stock-preparation-pull-batch.cjs'), ["'node:crypto'"])
})

test('PT-2 the ledger store requires node:crypto and the pure module only (no lock / audit / refresh / table-action module)', () => {
  assert.deepEqual(requiresOf('stock-preparation-pull-batch-store.cjs').sort(), ["'./stock-preparation-pull-batch.cjs'", "'node:crypto'"].sort())
})

// BI-2 (R-65; P2-21): the per-sheet install library is portable too — the pure module only, and its TEXT (comments
// included) names neither the ledger store's file nor the pull-batch switch (both reach it through injected deps).
test('PT-4 the install library requires the pure module only', () => {
  assert.deepEqual(requiresOf('stock-preparation-pull-batch-install.cjs'), ["'./stock-preparation-pull-batch.cjs'"])
})

test('PT-5 the install library text names neither the store file nor the switch env key', () => {
  const text = fs.readFileSync(path.join(LIB, 'stock-preparation-pull-batch-install.cjs'), 'utf8')
  assert.equal(text.includes('stock-preparation-pull-batch-store'), false)
  assert.equal(text.includes('STOCK_PREP_PULL_BATCH_ENABLED'), false)
  assert.equal(text.includes('process.env'), false)
})

test('PT-3 the scan is witnessed: a lazy require inside a function body is found', () => {
  const sample = "function f() { return require('./stock-preparation-project-write-lock.cjs') }\n// require('./commented-out.cjs')\n"
  const found = Array.from(sample.split('\n').map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n').matchAll(/\brequire\s*\(\s*([^)]*)\)/g)).map((m) => m[1])
  assert.deepEqual(found, ["'./stock-preparation-project-write-lock.cjs'"])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-portability.test.cjs', tests)
