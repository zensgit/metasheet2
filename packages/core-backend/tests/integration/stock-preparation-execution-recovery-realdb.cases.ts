/**
 * Batch-refresh step 6a-2 (S6-2; register row R-91) — real-Postgres proof of the RECOVERY CLOSE (closeExecution) over
 * migrations 100 (the write lock), 104 (the change plan), 105 (批次标识's ledger) and 106 (the close shape), through the
 * REAL scoped db helper, the REAL continuation store, the REAL write lock's in-transaction holder assert and the REAL
 * pull-batch store's close hook (batchWithin). Values-free: every id is synthetic and per run.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationExecutionRecoveryRealDbCases()` registers its `describe`
 * block and is called from the already-wired stock-prep real-DB host (tests/integration/stock-preparation-p4-repair-once-
 * realdb.test.ts), so the cases run in the existing "Run multitable real-DB integration" step of plugin-tests.yml
 * (aggregated into the required `test (20.x)`) without a workflow edit. Do NOT also list it as a standalone file there.
 *
 *   S9R-CL1  a puller `mixed` close of a plan-bound partial run (§3.7 P2): PostgreSQL accepts every 104 / 106 shape the close
 *            writes — CP invalidated(execution_failed), the recovery-written plan RW (written, recovered_from = CP, the
 *            landed write record only), W0 superseded FIRST (104's one-`written` partial unique holds), the execution
 *            verified_closed / mixed / puller_verified with the lease facts; 批次标识's link finished by value
 *            (verified_mixed, count := the sheet count), the batch kept open; decision_version + 1
 *   S9R-15   E09: an audit failure inside the close rolls back EVERYTHING — execution, plans, the 批次标识 link and batch
 *   S9R-BI-01 (store leg) a `landed` close of a linked run closes the open batch `recovery_verified`, count := n by value;
 *            an unlinked `landed` close closes a same-digest open batch `completed_by_later_execution`; `nothing_landed`
 *            keeps it open and never voids it
 *   S9R-26   the recovery's lease was taken over (another lease id / epoch on the lock row): the close's holder assert is
 *            409 LEASE_LOST and nothing persists
 *   RC-07r   a 55P03 by step on real row locks (a second connection holds the row): the lock row => 409 WRITE_LOCKED
 *            holder_in_write; the state row => 409 RECOVERY_BUSY state_row; the execution row => RECOVERY_BUSY execution
 *   S9R-U07  every step-6a artifact class makes its rollback stop-condition query non-zero (design §7.5 as amended by B-22):
 *            an unfinished execution; a puller close not yet settled (the 106 header query); a TRANSPARENT close over an
 *            UNSETTLED `succeeded` subject (the 106 header query, B-22); a plan left `confirmed` by a nothing_landed close
 *            (P3); a recovery-written plan RW — and the 106 query is zero once the settlement names the subject.
 *
 * The recovery through the REAL routes on the REAL stack (the multitable host, the route table, the lock's heartbeat, the
 * 批次标识 stamping writer) lives beside the stacks it needs, in stock-preparation-project-write-lock-realdb.cases.ts:
 * S9R-BI-02, S9R-BI-03, S9R-25 / 25b, S9R-29d (in its BI-1b block) and S9R-16 (recovery leg) / S9R-18 (P1 leg) (in its S8
 * block).
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
const MIGRATION_106 = path.join(REPO_ROOT, 'packages/core-backend/migrations/106_extend_integration_stock_prep_refresh_execution_for_recovery.sql')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const storeLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
const intentLib = require(path.join(PLUGIN_LIB, 'stock-preparation-execution-intent.cjs')) as any
const lockLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const pullBatchStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch-store.cjs')) as any
const pairing = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-pairing.cjs')) as any
const fs = require('node:fs') as typeof import('node:fs')

const { REFRESH_STORE_TABLES: RT, REFRESH_STORE_ERROR_CODES: CODES, createStockPreparationContinuationStore } = storeLib
const { buildExecutionIntent } = intentLib
const { PROJECT_WRITE_ERROR_CODES, PROJECT_WRITE_LOCK_TABLE, createStockPreparationProjectWriteLock, sheetWriteScopeKey } = lockLib
const { PULL_BATCH_TABLES: PB, createStockPreparationPullBatchStore } = pullBatchStoreLib

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function hostLikeDb() {
  return createDb({
    database: {
      query: async (sql: string, params?: unknown[]) => (await q(sql, params)).rows,
      transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        const client = await poolManager.get().getInternalPool().connect()
        try {
          await client.query('BEGIN')
          const result = await callback({
            query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
            commit: async () => {},
            rollback: async () => {},
          })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        } finally {
          client.release()
        }
      },
    },
  })
}

async function caught(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

// A second connection holding ONE row FOR UPDATE until released (the bounded-wait refusals by step).
async function holdRow(sql: string, params: unknown[]) {
  const client = await poolManager.get().getInternalPool().connect()
  await client.query('BEGIN')
  await client.query(sql, params)
  return async () => {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

export function defineStockPreparationExecutionRecoveryRealDbCases(): void {
  test('execution recovery real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1') return
    if (!process.env.DATABASE_URL) throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the S6-2 cases would skip-green')
  })

  describeIfDatabase('batch-refresh step 6a-2 (S6-2): the recovery close under the lease, the plan cells, 批次标识\'s close hook, the stop conditions (real Postgres)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const TENANT = `tenant_s62_${TOKEN}`
    const PLAN_DIGEST = 'a'.repeat(64)
    const BI_DIGEST = 'b'.repeat(32)
    const GUARD = { leaseRunId: `run_s62_${TOKEN}`, leaseId: `lease_s62_${TOKEN}`, fencingEpoch: 1, generation: 1, generationToken: `g_s62_${TOKEN}` }
    const scopeOf = (name: string) => ({ tenantId: TENANT, sheetId: `sheet_s62_${TOKEN}_${name}`, projectNo: `P-S62-${name}` })
    const sheets: string[] = []
    const store = createStockPreparationContinuationStore({ db: hostLikeDb() })
    const lock = createStockPreparationProjectWriteLock({ db: hostLikeDb() })
    const ledger = createStockPreparationPullBatchStore({ db: hostLikeDb() })
    const intentOf = (n: number) => buildExecutionIntent({
      plan: { decisions: Array.from({ length: n }, (_, i) => ({ decision: 'add', idempotencyKey: `{"k":"s62-${i}"}`, record: { idempotencyKey: `{"k":"s62-${i}"}`, rawQuantity: i } })) },
      planDigest: PLAN_DIGEST,
    })
    const beginInput = (scope: any, extra: Record<string, unknown> = {}) => ({
      ...scope, lane: 'small_apply', guard: GUARD, tokenRevision: 'rev_s62', planDigest: PLAN_DIGEST, plannedCounts: { add: 1 }, refreshBinding: { continuations: [] }, startedBy: 'u_s62', intent: intentOf(1), ...extra,
    })
    async function stateRow(scope: any) {
      sheets.push(scope.sheetId)
      await q(`INSERT INTO ${RT.state} (id, tenant_id, sheet_id, project_no, write_scope_key) VALUES ($1, $2, $3, $4, $5)`, [`rst_s62_${scope.sheetId}`, TENANT, scope.sheetId, scope.projectNo, sheetWriteScopeKey(scope.sheetId)])
    }
    async function lease(scope: any) {
      const grant = await lock.acquire(sheetWriteScopeKey(scope.sheetId), { purpose: 'recovery_verify', runId: `rec_s62_${TOKEN}`, tenantId: TENANT })
      return {
        grant,
        holderWithin: (trx: any) => lock.assertHolderWithin(trx, grant.scopeKey, { leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch, reason: 'recovery_close' }),
        facts: { leaseId: grant.leaseId, leaseRunId: `rec_s62_${TOKEN}`, fencingEpoch: grant.fencingEpoch },
      }
    }
    const audits: any[] = []
    const auditOk = async (_trx: any, event: any) => { audits.push(event) }
    function plan(scope: any, id: string, status: string, records: Array<[string, string, Record<string, [unknown, unknown]>]>, extra: Record<string, unknown> = {}) {
      const recordSet = records.map(([recordId, key, fields]) => ({ recordId, key, root: false, inContinuation: null, fields: Object.fromEntries(Object.entries(fields).map(([fieldId, [before, after]]) => [fieldId, { before, after, afterCanonical: after }])) }))
      const row: Record<string, unknown> = {
        id, tenant_id: TENANT, sheet_id: scope.sheetId, project_no: scope.projectNo, write_scope_key: sheetWriteScopeKey(scope.sheetId), status,
        plan_fingerprint: 'f'.repeat(64), source_content_digest: 'c'.repeat(32), planned_content_digest: pairing.plannedContentDigestOf(recordSet),
        record_count: recordSet.length, write_record_count: recordSet.length, record_set: JSON.stringify(recordSet), absorbed_change_plan_ids: '[]',
        hold_ids: '["hold_s62"]', hold_set_fingerprint: 'h'.repeat(64), continuation_ids: '[]', review_baseline_digest: 'none',
        confirmed_by: 'u_s62', confirmed_at: new Date(), confirmed_generation: 1, confirmed_generation_token: 'g_c', confirmed_fencing_epoch: 1, ...extra,
      }
      const columns = Object.keys(row)
      return q(`INSERT INTO ${RT.changePlan} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, columns.map((column) => row[column]))
    }
    async function batchAndLink(scope: any, executionId: string | null, { status = 'open', digest = BI_DIGEST } = {}) {
      const batchId = `pbat_s62_${scope.sheetId}`
      await q(`INSERT INTO ${PB.batch} (id, tenant_id, sheet_id, project_no, batch_no, origin, status, label, display_day, source_digest) VALUES ($1, $2, $3, $4, 1, 'live', $5, 'L-1', CURRENT_DATE, $6)`, [batchId, TENANT, scope.sheetId, scope.projectNo, status, digest])
      if (executionId) {
        await q(`INSERT INTO ${PB.execution} (id, batch_id, tenant_id, sheet_id, project_no, execution_ref, lane, refresh_execution_id, finished_at, writer_status, created_row_count) VALUES ($1, $2, $3, $4, $5, $6, 'small_apply', $7, now(), 'partial', 9)`, [`pbx_s62_${scope.sheetId}`, batchId, TENANT, scope.sheetId, scope.projectNo, `small:run-${scope.sheetId}`, executionId])
      }
      return batchId
    }
    const batchWithin = (trx: any, input: any) => ledger.batchWithin(trx, input)
    const classification = (execution: any, result: string, extra: Record<string, unknown> = {}) => ({ result, intentDigest: execution.intentDigest, counts: { intended: 2, landed: result === 'landed' ? 2 : 1, notLanded: result === 'mixed' ? 1 : 0 }, landedRecordIds: [], landedAddCount: 1, verifiedCreatedRows: 1, ...extra })

    afterAll(async () => {
      await q(`DELETE FROM ${PB.execution} WHERE tenant_id = $1`, [TENANT])
      await q(`DELETE FROM ${PB.batch} WHERE tenant_id = $1`, [TENANT])
      await q(`DELETE FROM ${RT.changePlan} WHERE tenant_id = $1`, [TENANT])
      await q(`DELETE FROM ${RT.intent} WHERE tenant_id = $1`, [TENANT])
      await q(`DELETE FROM ${RT.execution} WHERE tenant_id = $1`, [TENANT])
      await q(`DELETE FROM ${RT.state} WHERE tenant_id = $1`, [TENANT])
      if (sheets.length > 0) await q(`DELETE FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = ANY($1::text[])`, [sheets.map((sheet) => sheetWriteScopeKey(sheet))])
    })

    test('S9R-CL1 + S9R-15 a plan-bound PARTIAL run closed `mixed` (P2): PostgreSQL accepts every shape; RW written, W0 superseded first, CP invalidated; 批次标识 link by value, batch kept open; an audit failure first rolls back EVERYTHING', async () => {
      const scope = scopeOf('cl1')
      await stateRow(scope)
      await plan(scope, `chp_w0_${scope.sheetId}`, 'written', [['rec_9', 'k9', { rawQuantity: [7, 8] }]], { execution_id: 'exec_old', written_at: new Date(), written_content_digest: 'w'.repeat(64) })
      await plan(scope, `chp_cp_${scope.sheetId}`, 'confirmed', [['rec_1', 'k1', { rawQuantity: [1, 2] }], ['rec_2', 'k2', { rawQuantity: [3, 4] }]])
      const execution = await store.beginExecution(beginInput(scope, { refreshBinding: { continuations: [], changePlanId: `chp_cp_${scope.sheetId}` }, pullBatchSourceDigest: BI_DIGEST, intent: intentOf(2) }))
      await store.finishExecution({ ...scope, executionId: execution.id, status: 'partial', written: 1, attemptedWrites: 2 })
      // finish invalidated CP (execution_failed) — the P7 column; reset it to `confirmed` to drive P2 (a run that died running).
      await q(`UPDATE ${RT.changePlan} SET status = 'confirmed', invalidated_at = NULL, invalidated_reason = NULL, execution_id = NULL WHERE id = $1`, [`chp_cp_${scope.sheetId}`])
      const batchId = await batchAndLink(scope, execution.id)
      const held = await lease(scope)
      const input = { ...scope, executionId: execution.id, mode: 'puller_verified', classification: classification(execution, 'mixed', { landedRecordIds: ['rec_1'] }), lease: held.facts, closedBy: 'u_s62_puller' }
      const snapshot = async () => JSON.stringify([
        (await q(`SELECT status, closed_mode FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows,
        (await q(`SELECT id, status FROM ${RT.changePlan} WHERE sheet_id = $1 ORDER BY id`, [scope.sheetId])).rows,
        (await q(`SELECT verified_outcome, created_row_count FROM ${PB.execution} WHERE batch_id = $1`, [batchId])).rows,
        (await q(`SELECT decision_version FROM ${RT.state} WHERE sheet_id = $1`, [scope.sheetId])).rows,
      ])
      const before = await snapshot()
      const failed = await caught(store.closeExecution(input, { holderWithin: held.holderWithin, batchWithin, auditWithin: async () => { throw Object.assign(new Error('audit down'), { code: '57P01' }) } }))
      expect([failed && failed.status, failed && failed.code]).toEqual([503, CODES.STORE_FAILED])
      expect(await snapshot()).toBe(before)
      const closed = await store.closeExecution(input, { holderWithin: held.holderWithin, batchWithin, auditWithin: auditOk })
      expect([closed.preStatus, closed.result, closed.changePlan.cell, closed.batchOutcome, closed.transparent]).toEqual(['partial', 'mixed', 'P2', 'kept_open', false])
      const row = (await q(`SELECT status, verified_result, closed_mode, pre_close_status, verify_lease_run_id, verify_fencing_epoch, settlement_subject, verify_summary FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0]
      expect([row.status, row.verified_result, row.closed_mode, row.pre_close_status, row.verify_lease_run_id, row.verify_fencing_epoch, row.settlement_subject]).toEqual(['verified_closed', 'mixed', 'puller_verified', 'partial', held.facts.leaseRunId, held.grant.fencingEpoch, true])
      expect(row.verify_summary.changePlanCell).toBe('P2')
      const plans = (await q(`SELECT id, status, invalidated_reason, superseded_by, recovered_from_change_plan_id, write_record_count, execution_id FROM ${RT.changePlan} WHERE sheet_id = $1`, [scope.sheetId])).rows
      const byId = new Map(plans.map((entry: any) => [entry.id, entry]))
      const rw = plans.find((entry: any) => entry.recovered_from_change_plan_id === `chp_cp_${scope.sheetId}`)
      expect([rw.status, rw.write_record_count, rw.execution_id]).toEqual(['written', 1, execution.id])
      expect([(byId.get(`chp_cp_${scope.sheetId}`) as any).status, (byId.get(`chp_cp_${scope.sheetId}`) as any).invalidated_reason]).toEqual(['invalidated', 'execution_failed'])
      expect([(byId.get(`chp_w0_${scope.sheetId}`) as any).status, (byId.get(`chp_w0_${scope.sheetId}`) as any).superseded_by]).toEqual(['superseded', rw.id])
      const link = (await q(`SELECT finished_at IS NOT NULL AS finished, verified_outcome, created_row_count FROM ${PB.execution} WHERE batch_id = $1`, [batchId])).rows[0]
      expect(link).toEqual({ finished: true, verified_outcome: 'verified_mixed', created_row_count: 1 })
      expect((await q(`SELECT status FROM ${PB.batch} WHERE id = $1`, [batchId])).rows[0].status).toBe('open')
      expect((await q(`SELECT decision_version FROM ${RT.state} WHERE sheet_id = $1`, [scope.sheetId])).rows[0].decision_version).toBe(1)
    }, 120000)

    test('S9R-BI-01 (store leg) 批次标识\'s close hook on PostgreSQL: a linked `landed` close closes the open batch recovery_verified with the count BY VALUE; an unlinked `landed` close closes a same-digest open batch completed_by_later_execution; `nothing_landed` keeps the batch open (never void)', async () => {
      const linked = scopeOf('bi_linked')
      await stateRow(linked)
      const e1 = await store.beginExecution(beginInput(linked, { pullBatchSourceDigest: BI_DIGEST }))
      await store.finishExecution({ ...linked, executionId: e1.id, status: 'failed', written: 1, attemptedWrites: 1 })
      const b1 = await batchAndLink(linked, e1.id)
      const h1 = await lease(linked)
      const c1 = await store.closeExecution({ ...linked, executionId: e1.id, mode: 'puller_verified', classification: classification(e1, 'landed', { verifiedCreatedRows: 4 }), lease: h1.facts, closedBy: 'u_s62' }, { holderWithin: h1.holderWithin, batchWithin, auditWithin: auditOk })
      expect(c1.batchOutcome).toBe('closed')
      expect((await q(`SELECT status, closed_reason FROM ${PB.batch} WHERE id = $1`, [b1])).rows[0]).toEqual({ status: 'closed', closed_reason: 'recovery_verified' })
      expect((await q(`SELECT verified_outcome, created_row_count FROM ${PB.execution} WHERE batch_id = $1`, [b1])).rows[0]).toEqual({ verified_outcome: 'verified_landed', created_row_count: 4 })

      const unlinked = scopeOf('bi_unlinked')
      await stateRow(unlinked)
      const e2 = await store.beginExecution(beginInput(unlinked, { pullBatchSourceDigest: BI_DIGEST }))
      await store.finishExecution({ ...unlinked, executionId: e2.id, status: 'aborted', written: 1, attemptedWrites: 1 })
      const b2 = await batchAndLink(unlinked, null)
      const h2 = await lease(unlinked)
      const c2 = await store.closeExecution({ ...unlinked, executionId: e2.id, mode: 'puller_verified', classification: classification(e2, 'landed'), lease: h2.facts, closedBy: 'u_s62' }, { holderWithin: h2.holderWithin, batchWithin, auditWithin: auditOk })
      expect(c2.batchOutcome).toBe('closed')
      expect((await q(`SELECT status, closed_reason FROM ${PB.batch} WHERE id = $1`, [b2])).rows[0]).toEqual({ status: 'closed', closed_reason: 'completed_by_later_execution' })

      const kept = scopeOf('bi_kept')
      await stateRow(kept)
      const e3 = await store.beginExecution(beginInput(kept, { pullBatchSourceDigest: BI_DIGEST }))
      await store.finishExecution({ ...kept, executionId: e3.id, status: 'failed', written: 0, attemptedWrites: 1 })
      const b3 = await batchAndLink(kept, e3.id)
      const h3 = await lease(kept)
      const c3 = await store.closeExecution({ ...kept, executionId: e3.id, mode: 'puller_verified', classification: classification(e3, 'nothing_landed', { verifiedCreatedRows: 0 }), lease: h3.facts, closedBy: 'u_s62' }, { holderWithin: h3.holderWithin, batchWithin, auditWithin: auditOk })
      expect([c3.batchOutcome, c3.transparent]).toEqual(['kept_open', true])
      expect((await q(`SELECT status FROM ${PB.batch} WHERE id = $1`, [b3])).rows[0].status).toBe('open')
      expect((await q(`SELECT verified_outcome, created_row_count FROM ${PB.execution} WHERE batch_id = $1`, [b3])).rows[0]).toEqual({ verified_outcome: 'verified_nothing_landed', created_row_count: 0 })
    }, 120000)

    test('S9R-26 the recovery\'s lease was taken over before its close: the in-transaction holder assert is 409 LEASE_LOST and nothing persists', async () => {
      const scope = scopeOf('lost')
      await stateRow(scope)
      const execution = await store.beginExecution(beginInput(scope))
      await store.finishExecution({ ...scope, executionId: execution.id, status: 'failed', written: 1, attemptedWrites: 1 })
      const held = await lease(scope)
      // A takeover: another lease id and epoch + 1 on the lock row.
      await q(`UPDATE ${PROJECT_WRITE_LOCK_TABLE} SET lease_id = $2, fencing_epoch = fencing_epoch + 1 WHERE scope_key = $1`, [held.grant.scopeKey, `lease_other_${TOKEN}`])
      const error = await caught(store.closeExecution({ ...scope, executionId: execution.id, mode: 'puller_verified', classification: classification(execution, 'landed'), lease: held.facts, closedBy: 'u_s62' }, { holderWithin: held.holderWithin, auditWithin: auditOk }))
      expect([error && error.status, error && error.code, error && error.details && error.details.reason]).toEqual([409, PROJECT_WRITE_ERROR_CODES.LEASE_LOST, 'recovery_close'])
      expect((await q(`SELECT status FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0].status).toBe('failed')
      expect((await q(`SELECT decision_version FROM ${RT.state} WHERE sheet_id = $1`, [scope.sheetId])).rows[0].decision_version).toBe(0)
    }, 120000)

    test('RC-07r a 55P03 is classified by the step on REAL row locks: the lock row => 409 WRITE_LOCKED holder_in_write; the state row => RECOVERY_BUSY state_row; the execution row => RECOVERY_BUSY execution; nothing persists', async () => {
      const scope = scopeOf('busy')
      await stateRow(scope)
      const execution = await store.beginExecution(beginInput(scope))
      await store.finishExecution({ ...scope, executionId: execution.id, status: 'failed', written: 1, attemptedWrites: 1 })
      const held = await lease(scope)
      const input = { ...scope, executionId: execution.id, mode: 'puller_verified', classification: classification(execution, 'landed'), lease: held.facts, closedBy: 'u_s62' }
      const hooks = { holderWithin: held.holderWithin, auditWithin: auditOk }
      for (const [label, sql, param, expected] of [
        ['lock row', `SELECT 1 FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1 FOR UPDATE`, held.grant.scopeKey, [409, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 'holder_in_write', undefined]],
        ['state row', `SELECT 1 FROM ${RT.state} WHERE sheet_id = $1 FOR UPDATE`, scope.sheetId, [409, CODES.RECOVERY_BUSY, undefined, 'state_row']],
        ['execution row', `SELECT 1 FROM ${RT.execution} WHERE id = $1 FOR UPDATE`, execution.id, [409, CODES.RECOVERY_BUSY, undefined, 'execution']],
      ] as Array<[string, string, string, unknown[]]>) {
        const release = await holdRow(sql, [param])
        const started = Date.now()
        let error: any
        try {
          error = await caught(store.closeExecution(input, hooks))
        } finally {
          await release()
        }
        expect([label, error && error.status, error && error.code, error && error.details && error.details.reason, error && error.details && error.details.step]).toEqual([label, ...expected])
        expect(Date.now() - started).toBeLessThan(15000)
        expect((await q(`SELECT status FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0].status).toBe('failed')
      }
      // Released: the same close commits.
      const closed = await store.closeExecution(input, hooks)
      expect(closed.result).toBe('landed')
    }, 120000)

    test('S9R-U07 each step-6a artifact class makes its rollback stop-condition query non-zero (design §7.5 + B-22): an unfinished execution; an unsettled puller close; a TRANSPARENT close over an unsettled `succeeded` subject; a plan left confirmed (P3); a recovery-written plan — and the 106 query is zero once settled', async () => {
      const header = fs.readFileSync(MIGRATION_106, 'utf8').replace(/\r\n/g, '\n').split('\n')
      const first = header.findIndex((line) => /^--\s+SELECT count\(\*\) FROM integration_stock_prep_refresh_state s\s*$/.test(line))
      const last = header.findIndex((line, index) => index > first && /\)\);\s*$/.test(line))
      expect([first > 0, last > first]).toEqual([true, true])
      const stopSql = header.slice(first, last + 1).map((line) => line.replace(/^--\s?/, '')).join('\n').replace(/;\s*$/, '')
      const subjectStop = async (scope: any) => Number((await q(`${stopSql} AND s.tenant_id = $1 AND s.sheet_id = $2 AND s.project_no = $3`, [TENANT, scope.sheetId, scope.projectNo])).rows[0].count)
      const count = async (sql: string, scope: any) => Number((await q(sql, [TENANT, scope.sheetId])).rows[0].n)
      const unfinishedStop = (scope: any) => count(`SELECT count(*)::int AS n FROM ${RT.execution} WHERE tenant_id = $1 AND sheet_id = $2 AND status IN ('running', 'partial', 'failed', 'aborted')`, scope)
      const pendingPlanStop = (scope: any) => count(`SELECT count(*)::int AS n FROM ${RT.changePlan} WHERE tenant_id = $1 AND sheet_id = $2 AND status IN ('confirmed', 'written')`, scope)
      const recoveredPlanStop = (scope: any) => count(`SELECT count(*)::int AS n FROM ${RT.changePlan} WHERE tenant_id = $1 AND sheet_id = $2 AND recovered_from_change_plan_id IS NOT NULL`, scope)
      const startedAgo = (id: string, minutes: number) => q(`UPDATE ${RT.execution} SET started_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutes])

      // (1) an unfinished execution (partial): the 102-104 stop condition counts it.
      const u1 = scopeOf('u07_unfinished')
      await stateRow(u1)
      const partial = await store.beginExecution(beginInput(u1))
      await store.finishExecution({ ...u1, executionId: partial.id, status: 'partial', written: 1, attemptedWrites: 2 })
      expect(await unfinishedStop(u1)).toBe(1)

      // (2) a puller close (landed) not yet settled: the 106 query counts it; zero once the settlement names it.
      const u2 = scopeOf('u07_puller')
      await stateRow(u2)
      const landed = await store.beginExecution(beginInput(u2))
      await store.finishExecution({ ...u2, executionId: landed.id, status: 'failed', written: 1, attemptedWrites: 1 })
      const h2 = await lease(u2)
      await store.closeExecution({ ...u2, executionId: landed.id, mode: 'puller_verified', classification: classification(landed, 'landed'), lease: h2.facts, closedBy: 'u_s62' }, { holderWithin: h2.holderWithin, auditWithin: auditOk })
      expect([await unfinishedStop(u2), await subjectStop(u2)]).toEqual([0, 1])
      await q(`UPDATE ${RT.state} SET settled_at = now(), settled_execution_id = $1, settled_sheet_machine_digest = 'm', settled_source_content_digest = 's', settled_generation_token = 'g' WHERE sheet_id = $2`, [landed.id, u2.sheetId])
      expect(await subjectStop(u2)).toBe(0)

      // (3) B-22: a TRANSPARENT recovery close over an UNSETTLED `succeeded` subject — the raw newest is the transparent close
      // (an older build's 已完成) while the subject is not settled: the 106 query counts it; zero once settled.
      const u3 = scopeOf('u07_transparent')
      await stateRow(u3)
      const subject = await store.beginExecution(beginInput(u3))
      await store.finishExecution({ ...u3, executionId: subject.id, status: 'succeeded', written: 1, attemptedWrites: 1 })
      const later = await store.beginExecution(beginInput(u3))
      await store.finishExecution({ ...u3, executionId: later.id, status: 'failed', written: 0, attemptedWrites: 1 })
      await startedAgo(subject.id, 2)
      await startedAgo(later.id, 1)
      const h3 = await lease(u3)
      const transparent = await store.closeExecution({ ...u3, executionId: later.id, mode: 'puller_verified', classification: classification(later, 'nothing_landed'), lease: h3.facts, closedBy: 'u_s62' }, { holderWithin: h3.holderWithin, auditWithin: auditOk })
      expect(transparent.transparent).toBe(true)
      expect((await q(`SELECT settlement_subject FROM ${RT.execution} WHERE id = $1`, [later.id])).rows[0].settlement_subject).toBe(false)
      expect(await subjectStop(u3)).toBe(1)
      await q(`UPDATE ${RT.state} SET settled_at = now(), settled_execution_id = $1, settled_sheet_machine_digest = 'm', settled_source_content_digest = 's', settled_generation_token = 'g' WHERE sheet_id = $2`, [subject.id, u3.sheetId])
      expect(await subjectStop(u3)).toBe(0)

      // (4) a plan left `confirmed` by a nothing_landed close (P3) — pending, the stop condition counts it.
      const u4 = scopeOf('u07_p3')
      await stateRow(u4)
      await plan(u4, `chp_cp_${u4.sheetId}`, 'confirmed', [['rec_1', 'k1', { rawQuantity: [1, 2] }]])
      const p3 = await store.beginExecution(beginInput(u4, { refreshBinding: { continuations: [], changePlanId: `chp_cp_${u4.sheetId}` } }))
      await q(`UPDATE ${RT.execution} SET status = 'aborted', finished_at = now(), written = 0, attempted_writes = 1 WHERE id = $1`, [p3.id])
      const h4 = await lease(u4)
      const kept = await store.closeExecution({ ...u4, executionId: p3.id, mode: 'puller_verified', classification: classification(p3, 'nothing_landed'), lease: h4.facts, closedBy: 'u_s62' }, { holderWithin: h4.holderWithin, auditWithin: auditOk })
      expect([kept.changePlan.cell, kept.transparent]).toEqual(['P3', false])
      expect([await pendingPlanStop(u4), await subjectStop(u4)]).toEqual([1, 1])

      // (5) a recovery-written plan (P5 runbook close): RW counted by its own column and as a pending (written) plan.
      const u5 = scopeOf('u07_rw')
      await stateRow(u5)
      await plan(u5, `chp_cp_${u5.sheetId}`, 'confirmed', [['rec_1', 'k1', { rawQuantity: [1, 2] }]])
      const p5 = await store.beginExecution(beginInput(u5, { refreshBinding: { continuations: [], changePlanId: `chp_cp_${u5.sheetId}` } }))
      await q(`UPDATE ${RT.execution} SET status = 'partial', finished_at = now(), written = 1, attempted_writes = 1 WHERE id = $1`, [p5.id])
      const h5 = await lease(u5)
      const runbook = await store.closeExecution({ ...u5, executionId: p5.id, mode: 'runbook', runbookRef: `TICKET-${TOKEN}`, classification: { ...classification(p5, 'unknown'), counts: {} }, lease: h5.facts, closedBy: 'u_s62_admin' }, { holderWithin: h5.holderWithin, auditWithin: auditOk })
      expect(runbook.changePlan.cell).toBe('P5')
      expect([await recoveredPlanStop(u5), await pendingPlanStop(u5), await subjectStop(u5)]).toEqual([1, 1, 1])
      const rb = (await q(`SELECT closed_mode, verified_result, runbook_ref FROM ${RT.execution} WHERE id = $1`, [p5.id])).rows[0]
      expect(rb).toEqual({ closed_mode: 'runbook', verified_result: 'unknown', runbook_ref: `TICKET-${TOKEN}` })
      expect(audits.every((event) => typeof event.operation === 'string' && !JSON.stringify(event).includes(TENANT))).toBe(true)
    }, 120000)
  })
}
