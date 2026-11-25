/**
 * C1 (design lock STOP-BARRIER-OPEN-CONNECTIONS §5.3, no database): a child process runs the loopback
 * server with the stop signal mapped as MetaSheetServer.stopForSignal maps it. Holding a websocket
 * client, a long-poll client and an engine.io websocket session that never answers a close frame, a
 * stop signal ends it with exit code 0 in less than 3 s (before the fix: the 10 s barrier and 1).
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client'

import { openSilentWebSocket, sleep, type RawConnection } from '../helpers/client-connection-stack'

const ROOT = path.resolve(__dirname, '../..')
const CHILD = path.join(__dirname, '../helpers/client-connection-child.ts')

const clients: ClientSocket[] = []
const raws: RawConnection[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const raw of raws.splice(0)) raw.destroy()
})

function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('connect_error', reject)
  })
}

describe('C1 child process, no database', () => {
  it('a stop signal with a websocket, a long poll and a silent engine.io websocket open: exit code 0 in less than 3 000 ms', async () => {
    const child = fork(CHILD, [], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the child did not start')), 30_000)
        child.on('message', (message: { type?: string; port?: number }) => {
          if (message.type === 'ready' && typeof message.port === 'number') {
            clearTimeout(timer)
            resolve(message.port)
          }
        })
        child.once('exit', () => reject(new Error('the child ended before it listened')))
      })
      const url = `http://127.0.0.1:${port}`
      const websocket = connectClient(url, { forceNew: true, transports: ['websocket'], reconnection: false })
      const polling = connectClient(url, { forceNew: true, transports: ['polling'], reconnection: false })
      clients.push(websocket, polling)
      await Promise.all([connected(websocket), connected(polling)])
      const { connection, status } = await openSilentWebSocket(port)
      raws.push(connection)
      expect(status).toBe(101)
      // Let the next long poll be outstanding.
      await sleep(200)

      const startedAt = Date.now()
      child.kill('SIGTERM')
      const exit = await Promise.race([exited, sleep(15_000).then(() => null)])
      const elapsed = Date.now() - startedAt
      expect(exit).toEqual({ code: 0, signal: null })
      expect(elapsed).toBeLessThan(3_000)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  }, 40_000)
})
