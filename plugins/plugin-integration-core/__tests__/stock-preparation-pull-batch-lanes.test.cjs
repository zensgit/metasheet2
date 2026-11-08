'use strict'

// 批次标识 BI-1b (design §3.4-§3.8, §6.1-§6.4, §7.1; rulings C4 / C12; register R-65) — THE LANES, end to end on the
// project-sheet substrate (support/stock-preparation-project-sheet-harness.cjs: the REAL routes, registry store, lock and
// governance) with the REAL ledger store over the migration-105 fake (support/stock-preparation-pull-batch-kit.cjs). The
// lock's lease row is read INSIDE the ledger transaction through a one-database bridge (production: one plugin db), so
// the holder assert runs exactly as on main.
//
//   LN-01  SWITCH OFF ⇒ every answer is byte-identical to a run with NO band and NO ledger: dry-run, apply, a second
//          dry-run, the large start / run / plan / approve / chunk / job GET, the board, the pilot GET, the change-plan
//          read; the store (a proxy that throws on any use) is never touched; no answer carries a pullBatch key; the
//          probe input and the host writes are identical. 'TRUE', ' true', '1' are OFF (exact literal).
//   LN-02  critic M1: the band derivation never throws — no getFieldId, a non-string, a throw, a collision ⇒ no band
//   LN-03  ON, band not installed ⇒ preview / answer not_installed, ZERO ledger IO, rows land blank
//   LN-04  ON, computed probe ⇒ columns_unproven; one column ⇒ columns_partial; zero ledger IO either way
//   LN-05  ON, ready: the preview says so, the create leg stamps BOTH physical cells, the link is finished by value and
//          the batch closed; a no-create apply answers no_creates and opens nothing; a later pull's new part is 本次 =
//          首次 = 第2批 while the batch-1 row keeps 第1批 (E10: never re-stamped)
//   LN-06  ON, installing ⇒ the preview answers the reason; apply / large approve / large chunk refuse 409 with nothing
//          written and the job untouched
//   LN-07  ON, _sheet absent or pending ⇒ history_pending, unstamped, no ledger write
//   LN-08  ON, a gap row (a plugin row with a RUN stamp and blank cells) ⇒ history_gap + count, unstamped; C4: an
//          automation-like row (creator absent, non-JSON key, no RUN stamp) and a forged JSON key without a RUN stamp
//          are NOT gap rows (the pull stamps)
//   LN-09  ON, the ledger read fails ⇒ apply 503 STORE_FAILED before any create; the preview answers ledger_unreadable
//   LN-10  ON, the captured rule moved between the read and the allocation ⇒ 409 CONFLICT settings_changed, run stop
//   LN-11  ON, large lane: plan stores the sibling pullBatchPlan (no physical id, never in a public projection, not in
//          the plan revision), approve copies it, the chunk stamps under large:<apply job id>, the stanza answers
//   LN-12  ON, P-4: an expansion planned while OFF is refused at approval 409 JOB_REPLAN_REQUIRED BEFORE the bump
//   LN-13  ON, P-3: a gap plan runs its chunks UNSTAMPED (never REPLAN)
//   LN-14  P-12: a lease taken between the plan and the approval ⇒ 409 PLAN_SUPERSEDED, no ledger write
//   LN-15  egress: no answer and no stored token / job record carries a derived physical band id
//   LN-16  cross-lane join: a large job's open batch is JOINED by a small apply of the same content (one digest)
//   LN-17  source order: P-1 (before beginExecution), the stamp after the execution exists, the chunk gate before running
//   LN-18  vocabularies and the stored-plan / execution-ref validation (critic M6)
//
// Every value is synthetic.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const pbKit = require('./support/stock-preparation-pull-batch-kit.cjs')
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const { createStockPreparationPullBatchStore } = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const { pullBatchBandFieldDescriptors } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-pull-batch-lanes.cjs'))
const { PULL_BATCH_ERROR_CODES, PULL_BATCH_RESPONSE_REASONS } = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const swl = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-syn-pbl'
const PROJECT = 'SYN-PBL-01'
const ADMIN = Object.freeze({ id: 'u_pbl_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const SWITCH = 'STOCK_PREP_PULL_BATCH_ENABLED'
const LOCK_TABLE = 'integration_stock_prep_project_write_lock'
const ACTION = PLM_STOCK_PREPARATION_ACTION_ID
const DRY = '/api/integration/table-actions/:actionId/dry-run'
const APPLY = '/api/integration/table-actions/:actionId/apply'
const JOBS = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const BOARD = '/api/integration/stock-preparation/projects/:projectNo/board'
const PILOT = '/api/integration/stock-preparation/projects/:projectNo/target/pilot'
const STATUS = '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch'
const CHANGE_PLAN = '/api/integration/stock-preparation/projects/:projectNo/refresh/change-plans/current'

async function withSwitch(value, fn) {
  const original = process.env[SWITCH]
  if (value === undefined) delete process.env[SWITCH]
  else process.env[SWITCH] = value
  try { return await fn() } finally { if (original === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = original }
}

/** A ledger store that must never be touched (switch off): every method access is recorded, every call throws. */
function untouchableStore() {
  const touched = []
  const store = new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined
      touched.push(String(key))
      return () => { throw new Error(`the pull-batch ledger was touched while the switch is off: ${String(key)}`) }
    },
  })
  return { store, touched }
}

/**
 * One mount. `ledger`: 'real' (the REAL store over the fake 105 db, the lock row bridged into its transaction),
 * 'untouchable', or null (no store service). `band`: whether the band is installed on the seeded sheet (`'one'` = only
 * 本次拉取). `bandless`: the host's getFieldId answers no id for the band (the derivation degrades to "no band").
 */
function mount({ ledger = 'real', band = true, sheet = 'born_empty', bandless = false, computed = false, wrapStore = null } = {}) {
  const clock = pbKit.createClock('2026-11-08T01:00:00.000Z')
  const ledgerDb = pbKit.createFakePullBatchDb({ clock })
  const lockEnv = lockKit.createInMemoryProjectWriteLock()
  // ONE database in production: the holder assert reads the lease row inside the ledger's transaction.
  const bridged = {
    ...ledgerDb,
    async transaction(callback) {
      return ledgerDb.transaction((trx) => callback({
        ...trx,
        async selectOneForUpdate(table, where) { return table === LOCK_TABLE ? lockEnv.db.selectOne(table, where) : trx.selectOneForUpdate(table, where) },
      }))
    },
  }
  let n = 0
  const untouchable = ledger === 'untouchable' ? untouchableStore() : null
  const realStore = ledger === 'real' ? createStockPreparationPullBatchStore({ db: bridged, now: clock.now, idGenerator: (kind) => `${kind}_syn_${(n += 1)}` }) : null
  const store = realStore ? (wrapStore ? wrapStore(realStore, ledgerDb) : realStore) : (untouchable ? untouchable.store : null)
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    serviceExtras: { stockPreparationProjectWriteLock: lockEnv.lock, ...(store ? { stockPreparationPullBatchStore: store } : {}) },
  })
  const seeded = h.seedRegistryRow(PROJECT)
  const object = h.provisioning.objects.get(`${h.staging}/${seeded.objectId}`)
  if (band) {
    for (const descriptor of pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'left' })) {
      if (band === 'one' && descriptor.id !== 'pullBatch') continue
      object.fields.set(descriptor.id, { name: descriptor.name, type: descriptor.type, property: JSON.parse(JSON.stringify(descriptor.property)), order: descriptor.order })
    }
  }
  if (bandless) {
    const derive = h.provisioning.getFieldId
    h.provisioning.getFieldId = (projectId, objectId, fieldId) => (fieldId === 'pullBatch' || fieldId === 'firstPullBatch' ? undefined : derive(projectId, objectId, fieldId))
  }
  if (computed) delete h.provisioning.resolveExistingObjectFieldIds
  if (ledger === 'real' && sheet) {
    ledgerDb.seed(pbKit.T.sheet, pbKit.sheetRow({ tenantId: TENANT, sheetId: seeded.sheetId, projectNo: PROJECT, status: sheet }))
  }
  ledgerDb.log.length = 0
  const physical = (fieldId) => h.provisioning.getFieldId(h.staging, seeded.objectId, fieldId)
  return { ...h, ...seeded, ledgerDb, lockEnv, store, untouchable, clock, physical }
}

const call = (h, method, routePath, { body = {}, params = {}, query = { tenantId: TENANT }, user = ADMIN } = {}) =>
  harness.call(h.routes, method, routePath, { user, params: { actionId: ACTION, ...params }, body, query })
const dryRun = (h) => call(h, 'POST', DRY, { body: { parameters: { projectNo: PROJECT } } })
const apply = (h, token) => call(h, 'POST', APPLY, { body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: token, acceptManualConfirmHold: true } } })
async function pull(h) {
  const dry = await dryRun(h)
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  return { dry, applied: await apply(h, dry.body.data.dryRunToken) }
}
const sheetRows = async (h) => (await h.records.queryRecords({ sheetId: h.sheetId, filters: {} })).filter((row) => row.sheetId === h.sheetId)
const ledgerWrites = (h) => h.ledgerDb.log.filter(([method]) => /insertOne|updateRow/.test(method))
const hostWrites = (h) => h.records.calls.filter(([verb]) => verb === 'createRecord' || verb === 'patchRecord')

async function largeFlow(h, { approve = true, run = true } = {}) {
  const started = await call(h, 'POST', JOBS, { body: { parameters: { projectNo: PROJECT } } })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const jobId = started.body.data.jobId
  const ran = await call(h, 'POST', `${JOBS}/:jobId/run`, { params: { jobId } })
  assert.equal(ran.statusCode, 200, JSON.stringify(ran.body))
  const planned = await call(h, 'POST', `${JOBS}/:jobId/plan`, { params: { jobId } })
  const out = { jobId, started, ran, planned }
  if (!approve || planned.statusCode !== 200) return out
  out.approved = await call(h, 'POST', `${JOBS}/:jobId/apply-jobs`, { params: { jobId }, body: { confirm: { acceptManualConfirmHold: true } } })
  if (!run || out.approved.statusCode !== 202) return out
  out.applyJobId = out.approved.body.data.jobId
  out.chunks = []
  for (let i = 0; i < 5; i += 1) {
    const chunk = await call(h, 'POST', `${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params: { jobId, applyJobId: out.applyJobId } })
    out.chunks.push(chunk)
    if (chunk.statusCode !== 200 || ['succeeded', 'partial'].includes(chunk.body.data.status)) break
  }
  out.jobGet = await call(h, 'GET', `${JOBS}/:jobId/apply-jobs/:applyJobId`, { params: { jobId, applyJobId: out.applyJobId } })
  return out
}

// Random handles (tokens, job ids, run ids, wall-clock times) differ between two mounts by construction; everything else
// must be byte-identical.
const SHEET_HASH_KEYS = new Set(['revision', 'dryRunRevision', 'planRevision'])
const RANDOM_KEYS = new Set(['dryRunToken', 'jobId', 'applyJobId', 'sourceJobId', 'runId', 'createdAt', 'updatedAt', 'approvedAt', 'plannedAt', 'sealedAt', 'startedAt', 'completedAt', 'lastPlmRefreshAt', 'lastPlmRefreshRunId', 'plmReadPhase', 'elapsedMs', 'at', 'lastPullAt', 'lastChangedFromPlmAt'])
function normalize(value, { sheetHashes = false } = {}) {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, { sheetHashes }))
  if (!value || typeof value !== 'object') return typeof value === 'string' && /[0-9a-f]{8}-[0-9a-f]{4}-/.test(value) ? '<uuid>' : value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = RANDOM_KEYS.has(key.replace(/^fld_[0-9a-z]{8}_/, '')) || (sheetHashes && SHEET_HASH_KEYS.has(key)) ? '<random>' : normalize(value[key], { sheetHashes })
  return out
}
// Answers computed over rows an earlier pull wrote (their RUN stamps carry the wall clock).
const OVER_WRITTEN_ROWS = new Set(['dry2', 'largePlan', 'largeApprove', 'largeChunks', 'largeJobGet', 'apply'])
function hasKeyDeep(value, wanted) {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, wanted))
  if (!value || typeof value !== 'object') return false
  return Object.keys(value).some((key) => key === wanted || hasKeyDeep(value[key], wanted))
}

async function offScenario(h) {
  const answers = {}
  const first = await pull(h)
  answers.dry = first.dry.body
  answers.apply = first.applied.body
  answers.dry2 = (await dryRun(h)).body
  const large = await largeFlow(h)
  answers.largePlan = large.planned.body
  answers.largeApprove = large.approved && large.approved.body
  answers.largeChunks = (large.chunks || []).map((chunk) => chunk.body)
  answers.largeJobGet = large.jobGet && large.jobGet.body
  answers.board = (await call(h, 'GET', BOARD, { params: { projectNo: PROJECT } })).body
  answers.pilot = (await call(h, 'GET', PILOT, { params: { projectNo: PROJECT } })).body
  answers.changePlan = (await call(h, 'GET', CHANGE_PLAN, { params: { projectNo: PROJECT } })).body
  answers.status = (await call(h, 'GET', STATUS, { params: { projectNo: PROJECT } })).body
  const probes = h.provisioning.calls.filter(([verb]) => verb === 'resolveExistingObjectFieldIds')
  const rows = (await sheetRows(h)).map((row) => row.data)
  return { answers, probes, rows, writes: hostWrites(h).length }
}

test('LN-01 switch OFF: every answer is byte-identical to a run with no band and no ledger; the ledger is never touched; no pullBatch key', async () => {
  for (const value of [undefined, 'false', 'TRUE', ' true', 'true ', '1']) {
    const a = mount({ ledger: 'untouchable' })
    const b = mount({ ledger: null, bandless: true, band: false })
    try {
      const withBand = await withSwitch(value, () => offScenario(a))
      const without = await withSwitch(value, () => offScenario(b))
      assert.deepEqual(a.untouchable.touched, [], `switch ${JSON.stringify(value)}: the ledger store was never touched`)
      for (const [name, body] of Object.entries(withBand.answers)) {
        if (name === 'status') continue
        assert.equal(hasKeyDeep(body, 'pullBatch'), false, `switch ${JSON.stringify(value)}: ${name} carries no pullBatch key`)
        const sheetHashes = OVER_WRITTEN_ROWS.has(name)
        assert.deepEqual(normalize(body, { sheetHashes }), normalize(without.answers[name], { sheetHashes }), `switch ${JSON.stringify(value)}: ${name} is byte-identical to the band-less run`)
      }
      assert.equal(withBand.answers.status.data.switchOn, false)
      assert.deepEqual(withBand.answers.status.data.ledger.readable, null, 'the status route reads no ledger while off')
      assert.equal(withBand.answers.status.data.rows, null, 'and no rows')
      assert.deepEqual(withBand.probes, without.probes, 'the field probe input is byte-identical (no fold while off)')
      assert.deepEqual(normalize(withBand.rows), normalize(without.rows), 'the rows written are identical — no band cell')
      assert.ok(withBand.writes > 0, 'non-vacuous: the scenario wrote rows')
      assert.ok(withBand.answers.apply.ok && withBand.answers.largeChunks.length > 0, 'non-vacuous: apply and a chunk ran')
      assert.equal(withBand.answers.dry.data.revision, without.answers.dry.data.revision, 'the first preview (an empty sheet) hashes identically, revision included')
    } finally { a.restore(); b.restore() }
  }
})

test('LN-02 critic M1: the band derivation never throws and never 5xx — no provisioning / no getFieldId / a non-string / a throw / a collision ⇒ no band', () => {
  const target = { sheetId: 'sheet_syn', objectId: 'obj_syn', fieldIdMap: { notes: 'fld_mapped' } }
  const good = { getFieldId: (_p, o, f) => `fld_${o}_${f}` }
  assert.deepEqual(lanes.derivePullBatchBand({ provisioning: good, projectId: 'p', target }), { fieldIds: { pullBatch: 'fld_obj_syn_pullBatch', firstPullBatch: 'fld_obj_syn_firstPullBatch' } })
  for (const [label, provisioning, projectId, t] of [
    ['no provisioning', undefined, 'p', target],
    ['no getFieldId (and no findObjectSheet)', {}, 'p', target],
    ['a non-string answer', { getFieldId: () => 7 }, 'p', target],
    ['a Promise answer', { getFieldId: async () => 'fld_x' }, 'p', target],
    ['a throwing derivation', { getFieldId: () => { throw new Error('namespace') } }, 'p', target],
    ['one id for both', { getFieldId: () => 'fld_same' }, 'p', target],
    ['an id mapped onto a template column', { getFieldId: (_p, _o, f) => (f === 'pullBatch' ? 'fld_mapped' : 'fld_b') }, 'p', target],
    ['no objectId', good, 'p', { sheetId: 'sheet_syn' }],
    ['no project', good, '', target],
  ]) {
    assert.equal(lanes.derivePullBatchBand({ provisioning, projectId, target: t }), undefined, label)
  }
})

test('LN-02b critic M1 at the route: switch OFF on a host whose getFieldId answers no string ⇒ the dry-run and apply answer exactly as a band-less host', async () => {
  const a = mount({ ledger: 'untouchable' })
  const b = mount({ ledger: null, bandless: true, band: false })
  try {
    a.provisioning.getFieldId = (projectId, objectId, fieldId) => (fieldId === 'pullBatch' || fieldId === 'firstPullBatch' ? 42 : `fld_${objectId.slice(-8)}_${fieldId}`)
    const pa = await pull(a)
    const pb = await pull(b)
    assert.equal(pa.applied.statusCode, 200, JSON.stringify(pa.applied.body))
    assert.deepEqual(normalize(pa.dry.body), normalize(pb.dry.body))
    assert.deepEqual(normalize(pa.applied.body), normalize(pb.applied.body))
    assert.deepEqual(a.untouchable.touched, [])
  } finally { a.restore(); b.restore() }
})

test('LN-03 ON, band not installed ⇒ not_installed on the preview and the apply, ZERO ledger IO, the row lands blank', async () => {
  const h = mount({ band: false })
  try {
    await withSwitch('true', async () => {
      const { dry, applied } = await pull(h)
      assert.deepEqual(dry.body.data.pullBatch, { preview: true, wouldStamp: false, reason: 'not_installed' })
      assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
      assert.deepEqual(applied.body.data.pullBatch, { stamped: false, reason: 'not_installed' })
    })
    assert.deepEqual(h.ledgerDb.log, [], 'no ledger read at all')
    const [row] = await sheetRows(h)
    assert.equal(row.data[h.physical('pullBatch')], undefined)
  } finally { h.restore() }
})

test('LN-04 ON, a computed-only probe ⇒ columns_unproven; one column ⇒ columns_partial; zero ledger IO either way', async () => {
  for (const [options, reason] of [[{ computed: true }, 'columns_unproven'], [{ band: 'one' }, 'columns_partial']]) {
    const h = mount(options)
    try {
      await withSwitch('true', async () => {
        const { dry, applied } = await pull(h)
        assert.equal(dry.body.data.pullBatch.reason, reason)
        assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
        assert.deepEqual(applied.body.data.pullBatch, { stamped: false, reason })
      })
      assert.deepEqual(h.ledgerDb.log, [], `${reason}: no ledger IO`)
    } finally { h.restore() }
  }
})

function addSecondPart(h) {
  // A later pull: the project's BOM gains PART-SYN2 (the harness source is extended in place).
  const original = h.source.adapter.read
  h.source.adapter.read = async (input = {}) => {
    const answer = await original(input)
    if (input.object === 'DN_PDM_OrderDetailInfo') answer.records.push({ order_id: 'ORDER-SYN', part_id: 'PART-SYN2', quantity: '3' })
    if (input.object === 'DN_PDM_PartLibraryInfo' && (!input.filters || input.filters.OBJ_ID === undefined || input.filters.OBJ_ID === 'PART-SYN2')) {
      answer.records.push({ OBJ_ID: 'PART-SYN2', IdentityNo: 'SYN-0002', IdentityName: 'Synthetic part 2', Material: 'Synthetic', SysVer: 'V1' })
    }
    return answer
  }
}

test('LN-05 ON, ready: the create leg stamps both physical cells; finished by value; no_creates opens nothing; a later new part is 第2批 / 第2批 and the batch-1 row keeps 第1批', async () => {
  const h = mount()
  try {
    await withSwitch('true', async () => {
      const first = await pull(h)
      assert.deepEqual(first.dry.body.data.pullBatch, { preview: true, wouldStamp: true, reason: null })
      assert.equal(first.applied.statusCode, 200, JSON.stringify(first.applied.body))
      assert.deepEqual(first.applied.body.data.pullBatch, { stamped: true, label: '第1批（2026-11-08）', batchNo: 1, joined: false, createdRowCount: 1 })
      const [row] = await sheetRows(h)
      assert.equal(row.data[h.physical('pullBatch')], '第1批（2026-11-08）')
      assert.equal(row.data[h.physical('firstPullBatch')], '第1批（2026-11-08）')
      assert.equal(row.data.pullBatch, undefined, 'never under the logical id')
      const [batch] = h.ledgerDb.rows(pbKit.T.batch)
      assert.deepEqual([batch.status, batch.closed_reason], ['closed', 'execution_succeeded'])
      const [link] = h.ledgerDb.rows(pbKit.T.execution)
      assert.match(link.execution_ref, /^small:table-action-apply:/)
      assert.deepEqual([link.writer_status, link.created_row_count], ['succeeded', 1])
      // The same pull again: nothing to create ⇒ no allocation, no new batch (A03).
      const again = await pull(h)
      assert.deepEqual(again.applied.body.data.pullBatch, { stamped: false, reason: 'no_creates' })
      assert.equal(h.ledgerDb.rows(pbKit.T.batch).length, 1)
      // A later pull with a NEW part: 本次 = 首次 = 第2批 on the new row; the first row is never re-stamped (E10).
      h.clock.set('2026-11-09T01:00:00.000Z')
      addSecondPart(h)
      const later = await pull(h)
      assert.equal(later.applied.statusCode, 200, JSON.stringify(later.applied.body))
      assert.deepEqual(later.applied.body.data.pullBatch, { stamped: true, label: '第2批（2026-11-09）', batchNo: 2, joined: false, createdRowCount: 1 })
      const rows = await sheetRows(h)
      const byPart = new Map(rows.map((entry) => [entry.data[h.physical('componentSourceId')], entry.data]))
      assert.deepEqual([byPart.get('PART-SYN')[h.physical('firstPullBatch')], byPart.get('PART-SYN')[h.physical('pullBatch')]], ['第1批（2026-11-08）', '第1批（2026-11-08）'])
      assert.deepEqual([byPart.get('PART-SYN2')[h.physical('firstPullBatch')], byPart.get('PART-SYN2')[h.physical('pullBatch')]], ['第2批（2026-11-09）', '第2批（2026-11-09）'])
    })
  } finally { h.restore() }
})

test('LN-06 ON, installing ⇒ the preview answers installing; apply / large approve / large chunk refuse 409 INSTALL_IN_PROGRESS with nothing written and the job untouched', async () => {
  const h = mount({ sheet: 'installing' })
  try {
    await withSwitch('true', async () => {
      const dry = await dryRun(h)
      assert.deepEqual(dry.body.data.pullBatch, { preview: true, wouldStamp: false, reason: 'installing' })
      const refused = await apply(h, dry.body.data.dryRunToken)
      assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
      assert.equal(refused.body.error.code, PULL_BATCH_ERROR_CODES.INSTALL_IN_PROGRESS)
      assert.equal(hostWrites(h).length, 0)
      const large = await largeFlow(h, { run: false })
      assert.equal(large.planned.statusCode, 200, JSON.stringify(large.planned.body))
      assert.equal(large.planned.body.data.pullBatch.reason, 'installing')
      assert.equal(large.approved.statusCode, 409, JSON.stringify(large.approved.body))
      assert.equal(large.approved.body.error.code, PULL_BATCH_ERROR_CODES.INSTALL_IN_PROGRESS)
    })
    // The chunk: approved while resolved, then the install starts — the chunk refuses and the job is untouched.
    const k = mount()
    try {
      await withSwitch('true', async () => {
        const large = await largeFlow(k, { run: false })
        assert.equal(large.approved.statusCode, 202, JSON.stringify(large.approved.body))
        const applyJobId = large.approved.body.data.jobId
        await k.ledgerDb.updateRow(pbKit.T.sheet, { history_status: 'installing', settings_locked_at: '2026-11-08T00:30:00.000Z' }, { sheet_id: k.sheetId })
        const keyOf = [...k.context.storage.keys()].find((key) => key.includes(applyJobId))
        const before = JSON.stringify(await k.context.storage.get(keyOf))
        const chunk = await call(k, 'POST', `${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params: { jobId: large.jobId, applyJobId } })
        assert.equal(chunk.statusCode, 409, JSON.stringify(chunk.body))
        assert.equal(chunk.body.error.code, PULL_BATCH_ERROR_CODES.INSTALL_IN_PROGRESS)
        assert.equal(JSON.stringify(await k.context.storage.get(keyOf)), before, 'the job is exactly as it was')
        assert.equal(hostWrites(k).length, 0)
      })
    } finally { k.restore() }
  } finally { h.restore() }
})

test('LN-07 ON, _sheet absent or pending ⇒ history_pending, unstamped, no ledger write', async () => {
  for (const sheet of [null, 'pending']) {
    const h = mount({ sheet })
    try {
      await withSwitch('true', async () => {
        const { dry, applied } = await pull(h)
        assert.equal(dry.body.data.pullBatch.reason, 'history_pending')
        assert.deepEqual(applied.body.data.pullBatch, { stamped: false, reason: 'history_pending' })
      })
      assert.deepEqual(ledgerWrites(h), [], `${sheet}: reads only`)
    } finally { h.restore() }
  }
})

async function seedSheetRow(h, data) {
  // A row already on the sheet (physical keys), created WITHOUT a creator (a plugin / automation / form insert).
  const mapped = {}
  for (const [key, value] of Object.entries(data)) mapped[h.physical(key)] = value
  await h.records.createRecord({ sheetId: h.sheetId, data: mapped })
  h.records.calls.length = 0
}

test('LN-08 ON, a gap row pauses stamping (history_gap + count); C4: an automation-like row and a forged JSON key without a RUN stamp do not', async () => {
  const pluginKey = JSON.stringify({ projectNo: PROJECT, componentSourceId: 'PART-OLD', parentSourceId: null, path: ['PART-OLD'] })
  const gap = mount()
  try {
    await seedSheetRow(gap, { projectNo: PROJECT, idempotencyKey: pluginKey, componentSourceId: 'PART-OLD', active: true, lastPlmRefreshDecision: 'add' })
    await withSwitch('true', async () => {
      const { dry, applied } = await pull(gap)
      assert.deepEqual(dry.body.data.pullBatch, { preview: true, wouldStamp: false, reason: 'history_gap', gapRows: 1 })
      assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
      assert.deepEqual(applied.body.data.pullBatch, { stamped: false, reason: 'history_gap', gapRows: 1 })
    })
    assert.deepEqual(ledgerWrites(gap), [])
  } finally { gap.restore() }
  for (const [label, data] of [
    ['an automation-like row (non-JSON key, no RUN stamp)', { projectNo: PROJECT, idempotencyKey: 'auto-row-1', componentSourceId: 'PART-AUTO', active: true }],
    ['a forged JSON key without a RUN stamp', { projectNo: PROJECT, idempotencyKey: JSON.stringify({ forged: true }), componentSourceId: 'PART-FORGED', active: true }],
  ]) {
    const h = mount()
    try {
      await seedSheetRow(h, data)
      await withSwitch('true', async () => {
        const { applied } = await pull(h)
        assert.equal(applied.statusCode, 200, `${label}: ${JSON.stringify(applied.body)}`)
        assert.equal(applied.body.data.pullBatch.stamped, true, `${label}: not evidence, not a gap row — the pull stamps`)
      })
    } finally { h.restore() }
  }
})

test('LN-09 ON, a ledger read failure ⇒ apply 503 STORE_FAILED before any create; the preview answers ledger_unreadable', async () => {
  const h = mount()
  try {
    await withSwitch('true', async () => {
      h.ledgerDb.faults.selectOne = () => Object.assign(new Error('relation does not exist'), { code: '42P01' })
      const dry = await dryRun(h)
      assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
      assert.deepEqual(dry.body.data.pullBatch, { preview: true, wouldStamp: false, reason: 'ledger_unreadable' })
      const refused = await apply(h, dry.body.data.dryRunToken)
      assert.equal(refused.statusCode, 503, JSON.stringify(refused.body))
      assert.equal(refused.body.error.code, PULL_BATCH_ERROR_CODES.STORE_FAILED)
      assert.equal(hostWrites(h).length, 0, 'nothing created')
      assert.ok(!JSON.stringify(refused.body).includes('relation'), 'values-free: no driver text')
    })
  } finally { h.restore() }
})

test('LN-10 ON, the captured rule moved between the read and the allocation ⇒ 409 CONFLICT settings_changed, a run stop with nothing created', async () => {
  // The sheet row's rule changes AFTER the lane's one read (a per-sheet edit committing in between).
  let reads = 0
  const h = mount({
    wrapStore: (store, db) => ({
      ...store,
      async readSheetState(input) {
        const state = await store.readSheetState(input)
        // The preview reads first; the edit lands right after the APPLY's read.
        reads += 1
        if (reads === 2) await db.updateRow(pbKit.T.sheet, { first_pull_batch_rule: 'predecessor_suffix' }, { sheet_id: input.sheetId })
        return state
      },
    }),
  })
  try {
    await withSwitch('true', async () => {
      const { applied } = await pull(h)
      assert.equal(applied.statusCode, 409, JSON.stringify(applied.body))
      assert.equal(applied.body.error.code, PULL_BATCH_ERROR_CODES.CONFLICT)
      assert.equal(applied.body.error.details.reason, 'settings_changed')
    })
    assert.equal(hostWrites(h).length, 0)
    assert.equal(h.ledgerDb.rows(pbKit.T.batch).length, 0, 'the allocation rolled back')
  } finally { h.restore() }
})

test('LN-11 ON, large lane: the plan stores a sibling pullBatchPlan (no physical id; not public; not hashed), approve copies it, the chunk stamps under large:<apply job id>', async () => {
  const h = mount()
  const off = mount()
  try {
    const plain = await withSwitch(undefined, () => largeFlow(off, { approve: false }))
    await withSwitch('true', async () => {
      const large = await largeFlow(h)
      assert.equal(large.planned.statusCode, 200, JSON.stringify(large.planned.body))
      assert.deepEqual(large.planned.body.data.pullBatch, { preview: true, wouldStamp: true, reason: null })
      const stored = await h.context.storage.get([...h.context.storage.keys()].find((key) => key.includes(large.jobId) && !key.includes('apply')))
      assert.equal(stored.pullBatchPlan.ready, true)
      assert.equal(JSON.stringify(stored.pullBatchPlan).includes(h.physical('pullBatch')), false, 'critic M2: no physical band id stored')
      assert.equal(hasKeyDeep(large.planned.body.data, 'pullBatchPlan'), false, 'never in a public projection')
      const offStored = await off.context.storage.get([...off.context.storage.keys()].find((key) => key.includes(plain.jobId) && !key.includes('apply')))
      assert.equal(stored.planRevision, offStored.planRevision, 'the plan revision does not hash the pull-batch plan')
      assert.equal(large.approved.statusCode, 202, JSON.stringify(large.approved.body))
      const last = large.chunks[large.chunks.length - 1]
      assert.equal(last.statusCode, 200, JSON.stringify(last.body))
      assert.deepEqual(last.body.data.pullBatch, { stamped: true, label: '第1批（2026-11-08）', batchNo: 1, joined: false, createdRowCount: 1 })
      assert.equal(hasKeyDeep(large.jobGet.body, 'pullBatch'), false, 'the job GET is unchanged')
      assert.equal(hasKeyDeep(large.approved.body, 'pullBatchPlan'), false)
      const [link] = h.ledgerDb.rows(pbKit.T.execution)
      assert.equal(link.execution_ref, `large:${large.applyJobId}`)
      assert.deepEqual([link.lane, link.writer_status, link.created_row_count], ['large_apply', 'succeeded', 1])
      const [row] = await sheetRows(h)
      assert.equal(row.data[h.physical('pullBatch')], '第1批（2026-11-08）')
    })
  } finally { h.restore(); off.restore() }
})

test('LN-12 ON, P-4: an expansion planned while OFF is refused at approval 409 JOB_REPLAN_REQUIRED before the bump (nobody is superseded, no job)', async () => {
  const h = mount()
  try {
    const planned = await withSwitch(undefined, () => largeFlow(h, { approve: false }))
    assert.equal(planned.planned.statusCode, 200)
    const scope = swl.sheetWriteScopeKey(h.sheetId)
    const before = await h.lockEnv.lock.readGeneration(scope)
    await withSwitch('true', async () => {
      const approved = await call(h, 'POST', `${JOBS}/:jobId/apply-jobs`, { params: { jobId: planned.jobId }, body: { confirm: { acceptManualConfirmHold: true } } })
      assert.equal(approved.statusCode, 409, JSON.stringify(approved.body))
      assert.equal(approved.body.error.code, PULL_BATCH_ERROR_CODES.JOB_REPLAN_REQUIRED)
    })
    assert.deepEqual(await h.lockEnv.lock.readGeneration(scope), before, 'the generation did not move')
    assert.equal([...h.context.storage.keys()].filter((key) => key.includes('apply')).length, 0, 'no apply job')
  } finally { h.restore() }
})

test('LN-13 ON, P-3: a gap plan stores { ready: false } and its chunks run UNSTAMPED (never REPLAN forever)', async () => {
  const h = mount()
  try {
    const pluginKey = JSON.stringify({ projectNo: PROJECT, componentSourceId: 'PART-OLD', parentSourceId: null, path: ['PART-OLD'] })
    await seedSheetRow(h, { projectNo: PROJECT, idempotencyKey: pluginKey, componentSourceId: 'PART-OLD', active: true, lastPlmRefreshDecision: 'add' })
    await withSwitch('true', async () => {
      const large = await largeFlow(h)
      assert.deepEqual(large.planned.body.data.pullBatch, { preview: true, wouldStamp: false, reason: 'history_gap', gapRows: 1 })
      assert.equal(large.approved.statusCode, 202, JSON.stringify(large.approved.body))
      const last = large.chunks[large.chunks.length - 1]
      assert.equal(last.statusCode, 200, JSON.stringify(last.body))
      assert.deepEqual(last.body.data.pullBatch, { stamped: false, reason: 'history_gap', gapRows: 1 })
    })
    assert.deepEqual(ledgerWrites(h), [], 'no batch was opened')
  } finally { h.restore() }
})

test('LN-14 P-12: a lease taken between the plan and the approval ⇒ 409 PLAN_SUPERSEDED (expansion_stale), no ledger write, no job', async () => {
  const h = mount()
  try {
    await withSwitch('true', async () => {
      const planned = await largeFlow(h, { approve: false })
      assert.equal(planned.planned.statusCode, 200)
      const scope = swl.sheetWriteScopeKey(h.sheetId)
      const lease = await h.lockEnv.lock.acquire(scope, { purpose: 'small_apply', runId: 'syn-interloper' })
      await h.lockEnv.lock.createGuard(lease).release()
      const approved = await call(h, 'POST', `${JOBS}/:jobId/apply-jobs`, { params: { jobId: planned.jobId }, body: { confirm: { acceptManualConfirmHold: true } } })
      assert.equal(approved.statusCode, 409, JSON.stringify(approved.body))
      assert.equal(approved.body.error.code, swl.PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
      assert.equal(approved.body.error.details.reason, 'expansion_stale')
    })
    assert.deepEqual(ledgerWrites(h), [], 'no ledger write (the approval check only reads)')
  } finally { h.restore() }
})

test('LN-15 egress: with the switch ON, no answer, stored token or stored job record carries a derived physical band id', async () => {
  const h = mount()
  try {
    await withSwitch('true', async () => {
      const bodies = []
      const first = await pull(h)
      bodies.push(first.dry.body, first.applied.body)
      const large = await largeFlow(h)
      bodies.push(large.planned.body, large.approved.body, ...large.chunks.map((chunk) => chunk.body), large.jobGet.body)
      bodies.push((await call(h, 'GET', BOARD, { params: { projectNo: PROJECT } })).body)
      bodies.push((await call(h, 'GET', STATUS, { params: { projectNo: PROJECT } })).body)
      const ids = [h.physical('pullBatch'), h.physical('firstPullBatch')]
      for (const body of bodies) for (const id of ids) assert.equal(JSON.stringify(body).includes(id), false, `no ${id} in an answer`)
      for (const key of h.context.storage.keys()) {
        const text = JSON.stringify(await h.context.storage.get(key))
        for (const id of ids) assert.equal(text.includes(id), false, `no ${id} in stored ${key.split(':')[0]}`)
      }
      assert.ok(bodies.some((body) => hasKeyDeep(body, 'pullBatch')), 'non-vacuous: the stanzas were answered')
    })
  } finally { h.restore() }
})

test('LN-16 cross-lane join: a large job whose batch stays open is JOINED by a small apply of the same content (one digest, no lane prefix)', async () => {
  const h = mount()
  try {
    await withSwitch('true', async () => {
      // The large chunk's create fails (not landed) ⇒ the job ends partial ⇒ the link finishes partial, the batch stays open.
      const create = h.records.createRecord
      h.records.createRecord = async () => { throw Object.assign(new Error('validation'), { code: 'VALIDATION_ERROR' }) }
      const large = await largeFlow(h)
      h.records.createRecord = create
      const last = large.chunks[large.chunks.length - 1]
      assert.equal(last.body.data.status, 'partial', JSON.stringify(last.body))
      const [batch] = h.ledgerDb.rows(pbKit.T.batch)
      assert.equal(batch.status, 'open')
      const { applied } = await pull(h)
      assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
      assert.deepEqual(applied.body.data.pullBatch, { stamped: true, label: '第1批（2026-11-08）', batchNo: 1, joined: true, createdRowCount: 1 })
      assert.equal(h.ledgerDb.rows(pbKit.T.batch).length, 1, 'one batch for one logical pull')
    })
  } finally { h.restore() }
})

test('LN-17 source order: P-1 (after the clean-row bound, before beginExecution); the stamp after the execution exists; the chunk gate before running; the approve check before the bump', () => {
  const code = (file) => fs.readFileSync(path.join(LIB, file), 'utf8').replace(/\r\n/g, '\n')
  const ta = code('stock-preparation-table-actions.cjs')
  const applyBody = ta.slice(ta.indexOf('async function applyStockPreparationAction('), ta.indexOf('\nmodule.exports'))
  const at = (body, needle) => { const i = body.indexOf(needle); assert.ok(i >= 0, needle); return i }
  assert.ok(at(applyBody, 'assertProductionCleanRowsWithinBound(') < at(applyBody, 'prepareSmallApplyPullBatch('))
  assert.ok(at(applyBody, 'prepareSmallApplyPullBatch(') < at(applyBody, 'beginExecution('))
  assert.ok(at(applyBody, 'const execution = ') < at(applyBody, 'stampFor(execution)'), 'critic M9: no TDZ — the stamp is built after the execution exists')
  const lb = code('stock-preparation-large-bom-jobs.cjs')
  const chunkBody = lb.slice(lb.indexOf('async function runLargeBomCheckpointApplyJobChunk('), lb.indexOf('async function planLargeBomBackgroundExpansionJob('))
  assert.ok(at(chunkBody, 'assertWriterAdmitsPlan(') < at(chunkBody, 'input.pullBatchGate('))
  assert.ok(at(chunkBody, 'input.pullBatchGate(') < at(chunkBody, "job.status = 'running'"), 'M-1B-12: the gate runs before running')
  const hr = code('http-routes.cjs')
  const approveBody = hr.slice(hr.indexOf('async tableActionLargeBomApplyJobStart('), hr.indexOf('async tableActionLargeBomApplyJobGet('))
  assert.ok(at(approveBody, 'assertLargeApprovePullBatch(') < at(approveBody, 'createLargeBomCheckpointApplyJob('), 'P-4: before the bump')
})

test('LN-18 vocabularies; the stored-plan states; the execution ref is validated before any IO (critic M6)', async () => {
  assert.deepEqual([...lanes.PULL_BATCH_PREVIEW_REASONS], ['not_installed', 'columns_unproven', 'columns_partial', 'history_pending', 'installing', 'history_gap', 'ledger_unreadable'])
  assert.deepEqual([...PULL_BATCH_RESPONSE_REASONS], ['disabled', 'not_installed', 'columns_unproven', 'columns_partial', 'history_pending', 'history_gap', 'no_creates'])
  assert.equal(lanes.STOCK_PREP_PULL_BATCH_ENABLED_ENV, SWITCH)
  for (const [value, on] of [['true', true], ['TRUE', false], [' true', false], ['true ', false], ['1', false], ['yes', false], ['', false], [undefined, false]]) {
    assert.equal(lanes.stockPrepPullBatchEnabled(value === undefined ? {} : { [SWITCH]: value }), on, JSON.stringify(value))
  }
  assert.equal(lanes.normalizeStoredPullBatchPlan(undefined), null)
  assert.deepEqual(lanes.normalizeStoredPullBatchPlan({ ready: false, reason: 'history_gap', gapRows: 2 }), { ready: false, reason: 'history_gap', gapRows: 2 })
  for (const bad of [{ ready: true }, { ready: false, reason: 'other', gapRows: 1 }, { ready: true, sourceDigest: 'x', firstPullBatchByKey: {}, labelsOnSheet: [], expectedRule: 'material' }, 'x']) {
    assert.throws(() => lanes.normalizeStoredPullBatchPlan(bad), (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID)
  }
  const { executionRefOf } = lanes.__internals
  assert.equal(executionRefOf('small', 'table-action-apply:0b1c'), 'small:table-action-apply:0b1c')
  for (const bad of [undefined, '', '  ', '_leading', '-leading', 'has space', 'x'.repeat(201)]) {
    assert.throws(() => executionRefOf('large', bad), (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID && error.details.field === 'executionRef', JSON.stringify(bad))
  }
  // A malformed route lane input is refused before any IO.
  assert.throws(() => lanes.normalizePullBatchLaneInput({ enabled: 'yes' }), (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID)
  assert.equal(lanes.normalizePullBatchLaneInput(undefined), null)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-lanes.test.cjs', tests)
