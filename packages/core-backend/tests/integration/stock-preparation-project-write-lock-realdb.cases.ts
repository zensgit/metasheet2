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

const {
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS,
  PROJECT_WRITE_LEASE_TTL_MS,
  PROJECT_WRITE_LOCK_TABLE,
  createStockPreparationProjectWriteLock,
  sheetWriteScopeKey,
  writeBindingFromGeneration,
} = lockModule

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function dbOn(client: PoolClient) {
  return createDb({ database: { query: (sql: string, params?: unknown[]) => client.query(sql, params) } })
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

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'write-lock-realdb' },
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
          'const db = createDb({ database: { query: (sql, params) => pool.query(sql, params) } })',
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
  })
}
