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
//   LN-21  S6 C-6 (review MF-1): a takeover right before the allocation ⇒ 409 LEASE_LOST, nothing created, NO batch and
//          NO link — on the small apply and on a large chunk; the finish under the refused holder is a no-op
//   LN-22  (MF-1) the finish runs inside the guard's host-write bracket (open, finish, close) with the holder assert
//   LN-23  (MF-2) the §6.4 chunk-gate rows: no plan on a resolved sheet / band no longer proven / unresolved sheet ⇒
//          409 REPLAN with the job untouched; switch OFF after an ON plan ⇒ the chunk runs UNSTAMPED, zero ledger IO
//   LN-24  (MF-3) the small writer's catch finishes the link failed (count NULL); the batch stays open
//   LN-25  (MF-3) lib level, two chunks: the link is finished ONCE, at the terminal status, with the JOB total
//   LN-26  (MF-5) the defensive guards: a probed id that is not the derived physical id, a not_found preview, a later
//          chunk that allocates nothing, the reader-only lane, a holder assert that is not a function
//   LN-27  F-7 (R-65): a ready stored plan whose stamp the WRITER would refuse (a carry that misses an ADD; a band id
//          that is a key of the job's stored fieldIdMap) is refused by the chunk gate 500 STAMP_INVALID BEFORE `running`
//          — the stored job byte-identical, nothing written, zero ledger IO — and the job resumes once the plan is
//          repaired (on main it stayed `running` and answered 409 RUN_IN_PROGRESS forever); the check covers the
//          decisions from the checkpoint on; switch OFF ⇒ the gate never reads the malformed plan
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
  const store = realStore ? (wrapStore ? wrapStore(realStore, ledgerDb, lockEnv) : realStore) : (untouchable ? untouchable.store : null)
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
async function sheetRows(h) {
  return (await h.records.queryRecords({ sheetId: h.sheetId, filters: {} })).filter((row) => row.sheetId === h.sheetId)
}
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

test('LN-16b large lane, an allocation failure is a RUN STOP: the chunk answers 503 STORE_FAILED, the job is failed (resumable) with nothing created and no batch; the resume stamps under large:<apply job id>', async () => {
  const h = mount()
  try {
    await withSwitch('true', async () => {
      const large = await largeFlow(h, { run: false })
      assert.equal(large.approved.statusCode, 202, JSON.stringify(large.approved.body))
      const applyJobId = large.approved.body.data.jobId
      const keyOf = [...h.context.storage.keys()].find((key) => key.includes(applyJobId))
      h.ledgerDb.faults.insertOne = () => Object.assign(new Error('permission denied'), { code: '42501' })
      const stopped = await call(h, 'POST', `${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params: { jobId: large.jobId, applyJobId } })
      delete h.ledgerDb.faults.insertOne
      assert.equal(stopped.statusCode, 503, JSON.stringify(stopped.body))
      assert.equal(stopped.body.error.code, PULL_BATCH_ERROR_CODES.STORE_FAILED)
      const job = await h.context.storage.get(keyOf)
      assert.equal(job.status, 'failed', 'resumable')
      assert.ok(job.evidence.errorCodes.includes(PULL_BATCH_ERROR_CODES.STORE_FAILED))
      assert.equal(job.checkpoint.nextDecisionIndex, 0, 'stopped at the first create')
      assert.equal(hostWrites(h).length, 0, 'nothing created')
      assert.equal(h.ledgerDb.rows(pbKit.T.batch).length, 0, 'the allocation rolled back')
      const resumed = await call(h, 'POST', `${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params: { jobId: large.jobId, applyJobId } })
      assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.body))
      assert.equal(resumed.body.data.pullBatch.stamped, true)
      const [link] = h.ledgerDb.rows(pbKit.T.execution)
      assert.equal(link.execution_ref, `large:${applyJobId}`)
      assert.equal(link.created_row_count, 1)
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

test('LN-19 the probe fold (M-1B-4): optional ids are appended ONLY when asked, never refuse, and answer the verdict; without them the probe input is byte-identical', async () => {
  const { __internals: { assertTargetFieldsExist } } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
  const h = mount({ band: false })
  try {
    const action = { target: { sheetId: h.sheetId, objectId: h.objectId, fieldIdMap: {} }, template: undefined, extensionFieldIds: [] }
    const { assertStockPreparationTargetReady } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
    const ready = assertStockPreparationTargetReady({ actionId: ACTION, source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' }, target: action.target })
    const input = { provisioning: h.provisioning, projectId: h.staging }
    h.provisioning.calls.length = 0
    const plain = await assertTargetFieldsExist(ready, input)
    const plainCall = h.provisioning.calls.find(([verb]) => verb === 'resolveExistingObjectFieldIds')
    h.provisioning.calls.length = 0
    const folded = await assertTargetFieldsExist(ready, input, { optionalFieldIds: lanes.PULL_BATCH_PROBE_FIELD_IDS })
    const foldedCall = h.provisioning.calls.find(([verb]) => verb === 'resolveExistingObjectFieldIds')
    assert.deepEqual(foldedCall[2].slice(0, plainCall[2].length), plainCall[2], 'the template / ext ids are probed exactly as before')
    assert.deepEqual(foldedCall[2].slice(plainCall[2].length), ['pullBatch', 'firstPullBatch'], 'the optional ids are appended')
    assert.deepEqual({ ...plain.optional }, {}, 'no optional ids, no optional answers')
    assert.equal(folded.fieldExistenceMode, 'db')
    assert.deepEqual({ ...folded.optional }, { pullBatch: null, firstPullBatch: null }, 'missing band ids never refuse (no 422 on a band-less sheet)')
    assert.equal(await assertTargetFieldsExist(ready, undefined), null, 'an early return answers null')
  } finally { h.restore() }
})

test('LN-20 the strip runs BEFORE the prefix classification (M-1B-3): a parked manual row carries the Symbol too; absent band ⇒ no Symbol at all', async () => {
  const { __internals: { readExistingStockPreparationRows } } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
  const { manualPrefixRowsOf } = require(path.join(LIB, 'stock-preparation-manual-rows.cjs'))
  const band = { fieldIds: { pullBatch: 'fld_syn_pb', firstPullBatch: 'fld_syn_fpb' } }
  const records = [
    { id: 'rec_1', version: 1, createdAt: '2026-11-08T01:00:00.000Z', locked: true, data: { projectNo: PROJECT, idempotencyKey: '{"k":1}', fld_syn_pb: '第1批（2026-11-08）', fld_syn_fpb: '第1批（2026-11-08）' } },
    { id: 'rec_2', version: 1, createdBy: 'u_person', data: { projectNo: PROJECT, idempotencyKey: 'manual:v1:rec_2', fld_syn_pb: '人工补充', firstPullBatch: '人工补充' } },
  ]
  const api = { async queryRecords() { return records.map((record) => JSON.parse(JSON.stringify(record))) } }
  const target = { sheetId: 'sheet_syn', objectId: `plm_stock_preparation_sandbox_p_${'0'.repeat(24)}`, fieldIdMap: {} }
  const rows = await readExistingStockPreparationRows(api, target, PROJECT, { pullBatchBand: band })
  const SYMBOL = Symbol.for('metasheet.stock-preparation.existingRow.pullBatch')
  assert.deepEqual({ ...rows[0][SYMBOL] }, { pullBatch: '第1批（2026-11-08）', firstPullBatch: '第1批（2026-11-08）', createdAt: '2026-11-08T01:00:00.000Z', locked: true })
  assert.equal(Object.keys(rows[0]).some((key) => key === 'fld_syn_pb' || key === 'fld_syn_fpb'), false, 'both cells left the string keys')
  const parked = manualPrefixRowsOf(rows)
  assert.equal(rows.length, 1, 'the manual row left the planner array')
  assert.equal(parked.manualRows.length, 1, 'it was parked as a manual row (M′)')
  assert.equal(parked.manualRows[0].row[SYMBOL].pullBatch, '人工补充', 'the parked manual row carries the Symbol')
  assert.equal(parked.manualRows[0].row[SYMBOL].firstPullBatch, '人工补充', 'the logical id is stripped too (defensive)')
  const bare = await readExistingStockPreparationRows(api, target, PROJECT)
  assert.equal(bare[0][SYMBOL], undefined, 'no band ⇒ no Symbol (byte-identical rows)')
  assert.equal(bare[0].fld_syn_pb, '第1批（2026-11-08）')
  await assert.rejects(readExistingStockPreparationRows(api, { ...target, fieldIdMap: { notes: 'fld_syn_pb' } }, PROJECT, { pullBatchBand: band }), (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID)
})

// ── review fixes (verify round 1: MF-1, MF-2, MF-3, MF-5) ─────────────────────────────────────────────────────────

const LEASE_LOST = swl.PROJECT_WRITE_ERROR_CODES.LEASE_LOST
const CHUNK = `${JOBS}/:jobId/apply-jobs/:applyJobId/run`

/** THE TAKEOVER: another holder's lease lands on every lock row (a new lease id and a later fencing epoch). */
function takeOver(lockEnv) {
  const table = lockEnv.db.tables.get(LOCK_TABLE)
  let moved = 0
  for (const [key, row] of table ? table.entries() : []) {
    table.set(key, { ...row, lease_id: 'lease-syn-other-holder', fencing_epoch: Number(row.fencing_epoch || 0) + 1 })
    moved += 1
  }
  return moved
}

/** A store wrapper that lands the takeover right before the allocation and records what the store was handed. */
function takeoverBeforeAllocate() {
  const seen = { allocateHolder: [], finish: [] }
  const wrapStore = (store, _db, lockEnv) => ({
    ...store,
    async allocate(input) {
      seen.allocateHolder.push(typeof input.holderWithin === 'function')
      assert.ok(takeOver(lockEnv) > 0, 'non-vacuous: a lease row was taken over')
      return store.allocate(input)
    },
    async finish(input) {
      const outcome = await store.finish(input)
      seen.finish.push({ writerStatus: input.writerStatus, holder: typeof input.holderWithin === 'function', outcome: outcome && outcome.outcome })
      return outcome
    },
  })
  return { seen, wrapStore }
}

async function storedJobText(h, applyJobId) {
  const key = [...h.context.storage.keys()].find((entry) => entry.includes(applyJobId))
  assert.ok(key, 'the apply job is stored')
  return JSON.stringify(await h.context.storage.get(key))
}

test('LN-21 S6 C-6 (MF-1): a takeover right before the allocation ⇒ 409 LEASE_LOST with nothing created and NO batch or link opened by the non-holder — small apply and large chunk; the finish under the refused holder is a no-op (holder_refused)', async () => {
  // The small apply (the lane's holder is bound to THIS apply's lease: http-routes apply context { guard }).
  const small = takeoverBeforeAllocate()
  const h = mount({ wrapStore: small.wrapStore })
  try {
    await withSwitch('true', async () => {
      const dry = await dryRun(h)
      assert.deepEqual(dry.body.data.pullBatch, { preview: true, wouldStamp: true, reason: null })
      const applied = await apply(h, dry.body.data.dryRunToken)
      assert.equal(applied.statusCode, 409, JSON.stringify(applied.body))
      assert.equal(applied.body.error.code, LEASE_LOST)
    })
    assert.deepEqual(small.seen.allocateHolder, [true], 'the allocation was handed the holder assert')
    assert.equal(hostWrites(h).length, 0, 'nothing created')
    assert.equal((await sheetRows(h)).length, 0)
    assert.equal(h.ledgerDb.rows(pbKit.T.batch).length, 0, 'no batch opened by a non-holder')
    assert.equal(h.ledgerDb.rows(pbKit.T.execution).length, 0, 'no execution link opened by a non-holder')
    assert.deepEqual(small.seen.finish, [{ writerStatus: 'aborted', holder: true, outcome: 'holder_refused' }], 'the finish ran under the holder assert and was refused (a logged no-op)')
  } finally { h.restore() }
  // The large chunk (the lane is re-bound INSIDE the chunk's lease: pullBatchLaneInLease).
  const large = takeoverBeforeAllocate()
  const k = mount({ wrapStore: large.wrapStore })
  try {
    await withSwitch('true', async () => {
      const flow = await largeFlow(k, { run: false })
      assert.equal(flow.approved.statusCode, 202, JSON.stringify(flow.approved.body))
      const chunk = await call(k, 'POST', CHUNK, { params: { jobId: flow.jobId, applyJobId: flow.approved.body.data.jobId } })
      assert.equal(chunk.statusCode, 409, JSON.stringify(chunk.body))
      assert.equal(chunk.body.error.code, LEASE_LOST)
    })
    assert.deepEqual(large.seen.allocateHolder, [true], 'the chunk allocation was handed the holder assert of the chunk lease')
    assert.equal(hostWrites(k).length, 0, 'nothing created')
    assert.equal(k.ledgerDb.rows(pbKit.T.batch).length, 0, 'no batch opened by a non-holder')
    assert.equal(k.ledgerDb.rows(pbKit.T.execution).length, 0, 'no execution link opened by a non-holder')
  } finally { k.restore() }
})

test('LN-22 (MF-1) the finish runs INSIDE the guard host-write bracket (open, finish, close — as AW-8 pins for the allocation) and hands the store the lane holder assert; the catch-path finish too', async () => {
  const order = []
  const holderWithin = async () => {}
  const store = {
    async readSheetState() {
      return { sheet: { historyStatus: 'born_empty', firstPullBatchRule: 'material', labelFormat: 'ordinal_date', labelLocale: 'zh-CN' }, batches: [] }
    },
    async allocate() { throw new Error('LN-22: no allocation is asked here') },
    async finish(input) {
      order.push('finish', input.holderWithin === holderWithin ? 'holder' : 'no_holder')
      return { outcome: 'closed' }
    },
  }
  const band = { fieldIds: { pullBatch: 'fld_syn_ln22_pb', firstPullBatch: 'fld_syn_ln22_fpb' } }
  const lane = lanes.normalizePullBatchLaneInput({ enabled: true, band, store, tenantId: TENANT, holderWithin })
  const writeFence = { async withHostWrite(fn) { order.push('bracket:open'); try { return await fn() } finally { order.push('bracket:close') } } }
  const run = await lanes.prepareSmallApplyPullBatch({
    lane,
    dryRun: { pullBatch: { fieldIds: band.fieldIds, mode: 'db', present: { pullBatch: true, firstPullBatch: true } }, existingRows: [], plan: { decisions: [] }, expansion: { rows: [] } },
    action: { actionId: ACTION, target: { sheetId: 'sheet_syn_ln22', keyField: 'idempotencyKey' } },
    parameters: { projectNo: PROJECT },
    runId: 'table-action-apply:syn-ln22',
    canonicalRows: (rows) => rows,
    writeFence,
  })
  assert.equal(run.evaluation.ready, true, 'calibration: a ready run')
  await run.finish({ status: 'succeeded', pullBatch: { allocated: true, stampedRowCount: 1 } })
  assert.deepEqual(order, ['bracket:open', 'finish', 'holder', 'bracket:close'], 'finish is bracketed and carries the holder assert')
  order.length = 0
  await run.finishFailed()
  assert.deepEqual(order, ['bracket:open', 'finish', 'holder', 'bracket:close'], 'the catch-path finish is bracketed too')
})

test('LN-23 (MF-2) the §6.4 chunk-gate rows: no plan on a resolved sheet / band no longer proven / unresolved sheet ⇒ 409 REPLAN, job untouched; switch OFF after an ON plan ⇒ the chunk runs UNSTAMPED with zero ledger IO (the kill switch)', async () => {
  const chunkOf = (h, flow) => call(h, 'POST', CHUNK, { params: { jobId: flow.jobId, applyJobId: flow.approved.body.data.jobId } })
  async function refusedUntouched(h, flow, reason) {
    const applyJobId = flow.approved.body.data.jobId
    const before = await storedJobText(h, applyJobId)
    h.ledgerDb.log.length = 0
    const chunk = await withSwitch('true', () => chunkOf(h, flow))
    assert.equal(chunk.statusCode, 409, `${reason}: ${JSON.stringify(chunk.body)}`)
    assert.equal(chunk.body.error.code, PULL_BATCH_ERROR_CODES.JOB_REPLAN_REQUIRED, reason)
    assert.equal(chunk.body.error.details.reason, reason)
    assert.equal(await storedJobText(h, applyJobId), before, `${reason}: the job is exactly as it was (status, checkpoint, counts)`)
    assert.equal(hostWrites(h).length, 0, `${reason}: nothing written`)
    assert.deepEqual(ledgerWrites(h), [], `${reason}: no ledger write`)
  }
  // (1) planned and approved while OFF; the chunk runs after the switch is ON, on a RESOLVED sheet.
  {
    const h = mount()
    try {
      const flow = await withSwitch(undefined, () => largeFlow(h, { run: false }))
      assert.equal(flow.approved.statusCode, 202, JSON.stringify(flow.approved.body))
      await refusedUntouched(h, flow, 'planned_before_install')
    } finally { h.restore() }
  }
  // (2) planned and approved while ON (a ready plan); the band is no longer db-proven at the chunk.
  for (const [label, unprove] of [
    ['a computed-only probe', (h) => { delete h.provisioning.resolveExistingObjectFieldIds }],
    ['one band column left', (h) => { h.provisioning.objects.get(`${h.staging}/${h.objectId}`).fields.delete('firstPullBatch') }],
  ]) {
    const h = mount()
    try {
      const flow = await withSwitch('true', () => largeFlow(h, { run: false }))
      assert.equal(flow.approved.statusCode, 202, `${label}: ${JSON.stringify(flow.approved.body)}`)
      unprove(h)
      await refusedUntouched(h, flow, 'band_unproven')
    } finally { h.restore() }
  }
  // (3) a ready plan whose _sheet row went back to pending.
  {
    const h = mount()
    try {
      const flow = await withSwitch('true', () => largeFlow(h, { run: false }))
      assert.equal(flow.approved.statusCode, 202, JSON.stringify(flow.approved.body))
      await h.ledgerDb.updateRow(pbKit.T.sheet, { history_status: 'pending', resolved_at: null, resolved_by: null, history_mode: null, history_batch_count: null }, { sheet_id: h.sheetId })
      await refusedUntouched(h, flow, 'history_unresolved')
    } finally { h.restore() }
  }
  // (4) THE KILL SWITCH: planned and approved while ON, the chunk runs after the switch is turned OFF.
  {
    const h = mount()
    try {
      const flow = await withSwitch('true', () => largeFlow(h, { run: false }))
      assert.equal(flow.approved.statusCode, 202, JSON.stringify(flow.approved.body))
      assert.deepEqual(flow.planned.body.data.pullBatch, { preview: true, wouldStamp: true, reason: null }, 'calibration: a ready plan')
      h.ledgerDb.log.length = 0
      const chunk = await withSwitch(undefined, () => chunkOf(h, flow))
      assert.equal(chunk.statusCode, 200, JSON.stringify(chunk.body))
      assert.equal(chunk.body.data.status, 'succeeded')
      assert.equal(hasKeyDeep(chunk.body, 'pullBatch'), false, 'no pullBatch key while OFF')
      const rows = await sheetRows(h)
      assert.ok(rows.length > 0, 'non-vacuous: the chunk created rows')
      for (const row of rows) {
        assert.equal(row.data[h.physical('pullBatch')], undefined, 'unstamped 本次拉取')
        assert.equal(row.data[h.physical('firstPullBatch')], undefined, 'unstamped 首次批次')
      }
      assert.deepEqual(h.ledgerDb.log, [], 'zero ledger IO while OFF')
    } finally { h.restore() }
  }
})

test('LN-24 (MF-3) design §6.3: the small writer throws AFTER its decisions ran ⇒ the catch finishes the link failed (finished, count NULL), the batch stays open, the apply is refused', async () => {
  const h = mount()
  try {
    await withSwitch('true', async () => {
      const dry = await dryRun(h)
      assert.equal(dry.body.data.pullBatch.wouldStamp, true, 'calibration: a ready run')
      // The host metadata scope runs the decisions, then fails on exit (a post-run fault the writer does not catch).
      h.context.api.multitable.records.withMetadataCache = async (fn) => {
        await fn()
        throw Object.assign(new Error('synthetic metadata scope failure after the run'), { code: 'SYNTHETIC_SCOPE_EXIT' })
      }
      const applied = await apply(h, dry.body.data.dryRunToken)
      assert.ok(applied.statusCode >= 400, `the apply is refused: ${JSON.stringify(applied.body)}`)
    })
    const links = h.ledgerDb.rows(pbKit.T.execution)
    assert.equal(links.length, 1, 'calibration: the allocation ran (a link exists)')
    assert.deepEqual([links[0].writer_status, Boolean(links[0].finished_at), links[0].created_row_count], ['failed', true, null])
    const batches = h.ledgerDb.rows(pbKit.T.batch)
    assert.deepEqual(batches.map((batch) => batch.status), ['open'], 'a failed run never closes its batch')
  } finally { h.restore() }
})

test('LN-25 (MF-3) large lane, lib level: over two chunks (maxDecisionsPerChunk 1) the link is finished ONCE, at the terminal status, with the JOB total of stamped creates — not the last chunk count', async () => {
  const largeBomJobs = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))
  const SCOPE = Object.freeze({ tenantId: 'tenant-syn-pbl-lb', workspaceId: 'workspace-syn-pbl-lb' })
  const lockHarness = lockKit.createLibWriteLockHarness()
  const storage = lockKit.createConsumableStorage()
  storage.durable = true
  const action = lockKit.goldenAction()
  const source = lockKit.createSourceAdapter(lockKit.goldenPlmData())
  await lockHarness.wrapLargeExpansionStart(largeBomJobs.createLargeBomBackgroundExpansionJob)({ storage, ...SCOPE, action, parameters: { projectNo: lockKit.GOLDEN_PROJECT_NO }, principal: 'ln25-principal', createJobId: () => 'ln25-job-1', now: () => '2026-11-08T01:00:00.000Z' })
  await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...SCOPE, actionId: action.actionId, jobId: 'ln25-job-1', sourceAdapter: source.adapter, now: () => '2026-11-08T01:01:00.000Z' })
  await lockHarness.wrapLargePlan(largeBomJobs.planLargeBomBackgroundExpansionJob)({ storage, ...SCOPE, actionId: action.actionId, jobId: 'ln25-job-1', existingRows: [], plannedAt: lockKit.GOLDEN_PLANNED_AT, runId: lockKit.GOLDEN_RUN_ID, now: () => '2026-11-08T01:02:00.000Z' })
  await lockHarness.wrapLargeApprove(largeBomJobs.createLargeBomCheckpointApplyJob)({ storage, ...SCOPE, actionId: action.actionId, jobId: 'ln25-job-1', principal: 'ln25-principal', permission: 'write', createApplyJobId: () => 'ln25-apply-1', now: () => '2026-11-08T01:03:00.000Z' })
  const env = lockHarness.refresh()
  const key = largeBomJobs.__internals.checkpointApplyJobKey({ ...SCOPE, actionId: action.actionId, applyJobId: 'ln25-apply-1' })
  const approved = await storage.get(key)
  const adds = lanes.__internals.decisionsForCarry(approved.plan.decisions, approved.target && approved.target.keyField).filter((decision) => decision.decision === 'add')
  assert.ok(adds.length >= 2, `calibration: at least two ADDs (got ${adds.length})`)
  const carry = new Map(adds.map((decision) => [decision.idempotencyKey, null]))
  const finishes = []
  let allocations = 0
  const pullBatchGate = async () => ({
    stamp: {
      fieldIds: { pullBatch: 'fld_syn_ln25_pb', firstPullBatch: 'fld_syn_ln25_fpb' },
      firstPullBatchByKey: carry,
      allocate: async () => {
        allocations += 1
        return { batchId: 'batch_syn_ln25', batchNo: 1, label: '第1批（2026-11-08）', joined: allocations > 1 }
      },
    },
    finish: async (input) => { finishes.push({ ...input }) },
  })
  const rows = []
  const recordsApi = {
    async queryRecords(input = {}) {
      return rows.filter((row) => row.sheetId === input.sheetId)
        .filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row.data[field] === expected))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000)).map((row) => JSON.parse(JSON.stringify(row)))
    },
    async createRecord(input = {}) {
      const row = { id: `ln25_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(row)
      return JSON.parse(JSON.stringify(row))
    },
    async patchRecord() { throw new Error('LN-25: no patch is planned') },
  }
  const scopeKey = swl.sheetWriteScopeKey(action.target.sheetId)
  const statuses = []
  for (let i = 0; i < adds.length + 2; i += 1) {
    const job = await lockHarness.lock.withProjectWriteLease(scopeKey, { purpose: 'large_apply_chunk', runId: `ln25-chunk-${i}`, tenantId: SCOPE.tenantId }, (guard) => largeBomJobs.runLargeBomCheckpointApplyJobChunk({
      storage,
      ...SCOPE,
      actionId: action.actionId,
      applyJobId: 'ln25-apply-1',
      recordsApi: lockKit.withFakeHostWriteFence(recordsApi),
      projectWriteGuard: guard,
      refreshGovernanceGate: env.chunkGateFor(SCOPE.tenantId, lockKit.GOLDEN_PROJECT_NO),
      maxDecisionsPerChunk: 1,
      pullBatchGate,
    }))
    statuses.push(job.status)
    if (job.status !== 'paused') break
    assert.deepEqual(finishes, [], `chunk ${i + 1} paused: the link is not finished before the terminal status`)
  }
  assert.ok(statuses.filter((status) => status === 'paused').length >= 1, `calibration: the job paused between chunks (${statuses.join(',')})`)
  assert.equal(statuses[statuses.length - 1], 'succeeded')
  assert.equal(rows.length, adds.length, 'calibration: every ADD landed, one per chunk')
  assert.deepEqual(finishes, [{ writerStatus: 'succeeded', createdRowCount: adds.length }], 'finished ONCE, with the job total')
  assert.equal((await storage.get(key)).pullBatchStampedRowCount, adds.length, 'the running total across chunks')
})

test('LN-26 (MF-5) the defensive guards: a probed id that is not the derived physical id is not present; a not_found preview answers no stanza; a later chunk never forgets an allocation; the reader-only lane; a holder assert that is not a function', async () => {
  // (a) LN:173 — the probe resolves the logical band ids to OTHER physical ids than the derivation: nothing is present,
  // so the lane does not stamp and reads no ledger. (Brief §5.4 named `columns_unproven`; the lane answers
  // `not_installed` because neither derived column is proven present — recorded as a deviation in the PR body.)
  {
    const h = mount()
    try {
      const resolve = h.provisioning.resolveExistingObjectFieldIds
      h.provisioning.resolveExistingObjectFieldIds = async (input) => {
        const out = await resolve.call(h.provisioning, input)
        for (const id of ['pullBatch', 'firstPullBatch']) if (typeof out[id] === 'string') out[id] = `fld_syn_elsewhere_${id}`
        return out
      }
      await withSwitch('true', async () => {
        const { dry, applied } = await pull(h)
        assert.deepEqual(dry.body.data.pullBatch, { preview: true, wouldStamp: false, reason: 'not_installed' })
        assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
        assert.deepEqual(applied.body.data.pullBatch, { stamped: false, reason: 'not_installed' })
      })
      assert.deepEqual(h.ledgerDb.log, [], 'no ledger IO')
      const [row] = await sheetRows(h)
      assert.equal(row.data[h.physical('pullBatch')], undefined)
      assert.equal(row.data[h.physical('firstPullBatch')], undefined)
    } finally { h.restore() }
  }
  // (b) LN:445 (critic M11) — a project the source does not know: the dry-run answers NO pullBatch key while ON.
  {
    const h = mount()
    try {
      const read = h.source.adapter.read
      h.source.adapter.read = async (input = {}) => {
        const answer = await read(input)
        if (input.object === 'DN_PDM_PathExAttrInfo') answer.records = []
        return answer
      }
      await withSwitch('true', async () => {
        const dry = await dryRun(h)
        assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
        assert.equal(dry.body.data.status, 'not_found', 'calibration: the source does not know the project')
        assert.equal(hasKeyDeep(dry.body, 'pullBatch'), false, 'no stanza for a project the source does not have')
      })
      assert.deepEqual(h.ledgerDb.log, [], 'no ledger IO')
    } finally { h.restore() }
  }
  // (c) LN:619 — a two-chunk job whose second chunk creates nothing keeps the first chunk's allocation.
  const allocated = { allocated: true, batchNo: 3, label: '第3批（2026-11-08）', joined: false }
  const stampedGate = { stamp: { fieldIds: {} } }
  assert.deepEqual(lanes.mergeLargePullBatchRun(allocated, stampedGate, { pullBatch: { allocated: false, stampedRowCount: 0 } }), allocated, 'a stamped chunk with no create keeps the allocation')
  assert.deepEqual(lanes.mergeLargePullBatchRun(allocated, { stamp: null, reason: 'history_gap', gapRows: 1 }, { pullBatch: null }), allocated, 'an unstamped later chunk keeps it too')
  assert.deepEqual(lanes.mergeLargePullBatchRun(null, stampedGate, { pullBatch: { allocated: false } }), { allocated: false, reason: 'no_creates' }, 'calibration: no earlier allocation ⇒ no_creates')
  assert.deepEqual(
    lanes.largeChunkAnswerOf({ enabled: true }, { pullBatchRun: lanes.mergeLargePullBatchRun(allocated, stampedGate, { pullBatch: { allocated: false } }), pullBatchStampedRowCount: 2 }),
    { stamped: true, label: '第3批（2026-11-08）', batchNo: 3, joined: false, createdRowCount: 2 },
    'the stanza still says stamped',
  )
  // (d) LN:151 — the reconcile / mvp-persist lane is the band ONLY: switch reading dropped, no store, no holder, no fold.
  const band = { fieldIds: { pullBatch: 'fld_syn_ln26_pb', firstPullBatch: 'fld_syn_ln26_fpb' } }
  const readerOnly = lanes.readerOnlyLaneOf({ enabled: true, band, store: { readSheetState() {} }, tenantId: TENANT, holderWithin: async () => {} })
  assert.deepEqual({ ...readerOnly, band: { ...readerOnly.band, fieldIds: { ...readerOnly.band.fieldIds } } }, { band, enabled: false, store: null, tenantId: TENANT, holderWithin: null })
  assert.equal(lanes.pullBatchProbeOptions(readerOnly), undefined, 'no probe fold on the reader-only lanes while ON')
  assert.deepEqual(lanes.pullBatchProbeOptions(lanes.normalizePullBatchLaneInput({ enabled: true, band, tenantId: TENANT })), { optionalFieldIds: lanes.PULL_BATCH_PROBE_FIELD_IDS }, 'calibration: the full lane folds')
  assert.equal(lanes.readerOnlyLaneOf(undefined), null)
  // (e) LN:132 — a holder assert that is not a function is a route defect: 500 STAMP_INVALID before any IO.
  for (const holderWithin of ['x', 1, {}, true]) {
    assert.throws(
      () => lanes.normalizePullBatchLaneInput({ enabled: true, band, tenantId: TENANT, holderWithin }),
      (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID && error.status === 500 && error.details.field === 'pullBatch.holderWithin',
      JSON.stringify(holderWithin),
    )
    assert.throws(() => lanes.readerOnlyLaneOf({ enabled: true, band, tenantId: TENANT, holderWithin }), (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID)
  }
})

test('LN-27 F-7 (R-65): a stored plan whose stamp the writer would refuse is refused by the chunk gate 500 STAMP_INVALID BEFORE running — job untouched, nothing written, zero ledger IO — and the job resumes once repaired; the check starts at the checkpoint; switch OFF never reads it', async () => {
  const chunkOf = (h, flow) => call(h, 'POST', CHUNK, { params: { jobId: flow.jobId, applyJobId: flow.approved.body.data.jobId } })
  const keyOf = (h, applyJobId) => [...h.context.storage.keys()].find((entry) => entry.includes(applyJobId))
  // (a) / (b) route level, through the REAL chunk route, gate, store and writer.
  for (const [label, corrupt, field] of [
    ['a carry that misses the ADD', (job) => { job.pullBatchPlan.firstPullBatchByKey = {} }, 'pullBatchStamp.firstPullBatchByKey'],
    ['a band id that is a key of the stored fieldIdMap', (job, h) => { job.target.fieldIdMap = { ...job.target.fieldIdMap, [h.physical('pullBatch')]: 'fld_syn_ln27_unused' } }, 'fieldIds'],
  ]) {
    const h = mount()
    try {
      await withSwitch('true', async () => {
        const flow = await largeFlow(h, { run: false })
        assert.equal(flow.approved.statusCode, 202, `${label}: ${JSON.stringify(flow.approved.body)}`)
        const applyJobId = flow.approved.body.data.jobId
        const key = keyOf(h, applyJobId)
        const pristine = await h.context.storage.get(key)
        assert.equal(pristine.pullBatchPlan.ready, true, `${label}: calibration — a ready plan`)
        assert.ok(pristine.plan.decisions.some((decision) => decision && decision.decision === 'add'), `${label}: calibration — the job has an ADD`)
        const corrupted = JSON.parse(JSON.stringify(pristine))
        corrupt(corrupted, h)
        await h.context.storage.set(key, corrupted)
        const before = await storedJobText(h, applyJobId)
        h.ledgerDb.log.length = 0
        const refused = await chunkOf(h, flow)
        assert.equal(refused.statusCode, 500, `${label}: ${JSON.stringify(refused.body)}`)
        assert.equal(refused.body.error.code, PULL_BATCH_ERROR_CODES.STAMP_INVALID, label)
        assert.equal(refused.body.error.details.field, field, label)
        assert.equal(await storedJobText(h, applyJobId), before, `${label}: the job is exactly as it was — never stored as running`)
        assert.equal((await h.context.storage.get(key)).status, 'queued', `${label}: still runnable`)
        assert.equal(hostWrites(h).length, 0, `${label}: nothing written`)
        assert.deepEqual(h.ledgerDb.log, [], `${label}: zero ledger IO (refused before the ledger read)`)
        // Repaired, the SAME job runs: no RUN_IN_PROGRESS strand.
        await h.context.storage.set(key, pristine)
        const resumed = await chunkOf(h, flow)
        assert.equal(resumed.statusCode, 200, `${label}: ${JSON.stringify(resumed.body)}`)
        assert.equal(resumed.body.data.status, 'succeeded', label)
        assert.equal(resumed.body.data.pullBatch.stamped, true, `${label}: the repaired job stamps`)
      })
    } finally { h.restore() }
  }
  // (c) lib level: the check covers the decisions FROM THE CHECKPOINT ON (the writer's chunks still to run), zero IO.
  const band = { fieldIds: { pullBatch: 'fld_syn_ln27_pb', firstPullBatch: 'fld_syn_ln27_fpb' } }
  const probe = { fieldIds: band.fieldIds, mode: 'db', present: { pullBatch: true, firstPullBatch: true } }
  let reads = 0
  const lane = { enabled: true, band, tenantId: TENANT, holderWithin: null, store: { async readSheetState() { reads += 1; return { sheet: { historyStatus: 'born_empty' }, batches: [] } } } }
  const add = (key) => ({ decision: 'add', idempotencyKey: key, record: { idempotencyKey: key } })
  const jobAt = (nextDecisionIndex) => ({
    jobId: 'ln27-apply-1',
    target: { sheetId: 'sheet_syn_ln27', keyField: 'idempotencyKey', fieldIdMap: {} },
    plan: { decisions: [add('ln27-k1'), add('ln27-k2')] },
    checkpoint: { nextDecisionIndex, completedChunks: nextDecisionIndex },
    pullBatchPlan: { ready: true, firstPullBatchByKey: { 'ln27-k2': null }, sourceDigest: 'a'.repeat(32), labelsOnSheet: [], expectedRule: 'material' },
  })
  await assert.rejects(
    lanes.largeChunkPullBatchGate({ lane, probe, job: jobAt(0), projectNo: PROJECT }),
    (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID && error.status === 500 && error.details.field === 'pullBatchStamp.firstPullBatchByKey' && error.details.partial === false,
    'checkpoint 0: ln27-k1 is still to run and the carry misses it',
  )
  assert.equal(reads, 0, 'refused before the ledger read')
  const admitted = await lanes.largeChunkPullBatchGate({ lane, probe, job: jobAt(1), projectNo: PROJECT })
  assert.ok(admitted && admitted.stamp, 'checkpoint 1: only ln27-k2 is still to run, and the carry covers it')
  assert.deepEqual(admitted.stamp.fieldIds, band.fieldIds)
  assert.deepEqual([...admitted.stamp.firstPullBatchByKey], [['ln27-k2', null]])
  assert.equal(reads, 1, 'calibration: the admitted gate read the ledger once')
  // (d) switch OFF: the gate is inert — it never reads the malformed plan; the chunk runs unstamped.
  assert.equal(await lanes.largeChunkPullBatchGate({ lane: { ...lane, enabled: false }, probe, job: jobAt(0), projectNo: PROJECT }), null)
  assert.equal(await lanes.largeChunkPullBatchGate({ lane: { ...lane, enabled: false }, probe, job: { ...jobAt(0), pullBatchPlan: 'not a plan' }, projectNo: PROJECT }), null)
  {
    const h = mount()
    try {
      const flow = await withSwitch('true', () => largeFlow(h, { run: false }))
      assert.equal(flow.approved.statusCode, 202, JSON.stringify(flow.approved.body))
      const key = keyOf(h, flow.approved.body.data.jobId)
      const job = await h.context.storage.get(key)
      job.pullBatchPlan.firstPullBatchByKey = {}
      await h.context.storage.set(key, job)
      h.ledgerDb.log.length = 0
      const chunk = await withSwitch(undefined, () => chunkOf(h, flow))
      assert.equal(chunk.statusCode, 200, JSON.stringify(chunk.body))
      assert.equal(chunk.body.data.status, 'succeeded')
      assert.equal(hasKeyDeep(chunk.body, 'pullBatch'), false, 'no pullBatch key while OFF')
      assert.deepEqual(h.ledgerDb.log, [], 'zero ledger IO while OFF')
    } finally { h.restore() }
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-lanes.test.cjs', tests)
