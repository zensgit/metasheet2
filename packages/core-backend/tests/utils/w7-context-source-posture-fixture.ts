/**
 * THE one legal way for a test to put an org's W7 context-source posture into a
 * chosen state.
 *
 * WHY THIS EXISTS (#4556 W7-3, landing-gate P1-1). W7-3's migration
 * (`zzzz20260816120000_w7_context_source_transition_writer.ts`) changed what the
 * posture table accepts, in two ways that a bare fixture INSERT cannot satisfy:
 *
 *  1. `version` / `engine_version` / `reason_code` / `actor_id` are NOT NULL
 *     with their transient defaults dropped, so `(org_id, state, scope)` fails
 *     `23502`;
 *  2. `trg_accss_state_guard` is a BEFORE-ROW trigger whose INSERT branch
 *     accepts ONLY the two bootstrap shapes — `('off', prior NULL)` and
 *     `('group_shadow', prior 'off')` — so an arbitrary-state insert fails
 *     `P0001` BEFORE the NOT NULL check is even reached.
 *
 * Six landed suites seeded that table with the bare three-column shape. W7-3
 * adapted its own file and could not adapt the other five, because four of them
 * did not exist on the branch — they arrived from main as clean additions, so
 * git had nothing to conflict on. The result was six red real-DB suites at the
 * merge, with 29 legs never running.
 *
 * ONE helper rather than six repaired copies, deliberately: six hand-rolled
 * full-column INSERTs (or six copies of the ladder walk) would be exactly the
 * two-hand-maintained-copies trap W7-3's own migration header warns about, and
 * the next schema change would have to find all six again.
 *
 * WHAT IT DOES NOT DO: it never drops or disables the trigger. Running
 * W7-1b/W7-2's evidence against a schema production does not ship would be
 * green-by-neutering. (W7-1a's three HARD-THROW legs legitimately drop it —
 * they deliberately construct rows the schema forbids and are about the
 * RESOLVER's fail-closed behaviour, not about seeding. That is a different job
 * and stays where it is.)
 *
 * HOW EACH STATE IS REACHED — every row is one the production writer could
 * itself have produced:
 *
 *   off                  bootstrap INSERT, version 1, prior_state NULL
 *   group_shadow         bootstrap, then one legal UPDATE
 *   group_eligible       ... then another
 *   group_authoritative  ... then another
 *   suspended            ... then another
 *
 * The path is DERIVED by breadth-first search over the ratified constant
 * `ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1`, never
 * hand-written: a pair removed from that constant makes the walk unreachable
 * and throws here, instead of silently taking a stale route.
 */
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
  type AttendanceW7ContextSourcePostureStateV1,
} from '../../src/attendance/w7-context-source-posture-contract'

export const ATTENDANCE_W7_POSTURE_TABLE_V1 = 'attendance_calculation_context_source_state'

/** Minimal shape of the `pg` pool/client surface these fixtures need. */
export interface W7PostureFixtureQueryableV1 {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * The legal ladder path from `off` to `target`, derived from the RATIFIED
 * transition constant. Exported so a suite that wants to assert the walk itself
 * can, and so there is exactly one implementation of it in the tree.
 */
export function attendanceW7LegalLadderPathToV1(
  target: string,
): AttendanceW7ContextSourcePostureStateV1[] {
  if (target === 'off') return []
  const queue: Array<{ state: string; path: AttendanceW7ContextSourcePostureStateV1[] }> = [
    { state: 'off', path: [] },
  ]
  const seen = new Set<string>(['off'])
  while (queue.length > 0) {
    const head = queue.shift() as { state: string; path: AttendanceW7ContextSourcePostureStateV1[] }
    if (head.state === target) return head.path
    for (const [from, to] of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1) {
      if (from !== head.state || seen.has(to)) continue
      seen.add(to)
      queue.push({ state: to, path: [...head.path, to] })
    }
  }
  throw new Error(
    `w7 posture fixture: no legal ladder path to '${target}' in ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1`,
  )
}

/**
 * Seeds `orgId` at `state`, replacing any existing row.
 *
 * DELETE-then-bootstrap-then-walk rather than "walk from wherever it is": the
 * ladder is deliberately NOT strongly connected (OD-W7-4(a) leaves
 * `group_authoritative` with `suspended` as its only exit, and nothing returns
 * to `group_eligible`), so a general current -> target walk is not always
 * possible and a fixture that tried would fail on legitimate state pairs.
 * Deleting is safe and honest here: the state table carries no append-only
 * trigger (only the EVENT table does), and the row this rebuilds is
 * byte-equivalent to what the writer would have produced, including the
 * `prior_state` chain and the resulting `version`.
 *
 * `orgId` is lower-cased to match the canonical org-key spelling the resolver
 * and writer use.
 */
export async function seedAttendanceW7ContextSourcePostureV1(
  db: W7PostureFixtureQueryableV1,
  orgId: string,
  state: string,
  options: Readonly<{ scope?: string; actorId?: string; engineVersion?: string }> = {},
): Promise<void> {
  // Takes a plain `string` and validates it HERE rather than a branded type the
  // six call sites would each have to import and cast to. A cast at every call
  // site is six chances to cast a typo; one validation is none. Fail-closed on
  // an unknown state — a fixture that silently seeded nothing would make every
  // downstream leg vacuous.
  if (!(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1 as readonly string[]).includes(state)) {
    throw new Error(
      `w7 posture fixture: '${state}' is not a W7 context-source posture state ` +
        `(${ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1.join(', ')})`,
    )
  }
  const org = orgId.toLowerCase()
  const scope = options.scope ?? 'synthetic_staging'
  const actorId = options.actorId ?? 'w7-posture-fixture'
  const engineVersion = options.engineVersion ?? 'w7-posture-fixture'

  await db.query(`DELETE FROM ${ATTENDANCE_W7_POSTURE_TABLE_V1} WHERE org_id = $1`, [org])
  await db.query(
    `INSERT INTO ${ATTENDANCE_W7_POSTURE_TABLE_V1}
       (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
     VALUES ($1, 'off', $2, 1, NULL, $3, 'context_source_transition', $4)`,
    [org, scope, engineVersion, actorId],
  )
  for (const step of attendanceW7LegalLadderPathToV1(state)) {
    await db.query(
      `UPDATE ${ATTENDANCE_W7_POSTURE_TABLE_V1}
          SET state = $2, prior_state = state, version = version + 1,
              engine_version = $3, reason_code = 'context_source_transition', actor_id = $4,
              changed_at = now()
        WHERE org_id = $1`,
      [org, step, engineVersion, actorId],
    )
  }

  // The walk must have LANDED. An unasserted seed lets every leg downstream run
  // against whatever state the row happened to stop at — the difference between
  // a fixture and a decoration.
  const landed = await db.query(
    `SELECT state FROM ${ATTENDANCE_W7_POSTURE_TABLE_V1} WHERE org_id = $1`,
    [org],
  )
  const actual = landed.rows[0]?.state
  if (actual !== state) {
    throw new Error(`w7 posture fixture: expected '${state}' for ${org}, landed on '${String(actual)}'`)
  }
}

/** Removes any posture row for `orgId`. Convenience for suite teardown. */
export async function clearAttendanceW7ContextSourcePostureV1(
  db: W7PostureFixtureQueryableV1,
  orgId: string,
): Promise<void> {
  await db.query(`DELETE FROM ${ATTENDANCE_W7_POSTURE_TABLE_V1} WHERE org_id = $1`, [
    orgId.toLowerCase(),
  ])
}
