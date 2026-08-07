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
 *
 * ## Fail-closed and values-free (review #4799 P2-1 / P2-2)
 *
 * The `describe('fails closed …')` block below injects a failure into each of the three DDL
 * statements the finding named (ALTER / plain DROP / forced DROP) and asserts the helper does NOT
 * report CLEAN or FORCED. Each injection is proved to have reached its TARGET statement, not some
 * neighbouring one, by two independent means:
 *
 *   1. the thrown error carries the injection's UNIQUE signature, so a test that failed for any
 *      other reason cannot pass; and
 *   2. the proxy records the ORDERED sequence of statement categories it saw, asserted exactly —
 *      which is what discriminates the plain DROP from the forced DROP. A hit COUNT would not:
 *      `/DROP DATABASE/` matches both, so a mis-aimed matcher firing on the wrong statement would
 *      still satisfy `count >= 1`.
 *
 * `describe('values-free log')` gates P2-2 mechanically: the emitted line must FULLY match an
 * anchored whitelist grammar, asserted with a holder that is deliberately hostile (SQL-shaped
 * `application_name`, a marked comment inside its statement text).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import {
  assertSafeScratchDatabaseName,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
  ScratchDropError,
  type ScratchAdminQueryable,
  type ScratchDropStep,
} from '../helpers/scratch-database'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const TERMINATION_SIGNATURE = /57P01|terminating connection|Connection terminated/i

/**
 * The log grammar, anchored. Written HERE and not exported from the helper on purpose: a gate
 * that shares its pattern with the implementation can be widened by a single edit that keeps both
 * sides agreeing. The charsets are positive whitelists, and the structural separators
 * (`=`, ` `, `[`, `]`, `/`, `|`) are excluded from the field charset, so no field value can forge
 * structure. Any SQL text or row value reaching the line would have to be spelled entirely in
 * `[A-Za-z0-9_.-]` AND survive truncation — and the leak tests below check the stronger property
 * that it never enters the outcome object at all.
 */
const CLEAN_LINE = /^scratchDrain=CLEAN suite=[A-Za-z0-9_.-]{1,48} drainMs=\d{1,10} residualBackends=0$/
const FORCED_LINE =
  /^scratchDrain=FORCED suite=[A-Za-z0-9_.-]{1,48} drainMs=\d{1,10} residualBackends=\d{1,6} holders=\[[A-Za-z0-9_.\-/|]{0,4000}\]$/
const FAILED_LINE = /^scratchDrain=FAILED suite=[A-Za-z0-9_.-]{1,48} drainMs=\d{1,10} step=[A-Za-z0-9_.-]{1,32}$/

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

// ================================================================================================
// Failure injection
// ================================================================================================

/** Closed category set for every statement the helper is allowed to issue. */
type StatementKind =
  | 'exists'
  | 'revoke'
  | 'count'
  | 'inspect'
  | 'terminate'
  | 'drop_plain'
  | 'drop_forced'
  | 'other'

/**
 * First match wins; the ordering makes the predicates mutually exclusive by construction
 * (`drop_forced` before `drop_plain`, `terminate` before the other `pg_stat_activity` readers).
 * A statement the helper starts issuing that is not in this set lands in `other`, which every
 * sequence assertion below will reject — the classifier fails loud rather than silently lumping a
 * new statement in with an existing category.
 */
function classify(sql: string): StatementKind {
  const s = sql.replace(/\s+/g, ' ').trim()
  if (/DROP DATABASE/i.test(s) && /WITH \(FORCE\)/i.test(s)) return 'drop_forced'
  if (/DROP DATABASE/i.test(s)) return 'drop_plain'
  if (/ALTER DATABASE/i.test(s) && /ALLOW_CONNECTIONS false/i.test(s)) return 'revoke'
  if (/pg_terminate_backend/i.test(s)) return 'terminate'
  if (/FROM pg_database/i.test(s)) return 'exists'
  if (/count\(\*\)/i.test(s) && /pg_stat_activity/i.test(s)) return 'count'
  if (/application_name/i.test(s) && /pg_stat_activity/i.test(s)) return 'inspect'
  return 'other'
}

/** Collapse consecutive duplicates — the drain poll issues `count` an unbounded number of times. */
function collapse(kinds: StatementKind[]): StatementKind[] {
  return kinds.filter((k, i) => i === 0 || k !== kinds[i - 1])
}

interface Injection {
  /** Which statement to interfere with. */
  on: StatementKind
  /**
   * `throw` — the statement errors, as a failing DDL would.
   * `silent_success` — the statement is NEVER sent to PG but reports success, which is exactly
   * what `DROP DATABASE IF EXISTS` looks like when it drops nothing. This is the mutation that
   * proves the read-back is load-bearing rather than decorative.
   */
  mode: 'throw' | 'silent_success'
  signature: string
}

interface InjectingPool {
  proxy: ScratchAdminQueryable
  /** Ordered statement categories actually issued, consecutive duplicates collapsed. */
  sequence(): StatementKind[]
  /** Raw count of statements matching the injection target, for a "did it ever fire?" check. */
  targetHits(): number
}

function injectingPool(real: Pool, injection?: Injection): InjectingPool {
  const seen: StatementKind[] = []
  let hits = 0
  const proxy: ScratchAdminQueryable = {
    async query(text: string, values?: unknown[]) {
      const kind = classify(text)
      seen.push(kind)
      if (injection && injection.on === kind) {
        hits += 1
        if (injection.mode === 'throw') throw new Error(injection.signature)
        return { rows: [] }
      }
      return await real.query(text, values as unknown[])
    },
  }
  return { proxy, sequence: () => collapse(seen), targetHits: () => hits }
}

describeIfDatabase('#4791 scratch-database teardown drain', () => {
  let adminPool: Pool

  beforeAll(async () => {
    if (!dbUrl) throw new Error('SCRATCH_DRAIN_TEST_REQUIRES_DATABASE')
    adminPool = new Pool({ connectionString: urlFor(dbUrl, 'postgres') })
  })

  /**
   * The fail-closed cases deliberately leave the scratch database UNDROPPED (that is the point:
   * the helper refused to claim a clean teardown), several of them with `datallowconn = false`.
   * Without this sweep they accumulate on a developer's local PG across runs.
   *
   * Scoped to the names THIS process created, not to a `LIKE 'ms2_drain%'` prefix: a prefix sweep
   * on a shared database would drop a concurrently-running copy of this suite's live scratch DB.
   */
  const createdScratchNames = new Set<string>()

  afterEach(async () => {
    for (const datname of createdScratchNames) {
      assertSafeScratchDatabaseName(datname)
      await adminPool.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => undefined)
      createdScratchNames.delete(datname)
    }
  })

  afterAll(async () => {
    await adminPool?.end().catch(() => undefined)
  })

  async function createScratch(tag: string): Promise<string> {
    const name = scratchNameFor(tag)
    await adminPool.query(`CREATE DATABASE ${name}`)
    createdScratchNames.add(name)
    return name
  }

  async function databaseExists(name: string): Promise<boolean> {
    const r = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    return r.rows.length > 0
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
    expect(formatScratchDropOutcome('lagging', outcome)).toMatch(CLEAN_LINE)
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
    // channel #4791 asks for, and a count alone cannot provide it. Post-P2-2 the identification
    // is `application_name` + state CATEGORY; the statement text is gone.
    expect(outcome.residual.some((r) => r.applicationName === 'ms2-drain-holder')).toBe(true)
    expect(outcome.residual.some((r) => r.category === 'active')).toBe(true)
    const line = formatScratchDropOutcome('held', outcome)
    expect(line).toMatch(FORCED_LINE)
    expect(line).toContain('ms2-drain-holder/active/')
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

  // ==============================================================================================
  // Review #4799 P2-1 — a DDL failure must never be reported as CLEAN or FORCED
  // ==============================================================================================
  describe('fails closed when a teardown statement fails (P2-1)', () => {
    /**
     * Shared assertion for all three injections. Deliberately does NOT use `instanceof` alone as
     * the criterion — the criterion itself has to be attackable. It requires (a) that the helper
     * did not RESOLVE at all (so no outcome exists that could be formatted CLEAN/FORCED),
     * (b) the rejection to carry the targeted step, and (c) the message to carry the injection's
     * unique signature, proving the injection reached the TARGETED statement rather than the test
     * passing on some unrelated failure.
     */
    async function runFailClosed(args: {
      pool: InjectingPool
      name: string
      step: ScratchDropStep
      signature: string
      sequence: StatementKind[]
      drainTimeoutMs?: number
    }): Promise<void> {
      let caught: unknown = null
      let resolvedOutcome: unknown = null
      try {
        resolvedOutcome = await dropScratchDatabase(args.pool.proxy, args.name, {
          drainTimeoutMs: args.drainTimeoutMs ?? 400,
          pollIntervalMs: 25,
        })
      } catch (err) {
        caught = err
      }

      // (1) No outcome — so there is nothing that could be formatted as CLEAN or FORCED.
      expect(resolvedOutcome, 'must not resolve to an outcome').toBeNull()
      expect(caught, 'must reject').not.toBeNull()

      // (2) The failure is the INJECTED one, at the TARGETED step. Without this the test would
      //     also pass if the helper had failed for an unrelated reason (or if the injection never
      //     fired and something else broke).
      const err = caught as ScratchDropError
      expect(err.step).toBe(args.step)
      expect(String((err as Error).message)).toContain(args.signature)
      expect(args.pool.targetHits(), 'injection must actually have fired').toBeGreaterThanOrEqual(1)

      // (3) The injection reached the statement it aimed at and no other. This is what separates
      //     the plain DROP case from the forced DROP case: both match /DROP DATABASE/.
      expect(args.pool.sequence()).toEqual(args.sequence)

      // (4) Nothing downstream can turn this into a success line.
      const failedLine = formatScratchDropFailure('injected', caught)
      expect(failedLine).toMatch(FAILED_LINE)
      expect(failedLine).toContain(`step=${args.step}`)
      expect(failedLine).not.toMatch(/CLEAN|FORCED/)
      // And the driver message never reaches the values-free log.
      expect(failedLine).not.toContain(args.signature)

      // (5) The database is still there — the helper refused to claim a teardown it did not do.
      expect(await databaseExists(args.name), 'database must still exist after a failed teardown').toBe(true)
    }

    it('POSITIVE CONTROL — the same proxy, with no injection, still reports CLEAN', async () => {
      const name = await createScratch('ctrl')
      const pool = injectingPool(adminPool)
      const outcome = await dropScratchDatabase(pool.proxy, name, { drainTimeoutMs: 4_000, pollIntervalMs: 25 })

      expect(outcome.forced).toBe(false)
      expect(formatScratchDropOutcome('ctrl', outcome)).toMatch(CLEAN_LINE)
      expect(await databaseExists(name)).toBe(false)
      // The happy path's full statement sequence, INCLUDING the post-drop read-back. If the
      // read-back were removed, the trailing `exists` would disappear and this goes red.
      expect(pool.sequence()).toEqual(['exists', 'revoke', 'count', 'drop_plain', 'exists'])
      expect(pool.targetHits()).toBe(0)
    })

    it('(a) a failing ALTER ... ALLOW_CONNECTIONS false is NOT reported as CLEAN', async () => {
      const name = await createScratch('injalter')
      const signature = `INJECTED_ALTER_FAILURE_${randomUUID()}`
      const pool = injectingPool(adminPool, { on: 'revoke', mode: 'throw', signature })

      await runFailClosed({
        pool,
        name,
        step: 'revoke_connections',
        signature,
        // Stops dead at the revoke: the drain never starts, nothing is dropped.
        sequence: ['exists', 'revoke'],
      })
    })

    it('(b) a failing plain DROP DATABASE is NOT reported as CLEAN', async () => {
      const name = await createScratch('injdrop')
      const signature = `INJECTED_PLAIN_DROP_FAILURE_${randomUUID()}`
      const pool = injectingPool(adminPool, { on: 'drop_plain', mode: 'throw', signature })

      await runFailClosed({
        pool,
        name,
        step: 'drop_plain',
        signature,
        // No holder, so the drain completes and the PLAIN drop is the statement reached —
        // `drop_forced` must NOT appear anywhere in this sequence.
        sequence: ['exists', 'revoke', 'count', 'drop_plain'],
        drainTimeoutMs: 4_000,
      })
      // Explicit: fail-closed must not silently escalate to a forced drop, which would make
      // CLEAN vs FORCED unfalsifiable.
      expect(pool.sequence()).not.toContain('drop_forced')
    })

    it('(c) a failing forced DROP DATABASE ... WITH (FORCE) is NOT reported as FORCED', async () => {
      const name = await createScratch('injforce')
      const signature = `INJECTED_FORCED_DROP_FAILURE_${randomUUID()}`
      const pool = injectingPool(adminPool, { on: 'drop_forced', mode: 'throw', signature })

      // A holder that stays busy past the deadline is what routes execution to the forced branch.
      const { client } = await connectWatched(name, 'ms2-drain-injforce-holder')
      const held = client.query('SELECT pg_sleep(30)').catch(() => undefined)

      await runFailClosed({
        pool,
        name,
        step: 'drop_forced',
        signature,
        sequence: ['exists', 'revoke', 'count', 'inspect', 'terminate', 'drop_forced'],
        drainTimeoutMs: 400,
      })
      // Reached via the forced branch, not the plain one — the counterpart of case (b).
      expect(pool.sequence()).not.toContain('drop_plain')

      await held
      await client.end().catch(() => undefined)
    })

    it('(d) READ-BACK is load-bearing — a DROP that "succeeds" without dropping is NOT CLEAN', async () => {
      // The mutation that would otherwise be invisible: `DROP DATABASE IF EXISTS` reports success
      // when it drops nothing. Here the statement never reaches PG at all but reports success, so
      // the ONLY thing that can catch it is re-querying `pg_database`.
      const name = await createScratch('injnoop')
      const pool = injectingPool(adminPool, {
        on: 'drop_plain',
        mode: 'silent_success',
        signature: 'unused',
      })

      let caught: unknown = null
      let resolvedOutcome: unknown = null
      try {
        resolvedOutcome = await dropScratchDatabase(pool.proxy, name, { drainTimeoutMs: 4_000, pollIntervalMs: 25 })
      } catch (err) {
        caught = err
      }

      expect(resolvedOutcome).toBeNull()
      expect(caught).not.toBeNull()
      expect((caught as ScratchDropError).step).toBe('confirm_absent')
      expect(String((caught as Error).message)).toContain('database still present after plain DROP')
      // The read-back really ran: a second `exists` after the drop.
      expect(pool.sequence()).toEqual(['exists', 'revoke', 'count', 'drop_plain', 'exists'])
      expect(await databaseExists(name)).toBe(true)
      expect(formatScratchDropFailure('injnoop', caught)).toMatch(FAILED_LINE)
    })
  })

  // ==============================================================================================
  // Review #4799 P2-2 — the teardown log must carry no SQL text and no row values
  // ==============================================================================================
  describe('values-free log (P2-2)', () => {
    it('never reads the holder SQL, and stays inside the grammar for a HOSTILE application_name', async () => {
      const name = await createScratch('leak')
      const marker = `LEAKMARKER${randomUUID().replace(/-/g, '')}`

      // Two holders, probing the two properties separately — they must not be conflated.
      //  A: a benign identity running SQL that carries a unique marker. Probes "statement text is
      //     never read". Its `application_name` is clean so that the marker's presence in the
      //     outcome could ONLY have come from the statement text.
      //  B: a hostile `application_name`. That field IS kept (it is the root-cause channel), so
      //     the property it must satisfy is different: charset-bounded at format time. It carries
      //     no SQL keywords, so it cannot contaminate A's assertions.
      const holderA = await connectWatched(name, 'ms2-drain-leakprobe')
      const heldA = holderA.client.query(`SELECT pg_sleep(30) /* ${marker} */`).catch(() => undefined)
      const holderB = await connectWatched(name, 'evil" name; ok --|/[]=')
      const heldB = holderB.client.query('SELECT pg_sleep(30)').catch(() => undefined)

      const outcome = await dropScratchDatabase(adminPool, name, { drainTimeoutMs: 400, pollIntervalMs: 25 })
      expect(outcome.forced).toBe(true)
      expect(outcome.residual.length).toBeGreaterThanOrEqual(2)

      // (1) Holder A's statement text is not merely absent from the LINE — it never entered the
      //     outcome object, because `query` is no longer selected from `pg_stat_activity` at all.
      //     That is the "by construction" half: a formatter that merely stopped PRINTING it would
      //     still leave it in memory for the next caller to log.
      const serialised = JSON.stringify(outcome)
      expect(serialised).not.toContain('pg_sleep')
      expect(serialised).not.toContain(marker)
      expect(serialised).not.toMatch(/SELECT|FROM|DROP|ALTER/i)

      // (2) Holder B: the line matches the anchored whitelist grammar even with a hostile name.
      //     That anchored match IS the gate — it bounds the charset mechanically rather than by
      //     enumerating bad spellings, which is the only form that converges. The named checks
      //     below are the specific hostile inputs, not the criterion.
      //
      //     `-` is deliberately IN the whitelist (real labels are hyphenated:
      //     `w4c2-sweep-call-through`, `ms2-drain-holder`), so a literal `--` can survive. It is
      //     inert here: this line is never parsed as SQL, and none of the log's structural
      //     separators (`=`, ` `, `[`, `]`, `/`, `|`) nor any newline can survive the whitelist,
      //     so no field value can forge structure or inject a second log line.
      const line = formatScratchDropOutcome('leak', outcome)
      expect(line).toMatch(FORCED_LINE)
      expect(line.split('\n')).toHaveLength(1)
      for (const forbidden of ['"', ';', '\n', '\r', marker, 'pg_sleep', 'SELECT']) {
        expect(line, `log line must not contain ${JSON.stringify(forbidden)}`).not.toContain(forbidden)
      }

      // (3) Positive control on the sanitiser: it must still be USEFUL. A sanitiser that emitted a
      //     constant, or a formatter that dropped holders entirely, would satisfy every assertion
      //     above — so the surviving, recognisable holder identities and the diagnostic category
      //     are asserted PRESENT.
      expect(line).toMatch(/holders=\[[^\]]*evil__name/)
      expect(line).toMatch(/holders=\[[^\]]*ms2-drain-leakprobe\/active\//)
      expect(line).toMatch(/residualBackends=[1-9]/)

      await heldA
      await heldB
      expect(holderA.errors.some((e) => TERMINATION_SIGNATURE.test(e.message))).toBe(true)
      expect(holderB.errors.some((e) => TERMINATION_SIGNATURE.test(e.message))).toBe(true)
      await holderA.client.end().catch(() => undefined)
      await holderB.client.end().catch(() => undefined)
    })

    it('the CLEAN and FAILED lines are inside the grammar too', () => {
      const clean = formatScratchDropOutcome('bpmn-poller-disabled', {
        drained: true,
        forced: false,
        residualBackends: 0,
        drainMs: 12,
        residual: [],
      })
      expect(clean).toMatch(CLEAN_LINE)

      const failed = formatScratchDropFailure(
        'w4c2-sweep-call-through',
        new ScratchDropError('drop_forced', 'database "x" is being accessed by other users', 42),
      )
      expect(failed).toMatch(FAILED_LINE)
      expect(failed).toBe('scratchDrain=FAILED suite=w4c2-sweep-call-through drainMs=42 step=drop_forced')
      // The driver detail travels on the Error (to the runner's failure output), never here.
      expect(failed).not.toContain('accessed by other users')

      // A non-ScratchDropError still produces a grammar-valid line rather than interpolating an
      // arbitrary message.
      const foreign = formatScratchDropFailure('suite', new Error('boom "; DROP TABLE users --'))
      expect(foreign).toMatch(FAILED_LINE)
      expect(foreign).toBe('scratchDrain=FAILED suite=suite drainMs=0 step=unknown')
    })
  })
})
