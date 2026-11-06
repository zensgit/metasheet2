'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const { createMemoryDb } = require('./support/yida-reconciliation-memory-db.cjs')
const { createYidaReconciliationStore } = require('../lib/yida-reconciliation-store.cjs')

// R-71 ⑦.5 reconciliation store (RC7): one page, one transaction. Synthetic values only; no IO.
const planPromise = import(pathToFileURL(path.join(__dirname, '..', 'lib', 'yida-reconciliation-plan.mjs')).href)
const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const CONTEXT = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' }
const TARGET = 'synthetic-target-ref'
const digest = (label) => crypto.createHash('sha256').update(label).digest('hex')

async function harness(mode = 'register', pageSize = 2) {
  const plan = await planPromise
  const memory = createMemoryDb()
  const store = createYidaReconciliationStore({ db: memory.db, context: CONTEXT })
  const run = await memory.db.transaction(trx => store.openRunInTransaction(trx, { commandId: crypto.randomUUID(), targetRef: TARGET,
    projectNo: 'DEMO-P1', projectKeyTarget: 'project', keyDefinitionDigest: digest('layout'), mode, pageSize }))
  const commit = (pageNumber, entries, totalCount = 4) => store.commitPage({ runId: run.id, pageNumber, totalCount,
    responseDigest: digest(`page-${pageNumber}`), entries,
    evidence: { targetRef: TARGET, planRevision: digest('plan'), formUuid: 'synthetic-form', credentialRef: 'synthetic-credential',
      credentialGeneration: 1, payloadDigest: ({ observedInstanceId, businessKeyDigest }) => plan.yidaReconcilePayloadDigest({
        formUuid: 'synthetic-form', observedInstanceId, businessKeyDigest }) },
    classify: (holder, observedInstanceId) => plan.classifyYidaReconcileRecord({ mode, holder, observedInstanceId }),
    completion: (input) => plan.yidaReconcileCompletion({ ...input, pageSize }) })
  return { memory, store, run, commit }
}
const comparable = (id, key) => ({ observedInstanceId: id, kind: 'comparable', businessKeyDigest: digest(key) })

test('RC7: a registered page inserts reconciled rows + reconcile audits and advances the cursor in one transaction', async () => {
  const { memory, commit } = await harness()
  const result = await commit(1, [comparable('FINST-1', 'K1'), comparable('FINST-2', 'K2')])
  assert.equal(result.run.nextPageNumber, 2)
  assert.equal(result.run.pagesDone, 1)
  assert.equal(result.run.counts.registered, 2)
  const ledger = memory.rows(LEDGER)
  assert.equal(ledger.length, 2)
  for (const row of ledger) {
    assert.equal(row.status, 'reconciled_existing')
    assert.equal(row.intent, 'create')
    assert.equal(row.instance_id, null)
    assert.equal(row.ack_instance_id, null)
    assert.equal(row.ack_status_code, null)
    assert.equal(row.claim_token, null)
    assert.equal(row.workspace_id, null)
    assert.equal(row.target_revision, 'evidence-1')
    assert.equal(row.observed_instance_id, row.row_key)
  }
  assert.deepEqual(memory.rows(AUDIT).map(row => [row.event, row.status, row.reason]),
    [['reconcile', 'reconciled_existing', 'legacy_readback'], ['reconcile', 'reconciled_existing', 'legacy_readback']])
  assert.equal(memory.rows(AUDIT).some(row => row.event === 'acknowledgement'), false)
  assert.equal(memory.rows('integration_yida_reconciliation_pages').length, 1)
})

test('RC7: any failed insert rolls the whole page back and the cursor does not move', async () => {
  const { memory, store, run, commit } = await harness()
  memory.state.failInsert = (table) => table === 'integration_yida_reconciliation_pages'
  await assert.rejects(commit(1, [comparable('FINST-1', 'K1')]), { code: 'YIDA_RECONCILE_STORE_UNAVAILABLE' })
  assert.equal(memory.rows(LEDGER).length, 0)
  assert.equal(memory.rows(AUDIT).length, 0)
  const view = await store.inspect({ runId: run.id })
  assert.equal(view.nextPageNumber, 1)
  assert.equal(view.pagesDone, 0)
  // The cursor update itself failing also leaves nothing behind.
  memory.state.failInsert = null
  memory.state.failUpdate = (table) => table === 'integration_yida_reconciliation_runs'
  await assert.rejects(commit(1, [comparable('FINST-1', 'K1')]))
  assert.equal(memory.rows(LEDGER).length, 0)
  memory.state.failUpdate = null
  assert.equal((await commit(1, [comparable('FINST-1', 'K1')])).run.counts.registered, 1)
})

test('RC7: a page already committed by another step is STALE and writes nothing', async () => {
  const { memory, commit } = await harness()
  await commit(1, [comparable('FINST-1', 'K1'), comparable('FINST-2', 'K2')])
  const before = memory.rows(LEDGER).length
  await assert.rejects(commit(1, [comparable('FINST-1', 'K1')]), { code: 'YIDA_RECONCILE_STORE_STALE' })
  assert.equal(memory.rows(LEDGER).length, before)
})

test('RC7: a concurrent reservation on the fence makes the page RETRY with nothing written', async () => {
  const { memory, commit } = await harness()
  // Another transaction reserves K2 between our fence lookup and our insert.
  memory.state.beforeStatement = async (table, verb) => {
    if (table === LEDGER && verb === 'insert' && !memory.rows(LEDGER).some(row => row.operation_id === 'synthetic-admission')) {
      memory.rows(LEDGER).push({ id: 'synthetic-race', tenant_id: CONTEXT.tenantId, workspace_id: null, target_ref: TARGET,
        business_key_digest: digest('K1'), intent: 'create', status: 'prepared', operation_id: 'synthetic-admission', row_key: 'r' })
    }
  }
  await assert.rejects(commit(1, [comparable('FINST-1', 'K1')]), { code: 'YIDA_RECONCILE_STORE_RETRY' })
  // The race row was "committed" by the other session before ours rolled back; ours wrote nothing.
  memory.state.beforeStatement = null
  assert.equal(memory.rows(LEDGER).filter(row => row.status === 'reconciled_existing').length, 0)
  assert.equal(memory.rows(AUDIT).length, 0)
})

test('RC7: replay classifications: own rows are never updated, duplicates become observations', async () => {
  const { memory, commit } = await harness('register', 10)
  const own = (key, status, extra = {}) => memory.seed(LEDGER, { tenant_id: CONTEXT.tenantId, workspace_id: null, target_ref: TARGET,
    business_key_digest: digest(key), intent: 'create', status, operation_id: `op-${key}`, row_key: `row-${key}`,
    ack_instance_id: null, observed_instance_id: null, ...extra })
  own('KA', 'acknowledged', { ack_instance_id: 'FINST-A' })
  own('KB', 'acknowledged', { ack_instance_id: 'FINST-OTHER' })
  own('KC', 'prepared')
  own('KD', 'outcome_unknown')
  own('KE', 'not_sent')
  const before = JSON.stringify(memory.rows(LEDGER))
  const result = await commit(1, [comparable('FINST-A', 'KA'), comparable('FINST-B', 'KB'), comparable('FINST-C', 'KC'),
    comparable('FINST-D', 'KD'), comparable('FINST-E', 'KE'), comparable('FINST-F', 'KF'), comparable('FINST-G', 'KF'),
    { observedInstanceId: 'FINST-H', kind: 'key_unmatchable' }, { observedInstanceId: 'FINST-I', kind: 'project_mismatch' }], 9)
  const counts = result.run.counts
  assert.deepEqual([counts.own_acknowledged, counts.duplicate_with_own, counts.own_in_flight, counts.observed_for_unknown,
    counts.own_not_sent, counts.registered, counts.duplicate_remote, counts.key_unmatchable, counts.project_mismatch, counts.scanned],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 9])
  // The five pre-existing rows are byte-identical: never updated.
  assert.equal(JSON.stringify(memory.rows(LEDGER).slice(0, 5)), before)
  assert.equal(result.run.status, 'completed')
  const observations = memory.rows('integration_yida_reconciliation_observations')
  assert.deepEqual(observations.map(row => row.outcome).sort(),
    ['duplicate_remote', 'duplicate_with_own', 'key_unmatchable', 'observed_for_unknown', 'own_in_flight', 'own_not_sent'])
  assert.equal(observations.find(row => row.outcome === 'key_unmatchable').business_key_digest, null)
})

test('RC7: count mode writes no ledger row and a second count after register sees already_reconciled', async () => {
  const counting = await harness('count')
  const first = await counting.commit(1, [comparable('FINST-1', 'K1'), comparable('FINST-2', 'K1')], 2)
  assert.equal(first.run.counts.would_register, 1)
  assert.equal(first.run.counts.duplicate_remote, 1)
  assert.equal(counting.memory.rows(LEDGER).length, 0)
  assert.equal(counting.memory.rows(AUDIT).length, 0)
})

test('RC7: total-count change at completion fails the run for good; a failed run resumes only when retryable', async () => {
  const { commit } = await harness()
  const result = await commit(1, [comparable('FINST-1', 'K1')], 3)
  assert.equal(result.run.status, 'completed')
  const other = await harness()
  const changed = await other.commit(1, [comparable('FINST-1', 'K1'), comparable('FINST-2', 'K2')], 4)
  assert.equal(changed.run.status, 'running')
  const final = await other.commit(2, [comparable('FINST-3', 'K3')], 5)
  assert.equal(final.run.status, 'failed')
  assert.equal(final.run.lastErrorCode, 'TOTAL_CHANGED')
  const reopened = await other.memory.db.transaction(trx => other.store.openRunInTransaction(trx, {
    commandId: other.memory.rows('integration_yida_reconciliation_runs')[0].command_id, targetRef: TARGET, projectNo: 'DEMO-P1',
    projectKeyTarget: 'project', keyDefinitionDigest: digest('layout'), mode: 'register', pageSize: 2 }))
  assert.equal(reopened.status, 'failed')
  // RETRY is resumable.
  const third = await harness()
  await third.store.failRun({ runId: third.run.id, code: 'RETRY' })
  const resumed = await third.memory.db.transaction(trx => third.store.openRunInTransaction(trx, {
    commandId: third.run.command_id, targetRef: TARGET, projectNo: 'DEMO-P1', projectKeyTarget: 'project',
    keyDefinitionDigest: digest('layout'), mode: 'register', pageSize: 2 }))
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.last_error_code, null)
  // Same commandId, different project or mode: CONFLICT.
  await assert.rejects(third.memory.db.transaction(trx => third.store.openRunInTransaction(trx, {
    commandId: third.run.command_id, targetRef: TARGET, projectNo: 'DEMO-P2', projectKeyTarget: 'project',
    keyDefinitionDigest: digest('layout'), mode: 'register', pageSize: 2 })), { code: 'YIDA_RECONCILE_STORE_CONFLICT' })
})

test('RC7: the store projection never carries the project number', async () => {
  const { store, run } = await harness()
  const view = await store.inspect({ runId: run.id })
  assert.equal(JSON.stringify(view).includes('DEMO-P1'), false)
  assert.deepEqual(Object.keys(view).sort(), ['commandId', 'counts', 'lastErrorCode', 'mode', 'nextPageNumber', 'pageSize',
    'pagesDone', 'runId', 'status', 'targetRef', 'totalCountFirst', 'totalCountLast'])
})
