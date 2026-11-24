/**
 * Reconnection after a refusal by the realtime server.
 *
 * The transport library reconnects by itself after a network failure. It does not after the server
 * closes a connection on purpose (`io server disconnect`) or refuses a handshake (`connect_error`
 * from the server): the socket is left closed. Some of those refusals are transient — the server
 * could not decide right now and says `retry: true` — and some are final — the session is no longer
 * current, `retry: false`.
 *
 * This module tells the two apart and reconnects after a transient one, with capped exponential
 * backoff. After a final one it leaves the socket closed: reconnecting with the same credential
 * would only be refused again.
 *
 * It has no dependency on the transport library or on Vue; it works on anything with `on`.
 */

export const SESSION_ENDED_EVENT = 'realtime:session-ended'
export const SERVER_DISCONNECT_REASON = 'io server disconnect'

export const DEFAULT_RECONNECT_MIN_DELAY_MS = 1_000
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000

/** What the server said when it ended or refused a connection. */
export interface RealtimeRefusalNotice {
  code: string
  retry: boolean
}

export type RefusalKind =
  /** The server could not serve right now: reconnect later. */
  | 'transient'
  /** The server will not serve this credential again: do not reconnect. */
  | 'final'
  /** Not a refusal by the server, or one this module does not act on. */
  | 'none'

/** Reads `{ code, retry }` from an event payload or from the data of a handshake error. */
export function readRefusalNotice(payload: unknown): RealtimeRefusalNotice | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { code?: unknown; retry?: unknown }
  if (typeof record.retry !== 'boolean') return null
  return { code: typeof record.code === 'string' ? record.code : '', retry: record.retry }
}

/**
 * A disconnect. Only one the server made on purpose is a refusal; it is final only when the server
 * said so before closing. A server close with no notice is treated as transient: a connection that
 * shares its transport with another one is closed together with it and is told nothing itself, and
 * if its session really ended the next handshake says so.
 */
export function classifyDisconnect(reason: unknown, lastNotice: RealtimeRefusalNotice | null): RefusalKind {
  if (reason !== SERVER_DISCONNECT_REASON) return 'none'
  if (lastNotice && lastNotice.retry === false) return 'final'
  return 'transient'
}

/**
 * A failed handshake. While the transport library is still trying by itself (`active`), nothing is
 * done here. A refusal by the server is transient only when it says `retry: true`; one that says
 * `retry: false` is final; one that says nothing is left alone, as it always was.
 */
export function classifyConnectError(error: unknown, active: boolean | undefined): RefusalKind {
  if (active === true) return 'none'
  const notice = readRefusalNotice((error as { data?: unknown } | null | undefined)?.data)
  if (!notice) return 'none'
  return notice.retry ? 'transient' : 'final'
}

export interface ReconnectBackoff {
  /** The next delay; every call without a reset in between is longer, up to the cap. */
  next(): number
  reset(): void
  readonly attempts: number
}

export interface ReconnectBackoffOptions {
  minDelayMs?: number
  maxDelayMs?: number
  /** Returns a number in [0, 1); the delay is spread over the upper half of its step. */
  random?: () => number
}

export function createReconnectBackoff(options: ReconnectBackoffOptions = {}): ReconnectBackoff {
  const minDelayMs = Math.max(1, options.minDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS)
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS)
  const random = options.random ?? Math.random
  let attempts = 0
  return {
    next() {
      const step = Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(attempts, 30))
      attempts += 1
      // Half fixed, half spread: clients that were refused together do not come back together.
      return Math.round(step / 2 + (step / 2) * random())
    },
    reset() {
      attempts = 0
    },
    get attempts() {
      return attempts
    },
  }
}

/** The part of a realtime socket this module uses. */
export interface ReconnectableSocket {
  on(event: string, handler: (...args: any[]) => void): unknown
  connect?: () => unknown
  readonly active?: boolean
}

export interface RealtimeReconnectOptions extends ReconnectBackoffOptions {
  /** How to reconnect; the default opens the same socket again. */
  reconnect?: () => void
  /** Called on every connect after the first: the place to ask for rooms again. */
  onReconnected?: () => void
  /** Called once when the server refused for good. */
  onFinal?: (notice: RealtimeRefusalNotice | null) => void
  setTimer?: (handler: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface RealtimeReconnectHandle {
  /** Stops for good: call it when the owner closes the socket itself. */
  stop(): void
  /** True after a final refusal. */
  readonly final: boolean
  /** True while a reconnect is scheduled. */
  readonly waiting: boolean
}

/**
 * Installs the behaviour on one socket. Install it right after the socket is created, before the
 * owner registers its own listeners, and call `stop()` when the owner closes the socket.
 */
export function installRealtimeReconnect(socket: ReconnectableSocket, options: RealtimeReconnectOptions = {}): RealtimeReconnectHandle {
  const backoff = createReconnectBackoff(options)
  const setTimer = options.setTimer ?? ((handler: () => void, delayMs: number) => setTimeout(handler, delayMs))
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const reconnect = options.reconnect ?? (() => { socket.connect?.() })
  let lastNotice: RealtimeRefusalNotice | null = null
  let timer: unknown = null
  let stopped = false
  let final = false
  let connectedOnce = false

  function schedule(): void {
    if (stopped || final || timer !== null) return
    timer = setTimer(() => {
      timer = null
      if (stopped || final) return
      reconnect()
    }, backoff.next())
  }

  function refuse(kind: RefusalKind, notice: RealtimeRefusalNotice | null): void {
    if (kind === 'transient') schedule()
    if (kind === 'final' && !final) {
      final = true
      if (timer !== null) clearTimer(timer)
      timer = null
      options.onFinal?.(notice)
    }
  }

  if (typeof socket?.on !== 'function') {
    return { stop: () => undefined, get final() { return false }, get waiting() { return false } }
  }

  socket.on(SESSION_ENDED_EVENT, (payload: unknown) => {
    lastNotice = readRefusalNotice(payload)
  })
  socket.on('disconnect', (reason: unknown) => {
    const notice = lastNotice
    lastNotice = null
    refuse(classifyDisconnect(reason, notice), notice)
  })
  socket.on('connect_error', (error: unknown) => {
    refuse(classifyConnectError(error, socket.active), readRefusalNotice((error as { data?: unknown } | null)?.data))
  })
  socket.on('connect', () => {
    backoff.reset()
    lastNotice = null
    if (connectedOnce && !stopped) options.onReconnected?.()
    connectedOnce = true
  })

  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
    get final() {
      return final
    },
    get waiting() {
      return timer !== null
    },
  }
}
