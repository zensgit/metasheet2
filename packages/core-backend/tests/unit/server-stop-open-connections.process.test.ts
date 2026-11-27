/**
 * The whole server, started for real in a child process without a database (DATABASE_URL points to
 * an unreachable port), stopped with a stop signal through the product's own signal handler
 * (tests/helpers/server-process-harness.ts). Unlike C1, the connections are taken over by the
 * realtime server the product attaches in start(), so the tracking armed in start() is exercised:
 * a websocket client, an engine.io websocket session that never answers a close frame, and a
 * keep-alive request crossing the stop. Exit code 0 in less than 3 s, the stop went through, the
 * pool was closed. Before the stop, the fence the started server serves must have the source of the
 * fence the module hands out. The real-database cases (C2) are in tests/integration/server-stop-open-connections.db.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'

import { RawConnection, openSilentWebSocket, rawRequest, sleep } from '../helpers/client-connection-stack'
import { endServerProcesses, startServerProcess } from '../helpers/server-process-harness'

const clients: ClientSocket[] = []
const raws: RawConnection[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const raw of raws.splice(0)) raw.destroy()
  const { leftRunning } = await endServerProcesses()
  expect(leftRunning).toBe(0)
})

describe('the whole server started without a database, stopped with connections open', () => {
  it('a websocket, a silent engine.io websocket and a keep-alive request crossing the stop: exit 0 in less than 3 000 ms, the pool closed', async () => {
    const server = await startServerProcess({ env: { DATABASE_URL: 'postgres://127.0.0.1:1/none' } })
    // The started server serves exactly the fence the unit tests pin (U4c pins it as a const that is
    // never reassigned): nothing between construction and start() swapped or wrapped it.
    expect(await server.fenceSource()).toBe(true)
    const websocket = connectClient(server.url, { forceNew: true, transports: ['websocket'], reconnection: false })
    clients.push(websocket)
    await new Promise<void>((resolve, reject) => {
      websocket.once('connect', () => resolve())
      websocket.once('connect_error', reject)
    })
    const { connection: silent, status } = await openSilentWebSocket(server.port)
    raws.push(silent)
    expect(status).toBe(101)
    const keepAlive = new RawConnection(server.port)
    raws.push(keepAlive)
    await keepAlive.connected()
    keepAlive.write(rawRequest('/__stop-barrier/slow?ms=600'))
    const response = keepAlive.next()
    await sleep(300)

    const startedAt = Date.now()
    const exit = server.stop()
    expect((await response).status).toBe(200)
    expect(await exit).toEqual({ code: 0, signal: null })
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(server.stopOutcome()).toEqual({ outcome: 'ok', reason: null })
    expect(server.poolEnded()).toBe(true)
  }, 180_000)
})
