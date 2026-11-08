/**
 * 批次标识 BI-1a (register R-65; batch-identifier design §3.3, §3.5, §8.2, §13.2; coordinator rulings C2 / C7) —
 * real-Postgres proof of the pull-batch LEDGER: migration 105 and the store
 * (plugins/plugin-integration-core/lib/stock-preparation-pull-batch-store.cjs) through the REAL scoped db helper
 * (lib/db.cjs). R line (R83 on onprem-r82): the sheet write lock is not on this line, so main's holder-assert case
 * BI-R14 (a zombie allocate after a lease takeover, LEASE_LOST) is not here; the store's `holderWithin` hook stays
 * unused on this line (the lanes pass none). Every other case is main's.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationPullBatchRealDbCases()` registers its `describe`
 * block and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases run in the existing "Run
 * multitable real-DB integration" step of .github/workflows/plugin-tests.yml (aggregated into the required
 * `test (20.x)`) without a workflow edit. Do NOT also list it as a standalone file in that step.
 *
 * The hermetic suites (plugins/plugin-integration-core/__tests__/stock-preparation-pull-batch-*.test.cjs) drive the
 * store against a FAKE that refuses overlapping transactions; every interleaving lives here:
 *   BI-R0   migration 105 applied: the four tables, INTEGER (int4) counters, every closed CHECK refuses an
 *           out-of-vocabulary token with 23514 under its own constraint name (the removed 'off' / 'date' /
 *           'position' / 'promote_fill' included), `installing` / `backfilled` without `settings_locked_at` is 23514,
 *           a second open batch and a second non-void batch with one number are 23505, a void number is reusable.
 *   BI-R4   two sessions allocate for one sheet at the same moment (×10): exactly one open batch every time; the
 *           same digest joins it; a different digest voids-and-reuses only when no row carries the label, else
 *           closes it superseded — never two open batches, never a 503.
 *   BI-R15  settings: two tenant writers with the same expectedVersion (absent row and present row) => exactly one
 *           wins, the other 409 SETTINGS_VERSION_CONFLICT; a per-sheet edit racing the FIRST allocation, both
 *           orders (frozen inside its transaction) => whichever commits second fails cleanly (409 CONFIG_LOCKED or
 *           409 CONFLICT settings_changed), never both succeed.
 *   BI-R16  (ruling C7) abort of a first install on real rows: no plan label and no live batch => pending with the
 *           lock cleared; a plan label on the sheet => the lock stays; the CHECK itself refuses an `installing` row
 *           that loses its lock.
 * Values-free: every id is synthetic and per-run; the project numbers are the synthetic S-01 / P-07.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const storeLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch-store.cjs')) as any
const pureLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch.cjs')) as any

const { createStockPreparationPullBatchStore, PULL_BATCH_TABLES, SETTINGS_VERSION_CONFLICT_CODE } = storeLib
const { PULL_BATCH_ERROR_CODES } = pureLib

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

type StatementEvent = { sql: string; inTransaction: boolean }
// The scoped db over the HOST's plugin database binding shape (src/index.ts `database`: `query` on a pooled
// connection in autocommit, `transaction` on its OWN client), with an optional `hook` awaited before every statement
// — used to FREEZE a session inside its transaction at a chosen statement.
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 15000) {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// A backend of THIS database waiting on a row lock of the given table (the second session queued behind the first).
async function someoneWaitsOn(table: string): Promise<boolean> {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND query LIKE $1`,
    [`%${table}%`],
  )
  return rows[0].n > 0
}

// PostgreSQL tests a row's CHECK constraints in alphabetical order of their names and reports the first that fails, so
// every bad row below is shaped to fail exactly ONE constraint (or names the set it may fail).
async function expectSqlState(promise: Promise<unknown>, code: string, constraint?: string | string[]) {
  let thrown: any = null
  try { await promise } catch (error) { thrown = error }
  expect(thrown, `expected SQLSTATE ${code}${constraint ? ` (${String(constraint)})` : ''}`).not.toBeNull()
  expect(thrown.code).toBe(code)
  if (Array.isArray(constraint)) expect(constraint).toContain(thrown.constraint)
  else if (constraint) expect(thrown.constraint).toBe(constraint)
}

export function defineStockPreparationPullBatchRealDbCases(): void {
  test('pull-batch ledger real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1') return
    if (!process.env.DATABASE_URL) throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the BI-1a ledger cases would skip-green')
  })

  describeIfDatabase('批次标识 BI-1a: migration 105 and the pull-batch ledger store (real Postgres)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const TENANT = `tenant_bi1a_${TOKEN}`
    const sheetIds: string[] = []
    const sheetOf = (name: string) => {
      const id = `sheet_bi1a_${TOKEN}_${name}`
      sheetIds.push(id)
      return id
    }
    const D1 = 'a'.repeat(32)
    const D2 = 'b'.repeat(32)
    const C = (suffix: string) => `integration_stock_prep_pull_batch_${suffix}`

    const storeOn = (db: any = hostLikeDb()) => createStockPreparationPullBatchStore({ db })
    async function seedSheet(sheetId: string, { status = 'born_empty', rule = 'material', labelFormat = 'ordinal_date', locale = 'zh-CN', lockedAt = null as string | null, plan = null as unknown, projectNo = 'P-07' } = {}) {
      const resolved = status === 'born_empty' || status === 'backfilled'
      await q(
        `INSERT INTO ${PULL_BATCH_TABLES.sheet}
          (id, tenant_id, sheet_id, project_no, history_status, label_locale, first_pull_batch_rule, label_format,
           settings_locked_at, history_mode, history_batch_count, history_plan, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
        [`pbs_${sheetId}_${projectNo}`, TENANT, sheetId, projectNo, status, locale, rule, labelFormat, lockedAt,
          resolved ? 'inferred' : null, resolved ? 0 : null, plan === null ? null : JSON.stringify(plan), resolved ? new Date().toISOString() : null],
      )
    }
    const allocInput = (sheetId: string, extra: Record<string, unknown> = {}) => ({
      tenantId: TENANT,
      sheetId,
      projectNo: 'P-07',
      executionRef: `small:${sheetId}_run_1`,
      lane: 'small_apply',
      sourceDigest: D1,
      labelsOnSheet: new Set<string>(),
      voidReuse: 'in_lease',
      expectedRule: 'material',
      ...extra,
    })

    afterAll(async () => {
      if (sheetIds.length > 0) {
        await q(`DELETE FROM ${PULL_BATCH_TABLES.execution} WHERE sheet_id = ANY($1::text[])`, [sheetIds])
        await q(`DELETE FROM ${PULL_BATCH_TABLES.batch} WHERE sheet_id = ANY($1::text[])`, [sheetIds])
        await q(`DELETE FROM ${PULL_BATCH_TABLES.sheet} WHERE sheet_id = ANY($1::text[])`, [sheetIds])
      }
      await q(`DELETE FROM ${PULL_BATCH_TABLES.settings} WHERE tenant_id LIKE $1`, [`${TENANT}%`])
    })

    test('BI-R0 migration 105: four tables, INTEGER counters, every closed CHECK refuses an out-of-vocabulary token (23514), the lock CHECK, the partial unique indexes (23505)', async () => {
      const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'integration_stock_prep_pull_batch%' ORDER BY 1`)).rows.map((row: any) => row.table_name)
      expect(tables).toEqual([...Object.values(PULL_BATCH_TABLES)].sort())
      const ints = (await q(`SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name LIKE 'integration_stock_prep_pull_batch%' AND column_name IN ('version', 'batch_no', 'history_batch_count', 'created_row_count')`)).rows
      expect(ints.length).toBe(5)
      for (const row of ints) expect(row.data_type).toBe('integer')

      // The tenant settings table: each removed / misspelt token is refused under its own constraint.
      const tenantRow = (over: Record<string, unknown>) => {
        const row = { tenant_id: `${TENANT}_r0_${Object.keys(over).join('_')}_${Math.random().toString(36).slice(2, 8)}`, first_pull_batch_rule: 'material', label_format: 'ordinal_date', landing_mode: 'promote_prep_fill', band_placement: 'left', ...over }
        const cols = Object.keys(row)
        return q(`INSERT INTO ${PULL_BATCH_TABLES.settings} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row))
      }
      await tenantRow({})
      for (const [over, constraint] of [
        [{ first_pull_batch_rule: 'off' }, C('settings_rule_check')],
        [{ first_pull_batch_rule: 'position' }, C('settings_rule_check')],
        [{ first_pull_batch_rule: 'Material' }, C('settings_rule_check')],
        [{ label_format: 'date' }, C('settings_format_check')],
        [{ landing_mode: 'promote_fill' }, C('settings_landing_check')],
        [{ band_placement: 'middle' }, C('settings_placement_check')],
        [{ version: -1 }, C('settings_version_check')],
      ] as Array<[Record<string, unknown>, string]>) {
        await expectSqlState(tenantRow(over), '23514', constraint)
      }

      // The _sheet table.
      const sheetId = sheetOf('r0')
      const sheetRow = (over: Record<string, unknown>, projectNo: string) => {
        const row = { id: `pbs_r0_${projectNo}`, tenant_id: TENANT, sheet_id: sheetId, project_no: projectNo, history_status: 'pending', label_locale: 'zh-CN', first_pull_batch_rule: 'material', label_format: 'ordinal_date', ...over }
        const cols = Object.keys(row)
        return q(`INSERT INTO ${PULL_BATCH_TABLES.sheet} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row))
      }
      let n = 0
      for (const [over, constraint] of [
        [{ first_pull_batch_rule: 'off' }, C('sheet_rule_check')],
        [{ label_format: 'date' }, C('sheet_format_check')],
        [{ landing_mode: 'promote_fill' }, C('sheet_landing_check')],
        [{ band_placement: 'center' }, C('sheet_placement_check')],
        [{ label_locale: 'zh' }, C('sheet_locale_check')],
        [{ history_status: 'resolved' }, [C('sheet_status_check'), C('sheet_resolved_check')]],
        [{ history_status: 'installing' }, C('sheet_lock_check')],
        [{ history_status: 'backfilled', resolved_at: new Date().toISOString(), history_batch_count: 1, history_mode: 'inferred' }, C('sheet_lock_check')],
        [{ history_mode: 'guessed' }, C('sheet_mode_check')],
        [{ version: -1 }, C('sheet_version_check')],
      ] as Array<[Record<string, unknown>, string | string[]]>) {
        n += 1
        await expectSqlState(sheetRow(over, `S-01-${n}`), '23514', constraint)
      }
      await sheetRow({ history_status: 'installing', settings_locked_at: new Date().toISOString() }, 'S-01-ok')
      await sheetRow({}, 'S-01-pending')
      await expectSqlState(sheetRow({ id: 'pbs_r0_dup' }, 'S-01-pending'), '23505', 'uniq_integration_stock_prep_pull_batch_sheet')

      // The batch table: vocabulary CHECKs and the two partial unique indexes.
      const batchRow = (over: Record<string, unknown>) => {
        const row = { id: `pbat_r0_${Math.random().toString(36).slice(2, 10)}`, tenant_id: TENANT, sheet_id: sheetId, project_no: 'S-01-pending', batch_no: 1, origin: 'live', status: 'open', label: '第1批', display_day: '2026-11-07', source_digest: D1, ...over }
        const cols = Object.keys(row)
        return q(`INSERT INTO ${PULL_BATCH_TABLES.batch} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row))
      }
      await expectSqlState(batchRow({ status: 'closed', closed_at: new Date().toISOString(), closed_reason: 'because' }), '23514', C('closed_reason_check'))
      await expectSqlState(batchRow({ status: 'pending', closed_at: new Date().toISOString() }), '23514', C('status_check'))
      await expectSqlState(batchRow({ origin: 'guess', status: 'closed', closed_at: new Date().toISOString(), source_digest: null }), '23514', C('origin_check'))
      await batchRow({ id: 'pbat_r0_open1' })
      await expectSqlState(batchRow({ batch_no: 2 }), '23505', 'uniq_integration_stock_prep_pull_batch_open')
      await q(`UPDATE ${PULL_BATCH_TABLES.batch} SET status = 'void', closed_at = now(), closed_reason = 'void_no_rows' WHERE id = 'pbat_r0_open1'`)
      await batchRow({ id: 'pbat_r0_open1b' }) // a void number is reusable
      await q(`UPDATE ${PULL_BATCH_TABLES.batch} SET status = 'closed', closed_at = now(), closed_reason = 'execution_succeeded' WHERE id = 'pbat_r0_open1b'`)
      await expectSqlState(batchRow({ status: 'closed', closed_at: new Date().toISOString(), closed_reason: 'backfill' }), '23505', 'uniq_integration_stock_prep_pull_batch_no')

      // The execution link.
      const linkRow = (over: Record<string, unknown>) => {
        const row = { id: `pbx_r0_${Math.random().toString(36).slice(2, 10)}`, batch_id: 'pbat_r0_open1b', tenant_id: TENANT, sheet_id: sheetId, project_no: 'S-01-pending', execution_ref: `small:r0_${Math.random().toString(36).slice(2, 10)}`, lane: 'small_apply', ...over }
        const cols = Object.keys(row)
        return q(`INSERT INTO ${PULL_BATCH_TABLES.execution} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row))
      }
      await expectSqlState(linkRow({ lane: 'medium_apply' }), '23514', C('execution_lane_check'))
      await expectSqlState(linkRow({ writer_status: 'done' }), '23514', C('execution_writer_status_check'))
      await expectSqlState(linkRow({ verified_outcome: 'verified_maybe' }), '23514', C('execution_outcome_check'))
      await linkRow({ execution_ref: 'small:r0_fixed' })
      await expectSqlState(linkRow({ execution_ref: 'small:r0_fixed' }), '23505', 'uniq_integration_stock_prep_pull_batch_execution_ref')
    })

    test('BI-R4 two sessions allocate for one sheet at the same moment (×10 per shape): exactly one open batch; same digest joins, a different digest void-reuses or supersedes; never 503', async () => {
      for (let round = 0; round < 10; round += 1) {
        for (const shape of ['same_digest', 'void_reuse', 'supersede'] as const) {
          const sheetId = sheetOf(`r4_${shape}_${round}`)
          await seedSheet(sheetId)
          const labelOne = pureLib.formatPullBatchLabel({ kind: 'live', n: 1, day: pureLib.pullBatchLabelDay(new Date()), locale: 'zh-CN', labelFormat: 'ordinal_date' })
          const second = shape === 'same_digest'
            ? { executionRef: `small:${sheetId}_run_2` }
            : { executionRef: `small:${sheetId}_run_2`, sourceDigest: D2, labelsOnSheet: new Set(shape === 'supersede' ? [labelOne] : []) }
          const results = await Promise.allSettled([
            storeOn().allocate(allocInput(sheetId)),
            storeOn().allocate(allocInput(sheetId, second)),
          ])
          for (const result of results) {
            if (result.status === 'rejected') expect((result.reason as any).code, `${shape} round ${round}: a loser is a typed 409, never a 503`).toBe(PULL_BATCH_ERROR_CODES.CONFLICT)
          }
          const rows = (await q(`SELECT batch_no, status, closed_reason, source_digest FROM ${PULL_BATCH_TABLES.batch} WHERE sheet_id = $1 ORDER BY batch_no, status`, [sheetId])).rows
          const open = rows.filter((row: any) => row.status === 'open')
          expect(open.length, `${shape} round ${round}: exactly one open batch`).toBe(1)
          if (shape === 'same_digest') {
            expect(rows.length).toBe(1)
            const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<any>>
            expect(new Set(fulfilled.map((r) => r.value.batchId)).size).toBe(1)
          }
          const sheet = (await q(`SELECT settings_locked_at FROM ${PULL_BATCH_TABLES.sheet} WHERE sheet_id = $1`, [sheetId])).rows[0]
          expect(sheet.settings_locked_at, 'the first allocation locked the settings').not.toBeNull()
        }
      }
    })

    test('BI-R15 settings: same-version tenant writers => one wins, one 409; a per-sheet edit racing the first allocation (both orders) => whichever commits second fails cleanly', async () => {
      // Two tenant writers, absent row (the INSERT race) and present row (the FOR UPDATE CAS).
      for (const present of [false, true]) {
        const tenantId = `${TENANT}_r15_${present ? 'present' : 'absent'}`
        let expectedVersion = 0
        if (present) expectedVersion = (await storeOn().writeTenantSettings({ tenantId, expectedVersion: 0, patch: { placement: 'right' } })).version
        const results = await Promise.allSettled([
          storeOn().writeTenantSettings({ tenantId, expectedVersion, patch: { labelFormat: 'ordinal' } }),
          storeOn().writeTenantSettings({ tenantId, expectedVersion, patch: { landing: 'keep_current' } }),
        ])
        const won = results.filter((r) => r.status === 'fulfilled')
        const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
        expect(won.length, `present=${present}: exactly one writer wins`).toBe(1)
        expect(lost.length).toBe(1)
        expect(lost[0].reason.code).toBe(SETTINGS_VERSION_CONFLICT_CODE)
        expect(lost[0].reason.status).toBe(409)
        const row = (await q(`SELECT version FROM ${PULL_BATCH_TABLES.settings} WHERE tenant_id = $1`, [tenantId])).rows[0]
        expect(row.version).toBe(expectedVersion + 1)
      }

      // Order 1: the allocation holds the _sheet row (frozen after its FOR UPDATE); the edit queues; the allocation
      // commits (locked); the edit then reads the LOCKED row => 409 CONFIG_LOCKED.
      {
        const sheetId = sheetOf('r15_alloc_first')
        await seedSheet(sheetId)
        const gate = deferred()
        const frozen = deferred()
        let froze = false
        const frozenDb = hostLikeDb(async ({ sql, inTransaction }) => {
          if (!froze && inTransaction && sql.includes(PULL_BATCH_TABLES.execution)) {
            froze = true
            frozen.resolve()
            await gate.promise
          }
        })
        const allocation = storeOn(frozenDb).allocate(allocInput(sheetId))
        await frozen.promise
        const edit = storeOn().setSheetSettings({ tenantId: TENANT, sheetId, projectNo: 'P-07', expectedVersion: 0, patch: { firstPullBatchRule: 'predecessor_suffix' } })
        const editSettled = edit.then(() => 'ok', (error: any) => error)
        await waitFor(() => someoneWaitsOn(PULL_BATCH_TABLES.sheet), 'the edit to queue on the _sheet row')
        gate.resolve()
        expect((await allocation).batchNo).toBe(1)
        const error = await editSettled
        expect(error).not.toBe('ok')
        expect(error.code).toBe(PULL_BATCH_ERROR_CODES.CONFIG_LOCKED)
        const row = (await q(`SELECT first_pull_batch_rule, settings_locked_at FROM ${PULL_BATCH_TABLES.sheet} WHERE sheet_id = $1`, [sheetId])).rows[0]
        expect(row.first_pull_batch_rule).toBe('material')
        expect(row.settings_locked_at).not.toBeNull()
      }

      // Order 2: the edit holds the _sheet row (frozen before its UPDATE); the allocation queues; the edit commits a new
      // rule; the allocation then reads it => 409 CONFLICT settings_changed, nothing written.
      {
        const sheetId = sheetOf('r15_edit_first')
        await seedSheet(sheetId)
        const gate = deferred()
        const frozen = deferred()
        let froze = false
        const frozenDb = hostLikeDb(async ({ sql, inTransaction }) => {
          if (!froze && inTransaction && /^UPDATE/.test(sql.trim()) && sql.includes(PULL_BATCH_TABLES.sheet)) {
            froze = true
            frozen.resolve()
            await gate.promise
          }
        })
        const edit = storeOn(frozenDb).setSheetSettings({ tenantId: TENANT, sheetId, projectNo: 'P-07', expectedVersion: 0, patch: { firstPullBatchRule: 'predecessor_suffix' } })
        await frozen.promise
        const allocation = storeOn().allocate(allocInput(sheetId)).then(() => 'ok', (error: any) => error)
        await waitFor(() => someoneWaitsOn(PULL_BATCH_TABLES.sheet), 'the allocation to queue on the _sheet row')
        gate.resolve()
        expect((await edit).captured.firstPullBatchRule).toBe('predecessor_suffix')
        const error = await allocation
        expect(error).not.toBe('ok')
        expect(error.code).toBe(PULL_BATCH_ERROR_CODES.CONFLICT)
        expect(error.details.reason).toBe('settings_changed')
        expect((await q(`SELECT count(*)::int AS n FROM ${PULL_BATCH_TABLES.batch} WHERE sheet_id = $1`, [sheetId])).rows[0].n).toBe(0)
        expect((await q(`SELECT settings_locked_at FROM ${PULL_BATCH_TABLES.sheet} WHERE sheet_id = $1`, [sheetId])).rows[0].settings_locked_at).toBeNull()
      }
    })

    test('BI-R16 (ruling C7) abort of a first install on real rows: released when nothing carries a plan label and no live batch exists; kept otherwise; the CHECK refuses an installing row without its lock', async () => {
      const plan = { scheme: 'pull-batch-history/v1', clusters: [{ k: 1, label: '第1批（推定，2026-10-01）' }] }
      const released = sheetOf('r16_release')
      await seedSheet(released, { status: 'installing', lockedAt: new Date().toISOString(), plan })
      const answer = await storeOn().abortInstall({ tenantId: TENANT, sheetId: released, projectNo: 'P-07', labelsOnSheet: new Set(['人工补充']) })
      expect([answer.historyStatus, answer.settingsReleased]).toEqual(['pending', true])
      const row = (await q(`SELECT history_status, settings_locked_at, history_plan FROM ${PULL_BATCH_TABLES.sheet} WHERE sheet_id = $1`, [released])).rows[0]
      expect([row.history_status, row.settings_locked_at, row.history_plan.aborted]).toEqual(['pending', null, true])

      const kept = sheetOf('r16_keep')
      await seedSheet(kept, { status: 'installing', lockedAt: new Date().toISOString(), plan })
      const keptAnswer = await storeOn().abortInstall({ tenantId: TENANT, sheetId: kept, projectNo: 'P-07', labelsOnSheet: new Set(['第1批（推定，2026-10-01）']) })
      expect([keptAnswer.historyStatus, keptAnswer.settingsReleased]).toEqual(['pending', false])
      expect((await q(`SELECT settings_locked_at FROM ${PULL_BATCH_TABLES.sheet} WHERE sheet_id = $1`, [kept])).rows[0].settings_locked_at).not.toBeNull()

      const guarded = sheetOf('r16_check')
      await seedSheet(guarded, { status: 'installing', lockedAt: new Date().toISOString(), plan })
      await expectSqlState(q(`UPDATE ${PULL_BATCH_TABLES.sheet} SET settings_locked_at = NULL WHERE sheet_id = $1`, [guarded]), '23514', C('sheet_lock_check'))
    })
  })
}
