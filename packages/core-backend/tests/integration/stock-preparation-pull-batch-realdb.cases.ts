/**
 * 批次标识 BI-1a (register R-65; batch-identifier design §3.3, §3.5, §8.2, §13.2; coordinator rulings C2 / C7) —
 * real-Postgres proof of the pull-batch LEDGER: migration 105 and the store
 * (plugins/plugin-integration-core/lib/stock-preparation-pull-batch-store.cjs) through the REAL scoped db helper
 * (lib/db.cjs). R line (R83 on onprem-r82): the sheet write lock is not on this line, so main's holder-assert case
 * BI-R14 (a zombie allocate after a lease takeover, LEASE_LOST) is not here; the store's `holderWithin` hook stays
 * unused on this line (the lanes pass none). Every other case is main's. ADDED (R line; critic R83-extension correction 3):
 * main's BI-1b real-stack stamping cases BI-R1 / R2 / R5 / R-C4 live in the project-write-lock real-DB cases on main (absent
 * here); their R-line copies are the second describe block below, on a lock-free real stack.
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
 *   BI-R17  (BI-7; ruling C8) the settings routes' audit adapter over the REAL audit store: a tenant write and a
 *           per-sheet edit commit with exactly one `project_fields_update` row (tenant: project_id NULL; sheet:
 *           project_id = the project number, never in the flat detail); an append the store's values gate or PG's
 *           action CHECK refuses rolls the setting back with it.
 * Values-free: every id is synthetic and per-run; the project numbers are the synthetic S-01 / P-07.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const storeLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch-store.cjs')) as any
const pureLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch.cjs')) as any
// R line (R83): the BI-1b stamping cases below drive the real routes over a real project sheet (lock-free stack).
const tableActionsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')) as any
const templatesLib = require(path.join(PLUGIN_LIB, 'stock-preparation-templates.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const auditStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
const httpRoutesLib = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
const accessLib = require(path.join(PLUGIN_LIB, 'stock-preparation-workbench-access.cjs')) as any
const harnessLib = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')) as any

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
      // BI-R17's audit rows (the immutability trigger may refuse the delete on a hardened database: tolerated, as the
      // other stock-prep real-DB cases do — the rows are per-run synthetic tenants).
      await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id LIKE $1', [`${TENANT}%`]).catch(() => {})
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

    test('BI-R17 (BI-7; ruling C8) a setting and its audit row commit or roll back together on real PG: the tenant write and the per-sheet edit through the settings routes\' adapter; a refused append (store gate or PG CHECK) leaves neither', async () => {
      const auditLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
      const settingsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch-settings.cjs')) as any
      const db = hostLikeDb()
      const store = storeOn(db)
      const audit = auditLib.createStockPreparationAuditStore({ db })
      const tenantId = `${TENANT}_r17`
      const auditOf = async (tenant: string) => (await q(
        'SELECT project_id, action, subject_id, mode, actor, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 ORDER BY created_at, id',
        [tenant],
      )).rows
      // The real action CHECK accepts 088's action (the routes' vocabulary probe asks exactly this).
      expect((await audit.supportsAction('project_fields_update', { tenantId })).supported).toBe(true)

      // The tenant write: the settings row and ONE audit row, committed together; project_id NULL; the flat detail.
      const tenantAdapter = settingsLib.pullBatchSettingsAuditWithin({ audit, tenantId, actor: 'u_bi7_r17' })
      const written = await store.writeTenantSettings({ tenantId, expectedVersion: 0, patch: { labelFormat: 'ordinal' }, auditWithin: tenantAdapter })
      expect(written).toMatchObject({ source: 'tenant', version: 1 })
      expect(tenantAdapter.appended).toBe(true)
      expect(await auditOf(tenantId)).toEqual([{
        project_id: null, action: 'project_fields_update', subject_id: null, mode: 'pull_batch_settings_tenant_updated', actor: 'u_bi7_r17',
        detail: { labelFormatBefore: 'ordinal_date', labelFormatAfter: 'ordinal', version: 1 },
      }])

      // A refused append — the audit store's values gate (a detail value that is not a token) — rolls the write back.
      const gateRefused = async (trx: any, entry: any) => audit.appendWithin(trx, {
        tenantId, projectId: null, action: 'project_fields_update', subjectId: null, mode: entry.mode, actor: 'u_bi7_r17',
        detail: { ...entry.detail, placementAfter: 'not a token' },
      })
      await expect(store.writeTenantSettings({ tenantId, expectedVersion: 1, patch: { placement: 'right' }, auditWithin: gateRefused }))
        .rejects.toMatchObject({ code: 'AUDIT_DETAIL_INVALID' })
      // …and one the DATABASE refuses (the action CHECK, 23514) rolls it back too (a 503 store failure).
      const pgRefused = async (trx: any) => {
        await trx.insertOne('integration_stock_prep_audit', { id: `bi7_r17_${TOKEN}`, tenant_id: tenantId, action: 'not_an_audit_action', detail: {} })
      }
      await expect(store.writeTenantSettings({ tenantId, expectedVersion: 1, patch: { placement: 'right' }, auditWithin: pgRefused }))
        .rejects.toMatchObject({ code: PULL_BATCH_ERROR_CODES.STORE_FAILED, details: { sqlState: '23514' } })
      const settingsRow = (await q(`SELECT band_placement, version FROM ${PULL_BATCH_TABLES.settings} WHERE tenant_id = $1`, [tenantId])).rows[0]
      expect(settingsRow).toEqual({ band_placement: 'left', version: 1 })
      expect((await auditOf(tenantId)).length).toBe(1)

      // The per-sheet edit: project_id = the project number (ruling C12), subject_id = the sheet, the flat detail with no
      // project number in it; the sheet row and the audit row committed together.
      const sheetId = sheetOf('r17_sheet')
      await seedSheet(sheetId)
      const sheetAdapter = settingsLib.pullBatchSettingsAuditWithin({ audit, tenantId: TENANT, actor: 'u_bi7_r17', projectNo: 'P-07' })
      const edited = await store.setSheetSettings({ tenantId: TENANT, sheetId, projectNo: 'P-07', expectedVersion: 0, patch: { firstPullBatchRule: 'predecessor_suffix' }, auditWithin: sheetAdapter })
      expect(edited).toMatchObject({ captured: { firstPullBatchRule: 'predecessor_suffix' }, version: 1 })
      const sheetAudit = (await auditOf(TENANT)).filter((row: any) => row.subject_id === sheetId)
      expect(sheetAudit).toEqual([{
        project_id: 'P-07', action: 'project_fields_update', subject_id: sheetId, mode: 'pull_batch_settings_sheet_updated', actor: 'u_bi7_r17',
        detail: { firstPullBatchRuleBefore: 'material', firstPullBatchRuleAfter: 'predecessor_suffix', version: 1 },
      }])
      expect(JSON.stringify(sheetAudit[0].detail)).not.toContain('P-07')
      // A refused append on the per-sheet edit leaves the captured row as it was.
      await expect(store.setSheetSettings({ tenantId: TENANT, sheetId, projectNo: 'P-07', expectedVersion: 1, patch: { labelFormat: 'ordinal' }, auditWithin: pgRefused }))
        .rejects.toMatchObject({ code: PULL_BATCH_ERROR_CODES.STORE_FAILED })
      const sheetRow = (await q(`SELECT label_format, version FROM ${PULL_BATCH_TABLES.sheet} WHERE sheet_id = $1`, [sheetId])).rows[0]
      expect(sheetRow).toEqual({ label_format: 'ordinal_date', version: 1 })
      expect((await auditOf(TENANT)).filter((row: any) => row.subject_id === sheetId).length).toBe(1)
    })
  })

  // 批次标识 BI-1b on the R LINE (R83 on onprem-r82; critic R83-extension correction 3) — the small lane's stamping on the
  // REAL stack: the real host (MetaSheetServer plugin context), the real provisioning and records, the real routes, the
  // real ledger store over migration 105, a registered project sheet. On main these cases (BI-R1 / R2 / R5 / R-C4) ride
  // the project-write-lock real-DB stack, which is not on this line; here they ride a lock-free stack built the way the
  // R-line manual-rows real-DB cases build theirs. The case bodies are main's, on this line's source shapes:
  //   BI-R1  OWN-1: batch 1 (S-001 + its subtree) then batch 2 (P-001 ⊃ S-001, plus N-001): the batch-1 rows keep
  //          第1批 / 第1批 (swept inactive, never re-stamped), the copies carry 首次 第1批 / 本次 第2批, P-001 and N-001
  //          第2批 / 第2批; two closed batches, the link counts set by value (4 and 6)
  //   BI-R2  A03: a third identical pull opens no batch and no link; the band cells of every row are unchanged
  //   BI-R5  U05: the status route before and after the band; a ledger whose statements fail => the apply is 503
  //          STORE_FAILED with zero created rows on an installed sheet; a not-installed sheet's pull is unaffected
  //   BI-R-C4 a creator-NULL row the automation / form way (a non-JSON key, no RUN stamp) neither pauses stamping nor is
  //          labelled
  // (The second pull orders P-001 and N-001 only, so it does not depend on main-only root selection.)
  describeIfDatabase('批次标识 BI-1b pull-batch stamping on the R line (real Postgres, real ledger, real host, no lock)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const PULL_SWITCH = 'STOCK_PREP_PULL_BATCH_ENABLED'
    const SHEETS_SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
    const LABEL1 = /^第1批（\d{4}-\d{2}-\d{2}）$/
    const LABEL2 = /^第2批（\d{4}-\d{2}-\d{2}）$/
    const ACTION_ID = tableActionsLib.PLM_STOCK_PREPARATION_ACTION_ID
    const tenants: string[] = []
    const sheets: string[] = []
    const kvPrefixes: string[] = []
    afterAll(async () => {
      for (const sheetId of sheets) {
        for (const sql of ['DELETE FROM meta_record_revisions WHERE sheet_id = $1', 'DELETE FROM meta_records WHERE sheet_id = $1', 'DELETE FROM meta_views WHERE sheet_id = $1', 'DELETE FROM meta_fields WHERE sheet_id = $1', 'DELETE FROM meta_sheets WHERE id = $1']) {
          await q(sql, [sheetId]).catch(() => {})
        }
      }
      for (const tenantId of tenants) {
        for (const table of ['integration_stock_prep_pull_batch_execution', 'integration_stock_prep_pull_batch', 'integration_stock_prep_pull_batch_sheet', 'integration_stock_prep_audit', 'integration_stock_prep_project_target']) {
          await q(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
        }
      }
      for (const prefix of kvPrefixes) await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`${prefix}%`]).catch(() => {})
    })

    function hostPluginContext(): PluginContext {
      const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
      const loaded: LoadedPlugin = {
        manifest: { name: 'plugin-integration-core', version: 'pull-batch-rline-realdb' },
        plugin: { activate: async () => {} },
        path: 'realdb://stock-preparation-pull-batch-rline',
        loadedAt: new Date(),
      }
      return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
    }
    function routeResponse() {
      const res: any = { statusCode: 200, body: null, headers: {} }
      res.status = (code: number) => { res.statusCode = code; return res }
      res.json = (payload: unknown) => { res.body = payload; return res }
      res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res }
      res.send = (payload: unknown) => { res.body = payload; return res }
      res.end = () => res
      return res
    }
    // The OWN-1 source (main's continuation fixtures' S/P story, values-free).
    const part = (id: string, code: string, name: string) => ({ OBJ_ID: id, IdentityNo: code, IdentityName: name, Material: 'M-STEEL', SysVer: 'V1' })
    const PARTS = [part('P-001', 'D100-01', 'Assembly'), part('S-001', 'D100-01-03', 'SubAssembly'), part('PART-A', 'C200-1', 'Bracket'), part('PART-B', 'C200-2', 'Plate'), part('PART-C', 'C200-3', 'Pin'), part('N-001', 'E300-1', 'Loose')]
    const S_BOMS: Record<string, Array<{ part: string; usage: number }>> = { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: 4 }] }
    function sourceOf(projectNo: string, orders: Array<{ part: string; qty: number }>, boms: Record<string, Array<{ part: string; usage: number }>>) {
      const heads: any[] = []
      const lines: any[] = []
      for (const [parentId, children] of Object.entries(boms)) {
        heads.push({ part_id: parentId, bom_id: `BOM-${parentId}`, SysVer: 'V1', bom_able: true })
        children.forEach((child, index) => lines.push({ bom_pid: `BOM-${parentId}`, part_id: child.part, Bom_ExAttr1: String(child.usage), sort_id: String(index + 1) }))
      }
      return {
        DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: `${projectNo}-PATH` }],
        DN_PDM_PathInfo: [{ OBJ_ID: `${projectNo}-PATH` }],
        DN_PDM_OrderHeadInfo: [{ OBJ_ID: `${projectNo}-ORDER-1`, path_id: `${projectNo}-PATH` }],
        DN_PDM_OrderDetailInfo: orders.map((order, index) => ({ order_id: `${projectNo}-ORDER-1`, part_id: order.part, quantity: String(order.qty), sort_id: String((index + 1) * 10) })),
        DN_PDM_PartLibraryInfo: PARTS.map((entry) => ({ ...entry })),
        DN_PDM_BomHeadInfo: heads,
        DN_PDM_BomDetailsInfo: lines,
      }
    }
    const firstPullSource = (projectNo: string) => sourceOf(projectNo, [{ part: 'S-001', qty: 10 }], { ...S_BOMS })
    const secondPullSource = (projectNo: string) => sourceOf(projectNo, [{ part: 'P-001', qty: 5 }, { part: 'N-001', qty: 1 }], { 'P-001': [{ part: 'S-001', usage: 2 }], ...S_BOMS })

    async function withSwitches<T>(fn: () => Promise<T>): Promise<T> {
      const before = { pull: process.env[PULL_SWITCH], sheets: process.env[SHEETS_SWITCH] }
      process.env[PULL_SWITCH] = 'true'
      process.env[SHEETS_SWITCH] = 'true'
      try {
        return await fn()
      } finally {
        if (before.pull === undefined) delete process.env[PULL_SWITCH]; else process.env[PULL_SWITCH] = before.pull
        if (before.sheets === undefined) delete process.env[SHEETS_SWITCH]; else process.env[SHEETS_SWITCH] = before.sheets
      }
    }

    async function stampingStack(label: string, { band = true, failingLedger = false }: { band?: boolean; failingLedger?: boolean } = {}) {
      const tenantId = `tenant_bi1b_rl_${label}_${TOKEN}`
      tenants.push(tenantId)
      const projectNo = `SYN-BI1B-${label.toUpperCase()}`
      const projectId = `${tenantId}:integration-core`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = hostPluginContext()
      const multitable: any = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      const envObjectId = `plm_stock_preparation_sandbox_bi1b_env_${label}_${TOKEN}`
      const envEnsured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId: envObjectId })
      expect(envEnsured.ready).toBe(true)
      sheets.push(envEnsured.target.sheetId)
      const db = createDb({ database: pluginContext.api.database })
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      await registry.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
      const physical = (fieldId: string) => multitable.provisioning.getFieldId(projectId, objectId, fieldId)
      const ledgerDb = createDb({ database: pluginContext.api.database })
      // A ledger whose statements fail (the 105 tables behind a refusing handle) — never a DROP on the shared database (P-10).
      const refusing = failingLedger
        ? { ...ledgerDb, select: async () => { throw Object.assign(new Error('refused'), { code: '42501' }) }, selectOne: async () => { throw Object.assign(new Error('refused'), { code: '42501' }) } }
        : ledgerDb
      const pullBatchStore = createStockPreparationPullBatchStore({ db: refusing })
      if (band) {
        const added = await multitable.provisioning.ensureMissingObjectFields({
          projectId,
          objectId,
          fields: templatesLib.pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'left' }).map((descriptor: any) => ({ ...descriptor, property: { ...descriptor.property } })),
        })
        expect([...added.addedFieldIds].sort()).toEqual([physical('firstPullBatch'), physical('pullBatch')].sort())
        const seed = createStockPreparationPullBatchStore({ db: ledgerDb })
        await ledgerDb.transaction((trx: any) => seed.createSheetRowWithin(trx, { tenantId, sheetId, projectNo, historyStatus: 'born_empty', labelLocale: 'zh-CN', settings: { firstPullBatchRule: 'material', labelFormat: 'ordinal_date' } }))
      }
      const state: any = { data: firstPullSource(projectNo) }
      const sourceAdapter = {
        async read(input: any = {}) {
          const rows = Array.isArray(state.data[input.object]) ? state.data[input.object] : []
          const found = rows.filter((row: any) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
          return { records: found.map((row: any) => ({ ...row })), done: true, nextCursor: null }
        },
      }
      const routes = new Map<string, any>()
      kvPrefixes.push('integration:table-action:dry-run-token:')
      const routeContext = {
        api: {
          http: { addRoute: (method: string, routePath: string, handler: any) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
          multitable,
          database: pluginContext.api.database,
        },
        storage: pluginContext.storage,
        config: {
          stockPreparationTableActions: [{ actionId: ACTION_ID, source: { externalSystemId: `plm_bi1b_${label}_${TOKEN}`, kind: 'data-source:sql-readonly' }, target: envEnsured.target }],
          stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envObjectId] },
        },
      }
      const base = harnessLib.baseServices(sourceAdapter)
      const services: any = {
        ...base,
        externalSystemRegistry: { ...base.externalSystemRegistry, async listExternalSystems() { return [] } },
        pipelineRegistry: { ...base.pipelineRegistry, async listPipelines() { return [] } },
        stockPreparationProjectTargetStore: registry,
        stockPreparationAuditStore: auditStoreLib.createStockPreparationAuditStore({ db }),
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
        stockPreparationPullBatchStore: pullBatchStore,
      }
      httpRoutesLib.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
      const users = {
        puller: { id: `u_bi1b_pull_${label}`, tenantId, permissions: [accessLib.STOCK_PREP_READ, accessLib.STOCK_PREP_OPERATE, accessLib.STOCK_PREP_PULL] },
        admin: { id: `u_bi1b_admin_${label}`, tenantId, permissions: [accessLib.STOCK_PREP_ADMIN] },
      }
      const call = async (user: any, method: string, routePath: string, req: Record<string, any> = {}) => {
        const handler = routes.get(`${method} ${routePath}`)
        if (!handler) throw new Error(`route ${method} ${routePath} is not registered`)
        const res = routeResponse()
        await handler({ user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
        return res
      }
      const rows = async () => (await q('SELECT id, data, created_by FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])).rows
      const cells = async () => (await rows()).map((row: any) => ({
        part: row.data[physical('componentSourceId')],
        path: row.data[physical('path')],
        active: row.data[physical('active')],
        first: row.data[physical('firstPullBatch')] ?? null,
        current: row.data[physical('pullBatch')] ?? null,
      }))
      const ledger = async () => ({
        batches: (await q('SELECT batch_no, status, closed_reason, label FROM integration_stock_prep_pull_batch WHERE tenant_id = $1 ORDER BY batch_no', [tenantId])).rows,
        links: (await q('SELECT execution_ref, lane, writer_status, created_row_count FROM integration_stock_prep_pull_batch_execution WHERE tenant_id = $1 ORDER BY joined_at, id', [tenantId])).rows,
      })
      const dryRun = () => call(users.puller, 'POST', '/api/integration/table-actions/:actionId/dry-run', { body: { parameters: { projectNo } }, params: { actionId: ACTION_ID } })
      const apply = (token: string) => call(users.puller, 'POST', '/api/integration/table-actions/:actionId/apply', { body: { parameters: { projectNo }, confirm: { dryRunToken: token, acceptManualConfirmHold: true } }, params: { actionId: ACTION_ID } })
      const status = () => call(users.admin, 'GET', '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch', { params: { projectNo }, query: {} })
      const pull = async () => {
        const dry = await dryRun()
        expect(dry.statusCode, JSON.stringify(dry.body)).toBe(200)
        const applied = await apply(dry.body.data.dryRunToken)
        return { dry, applied }
      }
      return { tenantId, projectNo, sheetId, multitable, physical, state, rows, cells, ledger, dryRun, apply, status, pull, secondPullSource: () => secondPullSource(projectNo), firstPullSource: () => firstPullSource(projectNo) }
    }

    test('BI-R1 / BI-R2 (R line) OWN-1 on the real stack: batch 1, then batch 2 (P-001 ⊃ S-001) — exactly the owner\'s rows; a third identical pull opens nothing', async () => {
      const k = await stampingStack('r1')
      await withSwitches(async () => {
        const first = await k.pull()
        expect(first.dry.body.data.pullBatch).toEqual({ preview: true, wouldStamp: true, reason: null })
        expect(first.applied.statusCode, JSON.stringify(first.applied.body)).toBe(200)
        expect(first.applied.body.data.pullBatch).toMatchObject({ stamped: true, batchNo: 1, joined: false, createdRowCount: 4 })
        const afterOne = await k.cells()
        expect(afterOne).toHaveLength(4)
        for (const row of afterOne) {
          expect(row.first, JSON.stringify(row)).toMatch(LABEL1)
          expect(row.current, JSON.stringify(row)).toMatch(LABEL1)
        }
        k.state.data = k.secondPullSource()
        const second = await k.pull()
        expect(second.applied.statusCode, JSON.stringify(second.applied.body)).toBe(200)
        expect(second.applied.body.data.pullBatch).toMatchObject({ stamped: true, batchNo: 2, joined: false, createdRowCount: 6 })
        const afterTwo = await k.cells()
        const old = afterTwo.filter((row: any) => row.active === false)
        const fresh = afterTwo.filter((row: any) => row.active !== false)
        expect(old.map((row: any) => row.part).sort()).toEqual(['PART-A', 'PART-B', 'PART-C', 'S-001'])
        for (const row of old) expect([row.first, row.current].every((value: string) => LABEL1.test(value)), JSON.stringify(row)).toBe(true)
        const byPart = new Map(fresh.map((row: any) => [row.part, row]))
        expect([...byPart.keys()].sort()).toEqual(['N-001', 'P-001', 'PART-A', 'PART-B', 'PART-C', 'S-001'])
        for (const partId of ['P-001', 'N-001']) {
          expect(byPart.get(partId).first, partId).toMatch(LABEL2)
          expect(byPart.get(partId).current, partId).toMatch(LABEL2)
        }
        for (const partId of ['S-001', 'PART-A', 'PART-B', 'PART-C']) {
          expect(byPart.get(partId).first, `${partId}: 首次 = the batch it first appeared in`).toMatch(LABEL1)
          expect(byPart.get(partId).current, `${partId}: 本次 = the batch that created this row`).toMatch(LABEL2)
        }
        const ledgerTwo = await k.ledger()
        expect(ledgerTwo.batches.map((row: any) => [row.batch_no, row.status, row.closed_reason])).toEqual([[1, 'closed', 'execution_succeeded'], [2, 'closed', 'execution_succeeded']])
        expect(ledgerTwo.links.map((row: any) => [row.lane, row.writer_status, row.created_row_count])).toEqual([['small_apply', 'succeeded', 4], ['small_apply', 'succeeded', 6]])
        for (const link of ledgerTwo.links) expect(link.execution_ref).toMatch(/^small:table-action-apply:/)
        // BI-R2 (A03): the same pull again — nothing to create, so no batch and no link; every band cell unchanged.
        const third = await k.pull()
        expect(third.applied.body.data.pullBatch).toEqual({ stamped: false, reason: 'no_creates' })
        expect(await k.ledger()).toEqual(ledgerTwo)
        expect(await k.cells()).toEqual(afterTwo)
      })
    }, 180000)

    test('BI-R5 / BI-R-C4 (R line) U05 status before and after the band; a failing ledger is 503 STORE_FAILED with nothing created; a not-installed sheet is unaffected; a creator-NULL automation-like row never pauses stamping', async () => {
      const bare = await stampingStack('r5a', { band: false })
      await withSwitches(async () => {
        const status = await bare.status()
        expect(status.statusCode, JSON.stringify(status.body)).toBe(200)
        expect(status.body.data.columns).toMatchObject({ mode: 'db', pullBatch: false, firstPullBatch: false })
        expect(status.body.data.reasons).toContain('not_installed')
        expect(JSON.stringify(status.body)).not.toContain('fld_')
        const { applied } = await bare.pull()
        expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
        expect(applied.body.data.pullBatch).toEqual({ stamped: false, reason: 'not_installed' })
      })
      const failing = await stampingStack('r5b', { failingLedger: true })
      await withSwitches(async () => {
        const dry = await failing.dryRun()
        expect(dry.body.data.pullBatch).toEqual({ preview: true, wouldStamp: false, reason: 'ledger_unreadable' })
        const refused = await failing.apply(dry.body.data.dryRunToken)
        expect(refused.statusCode, JSON.stringify(refused.body)).toBe(503)
        expect(refused.body.error.code).toBe('STOCK_PREP_PULL_BATCH_STORE_FAILED')
        expect(await failing.rows()).toHaveLength(0)
      })
      const c4 = await stampingStack('r5c')
      await c4.multitable.records.createRecord({ sheetId: c4.sheetId, data: { [c4.physical('projectNo')]: c4.projectNo, [c4.physical('idempotencyKey')]: `auto-${TOKEN}`, [c4.physical('componentSourceId')]: 'AUTO-1', [c4.physical('active')]: true } })
      await withSwitches(async () => {
        const status = await c4.status()
        expect(status.body.data.ready, JSON.stringify(status.body.data)).toBe(true)
        expect(status.body.data.rows).toMatchObject({ gap: 0, nonPlugin: 1, machine: 0 })
        const { applied } = await c4.pull()
        expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
        expect(applied.body.data.pullBatch).toMatchObject({ stamped: true, batchNo: 1 })
        const auto = (await c4.cells()).find((row: any) => row.part === 'AUTO-1')
        expect(auto, 'the automation-like row is still there').toBeTruthy()
        expect([auto.first, auto.current]).toEqual([null, null])
      })
    }, 180000)
  })
}
