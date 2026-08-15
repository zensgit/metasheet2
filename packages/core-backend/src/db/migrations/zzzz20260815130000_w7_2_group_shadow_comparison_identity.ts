import { sql, type Kysely } from 'kysely'

/**
 * W7-2 (#4556) — give the `group_shadow` comparison record its own identity,
 * WITHOUT touching `uq_arc_operation`.
 *
 * Authority: design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2 + §5 item 1; ratified per #4556 comments 5293034619 + 5293478713.
 *
 * HISTORY (recorded so the gate trail stays legible): an earlier revision of
 * THIS SAME unmerged branch shipped
 * `zzzz20260815130000_w7_2_group_shadow_operation_dedup_index.ts`, which split
 * `uq_arc_operation` into two marker-partitioned partial indexes. The
 * independent gate (PR #4923 review, 2026-08-15) REFUTED that design: the
 * added predicate is not implied by any caller's query, so every
 * operation-replay lookup on this table lost its index (EXPLAIN-proven
 * Seq Scan under FOR UPDATE on five enumerated write paths), and the GLOBAL
 * one-row-per-operation invariant a landed migration asserts in prose was
 * silently narrowed under a live unguarded consumer. That file never ran
 * anywhere but scratch databases and is REPLACED here in the same (unmerged)
 * branch — no historical (landed) migration is edited.
 *
 * THE FIX. A comparison record is NOT the result of its producing operation —
 * the operation's seal points at the SERVED calculation, and §7.3's "retries
 * return the existing calculation" is a claim about served results. So the
 * comparison record leaves the operation-id domain entirely:
 *
 *   - its `operation_id` column is NULL (the column means "the operation this
 *     calculation is the RESULT of"); the producing operation is carried in
 *     the writer-controlled `input_provenance -> 'w7GroupShadowCompare' ->>
 *     'operationId'` marker member — provenance, where a derived fact
 *     belongs, never a lying result pointer;
 *   - `uq_arc_operation` is BYTE-UNTOUCHED: every replay lookup keeps its
 *     exact index and plan (`operation_id = $n` can never match a NULL), and
 *     the global invariant — at most one calculation row per
 *     `(org_id, entrypoint, operation_id)` among operation-bearing rows — is
 *     restored in full;
 *   - comparison-record dedup ("one comparison per producing operation") gets
 *     its own ADDITIVE expression index below, which can only ever match
 *     marker rows (no pre-existing row carries the marker).
 *
 * WHAT THIS MIGRATION DOES CHANGE — [OWNER-CONFIRM, surfaced not buried]:
 * `chk_arc_operation_id` (zzzz20260725120000, comment: "operation_id is null
 * only for the internal legacy baseline") is REBUILT. The precise
 * disjunct-by-disjunct delta — the owner rules from this text (gate P3-F1
 * corrected an earlier wording here that called both original disjuncts
 * "verbatim", which was mechanically false for the second one):
 *
 *   D1 (original first disjunct) — VERBATIM:
 *       `calculation_kind = 'legacy_baseline' AND operation_id IS NULL`.
 *   D2 (original second disjunct) — original text PLUS one added
 *       marker-exclusion conjunct
 *       (`AND NOT (input_provenance ? 'w7GroupShadowCompare')`). The added
 *       conjunct is VACUOUS on every pre-existing row — provable, not
 *       assumed: no pre-existing row carries the marker (it is written only
 *       by the W7-2 comparison recorder this branch introduces), so
 *       `NOT (marker)` is true for all of them and D2 admits exactly the
 *       rows it admitted before. Its purpose is forward-looking: it makes
 *       D2 and D3 disjoint, so a marker-tagged row can never satisfy the
 *       operation-bearing disjunct and re-enter the `uq_arc_operation`
 *       domain.
 *   D3 (NEW) — the marker-gated comparison-record disjunct: `mode='shadow'`
 *       AND the marker present AND `operation_id IS NULL` (REQUIRED) AND a
 *       non-empty marker `operationId` (REQUIRED), so a comparison record
 *       can neither collide with the served row's dedup slot nor lose its
 *       provenance link.
 *
 * Net: every previously legal row remains legal (D1 verbatim; D2's narrowing
 * vacuous on all pre-existing rows), and one previously illegal shape (the
 * comparison record) becomes legal under D3 — but this amends a landed
 * constraint's stated invariant and therefore belongs in front of the owner
 * with this slice's ratify; it is named in the PR body as its own decision
 * point.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_record_calculations
      DROP CONSTRAINT IF EXISTS chk_arc_operation_id
  `.execute(db)
  await sql`
    ALTER TABLE attendance_record_calculations
      ADD CONSTRAINT chk_arc_operation_id CHECK (
        (calculation_kind = 'legacy_baseline' AND operation_id IS NULL) OR
        (
          mode = 'shadow'
          AND input_provenance ? 'w7GroupShadowCompare'
          AND operation_id IS NULL
          AND COALESCE(input_provenance -> 'w7GroupShadowCompare' ->> 'operationId', '') <> ''
        ) OR
        (
          calculation_kind <> 'legacy_baseline'
          AND NOT (input_provenance ? 'w7GroupShadowCompare')
          AND operation_id IS NOT NULL
        )
      )
  `.execute(db)
  // One comparison record per producing operation — the replay/dedup backstop
  // for the UNSERVED half, additive by construction (only marker rows match).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_w7_comparison_identity
    ON attendance_record_calculations (
      org_id,
      entrypoint,
      ((input_provenance -> 'w7GroupShadowCompare' ->> 'operationId'))
    )
    WHERE (input_provenance ? 'w7GroupShadowCompare')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_arc_w7_comparison_identity`.execute(db)
  await sql`
    ALTER TABLE attendance_record_calculations
      DROP CONSTRAINT IF EXISTS chk_arc_operation_id
  `.execute(db)
  // The original two-disjunct form (zzzz20260725120000 verbatim). Valid only
  // on a database that holds no marker-tagged comparison rows — a NULL
  // operation_id comparison row violates the restored second disjunct, which
  // is the honest signal that dual-run data exists and the down path is not
  // applicable, rather than something this migration papers over.
  await sql`
    ALTER TABLE attendance_record_calculations
      ADD CONSTRAINT chk_arc_operation_id CHECK (
        (calculation_kind = 'legacy_baseline' AND operation_id IS NULL) OR
        (calculation_kind <> 'legacy_baseline' AND operation_id IS NOT NULL)
      )
  `.execute(db)
}
