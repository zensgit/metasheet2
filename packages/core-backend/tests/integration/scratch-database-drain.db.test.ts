/**
 * #4791 — behavioural gates for the scratch-database teardown drain
 * (`tests/helpers/scratch-database.ts`).
 *
 * ## The mechanism, reproduced
 *
 * #4791 records the failure as load-sensitive and not reproducible on demand (a local A/B over
 * 36 runs: 0/18 on both `main` and the PR head). What is reproducible on demand — and what the
 * first draft of THIS file hit by accident — is the mechanism underneath it:
 *
 *   `DROP DATABASE ... WITH (FORCE)` calls `pg_terminate_backend` on every attached backend.
 *   `pg` surfaces that to the owning `Client`/`Pool` as an `'error'` EVENT (57P01 /
 *   "Connection terminated unexpectedly"), not as a rejection of the in-flight query promise.
 *   A `.catch()` on the query therefore does NOT own it. With no `'error'` listener, node
 *   reports an uncaught exception, vitest prints `Errors: 2`, and the run exits 1 with every
 *   test passing — which is verbatim the #4791 CI signature.
 *
 * That is why the fix drains instead of muting: on the drained path nothing is terminated, so
 * no such event is ever emitted and there is nothing to own. The "clean drop" case below asserts
 * exactly that, with a lagging connection present — it is the payoff test, not a smoke test.
 *
 * ## Constructed, not argued
 *
 * The repo's discipline for races is that a sequential argument proves nothing. So the holder
 * cases really do keep a live backend busy (`pg_sleep`) across the drain window, and the
 * connect-refusal case really does race a fresh connection against a drain still in progress.
 *
 * Each gate is paired with the mutation that makes it red (run by hand, recorded in the PR):
 *   - delete the `ALLOW_CONNECTIONS false` statement  -> "refuses new connections" RED
 *   - delete the poll loop (force immediately)        -> "clean drop" RED, on BOTH its
 *                                                        `forced === false` and its
 *                                                        "no unowned pg error" assertion
 *   - delete `assertSafeScratchDatabaseName`          -> "rejects unsafe identifiers" RED
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import {
  assertSafeScratchDatabaseName,
  dropScratchDatabase,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const TERMINATION_SIGNATURE = /57P01|terminating connection|Connection terminated/i

function scratchNameFor(tag: string): string {
  return `ms2_drain${tag}_${randomUUID().slice(0, 8).replace(/-/g, '')}`
}

function urlFor(base: string, database: string): string {
  const u = new URL(base)
  u.pathname = `/${database}`
  return u.toString()
}

/**
 * A client whose backend-termination `'error'` EVENT is captured rather than left unowned.
 * Owning it is what keeps this suite from reproducing #4791 in its own process; capturing it
 * is what lets the assertions below distinguish "was terminated" from "was allowed to finish".
 */
async function connectWatched(
  database: string,
  applicationName: string,
): Promise<{ client: Client; errors: Error[] }> {
  const client = new Client({ connectionString: urlFor(dbUrl!, database), application_name: applicationName })
  const errors: Error[] = []
  client.on('error', (err: Error) => errors.push(err))
  await client.connect()
  return { client, errors }
}

describeIfDatabase('#4791 scratch-database teardown drain', () => {
  let adminPool: Pool

  beforeAll(async () => {
    if (!dbUrl) throw new Error('SCRATCH_DRAIN_TEST_REQUIRES_DATABASE')
    adminPool = new Pool({ connectionString: urlFor(dbUrl, 'postgres') })
  })

  afterAll(async () => {
    await adminPool?.end().catch(() => undefined)
  })

  async function createScratch(tag: string): Promise<string> {
    const name = scratchNameFor(tag)
    await adminPool.query(`CREATE DATABASE ${name}`)
    return name
  }

  async function databaseExists(name: string): Promise<boolean> {
    const r = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    return (r.rowCount ?? 0) > 0
  }

  it('waits for a LAGGING connection and drops without terminating it (no unowned pg error)', async () => {
    const name = await createScratch('lagging')
    // Models the real teardown: `server.stop()` has been called, but one background component's
    // connection has not finished closing yet. Pre-fix, FORCE killed it here.
    const { client, errors } = await connectWatched(name, 'ms2-drain-lagging')
    const lagging = new Promise<void>((resolve) => {
      setTimeout(() => {
        client
          .query('SELECT 1')
          .then(() => client.end())
          .catch(() => undefined)
          .finally(() => resolve())
      }, 150)
    })

    const outcome = await dropScratchDatabase(adminPool, name, { drainTimeoutMs: 5_000, pollIntervalMs: 25 })
    await lagging

    expect(outcome.drained).toBe(true)
    expect(outcome.forced).toBe(false)
    expect(outcome.residualBackends).toBe(0)
    // THE payoff assertion. This is the error that reds the required `test` check in #4791;
    // on the drained path it must never be emitted at all.
    expect(errors.map((e) => e.message)).toEqual([])
    // And the drain genuinely waited for the lagging client rather than racing past it.
    expect(outcome.drainMs).toBeGreaterThanOrEqual(140)
    expect(await databaseExists(name)).toBe(false)
    expect(formatScratchDropOutcome('lagging', outcome)).toMatch(/^scratchDrain=CLEAN /)
  })

  it('reports FORCED, names the holder, and DOES emit the termination error', async () => {
    const name = await createScratch('held')
    const { client, errors } = await connectWatched(name, 'ms2-drain-holder')
    // Deliberately not awaited: the backend must still be busy while the helper drains.
    const held = client.query('SELECT pg_sleep(30)').catch(() => undefined)

    const outcome = await dropScratchDatabase(adminPool, name, { drainTimeoutMs: 400, pollIntervalMs: 25 })

    expect(outcome.drained).toBe(false)
    expect(outcome.forced).toBe(true)
    expect(outcome.residualBackends).toBeGreaterThanOrEqual(1)
    // The holder is IDENTIFIED, not merely counted — that identification is the root-cause
    // channel #4791 asks for, and a count alone cannot provide it.
    expect(outcome.residual.some((r) => r.applicationName === 'ms2-drain-holder')).toBe(true)
    expect(outcome.residual.some((r) => r.query.includes('pg_sleep'))).toBe(true)
    expect(formatScratchDropOutcome('held', outcome)).toMatch(/^scratchDrain=FORCED .*ms2-drain-holder/)
    expect(await databaseExists(name)).toBe(false)

    await held
    // Negative control for the payoff assertion above: forcing really does produce the error
    // that the drained path must not. Without this, "no error on the clean path" could just as
    // well mean this suite is incapable of observing the error at all.
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.some((e) => TERMINATION_SIGNATURE.test(e.message))).toBe(true)
    await client.end().catch(() => undefined)
  })

  it('refuses NEW connections while the drain is still in progress (the TOCTOU window)', async () => {
    const name = await createScratch('toctou')
    const { client, errors } = await connectWatched(name, 'ms2-drain-toctou-holder')
    const held = client.query('SELECT pg_sleep(30)').catch(() => undefined)

    // Started but NOT awaited: the assertion below has to land while the helper sits between
    // "revoked connect rights" and "dropped" — exactly the window a reconnecting pool would slip
    // through if step (1) of the helper were missing.
    const dropping = dropScratchDatabase(adminPool, name, { drainTimeoutMs: 4_000, pollIntervalMs: 25 })
    await new Promise((resolve) => setTimeout(resolve, 250))

    const latecomer = new Client({ connectionString: urlFor(dbUrl!, name), application_name: 'ms2-drain-latecomer' })
    latecomer.on('error', () => undefined)
    let connectError: Error | null = null
    try {
      await latecomer.connect()
      await latecomer.end().catch(() => undefined)
    } catch (err) {
      connectError = err as Error
    }

    // Positive assertion on WHY it failed. "connect threw" alone would also be satisfied by the
    // database having already been dropped, which is a different and strictly later state.
    expect(connectError).not.toBeNull()
    expect(String(connectError?.message)).toMatch(/not currently accepting connections/i)

    const outcome = await dropping
    expect(outcome.forced).toBe(true)
    await held
    expect(errors.some((e) => TERMINATION_SIGNATURE.test(e.message))).toBe(true)
    await client.end().catch(() => undefined)
  })

  it('is a no-op (not an error) when the database is already gone', async () => {
    const outcome = await dropScratchDatabase(adminPool, scratchNameFor('absent'), { drainTimeoutMs: 200 })
    expect(outcome.drained).toBe(true)
    expect(outcome.forced).toBe(false)
    expect(outcome.drainMs).toBe(0)
  })

  it('rejects unsafe identifiers instead of interpolating them into DDL', () => {
    // The database name cannot be a bind parameter, so this guard is the only thing standing
    // between a caller-shaped string and executed DDL.
    for (const bad of ['ms2_x; DROP DATABASE postgres', 'MS2_UPPER', 'ms2-dash', '1leading', '', 'ms2_x"y']) {
      expect(() => assertSafeScratchDatabaseName(bad), bad).toThrow(/SCRATCH_DATABASE_NAME_UNSAFE/)
    }
    // Positive control: the shape the real call sites generate must still be ACCEPTED, otherwise
    // this gate would pass simply by rejecting everything.
    expect(() => assertSafeScratchDatabaseName('ms2_w4c2sweepct_0f1e2d3c4b5a')).not.toThrow()
  })
})
