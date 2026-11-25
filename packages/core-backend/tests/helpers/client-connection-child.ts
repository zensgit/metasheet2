/**
 * Child process of the C1 case (design lock STOP-BARRIER-OPEN-CONNECTIONS §5.3, no database): the
 * loopback server of tests/helpers/client-connection-stack.ts, with a stop signal mapped the way
 * MetaSheetServer.stopForSignal maps it: exit 0 when the stop went through, 1 when it failed. The
 * stop fails the way the producer barrier fails: when the close callback of the HTTP server has not
 * run within 10 s.
 *
 * It says `ready` with its port over the channel, prints nothing, and never outlives its parent.
 */
import { startStack } from './client-connection-stack'

const BARRIER_MS = 10_000

if (typeof process.send !== 'function') process.exit(2)
process.on('disconnect', () => process.exit(3))
setTimeout(() => process.exit(4), 60_000).unref()

async function main(): Promise<void> {
  const stack = await startStack()
  let stopping: Promise<void> | null = null
  const stopOnce = (): Promise<void> => {
    stopping ??= (async () => {
      const stop = stack.stop()
      let timer: NodeJS.Timeout | null = null
      try {
        await Promise.race([
          stop.closed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED')), BARRIER_MS)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        stop.finish()
      }
    })()
    return stopping
  }
  process.on('SIGTERM', () => {
    void stopOnce().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
  process.send?.({ type: 'ready', port: stack.port })
}

main().catch(() => process.exit(5))
