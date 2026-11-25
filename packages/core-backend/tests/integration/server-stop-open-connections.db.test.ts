/**
 * The stop of the whole server while client connections are open, on a real PostgreSQL (design lock
 * STOP-BARRIER-OPEN-CONNECTIONS v2 §5.3, C2). Each case starts the server in a child process
 * (tests/helpers/server-process-harness.ts) and stops it with a stop signal, which runs the product's
 * own signal handler: exit code 0 when the stop went through, 1 when it failed.
 *
 *   C2-a  a websocket client, a long-poll client, an engine.io websocket session that never answers a
 *         close frame, a request crossing the start that leaves its connection idle (d1), and a
 *         request crossing the start with a second one pipelined after it (d2): exit 0 in less than
 *         3 s, the stop went through, the pool was closed; the second request of d2 is answered 503
 *         SERVER_STOPPING with the CORS header;
 *   C2-b  no connection: the same, as a control;
 *   C2-c  a request that is still running 10 s after the start: the drain fails as before, exit 1,
 *         APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED, the pool is left open.
 *
 * Connects only when EXPECT_DB=1 and DATABASE_URL are both set; a skip is not a pass. Judged on
 * Node 20.x.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'

import { RawConnection, openSilentWebSocket, rawRequest, sleep } from '../helpers/client-connection-stack'
import { endServerProcesses, startServerProcess } from '../helpers/server-process-harness'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for server-stop-open-connections.db.test.ts')
}
const describeDb = process.env.EXPECT_DB === '1' ? describe : describe.skip

const clients: ClientSocket[] = []
const raws: RawConnection[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const raw of raws.splice(0)) raw.destroy()
  const { leftRunning } = await endServerProcesses()
  expect(leftRunning).toBe(0)
})

function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('connect_error', reject)
  })
}

describeDb('the stop of the whole server with client connections open (real PostgreSQL)', () => {
  it('C2-a: websocket, long poll, silent engine.io websocket, d1 and d2 open: exit 0 in less than 3 000 ms, the pool closed', async () => {
    const server = await startServerProcess()
    const websocket = connectClient(server.url, { forceNew: true, transports: ['websocket'], reconnection: false })
    const polling = connectClient(server.url, { forceNew: true, transports: ['polling'], reconnection: false })
    clients.push(websocket, polling)
    await Promise.all([connected(websocket), connected(polling)])
    const { connection: silent, status } = await openSilentWebSocket(server.port)
    raws.push(silent)
    expect(status).toBe(101)

    const d1 = new RawConnection(server.port)
    const d2 = new RawConnection(server.port)
    raws.push(d1, d2)
    await Promise.all([d1.connected(), d2.connected()])
    d1.write(rawRequest('/__stop-barrier/slow?ms=600'))
    d2.write(rawRequest('/__stop-barrier/slow?ms=600'))
    const d1Response = d1.next()
    const d2First = d2.next()
    await sleep(300)

    const startedAt = Date.now()
    const exit = server.stop()
    await sleep(50)
    d2.write(rawRequest('/__stop-barrier/after', { Origin: 'http://cross-origin.example' }))
    const d2Second = d2.next()

    expect((await d1Response).status).toBe(200)
    const first = await d2First
    expect(first.status).toBe(200)
    expect(first.body.toString()).toBe('slow:600')
    const second = await d2Second
    expect(second.status).toBe(503)
    expect(second.headers.connection).toBe('close')
    expect(second.headers['access-control-allow-origin']).toBeTruthy()
    expect(JSON.parse(second.body.toString()).error.code).toBe('SERVER_STOPPING')

    expect(await exit).toEqual({ code: 0, signal: null })
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(server.stopOutcome()).toEqual({ outcome: 'ok', reason: null })
    expect(server.poolEnded()).toBe(true)
  }, 180_000)

  it('C2-b: no connection (control): exit 0, the stop went through, the pool closed', async () => {
    const server = await startServerProcess()
    const startedAt = Date.now()
    expect(await server.stop()).toEqual({ code: 0, signal: null })
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(server.stopOutcome()).toEqual({ outcome: 'ok', reason: null })
    expect(server.poolEnded()).toBe(true)
  }, 180_000)

  it('C2-c: a request still running 10 s after the start: the drain fails as before, exit 1, the pool left open', async () => {
    const server = await startServerProcess()
    const held = new RawConnection(server.port)
    raws.push(held)
    await held.connected()
    held.write(rawRequest('/__stop-barrier/slow?ms=15000'))
    await sleep(300)
    expect(await server.stop()).toEqual({ code: 1, signal: null })
    expect(server.stopOutcome()).toEqual({ outcome: 'failed', reason: 'APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED' })
    expect(server.poolEnded()).toBe(false)
  }, 180_000)
})
