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
 *   U6   a stop that fails clears the timers of the module.
 */
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
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
    await vi.advanceTimersByTimeAsync(12_000)
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
