'use strict'

// Batch-refresh step 4, PR-6 — the ERP FEEDBACK WRITER refuses a GOVERNED stock-prep sheet (lib/erp-feedback.cjs;
// design §7.1 row 18, D-21; F-6). The writer writes whatever sheet the provisioning resolves for the configured
// (projectId, objectId); a pipeline whose feedback options name a stock-prep project object would write its machine
// columns after every run. Driven with a RECORDING provisioning + records API and a scripted or REAL probe:
//
//   E-01 governed: `updateRecords` throws the 409 (surface erp_feedback) after the sheet resolve and BEFORE the field
//        resolve, any lookup and any write; the probe got the RESOLVED sheet and the input tenant. `writeBack`
//        reports `{ ok:false, skipped:false, reason: ERP_FEEDBACK_GOVERNED_SHEET_REFUSED, code }`, nothing written;
//        under `failOnError` it throws the 409. The REAL probe over a real open hold refuses too.
//   E-02 the probe throws 503: `reason: ERP_FEEDBACK_GOVERNANCE_UNREADABLE` with the code, nothing written.
//   E-03 BYTE-IDENTITY: not governed (scripted and REAL probe) — the recorded calls and the result deep-equal a writer
//        without a probe; one probe per writeBack.
//   E-04 NOT WIRED: no probe + a RESOLVED object id in the stock-prep namespace (a per-project sheet, the env main
//        sheet) => 501 PROBE_UNWIRED before the field resolve and any records IO, reported as
//        ERP_FEEDBACK_GOVERNED_SHEET_REFUSED; no probe + `standard_materials` => unchanged.
//   E-05 the short-circuits that resolve no sheet (DISABLED / NO_ITEMS / TARGET_MISSING / a custom staging writer)
//        never call the probe; a provisioning that resolves NO sheet is not probed (nothing can be governed; the
//        host refuses a write to no sheet exactly as before).
//   E-06 the runner's projection: a refusal reaches the run details as `reason` (the projection's fixed field set
//        drops `code`); under failOnError the runner's own catch records ERP_FEEDBACK_THROWN with the code inside the
//        message.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const { createErpFeedbackWriter, createMultitableFeedbackWriter } = require(path.join(LIB, 'erp-feedback.cjs'))
const probeLib = require(path.join(LIB, 'stock-preparation-governed-sheet-probe.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const registryModule = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const ownBase = require(path.join(LIB, 'stock-preparation-own-base.cjs'))
const refreshKit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))

const { GOVERNED_SHEET_WRITE_CODES: CODES, StockPreparationGovernedSheetWriteError } = probeLib

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_efg_a'
const PROJECT_ID = `${TENANT}:integration-core`
const PROJECT_SHEET_OBJECT = ownBase.deriveStockPreparationProjectSheetObjectId(TENANT, 'PRJ-EFG')
const SHEET_FOR = (objectId) => `sheet_for_${objectId}`

const NOT_GOVERNED = Object.freeze({ ok: true, governed: false, reason: null, registry: Object.freeze({ present: false }), marks: Object.freeze({ continuation: 0, openHold: 0, state: 0, execution: 0 }) })
const GOVERNED = Object.freeze({ ok: true, governed: true, reason: 'pilot', registry: Object.freeze({ present: true, pilot: true, tenantMatches: true }), marks: Object.freeze({ continuation: 0, openHold: 0, state: 0, execution: 0 }) })

const cleanRecords = [
  { sourceRecord: { id: 'src_1' }, targetRecord: { _integration_idempotency_key: 'idem_1', FNumber: 'EFG-001' } },
  { sourceRecord: { id: 'src_2' }, targetRecord: { _integration_idempotency_key: 'idem_2', FNumber: 'EFG-002' } },
]
const writeResult = { results: [{ key: 'idem_1', externalId: 'ext_1' }, { key: 'idem_2', externalId: 'ext_2' }] }

function scriptedProbe(answerFor = () => NOT_GOVERNED) {
  const calls = []
  return {
    calls,
    async probe() { throw new Error('the feedback seam uses assertSheetWritable()') },
    async assertSheetWritable(input) {
      calls.push({ ...input })
      const answer = answerFor(input)
      if (answer instanceof Error) throw answer
      if (answer.governed) throw probeLib.governedSheetRefusal({ surface: input.surface, reason: answer.reason, objectId: input.objectId })
      return answer
    },
  }
}

function realProbeWorld() {
  const clock = refreshKit.createClock()
  const db = refreshKit.createFakeRefreshDb({ clock })
  const continuationStore = storeModule.createStockPreparationContinuationStore({ db, now: clock.now })
  const projectTargetStore = registryModule.createStockPreparationProjectTargetStore({ db })
  return { db, continuationStore, probe: probeLib.createStockPreparationGovernedSheetProbe({ continuationStore, projectTargetStore }) }
}

function createContext({ existingKeys = ['idem_1'], resolveNoSheet = false } = {}) {
  const calls = []
  const rows = existingKeys.map((key, index) => ({ id: `rec_seed_${index}`, data: { fld__integration_idempotency_key: key } }))
  return {
    calls,
    rows,
    context: {
      api: {
        multitable: {
          provisioning: {
            async findObjectSheet(input) {
              calls.push(['findObjectSheet', input])
              return resolveNoSheet ? null : { id: SHEET_FOR(input.objectId), baseId: null, name: 'Sheet' }
            },
            async resolveFieldIds(input) {
              calls.push(['resolveFieldIds', input])
              return Object.fromEntries(input.fieldIds.map((fieldId) => [fieldId, `fld_${fieldId}`]))
            },
          },
          records: {
            async queryRecords(input) {
              calls.push(['queryRecords', input])
              return rows.filter((row) => row.data.fld__integration_idempotency_key === input.filters.fld__integration_idempotency_key)
            },
            async patchRecord(input) {
              calls.push(['patchRecord', input])
              return { id: input.recordId, version: 2 }
            },
            async createRecord(input) {
              calls.push(['createRecord', input])
              return { id: `rec_new_${calls.length}`, version: 1 }
            },
          },
        },
      },
    },
  }
}

function pipelineFor(objectId, extra = {}) {
  return { id: 'pipe_efg', projectId: PROJECT_ID, targetObject: 'BD_MATERIAL', options: { erpFeedback: { objectId, keyField: '_integration_idempotency_key', ...extra } } }
}

function writeBackInput(objectId, extra = {}) {
  return { tenantId: TENANT, workspaceId: null, runId: 'run_efg', pipeline: pipelineFor(objectId, extra), cleanRecords, writeResult }
}

const writes = (calls) => calls.filter(([name]) => name === 'createRecord' || name === 'patchRecord')
const afterResolve = (calls) => calls.filter(([name]) => name !== 'findObjectSheet')

async function expectError(promise, { status, code, surface }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a throw (${code})`)
  if (status !== undefined) assert.equal(caught.status, status, caught.message)
  if (code !== undefined) assert.equal(caught.code, code, caught.message)
  if (surface !== undefined) assert.equal(caught.details && caught.details.surface, surface)
  return caught
}

const FIXED_CLOCK = () => '2026-10-26T00:00:00.000Z'

// ── E-01 / E-02 / E-03 ───────────────────────────────────────────────────────────────────────────

test('E-01 governed: updateRecords throws the 409 after the sheet resolve and before the field resolve / any lookup / any write; writeBack reports ERP_FEEDBACK_GOVERNED_SHEET_REFUSED with the code; failOnError throws; the REAL probe refuses too', async () => {
  const { context, calls } = createContext()
  const probe = scriptedProbe(() => GOVERNED)
  const writer = createMultitableFeedbackWriter({ context, governedSheetProbe: probe })
  const error = await expectError(writer.updateRecords({ tenantId: TENANT, projectId: PROJECT_ID, objectId: PROJECT_SHEET_OBJECT, keyField: '_integration_idempotency_key', updates: [{ key: 'idem_1', fields: { erpSyncStatus: 'synced' } }] }), { status: 409, code: CODES.REFUSED, surface: 'erp_feedback' })
  assert.ok(error instanceof StockPreparationGovernedSheetWriteError)
  assert.deepEqual(calls.map(([name]) => name), ['findObjectSheet'], 'only the sheet resolve ran')
  assert.deepEqual(probe.calls, [{ sheetId: SHEET_FOR(PROJECT_SHEET_OBJECT), tenantId: TENANT, surface: 'erp_feedback', objectId: PROJECT_SHEET_OBJECT }], 'the RESOLVED sheet and the input tenant')

  const feedback = createErpFeedbackWriter({ context, clock: FIXED_CLOCK, governedSheetProbe: probe })
  const result = await feedback.writeBack(writeBackInput(PROJECT_SHEET_OBJECT))
  assert.equal(result.ok, false)
  assert.equal(result.skipped, false)
  assert.equal(result.reason, 'ERP_FEEDBACK_GOVERNED_SHEET_REFUSED')
  assert.equal(result.code, CODES.REFUSED)
  assert.equal(result.objectId, PROJECT_SHEET_OBJECT)
  assert.equal(result.items.length, 2)
  assert.equal(writes(calls).length, 0, 'nothing written')
  await expectError(feedback.writeBack(writeBackInput(PROJECT_SHEET_OBJECT, { failOnError: true })), { status: 409, code: CODES.REFUSED })
  assert.equal(writes(calls).length, 0)

  // The REAL probe: a registry pilot row on the resolved sheet.
  const world = realProbeWorld()
  await world.db.insertOne(refreshKit.REGISTRY_TABLE, refreshKit.registryRow({ tenantId: TENANT, projectNo: 'PRJ-EFG', sheetId: SHEET_FOR(PROJECT_SHEET_OBJECT), objectId: PROJECT_SHEET_OBJECT, pilot: true }))
  const real = createContext()
  const realResult = await createErpFeedbackWriter({ context: real.context, clock: FIXED_CLOCK, governedSheetProbe: world.probe }).writeBack(writeBackInput(PROJECT_SHEET_OBJECT))
  assert.deepEqual([realResult.ok, realResult.reason, realResult.code], [false, 'ERP_FEEDBACK_GOVERNED_SHEET_REFUSED', CODES.REFUSED])
  assert.deepEqual(afterResolve(real.calls), [], 'no field resolve, no lookup, no write')
})

test('E-02 the probe throws 503: reason ERP_FEEDBACK_GOVERNANCE_UNREADABLE with the code, nothing written; a 501 store-unavailable reads the same way', async () => {
  for (const failure of [
    new StockPreparationGovernedSheetWriteError(503, CODES.STORE_FAILED, 'unreadable', { store: 'continuation', operation: 'read_sheet_governance_marks', partial: false }),
    new StockPreparationGovernedSheetWriteError(501, CODES.STORE_UNAVAILABLE, 'not wired', { reason: 'continuation_store', partial: false }),
  ]) {
    const { context, calls } = createContext()
    const feedback = createErpFeedbackWriter({ context, clock: FIXED_CLOCK, governedSheetProbe: scriptedProbe(() => failure) })
    const result = await feedback.writeBack(writeBackInput('standard_materials'))
    assert.deepEqual([result.ok, result.reason, result.code], [false, 'ERP_FEEDBACK_GOVERNANCE_UNREADABLE', failure.code])
    assert.deepEqual(afterResolve(calls), [])
  }
})

test('E-03 BYTE-IDENTITY for a sheet that is not governed: the recorded calls and the result deep-equal a writer without a probe (scripted and REAL probe); one probe per writeBack', async () => {
  async function run(governedSheetProbe) {
    const { context, calls } = createContext()
    const result = await createErpFeedbackWriter({ context, clock: FIXED_CLOCK, governedSheetProbe }).writeBack(writeBackInput('standard_materials'))
    return { calls, result }
  }
  const legacy = await run(undefined)
  const scripted = scriptedProbe()
  const probed = await run(scripted)
  const world = realProbeWorld()
  const real = await run(world.probe)
  for (const other of [probed, real]) {
    assert.deepEqual(other.calls, legacy.calls)
    assert.deepEqual(other.result, legacy.result)
  }
  assert.equal(legacy.result.ok, true)
  assert.equal(legacy.result.result.written, 2)
  assert.equal(writes(legacy.calls).length, 2, 'not vacuous: one patch and one create')
  assert.equal(scripted.calls.length, 1)
  assert.deepEqual(world.db.log.map(([method]) => method), ['selectOne', 'countRows', 'countRows', 'countRows', 'countRows'])
})

// ── E-04 / E-05 / E-06 ───────────────────────────────────────────────────────────────────────────

test('E-04 NOT WIRED: no probe + a resolved object id in the stock-prep namespace => 501 PROBE_UNWIRED before the field resolve and any records IO (reported as GOVERNED_SHEET_REFUSED); no probe + standard_materials => unchanged', async () => {
  for (const objectId of [PROJECT_SHEET_OBJECT, 'plm_stock_preparation_main']) {
    const { context, calls } = createContext()
    const writer = createMultitableFeedbackWriter({ context })
    const error = await expectError(writer.updateRecords({ tenantId: TENANT, projectId: PROJECT_ID, objectId, keyField: '_integration_idempotency_key', updates: [{ key: 'idem_1', fields: { erpSyncStatus: 'synced' } }] }), { status: 501, code: CODES.PROBE_UNWIRED, surface: 'erp_feedback' })
    assert.equal(error.details.object, objectId)
    assert.deepEqual(afterResolve(calls), [])
    const result = await createErpFeedbackWriter({ context, clock: FIXED_CLOCK }).writeBack(writeBackInput(objectId))
    assert.deepEqual([result.ok, result.reason, result.code], [false, 'ERP_FEEDBACK_GOVERNED_SHEET_REFUSED', CODES.PROBE_UNWIRED])
    assert.deepEqual(afterResolve(calls), [])
  }
  const { context, calls } = createContext()
  const plain = await createErpFeedbackWriter({ context, clock: FIXED_CLOCK }).writeBack(writeBackInput('standard_materials'))
  assert.equal(plain.ok, true)
  assert.equal(writes(calls).length, 2)
})

test('E-05 short-circuits that resolve no sheet never call the probe; a provisioning that resolves NO sheet is not probed', async () => {
  const probe = scriptedProbe(() => GOVERNED)
  const { context, calls } = createContext()
  const feedback = createErpFeedbackWriter({ context, clock: FIXED_CLOCK, governedSheetProbe: probe })
  assert.equal((await feedback.writeBack(writeBackInput(PROJECT_SHEET_OBJECT, { enabled: false }))).reason, 'ERP_FEEDBACK_DISABLED')
  assert.equal((await feedback.writeBack({ ...writeBackInput(PROJECT_SHEET_OBJECT), writeResult: { results: [] } })).reason, 'ERP_FEEDBACK_NO_ITEMS')
  assert.equal((await feedback.writeBack({ ...writeBackInput(PROJECT_SHEET_OBJECT), pipeline: { id: 'p', options: { erpFeedback: { objectId: PROJECT_SHEET_OBJECT } } } })).reason, 'ERP_FEEDBACK_TARGET_MISSING')
  assert.equal(probe.calls.length, 0)
  assert.deepEqual(calls, [])
  // A custom staging writer (no multitable writer is built): the probe is not the custom writer's business.
  const staged = []
  const custom = createErpFeedbackWriter({ clock: FIXED_CLOCK, governedSheetProbe: probe, stagingWriter: { async updateRecords(input) { staged.push(input); return { written: input.updates.length } } } })
  assert.equal((await custom.writeBack(writeBackInput(PROJECT_SHEET_OBJECT))).ok, true)
  assert.equal(staged.length, 1)
  assert.equal(probe.calls.length, 0)
  // No sheet resolved: not probed; the writer behaves exactly as without a probe (the host refuses the sheetless write).
  const none = createContext({ resolveNoSheet: true })
  const noneLegacy = createContext({ resolveNoSheet: true })
  const probedNone = await createErpFeedbackWriter({ context: none.context, clock: FIXED_CLOCK, governedSheetProbe: probe }).writeBack(writeBackInput('standard_materials'))
  const legacyNone = await createErpFeedbackWriter({ context: noneLegacy.context, clock: FIXED_CLOCK }).writeBack(writeBackInput('standard_materials'))
  assert.deepEqual(probedNone, legacyNone)
  assert.deepEqual(none.calls, noneLegacy.calls)
  assert.equal(probe.calls.length, 0)
})

test('E-06 the runner projection: the refusal reaches the run details as `reason`; under failOnError the runner records ERP_FEEDBACK_THROWN with the code inside the message', async () => {
  const { createPipelineRunner } = require(path.join(LIB, 'pipeline-runner.cjs'))
  assert.equal(typeof createPipelineRunner, 'function')
  // The projection is the runner's `writeErpFeedback` (pipeline-runner.cjs): it keeps a FIXED field set — `reason`
  // survives, `code` does not. Exercised on the writer's own answer here; the end-to-end leg is pipeline-runner R-04.
  const { context } = createContext()
  const feedback = createErpFeedbackWriter({ context, clock: FIXED_CLOCK, governedSheetProbe: scriptedProbe(() => GOVERNED) })
  const answer = await feedback.writeBack(writeBackInput(PROJECT_SHEET_OBJECT))
  assert.equal(answer.reason, 'ERP_FEEDBACK_GOVERNED_SHEET_REFUSED')
  const thrown = await expectError(feedback.writeBack(writeBackInput(PROJECT_SHEET_OBJECT, { failOnError: true })), { code: CODES.REFUSED })
  assert.ok(thrown.message.includes(CODES.REFUSED), 'the code survives in the message the runner keeps')
  assert.ok(thrown.message.includes(PROJECT_SHEET_OBJECT), 'and the object id')
  assert.equal(thrown.message.includes(SHEET_FOR(PROJECT_SHEET_OBJECT)), false, 'never the sheet id')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('erp-feedback-governed-sheet.test.cjs', tests)
