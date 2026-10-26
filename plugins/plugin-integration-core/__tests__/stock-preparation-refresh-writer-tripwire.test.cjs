'use strict'

// Batch-refresh step 4, PR-3a — E-1 LAYER (b): THE WRITER ITSELF (design §7.2; plan-final §2.5 AW-1/AW-2;
// refuter R-5, TD-20). Direct writer calls (`applyStockPreparationPlan`) on a recording records API — no lib,
// no route, no lease: what a caller that skipped every upper check would reach.
//
//   TW-1 writeFenceRequired with NO governance verdict          => 501 governance_absent, zero IO of any kind
//   TW-2 a verdict that was not consulted (`consulted: false`)  => 501 governance_malformed, zero IO
//   TW-3 an unknown verdict / a blank token / not an object     => 501 governance_malformed, zero IO
//   TW-4 `projected` with a plan that carries no projection     => 501 governance_plan_mismatch, zero IO
//   TW-5 `not_governed` with a plan carrying `continuation` or `suspended` => mismatch, zero IO
//   TW-6 a verdict whose token is not the write fence's (forged / stale) => 501 governance_stale, zero IO
//   TW-7 the controls: a consistent not_governed verdict and a consistent projected one WRITE; an unfenced direct
//        call (writeFenceRequired absent) is unchanged; the suspended plan is refused first (layer (b) of
//        #6509, re-run); `assertWriterAdmitsPlan` is exported, zero IO, and refuses a missing fence by name.
//
// Each refusal is distinguishable by its own code and reason, so removing ONLY this check turns its case red
// (the case then WRITES). Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const { DECISIONS, planStockPreparationConflicts } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const writer = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const { StockPreparationApplyWriterError, applyStockPreparationPlan, assertWriterAdmitsPlan } = writer

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TOKEN = 'gen-tw-synthetic-0001'
const CODE = 'STOCK_PREP_REFRESH_GOVERNANCE_UNCONSULTED'

function row(componentSourceId) {
  const pathTokens = [componentSourceId]
  return {
    projectNo: 'P-TW-1',
    idempotencyKey: JSON.stringify({ projectNo: 'P-TW-1', componentSourceId, parentSourceId: null, path: pathTokens }),
    componentSourceId,
    parentSourceId: null,
    path: JSON.stringify(pathTokens),
    depth: 0,
    componentCode: `${componentSourceId}-CODE`,
    componentName: `${componentSourceId} Name`,
    material: 'Steel',
    rawQuantity: 1,
    totalQuantity: 1,
    sourceVersion: 'V1',
  }
}

// A clean ADD plan (not governed: no `continuation`, no `suspended` key — the planner's own output).
function cleanPlan() {
  return planStockPreparationConflicts({ expandedRows: [row('PART-TW-1')], existingRows: [], rowErrors: [], runId: 'run-tw', plannedAt: '2026-10-26T00:00:00.000Z' })
}

// The same plan as a GOVERNED planner would hand it over clean: the values-free stanza, not suspended, no holds.
function projectedPlan() {
  const plan = cleanPlan()
  return { ...plan, suspended: false, holds: [], continuation: { pilot: false, consulted: 0, verdicts: {}, protectedOldRows: 0, suppressedNewRows: 0, candidateRows: 0, holds: { count: 0, confirmable: 0, kinds: {} }, suspended: false } }
}

function recordingApi() {
  const calls = []
  const rows = []
  return {
    calls,
    recordsApi: {
      supportsWriteFence: true,
      async queryRecords(input) { calls.push(['queryRecords', input.sheetId]); return [] },
      async createRecord(input) { calls.push(['createRecord', input.sheetId]); const record = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }; rows.push(record); return record },
      async patchRecord(input) { calls.push(['patchRecord', input.recordId]); throw new Error('unexpected patch') },
    },
  }
}

function fence(calls, generationToken = TOKEN) {
  return {
    generationToken,
    async beforeWrite() { calls.push(['fence']) },
    hostWriteFence() { return { lock: 'integration_stock_prep_project_write_lock', scopeKey: 'spw2:tw', leaseId: 'lease-tw', fencingEpoch: 1, generationToken } },
    async hostFenceRefused() { return Object.assign(new Error('fenced'), { code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', status: 409 }) },
    async reassert() { calls.push(['reassert']) },
    async withHostWrite(fn) { calls.push(['hostWrite']); return fn() },
  }
}

function verdict(overrides = {}) {
  return { consulted: true, verdict: 'not_governed', generationToken: TOKEN, ...overrides }
}

async function refusedWithZeroIo(input, reason) {
  const api = recordingApi()
  await assert.rejects(
    applyStockPreparationPlan({ permission: 'write', target: { sheetId: 'sheet_tw' }, recordsApi: api.recordsApi, writeFence: fence(api.calls), writeFenceRequired: true, ...input }),
    (error) => {
      assert.equal(error.status, 501, `${reason}: status`)
      assert.equal(error.code, CODE, `${reason}: code`)
      assert.deepEqual(error.details, { reason, partial: false })
      return true
    },
  )
  assert.deepEqual(api.calls, [], `${reason}: zero records-API calls and no fence CAS`)
}

test('TW-1 writeFenceRequired with no governance verdict: 501 governance_absent before any IO', async () => {
  await refusedWithZeroIo({ plan: cleanPlan() }, 'governance_absent')
  await refusedWithZeroIo({ plan: cleanPlan(), governance: null }, 'governance_absent')
})

test('TW-2 a verdict that was not consulted: 501 governance_malformed before any IO', async () => {
  await refusedWithZeroIo({ plan: cleanPlan(), governance: verdict({ consulted: false }) }, 'governance_malformed')
  await refusedWithZeroIo({ plan: cleanPlan(), governance: verdict({ consulted: 'true' }) }, 'governance_malformed')
})

test('TW-3 an unknown verdict, a blank / missing token, a non-object: 501 governance_malformed before any IO', async () => {
  for (const governance of [verdict({ verdict: 'governed' }), verdict({ verdict: undefined }), verdict({ generationToken: ' ' }), verdict({ generationToken: null }), 'not_governed', ['not_governed']]) {
    await refusedWithZeroIo({ plan: cleanPlan(), governance }, 'governance_malformed')
  }
})

test('TW-4 `projected` with a plan that carries no projection (a lane that consulted but planned without it): 501 governance_plan_mismatch before any IO', async () => {
  await refusedWithZeroIo({ plan: cleanPlan(), governance: verdict({ verdict: 'projected' }) }, 'governance_plan_mismatch')
  await refusedWithZeroIo({ plan: { ...projectedPlan(), continuation: 'yes' }, governance: verdict({ verdict: 'projected' }) }, 'governance_plan_mismatch')
})

test('TW-5 `not_governed` with a plan carrying the projection stanza or a `suspended` key: 501 governance_plan_mismatch before any IO', async () => {
  await refusedWithZeroIo({ plan: projectedPlan(), governance: verdict() }, 'governance_plan_mismatch')
  await refusedWithZeroIo({ plan: { ...cleanPlan(), suspended: false }, governance: verdict() }, 'governance_plan_mismatch')
})

test('TW-6 a verdict whose generation token is not the write fence\'s (forged / stale): 501 governance_stale before any IO', async () => {
  await refusedWithZeroIo({ plan: cleanPlan(), governance: verdict({ generationToken: 'gen-tw-other' }) }, 'governance_stale')
  await refusedWithZeroIo({ plan: projectedPlan(), governance: verdict({ verdict: 'projected', generationToken: 'gen-tw-other' }) }, 'governance_stale')
})

test('TW-7 controls: a consistent verdict writes; an unfenced direct call is unchanged; a suspended plan is refused first (layer (b), zero IO); assertWriterAdmitsPlan is exported, zero IO, and refuses a missing fence by name', async () => {
  for (const [plan, governance] of [[cleanPlan(), verdict()], [projectedPlan(), verdict({ verdict: 'projected' })]]) {
    const api = recordingApi()
    const result = await applyStockPreparationPlan({ permission: 'write', plan, target: { sheetId: 'sheet_tw' }, recordsApi: api.recordsApi, writeFence: fence(api.calls), writeFenceRequired: true, governance })
    assert.equal(result.status, 'succeeded')
    assert.equal(result.counts.created, 1)
    assert.equal(api.calls.filter(([op]) => op === 'createRecord').length, 1, `${governance.verdict}: the consistent verdict writes`)
  }
  // A direct call without writeFenceRequired (writer tests, fakes) never asks for a verdict.
  const unfenced = recordingApi()
  const plain = await applyStockPreparationPlan({ permission: 'write', plan: cleanPlan(), target: { sheetId: 'sheet_tw' }, recordsApi: unfenced.recordsApi })
  assert.equal(plain.counts.created, 1)
  // A suspended plan: the #6509 refusal fires FIRST (whatever the verdict), zero IO.
  for (const governance of [undefined, verdict({ verdict: 'projected' })]) {
    const api = recordingApi()
    await assert.rejects(
      applyStockPreparationPlan({ permission: 'write', plan: { ...projectedPlan(), suspended: true }, target: { sheetId: 'sheet_tw' }, recordsApi: api.recordsApi, writeFence: fence(api.calls), writeFenceRequired: true, ...(governance ? { governance } : {}) }),
      (error) => error instanceof StockPreparationApplyWriterError && error.details.code === 'plan_suspended',
    )
    assert.deepEqual(api.calls, [])
  }
  // The exported pre-check (the large chunk runs it before `running`): same refusals, a missing fence named.
  assert.equal(typeof assertWriterAdmitsPlan, 'function')
  assert.throws(() => assertWriterAdmitsPlan({ plan: cleanPlan(), governance: verdict(), writeFence: null }), (error) => error.code === CODE && error.details.reason === 'governance_malformed')
  assert.throws(() => assertWriterAdmitsPlan({ plan: cleanPlan(), governance: undefined, writeFence: fence([]) }), (error) => error.code === CODE && error.details.reason === 'governance_absent')
  assert.throws(() => assertWriterAdmitsPlan({ plan: { ...cleanPlan(), suspended: true }, governance: verdict(), writeFence: fence([]) }), (error) => error instanceof StockPreparationApplyWriterError && error.details.code === 'plan_suspended')
  assert.ok(assertWriterAdmitsPlan({ plan: cleanPlan(), governance: verdict(), writeFence: fence([]) }).decisions.some((decision) => decision.decision === DECISIONS.ADD))
  const text = JSON.stringify(Object.keys(writer))
  assert.ok(text.includes('assertWriterAdmitsPlan'))
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-writer-tripwire.test.cjs', tests)
