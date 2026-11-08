'use strict'

// 批次标识 BI-1b (design §4.4, §6.3 (b); register R-65) — BAND-POISON, the generic hash-neutrality tripwire.
//
// A spy on node:crypto's createHash AND createHmac is installed BEFORE any plugin module is required (so a module that
// destructures `{ createHash }` at load time gets the spy too), and every update() input is recorded. A project sheet
// is seeded with rows whose two band cells carry a SENTINEL label under the derived PHYSICAL ids (and, defensively, the
// logical ids). Then every lane that hashes sheet rows runs — dry-run (token revision, ledger input revision), apply
// (the in-lease recompute), a second dry-run, the large plan (plan revision) / approve (target revision) / chunk, the
// board, the pilot GET (readiness), the change-plan read and the status read — switch OFF and switch ON.
//
// R line (R83 on onprem-r82; critic "BAND-POISON" row): the lanes are THIS line's — there is no pilot GET (readiness)
// and no change-plan read here, so they are dropped; the confirmation-decision RECONCILE (its input revision) and
// MVP-PERSIST (buildArchiveRevision -> batchScope: the G5 rollback-floor path, design §12.4) are ADDED. There is no
// write lock, so the ledger store runs on the migration-105 fake directly.
//
//   HN-1  no recorded digest input ever contains the sentinel label or a physical band id (anti-vacuity: the spy saw
//         many inputs, and the sentinel rows WERE read)
//   HN-2  witness (the strip removed): the same run on a host whose band cannot be derived (so nothing is stripped)
//         DOES feed the sentinel into a digest — this suite would catch a new digest over band cells
//
// Every value is synthetic.

const crypto = require('node:crypto')

const RECORDED = []
let recording = false
function spy(original) {
  return function spiedFactory(...args) {
    const hash = original.apply(crypto, args)
    const update = hash.update.bind(hash)
    hash.update = (data, ...rest) => {
      if (recording) RECORDED.push(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      update(data, ...rest)
      return hash
    }
    return hash
  }
}
crypto.createHash = spy(crypto.createHash)
crypto.createHmac = spy(crypto.createHmac)

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const pbKit = require('./support/stock-preparation-pull-batch-kit.cjs')
const { createStockPreparationPullBatchStore } = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const { pullBatchBandFieldDescriptors } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-syn-hn'
const PROJECT = 'SYN-HN-01'
const ADMIN = Object.freeze({ id: 'u_hn_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const SENTINEL = '第9批（2001-01-01）HN-SENTINEL'
const RECONCILE = '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile'
const MVP_PERSIST = '/api/integration/table-actions/:actionId/mvp-persist'
const MVP_PERSIST_FLAG = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
const JOBS = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'

async function withSwitch(value, fn) {
  const original = process.env.STOCK_PREP_PULL_BATCH_ENABLED
  if (value === undefined) delete process.env.STOCK_PREP_PULL_BATCH_ENABLED
  else process.env.STOCK_PREP_PULL_BATCH_ENABLED = value
  try { return await fn() } finally { if (original === undefined) delete process.env.STOCK_PREP_PULL_BATCH_ENABLED; else process.env.STOCK_PREP_PULL_BATCH_ENABLED = original }
}

function mount({ derivable = true } = {}) {
  const clock = pbKit.createClock('2026-11-08T01:00:00.000Z')
  const ledgerDb = pbKit.createFakePullBatchDb({ clock })
  const store = createStockPreparationPullBatchStore({ db: ledgerDb, now: clock.now })
  // reconcile fails closed (501) without an audit store and a confirmation-decision lease: both are synthetic here.
  const reconcileServices = {
    stockPreparationAuditStore: { async append() { return { ok: true } }, list: async () => [], supportsAction: () => true },
    stockPreparationConfirmationDecisionLease: {
      async acquire() { return { held: true, leaseId: 'lease-syn-hn' } },
      async renew() { return { held: true } },
      async release() { return { released: true } },
    },
  }
  const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, fieldReads: true, serviceExtras: { ...reconcileServices, stockPreparationPullBatchStore: store } })
  const seeded = h.seedRegistryRow(PROJECT)
  const object = h.provisioning.objects.get(`${h.staging}/${seeded.objectId}`)
  for (const descriptor of pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'left' })) {
    object.fields.set(descriptor.id, { name: descriptor.name, type: descriptor.type, property: JSON.parse(JSON.stringify(descriptor.property)), order: descriptor.order })
  }
  ledgerDb.seed(pbKit.T.sheet, pbKit.sheetRow({ tenantId: TENANT, sheetId: seeded.sheetId, projectNo: PROJECT }))
  const derive = h.provisioning.getFieldId
  const physical = (fieldId) => derive(h.staging, seeded.objectId, fieldId)
  if (!derivable) h.provisioning.getFieldId = (projectId, objectId, fieldId) => (fieldId === 'pullBatch' || fieldId === 'firstPullBatch' ? undefined : derive(projectId, objectId, fieldId))
  return { ...h, ...seeded, physical }
}

async function seedPoisonedRows(h) {
  // The pulled part, as a pull wrote it — plus BAND CELLS carrying the sentinel, under the physical AND the logical ids.
  const p = h.physical
  const key = JSON.stringify({ projectNo: PROJECT, componentSourceId: 'PART-SYN', parentSourceId: null, path: ['PART-SYN'] })
  const base = { [p('projectNo')]: PROJECT, [p('idempotencyKey')]: key, [p('componentSourceId')]: 'PART-SYN', [p('parentSourceId')]: null, [p('path')]: '["PART-SYN"]', [p('depth')]: 0, [p('componentCode')]: 'SYN-0001', [p('active')]: true, [p('lastPlmRefreshDecision')]: 'add', [p('lastPlmRefreshRunId')]: 'run-syn-hn', [p('lastPlmRefreshAt')]: '2026-11-01T00:00:00.000Z' }
  await h.records.createRecord({ sheetId: h.sheetId, data: { ...base, [p('pullBatch')]: SENTINEL, [p('firstPullBatch')]: SENTINEL } })
  const other = JSON.stringify({ projectNo: PROJECT, componentSourceId: 'PART-GONE', parentSourceId: null, path: ['PART-GONE'] })
  await h.records.createRecord({ sheetId: h.sheetId, data: { ...base, [p('idempotencyKey')]: other, [p('componentSourceId')]: 'PART-GONE', pullBatch: SENTINEL, firstPullBatch: SENTINEL } })
}

const call = (h, method, routePath, { body = {}, params = {}, query = { tenantId: TENANT } } = {}) =>
  harness.call(h.routes, method, routePath, { user: ADMIN, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID, ...params }, body, query })

async function everyLane(h) {
  const statuses = {}
  const dry = await call(h, 'POST', '/api/integration/table-actions/:actionId/dry-run', { body: { parameters: { projectNo: PROJECT } } })
  statuses.dry = dry.statusCode
  const applied = await call(h, 'POST', '/api/integration/table-actions/:actionId/apply', { body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: dry.body.data && dry.body.data.dryRunToken, acceptManualConfirmHold: true } } })
  statuses.apply = applied.statusCode
  // R line: mvp-persist checks itself against the source the apply read (its two digests, #6475).
  const persistDigests = applied.body && applied.body.data ? { sourceScopeDigest: applied.body.data.sourceScopeDigest, sourceContentDigest: applied.body.data.sourceContentDigest } : {}
  statuses.dry2 = (await call(h, 'POST', '/api/integration/table-actions/:actionId/dry-run', { body: { parameters: { projectNo: PROJECT } } })).statusCode
  const started = await call(h, 'POST', JOBS, { body: { parameters: { projectNo: PROJECT } } })
  const jobId = started.body.data.jobId
  await call(h, 'POST', `${JOBS}/:jobId/run`, { params: { jobId } })
  statuses.plan = (await call(h, 'POST', `${JOBS}/:jobId/plan`, { params: { jobId } })).statusCode
  const approved = await call(h, 'POST', `${JOBS}/:jobId/apply-jobs`, { params: { jobId }, body: { confirm: { acceptManualConfirmHold: true } } })
  statuses.approve = approved.statusCode
  if (approved.statusCode === 202) statuses.chunk = (await call(h, 'POST', `${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params: { jobId, applyJobId: approved.body.data.jobId } })).statusCode
  statuses.board = (await call(h, 'GET', '/api/integration/stock-preparation/projects/:projectNo/board', { params: { projectNo: PROJECT } })).statusCode
  // R line: the reconcile (confirmation input revision) and mvp-persist (the archive revision) lanes, each with how many
  // digest inputs it fed (anti-vacuity per lane).
  let before = RECORDED.length
  statuses.reconcile = (await call(h, 'POST', RECONCILE, { body: { parameters: { projectNo: PROJECT } } })).statusCode
  statuses.reconcileDigests = RECORDED.length - before
  const previous = process.env[MVP_PERSIST_FLAG]
  process.env[MVP_PERSIST_FLAG] = 'true'
  try {
    before = RECORDED.length
    const persisted = await call(h, 'POST', MVP_PERSIST, { body: { parameters: { projectNo: PROJECT }, ...persistDigests }, query: {} })
    statuses.mvpPersist = persisted.statusCode
    if (persisted.statusCode !== 200) statuses.mvpPersistCode = persisted.body && persisted.body.error && persisted.body.error.code
    statuses.mvpPersistDigests = RECORDED.length - before
  } finally {
    if (previous === undefined) delete process.env[MVP_PERSIST_FLAG]
    else process.env[MVP_PERSIST_FLAG] = previous
  }
  statuses.status = (await call(h, 'GET', '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch', { params: { projectNo: PROJECT } })).statusCode
  return statuses
}

async function poisonRun({ derivable, switchValue }) {
  const h = mount({ derivable })
  try {
    await seedPoisonedRows(h)
    RECORDED.length = 0
    recording = true
    let statuses
    try {
      statuses = await withSwitch(switchValue, () => everyLane(h))
    } finally { recording = false }
    const reads = h.records.calls.filter(([verb]) => verb === 'queryRecords').length
    return { statuses, inputs: [...RECORDED], reads, ids: [h.physical('pullBatch'), h.physical('firstPullBatch')] }
  } finally { h.restore() }
}

const poisoned = (inputs, ids) => inputs.filter((text) => text.includes(SENTINEL) || ids.some((id) => text.includes(id)))

test('HN-1 BAND-POISON: no digest input of any lane contains the sentinel label or a physical band id — switch OFF and ON', async () => {
  for (const switchValue of [undefined, 'true']) {
    const run = await poisonRun({ derivable: true, switchValue })
    assert.equal(run.statuses.dry, 200, JSON.stringify(run.statuses))
    assert.equal(run.statuses.apply, 200, JSON.stringify(run.statuses))
    assert.equal(run.statuses.plan, 200, JSON.stringify(run.statuses))
    assert.equal(run.statuses.approve, 202, JSON.stringify(run.statuses))
    assert.equal(run.statuses.chunk, 200, JSON.stringify(run.statuses))
    // R line: the two added lanes really hashed sheet rows (non-vacuous per lane).
    assert.ok(run.statuses.reconcileDigests > 0, `the reconcile lane fed digests: ${JSON.stringify(run.statuses)}`)
    assert.ok(run.statuses.mvpPersistDigests > 0, `the mvp-persist lane fed digests: ${JSON.stringify(run.statuses)}`)
    assert.ok(run.inputs.length >= 20, `anti-vacuity: the spy recorded ${run.inputs.length} digest inputs`)
    assert.ok(run.reads >= 4, 'the poisoned rows were read')
    assert.deepEqual(poisoned(run.inputs, run.ids).map((text) => text.slice(0, 120)), [], `switch ${JSON.stringify(switchValue)}: a digest saw a band cell`)
  }
})

test('HN-2 witness: with the strip disabled (no derivable band), the same lanes DO feed the sentinel into a digest', async () => {
  const run = await poisonRun({ derivable: false, switchValue: undefined })
  assert.equal(run.statuses.dry, 200, JSON.stringify(run.statuses))
  assert.ok(poisoned(run.inputs, run.ids).length > 0, 'without the strip the band cells reach a digest — so HN-1 is not vacuous')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-hash-neutrality.test.cjs', tests)
