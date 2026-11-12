/**
 * Batch-refresh step 6d-2a (S6-6; step-6 design §6.6, §10 「S6-6」; register row R-91) — real-Postgres proof of the
 * DOUBLED-SHEET REPAIR: migration 108, the repair ledger store and the repair routes
 * (plugins/plugin-integration-core/lib/stock-preparation-sheet-repair*.cjs, lib/http-routes.cjs) on the REAL stack —
 * the production plugin context (the host's provisioning and records APIs with the plugin write fence, the plugin
 * database binding), the REAL sheet write lock, the REAL refresh governance, the REAL audit store, the REAL batch ledger
 * store — over a project sheet provisioned the way the plugin provisions one. Only the PLM source is synthetic (the
 * canonical S / P story of the continuation fixtures).
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationSheetRepairRealDbCases()` registers its `describe`
 * block and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases run in the existing "Run
 * multitable real-DB integration" step of .github/workflows/plugin-tests.yml (aggregated into the required
 * `test (20.x)`) without a workflow edit. Do NOT also list it as a standalone file in that step.
 *
 * The sheet of every case is design §6.1's D1: S-001 as its own root subtree (the first pull's four rows, a person's
 * note on the root) AND as a copy nested under P-001 (the second pull's rows) — every row active.
 *
 *   S9D-108  migration 108 applied: both tables, the JSONB backup, every closed CHECK refuses with 23514 under its own
 *            constraint name (a close approval on a run that is not `completed` among them), a second OPEN run of a
 *            sheet and a repeated sequence are 23505, the claim key is a PRIMARY KEY.
 *   S9D-11   D1 -> retire -> acknowledgement -> a clean governed pull (the design's §10 line, whole since S6-5 #6842 is on
 *            main). Before the retire the governed planner SUSPENDS the sheet (`candidate_target_occupied`) and
 *            readiness refuses the two-copy component; the retire through the route writes the BOOLEAN false
 *            (`jsonb_typeof = 'boolean'`) and the three RUN stamps on exactly the four old rows, version + 1 each, one
 *            host revision each, the run / claim / audit rows committed, the lease released and the generation bumped;
 *            the census then reads the component as an inactive-root remnant and the SAME governed computation over the
 *            rows read back from PostgreSQL is clean (no hold, nothing written on the component). In between, the
 *            acknowledgement (S6-5's route and migration 107; coordinator ruling C-6): the retire turned the two-copy
 *            refusal of readiness v5 into the unacknowledged-remnant one, and the admin's recorded acknowledgement of
 *            that component (the SAME private handle the repair named) lifts exactly that check.
 *   S9D-12   backup -> retire -> restore: with one retired row's version moved by a person's edit, the restore (its own
 *            digest, approval and claim) writes all four rows at their CURRENT versions; every stored row is
 *            byte-identical to before the retire (`data::text`), version + 2 — the edited row carries the edit, version
 *            + 3.
 *   S9D-13   a person's edit while the run writes STOPS it (409 STOPPED version_conflict, the partial count in the run
 *            row); the spent digest is 409 ALREADY_CONSUMED; the re-run needs a NEW preview digest and its own claim.
 *   S9D-14   the digest: a row edited between the preview and the execute => 409 PLAN_CHANGED in the lease — no run
 *            row, no claim, no patch, the lease released.
 *   S9D-15   one sheet, one writer: a pull, a recovery or an install holding the sheet lease refuses the repair 409
 *            WRITE_LOCKED (nothing of it runs); while the repair holds the lease a pull cannot take it (WRITE_LOCKED
 *            naming `sheet_repair`); the install gate (coordinator ruling C-2) is read from the batch ledger WHATEVER
 *            the batch switch says: with the switch OFF a sheet whose batch columns are being installed, and a pending
 *            one that still carries an aborted first install's persisted plan (the plan, or its digest alone — the
 *            settings lock held or released) or its settings lock, are refused 409 INSTALL_IN_PROGRESS inside the
 *            lease; a pending sheet with neither is repairable; once the install resolved, the same approved digest
 *            runs.
 *   S9D-16   takeover / zombie: the repair's lease lapses mid-run and a pull takes the sheet over — the HOST fence
 *            refuses the zombie's next patch (nothing lands), its answer carries the partial count, its run row stays
 *            open (the 108 stop-condition query answers 1); the next repair run closes it `abandoned` in its own begin
 *            and completes. And a takeover after the LAST patch: the finish's holder assert refuses, the run is never
 *            recorded completed.
 *   S9D-17   the one-shot claim on real row locks: two begins of ONE approved plan at the same moment — the second
 *            waits on the first's uncommitted claim key, then fails at the PRIMARY KEY, its transaction aborted by
 *            PostgreSQL and the claim READ BACK on a fresh handle => 409 ALREADY_CONSUMED, exactly one run row. An
 *            audit row the REAL audit store refuses rolls the run AND the claim back.
 *   S9D-18   the fills report through the route on real rows: the K2 class of the pair that carries the note, audited
 *            (project_board_read, no project) — and never the note.
 *   S9D-19   (ruling C-1) the heartbeat N6 rule on real row locks (the S9R-29d pattern): while the begin transaction, a
 *            host patch and the finish transaction hold the sheet lock row for 3 s each, the lease — heartbeating every
 *            100 ms over autocommit statements with a 1.5 s statement_timeout — attempts no holder CAS and none fails.
 *   S9D-20   (ruling C-3) the dead end closed: a run left `running` after every row was written (its finish refused by
 *            a takeover) is verified and finished `completed` by the continuation — no row write (`data::text` and
 *            versions unchanged, no host revision), its own approval and audit row, the close transaction inside the
 *            bracket on real row locks, the generation bump, the 108 stop-condition query back to 0. A planned row
 *            moved since refuses with counts (the restore stays the other way out). A project governed since still
 *            closes.
 *   S9D-21   (ruling C-4) a guard already lost before the begin (one heartbeat CAS failed in the store, the lease row
 *            intact): refused before the claim is spent; the same approved digest runs afterwards.
 *   S9D-22   the RESTORE's own digest (write-safety review of round 1): a row a person edited between the restore's
 *            preview and its execute => 409 PLAN_CHANGED in the lease — no restore run, no restore claim, no patch,
 *            `data::text` and versions unchanged; a restore run that began and wrote nothing leaves a NEW digest
 *            behind (the run sequence), the spent one is ALREADY_CONSUMED, and the new one puts every row back.
 *   S9D-23   F-11 on both sides (write-safety review of round 1): a row of the nested copy — the rows a retire leaves
 *            live — whose STORED `active` cell is the string 'false', the number 0, JSON null or absent refuses the
 *            retire before any write (`copy_row_active_not_boolean`, counted in the preview; 409 NOT_APPLICABLE by the
 *            recompute inside the lease; no run, no claim, no patch); with the cell put right the same approved digest
 *            runs, and every copy row is the JSON boolean true while every old row is the JSON boolean false.
 *   S9D-24   what a backup may hold (write-safety review of round 1): an old row whose STORED stamp cell is no known
 *            writer's — a part id or an unknown writer's run id in the run-id cell, a summary of an unknown type, a
 *            summary whose text carries a duplicated key — refuses the retire before any write (`row_not_machine_shaped`,
 *            counted; 409 inside the lease), so no run row and no backup exist; another WRITER's stamp (the large lane's
 *            run id, an UPDATE's decision and summary) is stored as read, nothing planted is anywhere in the ledger, the
 *            audit details or the answers, and the restore puts every stamp back byte for byte. And (ruling R3-2) no
 *            answer of that retire or of its restore — the previews, a STOPPED refusal of each (the first patch fails in
 *            the host), the execute answers — carries either cell of that backup; each answer has exactly its own keys.
 * Values-free: every id is synthetic and per run; the project number, part ids and the note are the fixtures' synthetic
 * values.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
const PLUGIN_SUPPORT = path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const repairLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-repair.cjs')) as any
const repairStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-repair-store.cjs')) as any
const lockLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const auditStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
const censusLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-census.cjs')) as any
const tableActionsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')) as any
const httpRoutesLib = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const continuationStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
const refreshGovernanceLib = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-governance.cjs')) as any
const packInstallStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pack-install-store.cjs')) as any
const pullBatchStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch-store.cjs')) as any
const componentRulingStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-component-ruling-store.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const harnessLib = require(path.join(PLUGIN_SUPPORT, 'stock-preparation-project-sheet-harness.cjs')) as any
const CF = require(path.join(PLUGIN_SUPPORT, 'stock-preparation-continuation-fixtures.cjs')) as any

const { SHEET_REPAIR_ERROR_CODES: CODES, SHEET_REPAIR_RECIPES, SHEET_REPAIR_RETIRE_SUMMARY, SHEET_REPAIR_RUN_ID_PREFIX, STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV } = repairLib
const { SHEET_REPAIR_TABLES: RT, createStockPreparationSheetRepairStore } = repairStoreLib
const { PROJECT_WRITE_ERROR_CODES, PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS, PROJECT_WRITE_LEASE_TTL_MS, PROJECT_WRITE_LOCK_TABLE, createStockPreparationProjectWriteLock, sheetWriteScopeKey } = lockLib
const { readExistingStockPreparationRows } = tableActionsLib.__internals
const [RETIRE, RESTORE] = SHEET_REPAIR_RECIPES as [string, string]
const CLOSE: string = repairLib.SHEET_REPAIR_CONTINUATIONS[0]
// The run id the SMALL LANE stamps on every row it writes — its only one (`table-action:` + the one action id). Every
// world plans its fixture rows under it: the repair backs a row up only when its stamp cells are a known writer's
// (the fixtures' own default run id is no writer's, and S9D-24 plants it to see it refused).
const SMALL_LANE_RUN_ID = `table-action:${tableActionsLib.PLM_STOCK_PREPARATION_ACTION_ID}`

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const PROJECT_SHEETS_SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const PULL_BATCH_SWITCH = 'STOCK_PREP_PULL_BATCH_ENABLED'
const BASE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/sheet-repair'
const PATHS = { repair: BASE_PATH, fills: `${BASE_PATH}/fills-report`, runs: `${BASE_PATH}/runs` }
// S6-5's surfaces (#6842): the pilot readiness read and the remnant acknowledgement.
const PILOT_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/pilot'
const ACKNOWLEDGE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/remnant-acknowledgements'
const RULING_TABLE: string = componentRulingStoreLib.COMPONENT_RULING_TABLE
const BI_SHEET_TABLE = 'integration_stock_prep_pull_batch_sheet'
const AUDIT_TABLE = 'integration_stock_prep_audit'
const REGISTRY_TABLE = 'integration_stock_prep_project_target'

type StatementEvent = { sql: string; inTransaction: boolean }
// The scoped db over the HOST's plugin database binding shape (`query` on a pooled connection in autocommit,
// `transaction` on its OWN client), with an optional `hook` awaited before every statement and before the COMMIT —
// used to FREEZE a session inside its transaction at a chosen point.
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
          await hook({ sql: 'COMMIT', inTransaction: true })
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

type LockEvent = { ok: boolean; order: number; ms: number; code?: string; holderCas: boolean }
/** The PROGRAM ORDER of the heartbeat cases: one counter, read when a lock statement is INVOKED and when a window opens / closes. */
type LockOrder = { n: number }
type LockWindow = { mode: string; openedAt: number; opened: number; closedAt?: number; closed?: number }
/** Opens a window NOW: every lock statement invoked from here until `closeLockWindow` is inside it. */
function openLockWindow(order: LockOrder, mode: string): LockWindow {
  return { mode, openedAt: order.n, opened: performance.now() }
}
function closeLockWindow(order: LockOrder, w: LockWindow): void {
  w.closedAt = order.n
  w.closed = performance.now()
}
/**
 * The lock statements INVOKED while the window was open — decided by order, never by timestamps: at millisecond
 * resolution a statement invoked just BEFORE a window opens can carry the window's own opening millisecond (the first
 * patch's pre-write holder CAS and the patch's window did, about one run in eight on a fast database).
 */
function invokedIn(w: LockWindow, events: LockEvent[]): LockEvent[] {
  if (w.closedAt === undefined) throw new Error(`the window ${w.mode} was never closed`)
  return events.filter((e) => e.order > w.openedAt && e.order <= (w.closedAt as number))
}
/**
 * The sheet write lock's db for the heartbeat cases (the S9R-29d pattern): every AUTOCOMMIT statement runs on its own
 * client under a short statement_timeout (standing for the pool's 30 s), and every UPDATE of the lock row is recorded
 * with its place in `order` (taken at the INVOCATION) — `holderCas` marks the holder CAS shape (a heartbeat tick or a
 * pre-write check). `shouldFail` makes ONE holder CAS fail before it reaches PostgreSQL (a transient store fault).
 */
function timedLockDb(opts: { timeoutMs: number; events: LockEvent[]; order?: LockOrder; shouldFail?: () => boolean }) {
  const order = opts.order || { n: 0 }
  return createDb({
    database: {
      query: async (sql: string, params?: unknown[]) => {
        const isLockUpdate = /^\s*UPDATE\s+"?integration_stock_prep_project_write_lock/i.test(sql)
        const holderCas = isLockUpdate && /lease_heartbeat_at/.test(sql) && /lease_seq/.test(sql)
        const at = performance.now()
        const place = isLockUpdate ? (order.n += 1) : order.n
        if (holderCas && opts.shouldFail && opts.shouldFail()) {
          opts.events.push({ ok: false, order: place, ms: 0, code: 'INJECTED', holderCas })
          throw Object.assign(new Error('injected store fault'), { code: '08006' })
        }
        const client = await poolManager.get().getInternalPool().connect()
        try {
          await client.query('BEGIN')
          await client.query(`SET LOCAL statement_timeout = ${opts.timeoutMs}`)
          const result = await client.query(sql, params)
          await client.query('COMMIT')
          if (isLockUpdate) opts.events.push({ ok: true, order: place, ms: Math.round(performance.now() - at), holderCas })
          return result.rows
        } catch (error: any) {
          await client.query('ROLLBACK').catch(() => {})
          if (isLockUpdate) opts.events.push({ ok: false, order: place, ms: Math.round(performance.now() - at), code: error && error.code, holderCas })
          throw error
        } finally {
          client.release()
        }
      },
      transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        const client = await poolManager.get().getInternalPool().connect()
        try {
          await client.query('BEGIN')
          const result = await callback({ query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows, commit: async () => {}, rollback: async () => {} })
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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function caught(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 15000) {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// A backend of THIS database waiting on a lock whose statement names the given table.
async function someoneWaitsOn(table: string): Promise<boolean> {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND query LIKE $1`,
    [`%${table}%`],
  )
  return rows[0].n > 0
}

async function expectSqlState(promise: Promise<unknown>, code: string, constraint?: string) {
  const thrown = await caught(promise)
  expect(thrown, `expected SQLSTATE ${code}${constraint ? ` (${constraint})` : ''}`).not.toBeNull()
  expect(thrown.code).toBe(code)
  if (constraint) expect(thrown.constraint).toBe(constraint)
}

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'sheet-repair-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-sheet-repair',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

export function defineStockPreparationSheetRepairRealDbCases(): void {
  test('sheet repair real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1') return
    if (!process.env.DATABASE_URL) throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the S6-6 sheet-repair cases would skip-green')
  })

  describeIfDatabase('S9 step-6 doubled-sheet repair: migration 108, the ledger and the routes on the real stack (real Postgres, S6-6)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const PROJECT: string = CF.PROJECT_NO
    const tenants: string[] = []
    const sheets: string[] = []
    const scopes: string[] = []
    const envBefore: Record<string, string | undefined> = {}

    beforeAll(() => {
      for (const name of [PROJECT_SHEETS_SWITCH, STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV, PULL_BATCH_SWITCH]) envBefore[name] = process.env[name]
      process.env[PROJECT_SHEETS_SWITCH] = 'true'
      process.env[STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV] = 'true'
      delete process.env[PULL_BATCH_SWITCH]
    })

    afterAll(async () => {
      for (const [name, value] of Object.entries(envBefore)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
      for (const scopeKey of scopes) await q(`DELETE FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [scopeKey]).catch(() => {})
      for (const tenantId of tenants) {
        await q(`DELETE FROM ${RT.claim} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
        await q(`DELETE FROM ${RT.run} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
        await q(`DELETE FROM ${BI_SHEET_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
        await q(`DELETE FROM ${RULING_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
        await q(`DELETE FROM ${AUDIT_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
        await q(`DELETE FROM ${REGISTRY_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
      }
    })

    /**
     * One world: its own tenant, a project sheet provisioned the way the plugin provisions one (the frozen template,
     * the contract option sets, the PLM lock, the registry row), the D1 rows, and the REAL route module over the
     * production plugin context. `hooks.beforePatch` / `hooks.afterPatch` run around the host's own patchRecord;
     * `hooks.onSourceRead` runs inside every source read. `opts.lock` builds the lock the routes use (the heartbeat
     * cases hand a fast-heartbeat lock over a recording db); `opts.audit` wraps the real audit store (a slow append
     * inside a ledger transaction holds its lock row).
     */
    async function world(label: string, opts: { lock?: () => any; audit?: (real: any) => any } = {}) {
      const tenantId = `tenant_s66_${label}_${TOKEN}`
      tenants.push(tenantId)
      const projectId = `${tenantId}:integration-core`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, PROJECT)
      const pluginContext = createProductionPluginContext()
      const multitable: any = pluginContext.api.multitable
      if (!multitable) throw new Error('production plugin context is missing multitable APIs')
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      const fields: Record<string, string> = { ...ensured.target.fieldIdMap }
      const target = ensured.target
      sheets.push(sheetId)
      const scopeKey: string = sheetWriteScopeKey(sheetId)
      scopes.push(scopeKey)
      const db = createDb({ database: pluginContext.api.database })
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      await registry.create({ tenantId, projectNo: PROJECT, sheetId, objectId, createdBy: 'syn' })

      // D1, row by row: created through the host records API (the project number), then the stored cells shaped
      // directly — exactly what two pulls of the fixture wrote, both subtrees active.
      const first = CF.applyToSheet(CF.plan(await CF.expand(CF.firstPullSource()), [], { runId: SMALL_LANE_RUN_ID }), [], { idPrefix: 'syn_s', human: { 'S-001': { notes: 'synthetic note' } } })
      const second = CF.applyToSheet(CF.plan(await CF.expand(CF.secondPullSource({ sLine: false })), [], { runId: SMALL_LANE_RUN_ID }), [], { idPrefix: 'syn_p' })
      const oldIds: string[] = []
      const copyIds: string[] = []
      for (const [index, row] of first.concat(second).entries()) {
        const created = await multitable.records.createRecord({ sheetId, data: { [fields.projectNo]: PROJECT } })
        const patch: Record<string, unknown> = {}
        for (const [logical, value] of Object.entries(row)) {
          const physical = fields[logical]
          if (!physical) throw new Error(`fixture field ${logical} is not on the sheet`)
          patch[physical] = value
        }
        await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [created.id, JSON.stringify(patch)])
        ;(index < first.length ? oldIds : copyIds).push(String(created.id))
      }
      expect([oldIds.length, copyIds.length]).toEqual([4, 6])

      // The source: P-001 ordered with S-001 inside it, S-001's own order line gone (H0).
      const source: any = { data: CF.secondPullSource({ sLine: false }), reads: 0 }
      const sourceAdapter = {
        async read(input: any = {}) {
          source.reads += 1
          if (hooks.onSourceRead) await hooks.onSourceRead(source.reads)
          const rows = Array.isArray(source.data[input.object]) ? source.data[input.object] : []
          const found = rows.filter((row: any) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
          return { records: found.map((row: any) => ({ ...row })), done: true, nextCursor: null }
        },
      }
      const hooks: { beforePatch: null | ((input: any) => Promise<void> | void); afterPatch: null | ((input: any) => Promise<void> | void); onSourceRead: null | ((reads: number) => Promise<void> | void) } = { beforePatch: null, afterPatch: null, onSourceRead: null }
      const patchInputs: any[] = []
      const records = new Proxy(multitable.records, {
        get(real, key, receiver) {
          if (key !== 'patchRecord') return Reflect.get(real, key, receiver)
          return async (input: any) => {
            patchInputs.push(input)
            if (hooks.beforePatch) await hooks.beforePatch(input)
            const answer = await real.patchRecord(input)
            if (hooks.afterPatch) await hooks.afterPatch(input)
            return answer
          }
        },
      })
      const lock = opts.lock ? opts.lock() : createStockPreparationProjectWriteLock({ db })
      const continuationStore = continuationStoreLib.createStockPreparationContinuationStore({ db })
      const realAudit = auditStoreLib.createStockPreparationAuditStore({ db })
      const audit = opts.audit ? opts.audit(realAudit) : realAudit
      const repairStore = createStockPreparationSheetRepairStore({ db })
      const pullBatchStore = pullBatchStoreLib.createStockPreparationPullBatchStore({ db })
      const routes = new Map<string, any>()
      const routeContext = {
        api: {
          http: { addRoute: (method: string, routePath: string, handler: any) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
          multitable: { provisioning: multitable.provisioning, records },
          database: pluginContext.api.database,
        },
        storage: pluginContext.storage,
        config: {
          stockPreparationTableActions: [{
            actionId: tableActionsLib.PLM_STOCK_PREPARATION_ACTION_ID,
            source: { externalSystemId: `plm_s66_${label}_${TOKEN}`, kind: 'data-source:sql-readonly' },
            target: { sheetId: `sheet_env_s66_${label}_${TOKEN}`, objectId: 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} },
          }],
          stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: ['plm_stock_preparation_sandbox_synthetic_env'] },
          // The pilot readiness read (S9D-11's acknowledgement step) needs the two site facts answered.
          stockPreparationPilot: { specReadPlanSlot: 'not_applicable', customerPack: 'not_applicable' },
        },
      }
      const base = harnessLib.baseServices(sourceAdapter)
      const services = {
        ...base,
        externalSystemRegistry: { ...base.externalSystemRegistry, async listExternalSystems() { return [] } },
        pipelineRegistry: { ...base.pipelineRegistry, async listPipelines() { return [] } },
        stockPreparationProjectWriteLock: lock,
        stockPreparationProjectTargetStore: registry,
        stockPreparationAuditStore: audit,
        stockPreparationPackInstallStore: packInstallStoreLib.createStockPreparationPackInstallStore({ db }),
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
        stockPreparationContinuationStore: continuationStore,
        stockPreparationRefreshGovernance: refreshGovernanceLib.createStockPreparationRefreshGovernance({ continuationStore, projectTargetStore: registry, projectWriteLock: lock }),
        stockPreparationPullBatchStore: pullBatchStore,
        stockPreparationSheetRepairStore: repairStore,
        // S6-5's ruling ledger (migration 107): the remnant acknowledgement and readiness v5's remnant check.
        stockPreparationComponentRulingStore: componentRulingStoreLib.createStockPreparationComponentRulingStore({ db }),
      }
      httpRoutesLib.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
      const admin = { id: `u_s66_admin_${label}`, tenantId, permissions: ['stock-prep:admin'] }
      const handle: string = censusLib.__internals.componentHandle(tenantId, PROJECT, 'S-001')
      const call = (method: string, routePath: string, req: Record<string, unknown> = {}) => harnessLib.call(routes, method, routePath, { user: admin, params: { projectNo: PROJECT }, ...req })
      const repair = (body: Record<string, unknown>) => call('POST', PATHS.repair, { body: { confirmProjectNo: PROJECT, ...body } })
      const st = {
        tenantId, projectId, objectId, sheetId, fields, target, scopeKey, db, lock, repairStore, audit, pullBatchStore, multitable, hooks, patchInputs, source, handle, oldIds, copyIds, admin, call, repair,
        preview: (extra: Record<string, unknown> = {}) => repair({ mode: 'preview', recipe: RETIRE, componentHandle: handle, ...extra }),
        execute: (planDigest: string, extra: Record<string, unknown> = {}) => repair({ mode: 'execute', recipe: RETIRE, componentHandle: handle, planDigest, approvalRef: `R-91:s66-${label}`, ...extra }),
        // Every stored row of the sheet: its version and the canonical text of its data.
        async stored() {
          const { rows } = await q('SELECT id, version, data::text AS data FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])
          return new Map<string, { version: number; data: string }>(rows.map((row: any) => [String(row.id), { version: Number(row.version), data: String(row.data) }]))
        },
        async cells(recordId: string) {
          const { rows } = await q(
            `SELECT version, jsonb_typeof(data -> $2) AS active_type, data -> $2 AS active, data ->> $3 AS run_id, data ->> $4 AS decision, data ->> $5 AS summary
               FROM meta_records WHERE id = $1`,
            [recordId, fields.active, fields.lastPlmRefreshRunId, fields.lastPlmRefreshDecision, fields.lastPlmConflictSummary],
          )
          return rows[0]
        },
        // A person's edit of a human cell: the cell changes and the row's version moves.
        async humanEdit(recordId: string, text: string) {
          await q('UPDATE meta_records SET data = data || $2::jsonb, version = version + 1 WHERE id = $1', [recordId, JSON.stringify({ [fields.notes]: text })])
        },
        runs: async () => (await q(`SELECT * FROM ${RT.run} WHERE tenant_id = $1 ORDER BY sequence_no`, [tenantId])).rows,
        claims: async () => (await q(`SELECT * FROM ${RT.claim} WHERE tenant_id = $1 ORDER BY claimed_at`, [tenantId])).rows,
        // `created_at` is the transaction's NOW(): the rows of ONE transaction (a begin that closes an abandoned run and
        // starts its own) tie, so the mode breaks the tie (`…_abandoned` sorts before `…_started`) — never the random id.
        audits: async () => (await q(`SELECT action, mode, subject_id, project_id, actor, detail FROM ${AUDIT_TABLE} WHERE tenant_id = $1 ORDER BY created_at, mode`, [tenantId])).rows,
        lockRow: async () => (await q(`SELECT * FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [scopeKey])).rows[0] || null,
        readerRows: () => readExistingStockPreparationRows(multitable.records, target, PROJECT),
        /** Another process's lock module on the same table; `aheadMs` skews its clock (a holder whose lease it sees as lapsed). */
        otherLock: (aheadMs = 0) => createStockPreparationProjectWriteLock({ db: hostLikeDb(), ...(aheadMs ? { now: () => new Date(Date.now() + aheadMs) } : {}) }),
      }
      return st
    }

    const dataOf = (res: any) => {
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
      return res.body.data
    }
    const errorOf = (res: any, status: number, code: string) => {
      expect([res.statusCode, res.body && res.body.error && res.body.error.code], JSON.stringify(res.body)).toEqual([status, code])
      return res.body.error
    }
    const LAPSED = PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS + 60_000
    /**
     * A retire whose LAST patch landed and whose finish was then refused (a pull took the sheet over on another
     * process's clock): every planned row is written and the run is left `running`. Answers the open run's id; the
     * taker has released the sheet.
     */
    async function leaveRetireOpen(st: Awaited<ReturnType<typeof world>>, label: string): Promise<string> {
      const plan = dataOf(await st.preview())
      let taker: any = null
      st.hooks.afterPatch = async () => {
        if (st.patchInputs.length !== 4) return
        const other = st.otherLock(LAPSED)
        taker = other.createGuard(await other.acquire(st.scopeKey, { purpose: 'small_apply', runId: `syn-pull-${label}`, tenantId: st.tenantId }))
      }
      const lost = errorOf(await st.execute(plan.planDigest), 409, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
      expect([lost.details.written, lost.details.planned, lost.details.partial]).toEqual([4, 4, true])
      st.hooks.afterPatch = null
      expect(taker).not.toBeNull()
      await taker.release()
      return String((await st.runs())[0].id)
    }

    test('S9D-108 migration 108 is applied: both tables, the closed CHECKs, one open run per sheet, one claim per approved plan', async () => {
      for (const table of [RT.run, RT.claim]) expect((await q('SELECT to_regclass($1) AS oid', [table])).rows[0].oid, table).not.toBeNull()
      const columns = (await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [RT.run])).rows as Array<{ column_name: string; data_type: string }>
      const typeOf = (name: string) => (columns.find((column) => column.column_name === name) || { data_type: null }).data_type
      expect([typeOf('backup'), typeOf('sequence_no'), typeOf('planned_count'), typeOf('written_count'), typeOf('fencing_epoch'), typeOf('close_approval_ref')]).toEqual(['jsonb', 'integer', 'integer', 'integer', 'integer', 'text'])
      const tenantId = `tenant_s66_108_${TOKEN}`
      tenants.push(tenantId)
      const sheetId = `sheet_s66_108_${TOKEN}`
      const digest = 'a'.repeat(64)
      const backup = JSON.stringify([['rec_syn_1', 1, true, 'run_syn', 'add', '']])
      const insertRun = (overrides: Record<string, unknown> = {}) => {
        const row: Record<string, unknown> = {
          id: `run_s66_${Math.random().toString(36).slice(2)}`, tenant_id: tenantId, sheet_id: sheetId, project_no: 'SYN-108', write_scope_key: 'spw2:syn', recipe: RETIRE, sequence_no: 0, plan_digest: digest,
          approval_ref: 'R-91', component_handle: 'a'.repeat(24), source_run_id: null, backup, planned_count: 1, written_count: null, status: 'running', stop_reason: null, lease_id: 'lease_syn', fencing_epoch: 1,
          started_by: 'syn', finished_at: null, ...overrides,
        }
        const names = Object.keys(row)
        return q(`INSERT INTO ${RT.run} (${names.join(', ')}) VALUES (${names.map((name, index) => (name === 'backup' ? `$${index + 1}::jsonb` : `$${index + 1}`)).join(', ')})`, names.map((name) => row[name]))
      }
      const finished = { finished_at: new Date().toISOString() }
      await expectSqlState(insertRun({ recipe: 'delete_rows' }), '23514', 'integration_stock_prep_sheet_repair_run_recipe_check')
      await expectSqlState(insertRun({ status: 'paused' }), '23514')
      await expectSqlState(insertRun({ status: 'stopped', stop_reason: 'because', written_count: 0, ...finished }), '23514', 'integration_stock_prep_sheet_repair_run_stop_reason_check')
      await expectSqlState(insertRun({ status: 'completed', written_count: 1, finished_at: null }), '23514', 'integration_stock_prep_sheet_repair_run_open_check')
      await expectSqlState(insertRun({ status: 'stopped', stop_reason: null, written_count: 0, ...finished }), '23514', 'integration_stock_prep_sheet_repair_run_stop_check')
      await expectSqlState(insertRun({ component_handle: null }), '23514', 'integration_stock_prep_sheet_repair_run_subject_check')
      await expectSqlState(insertRun({ recipe: RESTORE }), '23514', 'integration_stock_prep_sheet_repair_run_subject_check')
      await expectSqlState(insertRun({ plan_digest: 'abc' }), '23514', 'integration_stock_prep_sheet_repair_run_digest_check')
      await expectSqlState(insertRun({ planned_count: 0 }), '23514', 'integration_stock_prep_sheet_repair_run_counts_check')
      await expectSqlState(insertRun({ planned_count: 2, status: 'completed', written_count: 1, ...finished }), '23514', 'integration_stock_prep_sheet_repair_run_written_check')
      await expectSqlState(insertRun({ status: 'stopped', stop_reason: 'version_conflict', written_count: null, ...finished }), '23514', 'integration_stock_prep_sheet_repair_run_written_check')
      // A close approval (the continuation's) only ever sits on a `completed` run.
      await expectSqlState(insertRun({ close_approval_ref: 'R-91:close' }), '23514', 'integration_stock_prep_sheet_repair_run_close_check')
      await expectSqlState(insertRun({ status: 'stopped', stop_reason: 'abandoned', close_approval_ref: 'R-91:close', ...finished }), '23514', 'integration_stock_prep_sheet_repair_run_close_check')
      // The shapes the store writes are accepted: an open run; a second open run of the SAME sheet is refused.
      await insertRun({ id: `run_s66_open_${TOKEN}` })
      await expectSqlState(insertRun({ sequence_no: 1 }), '23505', 'uniq_integration_stock_prep_sheet_repair_run_open')
      await q(`UPDATE ${RT.run} SET status = 'stopped', stop_reason = 'abandoned', finished_at = now() WHERE id = $1`, [`run_s66_open_${TOKEN}`])
      await expectSqlState(insertRun({ status: 'completed', written_count: 1, ...finished }), '23505', 'uniq_integration_stock_prep_sheet_repair_run_sequence')
      await insertRun({ sequence_no: 1, recipe: RESTORE, component_handle: null, source_run_id: `run_s66_open_${TOKEN}`, status: 'completed', written_count: 1, ...finished })
      // The shape the continuation writes: `completed` with its close approval.
      await insertRun({ sequence_no: 2, status: 'completed', written_count: 1, close_approval_ref: 'R-91:close', ...finished })
      // The claim key is the PRIMARY KEY.
      const insertClaim = (key: string) => q(`INSERT INTO ${RT.claim} (claim_key, tenant_id, sheet_id, project_no, recipe, plan_digest, run_id, approval_ref, claimed_by) VALUES ($1, $2, $3, 'SYN-108', $4, $5, 'run_syn', 'R-91', 'syn')`, [key, tenantId, sheetId, RETIRE, digest])
      await insertClaim(`claim_s66_${TOKEN}`)
      await expectSqlState(insertClaim(`claim_s66_${TOKEN}`), '23505', `${RT.claim}_pkey`)
      await expectSqlState(q(`INSERT INTO ${RT.claim} (claim_key, tenant_id, sheet_id, project_no, recipe, plan_digest, run_id, approval_ref, claimed_by) VALUES ($1, $2, $3, 'SYN-108', 'delete_rows', $4, 'run_syn', 'R-91', 'syn')`, [`claim_s66_b_${TOKEN}`, tenantId, sheetId, digest]), '23514', 'integration_stock_prep_sheet_repair_claim_recipe_check')
    })

    test('S9D-11 D1 -> retire -> acknowledgement -> a clean governed pull: the boolean false and three stamps on exactly the four old rows, the run / claim / audit rows, the lease released and bumped; readiness refuses the two-copy component before, the unacknowledged remnant after the retire, and neither after the acknowledgement; the governed planner suspended before and clean after', async () => {
      const st = await world('d11')
      // Readiness v5 (S6-5) as the pilot read answers it: the checks that FAIL for this project now.
      const failing = async () => {
        const res = await st.call('GET', PILOT_PATH)
        expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
        return res.body.data.readiness.failing as string[]
      }
      const governed = async () => {
        const expansion = await CF.expand(CF.secondPullSource({ sLine: false }))
        return CF.plan(expansion, await st.readerRows(), { continuation: CF.continuationInput({ pilot: true, demandEvidence: expansion.demandEvidence }) })
      }
      // Before: the doubled sheet suspends a governed pull (the copy's position is occupied while the old root is live).
      const suspended = await governed()
      expect([suspended.suspended, suspended.holds.map((hold: any) => hold.kind)]).toEqual([true, ['candidate_target_occupied']])
      expect(censusLib.publicCensusOf(censusLib.censusOfRows(await st.readerRows()))).toMatchObject({ twoCopyComponents: 1, inactiveRootRemnantComponents: 0 })
      const failingBefore = await failing()
      expect([failingBefore.includes('no_two_copy_component'), failingBefore.includes('no_unacknowledged_inactive_root_remnant')], 'D1: readiness refuses the two-copy component; there is no remnant yet').toEqual([true, false])
      const before = await st.stored()

      const plan = dataOf(await st.preview())
      expect([plan.eligible, plan.refusals, plan.sequence, plan.counts.oldRows, plan.counts.toRetire, plan.counts.pairs]).toEqual([true, [], 0, 4, 4, 4])
      expect(await st.runs()).toEqual([])
      expect(await st.lockRow(), 'a preview takes no lease').toBeNull()
      const done = dataOf(await st.execute(plan.planDigest))
      expect([done.status, done.planned, done.written, done.generationBumped, done.componentHandle]).toEqual(['completed', 4, 4, true, st.handle])
      expect(done.runId.startsWith(SHEET_REPAIR_RUN_ID_PREFIX)).toBe(true)

      // The sheet: the BOOLEAN false and the three stamps on the four old rows, version + 1 — nothing else moved.
      for (const id of st.oldIds) {
        const cells = await st.cells(id)
        expect([cells.active_type, cells.active, cells.run_id, cells.decision, cells.summary, Number(cells.version)]).toEqual(['boolean', false, done.runId, 'inactive', SHEET_REPAIR_RETIRE_SUMMARY, before.get(id)!.version + 1])
      }
      const after = await st.stored()
      for (const id of st.copyIds) expect(after.get(id), 'the copies and the parent are untouched').toEqual(before.get(id))
      expect(st.patchInputs.map((input) => [st.oldIds.includes(input.recordId), Object.keys(input.changes).sort(), typeof input.expectedVersion, Boolean(input.writeFence)])).toEqual(
        Array(4).fill([true, [st.fields.active, st.fields.lastPlmConflictSummary, st.fields.lastPlmRefreshDecision, st.fields.lastPlmRefreshRunId].sort(), 'number', true]),
      )
      // The host's own trail: one revision per patched record at the new version (the create wrote version 1), none for
      // any other row.
      const revisions = (await q('SELECT record_id, version FROM meta_record_revisions WHERE sheet_id = $1 AND version > 1 ORDER BY record_id', [st.sheetId])).rows
      expect(revisions.map((row: any) => [String(row.record_id), Number(row.version)]).sort()).toEqual(st.oldIds.map((id) => [id, before.get(id)!.version + 1]).sort())
      // The ledger: the run row with its backup, the claim, both audit rows — and the lock.
      const run = (await st.runs())[0]
      expect([run.id, run.status, run.stop_reason, run.recipe, run.sequence_no, run.planned_count, run.written_count, run.plan_digest, run.component_handle, run.write_scope_key, run.started_by, run.project_no])
        .toEqual([done.runId, 'completed', null, RETIRE, 0, 4, 4, plan.planDigest, st.handle, st.scopeKey, st.admin.id, PROJECT])
      expect(run.backup.map((entry: any[]) => [st.oldIds.includes(entry[0]), entry[1], entry[2], entry[3], entry[4], entry[5]])).toEqual(Array(4).fill([true, 1, true, SMALL_LANE_RUN_ID, 'add', '']))
      expect((await st.claims()).map((claim: any) => [claim.run_id, claim.plan_digest, claim.recipe, claim.approval_ref])).toEqual([[done.runId, plan.planDigest, RETIRE, 'R-91:s66-d11']])
      const audits = await st.audits()
      expect(audits.map((row: any) => [row.action, row.mode, row.subject_id, row.project_id, row.actor])).toEqual([
        ['project_board_read', 'sheet_repair_preview_read', null, null, st.admin.id],
        ['exception_resolve', 'sheet_repair_started', done.runId, PROJECT, st.admin.id],
        ['exception_resolve', 'sheet_repair_completed', done.runId, PROJECT, st.admin.id],
      ])
      expect(JSON.stringify(audits.map((row: any) => row.detail)).includes(PROJECT)).toBe(false)
      const lockRow = await st.lockRow()
      expect([lockRow.lease_id, lockRow.generation_reason, Number(lockRow.generation)]).toEqual([null, 'sheet_repair', 1])
      // The rollback stop condition of migration 108's header: no open run.
      expect(Number((await q(`SELECT count(*)::int AS n FROM ${RT.run} WHERE status = 'running' AND tenant_id = $1`, [st.tenantId])).rows[0].n)).toBe(0)

      // After: the census reads an inactive-root remnant; the governed computation over the rows PostgreSQL holds is clean.
      expect(censusLib.publicCensusOf(censusLib.censusOfRows(await st.readerRows()))).toMatchObject({ twoCopyComponents: 0, inactiveRootRemnantComponents: 1 })
      // THE ACKNOWLEDGEMENT (design §10 S9D-11; S6-5's route over migration 107). The retire turned readiness's
      // two-copy refusal into the unacknowledged-remnant one; the admin's acknowledgement of that component — the SAME
      // private handle the repair named — lifts exactly that check. It writes the ruling ledger, never the sheet.
      const failingAfterRetire = await failing()
      expect([failingAfterRetire.includes('no_two_copy_component'), failingAfterRetire.includes('no_unacknowledged_inactive_root_remnant')], 'D2: the two-copy refusal is gone; the remnant is not acknowledged yet').toEqual([false, true])
      const sheetBeforeAck = await st.stored()
      const ack = await st.call('POST', ACKNOWLEDGE_PATH, { body: { confirmProjectNo: PROJECT, componentHandle: st.handle, basis: 'head_not_ordered', runbookRef: 'R-91.s66-d11', acknowledge: { customerAnswered: true } } })
      expect(ack.statusCode, JSON.stringify(ack.body)).toBe(201)
      const rulings = (await q(`SELECT id, project_no, component_digest, kind, status, recorded_by FROM ${RULING_TABLE} WHERE tenant_id = $1`, [st.tenantId])).rows
      expect(rulings).toEqual([{ id: ack.body.data.acknowledgementId, project_no: PROJECT, component_digest: st.handle, kind: 'remnant_acknowledged', status: 'active', recorded_by: st.admin.id }])
      const failingAfterAck = await failing()
      expect([failingAfterAck.includes('no_two_copy_component'), failingAfterAck.includes('no_unacknowledged_inactive_root_remnant')], 'acknowledged: neither doubled-sheet check refuses the pilot now').toEqual([false, false])
      expect(await st.stored(), 'the acknowledgement wrote no sheet row').toEqual(sheetBeforeAck)
      const clean = await governed()
      expect([clean.suspended, clean.holds]).toEqual([false, []])
      const touched = clean.decisions.filter((decision: any) => ['add', 'update', 'inactive'].includes(decision.decision)).map((decision: any) => decision.decision)
      expect(touched, 'the next governed pull writes nothing: the copies are unchanged and the retired rows are skipped').toEqual([])
      expect(clean.decisions.filter((decision: any) => decision.conflictSummary && decision.conflictSummary.type === 'already_inactive')).toHaveLength(4)
      // And a retire has nothing left of that shape.
      const again = dataOf(await st.preview())
      expect([again.eligible, again.shape, again.refusals]).toEqual([false, 'inactive_root_remnant', ['not_two_copy']])
    }, 120_000)

    test('S9D-12 backup -> retire -> restore: a moved row with its stamp intact is restored at its CURRENT version; every stored row is byte-identical to before the retire', async () => {
      const st = await world('d12')
      const before = await st.stored()
      const retired = dataOf(await st.execute(dataOf(await st.preview()).planDigest))
      // A person fills a human cell of one hidden old row after the retire.
      const edited = st.oldIds[2]
      await st.humanEdit(edited, 'typed after the retire')
      const plan = dataOf(await st.repair({ mode: 'preview', recipe: RESTORE, runId: retired.runId }))
      expect([plan.eligible, plan.refusals, plan.sequence, plan.sourceRunId]).toEqual([true, [], 1, retired.runId])
      expect(plan.counts).toEqual({ backupRows: 4, toRestore: 4, versionMovedStampIntact: 1, notRetired: 0, revived: 0, restamped: 0, missing: 0, unaddressable: 0 })
      st.patchInputs.length = 0
      const restored = dataOf(await st.repair({ mode: 'execute', recipe: RESTORE, runId: retired.runId, planDigest: plan.planDigest, approvalRef: 'R-91:s66-d12-restore' }))
      expect([restored.status, restored.planned, restored.written, restored.sourceRunId, restored.generationBumped]).toEqual(['completed', 4, 4, retired.runId, true])
      // Each patch named the row's CURRENT version — the edited row's is one higher than the retire left it.
      expect(new Map(st.patchInputs.map((input) => [input.recordId, input.expectedVersion]))).toEqual(new Map(st.oldIds.map((id) => [id, before.get(id)!.version + (id === edited ? 2 : 1)])))
      const after = await st.stored()
      for (const [id, row] of before.entries()) {
        if (id === edited) {
          expect(after.get(id)!.version).toBe(row.version + 3)
          const data = JSON.parse(after.get(id)!.data)
          expect(data[st.fields.notes]).toBe('typed after the retire')
          delete data[st.fields.notes]
          const original = JSON.parse(row.data)
          delete original[st.fields.notes]
          expect(data, 'the four cells are back; the person\'s edit survives').toEqual(original)
        } else {
          expect(after.get(id)!.data, `${st.oldIds.includes(id) ? 'old' : 'copy'} row: byte-identical`).toBe(row.data)
          expect(after.get(id)!.version).toBe(row.version + (st.oldIds.includes(id) ? 2 : 0))
        }
      }
      for (const id of st.oldIds) expect((await st.cells(id)).active_type).toBe('boolean')
      expect((await st.runs()).map((run: any) => [run.recipe, run.status, run.sequence_no, run.source_run_id, run.written_count])).toEqual([[RETIRE, 'completed', 0, null, 4], [RESTORE, 'completed', 1, retired.runId, 4]])
      expect((await st.claims()).map((claim: any) => claim.approval_ref).sort()).toEqual(['R-91:s66-d12', 'R-91:s66-d12-restore'])
      // The sheet is D1 again, and the restore itself is spent.
      expect(censusLib.publicCensusOf(censusLib.censusOfRows(await st.readerRows()))).toMatchObject({ twoCopyComponents: 1, inactiveRootRemnantComponents: 0 })
      errorOf(await st.repair({ mode: 'execute', recipe: RESTORE, runId: retired.runId, planDigest: plan.planDigest, approvalRef: 'R-91:s66-d12-restore' }), 409, CODES.ALREADY_CONSUMED)
    }, 120_000)

    test('S9D-13 a person\'s edit while the run writes stops it; the spent digest is ALREADY_CONSUMED; the re-run needs a NEW digest and its own claim', async () => {
      const st = await world('d13')
      const plan = dataOf(await st.preview())
      // After the first patch landed: a person edits a row the run has not reached yet.
      let patched = 0
      let victim: string | null = null
      st.hooks.afterPatch = async (input) => {
        patched += 1
        if (patched !== 1) return
        victim = st.oldIds.find((id) => id !== input.recordId && !st.patchInputs.some((seen) => seen.recordId === id)) || null
        const next = st.oldIds.filter((id) => id !== input.recordId)
        for (const id of next) await st.humanEdit(id, 'typed during the run')
      }
      const stop = errorOf(await st.execute(plan.planDigest), 409, CODES.STOPPED)
      expect([stop.details.reason, stop.details.planned, stop.details.written, stop.details.partial]).toEqual(['version_conflict', 4, 1, true])
      expect(victim).not.toBeNull()
      expect(st.patchInputs.length, 'the conflicting row was tried once; nothing after it').toBe(2)
      const run = (await st.runs())[0]
      expect([run.status, run.stop_reason, run.written_count, run.planned_count]).toEqual(['stopped', 'version_conflict', 1, 4])
      expect((await st.audits()).map((row: any) => row.mode)).toEqual(['sheet_repair_preview_read', 'sheet_repair_started', 'sheet_repair_stopped'])
      expect((await st.lockRow()).generation_reason, 'a run that wrote bumps the generation even when it stopped').toBe('sheet_repair')
      st.hooks.afterPatch = null
      errorOf(await st.execute(plan.planDigest), 409, CODES.ALREADY_CONSUMED)
      const next = dataOf(await st.preview())
      expect([next.eligible, next.sequence, next.counts.toRetire, next.counts.alreadyRetired, next.counts.pairs]).toEqual([true, 1, 3, 1, 4])
      expect(next.planDigest).not.toBe(plan.planDigest)
      const rerun = dataOf(await st.execute(next.planDigest, { approvalRef: 'R-91:s66-d13-rerun' }))
      expect([rerun.status, rerun.planned, rerun.written]).toEqual(['completed', 3, 3])
      for (const id of st.oldIds) expect((await st.cells(id)).active).toBe(false)
      expect((await st.claims()).map((claim: any) => claim.approval_ref).sort()).toEqual(['R-91:s66-d13', 'R-91:s66-d13-rerun'])
    }, 120_000)

    test('S9D-14 the digest: a row edited between the preview and the execute => 409 PLAN_CHANGED in the lease, nothing begun, nothing written', async () => {
      const st = await world('d14')
      const plan = dataOf(await st.preview())
      await st.humanEdit(st.oldIds[1], 'typed between preview and execute')
      const before = await st.stored()
      const error = errorOf(await st.execute(plan.planDigest), 409, CODES.PLAN_CHANGED)
      expect([error.details.reason, error.details.partial]).toEqual(['plan_digest_differs', false])
      expect([await st.runs(), await st.claims(), st.patchInputs.length]).toEqual([[], [], 0])
      expect(await st.stored()).toEqual(before)
      const lockRow = await st.lockRow()
      expect([lockRow.lease_id, lockRow.generation_reason], 'the lease was taken for the recompute and released; no bump').toEqual([null, null])
      // A digest that was never previewed is the same refusal.
      errorOf(await st.execute('f'.repeat(64)), 409, CODES.PLAN_CHANGED)
      expect(await st.runs()).toEqual([])
    }, 120_000)

    test('S9D-15 one sheet, one writer: a pull, a recovery or an install holding the lease refuses the repair; the repair holding it refuses a pull; an installing sheet is refused inside the lease', async () => {
      const st = await world('d15')
      const plan = dataOf(await st.preview())
      // (a) Someone else holds the sheet.
      for (const purpose of ['small_apply', 'recovery_verify', 'pull_batch_install']) {
        const other = st.otherLock()
        const holder = other.createGuard(await other.acquire(st.scopeKey, { purpose, runId: `syn-${purpose}`, tenantId: st.tenantId }))
        try {
          expect(errorOf(await st.preview(), 409, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED).details.holderPurpose).toBe(purpose)
          expect(errorOf(await st.execute(plan.planDigest), 409, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED).details.holderPurpose).toBe(purpose)
          expect([await st.runs(), await st.claims(), st.patchInputs.length], `${purpose}: nothing of the repair ran`).toEqual([[], [], 0])
          expect((await st.lockRow()).lease_purpose).toBe(purpose)
        } finally {
          await holder.release()
        }
      }
      // (b) The repair holds the sheet (frozen before its first patch): a pull cannot take the lease, and a write
      // carrying another lease's fence is refused by the host.
      const frozen = deferred()
      const reached = deferred()
      st.hooks.beforePatch = async () => {
        if (st.patchInputs.length !== 1) return
        reached.resolve()
        await frozen.promise
      }
      const running = st.execute(plan.planDigest)
      await reached.promise
      const pull = st.otherLock()
      const refused = await caught(pull.withProjectWriteLease(st.scopeKey, { purpose: 'small_apply', runId: 'syn-pull', tenantId: st.tenantId }, async () => 'ran'))
      expect([refused && refused.code, refused && refused.details.holderPurpose]).toEqual([PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 'sheet_repair'])
      expect((await st.lockRow()).lease_purpose).toBe('sheet_repair')
      const open = (await st.runs())[0]
      expect([open.status, open.lease_id], 'the open run names the lease that runs it').toEqual(['running', (await st.lockRow()).lease_id])
      frozen.resolve()
      expect(dataOf(await running).status).toBe('completed')
      st.hooks.beforePatch = null

      // (c) The install gate (rebaseline B-9; coordinator ruling C-2) is read from the batch ledger WHATEVER the batch
      // switch says. This file runs with the switch OFF: an `installing` sheet row still refuses the repair INSIDE the
      // lease (verifier probe VR-IO: before the ruling the same world previewed eligible and completed).
      const inst = await world('d15i')
      expect(process.env[PULL_BATCH_SWITCH], 'the batch identifier is switched OFF').toBeUndefined()
      const ok = dataOf(await inst.preview())
      expect(ok.eligible, 'no ledger row: the batch identifier never touched this sheet').toBe(true)
      const sheetRowId = `pbs_s66_${TOKEN}`
      await q(
        `INSERT INTO ${BI_SHEET_TABLE} (id, tenant_id, sheet_id, project_no, history_status, label_locale, first_pull_batch_rule, label_format, settings_locked_at)
         VALUES ($1, $2, $3, $4, 'installing', 'zh-CN', 'predecessor_suffix', 'ordinal_date', now())`,
        [sheetRowId, inst.tenantId, inst.sheetId, PROJECT],
      )
      const blockedPreview = dataOf(await inst.preview())
      expect([blockedPreview.eligible, blockedPreview.refusals, blockedPreview.planDigest]).toEqual([false, ['install_in_progress'], null])
      const error = errorOf(await inst.execute(ok.planDigest), 409, CODES.INSTALL_IN_PROGRESS)
      expect([error.details.reason, error.details.partial]).toEqual(['install_in_progress', false])
      expect([await inst.runs(), await inst.claims(), inst.patchInputs.length, (await inst.lockRow()).lease_id]).toEqual([[], [], 0, null])
      // That first install is ABORTED: the row is `pending` again and still carries its persisted plan (here with its
      // settings lock held as well). Its next run RESUMES that plan whenever one of its labels is on the sheet: refused
      // under the same code, naming the state.
      await q(`UPDATE ${BI_SHEET_TABLE} SET history_status = 'pending', history_plan = '{"aborted": true}'::jsonb WHERE id = $1`, [sheetRowId])
      const heldPreview = dataOf(await inst.preview())
      expect([heldPreview.eligible, heldPreview.refusals]).toEqual([false, ['install_aborted_unresolved']])
      const held = errorOf(await inst.execute(ok.planDigest), 409, CODES.INSTALL_IN_PROGRESS)
      expect([held.details.reason, held.details.partial]).toEqual(['install_aborted_unresolved', false])
      expect([await inst.runs(), await inst.claims(), inst.patchInputs.length]).toEqual([[], [], 0])
      const untouched = (await q(`SELECT history_status, version, settings_locked_at IS NOT NULL AS locked FROM ${BI_SHEET_TABLE} WHERE id = $1`, [sheetRowId])).rows[0]
      expect([untouched.history_status, Number(untouched.version), untouched.locked], 'the repair never writes the batch ledger').toEqual(['pending', 0, true])
      // An abort that RELEASED the lock (no label of the plan was on the sheet THEN), the plan still on the row: refused
      // all the same (ruling C-2 — the ledger shows the plan; it cannot show whether a labelled row has come back since).
      await q(`UPDATE ${BI_SHEET_TABLE} SET settings_locked_at = NULL WHERE id = $1`, [sheetRowId])
      const keptPreview = dataOf(await inst.preview())
      expect([keptPreview.eligible, keptPreview.refusals], 'the persisted plan alone').toEqual([false, ['install_aborted_unresolved']])
      const kept = errorOf(await inst.execute(ok.planDigest), 409, CODES.INSTALL_IN_PROGRESS)
      expect([kept.details.reason, kept.details.partial]).toEqual(['install_aborted_unresolved', false])
      // The plan's DIGEST alone is a persisted plan too, and so is the settings lock alone.
      await q(`UPDATE ${BI_SHEET_TABLE} SET history_plan = NULL, history_plan_digest = $2 WHERE id = $1`, [sheetRowId, 'd'.repeat(64)])
      expect(dataOf(await inst.preview()).refusals, 'the digest alone').toEqual(['install_aborted_unresolved'])
      await q(`UPDATE ${BI_SHEET_TABLE} SET history_plan_digest = NULL, settings_locked_at = now() WHERE id = $1`, [sheetRowId])
      expect(dataOf(await inst.preview()).refusals, 'the lock alone').toEqual(['install_aborted_unresolved'])
      expect(errorOf(await inst.execute(ok.planDigest), 409, CODES.INSTALL_IN_PROGRESS).details.reason).toBe('install_aborted_unresolved')
      expect([await inst.runs(), await inst.claims(), inst.patchInputs.length, (await inst.lockRow()).lease_id]).toEqual([[], [], 0, null])
      // A pending sheet with NEITHER a plan nor a lock (never installed: its first install plans from the rows as they
      // are then) is repairable.
      await q(`UPDATE ${BI_SHEET_TABLE} SET settings_locked_at = NULL WHERE id = $1`, [sheetRowId])
      const bare = (await q(`SELECT history_status, history_plan IS NULL AS no_plan, history_plan_digest IS NULL AS no_digest, settings_locked_at IS NULL AS no_lock FROM ${BI_SHEET_TABLE} WHERE id = $1`, [sheetRowId])).rows[0]
      expect([bare.history_status, bare.no_plan, bare.no_digest, bare.no_lock]).toEqual(['pending', true, true, true])
      expect(dataOf(await inst.preview()).eligible).toBe(true)
      // With the batch identifier ON the gate answers the same; resolved, the SAME approved digest runs.
      process.env[PULL_BATCH_SWITCH] = 'true'
      try {
        await q(`UPDATE ${BI_SHEET_TABLE} SET history_status = 'installing', settings_locked_at = now() WHERE id = $1`, [sheetRowId])
        expect(errorOf(await inst.execute(ok.planDigest), 409, CODES.INSTALL_IN_PROGRESS).details.reason).toBe('install_in_progress')
        expect([await inst.runs(), await inst.claims(), inst.patchInputs.length, (await inst.lockRow()).lease_id]).toEqual([[], [], 0, null])
        await q(`UPDATE ${BI_SHEET_TABLE} SET history_status = 'backfilled', history_mode = 'inferred', history_batch_count = 2, resolved_at = now(), resolved_by = 'syn' WHERE id = $1`, [sheetRowId])
        expect(dataOf(await inst.execute(ok.planDigest)).status).toBe('completed')
      } finally {
        delete process.env[PULL_BATCH_SWITCH]
      }
    }, 180_000)

    test('S9D-16 takeover / zombie: the host fence refuses the zombie\'s next patch, its run stays open and is closed `abandoned` by the next run; a takeover after the last patch refuses the finish', async () => {
      const st = await world('d16')
      const plan = dataOf(await st.preview())
      // Before the SECOND patch reaches the host: the repair's lease lapses (another process's clock) and a pull takes
      // the sheet over.
      let taker: any = null
      st.hooks.beforePatch = async () => {
        if (st.patchInputs.length !== 2) return
        const other = st.otherLock(LAPSED)
        taker = other.createGuard(await other.acquire(st.scopeKey, { purpose: 'small_apply', runId: 'syn-pull-takeover', tenantId: st.tenantId }))
      }
      const lost = errorOf(await st.execute(plan.planDigest), 409, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
      expect([lost.details.written, lost.details.planned, lost.details.partial]).toEqual([1, 4, true])
      expect(taker).not.toBeNull()
      st.hooks.beforePatch = null
      const retiredNow = (await Promise.all(st.oldIds.map((id) => st.cells(id)))).filter((cells) => cells.active === false)
      expect(retiredNow, 'the host refused the fenced write: only the first patch landed').toHaveLength(1)
      const open = (await st.runs())[0]
      expect([open.status, open.written_count, open.finished_at]).toEqual(['running', null, null])
      expect((await st.lockRow()).lease_purpose).toBe('small_apply')
      // The rollback stop condition of migration 108's header sees the open run.
      const openRuns = async () => Number((await q(`SELECT count(*)::int AS n FROM ${RT.run} WHERE status = 'running' AND tenant_id = $1`, [st.tenantId])).rows[0].n)
      expect(await openRuns()).toBe(1)
      await taker.release()
      // The next repair run: it closes the open run in its own begin (lease identity, not a clock) and completes.
      const next = dataOf(await st.preview())
      expect([next.eligible, next.openRun, next.sequence, next.counts.toRetire, next.counts.alreadyRetired]).toEqual([true, true, 1, 3, 1])
      const rerun = dataOf(await st.execute(next.planDigest, { approvalRef: 'R-91:s66-d16-rerun' }))
      expect([rerun.status, rerun.written]).toEqual(['completed', 3])
      expect((await st.runs()).map((run: any) => [run.status, run.stop_reason, run.written_count])).toEqual([['stopped', 'abandoned', null], ['completed', null, 3]])
      expect(await openRuns()).toBe(0)
      expect((await st.audits()).map((row: any) => row.mode).filter((mode: string) => mode !== 'sheet_repair_preview_read')).toEqual(['sheet_repair_started', 'sheet_repair_abandoned', 'sheet_repair_started', 'sheet_repair_completed'])
      for (const id of st.oldIds) expect((await st.cells(id)).active).toBe(false)

      // A takeover AFTER the last patch landed: the finish's holder assert refuses; the run is never recorded completed.
      const late = await world('d16l')
      const latePlan = dataOf(await late.preview())
      let lateTaker: any = null
      late.hooks.afterPatch = async () => {
        if (late.patchInputs.length !== 4) return
        const other = late.otherLock(LAPSED)
        lateTaker = other.createGuard(await other.acquire(late.scopeKey, { purpose: 'small_apply', runId: 'syn-pull-late', tenantId: late.tenantId }))
      }
      const lateLost = errorOf(await late.execute(latePlan.planDigest), 409, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
      expect([lateLost.details.written, lateLost.details.planned, lateLost.details.partial]).toEqual([4, 4, true])
      expect((await late.runs()).map((run: any) => [run.status, run.written_count])).toEqual([['running', null]])
      expect((await late.audits()).map((row: any) => row.mode)).toEqual(['sheet_repair_preview_read', 'sheet_repair_started'])
      await lateTaker.release()
    }, 180_000)

    test('S9D-17 the one-shot claim on real row locks: of two begins of one approved plan the second waits, fails at the PRIMARY KEY and reads the claim back => ALREADY_CONSUMED; an audit row the real audit store refuses rolls the run and the claim back', async () => {
      const tenantId = `tenant_s66_d17_${TOKEN}`
      tenants.push(tenantId)
      const scope = { tenantId, sheetId: `sheet_s66_d17_${TOKEN}`, projectNo: 'SYN-D17' }
      const digest = 'd'.repeat(64)
      const newRunId = () => `${SHEET_REPAIR_RUN_ID_PREFIX}${require('node:crypto').randomUUID()}`
      const input = (extra: Record<string, unknown> = {}) => ({
        ...scope, runId: newRunId(), writeScopeKey: 'spw2:syn-d17', recipe: RETIRE, planDigest: digest, approvalRef: 'R-91:s66-d17', componentHandle: 'b'.repeat(24),
        backup: [['rec_syn_1', 1, true, 'run_syn', 'add', '']], plannedCount: 1, expectSequence: 0, lease: { leaseId: 'lease_syn_a', fencingEpoch: 1 }, startedBy: 'syn',
        holderWithin: async () => {}, auditWithin: async () => {}, ...extra,
      })
      // Session A is frozen at its COMMIT (its claim row inserted, not committed).
      const frozen = deferred()
      const reached = deferred()
      const storeA = createStockPreparationSheetRepairStore({ db: hostLikeDb(async (event) => {
        if (event.inTransaction && event.sql === 'COMMIT') {
          reached.resolve()
          await frozen.promise
        }
      }) })
      const storeB = createStockPreparationSheetRepairStore({ db: hostLikeDb() })
      const a = input()
      const beginA = storeA.beginRun(a)
      await reached.promise
      // Session B: the same approved plan, at the same moment — it queues behind A's uncommitted claim key.
      const b = input({ lease: { leaseId: 'lease_syn_b', fencingEpoch: 2 } })
      const beginB = caught(storeB.beginRun(b))
      await waitFor(() => someoneWaitsOn(RT.claim), 'session B to wait on the claim key')
      frozen.resolve()
      expect((await beginA).runId).toBe(a.runId)
      const refusal = await beginB
      expect([refusal && refusal.status, refusal && refusal.code, refusal && refusal.details.reason], 'PostgreSQL aborted B at the unique index; the claim was read back on a fresh handle').toEqual([409, CODES.ALREADY_CONSUMED, 'claim_consumed'])
      const runs = (await q(`SELECT id, status FROM ${RT.run} WHERE tenant_id = $1`, [tenantId])).rows
      const claims = (await q(`SELECT run_id FROM ${RT.claim} WHERE tenant_id = $1`, [tenantId])).rows
      expect([runs.map((row: any) => [row.id, row.status]), claims.map((row: any) => row.run_id)]).toEqual([[[a.runId, 'running']], [a.runId]])
      // Sequentially too: after A finished, a begin of the SAME plan at the right sequence dies at the claim key and
      // leaves no second run row.
      await storeB.finishRun({ ...scope, runId: a.runId, status: 'completed', writtenCount: 1, lease: { leaseId: 'lease_syn_a', fencingEpoch: 1 }, holderWithin: async () => {}, auditWithin: async () => {} })
      const again = await caught(storeB.beginRun(input({ expectSequence: 1, lease: { leaseId: 'lease_syn_c', fencingEpoch: 3 } })))
      expect([again && again.status, again && again.code]).toEqual([409, CODES.ALREADY_CONSUMED])
      expect(Number((await q(`SELECT count(*)::int AS n FROM ${RT.run} WHERE tenant_id = $1`, [tenantId])).rows[0].n)).toBe(1)

      // The audit row rides the begin's transaction: the REAL audit store refusing it rolls the run and the claim back;
      // an accepted one commits with them.
      const audit = auditStoreLib.createStockPreparationAuditStore({ db: hostLikeDb() })
      const auditWithin = (detailExtra: Record<string, unknown>) => (trx: any, entry: any) => audit.appendWithin(trx, { tenantId, projectId: scope.projectNo, action: 'exception_resolve', subjectId: entry.subjectId, mode: entry.mode, actor: 'syn', detail: { ...entry.detail, ...detailExtra } })
      const other = { ...scope, sheetId: `sheet_s66_d17b_${TOKEN}` }
      const refused = await caught(storeB.beginRun(input({ ...other, planDigest: 'e'.repeat(64), auditWithin: auditWithin({ note: 'a free-text note the values gate refuses' }) })))
      expect([refused && refused.status, refused && refused.code]).toEqual([422, 'AUDIT_DETAIL_INVALID'])
      expect(Number((await q(`SELECT count(*)::int AS n FROM ${RT.run} WHERE sheet_id = $1`, [other.sheetId])).rows[0].n)).toBe(0)
      expect(Number((await q(`SELECT count(*)::int AS n FROM ${RT.claim} WHERE sheet_id = $1`, [other.sheetId])).rows[0].n), 'no claim was spent on a run without its audit row').toBe(0)
      const accepted = await storeB.beginRun(input({ ...other, planDigest: 'e'.repeat(64), auditWithin: auditWithin({}) }))
      const auditRows = (await q(`SELECT action, mode, subject_id, project_id FROM ${AUDIT_TABLE} WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, accepted.runId])).rows
      expect(auditRows.map((row: any) => [row.action, row.mode, row.subject_id, row.project_id])).toEqual([['exception_resolve', 'sheet_repair_started', accepted.runId, scope.projectNo]])
    }, 120_000)

    test('S9D-18 the fills report through the route on real rows: the pair that carries the note is K2-carryable; audited; never the note', async () => {
      const st = await world('d18')
      const summary = dataOf(await st.call('GET', PATHS.fills))
      expect([summary.total, summary.components[0].componentHandle, summary.components[0].shape, summary.components[0].counts.pairs, summary.components[0].counts.k2Carryable, summary.components[0].counts.pairsWithFills]).toEqual([1, st.handle, 'two_copy', 4, 1, 1])
      const detail = dataOf(await st.call('GET', PATHS.fills, { query: { componentHandle: st.handle } }))
      expect([detail.pairs.length, detail.pairs[0].class, detail.pairs[0].fields.notes, st.oldIds.includes(detail.pairs[0].oldRecordId), st.copyIds.includes(detail.pairs[0].copyRecordId)]).toEqual([1, 'k2_carryable', { old: true, copy: false, state: 'carry' }, true, true])
      const text = JSON.stringify([summary, detail])
      for (const planted of ['synthetic note', PROJECT, 'S-001', 'P-001', st.tenantId, st.sheetId]) expect(text.includes(planted), `${planted} leaked`).toBe(false)
      const runs = dataOf(await st.call('GET', PATHS.runs))
      expect(runs).toEqual({ runs: [], truncated: false })
      expect((await st.audits()).map((row: any) => [row.action, row.mode, row.project_id])).toEqual([
        ['project_board_read', 'sheet_fills_report_read', null],
        ['project_board_read', 'sheet_fills_report_read', null],
        ['project_board_read', 'sheet_repair_runs_read', null],
      ])
      expect([st.patchInputs.length, await st.runs(), await st.lockRow(), st.source.reads], 'reads only: no write, no lease, no source read').toEqual([0, [], null, 0])
      // With the repair switch off the surface is gone (404) and the ledger is not read.
      delete process.env[STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV]
      try {
        for (const res of [await st.preview(), await st.call('GET', PATHS.fills), await st.call('GET', PATHS.runs)]) errorOf(res, 404, CODES.DISABLED)
      } finally {
        process.env[STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV] = 'true'
      }
    }, 120_000)

    test('S9D-19 (ruling C-1) the heartbeat N6 rule on real row locks: while the begin transaction, a host patch and the finish transaction hold the sheet lock row (3 s each), the lease heartbeating every 100 ms over autocommit statements with a 1.5 s statement_timeout (standing for the pool\'s 30 s) attempts no holder CAS and none fails; the run completes', async () => {
      const events: LockEvent[] = []
      const order: LockOrder = { n: 0 }
      const warnings: any[] = []
      const windows: LockWindow[] = []
      const st = await world('d19', {
        lock: () => createStockPreparationProjectWriteLock({ db: timedLockDb({ timeoutMs: 1500, events, order }), heartbeatMs: 100, logger: { warn: (msg: string, meta: unknown) => warnings.push({ msg, meta }), info() {}, error() {} } }),
        audit: (real: any) => ({
          ...real,
          // The begin's and the finish's audit append runs INSIDE the ledger transaction, after its holder assert took
          // the lock row FOR UPDATE: slowing it holds that row for 3 s.
          appendWithin: async (trx: any, entry: any) => {
            if (entry && (entry.mode === 'sheet_repair_started' || entry.mode === 'sheet_repair_completed')) {
              const w = openLockWindow(order, entry.mode)
              windows.push(w)
              await sleep(3000)
              closeLockWindow(order, w)
            }
            return real.appendWithin(trx, entry)
          },
        }),
      })
      const plan = dataOf(await st.preview())
      // Calibration: the in-lease source read takes 450 ms outside any bracket, so the heartbeat ticks before the begin.
      let armed = true
      let calibration: LockWindow | null = null
      st.hooks.onSourceRead = async () => {
        if (!armed) return
        armed = false
        const w = openLockWindow(order, 'source_read')
        await sleep(450)
        closeLockWindow(order, w)
        calibration = w
      }
      // The FIRST host patch is held inside its write transaction (after the fence took the lock row FOR SHARE) for 3 s:
      // another session holds that record's row lock.
      st.hooks.beforePatch = async (input: any) => {
        if (st.patchInputs.length !== 1) return
        const client = await poolManager.get().getInternalPool().connect()
        await client.query('BEGIN')
        await client.query('SELECT 1 FROM meta_records WHERE id = $1 FOR UPDATE', [input.recordId])
        const w = openLockWindow(order, 'host_patch_1')
        windows.push(w)
        setTimeout(() => {
          closeLockWindow(order, w)
          client.query('COMMIT').catch(() => {}).finally(() => client.release())
        }, 3000)
      }
      const res = await st.execute(plan.planDigest)
      st.hooks.beforePatch = null
      st.hooks.onSourceRead = null
      const done = dataOf(res)
      expect([done.status, done.written]).toEqual(['completed', 4])
      expect(windows.map((w) => w.mode)).toEqual(['sheet_repair_started', 'host_patch_1', 'sheet_repair_completed'])
      // Calibration: during the 450 ms source read — inside the lease, outside any bracket — the heartbeat DID tick.
      expect(calibration, 'the in-lease source read ran').not.toBeNull()
      expect(invokedIn(calibration as unknown as LockWindow, events).filter((e) => e.holderCas && e.ok).length, 'calibration: the lease heartbeat ticks while the repair holds the lease outside a bracket').toBeGreaterThan(0)
      for (const w of windows) {
        expect((w.closed || 0) - w.opened, `${w.mode}: the window was held`).toBeGreaterThanOrEqual(2900)
        // By program order, not by timestamps: no lock statement was INVOKED between the window's open and its close.
        expect(invokedIn(w, events).filter((e) => e.holderCas).length, `${w.mode}: no holder CAS attempted while the lock row was held`).toBe(0)
        expect(invokedIn(w, events).filter((e) => !e.ok).map((e) => [e.code, e.ms]), `${w.mode}: no lock statement failed`).toEqual([])
      }
      expect(events.filter((e) => !e.ok).map((e) => [e.code, e.ms]), 'no heartbeat queued behind the repair\'s own transaction and timed out').toEqual([])
      expect(warnings.filter((w: any) => /heartbeat failed/.test(w.msg)).length).toBe(0)
      expect((await st.runs()).map((run: any) => [run.status, run.written_count])).toEqual([['completed', 4]])
      for (const id of st.oldIds) expect((await st.cells(id)).active).toBe(false)
    }, 180_000)

    test('S9D-20 (ruling C-3) the dead end closed on the real stack: a run left `running` after every row was written is verified and finished `completed` — no row write, its own approval and audit row, the close transaction inside the bracket on real row locks, the bump; a moved row refuses with counts; a project governed since still closes', async () => {
      const events: LockEvent[] = []
      const order: LockOrder = { n: 0 }
      const windows: LockWindow[] = []
      const st = await world('d20', {
        lock: () => createStockPreparationProjectWriteLock({ db: timedLockDb({ timeoutMs: 1500, events, order }), heartbeatMs: 100, logger: { warn() {}, info() {}, error() {} } }),
        audit: (real: any) => ({
          ...real,
          appendWithin: async (trx: any, entry: any) => {
            if (entry && entry.mode === 'sheet_repair_verified_closed') {
              const w = openLockWindow(order, entry.mode)
              windows.push(w)
              await sleep(3000)
              closeLockWindow(order, w)
            }
            return real.appendWithin(trx, entry)
          },
        }),
      })
      const openRuns = async (tenantId: string) => Number((await q(`SELECT count(*)::int AS n FROM ${RT.run} WHERE status = 'running' AND tenant_id = $1`, [tenantId])).rows[0].n)
      const runId = await leaveRetireOpen(st, 'd20')
      // The dead end (verifier probe VR-DE): every old row retired, the run open, no retire of the component left.
      const open = (await st.runs())[0]
      expect([open.id, open.status, open.written_count, open.close_approval_ref]).toEqual([runId, 'running', null, null])
      for (const id of st.oldIds) expect((await st.cells(id)).active).toBe(false)
      expect(await openRuns(st.tenantId)).toBe(1)
      const named = dataOf(await st.preview())
      expect([named.eligible, named.refusals, named.openRun, named.shape]).toEqual([false, ['not_two_copy'], true, 'inactive_root_remnant'])
      expect((await st.lockRow()).generation_reason, 'the run never got its bump (the taker held the sheet)').toBeNull()
      const before = await st.stored()
      const revisionsBefore = Number((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1', [st.sheetId])).rows[0].n)
      st.patchInputs.length = 0
      // The preview of the continuation: counts and the close's OWN digest. No lease, no write.
      const closePlan = dataOf(await st.repair({ mode: 'preview', recipe: CLOSE, runId }))
      expect([closePlan.eligible, closePlan.refusals, closePlan.runId, closePlan.runRecipe, closePlan.governed]).toEqual([true, [], runId, RETIRE, false])
      expect(closePlan.counts).toEqual({ planned: 4, inTargetState: 4, versionMoved: 0, notWritten: 0, moved: 0, missing: 0 })
      expect(closePlan.planDigest).not.toBe(open.plan_digest)
      expect([(await st.runs())[0].status, (await st.lockRow()).lease_id]).toEqual(['running', null])
      // The execute.
      const closed = dataOf(await st.repair({ mode: 'execute', recipe: CLOSE, runId, planDigest: closePlan.planDigest, approvalRef: 'R-91:s66-d20-close' }))
      expect([closed.status, closed.runId, closed.runRecipe, closed.planned, closed.verified, closed.governed, closed.generationBumped]).toEqual(['completed', runId, RETIRE, 4, 4, false, true])
      // NO row write: every stored row byte-identical at its version, no patch, no new host revision.
      expect(await st.stored()).toEqual(before)
      expect(st.patchInputs.length).toBe(0)
      expect(Number((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1', [st.sheetId])).rows[0].n)).toBe(revisionsBefore)
      // The ledger: completed with its planned count, the close's approval beside the run's own, no second claim.
      const run = (await st.runs())[0]
      expect([run.status, run.stop_reason, run.written_count, run.planned_count, run.close_approval_ref, run.approval_ref, run.finished_at !== null]).toEqual(['completed', null, 4, 4, 'R-91:s66-d20-close', 'R-91:s66-d20', true])
      expect((await st.claims()).map((claim: any) => claim.run_id)).toEqual([runId])
      expect(await openRuns(st.tenantId), 'the rollback stop condition of migration 108 is back to 0').toBe(0)
      const writes = (await st.audits()).filter((row: any) => row.action === 'exception_resolve')
      expect(writes.map((row: any) => [row.mode, row.subject_id, row.project_id, row.actor])).toEqual([
        ['sheet_repair_started', runId, PROJECT, st.admin.id],
        ['sheet_repair_verified_closed', runId, PROJECT, st.admin.id],
      ])
      expect([writes[1].detail.operation, writes[1].detail.recipe, writes[1].detail.planned, writes[1].detail.verified, writes[1].detail.approvalRef, writes[1].detail.closeDigest, writes[1].detail.governed]).toEqual(['sheet_repair_verified_close', RETIRE, 4, 4, 'R-91:s66-d20-close', closePlan.planDigest, false])
      expect(JSON.stringify(writes.map((row: any) => row.detail)).includes(PROJECT)).toBe(false)
      const lockRow = await st.lockRow()
      expect([lockRow.lease_id, lockRow.generation_reason], 'released, then bumped — the bump the run never got').toEqual([null, 'sheet_repair'])
      // N6 on real row locks: the close transaction held the lock row for 3 s inside the bracket — no holder CAS was
      // attempted in that window and no lock statement failed in it.
      expect(windows.length).toBe(1)
      expect((windows[0].closed || 0) - windows[0].opened).toBeGreaterThanOrEqual(2900)
      expect(events.filter((e) => e.holderCas && e.ok && e.order <= windows[0].openedAt).length, 'calibration: this lock\'s holder CAS reaches the store').toBeGreaterThan(0)
      // By program order, not by timestamps: no lock statement was INVOKED while the close's transaction was open.
      expect(invokedIn(windows[0], events).filter((e) => e.holderCas).length, 'no holder CAS attempted while the close held the lock row').toBe(0)
      expect(invokedIn(windows[0], events).filter((e) => !e.ok).map((e) => [e.code, e.ms])).toEqual([])
      // One-shot by the run's own status; the run list shows how it was closed; the sheet is the repaired one.
      expect(errorOf(await st.repair({ mode: 'execute', recipe: CLOSE, runId, planDigest: closePlan.planDigest, approvalRef: 'R-91:s66-d20-close' }), 409, CODES.NOT_APPLICABLE).details.reasons).toEqual(['run_not_open'])
      expect(dataOf(await st.call('GET', PATHS.runs)).runs.map((entry: any) => [entry.runId, entry.status, entry.written, entry.approvalRef, entry.closeApprovalRef])).toEqual([[runId, 'completed', 4, 'R-91:s66-d20', 'R-91:s66-d20-close']])
      expect(censusLib.publicCensusOf(censusLib.censusOfRows(await st.readerRows()))).toMatchObject({ twoCopyComponents: 0, inactiveRootRemnantComponents: 1 })

      // A planned row MOVED since (a pull revived it): refused with counts, nothing closed, the run still open.
      const moved = await world('d20m')
      const movedRun = await leaveRetireOpen(moved, 'd20m')
      const good = dataOf(await moved.repair({ mode: 'preview', recipe: CLOSE, runId: movedRun }))
      expect(good.eligible).toBe(true)
      await q('UPDATE meta_records SET data = data || $2::jsonb, version = version + 1 WHERE id = $1', [moved.oldIds[1], JSON.stringify({ [moved.fields.active]: true, [moved.fields.lastPlmRefreshRunId]: 'table-action:syn-pull-2', [moved.fields.lastPlmRefreshDecision]: 'update', [moved.fields.lastPlmConflictSummary]: '{"type":"plm_system_refresh","changedFields":["material"]}' })])
      const refusedPreview = dataOf(await moved.repair({ mode: 'preview', recipe: CLOSE, runId: movedRun }))
      expect([refusedPreview.eligible, refusedPreview.refusals, refusedPreview.planDigest, refusedPreview.counts]).toEqual([false, ['rows_not_in_target_state'], null, { planned: 4, inTargetState: 3, versionMoved: 0, notWritten: 0, moved: 1, missing: 0 }])
      const refused = errorOf(await moved.repair({ mode: 'execute', recipe: CLOSE, runId: movedRun, planDigest: good.planDigest, approvalRef: 'R-91:s66-d20m-close' }), 409, CODES.NOT_APPLICABLE)
      expect([refused.details.reasons, { ...refused.details.counts }, refused.details.partial]).toEqual([['rows_not_in_target_state'], { planned: 4, inTargetState: 3, versionMoved: 0, notWritten: 0, moved: 1, missing: 0 }, false])
      const stillOpen = (await moved.runs())[0]
      expect([stillOpen.status, stillOpen.close_approval_ref, (await moved.lockRow()).lease_id, (await moved.lockRow()).generation_reason]).toEqual(['running', null, null, null])
      expect(await openRuns(moved.tenantId)).toBe(1)
      // Restoring the run is the other way out: its begin closes the open run and the rows still retired come back.
      const restorePlan = dataOf(await moved.repair({ mode: 'preview', recipe: RESTORE, runId: movedRun }))
      expect([restorePlan.eligible, restorePlan.counts.toRestore, restorePlan.counts.revived]).toEqual([true, 3, 1])
      expect(dataOf(await moved.repair({ mode: 'execute', recipe: RESTORE, runId: movedRun, planDigest: restorePlan.planDigest, approvalRef: 'R-91:s66-d20m-restore' })).status).toBe('completed')
      expect((await moved.runs()).map((entry: any) => [entry.recipe, entry.status, entry.stop_reason])).toEqual([[RETIRE, 'stopped', 'abandoned'], [RESTORE, 'completed', null]])
      expect(await openRuns(moved.tenantId)).toBe(0)

      // The project became GOVERNED since the run (the pilot marker set on its registry row): neither recipe can
      // begin, and the verified close still works.
      const gov = await world('d20g')
      const govRun = await leaveRetireOpen(gov, 'd20g')
      await q(`UPDATE ${REGISTRY_TABLE} SET pilot_enabled_at = now(), pilot_enabled_by = 'syn', pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2`, [gov.tenantId, PROJECT])
      expect(dataOf(await gov.preview()).refusals).toContain('project_governed')
      expect(dataOf(await gov.repair({ mode: 'preview', recipe: RESTORE, runId: govRun })).refusals).toEqual(['project_governed'])
      const govPlan = dataOf(await gov.repair({ mode: 'preview', recipe: CLOSE, runId: govRun }))
      expect([govPlan.eligible, govPlan.refusals, govPlan.governed]).toEqual([true, [], true])
      const govBefore = await gov.stored()
      const govClosed = dataOf(await gov.repair({ mode: 'execute', recipe: CLOSE, runId: govRun, planDigest: govPlan.planDigest, approvalRef: 'R-91:s66-d20g-close' }))
      expect([govClosed.status, govClosed.governed, govClosed.verified, govClosed.generationBumped]).toEqual(['completed', true, 4, true])
      expect(await gov.stored()).toEqual(govBefore)
      const govRow = (await gov.runs())[0]
      expect([govRow.status, govRow.close_approval_ref, (await gov.lockRow()).generation_reason]).toEqual(['completed', 'R-91:s66-d20g-close', 'sheet_repair'])
      expect(await openRuns(gov.tenantId)).toBe(0)
    }, 240_000)

    test('S9D-21 (ruling C-4) a guard already LOST before the begin (one heartbeat whose holder CAS failed in the store while the source was read, the lease row itself intact): refused before the claim is spent — no run row, no claim, no patch — and the same approved digest runs afterwards', async () => {
      const events: LockEvent[] = []
      let failNext = false
      const st = await world('d21', {
        lock: () => createStockPreparationProjectWriteLock({
          db: timedLockDb({ timeoutMs: 5000, events, shouldFail: () => { if (!failNext) return false; failNext = false; return true } }),
          heartbeatMs: 60,
          logger: { warn() {}, info() {}, error() {} },
        }),
      })
      const plan = dataOf(await st.preview())
      let armed = true
      st.hooks.onSourceRead = async () => {
        if (!armed) return
        armed = false
        failNext = true
        await sleep(400)
      }
      const refused = errorOf(await st.execute(plan.planDigest), 503, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
      st.hooks.onSourceRead = null
      expect(events.filter((e) => e.code === 'INJECTED').length, 'exactly one holder CAS was failed').toBe(1)
      expect([refused.details.written, refused.details.planned, refused.details.partial, refused.details.runId]).toEqual([0, 4, false, undefined])
      expect([await st.runs(), await st.claims(), st.patchInputs.length], 'the one-shot claim was NOT spent').toEqual([[], [], 0])
      const lockRow = await st.lockRow()
      expect([lockRow.lease_id, lockRow.generation_reason], 'released; nothing was attempted, so nothing was bumped').toEqual([null, null])
      // The approval is still good: the SAME digest runs.
      const done = dataOf(await st.execute(plan.planDigest))
      expect([done.status, done.written]).toEqual(['completed', 4])
      expect((await st.claims()).length).toBe(1)
    }, 120_000)

    test('S9D-22 the RESTORE\'s own digest on the real stack: a row a person edited between the restore\'s preview and its execute => 409 PLAN_CHANGED in the lease, nothing begun, nothing written; a restore run that began and wrote NOTHING leaves a NEW digest behind, and its execute puts every row back', async () => {
      const st = await world('d22')
      const before = await st.stored()
      const retired = dataOf(await st.execute(dataOf(await st.preview()).planDigest))
      const restore = (body: Record<string, unknown>) => st.repair({ recipe: RESTORE, runId: retired.runId, ...body })
      const plan = dataOf(await restore({ mode: 'preview' }))
      expect([plan.eligible, plan.sequence, plan.counts.toRestore, plan.counts.versionMovedStampIntact]).toEqual([true, 1, 4, 0])

      // (a) A person fills a human cell of one retired row AFTER the restore was previewed (and its digest approved):
      // the row's version moves, its retire stamp stays. The approved digest no longer names the sheet.
      const edited = st.oldIds[1]
      await st.humanEdit(edited, 'typed between the restore preview and its execute')
      const moved = await st.stored()
      const generationBefore = Number((await st.lockRow()).generation)
      st.patchInputs.length = 0
      const refused = errorOf(await restore({ mode: 'execute', planDigest: plan.planDigest, approvalRef: 'R-91:s66-d22-a' }), 409, CODES.PLAN_CHANGED)
      expect([refused.details.reason, refused.details.partial]).toEqual(['plan_digest_differs', false])
      expect([(await st.runs()).length, (await st.claims()).length, st.patchInputs.length], 'no restore run, no restore claim, no patch').toEqual([1, 1, 0])
      expect(await st.stored(), 'no stored row moved').toEqual(moved)
      const lockRow = await st.lockRow()
      expect([lockRow.lease_id, Number(lockRow.generation)], 'the lease was taken for the recompute and released; nothing was attempted, so nothing was bumped').toEqual([null, generationBefore])
      // The new preview covers the moved row at its CURRENT version: another digest, to be approved on its own.
      const next = dataOf(await restore({ mode: 'preview' }))
      expect([next.eligible, next.sequence, next.counts.toRestore, next.counts.versionMovedStampIntact]).toEqual([true, 1, 4, 1])
      expect(next.planDigest).not.toBe(plan.planDigest)

      // (b) A restore run that BEGAN and wrote nothing (its first patch fails inside the host): the sheet is as it was
      // and the approval is spent — but the run sequence moved, so the next preview is a NEW digest and the undo of
      // the retire is not dead-ended.
      st.hooks.beforePatch = async () => { throw Object.assign(new Error('host down'), { code: 'SYN_HOST_DOWN' }) }
      const stop = errorOf(await restore({ mode: 'execute', planDigest: next.planDigest, approvalRef: 'R-91:s66-d22-b' }), 409, CODES.STOPPED)
      expect([stop.details.reason, stop.details.planned, stop.details.written, stop.details.partial]).toEqual(['host_write_failed', 4, 0, false])
      st.hooks.beforePatch = null
      expect(await st.stored(), 'the stopped run wrote nothing').toEqual(moved)
      expect((await st.runs()).map((run: any) => [run.recipe, run.status, run.stop_reason, run.sequence_no, run.written_count])).toEqual([[RETIRE, 'completed', null, 0, 4], [RESTORE, 'stopped', 'host_write_failed', 1, 0]])
      errorOf(await restore({ mode: 'execute', planDigest: next.planDigest, approvalRef: 'R-91:s66-d22-b' }), 409, CODES.ALREADY_CONSUMED)
      const again = dataOf(await restore({ mode: 'preview' }))
      expect([again.eligible, again.sequence, again.counts.toRestore, again.counts.versionMovedStampIntact]).toEqual([true, 2, 4, 1])
      expect(again.planDigest, 'the same rows at the same versions, a NEW digest').not.toBe(next.planDigest)
      const done = dataOf(await restore({ mode: 'execute', planDigest: again.planDigest, approvalRef: 'R-91:s66-d22-c' }))
      expect([done.status, done.planned, done.written, done.sourceRunId]).toEqual(['completed', 4, 4, retired.runId])

      // Every stored row is what it was before the retire (version + 2); the edited row carries the person's edit
      // (version + 3) and nothing else differs on it.
      const after = await st.stored()
      for (const [id, row] of before.entries()) {
        if (id === edited) {
          expect(after.get(id)!.version).toBe(row.version + 3)
          const data = JSON.parse(after.get(id)!.data)
          expect(data[st.fields.notes]).toBe('typed between the restore preview and its execute')
          delete data[st.fields.notes]
          const original = JSON.parse(row.data)
          delete original[st.fields.notes]
          expect(data, 'the four cells are back; the person\'s edit survives').toEqual(original)
        } else {
          expect(after.get(id)!.data, `${st.oldIds.includes(id) ? 'old' : 'copy'} row: byte-identical`).toBe(row.data)
          expect(after.get(id)!.version).toBe(row.version + (st.oldIds.includes(id) ? 2 : 0))
        }
      }
      expect((await st.claims()).map((claim: any) => claim.approval_ref).sort(), 'the refused execute spent nothing; the stopped run and the completed one each spent their own').toEqual(['R-91:s66-d22', 'R-91:s66-d22-b', 'R-91:s66-d22-c'])
    }, 180_000)

    test('S9D-23 F-11 on both sides, on real rows: a row of the nested copy whose STORED `active` cell is not the JSON boolean true (the string \'false\', the number 0, JSON null, no cell at all) refuses the retire before any write — counted in the preview, 409 inside the lease; with the cell put right the same approved digest runs and the component is shown once', async () => {
      const st = await world('d23')
      const F = st.fields
      const idsWhere = async (ids: string[], field: string, value: string) =>
        (await q(`SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2) AND data ->> $3 = $4 ORDER BY id`, [st.sheetId, ids, field, value])).rows.map((row: any) => String(row.id))
      const copyRoots = await idsWhere(st.copyIds, F.componentSourceId, 'S-001')
      expect(copyRoots, 'the nested copy has one head row').toHaveLength(1)
      const copyChildren = await idsWhere(st.copyIds, F.parentSourceId, 'S-001')
      expect(copyChildren.length, 'the nested copy has child rows').toBeGreaterThan(0)
      const activeTypeOf = async (id: string) => (await q('SELECT jsonb_typeof(data -> $2) AS t FROM meta_records WHERE id = $1', [id, F.active])).rows[0].t
      const setActive = (id: string, value: unknown) => q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [id, JSON.stringify({ [F.active]: value })])
      const dropActive = (id: string) => q('UPDATE meta_records SET data = data - $2::text WHERE id = $1', [id, F.active])

      const ok = dataOf(await st.preview())
      expect([ok.eligible, ok.refusals, ok.counts.copyRowsNotBooleanActive, ok.counts.pairs]).toEqual([true, [], 0, 4])
      for (const [label, id, arrange, storedType] of [
        ['the string false on the copy\'s head', copyRoots[0], (target: string) => setActive(target, 'false'), 'string'],
        ['the number 0 on the copy\'s head', copyRoots[0], (target: string) => setActive(target, 0), 'number'],
        ['JSON null on the copy\'s head', copyRoots[0], (target: string) => setActive(target, null), 'null'],
        ['no cell at all on the copy\'s head', copyRoots[0], (target: string) => dropActive(target), null],
        ['the string false on a copy child', copyChildren[0], (target: string) => setActive(target, 'false'), 'string'],
      ] as Array<[string, string, (target: string) => Promise<unknown>, string | null]>) {
        await arrange(id)
        expect(await activeTypeOf(id), label).toBe(storedType)
        const before = await st.stored()
        const refused = dataOf(await st.preview())
        expect([refused.eligible, refused.refusals, refused.planDigest, refused.counts.copyRowsNotBooleanActive, refused.counts.pairs], label).toEqual([false, ['copy_row_active_not_boolean'], null, 1, 4])
        // The digest approved while the sheet was clean runs nothing now: the in-lease recompute refuses by the precondition.
        const error = errorOf(await st.execute(ok.planDigest), 409, CODES.NOT_APPLICABLE)
        expect([error.details.reasons, error.details.counts.copyRowsNotBooleanActive, error.details.partial], label).toEqual([['copy_row_active_not_boolean'], 1, false])
        expect([await st.runs(), await st.claims(), st.patchInputs.length], `${label}: nothing begun, nothing written`).toEqual([[], [], 0])
        expect(await st.stored(), label).toEqual(before)
        await setActive(id, true)
        expect(await activeTypeOf(id)).toBe('boolean')
      }
      // Every copy row holds the boolean true again: the SAME approved digest (a copy cell is not in it, and no version
      // moved) retires the old subtree.
      const again = dataOf(await st.preview())
      expect([again.eligible, again.counts.copyRowsNotBooleanActive, again.planDigest]).toEqual([true, 0, ok.planDigest])
      const done = dataOf(await st.execute(ok.planDigest))
      expect([done.status, done.planned, done.written]).toEqual(['completed', 4, 4])
      const activeOf = async (ids: string[]) => (await q(`SELECT jsonb_typeof(data -> $2) AS t, data -> $2 AS v FROM meta_records WHERE id = ANY($1) ORDER BY id`, [ids, F.active])).rows.map((row: any) => [row.t, row.v])
      expect(await activeOf(copyRoots.concat(copyChildren)), 'the copy the retire left live: the boolean true on every row').toEqual(copyRoots.concat(copyChildren).map(() => ['boolean', true]))
      expect(await activeOf(st.oldIds), 'the retired old subtree: the boolean false on every row').toEqual(st.oldIds.map(() => ['boolean', false]))
    }, 180_000)

    test('S9D-24 what a backup may hold, on real rows: an old row whose STORED stamp cell is no known writer\'s — a part id or an unknown writer\'s run id in the run-id cell, a summary of an unknown type, a summary whose text carries a duplicated key — refuses the retire before any write, so nothing of it is stored; another WRITER\'s stamp (the large lane\'s run id, an UPDATE\'s summary) is stored as read and put back byte for byte by the restore — and no answer of the retire or of its restore (the previews, a STOPPED refusal of each, the execute answers) carries either cell', async () => {
      const st = await world('d24')
      const F = st.fields
      const cellOf = async (id: string, field: string) => (await q('SELECT data ->> $2 AS v FROM meta_records WHERE id = $1', [id, field])).rows[0].v as string | null
      const setCells = (id: string, cells: Record<string, unknown>) => q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [id, JSON.stringify(cells)])
      const ok = dataOf(await st.preview())
      expect([ok.eligible, ok.refusals, ok.counts.notMachineShaped]).toEqual([true, [], 0])

      // (a) A cell that is no known writer's — sitting in a stamp column of a row the retire would WRITE (and so back up).
      const victim = st.oldIds[1]
      for (const [label, field, value] of [
        ['a part id in the run-id cell', F.lastPlmRefreshRunId, 'S-001'],
        ['the run id of no known writer in the run-id cell', F.lastPlmRefreshRunId, CF.RUN_ID],
        ['a summary of an unknown type', F.lastPlmConflictSummary, '{"type":"note","drawing":"D100-01-03","by":"zhang.san"}'],
        ['a summary whose text carries a duplicated key', F.lastPlmConflictSummary, '{"type":"synthetic free text","type":"missing_from_plm"}'],
      ] as Array<[string, string, string]>) {
        const original = await cellOf(victim, field)
        await setCells(victim, { [field]: value })
        expect(await cellOf(victim, field), `${label}: stored as planted`).toBe(value)
        const before = await st.stored()
        const refused = dataOf(await st.preview())
        expect([refused.eligible, refused.refusals, refused.planDigest, refused.counts.notMachineShaped, refused.counts.toRetire], label).toEqual([false, ['row_not_machine_shaped'], null, 1, 4])
        // The digest approved while the sheet was clean runs nothing now: the recompute inside the lease refuses.
        const error = errorOf(await st.execute(ok.planDigest), 409, CODES.NOT_APPLICABLE)
        expect([error.details.reasons, error.details.counts.notMachineShaped, error.details.partial], label).toEqual([['row_not_machine_shaped'], 1, false])
        expect([await st.runs(), await st.claims(), st.patchInputs.length], `${label}: no run row — so no backup — no claim, no patch`).toEqual([[], [], 0])
        expect(await st.stored(), label).toEqual(before)
        for (const answer of [refused, error]) expect([value, 'D100-01-03', 'zhang.san'].some((planted) => JSON.stringify(answer).includes(planted)), `${label}: the refusal is values-free`).toBe(false)
        await setCells(victim, { [field]: original })
      }

      // (b) ANOTHER WRITER'S stamp on one old row — the large lane's run id, an UPDATE's decision and its summary: a
      // cell the plugin itself produces, so the row is planned and the cells are stored AS READ.
      const stamped = st.oldIds[2]
      const largeLane = { [F.lastPlmRefreshRunId]: 'large-bom:large-bom-expansion-0f8fad5b-d9cb-469f-a165-70867728950e', [F.lastPlmRefreshDecision]: 'update', [F.lastPlmConflictSummary]: '{"type":"plm_system_refresh","changedFields":["totalQuantity","ext_componentSortNo"]}' }
      await setCells(stamped, largeLane)
      const before = await st.stored()
      const again = dataOf(await st.preview())
      expect([again.eligible, again.counts.notMachineShaped, again.planDigest], 'no version moved: the same digest').toEqual([true, 0, ok.planDigest])
      // (c) THE BACKUP IS ANSWERED BY NO ROUTE (ruling R3-2). From here on every answer — of the retire and of its restore:
      // the previews, a STOPPED refusal of each, the execute answers — is searched for the two cells this row's backup
      // holds (the large lane's run id, the UPDATE's summary), as stored, JSON-escaped or by part.
      const backupCells = [largeLane[F.lastPlmRefreshRunId], largeLane[F.lastPlmConflictSummary]]
      const noBackupCell = (label: string, res: any) => {
        const text = JSON.stringify(res.body)
        for (const needle of [...backupCells, JSON.stringify(backupCells[1]).slice(1, -1), 'large-bom-expansion', 'plm_system_refresh', 'ext_componentSortNo']) expect(text.includes(needle), `${label} carries ${needle}`).toBe(false)
      }
      const STOP_DETAILS = ['hostCode', 'partial', 'planned', 'reason', 'runId', 'written']
      const hostDown = async () => { throw Object.assign(new Error('host down'), { code: 'SYN_HOST_DOWN' }) }
      // A retire STOPPED on its first patch (the host fails): its run's backup holds both cells already.
      st.hooks.beforePatch = hostDown
      const stoppedRes = await st.execute(ok.planDigest)
      st.hooks.beforePatch = null
      noBackupCell('the retire\'s STOPPED refusal', stoppedRes)
      const stopped = errorOf(stoppedRes, 409, CODES.STOPPED)
      expect([stopped.details.reason, stopped.details.written, Object.keys(stopped.details).sort()]).toEqual(['host_write_failed', 0, STOP_DETAILS])
      const stoppedRun = (await st.runs()).find((row: any) => row.id === stopped.details.runId)
      expect(stoppedRun.backup.find((entry: any[]) => entry[0] === stamped).slice(2), 'the positive control: the stopped run\'s backup holds both cells').toEqual([true, largeLane[F.lastPlmRefreshRunId], 'update', largeLane[F.lastPlmConflictSummary]])
      expect(await st.stored(), 'the stopped retire wrote nothing').toEqual(before)
      const rerun = dataOf(await st.preview())
      expect([rerun.eligible, rerun.sequence, rerun.planDigest === ok.planDigest]).toEqual([true, 1, false])
      const doneRes = await st.execute(rerun.planDigest, { approvalRef: 'R-91:s66-d24-rerun' })
      noBackupCell('the retire\'s execute answer', doneRes)
      const done = dataOf(doneRes)
      expect([done.status, done.planned, done.written]).toEqual(['completed', 4, 4])
      const run = (await st.runs()).find((row: any) => row.id === done.runId)
      expect(new Map(run.backup.map((entry: any[]) => [entry[0], entry.slice(2)]))).toEqual(new Map(st.oldIds.map((id) => [id, id === stamped
        ? [true, largeLane[F.lastPlmRefreshRunId], 'update', largeLane[F.lastPlmConflictSummary]]
        : [true, SMALL_LANE_RUN_ID, 'add', '']])))
      // Nothing that was planted in (a) is anywhere: not in the ledger, not in an audit detail, not in an answer.
      const runsAnswer = dataOf(await st.call('GET', PATHS.runs))
      const everything = JSON.stringify([await st.runs(), await st.claims(), (await st.audits()).map((row: any) => row.detail), again, stoppedRes.body, done, runsAnswer])
      for (const planted of ['S-001', CF.RUN_ID, 'D100-01-03', 'zhang.san', 'synthetic free text']) expect(everything.includes(planted), `${planted} is nowhere in the ledger, the audit details or the answers`).toBe(false)
      expect(JSON.stringify(runsAnswer).includes('large-bom-expansion'), 'the run list never answers a backup cell').toBe(false)
      // The restore: its preview, a STOPPED refusal (its first patch fails), the preview again, its execute — none carries
      // either cell; and it puts every stamp back byte for byte, the large lane's included.
      const restore = (body: Record<string, unknown>) => st.repair({ recipe: RESTORE, runId: done.runId, ...body })
      const planRes = await restore({ mode: 'preview' })
      noBackupCell('the restore preview', planRes)
      const plan = dataOf(planRes)
      st.hooks.beforePatch = hostDown
      const restoreStoppedRes = await restore({ mode: 'execute', planDigest: plan.planDigest, approvalRef: 'R-91:s66-d24-restore-stop' })
      st.hooks.beforePatch = null
      noBackupCell('the restore\'s STOPPED refusal', restoreStoppedRes)
      const restoreStopped = errorOf(restoreStoppedRes, 409, CODES.STOPPED)
      expect([restoreStopped.details.reason, restoreStopped.details.written, Object.keys(restoreStopped.details).sort()]).toEqual(['host_write_failed', 0, STOP_DETAILS])
      const planAgainRes = await restore({ mode: 'preview' })
      noBackupCell('the restore preview after the stop', planAgainRes)
      const restoredRes = await restore({ mode: 'execute', planDigest: dataOf(planAgainRes).planDigest, approvalRef: 'R-91:s66-d24-restore' })
      noBackupCell('the restore\'s execute answer', restoredRes)
      const restored = dataOf(restoredRes)
      expect([restored.status, restored.written]).toEqual(['completed', 4])
      // Each answer has exactly its own keys (BK-01's pins, through the route).
      expect([Object.keys(plan).sort(), Object.keys(done).sort(), Object.keys(restored).sort()]).toEqual([
        ['counts', 'eligible', 'mode', 'openRun', 'planDigest', 'recipe', 'refusals', 'requires', 'sequence', 'sourceRunId'],
        ['componentHandle', 'generationBumped', 'mode', 'planDigest', 'planned', 'recipe', 'runId', 'status', 'written'],
        ['generationBumped', 'mode', 'planDigest', 'planned', 'recipe', 'runId', 'sourceRunId', 'status', 'written'],
      ])
      const after = await st.stored()
      for (const [id, row] of before.entries()) {
        expect(after.get(id)!.data, `${st.oldIds.includes(id) ? 'old' : 'copy'} row: byte-identical`).toBe(row.data)
        expect(after.get(id)!.version).toBe(row.version + (st.oldIds.includes(id) ? 2 : 0))
      }
    }, 180_000)
  })
}
