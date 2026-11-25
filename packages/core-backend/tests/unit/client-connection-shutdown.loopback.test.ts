/**
 * Loopback cases of the stop of client connections (design lock STOP-BARRIER-OPEN-CONNECTIONS v2 §5.2
 * with the v2.1 changes): a real HTTP server, the real realtime server of the collaboration service
 * and the real module, on the loopback interface, no database. Every case starts its own server and
 * stops it the way the product does: `close()` first, then `begin()`. Judged on Node 20.x.
 */
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'

import { CLIENT_CLOSE_ABSOLUTE_MS, CLIENT_CLOSE_GRACE_MS } from '../../src/lifecycle/client-connection-shutdown'
import {
  RawConnection,
  openSilentWebSocket,
  rawRequest,
  rawWebSocketUpgrade,
  sleep,
  startStack,
  type Stack,
} from '../helpers/client-connection-stack'

const stacks: Stack[] = []
const clients: ClientSocket[] = []
const raws: RawConnection[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const raw of raws.splice(0)) raw.destroy()
  for (const stack of stacks.splice(0)) await stack.dispose()
})

async function stack(port?: number): Promise<Stack> {
  const started = await startStack({ port })
  stacks.push(started)
  return started
}

function client(url: string, options: Parameters<typeof connectClient>[1]): ClientSocket {
  const socket = connectClient(url, { forceNew: true, ...options })
  clients.push(socket)
  return socket
}

function raw(port: number): RawConnection {
  const connection = new RawConnection(port)
  raws.push(connection)
  return connection
}

function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve()
      return
    }
    socket.once('connect', () => resolve())
    socket.once('connect_error', reject)
  })
}

function disconnected(socket: ClientSocket): Promise<{ reason: string; at: number }> {
  return new Promise((resolve) => {
    socket.once('disconnect', (reason) => resolve({ reason, at: Date.now() }))
  })
}

/** Resolves with null when the promise has not settled within ms. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, sleep(ms).then(() => null)])
}

describe('loopback: realtime connections', () => {
  it('(a) websocket: 200 messages queued before the stop all arrive, then a transport close within 500 ms, then a reconnect on the same port', async () => {
    const first = await stack()
    const socket = client(first.url, { transports: ['websocket'], reconnectionDelay: 200, reconnectionDelayMax: 400 })
    await connected(socket)
    let received = 0
    socket.on('m', () => { received += 1 })
    const disconnect = disconnected(socket)
    const payload = 'x'.repeat(64 * 1024)
    for (let index = 0; index < 200; index += 1) first.broadcast('m', payload)
    const stop = first.stop()
    const { reason, at } = await disconnect
    expect(received).toBe(200)
    expect(reason).toBe('transport close')
    expect(at - stop.t0).toBeLessThan(500)
    await stop.closed
    stop.finish()
    const second = await stack(first.port)
    await within(connected(socket), 6_000)
    expect(socket.connected).toBe(true)
    expect(second.port).toBe(first.port)
  }, 15_000)

  it('(b) long poll with nothing sent before the stop: a transport close', async () => {
    const started = await stack()
    const socket = client(started.url, { transports: ['polling'], reconnection: false })
    await connected(socket)
    // Let the next long poll be outstanding before the stop.
    await sleep(200)
    const disconnect = disconnected(socket)
    const stop = started.stop()
    const result = await within(disconnect, 3_000)
    expect(result?.reason).toBe('transport close')
    expect(await within(stop.closed, 3_000)).not.toBeNull()
    stop.finish()
  }, 10_000)

  it("(b') long poll with messages after the stop: it reconnects to a server on the same port (delivery is not asserted, L-2)", async () => {
    const first = await stack()
    const socket = client(first.url, { transports: ['polling'], reconnectionDelay: 200, reconnectionDelayMax: 400 })
    await connected(socket)
    const disconnect = disconnected(socket)
    const stop = first.stop()
    for (let index = 0; index < 5; index += 1) first.broadcast('m', index)
    const ended = await within(disconnect, 3_000)
    expect(ended).not.toBeNull()
    // Which of the two depends on whether the next poll was already outstanding (L-2).
    expect(['transport close', 'transport error']).toContain(ended!.reason)
    expect(await within(stop.closed, 3_000)).not.toBeNull()
    stop.finish()
    await stack(first.port)
    await within(connected(socket), 6_000)
    expect(socket.connected).toBe(true)
  }, 15_000)

  it('(c) a real engine.io websocket session that never answers a close frame is ended at G <= t < G + 500', async () => {
    const started = await stack()
    const { connection, status, openPacket } = await openSilentWebSocket(started.port)
    raws.push(connection)
    expect(status).toBe(101)
    expect(openPacket.startsWith('0{')).toBe(true)
    expect(openPacket).toContain('"sid"')
    const stop = started.stop()
    const closedAt = await within(connection.closed, 3_000)
    expect(closedAt).not.toBeNull()
    expect(closedAt! - stop.t0).toBeGreaterThanOrEqual(CLIENT_CLOSE_GRACE_MS)
    expect(closedAt! - stop.t0).toBeLessThan(CLIENT_CLOSE_GRACE_MS + 500)
    expect(await within(stop.closed, 1_000)).not.toBeNull()
    stop.finish()
  }, 10_000)
})

describe('loopback: HTTP connections', () => {
  it('(d1) a request crossing the start, idle afterwards and sending nothing more: closed within finish + 1 500 ms; close callback < 2 100 ms', async () => {
    const started = await stack()
    const connection = raw(started.port)
    await connection.connected()
    connection.write(rawRequest('/slow?ms=600'))
    const response = connection.next()
    await sleep(300)
    const stop = started.stop()
    const answered = await response
    expect(answered.status).toBe(200)
    expect(answered.body.toString()).toBe('slow:600')
    const closedAt = await within(connection.closed, 4_000)
    expect(closedAt).not.toBeNull()
    expect(closedAt! - answered.at).toBeLessThan(1_500)
    const callbackAt = await within(stop.closed, 4_000)
    expect(callbackAt).not.toBeNull()
    expect(callbackAt! - stop.t0).toBeLessThan(2_100)
    stop.finish()
  }, 10_000)

  it('(d2) a second request pipelined after the start while the first is in flight: 200 in full, then 503 SERVER_STOPPING with Connection: close, then the connection closes', async () => {
    const started = await stack()
    const connection = raw(started.port)
    await connection.connected()
    connection.write(rawRequest('/slow?ms=600'))
    const first = connection.next()
    await sleep(300)
    const stop = started.stop()
    await sleep(50)
    connection.write(rawRequest('/after'))
    const second = connection.next()
    const one = await first
    expect(one.status).toBe(200)
    expect(one.body.toString()).toBe('slow:600')
    const two = await second
    expect(two.status).toBe(503)
    expect(two.headers.connection).toBe('close')
    expect(JSON.parse(two.body.toString())).toEqual({ ok: false, error: { code: 'SERVER_STOPPING', message: 'Server is stopping' } })
    expect(await within(connection.closed, 2_000)).not.toBeNull()
    expect(await within(stop.closed, 3_000)).not.toBeNull()
    stop.finish()
  }, 10_000)

  it('(e) a 3 s request in flight: answered in full, and the close callback runs after it', async () => {
    const started = await stack()
    const connection = raw(started.port)
    await connection.connected()
    connection.write(rawRequest('/slow?ms=3000'))
    const response = connection.next()
    await sleep(100)
    const stop = started.stop()
    const answered = await response
    expect(answered.status).toBe(200)
    expect(answered.body.toString()).toBe('slow:3000')
    const callbackAt = await within(stop.closed, 6_000)
    expect(callbackAt).not.toBeNull()
    expect(callbackAt!).toBeGreaterThanOrEqual(answered.at)
    stop.finish()
  }, 12_000)

  it('(f) a precondition that never settles: transports closed at about 8 000 ms, the last close at about 9 000 ms, a 9.5 s request answered in full, close callback after it', async () => {
    const started = await stack()
    const cooperative = client(started.url, { transports: ['websocket'], reconnection: false })
    await connected(cooperative)
    const { connection: silent } = await openSilentWebSocket(started.port)
    raws.push(silent)
    const connection = raw(started.port)
    await connection.connected()
    connection.write(rawRequest('/slow?ms=9600'))
    const response = connection.next()
    await sleep(100)
    const disconnect = disconnected(cooperative)
    const stop = started.stop(new Promise(() => undefined))
    const transportClose = await disconnect
    expect(transportClose.reason).toBe('transport close')
    expect(transportClose.at - stop.t0).toBeGreaterThanOrEqual(CLIENT_CLOSE_ABSOLUTE_MS - CLIENT_CLOSE_GRACE_MS - 50)
    expect(transportClose.at - stop.t0).toBeLessThan(CLIENT_CLOSE_ABSOLUTE_MS - CLIENT_CLOSE_GRACE_MS + 600)
    const silentClosedAt = await silent.closed
    expect(silentClosedAt - stop.t0).toBeGreaterThanOrEqual(CLIENT_CLOSE_ABSOLUTE_MS - 50)
    expect(silentClosedAt - stop.t0).toBeLessThan(CLIENT_CLOSE_ABSOLUTE_MS + 600)
    const answered = await response
    expect(answered.status).toBe(200)
    expect(answered.body.toString()).toBe('slow:9600')
    const callbackAt = await within(stop.closed, 4_000)
    expect(callbackAt).not.toBeNull()
    expect(callbackAt!).toBeGreaterThanOrEqual(answered.at)
    stop.finish()
  }, 20_000)

  /** A response of `mb` MiB written 50 ms after the start, read by a client that first stops reading. */
  async function bigResponse(port: number, options: { mb: number; pauseMs: number; connectionClose: boolean; resumeWhen?: () => Promise<void> }) {
    const agent = options.connectionClose ? false : new http.Agent({ keepAlive: true })
    return new Promise<{ expected: number; received: number }>((resolve, reject) => {
      const request = http.get({
        host: '127.0.0.1',
        port,
        path: `/big?mb=${options.mb}`,
        agent,
        headers: options.connectionClose ? { Connection: 'close' } : {},
      }, (response) => {
        const expected = Number(response.headers['content-length'])
        let received = 0
        response.on('data', (chunk: Buffer) => { received += chunk.length })
        response.on('end', () => resolve({ expected, received }))
        response.on('error', () => resolve({ expected, received }))
        response.on('aborted', () => resolve({ expected, received }))
        response.pause()
        if (options.resumeWhen) void options.resumeWhen().then(() => response.resume())
        else setTimeout(() => response.resume(), options.pauseMs)
      })
      request.on('error', reject)
    }).finally(() => { if (agent) agent.destroy() })
  }

  it.each([
    ['keep-alive', false],
    ['Connection: close', true],
  ])('(g) a 20 MiB response written after the start to a reader that pauses 300 ms arrives in full (%s)', async (_label, connectionClose) => {
    const started = await stack()
    const result = bigResponse(started.port, { mb: 20, pauseMs: 300, connectionClose })
    await sleep(100)
    const stop = started.stop()
    const { expected, received } = await result
    expect(expected).toBe(20 * 1024 * 1024)
    expect(received).toBe(expected)
    expect(await within(stop.closed, 5_000)).not.toBeNull()
    stop.finish()
  }, 15_000)

  it('(g) kernel tail: the server finished writing while the reader had read nothing; the reader waits 2.5 s more and still receives every byte', async () => {
    const started = await stack()
    let finishedAt: number | null = null
    started.server.on('request', (_request, response: http.ServerResponse) => {
      response.once('finish', () => { finishedAt = Date.now() })
    })
    const resumeWhen = async (): Promise<void> => {
      const deadline = Date.now() + 5_000
      while (finishedAt === null && Date.now() < deadline) await sleep(10)
      await sleep(2_500)
    }
    const result = bigResponse(started.port, { mb: 1, pauseMs: 0, connectionClose: false, resumeWhen })
    await sleep(100)
    const stop = started.stop()
    const { expected, received } = await result
    expect(finishedAt).not.toBeNull()
    expect(expected).toBe(1024 * 1024)
    expect(received).toBe(expected)
    stop.finish()
  }, 15_000)

  it('(h) B1: headers half sent before the start and completed 300 ms after it: not cut, answered 503', async () => {
    const started = await stack()
    const connection = raw(started.port)
    await connection.connected()
    connection.write('GET /half HTTP/1.1\r\nHost: 127.0.0.1\r\n')
    await sleep(100)
    const stop = started.stop()
    await sleep(300)
    expect(connection.isClosed()).toBe(false)
    connection.write('\r\n')
    const answered = await connection.next()
    expect(answered.status).toBe(503)
    expect(JSON.parse(answered.body.toString()).error.code).toBe('SERVER_STOPPING')
    expect(await within(connection.closed, 2_000)).not.toBeNull()
    stop.finish()
  }, 10_000)

  it('(h) B2: keep-alive, the first request answered before the start, the second half sent before it and completed 300 ms after: 200, then 503, then closed', async () => {
    const started = await stack()
    const connection = raw(started.port)
    await connection.connected()
    connection.write(rawRequest('/first'))
    const first = await connection.next()
    expect(first.status).toBe(200)
    connection.write('GET /second HTTP/1.1\r\nHost: 127.0.0.1\r\n')
    await sleep(100)
    const stop = started.stop()
    await sleep(300)
    expect(connection.isClosed()).toBe(false)
    connection.write('\r\n')
    const second = await connection.next()
    expect(second.status).toBe(503)
    expect(await within(connection.closed, 2_000)).not.toBeNull()
    stop.finish()
  }, 10_000)

  it('(i) an upgrade sent on a late-idle connection after the transports were closed is destroyed within 100 ms; the request before it is answered in full', async () => {
    const started = await stack()
    const connection = raw(started.port)
    await connection.connected()
    connection.write(rawRequest('/slow?ms=600'))
    const response = connection.next()
    await sleep(300)
    const stop = started.stop()
    const answered = await response
    expect(answered.status).toBe(200)
    expect(answered.body.toString()).toBe('slow:600')
    // Still inside the idle tail (finish + 1 001 ms) and well before the last close (T0 + 1 000 ms):
    // the connection is open when the upgrade arrives, so only the immediate destroy can close it.
    await sleep(200)
    expect(connection.isClosed()).toBe(false)
    const sentAt = Date.now()
    connection.write(rawWebSocketUpgrade())
    // The realtime server answers the upgrade in the same dispatch (a 101 may arrive); the module's
    // listener destroys the socket right after it, long before the idle tail or the last close.
    const closedAt = await within(connection.closed, 3_000)
    expect(closedAt).not.toBeNull()
    expect(closedAt!).toBeGreaterThanOrEqual(sentAt)
    expect(closedAt! - sentAt).toBeLessThan(100)
    stop.finish()
  }, 10_000)
})

describe('loopback: long poll while a precondition is pending (A2 window)', () => {
  it('(k) production form (listener closed, keep-alive agent): recorded, and the first disconnect is later than T0 + 300 ms', async () => {
    const started = await stack()
    const agent = new http.Agent({ keepAlive: true })
    try {
      const socket = client(started.url, { transports: ['polling'], reconnection: false, agent } as unknown as Parameters<typeof connectClient>[1])
      await connected(socket)
      await sleep(200)
      let received = 0
      socket.on('m', () => { received += 1 })
      const disconnect = disconnected(socket)
      let settle!: () => void
      const precondition = new Promise<void>((resolve) => { settle = resolve })
      const stop = started.stop(precondition)
      const sender = setInterval(() => started.broadcast('m', Date.now()), 300)
      setTimeout(() => settle(), 2_000)
      const result = await within(disconnect, 6_000)
      clearInterval(sender)
      expect(result).not.toBeNull()
      // Recorded, not asserted (L-2): how many of the messages arrived, and why it ended.
      console.info(`(k) received=${received} reason=${result!.reason} at=${result!.at - stop.t0}`)
      expect(result!.at - stop.t0).toBeGreaterThan(300)
      await within(stop.closed, 4_000)
      stop.finish()
    } finally {
      agent.destroy()
    }
  }, 15_000)

  it("(k') a raw engine.io v4 client that ignores the Keep-Alive hint and polls again at once on one connection: 6/6 arrive, then the close packet at the settle", async () => {
    const started = await stack()
    const connection = raw(started.port)
    await connection.connected()
    connection.write(rawRequest('/socket.io/?EIO=4&transport=polling&t=a'))
    const handshake = await connection.next()
    expect(handshake.status).toBe(200)
    const sid = JSON.parse(handshake.body.toString().slice(1)).sid as string
    const base = `/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`
    connection.write(rawRequest(`${base}&t=b`, { 'Content-Type': 'text/plain;charset=UTF-8' }, 'POST', '40'))
    expect((await connection.next()).body.toString()).toBe('ok')
    connection.write(rawRequest(`${base}&t=c`))
    expect((await connection.next()).body.toString()).toMatch(/^40/)

    const messages: number[] = []
    let closePacketAt: number | null = null
    let polls = 0
    const loop = (async () => {
      while (closePacketAt === null && !connection.isClosed()) {
        polls += 1
        connection.write(rawRequest(`${base}&t=p${polls}`))
        const answer = await connection.next().catch(() => null)
        if (!answer) return
        for (const packet of answer.body.toString().split('\x1e')) {
          if (packet.startsWith('42')) messages.push(Date.now())
          if (packet === '1') closePacketAt = Date.now()
        }
      }
    })()
    await sleep(50)

    let settle!: () => void
    const precondition = new Promise<void>((resolve) => { settle = resolve })
    const stop = started.stop(precondition)
    for (let index = 1; index <= 6; index += 1) setTimeout(() => started.broadcast('m', index), index * 300)
    setTimeout(() => settle(), 2_000)
    await within(loop, 6_000)
    expect(messages).toHaveLength(6)
    expect(closePacketAt).not.toBeNull()
    expect(closePacketAt! - stop.t0).toBeGreaterThanOrEqual(1_950)
    expect(closePacketAt! - stop.t0).toBeLessThan(2_600)
    await within(stop.closed, 4_000)
    stop.finish()
  }, 15_000)
})
