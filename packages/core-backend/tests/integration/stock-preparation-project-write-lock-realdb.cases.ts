/**
 * Batch-refresh phase 0 step 1 — real-Postgres proof of the stock-prep PROJECT WRITE LOCK (migration 100,
 * plugins/plugin-integration-core/lib/stock-preparation-project-write-lock.cjs) and the atomic token claim.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationProjectWriteLockRealDbCases()` registers its
 * `describe` blocks and is called from an already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases execute in the existing
 * "Run multitable real-DB integration" step of .github/workflows/plugin-tests.yml without a new lane file (the
 * pushing token has no `workflow` OAuth scope; precedent: multitable-copy-sheet-realdb.cases.ts). Do NOT also list
 * a standalone file for these cases in that step, or they run twice.
 *
 * The hermetic suites (plugins/plugin-integration-core/__tests__/stock-preparation-project-write-*.test.cjs) drive
 * the module against a faithful FAKE of the scoped db helper. A fake is a model of PostgreSQL, not PostgreSQL;
 * these cases drive the REAL module through the REAL scoped db helper (lib/db.cjs) against the REAL migrated table:
 *   D0  the table: PRIMARY KEY, the lease-shape CHECK, INTEGER counters (not int8 strings).
 *   D1  two independent sessions race `acquire` x50 on fresh scopes (INSERT race) and x50 on free rows (CAS race):
 *       exactly one holder each time, and the loser is 409 WRITE_LOCKED — never 503.
 *   D2  constructed interleavings via pg_blocking_pids, both orders: a bump queued behind an acquire re-evaluates
 *       `lease_id IS NULL` under READ COMMITTED and is refused; an acquire queued behind a bump is granted and its
 *       guard carries the token from the GRANTING statement's RETURNING row, not from its earlier read (I3).
 *   D3  a real small apply (real lock, real plugin_kv token, real host createRecord on a sandbox sheet), held at its
 *       first write: a preview bump from another session is refused 409; after release meta_records holds exactly
 *       the plan's ADD count and the lease is free.
 *   D4  two sessions consume the same plugin_kv token at once: exactly one gets the record.
 *   D5  lapse with injected clocks: a takeover from another session, and the stalled holder's next CAS is LEASE_LOST.
 *   D6  cross-PROCESS: three node children. A heartbeating holder of sheet S keeps S busy past its TTL while other
 *       sheets proceed; after SIGKILL the sheet stays busy until expiry + grace, then is taken over.
 *   D7  (R-52) two project numbers applied at the same moment to one EMPTY sheet: exactly one project lands; the
 *       other is refused (WRITE_LOCKED / PLAN_SUPERSEDED / the foreign-project 409) — never both, which the
 *       per-(sheet, project) scope allowed through the foreign-project check-then-write race.
 *   D8  (Codex review P1-a) through the REAL host fenced write: A is held inside its second create (past its
 *       pre-write CAS); the lease lapses; B previews and applies to completion; A's create resumes and the host
 *       refuses it (FOR SHARE finds no matching row) — no duplicate idempotency key, A is LEASE_LOST, B succeeded.
 *   D9  the fence's lock order (pg_blocking_pids): an in-flight fenced write (the host's exact allow-listed
 *       SELECT ... FOR SHARE, transaction open) blocks a takeover UPDATE until it commits; once the takeover has
 *       committed, a real host write carrying the old fence is refused and writes nothing.
 *   D12 SAME TRANSACTION, observed on a REAL host write: the host's createRecord (fence + insert) is held at its
 *       INSERT (another session holds SHARE on meta_records). While it waits, the host backend's own xid is the
 *       lease row's xmax (its FOR SHARE), that backend holds its transactionid lock, a takeover queues behind
 *       THAT backend; after it commits, the inserted record's xmin is the SAME xid. Then the takeover lands and
 *       the old fence is refused.
 *   D13 (review rounds 4-5) an ABANDONED lease at expansion time, through the real lock, large lib and host: the
 *       holder passed its pre-write CAS and stalled; the expansion start CLEARS the lease (epoch + 1). The holder
 *       resumes into its host write: refused (PLUGIN_WRITE_FENCE_REJECTED -> LEASE_LOST), no row; the expansion is
 *       approvable. Control: the holder never resumes -> approvable as well (no approval refused after a crash).
 *   D14 (review round 5) a holder stalled INSIDE its host write transaction (FOR SHARE held, INSERT blocked, the D12
 *       technique) when an expansion observes: the observation's clear WAITS for that transaction
 *       (pg_blocking_pids), the write commits first, the observation records epoch + 1, and the plan's
 *       existing-row read afterwards sees the committed row.
 *   D15 (review round 6, S1) a holder frozen INSIDE its fenced write transaction (FOR SHARE held, never commits):
 *       the takeover, the bump's and the observation's abandoned-lease clears each answer 409 WRITE_LOCKED
 *       `holder_in_write` within the bounded row-lock wait plus slack — never the pool's 30 s statement_timeout,
 *       never STORE_FAILED — the row is untouched, the host pool client comes back and no backend stays queued;
 *       release returns within the bound and keeps the lease (warned, reason holder_in_write); after the frozen
 *       transaction ends the takeover lands.
 *   D16 (review round 6, S2) a `writeFence` on a surface that implements no fence (deleteRecord, the overview
 *       port — through plugin-scope, and deleteRecord again through the unscoped `createCoreAPI()` SDK, i.e. the
 *       host's own refusal) is refused by the real host 501 PLUGIN_WRITE_FENCE_UNSUPPORTED with nothing written
 *       or deleted; the same delete without a fence runs.
 *   D10 a fence for another plugin, or for any table but the allow-listed lease table, is refused by the real
 *       host before any write.
 *   D11 (Codex review P1-b) the large lane through the real lock and host: an expansion planned and approved,
 *       then a small preview + apply writes quantities 5 / 15; re-approving the OLD expansion is refused
 *       `expansion_stale` (nothing bumped, no job) and the old approval's job is refused — quantities stay 5 / 15.
 *   D19 (PR B) migration 101: the pilot columns, the both-or-neither CHECK, the audit vocabulary with project_pilot_enable.
 *   D20 (PR B) the enable ROUTE on the real host / lock / registry / audit store: readiness over the real sheet (the step-4
 *       tables stubbed, the build marker flipped in memory), the bump, the host stamp through the #6507 port, the registry
 *       mark, one audit row; export-xlsx (xlsx + csv) 403 MULTITABLE_GRID_EXPORT_CLOSED (U09 with #6507); the re-POST.
 *   D21 (PR B, L02) a job approved before the enablement is refused inside the real lease with the pilot code, never
 *       PLAN_SUPERSEDED (the control run without the check proves the order); the job stays queued, zero meta_records writes.
 *   H-01 (pre-enable hardening F-3) no_open_large_job against a REAL paused checkpoint job in plugin_kv: counted on its
 *       own sheet only, the readiness check fails; run to its end the job is terminal and the check passes.
 *   H-02 (pre-enable hardening F-4c) the pilot mark and its audit row in ONE real transaction: a crash before or after
 *       the audit insert leaves neither; the completing call writes exactly one row; a repeat (already pilot) none.
 *   S2 / S3A (batch-refresh step 4, PR-2 / PR-3a) the continuation / refresh-state stores and the governance reader on
 *       PostgreSQL (S2-*), and the step-4 LANES on the real stack — the route module over the production host, lock,
 *       registry and refresh services (S3A-*; listed in the S3A describe's own header). PR-3a also threads the REAL
 *       refresh wiring (module-scope `realRefreshHandle` / `realChunkGate` / `inLeaseVerdict`) through D3, D7, D8, D11,
 *       D18, D21, H-01, S2-12 and S2-13: the writer now refuses a fenced write without a consulted verdict.
 *       PR-3b threads `realPlanVerdict` (the plan route's not-governed verdict from a real consult) through every direct
 *       large plan (D11, D13, D21, H-01, S3A-11, S3A-18, S3A-27): the approval now refuses an unconsulted expansion.
 *   S3B (batch-refresh step 4, PR-3b) the LARGE lane on the real stack — expansion start / run / plan / approve refuse a
 *       governed project (and an unreadable / retargeted one) before any source or existing-row read, the plan records its
 *       verdict, the approval refuses an unconsulted or governed-shape plan, the stored jobs never carry a hold (S3B-*;
 *       listed in the S3B describe's own header).
 *   S4 (batch-refresh step 4, PR-4) the puller's DECISIONS on the real stack — the six refresh routes over the production
 *       host / lock / registry / audit store and the lock's in-transaction bump inside the store's real transaction:
 *       interleavings (abandoned lease, frozen confirm vs acquire via pg_blocking_pids, live lease, frozen holder), E03,
 *       E04, E09 (a real audit trigger), A08 across two sessions, U03, U04 (S4-*; listed in the S4 describe's own header).
 *   S8 (batch-refresh step 5, PR-8) the CHANGE PLAN on the real stack — migration 104, the three routes, the controlled update
 *       through the host's own read-modify-write (a person's cell vs a plugin-owned cell committed inside the host's patch,
 *       pg_blocking_pids), the review, the absorption of an unreviewed write (B1), E09, C07, the combined confirm, register ①
 *       on a not-governed project, and the confirm / review interleavings (S8-*; listed in the S8 describe's own header).
 * Values-free: every id is synthetic and per-run.
 */
import { createRequire } from 'module'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import express from 'express'
import request from 'supertest'

import { MetaSheetServer } from '../../src/index'
import { invalidateUserPerms } from '../../src/rbac/service'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { PLUGIN_WRITE_FENCE_ALLOW_LIST } from '../../src/multitable/plugin-write-fence'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createPluginDurableStorage } from '../../src/plugins/plugin-durable-storage'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
/* eslint-disable @typescript-eslint/no-explicit-any */
const lockModule = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const tableActions = require(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const largeBomJobs = require(path.join(PLUGIN_LIB, 'stock-preparation-large-bom-jobs.cjs')) as any
// PR-0 (batch-refresh phase 2 step 4): the carry-confirm executor, driven under the real lease (D17, D18).
const confirmWrites = require(path.join(PLUGIN_LIB, 'stock-preparation-confirm-writes.cjs')) as any

const {
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS,
  PROJECT_WRITE_LEASE_TTL_MS,
  PROJECT_WRITE_LOCK_TABLE,
  createStockPreparationProjectWriteLock,
  sheetWriteScopeKey,
  writeBindingFromGeneration,
  writeObservationFromGeneration,
} = lockModule

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
// Round 6 (S1): cases that need a takeover / observation to KEEP WAITING behind an in-flight write while they
// inspect the catalog (D9, D12, D14) raise the lock's bounded wait far above those checks' duration; D15 is the
// case that drives the bound itself (SHORT_ROW_LOCK_WAIT_MS) and asserts the answer within it plus slack.
const LONG_ROW_LOCK_WAIT_MS = 20000
const SHORT_ROW_LOCK_WAIT_MS = 1000
const ROW_LOCK_WAIT_SLACK_MS = 10000

// The scoped db helper over ONE raw pool client. Round 6 (S1): the lock's takeover / abandoned clears /
// release run inside `db.transaction` (a bounded row-lock wait), so the binding also offers a transaction —
// BEGIN / COMMIT / ROLLBACK on that same client (production runs it on the host pool's transaction).
function dbOn(client: PoolClient) {
  return createDb({
    database: {
      query: (sql: string, params?: unknown[]) => client.query(sql, params),
      transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        await client.query('BEGIN')
        try {
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
        }
      },
    },
  })
}

// The scoped db over the HOST's plugin database binding shape (src/index.ts `database`: `query` runs on a POOLED
// connection in autocommit, `transaction` checks out its OWN client — BEGIN, the callback, COMMIT / ROLLBACK),
// with an optional `hook` awaited before every statement (and before the COMMIT): used to FREEZE a session at a
// chosen statement inside its transaction (the consult's snapshot), or to SIGNAL that a session is about to run
// one (the natural race loop). Faithful on purpose: a read that is NOT handed the transaction lands on another
// connection, exactly as in production — so a registry read outside the snapshot is visible here as one.
type StatementEvent = { sql: string; inTransaction: boolean }
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

// Batch-refresh step 4 PR-3a: the PRODUCTION refresh services over host-shaped bindings — index.cjs builds ONE
// continuation store for the reader and the lanes, PR B's registry store and the lock — and the lane handle / chunk
// gate / in-lease writer verdict built from them with the SAME factories lib/http-routes.cjs uses
// (`createRefreshGovernanceHandle`, `largeLaneVerdictOf`, `governanceVerdictOf`). The D-series lane calls thread them
// because the writer now refuses a fenced write without a consulted verdict (E-1 layer (b)).
const refreshLanes = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-lanes.cjs')) as any
const continuationStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
const refreshGovernanceLib = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-governance.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const packInstallStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pack-install-store.cjs')) as any
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(PLUGIN_LIB, 'stock-preparation-templates.cjs')) as any
function realRefreshServices(consultDb: any = hostLikeDb()) {
  const store = continuationStoreLib.createStockPreparationContinuationStore({ db: consultDb })
  const governance = refreshGovernanceLib.createStockPreparationRefreshGovernance({
    continuationStore: store,
    projectTargetStore: projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: hostLikeDb() }),
    projectWriteLock: createStockPreparationProjectWriteLock({ db: hostLikeDb() }),
  })
  return { governance, store }
}
function realRefreshHandle(tenantId: string, options: { services?: any; provisioning?: any; sourceBindingStore?: any; extFieldMapping?: any } = {}) {
  const services = options.services || realRefreshServices()
  return refreshLanes.createRefreshGovernanceHandle({
    tenantId,
    resolveServices: () => services,
    sourceBindingStore: options.sourceBindingStore || null,
    packInstallStore: packInstallStoreLib.createStockPreparationPackInstallStore({ db: hostLikeDb() }),
    resolveProvisioning: () => options.provisioning || null,
    projectId: `${tenantId}:integration-core`,
    defaultObjectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    extFieldMapping: options.extFieldMapping || null,
  })
}
function realChunkGate(tenantId: string, projectNo: string, services: any = realRefreshServices()) {
  return async ({ target }: any) => refreshLanes.largeLaneVerdictOf(await services.governance.consult({ tenantId, projectNo, sheetId: target && target.sheetId }), 'large_apply_chunk')
}
// Batch-refresh step 4 PR-3b: the not-governed verdict the PLAN route hands the plan (`consultLargeLane` =>
// `largeLaneVerdictOf`), from a REAL consult made right before the plan — the approval refuses an expansion planned
// without one (LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED). A direct lib plan of the D / H / S3A cases threads it the way
// the route does.
async function realPlanVerdict(tenantId: string, projectNo: string, sheetId: string, services: any = realRefreshServices()) {
  return refreshLanes.largeLaneVerdictOf(await services.governance.consult({ tenantId, projectNo, sheetId }), 'large_plan')
}
// A DIRECT writer call (S2-12 / S2-13) takes its verdict from a consult made INSIDE the lease, as every lane does.
async function inLeaseVerdict(scope: { tenantId: string; sheetId: string; projectNo: string }, services: any = realRefreshServices()) {
  const consult = await services.governance.consult(scope)
  return refreshLanes.governanceVerdictOf({ consult, governed: consult.governed === true })
}
async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs = 10000) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function isBlockedBy(waiterPid: number, holderPid: number) {
  const result = await q('SELECT pg_blocking_pids($1::int) AS pids', [waiterPid])
  const pids = (result.rows[0] && result.rows[0].pids) || []
  return pids.map(Number).includes(holderPid)
}

function createProductionPluginContext(pluginName = 'plugin-integration-core'): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: pluginName, version: 'write-lock-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-project-write-lock',
    loadedAt: new Date(),
  }
  return (server as unknown as {
    createPluginContext: (plugin: LoadedPlugin) => PluginContext
  }).createPluginContext(loaded)
}

export function defineStockPreparationProjectWriteLockRealDbCases(): void {
  test('project write lock real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the project write lock real-DB cases would skip-green')
    }
  })

  const TOKEN = `${process.pid}_${Date.now().toString(36)}`
  const SHEET = `sheet_swl_rdb_${TOKEN}`
  const scopes: string[] = []
  // R-52: the scope is the sheet, so every label is its own synthetic sheet.
  const scope = (label: string) => {
    const key = sheetWriteScopeKey(`${SHEET}_${label}`)
    scopes.push(key)
    return key
  }

  describeIfDatabase('stock-prep project write lock (real Postgres, migration 100)', () => {
    let clientA: PoolClient
    let clientB: PoolClient
    let clientX: PoolClient

    beforeAll(async () => {
      clientA = await poolManager.get().getInternalPool().connect()
      clientB = await poolManager.get().getInternalPool().connect()
      clientX = await poolManager.get().getInternalPool().connect()
    })

    afterAll(async () => {
      try { await clientX.query('ROLLBACK') } catch { /* not in a transaction */ }
      clientA?.release()
      clientB?.release()
      clientX?.release()
      if (scopes.length) await q(`DELETE FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = ANY($1::text[])`, [scopes]).catch(() => {})
    })

    test('D0 table shape: PRIMARY KEY, lease-shape CHECK, INTEGER counters', async () => {
      const cols = await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1`,
        [PROJECT_WRITE_LOCK_TABLE],
      )
      const byName = new Map(cols.rows.map((row: any) => [row.column_name, row]))
      for (const name of ['generation', 'fencing_epoch', 'lease_seq']) {
        expect(byName.get(name)?.data_type, name).toBe('integer')
        expect(byName.get(name)?.is_nullable, name).toBe('NO')
      }
      expect(byName.get('generation_token')?.is_nullable).toBe('NO')
      const pk = await q(
        `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [PROJECT_WRITE_LOCK_TABLE],
      )
      expect(pk.rows.map((row: any) => row.attname)).toEqual(['scope_key'])
      // Review round 2: the applied table comment is permanent (it changes only through a new migration),
      // so it must describe the scope actually used — the target sheet ('spw2:'), not (sheet, project).
      const comment = String((await q(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [PROJECT_WRITE_LOCK_TABLE])).rows[0].c || '')
      expect(comment).toContain('TARGET SHEET')
      expect(comment).toContain('spw2:')
      expect(comment).not.toContain('(target sheet, project)')
      const key = scope('D0')
      await expect(q(
        `INSERT INTO ${PROJECT_WRITE_LOCK_TABLE} (scope_key, generation_token, lease_id) VALUES ($1, 'g', 'half-a-lease')`,
        [key],
      )).rejects.toMatchObject({ code: '23514' })
      await q(`INSERT INTO ${PROJECT_WRITE_LOCK_TABLE} (scope_key, generation_token) VALUES ($1, 'g')`, [key])
      await expect(q(`INSERT INTO ${PROJECT_WRITE_LOCK_TABLE} (scope_key, generation_token) VALUES ($1, 'g2')`, [key])).rejects.toMatchObject({ code: '23505' })
      const lock = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
      const generation = await lock.bumpGeneration(key, { reason: 'small_preview' })
      expect(typeof generation.generation).toBe('number')
      expect(generation.generation).toBe(1)
    })

    test('D1 two sessions race acquire x50 (INSERT race) and x50 (free-row CAS race): exactly one holder, loser 409 never 503', async () => {
      const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
      const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB) })
      for (let round = 0; round < 2; round += 1) {
        for (let i = 0; i < 50; i += 1) {
          const key = scope(`D1-${i}`)
          if (round === 1) {
            // the row exists and is free: a CAS race, not an INSERT race
            const free = await q(`SELECT lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])
            expect(free.rows[0].lease_id).toBeNull()
          }
          const [a, b] = await Promise.all([
            settle(lockA.acquire(key, { purpose: 'small_apply', runId: `d1a-${i}` })),
            settle(lockB.acquire(key, { purpose: 'small_apply', runId: `d1b-${i}` })),
          ])
          const winners = [a, b].filter((outcome) => outcome.ok)
          const losers = [a, b].filter((outcome) => !outcome.ok) as Array<{ ok: false; error: any }>
          expect(winners.length, `round ${round} race ${i}`).toBe(1)
          expect(losers[0].error.code).toBe(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
          expect(losers[0].error.status).toBe(409)
          const winner = (winners[0] as { ok: true; value: any }).value
          await (a.ok ? lockA : lockB).createGuard(winner).release()
        }
      }
    })

    test('D2 READ COMMITTED re-evaluation, both orders (pg_blocking_pids)', async () => {
      const key = scope('D2')
      const lockY = createStockPreparationProjectWriteLock({ db: dbOn(clientB) })
      const start = await lockY.bumpGeneration(key, { reason: 'small_preview' })
      const pidX = Number((await clientX.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const pidY = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)

      // Order 1: an acquire (session X, open transaction) holds the row; a bump queues behind it.
      await clientX.query('BEGIN')
      await clientX.query(
        `UPDATE ${PROJECT_WRITE_LOCK_TABLE} SET lease_id = 'swl-x-lease', lease_purpose = 'small_apply',
            lease_acquired_at = now(), lease_expires_at = now() + interval '2 minutes', fencing_epoch = fencing_epoch + 1
          WHERE scope_key = $1`,
        [key],
      )
      const bump = settle(lockY.bumpGeneration(key, { reason: 'small_preview' }))
      await waitUntil('the bump to queue behind the acquire', () => isBlockedBy(pidY, pidX))
      await clientX.query('COMMIT')
      const bumped = await bump
      expect(bumped.ok).toBe(false)
      expect((bumped as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
      const afterOrder1 = (await q(`SELECT generation, generation_token FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])).rows[0]
      expect(afterOrder1.generation).toBe(start.generation)
      expect(afterOrder1.generation_token).toBe(start.generationToken)

      // Free the row again.
      await q(
        `UPDATE ${PROJECT_WRITE_LOCK_TABLE} SET lease_id = NULL, lease_purpose = NULL, lease_acquired_at = NULL, lease_expires_at = NULL
          WHERE scope_key = $1`,
        [key],
      )

      // Order 2: a bump (session X, open transaction) holds the row; an acquire queues behind it.
      await clientX.query('BEGIN')
      await clientX.query(
        `UPDATE ${PROJECT_WRITE_LOCK_TABLE} SET generation = generation + 1, generation_token = 'swl-token-from-x' WHERE scope_key = $1`,
        [key],
      )
      const acquire = settle(lockY.acquire(key, { purpose: 'small_apply', runId: 'swl-d2' }))
      await waitUntil('the acquire to queue behind the bump', () => isBlockedBy(pidY, pidX))
      await clientX.query('COMMIT')
      const granted = await acquire
      expect(granted.ok).toBe(true)
      const grant = (granted as any).value
      expect(grant.generationToken).toBe('swl-token-from-x')
      expect(grant.generation).toBe(start.generation + 1)
      await lockY.createGuard(grant).release()
    })

    test('D3 a real small apply held at its first host write: a preview bump from another session is refused; meta_records == ADD count', async () => {
      const pluginContext = createProductionPluginContext()
      const multitable = pluginContext.api.multitable
      if (!multitable) throw new Error('production plugin context is missing multitable APIs')
      const projectId = `tenant_swl_${TOKEN}:integration-core`
      const objectId = `plm_stock_preparation_sandbox_swl_${TOKEN}`
      const projectNo = 'SYN-SWL-D3'
      const ensured = await ensureStockPreparationSandboxTarget({
        context: { api: { multitable } },
        projectId,
        permission: 'admin',
        objectId,
      })
      expect(ensured.ready).toBe(true)
      // The sheet's contract select options (the decision column etc.), as the project-sheet create leg seeds them.
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      const key = sheetWriteScopeKey(sheetId)
      scopes.push(key)
      try {
        const lockA = createStockPreparationProjectWriteLock({ db: createDb({ database: pluginContext.api.database }) })
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB) })
        const action = {
          actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID,
          source: { externalSystemId: 'swl_source_rdb', kind: 'data-source:sql-readonly' },
          target: ensured.target,
        }
        const data: Record<string, Array<Record<string, unknown>>> = {
          DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: 'SWL-PATH-1' }],
          DN_PDM_PathInfo: [{ OBJ_ID: 'SWL-PATH-1' }],
          DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'SWL-ORDER-1', path_id: 'SWL-PATH-1' }],
          DN_PDM_OrderDetailInfo: [{ order_id: 'SWL-ORDER-1', part_id: 'SWL-PART-A', quantity: '2' }],
          DN_PDM_PartLibraryInfo: [
            { OBJ_ID: 'SWL-PART-A', IdentityNo: 'SWL-A-001', IdentityName: 'Synthetic assembly', Material: 'Synthetic', SysVer: 'V1' },
            { OBJ_ID: 'SWL-PART-B', IdentityNo: 'SWL-B-001', IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' },
          ],
          DN_PDM_BomHeadInfo: [{ part_id: 'SWL-PART-A', bom_id: 'SWL-BOM-A', SysVer: 'V1', bom_able: true }],
          DN_PDM_BomDetailsInfo: [{ bom_pid: 'SWL-BOM-A', part_id: 'SWL-PART-B', Bom_ExAttr1: '3' }],
        }
        const sourceAdapter = {
          async read(input: any = {}) {
            const rows = Array.isArray(data[input.object]) ? data[input.object] : []
            const found = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
            return { records: found.map((row) => ({ ...row })), done: true, nextCursor: null }
          },
        }
        let releaseFirstWrite: () => void = () => {}
        const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve })
        let firstWriteEntered: () => void = () => {}
        const firstWriteReached = new Promise<void>((resolve) => { firstWriteEntered = resolve })
        let held = false
        const records: any = {
          ...multitable.records,
          async createRecord(input: any) {
            if (!held) { held = true; firstWriteEntered(); await firstWriteGate }
            return (multitable.records as any).createRecord(input)
          },
        }
        const common = {
          action,
          parameters: { projectNo },
          sourceAdapter,
          recordsApi: records,
          tokenStore: pluginContext.storage,
          plannedAt: '2026-10-22T08:00:00.000Z',
          runId: `swl_rdb_${TOKEN}`,
          // PR-3a: the lane's governance handle (not governed here: one consult, nothing else).
          refreshGovernance: realRefreshHandle(`tenant_swl_${TOKEN}`),
        }
        const dry = await tableActions.dryRunStockPreparationAction({
          ...common,
          projectWriteGenerationBinder: async () => writeBindingFromGeneration(await lockA.bumpGeneration(key, { reason: 'small_preview' })),
        })
        expect(dry.canApply).toBe(true)
        const planned = dry.counts.add
        expect(planned).toBe(2)
        const running = lockA.withProjectWriteLease(key, { purpose: 'small_apply', runId: 'swl-d3' }, (guard: any) =>
          tableActions.applyStockPreparationAction({
            ...common,
            dryRunToken: dry.dryRunToken,
            permission: 'write',
            sandboxPolicy: { enabled: true, allowedTargetObjectIds: [objectId] },
            projectWriteGuard: guard,
          }))
        await firstWriteReached
        const refused = await settle(lockB.bumpGeneration(key, { reason: 'small_preview' }))
        expect(refused.ok).toBe(false)
        expect((refused as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
        await expect(lockB.assertNoLiveWriter(key)).rejects.toMatchObject({ code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
        releaseFirstWrite()
        const applied = await running
        expect(applied.status, JSON.stringify(applied.apply)).toBe('succeeded')
        expect(applied.apply.counts.created).toBe(planned)
        const count = await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])
        expect(count.rows[0].n).toBe(planned)
        const row = (await q(`SELECT lease_id, generation FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])).rows[0]
        expect(row.lease_id).toBeNull()
        expect(row.generation).toBe(1)
        // The plugin_kv token was claimed: a replay is TOKEN_INVALID.
        await expect(lockA.withProjectWriteLease(key, { purpose: 'small_apply' }, (guard: any) =>
          tableActions.applyStockPreparationAction({ ...common, dryRunToken: dry.dryRunToken, permission: 'write', sandboxPolicy: { enabled: true, allowedTargetObjectIds: [objectId] }, projectWriteGuard: guard }),
        )).rejects.toMatchObject({ code: 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID' })
      } finally {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
    })

    test('D4 two sessions consume one plugin_kv token at once: exactly one record', async () => {
      const storageA = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: (sql, params) => clientA.query(sql, params) as any })
      const storageB = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: (sql, params) => clientB.query(sql, params) as any })
      for (let i = 0; i < 20; i += 1) {
        const token = await tableActions.__internals.createDryRunToken(storageA, {
          actionId: 'swl-action', parametersHash: `swl-hash-${TOKEN}`, revision: 'swl-rev', conflictPolicyReview: null,
        })
        const expected = { actionId: 'swl-action', parametersHash: `swl-hash-${TOKEN}` }
        const [a, b] = await Promise.all([
          settle(tableActions.__internals.consumeDryRunToken(storageA, token, expected)),
          settle(tableActions.__internals.consumeDryRunToken(storageB, token, expected)),
        ])
        expect([a, b].filter((outcome) => outcome.ok).length, `claim race ${i}`).toBe(1)
        const loser = [a, b].find((outcome) => !outcome.ok) as { ok: false; error: any }
        expect(loser.error.code).toBe('TABLE_ACTION_DRY_RUN_TOKEN_INVALID')
      }
    })

    test('D5 lapse with injected clocks: another session takes over; the stalled holder\'s next CAS is LEASE_LOST', async () => {
      const key = scope('D5')
      const base = Date.now()
      const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base) })
      const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS) })
      const grantA = await lockA.acquire(key, { purpose: 'small_apply', runId: 'swl-d5-a' })
      const guardA = lockA.createGuard(grantA)
      await guardA.beforeWrite()
      const early = createStockPreparationProjectWriteLock({ db: dbOn(clientB), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS - 1000) })
      await expect(early.acquire(key, { purpose: 'small_apply' })).rejects.toMatchObject({ code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
      // guardA renewed at `base` (expiry base + TTL); lockB's clock is at base + TTL + GRACE: lapsed.
      const grantB = await lockB.acquire(key, { purpose: 'small_apply', runId: 'swl-d5-b' })
      expect(grantB.takeover).toBe(true)
      await expect(guardA.beforeWrite()).rejects.toMatchObject({ code: PROJECT_WRITE_ERROR_CODES.LEASE_LOST, fence: true })
      const row = (await q(`SELECT last_interrupted_run_id, fencing_epoch FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])).rows[0]
      expect(row.last_interrupted_run_id).toBe('swl-d5-a')
      expect(row.fencing_epoch).toBe(grantA.fencingEpoch + 1)
      await lockB.createGuard(grantB).release()
    })

    test('D6 cross-process: a heartbeating holder child keeps S busy past its TTL, unrelated scopes proceed, SIGKILL frees S only after expiry + grace', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'swl-write-lock-'))
      const children: ChildProcess[] = []
      try {
        const script = path.join(dir, 'swl-lock-child.cjs')
        await writeFile(script, [
          "'use strict'",
          "const { createRequire } = require('module')",
          `const backendRequire = createRequire(${JSON.stringify(path.join(REPO_ROOT, 'packages/core-backend/package.json'))})`,
          "const { Pool } = backendRequire('pg')",
          `const { createDb } = require(${JSON.stringify(path.join(PLUGIN_LIB, 'db.cjs'))})`,
          `const { createStockPreparationProjectWriteLock } = require(${JSON.stringify(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs'))})`,
          'const [mode, scopeKey] = process.argv.slice(2)',
          'const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })',
          '// round 6 (S1): the takeover runs in a bounded transaction, so the binding offers one over a pool client',
          'async function transaction(callback) {',
          '  const client = await pool.connect()',
          '  try {',
          "    await client.query('BEGIN')",
          '    const result = await callback({ query: async (sql, params) => (await client.query(sql, params)).rows, commit: async () => {}, rollback: async () => {} })',
          "    await client.query('COMMIT')",
          '    return result',
          '  } catch (error) {',
          "    await client.query('ROLLBACK').catch(() => {})",
          '    throw error',
          '  } finally {',
          '    client.release()',
          '  }',
          '}',
          'const db = createDb({ database: { query: (sql, params) => pool.query(sql, params), transaction } })',
          'const lock = createStockPreparationProjectWriteLock({ db, ttlMs: 1500, takeoverGraceMs: 1000, heartbeatMs: 300 })',
          ';(async () => {',
          '  try {',
          "    const grant = await lock.acquire(scopeKey, { purpose: 'small_apply', runId: 'swl-child-' + process.pid })",
          "    if (mode === 'hold') {",
          '      const guard = lock.createGuard(grant)',
          '      guard.startHeartbeat()',
          "      process.stdout.write('HELD\\n')",
          '      setInterval(() => {}, 1000)',
          '      return',
          '    }',
          '    await lock.createGuard(grant).release()',
          "    process.stdout.write(JSON.stringify({ acquired: true, takeover: grant.takeover }) + '\\n')",
          '  } catch (error) {',
          "    process.stdout.write(JSON.stringify({ acquired: false, code: error && error.code }) + '\\n')",
          '  }',
          "  if (mode !== 'hold') await pool.end()",
          '})()',
        ].join('\n'))
        const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL }
        const tryOnce = async (key: string) => {
          const { stdout } = await execFileAsync(process.execPath, [script, 'try', key], { env })
          return JSON.parse(stdout.trim().split(/\r?\n/).pop() as string)
        }
        const keyS = scope('D6-S')
        const keyS2 = scope('D6-S2')
        const keyS3 = scope('D6-S3')
        const holder = spawn(process.execPath, [script, 'hold', keyS], { env, stdio: ['ignore', 'pipe', 'inherit'] })
        children.push(holder)
        await new Promise<void>((resolve, reject) => {
          let buffer = ''
          holder.stdout!.on('data', (chunk) => { buffer += String(chunk); if (buffer.includes('HELD')) resolve() })
          holder.once('exit', () => reject(new Error('holder exited before holding')))
        })
        expect(await tryOnce(keyS)).toEqual({ acquired: false, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
        expect(await tryOnce(keyS2)).toEqual({ acquired: true, takeover: false })
        expect(await tryOnce(keyS3)).toEqual({ acquired: true, takeover: false })
        // Past the child's TTL (1.5 s) the live holder's heartbeat keeps S busy.
        await new Promise((resolve) => setTimeout(resolve, 2000))
        expect(await tryOnce(keyS)).toEqual({ acquired: false, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
        holder.kill('SIGKILL')
        await new Promise((resolve) => holder.once('exit', resolve))
        const killedAt = Date.now()
        expect(await tryOnce(keyS)).toEqual({ acquired: false, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
        let outcome: any = null
        await waitUntil('the crashed holder lease to lapse', async () => {
          outcome = await tryOnce(keyS)
          return outcome.acquired === true
        }, 15000)
        expect(outcome).toEqual({ acquired: true, takeover: true })
        // The last renewal was <= 300 ms before the kill: the takeover cannot come before TTL + GRACE minus that.
        expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1500 + 1000 - 300 - 50)
        const row = (await q(`SELECT last_interrupted_purpose FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [keyS])).rows[0]
        expect(row.last_interrupted_purpose).toBe('small_apply')
      } finally {
        for (const child of children) { try { child.kill('SIGKILL') } catch { /* gone */ } }
        await rm(dir, { recursive: true, force: true })
      }
    }, 60000)

    test('D7 (R-52) two project numbers applied at once to one EMPTY sheet: exactly one project lands; the other is refused (WRITE_LOCKED / PLAN_SUPERSEDED / the foreign-project 409)', async () => {
      const pluginContext = createProductionPluginContext()
      const multitable = pluginContext.api.multitable
      if (!multitable) throw new Error('production plugin context is missing multitable APIs')
      const projectId = `tenant_swl_d7_${TOKEN}:integration-core`
      const objectId = `plm_stock_preparation_sandbox_swl_d7_${TOKEN}`
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      const key = sheetWriteScopeKey(sheetId)
      const projectField: string = (ensured.target.fieldIdMap && ensured.target.fieldIdMap.projectNo) || 'projectNo'
      scopes.push(key)
      try {
        const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB) })
        const action = {
          actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID,
          source: { externalSystemId: 'swl_source_rdb_d7', kind: 'data-source:sql-readonly' },
          target: ensured.target,
        }
        const sourceFor = (projectNo: string) => {
          const data: Record<string, Array<Record<string, unknown>>> = {
            DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: `PATH-${projectNo}` }],
            DN_PDM_PathInfo: [{ OBJ_ID: `PATH-${projectNo}` }],
            DN_PDM_OrderHeadInfo: [{ OBJ_ID: `ORDER-${projectNo}`, path_id: `PATH-${projectNo}` }],
            DN_PDM_OrderDetailInfo: [{ order_id: `ORDER-${projectNo}`, part_id: `PART-${projectNo}`, quantity: '2' }],
            DN_PDM_PartLibraryInfo: [{ OBJ_ID: `PART-${projectNo}`, IdentityNo: `ID-${projectNo}`, IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' }],
            DN_PDM_BomHeadInfo: [],
            DN_PDM_BomDetailsInfo: [],
          }
          return {
            async read(input: any = {}) {
              const rows = Array.isArray(data[input.object]) ? data[input.object] : []
              const found = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
              return { records: found.map((row) => ({ ...row })), done: true, nextCursor: null }
            },
          }
        }
        // A barrier at the first host write: an apply that got that far waits for the other to get there
        // too (or to be refused), so two applies that BOTH passed the foreign-project check would both write.
        let entered = 0
        let releaseBarrier: () => void = () => {}
        const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
        const recordsWithBarrier: any = {
          ...multitable.records,
          async createRecord(input: any) {
            entered += 1
            if (entered >= 2) releaseBarrier()
            await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 5000))])
            return (multitable.records as any).createRecord(input)
          },
        }
        const plan = async (lock: any, projectNo: string) => tableActions.dryRunStockPreparationAction({
          action, parameters: { projectNo }, sourceAdapter: sourceFor(projectNo), recordsApi: multitable.records,
          tokenStore: pluginContext.storage, plannedAt: '2026-10-22T08:00:00.000Z', runId: `swl_d7_${projectNo}`,
          refreshGovernance: realRefreshHandle(`tenant_swl_d7_${TOKEN}`),
          projectWriteGenerationBinder: async () => writeBindingFromGeneration(await lock.bumpGeneration(key, { reason: 'small_preview' })),
        })
        const applyWith = (lock: any, projectNo: string, token: string) => lock.withProjectWriteLease(key, { purpose: 'small_apply', runId: `swl-d7-${projectNo}` }, (guard: any) =>
          tableActions.applyStockPreparationAction({
            action, parameters: { projectNo }, sourceAdapter: sourceFor(projectNo), recordsApi: recordsWithBarrier,
            tokenStore: pluginContext.storage, plannedAt: '2026-10-22T08:00:00.000Z', runId: `swl_d7_${projectNo}`,
            dryRunToken: token, permission: 'write', sandboxPolicy: { enabled: true, allowedTargetObjectIds: [objectId] }, projectWriteGuard: guard,
            refreshGovernance: realRefreshHandle(`tenant_swl_d7_${TOKEN}`),
          }))
        const P1 = 'SYN-SWL-D7A'
        const P2 = 'SYN-SWL-D7B'
        // Deterministic half (review round 2): the race below can be won by either apply, so it alone does
        // not prove the generation. Sequentially, the OLDER plan (project 1, superseded by project 2's
        // preview) applied ALONE to the still-empty sheet is refused PLAN_SUPERSEDED and writes nothing.
        const staleFirst = (await plan(lockA, P1)).dryRunToken
        await plan(lockB, P2)
        await expect(applyWith(lockA, P1, staleFirst)).rejects.toMatchObject({ code: PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED })
        expect((await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])).rows[0].n).toBe(0)
        // The race: both re-plan (project 2 last, so its token is the current one) and apply at once.
        const t1 = (await plan(lockA, P1)).dryRunToken
        const t2 = (await plan(lockB, P2)).dryRunToken
        expect(typeof t1).toBe('string')
        expect(typeof t2).toBe('string')
        const runs = [applyWith(lockA, P1, t1), applyWith(lockB, P2, t2)].map((p) => p.finally(() => releaseBarrier()))
        const [r1, r2] = await Promise.all(runs.map((p) => settle(p)))
        const allowed = [PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED, 'TARGET_SHEET_FOREIGN_PROJECT']
        for (const outcome of [r1, r2]) {
          if (!outcome.ok) expect(allowed, String(outcome.error && outcome.error.code)).toContain(outcome.error.code)
        }
        expect([r1, r2].filter((outcome) => outcome.ok).length).toBeLessThanOrEqual(1)
        const projects = await q(
          `SELECT DISTINCT data->>$2 AS p FROM meta_records WHERE sheet_id = $1`,
          [sheetId, projectField],
        )
        expect(projects.rows.length, 'one project on the sheet at most').toBeLessThanOrEqual(1)
        // A busy refusal kept its token (I4): the newest plan can still land, and then the sheet holds
        // exactly one project — and a later preview of the other project meets the foreign-project 409.
        if (!r2.ok && r2.error.code === PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED) {
          const retried = await applyWith(lockB, P2, t2)
          expect(retried.status).toBe('succeeded')
        }
        const finalProjects = await q(`SELECT DISTINCT data->>$2 AS p FROM meta_records WHERE sheet_id = $1`, [sheetId, projectField])
        expect(finalProjects.rows.length).toBe(1)
        await expect(plan(lockA, P1)).rejects.toMatchObject({ code: 'TARGET_SHEET_FOREIGN_PROJECT' })
      } finally {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
    }, 60000)

    // ── D8–D11: Codex review P1-a / P1-b ──────────────────────────────────────────────────────────────
    function synthData(quantity = '2'): Record<string, Array<Record<string, unknown>>> {
      return {
        DN_PDM_PathExAttrInfo: [{ FileCode: 'PROJECTNO', Parent_OBJ_ID: 'SWL-PATH-1' }],
        DN_PDM_PathInfo: [{ OBJ_ID: 'SWL-PATH-1' }],
        DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'SWL-ORDER-1', path_id: 'SWL-PATH-1' }],
        DN_PDM_OrderDetailInfo: [{ order_id: 'SWL-ORDER-1', part_id: 'SWL-PART-A', quantity }],
        DN_PDM_PartLibraryInfo: [
          { OBJ_ID: 'SWL-PART-A', IdentityNo: 'SWL-A-001', IdentityName: 'Synthetic assembly', Material: 'Synthetic', SysVer: 'V1' },
          { OBJ_ID: 'SWL-PART-B', IdentityNo: 'SWL-B-001', IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' },
        ],
        DN_PDM_BomHeadInfo: [{ part_id: 'SWL-PART-A', bom_id: 'SWL-BOM-A', SysVer: 'V1', bom_able: true }],
        DN_PDM_BomDetailsInfo: [{ bom_pid: 'SWL-BOM-A', part_id: 'SWL-PART-B', Bom_ExAttr1: '3' }],
      }
    }
    function sourceOf(projectNo: string, quantity = '2') {
      const data = synthData(quantity)
      data.DN_PDM_PathExAttrInfo[0].FileCode = projectNo
      return {
        async read(input: any = {}) {
          const rows = Array.isArray(data[input.object]) ? data[input.object] : []
          const found = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
          return { records: found.map((row) => ({ ...row })), done: true, nextCursor: null }
        },
      }
    }
    async function sandboxSheet(label: string) {
      const pluginContext = createProductionPluginContext()
      const multitable = pluginContext.api.multitable
      if (!multitable) throw new Error('production plugin context is missing multitable APIs')
      const projectId = `tenant_swl_${label}_${TOKEN}:integration-core`
      const objectId = `plm_stock_preparation_sandbox_swl_${label}_${TOKEN}`
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      const key = sheetWriteScopeKey(sheetId)
      scopes.push(key)
      const action = {
        actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: `swl_source_rdb_${label}`, kind: 'data-source:sql-readonly' },
        target: ensured.target,
      }
      return { pluginContext, multitable, objectId, sheetId, key, action, target: ensured.target }
    }
    async function dropSheet(sheetId: string) {
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    }
    const countRows = async (sheetId: string) => Number((await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])).rows[0].n)

    // THE FREEZE CASE (coordinator's spec): the plan is two ADDs; A is frozen between its LAST pre-write CAS and its
    // LAST create (in the records wrapper, after fenceBeforeWrite, before the real host call); the lease lapses; B
    // takes over and writes; A resumes into the real host records API.
    test('D8 (Codex P1-a, freeze case) A frozen between its last CAS and its last create; takeover; B writes; A resumes: the REAL host refuses A\'s create — no duplicate key, A LEASE_LOST, B succeeded', async () => {
      const sb = await sandboxSheet('d8')
      const projectNo = 'SYN-SWL-D8'
      try {
        const base = Date.now()
        const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base) })
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS) })
        expect(sb.multitable.records.supportsWriteFence, 'the production host declares fenced writes').toBe(true)
        let creates = 0
        let releaseA: () => void = () => {}
        const gateA = new Promise<void>((resolve) => { releaseA = resolve })
        let enteredA: () => void = () => {}
        const heldA = new Promise<void>((resolve) => { enteredA = resolve })
        const fencesSeen: unknown[] = []
        const recordsA: any = {
          ...sb.multitable.records,
          async createRecord(input: any) {
            creates += 1
            fencesSeen.push(input.writeFence)
            if (creates === 2) { enteredA(); await gateA }
            return (sb.multitable.records as any).createRecord(input)
          },
        }
        const common = (records: any) => ({
          action: sb.action, parameters: { projectNo }, sourceAdapter: sourceOf(projectNo), recordsApi: records,
          tokenStore: sb.pluginContext.storage, plannedAt: '2026-10-22T08:00:00.000Z', runId: `swl_d8_${TOKEN}`,
          refreshGovernance: realRefreshHandle(`tenant_swl_d8_${TOKEN}`),
        })
        const policy = { enabled: true, allowedTargetObjectIds: [sb.objectId] }
        const dryA = await tableActions.dryRunStockPreparationAction({ ...common(recordsA), projectWriteGenerationBinder: async () => writeBindingFromGeneration(await lockA.bumpGeneration(sb.key, { reason: 'small_preview' })) })
        expect(dryA.counts.add).toBe(2)
        const runningA = settle(lockA.withProjectWriteLease(sb.key, { purpose: 'small_apply', runId: 'swl-d8-a' }, (guard: any) =>
          tableActions.applyStockPreparationAction({ ...common(recordsA), dryRunToken: dryA.dryRunToken, permission: 'write', sandboxPolicy: policy, projectWriteGuard: guard })))
        await heldA
        expect(await countRows(sb.sheetId), 'calibration: A landed its first row').toBe(1)
        expect(fencesSeen.every((fence) => fence && typeof fence === 'object'), 'every A create carried a fence').toBe(true)
        // B: lease lapsed on B's clock; its preview clears A's lease and bumps; its apply runs to completion.
        const dryB = await tableActions.dryRunStockPreparationAction({ ...common(sb.multitable.records), projectWriteGenerationBinder: async () => writeBindingFromGeneration(await lockB.bumpGeneration(sb.key, { reason: 'small_preview' })) })
        const appliedB = await lockB.withProjectWriteLease(sb.key, { purpose: 'small_apply', runId: 'swl-d8-b' }, (guard: any) =>
          tableActions.applyStockPreparationAction({ ...common(sb.multitable.records), dryRunToken: dryB.dryRunToken, permission: 'write', sandboxPolicy: policy, projectWriteGuard: guard }))
        expect(appliedB.status).toBe('succeeded')
        const rowsAfterB = await countRows(sb.sheetId)
        releaseA()
        const outcomeA = await runningA
        expect(outcomeA.ok, 'A must not report success').toBe(false)
        const errorA = (outcomeA as any).error
        expect(errorA.code).toBe(PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
        expect(errorA.details.partial).toBe(true)
        expect(errorA.details.written).toBe(1)
        expect(errorA.details.abortedAtDecisionIndex).toBe(1)
        expect(await countRows(sb.sheetId), 'the host wrote nothing for A\'s held create').toBe(rowsAfterB)
        const keyField: string = (sb.target.fieldIdMap && sb.target.fieldIdMap.idempotencyKey) || 'idempotencyKey'
        const dupes = await q(
          `SELECT data->>$2 AS k, COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1 GROUP BY 1 HAVING COUNT(*) > 1`,
          [sb.sheetId, keyField],
        )
        expect(dupes.rows, 'no duplicate idempotency key').toEqual([])
      } finally {
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    test('D9 the fence\'s lock order (pg_blocking_pids): an in-flight fenced write blocks the takeover; after the takeover the old fence is refused by the real host', async () => {
      const sb = await sandboxSheet('d9')
      try {
        const base = Date.now()
        const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base) })
        // Round 6 (S1): this case needs the takeover to WAIT for the in-flight write (its own checks run meanwhile),
        // so its bounded wait is set well above the checks' duration; D15 is the case that exercises the bound.
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS), rowLockWaitMs: LONG_ROW_LOCK_WAIT_MS })
        await lockA.bumpGeneration(sb.key, { reason: 'small_preview' })
        const grantA = await lockA.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d9-a' })
        const guardA = lockA.createGuard(grantA)
        const fenceA = guardA.hostWriteFence()
        const pidX = Number((await clientX.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const pidB = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        // A fenced write in flight: the host's exact allow-listed statement, transaction open.
        await clientX.query('BEGIN')
        const held = await clientX.query(PLUGIN_WRITE_FENCE_ALLOW_LIST['plugin-integration-core'].sql, [fenceA.scopeKey, fenceA.leaseId, fenceA.fencingEpoch, fenceA.generationToken])
        expect(held.rows.length).toBe(1)
        const takeover = settle(lockB.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d9-b' }))
        await waitUntil('the takeover to queue behind the in-flight fenced write', () => isBlockedBy(pidB, pidX))
        await clientX.query('COMMIT')
        const granted = await takeover
        expect(granted.ok).toBe(true)
        expect((granted as any).value.takeover).toBe(true)
        // The reverse order: the takeover has committed, so a write carrying A's fence is refused by the host.
        const before = await countRows(sb.sheetId)
        const refused = await settle((sb.multitable.records as any).createRecord({ sheetId: sb.sheetId, data: {}, writeFence: fenceA }))
        expect(refused.ok).toBe(false)
        expect((refused as any).error.code).toBe('PLUGIN_WRITE_FENCE_REJECTED')
        expect(await countRows(sb.sheetId)).toBe(before)
        // …and the guard turns that answer into LEASE_LOST.
        const mapped = await guardA.hostFenceRefused((refused as any).error)
        expect(mapped.code).toBe(PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
        await lockB.createGuard((granted as any).value).release()
      } finally {
        try { await clientX.query('ROLLBACK') } catch { /* not in a transaction */ }
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    test('D12 SAME TRANSACTION: the host\'s fence FOR SHARE and its record INSERT carry one xid (pg_stat_activity / pg_locks / xmax / xmin)', async () => {
      const sb = await sandboxSheet('d12')
      const lockTable = PROJECT_WRITE_LOCK_TABLE
      try {
        const base = Date.now()
        const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base) })
        // Round 6 (S1): the takeover must still be WAITING while the catalog checks below run (see D9).
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS), rowLockWaitMs: LONG_ROW_LOCK_WAIT_MS })
        await lockA.bumpGeneration(sb.key, { reason: 'small_preview' })
        const guardA = lockA.createGuard(await lockA.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d12-a' }))
        const fenceA = guardA.hostWriteFence()
        const pidX = Number((await clientX.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const pidB = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        // Hold every INSERT/UPDATE on meta_records (reads still pass): the host write stops AT its insert.
        await clientX.query('BEGIN')
        await clientX.query('LOCK TABLE meta_records IN SHARE MODE')
        const write = settle((sb.multitable.records as any).createRecord({ sheetId: sb.sheetId, data: {}, writeFence: fenceA }))
        let hostPid = 0
        await waitUntil('the host write to wait at its meta_records INSERT', async () => {
          const waiting = await q(
            `SELECT pid FROM pg_locks WHERE relation = 'meta_records'::regclass AND NOT granted AND pid <> $1`,
            [pidX],
          )
          if (waiting.rows.length !== 1) return false
          hostPid = Number(waiting.rows[0].pid)
          return true
        })
        expect(await isBlockedBy(hostPid, pidX), 'the host backend waits on our SHARE lock').toBe(true)
        const activity = (await q('SELECT backend_xid::text AS xid FROM pg_stat_activity WHERE pid = $1', [hostPid])).rows[0]
        const hostXid = String(activity && activity.xid)
        expect(hostXid, 'the host transaction already has an xid (its FOR SHARE locked a row)').toMatch(/^[0-9]+$/)
        const leaseRow = (await q(`SELECT xmax::text AS xmax FROM ${lockTable} WHERE scope_key = $1`, [sb.key])).rows[0]
        expect(leaseRow.xmax, 'the lease row is share-locked BY the waiting host transaction').toBe(hostXid)
        const xidLock = await q(
          `SELECT granted FROM pg_locks WHERE locktype = 'transactionid' AND transactionid::text = $1 AND pid = $2`,
          [hostXid, hostPid],
        )
        expect(xidLock.rows.map((row: any) => row.granted)).toEqual([true])
        // A takeover now queues behind THAT backend (the uncommitted write that holds the fence).
        const takeover = settle(lockB.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d12-b' }))
        await waitUntil('the takeover to queue behind the host write transaction', () => isBlockedBy(pidB, hostPid))
        const takeoverWait = await q(
          `SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND locktype IN ('transactionid', 'tuple')`,
          [pidB],
        )
        expect(takeoverWait.rows.length).toBeGreaterThan(0)
        await clientX.query('COMMIT')
        const written = await write
        expect(written.ok, JSON.stringify((written as any).error && (written as any).error.code)).toBe(true)
        const recordId = (written as any).value.id
        const inserted = (await q('SELECT xmin::text AS xmin FROM meta_records WHERE id = $1', [recordId])).rows[0]
        expect(inserted.xmin, 'the INSERT committed in the SAME transaction as the fence FOR SHARE').toBe(hostXid)
        const granted = await takeover
        expect(granted.ok).toBe(true)
        expect((granted as any).value.takeover).toBe(true)
        const before = await countRows(sb.sheetId)
        const refused = await settle((sb.multitable.records as any).createRecord({ sheetId: sb.sheetId, data: {}, writeFence: fenceA }))
        expect((refused as any).error && (refused as any).error.code).toBe('PLUGIN_WRITE_FENCE_REJECTED')
        expect(await countRows(sb.sheetId)).toBe(before)
        // The same for a PATCH through the real host: the old fence is refused and the record is untouched.
        const versionBefore = (await q('SELECT version FROM meta_records WHERE id = $1', [recordId])).rows[0].version
        const patched = await settle((sb.multitable.records as any).patchRecord({ sheetId: sb.sheetId, recordId, changes: {}, writeFence: fenceA }))
        expect((patched as any).error && (patched as any).error.code).toBe('PLUGIN_WRITE_FENCE_REJECTED')
        expect((await q('SELECT version FROM meta_records WHERE id = $1', [recordId])).rows[0].version).toBe(versionBefore)
        // …while the CURRENT holder's fence lets the patch through.
        const guardB = lockB.createGuard((granted as any).value)
        const patchedB = await settle((sb.multitable.records as any).patchRecord({ sheetId: sb.sheetId, recordId, changes: {}, writeFence: guardB.hostWriteFence() }))
        expect(patchedB.ok, JSON.stringify((patchedB as any).error && (patchedB as any).error.code)).toBe(true)
        await guardB.release()
      } finally {
        try { await clientX.query('ROLLBACK') } catch { /* not in a transaction */ }
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    test('D13 (rounds 4-5) an ABANDONED lease at expansion time is cleared by the expansion: the resumed holder\'s write is refused (no row, LEASE_LOST) and the expansion is approvable; never-resumed control approvable too', async () => {
      async function stalledFlow(label: string, resume: boolean) {
        const sb = await sandboxSheet(label)
        const projectNo = `SYN-SWL-${label.toUpperCase()}`
        try {
          const base = Date.now()
          const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base) })
          const lockB = createStockPreparationProjectWriteLock({ db: createDb({ database: sb.pluginContext.api.database }), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS) })
          await lockA.bumpGeneration(sb.key, { reason: 'small_preview' })
          const grantA = await lockA.acquire(sb.key, { purpose: 'small_apply', runId: `swl-${label}-a` })
          const guardA = lockA.createGuard(grantA)
          await guardA.beforeWrite({ index: 0, operation: 'createRecord' }) // A passed its pre-write CAS, then stalls
          const storage: any = sb.pluginContext.storage
          const jobScope = { tenantId: `tenant_swl_${label}_${TOKEN}`, workspaceId: `ws_swl_${label}_${TOKEN}` }
          const actionId = sb.action.actionId
          const jobId = `swl_${label}_${TOKEN}`
          const records = sb.multitable.records as any
          await largeBomJobs.createLargeBomBackgroundExpansionJob({
            storage, ...jobScope, action: sb.action, parameters: { projectNo }, principal: 'swl-d13', createJobId: () => jobId,
            writeGenerationObserver: async () => writeObservationFromGeneration(await lockB.observeGeneration(sb.key)),
          })
          const stored = await storage.get(largeBomJobs.__internals.backgroundJobKey({ ...jobScope, actionId, jobId }))
          const cleared = (await q(`SELECT lease_id, fencing_epoch, last_interrupted_run_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sb.key])).rows[0]
          await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId, jobId, sourceAdapter: sourceOf(projectNo, '2') })
          await largeBomJobs.planLargeBomBackgroundExpansionJob({
            storage, ...jobScope, actionId, jobId,
            existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, sb.target, projectNo),
            governanceVerdict: await realPlanVerdict(jobScope.tenantId, projectNo, sb.target.sheetId),
            writeGenerationReader: (observed: string) => lockB.readGeneration(observed),
          })
          let late: any = null
          let lateMapped: any = null
          let lateCas: any = null
          const rowsBefore = await countRows(sb.sheetId)
          if (resume) {
            // A resumes straight into its host write (its CAS was before the stall).
            late = await settle(records.createRecord({ sheetId: sb.sheetId, data: {}, writeFence: guardA.hostWriteFence() }))
            if (!late.ok) lateMapped = await guardA.hostFenceRefused(late.error)
            lateCas = await settle(guardA.beforeWrite({ index: 1, operation: 'createRecord' }))
          }
          const rowsAfterResume = await countRows(sb.sheetId)
          const applyJobId = `swl_${label}_apply_${TOKEN}`
          const approval = await settle(largeBomJobs.createLargeBomCheckpointApplyJob({
            storage, ...jobScope, actionId, jobId, principal: 'swl-d13', permission: 'write', createApplyJobId: () => applyJobId,
            writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await lockB.bumpGeneration(sb.key, { reason: 'large_approval', expect })),
          }))
          const job = await storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...jobScope, actionId, applyJobId }))
          return { stored, cleared, grantA, late, lateMapped, lateCas, rowsBefore, rowsAfterResume, approval, job }
        } finally {
          await dropSheet(sb.sheetId)
        }
      }
      for (const [label, resume] of [['d13r', true], ['d13c', false]] as const) {
        const r = await stalledFlow(label, resume)
        expect('leaseId' in r.stored.writeObservation, 'the observation carries no lease').toBe(false)
        expect(r.stored.writeObservation.fencingEpoch).toBe(r.grantA.fencingEpoch + 1)
        expect(r.cleared.lease_id, 'the expansion cleared the abandoned lease').toBeNull()
        expect(r.cleared.fencing_epoch).toBe(r.grantA.fencingEpoch + 1)
        expect(r.cleared.last_interrupted_run_id).toBe(`swl-${label}-a`)
        if (resume) {
          expect(r.late.ok, 'the resumed holder\'s write is refused').toBe(false)
          expect(r.late.error.code).toBe('PLUGIN_WRITE_FENCE_REJECTED')
          expect(r.lateMapped.code).toBe(PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
          expect(r.lateCas.ok).toBe(false)
          expect(r.lateCas.error.code).toBe(PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
          expect(r.rowsAfterResume, 'no row written').toBe(r.rowsBefore)
        }
        expect(r.approval.ok, JSON.stringify(r.approval.ok ? null : r.approval.error.details)).toBe(true)
        expect(r.job).not.toBeNull()
      }
    }, 120000)

    test('D14 (round 5) a holder stalled INSIDE its host write transaction: the observation waits for it (pg_blocking_pids), the write commits first, the observation records epoch + 1, and the plan read sees the row', async () => {
      const sb = await sandboxSheet('d14')
      const projectNo = 'SYN-SWL-D14'
      const projectField: string = (sb.target.fieldIdMap && sb.target.fieldIdMap.projectNo) || 'projectNo'
      try {
        const base = Date.now()
        const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base) })
        // Round 6 (S1): the observation must still be WAITING while the checks below run (see D9); D15 bounds it.
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS), rowLockWaitMs: LONG_ROW_LOCK_WAIT_MS })
        await lockA.bumpGeneration(sb.key, { reason: 'small_preview' })
        const grantA = await lockA.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d14-a' })
        const guardA = lockA.createGuard(grantA)
        await guardA.beforeWrite({ index: 0, operation: 'createRecord' })
        const pidX = Number((await clientX.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const pidB = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        // A's host write starts its transaction (fence FOR SHARE taken) and stalls at its INSERT.
        await clientX.query('BEGIN')
        await clientX.query('LOCK TABLE meta_records IN SHARE MODE')
        const write = settle((sb.multitable.records as any).createRecord({ sheetId: sb.sheetId, data: { [projectField]: projectNo }, writeFence: guardA.hostWriteFence() }))
        let hostPid = 0
        await waitUntil('the host write to wait at its meta_records INSERT', async () => {
          const waiting = await q(`SELECT pid FROM pg_locks WHERE relation = 'meta_records'::regclass AND NOT granted AND pid <> $1`, [pidX])
          if (waiting.rows.length !== 1) return false
          hostPid = Number(waiting.rows[0].pid)
          return true
        })
        const hostXid = String((await q('SELECT backend_xid::text AS xid FROM pg_stat_activity WHERE pid = $1', [hostPid])).rows[0].xid)
        expect((await q(`SELECT xmax::text AS xmax FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sb.key])).rows[0].xmax, 'the stalled write holds the lease row FOR SHARE').toBe(hostXid)
        // The expansion observes on B's clock: the lease is abandoned, so it clears it — and must wait.
        let observedAt = 0
        const observing = settle(lockB.observeGeneration(sb.key).then((value: any) => { observedAt = Date.now(); return value }))
        await waitUntil('the observation\'s clear to queue behind the stalled host write', () => isBlockedBy(pidB, hostPid))
        expect(observedAt, 'the observation has not returned while the write is in flight').toBe(0)
        await clientX.query('COMMIT')
        const written = await write
        expect(written.ok, JSON.stringify(written.ok ? null : (written as any).error.code)).toBe(true)
        const observed = await observing
        expect(observed.ok).toBe(true)
        const observation = (observed as any).value
        expect(observation.fencingEpoch, 'the observation records epoch + 1').toBe(grantA.fencingEpoch + 1)
        expect(observation.leaseId).toBeNull()
        const recordId = (written as any).value.id
        const inserted = (await q('SELECT xmin::text AS xmin FROM meta_records WHERE id = $1', [recordId])).rows[0]
        expect(inserted.xmin, 'the row committed in the stalled holder\'s own transaction').toBe(hostXid)
        const cleared = (await q(`SELECT lease_id, fencing_epoch, xmin::text AS xmin FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sb.key])).rows[0]
        expect(cleared.lease_id).toBeNull()
        expect(cleared.fencing_epoch).toBe(grantA.fencingEpoch + 1)
        // The plan reads existing rows AFTER the observation: the stalled holder's row is there.
        const existing = await tableActions.__internals.readExistingStockPreparationRows(sb.multitable.records, sb.target, projectNo)
        expect(existing.length, 'the plan\'s existing-row read sees the committed write').toBeGreaterThanOrEqual(1)
        // …and the holder cannot write again.
        await expect(guardA.beforeWrite({ index: 1, operation: 'createRecord' })).rejects.toMatchObject({ code: PROJECT_WRITE_ERROR_CODES.LEASE_LOST })
        const again = await settle((sb.multitable.records as any).createRecord({ sheetId: sb.sheetId, data: {}, writeFence: guardA.hostWriteFence() }))
        expect((again as any).error && (again as any).error.code).toBe('PLUGIN_WRITE_FENCE_REJECTED')
      } finally {
        try { await clientX.query('ROLLBACK') } catch { /* not in a transaction */ }
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    test('D15 (round 6, S1) a holder frozen INSIDE its fenced write transaction: takeover / bump / observe answer 409 WRITE_LOCKED holder_in_write within the bounded wait (never statement_timeout, never STORE_FAILED); release returns and keeps the lease; the pool client comes back; after COMMIT the takeover lands', async () => {
      const key = scope('D15')
      const base = Date.now()
      const warnings: unknown[] = []
      const logger = { warn: (_message: string, fields: unknown) => { warnings.push(fields) } }
      const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base), rowLockWaitMs: SHORT_ROW_LOCK_WAIT_MS, logger })
      // The contender runs over the HOST's database API (the production shape): its bounded transaction takes a
      // client from the host pool, which must come back as soon as the bound fires.
      const hostDatabase = createProductionPluginContext().api.database
      const lockB = createStockPreparationProjectWriteLock({ db: createDb({ database: hostDatabase }), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS), rowLockWaitMs: SHORT_ROW_LOCK_WAIT_MS })
      const pool = poolManager.get().getInternalPool()
      const pidX = Number((await clientX.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const bound = SHORT_ROW_LOCK_WAIT_MS + ROW_LOCK_WAIT_SLACK_MS
      // The lib call races a timer at the bound: if the timer wins, the lib is still blocked (an unbounded wait would
      // sit there until statement_timeout), and the case fails at once with that message — never a 30 s hang.
      const raceAgainstBound = async <T>(label: string, promise: Promise<T>) => {
        const marker = Symbol('bound')
        const outcome = await Promise.race([settle(promise), new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), bound).unref())])
        if (outcome === marker) throw new Error(`${label}: still blocked ${bound} ms after it started (the bounded wait did not fire)`)
        return outcome as Awaited<ReturnType<typeof settle<T>>>
      }
      try {
        await lockA.bumpGeneration(key, { reason: 'small_preview' })
        const grantA = await lockA.acquire(key, { purpose: 'small_apply', runId: 'swl-d15-a' })
        const guardA = lockA.createGuard(grantA)
        const fenceA = guardA.hostWriteFence()
        // The frozen holder: its host write transaction holds the lease row FOR SHARE (the host's exact statement)
        // and never commits on its own.
        await clientX.query('BEGIN')
        const held = await clientX.query(PLUGIN_WRITE_FENCE_ALLOW_LIST['plugin-integration-core'].sql, [fenceA.scopeKey, fenceA.leaseId, fenceA.fencingEpoch, fenceA.generationToken])
        expect(held.rows.length).toBe(1)
        const rowNow = async () => (await q(`SELECT lease_id, fencing_epoch, generation FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])).rows[0]
        const before = await rowNow()
        const waitingOnOurRow = async () => Number((await q(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1 AND query LIKE '%' || $2 || '%'`,
          [pidX, PROJECT_WRITE_LOCK_TABLE],
        )).rows[0].n)
        for (const [label, run] of [
          ['takeover', () => lockB.acquire(key, { purpose: 'small_apply', runId: 'swl-d15-b' })],
          ['bump', () => lockB.bumpGeneration(key, { reason: 'small_preview' })],
          ['observe', () => lockB.observeGeneration(key)],
        ] as const) {
          const idleBefore = pool.idleCount
          const started = Date.now()
          const outcome = await raceAgainstBound(label, run())
          const elapsed = Date.now() - started
          expect(outcome.ok, `${label}: must be refused`).toBe(false)
          const error = (outcome as { ok: false; error: any }).error
          expect(error.code, label).toBe(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
          expect(error.status, label).toBe(409)
          expect(error.details.reason, label).toBe('holder_in_write')
          expect(error.details.holderPurpose, label).toBe('small_apply')
          expect(error.details.retryAfterMs, label).toBe(SHORT_ROW_LOCK_WAIT_MS)
          expect(elapsed, `${label}: waited for the bound`).toBeGreaterThanOrEqual(SHORT_ROW_LOCK_WAIT_MS / 2)
          expect(elapsed, `${label}: answered within the bound plus slack, far below statement_timeout`).toBeLessThan(bound)
          expect(await rowNow(), `${label}: nothing moved`).toEqual(before)
          // the pool client is back and no backend is left queued on our row
          await waitUntil(`${label}: the pool client to come back`, async () => pool.idleCount >= idleBefore && pool.waitingCount === 0)
          await waitUntil(`${label}: no backend queued on the lease row`, async () => (await waitingOnOurRow()) === 0)
        }
        // release: best-effort — returns within the bound, warns with the reason, keeps the lease (it expires)
        const releaseStarted = Date.now()
        await raceAgainstBound('release', guardA.release())
        expect(Date.now() - releaseStarted).toBeLessThan(bound)
        expect((await rowNow()).lease_id, 'release did not land while the write is in flight').toBe(grantA.leaseId)
        expect(warnings).toEqual([{ sqlState: '55P03', reason: 'holder_in_write' }])
        // the frozen holder's transaction ends (the operator escape hatch is a process restart, which does the
        // same): the takeover proceeds.
        await clientX.query('COMMIT')
        const granted = await raceAgainstBound('takeover after COMMIT', lockB.acquire(key, { purpose: 'small_apply', runId: 'swl-d15-c' }))
        expect(granted.ok, JSON.stringify(granted.ok ? null : (granted as any).error.code)).toBe(true)
        expect((granted as any).value.takeover).toBe(true)
        expect((await rowNow()).fencing_epoch).toBe(grantA.fencingEpoch + 1)
        await lockB.createGuard((granted as any).value).release()
      } finally {
        try { await clientX.query('ROLLBACK') } catch { /* not in a transaction */ }
      }
    }, 90000)

    test('D16 (round 6, S2) a fence on a write surface that does not implement fencing is REFUSED by the real host (501 PLUGIN_WRITE_FENCE_UNSUPPORTED), never dropped: deleteRecord and the overview port; an unfenced delete still deletes', async () => {
      const sb = await sandboxSheet('d16')
      try {
        const lock = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
        const grant = await lock.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d16' })
        const guard = lock.createGuard(grant)
        const fence = guard.hostWriteFence()
        const records = sb.multitable.records as any
        const created = await records.createRecord({ sheetId: sb.sheetId, data: {}, writeFence: fence })
        const before = await countRows(sb.sheetId)
        expect(before).toBeGreaterThanOrEqual(1)
        const attempts: Array<[string, () => Promise<unknown>]> = [
          ['records.deleteRecord', () => records.deleteRecord({ sheetId: sb.sheetId, recordId: created.id, writeFence: fence })],
          ['records.stockPreparationOverview.createRecord', () => records.stockPreparationOverview.createRecord({ projectId: `tenant_swl_d16_${TOKEN}:integration-core`, data: {}, writeFence: fence })],
          ['records.stockPreparationOverview.patchRecord', () => records.stockPreparationOverview.patchRecord({ projectId: `tenant_swl_d16_${TOKEN}:integration-core`, recordId: created.id, changes: {}, writeFence: fence })],
          ['records.stockPreparationOverview.deleteRecord', () => records.stockPreparationOverview.deleteRecord({ projectId: `tenant_swl_d16_${TOKEN}:integration-core`, recordId: created.id, writeFence: fence })],
        ]
        const total = async () => Number((await q('SELECT COUNT(*)::int AS n FROM meta_records')).rows[0].n)
        const totalBefore = await total()
        for (const [surface, attempt] of attempts) {
          const outcome = await settle(attempt())
          expect(outcome.ok, surface).toBe(false)
          expect((outcome as any).error.code, surface).toBe('PLUGIN_WRITE_FENCE_UNSUPPORTED')
          expect((outcome as any).error.status, surface).toBe(501)
          expect((outcome as any).error.details, surface).toEqual({ surface })
        }
        expect(await countRows(sb.sheetId), 'the fenced delete deleted nothing').toBe(before)
        expect(await total(), 'no surface wrote or deleted anywhere').toBe(totalBefore)
        // The HOST's own surface, below plugin-scope (the unscoped SDK `createCoreAPI()` hands out): its
        // deleteRecord refuses the fence itself, so a caller that bypasses plugin-scope gets no unfenced delete.
        const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
        const coreSdk = (server as unknown as { createCoreAPI: () => { multitable: { records: any } } }).createCoreAPI().multitable.records
        const hostLevel = await settle(coreSdk.deleteRecord({ sheetId: sb.sheetId, recordId: created.id, writeFence: fence }))
        expect(hostLevel.ok).toBe(false)
        expect((hostLevel as any).error.code).toBe('PLUGIN_WRITE_FENCE_UNSUPPORTED')
        expect((hostLevel as any).error.details).toEqual({ surface: 'records.deleteRecord' })
        expect(await countRows(sb.sheetId), 'the host-level fenced delete deleted nothing').toBe(before)
        // control: the same delete without a fence runs as before
        await records.deleteRecord({ sheetId: sb.sheetId, recordId: created.id })
        expect(await countRows(sb.sheetId)).toBe(before - 1)
        await guard.release()
      } finally {
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    test('D10 a fence for another plugin, or for any other table, is refused by the real host before any write', async () => {
      const sb = await sandboxSheet('d10')
      try {
        const lock = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
        const grant = await lock.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d10' })
        const fence = lock.createGuard(grant).hostWriteFence()
        const before = await countRows(sb.sheetId)
        const other = createProductionPluginContext('plugin-after-sales').api.multitable
        if (!other) throw new Error('missing multitable APIs')
        for (const attempt of [
          () => (other.records as any).createRecord({ sheetId: sb.sheetId, data: {}, writeFence: fence }),
          () => (other.records as any).patchRecord({ sheetId: sb.sheetId, recordId: 'rec_swl_none', changes: {}, writeFence: fence }),
          () => (sb.multitable.records as any).createRecord({ sheetId: sb.sheetId, data: {}, writeFence: { ...fence, lock: 'meta_records' } }),
          () => (sb.multitable.records as any).createRecord({ sheetId: sb.sheetId, data: {}, writeFence: { ...fence, extra: 'x' } }),
        ]) {
          const outcome = await settle(attempt())
          expect(outcome.ok).toBe(false)
          expect((outcome as any).error.code).toBe('PLUGIN_WRITE_FENCE_NOT_ALLOWED')
        }
        expect(await countRows(sb.sheetId)).toBe(before)
        await lock.createGuard(grant).release()
      } finally {
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    test('D11 (Codex P1-b) re-approving an expansion overtaken by a newer small write is refused expansion_stale; quantities stay 5 / 15', async () => {
      const sb = await sandboxSheet('d11')
      const projectNo = 'SYN-SWL-D11'
      try {
        const lock = createStockPreparationProjectWriteLock({ db: createDb({ database: sb.pluginContext.api.database }) })
        const storage: any = sb.pluginContext.storage
        expect(storage.durable).toBe(true)
        const jobScope = { tenantId: `tenant_swl_d11_${TOKEN}`, workspaceId: `ws_swl_d11_${TOKEN}` }
        const actionId = sb.action.actionId
        const jobId = `swl_d11_old_${TOKEN}`
        const records = sb.multitable.records as any
        const scopedForChunk = () => tableActions.createTargetScopedRecordsApi(records, sb.target, { fieldIdTranslation: 'pre_mapped' })
        // the OLD expansion, observed / planned / approved the way the routes do it
        await largeBomJobs.createLargeBomBackgroundExpansionJob({
          storage, ...jobScope, action: sb.action, parameters: { projectNo }, principal: 'swl-d11', createJobId: () => jobId,
          writeGenerationObserver: async () => writeObservationFromGeneration(await lock.observeGeneration(sb.key)),
        })
        await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId, jobId, sourceAdapter: sourceOf(projectNo, '2') })
        await largeBomJobs.planLargeBomBackgroundExpansionJob({
          storage, ...jobScope, actionId, jobId,
          existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, sb.target, projectNo),
          governanceVerdict: await realPlanVerdict(jobScope.tenantId, projectNo, sb.target.sheetId),
          writeGenerationReader: (observed: string) => lock.readGeneration(observed),
        })
        const approve = (applyJobId: string) => largeBomJobs.createLargeBomCheckpointApplyJob({
          storage, ...jobScope, actionId, jobId, principal: 'swl-d11', permission: 'write', createApplyJobId: () => applyJobId,
          writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await lock.bumpGeneration(sb.key, { reason: 'large_approval', expect })),
        })
        const oldApproval = await approve(`swl_d11_apply_old_${TOKEN}`)
        expect(oldApproval.writeGeneration).toBe(1)
        // the NEWER small preview + apply: quantity 5
        const policy = { enabled: true, allowedTargetObjectIds: [sb.objectId] }
        const small = {
          action: sb.action, parameters: { projectNo }, sourceAdapter: sourceOf(projectNo, '5'), recordsApi: records,
          tokenStore: storage, plannedAt: '2026-10-22T08:00:00.000Z', runId: `swl_d11_small_${TOKEN}`,
          refreshGovernance: realRefreshHandle(jobScope.tenantId),
        }
        const dry = await tableActions.dryRunStockPreparationAction({ ...small, projectWriteGenerationBinder: async () => writeBindingFromGeneration(await lock.bumpGeneration(sb.key, { reason: 'small_preview' })) })
        const applied = await lock.withProjectWriteLease(sb.key, { purpose: 'small_apply', runId: 'swl-d11-small' }, (guard: any) =>
          tableActions.applyStockPreparationAction({ ...small, dryRunToken: dry.dryRunToken, permission: 'write', sandboxPolicy: policy, projectWriteGuard: guard }))
        expect(applied.status).toBe('succeeded')
        const qtyRaw: string = (sb.target.fieldIdMap && sb.target.fieldIdMap.rawQuantity) || 'rawQuantity'
        const qtyTotal: string = (sb.target.fieldIdMap && sb.target.fieldIdMap.totalQuantity) || 'totalQuantity'
        const quantities = async () => (await q(
          `SELECT (data->>$2)::numeric AS raw, (data->>$3)::numeric AS total FROM meta_records WHERE sheet_id = $1 ORDER BY 1, 2`,
          [sb.sheetId, qtyRaw, qtyTotal],
        )).rows.map((row: any) => [Number(row.raw), Number(row.total)])
        expect(await quantities(), 'calibration: the newer write').toEqual([[3, 15], [5, 5]])
        const generation = (await lock.readGeneration(sb.key)).generation
        const reapproved = await settle(approve(`swl_d11_apply_revived_${TOKEN}`))
        expect(reapproved.ok).toBe(false)
        expect((reapproved as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
        expect((reapproved as any).error.details.reason).toBe('expansion_stale')
        expect((await lock.readGeneration(sb.key)).generation, 'nothing bumped').toBe(generation)
        // the old approval's own job cannot write either
        const oldChunk = await settle(lock.withProjectWriteLease(sb.key, { purpose: 'large_apply_chunk', runId: 'swl-d11-chunk' }, async (guard: any) =>
          largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId, applyJobId: `swl_d11_apply_old_${TOKEN}`, recordsApi: await scopedForChunk(), projectWriteGuard: guard, refreshGovernanceGate: realChunkGate(jobScope.tenantId, projectNo) })))
        expect(oldChunk.ok).toBe(false)
        expect((oldChunk as any).error.details.reason).toBe('newer_plan')
        expect(await quantities(), 'the quantities stay 5 / 15').toEqual([[3, 15], [5, 5]])
      } finally {
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    // ── D17–D18: batch-refresh phase 2 step 4, PR-0 — the carry-confirm write under the lease ─────────
    // The carry pair on a sandbox sheet: an INACTIVE predecessor holding a human note, and its re-keyed,
    // blank, active successor — created through the REAL host with the target's physical ids.
    const CARRY_COMPONENT = 'SWL-PART-X'
    function carryKeys(projectNo: string) {
      return {
        oldKey: JSON.stringify({ projectNo, componentSourceId: CARRY_COMPONENT, parentSourceId: null, path: ['OLD', CARRY_COMPONENT] }),
        newKey: JSON.stringify({ projectNo, componentSourceId: CARRY_COMPONENT, parentSourceId: null, path: ['NEW', CARRY_COMPONENT] }),
      }
    }
    function carryDecision(projectNo: string) {
      const { oldKey, newKey } = carryKeys(projectNo)
      return {
        decision: 'carry_via_confirm', idempotencyKey: newKey, sourceIdempotencyKey: oldKey, componentSourceId: CARRY_COMPONENT,
        carryKey: 'component_source_id', manualRowReattach: 'propose_confirm', carryFields: ['notes'], writeVia: 'k2_confirm',
        requiresConfirm: true, carry: true,
      }
    }
    async function seedCarryPair(sb: any, projectNo: string) {
      const physical = (logical: string) => (sb.target.fieldIdMap && sb.target.fieldIdMap[logical]) || logical
      const toPhysical = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([key, value]) => [physical(key), value]))
      const { oldKey, newKey } = carryKeys(projectNo)
      const records = sb.multitable.records as any
      await records.createRecord({ sheetId: sb.sheetId, data: toPhysical({ projectNo, idempotencyKey: oldKey, componentSourceId: CARRY_COMPONENT, path: JSON.stringify(['OLD', CARRY_COMPONENT]), active: false, notes: 'synthetic note' }) })
      const target = await records.createRecord({ sheetId: sb.sheetId, data: toPhysical({ projectNo, idempotencyKey: newKey, componentSourceId: CARRY_COMPONENT, path: JSON.stringify(['NEW', CARRY_COMPONENT]), active: true }) })
      const readTarget = async () => {
        const row = (await q('SELECT version, data->>$2 AS notes FROM meta_records WHERE id = $1', [target.id, physical('notes')])).rows[0]
        return { version: Number(row.version), notes: row.notes as string | null }
      }
      return { physical, targetId: target.id as string, targetVersion: Number(target.version), readTarget }
    }
    // A records surface that holds the carry's ONE patch at the gate (after the executor's pre-write CAS, before the
    // host is asked), the D8 technique on the patch side.
    function heldPatchRecords(records: any) {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      let entered: () => void = () => {}
      const reached = new Promise<void>((resolve) => { entered = resolve })
      const fences: unknown[] = []
      const api: any = {
        ...records,
        async patchRecord(input: any) {
          fences.push(input.writeFence)
          entered()
          await gate
          return records.patchRecord(input)
        },
      }
      return { api, reached, release, fences }
    }
    const carryUnder = (lock: any, key: string, records: any, target: any, projectNo: string, runId: string) =>
      lock.withProjectWriteLease(key, { purpose: 'carry_confirm', runId }, (guard: any) =>
        confirmWrites.applyCarryViaConfirm({ permission: 'admin', recordsApi: records, target, decision: carryDecision(projectNo), confirmedBy: 'swl-carry', writeFence: guard, writeFenceRequired: true }))

    test('D17 (PR-0) a carry frozen between its pre-write CAS and its host patch; the lease lapses and another session takes over; the carry resumes: the REAL host refuses the fenced patch — the human cell stays blank, the version unchanged, LEASE_LOST, nothing bumped', async () => {
      const sb = await sandboxSheet('d17')
      const projectNo = 'SYN-SWL-D17'
      try {
        const base = Date.now()
        const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA), now: () => new Date(base) })
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS) })
        expect(sb.multitable.records.supportsWriteFence, 'the production host declares fenced writes').toBe(true)
        const pair = await seedCarryPair(sb, projectNo)
        expect((await pair.readTarget()).notes, 'calibration: the successor is blank').toBeNull()
        const held = heldPatchRecords(sb.multitable.records)
        const runningA = settle(carryUnder(lockA, sb.key, held.api, sb.target, projectNo, 'swl-d17-a'))
        await held.reached
        const fence: any = held.fences[0]
        expect(fence && fence.lock, 'the patch carries the host fence').toBe(PROJECT_WRITE_LOCK_TABLE)
        expect(fence.scopeKey).toBe(sb.key)
        const duringA = (await q(`SELECT lease_id, lease_purpose, fencing_epoch, generation FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sb.key])).rows[0]
        expect(duringA.lease_purpose).toBe('carry_confirm')
        expect(duringA.lease_id).toBe(fence.leaseId)
        // B: on its clock the carry's lease lapsed; a small apply takes the sheet over (epoch + 1, new lease id).
        const grantB = await lockB.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d17-b' })
        expect(grantB.takeover).toBe(true)
        expect(grantB.fencingEpoch).toBe(Number(duringA.fencing_epoch) + 1)
        held.release()
        const outcome = await runningA
        expect(outcome.ok, 'the carry must not report success').toBe(false)
        const error = (outcome as any).error
        expect(error.code).toBe(PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
        expect(error.fence).toBe(true)
        const after = await pair.readTarget()
        expect(after.notes, 'the REAL host wrote nothing for the resumed patch').toBeNull()
        expect(after.version).toBe(pair.targetVersion)
        const row = (await q(`SELECT lease_id, fencing_epoch, generation FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sb.key])).rows[0]
        expect(row.lease_id, 'the taker-over still holds the sheet; the loser released nothing').toBe(grantB.leaseId)
        expect(row.generation, 'nothing bumped').toBe(Number(duringA.generation))
        await lockB.createGuard(grantB).release()
      } finally {
        await dropSheet(sb.sheetId)
      }
    }, 60000)

    test('D18 (PR-0, E01 cross-lane) carry vs apply interleaving through the real lock and host: a carry mid-patch refuses a preview bump and an apply acquire (holder carry_confirm); after it lands and bumps carry_confirm, the token minted before it is PLAN_SUPERSEDED with nothing written; an apply mid-write refuses a carry (holder small_apply) and the executor never runs; the carried note survives the apply', async () => {
      const sb = await sandboxSheet('d18')
      const projectNo = 'SYN-SWL-D18'
      try {
        const lockA = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
        const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB) })
        const records = sb.multitable.records as any
        const pair = await seedCarryPair(sb, projectNo)
        const policy = { enabled: true, allowedTargetObjectIds: [sb.objectId] }
        const common = (api: any) => ({
          action: sb.action, parameters: { projectNo }, sourceAdapter: sourceOf(projectNo), recordsApi: api,
          tokenStore: sb.pluginContext.storage, plannedAt: '2026-10-22T08:00:00.000Z', runId: `swl_d18_${TOKEN}`,
          refreshGovernance: realRefreshHandle(`tenant_swl_d18_${TOKEN}`),
        })
        const preview = (lock: any) => tableActions.dryRunStockPreparationAction({ ...common(records), projectWriteGenerationBinder: async () => writeBindingFromGeneration(await lock.bumpGeneration(sb.key, { reason: 'small_preview' })) })
        const applyWith = (lock: any, api: any, token: string, runId: string) => lock.withProjectWriteLease(sb.key, { purpose: 'small_apply', runId }, (guard: any) =>
          tableActions.applyStockPreparationAction({ ...common(api), dryRunToken: token, permission: 'write', sandboxPolicy: policy, projectWriteGuard: guard }))
        // 1. the puller previews BEFORE the carry: a token bound to this generation.
        const dryBefore = await preview(lockA)
        expect(dryBefore.canApply).toBe(true)
        const rowsBeforeCarry = await countRows(sb.sheetId)
        // 2. the carry, held at its patch (lease live): a preview bump and an apply acquire are both refused, naming it.
        const held = heldPatchRecords(records)
        const runningCarry = settle(carryUnder(lockA, sb.key, held.api, sb.target, projectNo, 'swl-d18-carry'))
        await held.reached
        const bumpDuring = await settle(lockB.bumpGeneration(sb.key, { reason: 'small_preview' }))
        expect(bumpDuring.ok).toBe(false)
        expect((bumpDuring as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
        expect((bumpDuring as any).error.details.holderPurpose).toBe('carry_confirm')
        const acquireDuring = await settle(lockB.acquire(sb.key, { purpose: 'small_apply', runId: 'swl-d18-contender' }))
        expect(acquireDuring.ok).toBe(false)
        expect((acquireDuring as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
        expect((acquireDuring as any).error.details.holderPurpose).toBe('carry_confirm')
        held.release()
        const carried = await runningCarry
        expect(carried.ok, JSON.stringify((carried as any).error && (carried as any).error.code)).toBe(true)
        expect((carried as any).value.mode).toBe('carried')
        expect((await pair.readTarget()).notes).toBe('synthetic note')
        // 3. after release the route bumps `carry_confirm`: the token minted before the carry is superseded.
        const bumped = await lockA.bumpGeneration(sb.key, { reason: 'carry_confirm' })
        expect(bumped.generation).toBe(2)
        const stale = await settle(applyWith(lockB, records, dryBefore.dryRunToken, 'swl-d18-stale'))
        expect(stale.ok).toBe(false)
        expect((stale as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
        expect((stale as any).error.details.reason).toBe('newer_plan')
        expect((stale as any).error.details.currentReason).toBe('carry_confirm')
        expect((stale as any).error.details.partial).toBe(false)
        expect(await countRows(sb.sheetId), 'the stale plan wrote nothing').toBe(rowsBeforeCarry)
        // 4. a fresh preview + apply, held at its first host write: a carry is refused, naming the apply, and the
        //    executor is never entered; after release the apply lands and the carried note survives it.
        const dryAfter = await preview(lockA)
        expect(dryAfter.canApply).toBe(true)
        let releaseCreate: () => void = () => {}
        const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
        let createEntered: () => void = () => {}
        const createReached = new Promise<void>((resolve) => { createEntered = resolve })
        let heldOnce = false
        const heldApply: any = {
          ...records,
          async createRecord(input: any) {
            if (!heldOnce) { heldOnce = true; createEntered(); await createGate }
            return records.createRecord(input)
          },
        }
        const runningApply = settle(applyWith(lockA, heldApply, dryAfter.dryRunToken, 'swl-d18-apply'))
        await createReached
        let executorEntered = false
        const carryDuringApply = await settle(lockB.withProjectWriteLease(sb.key, { purpose: 'carry_confirm', runId: 'swl-d18-carry-2' }, async () => { executorEntered = true }))
        expect(carryDuringApply.ok).toBe(false)
        expect((carryDuringApply as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
        expect((carryDuringApply as any).error.details.holderPurpose).toBe('small_apply')
        expect(executorEntered, 'a refused lease never enters the executor').toBe(false)
        releaseCreate()
        const applied = await runningApply
        expect(applied.ok, JSON.stringify((applied as any).error && (applied as any).error.code)).toBe(true)
        expect((applied as any).value.status).toBe('succeeded')
        expect((await pair.readTarget()).notes, 'the apply never touches the human cell').toBe('synthetic note')
        const row = (await q(`SELECT lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sb.key])).rows[0]
        expect(row.lease_id).toBeNull()
      } finally {
        await dropSheet(sb.sheetId)
      }
    }, 60000)
    // ── 备料分批拉取第一期 step 3 PR B: the pilot marker (migration 101), the enable route on the real stack, L02 ──
    //
    // D19 migration 101: the three columns, the pilot CHECK (both-or-neither; version >= 1) and the audit vocabulary.
    // D20 the enable ROUTE over the real host, lock, registry and audit store: readiness passes on a really prepared
    //     sheet (the step-4 tables are STUBS created here — the later migrations are not in this build — and the
    //     build marker is flipped in memory, exactly the two things the readiness list exists to wait for), the
    //     generation is bumped, the host stamp lands in meta_sheets.grid_export_closure through the #6507 port,
    //     the registry row is marked, ONE audit row; export-xlsx (xlsx + csv) answers 403 MULTITABLE_GRID_EXPORT_CLOSED;
    //     a re-POST repairs nothing new and writes no second audit row.
    // D21 (L02) a job approved BEFORE the enablement: the chunk inside the real lease is refused with the PILOT code
    //     (the enable's bump would have made it PLAN_SUPERSEDED — the control run without the check proves the
    //     order), the job stays queued and meta_records is untouched.
    const PILOT_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/pilot'
    const httpRoutes = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
    const projectTargetStoreModule = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
    const auditStoreModule = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
    const projectTargetsModule = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
    const ownBase = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
    const pilotGateModule = require(path.join(PLUGIN_LIB, 'stock-preparation-pilot-gate.cjs')) as any
    const continuationSupport = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-support.cjs')) as any
    const projectSheetHarness = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')) as any
    // Pre-enable hardening (H-series): the readiness evaluator (version 2) and the pack-install ledger store.
    const readinessModule = require(path.join(PLUGIN_LIB, 'stock-preparation-pilot-readiness.cjs')) as any
    const packInstallStoreModule = require(path.join(PLUGIN_LIB, 'stock-preparation-pack-install-store.cjs')) as any

    function routeResponse() {
      const res: any = { statusCode: 200, body: null, headers: {} }
      res.status = (code: number) => { res.statusCode = code; return res }
      res.json = (payload: unknown) => { res.body = payload; return res }
      res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res }
      res.send = (payload: unknown) => { res.body = payload; return res }
      res.end = () => res
      return res
    }
    async function callRoute(routes: Map<string, any>, method: string, routePath: string, req: Record<string, unknown>) {
      const handler = routes.get(`${method} ${routePath}`)
      if (!handler) throw new Error(`route ${method} ${routePath} is not registered`)
      const res = routeResponse()
      await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
      return res
    }

    test('D19 (PR B) migration 101: the three pilot columns, the pilot CHECK (both-or-neither, version >= 1), and the audit vocabulary accepts project_pilot_enable', async () => {
      const cols = await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'integration_stock_prep_project_target' AND column_name IN ('pilot_enabled_at', 'pilot_enabled_by', 'pilot_readiness_version')
          ORDER BY column_name`,
      )
      expect(cols.rows.map((row: any) => [row.column_name, row.data_type, row.is_nullable])).toEqual([
        ['pilot_enabled_at', 'timestamp with time zone', 'YES'],
        ['pilot_enabled_by', 'text', 'YES'],
        ['pilot_readiness_version', 'integer', 'YES'],
      ])
      const tenant = `tenant_swl_d19_${TOKEN}`
      const id = `pt_d19_${TOKEN}`
      const insert = (at: string | null, version: number | null) => q(
        `INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status, pilot_enabled_at, pilot_enabled_by, pilot_readiness_version)
         VALUES ($1, $2, 'SYN-SWL-D19', $3, $4, 'active', $5, $6, $7)`,
        [id, tenant, `sheet_swl_d19_${TOKEN}`, `plm_stock_preparation_sandbox_p_d19${TOKEN}`, at, at ? 'syn' : null, version],
      )
      try {
        for (const [at, version] of [['2026-10-23T00:00:00Z', null], [null, 1], ['2026-10-23T00:00:00Z', 0]] as const) {
          const refused = await settle(insert(at, version))
          expect(refused.ok, `${at} / ${version}`).toBe(false)
          expect((refused as any).error.code, `${at} / ${version}`).toBe('23514')
        }
        await insert(null, null)
        await q('DELETE FROM integration_stock_prep_project_target WHERE id = $1', [id])
        await insert('2026-10-23T00:00:00Z', 1)
        const stored = (await q('SELECT pilot_enabled_at, pilot_enabled_by, pilot_readiness_version FROM integration_stock_prep_project_target WHERE id = $1', [id])).rows[0]
        expect(stored.pilot_enabled_by).toBe('syn')
        expect(stored.pilot_readiness_version).toBe(1)
        // The audit vocabulary (re-listed by 101) accepts the new action and still refuses an unknown one.
        const auditId = `audit_d19_${TOKEN}`
        await q(
          `INSERT INTO integration_stock_prep_audit (id, tenant_id, project_id, action, subject_id, mode, actor, detail)
           VALUES ($1, $2, 'SYN-SWL-D19', 'project_pilot_enable', $3, 'enabled', 'syn', '{"readinessVersion":1}'::jsonb)`,
          [auditId, tenant, `sheet_swl_d19_${TOKEN}`],
        )
        const unknown = await settle(q(
          `INSERT INTO integration_stock_prep_audit (id, tenant_id, project_id, action, subject_id, mode, actor, detail)
           VALUES ($1, $2, 'SYN-SWL-D19', 'project_pilot_disable', $3, 'disabled', 'syn', '{}'::jsonb)`,
          [`${auditId}_unknown`, tenant, `sheet_swl_d19_${TOKEN}`],
        ))
        expect(unknown.ok).toBe(false)
        expect((unknown as any).error.code).toBe('23514')
      } finally {
        await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [tenant]).catch(() => {})
        await q('DELETE FROM integration_stock_prep_project_target WHERE id = $1', [id]).catch(() => {})
      }
    })

    test('D20 (PR B) the enable route on the real stack: readiness, bump, the host stamp through the #6507 port, the registry mark, one audit row; export-xlsx 403; a re-POST writes no second audit row', async () => {
      const tenantId = `tenant_swl_d20_${TOKEN}`
      const projectNo = 'SYN-SWL-D20'
      const projectId = `${tenantId}:integration-core`
      const objectId: string = ownBase.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = createProductionPluginContext()
      const multitable = pluginContext.api.multitable
      if (!multitable) throw new Error('production plugin context is missing multitable APIs')
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      const sheetId: string = ensured.target.sheetId
      const key = sheetWriteScopeKey(sheetId)
      scopes.push(key)
      const db = createDb({ database: pluginContext.api.database })
      const store = projectTargetStoreModule.createStockPreparationProjectTargetStore({ db })
      const audit = auditStoreModule.createStockPreparationAuditStore({ db })
      const lock = createStockPreparationProjectWriteLock({ db })
      const admin = { id: `u_d20_admin_${TOKEN}`, tenantId, permissions: ['stock-prep:admin'] }
      const envBefore = process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
      const markerBefore = continuationSupport.CONTINUATION_SUPPORT_VERSION
      const STEP4_STUB_TABLES = ['integration_stock_prep_continuation', 'integration_stock_prep_refresh_state']
      const createdStubs: string[] = []
      process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = 'true'
      continuationSupport.CONTINUATION_SUPPORT_VERSION = 1
      try {
        await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
        const plmLock = await projectTargetsModule.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
        expect(plmLock.missing).toBe(0)
        await store.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
        // STUBS of the step-4 stores (PR-2 creates the real ones): what the readiness probe waits for. Created
        // ONLY where absent and dropped ONLY when this test created them — the real-DB step shares one database,
        // and once PR-2's migrations exist these names are real tables that must survive this test.
        for (const table of STEP4_STUB_TABLES) {
          const exists = (await q('SELECT to_regclass($1) AS oid', [table])).rows[0].oid !== null
          if (!exists) {
            await q(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`)
            createdStubs.push(table)
          }
        }
        const routes = new Map<string, any>()
        const envTarget = { sheetId: `sheet_env_d20_${TOKEN}`, objectId: 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} }
        const routeContext = {
          api: {
            http: { addRoute: (method: string, routePath: string, handler: any) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
            multitable,
            database: pluginContext.api.database,
          },
          storage: pluginContext.storage,
          config: {
            stockPreparationTableActions: [{
              actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID,
              source: { externalSystemId: `swl_source_rdb_d20_${TOKEN}`, kind: 'data-source:sql-readonly' },
              target: envTarget,
            }],
            stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envTarget.objectId] },
            // Readiness version 2 (pre-enable hardening O-8): this synthetic deployment runs without a customer pack.
            stockPreparationPilot: { specReadPlanSlot: 'not_applicable', customerPack: 'not_applicable' },
          },
        }
        const base = projectSheetHarness.baseServices(sourceOf(projectNo))
        const services = {
          ...base,
          externalSystemRegistry: { ...base.externalSystemRegistry, async listExternalSystems() { return [] } },
          pipelineRegistry: { ...base.pipelineRegistry, async listPipelines() { return [] } },
          stockPreparationProjectWriteLock: lock,
          stockPreparationProjectTargetStore: store,
          stockPreparationAuditStore: audit,
          // Readiness version 2 (O-8): the pack-install ledger is read strictly — the real store, an empty ledger for this tenant.
          stockPreparationPackInstallStore: packInstallStoreModule.createStockPreparationPackInstallStore({ db }),
          tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
        }
        httpRoutes.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
        // GET: every readiness check passes on the really prepared sheet.
        const read = await callRoute(routes, 'GET', PILOT_PATH, { user: admin, params: { projectNo }, query: {} })
        expect(read.statusCode, JSON.stringify(read.body)).toBe(200)
        expect(read.body.data.readiness.failing, JSON.stringify(read.body.data.readiness)).toEqual([])
        expect(read.body.data.may).toEqual({ enable: true })
        expect(read.body.data.pilot.enabled).toBe(false)
        // Before: the host column is open, no audit row, generation 0.
        expect((await q('SELECT grid_export_closure FROM meta_sheets WHERE id = $1', [sheetId])).rows[0].grid_export_closure).toBeNull()
        // POST: the enablement.
        const enabled = await callRoute(routes, 'POST', PILOT_PATH, { user: admin, params: { projectNo }, body: { confirmProjectNo: projectNo } })
        expect(enabled.statusCode, JSON.stringify(enabled.body)).toBe(200)
        expect(enabled.body.data.enabled).toBe(true)
        expect(enabled.body.data.alreadyEnabled).toBe(false)
        expect(enabled.body.data.exportClosure).toEqual({ closed: true, alreadyClosed: false })
        const stamp = (await q('SELECT grid_export_closure, grid_export_closed_by, grid_export_closed_at FROM meta_sheets WHERE id = $1', [sheetId])).rows[0]
        expect(stamp.grid_export_closure).toBe('stock_prep_pilot')
        expect(stamp.grid_export_closed_by).toBe(admin.id)
        expect(stamp.grid_export_closed_at).not.toBeNull()
        const row = (await q('SELECT pilot_enabled_at, pilot_enabled_by, pilot_readiness_version FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [tenantId, projectNo])).rows[0]
        expect(row.pilot_enabled_at).not.toBeNull()
        expect(row.pilot_enabled_by).toBe(admin.id)
        expect(row.pilot_readiness_version).toBe(readinessModule.PILOT_READINESS_VERSION)
        const lockRow = (await q(`SELECT generation, generation_reason, lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])).rows[0]
        expect(lockRow.generation).toBe(1)
        expect(lockRow.generation_reason).toBe('pilot_enable')
        expect(lockRow.lease_id).toBeNull()
        const auditRows = (await q(`SELECT subject_id, mode, actor, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'project_pilot_enable'`, [tenantId])).rows
        expect(auditRows).toHaveLength(1)
        expect(auditRows[0].subject_id).toBe(sheetId)
        expect(auditRows[0].mode).toBe('enabled')
        expect(auditRows[0].actor).toBe(admin.id)
        expect(auditRows[0].detail).toEqual({ objectId, readinessVersion: readinessModule.PILOT_READINESS_VERSION, exportClosureAlreadyClosed: false, generationBumped: true })
        // The re-POST: idempotent on the host, set-once in the registry, no second audit row, generation moved again.
        const again = await callRoute(routes, 'POST', PILOT_PATH, { user: admin, params: { projectNo }, body: { confirmProjectNo: projectNo } })
        expect(again.statusCode, JSON.stringify(again.body)).toBe(200)
        expect(again.body.data.alreadyEnabled).toBe(true)
        expect(again.body.data.exportClosure).toEqual({ closed: true, alreadyClosed: true })
        expect((await q(`SELECT COUNT(*)::int AS n FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'project_pilot_enable'`, [tenantId])).rows[0].n).toBe(1)
        expect((await q('SELECT grid_export_closed_by FROM meta_sheets WHERE id = $1', [sheetId])).rows[0].grid_export_closed_by).toBe(admin.id)
        // GET after: enabled, nothing more to enable.
        const after = await callRoute(routes, 'GET', PILOT_PATH, { user: admin, params: { projectNo }, query: {} })
        expect(after.body.data.pilot.enabled).toBe(true)
        expect(after.body.data.may).toEqual({ enable: false })
        // U09 end to end with #6507: the stamped sheet refuses the generic grid export for an admin, xlsx and csv.
        await q(
          `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
           VALUES ($1, $2, $1, 'x', 'admin', '[]'::jsonb, TRUE, TRUE)
           ON CONFLICT (id) DO NOTHING`,
          [admin.id, `${admin.id}@example.test`],
        )
        invalidateUserPerms(admin.id)
        const app = express()
        app.use(express.json())
        app.use((req, _res, next) => { (req as { user?: unknown }).user = { id: admin.id, roles: ['admin'], perms: [] }; next() })
        app.use('/api/multitable', univerMetaRouter())
        for (const format of ['xlsx', 'csv']) {
          const res = await request(app).get(`/api/multitable/sheets/${sheetId}/export-xlsx`).query(format === 'csv' ? { format } : {})
          expect(res.status, `${format}: ${JSON.stringify(res.body)}`).toBe(403)
          expect(JSON.stringify(res.body)).toContain('MULTITABLE_GRID_EXPORT_CLOSED')
        }
      } finally {
        if (envBefore === undefined) delete process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
        else process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = envBefore
        continuationSupport.CONTINUATION_SUPPORT_VERSION = markerBefore
        for (const table of createdStubs) await q(`DROP TABLE IF EXISTS ${table}`).catch(() => {})
        await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [tenantId]).catch(() => {})
        await q('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [tenantId]).catch(() => {})
        await q('DELETE FROM user_permissions WHERE user_id = $1', [admin.id]).catch(() => {})
        await q('DELETE FROM users WHERE id = $1', [admin.id]).catch(() => {})
        await dropSheet(sheetId)
      }
    }, 90000)

    test('D21 (PR B, L02) a job approved BEFORE the enablement: the chunk inside the real lease is refused with the pilot code (not PLAN_SUPERSEDED), the job stays queued, meta_records untouched', async () => {
      const sb = await sandboxSheet('d21')
      const projectNo = 'SYN-SWL-D21'
      const tenantId = `tenant_swl_d21_${TOKEN}`
      try {
        const db = createDb({ database: sb.pluginContext.api.database })
        const lock = createStockPreparationProjectWriteLock({ db })
        const store = projectTargetStoreModule.createStockPreparationProjectTargetStore({ db })
        await store.create({ tenantId, projectNo, sheetId: sb.sheetId, objectId: sb.objectId, createdBy: 'syn' })
        const storage: any = sb.pluginContext.storage
        const jobScope = { tenantId, workspaceId: `ws_swl_d21_${TOKEN}` }
        const actionId = sb.action.actionId
        const jobId = `swl_d21_${TOKEN}`
        const applyJobId = `swl_d21_apply_${TOKEN}`
        const records = sb.multitable.records as any
        const scopedForChunk = () => tableActions.createTargetScopedRecordsApi(records, sb.target, { fieldIdTranslation: 'pre_mapped' })
        // Approved BEFORE the enablement, the way the routes do it.
        await largeBomJobs.createLargeBomBackgroundExpansionJob({
          storage, ...jobScope, action: sb.action, parameters: { projectNo }, principal: 'swl-d19', createJobId: () => jobId,
          writeGenerationObserver: async () => writeObservationFromGeneration(await lock.observeGeneration(sb.key)),
        })
        await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId, jobId, sourceAdapter: sourceOf(projectNo, '2') })
        await largeBomJobs.planLargeBomBackgroundExpansionJob({
          storage, ...jobScope, actionId, jobId,
          existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, sb.target, projectNo),
          governanceVerdict: await realPlanVerdict(jobScope.tenantId, projectNo, sb.target.sheetId),
          writeGenerationReader: (observed: string) => lock.readGeneration(observed),
        })
        const approved = await largeBomJobs.createLargeBomCheckpointApplyJob({
          storage, ...jobScope, actionId, jobId, principal: 'swl-d19', permission: 'write', createApplyJobId: () => applyJobId,
          writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await lock.bumpGeneration(sb.key, { reason: 'large_approval', expect })),
        })
        expect(approved.status).toBe('queued')
        expect(approved.totalDecisions).toBeGreaterThan(0)
        // THE ENABLEMENT on the lock and the registry, as the route performs it.
        await lock.bumpGeneration(sb.key, { reason: 'pilot_enable', tenantId })
        const marked = await store.markPilotEnabled({ tenantId, projectNo, actorId: 'swl-d21-admin', readinessVersion: 1 })
        expect(marked.enabled).toBe(true)
        const gate = pilotGateModule.createStockPreparationPilotGate({ store })
        const before = await countRows(sb.sheetId)
        const chunk = await settle(lock.withProjectWriteLease(sb.key, { purpose: 'large_apply_chunk', runId: 'swl-d21-chunk' }, async (guard: any) =>
          largeBomJobs.runLargeBomCheckpointApplyJobChunk({
            storage, ...jobScope, actionId, applyJobId, recordsApi: await scopedForChunk(), projectWriteGuard: guard,
            largeLanePilotCheck: ({ target }: any) => gate.assertLargeLaneAllowed({ tenantId, projectNo, sheetId: target && target.sheetId }, 'large_apply_chunk'),
            refreshGovernanceGate: realChunkGate(tenantId, projectNo),
          })))
        expect(chunk.ok).toBe(false)
        expect((chunk as any).error.code).toBe('STOCK_PREP_PILOT_LARGE_LANE_REFUSED')
        expect((chunk as any).error.status).toBe(409)
        expect((chunk as any).error.details).toMatchObject({ lane: 'large_apply_chunk', reason: 'pilot_project', byProject: true, bySheet: true, partial: false })
        expect(await countRows(sb.sheetId), 'zero meta_records writes').toBe(before)
        const job = await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId, applyJobId })
        expect(job.status).toBe('queued')
        expect(job.checkpoint.nextDecisionIndex).toBe(0)
        expect((await q(`SELECT lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sb.key])).rows[0].lease_id).toBeNull()
        // CONTROL: without the pilot check the same chunk is refused by the generation binding (the enable's bump) —
        // so the pilot check is what ran FIRST above, and the registry's marker is what refused.
        const control = await settle(lock.withProjectWriteLease(sb.key, { purpose: 'large_apply_chunk', runId: 'swl-d21-control' }, async (guard: any) =>
          largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId, applyJobId, recordsApi: await scopedForChunk(), projectWriteGuard: guard, refreshGovernanceGate: realChunkGate(tenantId, projectNo) })))
        expect(control.ok).toBe(false)
        expect((control as any).error.code).toBe(PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
        expect((control as any).error.details.reason).toBe('newer_plan')
        expect(await countRows(sb.sheetId)).toBe(before)
        // The marker read by sheet alone (what the chunk's in-lease check reads) says pilot.
        expect((await store.getPilotStateBySheetId({ sheetId: sb.sheetId })).pilot).toBe(true)
      } finally {
        await q('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [tenantId]).catch(() => {})
        await dropSheet(sb.sheetId)
      }
    }, 90000)

    // ── Pre-enable hardening (step-4 design §23.4 F-3 / F-4) — the H series ────────────────────────────────────
    // H-01 (F-3) no_open_large_job against a REAL job in the REAL durable job store (plugin_kv, jsonb round trip):
    //      approved through the real lock, one chunk of one decision lands on the real host and the job is
    //      `paused` — the scan counts it on its own sheet only, the readiness check fails; finishing the job
    //      through further chunks turns it terminal and the check passes.
    // H-02 (F-4c) the audit row commits WITH the mark on real PostgreSQL: a crash inside the mark transaction —
    //      before the audit insert, and AFTER it (the insert landed in the transaction) — rolls back BOTH (row not
    //      pilot, zero audit rows); the completing call writes exactly one; a repeat call (already pilot) none.
    test('H-01 (pre-enable F-3) no_open_large_job on a real paused checkpoint job in plugin_kv: counted on its sheet only, readiness fails; finished ⇒ terminal, readiness passes', async () => {
      const sb = await sandboxSheet('h01')
      const projectNo = 'SYN-SWL-H01'
      const tenantId = `tenant_swl_h01_${TOKEN}`
      const jobScope = { tenantId, workspaceId: `ws_swl_h01_${TOKEN}` }
      try {
        const db = createDb({ database: sb.pluginContext.api.database })
        const lock = createStockPreparationProjectWriteLock({ db })
        const storage: any = sb.pluginContext.storage
        expect(storage.durable, 'calibration: the production plugin storage is the durable plugin_kv store').toBe(true)
        const actionId = sb.action.actionId
        const jobId = `swl_h01_${TOKEN}`
        const applyJobId = `swl_h01_apply_${TOKEN}`
        const records = sb.multitable.records as any
        const scopedForChunk = () => tableActions.createTargetScopedRecordsApi(records, sb.target, { fieldIdTranslation: 'pre_mapped' })
        await largeBomJobs.createLargeBomBackgroundExpansionJob({
          storage, ...jobScope, action: sb.action, parameters: { projectNo }, principal: 'swl-h01', createJobId: () => jobId,
          writeGenerationObserver: async () => writeObservationFromGeneration(await lock.observeGeneration(sb.key)),
        })
        await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId, jobId, sourceAdapter: sourceOf(projectNo, '2') })
        await largeBomJobs.planLargeBomBackgroundExpansionJob({
          storage, ...jobScope, actionId, jobId,
          existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, sb.target, projectNo),
          governanceVerdict: await realPlanVerdict(jobScope.tenantId, projectNo, sb.target.sheetId),
          writeGenerationReader: (observed: string) => lock.readGeneration(observed),
        })
        const approved = await largeBomJobs.createLargeBomCheckpointApplyJob({
          storage, ...jobScope, actionId, jobId, principal: 'swl-h01', permission: 'write', createApplyJobId: () => applyJobId,
          writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await lock.bumpGeneration(sb.key, { reason: 'large_approval', expect })),
        })
        expect(approved.totalDecisions, 'calibration: at least two decisions, so one chunk of one leaves the job paused').toBeGreaterThanOrEqual(2)
        const runChunk = () => lock.withProjectWriteLease(sb.key, { purpose: 'large_apply_chunk', runId: `swl-h01-chunk-${Date.now()}` }, async (guard: any) =>
          largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId, applyJobId, recordsApi: await scopedForChunk(), projectWriteGuard: guard, maxDecisionsPerChunk: 1, refreshGovernanceGate: realChunkGate(tenantId, projectNo) }))
        const first = await runChunk()
        expect(first.status).toBe('paused')
        expect(await countRows(sb.sheetId), 'the chunk really landed on the host').toBeGreaterThan(0)
        // The job as plugin_kv stores it (jsonb), read back raw: paused, targeting this sheet.
        const stored = (await q(`SELECT value->>'status' AS status, value->'target'->>'sheetId' AS sheet_id FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1`, [largeBomJobs.__internals.checkpointApplyJobKey({ ...jobScope, actionId, applyJobId })])).rows
        expect(stored).toEqual([{ status: 'paused', sheet_id: sb.sheetId }])
        const scan = await largeBomJobs.countOpenLargeBomCheckpointApplyJobsForSheet({ storage, sheetId: sb.sheetId })
        expect(scan.open).toBe(1)
        expect(scan.unattributed).toBe(0)
        const otherSheet = await largeBomJobs.countOpenLargeBomCheckpointApplyJobsForSheet({ storage, sheetId: `sheet_swl_h01_other_${TOKEN}` })
        expect(otherSheet.open, 'another sheet sees none of it').toBe(0)
        const readinessOf = async () => {
          const answer = await readinessModule.evaluatePilotReadiness({
            countOpenLargeJobs: () => largeBomJobs.countOpenLargeBomCheckpointApplyJobsForSheet({ storage, sheetId: sb.sheetId }),
          })
          return answer.checks.find((check: any) => check.id === 'no_open_large_job').ok
        }
        expect(await readinessOf(), 'a paused job on the sheet fails no_open_large_job').toBe(false)
        // 旧作业处置: run it to its end — the job turns terminal and the check passes.
        let job = first
        for (let i = 0; i < 20 && job.status === 'paused'; i += 1) job = await runChunk()
        expect(['succeeded', 'partial']).toContain(job.status)
        expect((await largeBomJobs.countOpenLargeBomCheckpointApplyJobsForSheet({ storage, sheetId: sb.sheetId })).open).toBe(0)
        expect(await readinessOf(), 'a finished job no longer blocks').toBe(true)
      } finally {
        await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`stock-preparation:large-bom:%:${tenantId}:%`]).catch(() => {})
        await dropSheet(sb.sheetId)
      }
    }, 90000)

    test('H-02 (pre-enable F-4c) the mark and its audit row share one real transaction: a crash before or after the audit insert leaves neither; completing writes exactly one; a repeat none', async () => {
      const tenantId = `tenant_swl_h02_${TOKEN}`
      const projectNo = 'SYN-SWL-H02'
      const pluginContext = createProductionPluginContext()
      const db = createDb({ database: pluginContext.api.database })
      const store = projectTargetStoreModule.createStockPreparationProjectTargetStore({ db })
      const audit = auditStoreModule.createStockPreparationAuditStore({ db })
      const sheetId = `sheet_swl_h02_${TOKEN}`
      const objectId: string = ownBase.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const entry = { tenantId, projectId: projectNo, action: 'project_pilot_enable', subjectId: sheetId, mode: 'enabled', actor: 'swl-h02-admin', detail: { objectId, readinessVersion: readinessModule.PILOT_READINESS_VERSION, exportClosureAlreadyClosed: true, generationBumped: true } }
      const pilotRow = async () => (await q('SELECT pilot_enabled_at, pilot_readiness_version FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [tenantId, projectNo])).rows[0]
      const auditCount = async () => Number((await q(`SELECT COUNT(*)::int AS n FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'project_pilot_enable'`, [tenantId])).rows[0].n)
      const mark = (onMarked: any) => store.markPilotEnabled({ tenantId, projectNo, actorId: 'swl-h02-admin', readinessVersion: readinessModule.PILOT_READINESS_VERSION, onMarked })
      try {
        await store.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
        // (1) a crash inside the transaction BEFORE the audit insert: the compare-and-set rolls back.
        const crashBefore = await settle(mark(async () => { throw Object.assign(new Error('synthetic crash before the audit insert'), { code: 'SWL_H02' }) }))
        expect(crashBefore.ok).toBe(false)
        expect((crashBefore as any).error.code).toBe('SWL_H02')
        expect((await pilotRow()).pilot_enabled_at).toBeNull()
        expect(await auditCount()).toBe(0)
        // (2) a crash AFTER the audit insert landed in the transaction, before COMMIT: BOTH roll back.
        let insertedInside = false
        const crashAfter = await settle(mark(async (trx: any) => {
          await audit.appendWithin(trx, entry)
          insertedInside = true
          throw Object.assign(new Error('synthetic crash after the audit insert'), { code: 'SWL_H02' })
        }))
        expect(insertedInside, 'calibration: the audit insert ran inside the transaction').toBe(true)
        expect(crashAfter.ok).toBe(false)
        expect((await pilotRow()).pilot_enabled_at, 'the mark rolled back').toBeNull()
        expect((await pilotRow()).pilot_readiness_version).toBeNull()
        expect(await auditCount(), 'the audit insert rolled back with it').toBe(0)
        // (3) the completing call (the runbook's re-POST): marked, exactly one row, committed together.
        const done = await mark(async (trx: any) => { await audit.appendWithin(trx, entry) })
        expect(done.enabled).toBe(true)
        expect((await pilotRow()).pilot_enabled_at).not.toBeNull()
        expect((await pilotRow()).pilot_readiness_version).toBe(readinessModule.PILOT_READINESS_VERSION)
        expect(await auditCount()).toBe(1)
        // (4) a repeat (already pilot): the hook never runs, still exactly one row.
        let hookCalls = 0
        const again = await mark(async (trx: any) => { hookCalls += 1; await audit.appendWithin(trx, entry) })
        expect(again.alreadyEnabled).toBe(true)
        expect(hookCalls).toBe(0)
        expect(await auditCount()).toBe(1)
      } finally {
        await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [tenantId]).catch(() => {})
        await q('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [tenantId]).catch(() => {})
      }
    }, 60000)

    // ── Batch-refresh step 4 PR-2: the continuation / refresh-state stores (migrations 102 / 103) and the
    //    governance reader on real PostgreSQL. The hermetic suites drive them against a fake that models the
    //    unique indexes and rolls transactions back; a fake is not PostgreSQL, so the claims below are proven
    //    here: the partial unique claims arbitrate two SESSIONS (A08), the state-row FOR UPDATE serialises the
    //    decision / reconciliation races, a missing table is 503 (never zero rows), a header-steered tenant is
    //    refused (never "not governed"), and a project resolved to another sheet is refused (never matched).
    //    Review round 1 of #6514 adds: S2-07 / S2-08 / S2-09 (X-1) the consult is ONE REPEATABLE READ snapshot —
    //    frozen at every step-4 read boundary (and after the registry reads) while another session decides, it
    //    answers one instant, and a bounded natural race loop never persists a stale hold nor derives a torn
    //    complete; S2-10 (X-2) the end admissibility; S2-11 (X-3) the supersede relatedness. Review round 2 adds
    //    S2-12: a PARTIAL takeover cannot supersede — the reviewer's real-planner shape, refused with every row
    //    unchanged, and after a pilot exit the real planner and the REAL host writer still leave all four old rows
    //    alone; a full takeover supersedes and keeps them protected. S2-13: the reviewer's ANCESTOR counterexample —
    //    an independent subtree inserted beside the relationship (a synthetic starting state), the real planner's
    //    candidate over the full sheet and current projection (0 old rows, 4 new positions) refused; the next pull,
    //    pilot on and off, the real host writer and the third pull never write the four old rows.
    //    Cases are prefixed S2- (PR-0 / PR B own D17-D21, the pre-enable hardening H-01 / H-02). Every value is
    //    synthetic and per-run.
    describe('S2 continuation / refresh-state stores + governance reader (real Postgres, migrations 102 / 103)', () => {
      const nodeCrypto = require('node:crypto') as typeof import('node:crypto')
      const continuationStoreModule = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
      const governanceModule = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-governance.cjs')) as any
      const refreshStateModule = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-state.cjs')) as any
      const refreshKit = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-refresh-store-kit.cjs')) as any
      const { REFRESH_STORE_TABLES: RT, REFRESH_STORE_ERROR_CODES: RC } = continuationStoreModule
      const { REFRESH_GOVERNANCE_ERROR_CODES: GC } = governanceModule
      const S2_TENANT_PREFIX = `tenant_scs_${TOKEN}`
      const s2Sheets: string[] = []
      const tenantFor = (label: string) => `${S2_TENANT_PREFIX}_${label}`
      const sheetFor = (label: string) => {
        const id = `sheet_scs_${TOKEN}_${label}`
        s2Sheets.push(id)
        scopes.push(sheetWriteScopeKey(id))
        return id
      }
      const storeOn = (client: PoolClient) => continuationStoreModule.createStockPreparationContinuationStore({ db: dbOn(client) })
      const computation = (overrides: Record<string, unknown> = {}) => ({ lane: 'small_preview', suspended: true, generationToken: 'g_s2', sourceContentDigest: 'src_s2', ...overrides })
      // S2-01..S2-06 and S2-10 have no registry row: the registry's pilot reads (PR B, #6510) are a test double
      // answering "absent". S2-07..S2-09 use PR B's PRODUCTION registry store over real migration-101 rows
      // (`pilotReaderOn`), whose pilot reads run on the consult's snapshot handle.
      const absentRegistry = { getPilotState: async () => null, getPilotStateBySheetId: async () => null }
      const readerOn = (client: PoolClient) => governanceModule.createStockPreparationRefreshGovernance({
        continuationStore: storeOn(client),
        projectTargetStore: absentRegistry,
        projectWriteLock: createStockPreparationProjectWriteLock({ db: dbOn(client) }),
      })
      // `hostLikeDb` (the HOST's plugin database binding shape, with the statement hook) lives at MODULE scope since
      // PR-3a: the S3A cases and the rewired D-series lane calls use it too.
      // The PRODUCTION reader wiring over host-shaped bindings: the continuation store on `consultDb` (its snapshot
      // transaction may be hooked), PR B's registry store and the lock on their own bindings (autocommit reads go to
      // the pool; the registry reads reach the snapshot only through `{ executor }`).
      const pilotReaderOn = (consultDb: any = hostLikeDb()) => governanceModule.createStockPreparationRefreshGovernance({
        continuationStore: continuationStoreModule.createStockPreparationContinuationStore({ db: consultDb }),
        projectTargetStore: projectTargetStoreModule.createStockPreparationProjectTargetStore({ db: hostLikeDb() }),
        projectWriteLock: createStockPreparationProjectWriteLock({ db: hostLikeDb() }),
      })
      const derive = (consult: any) => refreshStateModule.readProjectRefreshState(consult)
      function gate() {
        let open: () => void = () => {}
        const promise = new Promise<void>((resolve) => { open = resolve })
        return { promise, open: () => open() }
      }

      // A registry row on real migration-087 / 101 columns (the pilot stamp all three columns, or none).
      async function registerProject(scope: Record<string, string>, { pilot = true } = {}) {
        await q(
          pilot
            ? `INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status, pilot_enabled_at, pilot_enabled_by, pilot_readiness_version)
               VALUES ($1, $2, $3, $4, $5, 'active', now(), 'u_scs_admin', 1)`
            : `INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status)
               VALUES ($1, $2, $3, $4, $5, 'active')`,
          [`pt_${scope.sheetId}`, scope.tenantId, scope.projectNo, scope.sheetId, `obj_${scope.sheetId}`],
        )
      }

      // ONE governed computation as PR-3 will run it: the REAL planner over the consult's projection (pilot from the
      // consult, the canonical second-pull expansion against the first-pull sheet), then the hold reconciliation
      // keyed on the decision_version the consult observed. Values-free outcome tokens only.
      async function computeAndReconcile(store: any, scope: Record<string, string>, consult: any, fixture: any) {
        const F = fixture.fixtures
        const slice = governanceModule.plannerSlice(consult)
        let planned: any
        try {
          planned = F.plan(fixture.expansion, fixture.sheet, {
            continuation: F.continuationInput({ pilot: consult.pilot ? consult.pilot.enabled === true : false, demandEvidence: fixture.expansion.demandEvidence, continuations: slice.continuations, members: slice.members, projectNo: scope.projectNo }),
          })
        } catch (error: any) {
          return { planner: `threw ${error && error.code}`, reconcile: null as string | null }
        }
        const reconciled = await settle(store.reconcileHolds({ ...scope, decisionVersionObserved: consult.decisionVersionObserved, holds: planned.holds || [], computation: computation({ suspended: planned.suspended === true }) }))
        return { planner: null as string | null, reconcile: reconciled.ok ? `ok opened=${(reconciled as any).value.holds.opened}` : String((reconciled as any).error.code) }
      }

      // Every row of the step-4 tables on one sheet plus its lock row: the "nothing persisted" fingerprint.
      async function sheetFingerprint(sheetId: string) {
        const out: unknown[] = []
        for (const table of [RT.continuation, RT.member, RT.hold, RT.state, RT.execution]) {
          out.push((await q(`SELECT * FROM ${table} WHERE sheet_id = $1 ORDER BY id`, [sheetId])).rows)
        }
        out.push((await q(`SELECT generation, generation_token, fencing_epoch, lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sheetWriteScopeKey(sheetId)])).rows)
        return JSON.stringify(out)
      }

      // The test's stand-in for PR-4's `bumpGenerationWithin` (design §8.1): the FREE-ROW branch on the caller's
      // TRANSACTION handle — insert generation 1 when the lock row is absent, else generation + 1 under
      // `lease_id IS NULL`; a live lease refuses 409 WRITE_LOCKED. Real statements on the real lock row inside the
      // store's transaction, so the composition "decision rows + bump, one COMMIT" is what is proven here.
      async function testBumpWithin(trx: any, scopeKey: string, { reason, tenantId }: { reason: string; tenantId: string }) {
        const token = `tok_${reason}_${nodeCrypto.randomUUID()}`
        const row = await trx.selectOneForUpdate(PROJECT_WRITE_LOCK_TABLE, { scope_key: scopeKey })
        if (!row) {
          await trx.insertOne(PROJECT_WRITE_LOCK_TABLE, { scope_key: scopeKey, tenant_id: tenantId, generation: 1, generation_token: token, generation_reason: 'small_preview', generation_bumped_at: new Date(), fencing_epoch: 0 })
          return { generation: 1, generationToken: token, fencingEpoch: 0 }
        }
        if (row.lease_id) throw Object.assign(new Error('live lease'), { status: 409, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, details: { reason: 'test_bump' } })
        const updated = await trx.updateRow(PROJECT_WRITE_LOCK_TABLE, { generation: Number(row.generation) + 1, generation_token: token, generation_bumped_at: new Date() }, { scope_key: scopeKey, lease_id: null, generation_token: row.generation_token })
        if (!updated || updated.length !== 1) throw Object.assign(new Error('bump lost'), { status: 409, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, details: { reason: 'contention' } })
        return { generation: Number(row.generation) + 1, generationToken: token, fencingEpoch: Number(row.fencing_epoch) }
      }

      async function seedOpenHolds(store: any, scope: Record<string, string>, holds: any[], observed = 0, verdicts: Record<string, string> = {}) {
        await store.reconcileHolds({ ...scope, decisionVersionObserved: observed, holds, verdicts, computation: computation() })
        const rows = (await q(`SELECT id, fingerprint FROM ${RT.hold} WHERE sheet_id = $1 AND project_no = $2 AND status = 'open'`, [scope.sheetId, scope.projectNo])).rows
        return (hold: any) => {
          const row = rows.find((entry: any) => entry.fingerprint === hold.fingerprint)
          if (!row) throw new Error('S2: hold not open')
          return row.id as string
        }
      }

      function confirmInput(scope: Record<string, string>, holdId: string, hold: any, fixture: any, extra: Record<string, unknown> = {}) {
        return { ...scope, holdId, echo: refreshKit.echoOf(hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: 'u_scs_puller', sourceIdentity: fixture.sourceIdentity, ...extra }
      }

      async function countWhere(table: string, where: string, params: unknown[]) {
        return Number((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n)
      }

      afterAll(async () => {
        const like = `${S2_TENANT_PREFIX}%`
        for (const table of [RT.changePlan, RT.member, RT.continuation, RT.hold, RT.execution, RT.state, 'integration_stock_prep_project_target']) {
          await q(`DELETE FROM ${table} WHERE tenant_id LIKE $1`, [like]).catch(() => {})
        }
      })

      test('S2-01 migrations 102 / 103 applied: the five tables, every unique index (partial where modelled), INTEGER counters, a direct double claim is 23505, the claim mirror and the open-hold unique are DB facts', async () => {
        for (const table of Object.values(RT) as string[]) {
          expect((await q('SELECT to_regclass($1) AS oid', [table])).rows[0].oid, table).not.toBeNull()
        }
        const indexes = await q(
          `SELECT c.relname AS name, i.indisunique AS uniq, (i.indpred IS NOT NULL) AS partial,
                  pg_get_expr(i.indpred, i.indrelid) AS predicate
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE i.indrelid = ANY($1::regclass[])`,
          // Step 5 PR-8: + the change-plan table (migration 104; its two partial uniques are in the kit's list).
          [[RT.continuation, RT.member, RT.hold, RT.state, RT.changePlan]],
        )
        for (const index of refreshKit.UNIQUE_INDEXES) {
          const row = indexes.rows.find((entry: any) => entry.name === index.name)
          expect(row, index.name).toBeTruthy()
          expect(row.uniq, index.name).toBe(true)
          expect(row.partial, index.name).toBe(Boolean(index.where))
        }
        const cols = await q(
          `SELECT table_name, column_name, data_type FROM information_schema.columns
            WHERE table_name = ANY($1::text[]) AND column_name IN ('revision', 'decision_version', 'version', 'generation', 'fencing_epoch', 'position', 'confirmed_generation')`,
          [Object.values(RT)],
        )
        expect(cols.rows.length).toBeGreaterThanOrEqual(7)
        for (const row of cols.rows) expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe('integer')
        const tenant = tenantFor('s2_01')
        const sheet = sheetFor('s2_01')
        const scopeKey = sheetWriteScopeKey(sheet)
        const continuationRow = (id: string, overrides: Record<string, unknown> = {}) => q(
          `INSERT INTO ${RT.continuation} (id, tenant_id, sheet_id, project_no, write_scope_key, status, revision, old_root_record_id, old_root_key,
             old_root_component_source_id, new_parent_component_source_id, new_root_path_tokens, new_root_key, new_root_key_digest, external_system_id,
             source_scope_digest, read_plan_digest, pairing_fingerprint, comparison_fingerprint, evidence_fingerprint, evidence_snapshot, demand_basis,
             confirmed_by, confirmed_at, confirmed_generation, confirmed_generation_token, confirmed_fencing_epoch, claim_active, ended_by, ended_at, ended_outcome)
           VALUES ($1, $2, $3, 'SYN-S2-01', $4, $5, 1, $6, 'ok', 'c', 'p', '["p","c"]'::jsonb, $7, $8, 'x', 's', 'r', 'pf', 'cf', 'ef', '{}'::jsonb,
             'puller_confirmed_same_demand', 'u', now(), 1, 't', 0, $9, $10, $11, $12)`,
          [id, tenant, sheet, scopeKey, overrides.status ?? 'active', overrides.oldRootRecordId ?? 'rec_a', overrides.newRootKey ?? 'nk_a', overrides.newRootKeyDigest ?? 'd_a',
            overrides.claimActive ?? true, overrides.endedBy ?? null, overrides.endedAt ?? null, overrides.endedOutcome ?? null],
        )
        await continuationRow('cont_s2_01_a')
        // The same old root claimed by a second live relationship: refused by the header's old-root index.
        const oldRoot = await settle(continuationRow('cont_s2_01_b', { newRootKey: 'nk_b', newRootKeyDigest: 'd_b' }))
        expect(oldRoot.ok).toBe(false)
        expect((oldRoot as any).error.code).toBe('23505')
        expect((oldRoot as any).error.constraint).toBe('uniq_integration_stock_prep_continuation_old_root')
        // The same new position claimed by a second live relationship: the new-root index.
        const newRoot = await settle(continuationRow('cont_s2_01_c', { oldRootRecordId: 'rec_c' }))
        expect((newRoot as any).error.constraint).toBe('uniq_integration_stock_prep_continuation_new_root')
        // Ending without releasing the claim, or claiming while ended: the mirror CHECK refuses both.
        const halfEnded = await settle(q(`UPDATE ${RT.continuation} SET status = 'ended', ended_by = 'u', ended_at = now(), ended_outcome = 'escalate_special_repair' WHERE id = $1`, ['cont_s2_01_a']))
        expect((halfEnded as any).error.code).toBe('23514')
        expect((halfEnded as any).error.constraint).toBe('integration_stock_prep_continuation_claim_active_check')
        await q(`UPDATE ${RT.continuation} SET status = 'ended', claim_active = false, ended_by = 'u', ended_at = now(), ended_outcome = 'escalate_special_repair' WHERE id = $1`, ['cont_s2_01_a'])
        // Once ended, the SAME old root and new position can be claimed again (the partial predicate).
        await continuationRow('cont_s2_01_d')
        // The open-hold unique: one open row per (sheet, project, fingerprint); a resolved one does not count.
        const holdRow = (id: string, status: string) => q(
          `INSERT INTO ${RT.hold} (id, tenant_id, sheet_id, project_no, write_scope_key, kind, fingerprint, status, confirmable, not_confirmable_reason, subject, detail, resolved_at, resolution)
           VALUES ($1, $2, $3, 'SYN-S2-01', $4, 'candidate_ambiguous', 'fp_s2_01', $5, false, 'ambiguous_pairing', '{}'::jsonb, '{}'::jsonb, $6, $7)`,
          [id, tenant, sheet, scopeKey, status, status === 'open' ? null : new Date(), status === 'open' ? null : 'superseded_by_computation'],
        )
        await holdRow('hold_s2_01_a', 'open')
        const dupOpen = await settle(holdRow('hold_s2_01_b', 'open'))
        expect((dupOpen as any).error.code).toBe('23505')
        expect((dupOpen as any).error.constraint).toBe('uniq_integration_stock_prep_refresh_hold_open')
        await holdRow('hold_s2_01_c', 'superseded')
        // The hold's confirmable shape and the shape-token vocabulary (dropped_other_rule admitted) are CHECKs.
        const badShape = await settle(q(`UPDATE ${RT.hold} SET confirmable = true WHERE id = $1`, ['hold_s2_01_a']))
        expect((badShape as any).error.code).toBe('23514')
        await q(`UPDATE ${RT.hold} SET shape_token = 'dropped_other_rule' WHERE id = $1`, ['hold_s2_01_a'])
        const badToken = await settle(q(`UPDATE ${RT.hold} SET shape_token = 'made_up' WHERE id = $1`, ['hold_s2_01_a']))
        expect((badToken as any).error.code).toBe('23514')
      }, 30000)

      test('S2-02 A08 across two sessions: two holds claiming one old record (and two old sets claiming one new position) -> exactly one confirm commits, the loser is 409 CONFIRM_CONFLICT from the partial unique index and persists nothing', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const storeB = storeOn(clientB)
        for (const [label, rival] of [['old_record', refreshKit.competingCandidateHold(fixture.hold)], ['new_position', refreshKit.sameNewPositionHold(fixture.hold)]] as const) {
          const scope = { tenantId: tenantFor(`s2_02_${label}`), sheetId: sheetFor(`s2_02_${label}`), projectNo: fixture.projectNo }
          const idOf = await seedOpenHolds(storeA, scope, [fixture.hold, rival])
          const [a, b] = await Promise.all([
            settle(storeA.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })),
            settle(storeB.confirmContinuation(confirmInput(scope, idOf(rival), rival, fixture), { bumpWithin: testBumpWithin })),
          ])
          const winners = [a, b].filter((outcome) => outcome.ok)
          const losers = [a, b].filter((outcome) => !outcome.ok) as Array<{ ok: false; error: any }>
          expect(winners.length, label).toBe(1)
          expect(losers.length, label).toBe(1)
          expect(losers[0].error.code, label).toBe(RC.CONFIRM_CONFLICT)
          expect(losers[0].error.status).toBe(409)
          expect(losers[0].error.details.sqlState).toBe('23505')
          expect(String(losers[0].error.details.constraint)).toMatch(/^uniq_integration_stock_prep_continuation/)
          expect(JSON.stringify(losers[0].error.details)).not.toContain('S-001')
          expect(await countWhere(RT.continuation, 'sheet_id = $1 AND claim_active', [scope.sheetId]), label).toBe(1)
          expect(await countWhere(RT.member, 'sheet_id = $1 AND claim_active', [scope.sheetId]), label).toBe(4)
          expect(await countWhere(RT.hold, 'sheet_id = $1 AND status = $2', [scope.sheetId, 'open']), 'the losing hold stays open').toBe(1)
          expect(await countWhere(RT.hold, 'sheet_id = $1 AND status = $2', [scope.sheetId, 'resolved'])).toBe(1)
          const state = (await q(`SELECT decision_version, version FROM ${RT.state} WHERE sheet_id = $1`, [scope.sheetId])).rows[0]
          expect(state.decision_version, 'exactly one decision').toBe(1)
          // The winner's bump landed in the SAME commit: generation 1 on the sheet's lock row.
          const lock = (await q(`SELECT generation, lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sheetWriteScopeKey(scope.sheetId)])).rows[0]
          expect(lock.generation).toBe(1)
          expect(lock.lease_id).toBeNull()
        }
      }, 60000)

      test('S2-03 CAS races across two sessions: two confirms of ONE hold, confirm-with-supersedes vs end, reconcile vs confirm, two reconciliations — serialised by the state row, never two decisions, never a stale hold set', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const storeB = storeOn(clientB)
        // (a) the same hold confirmed twice at once: one commits, the other is STALE (hold_not_open), one decision.
        {
          const scope = { tenantId: tenantFor('s2_03a'), sheetId: sheetFor('s2_03a'), projectNo: fixture.projectNo }
          const idOf = await seedOpenHolds(storeA, scope, [fixture.hold])
          const input = confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture)
          const [a, b] = await Promise.all([
            settle(storeA.confirmContinuation(input, { bumpWithin: testBumpWithin })),
            settle(storeB.confirmContinuation(input, { bumpWithin: testBumpWithin })),
          ])
          expect([a, b].filter((outcome) => outcome.ok).length).toBe(1)
          const loser = [a, b].find((outcome) => !outcome.ok) as { ok: false; error: any }
          expect(loser.error.code).toBe(RC.CONFIRM_STALE)
          expect(loser.error.details.reason).toBe('hold_not_open')
          expect(await countWhere(RT.continuation, 'sheet_id = $1', [scope.sheetId])).toBe(1)
          expect((await q(`SELECT decision_version FROM ${RT.state} WHERE sheet_id = $1`, [scope.sheetId])).rows[0].decision_version).toBe(1)
        }
        // (b) confirm (superseding A) vs end (A): exactly one decision lands; A is ended exactly once; at most one live.
        //     Review X-2 / X-3: A must NEED RECONFIRMATION with its hold open (only then may it be ended) and the rival
        //     must claim A's old rows (only then may it supersede) — ONE computation raises both holds and the verdict.
        {
          const scope = { tenantId: tenantFor('s2_03b'), sheetId: sheetFor('s2_03b'), projectNo: fixture.projectNo }
          const idOf = await seedOpenHolds(storeA, scope, [fixture.hold])
          const first = await storeA.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
          const rival = refreshKit.competingCandidateHold(fixture.hold)
          const reconfirm = refreshKit.reconfirmHoldFor(first.continuationId, { confirmable: false, verdict: 'structure_changed' })
          const idOf2 = await seedOpenHolds(storeA, scope, [rival, reconfirm], 1, { [first.continuationId]: 'structure_changed' })
          expect((await q(`SELECT status FROM ${RT.continuation} WHERE id = $1`, [first.continuationId])).rows[0].status).toBe('needs_reconfirmation')
          const [confirm, end] = await Promise.all([
            settle(storeB.confirmContinuation(confirmInput(scope, idOf2(rival), rival, fixture, { supersedes: { continuationId: first.continuationId, revision: 1 } }), { bumpWithin: testBumpWithin })),
            settle(storeA.endContinuation({ ...scope, continuationId: first.continuationId, revision: 1, endedBy: 'u_scs_puller', outcome: 'escalate_special_repair' }, { bumpWithin: testBumpWithin })),
          ])
          expect([confirm, end].filter((outcome) => outcome.ok).length, 'exactly one decision').toBe(1)
          const loser = [confirm, end].find((outcome) => !outcome.ok) as { ok: false; error: any }
          expect(loser.error.code).toBe(RC.CONFIRM_STALE)
          const ended = (await q(`SELECT status, ended_outcome, claim_active FROM ${RT.continuation} WHERE id = $1`, [first.continuationId])).rows[0]
          expect(ended.status).toBe('ended')
          expect(ended.claim_active).toBe(false)
          expect(ended.ended_outcome).toBe(confirm.ok ? 'superseded_by_new_confirmation' : 'escalate_special_repair')
          expect(await countWhere(RT.continuation, 'sheet_id = $1 AND claim_active', [scope.sheetId])).toBe(confirm.ok ? 1 : 0)
          expect((await q(`SELECT decision_version FROM ${RT.state} WHERE sheet_id = $1`, [scope.sheetId])).rows[0].decision_version).toBe(2)
          // A's hold stays open either way: escalated -> runbook-only (the project stays suspended); superseded -> as
          // it was, until the next computation (it no longer names a live relationship).
          const reconfirmRow = (await q(`SELECT status, runbook_only FROM ${RT.hold} WHERE sheet_id = $1 AND fingerprint = $2`, [scope.sheetId, reconfirm.fingerprint])).rows[0]
          expect(reconfirmRow.status).toBe('open')
          expect(reconfirmRow.runbook_only).toBe(!confirm.ok)
        }
        // (c) reconcile vs confirm: a reconciliation that straddles a decision is STATE_MOVED and persists nothing.
        {
          const scope = { tenantId: tenantFor('s2_03c'), sheetId: sheetFor('s2_03c'), projectNo: fixture.projectNo }
          const idOf = await seedOpenHolds(storeA, scope, [fixture.hold])
          const rival = refreshKit.competingCandidateHold(fixture.hold)
          const [confirm, reconcile] = await Promise.all([
            settle(storeA.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })),
            settle(storeB.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [fixture.hold, rival], computation: computation() })),
          ])
          expect(confirm.ok, JSON.stringify((confirm as any).error && (confirm as any).error.details)).toBe(true)
          const rows = (await q(`SELECT fingerprint, status FROM ${RT.hold} WHERE sheet_id = $1`, [scope.sheetId])).rows
          expect(rows.filter((row: any) => row.fingerprint === fixture.hold.fingerprint).length, 'the confirmed hold has ONE row').toBe(1)
          expect(rows.find((row: any) => row.fingerprint === fixture.hold.fingerprint).status).toBe('resolved')
          if (reconcile.ok) {
            // The reconciliation ran first (observed 0 still true): the rival hold is open, the confirm followed.
            expect(rows.some((row: any) => row.fingerprint === rival.fingerprint && row.status === 'open')).toBe(true)
          } else {
            expect((reconcile as any).error.code).toBe(RC.STATE_MOVED)
            expect((reconcile as any).error.details.reason).toBe('decision_version')
            expect(rows.some((row: any) => row.fingerprint === rival.fingerprint), 'nothing of the moved reconciliation persisted').toBe(false)
          }
        }
        // (d) two reconciliations at once (different sets, same observation): both land in some order; exactly
        //     one open hold remains, no duplicate rows per fingerprint, version advanced twice, no decision.
        {
          const scope = { tenantId: tenantFor('s2_03d'), sheetId: sheetFor('s2_03d'), projectNo: fixture.projectNo }
          const rival = refreshKit.competingCandidateHold(fixture.hold)
          const [x, y] = await Promise.all([
            settle(storeA.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [fixture.hold], computation: computation() })),
            settle(storeB.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [rival], computation: computation() })),
          ])
          expect(x.ok && y.ok, JSON.stringify([(x as any).error && (x as any).error.details, (y as any).error && (y as any).error.details])).toBe(true)
          expect(await countWhere(RT.state, 'sheet_id = $1', [scope.sheetId]), 'one state row (UPSERT then lock)').toBe(1)
          const state = (await q(`SELECT version, decision_version FROM ${RT.state} WHERE sheet_id = $1`, [scope.sheetId])).rows[0]
          expect(state.version).toBe(2)
          expect(state.decision_version).toBe(0)
          expect(await countWhere(RT.hold, 'sheet_id = $1 AND status = $2', [scope.sheetId, 'open'])).toBe(1)
          expect(await countWhere(RT.hold, 'sheet_id = $1', [scope.sheetId])).toBe(2)
        }
      }, 60000)

      test('S2-04 table unreadable (migrations absent on the search path): the store answers 503 STORE_FAILED (42P01) — never zero rows; the reader 503 naming the store; the derived state is unreadable', async () => {
        const client = await poolManager.get().getInternalPool().connect()
        const schema = `scs_empty_${TOKEN}`
        try {
          await client.query(`CREATE SCHEMA ${schema}`)
          await client.query(`SET search_path TO ${schema}`)
          const store = storeOn(client)
          const scope = { tenantId: tenantFor('s2_04'), sheetId: sheetFor('s2_04'), projectNo: 'SYN-S2-04' }
          const read = await settle(store.readGovernanceRows(scope))
          expect(read.ok).toBe(false)
          expect((read as any).error.code).toBe(RC.STORE_FAILED)
          expect((read as any).error.status).toBe(503)
          expect((read as any).error.details.sqlState).toBe('42P01')
          expect((read as any).error.details.operation).toBe('read_continuations')
          expect((read as any).error.details.partial).toBe(false)
          const reader = readerOn(client)
          const consult = await settle(reader.consult(scope))
          expect(consult.ok).toBe(false)
          expect((consult as any).error.code).toBe(GC.STORE_FAILED)
          expect((consult as any).error.details.store).toBe('continuation')
          const derived = await reader.readRefreshState(scope)
          expect(derived.state.status).toBe('unreadable')
          expect(derived.state.unreadable.store).toBe('continuation')
          expect(derived.state.exportAllowed).toBe(false)
          // A write is refused the same way: a hold reconciliation never records "clean" on a missing table.
          const write = await settle(store.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [], computation: computation({ suspended: false }) }))
          expect((write as any).error.code).toBe(RC.STORE_FAILED)
          expect((write as any).error.details.sqlState).toBe('42P01')
        } finally {
          await client.query('RESET search_path').catch(() => {})
          await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
          client.release()
        }
      }, 30000)

      test('S2-05 tenant assertion: a header-steered tenant that owns nothing is REFUSED by the sheet-keyed read (409 TENANT_MISMATCH), never answered "not governed"', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const owner = { tenantId: tenantFor('s2_05'), sheetId: sheetFor('s2_05'), projectNo: fixture.projectNo }
        const idOf = await seedOpenHolds(storeA, owner, [fixture.hold])
        await storeA.confirmContinuation(confirmInput(owner, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
        const steered = { ...owner, tenantId: tenantFor('s2_05_steered') }
        // The store's reads under the steered tenant still surface the owner's rows (the sheet-keyed read) ...
        const rows = await storeA.readGovernanceRows(steered)
        expect(rows.continuations.length).toBe(1)
        expect(rows.continuations[0].tenantId).toBe(owner.tenantId)
        // ... and the reader refuses on them instead of answering an empty, ungoverned project.
        const reader = readerOn(clientA)
        const refused = await settle(reader.consult(steered))
        expect(refused.ok).toBe(false)
        expect((refused as any).error.code).toBe(GC.TENANT_MISMATCH)
        expect((refused as any).error.status).toBe(409)
        expect(JSON.stringify((refused as any).error.details)).not.toContain(owner.tenantId)
        await expect(reader.readRefreshState(steered)).rejects.toMatchObject({ code: GC.TENANT_MISMATCH })
        // The owner's own consult is governed and derives the confirmed-pending state.
        const own = await reader.consult(owner)
        expect(own.governed).toBe(true)
        expect(own.continuations[0].memberCount).toBe(4)
        expect((await reader.readRefreshState(owner)).state.status).toBe('confirmed_pending_execution')
      }, 30000)

      test('S2-06 sheet-keyed read: a project whose protection lives on another sheet is refused 409 RETARGETED when resolved elsewhere — its old rows are never matched to the new target', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const home = { tenantId: tenantFor('s2_06'), sheetId: sheetFor('s2_06_home'), projectNo: fixture.projectNo }
        const idOf = await seedOpenHolds(storeA, home, [fixture.hold])
        await storeA.confirmContinuation(confirmInput(home, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
        const elsewhere = { ...home, sheetId: sheetFor('s2_06_env') }
        const reader = readerOn(clientA)
        const refused = await settle(reader.consult(elsewhere))
        expect(refused.ok).toBe(false)
        expect((refused as any).error.code).toBe(GC.TARGET_RETARGETED)
        expect((refused as any).error.status).toBe(409)
        expect((refused as any).error.details.reason).toBe('sheet')
        expect(JSON.stringify((refused as any).error.details)).not.toContain(home.sheetId)
        await expect(reader.readRefreshState(elsewhere)).rejects.toMatchObject({ code: GC.TARGET_RETARGETED })
        const own = await reader.consult(home)
        expect(own.governed).toBe(true)
        expect(governanceModule.plannerSlice(own).continuations.length).toBe(1)
      }, 30000)

      // Review X-1: the freeze points of the consult's snapshot reads (statement text from lib/db.cjs `select`).
      const STEP4_FREEZE_POINTS: Array<[string, RegExp]> = [
        ['T0 after the registry reads, before the first step-4 read', /FROM "integration_stock_prep_continuation" WHERE "tenant_id"/],
        ['T1 between the continuation reads and the member reads', /FROM "integration_stock_prep_continuation_member" WHERE/],
        ['T2 between the member reads and the hold reads', /FROM "integration_stock_prep_refresh_hold" WHERE/],
        ['T3 between the hold reads and the state read', /FROM "integration_stock_prep_refresh_state" WHERE/],
        ['T4 between the state read and the execution reads', /FROM "integration_stock_prep_refresh_execution" WHERE/],
      ]

      test('S2-07 (review X-1) the consult is ONE snapshot: frozen at each read boundary (T3 = between the hold reads and the state read) while another session CONFIRMS, it answers the pre-confirm instant whole; the computation keyed on it is 409 STATE_MOVED; no stale hold persisted, no torn complete, no projection 500', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeB = storeOn(clientB)
        // Every freeze point is run and recorded; ONE assertion at the end compares the whole table, so a regression
        // reports which boundaries tore and how (stale hold, torn complete, projection 500) — not only the first.
        const observed: Array<Record<string, unknown>> = []
        for (const [index, [label, pattern]] of STEP4_FREEZE_POINTS.entries()) {
          const scope = { tenantId: tenantFor(`s2_07_${index}`), sheetId: sheetFor(`s2_07_${index}`), projectNo: fixture.projectNo }
          await registerProject(scope, { pilot: true })
          const idOf = await seedOpenHolds(storeB, scope, [fixture.hold])
          const reached = gate()
          const frozen = gate()
          let hit = false
          // The freeze matches the step-4 read whether it runs in the snapshot transaction (the design) or not (a
          // regression): either way the case answers with an assertion, never a hang.
          const consultDb = hostLikeDb(async ({ sql }) => {
            if (!hit && pattern.test(sql)) {
              hit = true
              reached.open()
              await frozen.promise
            }
          })
          const consultP = settle(pilotReaderOn(consultDb).consult(scope))
          await reached.promise
          // Another session decides while the consult is frozen inside its snapshot.
          const confirmed = await storeB.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
          frozen.open()
          const consult = await consultP
          const row: Record<string, unknown> = { point: label.slice(0, 2), confirmDecisionVersion: confirmed.decisionVersion }
          if (!consult.ok) {
            row.consult = String((consult as any).error && (consult as any).error.code)
          } else {
            const answer = (consult as any).value
            row.consult = `c${answer.continuations.length}m${answer.members.length}h${answer.holds.length}dv${answer.decisionVersionObserved}`
            row.pilot = Boolean(answer.pilot && answer.pilot.enabled)
            const derived = derive(answer)
            row.derived = derived.status
            row.exportAllowed = derived.exportAllowed
            // The computation built on it (the real planner, pilot from the consult) and its CAS-keyed reconciliation.
            const outcome = await computeAndReconcile(storeB, scope, answer, fixture)
            row.planner = outcome.planner
            row.reconcile = outcome.reconcile
          }
          row.staleOpenHolds = await countWhere(RT.hold, 'sheet_id = $1 AND fingerprint = $2 AND status = $3', [scope.sheetId, fixture.hold.fingerprint, 'open'])
          const after = await pilotReaderOn().consult(scope)
          row.after = `c${after.continuations.length}m${after.members.length}h${after.holds.length}dv${after.decisionVersionObserved}:${derive(after).status}`
          observed.push(row)
        }
        // At EVERY boundary: the pre-confirm instant, whole (the snapshot was taken at the registry read, before the
        // freeze) — pending confirmation, export refused, the computation refused 409 STATE_MOVED at the CAS, no stale
        // open hold; the next consult sees the decision whole.
        expect(observed).toEqual(STEP4_FREEZE_POINTS.map(([label]) => ({
          point: label.slice(0, 2),
          confirmDecisionVersion: 1,
          consult: 'c0m0h1dv0',
          pilot: true,
          derived: 'pending_confirmation',
          exportAllowed: false,
          planner: null,
          reconcile: RC.STATE_MOVED,
          staleOpenHolds: 0,
          after: 'c1m4h0dv1:confirmed_pending_execution',
        })))
      }, 60000)

      test('S2-08 (review X-1) the registry reads are IN the snapshot: frozen right after them while another session enables the pilot and a pilot computation raises a hold, the consult answers the registry and the step-4 rows of ONE instant (not pilot, no rows) — never "not pilot" beside the rows the pilot raised', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeB = storeOn(clientB)
        {
          const scope = { tenantId: tenantFor('s2_08'), sheetId: sheetFor('s2_08'), projectNo: fixture.projectNo }
          await registerProject(scope, { pilot: false })
          const reached = gate()
          const frozen = gate()
          let hit = false
          const consultDb = hostLikeDb(async ({ sql }) => {
            if (!hit && STEP4_FREEZE_POINTS[0][1].test(sql)) {
              hit = true
              reached.open()
              await frozen.promise
            }
          })
          const consultP = settle(pilotReaderOn(consultDb).consult(scope))
          await reached.promise
          // Another session: the pilot marker is set and the first pilot computation raises the candidate hold.
          await q(`UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = 'u_scs_admin', pilot_readiness_version = 1 WHERE id = $1`, [`pt_${scope.sheetId}`])
          await storeB.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [fixture.hold], computation: computation() })
          frozen.open()
          const consult = await consultP
          expect(consult.ok).toBe(true)
          const answer = (consult as any).value
          expect(answer.pilot.enabled, 'the registry as of the snapshot').toBe(false)
          expect({ governed: answer.governed, state: answer.state, holds: answer.holds.length }, 'the step-4 rows as of the SAME snapshot').toEqual({ governed: false, state: null, holds: 0 })
          expect(derive(answer).status).toBe('not_governed')
          // A consult after both commits sees both: pilot, the hold, pending confirmation.
          const after = await pilotReaderOn().consult(scope)
          expect(after.pilot.enabled).toBe(true)
          expect(after.holds.length).toBe(1)
          expect(derive(after).status).toBe('pending_confirmation')
        }
      }, 30000)

      test('S2-09 (review X-1) natural races, no freezing: a consult starts as another session is about to run one of its confirm statements (lock read, bump, header, members, hold, state, COMMIT); bounded rounds — every consult is one of the two consistent instants, no stale hold, no torn complete, no projection 500', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const triggers = [
          /^SELECT \* FROM "integration_stock_prep_project_write_lock"/,
          /^(UPDATE "integration_stock_prep_project_write_lock"|INSERT INTO "integration_stock_prep_project_write_lock")/,
          /^INSERT INTO "integration_stock_prep_continuation" /,
          /^INSERT INTO "integration_stock_prep_continuation_member"/,
          /^UPDATE "integration_stock_prep_refresh_hold"/,
          /^UPDATE "integration_stock_prep_refresh_state"/,
          /^COMMIT$/,
        ]
        // 15 rounds per trigger point, capped by time so a slow runner stays within the step's budget.
        const MAX_ROUNDS = 105
        const BUDGET_MS = 8000
        const CONSISTENT = ['c0m0h1dv0', 'c1m4h0dv1']
        const tally: Record<string, number> = {}
        // Counted over every round and asserted once at the end, so a regression reports the whole tally.
        const counts = { torn: 0, tornComplete: 0, projection500: 0, staleOpenHolds: 0, confirmFailed: 0, consultFailed: 0 }
        let rounds = 0
        const started = Date.now()
        while (rounds < MAX_ROUNDS && Date.now() - started < BUDGET_MS) {
          const scope = { tenantId: tenantFor(`s2_09_${rounds}`), sheetId: sheetFor(`s2_09_${rounds}`), projectNo: fixture.projectNo }
          await registerProject(scope, { pilot: true })
          const idOf = await seedOpenHolds(storeA, scope, [fixture.hold])
          const trigger = triggers[rounds % triggers.length]
          const aboutTo = gate()
          const confirmDb = hostLikeDb(({ sql, inTransaction }) => { if (inTransaction && trigger.test(sql)) aboutTo.open() })
          const confirmStore = continuationStoreModule.createStockPreparationContinuationStore({ db: confirmDb })
          const confirmP = settle(confirmStore.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin }))
          await Promise.race([aboutTo.promise, confirmP])
          const offset = Math.floor(rounds / triggers.length) % 3
          if (offset > 0) await new Promise((resolve) => setTimeout(resolve, offset - 1))
          const [consult, confirm] = await Promise.all([settle(pilotReaderOn().consult(scope)), confirmP])
          rounds += 1
          if (!confirm.ok) { counts.confirmFailed += 1; continue }
          if (!consult.ok) { counts.consultFailed += 1; continue }
          const answer = (consult as any).value
          const shape = `c${answer.continuations.length}m${answer.members.length}h${answer.holds.length}dv${answer.decisionVersionObserved}`
          if (!CONSISTENT.includes(shape)) counts.torn += 1
          if (derive(answer).status === 'complete') counts.tornComplete += 1
          const outcome = await computeAndReconcile(storeA, scope, answer, fixture)
          if (outcome.planner) counts.projection500 += 1
          counts.staleOpenHolds += await countWhere(RT.hold, 'sheet_id = $1 AND fingerprint = $2 AND status = $3', [scope.sheetId, fixture.hold.fingerprint, 'open'])
          const key = `${shape}:${outcome.planner || outcome.reconcile}`
          tally[key] = (tally[key] || 0) + 1
        }
        // Values-free evidence in the CI log: how many rounds ran and which instants the consults answered.
        console.log(`[S2-09] rounds=${rounds} in ${Date.now() - started} ms counts=${JSON.stringify(counts)} tally=${JSON.stringify(tally)}`)
        expect(rounds, `rounds run within ${BUDGET_MS} ms`).toBeGreaterThanOrEqual(14)
        // Every consult one consistent instant: no torn view, no torn complete, no projection 500, no stale hold.
        expect({ counts, tally: Object.keys(tally).filter((key) => !['c0m0h1dv0:STOCK_PREP_PULL_STATE_MOVED', 'c1m4h0dv1:ok opened=0'].includes(key)) })
          .toEqual({ counts: { torn: 0, tornComplete: 0, projection500: 0, staleOpenHolds: 0, confirmFailed: 0, consultFailed: 0 }, tally: [] })
      }, 60000)

      test('S2-10 (review X-2) end admissibility on PostgreSQL: an ACTIVE continuation cannot be ended (409 status), an escalation with no open hold naming it cannot (409 no_open_hold) — both leave every table and the lock row untouched; an admitted escalation keeps the hold open runbook-only and the project pending, never complete, even after a clean settling computation', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const scope = { tenantId: tenantFor('s2_10'), sheetId: sheetFor('s2_10'), projectNo: fixture.projectNo }
        const idOf = await seedOpenHolds(storeA, scope, [fixture.hold])
        const confirmed = await storeA.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
        const id = confirmed.continuationId
        const endBase = { ...scope, continuationId: id, revision: 1, endedBy: 'u_scs_puller' }
        // ACTIVE with an OPEN hold naming it (a content_changed verdict keeps it active): only the status check refuses.
        await storeA.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [refreshKit.contentChangeHoldFor(id)], verdicts: { [id]: 'content_changed' }, computation: computation() })
        {
          const before = await sheetFingerprint(scope.sheetId)
          const refused = await settle(storeA.endContinuation({ ...endBase, outcome: 'escalate_special_repair' }, { bumpWithin: testBumpWithin }))
          expect(refused.ok, 'an ACTIVE relationship with an open hold is still not ended').toBe(false)
          expect((refused as any).error.details).toEqual({ reason: 'status', outcome: 'escalate_special_repair', status: 'active' })
          expect(await sheetFingerprint(scope.sheetId), 'nothing persisted, no bump').toBe(before)
        }
        // ACTIVE with no hold (the next computation verifies it valid and supersedes the content hold): both outcomes refused.
        await storeA.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [], verdicts: { [id]: 'valid' }, computation: computation({ suspended: false }) })
        for (const extra of [{ outcome: 'escalate_special_repair' }, { outcome: 'release_to_normal_refresh', facts: { holdId: 'hold_named', holdFingerprint: 'f'.repeat(64) } }]) {
          const before = await sheetFingerprint(scope.sheetId)
          const refused = await settle(storeA.endContinuation({ ...endBase, ...extra }, { bumpWithin: testBumpWithin }))
          expect(refused.ok, extra.outcome).toBe(false)
          expect((refused as any).error.code, extra.outcome).toBe(RC.END_OUTCOME_NOT_ADMISSIBLE)
          expect((refused as any).error.details, extra.outcome).toEqual({ reason: 'status', outcome: extra.outcome, status: 'active' })
          expect(await sheetFingerprint(scope.sheetId), `${extra.outcome}: nothing persisted, no bump`).toBe(before)
        }
        // needs_reconfirmation, but no open hold names it: an escalation would release the claims with nothing left
        // to suspend the project.
        await storeA.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [], verdicts: { [id]: 'structure_changed' }, computation: computation({ suspended: false }) })
        {
          const before = await sheetFingerprint(scope.sheetId)
          const refused = await settle(storeA.endContinuation({ ...endBase, outcome: 'escalate_special_repair' }, { bumpWithin: testBumpWithin }))
          expect(refused.ok, 'an escalation with no open hold is not admitted').toBe(false)
          expect((refused as any).error.code).toBe(RC.END_OUTCOME_NOT_ADMISSIBLE)
          expect((refused as any).error.details).toEqual({ reason: 'no_open_hold', outcome: 'escalate_special_repair' })
          expect(await sheetFingerprint(scope.sheetId), 'nothing persisted, no bump').toBe(before)
        }
        // The computation raises the hold: the escalation is admitted and the hold stays open, runbook-only.
        await storeA.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [refreshKit.reconfirmHoldFor(id, { confirmable: false, verdict: 'structure_changed' })], verdicts: { [id]: 'structure_changed' }, computation: computation() })
        const escalated = await storeA.endContinuation({ ...endBase, outcome: 'escalate_special_repair' }, { bumpWithin: testBumpWithin })
        expect(escalated.holdsEscalated).toBe(1)
        const kept = (await q(`SELECT kind, status, runbook_only, confirmable FROM ${RT.hold} WHERE sheet_id = $1 AND continuation_id = $2 AND status = 'open'`, [scope.sheetId, id])).rows
        expect(kept).toEqual([{ kind: 'relationship_reconfirm', status: 'open', runbook_only: true, confirmable: false }])
        const reader = readerOn(clientA)
        expect((await reader.readRefreshState(scope)).state.status).toBe('pending_confirmation')
        const clean = await storeA.reconcileHolds({ ...scope, decisionVersionObserved: 2, holds: [], computation: computation({ suspended: false, lane: 'small_apply' }), settlement: { executionId: null, generationToken: 'g_s2_10', sourceContentDigest: 'src_s2', sheetMachineDigest: 'm_s2_10' } })
        expect(clean.settled).toBe(false)
        expect(clean.holds.open).toBe(1)
        const state = (await reader.readRefreshState(scope)).state
        expect(state.status).toBe('pending_confirmation')
        expect(state.exportAllowed).toBe(false)
      }, 30000)

      test('S2-11 (review X-3) supersede relatedness on PostgreSQL: a candidate sharing no claim cannot supersede (409 supersedes_unrelated, every table and the lock row untouched) and commits on its own; a candidate claiming the same old rows supersedes in one transaction', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const scope = { tenantId: tenantFor('s2_11'), sheetId: sheetFor('s2_11'), projectNo: fixture.projectNo }
        const idOf = await seedOpenHolds(storeA, scope, [fixture.hold])
        const first = await storeA.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
        const disjoint = refreshKit.disjointCandidateHold(fixture.hold)
        const related = refreshKit.competingCandidateHold(fixture.hold)
        const idOf2 = await seedOpenHolds(storeA, scope, [disjoint, related], 1)
        const supersedes = { supersedes: { continuationId: first.continuationId, revision: 1 } }
        const before = await sheetFingerprint(scope.sheetId)
        const refused = await settle(storeA.confirmContinuation(confirmInput(scope, idOf2(disjoint), disjoint, fixture, supersedes), { bumpWithin: testBumpWithin }))
        expect(refused.ok).toBe(false)
        expect((refused as any).error.code).toBe(RC.END_OUTCOME_NOT_ADMISSIBLE)
        expect((refused as any).error.status).toBe(409)
        expect((refused as any).error.details).toEqual({ reason: 'supersedes_unrelated', outcome: 'superseded_by_new_confirmation' })
        expect(await sheetFingerprint(scope.sheetId), 'nothing persisted: the relationship keeps its claims, no bump').toBe(before)
        // Control: the same candidate commits on its own — the refusal was the relatedness rule alone.
        const alone = await storeA.confirmContinuation(confirmInput(scope, idOf2(disjoint), disjoint, fixture), { bumpWithin: testBumpWithin })
        expect(alone.supersededContinuationId).toBeNull()
        expect(await countWhere(RT.continuation, 'sheet_id = $1 AND claim_active', [scope.sheetId])).toBe(2)
        // Related: the claims collide without `supersedes`; with it the old relationship ends and the new one claims.
        const conflict = await settle(storeA.confirmContinuation(confirmInput(scope, idOf2(related), related, fixture), { bumpWithin: testBumpWithin }))
        expect((conflict as any).error.code).toBe(RC.CONFIRM_CONFLICT)
        const replaced = await storeA.confirmContinuation(confirmInput(scope, idOf2(related), related, fixture, supersedes), { bumpWithin: testBumpWithin })
        expect(replaced.supersededContinuationId).toBe(first.continuationId)
        expect((await q(`SELECT status, ended_outcome, claim_active FROM ${RT.continuation} WHERE id = $1`, [first.continuationId])).rows[0])
          .toEqual({ status: 'ended', ended_outcome: 'superseded_by_new_confirmation', claim_active: false })
        expect(await countWhere(RT.continuation, 'sheet_id = $1 AND claim_active', [scope.sheetId])).toBe(2)
      }, 30000)

      test('S2-12 (review round 2, P1 on X-3) a PARTIAL takeover cannot supersede — the reviewer\'s shape end to end on the real host: (a) refused 409 supersedes_incomplete, every step-4 row and the lock row byte-identical; (b) after pilot exit the persisted relationship still protects all four old rows through the REAL planner and the REAL host writer (zero INACTIVE / UPDATE / copy-ADD for them); (c) a FULL takeover supersedes, and after pilot exit the old rows stay protected under the replacing relationship', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const F = fixture.fixtures
        const storeA = storeOn(clientA)
        const demandEvidence = fixture.expansion.demandEvidence
        const RECORD_REF = Symbol.for('metasheet.stock-preparation.existingRow.recordRef')
        const writesTouching = (planned: any, keys: Set<string>) => planned.decisions
          .filter((decision: any) => keys.has(decision.idempotencyKey) && ['add', 'update', 'inactive'].includes(decision.decision))
          .map((decision: any) => decision.decision)
        // The runbook's pilot exit (migration 101): ONE statement clearing all three columns.
        const pilotExit = (scope: Record<string, string>) => q(
          'UPDATE integration_stock_prep_project_target SET pilot_enabled_at = NULL, pilot_enabled_by = NULL, pilot_readiness_version = NULL WHERE id = $1',
          [`pt_${scope.sheetId}`],
        )
        // (a) + (b) on a REAL sandbox sheet: the four old rows and the independent PART-A rows written through the host.
        // One observed table, asserted once: a regression shows the reviewer's whole outcome, not only its first step.
        const observed: Record<string, unknown> = {}
        const sb = await sandboxSheet('s2_12')
        try {
          const scope = { tenantId: tenantFor('s2_12'), sheetId: sb.sheetId, projectNo: fixture.projectNo }
          const fields = sb.target.fieldIdMap
          const seedRows = async (rows: any[]) => {
            const out: any[] = []
            for (const row of rows) {
              const data = Object.fromEntries(Object.entries(row).map(([name, value]) => [fields[name] || name, value]))
              const record = await sb.multitable.records.createRecord({ sheetId: sb.sheetId, data })
              out.push(F.withRecordRef(row, record.id, record.version))
            }
            return out
          }
          await registerProject(scope, { pilot: true })
          const oldRows = await seedRows(fixture.sheet)
          const original = F.plan(fixture.expansion, oldRows, { continuation: F.continuationInput({ demandEvidence }) }).holds.find((entry: any) => entry.kind === 'continuation_candidate')
          const idOf = await seedOpenHolds(storeA, scope, [original])
          const first = await storeA.confirmContinuation(confirmInput(scope, idOf(original), original, fixture), { bumpWithin: testBumpWithin })
          // The reviewer's candidate, emitted by the REAL planner against an independent PART-A subtree on the same sheet:
          // two of the relationship's four new positions, none of its four old rows.
          const independent = await F.expand(F.project({ orders: [{ part: 'PART-A', qty: 20 }], parts: F.PARTS.slice(), boms: { 'PART-A': [{ part: 'PART-C', usage: 4 }] } }))
          const aRows = await seedRows(F.applyToSheet(F.plan(independent, []), [], { idPrefix: 's2_12_independent_a' }))
          const partial = F.plan(fixture.expansion, aRows, { continuation: F.continuationInput({ demandEvidence }) }).holds.find((entry: any) => entry.kind === 'continuation_candidate')
          const oldNewKeys = new Set<string>(original.detail.pairs.map((pair: any) => pair.newKey))
          const oldRecordIds = new Set<string>(original.detail.pairs.map((pair: any) => pair.oldRecordId))
          expect(partial.detail.pairs.length).toBe(2)
          expect(partial.detail.pairs.every((pair: any) => oldNewKeys.has(pair.newKey) && !oldRecordIds.has(pair.oldRecordId))).toBe(true)
          const idOf2 = await seedOpenHolds(storeA, scope, [partial], 1)
          // (a) the partial supersede.
          const before = await sheetFingerprint(scope.sheetId)
          const supersede = await settle(storeA.confirmContinuation(confirmInput(scope, idOf2(partial), partial, fixture, { supersedes: { continuationId: first.continuationId, revision: 1 } }), { bumpWithin: testBumpWithin }))
          observed.supersede = supersede.ok ? 'admitted' : `${(supersede as any).error.code}:${(supersede as any).error.details.reason}`
          observed.supersedeDetails = supersede.ok ? null : (supersede as any).error.details
          observed.stepFourRowsAndLockRowUnchanged = (await sheetFingerprint(scope.sheetId)) === before
          // (b) pilot exit; the next plan over the PERSISTED state; the REAL host writer under a real lease.
          await pilotExit(scope)
          const consult = await pilotReaderOn().consult(scope)
          observed.pilotAfterExit = consult.pilot ? consult.pilot.enabled : null
          observed.governedAfterExit = consult.governed
          const next = F.plan(fixture.expansion, oldRows.concat(aRows), { continuation: F.continuationInput({ pilot: false, demandEvidence, ...governanceModule.plannerSlice(consult) }) })
          observed.nextSuspended = next.suspended === true
          observed.oldRowWrites = writesTouching(next, new Set<string>(oldRows.map((row: any) => row.idempotencyKey)))
          observed.copyAddsAtOldPositions = writesTouching(next, oldNewKeys)
          const oldIds = oldRows.map((row: any) => row[RECORD_REF].id)
          const rowsOf = async () => (await q('SELECT id, version, data FROM meta_records WHERE id = ANY($1::text[]) ORDER BY id', [oldIds])).rows
          const beforeRows = await rowsOf()
          const writer = require(path.join(PLUGIN_LIB, 'stock-preparation-apply-writer.cjs'))
          const writeLock = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
          const applied = await writeLock.withProjectWriteLease(sb.key, { purpose: 'small_apply', runId: 's2_12_run' }, async (guard: any) => writer.applyStockPreparationPlan({ permission: 'write', plan: next, target: sb.target, recordsApi: sb.multitable.records, writeFence: guard, writeFenceRequired: true, governance: await inLeaseVerdict(scope) }))
          observed.writerStatus = applied.status
          const afterRows = await rowsOf()
          observed.oldRowsChangedByWriter = afterRows.filter((row: any, index: number) => JSON.stringify(row) !== JSON.stringify(beforeRows[index])).length
        } finally {
          await dropSheet(sb.sheetId)
        }
        console.log(`[S2-12] partial ${JSON.stringify(observed)}`)
        expect(observed).toEqual({
          supersede: `${RC.END_OUTCOME_NOT_ADMISSIBLE}:supersedes_incomplete`,
          supersedeDetails: { reason: 'supersedes_incomplete', outcome: 'superseded_by_new_confirmation', uncoveredOldRecords: 4, uncoveredOldKeys: 4 },
          stepFourRowsAndLockRowUnchanged: true,
          pilotAfterExit: false,
          governedAfterExit: true,
          nextSuspended: false,
          oldRowWrites: [],
          copyAddsAtOldPositions: [],
          writerStatus: 'succeeded',
          oldRowsChangedByWriter: 0,
        })
        // (c) a FULL takeover: every old row (and old key) re-rooted under another parent supersedes; after pilot exit the
        //     replacing relationship is the only one in the projection and still protects every old row.
        const scope = { tenantId: tenantFor('s2_12_full'), sheetId: sheetFor('s2_12_full'), projectNo: fixture.projectNo }
        await registerProject(scope, { pilot: true })
        const idOf = await seedOpenHolds(storeA, scope, [fixture.hold])
        const first = await storeA.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
        const full = refreshKit.competingCandidateHold(fixture.hold)
        const idOf2 = await seedOpenHolds(storeA, scope, [full], 1)
        const replaced = await storeA.confirmContinuation(confirmInput(scope, idOf2(full), full, fixture, { supersedes: { continuationId: first.continuationId, revision: 1 } }), { bumpWithin: testBumpWithin })
        await pilotExit(scope)
        const consult = await pilotReaderOn().consult(scope)
        const slice = governanceModule.plannerSlice(consult)
        const next = F.plan(fixture.expansion, fixture.sheet, { continuation: F.continuationInput({ pilot: false, demandEvidence, ...slice }) })
        const fullObserved = {
          superseded: replaced.supersededContinuationId === first.continuationId,
          pilotAfterExit: consult.pilot ? consult.pilot.enabled : null,
          projection: slice.continuations.map((entry: any) => entry.id === replaced.continuationId ? 'replacing' : 'other'),
          claimedOldRecords: slice.members.map((member: any) => member.oldRecordId).sort(),
          oldRowWrites: writesTouching(next, new Set<string>(fixture.sheet.map((row: any) => row.idempotencyKey))),
        }
        console.log(`[S2-12] full ${JSON.stringify({ ...fullObserved, claimedOldRecords: fullObserved.claimedOldRecords.length })}`)
        expect(fullObserved).toEqual({
          superseded: true,
          pilotAfterExit: false,
          projection: ['replacing'],
          claimedOldRecords: fixture.hold.detail.pairs.map((pair: any) => pair.oldRecordId).sort(),
          oldRowWrites: [],
        })
      }, 90000)

      test('S2-13 (review round 2, the reviewer\'s ANCESTOR counterexample) on a real sheet: an independent P-001 subtree inserted beside the confirmed relationship; over the FULL sheet and the current projection the REAL planner emits a five-member ancestor candidate (0 old rows, 4 new positions); the supersede is refused 409 supersedes_incomplete (uncoveredOldRecords 4) with every step-4 row and the lock row byte-identical; the next pull with the pilot ON (the real writer refuses the suspended plan) and OFF (the real writer applies it), and the third pull over the rows the host now holds, never write the four old rows', async () => {
        const fixture = await refreshKit.candidateHoldFixture()
        const storeA = storeOn(clientA)
        const scenario = await refreshKit.ancestorScenario({ idPrefix: 's2_13_independent_p' })
        const F = scenario.fixtures
        const demandEvidence = scenario.expansion.demandEvidence
        const RECORD_REF = Symbol.for('metasheet.stock-preparation.existingRow.recordRef')
        const writesTouching = (planned: any, keys: Set<string>) => planned.decisions
          .filter((decision: any) => keys.has(decision.idempotencyKey) && ['add', 'update', 'inactive'].includes(decision.decision))
          .map((decision: any) => decision.decision)
        const planWith = (rows: any[], consult: any, pilot: boolean) => F.plan(scenario.expansion, rows, { continuation: F.continuationInput({ pilot, demandEvidence, ...governanceModule.plannerSlice(consult) }) })
        const writer = require(path.join(PLUGIN_LIB, 'stock-preparation-apply-writer.cjs'))
        const writeLock = createStockPreparationProjectWriteLock({ db: dbOn(clientA) })
        // One observed table, asserted once (a regression shows the reviewer's whole outcome).
        const observed: Record<string, unknown> = {}
        const sb = await sandboxSheet('s2_13')
        try {
          const scope = { tenantId: tenantFor('s2_13'), sheetId: sb.sheetId, projectNo: fixture.projectNo }
          const fields = sb.target.fieldIdMap
          const seedRows = async (rows: any[]) => {
            const out: any[] = []
            for (const row of rows) {
              const data = Object.fromEntries(Object.entries(row).map(([name, value]) => [fields[name] || name, value]))
              const record = await sb.multitable.records.createRecord({ sheetId: sb.sheetId, data })
              out.push(F.withRecordRef(row, record.id, record.version))
            }
            return out
          }
          const applyThroughHost = async (planned: any, runId: string) => {
            const outcome = await settle(writeLock.withProjectWriteLease(sb.key, { purpose: 'small_apply', runId }, async (guard: any) => writer.applyStockPreparationPlan({ permission: 'write', plan: planned, target: sb.target, recordsApi: sb.multitable.records, writeFence: guard, writeFenceRequired: true, governance: await inLeaseVerdict(scope) })))
            if (outcome.ok) return String((outcome as any).value.status)
            const error = (outcome as any).error
            return String(error && (error.code === 'plan_suspended' || (error.details && error.details.code === 'plan_suspended')) ? 'plan_suspended' : `threw ${error && error.code}`)
          }
          await registerProject(scope, { pilot: true })
          const oldRows = await seedRows(fixture.sheet)
          const oldKeys = new Set<string>(oldRows.map((row: any) => row.idempotencyKey))
          const oldIds = oldRows.map((row: any) => row[RECORD_REF].id)
          const oldRowsNow = async () => (await q('SELECT id, version, data FROM meta_records WHERE id = ANY($1::text[]) ORDER BY id', [oldIds])).rows
          const changedSince = (before: any[], after: any[]) => after.filter((row: any, index: number) => JSON.stringify(row) !== JSON.stringify(before[index])).length
          // The relationship: the real planner pairs the four old rows with S-001 nested under Q-001 > P-001.
          const original = F.plan(scenario.expansion, oldRows, { continuation: F.continuationInput({ demandEvidence }) }).holds.find((entry: any) => entry.kind === 'continuation_candidate')
          const idOf = await seedOpenHolds(storeA, scope, [original])
          const first = await storeA.confirmContinuation(confirmInput(scope, idOf(original), original, fixture), { bumpWithin: testBumpWithin })
          // The reviewer's SYNTHETIC step: five independent P-001 rows written to the same sheet after the confirm.
          const independentRows = await seedRows(scenario.independentRows)
          const complete = oldRows.concat(independentRows)
          // The real planner over the FULL sheet and the CURRENT projection (the real consult) emits the ancestor candidate.
          const consult0 = await pilotReaderOn().consult(scope)
          const candidate = planWith(complete, consult0, true).holds.find((entry: any) => entry.kind === 'continuation_candidate')
          const oldRecordIds = new Set<string>(original.detail.pairs.map((pair: any) => pair.oldRecordId))
          const oldNewKeys = new Set<string>(original.detail.pairs.map((pair: any) => pair.newKey))
          observed.sheetRows = complete.length
          observed.candidate = candidate ? {
            members: candidate.detail.pairs.length,
            oldRecordOverlap: candidate.detail.pairs.filter((pair: any) => oldRecordIds.has(pair.oldRecordId)).length,
            newPositionOverlap: candidate.detail.pairs.filter((pair: any) => oldNewKeys.has(pair.newKey)).length,
          } : null
          const idOf2 = await seedOpenHolds(storeA, scope, [candidate], consult0.decisionVersionObserved)
          // (a) the supersede.
          const before = await sheetFingerprint(scope.sheetId)
          const supersede = await settle(storeA.confirmContinuation(confirmInput(scope, idOf2(candidate), candidate, fixture, { supersedes: { continuationId: first.continuationId, revision: 1 } }), { bumpWithin: testBumpWithin }))
          observed.supersede = supersede.ok ? 'admitted' : `${(supersede as any).error.code}:${(supersede as any).error.details.reason}`
          observed.supersedeDetails = supersede.ok ? null : (supersede as any).error.details
          observed.stepFourRowsAndLockRowUnchanged = (await sheetFingerprint(scope.sheetId)) === before
          // (b) the next pull with the pilot ON, then (pilot exit) OFF — the real planner over the persisted state, the real host writer.
          const nextOn = planWith(complete, await pilotReaderOn().consult(scope), true)
          let rowsBefore = await oldRowsNow()
          observed.nextPilotOn = { suspended: nextOn.suspended === true, oldRowWrites: writesTouching(nextOn, oldKeys), writer: await applyThroughHost(nextOn, 's2_13_on'), oldRowsChangedByWriter: changedSince(rowsBefore, await oldRowsNow()) }
          await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = NULL, pilot_enabled_by = NULL, pilot_readiness_version = NULL WHERE id = $1', [`pt_${scope.sheetId}`])
          const consultOff = await pilotReaderOn().consult(scope)
          const nextOff = planWith(complete, consultOff, false)
          rowsBefore = await oldRowsNow()
          observed.nextPilotOff = { pilot: consultOff.pilot ? consultOff.pilot.enabled : null, suspended: nextOff.suspended === true, oldRowWrites: writesTouching(nextOff, oldKeys), writer: await applyThroughHost(nextOff, 's2_13_off'), oldRowsChangedByWriter: changedSince(rowsBefore, await oldRowsNow()) }
          // (c) the third pull over the sheet AS THE HOST NOW HOLDS IT (read back through the real reader), pilot on and off.
          const landed = await tableActions.__internals.readExistingStockPreparationRows(sb.multitable.records, sb.target, scope.projectNo)
          const consult3 = await pilotReaderOn().consult(scope)
          observed.thirdPull = {
            pilotOn: writesTouching(planWith(landed, consult3, true), oldKeys),
            pilotOff: writesTouching(planWith(landed, consult3, false), oldKeys),
            oldRowsStillActive: (await oldRowsNow()).filter((row: any) => row.data[fields.active || 'active'] !== false).length,
          }
        } finally {
          await dropSheet(sb.sheetId)
        }
        console.log(`[S2-13] ancestor ${JSON.stringify(observed)}`)
        expect(observed).toEqual({
          sheetRows: 9,
          candidate: { members: 5, oldRecordOverlap: 0, newPositionOverlap: 4 },
          supersede: `${RC.END_OUTCOME_NOT_ADMISSIBLE}:supersedes_incomplete`,
          supersedeDetails: { reason: 'supersedes_incomplete', outcome: 'superseded_by_new_confirmation', uncoveredOldRecords: 4, uncoveredOldKeys: 4 },
          stepFourRowsAndLockRowUnchanged: true,
          nextPilotOn: { suspended: true, oldRowWrites: [], writer: 'plan_suspended', oldRowsChangedByWriter: 0 },
          nextPilotOff: { pilot: false, suspended: false, oldRowWrites: [], writer: 'succeeded', oldRowsChangedByWriter: 0 },
          thirdPull: { pilotOn: [], pilotOff: [], oldRowsStillActive: 4 },
        })
      }, 120000)
      // ── S3A: batch-refresh step 4 PR-3a — the lanes on the REAL stack ─────────────────────────────────────────
      // Every route case mounts the REAL route module (lib/http-routes.cjs registerIntegrationRoutes) over the
      // production host context (real multitable records / provisioning, plugin_kv storage), the real lock, PR B's
      // real registry store, the real audit store and the REAL refresh services (`realRefreshServices`: one
      // continuation store for the reader and the lanes, as index.cjs wires them). A project sheet is a really
      // provisioned sandbox sheet (template fields, contract options, PLM column lock); the deployment's env target is
      // a second one. The source is the canonical S/P story of support/stock-preparation-continuation-fixtures.cjs
      // (first pull: S-001 alone; second pull: S-001 nested in P-001 plus N-001). Nested in S2 for its store helpers
      // (the seeded confirm's bump stand-in, `seedOpenHolds`, `sheetFingerprint`) and its tenant-prefix cleanup.
      //   S3A-01 (A01, E-1 full entry) a pilot project's second pull: a READ-tier and a puller preview are suspended
      //          (no token, no bump, one open confirmable candidate hold); HTTP apply with a forged token, a stale
      //          one and acceptManualConfirmHold is 409 SUSPENDED; mvp-persist 409 NOT_READY refresh_suspended; the
      //          reconcile route keeps the SAME hold; the main sheet's meta_records (ids, versions) and
      //          meta_record_revisions unchanged after EVERY entry; no execution begun by a refusal.
      //   S3A-06 (A12 / E-4) after a confirmed relationship, a PERSON's fill of a human column on an old row never
      //          revokes it: the re-preview verifies, the continuation stays active, the apply writes no human
      //          column and the new value survives; a HOST-side machine edit of an old row suspends the pull.
      //   S3A-07 (C10 (c), E-2(a)) a pilot-era open candidate hold survives pilot exit: two previews keep the SAME
      //          open row (no new row), the pull stays suspended, the apply is 409 and nothing is written.
      //   S3A-08 (U07, both ways) switch off: a PILOT project registered on its own sheet is refused 409 RETARGETED on
      //          dry-run, reconcile, mvp-persist, carry and apply (0 source reads, env sheet untouched, no store row, no
      //          token left, no bump); a registered NOT-governed project pulls on the env sheet as before, 0 step-4 rows.
      //   S3A-11 (G1 / A11; review round 1 item 2) the step-4 tables ABSENT from the store's binding (42P01 — what a
      //          pre-102/103 database answers; the registry stays readable): the chunk route on a PAUSED job, the
      //          dry-run and the apply answer 503 STORE_FAILED `continuation`; 0 source reads, nothing written, no token,
      //          no bump, the job STAYS paused (explicitly) and the lease is released.
      //   S3A-12 (H6 / E09; review round 1 item 1, lens B V50B-08) a REAL fault inside the reconcile transaction (a
      //          BEFORE INSERT trigger on the hold table raising 42501 for this tenant only): the preview and the apply
      //          answer 503 `hold_open`; every step-4 row byte-identical, no bump, no token, no execution, main untouched.
      //   S3A-13 (O-22) a seeded FAILED execution, or a RUNNING one of a dead lease: the PREVIEW answers
      //          `recovery_pending` (no token, no bump; review round 1 item 4) and the apply under its own live lease is
      //          409 RECOVERY_PENDING from the rows (the derived state under a live lease reads `executing`), nothing
      //          written, no new execution.
      //   S3A-17 (ST-1 / TD-23) the settling finish vs a concurrent preview reconcile, on PostgreSQL, both orders
      //          (pg_blocking_pids) plus the non-settling leg: no 40P01, no stuck `running` row, and while the finish
      //          waits it holds neither its execution row nor the bound continuation.
      //   S3A-18 (L5) a paused large job (one row written) on a project made governed by a store-seeded hold (no bump):
      //          the chunk ROUTE refuses 409 LARGE_LANE_REFUSED `hold` inside its lease, the job byte-identical, 0 writes.
      //   S3A-19 (G4) a registered NOT-governed project through dry-run / apply / re-preview / reconcile: 0 step-4 rows,
      //          the next consult `governed: false`.
      //   S3A-22 (R-7) the carry on a governed project: an ordinary open hold => carried (only the human cell moves);
      //          a runbook-only hold => 409; a failed execution => 409 RECOVERY_PENDING; the store unreadable => 503.
      //   S3A-23 (V1) a sentinel planted in a persisted hold's detail: the suspended responses, every plugin_kv value
      //          (token + background job record), the registry row and every meta_records value never carry it; the
      //          hold table does.
      //   S3A-27 (R-13) step-4 rows on sheet A, the registry re-pointed to sheet B, switch on: dry-run, reconcile,
      //          mvp-persist, carry, apply and the chunk route all 409 RETARGETED `sheet`; 0 source reads, no store write.
      //   S3A-28 (review round 1 item 3, lens B V50B-16) a carry whose key is DUPLICATE-RESOLVED
      //          (`<json>::duplicate:<kind>:<hash>`): a NOT-governed project (switch off) carries as before this PR; a
      //          GOVERNED project's consult resolves THAT project (an earlier failed execution => RECOVERY_PENDING).
      //   S3A-29 (PR-3a follow-up) the executor half of S3A-28: a governed project's pair whose duplicate-resolved
      //          TARGET key embeds another, not-governed project — the route consults that project and cannot refuse;
      //          the executor's base-key check refuses 409 CONFIRM_CARRY_PROJECT_MISMATCH, nothing written.
      //   S3A-30 (PR-3a follow-up) a run `running` at the preview's snapshot that finishes before the preview's lock
      //          read: the preview re-consults once and answers 409 STATE_MOVED execution_finished_during_preview,
      //          never a false recovery_pending; no token, no bump.
      describe('S3A step-4 lanes (real Postgres, real lock, real host)', () => {
        const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
        const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
        const auditStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
        const confirmationDecisionsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-confirmation-decisions.cjs')) as any
        const pairingLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-pairing.cjs')) as any
        const httpRoutesLib = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
        const access = require(path.join(PLUGIN_LIB, 'stock-preparation-workbench-access.cjs')) as any
        const harnessLib = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')) as any
        const CF = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-continuation-fixtures.cjs')) as any
        const SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
        const MVP_SWITCH = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
        const ACTION_ID = tableActions.PLM_STOCK_PREPARATION_ACTION_ID
        const PATHS = {
          dryRun: '/api/integration/table-actions/:actionId/dry-run',
          dryRunJob: '/api/integration/table-actions/:actionId/dry-run-jobs',
          apply: '/api/integration/table-actions/:actionId/apply',
          mvp: '/api/integration/table-actions/:actionId/mvp-persist',
          reconcile: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
          carry: '/api/integration/stock-preparation/carry/confirm',
          chunk: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId/run',
          // PR-3b: the large lane's four non-write routes.
          largeStart: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs',
          largeRun: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/run',
          largePlan: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/plan',
          largeApprove: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs',
          // PR-5 (S5): the formal export.
          export: '/api/integration/stock-preparation/prep-lines/export',
        }
        const RETARGETED = 'STOCK_PREP_REFRESH_TARGET_RETARGETED'
        const s3aSheets: string[] = []

        afterAll(async () => {
          for (const sheetId of s3aSheets) await dropSheet(sheetId)
        })

        // The main sheet as the host holds it: record ids + versions and the revision count.
        async function mainSheetState(sheetId: string) {
          const rows = (await q('SELECT id, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])).rows
          const revisions = Number((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1', [sheetId])).rows[0].n)
          return { count: rows.length, rows: rows.map((row: any) => `${row.id}@${row.version}`), revisions }
        }
        const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
        // Every step-4 row of one tenant (the five tables): the "nothing persisted" fingerprint of a lane refusal.
        async function stepFour(tenantId: string) {
          const out: unknown[] = []
          for (const table of [RT.continuation, RT.member, RT.hold, RT.state, RT.execution]) out.push((await q(`SELECT * FROM ${table} WHERE tenant_id = $1 ORDER BY id`, [tenantId])).rows)
          return JSON.stringify(out)
        }
        const kvTokens = async () => Number((await q(`SELECT count(*)::int AS n FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE 'integration:table-action:dry-run-token:%'`)).rows[0].n)
        const errorOf = (res: any) => (res && res.body && res.body.error ? res.body.error : {})
        const decisionVersionOf = async (scope: Record<string, string>) => Number(((await q(`SELECT decision_version FROM ${RT.state} WHERE sheet_id = $1 AND project_no = $2`, [scope.sheetId, scope.projectNo])).rows[0] || { decision_version: 0 }).decision_version)

        // A pilot content-change hold (a pilot-detection kind: re-emitted from its stored row after pilot exit).
        function contentHold(key = 'k_s3a', extraDetail: Record<string, unknown> = {}) {
          const hold: any = {
            kind: 'content_change',
            confirmable: false,
            notConfirmableReason: 'needs_step5',
            subject: { keyDigest: nodeCrypto.createHash('sha256').update(key).digest('hex') },
            detail: { recordId: null, recordVersion: null, key, reason: 'plm_system_refresh', fields: {}, inContinuation: null, humanColumnsPresent: {}, ...extraDetail },
          }
          hold.fingerprint = pairingLib.holdFingerprint(hold)
          return hold
        }

        // PR-5 (S5): `routeLock` replaces the lock the ROUTES are handed (a hookable view over the same table); `serviceExtras`
        // are merged last (the S5 xlsx builder with its hook). Both additive; every earlier case passes neither.
        async function s3aStack(label: string, options: { pilot?: boolean; register?: boolean; switchOn?: boolean; data?: any; refresh?: any; routeLock?: any; serviceExtras?: Record<string, any> } = {}) {
          const { pilot = true, register = true, switchOn = true } = options
          const tenantId = tenantFor(`s3a_${label}`)
          const projectNo: string = CF.PROJECT_NO
          const projectId = `${tenantId}:integration-core`
          const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
          const pluginContext = createProductionPluginContext()
          const multitable: any = pluginContext.api.multitable
          if (!multitable) throw new Error('production plugin context is missing multitable APIs')
          const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
          expect(ensured.ready).toBe(true)
          await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
          await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
          const sheetId: string = ensured.target.sheetId
          s3aSheets.push(sheetId)
          scopes.push(sheetWriteScopeKey(sheetId))
          // The deployment's env target: its OWN real sandbox sheet in the same tenant project (switch-off legs).
          const envObjectId = `plm_stock_preparation_sandbox_s3a_env_${label}_${TOKEN}`
          const envEnsured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId: envObjectId })
          expect(envEnsured.ready).toBe(true)
          await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId: envObjectId })
          s3aSheets.push(envEnsured.target.sheetId)
          scopes.push(sheetWriteScopeKey(envEnsured.target.sheetId))
          const db = createDb({ database: pluginContext.api.database })
          const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
          if (register) await registry.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
          if (register && pilot) {
            await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [tenantId, projectNo, 'u_s3a_admin'])
          }
          const lock = createStockPreparationProjectWriteLock({ db })
          const refresh = options.refresh || realRefreshServices()
          const state: any = { data: options.data || CF.firstPullSource(), reads: 0 }
          const sourceAdapter = {
            async read(input: any = {}) {
              state.reads += 1
              const rows = Array.isArray(state.data[input.object]) ? state.data[input.object] : []
              const found = rows.filter((row: any) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
              return { records: found.map((row: any) => ({ ...row })), done: true, nextCursor: null }
            },
          }
          const actionConfig = {
            actionId: ACTION_ID,
            source: { externalSystemId: `plm_s3a_${label}_${TOKEN}`, kind: 'data-source:sql-readonly' },
            target: envEnsured.target,
          }
          const routes = new Map<string, any>()
          const routeContext = {
            api: {
              http: { addRoute: (method: string, routePath: string, handler: any) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
              multitable,
              database: pluginContext.api.database,
            },
            storage: pluginContext.storage,
            config: {
              stockPreparationTableActions: [actionConfig],
              stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envObjectId] },
            },
          }
          const base = harnessLib.baseServices(sourceAdapter)
          const services: any = {
            ...base,
            externalSystemRegistry: { ...base.externalSystemRegistry, async listExternalSystems() { return [] } },
            pipelineRegistry: { ...base.pipelineRegistry, async listPipelines() { return [] } },
            stockPreparationProjectWriteLock: options.routeLock || lock,
            stockPreparationProjectTargetStore: registry,
            stockPreparationAuditStore: auditStoreLib.createStockPreparationAuditStore({ db }),
            stockPreparationPackInstallStore: packInstallStoreLib.createStockPreparationPackInstallStore({ db }),
            stockPreparationConfirmationDecisionLease: confirmationDecisionsLib.createConfirmationDecisionReconcileLease({ db }),
            tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
            stockPreparationRefreshGovernance: refresh.governance,
            stockPreparationContinuationStore: refresh.store,
            // PR-5 (S5): the export's workbook builder — a JSON buffer, so a case can read the headers and rows back.
            stockPreparationXlsxExport: { async buildWorkbookBuffer(params: any) { return Buffer.from(JSON.stringify(params), 'utf8') } },
            ...(options.serviceExtras || {}),
          }
          httpRoutesLib.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
          const users = {
            reader: { id: `u_s3a_read_${label}`, tenantId, permissions: ['integration:read'] },
            puller: { id: `u_s3a_pull_${label}`, tenantId, permissions: [access.STOCK_PREP_READ, access.STOCK_PREP_OPERATE, access.STOCK_PREP_PULL] },
            admin: { id: `u_s3a_admin_${label}`, tenantId, roles: ['admin'], permissions: ['integration:admin'] },
          }
          const key = sheetWriteScopeKey(sheetId)
          const withEnv = async <T>(extra: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
            const names = [SWITCH, ...Object.keys(extra)]
            const before: Record<string, string | undefined> = Object.fromEntries(names.map((name) => [name, process.env[name]]))
            if (switchOn) process.env[SWITCH] = 'true'
            else delete process.env[SWITCH]
            for (const [name, value] of Object.entries(extra)) process.env[name] = value
            try {
              return await fn()
            } finally {
              for (const name of names) {
                if (before[name] === undefined) delete process.env[name]
                else process.env[name] = before[name]
              }
            }
          }
          const call = (method: string, routePath: string, user: any, body: any = {}, params: Record<string, string> = {}, extraEnv: Record<string, string> = {}) =>
            withEnv(extraEnv, () => callRoute(routes, method, routePath, { user, body, query: {}, params: { actionId: ACTION_ID, ...params } }))
          const sourceIdentity = refreshLanes.refreshSourceIdentity({ action: tableActions.normalizeStockPreparationActionConfig(actionConfig), tenantId })
          return {
            tenantId, projectNo, projectId, objectId, sheetId, key, target: ensured.target, envTarget: envEnsured.target, multitable, pluginContext,
            registry, lock, refresh, state, users, routes, sourceAdapter, sourceIdentity, action: { ...actionConfig, target: ensured.target },
            scope: { tenantId, sheetId, projectNo },
            dryRun: (user: any = users.puller) => call('POST', PATHS.dryRun, user, { parameters: { projectNo } }),
            dryRunJob: (user: any = users.puller) => call('POST', PATHS.dryRunJob, user, { parameters: { projectNo } }),
            apply: (user: any, token: string, confirmExtra: Record<string, unknown> = {}) => call('POST', PATHS.apply, user, { parameters: { projectNo }, confirm: { dryRunToken: token, ...confirmExtra } }),
            mvpPersist: (user: any = users.admin) => call('POST', PATHS.mvp, user, { parameters: { projectNo } }, {}, { [MVP_SWITCH]: 'true' }),
            reconcile: (user: any = users.admin) => call('POST', PATHS.reconcile, user, { parameters: { projectNo } }),
            carry: (decision: any, user: any = users.admin) => call('POST', PATHS.carry, user, { decision }),
            chunk: (jobId: string, applyJobId: string, user: any = users.admin) => call('POST', PATHS.chunk, user, {}, { jobId, applyJobId }),
            // PR-3b: the large lane's four non-write routes, through the same switch handling as every lane.
            largeStart: (user: any = users.admin) => call('POST', PATHS.largeStart, user, { parameters: { projectNo } }),
            largeRun: (jobId: string, user: any = users.admin) => call('POST', PATHS.largeRun, user, {}, { jobId }),
            largePlan: (jobId: string, user: any = users.admin) => call('POST', PATHS.largePlan, user, {}, { jobId }),
            largeApprove: (jobId: string, user: any = users.admin) => call('POST', PATHS.largeApprove, user, { confirm: { acceptManualConfirmHold: true } }, { jobId }),
            // PR-5 (S5): the formal export through the REAL route, under the same switch handling as every lane.
            exportLines: (user: any = users.puller) => withEnv({}, () => callRoute(routes, 'GET', PATHS.export, { user, query: { projectNo }, params: {} })),
            // A token the apply route will consume and bind: the CURRENT generation of the sheet, no bump.
            async mintToken(revision: string, sheetKey: string = key) {
              const generation = await lock.readGeneration(sheetKey)
              return tableActions.__internals.createDryRunToken(pluginContext.storage, {
                actionId: ACTION_ID,
                parametersHash: tableActions.__internals.hashJson(tableActions.normalizeActionParameters({ projectNo })),
                revision,
                conflictPolicyReview: null,
                ...writeBindingFromGeneration(generation),
              })
            },
            generation: async (sheetKey: string = key) => {
              const generation = await lock.readGeneration(sheetKey)
              return { generation: generation.generation, generationToken: generation.generationToken }
            },
            main: (target: string = sheetId) => mainSheetState(target),
            rows: async (target: string = sheetId) => (await q('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY id', [target])).rows,
            holds: async () => (await q(`SELECT id, kind, status, confirmable, runbook_only, fingerprint, comparison_fingerprint, evidence_fingerprint FROM ${RT.hold} WHERE sheet_id = $1 AND project_no = $2 ORDER BY opened_at, id`, [sheetId, projectNo])).rows,
            executions: async () => (await q(`SELECT id, status, lease_id, started_by FROM ${RT.execution} WHERE sheet_id = $1 ORDER BY started_at, id`, [sheetId])).rows,
            stepFourRows: async () => {
              let n = 0
              for (const table of [RT.continuation, RT.member, RT.hold, RT.state, RT.execution]) n += await countWhere(table, 'tenant_id = $1', [tenantId])
              return n
            },
            pilotExit: () => q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = NULL, pilot_enabled_by = NULL, pilot_readiness_version = NULL WHERE tenant_id = $1 AND project_no = $2', [tenantId, projectNo]),
          }
        }

        // The first pull applied through the routes (a governed project's clean pull records ONE execution).
        async function firstPullApplied(st: any) {
          const first = await st.dryRun()
          expect(first.statusCode, JSON.stringify(first.body)).toBe(200)
          expect(first.body.data.status).toBe('ready')
          const applied = await st.apply(st.users.puller, first.body.data.dryRunToken)
          expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
          expect(applied.body.data.status).toBe('succeeded')
          return first
        }

        // Confirm the project's open candidate hold through the REAL store (the decision PR-4's route will make).
        async function confirmOpenCandidate(st: any) {
          const row = (await st.holds()).find((entry: any) => entry.status === 'open' && entry.kind === 'continuation_candidate')
          expect(row, 'an open candidate hold to confirm').toBeTruthy()
          return st.refresh.store.confirmContinuation({
            ...st.scope,
            holdId: row.id,
            echo: { holdFingerprint: row.fingerprint, comparisonFingerprint: row.comparison_fingerprint, evidenceFingerprint: row.evidence_fingerprint },
            basis: { kind: 'puller_confirmed_same_demand' },
            confirmedBy: st.users.puller.id,
            sourceIdentity: st.sourceIdentity,
          }, { bumpWithin: testBumpWithin })
        }

        test('S3A-01 (A01, E-1 full entry) a pilot project\'s second pull through the REAL routes: read-tier and puller previews suspended (no token, no bump, one open confirmable candidate hold); apply with a forged token, a stale one and acceptManualConfirmHold 409 SUSPENDED; mvp-persist 409 NOT_READY refresh_suspended; reconcile keeps the same hold; the main sheet\'s meta_records and meta_record_revisions unchanged after every entry; no execution begun by a refusal', async () => {
          const st = await s3aStack('s01', { pilot: true })
          const first = await firstPullApplied(st)
          expect((await st.executions()).map((row: any) => row.status)).toEqual(['succeeded'])
          st.state.data = CF.secondPullSource()
          const main0 = await st.main()
          expect(main0.count).toBe(4)
          const gen0 = await st.generation()
          const observed: Record<string, unknown> = {}
          const read = await st.dryRun(st.users.reader)
          observed.readTier = { status: read.statusCode, previewStatus: read.body.data && read.body.data.status, token: read.body.data ? read.body.data.dryRunToken : 'absent', canApply: read.body.data && read.body.data.canApply }
          observed.genAfterRead = sameJson(await st.generation(), gen0)
          observed.mainAfterRead = sameJson(await st.main(), main0)
          const pulled = await st.dryRun(st.users.puller)
          observed.puller = { status: pulled.statusCode, previewStatus: pulled.body.data && pulled.body.data.status, token: pulled.body.data ? pulled.body.data.dryRunToken : 'absent', held: pulled.body.data && pulled.body.data.refreshHold && pulled.body.data.refreshHold.held }
          observed.genAfterPuller = sameJson(await st.generation(), gen0)
          observed.mainAfterPuller = sameJson(await st.main(), main0)
          const openIds = (await st.holds()).filter((row: any) => row.status === 'open').map((row: any) => row.id)
          observed.openHolds = (await st.holds()).filter((row: any) => row.status === 'open').map((row: any) => `${row.kind}:${row.confirmable}`)
          // E-1 layer (a) at the full entry: every token shape is refused by the in-lease recompute.
          const tokens: Array<[string, string, Record<string, unknown>]> = [
            ['forged', 'rev_s3a_forged', {}],
            ['stale', String(first.body.data.revision), {}],
            ['acceptManualConfirmHold', 'rev_s3a_forged_manual', { acceptManualConfirmHold: true }],
          ]
          const refusals: Record<string, unknown> = {}
          for (const [label, revision, extra] of tokens) {
            const res = await st.apply(st.users.puller, await st.mintToken(revision), extra)
            refusals[label] = { status: res.statusCode, code: errorOf(res).code, mainUnchanged: sameJson(await st.main(), main0) }
          }
          observed.applies = refusals
          const mvp = await st.mvpPersist()
          observed.mvp = { status: mvp.statusCode, code: errorOf(mvp).code, reason: errorOf(mvp).details && errorOf(mvp).details.reason, mainUnchanged: sameJson(await st.main(), main0) }
          const reconciled = await st.reconcile()
          observed.reconcile = {
            mainUnchanged: sameJson(await st.main(), main0),
            sameOpenHolds: sameJson((await st.holds()).filter((row: any) => row.status === 'open').map((row: any) => row.id), openIds),
          }
          console.log(`[S3A-01] reconcile route answered ${reconciled.statusCode} ${errorOf(reconciled).code || ''}`)
          observed.executions = (await st.executions()).map((row: any) => row.status)
          console.log(`[S3A-01] ${JSON.stringify(observed)}`)
          expect(observed).toEqual({
            readTier: { status: 200, previewStatus: 'suspended', token: null, canApply: false },
            genAfterRead: true,
            mainAfterRead: true,
            puller: { status: 200, previewStatus: 'suspended', token: null, held: true },
            genAfterPuller: true,
            mainAfterPuller: true,
            openHolds: ['continuation_candidate:true'],
            applies: {
              forged: { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED', mainUnchanged: true },
              stale: { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED', mainUnchanged: true },
              acceptManualConfirmHold: { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED', mainUnchanged: true },
            },
            mvp: { status: 409, code: 'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY', reason: 'refresh_suspended', mainUnchanged: true },
            reconcile: { mainUnchanged: true, sameOpenHolds: true },
            executions: ['succeeded'],
          })
          expect(await st.main()).toEqual(main0)
        }, 180000)

        test('S3A-06 (A12 / E-4) a person\'s fill of a human column on an old row never revokes the confirmed relationship: the re-preview verifies, the continuation stays active, the apply writes no human column and the new value survives; a HOST-side machine edit of an old row suspends the pull', async () => {
          const st = await s3aStack('s06', { pilot: true })
          await firstPullApplied(st)
          st.state.data = CF.secondPullSource()
          expect((await st.dryRun()).body.data.status).toBe('suspended')
          const confirmed = await confirmOpenCandidate(st)
          const continuationRow = async () => (await q(`SELECT status, last_verdict FROM ${RT.continuation} WHERE id = $1`, [confirmed.continuationId])).rows[0]
          const observed: Record<string, unknown> = {}
          const before = await st.dryRun()
          observed.afterConfirm = { status: before.body.data && before.body.data.status, add: before.body.data && before.body.data.counts && before.body.data.counts.add }
          // A PERSON fills a human column on the old S-001 root through the host (a version bump of that record).
          const fields = st.target.fieldIdMap
          const notesField = fields.notes || 'notes'
          const rows = await st.rows()
          const root = rows.find((row: any) => row.data[fields.componentSourceId || 'componentSourceId'] === 'S-001' && JSON.parse(String(row.data[fields.path || 'path'])).length === 1)
          expect(root, 'the old S-001 root row').toBeTruthy()
          await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: root.id, changes: { [notesField]: 'synthetic human fill' } })
          // The old token: either still applicable or refused TOKEN_MISMATCH (acceptable) — never a human-column write.
          const old = await st.apply(st.users.puller, before.body.data.dryRunToken)
          observed.oldToken = old.statusCode === 200 ? 'applied' : errorOf(old).code
          const again = await st.dryRun()
          observed.rePreview = again.body.data && again.body.data.status
          if (again.body.data && again.body.data.dryRunToken) {
            const applied = await st.apply(st.users.puller, again.body.data.dryRunToken)
            observed.reApply = applied.statusCode === 200 ? applied.body.data.status : errorOf(applied).code
          }
          observed.continuation = await continuationRow()
          const rootAfter = (await st.rows()).find((row: any) => row.id === root.id)
          observed.humanValueIntact = rootAfter.data[notesField] === 'synthetic human fill'
          // A HOST-side MACHINE edit of an old row (a PLM column changed behind the plugin's back).
          const materialField = fields.material || 'material'
          await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: root.id, changes: { [materialField]: 'M-HOST-EDITED' } })
          const afterMachine = await st.dryRun()
          observed.afterMachineEdit = { status: afterMachine.body.data && afterMachine.body.data.status, token: afterMachine.body.data ? afterMachine.body.data.dryRunToken : 'absent' }
          observed.openHoldKinds = (await st.holds()).filter((row: any) => row.status === 'open').map((row: any) => row.kind).sort()
          console.log(`[S3A-06] ${JSON.stringify(observed)}`)
          expect(observed.afterConfirm).toEqual({ status: 'ready', add: 2 })
          expect(['applied', 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH']).toContain(observed.oldToken)
          expect(observed.rePreview).toBe('ready')
          expect(observed.continuation).toMatchObject({ status: 'active' })
          expect(observed.humanValueIntact).toBe(true)
          expect(observed.afterMachineEdit).toEqual({ status: 'suspended', token: null })
          expect((observed.openHoldKinds as string[]).length).toBeGreaterThan(0)
        }, 240000)

        test('S3A-07 (C10 (c), E-2(a)) a pilot-era open candidate hold survives pilot exit: two previews keep the SAME open row and add none, the pull stays suspended, the apply is 409 and nothing is written', async () => {
          const st = await s3aStack('s07', { pilot: true })
          await firstPullApplied(st)
          st.state.data = CF.secondPullSource()
          expect((await st.dryRun()).body.data.status).toBe('suspended')
          const pilotHolds = await st.holds()
          expect(pilotHolds.filter((row: any) => row.status === 'open').map((row: any) => row.kind)).toEqual(['continuation_candidate'])
          await st.pilotExit()
          const main0 = await st.main()
          const previews: unknown[] = []
          for (let i = 0; i < 2; i += 1) {
            const res = await st.dryRun()
            const holds = await st.holds()
            previews.push({
              status: res.body.data && res.body.data.status,
              token: res.body.data ? res.body.data.dryRunToken : 'absent',
              holdRows: holds.length,
              sameOpenRow: sameJson(holds.filter((row: any) => row.status === 'open').map((row: any) => row.id), pilotHolds.map((row: any) => row.id)),
            })
          }
          const applied = await st.apply(st.users.puller, await st.mintToken('rev_s3a_07_forged'))
          console.log(`[S3A-07] ${JSON.stringify({ previews, apply: errorOf(applied).code })}`)
          expect(previews).toEqual([
            { status: 'suspended', token: null, holdRows: 1, sameOpenRow: true },
            { status: 'suspended', token: null, holdRows: 1, sameOpenRow: true },
          ])
          expect(applied.statusCode).toBe(409)
          expect(errorOf(applied).code).toBe('STOCK_PREP_PULL_SUSPENDED')
          expect(await st.main()).toEqual(main0)
        }, 180000)

        test('S3A-08 (U07, both ways) switch off: a PILOT project registered on its own sheet is refused 409 RETARGETED on every lane with nothing read, written, minted or bumped; a registered NOT-governed project pulls on the env sheet as before with 0 step-4 rows', async () => {
          const st = await s3aStack('s08g', { pilot: true, switchOn: false })
          const envKey = sheetWriteScopeKey(st.envTarget.sheetId)
          const envMain0 = await st.main(st.envTarget.sheetId)
          // The env sheet's lock row exists before the lanes run (a first lease acquire CREATES it — a new row, not a
          // bump), so "no bump" compares the generation AND its token across every lane below.
          await st.lock.withProjectWriteLease(envKey, { purpose: 'small_apply', runId: 's3a-08-prime' }, async () => null)
          const envGen0 = await st.generation(envKey)
          expect(envGen0.generationToken).toBeTruthy()
          const tokens0 = await kvTokens()
          const carryPair = await seedCarryPair({ multitable: st.multitable, sheetId: st.envTarget.sheetId, target: st.envTarget }, st.projectNo)
          const envMainWithPair = await st.main(st.envTarget.sheetId)
          const lanes: Record<string, any> = {
            dryRun: await st.dryRun(),
            reconcile: await st.reconcile(),
            mvpPersist: await st.mvpPersist(),
            carry: await st.carry(carryDecision(st.projectNo)),
            apply: await st.apply(st.users.puller, await st.mintToken('rev_s3a_08_forged', envKey)),
          }
          const answers = Object.fromEntries(Object.entries(lanes).map(([lane, res]) => [lane, `${res.statusCode}:${errorOf(res).code}:${errorOf(res).details && errorOf(res).details.reason}`]))
          const governedLeg = {
            answers,
            sourceReads: st.state.reads,
            envUnchanged: sameJson(await st.main(st.envTarget.sheetId), envMainWithPair),
            carryTargetUntouched: (await carryPair.readTarget()).notes === null,
            stepFourRows: await st.stepFourRows(),
            tokensLeft: (await kvTokens()) - tokens0,
            envGenUnchanged: sameJson(await st.generation(envKey), envGen0),
          }
          console.log(`[S3A-08] governed ${JSON.stringify(governedLeg)}`)
          const refused = `409:${RETARGETED}:project_registered_on_another_sheet`
          expect(envMain0.count).toBe(0)
          expect(governedLeg).toEqual({
            answers: { dryRun: refused, reconcile: refused, mvpPersist: refused, carry: refused, apply: refused },
            sourceReads: 0,
            envUnchanged: true,
            carryTargetUntouched: true,
            stepFourRows: 0,
            tokensLeft: 0,
            envGenUnchanged: true,
          })
          // NOT governed (registered, no pilot, no step-4 row), switch off: today's behaviour on the env sheet.
          const nt = await s3aStack('s08n', { pilot: false, switchOn: false })
          const dry = await nt.dryRun()
          expect(dry.statusCode, JSON.stringify(dry.body)).toBe(200)
          expect(dry.body.data.status).toBe('ready')
          expect(dry.body.data.counts.add).toBe(4)
          const applied = await nt.apply(nt.users.puller, dry.body.data.dryRunToken)
          expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
          expect(applied.body.data.status).toBe('succeeded')
          expect((await nt.main(nt.envTarget.sheetId)).count).toBe(4)
          expect((await nt.main()).count).toBe(0)
          expect(await nt.stepFourRows()).toBe(0)
          expect((await nt.refresh.governance.consult({ ...nt.scope, sheetId: nt.envTarget.sheetId })).governed).toBe(false)
        }, 240000)

        test('S3A-13 (O-22) a seeded FAILED execution, or a RUNNING one of a dead lease: the PREVIEW answers `recovery_pending` (canApply false, no token, no bump, stamped with the recovery code) and the apply under its own live lease is 409 RECOVERY_PENDING from the same rows, nothing written, no new execution; the derived state under a live lease reads `executing`', async () => {
          for (const variant of ['failed', 'running']) {
            const st = await s3aStack(`s13${variant[0]}`, { pilot: true })
            const first = await st.dryRun()
            expect(first.body.data.status).toBe('ready')
            const gen = await st.generation()
            const begun = await st.refresh.store.beginExecution({
              ...st.scope,
              lane: 'small_apply',
              guard: { leaseRunId: `run_s3a_dead_${variant}`, leaseId: `lease_s3a_dead_${variant}`, fencingEpoch: 1, generation: gen.generation, generationToken: gen.generationToken },
              tokenRevision: 'rev_s3a_dead',
              planDigest: 'a'.repeat(64),
              plannedCounts: { add: 1, update: 0, inactive: 0 },
              refreshBinding: { continuations: [], holdSetFingerprint: null },
              startedBy: 'u_s3a_dead',
            })
            if (variant === 'failed') await st.refresh.store.finishExecution({ ...st.scope, executionId: begun.id, status: 'failed', written: 1, attemptedWrites: 1, errorCodes: ['E_S3A'] })
            // Review round 1 item 4: the preview says so — the same rows the apply refuses on.
            const genBeforePreview = await st.generation()
            const tokensBeforePreview = await kvTokens()
            const preview = await st.dryRun()
            expect(preview.statusCode, JSON.stringify(preview.body)).toBe(200)
            expect({ status: preview.body.data.status, canApply: preview.body.data.canApply, token: preview.body.data.dryRunToken, recovery: preview.body.data.refreshRecovery })
              .toEqual({ status: 'recovery_pending', canApply: false, token: null, recovery: { pending: true, openExecutions: 1 } })
            expect(await st.generation()).toEqual(genBeforePreview)
            expect(await kvTokens()).toBe(tokensBeforePreview)
            const stamp = (await q('SELECT last_pull_outcome, last_pull_code FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [st.tenantId, st.projectNo])).rows[0]
            expect(stamp).toEqual({ last_pull_outcome: 'previewed', last_pull_code: 'STOCK_PREP_REFRESH_RECOVERY_PENDING' })
            const main0 = await st.main()
            const executions0 = await st.executions()
            const applied = await st.apply(st.users.puller, first.body.data.dryRunToken)
            expect(applied.statusCode, `${variant}: ${JSON.stringify(applied.body)}`).toBe(409)
            expect(errorOf(applied).code).toBe('STOCK_PREP_REFRESH_RECOVERY_PENDING')
            expect(await st.main()).toEqual(main0)
            expect(await st.executions()).toEqual(executions0)
            // Why the lane reads ROWS: under a live lease the derived state is `executing`, masking the earlier run.
            const lease = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: `run_s3a_13_probe_${variant}` })
            try {
              const consult = await st.refresh.governance.consult(st.scope)
              console.log(`[S3A-13] ${variant} derived under a live lease: ${derive(consult).status}`)
              expect(derive(consult).status).toBe('executing')
            } finally {
              await st.lock.createGuard(lease).release()
            }
          }
        }, 240000)

        test('S3A-11 (G1 / A11; review round 1 item 2) the step-4 tables ABSENT from the store binding (42P01 — the shape of a pre-102/103 database; the registry readable): the chunk route on a PAUSED job, the dry-run and the apply answer 503 STORE_FAILED continuation before any source read — nothing written, no token, no bump, the job STAYS paused, the lease released', async () => {
          const client = await poolManager.get().getInternalPool().connect()
          const schema = `s3a_nostep4_${TOKEN}`
          try {
            await client.query(`CREATE SCHEMA ${schema}`)
            // The registry stays readable on this binding (the consult's registry reads share the store's snapshot):
            // only the five step-4 tables are missing, as on a database without migrations 102 / 103.
            await client.query(`CREATE VIEW ${schema}.integration_stock_prep_project_target AS SELECT * FROM public.integration_stock_prep_project_target`)
            await client.query(`SET search_path TO ${schema}`)
            const st = await s3aStack('s11', { pilot: false, refresh: realRefreshServices(dbOn(client)) })
            const storage: any = st.pluginContext.storage
            const jobScope = { tenantId: st.tenantId, workspaceId: 'workspace-default' }
            const jobId = `s3a_11_${TOKEN}`
            const applyJobId = `s3a_11_apply_${TOKEN}`
            const records = st.multitable.records as any
            await largeBomJobs.createLargeBomBackgroundExpansionJob({
              storage, ...jobScope, action: st.action, parameters: { projectNo: st.projectNo }, principal: 's3a-11', createJobId: () => jobId,
              writeGenerationObserver: async () => writeObservationFromGeneration(await st.lock.observeGeneration(st.key)),
            })
            await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId: ACTION_ID, jobId, sourceAdapter: st.sourceAdapter })
            await largeBomJobs.planLargeBomBackgroundExpansionJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId,
              existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, st.target, st.projectNo),
              governanceVerdict: await realPlanVerdict(jobScope.tenantId, st.projectNo, st.target.sheetId),
              writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
            })
            await largeBomJobs.createLargeBomCheckpointApplyJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId, principal: 's3a-11', permission: 'write', createApplyJobId: () => applyJobId,
              writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await st.lock.bumpGeneration(st.key, { reason: 'large_approval', expect })),
            })
            // One chunk lands through the lib with a HEALTHY gate (its own production services): the job is paused.
            const scoped = await tableActions.createTargetScopedRecordsApi(records, st.target, { fieldIdTranslation: 'pre_mapped' })
            const first = await st.lock.withProjectWriteLease(st.key, { purpose: 'large_apply_chunk', runId: 's3a-11-first' }, (guard: any) =>
              largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId: ACTION_ID, applyJobId, recordsApi: scoped, projectWriteGuard: guard, maxDecisionsPerChunk: 1, refreshGovernanceGate: realChunkGate(st.tenantId, st.projectNo) }))
            expect(first.status).toBe('paused')
            const job0 = await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId })
            const main0 = await st.main()
            const gen0 = await st.generation()
            const tokens0 = await kvTokens()
            const reads0 = st.state.reads
            const lanes: Record<string, any> = {
              chunk: await st.chunk(jobId, applyJobId),
              dryRun: await st.dryRun(),
            }
            const genAfterPreview = await st.generation()
            lanes.apply = await st.apply(st.users.puller, await st.mintToken('rev_s3a_11'))
            const answers = Object.fromEntries(Object.entries(lanes).map(([lane, res]) => [lane, `${res.statusCode}:${errorOf(res).code}:${errorOf(res).details && errorOf(res).details.store}:${errorOf(res).details && errorOf(res).details.sqlState}`]))
            const job1 = await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId })
            const observed = {
              answers,
              jobStatus: job1.status,
              jobByteIdentical: sameJson(job1, job0),
              leaseReleased: (await q(`SELECT lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [st.key])).rows[0].lease_id === null,
              sourceReads: st.state.reads - reads0,
              mainUnchanged: sameJson(await st.main(), main0),
              noBumpByThePreview: sameJson(genAfterPreview, gen0),
              tokensLeft: (await kvTokens()) - tokens0,
            }
            console.log(`[S3A-11] ${JSON.stringify(observed)}`)
            const refused = '503:STOCK_PREP_REFRESH_STORE_FAILED:continuation:42P01'
            expect(observed).toEqual({
              answers: { chunk: refused, dryRun: refused, apply: refused },
              jobStatus: 'paused',
              jobByteIdentical: true,
              leaseReleased: true,
              sourceReads: 0,
              mainUnchanged: true,
              noBumpByThePreview: true,
              tokensLeft: 0,
            })
            await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`stock-preparation:large-bom:%:${st.tenantId}:%`]).catch(() => {})
          } finally {
            await client.query('RESET search_path').catch(() => {})
            await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
            client.release()
          }
        }, 240000)

        test('S3A-12 (H6 / E09; review round 1 item 1, lens B V50B-08) a REAL fault inside the reconcile transaction — a BEFORE INSERT trigger on the hold table raising 42501 for this tenant only: the preview and the apply answer 503 STORE_FAILED hold_open; every step-4 row byte-identical, no bump, no token, no execution, the main sheet untouched', async () => {
          const st = await s3aStack('s12', { pilot: true })
          await firstPullApplied(st)
          st.state.data = CF.secondPullSource()
          const fn = `s3a_hold_fault_${TOKEN}`
          await q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW.tenant_id = '${st.tenantId}' THEN RAISE EXCEPTION 's3a hold fault' USING ERRCODE = '42501'; END IF; RETURN NEW; END $fn$`)
          await q(`CREATE TRIGGER ${fn} BEFORE INSERT ON ${RT.hold} FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
          try {
            const four0 = await stepFour(st.tenantId)
            const gen0 = await st.generation()
            const tokens0 = await kvTokens()
            const main0 = await st.main()
            const execs0 = (await st.executions()).length
            const preview = await st.dryRun()
            const genAfterPreview = await st.generation()
            const apply = await st.apply(st.users.puller, await st.mintToken('rev_s3a_12'))
            const answer = (res: any) => `${res.statusCode}:${errorOf(res).code}:${errorOf(res).details && errorOf(res).details.operation}:${errorOf(res).details && errorOf(res).details.sqlState}`
            const observed = {
              preview: answer(preview),
              apply: answer(apply),
              stepFourUnchanged: (await stepFour(st.tenantId)) === four0,
              noBumpByThePreview: sameJson(genAfterPreview, gen0),
              tokensLeft: (await kvTokens()) - tokens0,
              mainUnchanged: sameJson(await st.main(), main0),
              newExecutions: (await st.executions()).length - execs0,
            }
            console.log(`[S3A-12] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              preview: '503:STOCK_PREP_REFRESH_STORE_FAILED:hold_open:42501',
              apply: '503:STOCK_PREP_REFRESH_STORE_FAILED:hold_open:42501',
              stepFourUnchanged: true,
              noBumpByThePreview: true,
              tokensLeft: 0,
              mainUnchanged: true,
              newExecutions: 0,
            })
          } finally {
            await q(`DROP TRIGGER IF EXISTS ${fn} ON ${RT.hold}`).catch(() => {})
            await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
          }
        }, 180000)

        test('S3A-17 (ST-1 / TD-23) a settling finish vs a concurrent preview reconcile on PostgreSQL, both orders, plus the non-settling leg: no 40P01, no stuck running row; while the finish waits it holds neither its execution row nor the bound continuation', async () => {
          const fixture = await refreshKit.candidateHoldFixture()
          const pid = async (client: PoolClient) => Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          const pidA = await pid(clientA)
          const pidB = await pid(clientB)
          const pidX = await pid(clientX)
          // A store on ONE known client whose statements can be frozen (the dbOn shape plus a hook before every
          // statement and before the COMMIT).
          function hookedDbOn(client: PoolClient, hook: (event: { sql: string; inTransaction: boolean }) => Promise<void> | void) {
            return createDb({
              database: {
                query: async (sql: string, params?: unknown[]) => { await hook({ sql, inTransaction: false }); return client.query(sql, params) },
                transaction: async <T>(callback: (trx: any) => Promise<T>): Promise<T> => {
                  await client.query('BEGIN')
                  try {
                    const result = await callback({
                      query: async (sql: string, params?: unknown[]) => { await hook({ sql, inTransaction: true }); return (await client.query(sql, params)).rows },
                      commit: async () => {},
                      rollback: async () => {},
                    })
                    await hook({ sql: 'COMMIT', inTransaction: true })
                    await client.query('COMMIT')
                    return result
                  } catch (error) {
                    await client.query('ROLLBACK').catch(() => {})
                    throw error
                  }
                },
              },
            })
          }
          const seedStore = continuationStoreLib.createStockPreparationContinuationStore({ db: hostLikeDb() })
          // One governed project: an ACTIVE continuation C (seeded confirm), an open hold H the reconcile keeps, and a
          // zero-write execution bound to [C] ready to settle.
          async function setup(label: string) {
            const scope = { tenantId: tenantFor(`s3a_17_${label}`), sheetId: sheetFor(`s3a_17_${label}`), projectNo: fixture.projectNo }
            const idOf = await seedOpenHolds(seedStore, scope, [fixture.hold])
            const confirmed = await seedStore.confirmContinuation(confirmInput(scope, idOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
            const C = confirmed.continuationId
            const H = contentHold(`k_s3a_17_${label}`)
            const dv = await decisionVersionOf(scope)
            const idOfH = await seedOpenHolds(seedStore, scope, [H], dv)
            const lockRow = (await q(`SELECT generation, generation_token FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sheetWriteScopeKey(scope.sheetId)])).rows[0]
            const execution = await seedStore.beginExecution({
              ...scope,
              lane: 'small_apply',
              guard: { leaseRunId: `run_s3a_17_${label}`, leaseId: `lease_s3a_17_${label}`, fencingEpoch: 1, generation: Number(lockRow.generation), generationToken: lockRow.generation_token },
              tokenRevision: 'rev_s3a_17',
              planDigest: 'b'.repeat(64),
              plannedCounts: { add: 0, update: 0, inactive: 0 },
              refreshBinding: { continuations: [{ id: C, revision: confirmed.revision || 1 }], holdSetFingerprint: null },
              startedBy: 'u_s3a_17',
            })
            const settlement = { executionId: execution.id, generationToken: lockRow.generation_token, sourceContentDigest: 'src_s3a_17', sheetMachineDigest: 'machine_s3a_17' }
            return {
              scope, C, hId: idOfH(H), executionId: execution.id,
              reconcileInput: { ...scope, decisionVersionObserved: await decisionVersionOf(scope), holds: [H], verdicts: { [C]: 'valid' }, computation: computation({ suspended: true }) },
              finishInput: (settle: boolean) => ({ ...scope, executionId: execution.id, status: 'succeeded', written: 0, attemptedWrites: 0, counts: { add: 0, update: 0, inactive: 0, failed: 0 }, ...(settle ? { settlement } : {}) }),
            }
          }
          const lockable = async (table: string, id: string) => {
            const probe = await poolManager.get().getInternalPool().connect()
            try {
              await probe.query('BEGIN')
              await probe.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id])
              return true
            } catch (error: any) {
              return `refused ${error && error.code}`
            } finally {
              await probe.query('ROLLBACK').catch(() => {})
              probe.release()
            }
          }
          const outcomeOf = (result: any) => (result.ok ? 'ok' : `${result.error && result.error.code}:${result.error && result.error.details && result.error.details.sqlState}`)
          const after = async (s: any) => {
            const execution = (await q(`SELECT status FROM ${RT.execution} WHERE id = $1`, [s.executionId])).rows[0]
            const continuation = (await q(`SELECT executed_execution_id, last_verdict FROM ${RT.continuation} WHERE id = $1`, [s.C])).rows[0]
            return { execution: execution.status, executed: continuation.executed_execution_id === s.executionId, lastVerdict: continuation.last_verdict }
          }
          const observed: Record<string, unknown> = {}
          // Leg 1 (R holds the state row first): X blocks R at the hold R keeps; the finish F queues behind R AT THE
          // STATE ROW, holding neither its execution row nor C.
          {
            const s = await setup('leg1')
            await clientX.query('BEGIN')
            await clientX.query(`SELECT id FROM ${RT.hold} WHERE id = $1 FOR UPDATE`, [s.hId])
            const R = settle(storeOn(clientA).reconcileHolds(s.reconcileInput))
            await waitUntil('S3A-17 leg 1: R blocked by X', () => isBlockedBy(pidA, pidX))
            const F = settle(storeOn(clientB).finishExecution(s.finishInput(true)))
            const fQueued = await settle(waitUntil('S3A-17 leg 1: F blocked by R', () => isBlockedBy(pidB, pidA), 5000))
            const heldByF = { execution: await lockable(RT.execution, s.executionId), continuation: await lockable(RT.continuation, s.C) }
            await clientX.query('COMMIT')
            const [r, f] = [await R, await F]
            observed.leg1 = { fQueuedBehindR: fQueued.ok, r: outcomeOf(r), f: outcomeOf(f), settled: f.ok ? (f as any).value.settled : null, freeWhileWaiting: heldByF, ...(await after(s)) }
          }
          // Leg 2 (F first): F frozen right after its state lock, at its execution FOR UPDATE; R queues behind F.
          {
            const s = await setup('leg2')
            const frozen = gate()
            const reached = gate()
            const storeF = continuationStoreLib.createStockPreparationContinuationStore({
              db: hookedDbOn(clientB, async ({ sql, inTransaction }) => {
                if (inTransaction && /refresh_execution/.test(sql) && /FOR UPDATE/i.test(sql)) { reached.open(); await frozen.promise }
              }),
            })
            const F = settle(storeF.finishExecution(s.finishInput(true)))
            await reached.promise
            const R = settle(storeOn(clientA).reconcileHolds(s.reconcileInput))
            const queued = await settle(waitUntil('S3A-17 leg 2: R blocked by F', () => isBlockedBy(pidA, pidB), 5000))
            frozen.open()
            const [f, r] = [await F, await R]
            observed.leg2 = { rQueuedBehindF: queued.ok, r: outcomeOf(r), f: outcomeOf(f), settled: f.ok ? (f as any).value.settled : null, ...(await after(s)) }
          }
          // Leg 3 (a non-settling finish: no state lock): F takes its execution row and C and is frozen at COMMIT; R
          // waits on C until F commits.
          {
            const s = await setup('leg3')
            const frozen = gate()
            const reached = gate()
            const storeF = continuationStoreLib.createStockPreparationContinuationStore({
              db: hookedDbOn(clientB, async ({ sql, inTransaction }) => {
                if (inTransaction && sql === 'COMMIT') { reached.open(); await frozen.promise }
              }),
            })
            const F = settle(storeF.finishExecution(s.finishInput(false)))
            await reached.promise
            const R = settle(storeOn(clientA).reconcileHolds(s.reconcileInput))
            const waited = await settle(waitUntil('S3A-17 leg 3: R blocked by F', () => isBlockedBy(pidA, pidB), 5000))
            frozen.open()
            const [f, r] = [await F, await R]
            observed.leg3 = { rWaitedOnC: waited.ok, r: outcomeOf(r), f: outcomeOf(f), settled: f.ok ? (f as any).value.settled : null, ...(await after(s)) }
          }
          console.log(`[S3A-17] ${JSON.stringify(observed)}`)
          expect(observed).toEqual({
            leg1: { fQueuedBehindR: true, r: 'ok', f: 'ok', settled: true, freeWhileWaiting: { execution: true, continuation: true }, execution: 'succeeded', executed: true, lastVerdict: 'valid' },
            leg2: { rQueuedBehindF: true, r: 'ok', f: 'ok', settled: true, execution: 'succeeded', executed: true, lastVerdict: 'valid' },
            leg3: { rWaitedOnC: true, r: 'ok', f: 'ok', settled: false, execution: 'succeeded', executed: true, lastVerdict: 'valid' },
          })
        }, 120000)

        test('S3A-18 (L5) a paused large job (one row written) on a project made governed by a store-seeded hold (no bump): the chunk ROUTE refuses 409 LARGE_LANE_REFUSED `hold` inside its lease; the job byte-identical; 0 writes', async () => {
          const st = await s3aStack('s18', { pilot: false })
          const storage: any = st.pluginContext.storage
          const jobScope = { tenantId: st.tenantId, workspaceId: 'workspace-default' }
          const jobId = `s3a_18_${TOKEN}`
          const applyJobId = `s3a_18_apply_${TOKEN}`
          const records = st.multitable.records as any
          await largeBomJobs.createLargeBomBackgroundExpansionJob({
            storage, ...jobScope, action: st.action, parameters: { projectNo: st.projectNo }, principal: 's3a-18', createJobId: () => jobId,
            writeGenerationObserver: async () => writeObservationFromGeneration(await st.lock.observeGeneration(st.key)),
          })
          await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId: ACTION_ID, jobId, sourceAdapter: st.sourceAdapter })
          await largeBomJobs.planLargeBomBackgroundExpansionJob({
            storage, ...jobScope, actionId: ACTION_ID, jobId,
            existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, st.target, st.projectNo),
            governanceVerdict: await realPlanVerdict(jobScope.tenantId, st.projectNo, st.target.sheetId),
            writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
          })
          const approved = await largeBomJobs.createLargeBomCheckpointApplyJob({
            storage, ...jobScope, actionId: ACTION_ID, jobId, principal: 's3a-18', permission: 'write', createApplyJobId: () => applyJobId,
            writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await st.lock.bumpGeneration(st.key, { reason: 'large_approval', expect })),
          })
          expect(approved.totalDecisions).toBeGreaterThanOrEqual(2)
          const scoped = await tableActions.createTargetScopedRecordsApi(records, st.target, { fieldIdTranslation: 'pre_mapped' })
          const first = await st.lock.withProjectWriteLease(st.key, { purpose: 'large_apply_chunk', runId: 's3a-18-first' }, (guard: any) =>
            largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId: ACTION_ID, applyJobId, recordsApi: scoped, projectWriteGuard: guard, maxDecisionsPerChunk: 1, refreshGovernanceGate: realChunkGate(st.tenantId, st.projectNo, st.refresh) }))
          expect(first.status).toBe('paused')
          expect((await st.main()).count).toBe(1)
          // The project becomes governed by a store-seeded hold — no generation bump.
          const gen0 = await st.generation()
          await seedOpenHolds(st.refresh.store, st.scope, [contentHold('k_s3a_18')])
          expect(await st.generation()).toEqual(gen0)
          const job0 = await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId })
          const main0 = await st.main()
          const res = await st.chunk(jobId, applyJobId)
          console.log(`[S3A-18] chunk route ${res.statusCode} ${errorOf(res).code} ${JSON.stringify(errorOf(res).details)}`)
          expect(res.statusCode, JSON.stringify(res.body)).toBe(409)
          expect(errorOf(res).code).toBe('STOCK_PREP_REFRESH_LARGE_LANE_REFUSED')
          expect(errorOf(res).details).toMatchObject({ reason: 'hold', lane: 'large_apply_chunk', partial: false })
          expect(await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId })).toEqual(job0)
          expect(await st.main()).toEqual(main0)
          expect((await q(`SELECT lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [st.key])).rows[0].lease_id).toBeNull()
          await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`stock-preparation:large-bom:%:${st.tenantId}:%`]).catch(() => {})
        }, 180000)

        test('S3A-19 (G4) a registered NOT-governed project through dry-run, apply, re-preview and reconcile on the real stack: 0 step-4 rows; the next consult answers governed: false', async () => {
          const st = await s3aStack('s19', { pilot: false })
          const dry = await st.dryRun()
          expect(dry.body.data.status).toBe('ready')
          const applied = await st.apply(st.users.puller, dry.body.data.dryRunToken)
          expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
          expect(applied.body.data.status).toBe('succeeded')
          const again = await st.dryRun()
          expect(again.statusCode).toBe(200)
          const reconciled = await st.reconcile()
          console.log(`[S3A-19] re-preview ${again.body.data && again.body.data.status}; reconcile ${reconciled.statusCode} ${errorOf(reconciled).code || ''}`)
          expect(await st.stepFourRows()).toBe(0)
          expect((await st.refresh.governance.consult(st.scope)).governed).toBe(false)
        }, 180000)

        test('S3A-22 (R-7) the carry on a governed project: an ordinary open hold => carried (only the human cell of the target moves); a runbook-only hold => 409 runbook_only_hold; a failed execution => 409 RECOVERY_PENDING; the step-4 store unreadable => 503 — none of the refusals patch', async () => {
          const observed: Record<string, unknown> = {}
          // Ordinary open hold (a pilot second pull suspended by its candidate): the carry goes through.
          {
            const st = await s3aStack('s22o', { pilot: true })
            await firstPullApplied(st)
            st.state.data = CF.secondPullSource()
            expect((await st.dryRun()).body.data.status).toBe('suspended')
            const pair = await seedCarryPair({ multitable: st.multitable, sheetId: st.sheetId, target: st.target }, st.projectNo)
            const rows0 = await st.rows()
            const res = await st.carry(carryDecision(st.projectNo))
            const rows1 = await st.rows()
            const changed = rows1.filter((row: any) => !sameJson(row, rows0.find((entry: any) => entry.id === row.id))).map((row: any) => row.id)
            const target0 = rows0.find((row: any) => row.id === pair.targetId)
            const target1 = rows1.find((row: any) => row.id === pair.targetId)
            const notesField = pair.physical('notes')
            const { [notesField]: _n0, ...machine0 } = target0.data
            const { [notesField]: _n1, ...machine1 } = target1.data
            observed.ordinary = { status: res.statusCode, mode: res.body.data && res.body.data.mode, changed: changed.length === 1 && changed[0] === pair.targetId, notes: (await pair.readTarget()).notes, machineUnchanged: sameJson(machine0, machine1) }
          }
          // A runbook-only hold: confirm -> reconcile a reconfirm hold WITH its verdict -> escalate (R-6's recipe).
          {
            const st = await s3aStack('s22r', { pilot: true })
            await firstPullApplied(st)
            st.state.data = CF.secondPullSource()
            expect((await st.dryRun()).body.data.status).toBe('suspended')
            const confirmed = await confirmOpenCandidate(st)
            const reconfirm = refreshKit.reconfirmHoldFor(confirmed.continuationId)
            await seedOpenHolds(st.refresh.store, st.scope, [reconfirm], await decisionVersionOf(st.scope), { [confirmed.continuationId]: 'source_scope_changed' })
            await st.refresh.store.endContinuation({ ...st.scope, continuationId: confirmed.continuationId, revision: 1, outcome: 'escalate_special_repair', endedBy: st.users.admin.id }, { bumpWithin: testBumpWithin })
            const pair = await seedCarryPair({ multitable: st.multitable, sheetId: st.sheetId, target: st.target }, st.projectNo)
            const res = await st.carry(carryDecision(st.projectNo))
            observed.runbook = { status: res.statusCode, code: errorOf(res).code, reason: errorOf(res).details && errorOf(res).details.reason, notes: (await pair.readTarget()).notes, runbookRows: (await st.holds()).filter((row: any) => row.status === 'open' && row.runbook_only).length }
          }
          // A failed execution (O-22 for the carry lane).
          {
            const st = await s3aStack('s22f', { pilot: true })
            const gen = await st.generation()
            const begun = await st.refresh.store.beginExecution({
              ...st.scope, lane: 'small_apply',
              guard: { leaseRunId: 'run_s3a_22_dead', leaseId: 'lease_s3a_22_dead', fencingEpoch: 1, generation: gen.generation, generationToken: gen.generationToken || 'tok_s3a_22' },
              tokenRevision: 'rev_s3a_22', planDigest: 'c'.repeat(64), plannedCounts: { add: 1, update: 0, inactive: 0 }, refreshBinding: { continuations: [], holdSetFingerprint: null }, startedBy: 'u_s3a_22',
            })
            await st.refresh.store.finishExecution({ ...st.scope, executionId: begun.id, status: 'failed', written: 0, attemptedWrites: 1, errorCodes: ['E_S3A_22'] })
            const pair = await seedCarryPair({ multitable: st.multitable, sheetId: st.sheetId, target: st.target }, st.projectNo)
            const res = await st.carry(carryDecision(st.projectNo))
            observed.recovery = { status: res.statusCode, code: errorOf(res).code, notes: (await pair.readTarget()).notes }
          }
          // The step-4 store unreadable (its tables absent on the search path of its binding): 503, nothing patched.
          {
            const client = await poolManager.get().getInternalPool().connect()
            const schema = `s3a_empty_${TOKEN}`
            try {
              await client.query(`CREATE SCHEMA ${schema}`)
              // Only the step-4 store's binding loses its tables; the registry and the lock (host-shaped bindings) stay readable.
              await client.query(`SET search_path TO ${schema}`)
              const broken = realRefreshServices(dbOn(client))
              const st = await s3aStack('s22u', { pilot: true, refresh: broken })
              const pair = await seedCarryPair({ multitable: st.multitable, sheetId: st.sheetId, target: st.target }, st.projectNo)
              const res = await st.carry(carryDecision(st.projectNo))
              observed.unreadable = { status: res.statusCode, code: errorOf(res).code, notes: (await pair.readTarget()).notes }
            } finally {
              await client.query('RESET search_path').catch(() => {})
              await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
              client.release()
            }
          }
          console.log(`[S3A-22] ${JSON.stringify(observed)}`)
          expect(observed).toEqual({
            ordinary: { status: 200, mode: 'carried', changed: true, notes: 'synthetic note', machineUnchanged: true },
            runbook: { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED', reason: 'runbook_only_hold', notes: null, runbookRows: 1 },
            recovery: { status: 409, code: 'STOCK_PREP_REFRESH_RECOVERY_PENDING', notes: null },
            unreadable: { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED', notes: null },
          })
        }, 300000)

        test('S3A-23 (V1) a sentinel planted in a persisted hold\'s detail never leaves the hold table: the suspended responses (sync and background), every plugin_kv value written meanwhile (tokens, the job record), the registry row and every meta_records value are free of it and of the private keys', async () => {
          const st = await s3aStack('s23', { pilot: true })
          const SENTINEL = `S3A-SENTINEL-${TOKEN}`
          const startedAt = (await q('SELECT now() AS at')).rows[0].at
          await seedOpenHolds(st.refresh.store, st.scope, [contentHold('k_s3a_23', { key: SENTINEL, fields: { material: { before: SENTINEL, after: `${SENTINEL}-2` } } })])
          await st.pilotExit()
          const sync = await st.dryRun()
          expect(sync.body.data.status).toBe('suspended')
          const job = await st.dryRunJob()
          expect(job.statusCode, JSON.stringify(job.body)).toBe(202)
          await waitUntil('S3A-23: the background dry-run finished', async () => Number((await q(`SELECT count(*)::int AS n FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE 'stock-preparation:dry-run-job:%' AND updated_at >= $1 AND value->>'status' <> 'running'`, [startedAt])).rows[0].n) > 0, 30000)
          const PRIVATE = ['"holds":[', '"refresh":', '"handle":', '"planningInputs":', '"persistedHolds":', '"consult":', '"members":']
          const leaks = (text: string) => [SENTINEL, ...PRIVATE].filter((needle) => text.includes(needle))
          const kv = (await q(`SELECT key, value::text AS text FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND updated_at >= $1`, [startedAt])).rows
          const observed = {
            syncResponse: leaks(JSON.stringify(sync.body)),
            jobResponse: leaks(JSON.stringify(job.body)),
            kvRowsWritten: kv.length > 0,
            kv: kv.flatMap((row: any) => leaks(row.text)),
            registry: leaks(JSON.stringify((await q('SELECT * FROM integration_stock_prep_project_target WHERE tenant_id = $1', [st.tenantId])).rows)),
            metaRecords: Number((await q('SELECT count(*)::int AS n FROM meta_records WHERE data::text LIKE $1', [`%${SENTINEL}%`])).rows[0].n),
            holdTableCarriesIt: Number((await q(`SELECT count(*)::int AS n FROM ${RT.hold} WHERE detail::text LIKE $1`, [`%${SENTINEL}%`])).rows[0].n) > 0,
          }
          console.log(`[S3A-23] ${JSON.stringify(observed)}`)
          expect(observed).toEqual({ syncResponse: [], jobResponse: [], kvRowsWritten: true, kv: [], registry: [], metaRecords: 0, holdTableCarriesIt: true })
        }, 180000)

        test('S3A-27 (R-13) step-4 rows on sheet A, the registry re-pointed to sheet B, switch ON: dry-run, reconcile, mvp-persist, carry, apply and the chunk route all 409 RETARGETED `sheet`; 0 source reads; no store write; no bump of B', async () => {
          const st = await s3aStack('s27', { pilot: false })
          const sheetA = sheetFor('s3a_27_previous')
          await seedOpenHolds(st.refresh.store, { ...st.scope, sheetId: sheetA }, [contentHold('k_s3a_27')])
          const fingerprintA = await sheetFingerprint(sheetA)
          const rows0 = await st.stepFourRows()
          const gen0 = await st.generation()
          // A large job approved on B before anything consults (the chunk is the lane under test).
          const storage: any = st.pluginContext.storage
          const jobScope = { tenantId: st.tenantId, workspaceId: 'workspace-default' }
          const jobId = `s3a_27_${TOKEN}`
          const applyJobId = `s3a_27_apply_${TOKEN}`
          await largeBomJobs.createLargeBomBackgroundExpansionJob({
            storage, ...jobScope, action: st.action, parameters: { projectNo: st.projectNo }, principal: 's3a-27', createJobId: () => jobId,
            writeGenerationObserver: async () => writeObservationFromGeneration(await st.lock.observeGeneration(st.key)),
          })
          await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId: ACTION_ID, jobId, sourceAdapter: st.sourceAdapter })
          await largeBomJobs.planLargeBomBackgroundExpansionJob({
            storage, ...jobScope, actionId: ACTION_ID, jobId,
            existingRows: await tableActions.__internals.readExistingStockPreparationRows(st.multitable.records, st.target, st.projectNo),
            // PR-3b: the plan ROUTE would refuse this project (RETARGETED — its rows live on A), so a REAL consult cannot
            // hand this plan a verdict: the job stands for one that reached approval past every route (a direct lib
            // caller), with an ASSERTED not-governed verdict — the chunk's in-lease gate is the lane under test.
            governanceVerdict: { consulted: true, verdict: 'not_governed', generationToken: (await st.generation()).generationToken },
            writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
          })
          await largeBomJobs.createLargeBomCheckpointApplyJob({
            storage, ...jobScope, actionId: ACTION_ID, jobId, principal: 's3a-27', permission: 'write', createApplyJobId: () => applyJobId,
            writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await st.lock.bumpGeneration(st.key, { reason: 'large_approval', expect })),
          })
          const genApproved = await st.generation()
          const reads0 = st.state.reads
          const pair = await seedCarryPair({ multitable: st.multitable, sheetId: st.sheetId, target: st.target }, st.projectNo)
          const main0 = await st.main()
          const lanes: Record<string, any> = {
            dryRun: await st.dryRun(),
            reconcile: await st.reconcile(),
            mvpPersist: await st.mvpPersist(),
            carry: await st.carry(carryDecision(st.projectNo)),
            apply: await st.apply(st.users.puller, await st.mintToken('rev_s3a_27_forged')),
            chunk: await st.chunk(jobId, applyJobId),
          }
          const answers = Object.fromEntries(Object.entries(lanes).map(([lane, res]) => [lane, `${res.statusCode}:${errorOf(res).code}:${errorOf(res).details && errorOf(res).details.reason}`]))
          const observed = {
            answers,
            sourceReads: st.state.reads - reads0,
            mainUnchanged: sameJson(await st.main(), main0),
            carryTargetUntouched: (await pair.readTarget()).notes === null,
            sheetAUnchanged: (await sheetFingerprint(sheetA)) === fingerprintA,
            stepFourRows: (await st.stepFourRows()) - rows0,
            noBumpOfB: sameJson(await st.generation(), genApproved),
          }
          console.log(`[S3A-27] ${JSON.stringify(observed)}`)
          const refused = `409:${RETARGETED}:sheet`
          expect(gen0.generation).toBeLessThan(genApproved.generation)
          expect(observed).toEqual({
            answers: { dryRun: refused, reconcile: refused, mvpPersist: refused, carry: refused, apply: refused, chunk: refused },
            sourceReads: 0,
            mainUnchanged: true,
            carryTargetUntouched: true,
            sheetAUnchanged: true,
            stepFourRows: 0,
            noBumpOfB: true,
          })
          await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`stock-preparation:large-bom:%:${st.tenantId}:%`]).catch(() => {})
        }, 240000)

        test('S3A-28 (review round 1 item 3, lens B V50B-16) a carry whose key is DUPLICATE-RESOLVED: a NOT-governed project (switch off, unregistered, env sheet) carries as before this PR; a GOVERNED project consults THAT project — an earlier failed execution of it refuses 409 RECOVERY_PENDING, nothing patched', async () => {
          const suffixed = (key: string) => `${key}::duplicate:sortLine:${"7".repeat(16)}`
          const seedSuffixedPair = async (sb: any, projectNo: string) => {
            const physical = (logical: string) => (sb.target.fieldIdMap && sb.target.fieldIdMap[logical]) || logical
            const toPhysical = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([key, value]) => [physical(key), value]))
            const { oldKey, newKey: plainNewKey } = carryKeys(projectNo)
            const newKey = suffixed(plainNewKey)
            const records = sb.multitable.records as any
            await records.createRecord({ sheetId: sb.sheetId, data: toPhysical({ projectNo, idempotencyKey: oldKey, componentSourceId: CARRY_COMPONENT, path: JSON.stringify(['OLD', CARRY_COMPONENT]), active: false, notes: 'synthetic note' }) })
            const target = await records.createRecord({ sheetId: sb.sheetId, data: toPhysical({ projectNo, idempotencyKey: newKey, componentSourceId: CARRY_COMPONENT, path: JSON.stringify(['NEW', CARRY_COMPONENT]), active: true }) })
            const notes = async () => (await q('SELECT data->>$2 AS notes FROM meta_records WHERE id = $1', [target.id, physical('notes')])).rows[0].notes
            return { decision: { ...carryDecision(projectNo), idempotencyKey: newKey }, notes }
          }
          const observed: Record<string, unknown> = {}
          {
            const st = await s3aStack('s28n', { pilot: false, register: false, switchOn: false })
            const pair = await seedSuffixedPair({ multitable: st.multitable, sheetId: st.envTarget.sheetId, target: st.envTarget }, st.projectNo)
            const res = await st.carry(pair.decision)
            observed.notGoverned = { status: res.statusCode, mode: res.body.data && res.body.data.mode, code: errorOf(res).code || null, notes: await pair.notes(), stepFourRows: await st.stepFourRows() }
          }
          {
            const st = await s3aStack('s28g', { pilot: true })
            const gen = await st.generation()
            const begun = await st.refresh.store.beginExecution({
              ...st.scope, lane: 'small_apply',
              guard: { leaseRunId: 'run_s3a_28_dead', leaseId: 'lease_s3a_28_dead', fencingEpoch: 1, generation: gen.generation, generationToken: gen.generationToken || 'tok_s3a_28' },
              tokenRevision: 'rev_s3a_28', planDigest: 'd'.repeat(64), plannedCounts: { add: 1, update: 0, inactive: 0 }, refreshBinding: { continuations: [], holdSetFingerprint: null }, startedBy: 'u_s3a_28',
            })
            await st.refresh.store.finishExecution({ ...st.scope, executionId: begun.id, status: 'failed', written: 0, attemptedWrites: 1, errorCodes: ['E_S3A_28'] })
            const pair = await seedSuffixedPair({ multitable: st.multitable, sheetId: st.sheetId, target: st.target }, st.projectNo)
            const res = await st.carry(pair.decision)
            observed.governed = { status: res.statusCode, code: errorOf(res).code, notes: await pair.notes() }
          }
          console.log(`[S3A-28] ${JSON.stringify(observed)}`)
          expect(observed).toEqual({
            notGoverned: { status: 200, mode: 'carried', code: null, notes: 'synthetic note', stepFourRows: 0 },
            governed: { status: 409, code: 'STOCK_PREP_REFRESH_RECOVERY_PENDING', notes: null },
          })
        }, 180000)

        test('S3A-29 (PR-3a follow-up; the executor half of V50B-16) switch off, the shared env sheet: a project GOVERNED by an earlier failed execution whose pair carries a duplicate-resolved TARGET key EMBEDDING another, not-governed project — the route consults that other project (no refusal) and the executor\'s key-vs-rows check on the BASE key refuses 409 CONFIRM_CARRY_PROJECT_MISMATCH, nothing written; the honest key is refused 409 RECOVERY_PENDING', async () => {
          const st = await s3aStack('s29', { pilot: false, register: false, switchOn: false })
          const env = st.envTarget
          const other = 'PRJ-S3A-29-OTHER'
          const envScope = { tenantId: st.tenantId, sheetId: env.sheetId, projectNo: st.projectNo }
          const gen = await st.generation(sheetWriteScopeKey(env.sheetId))
          const begun = await st.refresh.store.beginExecution({
            ...envScope, lane: 'small_apply',
            guard: { leaseRunId: 'run_s3a_29_dead', leaseId: 'lease_s3a_29_dead', fencingEpoch: 1, generation: gen.generation, generationToken: gen.generationToken || 'tok_s3a_29' },
            tokenRevision: 'rev_s3a_29', planDigest: 'd'.repeat(64), plannedCounts: { add: 1, update: 0, inactive: 0 }, refreshBinding: { continuations: [], holdSetFingerprint: null }, startedBy: 'u_s3a_29',
          })
          await st.refresh.store.finishExecution({ ...envScope, executionId: begun.id, status: 'failed', written: 0, attemptedWrites: 1, errorCodes: ['E_S3A_29'] })
          const physical = (logical: string) => (env.fieldIdMap && env.fieldIdMap[logical]) || logical
          const toPhysical = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([key, value]) => [physical(key), value]))
          const keyOf = (projectNo: string, tag: string) => JSON.stringify({ projectNo, componentSourceId: CARRY_COMPONENT, parentSourceId: null, path: [tag, CARRY_COMPONENT] })
          const suffixed = (key: string) => `${key}::duplicate:sortLine:${'7'.repeat(16)}`
          const records = st.multitable.records as any
          // A pair on the env sheet whose rows both belong to THIS project (machine projectNo), the source row's key
          // honest; only the target key varies.
          const seedPair = async (tag: string, newKey: string) => {
            const oldKey = keyOf(st.projectNo, `OLD${tag}`)
            await records.createRecord({ sheetId: env.sheetId, data: toPhysical({ projectNo: st.projectNo, idempotencyKey: oldKey, componentSourceId: CARRY_COMPONENT, path: JSON.stringify([`OLD${tag}`, CARRY_COMPONENT]), active: false, notes: 'synthetic note' }) })
            const target = await records.createRecord({ sheetId: env.sheetId, data: toPhysical({ projectNo: st.projectNo, idempotencyKey: newKey, componentSourceId: CARRY_COMPONENT, path: JSON.stringify([`NEW${tag}`, CARRY_COMPONENT]), active: true }) })
            const notes = async () => (await q('SELECT data->>$2 AS notes FROM meta_records WHERE id = $1', [target.id, physical('notes')])).rows[0].notes
            return { decision: { ...carryDecision(st.projectNo), idempotencyKey: newKey, sourceIdempotencyKey: oldKey }, notes }
          }
          const forged = await seedPair('F', suffixed(keyOf(other, 'NEWF')))
          const honest = await seedPair('H', suffixed(keyOf(st.projectNo, 'NEWH')))
          const main0 = await st.main(env.sheetId)
          const forgedRes = await st.carry(forged.decision)
          const honestRes = await st.carry(honest.decision)
          const observed = {
            governed: {
              project: (await st.refresh.governance.consult(envScope)).governed,
              other: (await st.refresh.governance.consult({ ...envScope, projectNo: other })).governed,
            },
            forged: `${forgedRes.statusCode}:${errorOf(forgedRes).code}:${errorOf(forgedRes).details && errorOf(forgedRes).details.field}`,
            honest: `${honestRes.statusCode}:${errorOf(honestRes).code}`,
            notes: [await forged.notes(), await honest.notes()],
            envSheetUnchanged: sameJson(await st.main(env.sheetId), main0),
          }
          console.log(`[S3A-29] ${JSON.stringify(observed)}`)
          expect(observed).toEqual({
            governed: { project: true, other: false },
            forged: '409:CONFIRM_CARRY_PROJECT_MISMATCH:idempotencyKey',
            honest: '409:STOCK_PREP_REFRESH_RECOVERY_PENDING',
            notes: [null, null],
            envSheetUnchanged: true,
          })
        }, 180000)

        test('S3A-30 (PR-3a follow-up) the consult reads the executions in its snapshot and the lock AFTER it: an execution RUNNING under a live lease at the preview\'s snapshot that FINISHES cleanly and releases before the preview\'s lock read — the preview re-consults once and answers 409 STATE_MOVED execution_finished_during_preview, never recovery_pending: no token, no bump, no recovery stamp; the next preview is ready', async () => {
          // The real reader over the real store and lock, with two holds: before the snapshot, and at the lock read.
          const store = continuationStoreLib.createStockPreparationContinuationStore({ db: hostLikeDb() })
          const realLock = createStockPreparationProjectWriteLock({ db: hostLikeDb() })
          const rowsGate = { armed: false, reached: gate(), release: gate() }
          const lockGate = { armed: false, reached: gate(), release: gate() }
          const gatedStore = {
            ...store,
            readGovernanceRows: async (input: any, options: any) => {
              if (rowsGate.armed) { rowsGate.armed = false; rowsGate.reached.open(); await rowsGate.release.promise }
              return store.readGovernanceRows(input, options)
            },
          }
          const heldLock = {
            ...realLock,
            readState: async (scopeKey: string) => {
              if (lockGate.armed) { lockGate.armed = false; lockGate.reached.open(); await lockGate.release.promise }
              return realLock.readState(scopeKey)
            },
          }
          const governance = refreshGovernanceLib.createStockPreparationRefreshGovernance({
            continuationStore: gatedStore,
            projectTargetStore: projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: hostLikeDb() }),
            projectWriteLock: heldLock,
          })
          const st = await s3aStack('s30', { pilot: true, refresh: { governance, store } })
          await firstPullApplied(st)
          const gen0 = await st.generation()
          const tokens0 = await kvTokens()
          // 1. The preview passes its precheck (no lease yet) and stops before its consult's snapshot.
          rowsGate.armed = true
          const previewing = st.dryRun()
          await rowsGate.reached.promise
          // 2. A run takes the lease and begins its execution: `running` under the live lease.
          const runId = `s3a-30-${TOKEN}`
          const grant = await st.lock.acquire(st.key, { purpose: 'small_apply', runId, tenantId: st.tenantId })
          const gen = await st.generation()
          const begun = await store.beginExecution({
            ...st.scope, lane: 'small_apply',
            guard: { leaseRunId: runId, leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch, generation: gen.generation, generationToken: gen.generationToken },
            tokenRevision: 'rev_s3a_30', planDigest: 'e'.repeat(64), plannedCounts: { add: 0, update: 0, inactive: 0 }, refreshBinding: { continuations: [], holdSetFingerprint: null }, startedBy: 'u_s3a_30',
          })
          // 3. The snapshot is taken now (it holds the running row); the preview stops at its lock read.
          lockGate.armed = true
          rowsGate.release.open()
          await lockGate.reached.promise
          // 4. The run finishes cleanly and releases the lease.
          await store.finishExecution({ ...st.scope, executionId: begun.id, status: 'succeeded', written: 0, attemptedWrites: 0 })
          await st.lock.createGuard(grant).release()
          // 5. The lock read sees no live lease; the snapshot still holds the running row.
          lockGate.release.open()
          const straddled = await previewing
          const genAfter = await st.generation()
          const tokensAfter = await kvTokens()
          const stamp = (await q('SELECT last_pull_outcome, last_pull_code FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [st.tenantId, st.projectNo])).rows[0]
          const next = await st.dryRun()
          const observed = {
            straddled: `${straddled.statusCode}:${errorOf(straddled).code}:${errorOf(straddled).details && errorOf(straddled).details.reason}`,
            noBump: sameJson(genAfter, gen0),
            tokensLeft: tokensAfter - tokens0,
            recoveryStamp: Boolean(stamp && stamp.last_pull_code === 'STOCK_PREP_REFRESH_RECOVERY_PENDING'),
            executions: (await st.executions()).map((row: any) => row.status),
            next: `${next.statusCode}:${next.body && next.body.data && next.body.data.status}`,
          }
          console.log(`[S3A-30] ${JSON.stringify(observed)}`)
          expect(observed).toEqual({
            straddled: '409:STOCK_PREP_PULL_STATE_MOVED:execution_finished_during_preview',
            noBump: true,
            tokensLeft: 0,
            recoveryStamp: false,
            executions: ['succeeded', 'succeeded'],
            next: '200:ready',
          })
        }, 180000)
        // ── S3B: batch-refresh step 4 PR-3b — the LARGE lane on the real stack ────────────────────────────────────
        // Nested in S3A for its stack (`s3aStack`, now with the four large non-write routes), its fixtures and its
        // tenant-prefix cleanup. Each case drives the REAL route module over the production host, lock, registry, plugin
        // storage (plugin_kv) and the REAL refresh services.
        //   S3B-01 (P3-L1..L4, S6(4), D-7) a project governed by a store-seeded CONFIRMED relationship (not pilot): start,
        //          run, plan and approve 409 LARGE_LANE_REFUSED `continuation` — zero source reads, zero records reads,
        //          no large-BOM plugin_kv row written or changed, the generation unchanged, the sheet unchanged.
        //   S3B-02 (P3-L7 / L05 / C09 large, P3-B1) not governed: the plan records the verdict (read back from
        //          plugin_kv), approval and chunk run as before; an expansion planned WITHOUT a verdict is refused at
        //          approval 409 GOVERNANCE_UNCONSULTED (no apply job, no bump) and served once re-planned by the route.
        //   S3B-03 (P3-L6, O-1, E-3 large) a sentinel in a persisted hold's detail: the governed project's large routes
        //          write nothing; a DIRECT lib plan handed the governed projection as `continuation` stores no hold and no
        //          sentinel; a crafted stored plan carrying holds is refused at approval (PLAN_SUSPENDED), no apply job —
        //          every plugin_kv row written meanwhile is free of the sentinel and of a hold array.
        //   S3B-04 (C10 large, E-2(a)) pilot column cleared after a confirmed relationship: the four routes 409
        //          `continuation`; a job approved before the confirm is refused at its chunk (PLAN_SUPERSEDED — the binding
        //          answers first); a job slipped past the routes afterwards is refused by the chunk's in-lease gate.
        //   S3B-05 (U07 large, E-2(b), GV-1) switch off: rows on the project's own sheet while the action resolves the
        //          env sheet => 409 RETARGETED `sheet` on the four routes, nothing read or written; a pilot project =>
        //          PR B's code; a registered NOT-governed project => served end to end on the env sheet, 0 step-4 rows.
        //   S3B-06 (R-12, A11 / G1 large) the step-4 tables absent from the store binding (42P01): the four routes 503
        //          STORE_FAILED `continuation` before any source read or existing-row read; nothing written, no bump.
        describe('S3B step-4 large lane (real Postgres, real lock, real host)', () => {
          const LARGE_PREFIX = 'stock-preparation:large-bom:'
          // Every large-BOM plugin_kv row of one tenant, key order (the "nothing persisted" fingerprint of a refusal).
          const largeRows = async (tenantId: string) => (await q(
            `SELECT key, value::text AS text FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1 ORDER BY key`,
            [`${LARGE_PREFIX}%:${tenantId}:%`],
          )).rows
          const cleanupLarge = (tenantId: string) => q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`${LARGE_PREFIX}%:${tenantId}:%`]).catch(() => {})
          const answerOf = (res: any) => `${res.statusCode}:${errorOf(res).code || 'ok'}${errorOf(res).details && errorOf(res).details.reason ? `:${errorOf(res).details.reason}` : ''}${errorOf(res).details && errorOf(res).details.lane ? `:${errorOf(res).details.lane}` : ''}`
          const notGovernedVerdict = (generationToken: string | null) => ({ consulted: true, verdict: 'not_governed', generationToken })
          // Count the host records reads the ROUTES make (the plan's existing-row read and the foreign-row guard).
          function countRecordReads(records: any) {
            const original = records.queryRecords
            let n = 0
            records.queryRecords = async (...args: any[]) => { n += 1; return original.apply(records, args) }
            if (records.queryRecords === original) throw new Error('S3B: the host records API cannot be counted')
            return { count: () => n, restore: () => { records.queryRecords = original } }
          }
          async function startedJob(st: any) {
            const res = await st.largeStart()
            expect(res.statusCode, JSON.stringify(res.body)).toBe(202)
            return res.body.data.jobId as string
          }
          // Expansions at every stage, through the REAL routes while the project is NOT governed.
          async function largeStages(st: any) {
            const queued = await startedJob(st)
            const ran = await startedJob(st)
            expect((await st.largeRun(ran)).statusCode).toBe(200)
            const planned = await startedJob(st)
            expect((await st.largeRun(planned)).statusCode).toBe(200)
            const res = await st.largePlan(planned)
            expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
            return { queued, ran, planned }
          }
          const fourRoutes = (st: any, jobs: { queued: string; ran: string; planned: string }) => [
            ['start', () => st.largeStart()],
            ['run', () => st.largeRun(jobs.queued)],
            ['plan', () => st.largePlan(jobs.ran)],
            ['approve', () => st.largeApprove(jobs.planned)],
          ] as Array<[string, () => Promise<any>]>
          // A full expansion through the LIB (for a deployment whose routes refuse every large call), the way the routes
          // store it: observed, run, planned with the not-governed verdict, optionally approved through the binder.
          async function libExpansion(st: any, jobId: string, stage: 'queued' | 'ran' | 'planned' | 'approved') {
            const storage: any = st.pluginContext.storage
            const jobScope = { tenantId: st.tenantId, workspaceId: 'workspace-default' }
            await largeBomJobs.createLargeBomBackgroundExpansionJob({
              storage, ...jobScope, action: st.action, parameters: { projectNo: st.projectNo }, principal: st.users.admin.id, actor: st.users.admin.id, createJobId: () => jobId,
              writeGenerationObserver: async () => writeObservationFromGeneration(await st.lock.observeGeneration(st.key)),
            })
            if (stage === 'queued') return null
            await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId: ACTION_ID, jobId, sourceAdapter: st.sourceAdapter })
            if (stage === 'ran') return null
            await largeBomJobs.planLargeBomBackgroundExpansionJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId,
              existingRows: await tableActions.__internals.readExistingStockPreparationRows(st.multitable.records, st.target, st.projectNo),
              // The route-shaped verdict, ASSERTED rather than consulted: this helper stands for a caller that never asked.
              governanceVerdict: notGovernedVerdict((await st.generation()).generationToken),
              writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
            })
            if (stage === 'planned') return null
            return largeBomJobs.createLargeBomCheckpointApplyJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId, principal: st.users.admin.id, permission: 'write', acceptManualConfirmHold: true, createApplyJobId: () => `${jobId}_apply`,
              writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await st.lock.bumpGeneration(st.key, { reason: 'large_approval', expect })),
            })
          }
          // Governed by a store-seeded CONFIRMED relationship: the canonical candidate (same project number as the stack),
          // opened by a computation and confirmed by the store's own transaction with the bump stand-in.
          async function confirmSeededContinuation(st: any) {
            const fixture = await refreshKit.candidateHoldFixture()
            const holdIdOf = await seedOpenHolds(st.refresh.store, st.scope, [fixture.hold])
            return st.refresh.store.confirmContinuation(confirmInput(st.scope, holdIdOf(fixture.hold), fixture.hold, fixture), { bumpWithin: testBumpWithin })
          }

          test('S3B-01 (P3-L1..L4, S6(4), D-7) a project governed by a store-seeded CONFIRMED relationship (not pilot): start, run, plan and approve answer 409 LARGE_LANE_REFUSED `continuation` through the REAL routes — zero source reads, zero records reads, no large-BOM plugin_kv row written or changed, no apply job, the generation unchanged, the sheet\'s meta_records and meta_record_revisions unchanged, no step-4 write', async () => {
            const st = await s3aStack('b01', { pilot: false })
            const jobs = await largeStages(st)
            await confirmSeededContinuation(st)
            const consult = await st.refresh.governance.consult(st.scope)
            expect(consult.governed).toBe(true)
            expect(consult.pilot.enabled).toBe(false)
            const counter = countRecordReads(st.multitable.records)
            try {
              const kv0 = await largeRows(st.tenantId)
              const gen0 = await st.generation()
              const main0 = await st.main()
              const four0 = await stepFour(st.tenantId)
              const reads0 = st.state.reads
              const answers: Record<string, string> = {}
              for (const [route, run] of fourRoutes(st, jobs)) answers[route] = answerOf(await run())
              const kv1 = await largeRows(st.tenantId)
              const observed = {
                answers,
                sourceReads: st.state.reads - reads0,
                recordReads: counter.count(),
                kvUnchanged: sameJson(kv1, kv0),
                applyJobs: kv1.filter((row: any) => row.key.startsWith(`${LARGE_PREFIX}apply:`)).length,
                generationUnchanged: sameJson(await st.generation(), gen0),
                mainUnchanged: sameJson(await st.main(), main0),
                stepFourUnchanged: (await stepFour(st.tenantId)) === four0,
              }
              console.log(`[S3B-01] ${JSON.stringify(observed)}`)
              const refused = (lane: string) => `409:STOCK_PREP_REFRESH_LARGE_LANE_REFUSED:continuation:${lane}`
              expect(observed).toEqual({
                answers: { start: refused('large_expansion_start'), run: refused('large_expansion_run'), plan: refused('large_plan'), approve: refused('large_approve') },
                sourceReads: 0,
                recordReads: 0,
                kvUnchanged: true,
                applyJobs: 0,
                generationUnchanged: true,
                mainUnchanged: true,
                stepFourUnchanged: true,
              })
            } finally {
              counter.restore()
              await cleanupLarge(st.tenantId)
            }
          }, 240000)

          test('S3B-02 (P3-L7 / L05 / C09 large, P3-B1) a NOT-governed registered project through the REAL routes: the plan records the not-governed verdict (read back from plugin_kv: three keys, the consult\'s token); approval and chunk run as before; an expansion planned WITHOUT a verdict (a pre-PR-3b plan, through the lib) is refused at approval 409 GOVERNANCE_UNCONSULTED — no apply job, no bump — and is served once re-planned by the route; 0 step-4 rows', async () => {
            const st = await s3aStack('b02', { pilot: false })
            const kvKeyOf = (jobId: string) => `${LARGE_PREFIX}background:${st.tenantId}:workspace-default:${ACTION_ID}:${jobId}`
            const verdictOf = async (jobId: string) => ((await q(`SELECT value->'governanceVerdict' AS verdict FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1`, [kvKeyOf(jobId)])).rows[0] || {}).verdict
            try {
              const first = await startedJob(st)
              expect((await st.largeRun(first)).statusCode).toBe(200)
              expect((await st.largePlan(first)).statusCode).toBe(200)
              const firstVerdict = await verdictOf(first)
              const approved = await st.largeApprove(first)
              expect(approved.statusCode, JSON.stringify(approved.body)).toBe(202)
              const chunk = await st.chunk(first, approved.body.data.jobId)
              expect(chunk.statusCode, JSON.stringify(chunk.body)).toBe(200)
              const written = (await st.main()).count
              // A pre-PR-3b plan: another expansion, planned through the lib WITHOUT a verdict.
              const legacy = await startedJob(st)
              expect((await st.largeRun(legacy)).statusCode).toBe(200)
              await largeBomJobs.planLargeBomBackgroundExpansionJob({
                storage: st.pluginContext.storage, tenantId: st.tenantId, workspaceId: 'workspace-default', actionId: ACTION_ID, jobId: legacy,
                existingRows: await tableActions.__internals.readExistingStockPreparationRows(st.multitable.records, st.target, st.projectNo),
                writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
              })
              const legacyVerdict = await verdictOf(legacy)
              const gen0 = await st.generation()
              const applyJobs0 = (await largeRows(st.tenantId)).filter((row: any) => row.key.startsWith(`${LARGE_PREFIX}apply:`)).length
              const refused = await st.largeApprove(legacy)
              const genAfterRefusal = await st.generation()
              const applyJobs1 = (await largeRows(st.tenantId)).filter((row: any) => row.key.startsWith(`${LARGE_PREFIX}apply:`)).length
              const replanned = await st.largePlan(legacy)
              const replannedVerdict = await verdictOf(legacy)
              const tokenAtReplan = (await st.generation()).generationToken
              const servedAgain = await st.largeApprove(legacy)
              const observed = {
                firstVerdictKeys: Object.keys(firstVerdict || {}).sort(),
                firstVerdict: { consulted: firstVerdict.consulted, verdict: firstVerdict.verdict, tokenIsNullOrString: firstVerdict.generationToken === null || typeof firstVerdict.generationToken === 'string' },
                approved: answerOf(approved),
                chunk: answerOf(chunk),
                rowsWritten: written > 0,
                legacyVerdict: legacyVerdict === undefined || legacyVerdict === null ? 'absent' : 'present',
                refused: answerOf(refused),
                noBumpByTheRefusal: sameJson(genAfterRefusal, gen0),
                noApplyJobByTheRefusal: applyJobs1 === applyJobs0,
                replanned: answerOf(replanned),
                replannedVerdict: Boolean(replannedVerdict) && Object.keys(replannedVerdict).length === 3 && replannedVerdict.consulted === true && replannedVerdict.verdict === 'not_governed' && replannedVerdict.generationToken === tokenAtReplan && typeof tokenAtReplan === 'string',
                servedAgain: answerOf(servedAgain),
                stepFourRows: await st.stepFourRows(),
              }
              console.log(`[S3B-02] ${JSON.stringify(observed)}`)
              expect(observed).toEqual({
                firstVerdictKeys: ['consulted', 'generationToken', 'verdict'],
                firstVerdict: { consulted: true, verdict: 'not_governed', tokenIsNullOrString: true },
                approved: '202:ok',
                chunk: '200:ok',
                rowsWritten: true,
                legacyVerdict: 'absent',
                refused: '409:LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED:verdict_absent',
                noBumpByTheRefusal: true,
                noApplyJobByTheRefusal: true,
                replanned: '200:ok',
                replannedVerdict: true,
                servedAgain: '202:ok',
                stepFourRows: 0,
              })
            } finally {
              await cleanupLarge(st.tenantId)
            }
          }, 300000)

          test('S3B-03 (P3-L6, O-1, E-3 large) a sentinel planted in a persisted hold\'s detail never reaches a stored large-BOM job: the governed project\'s start / run / plan / approve are refused and write no plugin_kv row; a DIRECT lib plan handed the governed projection as `continuation` stores a plan with no hold and no sentinel; a crafted stored plan carrying a sentinel hold is refused at approval (409 LARGE_BOM_APPLY_PLAN_SUSPENDED) and no apply job row is written — every other plugin_kv row written meanwhile is free of the sentinel and of a hold array', async () => {
            const SENTINEL = `S3B-SENTINEL-${TOKEN}`
            const startedAt = (await q('SELECT now() AS at')).rows[0].at
            const sentinelHold = contentHold('k_s3b_03', { key: SENTINEL, fields: { material: { before: SENTINEL, after: `${SENTINEL}-2` } } })
            const st = await s3aStack('b03', { pilot: false })
            const free = await s3aStack('b03c', { pilot: false })
            try {
              const jobs = await largeStages(st)
              await seedOpenHolds(st.refresh.store, st.scope, [sentinelHold])
              const kv0 = await largeRows(st.tenantId)
              const answers: Record<string, string> = {}
              for (const [route, run] of fourRoutes(st, jobs)) answers[route] = answerOf(await run())
              const routesWroteNothing = sameJson(await largeRows(st.tenantId), kv0)
              // O-1 on the real store: a direct lib plan handed the governed projection (whose persistedHolds carry the
              // sentinel) as `continuation` — the large planner never receives it.
              const consult = await st.refresh.governance.consult(st.scope)
              const continuation = refreshLanes.continuationInputFor({ consult, governed: true }, { action: st.action, expansion: null })
              const sentinelInProjection = JSON.stringify(continuation.persistedHolds).includes(SENTINEL)
              await largeBomJobs.planLargeBomBackgroundExpansionJob({
                storage: st.pluginContext.storage, tenantId: st.tenantId, workspaceId: 'workspace-default', actionId: ACTION_ID, jobId: jobs.ran,
                existingRows: [], continuation, governanceVerdict: notGovernedVerdict((await st.generation()).generationToken),
                writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
              })
              const directPlanRow = (await largeRows(st.tenantId)).find((row: any) => row.key.endsWith(`:${jobs.ran}`))
              // E-3 / O-1 at approval: a NOT-governed project's stored plan crafted to carry the sentinel hold (an
              // artifact from before this change, or a forged one) — the route consult passes, the lib refuses.
              const freeJobs = await largeStages(free)
              const freeKey = `${LARGE_PREFIX}background:${free.tenantId}:workspace-default:${ACTION_ID}:${freeJobs.planned}`
              const storage: any = free.pluginContext.storage
              const crafted = await storage.get(freeKey)
              crafted.planArtifact.plan = { ...crafted.planArtifact.plan, suspended: true, holds: [sentinelHold] }
              await storage.set(freeKey, crafted)
              const craftedApproval = await free.largeApprove(freeJobs.planned)
              const freeApplyJobs = (await largeRows(free.tenantId)).filter((row: any) => row.key.startsWith(`${LARGE_PREFIX}apply:`)).length
              const kv = (await q(`SELECT key, value::text AS text FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND updated_at >= $1 AND key <> $2`, [startedAt, freeKey])).rows
              const leaks = (text: string) => [SENTINEL, '"holds":[', '"persistedHolds"', '"continuationRoots"'].filter((needle) => text.includes(needle))
              const observed = {
                answers,
                routesWroteNothing,
                sentinelInProjection,
                directPlanStored: Boolean(directPlanRow),
                directPlanLeaks: directPlanRow ? leaks(directPlanRow.text) : ['<missing>'],
                craftedApproval: answerOf(craftedApproval),
                freeApplyJobs,
                kvRowsWritten: kv.length > 0,
                kvLeaks: kv.flatMap((row: any) => leaks(row.text)),
                holdTableCarriesIt: Number((await q(`SELECT count(*)::int AS n FROM ${RT.hold} WHERE detail::text LIKE $1`, [`%${SENTINEL}%`])).rows[0].n) > 0,
              }
              console.log(`[S3B-03] ${JSON.stringify(observed)}`)
              const refused = (lane: string) => `409:STOCK_PREP_REFRESH_LARGE_LANE_REFUSED:hold:${lane}`
              expect(observed).toEqual({
                answers: { start: refused('large_expansion_start'), run: refused('large_expansion_run'), plan: refused('large_plan'), approve: refused('large_approve') },
                routesWroteNothing: true,
                sentinelInProjection: true,
                directPlanStored: true,
                directPlanLeaks: [],
                craftedApproval: '409:LARGE_BOM_APPLY_PLAN_SUSPENDED:suspended',
                freeApplyJobs: 0,
                kvRowsWritten: true,
                kvLeaks: [],
                holdTableCarriesIt: true,
              })
            } finally {
              await cleanupLarge(st.tenantId)
              await cleanupLarge(free.tenantId)
            }
          }, 300000)

          test('S3B-04 (C10 large, E-2(a)) the pilot column cleared after a confirmed relationship exists (same sheet): start, run, plan and approve answer 409 LARGE_LANE_REFUSED `continuation`; a job approved BEFORE the project became governed is refused at its chunk (PLAN_SUPERSEDED — the confirm bumped, the binding answers first; fail closed); a job slipped past the routes afterwards (a lib approval with a forged not-governed verdict) is refused by the chunk\'s in-lease gate `continuation` — nothing written by any of them', async () => {
            const st = await s3aStack('b04', { pilot: false })
            try {
              // Large jobs while the project is neither pilot nor governed: one approved, then every stage.
              const early = await startedJob(st)
              expect((await st.largeRun(early)).statusCode).toBe(200)
              expect((await st.largePlan(early)).statusCode).toBe(200)
              const approved = await st.largeApprove(early)
              expect(approved.statusCode, JSON.stringify(approved.body)).toBe(202)
              const jobs = await largeStages(st)
              // The pilot is enabled (the registry mark), the first pull applied, the second pull's candidate confirmed,
              // and the pilot cleared — the project is governed by its relationship alone.
              await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [st.tenantId, st.projectNo, 'u_s3b_admin'])
              await firstPullApplied(st)
              st.state.data = CF.secondPullSource()
              expect((await st.dryRun()).body.data.status).toBe('suspended')
              await confirmOpenCandidate(st)
              await st.pilotExit()
              const consult = await st.refresh.governance.consult(st.scope)
              expect(consult.pilot.enabled).toBe(false)
              expect(consult.continuations.length).toBeGreaterThan(0)
              const main0 = await st.main()
              const reads0 = st.state.reads
              const answers: Record<string, string> = {}
              for (const [route, run] of fourRoutes(st, jobs)) answers[route] = answerOf(await run())
              const routeSourceReads = st.state.reads - reads0
              const earlyJob0 = await st.pluginContext.storage.get(`${LARGE_PREFIX}apply:${st.tenantId}:workspace-default:${ACTION_ID}:${approved.body.data.jobId}`)
              answers.chunkBefore = answerOf(await st.chunk(early, approved.body.data.jobId))
              const earlyJob1 = await st.pluginContext.storage.get(`${LARGE_PREFIX}apply:${st.tenantId}:workspace-default:${ACTION_ID}:${approved.body.data.jobId}`)
              // Slipped past the routes: a fresh expansion planned and approved through the LIB with a forged verdict (its
              // own source read is this test's, not a route's).
              const slipped = await libExpansion(st, `s3b_04_slipped_${TOKEN}`, 'approved')
              const slippedJob0 = await st.pluginContext.storage.get(`${LARGE_PREFIX}apply:${st.tenantId}:workspace-default:${ACTION_ID}:${slipped.jobId}`)
              answers.chunkSlipped = answerOf(await st.chunk(`s3b_04_slipped_${TOKEN}`, slipped.jobId))
              const slippedJob1 = await st.pluginContext.storage.get(`${LARGE_PREFIX}apply:${st.tenantId}:workspace-default:${ACTION_ID}:${slipped.jobId}`)
              const observed = {
                answers,
                sourceReads: routeSourceReads,
                earlyJobUnchanged: sameJson(earlyJob1, earlyJob0),
                slippedJobUnchanged: sameJson(slippedJob1, slippedJob0),
                mainUnchanged: sameJson(await st.main(), main0),
              }
              console.log(`[S3B-04] ${JSON.stringify(observed)}`)
              const refused = (lane: string) => `409:STOCK_PREP_REFRESH_LARGE_LANE_REFUSED:continuation:${lane}`
              expect(observed).toEqual({
                answers: {
                  start: refused('large_expansion_start'),
                  run: refused('large_expansion_run'),
                  plan: refused('large_plan'),
                  approve: refused('large_approve'),
                  chunkBefore: '409:STOCK_PREP_PROJECT_PLAN_SUPERSEDED:newer_plan',
                  chunkSlipped: refused('large_apply_chunk'),
                },
                sourceReads: 0,
                earlyJobUnchanged: true,
                slippedJobUnchanged: true,
                mainUnchanged: true,
              })
            } finally {
              await cleanupLarge(st.tenantId)
            }
          }, 300000)

          test('S3B-05 (U07 large, E-2(b), GV-1) switch OFF: a project governed by step-4 ROWS on its own registered sheet while the action resolves the env sheet => start, run, plan and approve 409 RETARGETED `sheet` before any source read or existing-row read (no plugin_kv row written, no bump); a PILOT project => PR B\'s code; a registered NOT-governed project => today\'s large lane, served end to end on the env sheet with 0 step-4 rows', async () => {
            const free = await s3aStack('b05n', { pilot: false, switchOn: false })
            const gov = await s3aStack('b05g', { pilot: false, switchOn: false })
            const pilot = await s3aStack('b05p', { pilot: true, switchOn: false })
            const counter = countRecordReads(gov.multitable.records)
            try {
              // Registered, NOT governed: the whole lane on the env sheet, as before PR-3b.
              const freeJob = await startedJob(free)
              const served: Record<string, string> = { run: answerOf(await free.largeRun(freeJob)), plan: answerOf(await free.largePlan(freeJob)) }
              const freeApproved = await free.largeApprove(freeJob)
              served.approve = answerOf(freeApproved)
              served.chunk = freeApproved.statusCode === 202 ? answerOf(await free.chunk(freeJob, freeApproved.body.data.jobId)) : 'not approved'
              const freeRowsOnEnv = (await free.main(free.envTarget.sheetId)).count
              // Governed by ROWS on its registered sheet: jobs made while not governed, then the rows land.
              const jobs = await largeStages(gov)
              await seedOpenHolds(gov.refresh.store, gov.scope, [contentHold('k_s3b_05')])
              const envKey = sheetWriteScopeKey(gov.envTarget.sheetId)
              const kv0 = await largeRows(gov.tenantId)
              const gen0 = await gov.generation(envKey)
              const reads0 = gov.state.reads
              const recordReads0 = counter.count()
              const retargeted: Record<string, string> = {}
              for (const [route, run] of fourRoutes(gov, jobs)) retargeted[route] = answerOf(await run())
              const observed = {
                served,
                freeRowsOnEnv: freeRowsOnEnv > 0,
                freeStepFourRows: await free.stepFourRows(),
                retargeted,
                sourceReads: gov.state.reads - reads0,
                recordReads: counter.count() - recordReads0,
                kvUnchanged: sameJson(await largeRows(gov.tenantId), kv0),
                generationUnchanged: sameJson(await gov.generation(envKey), gen0),
                pilot: answerOf(await pilot.largeStart()),
              }
              console.log(`[S3B-05] ${JSON.stringify(observed)}`)
              const refused = '409:STOCK_PREP_REFRESH_TARGET_RETARGETED:sheet'
              expect(observed).toEqual({
                served: { run: '200:ok', plan: '200:ok', approve: '202:ok', chunk: '200:ok' },
                freeRowsOnEnv: true,
                freeStepFourRows: 0,
                retargeted: { start: refused, run: refused, plan: refused, approve: refused },
                sourceReads: 0,
                recordReads: 0,
                kvUnchanged: true,
                generationUnchanged: true,
                pilot: '409:STOCK_PREP_PILOT_LARGE_LANE_REFUSED:pilot_project:large_expansion_start',
              })
            } finally {
              counter.restore()
              await cleanupLarge(free.tenantId)
              await cleanupLarge(gov.tenantId)
              await cleanupLarge(pilot.tenantId)
            }
          }, 300000)

          test('S3B-06 (R-12, A11 / G1 large) the step-4 tables ABSENT from the store binding (42P01 — a pre-102/103 database; the registry readable): start, run, plan and approve answer 503 STORE_FAILED `continuation` 42P01 before any source read or existing-row read — no plugin_kv row written or changed, no apply job, the generation unchanged', async () => {
            const client = await poolManager.get().getInternalPool().connect()
            const schema = `s3b_nostep4_${TOKEN}`
            let tenantId: string | null = null
            try {
              await client.query(`CREATE SCHEMA ${schema}`)
              // The registry stays readable on this binding (the consult's registry reads share the store's snapshot):
              // only the five step-4 tables are missing, as on a database without migrations 102 / 103.
              await client.query(`CREATE VIEW ${schema}.integration_stock_prep_project_target AS SELECT * FROM public.integration_stock_prep_project_target`)
              await client.query(`SET search_path TO ${schema}`)
              const st = await s3aStack('b06', { pilot: false, refresh: realRefreshServices(dbOn(client)) })
              tenantId = st.tenantId
              // Jobs at every stage through the LIB (this deployment's routes refuse every large call).
              const queued = `s3b_06_queued_${TOKEN}`
              const ran = `s3b_06_ran_${TOKEN}`
              const planned = `s3b_06_planned_${TOKEN}`
              await libExpansion(st, queued, 'queued')
              await libExpansion(st, ran, 'ran')
              await libExpansion(st, planned, 'planned')
              const counter = countRecordReads(st.multitable.records)
              try {
                const kv0 = await largeRows(st.tenantId)
                const gen0 = await st.generation()
                const reads0 = st.state.reads
                const answers: Record<string, string> = {}
                for (const [route, run] of fourRoutes(st, { queued, ran, planned })) {
                  const res = await run()
                  answers[route] = `${res.statusCode}:${errorOf(res).code}:${errorOf(res).details && errorOf(res).details.store}:${errorOf(res).details && errorOf(res).details.sqlState}`
                }
                const kv1 = await largeRows(st.tenantId)
                const observed = {
                  answers,
                  sourceReads: st.state.reads - reads0,
                  recordReads: counter.count(),
                  kvUnchanged: sameJson(kv1, kv0),
                  applyJobs: kv1.filter((row: any) => row.key.startsWith(`${LARGE_PREFIX}apply:`)).length,
                  generationUnchanged: sameJson(await st.generation(), gen0),
                }
                console.log(`[S3B-06] ${JSON.stringify(observed)}`)
                const unreadable = '503:STOCK_PREP_REFRESH_STORE_FAILED:continuation:42P01'
                expect(observed).toEqual({
                  answers: { start: unreadable, run: unreadable, plan: unreadable, approve: unreadable },
                  sourceReads: 0,
                  recordReads: 0,
                  kvUnchanged: true,
                  applyJobs: 0,
                  generationUnchanged: true,
                })
              } finally {
                counter.restore()
              }
            } finally {
              await client.query('RESET search_path').catch(() => {})
              await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
              client.release()
              if (tenantId) await cleanupLarge(tenantId)
            }
          }, 300000)
        })
        // ── S4: batch-refresh step 4 PR-4 — THE PULLER'S DECISIONS on the REAL stack ───────────────────────────────
        // The six refresh routes (lib/http-routes.cjs stockPreparationRefresh*, lib/stock-preparation-refresh-decisions.cjs)
        // over the production host, lock, registry, audit store and refresh services, and the lock's in-transaction bump
        // (`bumpGenerationWithin`) inside the store's REAL transaction on PostgreSQL. Nested in S3A for its stack and
        // helpers. The pilot column is SEEDED DIRECTLY (pilot enable is impossible on this build: the readiness marker
        // CONTINUATION_SUPPORT_VERSION is 0). Synthetic values only.
        //   S4-01 bumpGenerationWithin interleavings: (a) an ABANDONED carry_confirm lease with no execution row is cleared
        //         by the confirm's own transaction (epoch + 1, interruption recorded, the stalled holder LEASE_LOST); (b) a
        //         crashed apply (a `running` execution of a dead lease) refuses the ROUTE confirm RECOVERY_PENDING with the
        //         lock row untouched; (c) the confirm transaction frozen before COMMIT while another session's acquire
        //         queues behind it (pg_blocking_pids) — after COMMIT the grant carries the NEW token (I3) and a token minted
        //         at the old generation is PLAN_SUPERSEDED; (d) acquire first => the confirm is WRITE_LOCKED and rolled
        //         back; (e) a holder frozen INSIDE its fenced write (FOR SHARE held) with an abandoned lease => the confirm
        //         answers WRITE_LOCKED holder_in_write within the bound + slack, nothing persisted.
        //   S4-02 E03 through the routes: a job approved and a token minted before the project became pilot; the confirm
        //         bumps IN its transaction; the apply (old token) and the chunk (approved job) are PLAN_SUPERSEDED before any
        //         write — meta_records / meta_record_revisions unchanged, the job byte-identical.
        //   S4-03 E04 through the routes: a chunk writes one row and pauses; while a large_apply_chunk lease is live the
        //         confirm is WRITE_LOCKED (nothing confirmed); after release it commits; the next chunk is refused before
        //         any write and no row of the old plan lands.
        //   S4-04 E09 on PostgreSQL: a BEFORE INSERT trigger on the audit table raising 42501 for this tenant's
        //         continuation_confirmed row => 503 STORE_FAILED audit; every step-4 row, the lock row and the main sheet
        //         byte-identical, the hold still open; with the trigger gone the same body commits.
        //   S4-05 A08 through the routes: two candidate holds claiming the same old record confirmed CONCURRENTLY from two
        //         sessions => exactly one 201, the other 409 CONFIRM_CONFLICT (23505 on the partial unique index).
        //   S4-06 U03 on the real stack: the floor operator 403 on all six; a tenantless platform admin 403
        //         OPERATOR_SCOPE_TENANT_REQUIRED; another tenant's hold id and an unknown id the SAME 404; one audit row per
        //         value read in integration_stock_prep_audit, values-free.
        //   S4-07 U04 on the real stack: holds paged by cursor, pairs by pairCursor with the receipt extended; a confirm
        //         with a half-read receipt is 409 READ_RECEIPT_INCOMPLETE and 201 after the last page; no receipt => 400.
        //   S4-04b E09, the other direction (review P7): a DEFERRED constraint trigger fails the decision's COMMIT => the
        //         ROUTE confirm answers 503 STORE_FAILED commit; nothing persisted, NO audit row; then commits.
        //   S4-08 review B1 / N2 / N3 at the lib level with the route-built context (sequential form): a computation, an
        //         escalation or a failed apply landing between the consult and the transaction is refused UNDER THE LOCK
        //         (new_position_present / facts_moved / runbook_only_hold_open / RECOVERY_PENDING), nothing persisted.
        describe('S4 step-4 PR-4 decisions (real Postgres, real lock, real host)', () => {
          const decisionsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-decisions.cjs')) as any
          const { REFRESH_DECISION_ERROR_CODES: DC } = decisionsLib
          const REFRESH_BASE = '/api/integration/stock-preparation/projects/:projectNo/refresh'
          const RP = {
            holds: `${REFRESH_BASE}/holds`,
            evidence: `${REFRESH_BASE}/holds/:holdId/evidence`,
            keep: `${REFRESH_BASE}/holds/:holdId/keep`,
            confirm: `${REFRESH_BASE}/continuations/confirm`,
            detail: `${REFRESH_BASE}/continuations/:id`,
            end: `${REFRESH_BASE}/continuations/:id/end`,
          }
          async function withSwitchOn<T>(fn: () => Promise<T>): Promise<T> {
            const before = process.env[SWITCH]
            process.env[SWITCH] = 'true'
            try {
              return await fn()
            } finally {
              if (before === undefined) delete process.env[SWITCH]
              else process.env[SWITCH] = before
            }
          }
          const refreshCall = (st: any, method: string, routePath: string, { user = st.users.puller, body = {}, query = {}, params = {} }: any = {}) =>
            withSwitchOn(() => callRoute(st.routes, method, routePath, { user, body, query, params: { projectNo: st.projectNo, ...params } }))
          const dataOf = (res: any) => {
            expect(res.statusCode < 300, JSON.stringify(res.body)).toBe(true)
            return res.body.data
          }
          const pilotEnter = (st: any) => q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [st.tenantId, st.projectNo, 'u_s4_admin'])
          const lockRowOf = async (key: string) => (await q(`SELECT generation, generation_token, generation_reason, fencing_epoch, lease_id, lease_purpose, last_interrupted_purpose FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])).rows[0] || null
          const openCandidate = async (st: any) => {
            const row = (await st.holds()).find((entry: any) => entry.status === 'open' && entry.kind === 'continuation_candidate')
            expect(row, 'an open candidate hold').toBeTruthy()
            expect(row.confirmable, 'the candidate is confirmable').toBe(true)
            return row
          }
          // Read the hold through the page (every pair page), answer the confirm body bound to it.
          async function readAndBind(st: any, row: any, { pairLimit, user }: { pairLimit?: number; user?: any } = {}) {
            const first = dataOf(await refreshCall(st, 'GET', RP.holds, { user, query: pairLimit ? { holdId: row.id, pairLimit: String(pairLimit) } : {} }))
            const entry = first.page.holds.find((item: any) => item.id === row.id)
            expect(entry, 'the hold is on the page').toBeTruthy()
            let receipt = first.readReceipt
            const pages = entry.pairPage ? entry.pairPage.count : 1
            for (let index = 1; index < pages; index += 1) {
              receipt = dataOf(await refreshCall(st, 'GET', RP.holds, { user, query: { holdId: row.id, pairCursor: String(index), ...(pairLimit ? { pairLimit: String(pairLimit) } : {}), receipt: receipt.id } })).readReceipt
            }
            return {
              receipt,
              entry,
              body: {
                confirmProjectNo: st.projectNo,
                holdId: row.id,
                holdFingerprint: row.fingerprint,
                comparisonFingerprint: row.comparison_fingerprint,
                evidenceFingerprint: row.evidence_fingerprint,
                candidateId: entry.pairingFingerprint,
                readReceipt: receipt.id,
                basis: { kind: 'puller_confirmed_same_demand' },
                acknowledge: { historyUnknown: true },
              },
            }
          }
          const confirmViaRoute = async (st: any, row: any, options: any = {}) => {
            const bound = await readAndBind(st, row, options)
            return refreshCall(st, 'POST', RP.confirm, { user: options.user, body: bound.body })
          }
          // A pilot project after its first pull, previewed on the canonical second pull: one open confirmable candidate.
          async function suspendedPilot(label: string) {
            const st = await s3aStack(label, { pilot: true })
            await firstPullApplied(st)
            st.state.data = CF.secondPullSource()
            const preview = await st.dryRun()
            expect(preview.body.data.status, JSON.stringify(preview.body)).toBe('suspended')
            return st
          }
          // A single raw client with a statement hook (dbOn + the hostLikeDb hook): the confirm's session for the frozen interleaving.
          function dbOnHooked(client: PoolClient, hook: (event: StatementEvent) => Promise<void> | void) {
            return createDb({
              database: {
                query: async (sql: string, params?: unknown[]) => { await hook({ sql, inTransaction: false }); return (await client.query(sql, params)).rows },
                transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
                  await client.query('BEGIN')
                  try {
                    const result = await callback({
                      query: async (sql: string, params?: unknown[]) => { await hook({ sql, inTransaction: true }); return (await client.query(sql, params)).rows },
                      commit: async () => {},
                      rollback: async () => {},
                    })
                    await hook({ sql: 'COMMIT', inTransaction: true })
                    await client.query('COMMIT')
                    return result
                  } catch (error) {
                    await client.query('ROLLBACK').catch(() => {})
                    throw error
                  }
                },
              },
            })
          }
          const auditRows = async (tenantId: string) => (await q('SELECT action, mode, subject_id, detail::text AS detail FROM integration_stock_prep_audit WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId])).rows

          test('S4-01 bumpGenerationWithin on PostgreSQL inside the store\'s transaction: (a) an ABANDONED carry_confirm lease is cleared by the confirm (epoch + 1, interruption recorded, the stalled holder LEASE_LOST); (b) a crashed apply refuses the ROUTE confirm RECOVERY_PENDING, lock row untouched; (c) the confirm frozen before COMMIT blocks an acquire (pg_blocking_pids) which is then granted the NEW token and an old token is PLAN_SUPERSEDED; (d) a live lease => WRITE_LOCKED, rolled back; (e) a holder frozen in its fenced write => holder_in_write within the bound, nothing persisted', async () => {
            const observed: Record<string, unknown> = {}
            // (a) + (c) + (d) + (e) at the store level with the REAL lock module's bump on the store's transaction handle.
            const fixture = await refreshKit.candidateHoldFixture()
            const F = fixture.fixtures
            {
              const scope = { tenantId: tenantFor('s4_01a'), sheetId: sheetFor('s4_01a'), projectNo: fixture.projectNo }
              const base = Date.now()
              const lockNow = createStockPreparationProjectWriteLock({ db: hostLikeDb(), now: () => new Date(base) })
              const lockLater = createStockPreparationProjectWriteLock({ db: hostLikeDb(), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS) })
              const store = continuationStoreModule.createStockPreparationContinuationStore({ db: hostLikeDb() })
              const key = sheetWriteScopeKey(scope.sheetId)
              await lockNow.bumpGeneration(key, { reason: 'small_preview', tenantId: scope.tenantId })
              const grant = await lockNow.acquire(key, { purpose: 'carry_confirm', runId: 's4-01a-stalled', tenantId: scope.tenantId })
              const guard = lockNow.createGuard(grant)
              const holdIdOf = await seedOpenHolds(store, scope, [fixture.hold])
              const holdId = holdIdOf(fixture.hold)
              const confirmed = await store.confirmContinuation(confirmInput(scope, holdId, fixture.hold, fixture), { bumpWithin: lockLater.bumpGenerationWithin })
              const row = await lockRowOf(key)
              const stalled = await settle(guard.beforeWrite())
              observed.a = {
                continuation: confirmed.continuationId ? 'active' : 'none',
                bump: confirmed.generation,
                leaseCleared: row.lease_id === null,
                epoch: Number(row.fencing_epoch),
                priorEpoch: grant.fencingEpoch,
                interrupted: row.last_interrupted_purpose,
                reason: row.generation_reason,
                stalledHolder: stalled.ok ? 'wrote' : (stalled as any).error.code,
              }
            }
            // (c) frozen before COMMIT; an acquire queues behind the bump's row lock; the grant carries the confirm's token.
            {
              const scope = { tenantId: tenantFor('s4_01c'), sheetId: sheetFor('s4_01c'), projectNo: fixture.projectNo }
              const key = sheetWriteScopeKey(scope.sheetId)
              const pidA = Number((await clientA.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
              const pidB = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
              const commitGate = gate()
              let frozen: (() => void) | null = null
              const frozenAt = new Promise<void>((resolve) => { frozen = resolve })
              const confirmDb = dbOnHooked(clientA, async (event) => {
                if (event.inTransaction && event.sql === 'COMMIT') {
                  if (frozen) frozen()
                  await commitGate.promise
                }
              })
              const lockA = createStockPreparationProjectWriteLock({ db: confirmDb })
              const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB) })
              const storeA = continuationStoreModule.createStockPreparationContinuationStore({ db: confirmDb })
              const seedStore = continuationStoreModule.createStockPreparationContinuationStore({ db: hostLikeDb() })
              const before = await lockB.bumpGeneration(key, { reason: 'small_preview', tenantId: scope.tenantId })
              const holdIdOf = await seedOpenHolds(seedStore, scope, [fixture.hold])
              const holdId = holdIdOf(fixture.hold)
              const confirming = storeA.confirmContinuation(confirmInput(scope, holdId, fixture.hold, fixture), { bumpWithin: lockA.bumpGenerationWithin })
              await frozenAt
              const acquiring = lockB.acquire(key, { purpose: 'small_apply', runId: 's4-01c-acquire', tenantId: scope.tenantId })
              await waitUntil('the acquire to queue behind the frozen confirm', () => isBlockedBy(pidB, pidA))
              observed.cBlocked = true
              commitGate.open()
              const confirmed = await confirming
              const grant = await acquiring
              const guardB = lockB.createGuard(grant)
              const oldBinding = writeBindingFromGeneration({ scopeKey: key, generation: before.generation, generationToken: before.generationToken })
              const stale = await settle((async () => lockModule.assertWriteBindingMatchesGuard(oldBinding, guardB))())
              observed.c = {
                grantToken: grant.generationToken === confirmed.generation.generationToken ? 'the confirm\'s token' : 'another token',
                grantGeneration: grant.generation,
                confirmGeneration: confirmed.generation.generation,
                oldToken: stale.ok ? 'admitted' : `${(stale as any).error.code}:${(stale as any).error.details.reason}`,
              }
              await guardB.release()
            }
            // (d) a LIVE lease first: the confirm is WRITE_LOCKED and rolled back.
            {
              const scope = { tenantId: tenantFor('s4_01d'), sheetId: sheetFor('s4_01d'), projectNo: fixture.projectNo }
              const key = sheetWriteScopeKey(scope.sheetId)
              const lock = createStockPreparationProjectWriteLock({ db: hostLikeDb() })
              const store = continuationStoreModule.createStockPreparationContinuationStore({ db: hostLikeDb() })
              await lock.bumpGeneration(key, { reason: 'small_preview', tenantId: scope.tenantId })
              const holdIdOf = await seedOpenHolds(store, scope, [fixture.hold])
              const holdId = holdIdOf(fixture.hold)
              const grant = await lock.acquire(key, { purpose: 'small_apply', runId: 's4-01d', tenantId: scope.tenantId })
              const before = await sheetFingerprint(scope.sheetId)
              const refused = await settle(store.confirmContinuation(confirmInput(scope, holdId, fixture.hold, fixture), { bumpWithin: lock.bumpGenerationWithin }))
              observed.d = {
                code: refused.ok ? 'committed' : (refused as any).error.code,
                holder: refused.ok ? null : (refused as any).error.details.holderPurpose,
                unchanged: (await sheetFingerprint(scope.sheetId)) === before,
                holdOpen: (await q(`SELECT status FROM ${RT.hold} WHERE id = $1`, [holdId])).rows[0].status,
              }
              await lock.createGuard(grant).release()
            }
            // (e) a holder frozen INSIDE its fenced write transaction, its lease abandoned from the confirm's clock.
            {
              const scope = { tenantId: tenantFor('s4_01e'), sheetId: sheetFor('s4_01e'), projectNo: fixture.projectNo }
              const key = sheetWriteScopeKey(scope.sheetId)
              const base = Date.now()
              const lockHolder = createStockPreparationProjectWriteLock({ db: hostLikeDb(), now: () => new Date(base) })
              const lockConfirm = createStockPreparationProjectWriteLock({ db: hostLikeDb(), now: () => new Date(base + PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS), rowLockWaitMs: SHORT_ROW_LOCK_WAIT_MS })
              const store = continuationStoreModule.createStockPreparationContinuationStore({ db: hostLikeDb() })
              await lockHolder.bumpGeneration(key, { reason: 'small_preview', tenantId: scope.tenantId })
              const grant = await lockHolder.acquire(key, { purpose: 'small_apply', runId: 's4-01e-frozen', tenantId: scope.tenantId })
              const fence = lockHolder.createGuard(grant).hostWriteFence()
              const holdIdOf = await seedOpenHolds(store, scope, [fixture.hold])
              const holdId = holdIdOf(fixture.hold)
              await clientX.query('BEGIN')
              try {
                const held = await clientX.query(PLUGIN_WRITE_FENCE_ALLOW_LIST['plugin-integration-core'].sql, [fence.scopeKey, fence.leaseId, fence.fencingEpoch, fence.generationToken])
                expect(held.rows.length).toBe(1)
                const before = await sheetFingerprint(scope.sheetId)
                const started = Date.now()
                const refused = await settle(store.confirmContinuation(confirmInput(scope, holdId, fixture.hold, fixture), { bumpWithin: lockConfirm.bumpGenerationWithin }))
                const elapsed = Date.now() - started
                observed.e = {
                  code: refused.ok ? 'committed' : (refused as any).error.code,
                  reason: refused.ok ? null : (refused as any).error.details.reason,
                  withinBound: elapsed >= SHORT_ROW_LOCK_WAIT_MS / 2 && elapsed < SHORT_ROW_LOCK_WAIT_MS + ROW_LOCK_WAIT_SLACK_MS,
                  unchanged: (await sheetFingerprint(scope.sheetId)) === before,
                }
              } finally {
                await clientX.query('COMMIT').catch(() => {})
              }
            }
            // (b) through the ROUTE: a crashed apply (a running execution row of a dead lease) => RECOVERY_PENDING.
            {
              const st = await suspendedPilot('s401b')
              const row = await openCandidate(st)
              const lock0 = await lockRowOf(st.key)
              await st.refresh.store.beginExecution({
                ...st.scope, lane: 'small_apply',
                guard: { leaseRunId: 's4-01b-dead', leaseId: 'lease_s4_01b_dead', fencingEpoch: 1, generation: Number(lock0.generation), generationToken: lock0.generation_token },
                tokenRevision: 'rev_s4_01b', planDigest: 'plan_s4_01b', plannedCounts: { add: 0, update: 0, inactive: 0 }, refreshBinding: { continuations: [] }, startedBy: st.users.puller.id,
              })
              const res = await confirmViaRoute(st, row)
              observed.b = {
                status: res.statusCode,
                code: errorOf(res).code,
                details: errorOf(res).details,
                lockUnchanged: JSON.stringify(await lockRowOf(st.key)) === JSON.stringify(lock0),
                holdOpen: (await st.holds()).find((entry: any) => entry.id === row.id).status,
                continuations: await countWhere(RT.continuation, 'tenant_id = $1', [st.tenantId]),
              }
            }
            console.log(`[S4-01] ${JSON.stringify(observed)}`)
            expect(observed.a).toEqual({ continuation: 'active', bump: expect.objectContaining({ generation: 2 }), leaseCleared: true, epoch: 2, priorEpoch: 1, interrupted: 'carry_confirm', reason: 'continuation_confirm', stalledHolder: PROJECT_WRITE_ERROR_CODES.LEASE_LOST })
            expect(observed.cBlocked).toBe(true)
            expect(observed.c).toEqual({ grantToken: 'the confirm\'s token', grantGeneration: 2, confirmGeneration: 2, oldToken: `${PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED}:newer_plan` })
            expect(observed.d).toEqual({ code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, holder: 'small_apply', unchanged: true, holdOpen: 'open' })
            expect(observed.e).toEqual({ code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, reason: 'holder_in_write', withinBound: true, unchanged: true })
            expect(observed.b).toEqual({ status: 409, code: DC.RECOVERY_PENDING, details: { state: 'failed_pending_recovery', openExecutions: 1, partial: false }, lockUnchanged: true, holdOpen: 'open', continuations: 0 })
          }, 240000)

          test('S4-02 (E03) a job approved and a token minted BEFORE the project became pilot; the ROUTE confirm bumps IN its transaction (reason continuation_confirm); the apply with the old token is PLAN_SUPERSEDED; the approved job\'s chunk is refused before any write — by the pilot gate at the route (R-54 (5)) and by the binding compare inside a real lease (PLAN_SUPERSEDED newer_plan) — meta_records and meta_record_revisions unchanged, the apply job byte-identical', async () => {
            const st = await s3aStack('s402', { pilot: false })
            await firstPullApplied(st)
            // The large lane while NOT governed (a registered, not-pilot project with no step-4 rows): expand the
            // canonical second pull, plan, approve (the approval bumps `large_approval`).
            st.state.data = CF.secondPullSource()
            const storage: any = st.pluginContext.storage
            const jobScope = { tenantId: st.tenantId, workspaceId: 'workspace-default' }
            const jobId = `s4_02_${TOKEN}`
            const applyJobId = `s4_02_apply_${TOKEN}`
            const records = st.multitable.records as any
            await largeBomJobs.createLargeBomBackgroundExpansionJob({
              storage, ...jobScope, action: st.action, parameters: { projectNo: st.projectNo }, principal: 's4-02', createJobId: () => jobId,
              writeGenerationObserver: async () => writeObservationFromGeneration(await st.lock.observeGeneration(st.key)),
            })
            await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId: ACTION_ID, jobId, sourceAdapter: st.sourceAdapter })
            await largeBomJobs.planLargeBomBackgroundExpansionJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId,
              existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, st.target, st.projectNo),
              governanceVerdict: await realPlanVerdict(jobScope.tenantId, st.projectNo, st.target.sheetId),
              writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
            })
            const approved = await largeBomJobs.createLargeBomCheckpointApplyJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId, principal: 's4-02', permission: 'write', createApplyJobId: () => applyJobId,
              writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await st.lock.bumpGeneration(st.key, { reason: 'large_approval', expect })),
            })
            expect(approved.totalDecisions).toBeGreaterThanOrEqual(2)
            // The old small token: minted at the CURRENT generation (after the approval's bump), a real revision shape.
            const oldToken = await st.mintToken('rev_s4_02_old')
            // The project becomes a pilot (seeded directly); the second pull suspends with a candidate.
            await pilotEnter(st)
            const preview = await st.dryRun()
            expect(preview.body.data.status, JSON.stringify(preview.body)).toBe('suspended')
            const row = await openCandidate(st)
            const main0 = await st.main()
            const lock0 = await lockRowOf(st.key)
            const job0 = await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId })
            const confirmed = await confirmViaRoute(st, row)
            expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(201)
            const lock1 = await lockRowOf(st.key)
            const apply = await st.apply(st.users.puller, oldToken)
            const mainAfterApply = await st.main()
            // The chunk ROUTE: PR B's pilot gate refuses the approved job before the lease (R-54 (5) - the pilot code precedes
            // PLAN_SUPERSEDED). The generation statement itself (E03: even sequentially the old decisions never land) is the
            // LIB chunk under a REAL lease: the binding compare inside the lease answers PLAN_SUPERSEDED before the gate and
            // before any write.
            const chunk = await st.chunk(jobId, applyJobId)
            const scoped = await tableActions.createTargetScopedRecordsApi(records, st.target, { fieldIdTranslation: 'pre_mapped' })
            const libChunk = await settle(st.lock.withProjectWriteLease(st.key, { purpose: 'large_apply_chunk', runId: 's4-02-lib', tenantId: st.tenantId }, (guard: any) =>
              largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId: ACTION_ID, applyJobId, recordsApi: scoped, projectWriteGuard: guard, maxDecisionsPerChunk: 1, refreshGovernanceGate: realChunkGate(st.tenantId, st.projectNo, st.refresh) })))
            const observed = {
              confirm: { state: confirmed.body.data.state, generation: confirmed.body.data.generation },
              bump: { generation: Number(lock1.generation) - Number(lock0.generation), reason: lock1.generation_reason, tokenMoved: lock1.generation_token !== lock0.generation_token, leaseFree: lock1.lease_id === null },
              apply: { status: apply.statusCode, code: errorOf(apply).code, reason: errorOf(apply).details && errorOf(apply).details.reason, partial: errorOf(apply).details && errorOf(apply).details.partial },
              mainAfterApply: sameJson(mainAfterApply, main0),
              chunk: { status: chunk.statusCode, code: errorOf(chunk).code, reason: errorOf(chunk).details && errorOf(chunk).details.reason, partial: errorOf(chunk).details && errorOf(chunk).details.partial },
              libChunk: libChunk.ok ? 'ran' : { code: (libChunk as any).error.code, reason: (libChunk as any).error.details && (libChunk as any).error.details.reason, partial: (libChunk as any).error.details && (libChunk as any).error.details.partial },
              mainAfterChunk: sameJson(await st.main(), main0),
              jobUnchanged: sameJson(await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId }), job0),
              continuation: (await q(`SELECT status FROM ${RT.continuation} WHERE tenant_id = $1`, [st.tenantId])).rows.map((entry: any) => entry.status),
              executions: (await st.executions()).map((entry: any) => entry.status),
            }
            console.log(`[S4-02] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              confirm: { state: 'confirmed_pending_execution', generation: Number(lock1.generation) },
              bump: { generation: 1, reason: 'continuation_confirm', tokenMoved: true, leaseFree: true },
              apply: { status: 409, code: PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED, reason: 'newer_plan', partial: false },
              mainAfterApply: true,
              chunk: { status: 409, code: 'STOCK_PREP_PILOT_LARGE_LANE_REFUSED', reason: 'pilot_project', partial: false },
              libChunk: { code: PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED, reason: 'newer_plan', partial: false },
              mainAfterChunk: true,
              jobUnchanged: true,
              continuation: ['active'],
              executions: [],
            })
            await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`stock-preparation:large-bom:%:${st.tenantId}:%`]).catch(() => {})
          }, 300000)

          test('S4-03 (E04) a chunk writes ONE row of the old plan and pauses; while a large_apply_chunk lease is live the ROUTE confirm is WRITE_LOCKED and nothing is confirmed; after release it commits (the bump in the transaction); the next chunk is refused before any write — the pilot gate at the route, PLAN_SUPERSEDED inside a real lease — and no further row of the old plan lands', async () => {
            const st = await s3aStack('s403', { pilot: false })
            await firstPullApplied(st)
            st.state.data = CF.secondPullSource()
            const storage: any = st.pluginContext.storage
            const jobScope = { tenantId: st.tenantId, workspaceId: 'workspace-default' }
            const jobId = `s4_03_${TOKEN}`
            const applyJobId = `s4_03_apply_${TOKEN}`
            const records = st.multitable.records as any
            await largeBomJobs.createLargeBomBackgroundExpansionJob({
              storage, ...jobScope, action: st.action, parameters: { projectNo: st.projectNo }, principal: 's4-03', createJobId: () => jobId,
              writeGenerationObserver: async () => writeObservationFromGeneration(await st.lock.observeGeneration(st.key)),
            })
            await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...jobScope, actionId: ACTION_ID, jobId, sourceAdapter: st.sourceAdapter })
            await largeBomJobs.planLargeBomBackgroundExpansionJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId,
              existingRows: await tableActions.__internals.readExistingStockPreparationRows(records, st.target, st.projectNo),
              governanceVerdict: await realPlanVerdict(jobScope.tenantId, st.projectNo, st.target.sheetId),
              writeGenerationReader: (observed: string) => st.lock.readGeneration(observed),
            })
            const approved = await largeBomJobs.createLargeBomCheckpointApplyJob({
              storage, ...jobScope, actionId: ACTION_ID, jobId, principal: 's4-03', permission: 'write', createApplyJobId: () => applyJobId,
              writeGenerationBinder: async (expect: any) => writeBindingFromGeneration(await st.lock.bumpGeneration(st.key, { reason: 'large_approval', expect })),
            })
            expect(approved.totalDecisions).toBeGreaterThanOrEqual(2)
            const scoped = await tableActions.createTargetScopedRecordsApi(records, st.target, { fieldIdTranslation: 'pre_mapped' })
            const first = await st.lock.withProjectWriteLease(st.key, { purpose: 'large_apply_chunk', runId: 's4-03-first' }, (guard: any) =>
              largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId: ACTION_ID, applyJobId, recordsApi: scoped, projectWriteGuard: guard, maxDecisionsPerChunk: 1, refreshGovernanceGate: realChunkGate(st.tenantId, st.projectNo, st.refresh) }))
            expect(first.status).toBe('paused')
            const mainPaused = await st.main()
            expect(mainPaused.count).toBe(5)
            await pilotEnter(st)
            const preview = await st.dryRun()
            expect(preview.body.data.status, JSON.stringify(preview.body)).toBe('suspended')
            const row = await openCandidate(st)
            // The lease is LIVE (another chunk in flight): the confirm is refused and rolled back.
            const grant = await st.lock.acquire(st.key, { purpose: 'large_apply_chunk', runId: 's4-03-live', tenantId: st.tenantId })
            const stepFour0 = await sheetFingerprint(st.sheetId)
            const locked = await confirmViaRoute(st, row)
            const lockedObserved = { status: locked.statusCode, code: errorOf(locked).code, holder: errorOf(locked).details && errorOf(locked).details.holderPurpose, unchanged: (await sheetFingerprint(st.sheetId)) === stepFour0 }
            await st.lock.createGuard(grant).release()
            const confirmed = await confirmViaRoute(st, row)
            expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(201)
            const job0 = await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId })
            // The next chunk: the ROUTE refuses by the pilot gate before the lease (R-54 (5)); the LIB chunk under a REAL lease
            // is refused by the binding compare (PLAN_SUPERSEDED, the confirm's bump) before the gate and before any write.
            const next = await st.chunk(jobId, applyJobId)
            const libNext = await settle(st.lock.withProjectWriteLease(st.key, { purpose: 'large_apply_chunk', runId: 's4-03-lib', tenantId: st.tenantId }, (guard: any) =>
              largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId: ACTION_ID, applyJobId, recordsApi: scoped, projectWriteGuard: guard, maxDecisionsPerChunk: 1, refreshGovernanceGate: realChunkGate(st.tenantId, st.projectNo, st.refresh) })))
            const observed = {
              locked: lockedObserved,
              confirmed: confirmed.body.data.state,
              reason: (await lockRowOf(st.key)).generation_reason,
              next: { status: next.statusCode, code: errorOf(next).code, reason: errorOf(next).details && errorOf(next).details.reason },
              libNext: libNext.ok ? 'ran' : { code: (libNext as any).error.code, reason: (libNext as any).error.details && (libNext as any).error.details.reason },
              mainUnchanged: sameJson(await st.main(), mainPaused),
              jobUnchanged: sameJson(await largeBomJobs.loadLargeBomCheckpointApplyJob({ storage, ...jobScope, actionId: ACTION_ID, applyJobId }), job0),
              leaseFree: (await lockRowOf(st.key)).lease_id === null,
            }
            console.log(`[S4-03] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              locked: { status: 409, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, holder: 'large_apply_chunk', unchanged: true },
              confirmed: 'confirmed_pending_execution',
              reason: 'continuation_confirm',
              next: { status: 409, code: 'STOCK_PREP_PILOT_LARGE_LANE_REFUSED', reason: 'pilot_project' },
              libNext: { code: PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED, reason: 'newer_plan' },
              mainUnchanged: true,
              jobUnchanged: true,
              leaseFree: true,
            })
            await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`stock-preparation:large-bom:%:${st.tenantId}:%`]).catch(() => {})
          }, 300000)

          test('S4-04 (E09) a BEFORE INSERT trigger on the audit table raising 42501 for this tenant\'s continuation_confirmed row: the ROUTE confirm answers 503 STORE_FAILED audit; every step-4 row, the lock row and the main sheet byte-identical, the hold still open, no continuation; with the trigger gone the same body commits and writes exactly one audit row of that mode', async () => {
            const st = await suspendedPilot('s404')
            const row = await openCandidate(st)
            const fn = `s4_audit_fault_${TOKEN}`
            await q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW.tenant_id = '${st.tenantId}' AND NEW.mode = 'continuation_confirmed' THEN RAISE EXCEPTION 's4 audit fault' USING ERRCODE = '42501'; END IF; RETURN NEW; END $fn$`)
            await q(`CREATE TRIGGER ${fn} BEFORE INSERT ON integration_stock_prep_audit FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
            try {
              const before = await sheetFingerprint(st.sheetId)
              const main0 = await st.main()
              const bound = await readAndBind(st, row)
              const refused = await refreshCall(st, 'POST', RP.confirm, { body: bound.body })
              const observed: Record<string, unknown> = {
                status: refused.statusCode,
                code: errorOf(refused).code,
                details: errorOf(refused).details,
                unchanged: (await sheetFingerprint(st.sheetId)) === before,
                mainUnchanged: sameJson(await st.main(), main0),
                holdOpen: (await st.holds()).find((entry: any) => entry.id === row.id).status,
                continuations: await countWhere(RT.continuation, 'tenant_id = $1', [st.tenantId]),
                confirmedAudits: (await auditRows(st.tenantId)).filter((entry: any) => entry.mode === 'continuation_confirmed').length,
              }
              await q(`DROP TRIGGER IF EXISTS ${fn} ON integration_stock_prep_audit`)
              await q(`DROP FUNCTION IF EXISTS ${fn}()`)
              const committed = await refreshCall(st, 'POST', RP.confirm, { body: bound.body })
              observed.afterRepair = { status: committed.statusCode, continuations: await countWhere(RT.continuation, 'tenant_id = $1', [st.tenantId]), confirmedAudits: (await auditRows(st.tenantId)).filter((entry: any) => entry.mode === 'continuation_confirmed').length }
              console.log(`[S4-04] ${JSON.stringify(observed)}`)
              expect(observed).toEqual({
                status: 503,
                code: RC.STORE_FAILED,
                details: { operation: 'audit', sqlState: '42501', partial: false },
                unchanged: true,
                mainUnchanged: true,
                holdOpen: 'open',
                continuations: 0,
                confirmedAudits: 0,
                afterRepair: { status: 201, continuations: 1, confirmedAudits: 1 },
              })
            } finally {
              await q(`DROP TRIGGER IF EXISTS ${fn} ON integration_stock_prep_audit`).catch(() => {})
              await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
            }
          }, 240000)

          test('S4-05 (A08) two candidate holds claiming the SAME old record (the real candidate and a competing one under another parent) confirmed CONCURRENTLY through the ROUTE from two sessions: exactly one 201, the other 409 CONFIRM_CONFLICT (23505 on the partial unique claim) — one continuation, one hold resolved, the other still open', async () => {
            const st = await suspendedPilot('s405')
            const real = await openCandidate(st)
            const fixtureHold = {
              kind: real.kind, fingerprint: real.fingerprint, confirmable: true, subject: (await q(`SELECT subject, detail, evidence_fingerprint, comparison_fingerprint, pairing_fingerprint FROM ${RT.hold} WHERE id = $1`, [real.id])).rows[0],
            }
            const stored = fixtureHold.subject
            const realHold = { kind: 'continuation_candidate', confirmable: true, fingerprint: real.fingerprint, subject: stored.subject, detail: stored.detail, evidenceFingerprint: stored.evidence_fingerprint, comparisonFingerprint: stored.comparison_fingerprint, pairingFingerprint: stored.pairing_fingerprint }
            const competing = refreshKit.competingCandidateHold(realHold, { parentId: 'Q-001' })
            // Both holds open in ONE computation (the real one kept, the competitor opened).
            await seedOpenHolds(st.refresh.store, st.scope, [realHold, competing], await decisionVersionOf(st.scope))
            const competingRow = (await st.holds()).find((entry: any) => entry.fingerprint === competing.fingerprint && entry.status === 'open')
            expect(competingRow).toBeTruthy()
            const boundA = await readAndBind(st, real)
            const boundB = await readAndBind(st, competingRow)
            const main0 = await st.main()
            const [a, b] = await Promise.all([
              refreshCall(st, 'POST', RP.confirm, { body: boundA.body }),
              refreshCall(st, 'POST', RP.confirm, { body: boundB.body }),
            ])
            const statuses = [a.statusCode, b.statusCode].sort()
            const loser = a.statusCode === 201 ? b : a
            const observed = {
              statuses,
              loser: { code: errorOf(loser).code, reason: errorOf(loser).details && errorOf(loser).details.reason, sqlState: errorOf(loser).details && errorOf(loser).details.sqlState },
              continuations: await countWhere(RT.continuation, 'tenant_id = $1 AND claim_active = true', [st.tenantId]),
              resolvedHolds: (await st.holds()).filter((entry: any) => entry.status === 'resolved').length,
              openHolds: (await st.holds()).filter((entry: any) => entry.status === 'open').length,
              mainUnchanged: sameJson(await st.main(), main0),
            }
            console.log(`[S4-05] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              statuses: [201, 409],
              loser: { code: RC.CONFIRM_CONFLICT, reason: 'claim_taken', sqlState: '23505' },
              continuations: 1,
              resolvedHolds: 1,
              openHolds: 1,
              mainUnchanged: true,
            })
          }, 240000)

          test('S4-06 (U03) on the real stack: the floor operator (read+operate) is 403 FORBIDDEN on all six; a TENANTLESS platform admin 403 OPERATOR_SCOPE_TENANT_REQUIRED; another tenant\'s hold id and an unknown id are the SAME 404; every value read writes exactly one project_board_read row with its mode, values-free; the confirm / keep / end write exception_resolve rows', async () => {
            const st = await suspendedPilot('s406a')
            const other = await suspendedPilot('s406b')
            const row = await openCandidate(st)
            const otherRow = await openCandidate(other)
            const operator = { id: `u_s4_operate_${TOKEN}`, tenantId: st.tenantId, permissions: [access.STOCK_PREP_READ, access.STOCK_PREP_OPERATE] }
            const tenantless = { id: `u_s4_platform_${TOKEN}`, roles: ['admin'], permissions: ['integration:admin'] }
            const everyRoute = async (user: any, holdId: string, continuationId: string) => ({
              holds: await refreshCall(st, 'GET', RP.holds, { user }),
              evidence: await refreshCall(st, 'GET', RP.evidence, { user, params: { holdId } }),
              keep: await refreshCall(st, 'POST', RP.keep, { user, params: { holdId }, body: { confirmProjectNo: st.projectNo } }),
              confirm: await refreshCall(st, 'POST', RP.confirm, { user, body: { confirmProjectNo: st.projectNo, holdId, holdFingerprint: 'a'.repeat(64), comparisonFingerprint: 'b'.repeat(64), evidenceFingerprint: 'c'.repeat(64), candidateId: 'd'.repeat(64), readReceipt: 'e'.repeat(32), basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } } }),
              detail: await refreshCall(st, 'GET', RP.detail, { user, params: { id: continuationId } }),
              end: await refreshCall(st, 'POST', RP.end, { user, params: { id: continuationId }, body: { confirmProjectNo: st.projectNo, revision: 1, outcome: 'escalate_special_repair' } }),
            })
            const codesOf = (answers: Record<string, any>) => Object.fromEntries(Object.entries(answers).map(([route, res]) => [route, `${res.statusCode}:${errorOf(res).code || 'ok'}`]))
            const audits0 = (await auditRows(st.tenantId)).length
            const operatorAnswers = codesOf(await everyRoute(operator, row.id, 'cont_s4_none'))
            const tenantlessAnswers = codesOf(await everyRoute(tenantless, row.id, 'cont_s4_none'))
            const auditsAfterRefusals = (await auditRows(st.tenantId)).length
            // Another tenant's hold id (the same project number on another sheet) vs an unknown id: the same 404s.
            const foreign = codesOf(await everyRoute(st.users.puller, otherRow.id, 'cont_s4_foreign'))
            const unknown = codesOf(await everyRoute(st.users.puller, 'hold_s4_unknown', 'cont_s4_unknown'))
            // Value reads: one audit row each, values-free detail (no component id, no project number, no key).
            const page = dataOf(await refreshCall(st, 'GET', RP.holds))
            const ev = dataOf(await refreshCall(st, 'GET', RP.evidence, { params: { holdId: row.id } }))
            const confirmed = dataOf(await confirmViaRoute(st, row))
            const det = dataOf(await refreshCall(st, 'GET', RP.detail, { params: { id: confirmed.continuationId } }))
            const audits = (await auditRows(st.tenantId)).slice(audits0)
            const auditText = JSON.stringify(audits.map((entry: any) => entry.detail))
            const observed = {
              operator: operatorAnswers,
              tenantless: tenantlessAnswers,
              refusalsWroteNoAudit: auditsAfterRefusals === audits0,
              foreignEqualsUnknown: sameJson(foreign, unknown),
              unknown,
              pageHolds: page.page.holds.length,
              evidenceObservations: ev.current.observations.length,
              detailMembers: det.members.length,
              auditModes: audits.map((entry: any) => `${entry.action}:${entry.mode}`),
              auditValuesFree: !auditText.includes('S-001') && !auditText.includes('P-001') && !auditText.includes(st.projectNo) && !auditText.includes('"path"'),
            }
            console.log(`[S4-06] ${JSON.stringify(observed)}`)
            const forbidden = Object.fromEntries(['holds', 'evidence', 'keep', 'confirm', 'detail', 'end'].map((route) => [route, '403:FORBIDDEN']))
            const tenantRequired = Object.fromEntries(['holds', 'evidence', 'keep', 'confirm', 'detail', 'end'].map((route) => [route, '403:OPERATOR_SCOPE_TENANT_REQUIRED']))
            expect(observed).toEqual({
              operator: forbidden,
              tenantless: tenantRequired,
              refusalsWroteNoAudit: true,
              foreignEqualsUnknown: true,
              unknown: { holds: '200:ok', evidence: `404:${DC.HOLD_NOT_FOUND}`, keep: `404:${DC.HOLD_NOT_FOUND}`, confirm: `404:${DC.HOLD_NOT_FOUND}`, detail: `404:${DC.CONTINUATION_NOT_FOUND}`, end: `404:${DC.CONTINUATION_NOT_FOUND}` },
              pageHolds: 1,
              evidenceObservations: 2,
              detailMembers: 4,
              // the two `holds` reads of the foreign / unknown rounds, the page, the evidence, the confirm's own page read, the confirm, the detail
              auditModes: ['project_board_read:refresh_hold_read', 'project_board_read:refresh_hold_read', 'project_board_read:refresh_hold_read', 'project_board_read:refresh_evidence_read', 'project_board_read:refresh_hold_read', 'exception_resolve:continuation_confirmed', 'project_board_read:continuation_read'],
              auditValuesFree: true,
            })
          }, 300000)

          test('S4-07 (U04) on the real stack: holds paged by cursor (limit 2 over 3), a hold\'s pairs paged by pairCursor (pairLimit 2 over 4) with ONE receipt extended across the pages; a confirm with a half-read receipt is 409 READ_RECEIPT_INCOMPLETE pages_missing and nothing is confirmed; after the last page the same receipt confirms 201; no receipt => 400', async () => {
            const st = await suspendedPilot('s407')
            const row = await openCandidate(st)
            await seedOpenHolds(st.refresh.store, st.scope, [
              { kind: 'continuation_candidate', confirmable: true, fingerprint: row.fingerprint, ...(await (async () => { const stored = (await q(`SELECT subject, detail, evidence_fingerprint, comparison_fingerprint, pairing_fingerprint FROM ${RT.hold} WHERE id = $1`, [row.id])).rows[0]; return { subject: stored.subject, detail: stored.detail, evidenceFingerprint: stored.evidence_fingerprint, comparisonFingerprint: stored.comparison_fingerprint, pairingFingerprint: stored.pairing_fingerprint } })()) },
              contentHold('k_s4_07_a'),
              contentHold('k_s4_07_b'),
            ], await decisionVersionOf(st.scope))
            const first = dataOf(await refreshCall(st, 'GET', RP.holds, { query: { limit: '2' } }))
            const second = dataOf(await refreshCall(st, 'GET', RP.holds, { query: { limit: '2', cursor: first.page.next, receipt: first.readReceipt.id } }))
            const pageA = dataOf(await refreshCall(st, 'GET', RP.holds, { query: { holdId: row.id, pairLimit: '2' } }))
            const entryA = pageA.page.holds[0]
            const half = await refreshCall(st, 'POST', RP.confirm, { body: { confirmProjectNo: st.projectNo, holdId: row.id, holdFingerprint: row.fingerprint, comparisonFingerprint: row.comparison_fingerprint, evidenceFingerprint: row.evidence_fingerprint, candidateId: entryA.pairingFingerprint, readReceipt: pageA.readReceipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } } })
            const continuationsAfterHalf = await countWhere(RT.continuation, 'tenant_id = $1', [st.tenantId])
            const pageB = dataOf(await refreshCall(st, 'GET', RP.holds, { query: { holdId: row.id, pairLimit: '2', pairCursor: '1', receipt: pageA.readReceipt.id } }))
            const noReceipt = await refreshCall(st, 'POST', RP.confirm, { body: { confirmProjectNo: st.projectNo, holdId: row.id, holdFingerprint: row.fingerprint, comparisonFingerprint: row.comparison_fingerprint, evidenceFingerprint: row.evidence_fingerprint, candidateId: entryA.pairingFingerprint, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } } })
            const done = await refreshCall(st, 'POST', RP.confirm, { body: { confirmProjectNo: st.projectNo, holdId: row.id, holdFingerprint: row.fingerprint, comparisonFingerprint: row.comparison_fingerprint, evidenceFingerprint: row.evidence_fingerprint, candidateId: entryA.pairingFingerprint, readReceipt: pageB.readReceipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } } })
            const observed = {
              page1: { holds: first.page.holds.length, next: first.page.next === first.page.holds[1].id },
              page2: { holds: second.page.holds.length, next: second.page.next, sameReceipt: second.readReceipt.id === first.readReceipt.id, receiptHolds: Object.keys(second.readReceipt.holds).length },
              pairPageA: entryA.pairPage,
              pairsA: entryA.candidates[0].pairs.length,
              receiptA: pageA.readReceipt.holds[row.id],
              half: { status: half.statusCode, code: errorOf(half).code, details: errorOf(half).details, continuations: continuationsAfterHalf },
              pairPageB: pageB.page.holds[0].pairPage,
              receiptB: { ...pageB.readReceipt.holds[row.id], sameId: pageB.readReceipt.id === pageA.readReceipt.id },
              noReceipt: { status: noReceipt.statusCode, field: errorOf(noReceipt).details && errorOf(noReceipt).details.field },
              done: { status: done.statusCode, state: done.body.data && done.body.data.state },
              continuations: await countWhere(RT.continuation, 'tenant_id = $1', [st.tenantId]),
            }
            console.log(`[S4-07] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              page1: { holds: 2, next: true },
              page2: { holds: 1, next: null, sameReceipt: true, receiptHolds: 3 },
              pairPageA: { index: 0, count: 2, size: 2, next: 1 },
              pairsA: 2,
              receiptA: { pageCount: 2, pagesServed: [0], complete: false },
              half: { status: 409, code: DC.READ_RECEIPT_INCOMPLETE, details: { reason: 'pages_missing', pagesServed: 1, pageCount: 2, partial: false }, continuations: 0 },
              pairPageB: { index: 1, count: 2, size: 2, next: null },
              receiptB: { pageCount: 2, pagesServed: [0, 1], complete: true, sameId: true },
              noReceipt: { status: 400, field: 'readReceipt' },
              done: { status: 201, state: 'confirmed_pending_execution' },
              continuations: 1,
            })
          }, 240000)
          test('S4-04b (E09, the other direction — review P7) the decision transaction fails AT COMMIT: a DEFERRABLE INITIALLY DEFERRED constraint trigger on this tenant\'s refresh-state row raising 42501 at commit; the ROUTE confirm answers 503 STORE_FAILED commit (never a generic 500); every step-4 row, the lock row and the main sheet byte-identical, the hold open, no continuation and NO audit row (the audit insert rode the rolled-back transaction); with the trigger gone the same body commits with exactly one audit row', async () => {
            const st = await suspendedPilot('s404b')
            const row = await openCandidate(st)
            const fn = `s4_commit_fault_${TOKEN}`
            await q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW.tenant_id = '${st.tenantId}' THEN RAISE EXCEPTION 's4 commit fault' USING ERRCODE = '42501'; END IF; RETURN NULL; END $fn$`)
            await q(`CREATE CONSTRAINT TRIGGER ${fn} AFTER UPDATE ON ${RT.state} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
            try {
              const before = await sheetFingerprint(st.sheetId)
              const main0 = await st.main()
              const lock0 = await lockRowOf(st.key)
              const bound = await readAndBind(st, row)
              const refused = await refreshCall(st, 'POST', RP.confirm, { body: bound.body })
              const observed: Record<string, unknown> = {
                status: refused.statusCode,
                code: errorOf(refused).code,
                details: errorOf(refused).details,
                unchanged: (await sheetFingerprint(st.sheetId)) === before,
                mainUnchanged: sameJson(await st.main(), main0),
                lockUnchanged: sameJson(await lockRowOf(st.key), lock0),
                holdOpen: (await st.holds()).find((entry: any) => entry.id === row.id).status,
                continuations: await countWhere(RT.continuation, 'tenant_id = $1', [st.tenantId]),
                confirmedAudits: (await auditRows(st.tenantId)).filter((entry: any) => entry.mode === 'continuation_confirmed').length,
              }
              await q(`DROP TRIGGER IF EXISTS ${fn} ON ${RT.state}`)
              await q(`DROP FUNCTION IF EXISTS ${fn}()`)
              const committed = await refreshCall(st, 'POST', RP.confirm, { body: bound.body })
              observed.afterRepair = { status: committed.statusCode, continuations: await countWhere(RT.continuation, 'tenant_id = $1', [st.tenantId]), confirmedAudits: (await auditRows(st.tenantId)).filter((entry: any) => entry.mode === 'continuation_confirmed').length }
              console.log(`[S4-04b] ${JSON.stringify(observed)}`)
              expect(observed).toEqual({
                status: 503,
                code: RC.STORE_FAILED,
                details: { operation: 'commit', sqlState: '42501', partial: false },
                unchanged: true,
                mainUnchanged: true,
                lockUnchanged: true,
                holdOpen: 'open',
                continuations: 0,
                confirmedAudits: 0,
                afterRepair: { status: 201, continuations: 1, confirmedAudits: 1 },
              })
            } finally {
              await q(`DROP TRIGGER IF EXISTS ${fn} ON ${RT.state}`).catch(() => {})
              await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
            }
          }, 240000)

          // S4-08 drives the decisions LIB (the exact code the six handlers call) with the context the route builds —
          // real store, real lock, real audit store, real governance consult on PostgreSQL — in the SEQUENTIAL form the
          // execution review used (P6 / P11 / P12): the consult, then what lands, then the decision with the earlier
          // consult. The route itself cannot be paused between its consult and its transaction; the in-request window
          // is proven by the hermetic RT-C7 / RT-C8 / RT-E5 / RT-E6 (the kit's pause hook).
          test('S4-08 (review B1 / N2 / N3, lib level on real PostgreSQL with the route-built context, sequential form) — (a) a computation lands between the end\'s consult and its transaction: N(c) 0 -> 1 => 409 END_OUTCOME_NOT_ADMISSIBLE new_position_present from the open row under the lock (consult-bound and body-bound alike); N(c) 0 -> 0 recomputed => 409 CONFIRM_STALE facts_moved; the relationship stays needs_reconfirmation with its claims, no bump, no audit row; a fresh consult then releases; (b) relationship A escalated between B\'s consult and B\'s release => 409 runbook_only_hold_open under the lock; (c) an apply fails and releases between the confirm\'s consult and its transaction => 409 RECOVERY_PENDING after the bump, the bump rolled back (lock row unchanged), nothing confirmed', async () => {
            const fixture = await refreshKit.candidateHoldFixture()
            const audit = auditStoreLib.createStockPreparationAuditStore({ db: hostLikeDb() })
            const errOf = (settled: any) => (settled.ok ? 'committed' : {
              status: settled.error.status,
              code: settled.error.code,
              reason: settled.error.details && settled.error.details.reason,
              ...(settled.error.details && settled.error.details.componentNewPositionCount !== undefined ? { count: settled.error.details.componentNewPositionCount } : {}),
              ...(settled.error.details && settled.error.details.state !== undefined ? { state: settled.error.details.state, openExecutions: settled.error.details.openExecutions } : {}),
            })
            const reconfirmWithCount = (continuationId: string, count: number | undefined, extra: Record<string, unknown> = {}) => {
              const hold = refreshKit.reconfirmHoldFor(continuationId, { confirmable: false, verdict: 'new_position_removed' })
              hold.detail = { ...hold.detail, ...(count === undefined ? {} : { componentNewPositionCount: count }), ...extra }
              hold.fingerprint = pairingLib.holdFingerprint(hold)
              return hold
            }
            async function stackFor(label: string) {
              const st = await s3aStack(label, { pilot: true })
              const receiptMap = new Map<string, unknown>()
              const receipts = decisionsLib.createReadReceiptStore({ storage: { get: async (key: string) => (receiptMap.has(key) ? receiptMap.get(key) : null), set: async (key: string, value: unknown) => { receiptMap.set(key, value) } } })
              const action = { actionId: st.action.actionId, source: st.action.source }
              const consult = () => st.refresh.governance.consult(st.scope)
              const ctxOf = (consultValue: any) => ({ scope: st.scope, actorId: st.users.puller.id, tenantClaimVerified: true, action, consult: consultValue, store: st.refresh.store, projectWriteLock: st.lock, audit, receipts })
              const seed = (holds: any[], verdicts: Record<string, string> = {}) => decisionVersionOf(st.scope).then((observed) => seedOpenHolds(st.refresh.store, st.scope, holds, observed, verdicts))
              const confirmDirect = async (hold: any) => {
                const idOf = await seed([hold])
                return st.refresh.store.confirmContinuation(confirmInput(st.scope, idOf(hold), hold, fixture, { confirmedBy: st.users.puller.id }), { bumpWithin: st.lock.bumpGenerationWithin })
              }
              const rowOf = async (id: string) => (await q(`SELECT status, claim_active, revision, ended_outcome FROM ${RT.continuation} WHERE id = $1`, [id])).rows[0]
              const openAbout = async (id: string) => (await q(`SELECT id, fingerprint, (detail->>'componentNewPositionCount')::int AS n FROM ${RT.hold} WHERE sheet_id = $1 AND continuation_id = $2 AND status = 'open' ORDER BY opened_at, id`, [st.sheetId, id])).rows
              const audits = async (mode: string) => (await auditRows(st.tenantId)).filter((entry: any) => entry.mode === mode).length
              return { st, store: st.refresh.store, consult, ctxOf, seed, confirmDirect, rowOf, openAbout, audits }
            }
            const observed: Record<string, unknown> = {}
            // (a) the release facts: THE open relationship_reconfirm row under the lock, bound to the hold shown.
            {
              const w = await stackFor('s408a')
              const confirmed = await w.confirmDirect(fixture.hold)
              const id = confirmed.continuationId
              await w.seed([reconfirmWithCount(id, 0)], { [id]: 'new_position_removed' })
              const consultT0 = await w.consult()
              const shown = (await w.openAbout(id))[0]
              await w.seed([reconfirmWithCount(id, 1)], { [id]: 'new_position_removed' })
              const landed = (await w.openAbout(id))[0]
              const lock0 = await lockRowOf(w.st.key)
              const staleConsultBound = await settle(decisionsLib.end(w.ctxOf(consultT0), id, { revision: 1, outcome: 'release_to_normal_refresh' }))
              const staleBodyBound = await settle(decisionsLib.end(w.ctxOf(consultT0), id, { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: landed.id, factsHoldFingerprint: landed.fingerprint }))
              await w.seed([reconfirmWithCount(id, 0, { recomputed: true })], { [id]: 'new_position_removed' })
              const recomputedConsultBound = await settle(decisionsLib.end(w.ctxOf(consultT0), id, { revision: 1, outcome: 'release_to_normal_refresh' }))
              const recomputedBodyBound = await settle(decisionsLib.end(w.ctxOf(consultT0), id, { revision: 1, outcome: 'release_to_normal_refresh', factsHoldId: landed.id, factsHoldFingerprint: landed.fingerprint }))
              const row = await w.rowOf(id)
              observed.a = {
                shownCount: shown.n,
                landedCount: landed.n,
                fingerprintsDiffer: shown.fingerprint !== landed.fingerprint,
                staleConsultBound: errOf(staleConsultBound),
                staleBodyBoundToLanded: errOf(staleBodyBound),
                recomputedConsultBound: errOf(recomputedConsultBound),
                recomputedBodyBoundToLanded: errOf(recomputedBodyBound),
                afterRefusals: {
                  status: row.status,
                  claimActive: row.claim_active,
                  activeMembers: await countWhere(RT.member, 'continuation_id = $1 AND claim_active = true', [id]),
                  openAbout: (await w.openAbout(id)).length,
                  lockUnchanged: sameJson(await lockRowOf(w.st.key), lock0),
                  endedAudits: await w.audits('continuation_ended'),
                },
              }
              const fresh = await settle(decisionsLib.end(w.ctxOf(await w.consult()), id, { revision: 1, outcome: 'release_to_normal_refresh' }))
              observed.aFresh = fresh.ok
                ? { status: fresh.value.status, endedOutcome: fresh.value.endedOutcome, holdsResolved: fresh.value.holdsResolved, claimActive: (await w.rowOf(id)).claim_active, endedAudits: await w.audits('continuation_ended') }
                : errOf(fresh)
            }
            // (b) S25 under the lock for a release: A escalated after B's consult.
            {
              const w = await stackFor('s408b')
              const a = await w.confirmDirect(refreshKit.disjointCandidateHold(fixture.hold, { parentId: 'Y-001', suffix: '_s408b1' }))
              const b = await w.confirmDirect(refreshKit.disjointCandidateHold(fixture.hold, { parentId: 'Y-002', suffix: '_s408b2' }))
              const holdA = refreshKit.reconfirmHoldFor(a.continuationId, { confirmable: false, verdict: 'source_scope_changed' })
              await w.seed([holdA, reconfirmWithCount(b.continuationId, 0)], { [a.continuationId]: 'source_scope_changed', [b.continuationId]: 'new_position_removed' })
              const consultT0 = await w.consult()
              const runbookAtConsult = consultT0.holds.filter((hold: any) => hold.runbookOnly === true).length
              const escalated = await settle(decisionsLib.end(w.ctxOf(consultT0), a.continuationId, { revision: 1, outcome: 'escalate_special_repair' }))
              const lock0 = await lockRowOf(w.st.key)
              const release = await settle(decisionsLib.end(w.ctxOf(consultT0), b.continuationId, { revision: 1, outcome: 'release_to_normal_refresh' }))
              observed.b = {
                runbookAtConsult,
                escalate: errOf(escalated),
                runbookNow: await countWhere(RT.hold, `sheet_id = $1 AND status = 'open' AND runbook_only = true`, [w.st.sheetId]),
                releaseWithStaleConsult: errOf(release),
                bStatus: (await w.rowOf(b.continuationId)).status,
                lockUnchanged: sameJson(await lockRowOf(w.st.key), lock0),
                endedAudits: await w.audits('continuation_ended'),
              }
            }
            // (c) RECOVERY_PENDING under the lock: an apply fails and releases after the confirm's consult.
            {
              const w = await stackFor('s408c')
              const idOf = await w.seed([fixture.hold])
              const holdId = idOf(fixture.hold)
              const consultT0 = await w.consult()
              const ctxT0 = w.ctxOf(consultT0)
              const first = await decisionsLib.listHolds(ctxT0, { holdId })
              const entry = first.page.holds.find((item: any) => item.id === holdId)
              let receipt = first.readReceipt
              const pages = entry.pairPage ? entry.pairPage.count : 1
              for (let index = 1; index < pages; index += 1) receipt = (await decisionsLib.listHolds(ctxT0, { holdId, pairCursor: index, receipt: receipt.id })).readReceipt
              const body = { holdId, holdFingerprint: entry.fingerprint, comparisonFingerprint: entry.comparisonFingerprint, evidenceFingerprint: entry.evidenceFingerprint, candidateId: entry.pairingFingerprint, readReceipt: receipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } }
              const recoveryAtConsult = refreshLanes.previewRecoveryOf(consultT0)
              const grant = await w.st.lock.acquire(w.st.key, { purpose: 'small_apply', runId: 's4-08c-apply', tenantId: w.st.tenantId })
              const guard = w.st.lock.createGuard(grant)
              const execution = await w.store.beginExecution({ ...w.st.scope, lane: 'small_apply', guard: { leaseRunId: 's4-08c-apply', leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch, generation: grant.generation, generationToken: grant.generationToken }, tokenRevision: 'rev_s408c', planDigest: 'plan_s408c', plannedCounts: { add: 1, update: 0, inactive: 0 }, refreshBinding: { continuations: [] }, startedBy: w.st.users.puller.id })
              await w.store.finishExecution({ ...w.st.scope, executionId: execution.id, status: 'failed', written: 0, attemptedWrites: 1, errorCodes: ['SYNTHETIC'] })
              await guard.release()
              const lock0 = await lockRowOf(w.st.key)
              const stale = await settle(decisionsLib.confirm(ctxT0, body))
              observed.c = {
                recoveryAtConsult,
                leaseFreeBeforeConfirm: lock0.lease_id === null,
                staleConfirm: errOf(stale),
                continuations: await countWhere(RT.continuation, 'tenant_id = $1', [w.st.tenantId]),
                holdOpen: (await w.st.holds()).find((row: any) => row.id === holdId).status,
                lockUnchanged: sameJson(await lockRowOf(w.st.key), lock0),
                confirmedAudits: await w.audits('continuation_confirmed'),
                freshPreviewRecovery: refreshLanes.previewRecoveryOf(await w.consult()),
              }
            }
            console.log(`[S4-08] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              a: {
                shownCount: 0,
                landedCount: 1,
                fingerprintsDiffer: true,
                staleConsultBound: { status: 409, code: RC.END_OUTCOME_NOT_ADMISSIBLE, reason: 'new_position_present', count: 1 },
                staleBodyBoundToLanded: { status: 409, code: RC.END_OUTCOME_NOT_ADMISSIBLE, reason: 'new_position_present', count: 1 },
                recomputedConsultBound: { status: 409, code: RC.CONFIRM_STALE, reason: 'facts_moved' },
                recomputedBodyBoundToLanded: { status: 409, code: RC.CONFIRM_STALE, reason: 'facts_moved' },
                afterRefusals: { status: 'needs_reconfirmation', claimActive: true, activeMembers: 4, openAbout: 1, lockUnchanged: true, endedAudits: 0 },
              },
              aFresh: { status: 'ended', endedOutcome: 'release_to_normal_refresh', holdsResolved: 1, claimActive: false, endedAudits: 1 },
              b: {
                runbookAtConsult: 0,
                escalate: 'committed',
                runbookNow: 1,
                releaseWithStaleConsult: { status: 409, code: RC.END_OUTCOME_NOT_ADMISSIBLE, reason: 'runbook_only_hold_open' },
                bStatus: 'needs_reconfirmation',
                lockUnchanged: true,
                endedAudits: 1,
              },
              c: {
                recoveryAtConsult: null,
                leaseFreeBeforeConfirm: true,
                staleConfirm: { status: 409, code: RC.RECOVERY_PENDING, reason: undefined, state: 'failed_pending_recovery', openExecutions: 1 },
                continuations: 0,
                holdOpen: 'open',
                lockUnchanged: true,
                confirmedAudits: 0,
                freshPreviewRecovery: { pending: true, openExecutions: 1 },
              },
            })
          }, 300000)
        })

        // ── S5: batch-refresh step 4 PR-5 — THE FORMAL-EXPORT GATE on the real stack ─────────────────────────────
        // Nested in S3A for its stack (`s3aStack` + `exportLines`), its fixtures and its cleanup. Each case drives the
        // REAL export route over the production host, lock, registry, the REAL refresh reader and store, and real
        // migrations 100-103 (design §11, §23.7 O-21 as replaced; plan §5.3 U01 / U02 / U07 / C10):
        //   S5-01 (U01) every unfinished state, each produced by the real lanes or the real store (pending_confirmation,
        //         confirmed_pending_execution, executed_pending_settlement, failed_pending_recovery, executing): the
        //         export is 409 BLOCKED naming the state, nothing streamed, one export_refused audit row, zero delivered;
        //         the overview posture over the SAME derived state is never 「可以导出」 — with no confirmation ledger at
        //         all (the pending count is not an input).
        //   S5-02 (U02, G8) the clean governed flow to 已完成 (first pull, suspended second pull, confirm, re-preview and
        //         apply, the settling preview): 200 with the 沿用说明 column on exactly the four continued rows, the S
        //         root once with its own quantity, the audit row's tokens; then the interleavings on the SAME sheet
        //         through hookable lock views: (a) a lease taken after G0 => executing; (b) a lease taken and released
        //         during the file build => G1 epoch moved; (c) a bump during the build => G1 token moved; (d) a lease
        //         live at G1; (e) THE REVIEWER'S zero-write FAILED execution inside C2's snapshot-to-lock-read gap:
        //         both consults answer complete, the digest is intact, G1's epoch refuses; afterwards failed_pending_recovery;
        //         (f) the same failure before G0 => C1 refuses; (g) the positive control: a zero-write SELF-SETTLED
        //         success before G0 => 200.
        //   S5-03 (B-M6 / A12) a human fill after the settlement exports; a HOST-side machine write refuses
        //         SHEET_CHANGED_SINCE_SETTLEMENT; the next preview raises the content hold and the export stays refused.
        //   S5-04 (A11) the step-4 tables absent from the store binding (42P01): 503 STATE_UNREADABLE, never complete.
        //   S5-05 (C10 (c) / U07, E-2) pilot exit with an open hold: still 409; switch off with a pilot registry row on
        //         the managed sheet: 409 RETARGETED before any row read — both audited export_refused.
        //   S5-06 (C09) a registered NOT-governed project: 200 with the pre-PR-5 headers and audit detail keys; 0
        //         step-4 rows written by the export.
        describe('S5 step-4 formal export gate (real Postgres, real lock, real host, real reader)', () => {
          const overviewLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-overview.cjs')) as any
          const prepLineExportLib = require(path.join(PLUGIN_LIB, 'stock-preparation-prep-line-export.cjs')) as any
          const EXPORT_HEADERS: string[] = prepLineExportLib.EXPORT_COLUMNS.map((column: any) => column.label)
          const CODE_INDEX: number = prepLineExportLib.EXPORT_COLUMNS.findIndex((column: any) => column.id === 'componentCode')
          const QTY_INDEX: number = prepLineExportLib.EXPORT_COLUMNS.findIndex((column: any) => column.id === 'totalQuantity')
          const BLOCKED = 'STOCK_PREP_EXPORT_BLOCKED'
          const STATE_CHANGED = 'STOCK_PREP_EXPORT_STATE_CHANGED'
          const SHEET_CHANGED = 'STOCK_PREP_EXPORT_SHEET_CHANGED_SINCE_SETTLEMENT'
          const UNREADABLE = 'STOCK_PREP_EXPORT_STATE_UNREADABLE'

          // A hookable view of one lock module (the real table underneath): `beforeReadState(n)`, `beforeReadGeneration(n)`,
          // `afterReadGeneration(n, answer)`, counted per view; `reset()` between export calls.
          function hookable(raw: any) {
            const hooks: Record<string, any> = {}
            const counters = { readState: 0, readGeneration: 0 }
            const view = Object.freeze({
              ...raw,
              readState: async (scopeKey: string) => {
                counters.readState += 1
                if (hooks.beforeReadState) await hooks.beforeReadState(counters.readState)
                return raw.readState(scopeKey)
              },
              readGeneration: async (scopeKey: string) => {
                counters.readGeneration += 1
                if (hooks.beforeReadGeneration) await hooks.beforeReadGeneration(counters.readGeneration)
                const answer = await raw.readGeneration(scopeKey)
                if (hooks.afterReadGeneration) await hooks.afterReadGeneration(counters.readGeneration, answer)
                return answer
              },
            })
            return { view, hooks, counters, reset() { counters.readState = 0; counters.readGeneration = 0; for (const key of Object.keys(hooks)) delete hooks[key] } }
          }

          /** The export audit rows of one tenant: delivered vs refused details (values-free). */
          async function exportAudit(tenantId: string) {
            const rows = (await q('SELECT mode, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = $2 ORDER BY created_at, id', [tenantId, 'prep_line_export'])).rows
            return {
              delivered: rows.filter((row: any) => row.mode !== 'export_refused').map((row: any) => row.detail),
              refused: rows.filter((row: any) => row.mode === 'export_refused').map((row: any) => row.detail),
            }
          }
          const answerOf = (res: any) => {
            const error = errorOf(res)
            const details = error.details || {}
            return `${res.statusCode}:${error.code || 'ok'}:${details.reason || ''}:${details.status || ''}`
          }
          const workbookOf = (res: any) => (res.statusCode === 200 && Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString('utf8')) : null)
          const streamed = (res: any) => Buffer.isBuffer(res.body)
          const postureOf = (state: any) => overviewLib.projectOverviewPosture({ pulledRowCount: 4, refreshStatus: state.status, refreshSettled: state.settled, refreshPendingConfirmCount: state.counts ? state.counts.pendingConfirm : 0 }).key

          /** A stack whose route lock and reader lock are hookable views over the real table; the reader's answers are recorded. */
          async function s5Stack(label: string, options: Record<string, any> = {}) {
            const rawLock = createStockPreparationProjectWriteLock({ db: hostLikeDb() })
            const route = hookable(rawLock)
            const reader = hookable(rawLock)
            const store = continuationStoreLib.createStockPreparationContinuationStore({ db: hostLikeDb() })
            const governance = refreshGovernanceLib.createStockPreparationRefreshGovernance({
              continuationStore: store,
              projectTargetStore: projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: hostLikeDb() }),
              projectWriteLock: reader.view,
            })
            const seen: string[] = []
            const governanceView = Object.freeze({
              ...governance,
              readRefreshState: async (scope: any) => {
                const read = await governance.readRefreshState(scope)
                seen.push(read.state.status)
                return read
              },
            })
            const xlsx = { calls: 0, hooks: {} as Record<string, any> }
            const st = await s3aStack(label, {
              pilot: true,
              ...options,
              refresh: { governance: governanceView, store },
              routeLock: route.view,
              serviceExtras: {
                stockPreparationXlsxExport: {
                  async buildWorkbookBuffer(params: any) {
                    xlsx.calls += 1
                    if (xlsx.hooks.afterBuild) await xlsx.hooks.afterBuild()
                    return Buffer.from(JSON.stringify(params), 'utf8')
                  },
                },
              },
            })
            return {
              ...st, route, reader, xlsx, rawLock, seen,
              resetHooks() { route.reset(); reader.reset(); xlsx.hooks = {}; seen.length = 0 },
              settledDigest: async () => ((await q(`SELECT settled_sheet_machine_digest AS d FROM ${RT.state} WHERE sheet_id = $1 AND project_no = $2`, [st.sheetId, st.projectNo])).rows[0] || {}).d || null,
            }
          }

          /** The clean governed flow to 已完成: first pull applied, second pull suspended, confirm, re-preview + apply, the settling preview. */
          async function settledContinuation(st: any) {
            await firstPullApplied(st)
            st.state.data = CF.secondPullSource()
            const suspended = await st.dryRun()
            expect(suspended.body.data.status, JSON.stringify(suspended.body)).toBe('suspended')
            const confirmed = await confirmOpenCandidate(st)
            const ready = await st.dryRun()
            expect(ready.body.data.status, JSON.stringify(ready.body)).toBe('ready')
            const applied = await st.apply(st.users.puller, ready.body.data.dryRunToken)
            expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
            expect(applied.body.data.status).toBe('succeeded')
            // 已执行待核对: the export refuses until a clean computation settles the written rows.
            const unsettled = await st.exportLines()
            expect(answerOf(unsettled)).toBe(`409:${BLOCKED}:state:executed_pending_settlement`)
            expect(streamed(unsettled)).toBe(false)
            const settling = await st.dryRun()
            expect(settling.body.data.status, JSON.stringify(settling.body)).toBe('ready')
            return { confirmed }
          }

          /** A WHOLE zero-write execution on the real lock and store: acquire (epoch + 1), begin, finish, release. */
          async function zeroWriteRun(st: any, status: 'failed' | 'succeeded', { settle = false }: { settle?: boolean } = {}) {
            const runId = `s5_${status}_${TOKEN}_${Date.now().toString(36)}`
            const grant = await st.rawLock.acquire(st.key, { purpose: 'small_apply', runId, tenantId: st.tenantId })
            const gen = await st.rawLock.readGeneration(st.key)
            const begun = await st.refresh.store.beginExecution({
              ...st.scope, lane: 'small_apply',
              guard: { leaseRunId: runId, leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch, generation: gen.generation, generationToken: gen.generationToken },
              tokenRevision: 'rev_s5', planDigest: 'e'.repeat(64), plannedCounts: { add: 0, update: 0, inactive: 0 }, refreshBinding: { continuations: [], holdSetFingerprint: null }, startedBy: 'u_s5',
            })
            await st.refresh.store.finishExecution({
              ...st.scope, executionId: begun.id, status, written: 0, attemptedWrites: 0,
              ...(settle ? { settlement: { generationToken: gen.generationToken, sourceContentDigest: 'c'.repeat(64), sheetMachineDigest: await st.settledDigest() } } : {}),
            })
            await st.rawLock.createGuard(grant).release()
            return begun
          }

          test('S5-01 (U01) every unfinished state refuses the formal export 409 BLOCKED naming it, streams nothing and audits export_refused; the overview posture over the same derived state is never 可以导出; no confirmation ledger exists on this stack (the pending count is not an input)', async () => {
            const observed: Record<string, unknown> = {}
            // pending_confirmation: the second pull of a pilot project is suspended by its candidate hold.
            {
              const st = await s3aStack('s5_01p', { pilot: true })
              await firstPullApplied(st)
              st.state.data = CF.secondPullSource()
              expect((await st.dryRun()).body.data.status).toBe('suspended')
              const res = await st.exportLines()
              const state = derive(await st.refresh.governance.consult(st.scope))
              const audit = await exportAudit(st.tenantId)
              observed.pending_confirmation = { answer: answerOf(res), streamed: streamed(res), posture: postureOf(state), refused: audit.refused.length, delivered: audit.delivered.length, refusal: audit.refused[0] && audit.refused[0].refusal }
              // confirmed_pending_execution: the candidate confirmed through the REAL store, not yet executed.
              await confirmOpenCandidate(st)
              const res2 = await st.exportLines()
              const state2 = derive(await st.refresh.governance.consult(st.scope))
              observed.confirmed_pending_execution = { answer: answerOf(res2), streamed: streamed(res2), posture: postureOf(state2) }
            }
            // executed_pending_settlement: the first pull wrote four rows; no clean computation has settled them yet.
            {
              const st = await s3aStack('s5_01e', { pilot: true })
              await firstPullApplied(st)
              const res = await st.exportLines()
              const state = derive(await st.refresh.governance.consult(st.scope))
              observed.executed_pending_settlement = { answer: answerOf(res), streamed: streamed(res), posture: postureOf(state) }
              // failed_pending_recovery: a settled project, then a seeded FAILED execution (S3A-13's recipe).
              expect((await st.dryRun()).body.data.status).toBe('ready')
              const gen = await st.generation()
              const begun = await st.refresh.store.beginExecution({
                ...st.scope, lane: 'small_apply',
                guard: { leaseRunId: `run_s5_dead_${TOKEN}`, leaseId: `lease_s5_dead_${TOKEN}`, fencingEpoch: 1, generation: gen.generation, generationToken: gen.generationToken },
                tokenRevision: 'rev_s5_dead', planDigest: 'a'.repeat(64), plannedCounts: { add: 1, update: 0, inactive: 0 }, refreshBinding: { continuations: [], holdSetFingerprint: null }, startedBy: 'u_s5_dead',
              })
              await st.refresh.store.finishExecution({ ...st.scope, executionId: begun.id, status: 'failed', written: 1, attemptedWrites: 1, errorCodes: ['E_S5'] })
              const res2 = await st.exportLines()
              const state2 = derive(await st.refresh.governance.consult(st.scope))
              observed.failed_pending_recovery = { answer: answerOf(res2), streamed: streamed(res2), posture: postureOf(state2) }
            }
            // executing: a live lease on the sheet (a writer in flight).
            {
              const st = await s3aStack('s5_01x', { pilot: true })
              await firstPullApplied(st)
              expect((await st.dryRun()).body.data.status).toBe('ready')
              const grant = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: `run_s5_live_${TOKEN}`, tenantId: st.tenantId })
              try {
                const res = await st.exportLines()
                const state = derive(await st.refresh.governance.consult(st.scope))
                observed.executing = { answer: answerOf(res), streamed: streamed(res), posture: postureOf(state) }
              } finally {
                await st.lock.createGuard(grant).release()
              }
            }
            console.log(`[S5-01] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              pending_confirmation: { answer: `409:${BLOCKED}:state:pending_confirmation`, streamed: false, posture: 'blocked_pull_state', refused: 1, delivered: 0, refusal: BLOCKED },
              confirmed_pending_execution: { answer: `409:${BLOCKED}:state:confirmed_pending_execution`, streamed: false, posture: 'blocked_pull_state' },
              executed_pending_settlement: { answer: `409:${BLOCKED}:state:executed_pending_settlement`, streamed: false, posture: 'blocked_pull_state' },
              failed_pending_recovery: { answer: `409:${BLOCKED}:state:failed_pending_recovery`, streamed: false, posture: 'blocked_pull_state' },
              executing: { answer: `409:${BLOCKED}:state:executing`, streamed: false, posture: 'blocked_pull_state' },
            })
          }, 300000)

          test('S5-02 (U02, G8, O-21) the clean governed flow exports 200 with the 沿用说明 column and no duplicated quantity; then, on the same sheet, every interleaving — a lease after G0, a lease taken and released during the build, a bump during the build, a lease live at G1, THE REVIEWER\'S zero-write failure inside C2\'s snapshot-to-lock-read gap, the same failure before G0 — refuses with nothing streamed; a zero-write self-settled success is the positive control', async () => {
            const st = await s5Stack('s5_02')
            const { confirmed } = await settledContinuation(st)
            const observed: Record<string, unknown> = {}
            st.resetHooks()
            const clean = await st.exportLines()
            const workbook = workbookOf(clean)
            const audit0 = await exportAudit(st.tenantId)
            const noted = workbook ? workbook.rows.filter((row: any[]) => row[row.length - 1] !== '') : []
            const codes: string[] = workbook ? workbook.rows.map((row: any[]) => row[CODE_INDEX]) : []
            observed.clean = {
              status: clean.statusCode,
              headers: workbook ? (workbook.headers.slice(0, -1).join('|') === EXPORT_HEADERS.join('|') ? 'export_columns' : 'other') : null,
              lastHeader: workbook ? workbook.headers[workbook.headers.length - 1] : null,
              notedRows: noted.length,
              note: noted.length ? noted[0][noted[0].length - 1] : null,
              sRootRows: codes.filter((code) => code === 'D100-01-03').length,
              sRootQty: workbook ? (workbook.rows.find((row: any[]) => row[CODE_INDEX] === 'D100-01-03') || [])[QTY_INDEX] : null,
              duplicatedCodes: codes.length - new Set(codes).size,
              consults: st.seen.slice(),
              routeGenerationReads: st.route.counters.readGeneration,
              delivered: audit0.delivered.length,
              deliveredDetail: audit0.delivered[audit0.delivered.length - 1],
              refusedBefore: audit0.refused.length,
            }
            // (a) a lease taken right after G0: C1 derives executing.
            st.resetHooks()
            let grant: any = null
            st.route.hooks.afterReadGeneration = async (n: number) => { if (n === 1) grant = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: `run_s5_a_${TOKEN}`, tenantId: st.tenantId }) }
            const a = await st.exportLines()
            await st.lock.createGuard(grant).release()
            observed.leaseAfterG0 = { answer: answerOf(a), streamed: streamed(a) }
            // (b) a lease taken AND released while the file is built (no execution row): only the epoch moved.
            st.resetHooks()
            st.xlsx.hooks.afterBuild = async () => { const g = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: `run_s5_b_${TOKEN}`, tenantId: st.tenantId }); await st.lock.createGuard(g).release() }
            const b = await st.exportLines()
            observed.leaseDuringBuild = { answer: answerOf(b), streamed: streamed(b), epochMoved: errorOf(b).details && errorOf(b).details.epochMoved, generationMoved: errorOf(b).details && errorOf(b).details.generationMoved, consults: st.seen.slice() }
            // (c) a bump (an applicable preview) while the file is built: the token moved.
            st.resetHooks()
            st.xlsx.hooks.afterBuild = async () => { await st.lock.bumpGeneration(st.key, { reason: 'small_preview', tenantId: st.tenantId }) }
            const c = await st.exportLines()
            observed.bumpDuringBuild = { answer: answerOf(c), streamed: streamed(c), generationMoved: errorOf(c).details && errorOf(c).details.generationMoved }
            // (d) a lease live at G1 (taken after C2's lock read, still held).
            st.resetHooks()
            grant = null
            st.route.hooks.beforeReadGeneration = async (n: number) => { if (n === 2) grant = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: `run_s5_d_${TOKEN}`, tenantId: st.tenantId }) }
            const d = await st.exportLines()
            await st.lock.createGuard(grant).release()
            observed.leaseAtG1 = { answer: answerOf(d), streamed: streamed(d) }
            // Control: nothing moved since — the export is deliverable again (the gate wrote nothing).
            st.resetHooks()
            const again = await st.exportLines()
            observed.again = { status: again.statusCode, consults: st.seen.slice() }
            // (e) THE REVIEWER'S interleaving: C2's REPEATABLE READ snapshot is taken (complete, settled); before C2's lock
            //     read a WHOLE zero-write FAILED execution lands (acquire = epoch + 1, begin, finish failed, release); C2's lock
            //     read sees no lease, so C2 derives complete; the digest is intact (nothing written); G1's epoch refuses.
            st.resetHooks()
            const executionsBefore = (await st.executions()).length
            st.reader.hooks.beforeReadState = async (n: number) => { if (n === 2) await zeroWriteRun(st, 'failed') }
            const e = await st.exportLines()
            observed.reviewerGap = {
              answer: answerOf(e), streamed: streamed(e),
              epochMoved: errorOf(e).details && errorOf(e).details.epochMoved, generationMoved: errorOf(e).details && errorOf(e).details.generationMoved,
              consults: st.seen.slice(), executionsAdded: (await st.executions()).length - executionsBefore,
              failedRows: (await st.executions()).filter((row: any) => row.status === 'failed').length,
            }
            // Afterwards the state is honest: C1 of the next export sees the failure.
            st.resetHooks()
            const after = await st.exportLines()
            observed.afterReviewerGap = { answer: answerOf(after), streamed: streamed(after) }
            const auditEnd = await exportAudit(st.tenantId)
            observed.audit = { delivered: auditEnd.delivered.length, refused: auditEnd.refused.length, refusals: auditEnd.refused.map((row: any) => `${row.refusal}:${row.reason || ''}`) }
            // (e2) the report's last named boundary, on a fresh settled sheet: the same whole failed run BETWEEN C2's two
            //      lock reads (after the reader's readState, before its readGeneration): C2 derives complete; G1 refuses.
            const e2 = await s5Stack('s5_02e2')
            await settledContinuation(e2)
            e2.resetHooks()
            e2.reader.hooks.beforeReadGeneration = async (n: number) => { if (n === 2) await zeroWriteRun(e2, 'failed') }
            const e2Res = await e2.exportLines()
            observed.betweenC2LockReads = { answer: answerOf(e2Res), streamed: streamed(e2Res), epochMoved: errorOf(e2Res).details && errorOf(e2Res).details.epochMoved, consults: e2.seen.slice(), failedRows: (await e2.executions()).filter((row: any) => row.status === 'failed').length }
            console.log(`[S5-02] ${JSON.stringify(observed)}`)
            const handle = String(confirmed.continuationId).slice(-8)
            expect(observed).toEqual({
              clean: {
                status: 200, headers: 'export_columns', lastHeader: '沿用说明', notedRows: 4, note: `由 D100-01 沿用（父边用量 2，关系 ${handle}）`,
                sRootRows: 1, sRootQty: 10, duplicatedCodes: 0, consults: ['complete', 'complete'], routeGenerationReads: 2,
                delivered: 1, deliveredDetail: { operation: 'prep_line_export', totalRowCount: 6, activeRowCount: 6, columnCount: 29, refreshState: 'complete', continuationCount: 1, continuedRowCount: 4 },
                refusedBefore: 1,
              },
              leaseAfterG0: { answer: `409:${BLOCKED}:state:executing`, streamed: false },
              leaseDuringBuild: { answer: `409:${STATE_CHANGED}:generation_moved:`, streamed: false, epochMoved: true, generationMoved: false, consults: ['complete', 'complete'] },
              bumpDuringBuild: { answer: `409:${STATE_CHANGED}:generation_moved:`, streamed: false, generationMoved: true },
              leaseAtG1: { answer: `409:${STATE_CHANGED}:lease_in_flight:`, streamed: false },
              again: { status: 200, consults: ['complete', 'complete'] },
              reviewerGap: { answer: `409:${STATE_CHANGED}:generation_moved:`, streamed: false, epochMoved: true, generationMoved: false, consults: ['complete', 'complete'], executionsAdded: 1, failedRows: 1 },
              afterReviewerGap: { answer: `409:${BLOCKED}:state:failed_pending_recovery`, streamed: false },
              audit: { delivered: 2, refused: 7, refusals: [`${BLOCKED}:state`, `${BLOCKED}:state`, `${STATE_CHANGED}:generation_moved`, `${STATE_CHANGED}:generation_moved`, `${STATE_CHANGED}:lease_in_flight`, `${STATE_CHANGED}:generation_moved`, `${BLOCKED}:state`] },
              betweenC2LockReads: { answer: `409:${STATE_CHANGED}:generation_moved:`, streamed: false, epochMoved: true, consults: ['complete', 'complete'], failedRows: 1 },
            })
            // (f) the same failure completed BEFORE G0, on a fresh settled sheet: C1's own snapshot refuses it.
            const f = await s5Stack('s5_02f')
            await settledContinuation(f)
            await zeroWriteRun(f, 'failed')
            f.resetHooks()
            const fRes = await f.exportLines()
            // (g) the positive control: a zero-write SELF-SETTLED success before G0 on another fresh settled sheet: 200.
            const g = await s5Stack('s5_02g')
            await settledContinuation(g)
            await zeroWriteRun(g, 'succeeded', { settle: true })
            g.resetHooks()
            const gRes = await g.exportLines()
            const tail = { failureBeforeG0: { answer: answerOf(fRes), streamed: streamed(fRes), consults: f.seen.slice() }, selfSettledSuccess: { status: gRes.statusCode, refreshState: ((await exportAudit(g.tenantId)).delivered.pop() || {}).refreshState, consults: g.seen.slice() } }
            console.log(`[S5-02 f/g] ${JSON.stringify(tail)}`)
            expect(tail).toEqual({
              failureBeforeG0: { answer: `409:${BLOCKED}:state:failed_pending_recovery`, streamed: false, consults: ['failed_pending_recovery'] },
              selfSettledSuccess: { status: 200, refreshState: 'complete', consults: ['complete', 'complete'] },
            })
          }, 600000)

          test('S5-03 (B-M6 / A12) after the settlement a human fill still exports; a HOST-side machine-column write refuses SHEET_CHANGED_SINCE_SETTLEMENT (the file built, nothing streamed); the next preview raises the content hold and the export stays refused pending_confirmation', async () => {
            const st = await s5Stack('s5_03')
            await settledContinuation(st)
            const fields = st.target.fieldIdMap
            const rows = await st.rows()
            const root = rows.find((row: any) => row.data[fields.componentSourceId || 'componentSourceId'] === 'S-001' && JSON.parse(String(row.data[fields.path || 'path'])).length === 1)
            expect(root, 'the old S-001 root row').toBeTruthy()
            await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: root.id, changes: { [fields.notes || 'notes']: 'synthetic human fill' } })
            st.resetHooks()
            const human = await st.exportLines()
            await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: root.id, changes: { [fields.material || 'material']: 'M-HOST-EDITED' } })
            st.resetHooks()
            const machine = await st.exportLines()
            const preview = await st.dryRun()
            st.resetHooks()
            const afterPreview = await st.exportLines()
            const observed = {
              human: { status: human.statusCode, streamed: streamed(human) },
              machine: { answer: answerOf(machine), streamed: streamed(machine), fileBuilt: st.xlsx.calls > 0 },
              preview: preview.body.data && preview.body.data.status,
              afterPreview: { answer: answerOf(afterPreview), streamed: streamed(afterPreview) },
            }
            console.log(`[S5-03] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              human: { status: 200, streamed: true },
              machine: { answer: `409:${SHEET_CHANGED}:machine_columns_changed:`, streamed: false, fileBuilt: true },
              preview: 'suspended',
              afterPreview: { answer: `409:${BLOCKED}:state:pending_confirmation`, streamed: false },
            })
          }, 300000)

          test('S5-04 (A11 / G1) the step-4 tables ABSENT from the store binding (42P01 — a pre-102/103 database; the registry readable): the export is 503 STATE_UNREADABLE naming the store, nothing streamed, one export_refused row — never complete', async () => {
            const client = await poolManager.get().getInternalPool().connect()
            const schema = `s5_nostep4_${TOKEN}`
            try {
              await client.query(`CREATE SCHEMA ${schema}`)
              await client.query(`CREATE VIEW ${schema}.integration_stock_prep_project_target AS SELECT * FROM public.integration_stock_prep_project_target`)
              await client.query(`SET search_path TO ${schema}`)
              const st = await s3aStack('s5_04', { pilot: false, refresh: realRefreshServices(dbOn(client)) })
              const res = await st.exportLines()
              const audit = await exportAudit(st.tenantId)
              const observed = { answer: answerOf(res), store: errorOf(res).details && errorOf(res).details.store, streamed: streamed(res), refused: audit.refused.length, delivered: audit.delivered.length, refusal: audit.refused[0] && `${audit.refused[0].refusal}:${audit.refused[0].store}` }
              console.log(`[S5-04] ${JSON.stringify(observed)}`)
              expect(observed).toEqual({ answer: `503:${UNREADABLE}:unreadable:`, store: 'continuation', streamed: false, refused: 1, delivered: 0, refusal: `${UNREADABLE}:continuation` })
              // Step-4 review follow-ups (item 1, #6566 N1): the row keeps the export's own operation through the real
              // jsonb round trip; the store's operation rides along as storeOperation.
              expect({ operation: audit.refused[0].operation, storeOperation: audit.refused[0].storeOperation }).toEqual({ operation: 'prep_line_export', storeOperation: 'read_continuations' })
            } finally {
              await client.query('RESET search_path').catch(() => {})
              await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
              client.release()
            }
          }, 300000)

          test('S5-05 (C10 (c) / U07, E-2) pilot exit with an open hold keeps the export refused; switch OFF with a pilot registry row on the managed sheet refuses 409 RETARGETED before any row read — both audited export_refused, nothing streamed', async () => {
            const exit = await s3aStack('s5_05x', { pilot: true })
            await firstPullApplied(exit)
            exit.state.data = CF.secondPullSource()
            expect((await exit.dryRun()).body.data.status).toBe('suspended')
            await exit.pilotExit()
            const afterExit = await exit.exportLines()
            const exitAudit = await exportAudit(exit.tenantId)
            const retargeted = await s3aStack('s5_05r', { pilot: true, switchOn: false })
            const envMain0 = await retargeted.main(retargeted.envTarget.sheetId)
            const res = await retargeted.exportLines()
            const rAudit = await exportAudit(retargeted.tenantId)
            const observed = {
              pilotExit: { answer: answerOf(afterExit), streamed: streamed(afterExit), refused: exitAudit.refused.length, delivered: exitAudit.delivered.length },
              retarget: { answer: answerOf(res), streamed: streamed(res), refused: rAudit.refused.length, refusal: rAudit.refused[0] && rAudit.refused[0].refusal, envUnchanged: sameJson(await retargeted.main(retargeted.envTarget.sheetId), envMain0), stepFourRows: await retargeted.stepFourRows() },
            }
            console.log(`[S5-05] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              pilotExit: { answer: `409:${BLOCKED}:state:pending_confirmation`, streamed: false, refused: 1, delivered: 0 },
              retarget: { answer: `409:${RETARGETED}:project_registered_on_another_sheet:`, streamed: false, refused: 1, refusal: RETARGETED, envUnchanged: true, stepFourRows: 0 },
            })
          }, 300000)

          test('S5-06 (C09, O-9) a registered NOT-governed project exports 200 with the pre-PR-5 headers and audit detail keys; the export writes no step-4 row; under a LIVE lease the same project is refused 409 lease_in_flight (the derived state hides the lease — the gate\'s own lock read sees it) and exports again once released', async () => {
            const st = await s3aStack('s5_06', { pilot: false })
            await firstPullApplied(st)
            expect(await st.stepFourRows()).toBe(0)
            const res = await st.exportLines()
            const workbook = workbookOf(res)
            const audit = await exportAudit(st.tenantId)
            const grant = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: `run_s5_06_live_${TOKEN}`, tenantId: st.tenantId })
            let leased: any
            try {
              leased = await st.exportLines()
            } finally {
              await st.lock.createGuard(grant).release()
            }
            const released = await st.exportLines()
            const auditEnd = await exportAudit(st.tenantId)
            const observed = {
              status: res.statusCode,
              headers: workbook ? (workbook.headers.join('|') === EXPORT_HEADERS.join('|') ? 'export_columns_exactly' : 'other') : null,
              rows: workbook ? workbook.rows.length : null,
              detailKeys: audit.delivered[0] ? Object.keys(audit.delivered[0]).sort() : null,
              columnCount: audit.delivered[0] && audit.delivered[0].columnCount,
              refused: audit.refused.length,
              stepFourRows: await st.stepFourRows(),
              governed: (await st.refresh.governance.consult(st.scope)).governed,
              derivedUnderLease: 'see below',
              underLease: { answer: answerOf(leased), streamed: streamed(leased) },
              afterRelease: released.statusCode,
              audit: { delivered: auditEnd.delivered.length, refused: auditEnd.refused.length },
            }
            // The derived state of an ungoverned project never shows a lease (O-9): the refusal above came from G0.
            const live = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: `run_s5_06_probe_${TOKEN}`, tenantId: st.tenantId })
            try {
              observed.derivedUnderLease = derive(await st.refresh.governance.consult(st.scope)).status
            } finally {
              await st.lock.createGuard(live).release()
            }
            console.log(`[S5-06] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              status: 200, headers: 'export_columns_exactly', rows: 4, detailKeys: ['activeRowCount', 'columnCount', 'operation', 'totalRowCount'], columnCount: 28, refused: 0, stepFourRows: 0, governed: false,
              derivedUnderLease: 'not_governed',
              underLease: { answer: `409:${BLOCKED}:lease_in_flight:not_governed`, streamed: false },
              afterRelease: 200,
              audit: { delivered: 2, refused: 1 },
            })
          }, 300000)

          test('S5-07 (O-9 answered, D-16) a PILOT project whose rows were pulled before it became pilot (no step-4 row at all) derives complete but is NOT settled: the export is 409 BLOCKED not_settled; one clean preview settles it (the state row and its digest appear) and the export is 200 without a 沿用说明 column', async () => {
            const st = await s3aStack('s5_07', { pilot: false })
            await firstPullApplied(st)
            expect(await st.stepFourRows()).toBe(0)
            await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [st.tenantId, st.projectNo, 'u_s5_07_admin'])
            const before = derive(await st.refresh.governance.consult(st.scope))
            const unsettled = await st.exportLines()
            const settling = await st.dryRun()
            const after = derive(await st.refresh.governance.consult(st.scope))
            const res = await st.exportLines()
            const workbook = workbookOf(res)
            const audit = await exportAudit(st.tenantId)
            const observed = {
              before: { status: before.status, settled: before.settled, governed: before.governed },
              unsettled: { answer: answerOf(unsettled), streamed: streamed(unsettled) },
              settlingPreview: settling.body.data && settling.body.data.status,
              after: { status: after.status, settled: after.settled },
              settledDigestPresent: Boolean(((await q(`SELECT settled_sheet_machine_digest AS d FROM ${RT.state} WHERE sheet_id = $1 AND project_no = $2`, [st.sheetId, st.projectNo])).rows[0] || {}).d),
              exported: { status: res.statusCode, lastHeader: workbook ? workbook.headers[workbook.headers.length - 1] : null, headerCount: workbook ? workbook.headers.length : null },
              audit: { refused: audit.refused.map((row: any) => `${row.refusal}:${row.reason}`), delivered: audit.delivered.map((row: any) => `${row.refreshState}:${row.continuationCount}`) },
            }
            console.log(`[S5-07] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              before: { status: 'complete', settled: false, governed: 'pilot' },
              unsettled: { answer: `409:${BLOCKED}:not_settled:complete`, streamed: false },
              settlingPreview: 'ready',
              after: { status: 'complete', settled: true },
              settledDigestPresent: true,
              exported: { status: 200, lastHeader: EXPORT_HEADERS[EXPORT_HEADERS.length - 1], headerCount: EXPORT_HEADERS.length },
              audit: { refused: [`${BLOCKED}:not_settled`], delivered: ['complete:0'] },
            })
          }, 300000)
        })

        // ── S8 (batch-refresh step 5, PR-8): the CHANGE PLAN on the real stack ─────────────────────────────────────────
        // The routes over the production host / lock / registry / audit store (`s3aStack`), the in-transaction bump inside
        // the store's real transaction, and the host's own read-modify-write patch. Values-free outcome tokens only; the
        // plan's private record set and the floor's notes never reach an `observed` line.
        //   S8-01 migration 104 on PostgreSQL: INTEGER counters, the CHECKs and the two partial uniques as DB facts; a
        //         confirmed and a written plan of one project coexist.
        //   S8-02 (C01 / C02 / C11) a pilot second pull (a unicode material: the JSONB round trip of the plan fingerprint)
        //         suspends on content holds; the page (presence only, ONE audit row, no receipt), the hold page's receipt,
        //         the confirm (201: the plan, the bump `change_plan_confirm` IN the transaction, the holds resolved, the
        //         audit row); the re-preview's token binds the plan.
        //   S8-03 (C02, m2) the source moves after the confirm: the re-preview invalidates the plan (source_changed) with ONE
        //         system audit row (actor NULL) on its own reconcile; the earlier bound token's apply is refused; the main
        //         sheet and its revisions unchanged.
        //   S8-04a (C03 / A12, M2) the controlled update: a person's note between the confirm and the write re-keys nothing;
        //         only the plan's fields + RUN change, the note and the keys untouched, the revisions name exactly those
        //         fields; the plan written by a bound execution.
        //   S8-04b (A12 / F15, human) a person's cell committed by another session INSIDE the host's patch (SHARE lock on
        //         meta_records, pg_blocking_pids): one conflict, one retry, the person's value kept.
        //   S8-04c (machine) a plugin-owned cell the same way: 409 CHANGE_PLAN_STALE machine_columns_moved, the execution
        //         aborted, the plan invalidated(execution_failed), failed_pending_recovery: the page blocked, a confirm 409
        //         RECOVERY_PENDING, the export 409.
        //   S8-05 (C04 / C11 / C12 / C08) written => change_pending_review: export 409, an unbound token's apply 409
        //         REVIEW_PENDING, the preview review_pending (no token, no bump) yet settled; the written page + receipt;
        //         the review (200, decision_version + 1, no bump, two audit rows, sameActorAsConfirm); export 200; a new
        //         change => export 409 again.
        //   S8-07 (C06, B1) W written, a change elsewhere: W's review refused hold_open, then change_plan_pending once B is
        //         confirmed; B's preview mints (no deadlock), B's write absorbs W (superseded, review-only fields); W's review
        //         STALE plan_replaced; the export waits for B's review.
        //   S8-08 (C05 / U03) the gate on the real stack: read tier 403, tenantless 403 (no audit row), another tenant's plan
        //         id and an unknown id answer the same bytes.
        //   S8-09 (E09) the confirm's audit insert fails (BEFORE INSERT trigger 42501): 503 audit, nothing persisted,
        //         generation unchanged; with the trigger gone the same body commits with exactly one audit row.
        //   S8-10 (C07) a structure hold beside the content holds: the page says so and the confirm is 409
        //         STRUCTURE_CHANGE_PRESENT with nothing persisted.
        //   S8-11 (§10.3 (5)) the combined confirm (candidate_content_differs): relationship + members + plan in ONE bump;
        //         the write updates the old rows (no copy of the continued subtree), S root raw = total; the review completes.
        //   S8-13 (F15, register ①, NOT governed) the same human / machine interleavings on a not-governed project: the
        //         person's value kept, a machine move stops 409 with partial counts; no step-4 / step-5 row.
        //   S8-I1 confirm vs apply (pg_blocking_pids): the confirm frozen before COMMIT; an apply's lease acquire queues on
        //         the lock row and is granted the confirm's token; the pre-confirm binding is refused.
        //   S8-I2 confirm vs reconcile: a computation's reconcile queues on the state row behind the frozen confirm, then
        //         misses its CAS (STATE_MOVED): the plan stays confirmed, the holds stay resolved.
        //   S8-I3 review vs live writer: a live lease => the review 409 WRITE_LOCKED; the review frozen before COMMIT holds
        //         the state row and a computation's reconcile queues behind it, then STATE_MOVED; the plan reviewed.
        describe('S8 step-5 PR-8 change plans (real Postgres, real lock, real host, real reader)', () => {
          const decisionsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-decisions.cjs')) as any
          const { REFRESH_DECISION_ERROR_CODES: DC } = decisionsLib
          const { RUN_FIELD_IDS } = require(path.join(PLUGIN_LIB, 'stock-preparation-conflict-planner.cjs')) as any
          const CP_BASE = '/api/integration/stock-preparation/projects/:projectNo/refresh'
          const CPR = {
            holds: `${CP_BASE}/holds`,
            current: `${CP_BASE}/change-plans/current`,
            confirm: `${CP_BASE}/change-plans/confirm`,
            review: `${CP_BASE}/change-reviews/complete`,
          }
          const S8_MATERIAL = '铝合金-合成'
          const EXPORT_BLOCKED = 'STOCK_PREP_EXPORT_BLOCKED'
          const TOKEN_KEY_PREFIX = 'integration:table-action:dry-run-token:'

          async function withSwitch<T>(fn: () => Promise<T>): Promise<T> {
            const before = process.env[SWITCH]
            process.env[SWITCH] = 'true'
            try {
              return await fn()
            } finally {
              if (before === undefined) delete process.env[SWITCH]
              else process.env[SWITCH] = before
            }
          }
          const cpCall = (st: any, method: string, routePath: string, { user, body = {}, query = {} }: { user?: any; body?: any; query?: any } = {}) =>
            withSwitch(() => callRoute(st.routes, method, routePath, { user: user || st.users.puller, body, query, params: { projectNo: st.projectNo } }))
          const okData = (res: any) => {
            expect(res.statusCode < 300, JSON.stringify(res.body)).toBe(true)
            return res.body.data
          }
          const answer = (res: any) => {
            if (res.statusCode < 300) return `${res.statusCode}`
            const error = errorOf(res)
            const details = error.details || {}
            return `${res.statusCode}:${error.code || ''}:${details.reason || ''}${details.status ? `:${details.status}` : ''}`
          }
          // The second read: PART-A's material (one record) and, when asked, PART-C's usage (a second record).
          function sourceWith({ material = S8_MATERIAL, partCUsage = 4 }: { material?: string; partCUsage?: number } = {}) {
            const parts = CF.PARTS.map((part: any) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: material } : part))
            return CF.project({ orders: [{ part: 'S-001', qty: 10 }], parts, boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: partCUsage }] } })
          }
          const plansOf = async (st: any) => (await q(`SELECT * FROM ${RT.changePlan} WHERE sheet_id = $1 AND project_no = $2 ORDER BY created_at, id`, [st.sheetId, st.projectNo])).rows
          const planById = async (id: string) => (await q(`SELECT * FROM ${RT.changePlan} WHERE id = $1`, [id])).rows[0] || null
          const lockRowFor = async (key: string) => (await q(`SELECT generation, generation_token, generation_reason, fencing_epoch, lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [key])).rows[0] || null
          const auditsOf = async (tenantId: string) => (await q('SELECT action, mode, subject_id, actor, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId])).rows
          const fullHolds = async (st: any) => (await q(`SELECT * FROM ${RT.hold} WHERE sheet_id = $1 AND project_no = $2 ORDER BY opened_at, id`, [st.sheetId, st.projectNo])).rows
          const openHoldRows = async (st: any) => (await fullHolds(st)).filter((row: any) => row.status === 'open')
          const stateOf = async (st: any) => (await q(`SELECT * FROM ${RT.state} WHERE sheet_id = $1 AND project_no = $2`, [st.sheetId, st.projectNo])).rows[0] || null
          const physical = (st: any, logical: string): string => (st.target.fieldIdMap && st.target.fieldIdMap[logical]) || logical
          const logicalOf = (st: any) => {
            const inverse: Record<string, string> = {}
            for (const [logical, phys] of Object.entries(st.target.fieldIdMap || {})) inverse[phys as string] = logical
            return (fieldId: string) => inverse[fieldId] || fieldId
          }
          const rowOf = async (st: any, component: string) => (await q(`SELECT id, version, data FROM meta_records WHERE sheet_id = $1 AND data->>$2 = $3`, [st.sheetId, physical(st, 'componentSourceId'), component])).rows[0] || null
          const rowsByComponent = async (st: any) => {
            const rows = (await q('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY id', [st.sheetId])).rows
            const key = physical(st, 'componentSourceId')
            return new Map(rows.map((row: any) => [String(row.data[key]), row]))
          }
          const derivedOf = async (st: any) => derive(await st.refresh.governance.consult(st.scope))
          const tokenRecordOf = async (st: any, token: string) => st.pluginContext.storage.get(`${TOKEN_KEY_PREFIX}${token}`)
          const noAudit = async () => {}

          // A pilot project after its first pull, previewed on the changed read: suspended on content holds.
          async function s8Suspended(label: string, { partCUsage = 4, pilot = true }: { partCUsage?: number; pilot?: boolean } = {}) {
            const st = await s3aStack(label, { pilot })
            await firstPullApplied(st)
            st.state.data = sourceWith({ partCUsage })
            const preview = await st.dryRun()
            expect(preview.body.data && preview.body.data.status, JSON.stringify(preview.body)).toBe('suspended')
            return st
          }
          // The confirm body exactly as the page offers it, with a receipt over every page of every content hold.
          async function boundBody(st: any) {
            const page = okData(await cpCall(st, 'GET', CPR.current))
            const holdsPage = okData(await cpCall(st, 'GET', CPR.holds))
            return {
              page,
              body: {
                confirmProjectNo: st.projectNo,
                holdIds: page.proposal.holdIds,
                holdSetFingerprint: page.proposal.holdSetFingerprint,
                planFingerprint: page.proposal.planFingerprint,
                sourceContentDigest: page.proposal.sourceContentDigest,
                readReceipt: holdsPage.readReceipt.id,
              },
            }
          }
          async function s8Confirmed(label: string, options: { partCUsage?: number } = {}) {
            const st = await s8Suspended(label, options)
            const { body } = await boundBody(st)
            const res = await cpCall(st, 'POST', CPR.confirm, { body })
            expect(res.statusCode, JSON.stringify(res.body)).toBe(201)
            return { st, confirmed: res.body.data }
          }
          async function s8Written(label: string, options: { partCUsage?: number } = {}) {
            const { st, confirmed } = await s8Confirmed(label, options)
            const replan = await st.dryRun()
            expect(replan.body.data.status, JSON.stringify(replan.body)).toBe('ready')
            const applied = await st.apply(st.users.puller, replan.body.data.dryRunToken)
            expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
            expect((await planById(confirmed.changePlanId)).status).toBe('written')
            return { st, confirmed }
          }
          // The review body exactly as the page offers it (the written plan's digest and the receipt over its current diff).
          async function reviewBody(st: any, changePlanId?: string) {
            const page = okData(await cpCall(st, 'GET', CPR.current))
            const written = page.current.written
            return {
              page,
              body: {
                confirmProjectNo: st.projectNo,
                changePlanId: changePlanId || (written && written.id),
                contentDigest: written ? written.writtenContentDigest : 'none',
                conclusion: 'handled',
                readReceipt: page.readReceipt ? page.readReceipt.id : 'f'.repeat(32),
              },
            }
          }
          // A single raw client with a statement hook — the frozen side of an interleaving (the S4 technique).
          function dbOnFrozen(client: PoolClient, hook: (event: StatementEvent) => Promise<void> | void) {
            return createDb({
              database: {
                query: async (sql: string, params?: unknown[]) => { await hook({ sql, inTransaction: false }); return (await client.query(sql, params)).rows },
                transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
                  await client.query('BEGIN')
                  try {
                    const result = await callback({
                      query: async (sql: string, params?: unknown[]) => { await hook({ sql, inTransaction: true }); return (await client.query(sql, params)).rows },
                      commit: async () => {},
                      rollback: async () => {},
                    })
                    await hook({ sql: 'COMMIT', inTransaction: true })
                    await client.query('COMMIT')
                    return result
                  } catch (error) {
                    await client.query('ROLLBACK').catch(() => {})
                    throw error
                  }
                },
              },
            })
          }
          // Freeze every meta_records INSERT / UPDATE behind a SHARE lock held by clientX (reads still pass), run `write`,
          // wait until the host backend waits on clientX (pg_locks + pg_blocking_pids), run `inside` on clientX, COMMIT.
          async function insideHostWrite(write: () => Promise<any>, inside: (client: PoolClient) => Promise<void>) {
            const pidX = Number((await clientX.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            await clientX.query('BEGIN')
            try {
              await clientX.query('LOCK TABLE meta_records IN SHARE MODE')
              let finished = false
              const running = settle(write()).then((outcome) => { finished = true; return outcome })
              let hostPid = 0
              // A write that ends WITHOUT ever reaching the host (refused before its first patch) ends the wait too, and
              // the case's own assertion names it (blocked: false).
              await waitUntil('the host write to wait at its meta_records write', async () => {
                if (finished) return true
                const waiting = await q(`SELECT pid FROM pg_locks WHERE relation = 'meta_records'::regclass AND NOT granted AND pid <> $1`, [pidX])
                if (waiting.rows.length !== 1) return false
                hostPid = Number(waiting.rows[0].pid)
                return true
              }, 30000)
              if (finished) {
                await clientX.query('COMMIT')
                return { blocked: false, result: await running }
              }
              const blocked = await isBlockedBy(hostPid, pidX)
              await inside(clientX)
              await clientX.query('COMMIT')
              return { blocked, result: await running }
            } finally {
              try { await clientX.query('ROLLBACK') } catch { /* already committed */ }
            }
          }
          // A person's cell through SQL (the grid's effect: the cell and the version move).
          const personSql = (client: PoolClient, recordId: string, fieldId: string, value: string) =>
            client.query('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], to_jsonb($3::text)), version = version + 1 WHERE id = $1', [recordId, fieldId, value])

          test('S8-01 migration 104 on PostgreSQL: INTEGER counters, the status / reason / shape CHECKs and the two partial uniques are DB facts; a confirmed and a written plan of one project coexist', async () => {
            const cols = (await q('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1', [RT.changePlan])).rows
            const typeOf = (name: string) => (cols.find((col: any) => col.column_name === name) || {}).data_type
            const indexes = (await q(
              `SELECT c.relname AS name, i.indisunique AS uniq, pg_get_expr(i.indpred, i.indrelid) AS predicate
                 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = $1::regclass AND i.indisunique AND i.indpred IS NOT NULL ORDER BY 1`,
              [RT.changePlan],
            )).rows
            const tenant = tenantFor('s8_01')
            const sheet = sheetFor('s8_01')
            const insertPlan = (id: string, status: string, { projectNo = 'SYN-S8-01', recordCount = 1, executionId = null, written = false, reason = null }: { projectNo?: string; recordCount?: number; executionId?: string | null; written?: boolean; reason?: string | null } = {}) => q(
              `INSERT INTO ${RT.changePlan} (id, tenant_id, sheet_id, project_no, write_scope_key, status, plan_fingerprint, source_content_digest, planned_content_digest,
                 record_count, write_record_count, record_set, absorbed_change_plan_ids, hold_ids, hold_set_fingerprint, continuation_ids, review_baseline_digest,
                 confirmed_by, confirmed_at, confirmed_generation, confirmed_generation_token, confirmed_fencing_epoch, execution_id, written_at, written_content_digest,
                 invalidated_at, invalidated_reason)
               VALUES ($1, $2, $3, $4, $5, $6, 'pf', 'src', 'pd', $7, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'hsf', '[]'::jsonb, 'rb',
                 'u_s8_01', now(), 1, 'tok', 0, $8, $9, $10, $11, $12)`,
              [id, tenant, sheet, projectNo, sheetWriteScopeKey(sheet), status, recordCount, executionId, written ? new Date() : null, written ? 'wd' : null, reason ? new Date() : null, reason],
            )
            const codeOf = async (promise: Promise<unknown>) => {
              const outcome = await settle(promise)
              return outcome.ok ? 'inserted' : `${(outcome as any).error.code}:${(outcome as any).error.constraint || ''}`
            }
            const observed = {
              integers: ['record_count', 'write_record_count', 'confirmed_generation', 'confirmed_fencing_epoch'].map(typeOf),
              jsonb: ['record_set', 'absorbed_change_plan_ids', 'hold_ids', 'continuation_ids'].map(typeOf),
              partialUniques: indexes.map((row: any) => `${row.name}:${String(row.predicate).replace(/::text/g, '')}`),
              confirmed: await codeOf(insertPlan('chp_s8_01_a', 'confirmed')),
              secondConfirmed: await codeOf(insertPlan('chp_s8_01_b', 'confirmed')),
              written: await codeOf(insertPlan('chp_s8_01_w', 'written', { executionId: 'exec_s8_01', written: true })),
              secondWritten: await codeOf(insertPlan('chp_s8_01_w2', 'written', { executionId: 'exec_s8_01b', written: true })),
              writtenWithoutExecution: await codeOf(insertPlan('chp_s8_01_x', 'written', { projectNo: 'SYN-S8-01-X', written: true })),
              unknownStatus: await codeOf(insertPlan('chp_s8_01_s', 'approved', { projectNo: 'SYN-S8-01-S' })),
              countsBelowWrites: await codeOf(insertPlan('chp_s8_01_c', 'confirmed', { projectNo: 'SYN-S8-01-C', recordCount: 0 })),
              failedWithoutExecution: await codeOf(insertPlan('chp_s8_01_f', 'invalidated', { projectNo: 'SYN-S8-01-F', reason: 'execution_failed' })),
              invalidatedBySource: await codeOf(insertPlan('chp_s8_01_i', 'invalidated', { projectNo: 'SYN-S8-01-I', reason: 'source_changed' })),
            }
            console.log(`[S8-01] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              integers: ['integer', 'integer', 'integer', 'integer'],
              jsonb: ['jsonb', 'jsonb', 'jsonb', 'jsonb'],
              partialUniques: [
                "uniq_integration_stock_prep_change_plan_confirmed:(status = 'confirmed')",
                "uniq_integration_stock_prep_change_plan_written:(status = 'written')",
              ],
              confirmed: 'inserted',
              secondConfirmed: '23505:uniq_integration_stock_prep_change_plan_confirmed',
              written: 'inserted',
              secondWritten: '23505:uniq_integration_stock_prep_change_plan_written',
              writtenWithoutExecution: '23514:integration_stock_prep_change_plan_written_shape_check',
              unknownStatus: '23514:integration_stock_prep_change_plan_status_check',
              countsBelowWrites: '23514:integration_stock_prep_change_plan_counts_check',
              failedWithoutExecution: '23514:integration_stock_prep_change_plan_invalidated_shape_check',
              invalidatedBySource: 'inserted',
            })
          }, 60000)

          test('S8-02 (C01 / C02 / C11) through the ROUTES on PostgreSQL: the suspended pull, the page (presence only, one audit row, no receipt), the receipt, the confirm (201, the plan, the bump change_plan_confirm in the transaction, the holds resolved, the audit row), the re-preview\'s token bound to the plan', async () => {
            const st = await s8Suspended('s8_02', { partCUsage: 5 })
            const suspendedHolds = await openHoldRows(st)
            const audits0 = (await auditsOf(st.tenantId)).length
            const page = okData(await cpCall(st, 'GET', CPR.current))
            const pageAudits = (await auditsOf(st.tenantId)).slice(audits0)
            const partA = await rowOf(st, 'PART-A')
            const recordA = page.proposal.records.find((record: any) => record.recordId === partA.id)
            const holdsPage = okData(await cpCall(st, 'GET', CPR.holds))
            const lock0 = await lockRowFor(st.key)
            const dv0 = await decisionVersionOf(st.scope)
            const res = await cpCall(st, 'POST', CPR.confirm, {
              body: {
                confirmProjectNo: st.projectNo,
                holdIds: page.proposal.holdIds,
                holdSetFingerprint: page.proposal.holdSetFingerprint,
                planFingerprint: page.proposal.planFingerprint,
                sourceContentDigest: page.proposal.sourceContentDigest,
                readReceipt: holdsPage.readReceipt.id,
              },
            })
            const lock1 = await lockRowFor(st.key)
            const plans = await plansOf(st)
            const holdsAfter = await fullHolds(st)
            const confirmAudits = (await auditsOf(st.tenantId)).filter((row: any) => row.mode === 'change_plan_confirmed')
            const replan = await st.dryRun()
            const record = await tokenRecordOf(st, replan.body.data.dryRunToken)
            const observed = {
              suspended: suspendedHolds.map((row: any) => row.kind).sort(),
              page: {
                blocked: page.proposal.blocked,
                holdIdsMatch: sameJson(page.proposal.holdIds, suspendedHolds.map((row: any) => row.id).sort()),
                records: page.proposal.recordCount,
                receipt: page.readReceipt,
                partANotesPresent: recordA ? recordA.humanColumnsPresent.notes : 'missing',
                status: page.refresh.status,
              },
              pageAudit: pageAudits.map((row: any) => `${row.action}:${row.mode}`),
              confirm: { status: res.statusCode, state: res.body.data && res.body.data.state, records: res.body.data && res.body.data.recordCount },
              plan: { count: plans.length, status: plans[0] && plans[0].status, confirmedBy: plans[0] && plans[0].confirmed_by === st.users.puller.id, bumpTokenIsThePlans: plans[0] && plans[0].confirmed_generation_token === lock1.generation_token },
              bump: { step: Number(lock1.generation) - Number(lock0.generation), reason: lock1.generation_reason, decisionVersionStep: (await decisionVersionOf(st.scope)) - dv0 },
              holdsResolved: suspendedHolds.every((row: any) => (holdsAfter.find((entry: any) => entry.id === row.id) || {}).status === 'resolved'),
              confirmAudit: confirmAudits.map((row: any) => `${row.action}:${row.subject_id === (plans[0] && plans[0].id)}:${row.actor === st.users.puller.id}`),
              replan: { status: replan.body.data.status, boundToThePlan: Boolean(record && record.refreshBinding && plans[0] && record.refreshBinding.changePlanId === plans[0].id) },
            }
            console.log(`[S8-02] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              suspended: ['content_change', 'content_change'],
              page: { blocked: null, holdIdsMatch: true, records: 2, receipt: null, partANotesPresent: false, status: 'pending_confirmation' },
              pageAudit: ['project_board_read:change_plan_read'],
              confirm: { status: 201, state: 'confirmed_pending_execution', records: 2 },
              plan: { count: 1, status: 'confirmed', confirmedBy: true, bumpTokenIsThePlans: true },
              bump: { step: 1, reason: 'change_plan_confirm', decisionVersionStep: 1 },
              holdsResolved: true,
              confirmAudit: ['exception_resolve:true:true'],
              replan: { status: 'ready', boundToThePlan: true },
            })
          }, 300000)

          test('S8-03 (C02, m2) the source moves after the confirm: the re-preview invalidates the plan (source_changed) with ONE system audit row (actor NULL) on its reconcile; the earlier bound token\'s apply is refused; the main sheet and its revisions unchanged', async () => {
            const { st, confirmed } = await s8Confirmed('s8_03', { partCUsage: 5 })
            const bound = await st.dryRun()
            expect(bound.body.data.status).toBe('ready')
            const main0 = await st.main()
            st.state.data = sourceWith({ partCUsage: 6 })
            const moved = await st.dryRun()
            const plan = await planById(confirmed.changePlanId)
            const invalidations = (await auditsOf(st.tenantId)).filter((row: any) => row.mode === 'change_plan_invalidated')
            const applied = await st.apply(st.users.puller, bound.body.data.dryRunToken)
            const observed = {
              moved: { status: moved.body.data.status, token: moved.body.data.dryRunToken },
              plan: `${plan.status}:${plan.invalidated_reason}`,
              reopened: (await openHoldRows(st)).map((row: any) => row.kind).sort(),
              invalidationAudit: invalidations.map((row: any) => ({ action: row.action, actor: row.actor, subject: row.subject_id === plan.id, reason: row.detail.reason, lane: row.detail.lane, records: row.detail.recordCount })),
              staleApply: answer(applied),
              mainUnchanged: sameJson(await st.main(), main0),
            }
            console.log(`[S8-03] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              moved: { status: 'suspended', token: null },
              plan: 'invalidated:source_changed',
              reopened: ['content_change', 'content_change'],
              invalidationAudit: [{ action: 'exception_resolve', actor: null, subject: true, reason: 'source_changed', lane: 'small_preview', records: 2 }],
              // The bound plan is no longer the project's confirmed plan (an earlier computation invalidated it).
              staleApply: `409:${DC.CHANGE_PLAN_STALE}:plan_replaced`,
              mainUnchanged: true,
            })
          }, 300000)

          test('S8-04a (C03 / A12, M2) the controlled update: a person\'s note between the confirm and the write re-keys nothing; only the plan\'s fields + RUN change, the note and the keys untouched; the revisions name exactly those fields; the plan written by a bound execution', async () => {
            const { st, confirmed } = await s8Confirmed('s8_04a', { partCUsage: 5 })
            const partA0 = await rowOf(st, 'PART-A')
            await personSql(clientX, partA0.id, physical(st, 'notes'), 'synthetic floor note s8-04a')
            const before = await rowsByComponent(st)
            const replan = await st.dryRun()
            const applied = await st.apply(st.users.puller, replan.body.data.dryRunToken)
            const after = await rowsByComponent(st)
            const plan = await planById(confirmed.changePlanId)
            const logical = logicalOf(st)
            const planFields = new Map<string, string[]>((plan.record_set as any[]).map((record: any) => [record.recordId, Object.keys(record.fields)]))
            const changed: Record<string, string[]> = {}
            const outsidePlan: string[] = []
            for (const [component, row] of before.entries()) {
              const next: any = after.get(component)
              const keys = Array.from(new Set([...Object.keys((row as any).data), ...Object.keys(next.data)]))
              const moved = keys.filter((key) => JSON.stringify((row as any).data[key]) !== JSON.stringify(next.data[key])).map(logical).sort()
              changed[component] = moved
              const allowed = new Set([...(planFields.get((row as any).id) || []), ...RUN_FIELD_IDS])
              for (const field of moved) if (!allowed.has(field)) outsidePlan.push(`${component}.${field}`)
            }
            const revisions = (await q(`SELECT record_id, changed_field_ids FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'plugin' AND action = 'update' ORDER BY created_at DESC LIMIT 2`, [st.sheetId])).rows
            const revisionOutside = revisions.flatMap((row: any) => (row.changed_field_ids as string[]).map(logical).filter((field: string) => !new Set([...(planFields.get(row.record_id) || []), ...RUN_FIELD_IDS]).has(field)))
            const execution = (await q(`SELECT status, refresh_binding FROM ${RT.execution} WHERE id = $1`, [plan.execution_id])).rows[0]
            const observed = {
              replan: replan.body.data.status,
              applied: `${applied.statusCode}:${applied.body.data && applied.body.data.status}`,
              changedComponents: Object.entries(changed).filter(([, fields]) => fields.length > 0).map(([component]) => component).sort(),
              partAPlanFieldsWritten: (planFields.get(partA0.id) || []).every((field) => changed['PART-A'].includes(field)),
              outsidePlan,
              noteKept: (after.get('PART-A') as any).data[physical(st, 'notes')] === 'synthetic floor note s8-04a',
              keysKept: ['idempotencyKey', 'path', 'parentSourceId'].every((field) => JSON.stringify((before.get('PART-A') as any).data[physical(st, field)]) === JSON.stringify((after.get('PART-A') as any).data[physical(st, field)])),
              revisionsOutsidePlan: revisionOutside,
              plan: plan.status,
              execution: `${execution.status}:${execution.refresh_binding && execution.refresh_binding.changePlanId === plan.id}`,
            }
            console.log(`[S8-04a] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              replan: 'ready',
              applied: '200:succeeded',
              changedComponents: ['PART-A', 'PART-C'],
              partAPlanFieldsWritten: true,
              outsidePlan: [],
              noteKept: true,
              keysKept: true,
              revisionsOutsidePlan: [],
              plan: 'written',
              execution: 'succeeded:true',
            })
          }, 300000)

          test('S8-04b (A12 / F15, human) a person\'s cell committed by another session INSIDE the host\'s patch (SHARE lock on meta_records, pg_blocking_pids): one conflict, one retry with the fresh version, the person\'s value kept, the plan written', async () => {
            const { st, confirmed } = await s8Confirmed('s8_04b')
            const replan = await st.dryRun()
            const partA0 = await rowOf(st, 'PART-A')
            const { blocked, result } = await insideHostWrite(
              () => st.apply(st.users.puller, replan.body.data.dryRunToken),
              async (client) => { await personSql(client, partA0.id, physical(st, 'notes'), 'synthetic floor note s8-04b') },
            )
            const applied = (result as any).ok ? (result as any).value : null
            const partA1 = await rowOf(st, 'PART-A')
            const observed = {
              hostWaitedOnTheLock: blocked,
              applied: applied ? `${applied.statusCode}:${applied.body.data && applied.body.data.status}` : 'threw',
              personKept: partA1.data[physical(st, 'notes')] === 'synthetic floor note s8-04b',
              materialWritten: partA1.data[physical(st, 'material')] === S8_MATERIAL,
              versionStep: Number(partA1.version) - Number(partA0.version),
              plan: (await planById(confirmed.changePlanId)).status,
            }
            console.log(`[S8-04b] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({ hostWaitedOnTheLock: true, applied: '200:succeeded', personKept: true, materialWritten: true, versionStep: 2, plan: 'written' })
          }, 300000)

          test('S8-04c (A12, machine) a plugin-owned cell committed INSIDE the host\'s patch: 409 CHANGE_PLAN_STALE machine_columns_moved, the execution aborted, the plan invalidated(execution_failed), failed_pending_recovery — the page blocked, a confirm 409 RECOVERY_PENDING, the export 409', async () => {
            const { st, confirmed } = await s8Confirmed('s8_04c')
            const replan = await st.dryRun()
            const partA0 = await rowOf(st, 'PART-A')
            const { blocked, result } = await insideHostWrite(
              () => st.apply(st.users.puller, replan.body.data.dryRunToken),
              async (client) => { await personSql(client, partA0.id, physical(st, 'componentName'), 'synthetic host-side name s8-04c') },
            )
            const applied = (result as any).ok ? (result as any).value : null
            const plan = await planById(confirmed.changePlanId)
            const execution = (await q(`SELECT status FROM ${RT.execution} WHERE id = $1`, [plan.execution_id])).rows[0]
            const page = okData(await cpCall(st, 'GET', CPR.current))
            const confirm = await cpCall(st, 'POST', CPR.confirm, { body: { confirmProjectNo: st.projectNo, holdIds: ['hold_s8_04c'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) } })
            const exported = await st.exportLines()
            const observed = {
              hostWaitedOnTheLock: blocked,
              applied: applied ? answer(applied) : 'threw',
              partial: applied && errorOf(applied).details ? typeof errorOf(applied).details.written : 'none',
              execution: execution && execution.status,
              plan: `${plan.status}:${plan.invalidated_reason}`,
              derived: (await derivedOf(st)).status,
              pageBlocked: page.proposal.blocked,
              confirm: answer(confirm),
              exported: answer(exported),
            }
            console.log(`[S8-04c] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              hostWaitedOnTheLock: true,
              applied: `409:${DC.CHANGE_PLAN_STALE}:machine_columns_moved`,
              partial: 'number',
              execution: 'aborted',
              plan: 'invalidated:execution_failed',
              derived: 'failed_pending_recovery',
              pageBlocked: 'recovery_pending',
              confirm: `409:${DC.RECOVERY_PENDING}:`,
              exported: `409:${EXPORT_BLOCKED}:state:failed_pending_recovery`,
            })
          }, 300000)

          test('S8-05 (C04 / C11 / C12 / C08) written => change_pending_review: export 409, an unbound token 409 REVIEW_PENDING, the preview review_pending (no token, no bump) yet settled; the written page + receipt; the review (200, decision_version + 1, no bump, two audit rows, sameActorAsConfirm); export 200; a new change => export 409 again', async () => {
            const { st, confirmed } = await s8Written('s8_05', { partCUsage: 5 })
            const derivedWritten = (await derivedOf(st)).status
            const export0 = await st.exportLines()
            const unbound = await st.apply(st.users.puller, await st.mintToken('rev_s8_05_unbound'))
            const lockBefore = await lockRowFor(st.key)
            const pending = await st.dryRun()
            const lockAfter = await lockRowFor(st.key)
            const settledAfterPreview = Boolean((await stateOf(st)).settled_at)
            const { page, body } = await reviewBody(st)
            const dv0 = await decisionVersionOf(st.scope)
            const generation0 = Number((await lockRowFor(st.key)).generation)
            const reviewed = await cpCall(st, 'POST', CPR.review, { body })
            const plan = await planById(confirmed.changePlanId)
            const decisions = (await auditsOf(st.tenantId)).filter((row: any) => row.action === 'exception_resolve')
            const export1 = await st.exportLines()
            st.state.data = sourceWith({ partCUsage: 7 })
            const again = await st.dryRun()
            const export2 = await st.exportLines()
            const observed = {
              derivedWritten,
              export0: answer(export0),
              unbound: answer(unbound),
              preview: { status: pending.body.data.status, token: pending.body.data.dryRunToken, bumped: Number(lockAfter.generation) !== Number(lockBefore.generation), settled: settledAfterPreview },
              page: { matches: page.current.written.contentMatchesWrite, receiptComplete: page.readReceipt.holds[plan.id].complete },
              review: { status: reviewed.statusCode, plan: plan.status, conclusion: plan.review_conclusion, decisionVersionStep: (await decisionVersionOf(st.scope)) - dv0, generationStep: Number((await lockRowFor(st.key)).generation) - generation0 },
              audits: decisions.map((row: any) => `${row.mode}${row.mode === 'change_review_completed' ? `:${row.detail.sameActorAsConfirm}` : ''}`),
              export1: answer(export1),
              again: again.body.data.status,
              export2: answer(export2),
            }
            console.log(`[S8-05] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              derivedWritten: 'change_pending_review',
              export0: `409:${EXPORT_BLOCKED}:state:change_pending_review`,
              unbound: '409:STOCK_PREP_REFRESH_REVIEW_PENDING:',
              preview: { status: 'review_pending', token: null, bumped: false, settled: true },
              page: { matches: true, receiptComplete: true },
              review: { status: 200, plan: 'reviewed', conclusion: 'handled', decisionVersionStep: 1, generationStep: 0 },
              audits: ['change_plan_confirmed', 'change_review_completed:true'],
              export1: '200',
              again: 'suspended',
              export2: `409:${EXPORT_BLOCKED}:state:pending_confirmation`,
            })
          }, 300000)

          test('S8-07 (C06, B1) W written, a change elsewhere: W\'s review refused hold_open, then change_plan_pending once B is confirmed; B\'s preview mints, B\'s write absorbs W (superseded, review-only fields); W\'s review STALE plan_replaced; the export waits for B\'s review', async () => {
            const { st, confirmed: w } = await s8Written('s8_07')
            const wPage = await reviewBody(st)
            st.state.data = sourceWith({ partCUsage: 5 })
            const suspended = await st.dryRun()
            const reviewHold = await cpCall(st, 'POST', CPR.review, { body: wPage.body })
            const { body: bBody } = await boundBody(st)
            const b = await cpCall(st, 'POST', CPR.confirm, { body: bBody })
            const reviewPending = await cpCall(st, 'POST', CPR.review, { body: wPage.body })
            const replanB = await st.dryRun()
            const appliedB = await st.apply(st.users.puller, replanB.body.data.dryRunToken)
            const wRow = await planById(w.changePlanId)
            const bRow = await planById(b.body.data.changePlanId)
            const reviewReplaced = await cpCall(st, 'POST', CPR.review, { body: wPage.body })
            const settleB = await st.dryRun()
            const exportB = await st.exportLines()
            const bPage = await reviewBody(st)
            const partA = await rowOf(st, 'PART-A')
            const bView = bPage.page.current.written
            const absorbedA = bView.records.find((record: any) => record.recordId === partA.id)
            const doneB = await cpCall(st, 'POST', CPR.review, { body: bPage.body })
            const exportFinal = await st.exportLines()
            const observed = {
              suspended: suspended.body.data.status,
              reviewWhileHoldOpen: answer(reviewHold),
              confirmB: b.statusCode,
              reviewWhileBConfirmed: answer(reviewPending),
              replanB: replanB.body.data.status,
              appliedB: `${appliedB.statusCode}:${appliedB.body.data && appliedB.body.data.status}`,
              w: `${wRow.status}:${wRow.superseded_by === bRow.id}`,
              b: `${bRow.status}:${sameJson(bRow.absorbed_change_plan_ids, [wRow.id])}`,
              reviewW: answer(reviewReplaced),
              settleB: settleB.body.data.status,
              exportBeforeBReview: answer(exportB),
              bShowsPartAReviewOnly: Boolean(absorbedA) && Object.values(absorbedA.fields).every((cell: any) => cell.reviewOnly === true),
              bMatches: bView.contentMatchesWrite,
              reviewB: doneB.statusCode,
              exportFinal: answer(exportFinal),
            }
            console.log(`[S8-07] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              suspended: 'suspended',
              reviewWhileHoldOpen: `409:${DC.CHANGE_REVIEW_BLOCKED}:hold_open`,
              confirmB: 201,
              reviewWhileBConfirmed: `409:${DC.CHANGE_REVIEW_BLOCKED}:change_plan_pending`,
              replanB: 'ready',
              appliedB: '200:succeeded',
              w: 'superseded:true',
              b: 'written:true',
              reviewW: `409:${DC.CHANGE_REVIEW_STALE}:plan_replaced:superseded`,
              settleB: 'review_pending',
              exportBeforeBReview: `409:${EXPORT_BLOCKED}:state:change_pending_review`,
              bShowsPartAReviewOnly: true,
              bMatches: true,
              reviewB: 200,
              exportFinal: '200',
            })
          }, 300000)

          test('S8-08 (C05 / U03) the gate on the real stack: the read tier 403 and a tenantless platform admin 403 on all three routes (no audit row); another tenant\'s plan id and an unknown id answer the SAME bytes', async () => {
            const { st, confirmed } = await s8Written('s8_08')
            const tenantless = { id: `u_s8_08_platform_${TOKEN}`, roles: ['admin'], permissions: ['integration:admin'] }
            const audits0 = (await auditsOf(st.tenantId)).length
            const routes = async (user: any) => [
              answer(await cpCall(st, 'GET', CPR.current, { user })),
              answer(await cpCall(st, 'POST', CPR.confirm, { user, body: { confirmProjectNo: st.projectNo, holdIds: ['h'], holdSetFingerprint: 'a', planFingerprint: 'b', sourceContentDigest: 'c', readReceipt: 'e'.repeat(32) } })),
              answer(await cpCall(st, 'POST', CPR.review, { user, body: { confirmProjectNo: st.projectNo, changePlanId: confirmed.changePlanId, contentDigest: 'd', conclusion: 'handled', readReceipt: 'e'.repeat(32) } })),
            ]
            const reader = await routes(st.users.reader)
            const platform = await routes(tenantless)
            const auditsAfterRefusals = (await auditsOf(st.tenantId)).length - audits0
            const own = await planById(confirmed.changePlanId)
            const foreignId = `chp_s8_08_foreign_${TOKEN}`
            await q(`INSERT INTO ${RT.changePlan} SELECT $1, $2, sheet_id || '_other', 'SYN-S8-08-OTHER', write_scope_key, status, plan_fingerprint, source_content_digest, planned_content_digest, record_count,
                       write_record_count, record_set, absorbed_change_plan_ids, hold_ids, hold_set_fingerprint, continuation_ids, review_baseline_digest, confirmed_by, confirmed_at,
                       confirmed_generation, confirmed_generation_token, confirmed_fencing_epoch, execution_id, written_at, written_content_digest, reviewed_by, reviewed_at,
                       review_conclusion, review_notes, reviewed_content_digest, invalidated_at, invalidated_reason, superseded_at, superseded_by, now(), now()
                     FROM ${RT.changePlan} WHERE id = $3`, [foreignId, `${st.tenantId}_other`, own.id])
            const { body } = await reviewBody(st)
            const foreign = await cpCall(st, 'POST', CPR.review, { body: { ...body, changePlanId: foreignId } })
            const unknown = await cpCall(st, 'POST', CPR.review, { body: { ...body, changePlanId: `chp_s8_08_unknown_${TOKEN}` } })
            await q(`DELETE FROM ${RT.changePlan} WHERE id = $1`, [foreignId])
            const observed = {
              reader,
              platform,
              auditsAfterRefusals,
              foreign: answer(foreign),
              sameBytes: JSON.stringify(foreign.body) === JSON.stringify(unknown.body),
              ownStillWritten: (await planById(own.id)).status,
            }
            console.log(`[S8-08] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              reader: ['403:FORBIDDEN:', '403:FORBIDDEN:', '403:FORBIDDEN:'],
              platform: ['403:OPERATOR_SCOPE_TENANT_REQUIRED:', '403:OPERATOR_SCOPE_TENANT_REQUIRED:', '403:OPERATOR_SCOPE_TENANT_REQUIRED:'],
              auditsAfterRefusals: 0,
              foreign: `404:${DC.CHANGE_PLAN_NOT_FOUND}:`,
              sameBytes: true,
              ownStillWritten: 'written',
            })
          }, 300000)

          test('S8-09 (E09) the confirm\'s audit insert fails (a BEFORE INSERT trigger raising 42501 for this tenant\'s change_plan_confirmed row): 503 STORE_FAILED audit, nothing persisted, the generation unchanged; with the trigger gone the same body commits with exactly one audit row', async () => {
            const st = await s8Suspended('s8_09', { partCUsage: 5 })
            const fn = `s8_audit_fault_${TOKEN}`
            await q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW.tenant_id = '${st.tenantId}' AND NEW.mode = 'change_plan_confirmed' THEN RAISE EXCEPTION 's8 audit fault' USING ERRCODE = '42501'; END IF; RETURN NEW; END $fn$`)
            await q(`CREATE TRIGGER ${fn} BEFORE INSERT ON integration_stock_prep_audit FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
            try {
              const { body } = await boundBody(st)
              const before = await sheetFingerprint(st.sheetId)
              const refused = await cpCall(st, 'POST', CPR.confirm, { body })
              const observed: Record<string, unknown> = {
                status: refused.statusCode,
                code: errorOf(refused).code,
                details: errorOf(refused).details,
                unchanged: (await sheetFingerprint(st.sheetId)) === before,
                plans: (await plansOf(st)).length,
                openHolds: (await openHoldRows(st)).length,
              }
              await q(`DROP TRIGGER IF EXISTS ${fn} ON integration_stock_prep_audit`)
              await q(`DROP FUNCTION IF EXISTS ${fn}()`)
              const committed = await cpCall(st, 'POST', CPR.confirm, { body })
              observed.afterRepair = { status: committed.statusCode, plans: (await plansOf(st)).length, audits: (await auditsOf(st.tenantId)).filter((row: any) => row.mode === 'change_plan_confirmed').length }
              console.log(`[S8-09] ${JSON.stringify(observed)}`)
              expect(observed).toEqual({
                status: 503,
                code: RC.STORE_FAILED,
                details: { operation: 'audit', sqlState: '42501', partial: false },
                unchanged: true,
                plans: 0,
                openHolds: 2,
                afterRepair: { status: 201, plans: 1, audits: 1 },
              })
            } finally {
              await q(`DROP TRIGGER IF EXISTS ${fn} ON integration_stock_prep_audit`).catch(() => {})
              await q(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {})
            }
          }, 300000)

          test('S8-10 (C07) a structure hold beside the content holds (a legacy lineage mismatch): the page names it and the confirm is 409 STRUCTURE_CHANGE_PRESENT with nothing persisted', async () => {
            const st = await s8Suspended('s8_10', { partCUsage: 5 })
            const state = await stateOf(st)
            const content = (await openHoldRows(st)).map(continuationStoreLib.__internals.rowToHold)
            const structure: any = { kind: 'structure_change', confirmable: false, notConfirmableReason: 'phase_2', subject: { keyDigest: 's'.repeat(64) }, detail: { recordId: (await rowOf(st, 'PART-B')).id, key: 'k_s8_10', changedFields: ['componentSourceId'] } }
            structure.fingerprint = pairingLib.holdFingerprint(structure)
            await st.refresh.store.reconcileHolds({ ...st.scope, decisionVersionObserved: Number(state.decision_version), holds: [...content, structure], computation: { lane: 'small_preview', suspended: true, generationToken: null, sourceContentDigest: state.last_computation_source_content_digest } }, { auditWithin: noAudit })
            const { page, body } = await boundBody(st)
            const before = await sheetFingerprint(st.sheetId)
            const refused = await cpCall(st, 'POST', CPR.confirm, { body })
            const observed = {
              blocked: page.proposal.blocked,
              structureHoldOpen: page.proposal.structureHoldOpen,
              confirm: answer(refused),
              holdCount: errorOf(refused).details && errorOf(refused).details.holdCount,
              unchanged: (await sheetFingerprint(st.sheetId)) === before,
              plans: (await plansOf(st)).length,
            }
            console.log(`[S8-10] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({ blocked: 'structure_change_present', structureHoldOpen: true, confirm: `409:${DC.CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT}:`, holdCount: 1, unchanged: true, plans: 0 })
          }, 300000)

          test('S8-11 (§10.3 (5)) the combined confirm (candidate_content_differs) through the ROUTE: the relationship, its members and the plan in ONE bump; the write updates the old rows (no copy of the continued subtree), the S root\'s raw = total; the review completes', async () => {
            const st = await s3aStack('s8_11', { pilot: true })
            await firstPullApplied(st)
            st.state.data = CF.secondPullSource({ edge: 3 })
            const suspended = await st.dryRun()
            const { page, body } = await boundBody(st)
            const candidate = page.proposal.candidates[0]
            const lock0 = await lockRowFor(st.key)
            const res = await cpCall(st, 'POST', CPR.confirm, { body: { ...body, candidates: [{ holdId: candidate.holdId, candidateId: candidate.candidateId, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true } }] } })
            const lock1 = await lockRowFor(st.key)
            const continuationId = res.body.data && res.body.data.continuationIds[0]
            const relationship = (await q(`SELECT status, confirmed_generation_token FROM ${RT.continuation} WHERE id = $1`, [continuationId])).rows[0]
            const members = await countWhere(RT.member, 'continuation_id = $1', [continuationId])
            const plan = await planById(res.body.data.changePlanId)
            const replan = await st.dryRun()
            const applied = await st.apply(st.users.puller, replan.body.data.dryRunToken)
            const rows = (await q('SELECT data FROM meta_records WHERE sheet_id = $1', [st.sheetId])).rows
            const component = physical(st, 'componentSourceId')
            const perComponent = (id: string) => rows.filter((row: any) => row.data[component] === id).length
            const sRoot = rows.find((row: any) => row.data[component] === 'S-001' && row.data[physical(st, 'active')] !== false)
            const review = await reviewBody(st)
            const reviewed = await cpCall(st, 'POST', CPR.review, { body: review.body })
            const observed = {
              suspended: suspended.body.data.status,
              candidateHistory: candidate.history,
              confirm: res.statusCode,
              oneBump: `${Number(lock1.generation) - Number(lock0.generation)}:${lock1.generation_reason}`,
              relationship: `${relationship.status}:${relationship.confirmed_generation_token === plan.confirmed_generation_token}`,
              members,
              planNamesTheRelationship: sameJson(plan.continuation_ids, [continuationId]),
              replan: replan.body.data.status,
              applied: `${applied.statusCode}:${applied.body.data && applied.body.data.status}`,
              continuedSubtreeOnce: ['S-001', 'PART-A', 'PART-B', 'PART-C'].map(perComponent),
              sRootRawEqualsTotal: Number(sRoot.data[physical(st, 'rawQuantity')]) === Number(sRoot.data[physical(st, 'totalQuantity')]),
              sRootTotal: Number(sRoot.data[physical(st, 'totalQuantity')]),
              review: reviewed.statusCode,
            }
            console.log(`[S8-11] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              suspended: 'suspended',
              candidateHistory: 'history_unknown',
              confirm: 201,
              oneBump: '1:change_plan_confirm',
              relationship: 'active:true',
              members: 4,
              planNamesTheRelationship: true,
              replan: 'ready',
              applied: '200:succeeded',
              continuedSubtreeOnce: [1, 1, 1, 1],
              sRootRawEqualsTotal: true,
              sRootTotal: 15,
              review: 200,
            })
          }, 300000)

          test('S8-13 (F15, register ①, NOT governed) the same interleavings on a not-governed project: a person\'s cell inside the host\'s patch is kept (one retry); a plugin-owned cell stops the run 409 with partial counts; no step-4 / step-5 row', async () => {
            const st = await s3aStack('s8_13', { pilot: false })
            await firstPullApplied(st)
            // A quantity change (PART-C's usage): the not-governed lane applies it without a manual confirm (a material change
            // on an existing row would answer manual_confirm_required there).
            st.state.data = sourceWith({ material: 'M-STEEL', partCUsage: 5 })
            const preview = await st.dryRun()
            const partC0 = await rowOf(st, 'PART-C')
            const human = await insideHostWrite(
              () => st.apply(st.users.puller, preview.body.data.dryRunToken),
              async (client) => { await personSql(client, partC0.id, physical(st, 'notes'), 'synthetic floor note s8-13') },
            )
            const humanApplied = (human.result as any).ok ? (human.result as any).value : null
            const partC1 = await rowOf(st, 'PART-C')
            st.state.data = sourceWith({ material: 'M-STEEL', partCUsage: 6 })
            const preview2 = await st.dryRun()
            const machine = await insideHostWrite(
              () => st.apply(st.users.puller, preview2.body.data.dryRunToken),
              async (client) => { await personSql(client, partC0.id, physical(st, 'componentName'), 'synthetic host-side name s8-13') },
            )
            const machineApplied = (machine.result as any).ok ? (machine.result as any).value : null
            const observed = {
              previews: `${preview.body.data.status}:${preview2.body.data.status}`,
              human: {
                waited: human.blocked,
                applied: humanApplied ? `${humanApplied.statusCode}:${humanApplied.body.data && humanApplied.body.data.status}` : 'threw',
                personKept: partC1.data[physical(st, 'notes')] === 'synthetic floor note s8-13',
                usageWritten: Number(partC1.data[physical(st, 'rawQuantity')]) === 5,
                versionStep: Number(partC1.version) - Number(partC0.version),
              },
              machine: {
                waited: machine.blocked,
                applied: machineApplied ? answer(machineApplied) : 'threw',
                partialCounts: machineApplied && errorOf(machineApplied).details ? typeof errorOf(machineApplied).details.written : 'none',
              },
              stepFiveRows: await countWhere(RT.changePlan, 'tenant_id = $1', [st.tenantId]),
              stepFourRows: await st.stepFourRows(),
            }
            console.log(`[S8-13] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({
              previews: 'ready:ready',
              human: { waited: true, applied: '200:succeeded', personKept: true, usageWritten: true, versionStep: 2 },
              machine: { waited: true, applied: `409:${DC.CHANGE_PLAN_STALE}:machine_columns_moved`, partialCounts: 'number' },
              stepFiveRows: 0,
              stepFourRows: 0,
            })
          }, 300000)

          // The store-level interleavings: the canonical changed read planned against the first-pull sheet (the REAL planner),
          // its content holds persisted on a synthetic sheet, the confirm's inputs derived from the persisted rows.
          async function storeScenario(label: string) {
            const scope = { tenantId: tenantFor(label), sheetId: sheetFor(label), projectNo: CF.PROJECT_NO }
            const key = sheetWriteScopeKey(scope.sheetId)
            const sheet = await CF.firstPullSheet()
            const expansion = await CF.expand(sourceWith({ partCUsage: 5 }))
            const planned = CF.plan(expansion, sheet, { continuation: CF.continuationInput({ pilot: true, demandEvidence: expansion.demandEvidence }) })
            const seedStore = continuationStoreLib.createStockPreparationContinuationStore({ db: hostLikeDb() })
            await seedStore.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: planned.holds, computation: computation({ sourceContentDigest: `src_${label}` }) }, { auditWithin: noAudit })
            const state = (await q(`SELECT * FROM ${RT.state} WHERE sheet_id = $1 AND project_no = $2`, [scope.sheetId, scope.projectNo])).rows[0]
            const holdRows = (await q(`SELECT * FROM ${RT.hold} WHERE sheet_id = $1 AND project_no = $2 AND status = 'open'`, [scope.sheetId, scope.projectNo])).rows
            const content = holdRows.map(continuationStoreLib.__internals.rowToHold).filter(pairingLib.isContentClassHold)
            const records = pairingLib.changePlanRecordsFromHolds(content)
            const input = {
              ...scope,
              confirmedBy: `u_${label}_puller`,
              holds: content.map((hold: any) => ({ id: hold.id, fingerprint: hold.fingerprint })),
              echo: { holdSetFingerprint: state.hold_set_fingerprint, planFingerprint: pairingLib.changePlanFingerprintOf({ projectNo: scope.projectNo, records, sourceContentDigest: `src_${label}` }), sourceContentDigest: `src_${label}` },
              candidates: [],
              sourceIdentity: CF.SOURCE_IDENTITY,
              template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
            }
            return { scope, key, planned, input, state, content }
          }

          test('S8-I1 confirm vs apply (pg_blocking_pids): the confirm frozen before COMMIT holds the lock row it bumped; an apply\'s lease acquire queues behind it and is granted the CONFIRM\'s token; the pre-confirm binding is refused', async () => {
            const scenario = await storeScenario('s8_i1')
            const pidA = Number((await clientA.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            const pidB = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            const lockB = createStockPreparationProjectWriteLock({ db: dbOn(clientB) })
            const before = await lockB.bumpGeneration(scenario.key, { reason: 'small_preview', tenantId: scenario.scope.tenantId })
            const commitGate = gate()
            let frozen: (() => void) | null = null
            const frozenAt = new Promise<void>((resolve) => { frozen = resolve })
            const confirmDb = dbOnFrozen(clientA, async (event) => {
              if (event.inTransaction && event.sql === 'COMMIT') {
                if (frozen) frozen()
                await commitGate.promise
              }
            })
            const lockA = createStockPreparationProjectWriteLock({ db: confirmDb })
            const storeA = continuationStoreLib.createStockPreparationContinuationStore({ db: confirmDb })
            const confirming = settle(storeA.confirmChangePlan(scenario.input, { bumpWithin: lockA.bumpGenerationWithin, auditWithin: noAudit }))
            await frozenAt
            const acquiring = settle(lockB.acquire(scenario.key, { purpose: 'small_apply', runId: 's8-i1-acquire', tenantId: scenario.scope.tenantId }))
            await waitUntil('the acquire to queue behind the frozen confirm', () => isBlockedBy(pidB, pidA))
            commitGate.open()
            const confirmed: any = await confirming
            const granted: any = await acquiring
            const guardB = granted.ok ? lockB.createGuard(granted.value) : null
            const oldBinding = writeBindingFromGeneration({ scopeKey: scenario.key, generation: before.generation, generationToken: before.generationToken })
            const stale = guardB ? await settle((async () => lockModule.assertWriteBindingMatchesGuard(oldBinding, guardB))()) : null
            const plan = confirmed.ok ? await planById(confirmed.value.changePlanId) : null
            const observed = {
              confirmed: confirmed.ok ? plan.status : String(confirmed.error && confirmed.error.code),
              acquired: granted.ok,
              grantCarriesTheConfirmToken: granted.ok && plan ? granted.value.generationToken === plan.confirmed_generation_token : false,
              oldBinding: stale ? (stale.ok ? 'admitted' : `${(stale as any).error.code}`) : 'none',
            }
            if (guardB) await guardB.release()
            console.log(`[S8-I1] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({ confirmed: 'confirmed', acquired: true, grantCarriesTheConfirmToken: true, oldBinding: PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED })
          }, 120000)

          test('S8-I2 confirm vs reconcile (pg_blocking_pids): a computation\'s reconcile queues on the state row behind the frozen confirm, then misses its CAS (STATE_MOVED): the plan stays confirmed, the holds stay resolved, nothing invalidated', async () => {
            const scenario = await storeScenario('s8_i2')
            const pidA = Number((await clientA.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            const pidB = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            const commitGate = gate()
            let frozen: (() => void) | null = null
            const frozenAt = new Promise<void>((resolve) => { frozen = resolve })
            const confirmDb = dbOnFrozen(clientA, async (event) => {
              if (event.inTransaction && event.sql === 'COMMIT') {
                if (frozen) frozen()
                await commitGate.promise
              }
            })
            const storeA = continuationStoreLib.createStockPreparationContinuationStore({ db: confirmDb })
            const storeB = continuationStoreLib.createStockPreparationContinuationStore({ db: dbOn(clientB) })
            const lockA = createStockPreparationProjectWriteLock({ db: confirmDb })
            const confirming = settle(storeA.confirmChangePlan(scenario.input, { bumpWithin: lockA.bumpGenerationWithin, auditWithin: noAudit }))
            await frozenAt
            const reconciling = settle(storeB.reconcileHolds({ ...scenario.scope, decisionVersionObserved: Number(scenario.state.decision_version), holds: scenario.planned.holds, computation: computation({ sourceContentDigest: 'src_s8_i2_next' }) }, { auditWithin: noAudit }))
            await waitUntil('the reconcile to queue behind the frozen confirm', () => isBlockedBy(pidB, pidA))
            commitGate.open()
            const confirmed: any = await confirming
            const reconciled: any = await reconciling
            const plan = confirmed.ok ? await planById(confirmed.value.changePlanId) : null
            const openAfter = await countWhere(RT.hold, `sheet_id = $1 AND status = 'open'`, [scenario.scope.sheetId])
            const observed = {
              confirmed: plan ? plan.status : String(confirmed.error && confirmed.error.code),
              reconcile: reconciled.ok ? 'committed' : `${reconciled.error.code}:${reconciled.error.details && reconciled.error.details.reason}`,
              openHolds: openAfter,
            }
            console.log(`[S8-I2] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({ confirmed: 'confirmed', reconcile: `${RC.STATE_MOVED}:decision_version`, openHolds: 0 })
          }, 120000)

          test('S8-I3 review vs live writer: a live lease => the review 409 WRITE_LOCKED; the review frozen before COMMIT holds the state row, a computation\'s reconcile queues behind it (pg_blocking_pids) and then misses its CAS; the plan reviewed', async () => {
            const { st, confirmed } = await s8Written('s8_i3')
            const { page, body } = await reviewBody(st)
            const grant = await st.lock.acquire(st.key, { purpose: 'small_apply', runId: 's8-i3-live', tenantId: st.tenantId })
            const locked = await cpCall(st, 'POST', CPR.review, { body })
            await st.lock.createGuard(grant).release()
            const pidA = Number((await clientA.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            const pidB = Number((await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
            const commitGate = gate()
            let frozen: (() => void) | null = null
            const frozenAt = new Promise<void>((resolve) => { frozen = resolve })
            const reviewDb = dbOnFrozen(clientA, async (event) => {
              if (event.inTransaction && event.sql === 'COMMIT') {
                if (frozen) frozen()
                await commitGate.promise
              }
            })
            const storeA = continuationStoreLib.createStockPreparationContinuationStore({ db: reviewDb })
            const storeB = continuationStoreLib.createStockPreparationContinuationStore({ db: dbOn(clientB) })
            const dv0 = await decisionVersionOf(st.scope)
            const written = page.current.written
            const reviewing = settle(storeA.completeChangeReview({ ...st.scope, changePlanId: written.id, reviewedBy: st.users.puller.id, echoDigest: written.writtenContentDigest, currentContentDigest: written.currentContentDigest, conclusion: 'handled', notes: null }, { auditWithin: noAudit }))
            await frozenAt
            const reconciling = settle(storeB.reconcileHolds({ ...st.scope, decisionVersionObserved: dv0, holds: [], computation: computation({ suspended: false, sourceContentDigest: 'src_s8_i3_next' }) }, { auditWithin: noAudit }))
            await waitUntil('the reconcile to queue behind the frozen review', () => isBlockedBy(pidB, pidA))
            commitGate.open()
            const reviewed: any = await reviewing
            const reconciled: any = await reconciling
            const observed = {
              liveLease: answer(locked),
              reviewed: reviewed.ok ? (await planById(confirmed.changePlanId)).status : String(reviewed.error && reviewed.error.code),
              reconcile: reconciled.ok ? 'committed' : `${reconciled.error.code}`,
            }
            console.log(`[S8-I3] ${JSON.stringify(observed)}`)
            expect(observed).toEqual({ liveLease: `409:${PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED}:`, reviewed: 'reviewed', reconcile: RC.STATE_MOVED })
          }, 300000)
        })
      })
    })
  })
}
