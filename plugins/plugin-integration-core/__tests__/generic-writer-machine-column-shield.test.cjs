'use strict'

// D2 (switch-on precondition for the YiDa issue-confirm write-back, register R-96): the three operator-configured
// GENERIC writers may not erase a machine write-back column (MACHINE_WRITEBACK_FIELD_IDS, today `issueConfirmDate`,
// lib/stock-preparation-templates.cjs) on a REGISTERED but NOT governed stock-prep project sheet. Governed sheets are
// already refused (PR-6); a registered sheet that is not governed stays writable (GV-1,
// lib/stock-preparation-refresh-governance.cjs:52-54), so before this change the generic writers could
//   - send the machine column in their patch (a direct overwrite), and
//   - patch a row without `expectedVersion`, so the host's whole-object UPDATE (records.ts SELECT, JS merge, UPDATE)
//     could put back a row read before a concurrent write-back committed (the race).
// The fix, per site, applies ONLY to a stock-prep target — an object key in the stock-prep namespace, or a sheet the
// governed-sheet probe reports as REGISTERED (`registry.present`) — and leaves every other target byte-identical:
//   (b) the machine column is stripped from the UPDATE payload (the logical id, the configured / provisioned physical id);
//   (a) the update carries `expectedVersion` (the version read), and a version conflict is a RETRYABLE row failure.
//
//   M-01..M-03  pipeline upsert   (lib/adapters/metasheet-multitable-target-adapter.cjs, writeOne update branch)
//   C-01..C-03  C6 updateRows     (same file) + the C6 row-error vocabulary (lib/external-write-dry-run.cjs)
//   E-01..E-03  ERP feedback      (lib/erp-feedback.cjs, updateRecords) + writeBack's reason token
// Values-free: every id below is synthetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const adapterLib = require(path.join(LIB, 'adapters', 'metasheet-multitable-target-adapter.cjs'))
const { createErpFeedbackWriter, createMultitableFeedbackWriter } = require(path.join(LIB, 'erp-feedback.cjs'))
const { __internals: c6Internals } = require(path.join(LIB, 'external-write-dry-run.cjs'))
const { MACHINE_WRITEBACK_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const ownBase = require(path.join(LIB, 'stock-preparation-own-base.cjs'))

const { createMetaSheetMultitableTargetAdapter, createMetaSheetMultitableWriteSource } = adapterLib

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_d2w_a'
const PROJECT_ID = `${TENANT}:integration-core`
const SHEET = 'sheet_d2w_target'
const NAMESPACE_OBJECT = ownBase.deriveStockPreparationProjectSheetObjectId(TENANT, 'PRJ-D2W')
const MACHINE = MACHINE_WRITEBACK_FIELD_IDS[0]
const CONFLICT_CODE = 'METASHEET_MULTITABLE_VERSION_CONFLICT'
const ERP_CONFLICT_REASON = 'ERP_FEEDBACK_VERSION_CONFLICT'
const SEEDED_DATE = '2026-11-01'
const RACED_DATE = '2026-11-02'

const MARKS = Object.freeze({ continuation: 0, openHold: 0, state: 0, execution: 0 })
const REGISTERED = Object.freeze({ ok: true, governed: false, reason: null, registry: Object.freeze({ present: true, pilot: false, tenantMatches: true }), marks: MARKS })
const NOT_REGISTERED = Object.freeze({ ok: true, governed: false, reason: null, registry: Object.freeze({ present: false }), marks: MARKS })

// The physical ids of the free-key config (the S6 reviewer config shape: object key `main`, a fieldIdMap, no projectId).
const PHYS = Object.freeze({ idempotencyKey: 'fld_d2w_key', material: 'fld_d2w_mat', [MACHINE]: 'fld_d2w_icd' })

function probeAnswering(answer) {
  const calls = []
  return {
    calls,
    async probe(input) { calls.push(['probe', { ...input }]); return answer },
    async assertSheetWritable(input) { calls.push(['assertSheetWritable', { ...input }]); return answer },
  }
}

// A records API that behaves like the host's plugin SDK on the points that matter here: query returns
// { id, version, data }; patch honours `expectedVersion` (VERSION_CONFLICT, the host's code) and merges `changes`.
// `between` runs right before a patch is applied: a concurrent writer that commits between the read and the update.
function createRecords({ rows = [], between = null } = {}) {
  const store = rows.map((row) => ({ ...row, data: { ...row.data } }))
  const calls = []
  let hook = between
  const records = {
    async queryRecords(input) {
      calls.push(['queryRecords', JSON.parse(JSON.stringify(input))])
      return store
        .filter((row) => row.sheetId === input.sheetId && Object.entries(input.filters || {}).every(([field, value]) => row.data[field] === value))
        .slice(0, input.limit || 1000)
        .map((row) => ({ id: row.id, version: row.version, data: { ...row.data } }))
    },
    async createRecord(input) {
      calls.push(['createRecord', JSON.parse(JSON.stringify(input))])
      const row = { id: `rec_${store.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
      store.push(row)
      return { id: row.id, version: row.version, data: { ...row.data } }
    },
    async patchRecord(input) {
      calls.push(['patchRecord', JSON.parse(JSON.stringify(input))])
      const row = store.find((item) => item.id === input.recordId && item.sheetId === input.sheetId)
      if (!row) throw new Error('record not found')
      if (hook) { const run = hook; hook = null; run(row) }
      if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
        const conflict = new Error('Record version conflict')
        conflict.name = 'MultitableRecordVersionConflictError'
        conflict.code = 'VERSION_CONFLICT'
        throw conflict
      }
      row.version += 1
      row.data = { ...row.data, ...input.changes }
      return { id: row.id, version: row.version, data: { ...row.data } }
    },
  }
  return { records, calls, store }
}

// The concurrent write-back: writes the date and bumps the version (what records.patchRecord does on the host).
const raceWriteback = (row) => { row.data = { ...row.data, [PHYS[MACHINE]]: RACED_DATE }; row.version += 1 }

const seededRow = () => ({ id: 'rec_seed', sheetId: SHEET, version: 3, data: { [PHYS.idempotencyKey]: 'idem-1', [PHYS.material]: 'M-OLD', [PHYS[MACHINE]]: SEEDED_DATE } })

function freeKeySystem(objectKey = 'main', extra = {}) {
  return {
    id: 'es_d2w', tenantId: TENANT, name: 'D2 target', kind: 'metasheet:multitable', role: 'target',
    config: {
      objects: {
        [objectKey]: {
          sheetId: SHEET,
          keyFields: ['idempotencyKey'],
          mode: 'upsert',
          fieldIdMap: { ...PHYS },
          fields: [{ name: 'idempotencyKey' }, { name: 'material' }, { name: MACHINE }],
          ...extra,
        },
      },
    },
  }
}

const QUIET = { warn() {} }
const patchesOf = (calls) => calls.filter(([name]) => name === 'patchRecord').map(([, input]) => input)

// ── pipeline upsert ─────────────────────────────────────────────────────────────────────────────────

test('M-01 pipeline upsert on a REGISTERED (not governed) sheet, free key `main`: the machine column is not written (logical + physical), the other fields are, and the patch carries the version read', async () => {
  const { records, calls, store } = createRecords({ rows: [seededRow()] })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: freeKeySystem(), context: { api: { multitable: { records } }, logger: QUIET }, governedSheetProbe: probeAnswering(REGISTERED) })
  const result = await adapter.upsert({ object: 'main', records: [{ idempotencyKey: 'idem-1', material: 'M-NEW', [MACHINE]: '' }] })
  assert.equal(result.written, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(result.results.map((entry) => entry.status), ['updated'])
  const [patch] = patchesOf(calls)
  assert.ok(patch, 'one patch')
  assert.equal(Object.prototype.hasOwnProperty.call(patch.changes, PHYS[MACHINE]), false, 'the physical machine column is not in the patch')
  assert.equal(Object.prototype.hasOwnProperty.call(patch.changes, MACHINE), false, 'nor the logical one')
  assert.equal(patch.changes[PHYS.material], 'M-NEW', 'the other fields still write')
  assert.equal(patch.expectedVersion, 3, 'the version read rides the patch')
  assert.equal(store[0].data[PHYS[MACHINE]], SEEDED_DATE, 'the date survives')
  assert.equal(store[0].data[PHYS.material], 'M-NEW')
})

test('M-01b a stock-prep NAMESPACE object key with a projectId: the PROVISIONED physical id of the machine column is stripped even when the config does not list it and the payload names it raw', async () => {
  const resolved = (objectId, fieldId) => `fld_${objectId}_${fieldId}`
  const physicalMachine = resolved(NAMESPACE_OBJECT, MACHINE)
  const physicalKey = resolved(NAMESPACE_OBJECT, 'idempotencyKey')
  const row = { id: 'rec_ns', sheetId: SHEET, version: 7, data: { [physicalKey]: 'idem-ns', [physicalMachine]: SEEDED_DATE, fld_other: 'x' } }
  const { records, calls, store } = createRecords({ rows: [row] })
  const provisioning = { async resolveFieldIds(input) { return Object.fromEntries(input.fieldIds.map((id) => [id, resolved(input.objectId, id)])) } }
  const system = { id: 'es_d2w_ns', tenantId: TENANT, kind: 'metasheet:multitable', role: 'target', config: { projectId: PROJECT_ID, objects: { [NAMESPACE_OBJECT]: { sheetId: SHEET, keyFields: ['idempotencyKey'], mode: 'upsert' } } } }
  const adapter = createMetaSheetMultitableTargetAdapter({ system, context: { api: { multitable: { records, provisioning } }, logger: QUIET }, governedSheetProbe: probeAnswering(NOT_REGISTERED) })
  const result = await adapter.upsert({ object: NAMESPACE_OBJECT, records: [{ idempotencyKey: 'idem-ns', [physicalMachine]: '', fld_other: 'y' }] })
  assert.equal(result.written, 1)
  const [patch] = patchesOf(calls)
  assert.equal(Object.prototype.hasOwnProperty.call(patch.changes, physicalMachine), false, 'the provisioned physical machine id is stripped')
  assert.equal(patch.changes.fld_other, 'y')
  assert.equal(patch.expectedVersion, 7)
  assert.equal(store[0].data[physicalMachine], SEEDED_DATE)
})

test('M-02 pipeline upsert, REGISTERED sheet: a version change between the read and the update is a RETRYABLE row failure (closed code), never a silent overwrite; an unreadable version fails the row the same way', async () => {
  const { records, store } = createRecords({ rows: [seededRow()], between: raceWriteback })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: freeKeySystem(), context: { api: { multitable: { records } }, logger: QUIET }, governedSheetProbe: probeAnswering(REGISTERED) })
  const result = await adapter.upsert({ object: 'main', records: [{ idempotencyKey: 'idem-1', material: 'M-NEW' }] })
  assert.deepEqual({ written: result.written, failed: result.failed, statuses: result.results.map((entry) => entry.status) }, { written: 0, failed: 1, statuses: [] })
  assert.equal(result.errors[0].code, CONFLICT_CODE)
  assert.equal(result.errors[0].retryable, true)
  assert.equal(/fld_|M-NEW|idem-1|2026-/.test(result.errors[0].message), false, 'the message is values-free')
  assert.equal(store[0].data[PHYS[MACHINE]], RACED_DATE, 'the concurrent write-back stands')
  assert.equal(store[0].data[PHYS.material], 'M-OLD', 'nothing of the row was written')

  const versionless = createRecords({ rows: [{ ...seededRow(), version: undefined }] })
  const adapter2 = createMetaSheetMultitableTargetAdapter({ system: freeKeySystem(), context: { api: { multitable: { records: versionless.records } }, logger: QUIET }, governedSheetProbe: probeAnswering(REGISTERED) })
  const result2 = await adapter2.upsert({ object: 'main', records: [{ idempotencyKey: 'idem-1', material: 'M-NEW' }] })
  assert.equal(result2.failed, 1)
  assert.equal(result2.errors[0].code, CONFLICT_CODE)
  assert.equal(patchesOf(versionless.calls).length, 0, 'no patch without a version to fence it')
})

test('M-03 REGRESSION pipeline upsert on a NON-stock-prep target (registry absent, free key; and no probe at all): the patch is byte-identical to before — machine-named column written, NO expectedVersion key, a racing version is last-writer-wins', async () => {
  for (const probe of [probeAnswering(NOT_REGISTERED), undefined]) {
    const { records, calls, store } = createRecords({ rows: [seededRow()], between: raceWriteback })
    const adapter = createMetaSheetMultitableTargetAdapter({ system: freeKeySystem(), context: { api: { multitable: { records } }, logger: QUIET }, governedSheetProbe: probe })
    const result = await adapter.upsert({ object: 'main', records: [{ idempotencyKey: 'idem-1', material: 'M-NEW', [MACHINE]: '' }] })
    assert.equal(result.written, 1)
    assert.equal(result.failed, 0)
    const [patch] = patchesOf(calls)
    assert.deepEqual(Object.keys(patch).sort(), ['changes', 'recordId', 'sheetId'], 'no expectedVersion key at all')
    assert.deepEqual(patch.changes, { [PHYS.idempotencyKey]: 'idem-1', [PHYS.material]: 'M-NEW', [PHYS[MACHINE]]: '' })
    assert.equal(store[0].data[PHYS[MACHINE]], '', 'legacy behaviour: the column is written as configured')
    assert.deepEqual(Object.keys(result.results[0]).sort(), ['externalId', 'index', 'key', 'recordId', 'status', 'version'])
  }
})

// ── C6 updateRows ─────────────────────────────────────────────────────────────────────────────────

test('C-01 C6 updateRows on a REGISTERED sheet: the machine column is not written, the other fields are, and the patch carries the version read', async () => {
  const { records, calls, store } = createRecords({ rows: [seededRow()] })
  const source = createMetaSheetMultitableWriteSource({ system: freeKeySystem(), context: { api: { multitable: { records } }, logger: QUIET }, governedSheetProbe: probeAnswering(REGISTERED) })
  const out = await source.updateRows('mt', 'main', [{ idempotencyKey: 'idem-1', material: 'M-C6', [MACHINE]: '' }], { keyFields: ['idempotencyKey'] })
  assert.equal(out.rowCount, 1)
  const [patch] = patchesOf(calls)
  assert.equal(Object.prototype.hasOwnProperty.call(patch.changes, PHYS[MACHINE]), false)
  assert.equal(Object.prototype.hasOwnProperty.call(patch.changes, MACHINE), false)
  assert.equal(patch.changes[PHYS.material], 'M-C6')
  assert.equal(patch.expectedVersion, 3)
  assert.equal(store[0].data[PHYS[MACHINE]], SEEDED_DATE)
})

test('C-02 C6 updateRows on a REGISTERED sheet: a racing version change throws the closed, retryable conflict code, and the C6 row loop keeps that code (not WRITE_FAILED)', async () => {
  const { records, store } = createRecords({ rows: [seededRow()], between: raceWriteback })
  const source = createMetaSheetMultitableWriteSource({ system: freeKeySystem(), context: { api: { multitable: { records } }, logger: QUIET }, governedSheetProbe: probeAnswering(REGISTERED) })
  let caught = null
  try {
    await source.updateRows('mt', 'main', [{ idempotencyKey: 'idem-1', material: 'M-C6' }], { keyFields: ['idempotencyKey'] })
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'the conflict throws (the C6 row loop turns it into a dead letter)')
  assert.equal(caught.code, CONFLICT_CODE)
  assert.equal(caught.retryable, true)
  assert.equal(c6Internals.valuesFreeErrorCode(caught), CONFLICT_CODE, 'registered in the C6 values-free row-error vocabulary')
  assert.equal(store[0].data[PHYS[MACHINE]], RACED_DATE)
  assert.equal(store[0].data[PHYS.material], 'M-OLD')
})

test('C-03 REGRESSION C6 updateRows on a NON-stock-prep target: byte-identical patch, no expectedVersion key, racing version is last-writer-wins', async () => {
  for (const probe of [probeAnswering(NOT_REGISTERED), undefined]) {
    const { records, calls } = createRecords({ rows: [seededRow()], between: raceWriteback })
    const source = createMetaSheetMultitableWriteSource({ system: freeKeySystem(), context: { api: { multitable: { records } }, logger: QUIET }, governedSheetProbe: probe })
    const out = await source.updateRows('mt', 'main', [{ idempotencyKey: 'idem-1', material: 'M-C6', [MACHINE]: '' }], { keyFields: ['idempotencyKey'] })
    assert.equal(out.rowCount, 1)
    const [patch] = patchesOf(calls)
    assert.deepEqual(Object.keys(patch).sort(), ['changes', 'recordId', 'sheetId'])
    assert.deepEqual(patch.changes, { [PHYS.idempotencyKey]: 'idem-1', [PHYS.material]: 'M-C6', [PHYS[MACHINE]]: '' })
  }
})

// ── ERP feedback ──────────────────────────────────────────────────────────────────────────────────

const feedbackPhysical = (objectId, fieldId) => `fld_${objectId}_${fieldId}`

function feedbackContext({ objectId, between = null, version = 5 }) {
  const row = { id: 'rec_fb', sheetId: SHEET, version, data: { [feedbackPhysical(objectId, 'idempotencyKey')]: 'idem-fb', [feedbackPhysical(objectId, MACHINE)]: SEEDED_DATE, [feedbackPhysical(objectId, 'material')]: 'M-OLD' } }
  const { records, calls, store } = createRecords({ rows: [row], between: between && ((target) => { target.data = { ...target.data, [feedbackPhysical(objectId, MACHINE)]: RACED_DATE }; target.version += 1 }) })
  const provisioning = {
    async findObjectSheet() { return { id: SHEET } },
    async resolveFieldIds(input) { return Object.fromEntries(input.fieldIds.map((id) => [id, feedbackPhysical(input.objectId, id)])) },
  }
  return { context: { api: { multitable: { records, provisioning } } }, calls, store }
}

// A feedback field map that lands the status on the machine column and the message on `material`.
const FIELD_MAP = { status: MACHINE, externalId: 'material', billNo: 'material', responseCode: 'material', responseMessage: 'material', syncedAt: 'material' }
const feedbackUpdate = { key: 'idem-fb', fields: { [MACHINE]: 'synced', material: 'M-FB' } }

test('E-01 ERP feedback updateRecords on a stock-prep NAMESPACE object (and on any REGISTERED sheet): the machine column is not written, the other fields are, and the patch carries the version read', async () => {
  for (const [objectId, answer] of [[NAMESPACE_OBJECT, NOT_REGISTERED], ['staging_main', REGISTERED]]) {
    const { context, calls, store } = feedbackContext({ objectId })
    const writer = createMultitableFeedbackWriter({ context, governedSheetProbe: probeAnswering(answer) })
    const result = await writer.updateRecords({ tenantId: TENANT, projectId: PROJECT_ID, objectId, keyField: 'idempotencyKey', updates: [feedbackUpdate] })
    assert.equal(result.patched, 1, objectId)
    const [patch] = patchesOf(calls)
    assert.equal(Object.prototype.hasOwnProperty.call(patch.changes, feedbackPhysical(objectId, MACHINE)), false, `${objectId}: no machine column`)
    assert.equal(patch.changes[feedbackPhysical(objectId, 'material')], 'M-FB')
    assert.equal(patch.expectedVersion, 5)
    assert.equal(store[0].data[feedbackPhysical(objectId, MACHINE)], SEEDED_DATE)
  }
})

test('E-02 ERP feedback on a stock-prep target: a racing version change is a retryable row failure — the row is not written, writeBack reports ERP_FEEDBACK_VERSION_CONFLICT (ok:false, retryable)', async () => {
  const { context, store } = feedbackContext({ objectId: NAMESPACE_OBJECT, between: true })
  const feedback = createErpFeedbackWriter({ context, clock: () => '2026-11-17T00:00:00.000Z', governedSheetProbe: probeAnswering(NOT_REGISTERED) })
  const out = await feedback.writeBack({
    tenantId: TENANT, runId: 'run_d2w', workspaceId: null,
    pipeline: { id: 'pipe_d2w', projectId: PROJECT_ID, options: { erpFeedback: { objectId: NAMESPACE_OBJECT, keyField: 'idempotencyKey', fieldMap: FIELD_MAP } } },
    cleanRecords: [{ sourceRecord: {}, targetRecord: { idempotencyKey: 'idem-fb' } }],
    writeResult: { results: [{ key: 'idem-fb', externalId: 'ext_d2w' }] },
  })
  assert.equal(out.ok, false)
  assert.equal(out.reason, ERP_CONFLICT_REASON)
  assert.equal(out.retryable, true)
  assert.equal(store[0].data[feedbackPhysical(NAMESPACE_OBJECT, MACHINE)], RACED_DATE, 'the concurrent write-back stands')
  assert.equal(store[0].data[feedbackPhysical(NAMESPACE_OBJECT, 'material')], 'M-OLD', 'nothing of the row was written')
})

test('E-03 REGRESSION ERP feedback on a NON-stock-prep target (registry absent, plain object; and no probe): byte-identical patch, no expectedVersion key, the configured fields all written', async () => {
  for (const probe of [probeAnswering(NOT_REGISTERED), undefined]) {
    const objectId = 'standard_materials'
    const { context, calls } = feedbackContext({ objectId, between: true })
    const writer = createMultitableFeedbackWriter({ context, governedSheetProbe: probe })
    const result = await writer.updateRecords({ tenantId: TENANT, projectId: PROJECT_ID, objectId, keyField: 'idempotencyKey', updates: [feedbackUpdate] })
    assert.deepEqual(result, { ok: true, sheetId: SHEET, objectId, patched: 1, created: 0, written: 1 })
    const [patch] = patchesOf(calls)
    assert.deepEqual(Object.keys(patch).sort(), ['changes', 'recordId', 'sheetId'])
    assert.deepEqual(patch.changes, { [feedbackPhysical(objectId, MACHINE)]: 'synced', [feedbackPhysical(objectId, 'material')]: 'M-FB' })
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('generic-writer-machine-column-shield.test.cjs', tests)
