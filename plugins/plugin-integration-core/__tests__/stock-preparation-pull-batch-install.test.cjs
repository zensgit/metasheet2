'use strict'

// 批次标识 BI-2 (register R-65) — THE PER-SHEET INSTALL LIBRARY (lib/stock-preparation-pull-batch-install.cjs) over a fake
// host world: the REAL project reader (table actions, with the band strip, the record ref, the created-by key and the
// manual-prefix parking) over a fake records host, a fake provisioning surface, and the REAL ledger store over the
// faithful fake of migration 105 (support/stock-preparation-pull-batch-kit.cjs). Every audit detail the install emits runs
// through the audit store's own values-free gate.
//
//   IN-1   values-free answers (a planted project number, key, part id, path, record id and field id never appear)
//   IN-2   switch OFF: dry_run reads the host only (the ledger is never touched), install / abort 409 DISABLED, no IO
//   IN-3   classes (person / nonPlugin (C4) / unbound prefix / locked untouched; M′ manual rows 人工补充 fill-blank)
//   IN-4   the PLM-lock precondition (missing / unmarked / unreadable)
//   IN-5   placement: required when a left band unfreezes a view; the tenant default never waives it (C6); right order
//   IN-6   landing: keep_current never promotes; promote once; an applied landing that differs is CONFIG_LOCKED
//   IN-7   the digest moved between the preview and the in-lease recompute => PLAN_CHANGED, the ledger untouched
//   IN-8   the attested count; unknown mode (历史批次未知 ×2, no inferred batch, live numbering after the count)
//   IN-9   approvalRef required and shape-checked before any IO
//   IN-10  crash continuation: a crash after k patches + a re-run => byte-identical labels (both rules, degenerate,
//          exceptions); IN-10b the same for a gap pass
//   IN-11  a covered row whose set cell differs => 409 PLAN_CONFLICT before the first patch
//   IN-12  VERSION_CONFLICT => one re-read, one retry; a row still blank at I5 => rows_unlabelled, never resolved
//   IN-13  FORBIDDEN (locked meanwhile) => skipped and counted
//   IN-14  rows after the plan => rows_after_plan; the extension digest installs and resolves with K = K + ext K
//   IN-15  the write budget (3 over 7 rows: remaining 4, then 1, then resolved)
//   IN-16  gap pass: exact join, appended clusters, base after the ledger; IN-16b live-labelled rows byte-identical
//   IN-17  abort: the C7 lock rule over every row's cells; a labelled gap pass cannot be aborted; abort under the lease
//   IN-18  the registry lock is never held during host IO or the writes (G11)
//   IN-19  every audit detail is flat and passes the audit store's gate (incl. the layout-null and landing-null paths)
//   IN-20  every patch names the two physical band ids only
//   IN-21  I7: the bump runs once, after the release; its failure is logged and answered generationBumped false
//   IN-22  noop on a resolved sheet without gap rows: zero host and ledger writes
//   IN-23  born ready (OFF null, ledger unreadable, rows present, band unverified, tenant right + keep_current, a row
//          arriving between the two reads)
//   IN-24  the band cannot be derived (critic C3): dry_run band_unavailable, install 503, birth provisioning_unavailable
//
// Synthetic values only (rec_*, S-01, P-07, X).

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const IN = require(path.join(LIB, 'stock-preparation-pull-batch-install.cjs'))
const PB = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const { createStockPreparationPullBatchStore } = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const TA = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const MR = require(path.join(LIB, 'stock-preparation-manual-rows.cjs'))
const TP = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const AS = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const kit = require('./support/stock-preparation-pull-batch-kit.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-syn-bi2'
const PROJECT = 'PRJ-SYN-0707'
const OBJECT_ID = `plm_stock_preparation_sandbox_p_${'a1'.repeat(12)}`
const SHEET = 'sheet_syn_bi2'
const PROJECT_ID = 'proj_syn_staging'
const BAND = Object.freeze({ fieldIds: Object.freeze({ pullBatch: 'fld_syn_pull_batch', firstPullBatch: 'fld_syn_first_pull_batch' }) })
const P_PB = BAND.fieldIds.pullBatch
const P_FPB = BAND.fieldIds.firstPullBatch
const KNOWN_FIELDS = Object.freeze(['projectNo', 'idempotencyKey', 'componentSourceId', 'path', 'active', 'lastPlmRefreshDecision', 'lastPlmRefreshAt'])
const FIELD_ID_MAP = Object.freeze(Object.fromEntries(KNOWN_FIELDS.map((id) => [id, `fld_t_${id}`])))
const UNKNOWN = '历史批次未知'
const MANUAL = '人工补充'
const P1 = '2026-10-20T01:00:00.000Z'
const P2 = '2026-10-20T02:30:00.000Z'
const NOW = '2026-10-27T01:00:00.000Z'

const codeIs = (code, status) => (error) => error && error.code === code && (status === undefined || error.status === status)
async function rejects(promise, code, label) {
  let thrown = null
  try { await promise } catch (error) { thrown = error }
  assert.ok(thrown, `${label}: expected a refusal`)
  assert.equal(thrown.code, code, `${label}: ${thrown && thrown.message}`)
  return thrown
}

// ── the fake world ─────────────────────────────────────────────────────────────────────────────────────

const pluginKey = (part, tokens) => JSON.stringify({ projectNo: PROJECT, componentSourceId: part, parentSourceId: tokens.length > 1 ? tokens[tokens.length - 2] : null, path: tokens })

/** One host record (envelope + data in PHYSICAL ids). */
function record(id, { createdAt, part = 'X', tokens, decision = 'add', plannedAt = null, active = true, createdBy, locked = false, key, pullBatch, firstPullBatch, version = 1 } = {}) {
  const pathTokens = tokens || [part]
  const data = {
    [FIELD_ID_MAP.projectNo]: PROJECT,
    [FIELD_ID_MAP.idempotencyKey]: key === undefined ? pluginKey(part, pathTokens) : key,
    [FIELD_ID_MAP.componentSourceId]: part,
    [FIELD_ID_MAP.path]: JSON.stringify(pathTokens),
    [FIELD_ID_MAP.active]: active,
    [FIELD_ID_MAP.lastPlmRefreshDecision]: decision,
    [FIELD_ID_MAP.lastPlmRefreshAt]: plannedAt,
  }
  if (pullBatch !== undefined) data[P_PB] = pullBatch
  if (firstPullBatch !== undefined) data[P_FPB] = firstPullBatch
  return { id, version, createdAt, locked, createdBy: createdBy || null, data }
}

function createWorld({ records = [], bandPresent = false, bandOrders = [-2, -1], bandMarked = true, views = { 'prep-fill': [], 'prep-todo': [] }, layout = { viewCount: 3, firstView: 'default', viewsWithFrozenColumns: 0, viewsLosingFrozen: 0, personalOrderOverrides: 0, trashedRecordCount: 0 }, plm = { fieldCount: 20, marked: 20, unmarked: 0, missing: 0, readBeforeWrite: true }, enabled = true, promote = true, sheetRow = null, tenantSettings = null, ledgerBatches = [], band = BAND, withLease = true } = {}) {
  const log = []
  const host = new Map(records.map((entry) => [entry.id, structuredClone(entry)]))
  const fields = new Map(KNOWN_FIELDS.map((id, index) => [id, { physical: FIELD_ID_MAP[id], order: index, property: { humanWriteLock: 'plm_system' } }]))
  if (bandPresent) {
    fields.set('firstPullBatch', { physical: P_FPB, order: bandOrders[0], property: bandMarked ? TP.pullBatchBandProperty('zh-CN') : {} })
    fields.set('pullBatch', { physical: P_PB, order: bandOrders[1], property: bandMarked ? TP.pullBatchBandProperty('zh-CN') : {} })
  }
  const viewState = new Map(Object.entries(views).filter(([, hidden]) => hidden !== null).map(([id, hidden]) => [id, { hiddenFieldIds: hidden.slice() }]))
  const state = { patchFault: null, readFault: null, registryLocked: false, leaseHeld: false, inTx: false, ioWhileRegistryLocked: [] }
  const note = (entry) => {
    log.push(entry)
    if (state.registryLocked && entry !== 'registry.lock' && entry !== 'registry.unlock') state.ioWhileRegistryLocked.push(entry)
  }
  const recordsApi = {
    supportsWriteFence: true,
    async queryRecords({ sheetId, filters, limit, offset }) {
      note('host.queryRecords')
      assert.equal(sheetId, SHEET)
      if (state.readFault) throw state.readFault
      const all = Array.from(host.values()).filter((entry) => entry.data[FIELD_ID_MAP.projectNo] === filters[FIELD_ID_MAP.projectNo]).sort((a, b) => (a.id < b.id ? -1 : 1))
      return all.slice(offset, offset + limit).map((entry) => structuredClone(entry))
    },
    async getRecord({ recordId }) {
      note('host.getRecord')
      const entry = host.get(recordId)
      return entry ? structuredClone(entry) : null
    },
    async patchRecord({ recordId, changes, expectedVersion }) {
      note('host.patchRecord')
      if (state.patchFault) {
        const fault = state.patchFault(recordId, changes)
        if (fault) throw fault
      }
      const entry = host.get(recordId)
      if (!entry) throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
      if (entry.locked) throw Object.assign(new Error('locked'), { code: 'FORBIDDEN' })
      if (expectedVersion !== entry.version) throw Object.assign(new Error('version'), { code: 'VERSION_CONFLICT' })
      Object.assign(entry.data, changes)
      entry.version += 1
      return { id: entry.id, version: entry.version }
    },
  }
  const target = { sheetId: SHEET, objectId: OBJECT_ID, fieldIdMap: { ...FIELD_ID_MAP } }
  const repairTx = {
    async findObjectSheet() { note('tx.findObjectSheet'); return { id: SHEET } },
    async resolveExistingObjectFieldIds({ fieldIds }) {
      note('tx.resolve')
      const out = {}
      for (const id of fieldIds) if (fields.has(id)) out[id] = fields.get(id).physical
      return out
    },
    async readObjectFieldsContent({ fieldIds }) {
      const out = {}
      for (const id of fieldIds) if (fields.has(id)) out[id] = { name: id, type: 'string', property: structuredClone(fields.get(id).property), order: fields.get(id).order }
      return out
    },
    async ensureMissingObjectFields({ fields: descriptors }) {
      note('tx.ensureMissingObjectFields')
      const added = []
      const skipped = []
      for (const descriptor of descriptors) {
        if (fields.has(descriptor.id)) { skipped.push(descriptor.id); continue }
        fields.set(descriptor.id, { physical: descriptor.id === 'pullBatch' ? P_PB : P_FPB, order: descriptor.order, property: structuredClone(descriptor.property) })
        added.push(descriptor.id)
      }
      return { addedFieldIds: added, skippedExistingFieldIds: skipped }
    },
  }
  const provisioning = {
    getFieldId: (projectId, objectId, fieldId) => (fieldId === 'pullBatch' ? P_PB : fieldId === 'firstPullBatch' ? P_FPB : `fld_t_${fieldId}`),
    async resolveExistingObjectFieldIds({ fieldIds }) { note('prov.resolve'); return repairTx.resolveExistingObjectFieldIds({ fieldIds }) },
    async getObjectField({ fieldId }) {
      const entry = fields.get(fieldId)
      return entry ? { id: entry.physical, name: fieldId, type: 'string', property: structuredClone(entry.property), order: entry.order } : null
    },
    async findObjectView({ viewId }) {
      const view = viewState.get(viewId)
      return view ? { id: `v_${viewId}`, hiddenFieldIds: view.hiddenFieldIds.slice() } : null
    },
    describeObjectSheetLayout: layout === null ? undefined : async () => { note('prov.describe'); return { ...layout } },
    promoteObjectViewToFirst: promote ? async ({ viewLogicalId }) => { note(`prov.promote:${viewLogicalId}`); return { promoted: true, alreadyFirst: false, missing: !viewState.has(viewLogicalId) } } : undefined,
    async patchObjectFieldProperty({ fieldId, propertyPatch }) {
      note(`prov.patchProperty:${fieldId}`)
      const entry = fields.get(fieldId)
      entry.property = { ...entry.property, ...structuredClone(propertyPatch) }
      return { closedAt: null, closedBy: null }
    },
    async runObjectFieldsRepairTransaction(fn) {
      note('prov.repairTx')
      const snapshot = new Map(Array.from(fields.entries()).map(([id, entry]) => [id, structuredClone(entry)]))
      try {
        return await fn(repairTx)
      } catch (error) {
        fields.clear()
        for (const [id, entry] of snapshot) fields.set(id, entry)
        throw error
      }
    },
  }
  const clock = kit.createClock(NOW)
  const db = kit.createFakePullBatchDb({ clock })
  let n = 0
  const store = createStockPreparationPullBatchStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${(n += 1)}` })
  if (sheetRow) db.seed(kit.T.sheet, kit.sheetRow({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT, ...sheetRow }))
  if (tenantSettings) db.seed(kit.T.settings, { tenant_id: TENANT, ...tenantSettings, version: 1 })
  for (const batch of ledgerBatches) db.seed(kit.T.batch, { tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, ...batch })
  const audits = []
  const world = {
    host, fields, viewState, log, state, db, store, clock, audits, recordsApi,
    cells(id) {
      const entry = host.get(id)
      return [entry.data[P_PB] === undefined ? '' : entry.data[P_PB], entry.data[P_FPB] === undefined ? '' : entry.data[P_FPB]]
    },
    sheet() {
      return db.rows(kit.T.sheet).find((row) => row.sheet_id === SHEET) || null
    },
  }
  world.deps = (extra = {}) => ({
    enabled,
    scope: { tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT },
    target,
    projectId: PROJECT_ID,
    band,
    store: enabled ? store : null,
    provisioning,
    knownFieldIds: KNOWN_FIELDS,
    readRows: () => TA.__internals.readExistingStockPreparationRows(recordsApi, target, PROJECT, { pullBatchBand: band || undefined }),
    parkedManualRowsOf: MR.manualPrefixRowsOf,
    readPlmLock: async () => { note('plm.read'); if (plm instanceof Error) throw plm; return { ...plm } },
    bandDescriptors: TP.pullBatchBandFieldDescriptors,
    bandPropertyOf: TP.pullBatchBandProperty,
    isBandProperty: TP.isPullBatchBandProperty,
    ensureFillView: async () => { note('prov.ensureView:prep-fill'); viewState.set('prep-fill', { hiddenFieldIds: [] }) },
    ensureTodoView: async () => { note('prov.ensureView:prep-todo'); viewState.set('prep-todo', { hiddenFieldIds: [] }) },
    labelLocale: () => 'zh-CN',
    readRecord: (recordId) => recordsApi.getRecord({ sheetId: SHEET, recordId }),
    patchBandCellsFor: (guard) => async ({ recordId, changes, expectedVersion }) => {
      if (withLease) assert.ok(guard && state.leaseHeld, 'every patch runs inside the lease')
      return recordsApi.patchRecord({ sheetId: SHEET, recordId, changes, expectedVersion })
    },
    withLease: withLease ? async (fn) => {
      note('lease.acquire')
      state.leaseHeld = true
      try {
        return await fn({ withHostWrite: (inner) => inner(), hostWriteFence: () => ({ leaseId: 'lease_syn' }), scopeKey: 'scope_syn', fencingEpoch: 1 })
      } finally {
        state.leaseHeld = false
        note('lease.release')
      }
    } : undefined,
    holderWithinFor: () => async () => { note('holder.assert') },
    bumpAfterRelease: async () => { note('bump'); assert.equal(state.leaseHeld, false, 'the bump runs after the release') },
    withRegistryLock: async (fn) => {
      note('registry.lock')
      state.registryLocked = true
      try {
        return await fn({ sheetId: SHEET, objectId: OBJECT_ID })
      } finally {
        state.registryLocked = false
        note('registry.unlock')
      }
    },
    auditWithin: async (trx, entry) => {
      AS.__internals.assertValuesFreeDetail(entry.detail)
      for (const column of [entry.mode, entry.subjectId]) assert.ok(AS.__internals.SAFE_STRING_PATTERN.test(column), 'mode / subject are enum-shaped')
      audits.push(structuredClone({ mode: entry.mode, detail: entry.detail }))
    },
    actor: 'u_admin_syn',
    logger: { warn: (message, fields2) => log.push(`warn:${JSON.stringify(fields2)}`) },
    writeBudget: IN.PULL_BATCH_INSTALL_WRITE_BUDGET,
    ...extra,
  })
  return world
}

// The C09 history (batch 1: S-01 ⊃ C swept by batch 2: P-07 ⊃ S-01 ⊃ C, 30 min later).
const c09 = () => [
  record('rec_01', { createdAt: '2026-10-20T02:00:01.000Z', part: 'S-01', decision: 'inactive', plannedAt: P2, active: false }),
  record('rec_02', { createdAt: '2026-10-20T02:00:02.000Z', part: 'C', tokens: ['S-01', 'C'], decision: 'inactive', plannedAt: P2, active: false }),
  record('rec_03', { createdAt: '2026-10-20T02:30:01.000Z', part: 'P-07', decision: 'add', plannedAt: P2 }),
  record('rec_04', { createdAt: '2026-10-20T02:30:02.000Z', part: 'S-01', tokens: ['P-07', 'S-01'], decision: 'add', plannedAt: P2 }),
  record('rec_05', { createdAt: '2026-10-20T02:30:03.000Z', part: 'C', tokens: ['P-07', 'S-01', 'C'], decision: 'add', plannedAt: P2 }),
]

const dryRun = (world, extra = {}, depsExtra = {}) => IN.runPullBatchInstallRequest(world.deps(depsExtra), { mode: 'dry_run', confirmProjectNo: PROJECT, ...extra })
async function install(world, extraIn = {}, depsExtra = {}) {
  const { count: _count, ...extra } = extraIn
  const preview = extra.planDigest ? null : await dryRun(world, { historyMode: extra.historyMode, placement: extra.placement, landing: extra.landing, gapMinutes: extra.gapMinutes }, depsExtra)
  return IN.runPullBatchInstallRequest(world.deps(depsExtra), {
    mode: 'install',
    confirmProjectNo: PROJECT,
    approvalRef: 'R-65',
    planDigest: preview ? preview.planDigest : extra.planDigest,
    confirmHistoricalBatchCount: preview ? (extra.historyMode === 'unknown' ? 0 : preview.requires.confirmHistoricalBatchCount.inferred) : extraIn.count,
    ...extra,
  })
}
const allCells = (world) => Object.fromEntries(Array.from(world.host.keys()).sort().map((id) => [id, world.cells(id)]))

// ── the suite ─────────────────────────────────────────────────────────────────────────────────────────

test('IN-0 the closed vocabularies; the body is closed (fixed facts, tenantId, unknown keys refused naming the field), approvalRef / planDigest / count required where the mode needs them', () => {
  assert.deepEqual([...IN.PULL_BATCH_INSTALL_MODES], ['dry_run', 'install', 'abort'])
  assert.deepEqual([...IN.PULL_BATCH_INSTALL_RUNS], ['first_install', 'resume_aborted', 'continue', 'gap_pass', 'noop'])
  assert.deepEqual([...IN.PULL_BATCH_INSTALL_UNRESOLVED_REASONS], ['rows_after_plan', 'rows_unlabelled', 'write_budget'])
  assert.equal(IN.PULL_BATCH_INSTALL_LEASE_PURPOSE, 'pull_batch_install')
  assert.equal(IN.PULL_BATCH_INSTALL_WRITE_BUDGET, 2000)
  assert.ok(IN.PULL_BATCH_INSTALL_DRY_RUN_REFUSALS.includes('band_unavailable'))
  const ok = { mode: 'dry_run', confirmProjectNo: PROJECT }
  assert.equal(IN.normalizePullBatchInstallBody(ok).historyMode, 'inferred')
  for (const [body, field] of [
    [{ ...ok, tenantId: 't' }, 'tenantId'],
    [{ ...ok, formalExport: 'x' }, 'formalExport'],
    [{ ...ok, pullBatchMeaning: 'x' }, 'pullBatchMeaning'],
    [{ ...ok, 'a b': 1 }, 'body'],
    [{ ...ok, mode: 'run' }, 'mode'],
    [{ mode: 'dry_run' }, 'confirmProjectNo'],
    [{ ...ok, mode: 'install', planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 1 }, 'approvalRef'],
    [{ ...ok, mode: 'install', approvalRef: 'R-65', confirmHistoricalBatchCount: 1 }, 'planDigest'],
    [{ ...ok, mode: 'install', approvalRef: 'R-65', planDigest: 'a'.repeat(64) }, 'confirmHistoricalBatchCount'],
    [{ ...ok, mode: 'abort' }, 'approvalRef'],
    [{ ...ok, historyMode: 'guess' }, 'historyMode'],
    [{ ...ok, placement: 'middle' }, 'placement'],
    [{ ...ok, landing: 'x' }, 'landing'],
    [{ ...ok, gapMinutes: 0 }, 'gapMinutes'],
    [{ ...ok, planDigest: 'A'.repeat(64) }, 'planDigest'],
  ]) {
    assert.throws(() => IN.normalizePullBatchInstallBody(body), (error) => error.code === PB.PULL_BATCH_ERROR_CODES.INSTALL_REQUEST_INVALID && error.status === 400 && error.details.field === field, field)
  }
})

test('IN-1 (M-2B-17) values-free answers: no project number, key, part id, path, record id or field id in a dry-run, install or abort answer', async () => {
  const world = createWorld({ records: c09() })
  const preview = await dryRun(world)
  const done = await install(world)
  assert.equal(done.resolved, true)
  for (const answer of [preview, done]) {
    const text = JSON.stringify(answer)
    for (const planted of [PROJECT, 'S-01', 'P-07', 'rec_0', 'fld_', '{"projectNo', OBJECT_ID, SHEET]) assert.equal(text.includes(planted), false, `${planted} leaked`)
  }
  assert.equal(preview.plan.K, 2)
  assert.deepEqual(preview.plan.clusters.map((cluster) => [cluster.k, cluster.evidence, cluster.rows]), [[1, 'created_at', 2], [2, 'plan_time', 3]])
})

test('IN-2 (M-2B-18) switch OFF: the dry-run reads the host only — a store whose every method throws is never touched, provisional, built-in defaults; install and abort answer 409 DISABLED before any IO', async () => {
  const world = createWorld({ records: c09(), enabled: false })
  const exploding = new Proxy({}, { get: () => () => { throw new Error('the ledger must not be touched') } })
  const answer = await dryRun(world, {}, { store: exploding })
  assert.equal(answer.provisional, true)
  assert.equal(answer.switchOn, false)
  assert.equal(answer.settings.source, 'built_in')
  assert.ok(answer.refusals.includes('disabled'))
  assert.equal(answer.plan.K, 2, 'the plan is computed from the host read')
  world.log.length = 0
  for (const mode of ['install', 'abort']) {
    await rejects(IN.runPullBatchInstallRequest(world.deps({ store: exploding }), { mode, confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 2 }), PB.PULL_BATCH_ERROR_CODES.DISABLED, mode)
  }
  assert.deepEqual(world.log, [], 'zero IO')
})

test('IN-3 (M-2B-10/11/12) classes: person, nonPlugin (automation-like and forged-key rows, C4), unbound prefix and locked rows are never written and are counted; M′ manual rows get the band\'s 人工补充 fill-blank', async () => {
  const records = [
    ...c09(),
    record('rec_10', { createdAt: '2026-10-20T02:30:04.000Z', part: 'X', createdBy: 'u_person' }),
    record('rec_11', { createdAt: '2026-10-20T02:30:05.000Z', part: 'Y', key: 'automation:row' }),
    record('rec_12', { createdAt: '2026-10-20T02:30:06.000Z', part: 'Z', decision: '' }),
    record('rec_13', { createdAt: '2026-10-20T02:30:07.000Z', part: 'W', locked: true }),
    record('rec_14', { createdAt: '2026-10-20T02:30:08.000Z', part: 'M', key: 'manual:v1:rec_14', createdBy: 'u_person' }),
    record('rec_15', { createdAt: '2026-10-20T02:30:09.000Z', part: 'M2', key: 'manual:v1:rec_other', createdBy: 'u_person' }),
    record('rec_16', { createdAt: '2026-10-20T02:30:10.000Z', part: 'M3', key: 'manual:v1:rec_16', createdBy: 'u_person', pullBatch: MANUAL }),
  ]
  const world = createWorld({ records })
  const preview = await dryRun(world)
  assert.deepEqual(
    [preview.classes.machine, preview.classes.person, preview.classes.nonPlugin, preview.classes.locked, preview.classes.manual, preview.classes.manualBlank, preview.classes.unboundPrefix],
    [5, 1, 2, 1, 2, 2, 1],
  )
  const done = await install(world)
  assert.equal(done.resolved, true)
  for (const id of ['rec_10', 'rec_11', 'rec_12', 'rec_13', 'rec_15']) assert.deepEqual(world.cells(id), ['', ''], `${id} untouched`)
  assert.deepEqual(world.cells('rec_14'), [MANUAL, MANUAL])
  assert.deepEqual(world.cells('rec_16'), [MANUAL, MANUAL], 'fill-blank: the set cell kept, the blank one filled')
  assert.equal(done.written.manualRows, 2)
  assert.deepEqual([done.skipped.person, done.skipped.nonPlugin, done.skipped.unboundPrefix, done.skipped.locked], [1, 2, 1, 1])
})

test('IN-4 (M-2B-16) the PLM-lock precondition: a missing, an unmarked or an unreadable PLM column => 409 PLM_LOCK_REQUIRED with the four counts; the dry-run names plm_lock_required', async () => {
  for (const [label, plm] of [
    ['missing', { fieldCount: 20, marked: 19, unmarked: 0, missing: 1, readBeforeWrite: true }],
    ['unmarked', { fieldCount: 20, marked: 19, unmarked: 1, missing: 0, readBeforeWrite: true }],
    ['unproven', { fieldCount: 20, marked: 0, unmarked: 0, missing: 20, readBeforeWrite: false }],
    ['unreadable', new Error('host down')],
  ]) {
    const world = createWorld({ records: c09(), plm })
    const preview = await dryRun(world)
    assert.ok(preview.refusals.includes('plm_lock_required'), label)
    const error = await rejects(install(world, { planDigest: preview.planDigest, count: 2 }), PB.PULL_BATCH_ERROR_CODES.PLM_LOCK_REQUIRED, label)
    assert.deepEqual(Object.keys(error.details).sort(), ['fieldCount', 'marked', 'missing', 'unmarked'])
    assert.equal(world.sheet(), null, `${label}: nothing persisted`)
  }
})

test('IN-5 (M-2B-14) placement: a left band that would unfreeze a view needs an explicit placement — the tenant default never waives it (C6); right goes after the last KNOWN column; an existing band\'s placement is a fact', async () => {
  const frozen = { viewCount: 3, firstView: 'default', viewsWithFrozenColumns: 1, viewsLosingFrozen: 1, personalOrderOverrides: 0, trashedRecordCount: 0 }
  const world = createWorld({ records: c09(), layout: frozen, tenantSettings: { first_pull_batch_rule: 'material', label_format: 'ordinal_date', landing_mode: 'promote_prep_fill', band_placement: 'left' } })
  const preview = await dryRun(world)
  assert.ok(preview.refusals.includes('placement_required'))
  assert.equal(preview.requires.placement, 'required')
  const error = await rejects(install(world, { planDigest: preview.planDigest, count: 2 }), PB.PULL_BATCH_ERROR_CODES.PLACEMENT_REQUIRED, 'tenant left does not waive')
  assert.equal(error.details.viewsLosingFrozen, 1)
  const done = await install(world, { placement: 'right' })
  assert.equal(done.resolved, true)
  assert.deepEqual([world.fields.get('firstPullBatch').order, world.fields.get('pullBatch').order], [KNOWN_FIELDS.length, KNOWN_FIELDS.length + 1], 'max known order + 1 / + 2')
  assert.equal(world.sheet().band_placement, 'right')
  const again = await dryRun(world, { placement: 'left' })
  assert.ok(again.refusals.includes('config_locked'), 'an existing band keeps its placement')
  const existing = createWorld({ records: c09(), bandPresent: true, bandOrders: [-2, -1] })
  const fact = await dryRun(existing)
  assert.deepEqual([fact.settings.placement, fact.requires.placement, fact.columns.placementApplied], ['left', 'fixed', true])
})

test('IN-6 landing: keep_current never promotes; promote_prep_fill promotes once; an applied landing that differs is CONFIG_LOCKED', async () => {
  const keep = createWorld({ records: c09() })
  await install(keep, { landing: 'keep_current' })
  assert.equal(keep.log.filter((entry) => entry.startsWith('prov.promote')).length, 0)
  assert.equal(keep.sheet().landing_mode, 'keep_current')
  const promote = createWorld({ records: c09() })
  const done = await install(promote)
  assert.deepEqual(promote.log.filter((entry) => entry.startsWith('prov.promote')), ['prov.promote:prep-fill'])
  assert.equal(done.host.landingPromoted, true)
  const locked = await dryRun(keep, { landing: 'promote_prep_fill' })
  assert.ok(locked.refusals.includes('config_locked'))
})

test('IN-7 (M-2B-1) the in-lease recompute: a row flipped between the preview and the lease moves the digest => 409 PLAN_CHANGED, the ledger untouched', async () => {
  const world = createWorld({ records: c09() })
  const preview = await dryRun(world)
  const deps = world.deps()
  const inner = deps.withLease
  deps.withLease = async (fn) => {
    world.host.get('rec_03').createdAt = '2026-10-25T05:00:00.000Z'
    return inner(fn)
  }
  await rejects(IN.runPullBatchInstallRequest(deps, { mode: 'install', confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: preview.planDigest, confirmHistoricalBatchCount: 2 }), PB.PULL_BATCH_ERROR_CODES.PLAN_CHANGED, 'moved')
  assert.equal(world.sheet(), null, 'nothing persisted')
  assert.equal(world.log.includes('host.patchRecord'), false, 'no cell written')
})

test('IN-8 (M-2B-8) the attested count: inferred needs count = K; unknown mode writes 历史批次未知 in both cells, no inferred batch, and live numbering continues after the count', async () => {
  const world = createWorld({ records: c09() })
  const preview = await dryRun(world)
  const error = await rejects(install(world, { planDigest: preview.planDigest, count: 3 }), PB.PULL_BATCH_ERROR_CODES.HISTORY_COUNT_MISMATCH, 'count')
  assert.equal(error.details.K, 2)
  const done = await install(world, { planDigest: preview.planDigest, count: 5, historyMode: 'unknown' })
  assert.deepEqual([done.resolved, done.historyBatchCount, done.firstLiveBatchNo], [true, 5, 6])
  for (const id of world.host.keys()) assert.deepEqual(world.cells(id), [UNKNOWN, UNKNOWN], id)
  assert.equal(world.db.rows(kit.T.batch).length, 0, 'no inferred batch row')
  assert.deepEqual([world.sheet().history_mode, world.sheet().history_batch_count, world.sheet().history_status], ['unknown', 5, 'backfilled'])
})

test('IN-9 (M-2B-15) approvalRef: required for install / abort and shape-checked (# refused) before any IO', async () => {
  const world = createWorld({ records: c09() })
  for (const approvalRef of [undefined, '#6079', 'R-65/x']) {
    world.log.length = 0
    await rejects(IN.runPullBatchInstallRequest(world.deps(), { mode: 'install', confirmProjectNo: PROJECT, approvalRef, planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 2 }), PB.PULL_BATCH_ERROR_CODES.INSTALL_REQUEST_INVALID, String(approvalRef))
    assert.deepEqual(world.log, [], 'no IO')
  }
})

// A crash after k patches, then a re-run with the persisted digest: the union of the labels equals an uninterrupted run.
async function crashThenContinue({ records, k, extra = {}, worldExtra = {} }) {
  const control = createWorld({ records: structuredClone(records), ...worldExtra })
  await install(control, extra)
  const world = createWorld({ records: structuredClone(records), ...worldExtra })
  const preview = await dryRun(world, extra)
  let patched = 0
  world.state.patchFault = () => (patched++ >= k ? Object.assign(new Error('crash'), { code: 'HOST_DOWN' }) : null)
  await assert.rejects(install(world, { ...extra, planDigest: preview.planDigest, count: preview.requires.confirmHistoricalBatchCount.inferred }), /crash/)
  assert.equal(world.sheet().history_status, 'installing', 'the crash leaves the sheet installing')
  world.state.patchFault = null
  const resumed = await dryRun(world, extra)
  assert.equal(resumed.run, 'continue')
  assert.equal(resumed.planDigest, preview.planDigest, 'the persisted plan is reused, never recomputed')
  const done = await install(world, { ...extra, planDigest: resumed.planDigest, count: resumed.requires.confirmHistoricalBatchCount.inferred })
  assert.equal(done.resolved, true)
  assert.equal(done.run, 'continue')
  assert.deepEqual(allCells(world), allCells(control), 'byte-identical labels')
  return { control, world }
}

test('IN-10 (M-BI-17 / M-2B-19) crash continuation reproduces the persisted assignment byte-identically — both rules, a degenerate (copy-like) plan and an exception shape', async () => {
  for (const rule of ['material', 'predecessor_suffix']) {
    const tenantSettings = { first_pull_batch_rule: rule, label_format: 'ordinal_date', landing_mode: 'promote_prep_fill', band_placement: 'left' }
    for (const k of [0, 1, 3]) await crashThenContinue({ records: c09(), k, worldExtra: { tenantSettings } })
  }
  const degenerate = [
    record('rec_d1', { createdAt: '2026-10-20T01:00:00.000Z', part: 'A', plannedAt: '2026-10-19T01:00:00.000Z' }),
    record('rec_d2', { createdAt: '2026-10-20T01:00:00.100Z', part: 'B', plannedAt: '2026-10-18T01:00:00.000Z' }),
    record('rec_d3', { createdAt: '2026-10-20T01:00:00.200Z', part: 'A', decision: 'inactive', plannedAt: '2026-10-19T01:00:00.000Z', active: false }),
  ]
  await crashThenContinue({ records: degenerate, k: 1 })
  const exception = [
    record('rec_e0', { createdAt: '2026-10-20T00:00:00.000Z', part: 'O', decision: 'inactive', plannedAt: P1, active: false }),
    record('rec_e1', { createdAt: '2026-10-20T00:59:56.000Z', part: 'O', plannedAt: P1 }),
    record('rec_e2', { createdAt: '2026-10-20T00:59:58.000Z', part: 'Q', decision: 'update', plannedAt: '2026-10-20T05:00:00.000Z' }),
    record('rec_e3', { createdAt: '2026-10-20T00:59:59.000Z', part: 'Q', plannedAt: P1 }),
  ]
  await crashThenContinue({ records: exception, k: 2 })
})

// A resolved sheet with one live batch, rows created while the switch was off (blank), and a labelled live row whose
// createdAt falls INSIDE the gap rows' interval.
const LIVE_LABEL = '第1批（2026-10-20）'
function gapWorld({ withCrash } = {}) {
  void withCrash
  const records = [
    record('rec_g0', { createdAt: '2026-10-20T01:00:01.000Z', part: 'S-01', plannedAt: P1, pullBatch: LIVE_LABEL, firstPullBatch: LIVE_LABEL }),
    record('rec_g1', { createdAt: '2026-10-22T01:00:01.000Z', part: 'S-01', tokens: ['P-07', 'S-01'], plannedAt: '2026-10-22T01:00:00.000Z' }),
    record('rec_g2', { createdAt: '2026-10-22T01:00:03.000Z', part: 'P-07', plannedAt: '2026-10-22T01:00:00.000Z' }),
    record('rec_gL', { createdAt: '2026-10-22T01:00:02.000Z', part: 'L', plannedAt: P1, pullBatch: LIVE_LABEL, firstPullBatch: LIVE_LABEL }),
    record('rec_gJ', { createdAt: '2026-10-21T01:00:01.000Z', part: 'J', plannedAt: P1 }),
  ]
  return createWorld({
    records,
    bandPresent: true,
    sheetRow: { status: 'backfilled', historyBatchCount: 0, placement: 'left', landing: 'promote_prep_fill', lockedAt: '2026-10-19T00:00:00.000Z' },
    ledgerBatches: [{ id: 'pbat_live1', batch_no: 1, origin: 'live', status: 'closed', label: LIVE_LABEL, display_day: '2026-10-20', source_digest: 'a'.repeat(32), evidence: null, opened_at: P1, closed_at: '2026-10-20T01:10:00.000Z', closed_reason: 'execution_succeeded' }],
  })
}

test('IN-16 / IN-16b (critic C1) gap pass: the exact join onto the live batch, an appended inferred cluster after base, the GAP-C09 carry — and every live-labelled row is byte-identical, never a plan_conflict', async () => {
  const world = gapWorld()
  const before = { g0: world.cells('rec_g0'), gL: world.cells('rec_gL'), versions: [world.host.get('rec_g0').version, world.host.get('rec_gL').version] }
  const preview = await dryRun(world)
  assert.equal(preview.run, 'gap_pass')
  assert.deepEqual(preview.refusals, [], JSON.stringify(preview.refusals))
  assert.equal(preview.fixedPoints.conflicting, 0)
  assert.deepEqual([preview.plan.base, preview.plan.K, preview.plan.joins], [1, 1, 1])
  const done = await install(world)
  assert.equal(done.resolved, true)
  assert.deepEqual(world.cells('rec_gJ'), [LIVE_LABEL, LIVE_LABEL], 'joined: the live label unmarked')
  assert.match(world.cells('rec_g1')[0], /^第2批（推定，/)
  assert.equal(world.cells('rec_g1')[1], LIVE_LABEL, 'GAP-C09: the copy carries 第1批')
  assert.deepEqual([world.cells('rec_g0'), world.cells('rec_gL')], [before.g0, before.gL])
  assert.deepEqual([world.host.get('rec_g0').version, world.host.get('rec_gL').version], before.versions, 'never patched')
  assert.deepEqual([world.sheet().history_status, world.sheet().history_batch_count], ['backfilled', 2])
  assert.deepEqual(world.db.rows(kit.T.batch).map((row) => [row.batch_no, row.origin]).sort(), [[1, 'live'], [2, 'backfill_inferred']])
})

test('IN-10b a gap-pass crash after k patches, then a re-run => the same union of labels as an uninterrupted gap pass', async () => {
  const control = gapWorld()
  await install(control)
  for (const k of [0, 1, 2]) {
    const world = gapWorld()
    const preview = await dryRun(world)
    let patched = 0
    world.state.patchFault = () => (patched++ >= k ? Object.assign(new Error('crash'), { code: 'HOST_DOWN' }) : null)
    await assert.rejects(install(world, { planDigest: preview.planDigest, count: preview.requires.confirmHistoricalBatchCount.inferred }), /crash/)
    world.state.patchFault = null
    const resumed = await dryRun(world)
    assert.deepEqual([resumed.run, resumed.planDigest, resumed.fixedPoints.conflicting], ['continue', preview.planDigest, 0])
    await install(world, { planDigest: resumed.planDigest, count: resumed.requires.confirmHistoricalBatchCount.inferred })
    assert.deepEqual(allCells(world), allCells(control), `k=${k}`)
  }
})

test('IN-11 a covered row whose set cell differs from the plan => 409 PLAN_CONFLICT before the first patch (P2-23)', async () => {
  const records = c09()
  records[2].data[P_PB] = '第9批（推定，2026-10-01）'
  const world = createWorld({ records })
  const preview = await dryRun(world)
  assert.ok(preview.refusals.includes('plan_conflict'))
  const error = await rejects(install(world, { planDigest: preview.planDigest, count: 2 }), PB.PULL_BATCH_ERROR_CODES.PLAN_CONFLICT, 'conflict')
  assert.equal(error.details.rows, 1)
  assert.equal(world.log.includes('host.patchRecord'), false)
})

test('IN-12 (M-2B-2) VERSION_CONFLICT => one re-read and one retry; a row conflicting again stays raced and blank => rows_unlabelled, never resolved', async () => {
  const world = createWorld({ records: c09() })
  let bumps = 0
  world.state.patchFault = (recordId) => {
    if (recordId === 'rec_02' && bumps < 1) { bumps += 1; world.host.get('rec_02').version += 1 }
    return null
  }
  const done = await install(world)
  assert.equal(done.resolved, true, 'one conflict: the retry with the fresh version lands')
  const stubborn = createWorld({ records: c09() })
  stubborn.state.patchFault = (recordId) => {
    if (recordId === 'rec_02') stubborn.host.get('rec_02').version += 1
    return null
  }
  const stuck = await install(stubborn)
  assert.deepEqual([stuck.resolved, stuck.reason, stuck.count], [false, 'rows_unlabelled', 1])
  assert.equal(stubborn.sheet().history_status, 'installing')
})

test('IN-13 FORBIDDEN (the record locked meanwhile) => skipped and counted, the run goes on; the locked row never blocks the resolve', async () => {
  const world = createWorld({ records: c09() })
  world.state.patchFault = (recordId) => {
    if (recordId === 'rec_03') { world.host.get('rec_03').locked = true; return Object.assign(new Error('locked'), { code: 'FORBIDDEN' }) }
    return null
  }
  const done = await install(world)
  assert.equal(done.resolved, true)
  assert.equal(done.skipped.locked, 1)
  assert.deepEqual(world.cells('rec_03'), ['', ''])
})

test('IN-14 rows created after the plan (the switch off meanwhile) => rows_after_plan; the next dry-run offers the extension, whose digest installs and resolves with K = K + ext K', async () => {
  const world = createWorld({ records: c09() })
  const preview = await dryRun(world)
  world.state.patchFault = () => {
    if (!world.host.has('rec_late')) world.host.set('rec_late', record('rec_late', { createdAt: '2026-10-26T03:00:01.000Z', part: 'N', plannedAt: '2026-10-26T03:00:00.000Z' }))
    return null
  }
  const first = await install(world, { planDigest: preview.planDigest, count: 2 })
  world.state.patchFault = null
  assert.deepEqual([first.resolved, first.reason, first.count], [false, 'rows_after_plan', 1])
  const next = await dryRun(world)
  assert.equal(next.run, 'continue')
  assert.ok(next.extension && next.extension.K === 3, JSON.stringify(next.extension))
  assert.equal(next.progress.uncovered, 1)
  const done = await install(world, { planDigest: next.extension.planDigest, count: 3 })
  assert.deepEqual([done.resolved, done.K, done.historyBatchCount], [true, 3, 3])
  assert.match(world.cells('rec_late')[0], /^第3批（推定，/)
})

test('IN-15 (M-2B-21) the write budget: 3 over 7 rows answers write_budget remaining 4, then remaining 1, then resolved', async () => {
  const records = [...c09(), record('rec_06', { createdAt: '2026-10-20T02:30:04.000Z', part: 'Q1', plannedAt: P2 }), record('rec_07', { createdAt: '2026-10-20T02:30:05.000Z', part: 'Q2', plannedAt: P2 })]
  const world = createWorld({ records })
  const preview = await dryRun(world)
  const step = () => install(world, { planDigest: preview.planDigest, count: 2 }, { writeBudget: 3 })
  const a = await step()
  assert.deepEqual([a.resolved, a.reason, a.remaining, a.written.rows], [false, 'write_budget', 4, 3])
  const b = await step()
  assert.deepEqual([b.resolved, b.reason, b.remaining], [false, 'write_budget', 1])
  const c = await step()
  assert.equal(c.resolved, true)
})

test('IN-17 (M-2B-4 / M-2B-22) abort: a first install with no label written releases the lock (C7); a 首次-only label or a person copy of a label keeps it; a labelled gap pass cannot be aborted; abort runs under the lease', async () => {
  const fresh = createWorld({ records: c09() })
  const preview = await dryRun(fresh)
  fresh.state.patchFault = () => Object.assign(new Error('crash'), { code: 'HOST_DOWN' })
  await assert.rejects(install(fresh, { planDigest: preview.planDigest, count: 2 }), /crash/)
  fresh.log.length = 0
  const released = await IN.runPullBatchInstallRequest(fresh.deps(), { mode: 'abort', confirmProjectNo: PROJECT, approvalRef: 'R-65' })
  assert.deepEqual(released, { mode: 'abort', historyStatus: 'pending', firstInstall: true, settingsReleased: true })
  const acquiredAt = fresh.log.indexOf('lease.acquire')
  assert.ok(acquiredAt !== -1 && acquiredAt < fresh.log.indexOf('host.queryRecords'), 'abort takes the lease, then reads under it')
  const firstOnly = createWorld({ records: c09() })
  const p2 = await dryRun(firstOnly)
  let done = 0
  firstOnly.state.patchFault = () => (done++ >= 1 ? Object.assign(new Error('crash'), { code: 'HOST_DOWN' }) : null)
  await assert.rejects(install(firstOnly, { planDigest: p2.planDigest, count: 2 }), /crash/)
  firstOnly.host.get('rec_01').data[P_PB] = ''
  const kept = await IN.runPullBatchInstallRequest(firstOnly.deps(), { mode: 'abort', confirmProjectNo: PROJECT, approvalRef: 'R-65' })
  assert.equal(kept.settingsReleased, false, 'a 首次-only label keeps the lock')
  const gap = gapWorld()
  const gp = await dryRun(gap)
  let g = 0
  gap.state.patchFault = () => (g++ >= 1 ? Object.assign(new Error('crash'), { code: 'HOST_DOWN' }) : null)
  await assert.rejects(install(gap, { planDigest: gp.planDigest, count: 1 }), /crash/)
  const refused = await rejects(IN.runPullBatchInstallRequest(gap.deps(), { mode: 'abort', confirmProjectNo: PROJECT, approvalRef: 'R-65' }), PB.PULL_BATCH_ERROR_CODES.CONFLICT, 'labelled gap pass')
  assert.equal(refused.details.reason, 'plan_labels_on_sheet')
})

test('IN-18 (M-2B-3, G11) the registry lock is held only around the resolve: no host read, write or provisioning call happens inside it', async () => {
  const world = createWorld({ records: c09() })
  await install(world)
  assert.ok(world.log.includes('registry.lock'))
  assert.deepEqual(world.state.ioWhileRegistryLocked.filter((entry) => entry.startsWith('host.') || entry.startsWith('prov.') || entry.startsWith('tx.')), [])
})

test('IN-19 every audit detail is flat and passes the audit store\'s gate — begin, resolve, abort, born ready — including the layout-null and landing-null paths (critic C4)', async () => {
  const world = createWorld({ records: c09() })
  await install(world)
  assert.deepEqual(world.audits.map((entry) => entry.mode), ['pull_batch_install_started', 'pull_batch_installed'])
  for (const entry of world.audits) {
    assert.equal(Object.values(entry.detail).some((value) => value === null), false)
    assert.ok(entry.detail.approvalRef === 'R-65' && /^[0-9a-f]{64}$/.test(entry.detail.planDigest))
  }
  assert.deepEqual(IN.__internals.flatDetail({ a: null, b: undefined, c: 1, d: 'x', e: { plan_time: 1, bad: null } }), { c: 1, d: 'x', e: { plan_time: 1 } })
  const birth = createWorld({ records: [], promote: false })
  const born = await IN.bornReadyBestEffort(birth.deps())
  assert.deepEqual(born, { installed: true, landingPromoted: false, reason: null })
  assert.equal(birth.audits[0].detail.landing, 'unset', 'a landing the birth could not apply is the token unset, never null')
})

test('IN-20 (M-BI-12) every patch names exactly the band\'s physical ids — never a human, template or other column — and only the blank ones', async () => {
  const records = c09()
  records[0].data[P_FPB] = ''
  const world = createWorld({ records })
  const seen = []
  world.state.patchFault = (recordId, changes) => { seen.push(Object.keys(changes).sort()); return null }
  await install(world)
  assert.ok(seen.length === 5)
  for (const keys of seen) assert.ok(keys.every((key) => key === P_PB || key === P_FPB), JSON.stringify(keys))
  const half = createWorld({ records: c09() })
  const preview = await dryRun(half)
  half.host.get('rec_03').data[P_FPB] = '第2批（推定，2026-10-20）'
  const keys = []
  half.state.patchFault = (recordId, changes) => { if (recordId === 'rec_03') keys.push(Object.keys(changes)); return null }
  await install(half, { planDigest: preview.planDigest, count: 2 })
  assert.deepEqual(keys, [[P_PB]], 'fill-blank: the set cell is never re-sent')
})

test('IN-21 (M-2B-13) I7: the bump runs once, after the release; a failing bump is logged and answered generationBumped false', async () => {
  const world = createWorld({ records: c09() })
  const done = await install(world)
  assert.equal(done.generationBumped, true)
  assert.deepEqual(world.log.filter((entry) => entry === 'bump' || entry === 'lease.release').slice(-2), ['lease.release', 'bump'])
  const failing = createWorld({ records: c09() })
  const answer = await install(failing, {}, { bumpAfterRelease: async () => { throw Object.assign(new Error('locked'), { code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' }) } })
  assert.deepEqual([answer.resolved, answer.generationBumped], [true, false])
  assert.ok(failing.log.some((entry) => entry.startsWith('warn:') && entry.includes('STOCK_PREP_PROJECT_WRITE_LOCKED')))
})

test('IN-22 noop: a resolved sheet without gap rows or blank manual rows answers run noop with zero host and ledger writes', async () => {
  const world = gapWorld()
  await install(world)
  const before = JSON.stringify(world.db.rows(kit.T.sheet))
  world.log.length = 0
  const preview = await dryRun(world)
  assert.equal(preview.run, 'noop')
  assert.ok(preview.refusals.includes('nothing_to_install'))
  const answer = await IN.runPullBatchInstallRequest(world.deps(), { mode: 'install', confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: 'a'.repeat(64), confirmHistoricalBatchCount: 0 })
  assert.deepEqual([answer.run, answer.resolved, answer.written.rows], ['noop', true, 0])
  assert.equal(world.log.some((entry) => /patch|ensure|repair|promote|lease|bump/.test(entry)), false, JSON.stringify(world.log))
  assert.equal(JSON.stringify(world.db.rows(kit.T.sheet)), before)
})

test('IN-23 (M-BI-14 / M-BI-21 / M-2B-5) born ready: OFF => null with zero calls; ledger unreadable => legacy; rows present => no band; band unverified => no born_empty; tenant right + keep_current honoured; a row arriving between the two reads => no born_empty', async () => {
  assert.equal(await IN.bornReadyBestEffort(null), null)
  const off = createWorld({ enabled: false })
  assert.equal(await IN.bornReadyBestEffort(off.deps()), null)
  assert.deepEqual(off.log, [])
  const unreadable = createWorld()
  unreadable.db.faults.select = kit.sqlError('42P01', 'relation does not exist')
  assert.deepEqual(await IN.bornReadyBestEffort(unreadable.deps()), { installed: false, landingPromoted: false, reason: 'ledger_unreadable' })
  assert.equal(unreadable.log.includes('prov.repairTx'), false)
  const rows = createWorld({ records: [record('rec_p', { createdAt: NOW, createdBy: 'u_person' })] })
  assert.equal((await IN.bornReadyBestEffort(rows.deps())).reason, 'sheet_has_rows')
  assert.equal(rows.log.includes('prov.repairTx'), false)
  const unverified = createWorld()
  unverified.fields.set('pullBatch', { physical: 'fld_other', order: 99, property: {} })
  const answer = await IN.bornReadyBestEffort(unverified.deps())
  assert.equal(answer.reason, 'band_unverified')
  assert.equal(unverified.sheet(), null, 'no born_empty before the band is verified')
  const right = createWorld({ tenantSettings: { first_pull_batch_rule: 'predecessor_suffix', label_format: 'ordinal', landing_mode: 'keep_current', band_placement: 'right' } })
  assert.deepEqual(await IN.bornReadyBestEffort(right.deps()), { installed: true, landingPromoted: false, reason: null })
  assert.deepEqual([right.sheet().history_status, right.sheet().band_placement, right.sheet().landing_mode, right.sheet().first_pull_batch_rule, right.sheet().label_format], ['born_empty', 'right', 'keep_current', 'predecessor_suffix', 'ordinal'])
  assert.ok(right.fields.get('pullBatch').order > KNOWN_FIELDS.length - 1)
  const late = createWorld()
  const deps = late.deps()
  const inner = deps.provisioning.runObjectFieldsRepairTransaction
  deps.provisioning.runObjectFieldsRepairTransaction = async (fn) => {
    const out = await inner(fn)
    late.host.set('rec_late', record('rec_late', { createdAt: NOW }))
    return out
  }
  assert.equal((await IN.bornReadyBestEffort(deps)).reason, 'sheet_has_rows')
  assert.equal(late.sheet(), null)
  const promoted = createWorld()
  assert.deepEqual(await IN.bornReadyBestEffort(promoted.deps()), { installed: true, landingPromoted: true, reason: null })
  assert.equal(promoted.sheet().landing_mode, 'promote_prep_fill')
})

test('IN-24 (critic C3) no derivable band: dry_run answers band_unavailable, install answers 503 PROVISIONING_UNAVAILABLE { requiredMethods: [getFieldId] }, birth answers provisioning_unavailable', async () => {
  const world = createWorld({ records: c09(), band: null })
  const preview = await dryRun(world)
  assert.deepEqual([preview.plan, preview.refusals], [null, ['band_unavailable']])
  const error = await rejects(install(world, { planDigest: 'a'.repeat(64), count: 2 }), 'STOCK_PREPARATION_PROJECT_TARGET_PROVISIONING_UNAVAILABLE', 'install')
  assert.deepEqual(error.details.requiredMethods, ['getFieldId'])
  assert.equal(world.sheet(), null)
  assert.equal((await IN.bornReadyBestEffort(world.deps())).reason, 'provisioning_unavailable')
})

test('IN-25 the audit actually ran (critic C10): an auditWithin that never reaches the store is a 500, never a silent unaudited install; install without auditWithin is 501 before any IO', async () => {
  const world = createWorld({ records: c09() })
  world.log.length = 0
  await rejects(install(world, { planDigest: 'a'.repeat(64), count: 2 }, { auditWithin: null }), 'AUDIT_STORE_UNAVAILABLE', 'no audit')
  assert.deepEqual(world.log, [])
  const store = world.store
  const skipping = { ...store, beginInstall: (input) => store.beginInstall({ ...input, auditWithin: undefined }) }
  await rejects(install(world, {}, { store: skipping }), PB.PULL_BATCH_ERROR_CODES.STAMP_INVALID, 'skipped audit')
})

test('IN-26 the portability pins hold by TEXT: one require (the pure module), and the file names neither the ledger store nor the switch', () => {
  const fs = require('node:fs')
  const source = fs.readFileSync(path.join(LIB, 'stock-preparation-pull-batch-install.cjs'), 'utf8')
  assert.equal(source.split('require(').length - 1, 1)
  assert.equal(source.includes("require('./stock-preparation-pull-batch.cjs')"), true)
  assert.equal(source.includes('stock-preparation-pull-batch-store'), false)
  assert.equal(source.includes('PULL_BATCH_ENABLED'), false)
})

test('IN-27 a gap pass whose only work is a blank manual row on a born_empty sheet fills 人工补充 and stays born_empty (no evidence row, K = 0)', async () => {
  const world = createWorld({
    records: [record('rec_m1', { createdAt: '2026-10-25T01:00:00.000Z', part: 'M', key: 'manual:v1:rec_m1', createdBy: 'u_person' })],
    bandPresent: true,
    sheetRow: { status: 'born_empty', placement: 'left', landing: 'promote_prep_fill', lockedAt: null },
  })
  const preview = await dryRun(world)
  assert.deepEqual([preview.run, preview.plan.K], ['gap_pass', 0])
  const done = await install(world)
  assert.deepEqual([done.resolved, done.historyStatus, done.written.manualRows], [true, 'born_empty', 1])
  assert.deepEqual(world.cells('rec_m1'), [MANUAL, MANUAL])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-install.test.cjs', tests)
