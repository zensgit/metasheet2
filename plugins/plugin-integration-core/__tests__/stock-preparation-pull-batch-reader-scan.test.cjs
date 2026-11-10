'use strict'

// 批次标识 BI-1b (design §4.4, S6 C-8; register R-65) — THE READER / ENTRY-POINT SOURCE SCAN. The reader strips the two
// band cells only when it is handed the server-held band; a call site that forgets it would hash band cells into a
// token / ledger / archive / plan / settlement digest (the #6475 duplicate-batch class) the day a band exists. So:
//
//   RS-1  every code occurrence of `readExistingStockPreparationRows` in the plugin runtime (lib/**/*.cjs, index.cjs)
//         and scripts/ops/*.mjs is exactly one of: its definition, its __internals export, a CALL (direct or MEMBER —
//         every route call is `tableActionInternals.readExistingStockPreparationRows(`, readiness's is
//         `deps.readExistingStockPreparationRows(`) whose arguments name `pullBatchBand`, or a value reference on a
//         closed allow-list whose consumer passes it. The (file, kind) multiset is PINNED: a new call site — with or
//         without the band — reds until it is added here deliberately (M-1B-2 / M-1B-19).
//   RS-2  every `computeDryRun(` call in table-actions passes the lane (`pullBatchLane`): the strip and the probe fold
//   RS-3  every route call of the four small-lane lib entries passes `pullBatch:`; the large planner gets
//         `pullBatchPlanFor`, the chunk runner `pullBatchGate:`
//   RS-4  witness: the scanner run over a synthetic source with one band-less call reports it
//
// Code-only text (comments and string bodies blanked, offsets kept) and balanced-paren argument extraction — the
// stock-preparation-refresh-scan precedent, widened to member calls.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN = path.join(__dirname, '..')
const LIB = path.join(PLUGIN, 'lib')
const REPO = path.join(PLUGIN, '..', '..')

const tests = []
const test = (name, fn) => tests.push([name, fn])

function codeOnly(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i += 1 }
      out += '  '
      i += 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      out += quote
      i += 1
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { out += '  '; i += 2; continue }
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += quote
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function callArgsAt(code, index) {
  const open = code.indexOf('(', index)
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(' || code[i] === '{' || code[i] === '[') depth += 1
    else if (code[i] === ')' || code[i] === '}' || code[i] === ']') {
      depth -= 1
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced call')
}

const NAME = 'readExistingStockPreparationRows'

/** Every code occurrence of NAME, classified. Kinds: definition | export | call:band | call:NO_BAND | ref:<context>. */
function classify(source) {
  const code = codeOnly(source.replace(/\r\n/g, '\n'))
  const out = []
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${NAME}(?![A-Za-z0-9_$])`, 'g')
  let match
  while ((match = pattern.exec(code)) !== null) {
    const at = match.index + match[1].length
    const before = code.slice(Math.max(0, at - 40), at)
    const after = code.slice(at + NAME.length, at + NAME.length + 3)
    if (/function\s*$/.test(before)) { out.push('definition'); continue }
    if (after.startsWith('(')) {
      out.push(callArgsAt(code, at).includes('pullBatchBand') ? 'call:band' : 'call:NO_BAND')
      continue
    }
    const line = code.slice(code.lastIndexOf('\n', at) + 1, code.indexOf('\n', at)).trim()
    if (/^readExistingStockPreparationRows,$/.test(line)) { out.push('export'); continue }
    if (/^readExistingStockPreparationRows: tableActionInternals\.readExistingStockPreparationRows,$/.test(line)) { out.push('ref:deps'); continue }
    if (/^async function readRows\(\{ readExistingStockPreparationRows,/.test(line)) { out.push('ref:status-param'); continue }
    // (string bodies are blanked: `'function'` reads as eight spaces between the quotes)
    if (/typeof (deps\.)?readExistingStockPreparationRows !== ' {8}'/.test(line)) { out.push('ref:typeof'); continue }
    out.push(`ref:UNREVIEWED:${line.slice(0, 80)}`)
  }
  return out
}

function runtimeFiles() {
  const files = ['index.cjs']
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}${entry.name}/`)
      else if (entry.name.endsWith('.cjs')) files.push(`lib/${rel}${entry.name}`)
    }
  }
  walk(LIB, '')
  return files
}

const sorted = (list) => [...list].sort()

test('RS-1 every occurrence of the reader is reviewed; every CALL passes the server-held band; the (file, kind) multiset is pinned', () => {
  const found = {}
  for (const file of runtimeFiles()) {
    const kinds = classify(fs.readFileSync(path.join(PLUGIN, file), 'utf8'))
    if (kinds.length) found[file] = sorted(kinds)
  }
  for (const file of fs.readdirSync(path.join(REPO, 'scripts', 'ops')).filter((name) => name.endsWith('.mjs'))) {
    const kinds = classify(fs.readFileSync(path.join(REPO, 'scripts', 'ops', file), 'utf8'))
    if (kinds.length) found[`scripts/ops/${file}`] = sorted(kinds)
  }
  for (const [file, kinds] of Object.entries(found)) {
    assert.ok(!kinds.includes('call:NO_BAND'), `${file}: a reader call without pullBatchBand`)
    assert.ok(!kinds.some((kind) => kind.startsWith('ref:UNREVIEWED')), `${file}: an unreviewed reference ${JSON.stringify(kinds)}`)
  }
  assert.deepEqual(found, {
    // the change-plan / review read (R2), the large plan (R4), the export gate (R5): calls with the band; readiness
    // deps and the status deps hand the reader on by reference (their consumers pass the band, below).
    // (each deps line spells the name twice: the key and the value). 批次标识 BI-2 (R-65): the install deps and the birth deps
    // each read the project's rows with the band (two more calls).
    'lib/http-routes.cjs': sorted(['call:band', 'call:band', 'call:band', 'call:band', 'call:band', 'ref:deps', 'ref:deps', 'ref:deps', 'ref:deps']),
    // readiness's O-6 read (R3).
    'lib/stock-preparation-pilot-readiness.cjs': sorted(['call:band', 'ref:typeof']),
    // the status / board / readiness v3 rows read (R6).
    'lib/stock-preparation-pull-batch-status.cjs': sorted(['call:band', 'ref:status-param', 'ref:typeof']),
    // the definition, computeDryRun's read (R1) and the __internals export.
    'lib/stock-preparation-table-actions.cjs': sorted(['call:band', 'definition', 'export']),
  })
})

test('RS-2 every computeDryRun( call in table-actions passes the lane (the strip, and the probe fold while the switch is on)', () => {
  const code = codeOnly(fs.readFileSync(path.join(LIB, 'stock-preparation-table-actions.cjs'), 'utf8').replace(/\r\n/g, '\n'))
  const calls = []
  const pattern = /(^|[^A-Za-z0-9_$.])computeDryRun\(/g
  let match
  while ((match = pattern.exec(code)) !== null) {
    const at = match.index + match[1].length
    if (/function\s*$/.test(code.slice(Math.max(0, at - 16), at))) continue
    calls.push(callArgsAt(code, at))
  }
  // Batch-refresh step 6a-2 (S6-2, rebaseline (f)): the recovery's in-lease recompute is the fifth.
  assert.equal(calls.length, 5, 'dry-run, reconcile, mvp-persist, apply, recovery')
  for (const args of calls) assert.match(args, /pullBatchLane/)
})

test('RS-3 every route call of the small-lane entries passes pullBatch:, the large planner pullBatchPlanFor, the chunk runner pullBatchGate:', () => {
  const code = codeOnly(fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n'))
  const callsOf = (name) => {
    const out = []
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${name}\\(`, 'g')
    let match
    while ((match = pattern.exec(code)) !== null) {
      const at = match.index + match[1].length
      if (/function\s*$/.test(code.slice(Math.max(0, at - 16), at))) continue
      out.push(callArgsAt(code, at))
    }
    return out
  }
  // Batch-refresh step 6a-2 (S6-2, rebaseline (f)): the recovery entry is the fifth small-lane route call.
  for (const name of ['dryRunStockPreparationAction', 'prepareStockPreparationConfirmationDecisions', 'prepareStockPreparationMvpSnapshot', 'applyStockPreparationAction', 'recoverStockPreparationExecution']) {
    const calls = callsOf(name)
    assert.equal(calls.length, 1, `${name}: one route call`)
    assert.match(calls[0], /pullBatch:/, `${name} passes the lane input`)
  }
  const planCalls = callsOf('planLargeBomBackgroundExpansionJob')
  assert.equal(planCalls.length, 1)
  assert.match(planCalls[0], /pullBatchPlanFor/)
  const chunkCalls = callsOf('runLargeBomCheckpointApplyJobChunk')
  assert.equal(chunkCalls.length, 1)
  assert.match(chunkCalls[0], /pullBatchGate:/)
})

test('RS-4 witness: the scanner reports a band-less call, an unreviewed reference, and accepts a member call with the band', () => {
  assert.deepEqual(classify('const rows = await tableActionInternals.readExistingStockPreparationRows(api, target, projectNo)\n'), ['call:NO_BAND'])
  assert.deepEqual(classify('const rows = await deps.readExistingStockPreparationRows(api, target, projectNo, { pullBatchBand })\n'), ['call:band'])
  assert.deepEqual(classify('// readExistingStockPreparationRows(api) in a comment\nconst s = "readExistingStockPreparationRows(x)"\n'), [], 'comments and strings are not code')
  assert.ok(classify('const reader = readExistingStockPreparationRows\n')[0].startsWith('ref:UNREVIEWED'))
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-reader-scan.test.cjs', tests)
