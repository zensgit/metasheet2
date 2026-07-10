/**
 * 4c-3 — record-undelete inbound-edge replay (design-lock 2026-07-08, owner-ratified 2026-07-09,
 * semantics = Option A / fail-closed neighbour-consent).
 *
 * When a record R is deleted via `record-service.deleteRecord` with capture enabled, the edges that
 * OTHER records N point at R with (`meta_links` rows where `foreign_record_id = R`) are captured
 * into `meta_link_tombstones (reason='record_delete', source_revision_id = R's delete revision)` —
 * and then destroyed. Restore rebuilds R's row and its OUTBOUND edges from the trash snapshot, but
 * inbound edges lived in the NEIGHBOURS' cells; this module replays them from the tombstones.
 *
 * THE SIX PRECONDITIONS (design-lock §3 — all applied as SQL predicates, NEVER left to FK errors,
 * because a 23503 would roll back the whole restore):
 *   1. R alive           — by construction: callers run this AFTER the restore INSERT, same txn.
 *   2. N alive           — JOIN meta_records n ON n.id = t.record_id
 *   3. F still exists    — JOIN meta_fields f ON f.id = t.field_id  (field may be gone; FK cascade
 *                          already deleted such tombstones' target field — the JOIN stays load-
 *                          bearing for the window where the tombstone outlives the field row)
 *   4. F still a link    — f.type = 'link'      (retype is a bare UPDATE; row + FK survive)
 *   5. F not a mirror    — (f.property->>'mirrorOf') IS NULL  (spine invariant: a mirror never owns
 *                          a meta_links row — same skip the two outbound replays make structurally)
 *   6. Neighbour consent — (n.data->t.field_id) ? t.foreign_record_id  (Option A: only replay edges
 *                          N's OWN data still declares; a link the user removed inside the trash
 *                          window stays removed — replay is index CONVERGENCE, never new info)
 * plus the idempotency guard (meta_links has NO unique constraint on (field_id, record_id,
 * foreign_record_id) — the application layer is the only defence):
 *   7. NOT EXISTS an identical meta_links row (also kills the self-link double: a self-link is both
 *      outbound-replayed from the trash snapshot and inbound-captured; running AFTER the outbound
 *      replay, the guard sees the freshly inserted row and skips).
 *
 * ANCHOR QUERY SHAPE (design-lock §2): always `WHERE source_revision_id = $1 AND
 * reason = 'record_delete'` — NEVER filter by sheet_id (on record_delete rows it stores the DELETED
 * record's sheet while field_id/record_id belong to the NEIGHBOUR's sheet, routinely cross-sheet)
 * and NEVER by foreign_record_id (the anchor already scopes exactly one deletion's capture set).
 *
 * lock-exempt: record-undelete inbound edge replay — index convergence to the neighbour's own data;
 * no new information. (Design-lock §5: because of precondition 6, replay writes nothing N's data
 * does not already declare — no new access, no write to N.data, no revision for N.)
 */

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface InboundReplaySkips {
  /** N (the pointing record) no longer exists. */
  neighborGone: number
  /** F (the link field on N's sheet) was deleted inside the trash window. */
  fieldGone: number
  /** F still exists but was retyped away from 'link'. */
  fieldNotLink: number
  /** F is (now) the mirror side of a twoWay link — mirrors never own meta_links rows. */
  fieldMirror: number
  /** N's own data no longer lists R in F's cell (Option A: the user's removal wins). */
  neighborDeclined: number
  /** An identical edge already exists (incl. the self-link outbound-replay overlap). */
  alreadyPresent: number
}

export interface InboundReplayResult {
  /** Edges actually inserted. */
  replayed: number
  /** Tombstone rows for this anchor that were NOT replayed, by first failing precondition. */
  skipped: InboundReplaySkips
  /** Total tombstone rows found for the anchor (replayed + sum(skipped)). */
  total: number
}

export const EMPTY_INBOUND_REPLAY: InboundReplayResult = Object.freeze({
  replayed: 0,
  skipped: Object.freeze({
    neighborGone: 0,
    fieldGone: 0,
    fieldNotLink: 0,
    fieldMirror: 0,
    neighborDeclined: 0,
    alreadyPresent: 0,
  }) as InboundReplaySkips,
  total: 0,
})

/**
 * Replay one deletion's captured inbound edges. MUST run inside the caller's restore transaction,
 * strictly AFTER (a) the restored record row has been inserted into the records table and (b) the outbound-link
 * replay (guard 7 must see outbound rows). Never throws on a disqualified edge — each is skipped
 * individually and counted (design-lock C2: per-edge tolerance, not whole-restore failure).
 */
export async function replayInboundLinks(
  query: QueryFn,
  deleteRevisionId: string,
): Promise<InboundReplayResult> {
  // Diagnostic pass: classify every anchor row by its FIRST failing precondition. Kept in exact
  // predicate lockstep with the INSERT below — RB12 mutations red both if they drift.
  const diag = await query(
    `SELECT
       CASE
         WHEN n.id IS NULL THEN 'neighborGone'
         WHEN f.id IS NULL THEN 'fieldGone'
         WHEN f.type <> 'link' THEN 'fieldNotLink'
         WHEN (f.property->>'mirrorOf') IS NOT NULL THEN 'fieldMirror'
         WHEN NOT ((n.data -> t.field_id) ? t.foreign_record_id) THEN 'neighborDeclined'
         WHEN EXISTS (
           SELECT 1 FROM meta_links ml
            WHERE ml.field_id = t.field_id
              AND ml.record_id = t.record_id
              AND ml.foreign_record_id = t.foreign_record_id
         ) THEN 'alreadyPresent'
         ELSE 'replayable'
       END AS verdict,
       count(*)::int AS n
     FROM meta_link_tombstones t
     LEFT JOIN meta_records n ON n.id = t.record_id
     LEFT JOIN meta_fields f ON f.id = t.field_id
     WHERE t.source_revision_id = $1 AND t.reason = 'record_delete'
     GROUP BY 1`,
    [deleteRevisionId],
  )

  const skipped: InboundReplaySkips = {
    neighborGone: 0,
    fieldGone: 0,
    fieldNotLink: 0,
    fieldMirror: 0,
    neighborDeclined: 0,
    alreadyPresent: 0,
  }
  let replayable = 0
  for (const raw of diag.rows as Array<{ verdict: string; n: number }>) {
    if (raw.verdict === 'replayable') replayable = raw.n
    else if (raw.verdict in skipped) skipped[raw.verdict as keyof InboundReplaySkips] = raw.n
  }

  // The write: same anchor, all seven guards as INSERT predicates. `id` mirrors the outbound
  // replay's `lnk_<uuid>` shape ('lnk_' + 36 uuid chars = 40 ≤ its 50-char slice).
  const ins = await query(
    `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
     SELECT 'lnk_' || gen_random_uuid(), t.field_id, t.record_id, t.foreign_record_id
       FROM meta_link_tombstones t
       JOIN meta_records n ON n.id = t.record_id
       JOIN meta_fields f ON f.id = t.field_id
      WHERE t.source_revision_id = $1
        AND t.reason = 'record_delete'
        AND f.type = 'link'
        AND (f.property->>'mirrorOf') IS NULL
        AND (n.data -> t.field_id) ? t.foreign_record_id
        AND NOT EXISTS (
          SELECT 1 FROM meta_links ml
           WHERE ml.field_id = t.field_id
             AND ml.record_id = t.record_id
             AND ml.foreign_record_id = t.foreign_record_id
        )`,
    [deleteRevisionId],
  )

  const replayed = ins.rowCount ?? 0
  const total = replayed + Object.values(skipped).reduce((a, b) => a + b, 0)
  // Diagnostic/INSERT drift tripwire — HONEST SEMANTICS, not a correctness net (do not extend this to
  // "fix" the count; it is deliberately a same-day characterization, see NIT-1 in the absorption audit):
  // the diagnostic query above and the write below are two SEPARATE statements, each its own READ
  // COMMITTED snapshot. The caller's transaction only holds a row lock on the deleted record's OWN
  // trash row (serializing concurrent restores of THAT record) — it never locks the neighbour or field
  // rows this function reads. So a genuinely concurrent write to a neighbour's cell (or a field
  // retype/mirror flip) landing in the gap between the two statements can flip a row's classification:
  // the diagnostic counts it one way, the write — evaluating every precondition fresh, at its own later
  // instant — resolves it another way. `replayed` (this statement's actual row count) is always the
  // truth for what got written; when it disagrees with the diagnostic's `replayable` count, the
  // shortfall is folded into `alreadyPresent` as a catch-all "something changed between the two
  // statements" bucket — it is a best-effort label, not necessarily the row's real disqualifying
  // precondition. This can never cause a wrong WRITE (the write's own predicates are re-checked in that
  // same statement against the then-current data, so it can never insert a row a live precondition
  // disqualifies, and the NOT EXISTS guard still prevents any duplicate) — it only means the returned
  // `skipped` breakdown, and `total` (already computed above from the pre-fold skip counts, and not
  // recomputed after this adjustment), are advisory diagnostics in this narrow race window, not an
  // exact ledger of every tombstone row's fate.
  if (replayed !== replayable) {
    skipped.alreadyPresent += Math.max(0, replayable - replayed)
  }
  return { replayed, skipped, total }
}

/** C7 flag gate: default OFF — off means today's restore behavior byte-for-byte. */
export function isRecordUndeleteInboundEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND === 'true'
}
