'use strict'

// Batch-refresh step 4, PR-6 — SOURCE SCANS for the generic configured writers' governed-sheet probe (design §7.1
// rows 17-18, D-21). The behavioural suites (metasheet-multitable-governed-sheet, erp-feedback-governed-sheet,
// pipeline-runner-governed-sheet, the route legs in http-routes) prove the seams they drive; these scans pin EVERY
// seam and EVERY construction site, so a new write method, a reorder, or a factory call that forgets the probe turns
// this red before any behavioural test of it exists. The not-wired rule (namespace objects 501) is only a backstop:
// the wiring guarantee is here.
//
//   SC-G1 the adapter file: exactly THREE `assertTargetSheetWritable(` call sites — one in each of `upsert`,
//         `insertRows`, `updateRows` — each with its own surface literal, and each BEFORE the method's first
//         `fieldMapForObject(` / `ownershipGuard.` / `recordsApi.` / `writeOne(` / `findExistingRecord(` token; the
//         assertion runs the host read-only check and THEN the governed-sheet check.
//   SC-G2 the write-source `test()` calls `assertSheetNotGoverned(` for every configured object with
//         `'c6_target_test'` BEFORE its `return`; `previewUpsert` and `lookupByKey` call neither (reads).
//   SC-G3 erp-feedback `updateRecords`: `assertFeedbackSheetWritable(` after `resolveObjectSheetId(` and before
//         `resolveFields(`, `findRecordByKey(` and the update loop; `createErpFeedbackWriter` hands its probe to
//         `createMultitableFeedbackWriter`.
//   SC-G4 index.cjs builds the probe from the continuation store AND the registry store BEFORE the adapter registry,
//         passes `governedSheetProbe: stockPreparationGovernedSheetProbe` to `createMetaSheetMultitableTargetAdapterFactory(`
//         and `createErpFeedbackWriter(`, and lists it in the route services.
//   SC-G5 http-routes: the services resolution, the write-source construction inside `resolveC6WritePlanInputs`
//         passing `governedSheetProbe`, and BOTH call sites of `resolveC6WritePlanInputs(` passing
//         `governedSheetProbe: stockPreparationGovernedSheetProbe`.
//   SC-G6 every construction of a generic writer in lib/ and index.cjs is one of the wired sites above (a new
//         construction must be wired and added here); `SAFE_WRITE_ERROR_CODES` keeps the refusal codes
//         diagnosable (behavioural: `valuesFreeErrorCode`).
//   SC-G7 `CONTINUATION_SUPPORT_VERSION` is still 0 (R-57 ⑦: the last PR of the D-22 set flips it, not PR-6).
//
// The scanner strips comments and string bodies before matching (offsets preserved), so prose never satisfies a
// scan; string literals (surface tokens) are read from the RAW text at code offsets.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN = path.join(__dirname, '..')
const LIB = path.join(PLUGIN, 'lib')

const tests = []
const test = (name, fn) => tests.push([name, fn])

// Code only: comments and string / template bodies replaced by spaces (offsets preserved, newlines kept).
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

function load(relative) {
  const rawText = fs.readFileSync(path.join(PLUGIN, relative), 'utf8').replace(/\r\n/g, '\n')
  return { raw: rawText, code: codeOnly(rawText) }
}

// The balanced (...) / {...} text starting at the first opener at or after `index`.
function balancedFrom(code, index, opener) {
  const open = code.indexOf(opener, index)
  assert.ok(open >= 0, `an opener ${opener} after ${index}`)
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(' || code[i] === '{' || code[i] === '[') depth += 1
    else if (code[i] === ')' || code[i] === '}' || code[i] === ']') {
      depth -= 1
      if (depth === 0) return { start: open, end: i + 1 }
    }
  }
  throw new Error('unbalanced')
}

// Every CALL of `name(` (not its declaration, not a method of another object).
function callsOf(code, name, span = { start: 0, end: code.length }) {
  const out = []
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$.])${name}\\(`, 'g')
  pattern.lastIndex = span.start
  let match
  while ((match = pattern.exec(code)) !== null) {
    const at = match.index + match[1].length
    if (at >= span.end) break
    const before = code.slice(Math.max(0, at - 16), at)
    if (/function\s*$/.test(before)) continue
    const args = balancedFrom(code, at, '(')
    out.push({ at, args })
  }
  return out
}

// The body span of `function name(` / `async function name(`.
function functionSpan(code, name) {
  const at = code.search(new RegExp(`(async\\s+)?function\\s+${name}\\(`))
  assert.ok(at >= 0, `function ${name} exists`)
  const params = balancedFrom(code, code.indexOf(`${name}(`, at), '(')
  return balancedFrom(code, params.end, '{')
}

// The body span of the object-literal method `async name(` / `name(` inside `within`.
function methodSpan(code, name, within) {
  const pattern = new RegExp(`\\n\\s+(async\\s+)?${name}\\(`, 'g')
  pattern.lastIndex = within.start
  const match = pattern.exec(code)
  assert.ok(match && match.index < within.end, `method ${name} exists in the span`)
  const params = balancedFrom(code, code.indexOf(`${name}(`, match.index), '(')
  const body = balancedFrom(code, params.end, '{')
  assert.ok(body.end <= within.end, `method ${name} lies inside the span`)
  return body
}

// The first offset (>= start, < end) of any of `tokens` in the code text, or Infinity.
function firstOf(code, span, tokens) {
  let best = Infinity
  for (const token of tokens) {
    const at = code.indexOf(token, span.start)
    if (at >= 0 && at < span.end && at < best) best = at
  }
  return best
}

const ADAPTER = load('lib/adapters/metasheet-multitable-target-adapter.cjs')
const ERP = load('lib/erp-feedback.cjs')
const INDEX = load('index.cjs')
const ROUTES = load('lib/http-routes.cjs')

test('SC-G1 the adapter: exactly three assertTargetSheetWritable( call sites — upsert / insertRows / updateRows — each with its own surface, each before the first field-map / ownership / records token; read-only check first, then the governed check', () => {
  const { code, raw } = ADAPTER
  const all = callsOf(code, 'assertTargetSheetWritable')
  assert.equal(all.length, 3, 'three call sites in the whole file')
  const adapterFactory = functionSpan(code, 'createMetaSheetMultitableTargetAdapter')
  const writeSourceFactory = functionSpan(code, 'createMetaSheetMultitableWriteSource')
  const seams = [
    { method: 'upsert', within: adapterFactory, surface: 'pipeline_upsert' },
    { method: 'insertRows', within: writeSourceFactory, surface: 'c6_insert_rows' },
    { method: 'updateRows', within: writeSourceFactory, surface: 'c6_update_rows' },
  ]
  for (const seam of seams) {
    const body = methodSpan(code, seam.method, seam.within)
    const calls = callsOf(code, 'assertTargetSheetWritable', body)
    assert.equal(calls.length, 1, `${seam.method}: one assertion`)
    const argsRaw = raw.slice(calls[0].args.start, calls[0].args.end)
    assert.ok(argsRaw.includes(`surface: '${seam.surface}'`), `${seam.method}: surface ${seam.surface} (${argsRaw})`)
    assert.ok(/\bgovernance\b/.test(code.slice(calls[0].args.start, calls[0].args.end)), `${seam.method}: hands the governance handle`)
    const firstIo = firstOf(code, body, ['fieldMapForObject(', 'ownershipGuard.', 'recordsApi.', 'writeOne(', 'findExistingRecord('])
    assert.ok(firstIo !== Infinity, `${seam.method}: not vacuous — the method does IO`)
    assert.ok(calls[0].at < firstIo, `${seam.method}: the assertion precedes the first field-map / ownership / records token`)
    assert.ok(/^\s*await\s+$/.test(code.slice(calls[0].at - 12, calls[0].at)), `${seam.method}: the assertion is awaited`)
  }
  // The assertion runs the read-only check, then the governed check.
  const assertion = functionSpan(code, 'assertTargetSheetWritable')
  const readOnly = callsOf(code, 'assertNotReadOnlySystemSheet', assertion)
  const governed = callsOf(code, 'assertSheetNotGoverned', assertion)
  assert.equal(readOnly.length, 1)
  assert.equal(governed.length, 1)
  assert.ok(readOnly[0].at < governed[0].at, 'the host read-only refusal keeps its precedence')
  assert.equal(callsOf(code, 'assertNotReadOnlySystemSheet').length, 1, 'the read-only check is reached only through the assertion')
  // The governed check asks the not-wired rule first, then the cached probe answer.
  const check = functionSpan(code, 'assertSheetNotGoverned')
  const wired = callsOf(code, 'assertProbeWiredFor', check)
  const refuse = callsOf(code, 'refuseIfGoverned', check)
  assert.equal(wired.length, 1)
  assert.equal(refuse.length, 1)
  assert.ok(wired[0].at < code.indexOf('.probe(', check.start) && code.indexOf('.probe(', check.start) < refuse[0].at)
})

test('SC-G2 the write-source test() probes every configured object with c6_target_test before it returns; previewUpsert and lookupByKey probe nothing', () => {
  const { code, raw } = ADAPTER
  const writeSourceFactory = functionSpan(code, 'createMetaSheetMultitableWriteSource')
  const testBody = methodSpan(code, 'test', writeSourceFactory)
  const calls = callsOf(code, 'assertSheetNotGoverned', testBody)
  assert.equal(calls.length, 1)
  assert.ok(raw.slice(calls[0].args.start, calls[0].args.end).includes(`surface: 'c6_target_test'`))
  const loop = code.indexOf('for (const objectConfig of Object.values(objects))', testBody.start)
  assert.ok(loop > testBody.start && loop < calls[0].at, 'inside a loop over every configured object')
  const ret = code.indexOf('return {', testBody.start)
  assert.ok(ret > calls[0].at && ret < testBody.end, 'before the capability answer')
  assert.equal(callsOf(code, 'assertSheetNotGoverned').length, 2, 'the assertion and test() — no other caller')
  const adapterFactory = functionSpan(code, 'createMetaSheetMultitableTargetAdapter')
  for (const [name, within] of [['previewUpsert', adapterFactory], ['lookupByKey', writeSourceFactory]]) {
    const body = methodSpan(code, name, within)
    assert.equal(callsOf(code, 'assertTargetSheetWritable', body).length + callsOf(code, 'assertSheetNotGoverned', body).length, 0, `${name} is a read`)
  }
})

test('SC-G3 erp-feedback updateRecords: the probe call after the sheet resolve and before the field resolve, the lookup and the loop; the writer factory hands its probe down', () => {
  const { code } = ERP
  const factory = functionSpan(code, 'createMultitableFeedbackWriter')
  const body = methodSpan(code, 'updateRecords', factory)
  const calls = callsOf(code, 'assertFeedbackSheetWritable', body)
  assert.equal(calls.length, 1)
  assert.equal(callsOf(code, 'assertFeedbackSheetWritable').length, 1, 'one call site in the file')
  const resolve = callsOf(code, 'resolveObjectSheetId', body)
  assert.equal(resolve.length, 1)
  assert.ok(resolve[0].at < calls[0].at, 'after the sheet resolve')
  for (const later of ['resolveFields(', 'findRecordByKey(', 'for (const update of updates)', 'recordsApi.']) {
    const at = code.indexOf(later, calls[0].at)
    assert.ok(at > calls[0].at && at < body.end, `before ${later}`)
    assert.equal(code.slice(body.start, calls[0].at).includes(later), false, `${later} does not run before the probe`)
  }
  const args = code.slice(calls[0].args.start, calls[0].args.end)
  for (const key of ['governedSheetProbe', 'sheetId', 'tenantId', 'objectId']) assert.ok(new RegExp(`\\b${key}\\b`).test(args), `hands ${key}`)
  const writerFactory = functionSpan(code, 'createErpFeedbackWriter')
  const down = callsOf(code, 'createMultitableFeedbackWriter', writerFactory)
  assert.equal(down.length, 1)
  assert.ok(/\bgovernedSheetProbe\b/.test(code.slice(down[0].args.start, down[0].args.end)))
})

test('SC-G4 index.cjs: the probe is built from the continuation store and the registry store before the adapter registry, and is handed to the adapter factory, the feedback writer and the route services', () => {
  const { code } = INDEX
  const built = callsOf(code, 'createStockPreparationGovernedSheetProbe')
  assert.equal(built.length, 1)
  const builtArgs = code.slice(built[0].args.start, built[0].args.end)
  assert.ok(/continuationStore:\s*stockPreparationContinuationStore/.test(builtArgs))
  assert.ok(/projectTargetStore:\s*stockPreparationProjectTargetStore/.test(builtArgs))
  assert.ok(/stockPreparationGovernedSheetProbe\s*=\s*createStockPreparationGovernedSheetProbe\(/.test(code), 'assigned to the module-level handle')
  const registry = code.indexOf('createAdapterRegistry(')
  assert.ok(built[0].at < registry, 'built before the adapter registry')
  for (const factory of ['createMetaSheetMultitableTargetAdapterFactory', 'createErpFeedbackWriter']) {
    const calls = callsOf(code, factory)
    assert.equal(calls.length, 1, `${factory}: one construction`)
    assert.ok(/governedSheetProbe:\s*stockPreparationGovernedSheetProbe\b/.test(code.slice(calls[0].args.start, calls[0].args.end)), `${factory} gets the probe`)
    assert.ok(built[0].at < calls[0].at, `${factory} after the probe is built`)
  }
  // `registeredRoutes.push(...registerIntegrationRoutes({ ... }))` — spread, so located directly.
  const register = code.indexOf('registerIntegrationRoutes({')
  assert.ok(register > 0 && code.indexOf('registerIntegrationRoutes({', register + 1) === -1, 'one route registration')
  const services = balancedFrom(code, register, '(')
  assert.ok(/\bstockPreparationGovernedSheetProbe,/.test(code.slice(services.start, services.end)), 'listed in the route services')
  assert.ok(/governedSheetProbe:\s*Boolean\(stockPreparationGovernedSheetProbe\)/.test(code), 'reported as a capability')
})

test('SC-G5 http-routes: the services resolution, the write-source construction with the probe, and both resolveC6WritePlanInputs( call sites pass it', () => {
  const { code } = ROUTES
  assert.ok(/const stockPreparationGovernedSheetProbe = services\.stockPreparationGovernedSheetProbe \|\| null/.test(code))
  const resolver = functionSpan(code, 'resolveC6WritePlanInputs')
  const definition = code.slice(code.search(/function\s+resolveC6WritePlanInputs\(/), resolver.start)
  assert.ok(/\bgovernedSheetProbe\b/.test(definition), 'the resolver takes the probe')
  const sources = callsOf(code, 'createMetaSheetMultitableWriteSource')
  assert.equal(sources.length, 1, 'one write-source construction in the routes')
  assert.ok(sources[0].at > resolver.start && sources[0].at < resolver.end, 'inside resolveC6WritePlanInputs')
  assert.ok(/\bgovernedSheetProbe\b/.test(code.slice(sources[0].args.start, sources[0].args.end)))
  const sites = callsOf(code, 'resolveC6WritePlanInputs')
  assert.equal(sites.length, 2, 'the dry-run and the apply')
  for (const site of sites) {
    assert.ok(/governedSheetProbe:\s*stockPreparationGovernedSheetProbe\b/.test(code.slice(site.args.start, site.args.end)), 'passes the probe')
  }
})

test('SC-G6 every generic-writer construction in lib/ and index.cjs is a wired site; the refusal codes stay diagnosable in the C6 row loop', () => {
  const files = ['index.cjs', ...fs.readdirSync(LIB).filter((name) => name.endsWith('.cjs')).map((name) => `lib/${name}`), ...fs.readdirSync(path.join(LIB, 'adapters')).filter((name) => name.endsWith('.cjs')).map((name) => `lib/adapters/${name}`)]
  const constructions = { createMetaSheetMultitableTargetAdapter: [], createMetaSheetMultitableTargetAdapterFactory: [], createMetaSheetMultitableWriteSource: [], createMultitableFeedbackWriter: [], createErpFeedbackWriter: [] }
  for (const file of files) {
    const { code } = load(file)
    for (const name of Object.keys(constructions)) {
      for (const call of callsOf(code, name)) constructions[name].push({ file, args: code.slice(call.args.start, call.args.end) })
    }
  }
  const sitesOf = (name) => constructions[name].map((entry) => entry.file).sort()
  assert.deepEqual(sitesOf('createMetaSheetMultitableTargetAdapter'), ['lib/adapters/metasheet-multitable-target-adapter.cjs'], 'only the factory builds an adapter')
  assert.deepEqual(sitesOf('createMetaSheetMultitableTargetAdapterFactory'), ['index.cjs'])
  assert.deepEqual(sitesOf('createMetaSheetMultitableWriteSource'), ['lib/http-routes.cjs'])
  assert.deepEqual(sitesOf('createMultitableFeedbackWriter'), ['lib/erp-feedback.cjs'])
  assert.deepEqual(sitesOf('createErpFeedbackWriter'), ['index.cjs'])
  for (const [name, entries] of Object.entries(constructions)) {
    for (const entry of entries) assert.ok(/\bgovernedSheetProbe\b/.test(entry.args), `${name} in ${entry.file} hands the probe`)
  }
  const { __internals } = require(path.join(LIB, 'external-write-dry-run.cjs'))
  const { GOVERNED_SHEET_WRITE_CODES } = require(path.join(LIB, 'stock-preparation-governed-sheet-probe.cjs'))
  assert.equal(__internals.valuesFreeErrorCode({ code: GOVERNED_SHEET_WRITE_CODES.REFUSED }), GOVERNED_SHEET_WRITE_CODES.REFUSED)
  assert.equal(__internals.valuesFreeErrorCode({ code: GOVERNED_SHEET_WRITE_CODES.PROBE_UNWIRED }), GOVERNED_SHEET_WRITE_CODES.PROBE_UNWIRED)
  assert.equal(__internals.valuesFreeErrorCode({ code: 'SOMETHING_ELSE' }), 'WRITE_FAILED', 'control')
})

test('SC-G7 CONTINUATION_SUPPORT_VERSION is still 0 (the last PR of the D-22 set flips it, not PR-6)', () => {
  const support = require(path.join(LIB, 'stock-preparation-continuation-support.cjs'))
  assert.equal(support.CONTINUATION_SUPPORT_VERSION, 0)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-generic-writer-scan.test.cjs', tests)
