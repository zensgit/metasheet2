/**
 * Child-process scenarios for `tests/integration/core-pool-connection-error-listener.db.test.ts` (no
 * test runner here). One scenario per invocation (`argv[2]`); each prints `D2 <STAGE> key=value …`
 * lines and lets the process end on its own when the scenario ran to its end, so the parent reads the
 * exit code and the lines. Nothing in this file listens for 'error' on the connection under test, so in
 * the `idle` and `borrowed` scenarios only the code under test handles it.
 *
 * Every scenario only affects connections this process opened.
 */
import { Client, Pool } from 'pg'

import { ConnectionPool } from '../../src/integration/db/connection-pool'

const url = process.env.DATABASE_URL
if (!url) {
  process.stderr.write('D2 child: DATABASE_URL is required\n')
  process.exit(2)
}

const write = (line: string): void => void process.stdout.write(`D2 ${line}\n`)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'none'
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

async function withAdmin<T>(run: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: url, application_name: 'd2-admin' })
  await admin.connect()
  try {
    return await run(admin)
  } finally {
    await admin.end()
  }
}

async function backendAlive(admin: Client, pid: number): Promise<boolean> {
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])
  return Number(rows[0].n) > 0
}

/** Ends backend `pid` (opened by this process) and waits until the server no longer lists it. */
async function terminateAndWait(pid: number, timeoutMs = 5000): Promise<boolean> {
  return withAdmin(async (admin) => {
    await admin.query('SELECT pg_terminate_backend($1)', [pid])
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await backendAlive(admin, pid))) return true
      await sleep(25)
    }
    return !(await backendAlive(admin, pid))
  })
}

function appPool(name: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: url,
    max: 1,
    min: 0,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
    name,
    application_name: `d2-${name}`,
  })
}

async function pidOf(pool: ConnectionPool): Promise<number> {
  const { rows } = await pool.query<{ pid: string }>('SELECT pg_backend_pid() AS pid')
  return Number(rows[0].pid)
}

async function close(pool: ConnectionPool): Promise<void> {
  pool.stopMetricsCollection()
  await pool.getInternalPool().end()
}

/** (a) an idle pooled connection is terminated: the pool records it, discards it, and the next query succeeds. */
async function idleScenario(): Promise<number> {
  const pool = appPool('d2-idle')
  const raw = pool.getInternalPool()
  const first = await pidOf(pool) // borrowed by pool.query and released: now idle in the pool
  write(`IDLE_BORROWED pid=${first} total=${raw.totalCount} idle=${raw.idleCount}`)
  const gone = await terminateAndWait(first)
  write(`IDLE_TERMINATED pid=${first} gone=${gone}`)
  const observed = await waitFor(() => pool.connectionErrorCount >= 1, 5000)
  write(`IDLE_OBSERVED observed=${observed} errors=${pool.connectionErrorCount} total=${raw.totalCount} idle=${raw.idleCount}`)
  const next = await pidOf(pool)
  write(`IDLE_NEXT pid=${next} different=${next !== first}`)
  await close(pool)
  return 0
}

/** (b) a connection lost while the transaction wrapper holds it: the failure reaches the caller, the pool discards the connection, the next query succeeds. */
async function borrowedScenario(): Promise<number> {
  const pool = appPool('d2-borrowed')
  const raw = pool.getInternalPool()
  let removed = 0
  raw.on('remove', () => {
    removed += 1
  })
  let pid = 0
  let rejected = false
  try {
    await pool.transaction(async (trx) => {
      const { rows } = await trx.query<{ pid: string }>('SELECT pg_backend_pid() AS pid')
      pid = Number(rows[0].pid)
      write(`BORROWED_IN_TXN pid=${pid} total=${raw.totalCount}`)
      const gone = await terminateAndWait(pid)
      write(`BORROWED_TERMINATED pid=${pid} gone=${gone}`)
      // Waits until the driver reports the held client unusable (a driver field, read only; no
      // listener is added here), so the outcome of the next statement is deterministic.
      const client = trx.__rawClient as unknown as { _queryable?: boolean }
      const heard = await waitFor(() => client._queryable === false, 5000)
      write(`BORROWED_CLIENT_STATE heard=${heard}`)
      await trx.query('SELECT 1')
      return 'unexpected'
    })
    write('BORROWED_RESOLVED')
  } catch (error) {
    rejected = true
    write(`BORROWED_REJECTED code=${codeOf(error)}`)
  }
  await sleep(100)
  write(`BORROWED_POOL total=${raw.totalCount} idle=${raw.idleCount} removed=${removed} poolErrors=${pool.connectionErrorCount}`)
  const next = await pidOf(pool)
  write(`BORROWED_NEXT pid=${next} different=${next !== pid}`)
  await close(pool)
  return rejected ? 0 : 3
}

/** Control for the harness: the parent expects this scenario not to reach its last line, which shows the harness tells an unfinished child from a finished one. */
async function controlScenario(): Promise<number> {
  const pool = new Pool({ connectionString: url, max: 1, min: 0, idleTimeoutMillis: 60000, application_name: 'd2-control' })
  const { rows } = await pool.query('SELECT pg_backend_pid() AS pid')
  const pid = Number(rows[0].pid)
  write(`CONTROL_BORROWED pid=${pid}`)
  // The start marker: the parent checks that it exists and that the end marker does not.
  write(`CONTROL_TERMINATING pid=${pid}`)
  await withAdmin((admin) => admin.query('SELECT pg_terminate_backend($1)', [pid]))
  await sleep(3000)
  write('CONTROL_STILL_RUNNING')
  await pool.end()
  return 0
}

async function main(): Promise<number> {
  const scenario = process.argv[2]
  if (scenario === 'idle') return idleScenario()
  if (scenario === 'borrowed') return borrowedScenario()
  if (scenario === 'control') return controlScenario()
  process.stderr.write(`D2 child: unknown scenario ${String(scenario)}\n`)
  return 2
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`D2 child: scenario failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 4
  },
)
