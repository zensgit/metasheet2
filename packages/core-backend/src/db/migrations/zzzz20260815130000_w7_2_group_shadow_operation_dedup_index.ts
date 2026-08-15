import { sql, type Kysely } from 'kysely'

/**
 * W7-2 (#4556) — split the per-operation calculation dedup index into two
 * partitions so the `group_shadow` dual-run can record its comparison row.
 *
 * Authority: design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2 (`group_shadow`: "Alongside it, the W7 resolver produces a
 * group-derived frozen context and a shadow calculation, recorded through the
 * existing shadow machinery"); ratified per #4556 comments 5293034619 +
 * 5293478713.
 *
 * WHY. `uq_arc_operation` (zzzz20260725120000, "Retries return the existing
 * calculation and cannot allocate another version") is UNIQUE over
 * `(org_id, entrypoint, operation_id)`. Under `group_shadow` ONE producing
 * operation legitimately yields TWO rows: the served-path row (authoritative
 * or W4 shadow) and the W7 group-comparison row — same org, same entrypoint,
 * same operation. A single-partition unique index makes the second INSERT a
 * constraint violation, so the dual-run cannot be recorded at all.
 *
 * WHAT. The index is REBUILT (in this new zzzz migration — the historical
 * migration is not edited) as two partial unique indexes partitioned on the
 * writer-controlled `input_provenance` marker `w7GroupShadowCompare`, which
 * ONLY the boundary's W7-2 comparison recorder writes:
 *
 *   - `uq_arc_operation` — every row WITHOUT the marker. Byte-for-byte the
 *     old dedup domain for every pre-W7-2 row (no existing row carries the
 *     marker), so the retry-dedup contract is unchanged for the served path.
 *   - `uq_arc_operation_w7_group_shadow` — rows WITH the marker: at most ONE
 *     W7 comparison record per producing operation, so a replayed operation
 *     cannot double-record its comparison either.
 *
 * WHY NOT the `context_snapshot ->> 'selector'` discriminator here: the W7
 * GROUP-RESOLUTION FAIL-CLOSE record (design lock §5 item 1) has
 * `context_snapshot IS NULL` — no group context exists to persist — so a
 * selector-partitioned index would put it back into the served partition and
 * re-create the very collision this migration removes. The selector remains
 * the COUNTERS' compare-row discriminator (`w7-compare-window-status.ts`);
 * the provenance marker is the DEDUP partition key. Two discriminators, two
 * jobs.
 *
 * This is an INDEX change only — no column, no CHECK domain, no tier value
 * (per §3.2 of the W7-2 brief and OD-W7-6(a): group policy is frozen INTO the
 * context; no second snapshot shape).
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_arc_operation`.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_operation
    ON attendance_record_calculations (org_id, entrypoint, operation_id)
    WHERE operation_id IS NOT NULL AND NOT (input_provenance ? 'w7GroupShadowCompare')
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_operation_w7_group_shadow
    ON attendance_record_calculations (org_id, entrypoint, operation_id)
    WHERE operation_id IS NOT NULL AND (input_provenance ? 'w7GroupShadowCompare')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restoring the single-partition index fails if W7 comparison rows exist for
  // operations that also carry a served row — which is exactly the point: the
  // down path is only valid on a database that has not recorded dual-run rows.
  await sql`DROP INDEX IF EXISTS uq_arc_operation_w7_group_shadow`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_arc_operation`.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_operation
    ON attendance_record_calculations (org_id, entrypoint, operation_id)
    WHERE operation_id IS NOT NULL
  `.execute(db)
}
