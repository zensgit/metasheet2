'use strict'

// Batch-refresh phase 2 step 4, PR-0 (plan §5.1 / G5; design §7.1 row 13, §17 PR-0, §19 PR-0) — the carry-confirm
// write under the SHEET WRITE LEASE and the host write fence, on the shared project-sheet substrate
// (support/stock-preparation-project-sheet-harness.cjs) with the inspectable in-memory lock
// (support/stock-preparation-project-write-lock-kit.cjs) and a records fake that honours filters and
// `expectedVersion` (the harness's own fake does neither, which the carry executor needs):
//
//   C1  a busy sheet refuses the carry 409 WRITE_LOCKED BEFORE any ledger read and any records read (the
//       lease is acquired after the tenant wall, which is provisioning-only); the holder's purpose is named.
//   C2  no lock service: 501 UNAVAILABLE with zero records IO.
//   C3  the happy path runs under the lease (a contender mid-write sees purpose `carry_confirm`), the one
//       patch carries the host fence AND `expectedVersion`, the lease is released after, the generation is
//       bumped once with reason `carry_confirm`, and the audit says so (values-free).
//   C4  a takeover between the carry's pre-write CAS and its host patch: the (fake) host refuses the fence
//       — 409 LEASE_LOST, nothing written, the lease was not ours to release (D17's hermetic twin).
//   C4b a takeover before the pre-write CAS: `beforeWrite` refuses with ZERO host writes attempted (zero
//       fences seen) — the discriminator for "carry without beforeWrite".
//   C5  a row moved between the read and the write: the version conflict is still
//       CONFIRM_CARRY_TARGET_VERSION_CONFLICT (fence-first, so never mistaken for a lost lease); released.
//   C6  E01 cross-lane: a dry-run token minted BEFORE the carry is refused PLAN_SUPERSEDED `newer_plan`
//       (currentReason `carry_confirm`) at its apply with nothing written; a token minted after applies.
//   C7  a replayed carry (skipped_already_carried) writes nothing and bumps nothing.
//   C8  a bump refused after release is logged values-free and never masks the carry (200, audited false).
//   C9  source order in stockPreparationCarryConfirm: tenant wall < lock < lease < ledger pre-flight <
//       executor (with writeFenceRequired) < release < bump < ledger close < audit.
//   C10 the executor itself: a records surface that declares no fence is refused 501 before any read; a
//       fenced run without the guard is refused 501 before any read; the logical view forwards the
//       declaration.
//
// Every value here is synthetic.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const kit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { OBJECT_ID: LEDGER_OBJECT_ID } = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const { applyCarryViaConfirm } = require(path.join(LIB, 'stock-preparation-confirm-writes.cjs'))
const {
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS,
  PROJECT_WRITE_LEASE_TTL_MS,
  PROJECT_WRITE_LOCK_TABLE,
  sheetWriteScopeKey,
} = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-scl-carry'
const PROJECT = 'SYN-SCL-0007'
const COMPONENT = 'SCL-COMP-X'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const CARRY_PATH = '/api/integration/stock-preparation/carry/confirm'
const PULLER = Object.freeze({ id: 'u_scl_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const ADMIN = Object.freeze({ id: 'u_scl_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const NOTE = 'synthetic note carried 0007'
const OLD_KEY = JSON.stringify({ projectNo: PROJECT, componentSourceId: COMPONENT, parentSourceId: null, path: ['OLD', COMPONENT] })
const NEW_KEY = JSON.stringify({ projectNo: PROJECT, componentSourceId: COMPONENT, parentSourceId: null, path: ['NEW', COMPONENT] })

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function decisionFixture() {
  return {
    decision: 'carry_via_confirm',
    idempotencyKey: NEW_KEY,
    sourceIdempotencyKey: OLD_KEY,
    componentSourceId: COMPONENT,
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
    carryFields: ['notes'],
    writeVia: 'k2_confirm',
    requiresConfirm: true,
    carry: true,
  }
}

// A records fake the carry can run against: rows per sheet, equality filters, limit / offset, `expectedVersion`
// refused exactly as records.ts refuses it (name + code), merge semantics on patch. Keys are whatever the caller
// sends (the overlay target binds physical ids, so rows hold physical keys).
function createRecordsFake() {
  const rows = []
  const calls = []
  let seq = 0
  const matches = (record, filters) => Object.entries(filters || {}).every(([key, value]) => record.data[key] === value)
  return {
    rows,
    calls,
    patches: () => calls.filter(([op]) => op === 'patchRecord'),
    writes: () => calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord'),
    async queryRecords(input = {}) {
      calls.push(['queryRecords', clone({ sheetId: input.sheetId, filters: input.filters, limit: input.limit, offset: input.offset })])
      const found = rows.filter((record) => record.sheetId === input.sheetId && matches(record, input.filters))
      const offset = input.offset || 0
      return found.slice(offset, offset + (input.limit || 1000)).map(clone)
    },
    async createRecord(input = {}) {
      calls.push(['createRecord', clone({ sheetId: input.sheetId, data: input.data })])
      seq += 1
      const record = { id: `rec_scl_${seq}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      calls.push(['patchRecord', clone({ sheetId: input.sheetId, recordId: input.recordId, changes: input.changes, expectedVersion: input.expectedVersion })])
      const record = rows.find((entry) => entry.sheetId === input.sheetId && entry.id === input.recordId)
      if (!record) throw new Error('record not found')
      if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) {
        throw Object.assign(new Error('Record version conflict'), { name: 'MultitableRecordVersionConflictError', code: 'VERSION_CONFLICT' })
      }
      Object.assign(record.data, input.changes || {})
      record.version += 1
      return clone(record)
    },
  }
}

// The project-sheet mount with (a) the inspectable lock on a controllable clock (or none), (b) the records fake
// above installed under the harness's fake host fence, and (c) a hook layer ABOVE the fence, so a test can act
// between the executor's pre-write CAS and the host's fence check (the real D17 window).
function mount({ lock = 'memory', logger } = {}) {
  const clock = kit.createClock()
  const env = lock === 'memory' ? kit.createInMemoryProjectWriteLock({ clock, timers: 'real' }) : null
  const warns = []
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    logger: logger || { info() {}, warn(...args) { warns.push(args) }, error() {} },
    serviceExtras: { stockPreparationProjectWriteLock: env ? env.lock : null },
  })
  const fake = createRecordsFake()
  Object.assign(h.records, { queryRecords: fake.queryRecords, createRecord: fake.createRecord, patchRecord: fake.patchRecord })
  const fenced = h.context.api.multitable.records
  const hooks = { beforeQuery: null, beforePatch: null }
  h.context.api.multitable.records = {
    supportsWriteFence: true,
    get fakeHostFences() { return fenced.fakeHostFences },
    async queryRecords(input) { if (hooks.beforeQuery) await hooks.beforeQuery(input); return fenced.queryRecords(input) },
    async createRecord(input) { return fenced.createRecord(input) },
    async patchRecord(input) { if (hooks.beforePatch) await hooks.beforePatch(input); return fenced.patchRecord(input) },
  }
  const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
  const physical = (fieldId) => h.provisioning.getFieldId(h.staging, objectId, fieldId)
  const seedRow = (logical) => fake.rows.push({
    id: `rec_seed_${fake.rows.length + 1}`,
    sheetId,
    version: 1,
    data: Object.fromEntries(Object.entries(logical).map(([key, value]) => [physical(key), value])),
  })
  // The carry pair: an inactive predecessor holding the human note, and its re-keyed, blank successor.
  seedRow({ projectNo: PROJECT, idempotencyKey: OLD_KEY, componentSourceId: COMPONENT, path: JSON.stringify(['OLD', COMPONENT]), totalQuantity: 2, active: false, notes: NOTE })
  seedRow({ projectNo: PROJECT, idempotencyKey: NEW_KEY, componentSourceId: COMPONENT, path: JSON.stringify(['NEW', COMPONENT]), totalQuantity: 2, active: true })
  fake.calls.length = 0
  return Object.assign(h, {
    env,
    clock,
    fake,
    hooks,
    warns,
    sheetId,
    objectId,
    physical,
    scope: sheetWriteScopeKey(sheetId),
    targetRow: () => fake.rows.find((row) => row.data[physical('idempotencyKey')] === NEW_KEY),
    lockRow: () => (env ? env.db.rows(PROJECT_WRITE_LOCK_TABLE).find((row) => row.scope_key === sheetWriteScopeKey(sheetId)) || null : null),
    fences: () => fenced.fakeHostFences,
    carryAudits: () => h.auditAppends.filter((entry) => entry.detail && entry.detail.operation === 'stock_preparation_carry_confirm'),
  })
}

const call = (h, method, routePath, { body, user, query = { tenantId: TENANT } } = {}) =>
  harness.call(h.routes, method, routePath, { user, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body, query })
const carry = (h, body = { decision: decisionFixture() }) => call(h, 'POST', CARRY_PATH, { body, user: ADMIN })
const dryRun = (h) => call(h, 'POST', DRY_RUN_PATH, { body: { parameters: { projectNo: PROJECT } }, user: PULLER })
const apply = (h, token) => call(h, 'POST', APPLY_PATH, { body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: token } }, user: PULLER })
const errorOf = (res) => (res.body && res.body.error ? res.body.error : {})
// A second lock instance over the SAME fake db and clock: another process.
const otherLock = (h) => kit.createInMemoryProjectWriteLock({ db: h.env.db, clock: h.clock, timers: 'real' }).lock
const lapse = (h) => h.clock.advance(PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS + 1)

// ── C1 ────────────────────────────────────────────────────────────────────────────────────────────
test('C1 a busy sheet refuses the carry 409 WRITE_LOCKED before any ledger read and any records read; the holder purpose is named', async () => {
  const h = mount()
  try {
    // A ledger sheet exists, so a pre-flight that DID run would be a visible records read (and a 404).
    harness.seedObject(h.provisioning, h.staging, LEDGER_OBJECT_ID)
    const holder = await otherLock(h).acquire(h.scope, { purpose: 'small_apply', runId: 'scl-other-apply' })
    const res = await carry(h, { decision: decisionFixture(), decisionId: 'd1c1d1c1d1c1d1c1', inputFingerprint: 'f1f1f1f1f1f1f1f1' })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.equal(errorOf(res).details.holderPurpose, 'small_apply')
    assert.deepEqual(h.fake.calls, [], 'zero records IO: no ledger read, no row read')
    assert.equal(h.provisioning.calls.some(([op, objectId]) => op === 'findObjectSheet' && objectId === LEDGER_OBJECT_ID), false, 'the ledger was not even resolved')
    assert.equal(h.carryAudits().length, 0, 'nothing audited')
    assert.equal(h.targetRow().data[h.physical('notes')], undefined, 'nothing carried')
    await h.env.lock.createGuard(holder).release()
    const ok = await carry(h)
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.data.mode, 'carried')
  } finally { h.restore() }
})

// ── C2 ────────────────────────────────────────────────────────────────────────────────────────────
test('C2 no lock service: the carry is refused 501 UNAVAILABLE with zero records IO', async () => {
  const h = mount({ lock: null })
  try {
    const res = await carry(h)
    assert.equal(res.statusCode, 501, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE)
    assert.deepEqual(h.fake.calls, [])
    assert.equal(h.targetRow().data[h.physical('notes')], undefined)
  } finally { h.restore() }
})

// ── C3 ────────────────────────────────────────────────────────────────────────────────────────────
test('C3 the carry runs under the lease (purpose carry_confirm), its patch carries the host fence and expectedVersion, the lease is released and the generation bumped once with reason carry_confirm', async () => {
  const h = mount()
  try {
    let midWrite = null
    let contender = null
    h.hooks.beforePatch = async () => {
      midWrite = h.lockRow()
      // A contender during the patch is told the carry holds the sheet.
      try { await otherLock(h).acquire(h.scope, { purpose: 'small_apply', runId: 'scl-contender' }); contender = 'granted' } catch (error) { contender = error }
    }
    const res = await carry(h)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.mode, 'carried')
    assert.deepEqual(res.body.data.carriedFields, ['notes'])
    assert.equal(h.targetRow().data[h.physical('notes')], NOTE, 'the human note was carried')
    assert.ok(midWrite && midWrite.lease_id, 'calibration: a lease was held during the patch')
    assert.equal(midWrite.lease_purpose, 'carry_confirm')
    assert.equal(contender && contender.code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.equal(contender.details.holderPurpose, 'carry_confirm')
    // ONE patch, fenced with THIS lease and version-conditional.
    assert.equal(h.fences().length, 1, 'exactly one fenced host write')
    assert.deepEqual(h.fences()[0], ['patchRecord', { lock: PROJECT_WRITE_LOCK_TABLE, scopeKey: h.scope, leaseId: midWrite.lease_id, fencingEpoch: midWrite.fencing_epoch, generationToken: midWrite.generation_token }])
    assert.equal(h.fake.patches().length, 1)
    assert.equal(h.fake.patches()[0][1].expectedVersion, 1, 'the patch pins the version it decided against')
    assert.deepEqual(Object.keys(h.fake.patches()[0][1].changes), [h.physical('notes')], 'exactly the carried column')
    // Released, bumped once, reason recorded.
    const after = h.lockRow()
    assert.equal(after.lease_id, null, 'released after the carry')
    assert.equal(after.generation, 1)
    assert.equal(after.generation_reason, 'carry_confirm')
    assert.notEqual(after.generation_token, midWrite.generation_token, 'the plan generation moved')
    const audit = h.carryAudits()
    assert.equal(audit.length, 1)
    assert.equal(audit[0].detail.generationBumped, true)
    assert.equal(JSON.stringify(audit[0]).includes(NOTE), false, 'values-free')
    assert.deepEqual(h.warns, [], 'nothing to warn about')
  } finally { h.restore() }
})

// ── C4 ────────────────────────────────────────────────────────────────────────────────────────────
test('C4 a takeover between the pre-write CAS and the host patch: the host refuses the fence — 409 LEASE_LOST, nothing written, nothing bumped', async () => {
  const h = mount()
  try {
    let grantB = null
    h.hooks.beforePatch = async () => {
      // The carry passed its pre-write CAS and is about to ask the host; its lease lapses and another
      // process takes the sheet over (epoch + 1, a new lease id) before the host checks the fence.
      lapse(h)
      grantB = await otherLock(h).acquire(h.scope, { purpose: 'small_apply', runId: 'scl-takeover' })
      assert.equal(grantB.takeover, true, 'calibration: a takeover')
    }
    const res = await carry(h)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
    assert.equal(h.fences().length, 1, 'the host was asked once, with the old fence')
    assert.equal(h.fake.patches().length, 0, 'the host wrote nothing')
    assert.equal(h.targetRow().data[h.physical('notes')], undefined, 'nothing carried')
    assert.equal(h.targetRow().version, 1, 'version unchanged')
    const row = h.lockRow()
    assert.equal(row.lease_id, grantB.leaseId, 'the taker-over still holds the sheet (the loser released nothing)')
    assert.equal(row.generation, 0, 'nothing bumped')
    assert.equal(h.carryAudits().length, 0, 'a refused carry is not audited as a carry')
    await h.env.lock.createGuard(grantB).release()
  } finally { h.restore() }
})

// ── C4b ───────────────────────────────────────────────────────────────────────────────────────────
test('C4b a takeover before the pre-write CAS: beforeWrite refuses LEASE_LOST with ZERO host writes attempted (zero fences seen)', async () => {
  const h = mount()
  try {
    let grantB = null
    h.hooks.beforeQuery = async () => {
      if (grantB) return
      lapse(h)
      grantB = await otherLock(h).acquire(h.scope, { purpose: 'small_apply', runId: 'scl-takeover-early' })
    }
    const res = await carry(h)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
    assert.equal(h.fences().length, 0, 'the host was never asked: the pre-write CAS refused first')
    assert.equal(h.fake.patches().length, 0)
    assert.equal(h.targetRow().data[h.physical('notes')], undefined)
    assert.equal(h.lockRow().generation, 0, 'nothing bumped')
    await h.env.lock.createGuard(grantB).release()
  } finally { h.restore() }
})

// ── C5 ────────────────────────────────────────────────────────────────────────────────────────────
test('C5 a target row that moved between the read and the write is still CONFIRM_CARRY_TARGET_VERSION_CONFLICT under the lease; released, nothing written, nothing bumped', async () => {
  const h = mount()
  try {
    h.hooks.beforePatch = async () => { h.targetRow().version += 1 } // a human edit landed meanwhile
    const res = await carry(h)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'CONFIRM_CARRY_TARGET_VERSION_CONFLICT')
    assert.deepEqual(errorOf(res).details.fields, ['notes'])
    assert.equal(h.fences().length, 1, 'the write was fenced (and the fence held): the version is what refused')
    assert.equal(h.targetRow().data[h.physical('notes')], undefined, 'nothing carried')
    const row = h.lockRow()
    assert.equal(row.lease_id, null, 'released after the refusal')
    assert.equal(row.generation, 0, 'nothing bumped')
  } finally { h.restore() }
})

// ── C6 ────────────────────────────────────────────────────────────────────────────────────────────
test('C6 (E01) a dry-run token minted before the carry is refused PLAN_SUPERSEDED newer_plan (currentReason carry_confirm) at apply, nothing written; a token minted after applies', async () => {
  const h = mount()
  try {
    const before = await dryRun(h)
    assert.equal(before.statusCode, 200, JSON.stringify(before.body))
    assert.equal(h.lockRow().generation, 1, 'calibration: the applicable preview bumped')
    const carried = await carry(h)
    assert.equal(carried.statusCode, 200, JSON.stringify(carried.body))
    assert.equal(h.lockRow().generation, 2)
    assert.equal(h.lockRow().generation_reason, 'carry_confirm')
    const writesBefore = h.fake.writes().length
    const refused = await apply(h, before.body.data.dryRunToken)
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.equal(errorOf(refused).code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(errorOf(refused).details.reason, 'newer_plan')
    assert.equal(errorOf(refused).details.currentReason, 'carry_confirm')
    assert.equal(errorOf(refused).details.partial, false)
    assert.equal(h.fake.writes().length, writesBefore, 'the stale plan wrote nothing')
    assert.equal(h.lockRow().lease_id, null, 'released')
    // A preview made after the carry sees the carried sheet and applies.
    const after = await dryRun(h)
    assert.equal(after.statusCode, 200, JSON.stringify(after.body))
    const ok = await apply(h, after.body.data.dryRunToken)
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.data.status, 'succeeded')
    assert.equal(h.targetRow().data[h.physical('notes')], NOTE, 'the apply left the human cell alone')
  } finally { h.restore() }
})

// ── C7 ────────────────────────────────────────────────────────────────────────────────────────────
test('C7 a replayed carry (skipped_already_carried) runs under the lease but writes nothing and bumps nothing', async () => {
  const h = mount()
  try {
    const first = await carry(h)
    assert.equal(first.statusCode, 200, JSON.stringify(first.body))
    const generation = h.lockRow().generation
    const token = h.lockRow().generation_token
    const replay = await carry(h)
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.data.mode, 'skipped_already_carried')
    assert.equal(h.fake.patches().length, 1, 'no second patch')
    assert.equal(h.lockRow().generation, generation, 'a no-op carry bumps nothing')
    assert.equal(h.lockRow().generation_token, token)
    assert.equal(h.lockRow().lease_id, null, 'released')
    const audits = h.carryAudits()
    assert.equal(audits.length, 2)
    assert.equal(audits[1].mode, 'skipped_already_carried')
    assert.equal(Object.prototype.hasOwnProperty.call(audits[1].detail, 'generationBumped'), false, 'no bump to report')
  } finally { h.restore() }
})

// ── C8 ────────────────────────────────────────────────────────────────────────────────────────────
test('C8 a bump refused after release is logged values-free and never masks the carry: 200 carried, audited generationBumped false', async () => {
  const h = mount()
  try {
    h.env.db.faults.updateRow = (args) => (args.set && args.set.generation_reason === 'carry_confirm' ? Object.assign(new Error('synthetic store fault'), { code: '08006' }) : null)
    const res = await carry(h)
    delete h.env.db.faults.updateRow
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(h.targetRow().data[h.physical('notes')], NOTE, 'the carry stands')
    const row = h.lockRow()
    assert.equal(row.lease_id, null, 'released')
    assert.equal(row.generation, 0, 'the bump did not land')
    assert.equal(h.carryAudits()[0].detail.generationBumped, false)
    assert.equal(h.warns.length, 1, 'one warning')
    assert.match(h.warns[0][0], /carry confirm: the generation bump after release was refused; the carry stands/)
    assert.equal(h.warns[0][1].code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
    const text = JSON.stringify(h.warns)
    assert.equal(text.includes(NOTE) || text.includes(h.scope) || text.includes(h.sheetId) || text.includes(NEW_KEY), false, 'values-free')
  } finally { h.restore() }
})

// ── C9 ────────────────────────────────────────────────────────────────────────────────────────────
test('C9 source order in stockPreparationCarryConfirm: tenant wall < lock < lease < ledger pre-flight < executor (fence required) < bump < ledger close < audit', () => {
  const code = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = code.indexOf('    async stockPreparationCarryConfirm(req, res) {')
  assert.notEqual(start, -1)
  const body = code.slice(start, code.indexOf('\n    },', start))
  const at = (needle) => {
    const i = body.indexOf(needle)
    assert.notEqual(i, -1, `stockPreparationCarryConfirm contains ${needle}`)
    return i
  }
  const order = [
    'assertCarryTargetBelongsToTenant(',
    'requireStockPreparationProjectWriteLock()',
    "withProjectWriteLease(carryWriteScope, { purpose: 'carry_confirm'",
    'assertCarryConfirmDecisionBinding(',
    'applyCarryViaConfirm(',
    'writeFence: projectWriteGuard,',
    'writeFenceRequired: true,',
    "bumpGeneration(carryWriteScope, { reason: 'carry_confirm'",
    'confirmCarryConfirmationDecision(',
    'audit.append(',
  ]
  for (let i = 1; i < order.length; i += 1) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} precedes ${order[i]}`)
  assert.equal(body.includes('assertNoLiveWriter('), false, 'the carry acquires; it does not merely peek')
  assert.ok(body.indexOf('result.persisted === true') < at("bumpGeneration(carryWriteScope, { reason: 'carry_confirm'"), 'only a written carry bumps')
})

// ── C10 ───────────────────────────────────────────────────────────────────────────────────────────
test('C10 the executor: a records surface without fence support is refused 501 before any read; a required fence that is absent is refused 501 before any read; the logical view forwards the declaration', async () => {
  const env = kit.createInMemoryProjectWriteLock({ timers: 'real' })
  const scope = sheetWriteScopeKey('sheet_scl_executor')
  const target = { sheetId: 'sheet_scl_executor', objectId: 'plm_stock_preparation_main', fieldIdMap: {} }
  const seeded = () => {
    const fake = createRecordsFake()
    fake.rows.push({ id: 'r_old', sheetId: target.sheetId, version: 1, data: { projectNo: PROJECT, idempotencyKey: OLD_KEY, componentSourceId: COMPONENT, active: false, notes: NOTE } })
    fake.rows.push({ id: 'r_new', sheetId: target.sheetId, version: 1, data: { projectNo: PROJECT, idempotencyKey: NEW_KEY, componentSourceId: COMPONENT, active: true } })
    return fake
  }
  const base = (fake) => ({ permission: 'admin', recordsApi: fake, target, decision: decisionFixture(), confirmedBy: 'u_scl_admin' })
  // (a) a guard but a host that declares no fence: 501 host_fence_unsupported, zero reads.
  {
    const fake = seeded()
    await assert.rejects(
      () => env.lock.withProjectWriteLease(scope, { purpose: 'carry_confirm' }, (guard) => applyCarryViaConfirm({ ...base(fake), writeFence: guard, writeFenceRequired: true })),
      (error) => error.status === 501 && error.code === PROJECT_WRITE_ERROR_CODES.UNAVAILABLE && error.details.reason === 'host_fence_unsupported',
    )
    assert.deepEqual(fake.calls, [], 'refused before any read')
  }
  // (b) the fence required but absent: 501 write_fence_required, zero reads.
  {
    const fake = seeded()
    await assert.rejects(
      () => applyCarryViaConfirm({ ...base(kit.withFakeHostWriteFence(fake)), writeFenceRequired: true }),
      (error) => error.status === 501 && error.code === PROJECT_WRITE_ERROR_CODES.UNAVAILABLE && error.details.reason === 'write_fence_required',
    )
    assert.deepEqual(fake.calls, [], 'refused before any read')
  }
  // (c) the fenced host + the guard: the declaration crossed the logical view, the patch is fenced, the note carried.
  {
    const fake = seeded()
    const fenced = kit.withFakeHostWriteFence(fake)
    const result = await env.lock.withProjectWriteLease(scope, { purpose: 'carry_confirm' }, (guard) => applyCarryViaConfirm({ ...base(fenced), writeFence: guard, writeFenceRequired: true }))
    assert.equal(result.mode, 'carried')
    assert.equal(fenced.fakeHostFences.length, 1)
    assert.equal(fake.rows.find((row) => row.id === 'r_new').data.notes, NOTE)
  }
  // (d) no guard, nothing required (the executor's own unit suites): unfenced, byte-identical to before.
  {
    const fake = seeded()
    const result = await applyCarryViaConfirm(base(fake))
    assert.equal(result.mode, 'carried')
    assert.equal(fake.patches()[0][1].expectedVersion, 1)
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-carry-confirm-write-lease.test.cjs', tests, { passLine: '✓ stock-preparation-carry-confirm-write-lease' })
