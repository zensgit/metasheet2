/**
 * Release probe for the W4 connection-destroy legs (P1-1 「连接销毁语义」, acceptance A05 / A06).
 *
 * A real `AttendanceManagedPgPool` (`max: 1`) with two instrumented entry points shaped like production:
 *  - `provider()` is an `acquireConnection` closure shaped like the composition-root ones
 *    (`src/index.ts`): `{ client, release: (error?: Error) => client.release(error) }`, optionally
 *    wrapping the client the way the PROC / RES providers do;
 *  - `pool()` is the `Pick<Pool, 'connect'>` the OPS entry points receive, whose checkouts are
 *    released by the code under test calling pg's `client.release(err?)` directly.
 *
 * Every checkout is one numbered borrow. Test-only native query observation
 * runs below the managed dispatcher and forwards the original pg arguments,
 * including native COMMIT QueryConfig. The facade is never rewritten or issued
 * as a query wrapper. Native protocol state still comes from real PostgreSQL.
 * Release attempts are observed before the real facade's guard; pool events
 * independently record accepted handoffs. No opaque client identity is replaced.
 *
 * Faults are one-shot and armed BEFORE the boundary call; each arm returns the fresh error object
 * it will throw, so a leg can assert it receives that same object. A faulted statement is never
 * sent to the server (outcome `faulted`):
 *  - body: the first statement after the runner's `BEGIN ISOLATION LEVEL SERIALIZABLE` and its two
 *    `set_config` calls, counted by position (a body may itself start with a `set_config`);
 *  - rollback: the next `ROLLBACK` (the server transaction stays open; only a destroy ends it);
 *  - commit: the next `COMMIT` (also when it arrives as a config object, as the CCON wrapper sends it).
 * One fault is the exception, a lost result rather than a failed send (outcome `lost`):
 *  - rollback-lost: the next `ROLLBACK` IS sent and runs on the server (its transaction really ends,
 *    the connection is idle again), then the client is handed the armed error instead of the result.
 *    Same shape as `attendance-report-cleaning-proposal.db.test.ts`'s lost-response faults.
 *
 * Pool events (`release`, `remove`) are recorded per borrow, not per client: with `max: 1` the same
 * pg client is handed out again after a normal return.
 */
import type { PoolClient } from 'pg'
import { AttendanceManagedPgPool, attendanceOwningSessionForClientV1, type AttendanceOwningSessionV1 } from '../../src/attendance/attendance-owning-session'
import { attendanceOwnedNativeQueryProbeV1 } from './attendance-owned-native-query-probe'

export type AttendanceW4ReleaseProbeFaultKind = 'body' | 'rollback' | 'rollback-lost' | 'commit'

/** `faulted`: never sent. `lost`: sent and executed by the server, then failed on the client. */
export type AttendanceW4ReleaseProbeStatementOutcome = 'ok' | 'error' | 'faulted' | 'lost'

export interface AttendanceW4ReleaseProbeStatement {
  readonly text: string
  outcome: AttendanceW4ReleaseProbeStatementOutcome | 'pending'
  readonly fault: AttendanceW4ReleaseProbeFaultKind | null
}

export interface AttendanceW4ReleaseProbeBorrow {
  /** 1-based checkout ordinal within this probe (`nextPid` checkouts are not counted). */
  readonly ordinal: number
  readonly client: PoolClient
  readonly pid: number
  readonly statements: AttendanceW4ReleaseProbeStatement[]
  /** Caller arguments at the real facade release entry, including rejected attempts. */
  readonly releaseCalls: Array<Error | undefined>
  /** `err` of each pool `release` event emitted for this checkout. */
  readonly releaseEvents: Array<Error | undefined>
  removed: boolean
  /** Faults attached to this checkout that have not fired. */
  readonly unfired: AttendanceW4ReleaseProbeFaultKind[]
  /** Resolves when the pool emits `remove` for this checkout's client. */
  readonly removal: Promise<void>
}

interface ArmedFault {
  readonly kind: AttendanceW4ReleaseProbeFaultKind
  readonly error: Error
  remainingSkips: number
}

interface BorrowState extends AttendanceW4ReleaseProbeBorrow {
  faults: ArmedFault[]
  /** -1 before BEGIN; then the number of statements seen since BEGIN. */
  sinceBegin: number
  resolveRemoval: () => void
  restoreNative: () => void
}

export interface AttendanceW4ReleaseProbeArmOptions {
  /** How many future checkouts to let pass before this fault attaches (default 0: the next one). */
  readonly skipBorrows?: number
}

export interface AttendanceW4ReleaseProbe {
  readonly raw: AttendanceManagedPgPool
  readonly borrows: readonly AttendanceW4ReleaseProbeBorrow[]
  provider(): () => Promise<{ client: AttendanceOwningSessionV1; release: (error?: Error) => void }>
  provider<T>(wrap: (client: PoolClient) => T): () => Promise<{ client: T; release: (error?: Error) => void }>
  pool(): Pick<AttendanceManagedPgPool, 'connect'>
  /** `code` (default `'PROBE_BODY'`) is the SQLSTATE-like code the thrown body error carries, e.g. `'40001'`. */
  failNextBodyStatement(options?: AttendanceW4ReleaseProbeArmOptions & { readonly code?: string }): Error
  failNextRollback(options?: AttendanceW4ReleaseProbeArmOptions): Error
  /** The next ROLLBACK runs on the server; its result is replaced by the returned error on the client. */
  loseNextRollbackResult(options?: AttendanceW4ReleaseProbeArmOptions): Error
  failNextCommit(code: string, options?: AttendanceW4ReleaseProbeArmOptions): Error
  /** Faults armed but not yet attached to any checkout. */
  pendingFaults(): AttendanceW4ReleaseProbeFaultKind[]
  /** Statement shape of a checkout: `<label>:<outcome>`; the faulted body statement is labelled `body`; a lost ROLLBACK is `ROLLBACK:lost`. */
  shape(borrow: AttendanceW4ReleaseProbeBorrow): string[]
  /** Only BEGIN / COMMIT / ROLLBACK, as `<label>:<outcome>`. */
  controlShape(borrow: AttendanceW4ReleaseProbeBorrow): string[]
  waitForRemoval(borrow: AttendanceW4ReleaseProbeBorrow, timeoutMs?: number): Promise<boolean>
  /** Borrows directly from the pool, reads the backend pid, releases normally. */
  nextPid(): Promise<number>
  end(): Promise<void>
}

const BEGIN = 'BEGIN ISOLATION LEVEL SERIALIZABLE'


function label(statement: AttendanceW4ReleaseProbeStatement): string {
  if (statement.fault === 'body') return 'body'
  const text = statement.text
  if (text === BEGIN) return 'BEGIN'
  if (text === 'COMMIT') return 'COMMIT'
  if (text === 'ROLLBACK') return 'ROLLBACK'
  if (text.startsWith("SELECT set_config('statement_timeout'")) return 'set_config(statement_timeout)'
  if (text.startsWith("SELECT set_config('lock_timeout'")) return 'set_config(lock_timeout)'
  return 'statement'
}

// Test-only construction instrumentation: wrap the original proxy handler's
// release function while preserving the exact Proxy registered by the issuer.
// The global constructor is restored synchronously before any checkout callback;
// no production hook, outer client wrapper, trusted stamp or protocol setter.
export class AttendanceReleaseObservedPool extends AttendanceManagedPgPool {
  readonly releaseAttempts = new WeakMap<PoolClient, Array<Error | undefined>>()

  _acquireClient(...args: Parameters<AttendanceManagedPgPool['_acquireClient']>): void {
    const NativeProxy = globalThis.Proxy
    const attempts = this.releaseAttempts
    globalThis.Proxy = new NativeProxy(NativeProxy, {
      construct(constructor, parameters) {
        const [target, handler] = parameters as [object, ProxyHandler<object>]
        if (Object.getPrototypeOf(target) !== null || typeof handler.get !== 'function') {
          return Reflect.construct(constructor, parameters)
        }
        const originalGet = handler.get
        const calls: Array<Error | undefined> = []
        const wrappers = new Map<object, (error?: Error) => unknown>()
        const facade = Reflect.construct(constructor, [target, {
          ...handler,
          get(object: object, key: PropertyKey, receiver: unknown) {
            const value = Reflect.apply(originalGet, handler, [object, key, receiver])
            if (key !== 'release' || typeof value !== 'function') return value
            let wrapper = wrappers.get(value)
            if (!wrapper) {
              wrapper = (...releaseArgs: [Error?]) => {
                calls.push(releaseArgs[0])
                return Reflect.apply(value, receiver, releaseArgs)
              }
              wrappers.set(value, wrapper)
            }
            return wrapper
          },
        }]) as PoolClient
        attempts.set(facade, calls)
        return facade
      },
    })
    try {
      super._acquireClient(...args)
    } finally {
      globalThis.Proxy = NativeProxy
    }
  }
}

export function createAttendanceW4ReleaseProbe(connectionString: string): AttendanceW4ReleaseProbe {
  // idleTimeoutMillis 0: no idle reaping, so a `remove` can only come from a destroy.
  const raw = new AttendanceReleaseObservedPool({ connectionString, max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 10_000 })
  const borrows: BorrowState[] = []
  const pending: ArmedFault[] = []
  const lastBorrowOf = new Map<number, BorrowState>()

  raw.on('error', () => undefined)
  raw.on('release', (error: Error | undefined, client: PoolClient) => {
    const borrow = lastBorrowOf.get(Number((client as PoolClient & { processID: number }).processID))
    if (!borrow || borrow.client !== client) return
    borrow.releaseEvents.push(error)
    borrow.restoreNative()
  })
  raw.on('remove', (client: PoolClient) => {
    const borrow = lastBorrowOf.get(Number((client as PoolClient & { processID: number }).processID))
    if (!borrow) return
    borrow.removed = true
    borrow.resolveRemoval()
  })

  function arm(kind: AttendanceW4ReleaseProbeFaultKind, error: Error, options?: AttendanceW4ReleaseProbeArmOptions): Error {
    const skips = options?.skipBorrows ?? 0
    if (!Number.isInteger(skips) || skips < 0) throw new Error('probe: skipBorrows must be a non-negative integer')
    pending.push({ kind, error, remainingSkips: skips })
    return error
  }

  async function borrow(): Promise<BorrowState> {
    const client = await raw.connect()
    const { rows } = await client.query('SELECT pg_backend_pid() AS pid')
    let resolveRemoval!: () => void
    const removal = new Promise<void>((resolve) => {
      resolveRemoval = resolve
    })
    const state: BorrowState = {
      ordinal: borrows.length + 1,
      client,
      pid: Number(rows[0].pid),
      statements: [],
      releaseCalls: raw.releaseAttempts.get(client)!,
      releaseEvents: [],
      removed: false,
      unfired: [],
      removal,
      faults: [],
      sinceBegin: -1,
      resolveRemoval,
      restoreNative: () => undefined,
    }
    for (let i = 0; i < pending.length; ) {
      const fault = pending[i]!
      if (fault.remainingSkips === 0) {
        state.faults.push(fault)
        state.unfired.push(fault.kind)
        pending.splice(i, 1)
      } else {
        fault.remainingSkips -= 1
        i += 1
      }
    }
    borrows.push(state)
    lastBorrowOf.set(state.pid, state)

    const take = (kind: AttendanceW4ReleaseProbeFaultKind): ArmedFault | null => {
      const index = state.faults.findIndex((fault) => fault.kind === kind)
      if (index < 0) return null
      const [fault] = state.faults.splice(index, 1)
      state.unfired.splice(state.unfired.indexOf(kind), 1)
      return fault!
    }
    const nativeProbe = attendanceOwnedNativeQueryProbeV1(raw, client, (call) => {
      const text = call.text
      let fault: ArmedFault | null = null
      if (text === BEGIN) {
        state.sinceBegin = 0
      } else if (state.sinceBegin >= 0) {
        state.sinceBegin += 1
        // Statements 1 and 2 after BEGIN are the runner's two set_config calls; the third is the body's first.
        if (state.sinceBegin === 3) fault = take('body')
      }
      if (!fault && text === 'ROLLBACK') fault = take('rollback')
      if (!fault && text === 'ROLLBACK') fault = take('rollback-lost')
      if (!fault && text === 'COMMIT') fault = take('commit')
      const statement: AttendanceW4ReleaseProbeStatement = { text, outcome: 'pending', fault: fault ? fault.kind : null }
      state.statements.push(statement)
      // A lost-result fault lets the statement through to the server and fails only the reply.
      const lost = fault !== null && fault.kind === 'rollback-lost' ? fault : null
      if (fault && !lost) {
        statement.outcome = 'faulted'
        return Promise.reject(fault.error)
      }
      const sent = call.next() as Promise<unknown>
      return sent.then(
        (result) => {
          if (lost) {
            statement.outcome = 'lost'
            throw lost.error
          }
          statement.outcome = 'ok'
          return result
        },
        (error: unknown) => {
          statement.outcome = 'error'
          throw error
        },
      )
    })
    state.restoreNative = nativeProbe.restore
    return state
  }

  function provider<T>(wrap?: (client: PoolClient) => T) {
    return async () => {
      const state = await borrow()
      const client = state.client
      return {
        client: wrap ? wrap(client) : attendanceOwningSessionForClientV1(client),
        release: (error?: Error) => client.release(error),
      }
    }
  }

  return {
    raw,
    borrows,
    provider: provider as AttendanceW4ReleaseProbe['provider'],
    pool() {
      return { connect: async () => (await borrow()).client } as unknown as Pick<AttendanceManagedPgPool, 'connect'>
    },
    failNextBodyStatement(options) {
      const code = options?.code ?? 'PROBE_BODY'
      if (typeof code !== 'string' || code.length === 0) throw new Error('probe: body fault code must be a non-empty string')
      return arm('body', Object.assign(new Error('probe: body failed'), { code }), options)
    },
    failNextRollback(options) {
      return arm('rollback', Object.assign(new Error('probe: rollback failed'), { code: 'PROBE_ROLLBACK' }), options)
    },
    loseNextRollbackResult(options) {
      return arm('rollback-lost', Object.assign(new Error('probe: rollback result lost'), { code: 'PROBE_ROLLBACK_LOST' }), options)
    },
    failNextCommit(code, options) {
      return arm('commit', Object.assign(new Error('probe: commit failed'), { code }), options)
    },
    pendingFaults() {
      return pending.map((fault) => fault.kind)
    },
    shape(borrowed) {
      return borrowed.statements.map((statement) => `${label(statement)}:${statement.outcome}`)
    },
    controlShape(borrowed) {
      return borrowed.statements
        .filter((statement) => statement.fault !== 'body')
        .filter((statement) => [BEGIN, 'COMMIT', 'ROLLBACK'].includes(statement.text))
        .map((statement) => `${label(statement)}:${statement.outcome}`)
    },
    async waitForRemoval(borrowed, timeoutMs = 5_000) {
      if (borrowed.removed) return true
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
      try {
        return await Promise.race([borrowed.removal.then(() => true as const), timeout])
      } finally {
        clearTimeout(timer)
      }
    },
    async nextPid() {
      const client = await raw.connect()
      try {
        const { rows } = await client.query('SELECT pg_backend_pid() AS pid')
        return Number(rows[0].pid)
      } finally {
        client.release()
      }
    },
    async end() {
      for (const state of borrows) state.restoreNative()
      await raw.end()
    },
  }
}
