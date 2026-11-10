'use strict'

// 备料 batch-refresh step 6d-1b (S6-5; register row R-91) — THE CENSUS ROUTES and THE REMNANT ACKNOWLEDGEMENT through the
// real route table (step-6 design §6.5 as rebaselined; SC-03 / SC-04 / SC-05). The project-sheet harness mounts every
// route with the real registry store, the real refresh governance and a fake host; the component ruling ledger is the
// REAL store over the faithful 107 fake (support/stock-preparation-component-ruling-kit.cjs).
//
//   SC-01  tiers: all four are stock-prep:admin — a puller and the floor are 403 at the gate; a tenantless platform admin
//          is refused by the operator scope; zero records IO and zero ledger IO on a refusal
//   SC-02  the project-sheets switch off: 404 DISABLED after the gate with zero IO (no scope lookup, no records, no ledger)
//   SC-03  the tenant-wide census: per registry row (creation order, stable ordinals, cursor / limit), the counts of the
//          census module, the governed token and the acknowledgement counts; a row whose sheet cannot be read answers
//          incomplete with a closed reason and NO counts; no component handle; audited project_board_read /
//          sheet_census_read with counts only BEFORE the answer (a refusing audit store => no answer)
//   SC-03b the closed query keys and values: 400 before any IO
//   SC-04  the project census: the D2 components by their private handle; an archived project answers too; audited
//   SC-05  the acknowledgement: the closed body and the typed number (400 before IO); a handle that is not a remnant on a
//          fresh read is 409 NOT_PRESENT (nothing written, no audit row); a recorded one is ONE transaction (row + audit
//          via appendWithin); a second is 409; the revoke flips it (409 on a second revoke, 404 for an unknown id);
//          readiness v5 (the pilot GET) refuses before, passes after, and refuses again after the revoke
//   SC-06  an archived project cannot be acknowledged (409 ARCHIVED, nothing written)
//   SC-07  no ruling ledger wired: the acknowledgement routes 501 by name; the census still answers its counts, with the
//          acknowledgement counts null (never zero)
//   SC-09  (#6842 fix round 1) an installed pack human column the action does NOT declare: the host field read answers no
//          id, the cell sits under the PHYSICAL id (the host's getFieldId derivation); both forms count its hidden fills
//   SC-10  the pack read is strict on both forms: a ledger, host field read or id-derivation failure is the list row
//          incomplete / pack_unreadable with no counts and the project form 503 PACK_UNREADABLE (never template-only)
// Every value is synthetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const rulingKit = require('./support/stock-preparation-component-ruling-kit.cjs')
const { createStockPreparationComponentRulingStore, COMPONENT_RULING_ERROR_CODES } = require(path.join(LIB, 'stock-preparation-component-ruling-store.cjs'))
const { REMNANT_ACKNOWLEDGEMENT_ERROR_CODES } = require(path.join(LIB, 'stock-preparation-remnant-acknowledgement.cjs'))
const { SHEET_CENSUS_COUNT_KEYS, __internals: { componentHandle } } = require(path.join(LIB, 'stock-preparation-sheet-census.cjs'))
const { STOCK_PREP_ADMIN, STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-sc-a'
const PROJECT = 'PRJ-SC-01'
const PROJECT_2 = 'PRJ-SC-02'
const PROJECT_3 = 'PRJ-SC-03'
const PATHS = Object.freeze({
  list: '/api/integration/stock-preparation/project-targets/census',
  project: '/api/integration/stock-preparation/projects/:projectNo/target/census',
  acknowledge: '/api/integration/stock-preparation/projects/:projectNo/target/remnant-acknowledgements',
  revoke: '/api/integration/stock-preparation/projects/:projectNo/target/remnant-acknowledgements/:acknowledgementId/revoke',
  pilot: '/api/integration/stock-preparation/projects/:projectNo/target/pilot',
})
const ADMIN = Object.freeze({ id: 'u_sc_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PULLER = Object.freeze({ id: 'u_sc_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const OPERATOR = Object.freeze({ id: 'u_sc_operate', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const TENANTLESS_ADMIN = Object.freeze({ id: 'u_sc_platform', roles: ['admin'], permissions: ['integration:admin'] })
const HANDLE_S1 = componentHandle(TENANT, PROJECT, 'S1')

function mount({ switchOn = true, ruling = true } = {}) {
  const fake = rulingKit.createComponentRulingFakeDb()
  let n = 0
  const store = createStockPreparationComponentRulingStore({ db: fake.db, idGenerator: () => `cr_sc_${(n += 1)}`, now: () => new Date('2026-11-10T04:00:00Z') })
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn,
    serviceExtras: ruling ? { stockPreparationComponentRulingStore: store } : {},
  })
  return Object.assign(h, { rulingFake: fake, rulingStore: store })
}

const call = (h, method, routePath, req) => harness.call(h.routes, method, routePath, req)

function dataOf(res) {
  assert.ok(res.statusCode < 300, `expected a 2xx, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  return res.body.data
}

function expectRefusal(res, status, code) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body))
  if (code !== undefined) assert.equal(res.body.error.code, code, JSON.stringify(res.body.error))
  return res.body.error
}

/** Rows on the harness host (physical keys, the given project number) — what the project-scoped read answers. */
async function seedSheetRows(h, seeded, projectNo, rows) {
  const physical = (fieldId) => h.provisioning.getFieldId(h.staging, seeded.objectId, fieldId)
  for (const row of rows) {
    const data = Object.fromEntries(Object.entries({ projectNo, active: true, ...row }).map(([key, value]) => [physical(key), value]))
    await h.records.createRecord({ sheetId: seeded.sheetId, data })
  }
}
const r = (component, parent = null, active = true) => ({ componentSourceId: component, parentSourceId: parent, active, idempotencyKey: JSON.stringify([component, parent]) })
// D2 on S1: the old root INACTIVE, S1 active under P1.
const D2 = [r('P1'), r('S1', null, false), r('S1', 'P1')]

const ackBody = (extra = {}) => ({ confirmProjectNo: PROJECT, componentHandle: HANDLE_S1, basis: 'head_not_ordered', runbookRef: 'R-91.ack-01', acknowledge: { customerAnswered: true }, ...extra })

test('SC-01 tiers: all four are ADMIN; a puller / the floor are 403 at the gate, a tenantless platform admin is refused by the scope; zero records and ledger IO', async () => {
  const h = mount()
  try {
    const seeded = h.seedRegistryRow(PROJECT)
    await seedSheetRows(h, seeded, PROJECT, D2)
    const requests = [
      ['GET', PATHS.list, { query: {} }],
      ['GET', PATHS.project, { params: { projectNo: PROJECT }, query: {} }],
      ['POST', PATHS.acknowledge, { params: { projectNo: PROJECT }, body: ackBody() }],
      ['POST', PATHS.revoke, { params: { projectNo: PROJECT, acknowledgementId: 'cr_sc_1' }, body: { confirmProjectNo: PROJECT, runbookRef: 'R-91.rev' } }],
    ]
    h.records.calls.length = 0
    for (const user of [PULLER, OPERATOR]) {
      for (const [method, routePath, req] of requests) {
        const res = await call(h, method, routePath, { ...req, user })
        assert.equal(res.statusCode, 403, `${user.id} ${routePath}: ${JSON.stringify(res.body)}`)
      }
    }
    for (const [method, routePath, req] of requests) {
      const res = await call(h, method, routePath, { ...req, user: TENANTLESS_ADMIN })
      assert.ok([400, 403].includes(res.statusCode), `tenantless ${routePath}: ${res.statusCode} ${JSON.stringify(res.body)}`)
      assert.notEqual(res.statusCode, 200)
    }
    assert.deepEqual(h.records.calls, [], 'no records IO on any refusal')
    assert.deepEqual(h.rulingFake.log, [], 'no ledger IO on any refusal')
    assert.deepEqual(h.auditAppends, [])
  } finally { h.restore() }
})

test('SC-02 the project-sheets switch off: 404 DISABLED after the gate, zero IO', async () => {
  const h = mount({ switchOn: false })
  try {
    for (const [method, routePath, req] of [
      ['GET', PATHS.list, { query: {} }],
      ['GET', PATHS.project, { params: { projectNo: PROJECT }, query: {} }],
      ['POST', PATHS.acknowledge, { params: { projectNo: PROJECT }, body: ackBody() }],
      ['POST', PATHS.revoke, { params: { projectNo: PROJECT, acknowledgementId: 'cr_sc_1' }, body: { confirmProjectNo: PROJECT, runbookRef: 'R-91.rev' } }],
    ]) {
      expectRefusal(await call(h, method, routePath, { ...req, user: ADMIN }), 404, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      // The gate still comes first.
      assert.equal((await call(h, method, routePath, { ...req, user: PULLER })).statusCode, 403)
    }
    assert.deepEqual(h.tenantDirectoryCalls, [], 'not even the scope lookup')
    assert.deepEqual(h.records.calls, [])
    assert.deepEqual(h.rulingFake.log, [])
    assert.deepEqual(h.auditAppends, [])
  } finally { h.restore() }
})

test('SC-03 the tenant-wide census: counts per registry row, stable ordinals and the cursor, an unreadable sheet is incomplete with no counts, no handle, audited (counts only) before the answer', async () => {
  const h = mount()
  try {
    const one = h.seedRegistryRow(PROJECT)
    const two = h.seedRegistryRow(PROJECT_2)
    const three = h.seedRegistryRow(PROJECT_3, { archived: true })
    await seedSheetRows(h, one, PROJECT, D2)
    await seedSheetRows(h, two, PROJECT_2, [r('P2'), r('C2', 'P2')])
    await seedSheetRows(h, three, PROJECT_3, [r('S3'), r('S3', 'P3')])
    // The second sheet's read fails (a host failure): that ROW is incomplete, the page still answers.
    const query = h.records.queryRecords
    h.records.queryRecords = async (input) => {
      if (input.sheetId === two.sheetId) throw Object.assign(new Error(`host down ${two.sheetId}`), { code: 'SYN_DOWN' })
      return query(input)
    }
    const page = dataOf(await call(h, 'GET', PATHS.list, { user: ADMIN, query: {} }))
    assert.equal(page.total, 3)
    assert.equal(page.nextCursor, null)
    assert.deepEqual(page.items.map((item) => [item.ordinal, item.objectId, item.registryStatus, item.status]), [
      [1, one.objectId, 'active', 'complete'],
      [2, two.objectId, 'active', 'incomplete'],
      [3, three.objectId, 'archived', 'complete'],
    ])
    const [first, second, third] = page.items
    assert.equal(first.inactiveRootRemnantComponents, 1)
    assert.equal(first.twoCopyComponents, 0)
    assert.equal(first.rowCount, 3)
    assert.equal(first.activeRowCount, 2)
    assert.equal(first.acknowledgedComponents, 0)
    assert.equal(first.unacknowledgedRemnantComponents, 1)
    assert.equal(first.governed, 'none')
    assert.equal(second.reason, 'rows_unreadable')
    for (const key of SHEET_CENSUS_COUNT_KEYS) assert.ok(!(key in second), `an incomplete row carries no ${key}`)
    assert.equal(third.twoCopyComponents, 1, 'an archived project is counted too (read target)')
    const text = JSON.stringify(page)
    assert.ok(!text.includes(HANDLE_S1) && !text.includes(PROJECT) && !text.includes('host down'), 'no handle, no project number, no error text')
    // The audit row: before the answer, counts only.
    assert.equal(h.auditAppends.length, 1)
    const entry = h.auditAppends[0]
    assert.equal(entry.action, 'project_board_read')
    assert.equal(entry.mode, 'sheet_census_read')
    assert.equal(entry.projectId, undefined, 'the board read carries no project number')
    assert.deepEqual({ ...entry.detail }, { operation: 'sheet_census_list', total: 3, itemCount: 3, completeCount: 2, incompleteCount: 1, remnantComponents: 1, unacknowledgedRemnantComponents: 1, rulingsUnreadableCount: 0, tenantClaimVerified: entry.detail.tenantClaimVerified })
    // Paging: limit 1 from cursor 1 answers ordinal 2 and points at 2.
    const paged = dataOf(await call(h, 'GET', PATHS.list, { user: ADMIN, query: { cursor: '1', limit: '1' } }))
    assert.deepEqual(paged.items.map((item) => item.ordinal), [2])
    assert.equal(paged.nextCursor, '2')
    // A refusing audit store: no answer.
    h.services.stockPreparationAuditStore.append = async () => { throw Object.assign(new Error('audit refused'), { status: 503, code: 'AUDIT_STORE_UNAVAILABLE' }) }
    expectRefusal(await call(h, 'GET', PATHS.list, { user: ADMIN, query: {} }), 503, 'AUDIT_STORE_UNAVAILABLE')
  } finally { h.restore() }
})

test('SC-03b the closed query keys and values: 400 before any IO', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.records.calls.length = 0
    for (const query of [{ projectNo: PROJECT }, { cursor: '-1' }, { limit: '11' }, { workspaceId: 'w' }]) {
      const res = await call(h, 'GET', PATHS.list, { user: ADMIN, query })
      expectRefusal(res, 400, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.REQUEST_INVALID)
    }
    expectRefusal(await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: PROJECT }, query: { cursor: '1' } }), 400)
    assert.deepEqual(h.records.calls, [])
    assert.deepEqual(h.tenantDirectoryCalls, [])
  } finally { h.restore() }
})

test('SC-04 the project census: the D2 components by their private handle with their acknowledgement; an archived project answers too; audited', async () => {
  const h = mount()
  try {
    const one = h.seedRegistryRow(PROJECT)
    await seedSheetRows(h, one, PROJECT, D2)
    const answer = dataOf(await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: PROJECT }, query: {} }))
    assert.equal(answer.projectNo, PROJECT)
    assert.equal(answer.status, 'complete')
    assert.equal(answer.registryStatus, 'active')
    assert.equal(answer.inactiveRootRemnantComponents, 1)
    assert.deepEqual(answer.components, [{ componentHandle: HANDLE_S1, acknowledgement: null }])
    assert.equal(answer.rulingsReadable, true)
    assert.equal(answer.unacknowledgedRemnantComponents, 1)
    assert.equal(answer.governed, 'none', 'the refresh-state derivation\'s token (a not-governed project)')
    assert.ok(!JSON.stringify(answer).includes('"S1"'), 'no component id, only its handle')
    const entry = h.auditAppends[h.auditAppends.length - 1]
    assert.equal(entry.mode, 'sheet_census_read')
    assert.equal(entry.detail.operation, 'sheet_census_project')
    assert.ok(!JSON.stringify(entry).includes(HANDLE_S1) && !JSON.stringify(entry).includes(PROJECT), 'the audit row carries no handle and no project number')
    const archived = h.seedRegistryRow(PROJECT_3, { archived: true })
    await seedSheetRows(h, archived, PROJECT_3, D2)
    const read = dataOf(await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: PROJECT_3 }, query: {} }))
    assert.equal(read.registryStatus, 'archived')
    assert.deepEqual(read.components.map((entry) => entry.componentHandle), [componentHandle(TENANT, PROJECT_3, 'S1')])
    expectRefusal(await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: 'PRJ-SC-404' }, query: {} }), 409, 'STOCK_PREPARATION_PROJECT_ABSENT')
  } finally { h.restore() }
})

test('SC-05 the acknowledgement: closed body, typed number, re-proof (409 NOT_PRESENT), one transaction with its audit row, 409 twice; the revoke; readiness v5 follows it', async () => {
  const h = mount()
  try {
    const one = h.seedRegistryRow(PROJECT)
    await seedSheetRows(h, one, PROJECT, D2)
    const acknowledge = (body, user = ADMIN) => call(h, 'POST', PATHS.acknowledge, { user, params: { projectNo: PROJECT }, body })
    // Pure refusals: before any IO.
    h.records.calls.length = 0
    expectRefusal(await acknowledge(ackBody({ confirmProjectNo: PROJECT_2 })), 400, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.REQUEST_INVALID)
    expectRefusal(await acknowledge(ackBody({ note: 'free text' })), 400, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.REQUEST_INVALID)
    expectRefusal(await acknowledge(ackBody({ acknowledge: { customerAnswered: false } })), 400, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.REQUEST_INVALID)
    expectRefusal(await acknowledge(ackBody({ runbookRef: 'per the call' })), 400, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.REQUEST_INVALID)
    assert.deepEqual(h.records.calls, [])
    assert.deepEqual(h.tenantDirectoryCalls, [])
    // Readiness BEFORE: the remnant refuses (among the plain mount's other failing ids).
    const failingNow = async () => dataOf(await call(h, 'GET', PATHS.pilot, { user: ADMIN, params: { projectNo: PROJECT }, query: {} })).readiness.failing
    assert.ok((await failingNow()).includes('no_unacknowledged_inactive_root_remnant'))
    // The re-proof: a handle that is no remnant of the fresh read.
    const notRemnant = await acknowledge(ackBody({ componentHandle: componentHandle(TENANT, PROJECT, 'P1') }))
    expectRefusal(notRemnant, 409, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.NOT_PRESENT)
    assert.equal(h.rulingFake.rows().length, 0, 'nothing written')
    assert.ok(!h.auditAppends.some((entry) => entry.action === 'exception_resolve'), 'no audit row')
    // Recorded.
    const created = await acknowledge(ackBody())
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    const ack = created.body.data
    assert.equal(ack.acknowledgementId, 'cr_sc_1')
    assert.equal(ack.componentHandle, HANDLE_S1)
    assert.equal(ack.status, 'active')
    assert.equal(ack.nextStep, 'readiness_again')
    const [stored] = h.rulingFake.rows()
    assert.deepEqual([stored.tenant_id, stored.sheet_id, stored.project_no, stored.kind, stored.basis, stored.runbook_ref, stored.recorded_by], [TENANT, one.sheetId, PROJECT, 'remnant_acknowledged', 'head_not_ordered', 'R-91.ack-01', ADMIN.id])
    const audit = h.auditAppends.filter((entry) => entry.action === 'exception_resolve')
    assert.equal(audit.length, 1)
    assert.equal(audit[0].mode, 'remnant_acknowledged')
    assert.equal(audit[0].subjectId, 'cr_sc_1')
    assert.equal(audit[0].actor, ADMIN.id)
    assert.ok(!JSON.stringify(audit[0]).includes(HANDLE_S1) && !JSON.stringify(audit[0]).includes(PROJECT), 'no handle, no project number in the audit row')
    // The ledger saw ONE transaction: the insert (the audit row rides it, the harness's appendWithin pins the handle).
    assert.deepEqual(h.rulingFake.log.filter(([op]) => op !== 'select').map(([op]) => op), ['transaction', 'insertOne'])
    // Readiness AFTER: the remnant check passes.
    assert.ok(!(await failingNow()).includes('no_unacknowledged_inactive_root_remnant'))
    // The project census shows it.
    const census = dataOf(await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: PROJECT }, query: {} }))
    assert.equal(census.components[0].acknowledgement.acknowledgementId, 'cr_sc_1')
    assert.equal(census.unacknowledgedRemnantComponents, 0)
    // Twice: 409.
    expectRefusal(await acknowledge(ackBody()), 409, COMPONENT_RULING_ERROR_CODES.ALREADY_ACKNOWLEDGED)
    // The revoke.
    const revoke = (id, body = { confirmProjectNo: PROJECT, runbookRef: 'R-91.rev-01' }) => call(h, 'POST', PATHS.revoke, { user: ADMIN, params: { projectNo: PROJECT, acknowledgementId: id }, body })
    expectRefusal(await revoke('cr_sc_1', { confirmProjectNo: PROJECT_2, runbookRef: 'R-91.rev-01' }), 400)
    expectRefusal(await revoke('cr_sc_404'), 404, COMPONENT_RULING_ERROR_CODES.ACKNOWLEDGEMENT_NOT_FOUND)
    const revoked = dataOf(await revoke('cr_sc_1'))
    assert.equal(revoked.status, 'revoked')
    assert.equal(revoked.revokedRunbookRef, 'R-91.rev-01')
    const revokeAudit = h.auditAppends.filter((entry) => entry.action === 'exception_resolve').pop()
    assert.equal(revokeAudit.mode, 'remnant_acknowledgement_revoked')
    expectRefusal(await revoke('cr_sc_1'), 409, COMPONENT_RULING_ERROR_CODES.ALREADY_REVOKED)
    // Readiness after the revoke: refused again.
    assert.ok((await failingNow()).includes('no_unacknowledged_inactive_root_remnant'))
  } finally { h.restore() }
})

test('SC-06 an archived project cannot be acknowledged (409 ARCHIVED, nothing written)', async () => {
  const h = mount()
  try {
    const archived = h.seedRegistryRow(PROJECT, { archived: true })
    await seedSheetRows(h, archived, PROJECT, D2)
    expectRefusal(await call(h, 'POST', PATHS.acknowledge, { user: ADMIN, params: { projectNo: PROJECT }, body: ackBody() }), 409, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.equal(h.rulingFake.rows().length, 0)
  } finally { h.restore() }
})

test('SC-07 no ruling ledger wired: the acknowledgement routes 501 by name; the census answers its counts with the acknowledgement counts null', async () => {
  const h = mount({ ruling: false })
  try {
    const one = h.seedRegistryRow(PROJECT)
    await seedSheetRows(h, one, PROJECT, D2)
    expectRefusal(await call(h, 'POST', PATHS.acknowledge, { user: ADMIN, params: { projectNo: PROJECT }, body: ackBody() }), 501, COMPONENT_RULING_ERROR_CODES.STORE_UNAVAILABLE)
    expectRefusal(await call(h, 'POST', PATHS.revoke, { user: ADMIN, params: { projectNo: PROJECT, acknowledgementId: 'cr_sc_1' }, body: { confirmProjectNo: PROJECT, runbookRef: 'R-91.rev' } }), 501, COMPONENT_RULING_ERROR_CODES.STORE_UNAVAILABLE)
    const page = dataOf(await call(h, 'GET', PATHS.list, { user: ADMIN, query: {} }))
    assert.equal(page.items[0].inactiveRootRemnantComponents, 1)
    assert.equal(page.items[0].acknowledgedComponents, null)
    assert.equal(page.items[0].unacknowledgedRemnantComponents, null)
    const project = dataOf(await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: PROJECT }, query: {} }))
    assert.equal(project.rulingsReadable, false)
    assert.deepEqual(project.components, [{ componentHandle: HANDLE_S1, acknowledgement: null }])
    // Readiness: no ledger => the remnant check refuses even if nothing were doubled (positive evidence only).
    const pilot = dataOf(await call(h, 'GET', PATHS.pilot, { user: ADMIN, params: { projectNo: PROJECT }, query: {} }))
    assert.ok(pilot.readiness.failing.includes('no_unacknowledged_inactive_root_remnant'))
  } finally { h.restore() }
})

// Fix round 1 (#6842 review): an installed pack `ext_` HUMAN column the action does NOT declare. The host's field read
// answers { name, type, property, order } and never an id; the reader keys the unmapped cell by its PHYSICAL id.
const PACK_HUMAN = 'ext_scHumanNote'
async function installPackHumanColumn(h, seeded) {
  await h.provisioning.ensureMissingObjectFields({
    projectId: h.staging,
    objectId: seeded.objectId,
    fields: [{ id: PACK_HUMAN, name: 'SC human note', type: 'string', property: { stockPreparation: { ownership: 'human_preserved', extension: true, preserveOnRefresh: false } } }],
  })
  await h.services.stockPreparationPackInstallStore.recordInstall({
    tenantId: TENANT, projectId: h.staging, objectId: seeded.objectId, packId: 'pack_sc_synthetic', packVersion: '1',
    installedFields: [{ fieldId: PACK_HUMAN, ownership: 'human_preserved', preserveOnRefresh: false, extension: true }],
  })
}
// D2 on S1 with the hidden fills ONLY in the pack column, plus an inactive row with a template-band fill.
const D2_PACK = [
  r('P1'),
  { ...r('S1', null, false), [PACK_HUMAN]: 'SC pack fill (old root)' },
  { ...r('S1', 'P1'), [PACK_HUMAN]: 'SC pack fill (nested copy)' },
  { ...r('X1', null, false), notes: 'SC template fill' },
]

test('SC-09 an installed pack human column the action does not declare: both census forms count its hidden fills under the PHYSICAL id (the host field read carries no id)', async () => {
  const h = mount()
  try {
    const one = h.seedRegistryRow(PROJECT)
    await installPackHumanColumn(h, one)
    await seedSheetRows(h, one, PROJECT, D2_PACK)
    // The recorded facts the fix rests on: the ledger lists the column; the host field read answers no id; the cell sits
    // under the physical id; the target field map does not name the column.
    assert.deepEqual((await h.services.stockPreparationPackInstallStore.listInstalledFieldIds({ tenantId: TENANT, projectId: h.staging, objectId: one.objectId })).fieldIds, [PACK_HUMAN])
    const content = await h.provisioning.readObjectFieldsContent({ projectId: h.staging, objectId: one.objectId, fieldIds: [PACK_HUMAN] })
    assert.deepEqual(Object.keys(content[PACK_HUMAN]).sort(), ['name', 'order', 'property', 'type'])
    const physical = h.provisioning.getFieldId(h.staging, one.objectId, PACK_HUMAN)
    const stored = await h.records.queryRecords({ sheetId: one.sheetId })
    assert.equal(stored.filter((record) => typeof record.data[physical] === 'string').length, 2, 'the pack cells are stored under the physical id')
    assert.ok(stored.every((record) => !(PACK_HUMAN in record.data)), 'never under the logical id')
    const page = dataOf(await call(h, 'GET', PATHS.list, { user: ADMIN, query: {} }))
    const [row] = page.items
    assert.equal(row.status, 'complete', JSON.stringify(row))
    assert.equal(row.inactiveRootRemnantComponents, 1)
    assert.equal(row.inactiveRowsWithHumanCells, 2, 'the old root (pack fill) and X1 (template fill)')
    assert.equal(row.nestedCopiesWithHumanCells, 1, 'the nested copy (pack fill)')
    const project = dataOf(await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: PROJECT }, query: {} }))
    assert.equal(project.status, 'complete')
    assert.equal(project.inactiveRowsWithHumanCells, 2)
    assert.equal(project.nestedCopiesWithHumanCells, 1)
    assert.ok(!JSON.stringify([page, project]).includes('SC pack fill'), 'values-free: no cell value')
  } finally { h.restore() }
})

test('SC-10 the pack read is STRICT on both forms: a ledger / host field read / id derivation failure is the list row incomplete pack_unreadable with no counts and the project form 503 PACK_UNREADABLE — never a template-only count', async () => {
  const failures = {
    ledger: (h) => { h.services.stockPreparationPackInstallStore.listInstalledFieldIds = async () => { throw Object.assign(new Error('ledger down'), { code: 'SYN_DOWN' }) } },
    ledgerShape: (h) => { h.services.stockPreparationPackInstallStore.listInstalledFieldIds = async () => ({ packIds: [] }) },
    hostRead: (h) => { h.provisioning.readObjectFieldsContent = async () => { throw Object.assign(new Error('host down'), { code: 'SYN_DOWN' }) } },
    hostShape: (h) => { h.provisioning.readObjectFieldsContent = async () => null },
    derivation: (h) => { delete h.provisioning.getFieldId },
    derivationBlank: (h) => { h.provisioning.getFieldId = () => '' },
  }
  for (const [name, inject] of Object.entries(failures)) {
    const h = mount()
    try {
      const one = h.seedRegistryRow(PROJECT)
      await installPackHumanColumn(h, one)
      await seedSheetRows(h, one, PROJECT, D2_PACK)
      inject(h)
      const page = dataOf(await call(h, 'GET', PATHS.list, { user: ADMIN, query: {} }))
      const [row] = page.items
      assert.equal(row.status, 'incomplete', `${name}: ${JSON.stringify(row)}`)
      assert.equal(row.reason, 'pack_unreadable', name)
      for (const key of SHEET_CENSUS_COUNT_KEYS) assert.ok(!(key in row), `${name}: an incomplete row carries no ${key}`)
      const res = await call(h, 'GET', PATHS.project, { user: ADMIN, params: { projectNo: PROJECT }, query: {} })
      const error = expectRefusal(res, 503, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.PACK_UNREADABLE)
      assert.equal(REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.PACK_UNREADABLE, 'STOCK_PREP_SHEET_CENSUS_PACK_UNREADABLE')
      assert.ok(!JSON.stringify(res.body).includes('down'), `${name}: no error text`)
      assert.ok(error, name)
    } finally { h.restore() }
  }
})

test('SC-08 (source) the census\'s ONE project read walls the sheet to the tenant BEFORE the reader, and every census / acknowledgement handler reads rows only through it', () => {
  const fs = require('node:fs')
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('async function readStockPreparationCensusRows(')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  const wall = body.indexOf('assertTableActionTargetBelongsToTenant(')
  const read = body.indexOf('readExistingStockPreparationRows(')
  assert.ok(start > 0 && wall > 0 && read > wall, 'the wall runs before the read')
  assert.match(body, /targetProjectId: resolveIntegrationStagingProjectId\(tenantId, undefined\)/, 'the staging project is the scope\'s, never a request one')
  for (const handler of ['stockPreparationSheetCensusList', 'stockPreparationProjectSheetCensusGet', 'stockPreparationProjectRemnantAcknowledge', 'stockPreparationProjectRemnantAcknowledgementRevoke']) {
    const at = source.indexOf(`    async ${handler}(req, res) {`)
    const text = source.slice(at, source.indexOf('\n    },\n', at))
    assert.ok(at > 0, handler)
    assert.ok(!text.includes('readExistingStockPreparationRows'), `${handler} reads rows only through the walled helper`)
    assert.match(text, /requireAccess\(req, STOCK_PREP_ADMIN\)\n {6}requireProjectSheetsEnabled\(\)/, `${handler}: the ADMIN gate, then the switch, first`)
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-sheet-census-routes.test.cjs', tests)
