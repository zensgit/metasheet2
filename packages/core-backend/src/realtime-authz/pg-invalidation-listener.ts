/**
 * The dedicated listening session of one serving process.
 *
 * One PostgreSQL session per process, outside the business pool, shared by both realtime channels.
 * It is opened only when realtime revalidation requires it. It does three things:
 *
 *   1. LISTEN on the invalidation channel and hand every notice to the protection runtime as a
 *      hint to re-read;
 *   2. report whether it is ready. A lost session, a replaced session, a liveness probe that does
 *      not answer in time and the period of reconnecting are all `not-ready`, during which a
 *      notice may have been missed; the runtime then serves no protected traffic, and every
 *      connection is read again before it is served after the session is back;
 *   3. watch the identity of the database: the listening session and the business pool must be
 *      attached to the same database, not in recovery, and the same one this process first
 *      accepted. A mismatch isolates the process: the listener stays `not-ready` and does not
 *      reconnect by itself.
 *
 * Business statements never run on this session.
 */
import type { ListenerState } from './admission'
import { compareDatabaseIdentity, readDatabaseIdentity, type DatabaseIdentity, type IdentityMismatch, type IdentityQuery } from './database-identity'
import type { RealtimeDiagnostics } from './diagnostics'
import { REALTIME_INVALIDATION_CHANNEL, decodeInvalidationPayload } from './invalidation-notify'
import type { InvalidationListenerPort, InvalidationScope } from './protection'

/** The part of a pg Client this listener uses. */
export interface ListenerClient {
  connect(): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>
  on(event: 'notification', handler: (message: { channel?: string; payload?: string }) => void): unknown
  on(event: 'error', handler: (error: unknown) => void): unknown
  on(event: 'end', handler: () => void): unknown
  removeAllListeners(event?: string): unknown
  end(): Promise<unknown>
}

export type IsolationReason = IdentityMismatch | 'listener-and-pool-differ'

export interface PgInvalidationListenerDeps {
  createClient: () => ListenerClient
  /** Reads the database identity through a connection of the business pool. */
  readPoolIdentity: () => Promise<DatabaseIdentity>
  /**
   * Registers a handler that is called for every new connection of the business pool with a query
   * function bound to that connection. Returns the function that removes the handler.
   */
  onPoolConnection?: (handler: (query: IdentityQuery) => void) => () => void
  diagnostics: RealtimeDiagnostics
  probeIntervalMs?: number
  probeTimeoutMs?: number
  connectTimeoutMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  setTimer?: (handler: () => void, delayMs: number) => { unref?: () => void }
  clearTimer?: (timer: unknown) => void
}

export const DEFAULT_LISTENER_PROBE_INTERVAL_MS = 1_500
export const DEFAULT_LISTENER_PROBE_TIMEOUT_MS = 1_000
export const DEFAULT_LISTENER_CONNECT_TIMEOUT_MS = 3_000
export const DEFAULT_LISTENER_RECONNECT_MIN_MS = 250
export const DEFAULT_LISTENER_RECONNECT_MAX_MS = 5_000

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
  })
  work.then(undefined, () => undefined)
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export class PgInvalidationListener implements InvalidationListenerPort {
  private current: ListenerState = 'not-started'
  private client: ListenerClient | null = null
  private started = false
  private attempting: Promise<void> | null = null
  private timer: unknown = null
  private reconnectDelayMs: number
  private pinned: DatabaseIdentity | null = null
  private isolated: IsolationReason | null = null
  private removePoolHandler: (() => void) | null = null
  /** Sessions opened so far; exactly one is open while the listener is ready. */
  private sessionsOpened = 0
  private readonly stateHandlers: Array<(state: ListenerState) => void> = []
  private readonly noticeHandlers: Array<(scope: InvalidationScope) => void> = []
  private readonly probeIntervalMs: number
  private readonly probeTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimer: (handler: () => void, delayMs: number) => { unref?: () => void }
  private readonly clearTimer: (timer: unknown) => void

  constructor(private readonly deps: PgInvalidationListenerDeps) {
    this.probeIntervalMs = deps.probeIntervalMs ?? DEFAULT_LISTENER_PROBE_INTERVAL_MS
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_LISTENER_PROBE_TIMEOUT_MS
    this.connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_LISTENER_CONNECT_TIMEOUT_MS
    this.reconnectMinMs = deps.reconnectMinMs ?? DEFAULT_LISTENER_RECONNECT_MIN_MS
    this.reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_LISTENER_RECONNECT_MAX_MS
    this.reconnectDelayMs = this.reconnectMinMs
    this.setTimer = deps.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs))
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  }

  state(): ListenerState {
    return this.current
  }

  /** Why this process is isolated, or null. Isolation ends only when the listener is started anew. */
  isolation(): IsolationReason | null {
    return this.isolated
  }

  pinnedIdentity(): DatabaseIdentity | null {
    return this.pinned
  }

  openedSessions(): number {
    return this.sessionsOpened
  }

  onStateChange(handler: (state: ListenerState) => void): void {
    this.stateHandlers.push(handler)
  }

  onNotice(handler: (scope: InvalidationScope) => void): void {
    this.noticeHandlers.push(handler)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.isolated = null
    this.pinned = null
    this.reconnectDelayMs = this.reconnectMinMs
    this.setState('not-ready')
    this.removePoolHandler = this.deps.onPoolConnection?.((query) => this.checkPoolConnection(query)) ?? null
    await this.attempt()
  }

  async stop(): Promise<void> {
    this.started = false
    this.cancelTimer()
    this.removePoolHandler?.()
    this.removePoolHandler = null
    await this.discard(this.client)
    this.client = null
    this.current = 'not-started'
  }

  private setState(next: ListenerState): void {
    if (this.current === next) return
    this.current = next
    for (const handler of [...this.stateHandlers]) {
      try {
        handler(next)
      } catch {
        // A failing subscriber must not stop the listener.
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
  }

  private schedule(handler: () => void, delayMs: number): void {
    this.cancelTimer()
    if (!this.started) return
    const handle = this.setTimer(() => {
      this.timer = null
      handler()
    }, delayMs)
    handle.unref?.()
    this.timer = handle
  }

  private async discard(client: ListenerClient | null): Promise<void> {
    if (!client) return
    try {
      client.removeAllListeners('notification')
      client.removeAllListeners('end')
      client.removeAllListeners('error')
      // An idle socket error after this point must not crash the process.
      client.on('error', () => undefined)
      await withTimeout(Promise.resolve(client.end()), 500, 'listener close')
    } catch {
      // The session is gone or will be reaped by the server.
    }
  }

  private isolate(reason: IsolationReason): void {
    if (this.isolated) return
    this.isolated = reason
    this.deps.diagnostics.recordEvent('database-identity-changed')
    this.cancelTimer()
    const client = this.client
    this.client = null
    this.setState('not-ready')
    void this.discard(client)
  }

  private fail(client: ListenerClient | null): void {
    if (!this.started || this.isolated) return
    if (client !== null && client !== this.client) return
    this.client = null
    this.setState('not-ready')
    void this.discard(client)
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxMs)
    this.schedule(() => { void this.attempt() }, delay)
  }

  private attempt(): Promise<void> {
    if (this.attempting) return this.attempting
    this.attempting = this.attemptOnce().finally(() => {
      this.attempting = null
    })
    return this.attempting
  }

  private async attemptOnce(): Promise<void> {
    if (!this.started || this.isolated) return
    const client = this.deps.createClient()
    let failed = false
    const onFailure = (): void => {
      failed = true
      if (this.client === client) this.fail(client)
    }
    client.on('error', onFailure)
    client.on('end', onFailure)
    client.on('notification', (message) => {
      if (this.client !== client || this.current !== 'ready') return
      if (message.channel !== REALTIME_INVALIDATION_CHANNEL) return
      const scope = decodeInvalidationPayload(message.payload)
      for (const handler of [...this.noticeHandlers]) {
        try {
          handler(scope)
        } catch {
          // A failing subscriber must not stop the listener.
        }
      }
    })
    try {
      await withTimeout(Promise.resolve(client.connect()), this.connectTimeoutMs, 'listener connect')
      this.sessionsOpened += 1
      await withTimeout(client.query(`LISTEN ${REALTIME_INVALIDATION_CHANNEL}`), this.connectTimeoutMs, 'listen')
      const mismatch = await this.checkContinuity(client)
      if (!this.started || failed) throw new Error('listener session lost while starting')
      if (mismatch) {
        this.isolate(mismatch)
        await this.discard(client)
        return
      }
    } catch {
      await this.discard(client)
      if (!this.started || this.isolated) return
      this.setState('not-ready')
      const delay = this.reconnectDelayMs
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxMs)
      this.schedule(() => { void this.attempt() }, delay)
      return
    }
    this.client = client
    this.reconnectDelayMs = this.reconnectMinMs
    this.setState('ready')
    this.schedule(() => { void this.probe() }, this.probeIntervalMs)
  }

  /** Reads the identity on the listening session and through the pool; pins it the first time. */
  private async checkContinuity(client: ListenerClient): Promise<IsolationReason | null> {
    const listenerIdentity = await withTimeout(readDatabaseIdentity((sql) => client.query(sql)), this.probeTimeoutMs, 'identity read')
    const poolIdentity = await withTimeout(this.deps.readPoolIdentity(), this.probeTimeoutMs, 'pool identity read')
    if (listenerIdentity.inRecovery || poolIdentity.inRecovery) return 'in-recovery'
    if (compareDatabaseIdentity(listenerIdentity, poolIdentity) !== null) return 'listener-and-pool-differ'
    if (!this.pinned) {
      this.pinned = listenerIdentity
      return null
    }
    return compareDatabaseIdentity(this.pinned, listenerIdentity)
  }

  /** Liveness of the session (a half-open connection does not answer) and continuity of the database. */
  private async probe(): Promise<void> {
    const client = this.client
    if (!this.started || this.isolated || !client || this.current !== 'ready') return
    try {
      const mismatch = await this.checkContinuity(client)
      if (this.client !== client) return
      if (mismatch) {
        this.isolate(mismatch)
        return
      }
    } catch {
      this.fail(client)
      return
    }
    this.schedule(() => { void this.probe() }, this.probeIntervalMs)
  }

  private checkPoolConnection(query: IdentityQuery): void {
    if (!this.started || this.isolated || !this.pinned) return
    const pinned = this.pinned
    void readDatabaseIdentity(query).then((identity) => {
      if (!this.started || this.isolated || this.pinned !== pinned) return
      const mismatch = compareDatabaseIdentity(pinned, identity)
      if (mismatch) this.isolate(mismatch)
    }, () => {
      // The connection could not be read; the next probe decides.
    })
  }
}
