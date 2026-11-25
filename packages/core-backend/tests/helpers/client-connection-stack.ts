/**
 * A small server for the loopback and child-process cases of the stop of client connections
 * (design lock STOP-BARRIER-OPEN-CONNECTIONS): a real HTTP server, the real collaboration service
 * (its realtime server and its closeTransportsForShutdown) and the real module, wired the way the
 * product wires them: the fence in front of every request, the tracking armed once the realtime
 * server is attached, and at the stop `close()` first, then `begin()` in the same synchronous step.
 *
 * No database. Routes:
 *   /slow?ms=N      answers 200 after N ms with a short body;
 *   /big?mb=N       answers 200 with N MiB, 50 ms after the stop began (or at once without a stop);
 *   anything else   answers 200 'ok'.
 *
 * Also a raw HTTP/1.1 connection for the cases that need one connection under full control.
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { createClientConnectionShutdown, type ClientConnectionShutdown } from '../../src/lifecycle/client-connection-shutdown'
import { CollabService } from '../../src/services/CollabService'

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }

export interface StackStop {
  /** Date.now() at the start of the stop. */
  t0: number
  /** Resolves with Date.now() when the close callback of the HTTP server ran. */
  closed: Promise<number>
  finish(): void
}

export interface Stack {
  server: http.Server
  port: number
  url: string
  collab: CollabService
  shutdown: ClientConnectionShutdown
  /** A send to every realtime connection of the collaboration server. */
  broadcast(event: string, data: unknown): void
  /** Starts the stop the way the product does: close() first, then begin(). */
  stop(precondition?: Promise<unknown>): StackStop
  /** Ends everything that is left, for the end of a case. */
  dispose(): Promise<void>
}

export async function startStack(options: { port?: number } = {}): Promise<Stack> {
  const shutdown = createClientConnectionShutdown()
  let stopBegan: (() => void) | null = null
  const stopped = new Promise<void>((resolve) => { stopBegan = resolve })
  let stopping = false

  const route = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://local')
    if (url.pathname === '/slow') {
      const ms = Number(url.searchParams.get('ms') ?? 600)
      const body = `slow:${ms}`
      setTimeout(() => {
        response.setHeader('Content-Length', Buffer.byteLength(body))
        response.end(body)
      }, ms)
      return
    }
    if (url.pathname === '/big') {
      const size = Number(url.searchParams.get('mb') ?? 20) * 1024 * 1024
      const send = (): void => {
        response.setHeader('Content-Type', 'application/octet-stream')
        response.setHeader('Content-Length', size)
        response.end(Buffer.alloc(size, 7))
      }
      if (stopping) setTimeout(send, 50)
      else void stopped.then(() => setTimeout(send, 50))
      return
    }
    response.setHeader('Content-Length', 2)
    response.end('ok')
  }

  const server = http.createServer((request, response) => shutdown.fence(request, response, () => route(request, response)))
  const collab = new CollabService(silentLogger, { subscribe: () => undefined } as never)
  collab.initialize(server)
  shutdown.arm(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  let handle: StackStop | null = null

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    collab,
    shutdown,
    broadcast: (event, data) => collab.broadcast(event, data),
    stop: (precondition) => {
      const t0 = Date.now()
      stopping = true
      const closed = new Promise<number>((resolve) => {
        server.close(() => resolve(Date.now()))
      })
      const begun = shutdown.begin({ httpServer: server, closeTransports: () => collab.closeTransportsForShutdown(), precondition })
      stopBegan?.()
      handle = { t0, closed, finish: () => begun.finish() }
      return handle
    },
    dispose: async () => {
      handle?.finish()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      collab.getIO()?.close()
    },
  }
}

export interface RawResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  /** Date.now() when the whole response was read. */
  at: number
}

/**
 * One HTTP/1.1 connection written and read by hand: requests are written as given (pipelining and
 * half-written headers included) and responses are read in order, by their Content-Length.
 */
export class RawConnection {
  readonly socket: net.Socket
  /** Resolves with Date.now() when the connection closed, however it closed. */
  readonly closed: Promise<number>
  private buffer = Buffer.alloc(0)
  private readonly waiting: Array<{ resolve: (response: RawResponse) => void; reject: (error: Error) => void }> = []
  private ended = false
  /** Everything read that was not a response (for an upgraded connection). */
  raw = Buffer.alloc(0)
  private rawMode = false

  constructor(port: number) {
    this.socket = net.connect(port, '127.0.0.1')
    this.socket.on('error', () => undefined)
    this.socket.on('data', (data: Buffer) => {
      if (this.rawMode) {
        this.raw = Buffer.concat([this.raw, data])
        return
      }
      this.buffer = Buffer.concat([this.buffer, data])
      this.pump()
    })
    this.closed = new Promise<number>((resolve) => {
      this.socket.once('close', () => {
        this.ended = true
        for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('connection closed before a response'))
        resolve(Date.now())
      })
    })
  }

  connected(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket.connecting) {
        resolve()
        return
      }
      this.socket.once('connect', () => resolve())
      this.socket.once('error', reject)
    })
  }

  write(text: string): void {
    this.socket.write(text)
  }

  /** From now on, what arrives is kept as it is (after an upgrade). */
  readRaw(): void {
    this.rawMode = true
    this.raw = Buffer.concat([this.raw, this.buffer])
    this.buffer = Buffer.alloc(0)
  }

  isClosed(): boolean {
    return this.ended
  }

  next(): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      if (this.ended && this.buffer.length === 0) {
        reject(new Error('connection closed before a response'))
        return
      }
      this.waiting.push({ resolve, reject })
      this.pump()
    })
  }

  destroy(): void {
    this.socket.destroy()
  }

  private pump(): void {
    while (this.waiting.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const head = this.buffer.subarray(0, headerEnd).toString('latin1').split('\r\n')
      const status = Number(head[0].split(' ')[1])
      const headers: Record<string, string> = {}
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const length = status === 101 ? 0 : Number(headers['content-length'] ?? 0)
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length)
      this.buffer = this.buffer.subarray(start + length)
      this.waiting.shift()!.resolve({ status, headers, body, at: Date.now() })
    }
  }
}

/** A request on a raw connection, keep-alive unless the headers say otherwise. */
export function rawRequest(path: string, extraHeaders: Record<string, string> = {}, method = 'GET', body = ''): string {
  const lines = [`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1']
  for (const [name, value] of Object.entries(extraHeaders)) lines.push(`${name}: ${value}`)
  if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
  return `${lines.join('\r\n')}\r\n\r\n${body}`
}

/** The upgrade request of an engine.io v4 websocket session. */
export function rawWebSocketUpgrade(): string {
  return rawRequest('/socket.io/?EIO=4&transport=websocket', {
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': Buffer.from('stop-barrier-key').toString('base64'),
    'Sec-WebSocket-Version': '13',
  })
}

/**
 * A real engine.io websocket session that never answers a close frame: resolves once the server
 * answered 101 and sent its open packet.
 */
export async function openSilentWebSocket(port: number): Promise<{ connection: RawConnection; status: number; openPacket: string }> {
  const connection = new RawConnection(port)
  await connection.connected()
  connection.write(rawWebSocketUpgrade())
  const response = await connection.next()
  connection.readRaw()
  const deadline = Date.now() + 2_000
  while (connection.raw.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  // One unmasked text frame from the server: 0x81, a 7-bit length, then the payload.
  const length = connection.raw[1] & 0x7f
  while (connection.raw.length < 2 + length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  const openPacket = connection.raw[0] === 0x81 ? connection.raw.subarray(2, 2 + length).toString('utf8') : ''
  return { connection, status: response.status, openPacket }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
