/**
 * #4791 — teardown drain for real-server scratch databases.
 *
 * The failure this closes: a suite that boots a REAL `MetaSheetServer` against its OWN
 * freshly-migrated scratch database ends `afterAll` with
 * `DROP DATABASE <scratch> WITH (FORCE)`. `FORCE` calls `pg_terminate_backend` on every
 * backend still attached. If a real-server background component still has a query in flight
 * on one of those backends, PG answers that query with
 * `57P01 terminating connection due to administrator command`; the rejection has no owner, so
 * vitest reports `Unhandled Errors: 1` and the step exits 1 **even though every test passed**.
 * Because the run is load-sensitive it only manifests under the full CI suite (a local A/B over
 * 36 runs reproduced it 0/18 on both `main` and the PR head), so it reds the REQUIRED `test`
 * check on unrelated PRs.
 *
 * Shape of the fix — remove the cause, do not mute the symptom:
 *
 *  1. `ALLOW_CONNECTIONS false` **first**. Draining and then dropping leaves a window in which
 *     a reconnecting pool re-attaches between the count and the DDL; revoking connect rights
 *     closes that window instead of narrowing it. (`DROP DATABASE` itself still works on a
 *     database with `datallowconn = false`.)
 *  2. Poll `pg_stat_activity` until no backend but ours is attached. A plain `DROP DATABASE`
 *     then terminates nothing, so nothing can raise 57P01.
 *  3. Only if the drain deadline expires: capture who is still attached, `pg_terminate_backend`
 *     them, and fall back to `WITH (FORCE)`.
 *
 * Step 3 is the reason this returns a value rather than `void`. A forced drop is exactly the
 * pre-fix behaviour, so "CI went green" cannot by itself distinguish a working drain from a
 * lucky run — the race was never reproducible on demand. `ScratchDropOutcome.forced` is the
 * discriminator: callers log it unconditionally, `CLEAN` is the claim this helper makes, and a
 * `FORCED` line names the component still holding a connection (that is the root cause #4791
 * asks for, and it is not knowable any other way).
 */
import type { Pool } from 'pg'

export interface ScratchResidualBackend {
  applicationName: string
  state: string
  query: string
}

export interface ScratchDropOutcome {
  /** Every backend other than ours detached on its own before the deadline. */
  drained: boolean
  /** We had to `pg_terminate_backend` + `DROP ... WITH (FORCE)` — i.e. 57P01 was possible. */
  forced: boolean
  /** Backends still attached when the deadline expired (0 whenever `drained`). */
  residualBackends: number
  /** Observed drain duration, for the CI log line. */
  drainMs: number
  /** Populated only on the forced path — who was still holding a connection. */
  residual: ScratchResidualBackend[]
}

/**
 * Identifier guard. `scratchName` is interpolated into DDL (`DROP DATABASE` and
 * `ALTER DATABASE` take no bind parameters for the database name), so it is validated against a
 * POSITIVE character whitelist rather than a denylist of bad spellings: the complement of a
 * denylist is unbounded, the complement of this pattern is not. Matches what the call sites
 * actually generate (`ms2_<suite>_<hex>`), and nothing else.
 */
const SAFE_SCRATCH_NAME = /^[a-z][a-z0-9_]{0,62}$/

export function assertSafeScratchDatabaseName(scratchName: string): void {
  if (typeof scratchName !== 'string' || !SAFE_SCRATCH_NAME.test(scratchName)) {
    throw new Error(`SCRATCH_DATABASE_NAME_UNSAFE: ${JSON.stringify(scratchName)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Drop a scratch database after draining its backends. See the file header for why the ordering
 * (revoke → drain → drop) matters and why the return value is the deliverable.
 *
 * Never throws for the ordinary paths (absent database, backends that refuse to leave); an
 * unsafe identifier DOES throw, because that is a caller bug and silently proceeding would run
 * caller-shaped text as DDL.
 */
export async function dropScratchDatabase(
  adminPool: Pool,
  scratchName: string,
  options: { drainTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<ScratchDropOutcome> {
  assertSafeScratchDatabaseName(scratchName)
  const drainTimeoutMs = options.drainTimeoutMs ?? 10_000
  const pollIntervalMs = options.pollIntervalMs ?? 50
  const startedAt = Date.now()

  const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratchName])
  if (exists.rowCount === 0) {
    return { drained: true, forced: false, residualBackends: 0, drainMs: 0, residual: [] }
  }

  // (1) Revoke connect rights BEFORE counting, so a reconnecting pool cannot re-attach between
  // the count and the DROP. Without this the drain below is a TOCTOU check, not a guarantee.
  await adminPool.query(`ALTER DATABASE "${scratchName}" ALLOW_CONNECTIONS false`).catch(() => undefined)

  // (2) Wait for the backends that are already attached to finish and detach on their own.
  const countAttached = async (): Promise<number> => {
    const r = await adminPool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [scratchName],
    )
    return Number(r.rows[0]?.n ?? 0)
  }

  let attached = await countAttached()
  while (attached > 0 && Date.now() - startedAt < drainTimeoutMs) {
    await sleep(pollIntervalMs)
    attached = await countAttached()
  }

  if (attached === 0) {
    const drainMs = Date.now() - startedAt
    await adminPool.query(`DROP DATABASE IF EXISTS "${scratchName}"`).catch(() => undefined)
    return { drained: true, forced: false, residualBackends: 0, drainMs, residual: [] }
  }

  // (3) Deadline expired. Name the holders BEFORE terminating them — this is the only place the
  // identity of the component that keeps the connection open is observable.
  const residualRows = await adminPool
    .query<{ application_name: string | null; state: string | null; query: string | null }>(
      `SELECT application_name, state, left(query, 200) AS query
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [scratchName],
    )
    .catch(() => ({ rows: [] as Array<{ application_name: string | null; state: string | null; query: string | null }> }))
  const residual: ScratchResidualBackend[] = residualRows.rows.map((row) => ({
    applicationName: row.application_name ?? '',
    state: row.state ?? '',
    query: row.query ?? '',
  }))

  await adminPool
    .query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
      scratchName,
    ])
    .catch(() => undefined)
  await adminPool.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => undefined)

  return { drained: false, forced: true, residualBackends: residual.length || attached, drainMs: Date.now() - startedAt, residual }
}

/**
 * Values-free one-liner for the CI log. `CLEAN` is the claim; `FORCED` is the counter-evidence
 * that keeps #4791 open and names the holder. Emitted unconditionally by both call sites — a
 * line that only appears on failure cannot distinguish "drain worked" from "drain never ran".
 */
export function formatScratchDropOutcome(label: string, outcome: ScratchDropOutcome): string {
  if (!outcome.forced) return `scratchDrain=CLEAN suite=${label} drainMs=${outcome.drainMs}`
  const holders = outcome.residual
    .map((r) => `${r.applicationName || '<unnamed>'}:${r.state || '<nostate>'}:${r.query.replace(/\s+/g, ' ').slice(0, 120)}`)
    .join(' | ')
  return `scratchDrain=FORCED suite=${label} drainMs=${outcome.drainMs} residualBackends=${outcome.residualBackends} holders=[${holders}]`
}
