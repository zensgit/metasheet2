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
        for (const table of [RT.member, RT.continuation, RT.hold, RT.execution, RT.state, 'integration_stock_prep_project_target']) {
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
          [[RT.continuation, RT.member, RT.hold, RT.state]],
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
        for (const extra of [{ outcome: 'escalate_special_repair' }, { outcome: 'release_to_normal_refresh', currentExpansionHoldsNoNewPosition: true }]) {
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

        async function s3aStack(label: string, options: { pilot?: boolean; register?: boolean; switchOn?: boolean; data?: any; refresh?: any } = {}) {
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
            stockPreparationProjectWriteLock: lock,
            stockPreparationProjectTargetStore: registry,
            stockPreparationAuditStore: auditStoreLib.createStockPreparationAuditStore({ db }),
            stockPreparationPackInstallStore: packInstallStoreLib.createStockPreparationPackInstallStore({ db }),
            stockPreparationConfirmationDecisionLease: confirmationDecisionsLib.createConfirmationDecisionReconcileLease({ db }),
            tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
            stockPreparationRefreshGovernance: refresh.governance,
            stockPreparationContinuationStore: refresh.store,
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
      })
    })
  })
}
