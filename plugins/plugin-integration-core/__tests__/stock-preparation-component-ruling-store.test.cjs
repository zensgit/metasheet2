'use strict'

// 备料 batch-refresh step 6d-1b (S6-5; register row R-91) — THE COMPONENT RULING STORE over migration 107
// (lib/stock-preparation-component-ruling-store.cjs), driven against the faithful fake of the support kit (the enum CHECKs
// parsed from 107, the shape CHECKs cross-checked by name, the partial UNIQUE, rollback on throw).
//
//   CR-01  record: ONE transaction — the row (kind remnant_acknowledged, basis head_not_ordered, active, the runbook
//          handle, the recorder), then the caller's auditWithin on the SAME handle with a values-free event
//   CR-02  a second ACTIVE acknowledgement of the same component is the partial UNIQUE's 23505 => 409 ALREADY_ACKNOWLEDGED,
//          no audit call, nothing written; after a revoke the component can be acknowledged again
//   CR-03  an audit failure rolls the row back (and its typed refusal passes through); a row failure writes no audit row
//   CR-04  revoke: FOR UPDATE by (id, tenant, sheet, project) — another scope's id is 404; already revoked 409; the
//          compare-and-set writes the revoker, the clock and the revoke's own runbook handle; audit on the same handle;
//          an audit failure rolls the revoke back
//   CR-05  reads: active vs all, scoped; a failing read is 503 STORE_FAILED (42P01 => reason undefined_table), never [];
//          a row of another scope / a malformed row is 503, never data
//   CR-06  the inputs are validated before any IO (digest, basis, runbook handle, recorder, the audit hook)
//   CR-07  the migration text and the store agree: the enum lists, the unique index name, the shape CHECK names, the
//          runbook pattern; the kit's unique index can be dropped (the in-memory mutation probe) and then CR-02 reds
// Every value is synthetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const storeModule = require(path.join(LIB, 'stock-preparation-component-ruling-store.cjs'))
const kit = require('./support/stock-preparation-component-ruling-kit.cjs')

const {
  COMPONENT_RULING_ERROR_CODES: CODES,
  COMPONENT_RULING_KINDS,
  COMPONENT_RULING_STATUSES,
  REMNANT_ACKNOWLEDGEMENT_BASES,
  ACTIVE_UNIQUE_INDEX,
  RUNBOOK_REF_PATTERN,
  createStockPreparationComponentRulingStore,
} = storeModule

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SCOPE = Object.freeze({ tenantId: 'tenant-cr-a', sheetId: 'sheet_cr_a', projectNo: 'PRJ-CR-01' })
const OTHER_SCOPE = Object.freeze({ tenantId: 'tenant-cr-a', sheetId: 'sheet_cr_b', projectNo: 'PRJ-CR-02' })
const DIGEST = 'a1b2c3d4e5f60718293a4b5c'
const DIGEST_2 = 'ffeeddccbbaa009988776655'
const AT = new Date('2026-11-10T03:00:00Z')

function storeOn(fake, extra = {}) {
  let n = 0
  return createStockPreparationComponentRulingStore({ db: fake.db, idGenerator: () => `cr_syn_${(n += 1)}`, now: () => AT, ...extra })
}

function recorder() {
  const calls = []
  const hook = async (trx, event) => { calls.push({ trx, event }) }
  return { calls, hook }
}

async function refusal(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal')
}

const recordInput = (hook, extra = {}) => ({ ...SCOPE, componentDigest: DIGEST, basis: 'head_not_ordered', runbookRef: 'R-91.ack-01', recordedBy: 'u_admin', auditWithin: hook, ...extra })

test('CR-01 record: one transaction — the row, then auditWithin on the same handle with a values-free event', async () => {
  const fake = kit.createComponentRulingFakeDb()
  const store = storeOn(fake)
  const audit = recorder()
  const row = await store.recordRemnantAcknowledgement(recordInput(audit.hook))
  assert.equal(row.id, 'cr_syn_1')
  assert.equal(row.kind, 'remnant_acknowledged')
  assert.equal(row.basis, 'head_not_ordered')
  assert.equal(row.status, 'active')
  assert.equal(row.componentDigest, DIGEST)
  assert.equal(row.runbookRef, 'R-91.ack-01')
  assert.equal(row.recordedBy, 'u_admin')
  assert.equal(row.recordedAt, AT.toISOString())
  assert.equal(row.revokedAt, null)
  const [stored] = fake.rows()
  assert.equal(stored.tenant_id, SCOPE.tenantId)
  assert.equal(stored.sheet_id, SCOPE.sheetId)
  assert.equal(stored.project_no, SCOPE.projectNo)
  assert.equal(stored.rules, null)
  assert.equal(stored.position_fingerprint, null)
  assert.equal(audit.calls.length, 1)
  assert.equal(audit.calls[0].trx.isTransaction, true, 'the audit hook runs on the transaction handle')
  assert.deepEqual({ ...audit.calls[0].event }, { operation: 'remnant_acknowledged', rulingId: 'cr_syn_1', kind: 'remnant_acknowledged', basis: 'head_not_ordered', runbookRef: 'R-91.ack-01' })
  assert.ok(!JSON.stringify(audit.calls[0].event).includes(DIGEST), 'the event carries no component handle')
  assert.deepEqual(fake.log.map(([op]) => op), ['transaction', 'insertOne'])
})

test('CR-02 a second ACTIVE acknowledgement of one component is 409 ALREADY_ACKNOWLEDGED (the partial UNIQUE); after a revoke it can be acknowledged again', async () => {
  const fake = kit.createComponentRulingFakeDb()
  const store = storeOn(fake)
  const audit = recorder()
  await store.recordRemnantAcknowledgement(recordInput(audit.hook))
  const second = await refusal(store.recordRemnantAcknowledgement(recordInput(audit.hook)))
  assert.equal(second.status, 409)
  assert.equal(second.code, CODES.ALREADY_ACKNOWLEDGED)
  assert.equal(second.details.partial, false)
  assert.equal(fake.rows().length, 1, 'nothing written')
  assert.equal(audit.calls.length, 1, 'no audit row for the refused second')
  // Another component, another project: independent.
  await store.recordRemnantAcknowledgement(recordInput(audit.hook, { componentDigest: DIGEST_2 }))
  await store.recordRemnantAcknowledgement(recordInput(audit.hook, { ...OTHER_SCOPE }))
  assert.equal(fake.rows().length, 3)
  // Revoked => the partial index no longer covers it => a fresh acknowledgement lands.
  await store.revokeRemnantAcknowledgement({ ...SCOPE, rulingId: 'cr_syn_1', runbookRef: 'R-91.rev-01', revokedBy: 'u_admin', auditWithin: audit.hook })
  const again = await store.recordRemnantAcknowledgement(recordInput(audit.hook))
  assert.equal(again.status, 'active')
  assert.equal(fake.rows().filter((row) => row.component_digest === DIGEST && row.sheet_id === SCOPE.sheetId).length, 2)
})

test('CR-03 an audit failure rolls the acknowledgement back (a typed refusal passes through); a row failure never reaches the audit hook', async () => {
  const fake = kit.createComponentRulingFakeDb()
  const store = storeOn(fake)
  const typed = Object.assign(new Error('audit vocabulary refused'), { status: 422, code: 'AUDIT_DETAIL_INVALID' })
  const refused = await refusal(store.recordRemnantAcknowledgement(recordInput(async () => { throw typed })))
  assert.equal(refused, typed, 'the audit store\'s own typed refusal is answered as itself')
  assert.equal(fake.rows().length, 0, 'the row rolled back with the audit failure')
  const untyped = await refusal(store.recordRemnantAcknowledgement(recordInput(async () => { throw new Error('socket closed') })))
  assert.equal(untyped.status, 503)
  assert.equal(untyped.code, CODES.STORE_FAILED)
  assert.equal(fake.rows().length, 0)
  const audit = recorder()
  fake.failNext('insertOne', Object.assign(new Error('relation does not exist'), { code: '42P01' }))
  const missing = await refusal(store.recordRemnantAcknowledgement(recordInput(audit.hook)))
  assert.equal(missing.status, 503)
  assert.equal(missing.details.reason, 'undefined_table')
  assert.equal(missing.details.sqlState, '42P01')
  assert.equal(audit.calls.length, 0)
})

test('CR-04 revoke: scoped FOR UPDATE (404 for another scope / an unknown id), 409 when already revoked, the compare-and-set and its audit; an audit failure rolls it back', async () => {
  const fake = kit.createComponentRulingFakeDb()
  const store = storeOn(fake)
  const audit = recorder()
  await store.recordRemnantAcknowledgement(recordInput(audit.hook))
  const revokeInput = (extra = {}) => ({ ...SCOPE, rulingId: 'cr_syn_1', runbookRef: 'R-91.rev-01', revokedBy: 'u_admin_2', auditWithin: audit.hook, ...extra })
  for (const extra of [{ ...OTHER_SCOPE }, { tenantId: 'tenant-cr-b' }, { rulingId: 'cr_syn_404' }]) {
    const missing = await refusal(store.revokeRemnantAcknowledgement(revokeInput(extra)))
    assert.equal(missing.status, 404, JSON.stringify(extra))
    assert.equal(missing.code, CODES.ACKNOWLEDGEMENT_NOT_FOUND)
  }
  // An audit failure rolls the revoke back: the row is still active.
  const rolledBack = await refusal(store.revokeRemnantAcknowledgement(revokeInput({ auditWithin: async () => { throw new Error('audit down') } })))
  assert.equal(rolledBack.status, 503)
  assert.equal(fake.rows()[0].status, 'active')
  const revoked = await store.revokeRemnantAcknowledgement(revokeInput())
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.revokedBy, 'u_admin_2')
  assert.equal(revoked.revokedAt, AT.toISOString())
  assert.equal(revoked.revokedRunbookRef, 'R-91.rev-01')
  assert.equal(revoked.runbookRef, 'R-91.ack-01', 'the recording handle is kept')
  const event = audit.calls[audit.calls.length - 1]
  assert.equal(event.trx.isTransaction, true)
  assert.deepEqual({ ...event.event }, { operation: 'remnant_acknowledgement_revoked', rulingId: 'cr_syn_1', kind: 'remnant_acknowledged', basis: 'head_not_ordered', runbookRef: 'R-91.rev-01' })
  const twice = await refusal(store.revokeRemnantAcknowledgement(revokeInput()))
  assert.equal(twice.status, 409)
  assert.equal(twice.code, CODES.ALREADY_REVOKED)
  // The update is a compare-and-set on status 'active' within the scope.
  const update = fake.log.filter(([op]) => op === 'updateRow').pop()
  assert.deepEqual(update[2], { id: 'cr_syn_1', tenant_id: SCOPE.tenantId, sheet_id: SCOPE.sheetId, project_no: SCOPE.projectNo, status: 'active' })
})

test('CR-05 reads: active vs all, scoped; a failing read is 503 (never []); a foreign or malformed row is 503, never data', async () => {
  const fake = kit.createComponentRulingFakeDb()
  const store = storeOn(fake)
  const audit = recorder()
  await store.recordRemnantAcknowledgement(recordInput(audit.hook))
  await store.recordRemnantAcknowledgement(recordInput(audit.hook, { componentDigest: DIGEST_2 }))
  await store.revokeRemnantAcknowledgement({ ...SCOPE, rulingId: 'cr_syn_2', runbookRef: 'R-91.rev-01', revokedBy: 'u_admin', auditWithin: audit.hook })
  await store.recordRemnantAcknowledgement(recordInput(audit.hook, { ...OTHER_SCOPE }))
  const active = await store.listActiveRulings(SCOPE)
  assert.deepEqual(active.map((row) => [row.id, row.status]), [['cr_syn_1', 'active']])
  const all = await store.listRulings(SCOPE)
  assert.deepEqual(all.map((row) => [row.id, row.status]).sort(), [['cr_syn_1', 'active'], ['cr_syn_2', 'revoked']])
  assert.deepEqual(fake.log.filter(([op]) => op === 'select').pop()[2], { tenant_id: SCOPE.tenantId, sheet_id: SCOPE.sheetId, project_no: SCOPE.projectNo })
  // Failures are 503 by name.
  const missing = kit.createComponentRulingFakeDb({ tableMissing: true })
  const undefinedTable = await refusal(storeOn(missing).listActiveRulings(SCOPE))
  assert.equal(undefinedTable.status, 503)
  assert.equal(undefinedTable.code, CODES.STORE_FAILED)
  assert.equal(undefinedTable.details.reason, 'undefined_table')
  // A store whose db answers a row of another scope (a broken binding): 503, never data.
  const foreign = storeOn({ db: { async select() { return [{ id: 'x', tenant_id: 'tenant-other', sheet_id: SCOPE.sheetId, project_no: SCOPE.projectNo, component_digest: DIGEST, kind: 'remnant_acknowledged', status: 'active' }] }, async transaction() {} } })
  const scoped = await refusal(foreign.listActiveRulings(SCOPE))
  assert.equal(scoped.status, 503)
  assert.equal(scoped.details.reason, 'scope_mismatch')
  const malformed = storeOn({ db: { async select() { return [{ id: 'x', tenant_id: SCOPE.tenantId, sheet_id: SCOPE.sheetId, project_no: SCOPE.projectNo, component_digest: DIGEST, kind: 'something_else', status: 'active' }] }, async transaction() {} } })
  assert.equal((await refusal(malformed.listRulings(SCOPE))).details.reason, 'row_malformed')
})

test('CR-06 the inputs are validated before any IO', async () => {
  const fake = kit.createComponentRulingFakeDb()
  const store = storeOn(fake)
  const hook = async () => {}
  for (const [label, extra, field] of [
    ['a short digest', { componentDigest: 'abc' }, 'componentDigest'],
    ['an upper-case digest', { componentDigest: DIGEST.toUpperCase() }, 'componentDigest'],
    ['another basis', { basis: 'customer_said_so' }, 'basis'],
    ['a free-text runbook ref', { runbookRef: 'see the email from the customer' }, 'runbookRef'],
    ['no recorder', { recordedBy: ' ' }, 'recordedBy'],
    ['no audit hook', { auditWithin: null }, 'auditWithin'],
    ['no sheet', { sheetId: '' }, 'sheetId'],
  ]) {
    const error = await refusal(store.recordRemnantAcknowledgement(recordInput(hook, extra)))
    assert.equal(error.code, CODES.INPUT_INVALID, label)
    assert.equal(error.details.field, field, label)
  }
  for (const [label, extra, field] of [
    ['a malformed id', { rulingId: 'id with spaces' }, 'rulingId'],
    ['a free-text runbook ref', { runbookRef: 'x'.repeat(65) }, 'runbookRef'],
    ['no revoker', { revokedBy: '' }, 'revokedBy'],
  ]) {
    const error = await refusal(store.revokeRemnantAcknowledgement({ ...SCOPE, rulingId: 'cr_syn_1', runbookRef: 'R-91', revokedBy: 'u_admin', auditWithin: hook, ...extra }))
    assert.equal(error.code, CODES.INPUT_INVALID, label)
    assert.equal(error.details.field, field, label)
  }
  assert.equal(fake.log.length, 0, 'no IO')
  assert.throws(() => createStockPreparationComponentRulingStore({}), /scoped db helper/)
})

test('CR-07 the migration text and the store agree; the kit models 107 (and dropping its unique index is caught by CR-02\'s shape)', async () => {
  const enums = kit.parsedEnums()
  assert.deepEqual(enums.kind, [...COMPONENT_RULING_KINDS])
  assert.deepEqual(enums.status, [...COMPONENT_RULING_STATUSES])
  assert.deepEqual(enums.basis, [...REMNANT_ACKNOWLEDGEMENT_BASES])
  const code = kit.sqlCode(kit.migrationText())
  assert.match(code, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${ACTIVE_UNIQUE_INDEX}\\s+ON ${kit.TABLE} \\(sheet_id, project_no, component_digest, kind\\)\\s+WHERE status = 'active';`))
  for (const constraint of Object.keys(kit.SHAPE_CHECKS)) assert.ok(code.includes(`CONSTRAINT ${constraint} CHECK`) || code.includes(`CONSTRAINT ${constraint}\n`), `107 names ${constraint}`)
  const runbookChecks = code.match(/\^\[A-Za-z0-9\._:-\]\{1,64\}\$/g) || []
  assert.equal(runbookChecks.length, 2, 'both runbook handles are shape-checked in 107')
  assert.equal(RUNBOOK_REF_PATTERN.source, '^[A-Za-z0-9._:-]{1,64}$')
  assert.match(code, /component_digest ~ '\^\[0-9a-f\]\{24\}\$'/)
  // The kit refuses the wrong shapes the way 107 does (by name).
  const fake = kit.createComponentRulingFakeDb()
  const base = { id: 'cr_x', tenant_id: 't', sheet_id: 's', project_no: 'p', component_digest: DIGEST, kind: 'remnant_acknowledged', basis: 'head_not_ordered', rules: null, position_fingerprint: null, status: 'active', runbook_ref: 'R-91', recorded_by: 'u', recorded_at: AT, revoked_by: null, revoked_at: null, revoked_runbook_ref: null, updated_at: AT }
  for (const [patch, constraint] of [
    [{ kind: 'other' }, `${kit.TABLE}_kind_check`],
    [{ basis: null }, `${kit.TABLE}_kind_shape_check`],
    [{ rules: [] }, `${kit.TABLE}_kind_shape_check`],
    [{ status: 'revoked' }, `${kit.TABLE}_revoked_shape_check`],
    [{ revoked_at: AT }, `${kit.TABLE}_revoked_shape_check`],
    [{ component_digest: 'xyz' }, `${kit.TABLE}_digest_shape_check`],
  ]) {
    assert.throws(() => fake.seed({ ...base, ...patch }), (error) => error.code === '23514' && error.constraint === constraint, JSON.stringify(patch))
  }
  // The mutation probe: WITHOUT the partial unique index a second active acknowledgement lands — exactly what CR-02 refuses.
  const unguarded = kit.createComponentRulingFakeDb({ withoutUniqueIndex: true })
  const store = storeOn(unguarded)
  await store.recordRemnantAcknowledgement(recordInput(async () => {}))
  await store.recordRemnantAcknowledgement(recordInput(async () => {}))
  assert.equal(unguarded.rows().length, 2, 'the index is what refuses the second (witness)')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-component-ruling-store.test.cjs', tests)
