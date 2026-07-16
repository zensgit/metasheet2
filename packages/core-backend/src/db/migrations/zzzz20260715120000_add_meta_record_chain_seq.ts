import { sql, type Kysely } from 'kysely'

/**
 * W0-1 v3.5 (design lock #4262, §2) — ONE causal `seq` domain shared by revisions AND markers.
 *
 * WHY: the landed #4269 chain-order comparator (`chainOrderAfter` in `history-integrity-precheck.ts`)
 * orders events by `(created_at epoch-ms, version, delete-last)` — `created_at` is txn-start so same-ms
 * events collide, and neither `version` (resets per generation) nor row `id` (random uuid) can disambiguate
 * TRUE causal order across the two tables. A single monotonic sequence, allocated at write time and shared
 * by both `meta_record_revisions` and `meta_record_version_markers`, gives an exact total order that the
 * strict (`MULTITABLE_HISTORY_CONTIGUITY_STRICT`) generation-aware precheck can rely on for C2 (time-anchor
 * monotonicity) without any float/packing tricks.
 *
 * ALSO (§1 P1-1): drops the cross-generation `UNIQUE (sheet_id, record_id, version)` on
 * `meta_record_version_markers`. A resurrected record resets `version` to 1; a new generation's lock/unlock
 * at a version the FIRST generation also marked would otherwise collide against that constraint, and the
 * marker INSERT's (pre-existing) `ON CONFLICT ... DO NOTHING` would silently SWALLOW the new marker — the
 * lock/unlock itself succeeds while its marker vanishes, and the contiguity walk then sees an unexplained
 * hole in the new generation (a false refusal of a healthy record). Dup-detection moves into the
 * per-generation (seq-ordered) walk instead (`chain_corrupt` — a TRUE within-generation duplicate). Step 2
 * of this lane (`record-history-service.ts` `recordVersionMarker`) removes the `ON CONFLICT DO NOTHING` so a
 * genuine write conflict fails the enclosing lock/unlock transaction loudly instead of swallowing silently.
 *
 * Migration shape (safe on a populated table): add the column NULLABLE first, backfill deterministically,
 * THEN attach the `nextval` default + `NOT NULL` — never add a column with a volatile (`nextval()`) default
 * directly, which would force an uncontrolled full-table rewrite ordered by physical row order instead of
 * the intended `(created_at, version, id)` backfill order.
 *
 * Backfill semantics (owner-directed, design lock §2/§9-5): `row_number() OVER (ORDER BY created_at,
 * version, id)` PER TABLE — revisions and markers each get their own dense 1..N run. This is ordering-for-
 * DISPLAY only for legacy (pre-this-migration) rows, NOT a trust boundary: the two tables' backfilled seq
 * ranges legitimately overlap (both start at 1), so a legacy revision and a legacy marker can share a seq
 * value. This is fine BECAUSE the durable trusted-since checkpoint (design lock §6, C6) is what actually
 * grandfathers pre-checkpoint history into "trustworthy" — that checkpoint mechanism is explicitly DEFERRED
 * (this lane ships §2/§4/C2 only), so strict mode is not yet meant to be flipped on over a mature, populated
 * environment; it is default-OFF everywhere. Going FORWARD (every row inserted after this migration), `seq`
 * is allocated from the ONE shared `meta_record_chain_seq` sequence at INSERT time, so new revisions and new
 * markers interleave in true causal order with no collisions — the seq domain is trustworthy prospectively
 * from the moment this migration lands, which is exactly what the strict precheck's C2/C3 need.
 *
 * zzzz-timestamped ([[feedback_migration_zzzz_ordering]]): touches `meta_record_revisions` /
 * `meta_record_version_markers`, both created in zzzz migrations. Proven on a FRESH-DB full migrate.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE IF NOT EXISTS meta_record_chain_seq`.execute(db)

  // ---- meta_record_revisions: add nullable, backfill, then attach default + NOT NULL --------------------
  await sql`ALTER TABLE meta_record_revisions ADD COLUMN IF NOT EXISTS seq bigint`.execute(db)
  await sql`
    UPDATE meta_record_revisions r
    SET seq = backfill.rn
    FROM (
      SELECT id, row_number() OVER (ORDER BY created_at, version, id) AS rn
      FROM meta_record_revisions
    ) AS backfill
    WHERE r.id = backfill.id AND r.seq IS NULL
  `.execute(db)

  // ---- meta_record_version_markers: same shape ------------------------------------------------------------
  await sql`ALTER TABLE meta_record_version_markers ADD COLUMN IF NOT EXISTS seq bigint`.execute(db)
  await sql`
    UPDATE meta_record_version_markers m
    SET seq = backfill.rn
    FROM (
      SELECT id, row_number() OVER (ORDER BY created_at, version, id) AS rn
      FROM meta_record_version_markers
    ) AS backfill
    WHERE m.id = backfill.id AND m.seq IS NULL
  `.execute(db)

  // Advance the shared sequence PAST every backfilled value (both tables) so that every FUTURE nextval()
  // (used by both tables' DEFAULT below) is guaranteed greater than any legacy backfilled seq — i.e. every
  // new write causally sorts after all pre-migration history, which is the only ordering guarantee the
  // backfill needs to provide.
  await sql`
    SELECT setval(
      'meta_record_chain_seq',
      GREATEST(
        COALESCE((SELECT MAX(seq) FROM meta_record_revisions), 0),
        COALESCE((SELECT MAX(seq) FROM meta_record_version_markers), 0)
      ) + 1,
      false
    )
  `.execute(db)

  await sql`ALTER TABLE meta_record_revisions ALTER COLUMN seq SET DEFAULT nextval('meta_record_chain_seq')`.execute(db)
  await sql`ALTER TABLE meta_record_revisions ALTER COLUMN seq SET NOT NULL`.execute(db)
  await sql`ALTER TABLE meta_record_version_markers ALTER COLUMN seq SET DEFAULT nextval('meta_record_chain_seq')`.execute(db)
  await sql`ALTER TABLE meta_record_version_markers ALTER COLUMN seq SET NOT NULL`.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_sheet_record_seq
    ON meta_record_revisions(sheet_id, record_id, seq)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_version_markers_sheet_record_seq
    ON meta_record_version_markers(sheet_id, record_id, seq)
  `.execute(db)

  // §1 P1-1: drop the cross-generation UNIQUE that silently swallowed a resurrected generation's marker.
  await sql`
    ALTER TABLE meta_record_version_markers
    DROP CONSTRAINT IF EXISTS uq_meta_record_version_markers_sheet_record_version
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Best-effort restore of the dropped constraint — will fail if any cross-generation duplicate marker was
  // written while it was absent (expected: this migration's whole point is to allow that shape going
  // forward). Not wrapped in a guard: a failing `down()` here is a correct signal that forward-only data
  // now exists and this migration cannot be cleanly reversed.
  await sql`
    ALTER TABLE meta_record_version_markers
    ADD CONSTRAINT uq_meta_record_version_markers_sheet_record_version UNIQUE (sheet_id, record_id, version)
  `.execute(db)

  await sql`DROP INDEX IF EXISTS idx_meta_record_version_markers_sheet_record_seq`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_record_revisions_sheet_record_seq`.execute(db)

  await sql`ALTER TABLE meta_record_version_markers DROP COLUMN IF EXISTS seq`.execute(db)
  await sql`ALTER TABLE meta_record_revisions DROP COLUMN IF EXISTS seq`.execute(db)

  await sql`DROP SEQUENCE IF EXISTS meta_record_chain_seq`.execute(db)
}
