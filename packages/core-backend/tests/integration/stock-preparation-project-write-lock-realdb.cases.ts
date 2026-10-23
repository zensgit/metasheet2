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

import { MetaSheetServer } from '../../src/index'
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
          projectWriteGenerationBinder: async () => writeBindingFromGeneration(await lock.bumpGeneration(key, { reason: 'small_preview' })),
        })
        const applyWith = (lock: any, projectNo: string, token: string) => lock.withProjectWriteLease(key, { purpose: 'small_apply', runId: `swl-d7-${projectNo}` }, (guard: any) =>
          tableActions.applyStockPreparationAction({
            action, parameters: { projectNo }, sourceAdapter: sourceFor(projectNo), recordsApi: recordsWithBarrier,
            tokenStore: pluginContext.storage, plannedAt: '2026-10-22T08:00:00.000Z', runId: `swl_d7_${projectNo}`,
            dryRunToken: token, permission: 'write', sandboxPolicy: { enabled: true, allowedTargetObjectIds: [objectId] }, projectWriteGuard: guard,
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
          largeBomJobs.runLargeBomCheckpointApplyJobChunk({ storage, ...jobScope, actionId, applyJobId: `swl_d11_apply_old_${TOKEN}`, recordsApi: await scopedForChunk(), projectWriteGuard: guard })))
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
  })
}
