/**
 * Child-process scenarios for the settlement coordination tests (no test runner here). Each prints one
 * terminal line — `PORT_REJECTED` / `PORT_RESOLVED` or `FINISHED_OK` / `FINISHED_ERROR <code>` — and
 * then lets the process end on its own: nothing else keeps it alive, so a scenario that never reaches
 * its terminal line shows up as an exit without one, and an unhandled 'error' event as exit code 1.
 */
import { createSystemCoordinationClockV1 } from '../../src/attendance/coordination/settlement-coordination-clock'
import { deriveSettlementCoordinationCapacityV1 } from '../../src/attendance/coordination/settlement-coordination-capacity'
import { coordinatedTransactionCliV1, createSettlementCoordinationCliCoordinatorV1 } from '../../src/attendance/coordination/settlement-coordination-cli'
import { coordinatedTransactionV1 } from '../../src/attendance/coordination/settlement-coordination-port'
import { createSettlementCoordinatorV1, type SettlementCoordinationPoolV1 } from '../../src/attendance/coordination/settlement-coordinator'
import { FakeLockWorld, FakePool, ORG, REQUEST } from './settlement-coordination-fakes-core'

const write = (line: string): void => void process.stdout.write(`${line}\n`)
const codeOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? (error as Error)?.message ?? error)

async function connectionError(): Promise<void> {
  const world = new FakeLockWorld()
  const pool = new FakePool(world)
  const coordinator = createSettlementCoordinatorV1({
    pool,
    capacity: deriveSettlementCoordinationCapacityV1({ poolMax: 20 }),
    connectTimeoutMs: 1000,
    clock: createSystemCoordinationClockV1(),
  })
  try {
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        const client = pool.clients[0]
        await new Promise<void>((resolve) =>
          setImmediate(() => {
            client.lose(new Error('child: connection lost'))
            resolve()
          }),
        )
        await context.client.query('UPDATE t SET v = 1')
        return 'never'
      },
    })
    write('PORT_RESOLVED')
  } catch (error) {
    write(`PORT_REJECTED ${codeOf(error)}`)
  }
}

/** A private pool whose first `failures` connects are refused; later ones hand out fake clients. */
function flakyPool(failures: number): SettlementCoordinationPoolV1 {
  const pool = new FakePool(new FakeLockWorld())
  let connects = 0
  return {
    connect: () => {
      connects += 1
      return connects <= failures ? Promise.reject(new Error('child: connection refused')) : pool.connect()
    },
  }
}

async function cli(failures: number, backoffMs: number, abortAfterMs: number | null): Promise<void> {
  const coordinator = createSettlementCoordinationCliCoordinatorV1({ pool: flakyPool(failures), poolMax: 4 })
  const controller = new AbortController()
  if (abortAfterMs !== null) setTimeout(() => controller.abort(), abortAfterMs)
  const started = Date.now()
  try {
    const value = await coordinatedTransactionCliV1({
      transactionDepth: () => 0,
      coordinator,
      request: { ...REQUEST, signal: controller.signal },
      candidate: { org: ORG },
      retry: { attempts: 2, backoffMs: [backoffMs], jitter: 0 },
      body: async (context) => {
        await context.client.query('UPDATE t SET v = 1')
        return 'committed'
      },
    })
    write(`FINISHED_OK ${value} ${Date.now() - started}`)
  } catch (error) {
    write(`FINISHED_ERROR ${codeOf(error)} ${Date.now() - started}`)
  }
}

const scenario = process.argv[2]
if (scenario === 'connection-error') void connectionError()
else if (scenario === 'cli-retry-succeeds') void cli(1, 300, null)
else if (scenario === 'cli-retry-exhausted') void cli(Number.MAX_SAFE_INTEGER, 300, null)
else if (scenario === 'cli-retry-aborted') void cli(Number.MAX_SAFE_INTEGER, 5000, 100)
else {
  write(`UNKNOWN_SCENARIO ${String(scenario)}`)
  process.exitCode = 2
}
