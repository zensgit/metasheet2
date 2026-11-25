/**
 * The client connections that are still open when the server stops.
 *
 * `httpServer.close()` stops listening and ends the connections that are idle at that moment, then
 * waits for every other connection to end before its callback runs. A realtime connection, a long
 * poll, or a keep-alive connection that becomes idle only after that moment would keep the callback
 * from running, so the producer barrier of the stop would time out and the stop would fail. This
 * module ends those connections, in this order:
 *
 *   - at the start of the stop (right after the listener closed, in the same synchronous step):
 *       - every request that arrives after this point on a connection kept open is answered 503
 *         SERVER_STOPPING and its connection is closed (`fence`); requests admitted before go on;
 *       - the idle time of a keep-alive connection is set to its least value, so a connection whose
 *         response finishes after this point closes about one second after that response finished.
 *         Nothing is cut: the idle close is armed only after the response finished;
 *   - once the precondition has settled (the stop of the realtime documents, when there is one;
 *     without one, at once), or at the latest CLIENT_CLOSE_ABSOLUTE_MS - CLIENT_CLOSE_GRACE_MS after
 *     the start: the transport of every realtime connection is closed with its standard close, which
 *     writes the packets already queued first (`closeTransports`, given by the caller);
 *   - CLIENT_CLOSE_GRACE_MS later, and never later than CLIENT_CLOSE_ABSOLUTE_MS after the start, and
 *     only when connections are left: the transports are closed once more, and every connection
 *     taken over by a realtime server that is still open is destroyed. A connection taken over after
 *     the transports were closed is destroyed at once.
 *
 * Every state is held by one instance; an instance belongs to one server. Every timer is unref'd and
 * is cleared by `finish()`, which the stop calls on every exit. No timer exists unless there is
 * something to wait for.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { Duplex } from 'stream'

/** Time a realtime connection is given to answer the close of its transport. */
export const CLIENT_CLOSE_GRACE_MS = 1_000
/** From the start of the stop: the latest time any realtime connection is still open. */
export const CLIENT_CLOSE_ABSOLUTE_MS = 9_000
/** Idle time of a keep-alive connection once the stop has begun (0 would arm no idle close at all). */
export const IDLE_KEEP_ALIVE_MS = 1

/** The parts of the HTTP server the stop reads or sets; a test double may lack any of them. */
interface StopHttpServer {
  keepAliveTimeout?: unknown
  getConnections?: (callback: (error: Error | null, count: number) => void) => unknown
}

/** The parts of the HTTP server the tracking needs; a test double may lack any of them. */
interface TrackedHttpServer {
  listenerCount?: (eventName: string) => number
  on?: (eventName: 'upgrade', listener: (request: IncomingMessage, socket: Duplex) => void) => unknown
}

export interface ClientConnectionStopOptions {
  /** The server as it is at the stop (read by the caller at that time). */
  httpServer: unknown
  /** Closes the transport of every realtime connection with its standard close; returns how many. */
  closeTransports: () => number
  /** When given, the transports are closed only once it has settled (fulfilled or rejected). */
  precondition?: Promise<unknown>
}

export interface ClientConnectionStop {
  /** Clears every timer of the stop. Safe to call more than once. */
  finish(): void
}

export interface ClientConnectionShutdown {
  /** Middleware: after `begin`, answers 503 SERVER_STOPPING and closes the connection. */
  readonly fence: (request: IncomingMessage, response: ServerResponse, next: () => void) => void
  /** Called by the start, once the realtime servers are attached and before the server listens. */
  arm(httpServer: unknown): void
  /** Called by the stop right after the listener closed. */
  begin(options: ClientConnectionStopOptions): ClientConnectionStop
  /** Whether the stop of this instance has begun. */
  isStopping(): boolean
}

const STOPPING_BODY = JSON.stringify({ ok: false, error: { code: 'SERVER_STOPPING', message: 'Server is stopping' } })

export function createClientConnectionShutdown(): ClientConnectionShutdown {
  let stopping = false
  let armed = false
  let transportsClosed = false
  const upgraded = new Set<Duplex>()

  const fence = (_request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (!stopping) {
      next()
      return
    }
    response.statusCode = 503
    response.setHeader('Connection', 'close')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Length', Buffer.byteLength(STOPPING_BODY))
    response.end(STOPPING_BODY)
  }

  const arm = (httpServer: unknown): void => {
    const server = httpServer as TrackedHttpServer | null | undefined
    if (armed || !server || typeof server.listenerCount !== 'function' || typeof server.on !== 'function') return
    // No realtime server took the upgrade (its start failed): track nothing, so such a request keeps
    // the answer it has today.
    if (server.listenerCount('upgrade') === 0) return
    armed = true
    server.on('upgrade', (_request, socket) => {
      if (transportsClosed) {
        socket.destroy()
        return
      }
      if (socket.destroyed) return
      upgraded.add(socket)
      socket.once('close', () => {
        upgraded.delete(socket)
      })
    })
  }

  const begin = ({ httpServer, closeTransports, precondition }: ClientConnectionStopOptions): ClientConnectionStop => {
    stopping = true
    const server = (httpServer ?? {}) as StopHttpServer
    if (typeof server.keepAliveTimeout === 'number') server.keepAliveTimeout = IDLE_KEEP_ALIVE_MS
    const startedAt = Date.now()
    let finished = false
    let capTimer: ReturnType<typeof setTimeout> | null = null
    let lastCloseTimer: ReturnType<typeof setTimeout> | null = null

    const closeTransportsOnce = (): void => {
      try {
        closeTransports()
      } catch {
        // A transport that could not be closed is left to the drain timeout of the stop.
      }
    }

    const lastClose = (): void => {
      lastCloseTimer = null
      if (finished) return
      // Transports created since the first close (a handshake on a connection that was still open).
      closeTransportsOnce()
      for (const socket of [...upgraded]) socket.destroy()
      upgraded.clear()
    }

    const closeClients = (): void => {
      if (finished || transportsClosed) return
      transportsClosed = true
      if (capTimer) {
        clearTimeout(capTimer)
        capTimer = null
      }
      closeTransportsOnce()
      // A test double without a connection count has nothing left to end. Never judged by whether
      // the server listens: it no longer does once the stop has begun, while connections remain.
      if (typeof server.getConnections !== 'function') return
      const closedAt = Date.now()
      server.getConnections((error, count) => {
        if (finished || error || !(count > 0)) return
        const due = Math.min(closedAt + CLIENT_CLOSE_GRACE_MS, startedAt + CLIENT_CLOSE_ABSOLUTE_MS)
        lastCloseTimer = setTimeout(lastClose, Math.max(0, due - Date.now()))
        lastCloseTimer.unref?.()
      })
    }

    if (precondition === undefined) {
      closeClients()
    } else {
      capTimer = setTimeout(closeClients, CLIENT_CLOSE_ABSOLUTE_MS - CLIENT_CLOSE_GRACE_MS)
      capTimer.unref?.()
      precondition.then(closeClients, closeClients)
    }

    return {
      finish: () => {
        finished = true
        if (capTimer) clearTimeout(capTimer)
        if (lastCloseTimer) clearTimeout(lastCloseTimer)
        capTimer = null
        lastCloseTimer = null
      },
    }
  }

  return { fence, arm, begin, isStopping: () => stopping }
}
