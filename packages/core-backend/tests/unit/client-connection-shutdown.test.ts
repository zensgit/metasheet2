/**
 * Client connections still open when the server stops (design lock STOP-BARRIER-OPEN-CONNECTIONS
 * v1 / v2 / v2.1): unit cases with doubles and fake timers.
 *
 *   U1   the module: keep-alive idle time, the precondition, the cap, the last close, the tracking
 *        of connections taken over by a realtime server, and its timers;
 *   U1s  both services close every transport with the standard close (no argument);
 *   U2   MetaSheetServer.stop() settles and closes the pool once while connections are open, each
 *        ended only by an action of the module;
 *   U3   the signal handler exits 0 when the stop went through;
 *   U4   the fence answers 503 SERVER_STOPPING after the stop began, and only then;
 *   U4b  the stopping state belongs to one instance;
 *   U5   the stop closes the transports of both services (twice when the last close runs);
 *   U4c  the fence and its mount, read from the syntax tree: a snapshot of the whole fence, nine
 *        targeted checks, and the delegating mount right after cors();
 *   U6   a stop that fails clears the timers of the module;
 *   U6b  a synchronous throw after the module began: same reason, timers back to their baseline;
 *   U6c  a synchronous throw before the module began: same reason, nothing opened;
 *   U7   finish() never throws, whenever it is called;
 *   U1s+ a client whose close throws does not keep the others open (both services).
 */
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pool as pgPool } from '../../src/db/pg'
import { ICollabService } from '../../src/di/identifiers'
import { MetaSheetServer } from '../../src/index'
import {
  CLIENT_CLOSE_ABSOLUTE_MS,
  CLIENT_CLOSE_GRACE_MS,
  IDLE_KEEP_ALIVE_MS,
  createClientConnectionShutdown,
} from '../../src/lifecycle/client-connection-shutdown'
import { CollabService } from '../../src/services/CollabService'
import { MetricsStreamService } from '../../src/services/MetricsStreamService'

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }

type UpgradeListener = (request: unknown, socket: FakeSocket) => void

class FakeSocket extends EventEmitter {
  destroyed = false
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  })
}

/** A double of the HTTP server as the module sees it. */
function fakeHttpServer(options: { connections?: number; asyncCount?: boolean; upgradeListeners?: number; withCount?: boolean } = {}) {
  const upgradeListeners: UpgradeListener[] = []
  const server = {
    keepAliveTimeout: 5_000 as unknown,
    listening: false,
    connections: options.connections ?? 0,
    getConnections: vi.fn((callback: (error: Error | null, count: number) => void) => {
      if (options.asyncCount) process.nextTick(callback, null, server.connections)
      else callback(null, server.connections)
    }),
    listenerCount: vi.fn((eventName: string) => (eventName === 'upgrade' ? options.upgradeListeners ?? 1 : 0)),
    on: vi.fn((eventName: string, listener: UpgradeListener) => {
      if (eventName === 'upgrade') upgradeListeners.push(listener)
    }),
    closeAllConnections: vi.fn(),
    closeIdleConnections: vi.fn(),
    upgrade(socket: FakeSocket) {
      for (const listener of upgradeListeners) listener({}, socket)
    },
  }
  if (options.withCount === false) delete (server as { getConnections?: unknown }).getConnections
  return server
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** One GET on a connection of its own. */
function get(port: number, path = '/anything'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    request.on('error', reject)
  })
}

describe('U1 the module', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('exports its three constants', () => {
    expect(CLIENT_CLOSE_GRACE_MS).toBe(1_000)
    expect(CLIENT_CLOSE_ABSOLUTE_MS).toBe(9_000)
    expect(IDLE_KEEP_ALIVE_MS).toBe(1)
  })

  it('sets the keep-alive idle time to 1 at the start; leaves a value that is not a number alone', () => {
    const server = fakeHttpServer()
    createClientConnectionShutdown().begin({ httpServer: server, closeTransports: () => 0 }).finish()
    expect(server.keepAliveTimeout).toBe(1)
    const double = { keepAliveTimeout: undefined as unknown }
    createClientConnectionShutdown().begin({ httpServer: double, closeTransports: () => 0 }).finish()
    expect(double.keepAliveTimeout).toBeUndefined()
  })

  it('without a precondition: closes the transports at once, then the last close G later when connections are left', async () => {
    const server = fakeHttpServer({ connections: 1 })
    const instance = createClientConnectionShutdown()
    instance.arm(server)
    const tracked = new FakeSocket()
    server.upgrade(tracked)
    const closeTransports = vi.fn(() => 1)
    const stop = instance.begin({ httpServer: server, closeTransports })
    expect(closeTransports).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS - 1)
    expect(tracked.destroy).not.toHaveBeenCalled()
    expect(closeTransports).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(tracked.destroy).toHaveBeenCalledTimes(1)
    expect(closeTransports).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    stop.finish()
    expect(server.closeAllConnections).not.toHaveBeenCalled()
    expect(server.closeIdleConnections).not.toHaveBeenCalled()
  })

  it('arms no last close when no connection is left, and no timer at all for a double without a connection count', () => {
    const empty = fakeHttpServer({ connections: 0 })
    const closeTransports = vi.fn(() => 0)
    const first = createClientConnectionShutdown().begin({ httpServer: empty, closeTransports })
    expect(closeTransports).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    first.finish()
    // A server that never started and has no realtime server (io null): nothing to wait for.
    const bare = fakeHttpServer({ withCount: false })
    const second = createClientConnectionShutdown().begin({ httpServer: bare, closeTransports: () => 0 })
    expect(vi.getTimerCount()).toBe(0)
    second.finish()
    const nothing = createClientConnectionShutdown().begin({ httpServer: { listening: false, close: () => undefined }, closeTransports: () => 0 })
    expect(vi.getTimerCount()).toBe(0)
    nothing.finish()
  })

  it('arms the last close when the server no longer listens but a connection is left (never judged by listening)', async () => {
    const server = fakeHttpServer({ connections: 1, asyncCount: true })
    server.listening = false
    const closeTransports = vi.fn(() => 0)
    const stop = createClientConnectionShutdown().begin({ httpServer: server, closeTransports })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS)
    expect(closeTransports).toHaveBeenCalledTimes(2)
    stop.finish()
  })

  it('waits for a pending precondition: no transport is closed and no taken-over connection is destroyed before it settles', async () => {
    const server = fakeHttpServer({ connections: 1 })
    const instance = createClientConnectionShutdown()
    instance.arm(server)
    const early = new FakeSocket()
    server.upgrade(early)
    const precondition = deferred()
    const closeTransports = vi.fn(() => 1)
    const stop = instance.begin({ httpServer: server, closeTransports, precondition: precondition.promise })
    // A connection taken over while the precondition is pending is tracked, not destroyed.
    const during = new FakeSocket()
    server.upgrade(during)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(closeTransports).not.toHaveBeenCalled()
    expect(early.destroy).not.toHaveBeenCalled()
    expect(during.destroy).not.toHaveBeenCalled()
    precondition.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeTransports).toHaveBeenCalledTimes(1)
    // The cap timer was cleared; only the last close is pending.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS)
    expect(early.destroy).toHaveBeenCalledTimes(1)
    expect(during.destroy).toHaveBeenCalledTimes(1)
    expect(closeTransports).toHaveBeenCalledTimes(2)
    stop.finish()
  })

  it('treats a rejected precondition as settled', async () => {
    const server = fakeHttpServer({ connections: 0 })
    const precondition = deferred()
    const closeTransports = vi.fn(() => 0)
    const stop = createClientConnectionShutdown().begin({ httpServer: server, closeTransports, precondition: precondition.promise })
    expect(closeTransports).not.toHaveBeenCalled()
    precondition.reject(new Error('precondition failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(closeTransports).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    stop.finish()
  })

  it('closes the transports at T0 + 8 000 ms when the precondition never settles, and the last close at T0 + 9 000 ms', async () => {
    const server = fakeHttpServer({ connections: 1 })
    const instance = createClientConnectionShutdown()
    instance.arm(server)
    const tracked = new FakeSocket()
    server.upgrade(tracked)
    const closeTransports = vi.fn(() => 1)
    const stop = instance.begin({ httpServer: server, closeTransports, precondition: new Promise(() => undefined) })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_ABSOLUTE_MS - CLIENT_CLOSE_GRACE_MS - 1)
    expect(closeTransports).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(closeTransports).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS - 1)
    expect(tracked.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    // Exactly T0 + 9 000 ms: never later.
    expect(tracked.destroy).toHaveBeenCalledTimes(1)
    expect(closeTransports).toHaveBeenCalledTimes(2)
    stop.finish()
  })

  it('runs the last close G after the transports were closed when the precondition settles early (7 900 -> 8 900)', async () => {
    const server = fakeHttpServer({ connections: 1 })
    const precondition = deferred()
    const closeTransports = vi.fn(() => 1)
    const stop = createClientConnectionShutdown().begin({ httpServer: server, closeTransports, precondition: precondition.promise })
    await vi.advanceTimersByTimeAsync(7_900)
    precondition.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeTransports).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS - 1)
    expect(closeTransports).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(closeTransports).toHaveBeenCalledTimes(2)
    stop.finish()
  })

  it('destroys at once a connection taken over after the transports were closed', () => {
    const server = fakeHttpServer({ connections: 0 })
    const instance = createClientConnectionShutdown()
    instance.arm(server)
    const stop = instance.begin({ httpServer: server, closeTransports: () => 0 })
    const late = new FakeSocket()
    server.upgrade(late)
    expect(late.destroy).toHaveBeenCalledTimes(1)
    stop.finish()
  })

  it('tracks nothing when no realtime server took the upgrade (its start failed)', () => {
    const server = fakeHttpServer({ upgradeListeners: 0 })
    createClientConnectionShutdown().arm(server)
    expect(server.on).not.toHaveBeenCalled()
    const taken = fakeHttpServer({ upgradeListeners: 2 })
    createClientConnectionShutdown().arm(taken)
    expect(taken.on).toHaveBeenCalledTimes(1)
    expect(taken.on.mock.calls[0][0]).toBe('upgrade')
  })

  it('finish() clears every pending timer, and a connection count that answers after finish() arms nothing', async () => {
    const capped = createClientConnectionShutdown().begin({ httpServer: fakeHttpServer({ connections: 1 }), closeTransports: () => 0, precondition: new Promise(() => undefined) })
    expect(vi.getTimerCount()).toBe(1)
    capped.finish()
    expect(vi.getTimerCount()).toBe(0)
    const last = createClientConnectionShutdown().begin({ httpServer: fakeHttpServer({ connections: 1 }), closeTransports: () => 0 })
    expect(vi.getTimerCount()).toBe(1)
    last.finish()
    expect(vi.getTimerCount()).toBe(0)
    const late = createClientConnectionShutdown().begin({ httpServer: fakeHttpServer({ connections: 1, asyncCount: true }), closeTransports: () => 0 })
    late.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a closeTransports that throws does not fail the stop and the last close still runs', async () => {
    const server = fakeHttpServer({ connections: 1 })
    const closeTransports = vi.fn(() => { throw new Error('transport close failed') })
    const stop = createClientConnectionShutdown().begin({ httpServer: server, closeTransports })
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS)
    expect(closeTransports).toHaveBeenCalledTimes(2)
    stop.finish()
  })
})

describe('U7 finish() never throws', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('before begin, twice after begin, and after its timers fired: no throw, no timer left', async () => {
    const instance = createClientConnectionShutdown()
    expect(() => instance.finish()).not.toThrow()
    expect(instance.isStopping()).toBe(false)
    const stop = instance.begin({ httpServer: fakeHttpServer({ connections: 1 }), closeTransports: () => 0, precondition: new Promise(() => undefined) })
    expect(stop.finish).toBe(instance.finish)
    expect(() => instance.finish()).not.toThrow()
    expect(() => instance.finish()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    const fired = createClientConnectionShutdown()
    fired.begin({ httpServer: fakeHttpServer({ connections: 1 }), closeTransports: () => 0 })
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => fired.finish()).not.toThrow()
  })

  it('a begin that throws after it armed the cap (a precondition whose then throws): finish() still clears the cap', () => {
    const instance = createClientConnectionShutdown()
    const precondition = { then: () => { throw new Error('then sentinel') } } as unknown as Promise<unknown>
    expect(() => instance.begin({ httpServer: fakeHttpServer({ connections: 1 }), closeTransports: () => 0, precondition })).toThrow('then sentinel')
    expect(vi.getTimerCount()).toBe(1)
    expect(() => instance.finish()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('U1s both services close every transport with the standard close', () => {
  const fakeEngine = () => {
    const clients = { a: { close: vi.fn() }, b: { close: vi.fn() } }
    return { io: { engine: { clients } }, clients }
  }

  it('CollabService.closeTransportsForShutdown: close() without an argument on every client; 0 without a server', () => {
    const service = new CollabService(silentLogger, { subscribe: () => undefined } as never)
    expect(service.closeTransportsForShutdown()).toBe(0)
    const { io, clients } = fakeEngine()
    ;(service as unknown as { io: unknown }).io = io
    expect(service.closeTransportsForShutdown()).toBe(2)
    expect(clients.a.close).toHaveBeenCalledTimes(1)
    expect(clients.a.close).toHaveBeenCalledWith()
    expect(clients.b.close).toHaveBeenCalledTimes(1)
    expect(clients.b.close).toHaveBeenCalledWith()
  })

  const throwingEngine = () => {
    const clients = {
      a: { close: vi.fn(() => { throw new Error('disconnect listener sentinel') }) },
      b: { close: vi.fn() },
      c: { close: vi.fn() },
    }
    return { io: { engine: { clients } }, clients }
  }

  it('CollabService: one client whose close throws does not keep the others open; logged once, without values', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const service = new CollabService(logger, { subscribe: () => undefined } as never)
    const { io, clients } = throwingEngine()
    ;(service as unknown as { io: unknown }).io = io
    expect(service.closeTransportsForShutdown()).toBe(2)
    expect(clients.a.close).toHaveBeenCalledTimes(1)
    expect(clients.b.close).toHaveBeenCalledTimes(1)
    expect(clients.c.close).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('Transport close at shutdown failed for a client')
    // Nothing else is logged: no error object through any other method.
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('MetricsStreamService: one client whose close throws does not keep the others open; logged once, without values', () => {
    const service = new MetricsStreamService()
    const serviceLogger = (service as unknown as { logger: { warn(message: string): void; error(message: string): void; info(message: string): void; debug(message: string): void } }).logger
    const warn = vi.spyOn(serviceLogger, 'warn').mockImplementation(() => undefined)
    const others = (['error', 'info', 'debug'] as const).map((name) => vi.spyOn(serviceLogger, name).mockImplementation(() => undefined))
    const { io, clients } = throwingEngine()
    ;(service as unknown as { io: unknown }).io = io
    expect(service.closeTransportsForShutdown()).toBe(2)
    expect(clients.b.close).toHaveBeenCalledTimes(1)
    expect(clients.c.close).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Transport close at shutdown failed for a client')
    for (const other of others) expect(other).not.toHaveBeenCalled()
  })

  it('MetricsStreamService.closeTransportsForShutdown: close() without an argument on every client; 0 without a server', () => {
    const service = new MetricsStreamService()
    expect(service.closeTransportsForShutdown()).toBe(0)
    const { io, clients } = fakeEngine()
    ;(service as unknown as { io: unknown }).io = io
    expect(service.closeTransportsForShutdown()).toBe(2)
    expect(clients.a.close).toHaveBeenCalledWith()
    expect(clients.b.close).toHaveBeenCalledWith()
  })
})

/**
 * A double of the HTTP server of MetaSheetServer that holds connections: its close callback runs only
 * when every one of them has ended, and each can be ended only by an action of the module.
 */
class HoldingHttpServer {
  listening = true
  keepAliveTimeout = 5_000
  private readonly live = new Set<string>()
  private closeCallback: ((error?: Error) => void) | null = null
  private upgradeListener: ((request: unknown, socket: FakeSocket) => void) | null = null

  constructor(names: string[]) {
    for (const name of names) this.live.add(name)
  }

  close(callback: (error?: Error) => void): void {
    this.listening = false
    this.closeCallback = callback
    this.check()
  }

  end(name: string): void {
    this.live.delete(name)
    this.check()
  }

  has(name: string): boolean {
    return this.live.has(name)
  }

  getConnections(callback: (error: Error | null, count: number) => void): void {
    process.nextTick(callback, null, this.live.size)
  }

  listenerCount(eventName: string): number {
    return eventName === 'upgrade' ? 1 : 0
  }

  on(eventName: string, listener: (request: unknown, socket: FakeSocket) => void): void {
    if (eventName === 'upgrade') this.upgradeListener = listener
  }

  upgrade(socket: FakeSocket): void {
    this.upgradeListener?.({}, socket)
  }

  private check(): void {
    if (this.closeCallback && this.live.size === 0) {
      const callback = this.closeCallback
      this.closeCallback = null
      callback()
    }
  }
}

type ServerInternals = {
  httpServer: unknown
  injector: { get(token: unknown): unknown }
  clientConnectionShutdown: { arm(server: unknown): void }
  metricsStreamService?: unknown
  stopDingTalkTodoMirrorWorker?: () => Promise<void>
  stopForSignal(signal: 'SIGTERM' | 'SIGINT'): void
}

const internals = (server: MetaSheetServer) => server as unknown as ServerInternals

describe('MetaSheetServer with connections open at the stop', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('U2: stop() settles and the pool closes exactly once while a realtime connection, a taken-over socket and a keep-alive connection are open', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    // The clock is fake too: the last close is due G after the transports closed, by the clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const host = internals(server)
    const fake = new HoldingHttpServer(['websocket', 'upgraded', 'keep-alive'])
    host.httpServer = fake
    // The realtime connection ends only when its transport gets the standard close of the service.
    const collab = host.injector.get(ICollabService) as CollabService
    ;(collab as unknown as { io: unknown }).io = {
      engine: { clients: { one: { close: () => fake.end('websocket') } } },
    }
    // The taken-over socket ends only when the module destroys it.
    host.clientConnectionShutdown.arm(fake)
    const upgraded = new FakeSocket()
    upgraded.once('close', () => fake.end('upgraded'))
    fake.upgrade(upgraded)

    const stop = server.stop()
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
    stop.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
    // The keep-alive connection: its response finishes 4 500 ms after the start and Node closes it
    // keepAliveTimeout + 1 000 ms after that; 0 arms no idle close at all.
    setTimeout(() => {
      const idle = fake.keepAliveTimeout
      if (idle > 0) setTimeout(() => fake.end('keep-alive'), idle + 1_000)
    }, 4_500)

    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS)
    expect(fake.has('websocket')).toBe(false)
    expect(fake.has('upgraded')).toBe(false)
    // Bound: with the idle time lowered to 1 the keep-alive connection ends at 4 500 + 1 001 ms, so
    // the stop has settled by 6 000 ms. Left at 5 000 it would end at 10 500 ms, past the 10 s barrier.
    await vi.advanceTimersByTimeAsync(6_000 - CLIENT_CLOSE_GRACE_MS)
    expect(outcome).toBe('resolved')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(outcome).toBe('resolved')
    expect(fake.has('keep-alive')).toBe(false)
    expect(poolEnd).toHaveBeenCalledTimes(1)
  })

  it('U3: the signal handler exits 0 when the stop went through', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const stop = vi.spyOn(server, 'stop').mockResolvedValue(undefined)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)
    internals(server).stopForSignal('SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
    expect(exit).toHaveBeenCalledWith(0)
    expect(stop).toHaveBeenCalledWith('SIGTERM')
  })

  it('U4b: the stopping state belongs to one server: B answers normally after A stopped', async () => {
    expect(pgPool).not.toBeNull()
    vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const a = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const b = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await a.stop()
    const answerOf = async (server: MetaSheetServer) => {
      const app = (server as unknown as { app: http.RequestListener }).app
      const temporary = http.createServer(app)
      await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve))
      try {
        const { port } = temporary.address() as AddressInfo
        return await get(port, '/stop-barrier-probe')
      } finally {
        temporary.closeAllConnections()
        await new Promise<void>((resolve) => temporary.close(() => resolve()))
      }
    }
    const fromA = await answerOf(a)
    expect(fromA.status).toBe(503)
    expect(fromA.body).toContain('SERVER_STOPPING')
    const fromB = await answerOf(b)
    expect(fromB.status).not.toBe(503)
    expect(fromB.body).not.toContain('SERVER_STOPPING')
  })

  it('U5: the stop closes the transports of both services once; twice when the last close runs', async () => {
    expect(pgPool).not.toBeNull()
    vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const host = internals(server)
    const collab = host.injector.get(ICollabService) as CollabService
    const collabClose = vi.spyOn(collab, 'closeTransportsForShutdown')
    const metricsClose = vi.fn(() => 0)
    host.metricsStreamService = { closeTransportsForShutdown: metricsClose, shutdown: vi.fn(async () => undefined) }
    await server.stop()
    expect(collabClose).toHaveBeenCalledTimes(1)
    expect(metricsClose).toHaveBeenCalledTimes(1)
  })

  it('U5: with a connection left, the last close calls both services a second time', async () => {
    expect(pgPool).not.toBeNull()
    vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    // The clock is fake too: the last close is due G after the transports closed, by the clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const host = internals(server)
    const fake = new HoldingHttpServer(['held'])
    host.httpServer = fake
    const collab = host.injector.get(ICollabService) as CollabService
    const collabClose = vi.spyOn(collab, 'closeTransportsForShutdown')
    const metricsClose = vi.fn(() => {
      if (metricsClose.mock.calls.length === 2) fake.end('held')
      return 0
    })
    host.metricsStreamService = { closeTransportsForShutdown: metricsClose, shutdown: vi.fn(async () => undefined) }
    const stop = server.stop()
    await vi.advanceTimersByTimeAsync(CLIENT_CLOSE_GRACE_MS - 1)
    expect(collabClose).toHaveBeenCalledTimes(1)
    expect(metricsClose).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(collabClose).toHaveBeenCalledTimes(2)
    expect(metricsClose).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    await stop
  })

  it('U5: without a metrics stream service the stop does not throw', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const host = internals(server)
    host.metricsStreamService = undefined
    const collabClose = vi.spyOn(host.injector.get(ICollabService) as CollabService, 'closeTransportsForShutdown')
    await server.stop()
    expect(collabClose).toHaveBeenCalledTimes(1)
    expect(poolEnd).toHaveBeenCalledTimes(1)
  })

  it('U6: a stop that fails before the last close leaves no timer of the module behind', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const host = internals(server)
    // The connection count says one is left, so the last close is armed at once.
    host.httpServer = {
      listening: false,
      keepAliveTimeout: 5_000,
      getConnections: (callback: (error: Error | null, count: number) => void) => callback(null, 1),
    }
    host.stopDingTalkTodoMirrorWorker = vi.fn().mockRejectedValue(new Error('worker drain sentinel'))
    const baseline = vi.getTimerCount()
    await expect(server.stop()).rejects.toThrow('APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED')
    expect(vi.getTimerCount()).toBe(baseline)
    expect(poolEnd).not.toHaveBeenCalled()
  })
})

describe('MetaSheetServer: synchronous throws around the start of the stop', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('U6b: a synchronous throw after the module began rejects with the same error and leaves no timer of the module', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const host = server as unknown as {
      httpServer: unknown
      automationService: { stopProducerAdmissions(): Promise<void> }
      clientConnectionShutdown: { isStopping(): boolean }
    }
    // The connection count says one is left, so the last close is armed at once by begin().
    host.httpServer = {
      listening: false,
      keepAliveTimeout: 5_000,
      getConnections: (callback: (error: Error | null, count: number) => void) => callback(null, 1),
    }
    const thrown = new Error('producer admission sentinel')
    host.automationService = { stopProducerAdmissions: () => { throw thrown } }
    const baseline = vi.getTimerCount()
    const stop = server.stop()
    let reason: unknown = null
    await stop.catch((error: unknown) => { reason = error })
    expect(reason).toBe(thrown)
    expect(host.clientConnectionShutdown.isStopping()).toBe(true)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(poolEnd).not.toHaveBeenCalled()
  })

  it('U6c: a synchronous throw before the module began rejects with the same error, opens nothing, and stop() stays latched', async () => {
    expect(pgPool).not.toBeNull()
    vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const host = server as unknown as {
      app: http.RequestListener
      yidaOwnerRuntime: { stop(): Promise<void> }
      clientConnectionShutdown: { isStopping(): boolean }
    }
    const thrown = new Error('owner runtime sentinel')
    host.yidaOwnerRuntime = { stop: () => { throw thrown } }
    const baseline = vi.getTimerCount()
    const stop = server.stop()
    let reason: unknown = null
    await stop.catch((error: unknown) => { reason = error })
    expect(reason).toBe(thrown)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(host.clientConnectionShutdown.isStopping()).toBe(false)
    expect(server.stop()).toBe(stop)
    vi.useRealTimers()
    const temporary = http.createServer(host.app)
    await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = temporary.address() as AddressInfo
      const answer = await get(port, '/stop-barrier-probe')
      expect(answer.status).not.toBe(503)
      expect(answer.body).not.toContain('SERVER_STOPPING')
    } finally {
      temporary.closeAllConnections()
      await new Promise<void>((resolve) => temporary.close(() => resolve()))
    }
  })
})

describe('U4 the fence on the real app, after the stop began, on every kind of path', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** One request on a connection of its own, any method and headers. */
  function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body = '') {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }))
      })
      request.on('error', reject)
      request.end(body)
    })
  }

  it('GET /health, GET /api/health, GET /api/admin/users without credentials, POST /api/attendance/import and an unknown path with headers: each 503 SERVER_STOPPING with only the fixed headers, and nothing downstream, also 250 ms later', async () => {
    expect(pgPool).not.toBeNull()
    vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const app = (server as unknown as { app: { use(handler: unknown): void; _router: { stack: Array<{ handle: unknown }> } } }).app
    // A counter placed right behind the fence: everything the fence lets through passes it first.
    let downstream = 0
    app.use((_request: unknown, _response: unknown, next: () => void) => {
      downstream += 1
      next()
    })
    const stack = app._router.stack
    const counter = stack.pop()!
    const fenceAt = stack.findIndex((layer) => String(layer.handle).includes('clientConnectionShutdown.fence'))
    expect(fenceAt).toBeGreaterThan(0)
    stack.splice(fenceAt + 1, 0, counter)

    await server.stop()
    const temporary = http.createServer(app as unknown as http.RequestListener)
    await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = temporary.address() as AddressInfo
      const origin = { Origin: 'http://cross-origin.example' }
      const answers = [
        await send(port, 'GET', '/health', origin),
        await send(port, 'GET', '/api/health', origin),
        await send(port, 'GET', '/api/admin/users', origin),
        await send(port, 'POST', '/api/attendance/import', { ...origin, 'Content-Type': 'application/json' }, '{"rows":[]}'),
        await send(port, 'GET', '/stop-barrier/unknown', { ...origin, 'x-internal': '1', Authorization: 'Bearer x' }),
      ]
      // Set by the fence, by CORS, and before the fence by Node, Express and the correlation-id middleware.
      const allowed = new Set([
        'connection', 'x-content-type-options', 'content-type', 'content-length',
        'access-control-allow-origin', 'access-control-expose-headers', 'vary',
        'date', 'x-powered-by', 'x-correlation-id',
      ])
      for (const answer of answers) {
        expect(answer.status).toBe(503)
        expect(JSON.parse(answer.body)).toEqual({ ok: false, error: { code: 'SERVER_STOPPING', message: 'Server is stopping' } })
        expect(answer.headers.connection).toBe('close')
        expect(answer.headers['x-content-type-options']).toBe('nosniff')
        expect(answer.headers['access-control-allow-origin']).toBeTruthy()
        expect(Object.keys(answer.headers).filter((name) => !allowed.has(name))).toEqual([])
        // Values too, not only names: nothing of the request may be echoed into an allowed header.
        expect(answer.headers['content-type']).toBe('application/json; charset=utf-8')
        expect(answer.headers['x-powered-by']).toBe('Express')
        expect(answer.headers['x-correlation-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      }
      expect(downstream).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(downstream).toBe(0)
    } finally {
      temporary.closeAllConnections()
      await new Promise<void>((resolve) => temporary.close(() => resolve()))
    }
  })
})

/** The syntax tree of a source file of the backend. */
function sourceOf(relative: string): ts.SourceFile {
  const path = join(__dirname, '..', '..', relative)
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

const printer = ts.createPrinter({ removeComments: true })
const printed = (node: ts.Node, source: ts.SourceFile): string => printer.printNode(ts.EmitHint.Unspecified, node, source)

const FENCE_SNAPSHOT = "(_request: IncomingMessage, response: ServerResponse, next: () => void): void => {\n    if (!stopping) {\n        next();\n        return;\n    }\n    response.statusCode = 503;\n    response.setHeader('Connection', 'close');\n    response.setHeader('X-Content-Type-Options', 'nosniff');\n    response.setHeader('Content-Type', 'application/json; charset=utf-8');\n    response.setHeader('Content-Length', Buffer.byteLength(STOPPING_BODY));\n    response.end(STOPPING_BODY);\n}"
const DELEGATE = 'this.app.use((request, response, next) => this.clientConnectionShutdown.fence(request, response, next))'

describe('U4c the fence and its mount, read from the syntax tree', () => {
  const module = sourceOf('src/lifecycle/client-connection-shutdown.ts')
  let fence: ts.ArrowFunction | undefined
  let begin: ts.Node | undefined
  walk(module, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'fence' && ts.isArrowFunction(node.initializer)) fence = node.initializer
      if (node.name.text === 'begin') begin = node.initializer
    }
  })
  const fenceNodes: ts.Node[] = []
  if (fence) walk(fence.body, (node) => fenceNodes.push(node))
  const identifiers = (name: string) => fenceNodes.filter((node): node is ts.Identifier => ts.isIdentifier(node) && node.text === name)
  const calls = (method: string) => fenceNodes.filter((node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method)

  it('layer 1: the whole fence equals its snapshot (comments and spacing aside)', () => {
    expect(fence).toBeDefined()
    expect(printer.printNode(ts.EmitHint.Expression, fence!, module)).toBe(FENCE_SNAPSHOT)
  })

  it('the request parameter is never used in the body of the fence', () => {
    const requestName = (fence!.parameters[0].name as ts.Identifier).text
    expect(identifiers(requestName)).toHaveLength(0)
  })

  it('check 1: no `arguments` in the fence', () => {
    expect(identifiers('arguments')).toHaveLength(0)
  })

  it('check 2: no member access .req, .socket or .connection in the fence', () => {
    const reached = fenceNodes.filter((node) => ts.isPropertyAccessExpression(node) && ['req', 'socket', 'connection'].includes(node.name.text))
    expect(reached).toHaveLength(0)
  })

  it('check 3: the response is used only through statusCode, setHeader and end', () => {
    const responseName = (fence!.parameters[1].name as ts.Identifier).text
    const uses = identifiers(responseName)
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) {
      expect(ts.isPropertyAccessExpression(use.parent) && use.parent.expression === use).toBe(true)
      expect(['statusCode', 'setHeader', 'end']).toContain((use.parent as ts.PropertyAccessExpression).name.text)
    }
  })

  it('check 4: setHeader names come from a fixed set of literals; values are literals or the length of the fixed body', () => {
    const names = new Set(['Connection', 'X-Content-Type-Options', 'Content-Type', 'Content-Length'])
    const headers = calls('setHeader')
    expect(headers.length).toBe(4)
    for (const call of headers) {
      expect(call.arguments).toHaveLength(2)
      const [name, value] = call.arguments
      expect(ts.isStringLiteral(name) && names.has(name.text)).toBe(true)
      const literal = ts.isStringLiteral(value) || ts.isNumericLiteral(value)
      expect(literal || value.getText(module) === 'Buffer.byteLength(STOPPING_BODY)').toBe(true)
    }
  })

  it('check 5: end is called only with STOPPING_BODY as its only argument', () => {
    const ends = calls('end')
    expect(ends).toHaveLength(1)
    expect(ends[0].arguments.map((argument) => argument.getText(module))).toEqual(['STOPPING_BODY'])
  })

  it('check 6: next appears exactly once, as the call in `if (!stopping) { next(); return }`', () => {
    const nextName = (fence!.parameters[2].name as ts.Identifier).text
    const uses = identifiers(nextName)
    expect(uses).toHaveLength(1)
    const call = uses[0].parent
    expect(ts.isCallExpression(call) && call.expression === uses[0] && call.arguments.length === 0).toBe(true)
    const block = call.parent.parent
    expect(ts.isBlock(block) && block.statements.length === 2 && ts.isReturnStatement(block.statements[1])).toBe(true)
    const branch = block.parent
    expect(ts.isIfStatement(branch) && branch.expression.getText(module) === '!stopping').toBe(true)
  })

  it('check 7: nothing deferred in the fence (no timers, microtasks, promises, await or then)', () => {
    for (const name of ['setTimeout', 'setImmediate', 'queueMicrotask', 'Promise']) expect(identifiers(name)).toHaveLength(0)
    expect(fenceNodes.filter((node) => ts.isAwaitExpression(node))).toHaveLength(0)
    expect(fenceNodes.filter((node) => ts.isPropertyAccessExpression(node) && ['then', 'nextTick'].includes(node.name.text))).toHaveLength(0)
  })

  it('check 8: in the whole module `stopping` is written twice only: its initial false, and `stopping = true` inside begin', () => {
    const writes: Array<{ text: string; inBegin: boolean }> = []
    const inBegin = (node: ts.Node): boolean => {
      for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === begin) return true
      return false
    }
    const isStopping = (node: ts.Node) => ts.isIdentifier(node) && node.text === 'stopping'
    walk(module, (node) => {
      if (ts.isVariableDeclaration(node) && isStopping(node.name)) writes.push({ text: printed(node, module), inBegin: inBegin(node) })
      if (ts.isBinaryExpression(node) && isStopping(node.left)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        writes.push({ text: printed(node, module), inBegin: inBegin(node) })
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && isStopping(node.operand)
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        writes.push({ text: printed(node, module), inBegin: inBegin(node) })
      }
    })
    expect(begin).toBeDefined()
    expect(writes).toEqual([
      { text: 'stopping = false', inBegin: false },
      { text: 'stopping = true', inBegin: true },
    ])
  })

  it('check 9: the instance has exactly the keys fence, arm, begin, finish and isStopping', () => {
    let returned: ts.ObjectLiteralExpression | undefined
    walk(module, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'createClientConnectionShutdown' && node.body) {
        const last = node.body.statements[node.body.statements.length - 1]
        if (ts.isReturnStatement(last) && last.expression && ts.isObjectLiteralExpression(last.expression)) returned = last.expression
      }
    })
    expect(returned).toBeDefined()
    expect(returned!.properties.map((property) => property.name?.getText(module))).toEqual(['fence', 'arm', 'begin', 'finish', 'isStopping'])
    // The instance hands out the very functions declared under these names (shorthand), so the
    // fence pinned above is the fence that is served.
    const [fenceProperty, armProperty, beginProperty, finishProperty, stoppingProperty] = returned!.properties
    for (const property of [fenceProperty, armProperty, beginProperty, finishProperty]) {
      expect(ts.isShorthandPropertyAssignment(property)).toBe(true)
    }
    expect(ts.isPropertyAssignment(stoppingProperty) && printed(stoppingProperty.initializer, module)).toBe('() => stopping')
    expect(Object.keys(createClientConnectionShutdown()).sort()).toEqual(['arm', 'begin', 'fence', 'finish', 'isStopping'])
  })

  it('check 9c: fence is declared const and never assigned anywhere in the module', () => {
    const declarations: ts.VariableDeclaration[] = []
    const assignments: string[] = []
    walk(module, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'fence') declarations.push(node)
      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === 'fence'
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        assignments.push(printed(node, module))
      }
    })
    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      expect(ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0).toBe(true)
    }
    expect(assignments).toEqual([])
  })

  it('check 9b: exactly one declaration in the module is named fence (a second one could carry the snapshot while another is served)', () => {
    const declarations: ts.Node[] = []
    walk(module, (node) => {
      const named = (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
        && node.name && ts.isIdentifier(node.name) && node.name.text === 'fence'
      if (named) declarations.push(node)
    })
    expect(declarations).toHaveLength(1)
  })

  it('the mount: the statement right after `this.app.use(cors(...))` in setupMiddleware is the delegating mount, and only forwards', () => {
    const index = sourceOf('src/index.ts')
    let statements: readonly ts.Statement[] = []
    walk(index, (node) => {
      if (ts.isMethodDeclaration(node) && node.name.getText(index) === 'setupMiddleware' && node.body) statements = node.body.statements
    })
    const corsAt = statements.findIndex((statement) => /^this\.app\.use\(cors\(/.test(statement.getText(index)))
    expect(corsAt).toBeGreaterThanOrEqual(0)
    const expected = ts.createSourceFile('expected.ts', DELEGATE, ts.ScriptTarget.ES2022, true)
    expect(printed(statements[corsAt + 1], index)).toBe(printed(expected.statements[0], expected))
  })
})

/**
 * Closed world of the instance: every statement in the deployable backend sources (src, core, types,
 * scripts) that mentions `clientConnectionShutdown` — as a name or inside a text — is one of these six,
 * compared whole and through the syntax tree. The printer drops comments, spacing, semicolons and line
 * breaks inside argument lists, but it keeps a line break before `.`, so reformatting a statement that
 * way also fails here (on the strict side: the list is then updated on purpose).
 *
 * Together with the two checks on the factory name below, this catches a wrapper, a swap or an alias of
 * the instance installed by mistake, at construction, at start or at the stop. It is not a proof against
 * deliberate disguise; that is left to review.
 */
const INSTANCE_STATEMENTS = [
  { file: 'src/index.ts', text: 'private readonly clientConnectionShutdown: ClientConnectionShutdown;' },
  { file: 'src/index.ts', text: 'this.clientConnectionShutdown = createClientConnectionShutdown();' },
  { file: 'src/index.ts', text: 'this.app.use((request, response, next) => this.clientConnectionShutdown.fence(request, response, next));' },
  { file: 'src/index.ts', text: 'this.stopPromise ??= this.stopOnce(signal).finally(() => this.clientConnectionShutdown.finish());' },
  { file: 'src/index.ts', text: 'return this.clientConnectionShutdown.begin({\n    httpServer: this.httpServer,\n    closeTransports: () => this.closeRealtimeTransportsForShutdown(),\n});' },
  { file: 'src/index.ts', text: 'this.clientConnectionShutdown.arm(this.httpServer);' },
]

describe('closed world: every statement that mentions the instance', () => {
  it('is exactly one of the six pinned statements, whole, in src/index.ts', () => {
    const root = join(__dirname, '..', '..')
    const name = 'clientConnectionShutdown'
    const found: Array<{ file: string; text: string }> = []
    const scanFile = (full: string): void => {
      const text = readFileSync(full, 'utf8')
      if (!text.includes(name)) return
      const source = ts.createSourceFile(full, text, ts.ScriptTarget.ES2022, true)
      const seen = new Set<number>()
      walk(source, (node) => {
        const hit = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text === name
          : ts.isStringLiteralLike(node) && node.text.includes(name)
        if (!hit) return
        let statement: ts.Node = node
        while (statement.parent && !(ts.isStatement(statement) || ts.isClassElement(statement))) statement = statement.parent
        if (seen.has(statement.pos)) return
        seen.add(statement.pos)
        found.push({ file: relative(root, full).split(sep).join('/'), text: printed(statement, source) })
      })
    }
    const scanDir = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) scanDir(full)
        else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry)) scanFile(full)
      }
    }
    for (const top of ['src', 'core', 'types', 'scripts']) if (existsSync(join(root, top))) scanDir(join(root, top))
    // Control: the scan sees the real declaration.
    expect(found.length).toBeGreaterThan(0)
    expect(found).toEqual(INSTANCE_STATEMENTS)
  })
})

/** Every statement outside the module that names the factory: the import and the constructor assignment. */
const FACTORY_STATEMENTS = [
  { file: 'src/index.ts', text: "import { createClientConnectionShutdown, type ClientConnectionShutdown, type ClientConnectionStop } from './lifecycle/client-connection-shutdown';" },
  { file: 'src/index.ts', text: 'this.clientConnectionShutdown = createClientConnectionShutdown();' },
]

describe('closed world: the name of the factory, on both sides of the module boundary', () => {
  const root = join(__dirname, '..', '..')
  const factory = 'createClientConnectionShutdown'
  const modulePath = 'src/lifecycle/client-connection-shutdown.ts'
  const mentions = (node: ts.Node): boolean => (ts.isIdentifier(node) && node.text === factory)
    || (ts.isStringLiteralLike(node) && node.text.includes(factory))

  it('outside the module only the import and the constructor assignment name it (the name cannot be redirected locally)', () => {
    const found: Array<{ file: string; text: string }> = []
    const scanDir = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) { scanDir(full); continue }
        if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry)) continue
        const file = relative(root, full).split(sep).join('/')
        if (file === modulePath) continue
        const text = readFileSync(full, 'utf8')
        if (!text.includes(factory)) continue
        const source = ts.createSourceFile(full, text, ts.ScriptTarget.ES2022, true)
        const seen = new Set<number>()
        walk(source, (node) => {
          if (!mentions(node)) return
          let statement: ts.Node = node
          while (statement.parent && !(ts.isStatement(statement) || ts.isClassElement(statement))) statement = statement.parent
          if (seen.has(statement.pos)) return
          seen.add(statement.pos)
          found.push({ file, text: printed(statement, source) })
        })
      }
    }
    for (const top of ['src', 'core', 'types', 'scripts']) if (existsSync(join(root, top))) scanDir(join(root, top))
    expect(found).toEqual(FACTORY_STATEMENTS)
  })

  it('inside the module the name appears exactly once, as the exported function declaration that U4c checks', () => {
    const source = sourceOf(modulePath)
    const uses: ts.Node[] = []
    walk(source, (node) => { if (mentions(node)) uses.push(node) })
    expect(uses).toHaveLength(1)
    const declaration = uses[0].parent
    expect(ts.isFunctionDeclaration(declaration) && declaration.name === uses[0]).toBe(true)
    const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) ?? [] : []
    expect(modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBe(true)
    expect(declaration.parent).toBe(source)
  })
})

describe('U4 the fence', () => {
  const servers: http.Server[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  async function serve(fence: (request: http.IncomingMessage, response: http.ServerResponse, next: () => void) => void) {
    const downstream = vi.fn((_request: http.IncomingMessage, response: http.ServerResponse) => {
      response.end('downstream')
    })
    const server = http.createServer((request, response) => fence(request, response, () => downstream(request, response)))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { port, downstream }
  }

  it('lets every request through before the stop and answers 503 SERVER_STOPPING after it, without the downstream handler', async () => {
    const instance = createClientConnectionShutdown()
    const { port, downstream } = await serve(instance.fence)
    const before = await get(port)
    expect(before.status).toBe(200)
    expect(before.body).toBe('downstream')
    expect(downstream).toHaveBeenCalledTimes(1)
    expect(instance.isStopping()).toBe(false)

    instance.begin({ httpServer: {}, closeTransports: () => 0 }).finish()
    expect(instance.isStopping()).toBe(true)
    const after = await get(port)
    expect(after.status).toBe(503)
    expect(after.headers.connection).toBe('close')
    expect(after.headers['x-content-type-options']).toBe('nosniff')
    expect(after.headers['content-type']).toMatch(/^application\/json/)
    expect(JSON.parse(after.body)).toEqual({ ok: false, error: { code: 'SERVER_STOPPING', message: 'Server is stopping' } })
    expect(downstream).toHaveBeenCalledTimes(1)
  })

  it('U4b: the stopping state of one instance does not reach another instance', async () => {
    const stopped = createClientConnectionShutdown()
    const other = createClientConnectionShutdown()
    stopped.begin({ httpServer: {}, closeTransports: () => 0 }).finish()
    const { port, downstream } = await serve(other.fence)
    const answer = await get(port)
    expect(answer.status).toBe(200)
    expect(downstream).toHaveBeenCalledTimes(1)
    expect(other.isStopping()).toBe(false)
  })
})
