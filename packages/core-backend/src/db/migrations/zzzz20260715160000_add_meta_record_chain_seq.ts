import { sql, type Kysely } from 'kysely'

/**
 * W0-1 (v3.7 correction, owner-ratified #4331 §9 — see
 * docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-20260715.md §1.1/§9.7) — the
 * chain-integrity core's shared causal `seq` domain.
 *
 * WHY: the landed #4269 chain-order comparator (`chainOrderAfter` in `history-integrity-precheck.ts`)
 * orders events by `(created_at epoch-ms, version, delete-last)` — `created_at` is txn-start so same-ms
 * events collide, and neither `version` (resets per generation) nor row `id` (random uuid) can disambiguate
 * true causal order across the two tables. A single monotonic sequence, allocated at write time and shared
 * by both `meta_record_revisions` and `meta_record_version_markers`, gives an exact total order for the
 * generation-aware precheck behind `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (default OFF — this migration
 * changes schema only, no runtime behavior; see §9.7 "Ratification authorizes default-off implementation
 * slices only").
 *
 * ALSO (v3.7 §9.3 / owner-ruled "loud marker"): drops the cross-generation
 * `UNIQUE (sheet_id, record_id, version)` on `meta_record_version_markers`. A resurrected record resets
 * `version` to 1; a new generation's lock/unlock at a version the FIRST generation also marked would
 * otherwise collide against that constraint, and the marker INSERT's (pre-existing) `ON CONFLICT ... DO
 * NOTHING` would silently SWALLOW the new marker — the lock/unlock itself succeeds while its marker
 * vanishes, and the strict contiguity walk then sees an unexplained hole in the new generation (a false
 * refusal of a healthy record). Dup-detection moves into the per-generation (seq-ordered) occupancy walk
 * instead (`chain_corrupt` — a TRUE within-generation duplicate, distinct from the legacy
 * `duplicate_version_event`, which stays on the byte-identical flag-off path). `record-history-service.ts`
 * `recordVersionMarker` removes the `ON CONFLICT DO NOTHING` in the SAME PR so a genuine write conflict now
 * fails the enclosing lock/unlock transaction loudly instead of swallowing silently.
 *
 * Migration shape (safe on a populated table): add the column NULLABLE first, backfill deterministically,
 * THEN attach the `nextval` default + `NOT NULL` — never add a column with a volatile (`nextval()`) default
 * directly, which would force an uncontrolled full-table rewrite ordered by physical row order instead of
 * the intended `(created_at, version, id)` backfill order.
 *
 * Backfill semantics (v3.7 §9.3 scope item 1 — verbatim): `row_number() OVER (ORDER BY created_at, version,
 * id)` PER TABLE — revisions and markers each get their own dense 1..N run. This is DISPLAY/ORDER
 * ASSISTANCE ONLY for legacy (pre-this-migration) rows, NEVER A TRUST SIGNAL: the two tables' backfilled seq
 * ranges legitimately overlap (both start at 1), so a legacy revision and a legacy marker can share a seq
 * value, and backfilled order is only as reliable as the `created_at`/`version` it derives from. Any
 * "prospectively causal on landing" claim from the superseded v3.5 draft (#4309) is WITHDRAWN here per the
 * v3.7 P2-A/P2-B correction: real causality requires L4 (all-writer fence, so seq is allocated
 * post-fence-acquisition on every writer) and an L5 trusted-since checkpoint that cuts off pre-fence/
 * backfilled history — BOTH deferred, later lanes. Going FORWARD (every row inserted after this migration),
 * `seq` is allocated from the ONE shared `meta_record_chain_seq` sequence at INSERT time via each table's
 * `DEFAULT nextval(...)`, so new revisions and new markers interleave in one exact total order — necessary,
 * but on its own (pre-L4/L5) NOT SUFFICIENT for destructive trust; see the design lock.
 *
 * The one-time `setval` below is a MIGRATION-TIME bootstrap sync (advancing the shared sequence past every
 * backfilled value so no future `nextval()` collides with a legacy row's backfilled number) — NOT a test
 * mutating a shared real-DB sequence. Goldens must NEVER call `setval` on this sequence (v3.7 P2-C); they
 * insert explicit synthetic seq literals into isolated fixture rows instead (see
 * `multitable-history-contiguity-strict-seq-realdb.test.ts`).
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

  // Advance the shared sequence PAST every backfilled value (both tables) so every FUTURE nextval() (used
  // by both tables' DEFAULT below) is guaranteed greater than any legacy backfilled seq — new writes always
  // causally sort after all pre-migration history. Skipped on a fresh/empty DB (nothing backfilled, GREATEST
  // is 0, and 0 is below the sequence's own MINVALUE for an is_called=true setval).
  await sql`
    DO $$
    DECLARE max_seq bigint;
    BEGIN
      SELECT GREATEST(
        COALESCE((SELECT MAX(seq) FROM meta_record_revisions), 0),
        COALESCE((SELECT MAX(seq) FROM meta_record_version_markers), 0)
      ) INTO max_seq;
      IF max_seq > 0 THEN
        PERFORM setval('meta_record_chain_seq', max_seq, true);
      END IF;
    END $$;
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

  // v3.7 §9.3 scope item 1 / owner "loud marker": drop the cross-generation UNIQUE that silently swallowed
  // a resurrected generation's marker (see the module doc comment above).
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
