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
 *
 * ## Fail-closed, and evidence-based (review #4799 P2-1)
 *
 * Every statement this helper issues is REQUIRED to succeed. An earlier revision wrapped the
 * `ALTER`, the plain `DROP` and the forced `DROP` in `.catch(() => undefined)` and then returned
 * `CLEAN`/`FORCED` anyway — so a DDL failure was reported as a terminal-clean teardown. There is
 * no swallowing left: any statement error becomes a `ScratchDropError` carrying the `step` that
 * failed, and it propagates. In particular there is deliberately NO "plain DROP failed, retry
 * with FORCE" fallback — that would make `CLEAN` vs `FORCED` unfalsifiable, which is the exact
 * ambiguity this helper exists to remove.
 *
 * And a terminal status is never assumed: before returning CLEAN or FORCED the helper re-queries
 * `pg_database` and requires the row to be GONE. `DROP DATABASE IF EXISTS` reports success when
 * it dropped nothing, so "the statement did not error" is not evidence that the database is
 * actually gone — only the read-back is.
 *
 * ## Values-free logging, by construction (review #4799 P2-2)
 *
 * An earlier revision selected `left(query, 200)` from `pg_stat_activity` and put that SQL text
 * into the log line that is documented as values-free. SQL text can embed row values (literals in
 * a statement), so that log could leak data. `query` is no longer selected AT ALL — it cannot be
 * logged because it is never read. What remains is closure status, connection counts, and closed
 * enum categories (`state`, `wait_event_type`) plus the connection-identity `application_name`,
 * which is a label our own call sites set — not SQL and not a row value. Every field that reaches
 * the log is passed through a positive charset whitelist and truncated, so the emitted line is
 * bounded by construction rather than by the good behaviour of its inputs.
 */

/**
 * The only capability this helper needs from its admin handle. Declared structurally (rather than
 * as `pg.Pool`) so a test can substitute a genuinely type-checked failure-injecting proxy without
 * an `as unknown as Pool` cast — an injection that has to be cast into place is an injection whose
 * shape nobody checked. A real `pg.Pool` satisfies this.
 */
export interface ScratchAdminQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

/** The statement being issued when a teardown failed. Closed set — safe to put in a log line. */
export type ScratchDropStep =
  | 'probe_exists'
  | 'revoke_connections'
  | 'count_attached'
  | 'inspect_residual'
  | 'terminate_backends'
  | 'drop_plain'
  | 'drop_forced'
  | 'confirm_absent'

export const SCRATCH_DROP_STEPS: readonly ScratchDropStep[] = [
  'probe_exists',
  'revoke_connections',
  'count_attached',
  'inspect_residual',
  'terminate_backends',
  'drop_plain',
  'drop_forced',
  'confirm_absent',
]

/**
 * Thrown for EVERY teardown failure. `step` is what makes the failure diagnosable without the
 * caller having to parse a driver message, and it is the only failure detail that reaches the
 * values-free log — the underlying driver message travels in `message`/`cause`, i.e. to the test
 * runner's failure output, never to the teardown log line.
 */
export class ScratchDropError extends Error {
  readonly step: ScratchDropStep
  readonly drainMs: number

  constructor(step: ScratchDropStep, detail: string, drainMs: number, options?: { cause?: unknown }) {
    super(`SCRATCH_DROP_FAILED step=${step} detail=${detail}`, options)
    this.name = 'ScratchDropError'
    this.step = step
    this.drainMs = drainMs
  }
}

/**
 * `pg_stat_activity.state`, mapped onto a closed snake_case enum. The raw values contain spaces
 * and parentheses (`idle in transaction (aborted)`), which would put unbounded-shaped text into a
 * log line whose grammar is asserted; the enum keeps the grammar decidable.
 */
export type ScratchBackendCategory =
  | 'active'
  | 'idle'
  | 'idle_in_transaction'
  | 'idle_in_transaction_aborted'
  | 'fastpath_function_call'
  | 'disabled'
  | 'unknown'

const BACKEND_CATEGORY_BY_PG_STATE: Readonly<Record<string, ScratchBackendCategory>> = {
  active: 'active',
  idle: 'idle',
  'idle in transaction': 'idle_in_transaction',
  'idle in transaction (aborted)': 'idle_in_transaction_aborted',
  'fastpath function call': 'fastpath_function_call',
  disabled: 'disabled',
}

export function categoriseBackendState(state: string | null | undefined): ScratchBackendCategory {
  if (typeof state !== 'string') return 'unknown'
  return BACKEND_CATEGORY_BY_PG_STATE[state] ?? 'unknown'
}

/** `pg_stat_activity.wait_event_type` domain in PG 15, plus the two out-of-band cases. */
const WAIT_EVENT_TYPES = new Set([
  'Activity',
  'BufferPin',
  'Client',
  'Extension',
  'IO',
  'IPC',
  'Lock',
  'LWLock',
  'Timeout',
])

export function categoriseWaitEventType(waitEventType: string | null | undefined): string {
  if (typeof waitEventType !== 'string' || waitEventType === '') return 'none'
  return WAIT_EVENT_TYPES.has(waitEventType) ? waitEventType : 'other'
}

/**
 * Positive charset whitelist for anything that reaches the log line. `/`, `|`, `[`, `]` and `=`
 * are the log's structural separators and are therefore NOT in the whitelist, so no field value
 * can forge structure. The complement of a whitelist is bounded; the complement of a denylist of
 * bad spellings is not.
 */
const LOG_TOKEN_ALLOWED = /[^A-Za-z0-9_.-]/g

function logToken(value: string | null | undefined, fallback: string, maxLength = 48): string {
  const raw = typeof value === 'string' ? value : ''
  const sanitised = raw.replace(LOG_TOKEN_ALLOWED, '_').slice(0, maxLength)
  return sanitised.length > 0 ? sanitised : fallback
}

export interface ScratchResidualBackend {
  /**
   * `pg_stat_activity.application_name` — a connection-identity label set by the connecting
   * component, which is why it survives into the log: it is the only channel that NAMES the
   * component still holding a connection. It is not SQL text and not a row value. It is
   * nevertheless charset-bounded at format time, because it is set by whoever connected.
   */
  applicationName: string
  /** Closed enum, from `pg_stat_activity.state`. */
  category: ScratchBackendCategory
  /** Closed enum, from `pg_stat_activity.wait_event_type`. */
  waitEventType: string
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

function messageOf(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string') return err.message
  return String(err)
}

/**
 * Run one teardown statement. NOTHING here swallows: a driver error is re-thrown as a
 * `ScratchDropError` naming the step. This function is the single choke point for that rule, so
 * "is any teardown statement still fail-open?" is answerable by reading the call sites below
 * rather than by auditing N independent `.catch()` clauses.
 */
async function step<R>(
  stepName: ScratchDropStep,
  startedAt: number,
  run: () => Promise<R>,
): Promise<R> {
  try {
    return await run()
  } catch (err) {
    throw new ScratchDropError(stepName, messageOf(err), Date.now() - startedAt, { cause: err })
  }
}

/**
 * Drop a scratch database after draining its backends. See the file header for why the ordering
 * (revoke → drain → drop) matters, why the return value is the deliverable, and why every step
 * fails closed.
 *
 * Throws `ScratchDropError` if any statement fails, or if the database is still present after the
 * drop. Returns only when the database is CONFIRMED gone. An unsafe identifier throws too — that
 * is a caller bug, and proceeding would run caller-shaped text as DDL.
 */
export async function dropScratchDatabase(
  adminPool: ScratchAdminQueryable,
  scratchName: string,
  options: { drainTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<ScratchDropOutcome> {
  assertSafeScratchDatabaseName(scratchName)
  const drainTimeoutMs = options.drainTimeoutMs ?? 10_000
  const pollIntervalMs = options.pollIntervalMs ?? 50
  const startedAt = Date.now()

  const stillPresent = async (stepName: ScratchDropStep): Promise<boolean> => {
    const res = await step(stepName, startedAt, () =>
      adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratchName]),
    )
    // `rows.length`, not `rowCount`: `rowCount` is nullable in the pg typings, and `=== 0` on a
    // null would report "absent" for a query that returned rows — a fail-OPEN read-back.
    return res.rows.length > 0
  }

  if (!(await stillPresent('probe_exists'))) {
    return { drained: true, forced: false, residualBackends: 0, drainMs: 0, residual: [] }
  }

  // (1) Revoke connect rights BEFORE counting, so a reconnecting pool cannot re-attach between
  // the count and the DROP. Without this the drain below is a TOCTOU check, not a guarantee.
  await step('revoke_connections', startedAt, () =>
    adminPool.query(`ALTER DATABASE "${scratchName}" ALLOW_CONNECTIONS false`),
  )

  // (2) Wait for the backends that are already attached to finish and detach on their own.
  const countAttached = async (): Promise<number> => {
    const res = await step('count_attached', startedAt, () =>
      adminPool.query(
        'SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [scratchName],
      ),
    )
    const row = res.rows[0] as { n?: string } | undefined
    return Number(row?.n ?? 0)
  }

  let attached = await countAttached()
  while (attached > 0 && Date.now() - startedAt < drainTimeoutMs) {
    await sleep(pollIntervalMs)
    attached = await countAttached()
  }

  if (attached === 0) {
    await step('drop_plain', startedAt, () => adminPool.query(`DROP DATABASE IF EXISTS "${scratchName}"`))
    // Read-back. `DROP DATABASE IF EXISTS` succeeds when it drops nothing, so a non-throwing
    // statement is NOT evidence the database is gone. CLEAN is only reported against evidence.
    if (await stillPresent('confirm_absent')) {
      throw new ScratchDropError(
        'confirm_absent',
        'database still present after plain DROP',
        Date.now() - startedAt,
      )
    }
    return { drained: true, forced: false, residualBackends: 0, drainMs: Date.now() - startedAt, residual: [] }
  }

  // (3) Deadline expired. Name the holders BEFORE terminating them — this is the only place the
  // identity of the component that keeps the connection open is observable. `query` is
  // deliberately NOT selected: it is SQL text, it can embed row values, and it would end up in a
  // log line documented as values-free (review #4799 P2-2).
  const residualRes = await step('inspect_residual', startedAt, () =>
    adminPool.query(
      `SELECT application_name, state, wait_event_type
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [scratchName],
    ),
  )
  const residual: ScratchResidualBackend[] = (
    residualRes.rows as Array<{
      application_name?: string | null
      state?: string | null
      wait_event_type?: string | null
    }>
  ).map((row) => ({
    applicationName: row.application_name ?? '',
    category: categoriseBackendState(row.state),
    waitEventType: categoriseWaitEventType(row.wait_event_type),
  }))

  await step('terminate_backends', startedAt, () =>
    adminPool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [scratchName],
    ),
  )
  await step('drop_forced', startedAt, () =>
    adminPool.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`),
  )
  if (await stillPresent('confirm_absent')) {
    throw new ScratchDropError('confirm_absent', 'database still present after forced DROP', Date.now() - startedAt)
  }

  return {
    drained: false,
    forced: true,
    residualBackends: residual.length || attached,
    drainMs: Date.now() - startedAt,
    residual,
  }
}

/**
 * Values-free one-liner for the CI log. `CLEAN` is the claim; `FORCED` is the counter-evidence
 * that keeps #4791 open and names the holder. Emitted unconditionally by both call sites — a
 * line that only appears on failure cannot distinguish "drain worked" from "drain never ran".
 *
 * Contains NO SQL text and NO row values: only the closure status, the drain duration, the
 * connection count, and per-holder `application_name` / state category / wait-event category —
 * every one of them charset-bounded by `logToken`.
 */
export function formatScratchDropOutcome(label: string, outcome: ScratchDropOutcome): string {
  const suite = logToken(label, 'unlabelled')
  const drainMs = Math.max(0, Math.trunc(outcome.drainMs))
  if (!outcome.forced) {
    return `scratchDrain=CLEAN suite=${suite} drainMs=${drainMs} residualBackends=0`
  }
  const holders = outcome.residual
    .map(
      (r) =>
        `${logToken(r.applicationName, 'unnamed')}/${logToken(r.category, 'unknown', 32)}/${logToken(
          r.waitEventType,
          'none',
          32,
        )}`,
    )
    .join('|')
  const count = Math.max(0, Math.trunc(outcome.residualBackends))
  return `scratchDrain=FORCED suite=${suite} drainMs=${drainMs} residualBackends=${count} holders=[${holders}]`
}

/**
 * The third status. Teardown now fails closed, so a caller that logs only CLEAN/FORCED would go
 * SILENT on exactly the case worth seeing. Call sites log this and then RE-THROW, which keeps the
 * "one line, unconditionally" property without converting a failure into a pass.
 *
 * Carries the `step` enum only — never the driver message, which can quote statement text.
 */
export function formatScratchDropFailure(label: string, err: unknown): string {
  const suite = logToken(label, 'unlabelled')
  const step = err instanceof ScratchDropError ? err.step : undefined
  const drainMs = err instanceof ScratchDropError ? Math.max(0, Math.trunc(err.drainMs)) : 0
  return `scratchDrain=FAILED suite=${suite} drainMs=${drainMs} step=${logToken(step, 'unknown', 32)}`
}
