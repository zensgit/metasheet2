'use strict'

// 批次标识 BI-1b (design §8.7; rulings C4 / C12; register R-65) — THE STATUS READ, THE BOARD STANZA AND THE READINESS v3
// FACTS (lib/stock-preparation-pull-batch-status.cjs) and the ADMIN status route.
//
//   SS-01  switch OFF: no ledger read, no rows read (a store that throws if touched), `disabled`, values-free
//   SS-02  switch ON on a ready sheet: ready, no reasons; columns are BOOLEANS (no field id anywhere)
//   SS-03  every blocking reason on its own; the advisory ones never decide `ready`
//   SS-04  row classes: C4 evidence vs non-plugin creator-less rows; person rows; parked manual / unbound prefix rows
//          (critic M10: a sheet without prefix rows reads null-safely); locked rows; unknown labels
//   SS-05  the layout read is capability-detected (absent ⇒ layout: null, trashedRecordCount: null)
//   SS-06  readiness v3: the six booleans off one status; the OFF status (zero IO) fails all six
//   SS-07  the board stanza: ready / each pause / fail-soft (never throws)
//   SR-01  the route: 403 below ADMIN; 404 with the project-sheets switch off and ZERO IO; a tenantless platform admin
//          refused; absent / archived answer ready:false; OFF ⇒ FLAT answer, switchOn:false, no ledger read; ON ⇒ the
//          status; no `fld_` and no pullBatch key in any answer; the handler is registered values-free
//   SR-02  the board: OFF ⇒ exactly the frozen keys (no pullBatch); ON ⇒ the stanza; a ledger failure is fail-soft
//
// Every value is synthetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const SS = require(path.join(LIB, 'stock-preparation-pull-batch-status.cjs'))
const { pullBatchBandProperty } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { EXISTING_ROW_PULL_BATCH } = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const { EXISTING_ROWS_MANUAL_PREFIX } = require(path.join(LIB, 'stock-preparation-manual-rows.cjs'))
const { STOCK_PREPARATION_PROJECT_BOARD_KEYS, STOCK_PREPARATION_PROJECT_BOARD_OPTIONAL_KEYS } = require(path.join(LIB, 'stock-preparation-project-board.cjs'))
const { STOCK_PREP_ADMIN, STOCK_PREP_PULL, STOCK_PREP_READ, STOCK_PREP_OPERATE } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const pbKit = require('./support/stock-preparation-pull-batch-kit.cjs')
const { createStockPreparationPullBatchStore } = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const { pullBatchBandFieldDescriptors } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { PROJECT_SHEETS_ENABLED_ENV } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const BAND = Object.freeze({ fieldIds: Object.freeze({ pullBatch: 'fld_syn_pb', firstPullBatch: 'fld_syn_fpb' }) })
const KEY = (part) => JSON.stringify({ projectNo: 'SYN-S', componentSourceId: part, parentSourceId: null, path: [part] })
const row = ({ part = 'P1', key = KEY(part), stamp = 'add', pullBatch = '第1批（2026-11-08）', firstPullBatch = pullBatch, creator, locked = false } = {}) => {
  const out = { projectNo: 'SYN-S', idempotencyKey: key, componentSourceId: part, ...(stamp ? { lastPlmRefreshDecision: stamp } : {}) }
  if (creator) out[Symbol.for('metasheet.stock-preparation.existingRow.createdBy')] = creator
  out[EXISTING_ROW_PULL_BATCH] = Object.freeze({ pullBatch, firstPullBatch, createdAt: '2026-11-08T01:00:00.000Z', locked })
  return out
}

function provisioningFake({ fields = ['pullBatch', 'firstPullBatch'], property = pullBatchBandProperty('zh-CN'), computed = false, views = { 'prep-fill': [], 'prep-todo': [] }, layout } = {}) {
  const calls = []
  const p = {
    calls,
    async resolveFieldIds({ fieldIds }) { calls.push('resolveFieldIds'); return Object.fromEntries(fieldIds.map((id) => [id, id === 'pullBatch' ? BAND.fieldIds.pullBatch : BAND.fieldIds.firstPullBatch])) },
    async getObjectField({ fieldId }) { calls.push('getObjectField'); return fields.includes(fieldId) ? { id: `fld_${fieldId}`, property: JSON.parse(JSON.stringify(property)) } : null },
    async findObjectView({ viewId }) { calls.push('findObjectView'); return Object.prototype.hasOwnProperty.call(views, viewId) ? { id: `view_${viewId}`, hiddenFieldIds: views[viewId] } : null },
  }
  if (!computed) {
    p.resolveExistingObjectFieldIds = async ({ fieldIds }) => {
      calls.push('resolveExistingObjectFieldIds')
      return Object.fromEntries(fieldIds.filter((id) => fields.includes(id)).map((id) => [id, id === 'pullBatch' ? BAND.fieldIds.pullBatch : BAND.fieldIds.firstPullBatch]))
    }
  }
  if (layout !== undefined) p.describeObjectSheetLayout = async () => { calls.push('describeObjectSheetLayout'); if (layout instanceof Error) throw layout; return layout }
  return p
}

function ledgerFake({ status = 'born_empty', fail = false, batches = [] } = {}) {
  const calls = []
  return {
    calls,
    async readSheetState(input) {
      calls.push(['readSheetState', input])
      if (fail) throw Object.assign(new Error('relation missing'), { code: '42P01' })
      return { sheet: status === null ? null : { historyStatus: status, historyMode: 'inferred', historyBatchCount: 0, firstPullBatchRule: 'material', labelFormat: 'ordinal_date', labelLocale: 'zh-CN', bandPlacement: 'left' }, batches }
    },
  }
}

function deps({ enabled = true, provisioning = provisioningFake(), store = ledgerFake(), rows = [row()], readRows } = {}) {
  return {
    enabled,
    provisioning,
    projectId: 'syn_staging',
    objectId: 'obj_syn',
    tenantId: 'tenant-syn',
    sheetId: 'sheet_syn',
    projectNo: 'SYN-S',
    store,
    recordsApi: {},
    target: { sheetId: 'sheet_syn', objectId: 'obj_syn' },
    readExistingStockPreparationRows: readRows || (async () => rows),
    band: BAND,
  }
}

function untouchable() {
  return new Proxy({}, { get(_t, key) { if (typeof key === 'symbol' || key === 'then') return undefined; throw new Error(`ledger touched: ${String(key)}`) } })
}

test('SS-01 switch OFF: no ledger read and no rows read; disabled; values-free', async () => {
  let rowsRead = 0
  const status = await SS.readPullBatchStatus(deps({ enabled: false, store: untouchable(), readRows: async () => { rowsRead += 1; return [] } }))
  assert.equal(status.switchOn, false)
  assert.equal(status.ledger.readable, null)
  assert.equal(status.rows, null)
  assert.equal(rowsRead, 0, 'no rows read while off (critic M14)')
  assert.ok(status.reasons.includes('disabled'))
  assert.equal(status.ready, false)
  assert.equal(status.columns.pullBatch, true, 'host reads still answer while off')
  assert.equal(JSON.stringify(status).includes('fld_'), false, 'no field id')
})

test('SS-02 switch ON, a ready sheet: ready, no reasons; columns are booleans', async () => {
  const status = await SS.readPullBatchStatus(deps())
  assert.equal(status.ready, true, JSON.stringify(status.reasons))
  assert.deepEqual([...status.reasons], [])
  assert.deepEqual({ ...status.columns }, { mode: 'db', pullBatch: true, firstPullBatch: true, locked: 2 })
  assert.equal(status.ledger.readable, true)
  assert.deepEqual({ ...status.ledger.captured }, { firstPullBatchRule: 'material', labelFormat: 'ordinal_date', labelLocale: 'zh-CN' })
  assert.equal(status.placement, 'left')
  assert.equal(JSON.stringify(status).includes('fld_'), false, 'critic M14: no field id in the answer')
  for (const reason of status.reasons) assert.ok(SS.PULL_BATCH_STATUS_REASONS.includes(reason))
})

test('SS-03 every blocking reason on its own; the advisory reasons never decide ready', async () => {
  const cases = [
    ['not_installed', { provisioning: provisioningFake({ fields: [] }) }],
    ['columns_unproven', { provisioning: provisioningFake({ computed: true }) }],
    ['columns_partial', { provisioning: provisioningFake({ fields: ['pullBatch'] }) }],
    ['lock_unmarked', { provisioning: provisioningFake({ property: { humanWriteLock: 'plm_system' } }) }],
    ['ledger_unreadable', { store: ledgerFake({ fail: true }) }],
    ['ledger_unreadable', { store: null }],
    ['history_pending', { store: ledgerFake({ status: 'pending' }) }],
    ['history_pending', { store: ledgerFake({ status: null }) }],
    ['installing', { store: ledgerFake({ status: 'installing' }) }],
    ['history_gap', { rows: [row({ pullBatch: '' })] }],
    ['rows_unreadable', { readRows: async () => { throw new Error('too large') } }],
    ['band_hidden_in_view', { provisioning: provisioningFake({ views: { 'prep-fill': [BAND.fieldIds.pullBatch], 'prep-todo': [] } }) }],
    ['band_hidden_in_view', { provisioning: provisioningFake({ views: { 'prep-fill': [], 'prep-todo': ['firstPullBatch'] } }) }],
    ['band_hidden_in_view', { provisioning: provisioningFake({ views: { 'prep-fill': [] } }) }],
    // critic M13: the web's property rule hides the field in every view.
    ['band_hidden_in_view', { provisioning: provisioningFake({ property: { ...pullBatchBandProperty('zh-CN'), hidden: true } }) }],
    ['band_hidden_in_view', { provisioning: provisioningFake({ property: { ...pullBatchBandProperty('zh-CN'), visible: false } }) }],
  ]
  for (const [reason, patch] of cases) {
    const status = await SS.readPullBatchStatus(deps(patch))
    assert.ok(status.reasons.includes(reason), `${reason}: ${JSON.stringify(status.reasons)}`)
    assert.equal(status.ready, false, reason)
  }
  for (const [reason, patch] of [
    ['person_rows_present', { rows: [row(), row({ part: 'P2', creator: 'u_person' })] }],
    ['locked_rows_present', { rows: [row({ locked: true })] }],
    ['landing_not_fill', { provisioning: provisioningFake({ layout: { viewCount: 3, firstView: 'other', viewsWithFrozenColumns: 0, viewsLosingFrozen: 0, personalOrderOverrides: 0, trashedRecordCount: 0 } }) }],
  ]) {
    const status = await SS.readPullBatchStatus(deps(patch))
    assert.ok(status.reasons.includes(reason), reason)
    assert.equal(status.ready, true, `${reason} is advisory`)
  }
})

test('SS-04 row classes: C4 evidence, non-plugin creator-less rows, person rows, parked manual / unbound prefix rows, locked, unknown', async () => {
  const rows = [
    row({ part: 'P1' }),
    row({ part: 'P2', pullBatch: '', firstPullBatch: '' }),
    row({ part: 'P3', firstPullBatch: '历史批次未知' }),
    row({ part: 'AUTO', key: 'auto-1', stamp: null, pullBatch: '', firstPullBatch: '' }),
    row({ part: 'FORGED', key: JSON.stringify({ forged: 1 }), stamp: null, pullBatch: '', firstPullBatch: '' }),
    row({ part: 'P4', creator: 'u_person' }),
  ]
  const plain = await SS.readPullBatchStatus(deps({ rows }))
  assert.deepEqual({ ...plain.rows }, { total: 6, machine: 3, labelled: 2, gap: 1, unknown: 1, person: 1, manual: 0, unboundPrefix: 0, nonPlugin: 2, locked: 0 })
  // Parked prefix rows ride the array's Symbol (B1). Without one, manualPrefixRowsOf answers null (critic M10).
  const parked = [row()]
  parked[EXISTING_ROWS_MANUAL_PREFIX] = Object.freeze({ manualRows: [{ recordId: 'rec_m1', row: {} }, { recordId: 'rec_m2', row: {} }], unboundKeyCount: 3, unboundRecordIds: [] })
  const withPrefix = await SS.readPullBatchStatus(deps({ rows: parked }))
  assert.equal(withPrefix.rows.manual, 2)
  assert.equal(withPrefix.rows.unboundPrefix, 3)
})

test('SS-05 the layout read is capability-detected', async () => {
  const none = await SS.readPullBatchStatus(deps())
  assert.equal(none.views.layout, null)
  assert.equal(none.trashedRecordCount, null)
  const some = await SS.readPullBatchStatus(deps({ provisioning: provisioningFake({ layout: { viewCount: 3, firstView: 'prep-fill', viewsWithFrozenColumns: 1, viewsLosingFrozen: 1, personalOrderOverrides: 2, trashedRecordCount: 4 } }) }))
  assert.deepEqual({ ...some.views.layout }, { firstView: 'fill', viewsLosingFrozen: 1, personalOrderOverrides: 2 })
  assert.equal(some.trashedRecordCount, 4)
  const failing = await SS.readPullBatchStatus(deps({ provisioning: provisioningFake({ layout: new Error('host down') }) }))
  assert.equal(failing.views.layout, null, 'a failing layout read is no layout, never a throw')
})

test('SS-06 readiness v3: six booleans off one status; the OFF status (zero IO) fails all six', async () => {
  assert.deepEqual([...SS.PULL_BATCH_READINESS_CHECK_IDS], ['pull_batch_enabled', 'pull_batch_columns_present', 'pull_batch_columns_locked', 'pull_batch_columns_visible', 'pull_batch_ledger_readable', 'pull_batch_history_resolved'])
  const ready = SS.pullBatchReadinessChecks(await SS.readPullBatchStatus(deps()))
  assert.ok(Object.values(ready).every((ok) => ok === true), JSON.stringify(ready))
  const provisioning = provisioningFake()
  const off = await SS.readPullBatchReadinessStatus({ ...deps({ enabled: false, provisioning, store: untouchable(), readRows: async () => { throw new Error('read') } }) })
  assert.deepEqual(provisioning.calls, [], 'OFF readiness: not even a host read')
  assert.ok(Object.values(SS.pullBatchReadinessChecks(off)).every((ok) => ok === false))
  const hidden = SS.pullBatchReadinessChecks(await SS.readPullBatchStatus(deps({ provisioning: provisioningFake({ views: { 'prep-fill': ['pullBatch'], 'prep-todo': [] } }) })))
  assert.equal(hidden.pull_batch_columns_visible, false)
  assert.equal(hidden.pull_batch_columns_present, true)
})

test('SS-07 the board stanza: ready, each pause, fail-soft (never throws)', async () => {
  const ready = await SS.readPullBatchBoardStanza(deps({ store: ledgerFake({ batches: [{ batchNo: 1, status: 'closed', label: '第1批（2026-11-08）' }, { batchNo: 2, status: 'void', label: '第2批（2026-11-08）' }] }) }))
  assert.deepEqual({ ...ready, latest: { ...ready.latest } }, { enabled: true, ready: true, latest: { label: '第1批（2026-11-08）', batchNo: 1 }, batchCount: 1, paused: null })
  for (const [paused, patch] of [
    ['not_installed', { provisioning: provisioningFake({ fields: [] }) }],
    ['columns_unproven', { provisioning: provisioningFake({ computed: true }) }],
    ['columns_partial', { provisioning: provisioningFake({ fields: ['firstPullBatch'] }) }],
    ['history_pending', { store: ledgerFake({ status: 'pending' }) }],
    ['installing', { store: ledgerFake({ status: 'installing' }) }],
    ['ledger_unreadable', { store: ledgerFake({ fail: true }) }],
    ['history_gap', { rows: [row({ pullBatch: '' })] }],
    ['ledger_unreadable', { readRows: async () => { throw new Error('rows') } }],
  ]) {
    const stanza = await SS.readPullBatchBoardStanza(deps(patch))
    assert.equal(stanza.paused, paused, paused)
    assert.equal(stanza.ready, false)
    assert.ok(SS.PULL_BATCH_BOARD_PAUSED_REASONS.includes(stanza.paused))
  }
  const gap = await SS.readPullBatchBoardStanza(deps({ rows: [row({ pullBatch: '' }), row({ part: 'P9', pullBatch: '' })] }))
  assert.equal(gap.gapRows, 2)
  const noTarget = await SS.readPullBatchBoardStanza({ ...deps(), target: null })
  assert.equal(noTarget.paused, 'not_installed')
})

// ── the route ──────────────────────────────────────────────────────────────────────────────────────────────────────

const TENANT = 'tenant-syn-pbs'
const PROJECT = 'SYN-PBS-01'
const STATUS = '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch'
const BOARD = '/api/integration/stock-preparation/projects/:projectNo/board'
const ADMIN = Object.freeze({ id: 'u_pbs_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PULLER = Object.freeze({ id: 'u_pbs_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const OPERATOR = Object.freeze({ id: 'u_pbs_op', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const TENANTLESS = Object.freeze({ id: 'u_pbs_tl', roles: ['admin'], permissions: ['integration:admin'] })

async function withSwitch(value, fn) {
  const original = process.env.STOCK_PREP_PULL_BATCH_ENABLED
  if (value === undefined) delete process.env.STOCK_PREP_PULL_BATCH_ENABLED
  else process.env.STOCK_PREP_PULL_BATCH_ENABLED = value
  try { return await fn() } finally { if (original === undefined) delete process.env.STOCK_PREP_PULL_BATCH_ENABLED; else process.env.STOCK_PREP_PULL_BATCH_ENABLED = original }
}

function mount({ switchOn = true, ledger = 'real', sheet = 'born_empty' } = {}) {
  const clock = pbKit.createClock('2026-11-08T01:00:00.000Z')
  const db = pbKit.createFakePullBatchDb({ clock })
  const store = ledger === 'real' ? createStockPreparationPullBatchStore({ db, now: clock.now }) : (ledger === 'untouchable' ? untouchable() : null)
  const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn, fieldReads: true, serviceExtras: store ? { stockPreparationPullBatchStore: store } : {} })
  return { ...h, db, store, sheet }
}

function seedReady(h) {
  const seeded = h.seedRegistryRow(PROJECT)
  const object = h.provisioning.objects.get(`${h.staging}/${seeded.objectId}`)
  for (const descriptor of pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'left' })) {
    object.fields.set(descriptor.id, { name: descriptor.name, type: descriptor.type, property: JSON.parse(JSON.stringify(descriptor.property)), order: descriptor.order })
  }
  h.provisioning.findObjectView = async ({ viewId }) => (viewId === 'prep-fill' || viewId === 'prep-todo' ? { id: `view_${viewId}`, hiddenFieldIds: [] } : null)
  // One machine row of the project on its sheet (what a pull wrote; the board's directory finds the project by it).
  const physical = (fieldId) => h.provisioning.getFieldId(h.staging, seeded.objectId, fieldId)
  h.records.createRecord({ sheetId: seeded.sheetId, data: { [physical('projectNo')]: PROJECT, [physical('idempotencyKey')]: JSON.stringify({ projectNo: PROJECT, componentSourceId: 'P1', parentSourceId: null, path: ['P1'] }), [physical('componentSourceId')]: 'P1', [physical('active')]: true, [physical('lastPlmRefreshDecision')]: 'add', [physical('pullBatch')]: '第1批（2026-11-08）', [physical('firstPullBatch')]: '第1批（2026-11-08）' } })
  h.records.calls.length = 0
  if (h.sheet) h.db.seed(pbKit.T.sheet, pbKit.sheetRow({ tenantId: TENANT, sheetId: seeded.sheetId, projectNo: PROJECT, status: h.sheet }))
  h.db.log.length = 0
  return seeded
}

const getStatus = (h, user = ADMIN, query = { tenantId: TENANT }) => harness.call(h.routes, 'GET', STATUS, { user, params: { projectNo: PROJECT }, query })
const getBoard = (h, user = OPERATOR) => harness.call(h.routes, 'GET', BOARD, { user, params: { projectNo: PROJECT }, query: { tenantId: TENANT } })

test('SR-01 the status route: gate, switch, scope, absent / archived, OFF (flat, no ledger), ON; values-free; registered values-free', async () => {
  assert.ok(httpRoutes.__internals.STOCK_PREPARATION_VALUES_FREE_HANDLERS.has('stockPreparationProjectPullBatchGet'))
  const h = mount({ ledger: 'untouchable' })
  try {
    const below = await getStatus(h, PULLER)
    assert.equal(below.statusCode, 403, JSON.stringify(below.body))
    const absent = await getStatus(h)
    assert.equal(absent.statusCode, 200, JSON.stringify(absent.body))
    assert.deepEqual(absent.body.data, { projectNo: PROJECT, status: 'absent', switchOn: false, ready: false, reasons: [] })
    const tenantless = await getStatus(h, TENANTLESS, {})
    assert.ok([400, 403].includes(tenantless.statusCode), JSON.stringify(tenantless.body))
    seedReady(h)
    const off = await withSwitch(undefined, () => getStatus(h))
    assert.equal(off.statusCode, 200, JSON.stringify(off.body))
    assert.equal(off.body.data.status, 'active')
    assert.equal(off.body.data.switchOn, false)
    assert.equal(off.body.data.ledger.readable, null, 'no ledger read while off')
    assert.equal(off.body.data.rows, null)
    assert.equal(off.body.data.columns.pullBatch, true, 'host reads still answer')
    assert.equal(Object.prototype.hasOwnProperty.call(off.body.data, 'pullBatch'), false, 'FLAT (P-6)')
    assert.equal(JSON.stringify(off.body).includes('fld_'), false)
  } finally { h.restore() }
  const on = mount()
  try {
    seedReady(on)
    const res = await withSwitch('true', () => getStatus(on))
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.switchOn, true)
    assert.equal(res.body.data.ready, true, JSON.stringify(res.body.data.reasons))
    assert.equal(JSON.stringify(res.body).includes('fld_'), false, 'no field id in the answer')
    assert.equal(JSON.stringify(res.body).includes(TENANT), false, 'no tenant')
    assert.ok(on.db.log.every(([method]) => !/insertOne|updateRow/.test(method)), 'reads only')
  } finally { on.restore() }
  const disabled = mount({ switchOn: false, ledger: 'untouchable' })
  try {
    disabled.provisioning.calls.length = 0
    const res = await getStatus(disabled)
    assert.equal(res.statusCode, 404, JSON.stringify(res.body))
    assert.deepEqual(disabled.provisioning.calls, [], 'zero host IO with the project-sheets switch off')
    assert.deepEqual(disabled.tenantDirectoryCalls, [], 'not even the scope lookup')
  } finally { disabled.restore() }
  assert.equal(process.env[PROJECT_SHEETS_ENABLED_ENV], undefined, 'the harness restored the env')
})

test('SR-02 the board: OFF answers exactly the frozen keys (no pullBatch); ON adds the stanza; a ledger failure is fail-soft', async () => {
  assert.deepEqual([...STOCK_PREPARATION_PROJECT_BOARD_OPTIONAL_KEYS], ['pullBatch'])
  const h = mount({ ledger: 'untouchable' })
  try {
    seedReady(h)
    const off = await withSwitch(undefined, () => getBoard(h))
    assert.equal(off.statusCode, 200, JSON.stringify(off.body))
    assert.deepEqual(Object.keys(off.body.data).sort(), [...STOCK_PREPARATION_PROJECT_BOARD_KEYS].sort(), 'OFF: exactly the frozen keys')
  } finally { h.restore() }
  const on = mount()
  try {
    seedReady(on)
    const res = await withSwitch('true', () => getBoard(on))
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(Object.keys(res.body.data).sort(), [...STOCK_PREPARATION_PROJECT_BOARD_KEYS, ...STOCK_PREPARATION_PROJECT_BOARD_OPTIONAL_KEYS].sort())
    assert.deepEqual(res.body.data.pullBatch, { enabled: true, ready: true, latest: null, batchCount: 0, paused: null })
    on.db.faults.selectOne = () => Object.assign(new Error('down'), { code: '08006' })
    const soft = await withSwitch('true', () => getBoard(on))
    assert.equal(soft.statusCode, 200, 'the board never fails for the stanza')
    assert.deepEqual(soft.body.data.pullBatch, { enabled: true, ready: false, latest: null, batchCount: null, paused: 'ledger_unreadable' })
  } finally { on.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-status.test.cjs', tests)
