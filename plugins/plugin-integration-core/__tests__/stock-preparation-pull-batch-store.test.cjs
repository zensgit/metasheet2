'use strict'

// 批次标识 BI-1a (register R-65) — THE LEDGER STORE (lib/stock-preparation-pull-batch-store.cjs) over a faithful fake of
// the scoped db (support/stock-preparation-pull-batch-kit.cjs: migration 105's NOT NULL / DEFAULT / enum CHECKs parsed
// from the SQL, the shape CHECKs and every partial unique index by hand, rollback on throw). The fake refuses
// overlapping transactions: every interleaving (two allocations, a settings edit racing the first allocation, a zombie
// after a takeover) is proven on real PostgreSQL in packages/core-backend/tests/integration/
// stock-preparation-pull-batch-realdb.cases.ts (BI-R*).
//
//   ST-00  the fake's tables and unique indexes are exactly the migration's
//   ST-A*  allocate(): open / link reuse / join / void + reuse / supersede / numbering floor / refusals / 23505 /
//          holder FIRST / expectedRule / the label from the captured format and locale / the settings lock
//   ST-F*  finish(): one finisher per link, counts BY VALUE, close on success, completed_by_later_execution, holder
//   ST-S*  the step-6 surface: readBatchLink (C-2), batchWithin (C-3), listBatches (C-10)
//   ST-T*  tenant settings: built-in defaults, CAS (absent row, insert race, stale version), the patch normalizer,
//          the audit entry (flat, enum tokens) and its rollback
//   ST-H*  per-sheet settings: not captured, locked (the pure module's lock helper), CAS, rule / format only, audit
//   ST-C*  the capture primitive and the admin list
//   ST-X*  abort of an install: the C7 lock release and its three refusals to release; the gap pass
//   ST-E*  every store failure is a typed 503 — never "no batch"; malformed input is refused before any statement
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const storeModule = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const {
  PULL_BATCH_BUILT_IN_SETTINGS,
  PULL_BATCH_STORE_AUDIT,
  PULL_BATCH_TABLES,
  SETTINGS_NOT_CAPTURED_CODE,
  SETTINGS_VERSION_CONFLICT_CODE,
  createStockPreparationPullBatchStore,
} = storeModule
const pure = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const { PULL_BATCH_ERROR_CODES, formatPullBatchLabel, pullBatchLabelDay } = pure
const kit = require('./support/stock-preparation-pull-batch-kit.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-syn-bi'
const SHEET = 'sheet_syn_bi'
const PROJECT = 'P-07'
const SCOPE = Object.freeze({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT })
const D1 = 'a'.repeat(32)
const D2 = 'b'.repeat(32)
const AT = '2026-10-27T01:00:00.000Z'

function setup({ status = 'born_empty', historyBatchCount = 0, withoutUniqueIndexes = [], locale = 'zh-CN', rule = 'material', labelFormat = 'ordinal_date', lockedAt, resolvedAt, historyPlan = null, placement = 'left', landing = null } = {}) {
  const clock = kit.createClock(AT)
  const db = kit.createFakePullBatchDb({ clock, withoutUniqueIndexes })
  let n = 0
  const store = createStockPreparationPullBatchStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${(n += 1)}` })
  if (status) {
    db.seed(kit.T.sheet, kit.sheetRow({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT, status, historyBatchCount, locale, rule, labelFormat, lockedAt, resolvedAt, historyPlan, placement, landing }))
  }
  return { db, store, clock }
}

const alloc = (store, extra = {}) => store.allocate({
  ...SCOPE,
  executionRef: 'small:run_1',
  lane: 'small_apply',
  sourceDigest: D1,
  labelsOnSheet: new Set(),
  voidReuse: 'in_lease',
  expectedRule: 'material',
  ...extra,
})
const DAY = pullBatchLabelDay(new Date(AT))
const label = (n, { locale = 'zh-CN', labelFormat = 'ordinal_date' } = {}) => formatPullBatchLabel({ kind: 'live', n, day: DAY, locale, labelFormat })
const batches = (db) => db.rows(kit.T.batch).map((row) => [row.batch_no, row.status, row.closed_reason || null]).sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])))
const sheet = (db) => db.rows(kit.T.sheet).find((row) => row.sheet_id === SHEET && row.project_no === PROJECT)
const snapshot = (db) => JSON.stringify(Object.values(kit.T).filter((name) => db.tables.has(name)).map((name) => db.rows(name)))
async function rejects(promise, code, label2) {
  let thrown = null
  try { await promise } catch (error) { thrown = error }
  assert.ok(thrown, `${label2}: expected a refusal`)
  assert.equal(thrown.code, code, `${label2}: ${thrown && thrown.message}`)
  return thrown
}

test('ST-00 the fake models exactly the tables and unique indexes the migration installs, under the same names', () => {
  const sql = kit.readMigrationText(kit.MIGRATION_FILES.pullBatch)
  const inSql = Array.from(sql.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS (\w+)/g)).map((match) => match[1]).sort()
  assert.deepEqual(kit.UNIQUE_INDEXES.map((index) => index.name).sort(), inSql)
  const tablesInSql = Array.from(sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)).map((match) => match[1]).sort()
  assert.deepEqual(Object.values(PULL_BATCH_TABLES).sort(), tablesInSql)
  assert.deepEqual(Object.keys(kit.loadSchema()).sort(), tablesInSql)
  assert.ok(/WHERE status <> 'void'/.test(sql) && /WHERE status = 'open'/.test(sql), 'the two partial predicates')
  // Every non-enum CHECK the kit models by hand names a constraint the SQL declares.
  for (const check of kit.SHAPE_CHECKS) {
    if (check.name === 'integration_stock_prep_pull_batch_batch_no_check' || check.name === 'integration_stock_prep_pull_batch_execution_count_check') continue // inline column CHECKs (PostgreSQL names them so)
    assert.ok(sql.includes(`CONSTRAINT ${check.name}`), `${check.name} is declared in 105`)
  }
})

test('ST-A1 the first create of a resolved sheet opens batch 1 (live, open, its label fixed now) and links the execution', async () => {
  const { db, store } = setup()
  const answer = await alloc(store, { refreshExecutionId: 'exec_syn_1' })
  assert.deepEqual({ ...answer }, { batchId: answer.batchId, batchNo: 1, label: label(1), joined: false, linkReused: false })
  const [batch] = db.rows(kit.T.batch)
  assert.deepEqual([batch.status, batch.origin, batch.source_digest, batch.display_day], ['open', 'live', D1, DAY])
  const [link] = db.rows(kit.T.execution)
  assert.deepEqual([link.execution_ref, link.lane, link.refresh_execution_id, link.batch_id, link.finished_at], ['small:run_1', 'small_apply', 'exec_syn_1', batch.id, null])
  assert.deepEqual(db.statements('trx.').slice(0, 2), [['trx.selectOneForUpdate', kit.T.sheet], ['trx.selectOne', kit.T.execution]], 'the _sheet row FOR UPDATE first, then the link')
})

test('ST-A2 the SAME execution again (a later chunk, a resume, a takeover) reuses its link — no new row', async () => {
  const { db, store } = setup()
  const first = await alloc(store, { executionRef: 'large:job_1', lane: 'large_apply' })
  const again = await alloc(store, { executionRef: 'large:job_1', lane: 'large_apply' })
  assert.equal(again.batchId, first.batchId)
  assert.deepEqual([again.linkReused, again.joined], [true, true])
  assert.equal(db.rows(kit.T.execution).length, 1)
  assert.equal(db.rows(kit.T.batch).length, 1)
})

test('ST-A3 another execution with the SAME content digest JOINS the open batch (one logical pull = one batch)', async () => {
  const { db, store } = setup()
  const first = await alloc(store)
  const retry = await alloc(store, { executionRef: 'small:run_2' })
  assert.equal(retry.batchId, first.batchId)
  assert.deepEqual([retry.joined, retry.label], [true, label(1)])
  assert.equal(db.rows(kit.T.execution).length, 2)
  assert.deepEqual(batches(db), [[1, 'open', null]])
})

test('ST-A4 a DIFFERENT digest: in-lease with the label on no row => void the open batch and REUSE its number; with the label on a row => close it superseded', async () => {
  const voided = setup()
  await alloc(voided.store)
  const next = await alloc(voided.store, { executionRef: 'small:run_2', sourceDigest: D2, labelsOnSheet: new Set() })
  assert.equal(next.batchNo, 1, 'no row carries 第1批: the number is reused, no visible gap')
  assert.deepEqual(batches(voided.db), [[1, 'open', null], [1, 'void', 'void_no_rows']])
  const kept = setup()
  await alloc(kept.store)
  const after = await alloc(kept.store, { executionRef: 'small:run_2', sourceDigest: D2, labelsOnSheet: new Set([label(1)]) })
  assert.equal(after.batchNo, 2)
  assert.deepEqual(batches(kept.db), [[1, 'closed', 'superseded_by_new_source'], [2, 'open', null]])
})

test('ST-A5 voidReuse \'off\' (the R line, no lease) never voids: a different digest closes the open batch and opens the next number', async () => {
  const { db, store } = setup()
  await alloc(store, { voidReuse: 'off' })
  const next = await alloc(store, { executionRef: 'small:run_2', sourceDigest: D2, voidReuse: 'off' })
  assert.equal(next.batchNo, 2)
  assert.deepEqual(batches(db), [[1, 'closed', 'superseded_by_new_source'], [2, 'open', null]])
})

test('ST-A6 live numbering continues after max(non-void batch_no, history_batch_count) — never on an unconfirmed K', async () => {
  const backfilled = setup({ status: 'backfilled', historyBatchCount: 3 })
  assert.equal((await alloc(backfilled.store)).batchNo, 4)
  assert.equal((await alloc(backfilled.store)).label, label(4), 'a join keeps the label')
  const withHigher = setup({ status: 'backfilled', historyBatchCount: 1 })
  withHigher.db.seed(kit.T.batch, { id: 'pbat_inf_5', tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, batch_no: 5, origin: 'backfill_inferred', status: 'closed', label: '第5批（推定，2026-10-01）', display_day: '2026-10-01', source_digest: null, evidence: 'created_at', opened_at: '2026-10-01T00:00:00.000Z', closed_at: '2026-10-02T00:00:00.000Z', closed_reason: 'backfill' })
  assert.equal((await alloc(withHigher.store)).batchNo, 6)
})

test('ST-A7 refusals before anything is written: installing => 409 INSTALL_IN_PROGRESS; pending / absent => 409 NOT_READY; a closed batch\'s link => 409 EXECUTION_CLOSED; another tenant\'s row => 409', async () => {
  const installing = setup({ status: 'installing' })
  await rejects(alloc(installing.store), PULL_BATCH_ERROR_CODES.INSTALL_IN_PROGRESS, 'installing')
  assert.equal(installing.db.rows(kit.T.batch).length, 0)
  const pending = setup({ status: 'pending' })
  await rejects(alloc(pending.store), PULL_BATCH_ERROR_CODES.NOT_READY, 'pending')
  const absent = setup({ status: null })
  await rejects(alloc(absent.store), PULL_BATCH_ERROR_CODES.NOT_READY, 'absent')
  const closed = setup()
  await alloc(closed.store)
  await closed.store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'succeeded', createdRowCount: 2 })
  await rejects(alloc(closed.store), PULL_BATCH_ERROR_CODES.EXECUTION_CLOSED, 'the link\'s batch is closed')
  const foreign = setup({ status: null })
  foreign.db.seed(kit.T.sheet, kit.sheetRow({ id: 'pbs_foreign', tenantId: 'tenant-other', sheetId: SHEET, projectNo: PROJECT }))
  const error = await rejects(alloc(foreign.store), PULL_BATCH_ERROR_CODES.CONFLICT, 'another tenant\'s _sheet row is never read as this one')
  assert.equal(error.details.reason, 'scope_mismatch')
})

test('ST-A8 a unique violation is the arbitration of last resort: 409 CONFLICT and everything rolls back', async () => {
  const { db, store } = setup()
  db.faults.insertOne = (args) => (args.table === kit.T.execution ? kit.sqlError('23505', 'duplicate key value violates unique constraint', { constraint: 'uniq_integration_stock_prep_pull_batch_execution_ref' }) : null)
  await rejects(alloc(store), PULL_BATCH_ERROR_CODES.CONFLICT, '23505')
  assert.equal(db.rows(kit.T.batch).length, 0, 'the batch row inserted before the link rolled back with it')
  assert.equal(sheet(db).settings_locked_at, null, 'the settings lock rolled back too')
  delete db.faults.insertOne
  const noIndex = setup({ withoutUniqueIndexes: ['uniq_integration_stock_prep_pull_batch_open'] })
  noIndex.db.seed(kit.T.batch, { id: 'pbat_x', tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, batch_no: 7, origin: 'live', status: 'open', label: label(7), display_day: DAY, source_digest: D2, evidence: null })
  noIndex.db.seed(kit.T.batch, { id: 'pbat_y', tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, batch_no: 8, origin: 'live', status: 'open', label: label(8), display_day: DAY, source_digest: D2, evidence: null })
  await rejects(alloc(noIndex.store), PULL_BATCH_ERROR_CODES.CONFLICT, 'two open batches are a defect, refused')
})

test('ST-A9 (S6 C-6, F-BI-1; M-BI-22) the holder assert runs FIRST in the allocation transaction; a refusal writes nothing and keeps its own code', async () => {
  const { db, store } = setup()
  const order = []
  const passing = async (trx) => {
    order.push(trx === db.lastTransactionHandle ? 'holder_on_this_handle' : 'holder_elsewhere')
    order.push(`ledger_statements_before_holder:${db.statements('trx.').length}`)
  }
  await alloc(store, { holderWithin: passing })
  assert.deepEqual(order, ['holder_on_this_handle', 'ledger_statements_before_holder:0'])
  assert.deepEqual(db.statements('trx.')[0], ['trx.selectOneForUpdate', kit.T.sheet], 'the holder hook precedes every ledger statement')
  const refused = Object.assign(new Error('lease lost'), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', details: { reason: 'holder_assert_lost' } })
  const before = snapshot(db)
  const error = await rejects(alloc(store, { executionRef: 'small:zombie', sourceDigest: D2, holderWithin: async () => { throw refused } }), 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', 'zombie')
  assert.equal(error, refused, 'the hook\'s own typed error passes through')
  assert.equal(snapshot(db), before, 'a zombie can neither void nor supersede the live batch')
  // An untyped hook failure is a store failure, never "no batch".
  const untyped = await rejects(alloc(store, { executionRef: 'small:z2', holderWithin: async () => { throw new Error('boom') } }), PULL_BATCH_ERROR_CODES.STORE_FAILED, 'untyped')
  assert.equal(untyped.details.operation, 'holder')
})

test('ST-A10 (M-CFG-2) allocate with a stale expectedRule => 409 CONFLICT settings_changed, nothing written (the lane built its carry map under another rule)', async () => {
  const { db, store } = setup({ rule: 'predecessor_suffix' })
  const before = snapshot(db)
  const error = await rejects(alloc(store, { expectedRule: 'material' }), PULL_BATCH_ERROR_CODES.CONFLICT, 'stale rule')
  assert.equal(error.details.reason, 'settings_changed')
  assert.equal(snapshot(db), before)
  const ok = await alloc(store, { expectedRule: 'predecessor_suffix' })
  assert.equal(ok.batchNo, 1)
  // expectedRule is required and closed (validated before any statement).
  const fresh = setup()
  const logBefore = fresh.db.log.length
  // The removed C2 tokens ('off') are pinned in the vocabulary-migration suite (VM-6), which runs last in the chain.
  for (const bad of [undefined, '', 'Material', ' material', 'position']) {
    await rejects(alloc(fresh.store, { expectedRule: bad }), PULL_BATCH_ERROR_CODES.STAMP_INVALID, `expectedRule ${JSON.stringify(bad)}`)
  }
  assert.equal(fresh.db.log.length, logBefore)
})

test('ST-A11 (M-CFG-5) the label is formatted inside the transaction from the LOCKED row\'s captured format and locale', async () => {
  const cases = [
    [{ locale: 'zh-CN', labelFormat: 'ordinal_date' }, `第1批（${DAY}）`],
    [{ locale: 'zh-CN', labelFormat: 'ordinal' }, '第1批'],
    [{ locale: 'en', labelFormat: 'ordinal_date' }, `Batch 1 (${DAY})`],
    [{ locale: 'en', labelFormat: 'ordinal' }, 'Batch 1'],
  ]
  for (const [captured, expected] of cases) {
    const { db, store } = setup(captured)
    const answer = await alloc(store)
    assert.equal(answer.label, expected, JSON.stringify(captured))
    assert.equal(db.rows(kit.T.batch)[0].label, expected)
    assert.equal(db.rows(kit.T.batch)[0].display_day, DAY, 'the ordinal format still records the day')
  }
})

test('ST-A12 (M-CFG-4) settings_locked_at is set in the transaction that hands the FIRST batch out (version + 1), on every path, and never moved again', async () => {
  const { db, store, clock } = setup()
  assert.equal(sheet(db).settings_locked_at, null)
  await alloc(store)
  const first = sheet(db)
  assert.equal(first.settings_locked_at, AT)
  assert.equal(first.version, 1)
  clock.advance(60 * 1000)
  await alloc(store, { executionRef: 'small:run_2' }) // join
  await alloc(store, { executionRef: 'small:run_2' }) // link reuse
  await alloc(store, { executionRef: 'small:run_3', sourceDigest: D2, labelsOnSheet: new Set([label(1)]) }) // new
  assert.equal(sheet(db).settings_locked_at, AT, 'never moved, never cleared by a later allocation')
  assert.equal(sheet(db).version, 1, 'no further version bump once locked')
  // A link-reuse path locks too (a sheet whose lock is absent but whose link exists — defensive).
  const reuse = setup()
  await alloc(reuse.store, { executionRef: 'large:job_1', lane: 'large_apply' })
  reuse.db.tables.get(kit.T.sheet).forEach((row) => { row.settings_locked_at = null })
  await alloc(reuse.store, { executionRef: 'large:job_1', lane: 'large_apply' })
  assert.equal(sheet(reuse.db).settings_locked_at, AT)
  // A refusal locks nothing.
  const refused = setup({ status: 'pending' })
  await rejects(alloc(refused.store), PULL_BATCH_ERROR_CODES.NOT_READY, 'pending')
  assert.equal(sheet(refused.db).settings_locked_at, null)
})

test('ST-F1 finish: one finisher per link, the count set BY VALUE; succeeded closes the batch; a second finish is a no-op', async () => {
  const { db, store } = setup()
  await alloc(store)
  assert.equal((await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'succeeded', createdRowCount: 3, sourceDigest: D1 })).outcome, 'closed')
  const [link] = db.rows(kit.T.execution)
  assert.deepEqual([link.writer_status, link.created_row_count, typeof link.finished_at], ['succeeded', 3, 'string'])
  assert.deepEqual(batches(db), [[1, 'closed', 'execution_succeeded']])
  assert.equal((await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'succeeded', createdRowCount: 99 })).outcome, 'already_finished')
  assert.equal(db.rows(kit.T.execution)[0].created_row_count, 3, 'a zombie finish never re-counts (F-BI-2)')
})

test('ST-F2 a partial / failed / aborted run keeps its batch OPEN (a same-digest retry joins it)', async () => {
  for (const writerStatus of ['partial', 'failed', 'aborted']) {
    const { db, store } = setup()
    await alloc(store)
    assert.equal((await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus, createdRowCount: 1 })).outcome, 'finished')
    assert.deepEqual(batches(db), [[1, 'open', null]], writerStatus)
    const retry = await alloc(store, { executionRef: 'small:run_2' })
    assert.equal(retry.joined, true, `${writerStatus}: the retry joins`)
  }
})

test('ST-F3 a succeeded run that allocated nothing closes a SAME-digest open batch completed_by_later_execution; another digest stays open', async () => {
  const { db, store } = setup()
  await alloc(store)
  await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'failed', createdRowCount: 2 })
  assert.equal((await store.finish({ ...SCOPE, executionRef: 'small:run_2', writerStatus: 'succeeded', createdRowCount: 0, sourceDigest: D2 })).outcome, 'no_link')
  assert.deepEqual(batches(db), [[1, 'open', null]])
  assert.equal((await store.finish({ ...SCOPE, executionRef: 'small:run_3', writerStatus: 'succeeded', createdRowCount: 0, sourceDigest: D1 })).outcome, 'closed_completed_by_later_execution')
  assert.deepEqual(batches(db), [[1, 'closed', 'completed_by_later_execution']])
  assert.equal((await store.finish({ ...SCOPE, executionRef: 'small:run_4', writerStatus: 'partial', createdRowCount: 0, sourceDigest: D1 })).outcome, 'no_link', 'only a succeeded run closes')
})

test('ST-F4 finish under a lost lease is a logged no-op (holder_refused): nothing written', async () => {
  const { db, store } = setup()
  await alloc(store)
  const before = snapshot(db)
  const answer = await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'succeeded', createdRowCount: 1, holderWithin: async () => { throw Object.assign(new Error('lost'), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST' }) } })
  assert.deepEqual({ ...answer }, { outcome: 'holder_refused', code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST' })
  assert.equal(snapshot(db), before)
})

test('ST-S1 (S6 C-2) readBatchLink: by the governed execution id, values-free; none => linked false; two => 409 STATE_MOVED pull_batch_link_ambiguous', async () => {
  const { db, store } = setup()
  assert.deepEqual({ ...(await store.readBatchLink({ ...SCOPE, refreshExecutionId: 'exec_none' })) }, { linked: false })
  await alloc(store, { refreshExecutionId: 'exec_1' })
  await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'partial', createdRowCount: 2 })
  const link = await store.readBatchLink({ ...SCOPE, refreshExecutionId: 'exec_1' })
  assert.deepEqual({ ...link, batchId: 'x' }, { linked: true, batchId: 'x', batchNo: 1, label: label(1), status: 'open', linkFinished: true, linkCreatedRowCount: 2, sourceDigest: D1 })
  db.seed(kit.T.execution, { id: 'pbx_dup', batch_id: link.batchId, tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, execution_ref: 'small:run_dup', lane: 'small_apply', refresh_execution_id: 'exec_1' })
  const error = await rejects(store.readBatchLink({ ...SCOPE, refreshExecutionId: 'exec_1' }), 'STOCK_PREP_PULL_STATE_MOVED', 'two links')
  assert.equal(error.details.reason, 'pull_batch_link_ambiguous')
})

test('ST-S2 (S6 C-3) batchWithin: landed closes the linked open batch recovery_verified with the count BY VALUE; mixed keeps it open; never voids', async () => {
  const run = async (result, { finishFirst = null } = {}) => {
    const { db, store } = setup()
    await alloc(store, { refreshExecutionId: 'exec_1' })
    if (finishFirst) await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: finishFirst, createdRowCount: 5 })
    const outcome = await db.transaction((trx) => store.batchWithin(trx, { scope: SCOPE, refreshExecutionId: 'exec_1', result, verifiedCreatedRows: 4, sourceDigest: D1 }))
    return { db, store, outcome }
  }
  const landed = await run('landed')
  assert.equal(landed.outcome, 'closed')
  assert.deepEqual(batches(landed.db), [[1, 'closed', 'recovery_verified']])
  const [link] = landed.db.rows(kit.T.execution)
  assert.deepEqual([link.verified_outcome, link.created_row_count, typeof link.finished_at], ['verified_landed', 4, 'string'])
  assert.equal((await landed.store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'succeeded', createdRowCount: 9 })).outcome, 'already_finished')
  assert.equal(landed.db.rows(kit.T.execution)[0].created_row_count, 4)
  const own = await run('landed', { finishFirst: 'succeeded' })
  assert.equal(own.outcome, 'already_closed', 'closed by this link\'s own succeeded finish')
  for (const result of ['mixed', 'nothing_landed', 'unknown']) {
    const kept = await run(result)
    assert.equal(kept.outcome, 'kept_open', result)
    assert.deepEqual(batches(kept.db), [[1, 'open', null]], `${result}: never closes, never voids`)
  }
})

test('ST-S3 (S6 C-3) batchWithin refuses a moved batch 409 STATE_MOVED; with no link a landed close closes a same-digest open batch', async () => {
  const { db, store } = setup()
  await alloc(store, { refreshExecutionId: 'exec_1' })
  await alloc(store, { executionRef: 'small:run_2', sourceDigest: D2, labelsOnSheet: new Set([label(1)]) })
  const error = await db.transaction((trx) => store.batchWithin(trx, { scope: SCOPE, refreshExecutionId: 'exec_1', result: 'landed', verifiedCreatedRows: 1, sourceDigest: D1 })).catch((e) => e)
  assert.equal(error.code, 'STOCK_PREP_PULL_STATE_MOVED')
  assert.equal(error.details.reason, 'pull_batch_moved')
  const noLink = setup()
  await alloc(noLink.store)
  const outcome = await noLink.db.transaction((trx) => noLink.store.batchWithin(trx, { scope: SCOPE, refreshExecutionId: 'exec_unlinked', result: 'landed', verifiedCreatedRows: 0, sourceDigest: D1 }))
  assert.equal(outcome, 'closed')
  assert.deepEqual(batches(noLink.db), [[1, 'closed', 'completed_by_later_execution']])
})

test('ST-S4 (S6 C-10) listBatches: values-free rows with COMPUTED counts (sum of the links) and link counts, paged by number', async () => {
  const { store } = setup()
  await alloc(store)
  await store.finish({ ...SCOPE, executionRef: 'small:run_1', writerStatus: 'partial', createdRowCount: 2 })
  await alloc(store, { executionRef: 'small:run_2' })
  await store.finish({ ...SCOPE, executionRef: 'small:run_2', writerStatus: 'succeeded', createdRowCount: 3 })
  await alloc(store, { executionRef: 'small:run_3', sourceDigest: D2, labelsOnSheet: new Set([label(1)]) })
  const page = await store.listBatches({ scope: SCOPE, limit: 1 })
  assert.deepEqual(page.batches.map((row) => [row.batchNo, row.status, row.createdRowCount, row.linkCount]), [[1, 'closed', 5, 2]])
  assert.equal(page.nextCursor, 1)
  const rest = await store.listBatches({ scope: SCOPE, limit: 5, cursor: page.nextCursor })
  assert.deepEqual(rest.batches.map((row) => [row.batchNo, row.status, row.createdRowCount, row.linkCount]), [[2, 'open', 0, 1]])
  assert.equal(rest.nextCursor, null)
  const text = JSON.stringify([page, rest])
  assert.ok(!text.includes(PROJECT) && !text.includes(SHEET) && !text.includes(TENANT), 'values-free')
})

// ── tenant settings ──────────────────────────────────────────────────────────────────────────────────

test('ST-T1 the tenant default: no row => the built-in 10-27 defaults, version 0; the built-ins are exactly the 10-27 design', async () => {
  const { store } = setup()
  assert.deepEqual({ ...PULL_BATCH_BUILT_IN_SETTINGS }, { firstPullBatchRule: 'material', labelFormat: 'ordinal_date', landing: 'promote_prep_fill', placement: 'left' })
  const read = await store.readTenantSettings({ tenantId: TENANT })
  assert.deepEqual({ ...read, settings: { ...read.settings } }, { settings: { ...PULL_BATCH_BUILT_IN_SETTINGS }, source: 'built_in', version: 0 })
})

test('ST-T2 tenant CAS: expectedVersion 0 inserts (version 1); a stale version => 409 SETTINGS_VERSION_CONFLICT, nothing written; the next write needs version 1', async () => {
  const { db, store } = setup()
  const written = await store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 0, patch: { placement: 'right' } })
  assert.deepEqual({ ...written, settings: { ...written.settings } }, { settings: { ...PULL_BATCH_BUILT_IN_SETTINGS, placement: 'right' }, source: 'tenant', version: 1 })
  const before = snapshot(db)
  await rejects(store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 0, patch: { landing: 'keep_current' } }), SETTINGS_VERSION_CONFLICT_CODE, 'stale 0 on an existing row')
  await rejects(store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 2, patch: { landing: 'keep_current' } }), SETTINGS_VERSION_CONFLICT_CODE, 'a future version')
  assert.equal(snapshot(db), before)
  const again = await store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 1, patch: { landing: 'keep_current', firstPullBatchRule: 'predecessor_suffix' } })
  assert.deepEqual({ ...again.settings }, { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal_date', landing: 'keep_current', placement: 'right' })
  assert.equal(again.version, 2)
  // Absent row with a non-zero expectation is a conflict too.
  const other = await rejects(store.writeTenantSettings({ tenantId: 'tenant-syn-other', expectedVersion: 3, patch: { placement: 'right' } }), SETTINGS_VERSION_CONFLICT_CODE, 'absent row, version 3')
  assert.equal(other.status, 409)
})

test('ST-T3 tenant insert race: a concurrent insert\'s 23505 => 409 SETTINGS_VERSION_CONFLICT (never a 503), rolled back', async () => {
  const { db, store } = setup()
  db.faults.insertOne = (args) => (args.table === kit.T.settings ? kit.sqlError('23505', 'duplicate key value violates unique constraint', { constraint: 'integration_stock_prep_pull_batch_settings_pkey' }) : null)
  const error = await rejects(store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 0, patch: { placement: 'right' } }), SETTINGS_VERSION_CONFLICT_CODE, 'insert race')
  assert.equal(error.status, 409)
  assert.equal(db.rows(kit.T.settings).length, 0)
})

test('ST-T4 (M-CFG-1) the patch normalizer: every closed value accepted, every other refused 400 naming the field only — no trim, no case folding, no unknown or removed key, never empty; nothing written', async () => {
  const accepted = {
    firstPullBatchRule: ['material', 'predecessor_suffix'],
    labelFormat: ['ordinal_date', 'ordinal'],
    landing: ['promote_prep_fill', 'keep_current'],
    placement: ['left', 'right'],
  }
  let version = 0
  const { db, store } = setup()
  for (const [key, values] of Object.entries(accepted)) {
    for (const value of values) {
      const answer = await store.writeTenantSettings({ tenantId: TENANT, expectedVersion: version, patch: { [key]: value } })
      version = answer.version
      assert.equal(answer.settings[key], value, `${key}=${value}`)
    }
  }
  const before = snapshot(db)
  const refused = [
    [{ firstPullBatchRule: ' material' }, 'firstPullBatchRule'],
    [{ firstPullBatchRule: 'material ' }, 'firstPullBatchRule'],
    [{ firstPullBatchRule: 'Material' }, 'firstPullBatchRule'],
    [{ firstPullBatchRule: 'position' }, 'firstPullBatchRule'],
    [{ labelFormat: 'ORDINAL' }, 'labelFormat'],
    [{ landing: 'promote_fill' }, 'landing'],
    [{ placement: 1 }, 'placement'],
    [{ placement: null }, 'placement'],
    [{ formalExport: 'excluded' }, 'formalExport'],
    [{ pullBatchMeaning: 'created' }, 'pullBatchMeaning'],
    [{ trashedRowsAreEvidence: false }, 'trashedRowsAreEvidence'],
    [{ somethingElse: 'x' }, 'somethingElse'],
    [{}, 'patch'],
    [[], 'patch'],
    ['material', 'patch'],
    [null, 'patch'],
  ]
  for (const [patch, field] of refused) {
    const error = await rejects(store.writeTenantSettings({ tenantId: TENANT, expectedVersion: version, patch }), PULL_BATCH_ERROR_CODES.CONFIG_INVALID, JSON.stringify(patch))
    assert.equal(error.status, 400)
    assert.equal(error.details.field, field, JSON.stringify(patch))
    assert.ok(!JSON.stringify(error.details).includes('Material') && !JSON.stringify(error.details).includes('position'), 'the value is never echoed')
  }
  for (const bad of [-1, 1.5, '0', undefined]) {
    await rejects(store.writeTenantSettings({ tenantId: TENANT, expectedVersion: bad, patch: { placement: 'left' } }), PULL_BATCH_ERROR_CODES.CONFIG_INVALID, `expectedVersion ${bad}`)
  }
  assert.equal(snapshot(db), before, 'a refused patch writes nothing')
})

test('ST-T5 (ruling C8) the tenant write hands auditWithin a FLAT depth-1 entry of enum tokens on the SAME transaction; a throw rolls the write back', async () => {
  const { db, store } = setup()
  const seen = []
  await store.writeTenantSettings({
    tenantId: TENANT,
    expectedVersion: 0,
    patch: { placement: 'right', labelFormat: 'ordinal' },
    auditWithin: async (trx, entry) => { seen.push({ sameHandle: trx === db.lastTransactionHandle, entry }) },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sameHandle, true)
  assert.deepEqual({ ...seen[0].entry, detail: { ...seen[0].entry.detail } }, {
    mode: PULL_BATCH_STORE_AUDIT.modes.tenantSettingsUpdated,
    subjectId: null,
    detail: { placementBefore: 'left', placementAfter: 'right', labelFormatBefore: 'ordinal_date', labelFormatAfter: 'ordinal', version: 1 },
  })
  for (const value of Object.values(seen[0].entry.detail)) assert.ok(typeof value === 'number' || /^[A-Za-z0-9@._:|-]{1,80}$/.test(value), 'every detail value passes the audit store\'s values-free gate')
  assert.equal(PULL_BATCH_STORE_AUDIT.settingsAction, 'project_fields_update')
  const before = snapshot(db)
  await assert.rejects(store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 1, patch: { placement: 'left' }, auditWithin: async () => { throw Object.assign(new Error('audit refused'), { status: 422, code: 'AUDIT_DETAIL_INVALID' }) } }), (error) => error.code === 'AUDIT_DETAIL_INVALID')
  assert.equal(snapshot(db), before, 'the audit refusal rolled the settings write back')
})

// ── per-sheet settings ───────────────────────────────────────────────────────────────────────────────

test('ST-H1 per-sheet edit of a CAPTURED setting before the first stamp: rule / format only, CAS on version, audited, the same row lock allocate takes', async () => {
  const { db, store } = setup()
  const seen = []
  const answer = await store.setSheetSettings({ ...SCOPE, expectedVersion: 0, patch: { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal' }, auditWithin: async (trx, entry) => { seen.push(entry) } })
  assert.deepEqual({ ...answer.captured }, { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal', landing: null, placement: 'left' })
  assert.deepEqual({ ...answer.locks }, { firstPullBatchRule: false, labelFormat: false, landing: false, placement: true })
  assert.equal(answer.version, 1)
  assert.deepEqual(db.statements('trx.')[0], ['trx.selectOneForUpdate', kit.T.sheet], 'the _sheet row FOR UPDATE first')
  assert.deepEqual({ ...seen[0], detail: { ...seen[0].detail } }, {
    mode: PULL_BATCH_STORE_AUDIT.modes.sheetSettingsUpdated,
    subjectId: SHEET,
    projectNo: PROJECT,
    detail: { firstPullBatchRuleBefore: 'material', firstPullBatchRuleAfter: 'predecessor_suffix', labelFormatBefore: 'ordinal_date', labelFormatAfter: 'ordinal', version: 1 },
  })
  await rejects(store.setSheetSettings({ ...SCOPE, expectedVersion: 0, patch: { labelFormat: 'ordinal_date' } }), SETTINGS_VERSION_CONFLICT_CODE, 'stale sheet version')
  for (const key of ['landing', 'placement']) {
    const error = await rejects(store.setSheetSettings({ ...SCOPE, expectedVersion: 1, patch: { [key]: key === 'landing' ? 'keep_current' : 'right' } }), PULL_BATCH_ERROR_CODES.CONFIG_INVALID, `${key} is not a per-sheet edit`)
    assert.equal(error.details.field, key)
  }
  // The allocation now formats with the edited capture and refuses the old rule.
  await rejects(alloc(store), PULL_BATCH_ERROR_CODES.CONFLICT, 'old rule')
  assert.equal((await alloc(store, { expectedRule: 'predecessor_suffix' })).label, '第1批')
})

test('ST-H2 (M-CFG-3) per-sheet edit on a LOCKED sheet => 409 CONFIG_LOCKED naming the locked keys; nothing written, no audit', async () => {
  const { db, store } = setup()
  await alloc(store)
  const before = snapshot(db)
  const seen = []
  const error = await rejects(store.setSheetSettings({ ...SCOPE, expectedVersion: 1, patch: { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal' }, auditWithin: async (trx, entry) => { seen.push(entry) } }), PULL_BATCH_ERROR_CODES.CONFIG_LOCKED, 'locked')
  assert.equal(error.status, 409)
  assert.deepEqual([...error.details.locked].sort(), ['firstPullBatchRule', 'labelFormat'])
  const one = await rejects(store.setSheetSettings({ ...SCOPE, expectedVersion: 1, patch: { labelFormat: 'ordinal' } }), PULL_BATCH_ERROR_CODES.CONFIG_LOCKED, 'format alone')
  assert.deepEqual([...one.details.locked], ['labelFormat'])
  assert.equal(snapshot(db), before)
  assert.equal(seen.length, 0)
})

test('ST-H3 per-sheet edit with no _sheet row => 409 SETTINGS_NOT_CAPTURED; another tenant\'s row => 409 CONFLICT; auditWithin throw rolls back', async () => {
  const absent = setup({ status: null })
  const error = await rejects(absent.store.setSheetSettings({ ...SCOPE, expectedVersion: 0, patch: { labelFormat: 'ordinal' } }), SETTINGS_NOT_CAPTURED_CODE, 'not captured')
  assert.equal(error.status, 409)
  const foreign = setup({ status: null })
  foreign.db.seed(kit.T.sheet, kit.sheetRow({ id: 'pbs_foreign', tenantId: 'tenant-other', sheetId: SHEET, projectNo: PROJECT }))
  await rejects(foreign.store.setSheetSettings({ ...SCOPE, expectedVersion: 0, patch: { labelFormat: 'ordinal' } }), PULL_BATCH_ERROR_CODES.CONFLICT, 'foreign')
  const rolled = setup()
  const before = snapshot(rolled.db)
  await assert.rejects(rolled.store.setSheetSettings({ ...SCOPE, expectedVersion: 0, patch: { labelFormat: 'ordinal' }, auditWithin: async () => { throw new Error('audit down') } }))
  assert.equal(snapshot(rolled.db), before)
})

// ── the capture primitive and the admin list ─────────────────────────────────────────────────────────

test('ST-C1 createSheetRowWithin captures rule / format / locale from the caller (the tenant default it resolved); placement / landing / lock stay NULL; born_empty is resolved now', async () => {
  const { db, store } = setup({ status: null })
  await store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 0, patch: { firstPullBatchRule: 'predecessor_suffix', placement: 'right' } })
  const born = await db.transaction(async (trx) => {
    const tenant = await store.readTenantSettingsWithin(trx, { tenantId: TENANT })
    return store.createSheetRowWithin(trx, { ...SCOPE, historyStatus: 'born_empty', labelLocale: 'en', settings: tenant.settings })
  })
  assert.deepEqual([born.historyStatus, born.firstPullBatchRule, born.labelFormat, born.labelLocale, born.bandPlacement, born.landingMode, born.settingsLockedAt, born.historyBatchCount, born.historyMode, born.resolvedAt, born.version],
    ['born_empty', 'predecessor_suffix', 'ordinal_date', 'en', null, null, null, 0, 'inferred', AT, 0])
  assert.equal((await alloc(store, { expectedRule: 'predecessor_suffix' })).label, `Batch 1 (${DAY})`)
  const pending = setup({ status: null })
  const row = await pending.db.transaction((trx) => pending.store.createSheetRowWithin(trx, { ...SCOPE, historyStatus: 'pending', labelLocale: 'zh-CN', settings: PULL_BATCH_BUILT_IN_SETTINGS }))
  assert.deepEqual([row.historyStatus, row.resolvedAt, row.historyBatchCount], ['pending', null, null])
  await rejects(pending.db.transaction((trx) => pending.store.createSheetRowWithin(trx, { ...SCOPE, historyStatus: 'pending', labelLocale: 'zh-CN', settings: PULL_BATCH_BUILT_IN_SETTINGS })), PULL_BATCH_ERROR_CODES.CONFLICT, 'one row per (sheet, project)')
  for (const bad of [
    { historyStatus: 'backfilled' }, { historyStatus: 'installing' }, { labelLocale: 'zh' },
    { settings: { firstPullBatchRule: 'position', labelFormat: 'ordinal' } }, { settings: { firstPullBatchRule: 'material', labelFormat: 'ORDINAL' } }, { settings: null },
  ]) {
    const fresh = setup({ status: null })
    await rejects(fresh.db.transaction((trx) => fresh.store.createSheetRowWithin(trx, { ...SCOPE, historyStatus: 'pending', labelLocale: 'zh-CN', settings: PULL_BATCH_BUILT_IN_SETTINGS, ...bad })), PULL_BATCH_ERROR_CODES.STAMP_INVALID, JSON.stringify(bad))
    assert.equal(fresh.db.rows(kit.T.sheet).length, 0)
  }
})

test('ST-C2 listSheetSettings: the tenant\'s admin rows with captured values, the four lock flags and the version; another tenant\'s rows never appear', async () => {
  const { db, store } = setup({ landing: 'promote_prep_fill' })
  db.seed(kit.T.sheet, kit.sheetRow({ id: 'pbs_other', tenantId: 'tenant-other', sheetId: 'sheet_syn_x', projectNo: 'S-01' }))
  await alloc(store)
  const rows = await store.listSheetSettings({ tenantId: TENANT })
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0], captured: { ...rows[0].captured }, locks: { ...rows[0].locks } }, {
    sheetId: SHEET,
    projectNo: PROJECT,
    historyStatus: 'born_empty',
    labelLocale: 'zh-CN',
    captured: { firstPullBatchRule: 'material', labelFormat: 'ordinal_date', landing: 'promote_prep_fill', placement: 'left' },
    locks: { firstPullBatchRule: true, labelFormat: true, landing: true, placement: true },
    lockedAt: AT,
    version: 1,
  })
})

// ── abort of an install (ruling C7) ──────────────────────────────────────────────────────────────────

const PLAN = Object.freeze({ scheme: 'pull-batch-history/v1', clusters: [{ k: 1, label: '第1批（推定，2026-10-01）' }, { k: 2, label: '第2批（推定，2026-10-08）' }] })

test('ST-X1 (C7, M-CFG-8) abort of a FIRST install with no plan label on the sheet and no live batch => pending, settings_locked_at CLEARED, plan kept flagged aborted, audited', async () => {
  const { db, store } = setup({ status: 'installing', lockedAt: AT, historyPlan: PLAN })
  const seen = []
  const answer = await store.abortInstall({ ...SCOPE, labelsOnSheet: new Set(['人工补充']), auditWithin: async (trx, entry) => { seen.push(entry) } })
  assert.deepEqual({ ...answer }, { historyStatus: 'pending', firstInstall: true, settingsReleased: true, version: 1 })
  const row = sheet(db)
  assert.deepEqual([row.history_status, row.settings_locked_at, row.history_plan.aborted, row.history_plan.clusters.length], ['pending', null, true, 2])
  assert.deepEqual({ ...seen[0].detail }, { firstInstall: true, settingsReleased: true, historyStatus: 'pending', version: 1 })
  assert.equal(seen[0].mode, 'pull_batch_install_aborted')
  // Released: the captured settings may be re-chosen now.
  const edited = await store.setSheetSettings({ ...SCOPE, expectedVersion: 1, patch: { labelFormat: 'ordinal' } })
  assert.equal(edited.captured.labelFormat, 'ordinal')
})

test('ST-X2 (C7) the lock STAYS when a plan label is on the sheet, when 历史批次未知 is, when the project has a live batch, or when the plan is unreadable', async () => {
  const cases = [
    ['a cluster label on a row', { labelsOnSheet: new Set(['第2批（推定，2026-10-08）']) }, PLAN, false],
    ['the unknown label on a row', { labelsOnSheet: new Set(['历史批次未知']) }, PLAN, false],
    ['the en unknown label on a row', { labelsOnSheet: new Set(['Unknown historical batch']) }, PLAN, false],
    ['an unreadable plan', { labelsOnSheet: new Set() }, { scheme: 'pull-batch-history/v1' }, false],
    ['no plan at all', { labelsOnSheet: new Set() }, null, false],
    ['a live batch row', { labelsOnSheet: new Set() }, PLAN, true],
  ]
  for (const [name, input, plan, liveBatch] of cases) {
    const { db, store } = setup({ status: 'installing', lockedAt: AT, historyPlan: plan })
    if (liveBatch) db.seed(kit.T.batch, { id: 'pbat_live', tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, batch_no: 1, origin: 'live', status: 'void', label: label(1), display_day: DAY, source_digest: D1, evidence: null, closed_at: AT, closed_reason: 'void_no_rows' })
    const answer = await store.abortInstall({ ...SCOPE, ...input })
    assert.deepEqual([answer.historyStatus, answer.settingsReleased], ['pending', false], name)
    assert.equal(sheet(db).settings_locked_at, AT, `${name}: the lock stays`)
  }
})

test('ST-X3 abort of a GAP PASS returns to the recorded resolved status and never clears the lock; refusals: not installing, unknown previous status, labelsOnSheet missing, holder refused', async () => {
  const gap = setup({ status: 'installing', lockedAt: AT, resolvedAt: '2026-10-20T00:00:00.000Z', historyPlan: { ...PLAN, previousHistoryStatus: 'backfilled' } })
  // installing with a resolved_at from before: the _sheet row keeps its count / mode across the gap pass.
  gap.db.tables.get(kit.T.sheet).forEach((row) => { row.history_batch_count = 2; row.history_mode = 'inferred' })
  const answer = await gap.store.abortInstall({ ...SCOPE, labelsOnSheet: new Set() })
  assert.deepEqual([answer.historyStatus, answer.firstInstall, answer.settingsReleased], ['backfilled', false, false])
  assert.equal(sheet(gap.db).settings_locked_at, AT)
  const unknownPrevious = setup({ status: 'installing', lockedAt: AT, resolvedAt: '2026-10-20T00:00:00.000Z', historyPlan: PLAN })
  unknownPrevious.db.tables.get(kit.T.sheet).forEach((row) => { row.history_batch_count = 2; row.history_mode = 'inferred' })
  const before = snapshot(unknownPrevious.db)
  const error = await rejects(unknownPrevious.store.abortInstall({ ...SCOPE, labelsOnSheet: new Set() }), PULL_BATCH_ERROR_CODES.CONFLICT, 'previous status unknown')
  assert.equal(error.details.reason, 'previous_status_unknown')
  assert.equal(snapshot(unknownPrevious.db), before)
  const resolved = setup()
  const notInstalling = await rejects(resolved.store.abortInstall({ ...SCOPE, labelsOnSheet: new Set() }), PULL_BATCH_ERROR_CODES.CONFLICT, 'not installing')
  assert.equal(notInstalling.details.reason, 'not_installing')
  await rejects(resolved.store.abortInstall({ ...SCOPE }), PULL_BATCH_ERROR_CODES.STAMP_INVALID, 'labelsOnSheet required')
  const held = setup({ status: 'installing', lockedAt: AT, historyPlan: PLAN })
  const heldBefore = snapshot(held.db)
  await rejects(held.store.abortInstall({ ...SCOPE, labelsOnSheet: new Set(), holderWithin: async () => { throw Object.assign(new Error('lost'), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST' }) } }), 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', 'holder')
  assert.equal(snapshot(held.db), heldBefore)
})

test('ST-E1 every store failure is a typed 503 STORE_FAILED with its operation — never "no batch"; malformed input is refused before any statement', async () => {
  const { db, store } = setup()
  db.faults.selectOne = kit.sqlError('42P01', 'relation does not exist')
  const read = await rejects(store.readSheetState(SCOPE), PULL_BATCH_ERROR_CODES.STORE_FAILED, 'read')
  assert.deepEqual([read.status, read.details.operation, read.details.sqlState], [503, 'read_sheet', '42P01'])
  db.faults.selectOne = kit.sqlError('42P01', 'relation does not exist')
  const tenant = await rejects(store.readTenantSettings({ tenantId: TENANT }), PULL_BATCH_ERROR_CODES.STORE_FAILED, 'tenant read')
  assert.equal(tenant.details.operation, 'read_tenant_settings')
  db.faults.selectOneForUpdate = kit.sqlError('57014', 'canceling statement')
  const allocation = await rejects(alloc(store), PULL_BATCH_ERROR_CODES.STORE_FAILED, 'allocate')
  assert.equal(allocation.details.operation, 'allocate')
  db.faults.selectOneForUpdate = kit.sqlError('57014', 'canceling statement')
  const settings = await rejects(store.writeTenantSettings({ tenantId: TENANT, expectedVersion: 0, patch: { placement: 'right' } }), PULL_BATCH_ERROR_CODES.STORE_FAILED, 'tenant write')
  assert.equal(settings.details.operation, 'write_tenant_settings')
  db.faults.select = kit.sqlError('42501', 'permission denied')
  const probe = await rejects(store.probeReadable(), PULL_BATCH_ERROR_CODES.STORE_FAILED, 'probe')
  assert.equal(probe.details.table, 'settings')
  db.faults.select = kit.sqlError('42501', 'permission denied')
  const list = await rejects(store.listSheetSettings({ tenantId: TENANT }), PULL_BATCH_ERROR_CODES.STORE_FAILED, 'list')
  assert.equal(list.details.operation, 'list_sheet_settings')
  const fresh = setup()
  const before = fresh.db.log.length
  for (const bad of [{ executionRef: 'run_1' }, { executionRef: 'small:' }, { lane: 'other' }, { sourceDigest: 'xyz' }, { labelsOnSheet: [] }, { voidReuse: 'yes' }, { tenantId: '' }]) {
    await rejects(alloc(fresh.store, bad), PULL_BATCH_ERROR_CODES.STAMP_INVALID, JSON.stringify(bad))
  }
  assert.equal(fresh.db.log.length, before, 'no statement on a malformed input')
  const state = await fresh.store.readSheetState(SCOPE)
  assert.deepEqual([state.sheet.historyStatus, state.sheet.firstPullBatchRule, state.sheet.labelFormat, state.sheet.labelLocale, state.sheet.settingsLockedAt, state.sheet.version], ['born_empty', 'material', 'ordinal_date', 'zh-CN', null, 0])
  assert.deepEqual([...state.batches], [])
  assert.throws(() => createStockPreparationPullBatchStore({ db: {} }), /scoped db helper/)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-store.test.cjs', tests)
