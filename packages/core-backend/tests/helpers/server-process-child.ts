/**
 * The whole server in one child process, for tests/helpers/server-process-harness.ts (C2 cases of
 * the stop of client connections). It starts MetaSheetServer on a port the system picks on the
 * loopback interface, with one route for the test only (mounted here, never by the product):
 *   GET /__stop-barrier/slow?ms=N   answers 200 after N ms;
 * and on a stop signal it runs the product's own signal handler (stopForSignal, reached through a
 * type assertion), after first observing the latched stop promise, so the outcome is said before
 * the process exits. It says `pool-ended` once the database pool has been closed.
 *
 * On the command `fence-source` it says whether the fence its started server serves has the same
 * source as the fence a fresh instance of the module hands out.
 *
 * It prints nothing, never sends its settings, and never outlives its parent.
 */
import type { Application, Request, Response } from 'express'

const lifetimeMs = Number(process.env.STOP_BARRIER_PROCESS_LIFETIME_MS ?? 120_000)

function tell(message: Record<string, unknown>): void {
  if (process.connected) process.send?.(message)
}

/** A reason that can be passed on: one line, no address of a database in it. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\b[a-z]+:\/\/\S+/gi, '<address>').split('\n')[0].slice(0, 200)
}

if (typeof process.send !== 'function') process.exit(2)
process.on('disconnect', () => process.exit(3))
setTimeout(() => process.exit(4), lifetimeMs).unref()

async function main(): Promise<void> {
  const { pool } = await import('../../src/db/pg')
  if (pool) {
    const end = pool.end.bind(pool)
    ;(pool as { end: () => Promise<void> }).end = async () => {
      await end()
      tell({ type: 'pool-ended' })
    }
  }
  const { MetaSheetServer } = await import('../../src/index')
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', manageProcessSignals: false })
  const app = (server as unknown as { app: Application }).app
  app.get('/__stop-barrier/slow', (request: Request, response: Response) => {
    const ms = Number(request.query.ms ?? 600)
    setTimeout(() => response.type('text/plain').send(`slow:${ms}`), ms)
  })
  await server.start()
  const address = server.getAddress()
  if (!address || typeof address === 'string' || !address.port) throw new Error('the server did not listen')

  let signalled = false
  process.on('SIGTERM', () => {
    if (signalled) return
    signalled = true
    // The observer is attached first, so it runs before the exit of the product's handler.
    server.stop('SIGTERM').then(
      () => tell({ type: 'stop-outcome', outcome: 'ok' }),
      (error: unknown) => tell({ type: 'stop-outcome', outcome: 'failed', reason: reasonOf(error) }),
    )
    ;(server as unknown as { stopForSignal(signal: 'SIGTERM' | 'SIGINT'): void }).stopForSignal('SIGTERM')
  })
  // For the check that the fence served by the started server is the declaration the unit tests pin:
  // its source, compared with the fence a fresh instance of the module hands out.
  const { createClientConnectionShutdown } = await import('../../src/lifecycle/client-connection-shutdown')
  process.on('message', (message: { type?: string; id?: number }) => {
    if (message?.type !== 'fence-source') return
    const served = (server as unknown as { clientConnectionShutdown: { fence: unknown } }).clientConnectionShutdown.fence
    const pinned = createClientConnectionShutdown().fence
    tell({ type: 'fence-source', id: message.id, sameSource: typeof served === 'function' && String(served) === String(pinned) })
  })
  tell({ type: 'ready', port: address.port })
}

main().catch((error) => {
  tell({ type: 'failed', reason: reasonOf(error) })
  process.exit(1)
})
