/**
 * Batch-refresh step 6a-1 (S6-1; register row R-91) — real-Postgres proof of migration 106 and the store's EXECUTION
 * INTENT JOURNAL, SELF-VERIFYING FINISH and SETTLEMENT SUBJECT read, through the REAL scoped db helper
 * (plugins/plugin-integration-core/lib/db.cjs) and the REAL continuation store / refresh-state derivation.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationExecutionIntentRealDbCases()` registers its `describe`
 * block and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases run in the existing "Run
 * multitable real-DB integration" step of .github/workflows/plugin-tests.yml (aggregated into the required
 * `test (20.x)`) without a workflow edit. Do NOT also list it as a standalone file in that step.
 *
 * The hermetic suite (plugins/plugin-integration-core/__tests__/stock-preparation-execution-intent.test.cjs) drives the
 * store against a FAKE; here the SQL itself answers:
 *   S9R-106  migration 106 applied: the eleven execution columns, settlement_subject NOT NULL DEFAULT true, the intent
 *            table, change_plan.recovered_from_change_plan_id; every new CHECK refuses its wrong shape with 23514 under
 *            its own name; the chunk UNIQUE is 23505; the legacy backfill re-runs the file over a legacy close (constraints
 *            dropped in a rolled-back transaction) and every constraint VALIDATES.
 *   S9R-03   begin atomicity: the execution INSERT and the chunk INSERTs are ONE transaction — chunk 2 of 3 fails => no
 *            execution row and no chunk remain (503 intent_insert).
 *   S9R-02   a 10 000-decision begin: five chunks, Σ entry_count = 10 000, the JSONB read back re-admits against the row's
 *            own digest; the begin's latency is measured (values-free log line).
 *   S9R-01   the PR-8 wedge W2 on an UNBOUND run at the store: a decision-0 stop (aborted, 0 written, 0 attempted) closes
 *            verified_closed / nothing_landed / self_verified, transparent — PostgreSQL's CHECKs accept the shape, and the
 *            consult over the real store derives the project as before the attempt (never 失败待恢复). The plan-bound twin
 *            (S9R-01b) runs through the routes in the write-lock cases (S8-04c, re-pinned).
 *   S9R-30   the subject window: one verified_closed / landed subject, then six transparent closes — the consult still
 *            carries the subject (the settlement-subject read), the derivation answers executed_pending_settlement and the
 *            formal surface refuses; settled naming it => complete and allowed.
 * Values-free: every id is synthetic and per-run.
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
const stateLib = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-state.cjs')) as any
const fs = require('node:fs') as typeof import('node:fs')

const { REFRESH_STORE_TABLES: RT, REFRESH_STORE_ERROR_CODES: CODES, createStockPreparationContinuationStore } = storeLib
const { buildExecutionIntent, assertExecutionIntent } = intentLib
const { readProjectRefreshState, formalSurfaceVerdict } = stateLib

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

type StatementEvent = { sql: string; inTransaction: boolean }
// The scoped db over the HOST's plugin database binding shape (autocommit `query`, `transaction` on its own client), with
// an optional `hook` awaited before every statement (a thrown hook fails that statement).
function hostLikeDb(hook: (event: StatementEvent) => Promise<void> | void = () => {}) {
  return createDb({
    database: {
      query: async (sql: string, params?: unknown[]) => {
        await hook({ sql, inTransaction: false })
        return (await q(sql, params)).rows
      },
      transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        const client = await poolManager.get().getInternalPool().connect()
        try {
          await client.query('BEGIN')
          const result = await callback({
            query: async (sql: string, params?: unknown[]) => {
              await hook({ sql, inTransaction: true })
              return (await client.query(sql, params)).rows
            },
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

async function expectSqlState(promise: Promise<unknown>, code: string, constraint?: string) {
  let thrown: any = null
  try { await promise } catch (error) { thrown = error }
  expect(thrown, `expected SQLSTATE ${code}${constraint ? ` (${constraint})` : ''}`).not.toBeNull()
  expect(thrown.code).toBe(code)
  if (constraint) expect(thrown.constraint).toBe(constraint)
}

const EXEC_CHECK = (name: string) => `integration_stock_prep_refresh_execution_${name}_check`

export function defineStockPreparationExecutionIntentRealDbCases(): void {
  test('execution intent real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1') return
    if (!process.env.DATABASE_URL) throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the S6-1 cases would skip-green')
  })

  describeIfDatabase('batch-refresh step 6a-1 (S6-1): migration 106, the intent journal, the self-verifying finish, the settlement subject (real Postgres)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const TENANT = `tenant_s61_${TOKEN}`
    const PLAN_DIGEST = 'a'.repeat(64)
    const GUARD = { leaseRunId: `run_s61_${TOKEN}`, leaseId: `lease_s61_${TOKEN}`, fencingEpoch: 1, generation: 1, generationToken: `g_s61_${TOKEN}` }
    const FREE_LOCK = { state: { present: true, leaseHeld: false, leaseLive: false }, generation: { generationToken: 'g_free', fencingEpoch: 1, leaseId: null } }
    const scopeOf = (name: string) => ({ tenantId: TENANT, sheetId: `sheet_s61_${TOKEN}_${name}`, projectNo: `P-S61-${name}` })
    const storeOn = (db: any = hostLikeDb()) => createStockPreparationContinuationStore({ db })
    const emptyIntent = () => buildExecutionIntent({ plan: { decisions: [] }, planDigest: PLAN_DIGEST })
    const beginInput = (scope: any, extra: Record<string, unknown> = {}) => ({
      ...scope, lane: 'small_apply', guard: GUARD, tokenRevision: 'rev_s61', planDigest: PLAN_DIGEST, plannedCounts: {}, refreshBinding: { continuations: [] }, startedBy: 'u_s61', intent: emptyIntent(), ...extra,
    })
    const addDecisions = (n: number) => Array.from({ length: n }, (_, index) => ({ decision: 'add', idempotencyKey: `{"k":"s61-${index}"}`, record: { idempotencyKey: `{"k":"s61-${index}"}`, componentCode: `C-${index}`, rawQuantity: index } }))
    const consultOf = async (store: any, scope: any) => {
      const rows = await store.readGovernanceRows(scope)
      return {
        ok: true, pilot: { enabled: true }, continuations: rows.continuations, holds: rows.holds,
        state: rows.states.find((row: any) => row.sheetId === scope.sheetId && row.projectNo === scope.projectNo) || null,
        executions: rows.executions, changePlans: rows.changePlans, lock: FREE_LOCK,
      }
    }

    afterAll(async () => {
      await q(`DELETE FROM ${RT.intent} WHERE tenant_id = $1`, [TENANT])
      await q(`DELETE FROM ${RT.execution} WHERE tenant_id = $1`, [TENANT])
      await q(`DELETE FROM ${RT.state} WHERE tenant_id = $1`, [TENANT])
    })

    test('S9R-106 migration 106: the columns, the default, the intent table, every new CHECK (23514 by name), the chunk UNIQUE (23505), and the legacy backfill re-runs over a legacy close with every constraint validated', async () => {
      const columns = (await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [RT.execution])).rows
      const byName = new Map(columns.map((row: any) => [row.column_name, row]))
      for (const [name, type] of [['intent_version', 'integer'], ['intent_digest', 'text'], ['intent_entry_count', 'integer'], ['pull_batch_source_digest', 'text'], ['pre_close_status', 'text'], ['closed_mode', 'text'], ['verify_summary', 'jsonb'], ['verify_lease_run_id', 'text'], ['verify_fencing_epoch', 'integer'], ['runbook_ref', 'text'], ['settlement_subject', 'boolean']]) {
        expect((byName.get(name) as any)?.data_type, name).toBe(type)
      }
      expect((byName.get('settlement_subject') as any).is_nullable).toBe('NO')
      expect(String((byName.get('settlement_subject') as any).column_default)).toBe('true')
      const intentTable = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY 1`, [RT.intent])).rows.map((row: any) => row.column_name)
      expect(intentTable).toEqual(['chunk_index', 'created_at', 'entries', 'entry_count', 'execution_id', 'fieldsets', 'id', 'project_no', 'sheet_id', 'tenant_id', 'write_scope_key'])
      const recovered = (await q(`SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'recovered_from_change_plan_id'`, [RT.changePlan])).rows
      expect(recovered.map((row: any) => row.data_type)).toEqual(['text'])

      const scope = scopeOf('shape')
      const store = storeOn()
      const execution = await store.beginExecution(beginInput(scope))
      const row0 = (await q(`SELECT settlement_subject, intent_version, intent_entry_count FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0]
      expect(row0).toEqual({ settlement_subject: true, intent_version: 1, intent_entry_count: 0 })
      // PostgreSQL reports the first failing CHECK in name order, so each bad row fails exactly ONE constraint.
      const closed = `status = 'verified_closed', verified_at = now(), finished_at = now()`
      const bad: Array<[string, string]> = [
        [EXEC_CHECK('intent_shape'), 'intent_digest = NULL'],
        [EXEC_CHECK('batch_digest'), `pull_batch_source_digest = 'small:${'a'.repeat(32)}'`],
        [EXEC_CHECK('pre_close_status'), `${closed}, verified_result = 'landed', closed_mode = 'puller_verified', pre_close_status = 'nope'`],
        [EXEC_CHECK('closed_mode'), `${closed}, verified_result = 'landed', closed_mode = 'nope', pre_close_status = 'running'`],
        [EXEC_CHECK('close_shape'), `${closed}, verified_result = 'landed'`],
        [EXEC_CHECK('runbook_shape'), `${closed}, verified_result = 'landed', closed_mode = 'runbook', pre_close_status = 'running', runbook_ref = 'rb-1'`],
        [EXEC_CHECK('self_verified'), `${closed}, verified_result = 'nothing_landed', closed_mode = 'self_verified', pre_close_status = 'aborted', written = 1, attempted_writes = 1`],
        [EXEC_CHECK('subject'), 'settlement_subject = false'],
      ]
      for (const [constraint, set] of bad) {
        await expectSqlState(q(`UPDATE ${RT.execution} SET ${set} WHERE id = $1`, [execution.id]), '23514', constraint)
      }
      const chunk = (index: number, count: number) => q(
        `INSERT INTO ${RT.intent} (id, execution_id, chunk_index, tenant_id, sheet_id, project_no, write_scope_key, entry_count, entries, fieldsets) VALUES ($1, $2, $3, $4, $5, $6, 'k', $7, '[]'::jsonb, '[]'::jsonb)`,
        [`${execution.id}:x${index}:${count}`, execution.id, index, TENANT, scope.sheetId, scope.projectNo, count],
      )
      await expectSqlState(chunk(0, 2001), '23514', 'integration_stock_prep_refresh_execution_intent_chunk_check')
      await expectSqlState(chunk(-1, 1), '23514', 'integration_stock_prep_refresh_execution_intent_chunk_check')
      await chunk(7, 1)
      await expectSqlState(chunk(7, 2), '23505', 'integration_stock_prep_refresh_execution_intent_chunk_unique')

      // The legacy backfill (design §7.2 / OQ-14): a runbook-closed row from before 106 has no close shape. Re-run the whole
      // file inside ONE transaction that first drops the close-shape constraints and plants such a row: the backfill gives
      // it the legacy shape and every ADD CONSTRAINT validates. Rolled back — nothing persists.
      const client = await poolManager.get().getInternalPool().connect()
      try {
        await client.query('BEGIN')
        for (const name of ['close_shape', 'runbook_shape', 'self_verified', 'subject']) await client.query(`ALTER TABLE ${RT.execution} DROP CONSTRAINT ${EXEC_CHECK(name)}`)
        await client.query(`UPDATE ${RT.execution} SET status = 'verified_closed', verified_at = now(), finished_at = now(), verified_result = NULL WHERE id = $1`, [execution.id])
        await client.query(fs.readFileSync(MIGRATION_106, 'utf8'))
        const legacy = (await client.query(`SELECT closed_mode, pre_close_status, verified_result, settlement_subject FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0]
        expect(legacy).toEqual({ closed_mode: 'legacy_runbook', pre_close_status: 'unrecorded', verified_result: 'unknown', settlement_subject: true })
        const validated = (await client.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = $1::regclass AND conname LIKE 'integration_stock_prep_refresh_execution_%_check' ORDER BY 1`, [RT.execution])).rows
        expect(validated.every((entry: any) => entry.convalidated === true)).toBe(true)
        expect(validated.map((entry: any) => entry.conname)).toEqual(expect.arrayContaining(['close_shape', 'runbook_shape', 'self_verified', 'subject', 'intent_shape', 'batch_digest'].map(EXEC_CHECK)))
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
      expect((await q(`SELECT status FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0].status).toBe('running')
    }, 120000)

    test('S9R-03 begin atomicity: the execution INSERT and every chunk INSERT are ONE transaction — chunk 2 of 3 fails => no execution row and no chunk remain (503 intent_insert)', async () => {
      const scope = scopeOf('atomic')
      let chunkInserts = 0
      const store = storeOn(hostLikeDb(({ sql, inTransaction }) => {
        if (inTransaction && /^\s*INSERT INTO "?integration_stock_prep_refresh_execution_intent"?/i.test(sql)) {
          chunkInserts += 1
          if (chunkInserts === 2) throw Object.assign(new Error('synthetic chunk failure'), { code: '57014' })
        }
      }))
      const intent = buildExecutionIntent({ plan: { decisions: addDecisions(4100) }, planDigest: PLAN_DIGEST })
      expect(intent.chunks.length).toBe(3)
      let thrown: any = null
      try { await store.beginExecution(beginInput(scope, { intent })) } catch (error) { thrown = error }
      expect([thrown && thrown.status, thrown && thrown.code, thrown && thrown.details && thrown.details.operation]).toEqual([503, CODES.STORE_FAILED, 'intent_insert'])
      expect(chunkInserts).toBe(2)
      expect(Number((await q(`SELECT count(*)::int AS n FROM ${RT.execution} WHERE tenant_id = $1 AND sheet_id = $2`, [TENANT, scope.sheetId])).rows[0].n)).toBe(0)
      expect(Number((await q(`SELECT count(*)::int AS n FROM ${RT.intent} WHERE tenant_id = $1 AND sheet_id = $2`, [TENANT, scope.sheetId])).rows[0].n)).toBe(0)
    }, 120000)

    test('S9R-02 a 10 000-decision begin: five chunks, Σ entry_count = 10 000, the JSONB read back re-admits against the row\'s own digest; latency measured', async () => {
      const scope = scopeOf('big')
      const intent = buildExecutionIntent({ plan: { decisions: addDecisions(10000) }, planDigest: PLAN_DIGEST })
      const started = Date.now()
      const execution = await storeOn().beginExecution(beginInput(scope, { intent }))
      const elapsedMs = Date.now() - started
      console.log(`[S9R-02] ${JSON.stringify({ decisions: 10000, chunks: intent.chunks.length, beginMs: elapsedMs })}`)
      const row = (await q(`SELECT intent_version, intent_digest, intent_entry_count, plan_digest FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0]
      const chunks = (await q(`SELECT chunk_index, entry_count, entries, fieldsets FROM ${RT.intent} WHERE execution_id = $1 ORDER BY chunk_index`, [execution.id])).rows
      expect(chunks.map((chunk: any) => [chunk.chunk_index, chunk.entry_count])).toEqual([[0, 2000], [1, 2000], [2, 2000], [3, 2000], [4, 2000]])
      expect(row.intent_entry_count).toBe(10000)
      expect(() => assertExecutionIntent({
        version: row.intent_version, digest: row.intent_digest, entryCount: row.intent_entry_count,
        chunks: chunks.map((chunk: any) => ({ chunkIndex: chunk.chunk_index, entryCount: chunk.entry_count, entries: chunk.entries, fieldsets: chunk.fieldsets })),
      }, { planDigest: row.plan_digest })).not.toThrow()
      expect(elapsedMs).toBeLessThan(30000)
    }, 120000)

    test('S9R-01 the PR-8 wedge W2 on an UNBOUND run: a decision-0 stop (aborted, 0 / 0) closes verified_closed / nothing_landed / self_verified, transparent — PostgreSQL accepts the shape and the project derives as before the attempt (never 失败待恢复)', async () => {
      const scope = scopeOf('w2')
      const store = storeOn()
      const intent = buildExecutionIntent({ plan: { decisions: addDecisions(3) }, planDigest: PLAN_DIGEST })
      const execution = await store.beginExecution(beginInput(scope, { intent }))
      const done = await store.finishExecution({ ...scope, executionId: execution.id, status: 'aborted', written: 0, attemptedWrites: 0, abortCode: 'STOCK_PREP_CHANGE_PLAN_STALE', errorCodes: [] })
      expect(done.selfVerified).toBe(true)
      const row = (await q(`SELECT status, verified_result, closed_mode, pre_close_status, settlement_subject, verified_by, verify_summary, written, attempted_writes FROM ${RT.execution} WHERE id = $1`, [execution.id])).rows[0]
      expect(row).toEqual({ status: 'verified_closed', verified_result: 'nothing_landed', closed_mode: 'self_verified', pre_close_status: 'aborted', settlement_subject: false, verified_by: null, verify_summary: { selfVerified: true, finishStatus: 'aborted', intendedEntries: 3 }, written: 0, attempted_writes: 0 })
      const derived = readProjectRefreshState(await consultOf(store, scope))
      expect(derived.status).not.toBe('failed_pending_recovery')
      expect(derived.status).toBe('complete')
      // The unprovable twin stays failed (attempted 1): 失败待恢复.
      const twin = scopeOf('w2_twin')
      const failing = await store.beginExecution(beginInput(twin))
      await store.finishExecution({ ...twin, executionId: failing.id, status: 'aborted', written: 0, attemptedWrites: 1 })
      expect(readProjectRefreshState(await consultOf(store, twin)).status).toBe('failed_pending_recovery')
    }, 120000)

    test('S9R-30 the subject window: one verified_closed / landed subject, then six transparent closes — the consult still carries the subject, the derivation answers executed_pending_settlement and the formal surface refuses; settled naming it => complete and allowed', async () => {
      const scope = scopeOf('window')
      const store = storeOn()
      const subject = await store.beginExecution(beginInput(scope))
      // The subject closed as step 6a-2's puller close will write it (its shape is the CHECKs'; S6-2 writes it for real).
      await q(`UPDATE ${RT.execution} SET status = 'verified_closed', verified_result = 'landed', verified_at = now(), verified_by = 'u_s61', finished_at = now(), closed_mode = 'puller_verified', pre_close_status = 'running' WHERE id = $1`, [subject.id])
      for (let index = 0; index < 6; index += 1) {
        const run = await store.beginExecution(beginInput(scope))
        await store.finishExecution({ ...scope, executionId: run.id, status: index % 2 ? 'failed' : 'aborted', written: 0, attemptedWrites: 0 })
      }
      const transparent = Number((await q(`SELECT count(*)::int AS n FROM ${RT.execution} WHERE tenant_id = $1 AND sheet_id = $2 AND NOT settlement_subject`, [TENANT, scope.sheetId])).rows[0].n)
      expect(transparent).toBe(6)
      const consult = await consultOf(store, scope)
      expect(consult.executions.some((entry: any) => entry.id === subject.id)).toBe(true)
      expect(stateLib.newestSettlementSubject(consult.executions).id).toBe(subject.id)
      const derived = readProjectRefreshState(consult)
      expect(derived.status).toBe('executed_pending_settlement')
      expect(formalSurfaceVerdict(derived)).toEqual({ allowed: false, reason: 'state' })
      const settled = readProjectRefreshState({ ...consult, state: { settledAt: new Date().toISOString(), settledExecutionId: subject.id, settledSheetMachineDigest: 'd' } })
      expect([settled.status, formalSurfaceVerdict(settled).allowed]).toEqual(['complete', true])
    }, 120000)
  })
}
