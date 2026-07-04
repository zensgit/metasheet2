'use strict'

// Read-source composition C-R3 — chain runtime executor. Mock adapter/system only; no real network, no
// persistence, no route, no write path. Locks under test (composition design-lock 2026-07-03):
//   L1 approved-only (planner re-validates the resolved bundle: draft/write-shaped/mis-wired step aborts)
//   L2 typed single-scalar handoff (intermediate key DERIVED by the platform, never runtime-supplied)
//   L3 runtime request key-only ({ inputs: { key } } strict allowlist; config-override rejected)
//   L4 per-hop + chain-level fail-closed; downstream hops never run
//   L5 values-free stitched evidence; intermediate resolved value never exposed; data = last hop only
//   L6 read-only (adapter write surface never touched)

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const { validateReadSourceCompositionConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-composition-config.cjs'))
const {
  ReadSourceCompositionRuntimeError,
  executeReadSourceComposition,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'read-source-composition-runtime.cjs'))

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

function resolverConfig({ object, readPath, keyField, source, target }) {
  const result = validateReadSourceConfig({
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object,
    mode: 'resolver_lookup',
    readPath,
    readMethod: 'POST',
    operations: ['read'],
    keyField,
    containerPaths: ['Data.Rows'],
    resolverRule: 'exactly_one',
    fieldMap: [{ source, target }],
  })
  assert.equal(result.valid, true, `read config must validate: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

const ITEM_CONFIG = resolverConfig({
  object: 'material', readPath: '/K3API/Material/GetList', keyField: 'FNumber',
  source: 'FItemID', target: 'internal_id',
})
const BOM_CONFIG = resolverConfig({
  object: 'bom', readPath: '/K3API/BOM/GetList', keyField: 'FItemId',
  source: 'FBOMNumber', target: 'bom_number',
})

function normalizedComposition(overrides = {}) {
  const result = validateReadSourceCompositionConfig({
    version: 1,
    name: 'material-to-bom',
    operations: ['read'],
    steps: [
      { id: 'resolve-item', readSourceConfigId: 'cfg-item' },
      { id: 'resolve-bom', readSourceConfigId: 'cfg-bom', input: { fromStep: 'resolve-item', sourceTarget: 'internal_id', toInput: 'key' } },
    ],
    ...overrides,
  }, {
    readConfigsById: {
      'cfg-item': { status: 'approved', config: ITEM_CONFIG },
      'cfg-bom': { status: 'approved', config: BOM_CONFIG },
    },
  })
  assert.equal(result.valid, true, `composition must validate: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

const STORED_SYSTEM = Object.freeze({
  id: 'sys_1',
  tenantId: 'tenant_1',
  kind: 'erp:k3-wise-webapi',
  role: 'target',
  credentials: Object.freeze({ bearerToken: 'secret-token' }),
  config: Object.freeze({ baseUrl: 'https://k3host.internal' }),
})

function bundle({ itemStatus = 'approved', bomStatus = 'approved', itemSystem = STORED_SYSTEM, bomSystem = STORED_SYSTEM } = {}) {
  return {
    'cfg-item': { status: itemStatus, config: ITEM_CONFIG, system: itemSystem },
    'cfg-bom': { status: bomStatus, config: BOM_CONFIG, system: bomSystem },
  }
}

// Mock adapter that answers per hop by request.object, records outbound reads + the derived keys, and
// records any write attempt (there must be none).
function mockDeps({ itemRows, bomRows, itemThrows, bomThrows } = {}) {
  const state = { reads: [], writes: [] }
  const deps = {
    stepConfigsById: bundle(),
    createAdapter(system) {
      return {
        async read(request) {
          state.reads.push({ object: request.object, filters: request.filters })
          if (request.object === 'material') {
            if (itemThrows) throw itemThrows
            return { raw: { Data: { Rows: itemRows } } }
          }
          if (request.object === 'bom') {
            if (bomThrows) throw bomThrows
            return { raw: { Data: { Rows: bomRows } } }
          }
          throw new Error(`unexpected object ${request.object}`)
        },
        async upsert(input) { state.writes.push(['upsert', input]); return {} },
        async save(input) { state.writes.push(['save', input]); return {} },
      }
    },
  }
  return { deps, state }
}

// The chain must never leak these anywhere in its returned evidence.
const SENTINELS = Object.freeze([
  'ITEM-777', 'BOM-2026-X', 'M-001', 'internal_id', 'bom_number', 'FItemID', 'FBOMNumber',
  'FNumber', 'FItemId', 'k3host', 'secret-token', 'sys_1',
])
function assertValuesFree(subject) {
  const text = JSON.stringify(subject)
  for (const s of SENTINELS) assert.ok(!text.includes(s), `evidence must not leak ${s}: ${text}`)
}

// ── happy path (L1/L2/L5) ────────────────────────────────────────────────────────────────────────
async function testHappyPathTwoHop() {
  const { deps, state } = mockDeps({ itemRows: [{ FItemID: 'ITEM-777' }], bomRows: [{ FBOMNumber: 'BOM-2026-X' }] })
  const out = await executeReadSourceComposition(normalizedComposition(), { inputs: { key: 'M-001' } }, deps)

  // Chain data = ONLY the last hop's single resolver output; the intermediate FItemID is never exposed.
  assert.deepEqual(out.data, { resolver: { target: 'bom_number', value: 'BOM-2026-X' } })
  assert.equal(out.evidence.ok, true)
  assert.equal(out.evidence.failedStep, null)
  assert.deepEqual(out.evidence.steps, [
    { step: 0, ok: true, rule: 'exactly_one' },
    { step: 1, ok: true, rule: 'exactly_one' },
  ])
  // Evidence carries no value; the intermediate ITEM-777 appears nowhere in evidence.
  assertValuesFree(out.evidence)

  // L2: hop 0 filtered on the business key; hop 1 filtered on the DERIVED intermediate key — the runtime
  // request never supplied it.
  assert.equal(state.reads.length, 2)
  assert.deepEqual(state.reads[0], { object: 'material', filters: { FNumber: 'M-001' } })
  assert.deepEqual(state.reads[1], { object: 'bom', filters: { FItemId: 'ITEM-777' } })
  // L6: never wrote.
  assert.equal(state.writes.length, 0)
}

// ── L3: runtime request is key-only ────────────────────────────────────────────────────────────────
async function testRuntimeRequestKeyOnly() {
  const { deps } = mockDeps({ itemRows: [{ FItemID: 'ITEM-777' }], bomRows: [{ FBOMNumber: 'BOM-2026-X' }] })
  const comp = normalizedComposition()
  // A config override, a per-hop key, a target/sheet id, or any extra field is rejected — not dropped.
  for (const bad of [
    { inputs: { key: 'M-001' }, config: { mode: 'resolver_lookup' } },
    { inputs: { key: 'M-001' }, stepConfigsById: {} },
    { inputs: { key: 'M-001', key1: 'ITEM-777' } },
    { inputs: { key: 'M-001', sheetId: 'sheet_x' } },
    'not-an-object',
    { inputs: 'not-an-object' },
  ]) {
    await assert.rejects(
      () => executeReadSourceComposition(comp, bad, deps),
      (e) => e instanceof ReadSourceCompositionRuntimeError,
    )
  }
  // A too-long / control-char first key is rejected downstream by the bounded-key predicate → the chain
  // fails closed at hop 0 (STEP_FAILED), it does not throw.
  const longKey = await executeReadSourceComposition(comp, { inputs: { key: 'k'.repeat(200) } }, deps)
  assert.equal(longKey.evidence.ok, false)
  assert.equal(longKey.evidence.failedStep, 0)
}

// ── L1: approved-only + write-shaped + mis-wired ───────────────────────────────────────────────────
async function testPlanGate() {
  const comp = normalizedComposition()

  // A draft step config aborts the whole chain at plan time — no hop runs.
  const draftDeps = mockDeps({ itemRows: [{ FItemID: 'ITEM-777' }], bomRows: [{ FBOMNumber: 'BOM-2026-X' }] })
  draftDeps.deps.stepConfigsById = bundle({ bomStatus: 'draft' })
  const draftOut = await executeReadSourceComposition(comp, { inputs: { key: 'M-001' } }, draftDeps.deps)
  assert.equal(draftOut.evidence.ok, false)
  assert.equal(draftOut.evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  assert.ok(draftOut.evidence.planErrors.some((e) => e.code === 'READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED'))
  assert.equal(draftDeps.state.reads.length, 0, 'no hop may run when the plan is invalid')
  // planErrors are values-free triples.
  for (const e of draftOut.evidence.planErrors) assert.deepEqual(Object.keys(e).sort(), ['code', 'field', 'reason'])
  assertValuesFree(draftOut.evidence)

  // A missing bundle entry is likewise unapproved → PLAN_INVALID, no hop runs.
  const missingDeps = mockDeps({})
  missingDeps.deps.stepConfigsById = { 'cfg-item': bundle()['cfg-item'] } // cfg-bom absent
  const missingOut = await executeReadSourceComposition(comp, { inputs: { key: 'M-001' } }, missingDeps.deps)
  assert.equal(missingOut.evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
  assert.equal(missingDeps.state.reads.length, 0)

  // A malformed composition config fails closed too.
  const badShape = await executeReadSourceComposition({ steps: 'nope' }, { inputs: { key: 'M-001' } }, mockDeps({}).deps)
  assert.equal(badShape.evidence.errorCode, 'READ_SOURCE_COMPOSITION_PLAN_INVALID')
}

// ── L4: hop-0 failure aborts, hop 1 never runs ─────────────────────────────────────────────────────
async function testHopFailureAborts() {
  // Hop 0 ambiguates (two candidates) → chain aborts, hop 1 never issues an outbound read.
  const { deps, state } = mockDeps({
    itemRows: [{ FItemID: 'ITEM-777' }, { FItemID: 'ITEM-888' }],
    bomRows: [{ FBOMNumber: 'BOM-2026-X' }],
  })
  const out = await executeReadSourceComposition(normalizedComposition(), { inputs: { key: 'M-001' } }, deps)
  assert.equal(out.evidence.ok, false)
  assert.equal(out.evidence.failedStep, 0)
  assert.equal(out.evidence.steps[0].ok, false)
  assert.equal(out.evidence.steps[0].errorCode, 'READ_SOURCE_RESOLVER_AMBIGUOUS')
  assert.deepEqual(out.evidence.steps[1], { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
  assert.equal(out.data, null)
  assert.equal(state.reads.length, 1, 'hop 1 must not run after hop 0 fails')
  assert.equal(state.writes.length, 0)
  assertValuesFree(out.evidence)
}

// ── L4: hop-0 not-found aborts ─────────────────────────────────────────────────────────────────────
async function testHopNotFoundAborts() {
  const { deps, state } = mockDeps({ itemRows: [], bomRows: [{ FBOMNumber: 'BOM-2026-X' }] })
  const out = await executeReadSourceComposition(normalizedComposition(), { inputs: { key: 'M-001' } }, deps)
  assert.equal(out.evidence.ok, false)
  assert.equal(out.evidence.failedStep, 0)
  assert.equal(out.evidence.steps[0].errorCode, 'READ_SOURCE_RESOLVER_NO_MATCH')
  assert.deepEqual(out.evidence.steps[1], { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
  assert.equal(state.reads.length, 1)
}

// ── hop 1 fails after hop 0 resolves ───────────────────────────────────────────────────────────────
async function testSecondHopFailure() {
  const { deps, state } = mockDeps({ itemRows: [{ FItemID: 'ITEM-777' }], bomRows: [] })
  const out = await executeReadSourceComposition(normalizedComposition(), { inputs: { key: 'M-001' } }, deps)
  assert.equal(out.evidence.ok, false)
  assert.equal(out.evidence.failedStep, 1)
  assert.equal(out.evidence.steps[0].ok, true)
  assert.equal(out.evidence.steps[1].errorCode, 'READ_SOURCE_RESOLVER_NO_MATCH')
  assert.equal(out.data, null)
  // Hop 1 DID run (both reads issued), but resolved nothing.
  assert.equal(state.reads.length, 2)
  assert.deepEqual(state.reads[1], { object: 'bom', filters: { FItemId: 'ITEM-777' } })
  assertValuesFree(out.evidence)
}

// ── adapter throw becomes a fail-closed hop, never an escaped error ────────────────────────────────
async function testAdapterThrowFailsClosed() {
  const { deps, state } = mockDeps({ itemThrows: new Error('NETWORK-SECRET-BOOM'), bomRows: [{ FBOMNumber: 'B' }] })
  const out = await executeReadSourceComposition(normalizedComposition(), { inputs: { key: 'M-001' } }, deps)
  assert.equal(out.evidence.ok, false)
  assert.equal(out.evidence.failedStep, 0)
  assert.equal(out.data, null)
  assert.equal(state.reads.length, 1)
  // The thrown error message (a leak channel) never surfaces.
  assert.ok(!JSON.stringify(out).includes('NETWORK-SECRET-BOOM'))
}

// ── server-config inconsistency (system kind mismatch) fails closed ────────────────────────────────
async function testKindMismatchFailsClosed() {
  const wrongSystem = Object.freeze({ ...STORED_SYSTEM, kind: 'erp:some-other-kind' })
  const dep = mockDeps({ itemRows: [{ FItemID: 'ITEM-777' }], bomRows: [{ FBOMNumber: 'B' }] })
  dep.deps.stepConfigsById = bundle({ itemSystem: wrongSystem })
  const out = await executeReadSourceComposition(normalizedComposition(), { inputs: { key: 'M-001' } }, dep.deps)
  assert.equal(out.evidence.ok, false)
  assert.equal(out.evidence.failedStep, 0)
  assert.equal(out.data, null)
}

// ── createAdapter required ─────────────────────────────────────────────────────────────────────────
async function testCreateAdapterRequired() {
  await assert.rejects(
    () => executeReadSourceComposition(normalizedComposition(), { inputs: { key: 'M-001' } }, { stepConfigsById: bundle() }),
    (e) => e instanceof ReadSourceCompositionRuntimeError && e.reason === 'create_adapter_required',
  )
}

// ── internals ──────────────────────────────────────────────────────────────────────────────────────
function testInternals() {
  assert.deepEqual(__internals.normalizeCompositionRuntimeRequest({ inputs: { key: 'M-001' } }), { key: 'M-001' })
  assert.throws(() => __internals.normalizeCompositionRuntimeRequest({ inputs: { key: 'x' }, extra: 1 }),
    (e) => e.reason === 'unexpected_field')
  assert.equal(__internals.stepBundleById({ a: 1 }, 'a'), 1)
  assert.equal(__internals.stepBundleById(new Map([['a', 2]]), 'a'), 2)
  assert.equal(__internals.stepBundleById({ __proto__: { polluted: 9 } }, 'polluted'), null)
}

async function main() {
  await testHappyPathTwoHop()
  await testRuntimeRequestKeyOnly()
  await testPlanGate()
  await testHopFailureAborts()
  await testHopNotFoundAborts()
  await testSecondHopFailure()
  await testAdapterThrowFailsClosed()
  await testKindMismatchFailsClosed()
  await testCreateAdapterRequired()
  testInternals()
  console.log('read-source-composition-runtime.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
