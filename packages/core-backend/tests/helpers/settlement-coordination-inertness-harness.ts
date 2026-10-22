/**
 * P1-1 settlement coordination, S5 groups G1 / G2: a statement recorder and an entry harness for the
 * production-inertness baseline (acceptance A01-P1 / A01-P2) and the hot-path record (A12-P4).
 *
 * Named `settlement-coordination-*` because key-space guard ① admits the reserved key1 (written out in
 * decimal below) only under the coordination test prefixes.
 *
 * BASE-RUNNABLE. Everything imported here exists, with the same exports, at the implementation base
 * `d671019f2b` and at the head. Nothing from `src/attendance/coordination/` is imported: the
 * settlement-coordination key space is written out below as the numbers `pg_locks` shows, so this
 * file and the suites that use it can be cherry-picked onto the base and run unchanged there.
 *
 * What the recorder does:
 *  - `pg.Client.prototype.query` is wrapped once. A statement is booked to an entry only when it is
 *    sent inside `recorder.run(label, fn)` (an AsyncLocalStorage store), so whatever the booted
 *    server does in the background (timers, workers, other requests) is never booked to an entry.
 *    Wrapping the prototype catches every pool: the main pool, Kysely (which uses the main pool) and
 *    any other pool an entry borrows from.
 *  - The pools passed to `observePool` also report each checkout (`acquire`) and each return
 *    (`release`, with whether pg was asked to destroy the connection). Each checkout gets its own
 *    borrow label (`b0`, `b1`, …), so the trace shows which statements went over which borrow.
 *    A client that was not checked out inside the entry gets an `x<n>` label.
 *  - With an observer pool, after every statement settles (and before its result is handed back) the
 *    advisory locks the backend holds are read from `pg_locks` on the observer pool, outside the
 *    entry's store. This sees transaction-scoped locks a timer-based poll would miss, and it does not
 *    add a statement to the entry's own sequence.
 *  - Statement text is normalised (literals, numbers and whitespace folded); values are never
 *    recorded, only how many there were.
 *
 * Known limits (also in the S5 design note):
 *  - pg-pool hands a queued checkout to a waiter from the releaser's async context. Entries run one at
 *    a time and never fill the pool, so this never misattributes here; a saturated pool would.
 *  - When an entry sends two statements on one connection without awaiting the first (pg queues
 *    them), the lock sample after the first can be taken while the second runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { Client, Pool, type PoolClient } from 'pg'
import { expect, vi } from 'vitest'

import type { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import type { ApprovalActionRequest } from '../../src/types/approval-product'
import * as liveBoundaryModule from '../../src/attendance/w4c2-live-scheduled-boundary'
import type { AttendanceW4LiveScheduledBoundaryV1, OnlinePunchInputV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import {
  closeLegacyRollbackWindowV1,
  transitionAttendanceCalculationRolloutV1,
  type AttendanceW4C3aRolloutControlResultV1,
} from '../../src/attendance/w4c3a-rollout-control'
import { transitionAttendanceW7ContextSourceV1 } from '../../src/attendance/w7-context-source-transition'
import { sweepAttendanceScheduledRunsOnceV1 } from '../../src/attendance/w4c2-scheduled-run-ops-worker'
import { isCancelRoundInstance } from '../../src/attendance/w4c3b-central-approval-hooks'
import { ensureLocalUserRow, grantApprovalWriteForIntegrationActor } from './approval-schema-bootstrap'
import {
  assertDroppableScratchDatabaseName,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from './scratch-database'

// ---------------------------------------------------------------------------------------------------
// The settlement-coordination key space, as `pg_locks` shows it
// ---------------------------------------------------------------------------------------------------

/**
 * The dedicated coordination key is a two-int4 advisory key `(0x4D533243, key2)`
 * (`SETTLEMENT_COORDINATION_KEY1` in `src/attendance/coordination/settlement-coordination-key.ts` at
 * the head). PostgreSQL shows a two-int4 advisory lock with `classid = key1`, `objid = key2` (as an
 * unsigned oid) and `objsubid = 2`; single-bigint keys (class-00 and every W4 class) show
 * `objsubid = 1`. 0x4D533243 = 1297297987. Written out here, not imported, so the file runs on the base.
 */
export const P11_SETTLEMENT_KEY1_CLASSID = '1297297987'

const ADVISORY_LOCKS_SQL = `SELECT classid::text AS classid, objid::text AS objid, objsubid::int AS objsubid, mode, granted
  FROM pg_locks
 WHERE locktype = 'advisory'
   AND pid = $1
   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
 ORDER BY objsubid, classid, objid, mode`

export interface P11AdvisoryLockRow {
  readonly classid: string
  readonly objid: string
  readonly objsubid: number
  readonly mode: string
  readonly granted: boolean
}

export function isSettlementCoordinationLockRow(row: P11AdvisoryLockRow): boolean {
  return row.objsubid === 2 && row.classid === P11_SETTLEMENT_KEY1_CLASSID
}

/** A lock row without its key values: family, mode, granted, and whether it is in the coordination space. */
function lockKind(row: P11AdvisoryLockRow): string {
  const family = row.objsubid === 2 ? 'int4x2' : row.objsubid === 1 ? 'bigint' : `objsubid${row.objsubid}`
  return `${family}:${row.mode}:${row.granted ? 'granted' : 'waiting'}${isSettlementCoordinationLockRow(row) ? ':settlement' : ''}`
}

// ---------------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------------

/**
 * Statement shape without values: comments dropped, string literals → `'?'`, numeric literals → `<n>`
 * (bind placeholders `$1` and identifiers such as `w4c5_idle_probe` are kept), whitespace folded.
 * What this hides: a changed string or number literal inside an otherwise identical statement (e.g.
 * `set_config('statement_timeout', …)` and `set_config('lock_timeout', …)` fold to the same text), so
 * a base / head comparison of these traces cannot see a literal-only change.
 */
export function normalizeP11Sql(text: string): string {
  return text
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/(?<![\w$])-?\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

// ---------------------------------------------------------------------------------------------------
// Trace types
// ---------------------------------------------------------------------------------------------------

export interface P11Step {
  /** `q`: a statement; `acquire` / `release`: a checkout from / return to an observed pool. */
  readonly k: 'q' | 'acquire' | 'release'
  /** Borrow label: `b<n>` for a checkout inside the entry, `x<n>` for any other client. */
  readonly b: string
  sql?: string
  /** Number of bind values (never the values). */
  n?: number
  /** Whether the statement succeeded; `null` until it settles (or for a submittable). */
  ok?: boolean | null
  /** SQLSTATE (or `error`) of a failed statement. */
  code?: string | null
  /** Advisory locks the backend held once the statement settled (kinds only, sorted). */
  locks?: string[]
  /** `release` only: pg was asked to destroy the connection. */
  destroy?: boolean
  /** Timing mode only: `performance.now()` at the step. */
  t?: number
}

export interface P11EntryTrace {
  readonly label: string
  readonly steps: readonly P11Step[]
  /** Raw advisory-lock rows seen after any statement of the entry (key values included; never written out). */
  readonly lockRows: readonly P11AdvisoryLockRow[]
}

export interface P11EntryRun<T> {
  readonly result: T | undefined
  readonly error: unknown
  readonly trace: P11EntryTrace
  readonly elapsedMs: number
}

interface EntryStore {
  readonly label: string
  readonly steps: P11Step[]
  readonly lockRows: P11AdvisoryLockRow[]
  readonly borrowOf: Map<object, string>
  readonly otherOf: Map<object, string>
  nextBorrow: number
  pending: number
  lastActivity: number
}

type QueryFn = (...args: unknown[]) => unknown

export interface P11RecorderOptions {
  /** Pool used to read `pg_locks` after every statement; `null` turns lock sampling off (timing runs). */
  readonly observer: Pool | null
  /** Record `performance.now()` on every step. */
  readonly timing?: boolean
  /** Called synchronously, in the caller's async context, for every booked statement. */
  readonly onStatement?: (label: string, sql: string) => void
}

// ---------------------------------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------------------------------

export class P11StatementRecorder {
  readonly #als = new AsyncLocalStorage<EntryStore>()
  readonly #options: P11RecorderOptions
  #original: QueryFn | null = null
  readonly #observed: Array<{ pool: Pool; onAcquire: (client: PoolClient) => void; onRelease: (error: unknown, client: PoolClient) => void }> = []
  /**
   * The entry that checked each client out. A release is booked to it by client identity, not by the
   * async scope active at release time: `pool.query` releases inside pg's own query callback, which runs
   * in the socket's async context, where no entry scope is active.
   */
  readonly #checkedOut = new Map<object, EntryStore>()

  constructor(options: P11RecorderOptions) {
    this.#options = options
  }

  /** Wraps `pg.Client.prototype.query` once. */
  install(): void {
    if (this.#original) return
    const prototype = Client.prototype as unknown as { query: QueryFn }
    const original = prototype.query
    this.#original = original
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const recorder = this
    prototype.query = function p11RecordedQuery(this: object, ...args: unknown[]): unknown {
      const store = recorder.#als.getStore()
      if (!store) return original.apply(this, args)
      return recorder.#record(store, this, original, args)
    }
  }

  uninstall(): void {
    for (const { pool, onAcquire, onRelease } of this.#observed.splice(0)) {
      pool.removeListener('acquire', onAcquire)
      pool.removeListener('release', onRelease)
    }
    if (!this.#original) return
    ;(Client.prototype as unknown as { query: QueryFn }).query = this.#original
    this.#original = null
  }

  /** Books each checkout from / return to `pool` made inside an entry. */
  observePool(pool: Pool): void {
    const onAcquire = (client: PoolClient): void => {
      const store = this.#als.getStore()
      if (!store) return
      const label = `b${store.nextBorrow}`
      store.nextBorrow += 1
      store.borrowOf.set(client, label)
      this.#checkedOut.set(client, store)
      store.steps.push(this.#stamp({ k: 'acquire', b: label }))
      store.lastActivity = Date.now()
    }
    const onRelease = (error: unknown, client: PoolClient): void => {
      const store = this.#checkedOut.get(client) ?? this.#als.getStore()
      if (!store) return
      this.#checkedOut.delete(client)
      const label = store.borrowOf.get(client) ?? this.#otherLabel(store, client)
      store.borrowOf.delete(client)
      store.steps.push(this.#stamp({ k: 'release', b: label, destroy: Boolean(error) }))
      store.lastActivity = Date.now()
    }
    pool.on('acquire', onAcquire)
    pool.on('release', onRelease)
    this.#observed.push({ pool, onAcquire, onRelease })
  }

  /**
   * Runs `fn` as entry `label`, then waits until the entry is quiet (no statement in flight and none
   * sent for 250 ms, at most 5 s) so post-commit work the entry started is booked to it as well.
   * Never throws: the entry's error is returned for the caller to assert on.
   */
  async run<T>(label: string, fn: () => Promise<T>): Promise<P11EntryRun<T>> {
    const store: EntryStore = {
      label,
      steps: [],
      lockRows: [],
      borrowOf: new Map(),
      otherOf: new Map(),
      nextBorrow: 0,
      pending: 0,
      lastActivity: Date.now(),
    }
    const started = performance.now()
    let result: T | undefined
    let error: unknown = undefined
    try {
      result = await this.#als.run(store, fn)
    } catch (caught) {
      error = caught === undefined ? new Error('entry rejected with undefined') : caught
    }
    const elapsedMs = performance.now() - started
    await this.#quiesce(store)
    return {
      result,
      error,
      elapsedMs,
      trace: { label, steps: store.steps.map((step) => ({ ...step, ...(step.locks ? { locks: [...step.locks] } : {}) })), lockRows: [...store.lockRows] },
    }
  }

  #stamp(step: P11Step): P11Step {
    if (this.#options.timing) step.t = performance.now()
    return step
  }

  #otherLabel(store: EntryStore, client: object): string {
    let label = store.otherOf.get(client)
    if (!label) {
      label = `x${store.otherOf.size}`
      store.otherOf.set(client, label)
    }
    return label
  }

  #record(store: EntryStore, client: object, original: QueryFn, args: unknown[]): unknown {
    const first = args[0]
    const isObject = typeof first === 'object' && first !== null
    const submittable = isObject && typeof (first as { submit?: unknown }).submit === 'function'
    const text = typeof first === 'string' ? first : String((first as { text?: unknown } | null)?.text ?? '')
    const configValues = isObject ? (first as { values?: unknown }).values : undefined
    const values = Array.isArray(configValues) ? configValues : Array.isArray(args[1]) ? (args[1] as unknown[]) : []
    const sql = normalizeP11Sql(text)
    const step: P11Step = this.#stamp({
      k: 'q',
      b: store.borrowOf.get(client) ?? this.#otherLabel(store, client),
      sql,
      n: values.length,
      ok: null,
      code: null,
      locks: [],
    })
    store.steps.push(step)
    store.lastActivity = Date.now()
    this.#options.onStatement?.(store.label, sql)
    if (submittable) return original.apply(client, args)

    store.pending += 1
    const settle = async (error: unknown): Promise<void> => {
      try {
        step.ok = !error
        step.code = error ? sqlStateOf(error) : null
        await this.#sampleLocks(store, client, step)
      } finally {
        store.pending -= 1
        store.lastActivity = Date.now()
      }
    }

    const callbackIndex = args.findIndex((arg) => typeof arg === 'function')
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (error: unknown, result: unknown) => void
      const forwarded = [...args]
      forwarded[callbackIndex] = (error: unknown, result: unknown) => {
        void settle(error).then(
          () => callback(error, result),
          () => callback(error, result),
        )
      }
      return original.apply(client, forwarded)
    }
    const sent = original.apply(client, args) as Promise<unknown> | undefined
    if (!sent || typeof (sent as { then?: unknown }).then !== 'function') {
      // Not a promise (a config object carrying its own callback): nothing to wait on.
      void settle(undefined)
      return sent
    }
    return sent.then(
      async (value) => {
        await settle(undefined)
        return value
      },
      async (error: unknown) => {
        await settle(error)
        throw error
      },
    )
  }

  async #sampleLocks(store: EntryStore, client: object, step: P11Step): Promise<void> {
    const observer = this.#options.observer
    if (!observer) return
    const pid = (client as { processID?: unknown }).processID
    if (typeof pid !== 'number') {
      step.locks = ['<no-backend-pid>']
      return
    }
    try {
      const { rows } = await this.#als.exit(() => observer.query(ADVISORY_LOCKS_SQL, [pid]))
      const lockRows = rows as P11AdvisoryLockRow[]
      store.lockRows.push(...lockRows)
      step.locks = [...new Set(lockRows.map(lockKind))].sort()
    } catch {
      step.locks = ['<lock-sample-failed>']
    }
  }

  async #quiesce(store: EntryStore): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (store.pending === 0 && Date.now() - store.lastActivity >= 250) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Trace checks (hold on the base and the head alike)
// ---------------------------------------------------------------------------------------------------

const TRANSACTION_CONTROL = /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i
const SAVEPOINT_ROLLBACK = /^ROLLBACK TO\b/i

function transactionControl(sql: string): string | null {
  if (SAVEPOINT_ROLLBACK.test(sql) || !TRANSACTION_CONTROL.test(sql)) return null
  return /^(BEGIN|START TRANSACTION)\b/i.test(sql) ? 'BEGIN' : sql.split(' ')[0].toUpperCase()
}

/** The successful transaction-control statements of one borrow, in order, with every BEGIN form folded to `BEGIN`. */
export function transactionControlOf(trace: P11EntryTrace, borrow: string): string[] {
  const out: string[] = []
  for (const step of trace.steps) {
    if (step.k !== 'q' || step.b !== borrow || step.ok !== true) continue
    const control = transactionControl(step.sql ?? '')
    if (control) out.push(control)
  }
  return out
}

/** The borrow that sent the first statement matching `matcher` (fails the test if none did). */
export function borrowOfStatement(trace: P11EntryTrace, matcher: RegExp): string {
  const step = trace.steps.find((candidate) => candidate.k === 'q' && matcher.test(candidate.sql ?? ''))
  expect(step, `${trace.label}: no statement matches ${String(matcher)}`).toBeDefined()
  return (step as P11Step).b
}

/**
 * The first statement matching `matcher` ran inside a transaction its own connection opened: the
 * nearest successful transaction-control statement before it on the same borrow is a BEGIN, and the
 * next one after it is `end`. This is what an entry in its default mode does and what a handed-over
 * caller never does (it sends no BEGIN / COMMIT / ROLLBACK), so it is the check that turns red when a
 * default call is switched to the handed-over mode (A01-M1).
 */
export function expectInsideOwnTransaction(trace: P11EntryTrace, matcher: RegExp, end: 'COMMIT' | 'ROLLBACK'): void {
  const index = trace.steps.findIndex((step) => step.k === 'q' && matcher.test(step.sql ?? ''))
  expect(index, `${trace.label}: no statement matches ${String(matcher)}`).toBeGreaterThanOrEqual(0)
  const borrow = trace.steps[index].b
  const control = (step: P11Step): string | null =>
    step.k === 'q' && step.b === borrow && step.ok === true ? transactionControl(step.sql ?? '') : null
  let opened: string | null = null
  for (let i = index - 1; i >= 0 && opened === null; i -= 1) opened = control(trace.steps[i])
  let closed: string | null = null
  for (let i = index + 1; i < trace.steps.length && closed === null; i += 1) closed = control(trace.steps[i])
  expect({ entry: trace.label, opened, closed }).toEqual({ entry: trace.label, opened: 'BEGIN', closed: end })
}

/** No backend the entry used ever held or waited for a lock in the settlement-coordination key space. */
export function settlementCoordinationLocksOf(trace: P11EntryTrace): P11AdvisoryLockRow[] {
  return trace.lockRows.filter(isSettlementCoordinationLockRow)
}

/** The lock sampler worked for every settled statement (so "no settlement lock" is not vacuous). */
export function expectLocksSampled(trace: P11EntryTrace): void {
  const statements = trace.steps.filter((step) => step.k === 'q' && step.ok !== null)
  expect(statements.length, `${trace.label}: no settled statement was booked`).toBeGreaterThan(0)
  const failed = statements.filter((step) => (step.locks ?? []).some((kind) => kind.startsWith('<')))
  expect(failed.map((step) => step.locks)).toEqual([])
}

/** Every checkout made inside the entry was returned, and none was destroyed. */
export function expectBorrowsReturnedClean(trace: P11EntryTrace): void {
  const acquired = trace.steps.filter((step) => step.k === 'acquire').map((step) => step.b)
  const released = trace.steps.filter((step) => step.k === 'release').map((step) => ({ b: step.b, destroy: step.destroy }))
  expect(acquired.length, `${trace.label}: no checkout was observed`).toBeGreaterThan(0)
  expect(released).toEqual(acquired.map((b) => ({ b, destroy: false })))
}

// ---------------------------------------------------------------------------------------------------
// Trace output
// ---------------------------------------------------------------------------------------------------

export const P11_TRACE_FORMAT = 'p11-inertness-trace/v1'

/** The trace as written to disk: statements and lock kinds only, no key values, no timings. */
export function serializableTrace(trace: P11EntryTrace, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: P11_TRACE_FORMAT,
    entry: trace.label,
    ...extra,
    steps: trace.steps.map((step) => {
      const { t: _t, ...rest } = step
      return rest
    }),
  }
}

/** Writes `<P11_TRACE_DIR>/<name>.json` when `P11_TRACE_DIR` is set; returns the path or null. */
export function writeP11TraceFile(name: string, data: unknown): string | null {
  const dir = process.env.P11_TRACE_DIR
  if (!dir) return null
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.json`)
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  return file
}

/** Active libuv resources by type (`process.getActiveResourcesInfo()`), sorted by type. */
export function activeResourceCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

export async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------------------------------

const W4_ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_ALLOWLIST_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'
const BOOT_ENV_KEYS = ['RBAC_BYPASS', 'SKIP_PLUGINS', W4_ALLOWLIST_ENV, W7_ALLOWLIST_ENV] as const

export interface P11Boot {
  readonly server: MetaSheetServer | null
  readonly baseUrl: string
  /** The error `server.start()` threw, or null. */
  readonly bootError: Error | null
  /** The live / scheduled boundary the composition root built for the attendance plugin (index.ts). */
  readonly liveBoundary: AttendanceW4LiveScheduledBoundaryV1 | null
  /** The main pool the composition root uses (`poolManager.get().getInternalPool()`). */
  readonly mainPool: Pool
  restoreEnv(): void
}

/**
 * Boots the real `MetaSheetServer` with the attendance plugin, the way the route-level attendance
 * suites do. The boundary factory is wrapped for the duration of the boot only, to keep a reference to
 * the boundary `index.ts` builds (its connection provider over the main pool included); the object the
 * plugin receives is that same boundary, unchanged.
 */
export async function bootP11CompositionRoot(): Promise<P11Boot> {
  const priorEnv = Object.fromEntries(BOOT_ENV_KEYS.map((key) => [key, process.env[key]]))
  const restoreEnv = (): void => {
    for (const key of BOOT_ENV_KEYS) {
      const prior = priorEnv[key]
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  }
  process.env.RBAC_BYPASS = 'true'
  process.env.SKIP_PLUGINS = 'false'
  // Neither allowlist is set while the server runs: no org is in a W4 or W7 rollout, and the outbox
  // drain worker that the W4 allowlist would start does not exist.
  delete process.env[W4_ALLOWLIST_ENV]
  delete process.env[W7_ALLOWLIST_ENV]

  const repoRoot = path.resolve(__dirname, '../../../..')
  const original = liveBoundaryModule.createAttendanceLiveScheduledBoundaryV1
  let liveBoundary: AttendanceW4LiveScheduledBoundaryV1 | null = null
  const spy = vi.spyOn(liveBoundaryModule, 'createAttendanceLiveScheduledBoundaryV1').mockImplementation((config) => {
    const boundary = original(config)
    liveBoundary = boundary
    return boundary
  })
  const { MetaSheetServer: Server } = await import('../../src/index')
  let server: MetaSheetServer | null = new Server({
    port: 0,
    host: '127.0.0.1',
    pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
  })
  let bootError: Error | null = null
  let baseUrl = ''
  try {
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
  } catch (error) {
    bootError = error instanceof Error ? error : new Error(String(error))
    server = null
  } finally {
    spy.mockRestore()
  }
  return { server, baseUrl, bootError, liveBoundary, mainPool: poolManager.get().getInternalPool(), restoreEnv }
}

// ---------------------------------------------------------------------------------------------------
// The scratch database each inertness file runs on
// ---------------------------------------------------------------------------------------------------

/**
 * Why the inertness files do not use the shared test database: in CI every attendance file runs in
 * one invocation against one database, and earlier files leave `attendance_scheduled_runs` rows in
 * state `running`. The sweep entry's scan stamps `last_attempt_at` on such a row, a row-state trigger
 * refuses some of them (`W4C2_RUN_STATE`), and the entry then fails for a reason that is not a
 * property of the code under comparison. Each inertness file therefore creates its own database,
 * migrates it with the full migration set, and drops it in `afterAll`, as
 * `attendance-w4c2-sweep-call-through.db.test.ts` does.
 *
 * The files pick the name and rebind `DATABASE_URL` in their `vi.hoisted` block, before
 * `connection-pool` builds the pool manager from it at module load (pg pools connect lazily, so
 * nothing connects before the database exists). These functions do the rest, in `beforeAll` /
 * `afterAll`. They use the shared URL only to reach the server's maintenance database `postgres`,
 * through a one-connection admin pool that is closed again before the server boots, so it never shows
 * up in the active-resource counts the baseline file records.
 */

/** Ceiling for the migration child; the files' `beforeAll` budgets add this to their previous budget. */
export const P11_SCRATCH_MIGRATION_TIMEOUT_MS = 240_000

const CORE_BACKEND_DIR = path.resolve(__dirname, '../..')
const execFileAsync = promisify(execFile)

function p11AdminUrl(sharedUrl: string): string {
  const adminUrl = new URL(sharedUrl)
  adminUrl.pathname = '/postgres'
  return adminUrl.toString()
}

function p11AdminPool(sharedUrl: string): Pool {
  return new Pool({ connectionString: p11AdminUrl(sharedUrl), max: 1, application_name: 'p11-scratch-admin' })
}

/**
 * Creates the empty scratch database. Refuses a name that already exists (it would belong to someone
 * else, and `afterAll` drops only what this call created).
 */
export async function createP11ScratchDatabase(sharedUrl: string, name: string): Promise<void> {
  assertDroppableScratchDatabaseName(name)
  const admin = p11AdminPool(sharedUrl)
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (existing.rows.length !== 0) throw new Error('P11_SCRATCH_DATABASE_NAME_COLLISION')
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    // Never let a failed close hide a database that was created: the caller marks it for the drop
    // only when this function returns. Same pattern as the drop helper.
    await admin.end().catch(() => undefined)
  }
}

/**
 * Migrates the scratch database with the same CLI `pnpm migrate` runs (`tsx src/db/migrate.ts`), in
 * a child process, as the sweep call-through suite does: kysely's file provider `import()`s each
 * migration from code outside the test runner's transform graph, which tsx resolves and the runner
 * does not. The child inherits the environment with `DATABASE_URL` pointing at the scratch database.
 * The CI attendance step sets no `MIGRATION_EXCLUDE`, so the scratch database gets the full migration
 * set (the shared database was migrated in an earlier step with six exclusions): the same set as
 * production and the sibling scratch-database suites, not a copy of the shared database's schema. Asynchronous, so a slow migration ends in
 * the child's own timeout with a code rather than a blocked event loop.
 */
export async function migrateP11ScratchDatabase(scratchUrl: string): Promise<void> {
  try {
    await execFileAsync('pnpm', ['exec', 'tsx', 'src/db/migrate.ts'], {
      cwd: CORE_BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: scratchUrl },
      timeout: P11_SCRATCH_MIGRATION_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; killed?: unknown } | null
    throw new Error(
      `P11_SCRATCH_MIGRATION_FAILED code=${String(failure?.code ?? 'unknown')} signal=${String(failure?.signal ?? 'none')} killed=${String(failure?.killed === true)}`,
      { cause: error },
    )
  }
}

/**
 * Drops the scratch database through `dropScratchDatabase` (revoke, drain, drop, read back) and
 * logs its values-free outcome line unconditionally; a failed drop is logged and re-thrown.
 */
export async function dropP11ScratchDatabase(sharedUrl: string, name: string, label: string): Promise<void> {
  const admin = p11AdminPool(sharedUrl)
  try {
    const outcome = await dropScratchDatabase(admin, name)
    console.log(formatScratchDropOutcome(label, outcome))
  } catch (error) {
    console.log(formatScratchDropFailure(label, error))
    throw error
  } finally {
    await admin.end().catch(() => undefined)
  }
}

/** The composition root's main pool (`poolManager`'s), for the teardown's termination handler. */
export function p11MainPool(): Pool {
  return poolManager.get().getInternalPool()
}

// ---------------------------------------------------------------------------------------------------
// Approval fixtures (published over HTTP, outside every recorded entry)
// ---------------------------------------------------------------------------------------------------

export interface P11ApprovalPeople {
  readonly requesterId: string
  readonly approverId: string
  readonly templateId: string
}

function oneNodeGraph(approverId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

export class P11ApprovalFixtures {
  readonly templateIds = new Set<string>()
  readonly instanceIds = new Set<string>()
  readonly userIds = new Set<string>()
  readonly #baseUrl: string
  readonly #tag: string

  constructor(baseUrl: string, tag: string) {
    this.#baseUrl = baseUrl
    this.#tag = tag
  }

  async #token(userId: string): Promise<string> {
    await ensureLocalUserRow(userId)
    this.userIds.add(userId)
    const response = await fetch(
      `${this.#baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async #json(route: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${this.#baseUrl}${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** A requester with approvals:write and an org, an approver with a users row, and a published one-node template. */
  async people(label: string): Promise<P11ApprovalPeople> {
    const suffix = `${this.#tag}-${label}-${randomUUID().slice(0, 8)}`
    const requesterId = `p11-req-${suffix}`
    const approverId = `p11-apr-${suffix}`
    for (const userId of [requesterId, approverId]) {
      await ensureLocalUserRow(userId)
      this.userIds.add(userId)
    }
    await grantApprovalWriteForIntegrationActor(requesterId)
    const adminToken = await this.#token(`p11-adm-${suffix}`)
    const create = await this.#json('/api/approval-templates', adminToken, {
      key: `p11-inert-${suffix}`,
      name: 'p11 inertness fixture',
      description: 'settlement-coordination-inertness-harness.ts',
      formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
      approvalGraph: oneNodeGraph(approverId),
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const templateId = ((await create.json()) as { id: string }).id
    this.templateIds.add(templateId)
    const publish = await this.#json(`/api/approval-templates/${templateId}/publish`, adminToken, { policy: { allowRevoke: true } })
    expect(publish.status, await publish.clone().text()).toBe(200)
    return { requesterId, approverId, templateId }
  }

  /** Deletes every row these fixtures created; each statement is tolerated on its own. */
  async cleanup(observer: Pool): Promise<void> {
    const quiet = async (sql: string, values: unknown[]): Promise<void> => {
      await observer.query(sql, values).catch(() => undefined)
    }
    const instances = [...this.instanceIds]
    const templates = [...this.templateIds]
    const users = [...this.userIds]
    if (instances.length > 0) {
      await quiet('DELETE FROM approval_rounds WHERE engine_instance_id = ANY($1::text[])', [instances])
      await quiet('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [instances])
      await quiet('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [instances])
      await quiet('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [instances])
      await quiet('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [instances])
    }
    if (templates.length > 0) {
      await quiet('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templates])
      await quiet('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templates])
      await quiet('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templates])
    }
    if (users.length > 0) {
      await quiet('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [users])
      await quiet('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [users])
      await quiet('DELETE FROM users WHERE id = ANY($1::text[])', [users])
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// The existing entries, driven the way their production callers drive them
// ---------------------------------------------------------------------------------------------------

type W4TransitionInput = Parameters<typeof transitionAttendanceCalculationRolloutV1>[1]
type W7TransitionInput = Parameters<typeof transitionAttendanceW7ContextSourceV1>[1]
/** Exactly the three base reference keys both boundaries require on a non-resume pair. */
const BASE_EVIDENCE_REFERENCES = Object.freeze({ imageSha: 'img-p11', ownerAuthorizationRef: 'owner-p11', syntheticOrgRef: 'org-p11' })

/** pg's own client as the W4 boundaries take it (the CLIs' `clientAdapter` / `asTrx`). */
function trxOf(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text: string, values?: unknown[]) => client.query(text, values as unknown[]),
  } as unknown as AttendanceW4TransactionClientV1
}

export interface P11ApprovalActor {
  readonly userId: string
  readonly userName: string
  readonly roles: string[]
}

export const p11Entries = {
  /** `POST /api/approvals` → `createApproval`, with the actor the route builds from an admin token. */
  createApproval(people: P11ApprovalPeople) {
    return new ApprovalProductService().createApproval(
      { templateId: people.templateId, formData: { reason: 'p11 inertness' } },
      { userId: people.requesterId, userName: 'p11 requester', roles: ['admin'], permissions: ['*:*'] },
    )
  },

  /** `POST /api/approvals/:id/actions` → `dispatchAction`, default mode (no handover argument). */
  dispatch(instanceId: string, action: 'approve' | 'reject', actor: P11ApprovalActor) {
    const request = (action === 'reject' ? { action, comment: 'p11 inertness reject' } : { action }) as ApprovalActionRequest
    return new ApprovalProductService().dispatchAction(instanceId, request, actor)
  },

  /** `createCancelRoundInstance`, default mode (no options): the method borrows, begins and commits itself. */
  createCancelRound(documentId: string, requesterId: string) {
    return new ApprovalProductService().createCancelRoundInstance(documentId, { userId: requesterId })
  },

  /**
   * W4 transition, composed as `scripts/ops/attendance-w4c5-rollout-transition.ts` composes it: one
   * main-pool connection, pg's client behind a `{ query }` adapter, released once. The org is
   * allowlisted for the call only.
   */
  async w4Transition(orgId: string): Promise<AttendanceW4C3aRolloutControlResultV1> {
    const prior = process.env[W4_ALLOWLIST_ENV]
    process.env[W4_ALLOWLIST_ENV] = orgId
    const client = await poolManager.get().getInternalPool().connect()
    try {
      return await transitionAttendanceCalculationRolloutV1(trxOf(client), {
        orgId,
        actorId: 'p11-inertness-actor',
        correlationId: randomUUID(),
        engineVersion: 'p11-inertness',
        targetState: 'shadow',
        expectedState: 'legacy',
        expectedVersion: 1,
        evidenceManifestSha256: createHash('sha256').update(`p11-inertness-${orgId}`).digest('hex'),
        // The base key set of a non-resume pair; the type lists the resume keys too (the rollout-control
        // suite casts the same way).
        evidenceReferences: BASE_EVIDENCE_REFERENCES as unknown as W4TransitionInput['evidenceReferences'],
        reasonCode: 'rollout_transition',
      })
    } finally {
      client.release()
      if (prior === undefined) delete process.env[W4_ALLOWLIST_ENV]
      else process.env[W4_ALLOWLIST_ENV] = prior
    }
  },

  /**
   * W4 closure (`closeLegacyRollbackWindowV1`) on a batch that does not exist: the full runner
   * transaction (exclusive class-00, the control-domain locks and reads) ends in the reference
   * refusal and a ROLLBACK. A committed legacy batch is not seeded: no base suite seeds one in the
   * shared database (both rollout-control suites use scratch databases with hand-made tables).
   */
  async w4ClosureRefused(orgId: string): Promise<AttendanceW4C3aRolloutControlResultV1> {
    const client = await poolManager.get().getInternalPool().connect()
    try {
      return await closeLegacyRollbackWindowV1(trxOf(client), {
        orgId,
        batchId: randomUUID(),
        actorId: 'p11-inertness-actor',
        correlationId: randomUUID(),
        engineVersion: 'p11-inertness',
        reasonCode: 'legacy_rollback_window_closed',
      })
    } finally {
      client.release()
    }
  },

  /** The sweep tick as `index.ts` wires `sweepScheduledRuns` (main pool), one candidate at most, no logger. */
  sweep() {
    return sweepAttendanceScheduledRunsOnceV1(poolManager.get().getInternalPool(), {
      limit: 1,
      recoverCandidate: async () => undefined,
    })
  },

  /**
   * W7 transition, composed as `scripts/ops/attendance-w7-context-source-transition.ts` composes it.
   * With the W7 allowlist unset (the server's state), it takes its session lock, opens the runner's
   * transaction, refuses the org and rolls back, then unlocks: the whole connection lifecycle with a
   * fixed outcome on both refs.
   */
  async w7TransitionRefused(orgId: string) {
    const client = await poolManager.get().getInternalPool().connect()
    try {
      return await transitionAttendanceW7ContextSourceV1(
        {
          query: async (text: string, values?: unknown[]) => ({ rows: (await client.query(text, values as unknown[])).rows }),
        } as unknown as AttendanceW4TransactionClientV1,
        {
          orgId,
          actorId: 'p11-inertness-actor',
          correlationId: randomUUID(),
          engineVersion: 'p11-inertness',
          targetState: 'group_shadow',
          expectedState: 'off',
          expectedVersion: 1,
          evidenceManifestSha256: createHash('sha256').update(`p11-inertness-w7-${orgId}`).digest('hex'),
          evidenceReferences: BASE_EVIDENCE_REFERENCES as unknown as W7TransitionInput['evidenceReferences'],
          reasonCode: 'context_source_transition',
        },
      )
    } finally {
      client.release()
    }
  },

  /** The online-punch replay probe, on the boundary the composition root built (its own connection provider). */
  probe(boundary: AttendanceW4LiveScheduledBoundaryV1, orgId: string, userId: string) {
    const input: OnlinePunchInputV1 = {
      orgId,
      userId,
      tokenSubjectUserId: userId,
      operationId: randomUUID(),
      client: {
        eventType: 'check_in',
        timezone: 'UTC',
        source: null,
        location: null,
        meta: null,
        photoFileId: null,
        requestNamedOrgId: orgId,
      },
    }
    return boundary.probeOnlinePunchReplay(input)
  },
}

/** A user who may punch for `orgId` (active, activated, an active member): the probe's liveness recheck. */
export async function seedP11PunchUser(observer: Pool, orgId: string): Promise<string> {
  const userId = randomUUID()
  await ensureLocalUserRow(userId)
  await observer.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING', [userId, orgId])
  return userId
}

export async function readInstanceRow(observer: Pool, id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await observer.query('SELECT * FROM approval_instances WHERE id = $1', [id])
  return (rows[0] as Record<string, unknown> | undefined) ?? null
}

export { isCancelRoundInstance }

// ---------------------------------------------------------------------------------------------------
// The entry plan: one item per existing entry, run in this order by the baseline file (and again by
// the head-only file). Every check here holds on the base and on the head alike.
// ---------------------------------------------------------------------------------------------------

export interface P11EntryContext {
  boot: P11Boot | null
  observer: Pool | null
  fixtures: P11ApprovalFixtures | null
  people: P11ApprovalPeople | null
  /** Carried from one approval entry to the next (create → approve → cancel-round → reject). */
  documentId: string | null
  roundId: string | null
  /** The probe's org and its member (seeded outside every recorded entry). */
  punchOrgId: string | null
  punchUserId: string | null
}

export function emptyP11EntryContext(): P11EntryContext {
  return { boot: null, observer: null, fixtures: null, people: null, documentId: null, roundId: null, punchOrgId: null, punchUserId: null }
}

export interface P11EntryPlanItem {
  /** Trace file name (`<id>.json`). */
  readonly id: string
  /** Test title (both files use it; the head-only file appends its own suffix). */
  readonly title: string
  /** Fixture work outside the recorded entry. */
  prepare?(ctx: P11EntryContext): Promise<void>
  run(ctx: P11EntryContext): Promise<unknown>
  /** Base / head invariant checks of the run (outcome, transaction ownership, borrows). */
  check(run: P11EntryRun<unknown>, ctx: P11EntryContext): Promise<void>
  /** The part of the trace that is written and compared (default: all of it). */
  written?(run: P11EntryRun<unknown>): Record<string, unknown>
}

/** `SELECT * FROM approval_instances WHERE id = $1 AND COALESCE(source_system, 'platform') = 'platform' FOR UPDATE`, normalised. */
export const P11_DISPATCH_ROW_LOCK = /^SELECT \* FROM approval_instances WHERE id = \$1 AND COALESCE\(source_system, '\?'\) = '\?' FOR UPDATE$/
export const P11_INSTANCE_INSERT = /^INSERT INTO approval_instances\b/
const SWEEP_RESULT_KEYS = [
  'backlogRemaining',
  'errored',
  'finalized',
  'neverAttemptedRunning',
  'notReady',
  'oldestRunningAttemptAgeSeconds',
  'scanned',
  'skipped',
]

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`p11 entry plan: ${what} is missing (an earlier step failed)`)
  return value
}

/** Every checkout was returned once; a destroyed one only where pg-pool's own `pool.query` saw its statement fail. */
export function expectBorrowsReturned(trace: P11EntryTrace): void {
  const acquired = trace.steps.filter((step) => step.k === 'acquire').map((step) => step.b)
  const released = trace.steps.filter((step) => step.k === 'release')
  expect(acquired.length, `${trace.label}: no checkout was observed`).toBeGreaterThan(0)
  expect(released.map((step) => step.b).sort()).toEqual([...acquired].sort())
  const destroyedWithoutFailure = released
    .filter((step) => step.destroy === true)
    .map((step) => step.b)
    .filter((borrow) => {
      const last = [...trace.steps].reverse().find((step) => step.k === 'q' && step.b === borrow)
      return !last || last.ok !== false
    })
  expect(destroyedWithoutFailure).toEqual([])
}

function lockKindsOf(trace: P11EntryTrace): Set<string> {
  return new Set(trace.steps.flatMap((step) => step.locks ?? []))
}

export const P11_ENTRY_PLAN: readonly P11EntryPlanItem[] = Object.freeze([
  {
    id: 'approval.create',
    title: 'approval.create — createApproval writes inside its own BEGIN … COMMIT and returns every borrow',
    run: (ctx) => p11Entries.createApproval(need(ctx.people, 'approval people')),
    async check(run, ctx) {
      expect(run.error).toBeUndefined()
      const id = (run.result as { id?: unknown } | undefined)?.id
      expect(typeof id).toBe('string')
      need(ctx.fixtures, 'fixtures').instanceIds.add(id as string)
      ctx.documentId = id as string
      const row = await readInstanceRow(need(ctx.observer, 'observer'), id as string)
      expect({ exists: row !== null, cancelRound: isCancelRoundInstance(row as { workflow_key?: string | null } | null) }).toEqual({ exists: true, cancelRound: false })
      expectInsideOwnTransaction(run.trace, P11_INSTANCE_INSERT, 'COMMIT')
      expectBorrowsReturned(run.trace)
    },
  },
  {
    id: 'approval.dispatch.approve',
    title: 'approval.dispatch.approve — a non-cancel-round dispatch locks its row inside its own BEGIN … COMMIT and approves',
    run: (ctx) => {
      const people = need(ctx.people, 'approval people')
      return p11Entries.dispatch(need(ctx.documentId, 'the created document'), 'approve', { userId: people.approverId, userName: 'p11 approver', roles: [] })
    },
    async check(run) {
      expect(run.error).toBeUndefined()
      expect((run.result as { status?: unknown } | undefined)?.status).toBe('approved')
      expectInsideOwnTransaction(run.trace, P11_DISPATCH_ROW_LOCK, 'COMMIT')
      expectBorrowsReturned(run.trace)
    },
  },
  {
    id: 'approval.cancel-round.create',
    title: 'approval.cancel-round.create — createCancelRoundInstance in its default mode writes inside its own BEGIN … COMMIT',
    run: (ctx) => p11Entries.createCancelRound(need(ctx.documentId, 'the approved document'), need(ctx.people, 'approval people').requesterId),
    async check(run, ctx) {
      expect(run.error).toBeUndefined()
      const id = (run.result as { id?: unknown } | undefined)?.id
      expect(typeof id).toBe('string')
      need(ctx.fixtures, 'fixtures').instanceIds.add(id as string)
      ctx.roundId = id as string
      const row = await readInstanceRow(need(ctx.observer, 'observer'), id as string)
      expect(isCancelRoundInstance(row as { workflow_key?: string | null } | null)).toBe(true)
      expectInsideOwnTransaction(run.trace, P11_INSTANCE_INSERT, 'COMMIT')
      expectBorrowsReturned(run.trace)
    },
  },
  {
    id: 'approval.cancel-round.dispatch.reject',
    title: 'approval.cancel-round.dispatch.reject — dispatchAction in its default mode on a cancel round locks its row inside its own BEGIN … COMMIT and rejects',
    run: (ctx) => {
      const people = need(ctx.people, 'approval people')
      return p11Entries.dispatch(need(ctx.roundId, 'the cancel round'), 'reject', { userId: people.approverId, userName: 'p11 approver', roles: [] })
    },
    async check(run) {
      expect(run.error).toBeUndefined()
      expect((run.result as { status?: unknown } | undefined)?.status).toBe('rejected')
      expectInsideOwnTransaction(run.trace, P11_DISPATCH_ROW_LOCK, 'COMMIT')
      expectBorrowsReturned(run.trace)
    },
  },
  {
    id: 'w4.transition',
    title: 'w4.transition — legacy → shadow commits under its session-exclusive class-00 lock and returns its connection',
    run: () => {
      const orgId = randomUUID()
      return p11Entries.w4Transition(orgId).then((result) => ({ orgId, result }))
    },
    async check(run) {
      expect(run.error).toBeUndefined()
      const { orgId, result } = run.result as { orgId: string; result: unknown }
      expect(result).toEqual({ orgId, state: 'shadow', batchId: null })
      expectInsideOwnTransaction(run.trace, /^INSERT INTO attendance_calculation_rollout_events\b/, 'COMMIT')
      // Positive control for the lock sampler: the session-exclusive class-00 lock is seen.
      expect(lockKindsOf(run.trace).has('bigint:ExclusiveLock:granted')).toBe(true)
      expectBorrowsReturned(run.trace)
    },
  },
  {
    id: 'w4.closure',
    title: 'w4.closure — closeLegacyRollbackWindowV1 on an unknown batch refuses with the reference code after the full runner transaction and rolls back',
    run: () => p11Entries.w4ClosureRefused(randomUUID()),
    async check(run) {
      expect(run.error).toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REFERENCE_INVALID' })
      expectInsideOwnTransaction(run.trace, /attendance_import_rollback_closures c WHERE c\.org_id = \$1 AND c\.batch_id = \$2::uuid/, 'ROLLBACK')
      // Positive control: the transaction-level exclusive class-00 lock is seen while the body runs.
      expect(lockKindsOf(run.trace).has('bigint:ExclusiveLock:granted')).toBe(true)
      expectBorrowsReturned(run.trace)
    },
  },
  {
    id: 'w4.sweep',
    title: 'w4.sweep — the sweep tick scans in its own runner transaction on the main pool and reports the same counters',
    run: () => p11Entries.sweep(),
    async check(run) {
      expect(run.error).toBeUndefined()
      expect(Object.keys(run.result as Record<string, unknown>).sort()).toEqual(SWEEP_RESULT_KEYS)
      expect(borrowOfStatement(run.trace, /FROM attendance_scheduled_runs WHERE state = '\?'/)).toBe('b0')
      expectInsideOwnTransaction(run.trace, /FROM attendance_scheduled_runs WHERE state = '\?'/, 'COMMIT')
      expectBorrowsReturned(run.trace)
    },
    // Only the scan borrow is compared. The inertness files run on their own freshly migrated scratch
    // database, where nothing creates a `running` scheduled run before this entry: the attendance
    // scheduler is off (it starts only on an exact 'true'), and the only W4 allowlist window before the
    // sweep is w4.transition's own call, which creates no scheduled run. So `candidateBorrows` is
    // expected to be 0 on both refs there (checked on the recorded traces, not assumed). It stays out of the comparison as before: a candidate (at most one) is
    // a data row, not a property of the code.
    written: (run) => ({
      candidateBorrows: new Set(run.trace.steps.filter((step) => step.b !== 'b0').map((step) => step.b)).size,
      steps: run.trace.steps.filter((step) => step.b === 'b0').map(({ t: _t, ...rest }) => rest),
    }),
  },
  {
    id: 'w7.transition',
    title: 'w7.transition — with the W7 allowlist unset the transition refuses the org inside its runner transaction, rolls back and unlocks',
    run: () => p11Entries.w7TransitionRefused(randomUUID()),
    async check(run) {
      expect(run.error).toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_ORG_NOT_ALLOWLISTED' })
      expect(transactionControlOf(run.trace, 'b0')).toEqual(['BEGIN', 'ROLLBACK'])
      const sent = run.trace.steps.filter((step) => step.k === 'q' && step.b === 'b0').map((step) => step.sql)
      expect(sent).toContain('SELECT pg_advisory_lock($1::bigint)')
      expect(sent).toContain('SELECT pg_advisory_unlock($1::bigint)')
      expect(sent.indexOf('SELECT pg_advisory_unlock($1::bigint)')).toBeGreaterThan(sent.lastIndexOf('ROLLBACK'))
      expect(lockKindsOf(run.trace).has('bigint:ExclusiveLock:granted')).toBe(true)
      expectBorrowsReturned(run.trace)
    },
  },
  {
    id: 'live.online-replay-probe',
    title: 'live.online-replay-probe — the probe on the composition root’s live boundary reads in its own runner transaction and finds no receipt',
    async prepare(ctx) {
      ctx.punchOrgId = randomUUID()
      ctx.punchUserId = await seedP11PunchUser(need(ctx.observer, 'observer'), ctx.punchOrgId)
      need(ctx.fixtures, 'fixtures').userIds.add(ctx.punchUserId)
    },
    run: (ctx) =>
      p11Entries.probe(
        need(need(ctx.boot, 'boot').liveBoundary, 'the live boundary the composition root built'),
        need(ctx.punchOrgId, 'punch org'),
        need(ctx.punchUserId, 'punch user'),
      ),
    async check(run, ctx) {
      // The composition root built the live boundary for the plugin (index.ts ~L2990); the probe ran on it.
      expect(ctx.boot?.liveBoundary ?? null).not.toBeNull()
      expect(run.error).toBeUndefined()
      expect(run.result).toBeNull()
      expectInsideOwnTransaction(run.trace, /FROM users WHERE id = \$1 AND is_active = true/, 'COMMIT')
      expectBorrowsReturned(run.trace)
    },
  },
])
