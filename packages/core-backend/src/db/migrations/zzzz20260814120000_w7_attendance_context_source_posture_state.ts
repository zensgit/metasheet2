import { sql, type Kysely } from 'kysely'

/**
 * W7-1a (#4556) STEP 0 — OD-W7-3(a) context-source posture-state table.
 *
 * Authority: `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2 (two-part posture read), §7 OD-W7-3(a), red line W7-R4; ratified per
 * #4556 comments 5293034619 (ruling) + 5293478713 (owner first-person confirmation),
 * ruling 2 (OD-W7-1..8 = option (a)).
 *
 * This is a SECOND, independent org-keyed posture — a sibling of the W4
 * segment-calculation rollout machine (`attendance_calculation_rollout_state`,
 * `zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:993`),
 * NOT a reuse of it. The W4 machine's meaning ("is segment calculation
 * authoritative") stays untouched (OD-W7-3 consequence note).
 *
 * SHIPS EMPTY, and W7-1a inserts no row anywhere. The two-part read contract
 * (§4.2) resolves an org with no row to `off`, so an empty table means every
 * org resolves to `off` — this is one of the three independent legs W7-1a's
 * structural inertness rests on (the others: zero production import sites for
 * the resolver, and no default allowlist entry for the W7-specific env var).
 *
 * Deliberately MINIMAL — this is the read side only. The transition writer's
 * machinery (append-only event table, version/prior_state columns, the
 * legal-matrix trigger backstop, evidence manifest) is W7-R4 write-side work
 * that lands with the transition-boundary slice, not here. Adding those
 * columns now would be unexercised surface on a table nothing writes to.
 *
 * Provenance value-domain widening (`projectionOwner` gaining `w4_group`,
 * trace `source.kind` gaining `group_policy_snapshot`) is explicitly NOT part
 * of this migration: it is the separate inert slice W7-1a-M (ratification
 * comments 5293034619 + 5293478713, execution-order clause). Per the
 * zzzz-ordering trap,
 * any new value on a zzzz table must itself arrive in a zzzz migration — this
 * file is zzzz-keyed so later additions to this table can be too.
 */

/** Mirrors `ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1`
 *  (`packages/core-backend/src/attendance/w7-context-source-posture-contract.ts:28`).
 *  The TS constant and this CHECK are pinned to each other by the STEP 0 legs
 *  in `tests/integration/attendance-w7-1a-resolver.db.test.ts`, which read
 *  `pg_get_constraintdef` and compare it against the imported TS constant
 *  rather than re-spelling the list, so a one-sided edit reds. Those legs also
 *  prove the CHECKs REJECT out-of-union values (a constraint definition is not
 *  behaviour) and replay this migration down/up without drift. */
const CONTEXT_SOURCE_STATES = [
  'off',
  'group_shadow',
  'group_eligible',
  'group_authoritative',
  'suspended',
] as const

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_calculation_context_source_state (
      org_id text PRIMARY KEY,
      state text NOT NULL,
      scope text NOT NULL DEFAULT 'synthetic_staging',
      CONSTRAINT chk_accss_state CHECK (state IN (${sql.raw(sqlList(CONTEXT_SOURCE_STATES))})),
      CONSTRAINT chk_accss_scope CHECK (scope = 'synthetic_staging')
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS attendance_calculation_context_source_state`.execute(db)
}
