'use strict'

// 批次标识 BI-2 (design §8.1, §9; register R-65) — THE INSTALL ROUTE and THE BORN-READY CREATE LEG over the real route
// stack (support/stock-preparation-project-sheet-harness.cjs), the REAL ledger store and the REAL sheet write lock over
// one faithful fake of migrations 105 + 100 (support/stock-preparation-pull-batch-kit.cjs, lockTable), and a records host
// whose envelopes carry createdAt.
//
//   IR-2   403 below ADMIN; 404 with the project-sheets switch off and ZERO IO
//   IR-3   the pull-batch switch OFF: dry_run 200 from host reads (the ledger never touched); install / abort 409
//          STOCK_PREP_PULL_BATCH_DISABLED with zero IO
//   IR-4   the closed body (tenantId, formalExport, pullBatchMeaning, unknown keys => 400 naming the field)
//   IR-5   confirmProjectNo ≠ path => 409 INSTALL_CONFIRM_MISMATCH
//   IR-6   a tenantless platform admin refused; absent / archived 409; a sheet that is not the registry's 409 OBJECT_REFUSED
//   IR-7   install without appendWithin => 501 before any write; the 088 vocabulary probe precedes every write
//   IR-8   the create route: OFF => no pullBatchBand key and no band / ledger IO (byte-identical); ON => the stanza, the
//          `_sheet` row born_empty, the birth BEFORE the registry row; a birth failure never fails the create
//   IR-9   ON end to end: dry-run -> install under the real lease -> resolved; values-free answers; the scheduled-pull
//          shape (the dry-run precheck answers WRITE_LOCKED with holderPurpose pull_batch_install while an install holds
//          the sheet)
//   IR-10  the tenancy wall (IR-RL-WALL on main): a registry row of the caller's tenant whose sheet belongs to ANOTHER
//          tenant's staging project is refused 409 TABLE_ACTION_TARGET_TENANT_MISMATCH for dry_run (switch on AND off),
//          install and abort — zero ledger statements, zero records reads, zero host writes, no audit row; the caller's
//          own sheet still answers 200
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_ADMIN, STOCK_PREP_PULL, STOCK_PREP_READ, STOCK_PREP_OPERATE } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { createStockPreparationPullBatchStore } = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const lockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const pbKit = require('./support/stock-preparation-pull-batch-kit.cjs')
const { withFakeHostWriteFence } = require('./support/stock-preparation-project-write-lock-kit.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-syn-bi2r'
const PROJECT = 'SYN-PBI-01'
const ROUTE = '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch'
const CREATE = '/api/integration/stock-preparation/projects/:projectNo/target'
const ADMIN = Object.freeze({ id: 'u_pbi_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PULLER = Object.freeze({ id: 'u_pbi_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const TENANTLESS = Object.freeze({ id: 'u_pbi_tl', roles: ['admin'], permissions: ['integration:admin'] })

async function withSwitch(value, fn) {
  const original = process.env.STOCK_PREP_PULL_BATCH_ENABLED
  if (value === undefined) delete process.env.STOCK_PREP_PULL_BATCH_ENABLED
  else process.env.STOCK_PREP_PULL_BATCH_ENABLED = value
  try { return await fn() } finally { if (original === undefined) delete process.env.STOCK_PREP_PULL_BATCH_ENABLED; else process.env.STOCK_PREP_PULL_BATCH_ENABLED = original }
}

function untouchable() {
  return new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => { throw new Error(`the ledger must not be touched: ${String(key)}`) }) })
}

/** A records host whose envelopes carry createdAt / createdBy / locked / version (what the real host answers). */
function makeEnvelopeRecords() {
  const rows = []
  const calls = []
  const api = {
    rows,
    calls,
    async queryRecords({ sheetId, filters = {}, limit, offset = 0 }) {
      calls.push('queryRecords')
      const hit = rows.filter((row) => row.sheetId === sheetId && Object.entries(filters).every(([key, value]) => String(row.data[key]) === String(value)))
      return hit.slice(offset, offset + limit).map((row) => JSON.parse(JSON.stringify(row)))
    },
    async getRecord({ recordId }) {
      calls.push('getRecord')
      const row = rows.find((entry) => entry.id === recordId)
      return row ? JSON.parse(JSON.stringify(row)) : null
    },
    async patchRecord({ recordId, changes, expectedVersion }) {
      calls.push('patchRecord')
      const row = rows.find((entry) => entry.id === recordId)
      if (!row) throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Object.assign(new Error('version'), { code: 'VERSION_CONFLICT' })
      Object.assign(row.data, changes)
      row.version += 1
      return { id: row.id, version: row.version }
    },
    async createRecord({ sheetId, data }) {
      calls.push('createRecord')
      const row = { id: `rec_${rows.length + 1}`, sheetId, version: 1, createdAt: new Date().toISOString(), createdBy: null, locked: false, data: { ...data } }
      rows.push(row)
      return JSON.parse(JSON.stringify(row))
    },
  }
  return api
}

function mount({ switchOn = true, ledger = 'real' } = {}) {
  const clock = pbKit.createClock('2026-11-08T01:00:00.000Z')
  const db = pbKit.createFakePullBatchDb({ clock, lockTable: true })
  const store = ledger === 'real' ? createStockPreparationPullBatchStore({ db, now: clock.now }) : untouchable()
  const lock = lockLib.createStockPreparationProjectWriteLock({ db })
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn,
    fieldReads: true,
    serviceExtras: { stockPreparationPullBatchStore: store, stockPreparationProjectWriteLock: lock },
  })
  const records = makeEnvelopeRecords()
  // The host fence is checked against THIS ledger db's lock row (the one lock the routes hold).
  const fenceRowExists = (fence) => db.rows(pbKit.T.lock).some((row) => row.scope_key === fence.scopeKey && row.lease_id === fence.leaseId && Number(row.fencing_epoch) === fence.fencingEpoch && row.generation_token === fence.generationToken)
  h.context.api.multitable.records = withFakeHostWriteFence(records, { lockDb: { fenceRowExists } })
  const audits = []
  h.services.stockPreparationAuditStore.appendWithin = async (trx, entry) => {
    assert.ok(trx && typeof trx.insertOne === 'function', 'appendWithin is handed the ledger transaction')
    audits.push(entry)
    return { ok: true }
  }
  // The host primitives the install needs (BI-5's two, the repair transaction), over the harness's own objects.
  const p = h.provisioning
  const views = new Map()
  p.findObjectView = async ({ viewId }) => { p.calls.push(['findObjectView', viewId]); return views.has(viewId) ? { id: `view_${viewId}`, hiddenFieldIds: [] } : null }
  p.ensureView = async ({ projectId, sheetId, descriptor }) => { p.calls.push(['ensureView', descriptor.id]); views.set(descriptor.id, true); return { id: `view_${descriptor.id}`, sheetId, name: descriptor.name, type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} } }
  p.describeObjectSheetLayout = async () => { p.calls.push(['describeObjectSheetLayout']); return { viewCount: 3, firstView: 'default', viewsWithFrozenColumns: 0, viewsLosingFrozen: 0, personalOrderOverrides: 0, trashedRecordCount: 0 } }
  p.promoteObjectViewToFirst = async ({ viewLogicalId }) => { p.calls.push(['promoteObjectViewToFirst', viewLogicalId]); return { promoted: true, alreadyFirst: false, missing: false } }
  p.runObjectFieldsRepairTransaction = async (fn) => {
    p.calls.push(['runObjectFieldsRepairTransaction'])
    return fn({
      findObjectSheet: (input) => p.findObjectSheet(input),
      resolveExistingObjectFieldIds: (input) => p.resolveExistingObjectFieldIds(input),
      readObjectFieldsContent: (input) => p.readObjectFieldsContent(input),
      ensureMissingObjectFields: (input) => p.ensureMissingObjectFields(input),
    })
  }
  return { ...h, db, store, lock, records, audits, views }
}

// A registered project sheet with PLM-locked columns, the two plugin views and two pulled rows (batch 1 then batch 2).
function seedSheet(h) {
  const seeded = h.seedRegistryRow(PROJECT)
  const object = h.provisioning.objects.get(`${h.staging}/${seeded.objectId}`)
  for (const id of PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS) if (object.fields.has(id)) object.fields.get(id).property = { humanWriteLock: 'plm_system' }
  h.views.set('prep-fill', true)
  h.views.set('prep-todo', true)
  const physical = (fieldId) => h.provisioning.getFieldId(h.staging, seeded.objectId, fieldId)
  const row = (id, createdAt, part, plannedAt) => ({
    id, sheetId: seeded.sheetId, version: 1, createdAt, createdBy: null, locked: false,
    data: {
      [physical('projectNo')]: PROJECT,
      [physical('idempotencyKey')]: JSON.stringify({ projectNo: PROJECT, componentSourceId: part, parentSourceId: null, path: [part] }),
      [physical('componentSourceId')]: part,
      [physical('path')]: JSON.stringify([part]),
      [physical('active')]: true,
      [physical('lastPlmRefreshDecision')]: 'add',
      [physical('lastPlmRefreshAt')]: plannedAt,
    },
  })
  h.records.rows.push(row('rec_r1', '2026-11-01T01:00:01.000Z', 'S-01', '2026-11-01T01:00:00.000Z'))
  h.records.rows.push(row('rec_r2', '2026-11-03T01:00:01.000Z', 'P-07', '2026-11-03T01:00:00.000Z'))
  h.provisioning.calls.length = 0
  h.records.calls.length = 0
  h.db.log.length = 0
  return { ...seeded, physical }
}

const post = (h, body, { user = ADMIN, projectNo = PROJECT } = {}) => harness.call(h.routes, 'POST', ROUTE, { user, params: { projectNo }, body })
const dryRunBody = (extra = {}) => ({ mode: 'dry_run', confirmProjectNo: PROJECT, ...extra })

test('IR-1 the route is registered separately, values-free, in the 4-space handler shape', () => {
  assert.ok(httpRoutes.__internals.STOCK_PREPARATION_VALUES_FREE_HANDLERS.has('stockPreparationProjectPullBatchInstall'))
  const source = require('node:fs').readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  assert.ok(source.includes("['POST', '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch', 'stockPreparationProjectPullBatchInstall'],"))
  assert.ok(source.includes('    async stockPreparationProjectPullBatchInstall(req, res) {'))
})

test('IR-2 403 below ADMIN; 404 with the project-sheets switch off and ZERO IO', async () => {
  const h = mount()
  try {
    seedSheet(h)
    const below = await withSwitch('true', () => post(h, dryRunBody(), { user: PULLER }))
    assert.equal(below.statusCode, 403, JSON.stringify(below.body))
  } finally { h.restore() }
  const off = mount({ switchOn: false, ledger: 'untouchable' })
  try {
    off.provisioning.calls.length = 0
    const res = await withSwitch('true', () => post(off, dryRunBody()))
    assert.equal(res.statusCode, 404, JSON.stringify(res.body))
    assert.deepEqual(off.provisioning.calls, [])
    assert.deepEqual(off.tenantDirectoryCalls, [], 'not even the scope lookup')
  } finally { off.restore() }
})

test('IR-3 (M-2B-18) the pull-batch switch OFF: dry_run answers from host reads only (the ledger is never touched); install / abort answer 409 DISABLED with zero IO', async () => {
  const h = mount({ ledger: 'untouchable' })
  try {
    seedSheet(h)
    const dry = await withSwitch(undefined, () => post(h, dryRunBody()))
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.deepEqual([dry.body.data.mode, dry.body.data.provisional, dry.body.data.switchOn, dry.body.data.settings.source], ['dry_run', true, false, 'built_in'])
    assert.equal(dry.body.data.plan.K, 2)
    for (const mode of ['install', 'abort']) {
      h.provisioning.calls.length = 0
      h.records.calls.length = 0
      h.tenantDirectoryCalls.length = 0
      const res = await withSwitch(undefined, () => post(h, { mode, confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 2 }))
      assert.equal(res.statusCode, 409, JSON.stringify(res.body))
      assert.equal(res.body.error.code, 'STOCK_PREP_PULL_BATCH_DISABLED')
      assert.deepEqual([h.provisioning.calls, h.records.calls, h.tenantDirectoryCalls], [[], [], []], `${mode}: zero IO`)
    }
  } finally { h.restore() }
})

test('IR-4 the closed body: tenantId, formalExport, pullBatchMeaning and unknown keys are 400 naming the field; mode is required', async () => {
  const h = mount()
  try {
    seedSheet(h)
    for (const [body, field] of [
      [dryRunBody({ tenantId: TENANT }), 'tenantId'],
      [dryRunBody({ formalExport: 'included' }), 'formalExport'],
      [dryRunBody({ pullBatchMeaning: 'latest' }), 'pullBatchMeaning'],
      [dryRunBody({ extra: 1 }), 'extra'],
      [{ confirmProjectNo: PROJECT }, 'mode'],
    ]) {
      const res = await withSwitch('true', () => post(h, body))
      assert.equal(res.statusCode, 400, JSON.stringify(res.body))
      assert.deepEqual([res.body.error.code, res.body.error.details.field], ['STOCK_PREP_PULL_BATCH_INSTALL_REQUEST_INVALID', field])
    }
  } finally { h.restore() }
})

test('IR-5 / IR-6 the typed project number; the tenant scope; absent / archived / not the registry\'s sheet', async () => {
  const h = mount()
  try {
    const mismatch = await withSwitch('true', () => post(h, { mode: 'dry_run', confirmProjectNo: 'SYN-OTHER' }))
    assert.deepEqual([mismatch.statusCode, mismatch.body.error.code], [409, 'STOCK_PREP_PULL_BATCH_INSTALL_CONFIRM_MISMATCH'])
    const absent = await withSwitch('true', () => post(h, dryRunBody()))
    assert.deepEqual([absent.statusCode, absent.body.error.code], [409, 'STOCK_PREPARATION_PROJECT_ABSENT'])
    const tenantless = await withSwitch('true', () => post(h, dryRunBody(), { user: TENANTLESS }))
    assert.ok([400, 403].includes(tenantless.statusCode), JSON.stringify(tenantless.body))
  } finally { h.restore() }
  const archived = mount()
  try {
    archived.seedRegistryRow(PROJECT, { archived: true })
    const res = await withSwitch('true', () => post(archived, dryRunBody()))
    assert.deepEqual([res.statusCode, res.body.error.code], [409, 'STOCK_PREPARATION_PROJECT_ARCHIVED'])
  } finally { archived.restore() }
  const moved = mount()
  try {
    seedSheet(moved)
    moved.registryRows()[0].object_id = 'plm_stock_preparation_project_overview'
    const res = await withSwitch('true', () => post(moved, dryRunBody()))
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
  } finally { moved.restore() }
})

test('IR-7 install without the in-transaction audit append => 501 before any write; the vocabulary probe precedes every write', async () => {
  const h = mount()
  try {
    seedSheet(h)
    h.services.stockPreparationAuditStore.appendWithin = undefined
    const res = await withSwitch('true', () => post(h, { mode: 'install', confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 2 }))
    assert.deepEqual([res.statusCode, res.body.error.code], [501, 'AUDIT_STORE_UNAVAILABLE'])
    assert.equal(h.db.log.some(([method]) => /insertOne|updateRow/.test(method)), false)
    assert.equal(h.records.calls.includes('patchRecord'), false)
  } finally { h.restore() }
  const probe = mount()
  try {
    seedSheet(probe)
    probe.services.stockPreparationAuditStore.supportsAction = async () => ({ supported: false, reason: 'check_constraint_rejects' })
    const res = await withSwitch('true', () => post(probe, { mode: 'install', confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 2 }))
    assert.ok(res.statusCode >= 500, JSON.stringify(res.body))
    assert.equal(probe.db.log.length, 0, 'no ledger statement before the probe passes')
  } finally { probe.restore() }
})

test('IR-8 (M-2B-20) the create route: OFF answers exactly the pre-BI-2 keys with no band or ledger IO; ON births the sheet (stanza, born_empty, before the registry row); a birth failure never fails the create', async () => {
  const PRE_BI2_CREATE_KEYS = ['created', 'customerPacks', 'grant', 'objectId', 'options', 'overview', 'plmColumnLock', 'projectNo', 'sheetId', 'status', 'todoView', 'todoViewId', 'viewId']
  const off = mount({ ledger: 'untouchable' })
  try {
    const res = await withSwitch(undefined, () => harness.call(off.routes, 'POST', CREATE, { user: PULLER, params: { projectNo: PROJECT }, body: {} }))
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    assert.deepEqual(Object.keys(res.body.data).sort(), PRE_BI2_CREATE_KEYS)
    assert.equal(off.provisioning.calls.some(([name]) => /runObjectFieldsRepairTransaction|promoteObjectViewToFirst|describeObjectSheetLayout/.test(name)), false, 'no band, landing or layout call')
    assert.equal(off.records.calls.length, 0, 'no records read for a birth')
    assert.equal(off.audits.length, 0)
  } finally { off.restore() }
  const on = mount()
  try {
    const order = []
    const registry = on.services.stockPreparationProjectTargetStore
    const create = registry.create
    registry.create = async (input) => { order.push('registry.create'); return create(input) }
    const repair = on.provisioning.runObjectFieldsRepairTransaction
    on.provisioning.runObjectFieldsRepairTransaction = async (fn) => { order.push('birth.band'); return repair(fn) }
    const res = await withSwitch('true', () => harness.call(on.routes, 'POST', CREATE, { user: PULLER, params: { projectNo: PROJECT }, body: {} }))
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.pullBatchBand, { installed: true, landingPromoted: true, reason: null })
    assert.deepEqual(order, ['birth.band', 'registry.create'], 'the birth precedes the registry row')
    const sheet = on.db.rows(pbKit.T.sheet)[0]
    assert.deepEqual([sheet.history_status, sheet.band_placement, sheet.landing_mode], ['born_empty', 'left', 'promote_prep_fill'])
    assert.deepEqual(on.audits.map((entry) => [entry.action, entry.mode]), [['project_target_create', 'pull_batch_born_ready']])
    assert.equal(JSON.stringify(on.audits).includes(PROJECT) && JSON.stringify(on.audits.map((entry) => entry.detail)).includes(PROJECT), false, 'the project number never in the detail')
  } finally { on.restore() }
  const failing = mount()
  try {
    failing.provisioning.runObjectFieldsRepairTransaction = async () => { throw Object.assign(new Error('host down'), { code: 'HOST_DOWN' }) }
    const res = await withSwitch('true', () => harness.call(failing.routes, 'POST', CREATE, { user: PULLER, params: { projectNo: PROJECT }, body: {} }))
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.pullBatchBand, { installed: false, landingPromoted: false, reason: 'birth_failed' })
    assert.equal(failing.db.rows(pbKit.T.sheet).length, 0)
  } finally { failing.restore() }
})

test('IR-9 ON end to end through the route: dry-run, install under the real sheet lease (fenced patches, holder asserted in every ledger transaction), resolved, bumped; values-free answers', async () => {
  const h = mount()
  try {
    const seeded = seedSheet(h)
    const dry = await withSwitch('true', () => post(h, dryRunBody()))
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.deepEqual([dry.body.data.run, dry.body.data.plan.K, dry.body.data.refusals], ['first_install', 2, []])
    const res = await withSwitch('true', () => post(h, { mode: 'install', confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: dry.body.data.planDigest, confirmHistoricalBatchCount: 2 }))
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual([res.body.data.resolved, res.body.data.historyStatus, res.body.data.written.rows, res.body.data.generationBumped], [true, 'backfilled', 2, true])
    const cells = h.records.rows.map((row) => [row.data[seeded.physical('pullBatch')], row.data[seeded.physical('firstPullBatch')]])
    assert.match(cells[0][0], /^(第1批（推定，|Batch 1 \(inferred, )/)
    assert.match(cells[1][0], /^(第2批（推定，|Batch 2 \(inferred, )/)
    const fenced = h.context.api.multitable.records.fakeHostFences
    assert.equal(fenced.length, 2, 'every patch carried the host write fence')
    const sheet = h.db.rows(pbKit.T.sheet)[0]
    assert.deepEqual([sheet.history_status, sheet.history_batch_count, sheet.approval_ref], ['backfilled', 2, 'R-65'])
    for (const answer of [dry.body, res.body]) {
      const text = JSON.stringify(answer)
      for (const planted of [PROJECT, 'S-01', 'P-07', 'rec_r', 'fld_', TENANT]) assert.equal(text.includes(planted), false, `${planted} leaked`)
    }
    const lockRow = h.db.rows(pbKit.T.lock)[0]
    assert.deepEqual([lockRow.lease_id, lockRow.generation_reason], [null, 'pull_batch_install'], 'released, then bumped with the install reason')
    assert.deepEqual(h.audits.map((entry) => entry.mode), ['pull_batch_install_started', 'pull_batch_installed'])
  } finally { h.restore() }
})

test('IR-10 the tenancy wall: a project the registry resolves onto another tenant\'s sheet is refused 409 for dry_run, install and abort before any ledger, records or host write', async () => {
  const OTHER = 'tenant-syn-bi2r-other'
  const cases = [
    ['dry_run', 'true', dryRunBody()],
    ['dry_run', undefined, dryRunBody()],
    ['install', 'true', { mode: 'install', confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 1 }],
    ['abort', 'true', { mode: 'abort', confirmProjectNo: PROJECT, approvalRef: 'R-65' }],
  ]
  for (const [mode, switchValue, body] of cases) {
    const label = `${mode} (switch ${switchValue})`
    const h = mount()
    try {
      // The OTHER tenant's sheet, provisioned in ITS staging project with one pulled row; then the caller's registry row
      // is pointed at it (sheet and object both the other tenant's), so neither ownership nor the derived-id fallback
      // attributes it to the caller.
      const foreign = h.seedRegistryRow(PROJECT, { tenant: OTHER })
      const planted = h.registryRows().find((r) => r.tenant_id === OTHER && r.project_no === PROJECT)
      planted.tenant_id = TENANT
      assert.notEqual(foreign.objectId, h.projectObjectId(PROJECT), 'the planted object is not the caller\'s derived one')
      h.records.rows.push({ id: 'rec_foreign_1', sheetId: foreign.sheetId, version: 1, createdAt: '2026-11-01T01:00:01.000Z', createdBy: null, locked: false, data: {} })
      h.db.log.length = 0
      h.records.calls.length = 0
      h.provisioning.calls.length = 0
      const res = await withSwitch(switchValue, () => post(h, body))
      assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'TABLE_ACTION_TARGET_TENANT_MISMATCH', label)
      assert.deepEqual({ ...res.body.error.details }, { objectId: foreign.objectId }, `${label}: the refusal names only the logical object id`)
      assert.ok(h.provisioning.calls.some((c) => c[0] === 'isSheetOwnedByProject' && c[1] === foreign.sheetId && c[2] === h.staging), `${label}: the wall ran on the resolved sheet against the caller's staging project`)
      assert.deepEqual(h.db.log, [], `${label}: zero pull-batch ledger statements`)
      assert.deepEqual(h.records.calls, [], `${label}: zero records reads or writes`)
      // The overlay's own field binding, then the wall — and nothing after it (no band, view, layout or repair call).
      assert.deepEqual(h.provisioning.calls.map((c) => c[0]), ['resolveFieldIds', 'isSheetOwnedByProject'], `${label}: the wall is the last host call`)
      assert.deepEqual(h.context.api.multitable.records.fakeHostFences, [], `${label}: no fenced host write`)
      assert.deepEqual(h.audits, [], `${label}: no audit row`)
      assert.deepEqual([h.db.rows(pbKit.T.sheet), h.db.rows(pbKit.T.lock)], [[], []], `${label}: no ledger or lease row`)
      assert.equal(h.records.rows.find((row) => row.id === 'rec_foreign_1').version, 1, `${label}: the foreign row is untouched`)
      const text = JSON.stringify(res.body)
      for (const value of [OTHER, foreign.sheetId, PROJECT]) assert.equal(text.includes(value), false, `${label}: values-free (${value === PROJECT ? 'project' : 'foreign tenant or sheet'} not named)`)
    } finally { h.restore() }
  }
  // Control: the caller's OWN registered sheet passes the same wall, switch on and off.
  for (const switchValue of ['true', undefined]) {
    const own = mount()
    try {
      seedSheet(own)
      const res = await withSwitch(switchValue, () => post(own, dryRunBody()))
      assert.equal(res.statusCode, 200, `own sheet (switch ${switchValue}): ${JSON.stringify(res.body)}`)
      assert.ok(own.provisioning.calls.some((c) => c[0] === 'isSheetOwnedByProject'), 'the control crossed the same wall')
    } finally { own.restore() }
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-install-routes.test.cjs', tests)
