/**
 * Migration: `approval_comments` — Lock-10 (S2), D2(b1) MUTABLE comment storage.
 *
 * Ordering: sorts after `zzzz20260821100000_add_approval_instance_org_id.ts` (S1) and after
 * `zzzz20260821120000_recovery_authority_functions_fix_search_path.ts` (current tail at S2's
 * baseline `9fcccd69c3`). S2 does NOT read `approval_instances.org_id` directly — it reaches org
 * scoping only through the S1 predicate (`canReadApprovalInstance`) — so this ordering is a
 * hygiene requirement (a table cannot precede the table it FKs), not a correctness dependency on
 * S1's org column.
 *
 * Rulings baked into this DDL (each with its stated reason — see the S2 implementation contract):
 *
 *  - NO `org_id` column. The org fact is instance-level after S1 (`approval_instances.org_id`); a
 *    comment-level copy would be a second source of truth that can drift from the predicate's own
 *    source. Explicitly NOT the attendance anti-precedent
 *    (`zzzz20260114100000_add_attendance_org_id.ts`'s `org_id text NOT NULL DEFAULT 'default'`) —
 *    per Lock-10 §2.2(a), a comment-level org column would need `text NOT NULL` with NO default
 *    and a non-blank CHECK if a reviewer ever adds one; this migration adds none.
 *
 *  - `body` is NULLable and `approval_cmt_tombstone_body_cleared` is the MECHANICAL form of
 *    D2(b1) ("author retained, body cleared" on delete). `body text NOT NULL` with `body = ''` on
 *    delete would satisfy the prose while defeating the intent — the CHECK makes "a tombstone that
 *    still has a body" unrepresentable at the DB layer, not merely disallowed by a service branch.
 *
 *  - Fix-round (S2 gate P2-1): `approval_cmt_tombstone_mentions_cleared` is the SAME mechanical
 *    treatment applied to `mentions` — a tombstone with a non-empty `mentions` array is now
 *    equally unrepresentable at the DB layer. Named SEPARATELY from
 *    `approval_cmt_tombstone_body_cleared` (not folded in) so a constraint-violation error names
 *    which arm broke. Before this fix, deleting the service's `mentions = '[]'::jsonb,` UPDATE
 *    clause was undetected by any of the 45 gates — `toView` masks the field on every read path
 *    and the one DB re-read that SELECTs `mentions` (C-4/C-5,
 *    `tests/integration/approval-comments.db.test.ts`) never asserted on it. Both are now fixed:
 *    the CHECK enforces storage, the test asserts behavior.
 *
 *  - Real FK with `ON DELETE CASCADE`, UNLIKE `meta_comments`
 *    (`zzzz20260326134000_create_meta_comments.ts`), which has no FK at all — that was a
 *    deliberate application-layer-cascade choice for multitable comments. Approval satellites
 *    (`approval_reads`, `approval_attachments`) carry real FKs; this table follows that lineage,
 *    not `meta_comments`'s.
 *
 *  - One-level threading is enforced in the SERVICE (`approval-comment-service.ts`), not here — a
 *    self-referencing CHECK cannot see the PARENT row's own `parent_id`. `approval_cmt_no_self_parent`
 *    below is only the degenerate self-reference case, which IS representable in a CHECK.
 *
 *  - `mentions jsonb NOT NULL DEFAULT '[]'::jsonb` matches `meta_comments`'s shape; cleared to
 *    `'[]'` on tombstone alongside the body — a mention list is a values channel derived from the
 *    body, so clearing one without the other would leak stale mention data past a delete.
 *
 *  - id shape `` `acmt_${randomUUID()}` ``: a NAMING CHOICE, not a co-existence contract. The repo
 *    idiom for a text-PK comment id is `` `cmt_${randomUUID()}` `` (`CommentService.ts`); the
 *    distinguishable `acmt_` prefix exists for ONE stated reason — these ids travel inside
 *    `approval_records.metadata.commentId` and in FE payloads alongside multitable `cmt_` ids, so
 *    a mis-routed id becomes a visible bug (wrong prefix) rather than a silent lookup miss. This
 *    table is NOT shared with `meta_comments`; the "shared satellite" premise from the reuse study
 *    was a REJECTED arm, not what was decided.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_comments (
      id           text PRIMARY KEY,
      instance_id  text NOT NULL
                     CONSTRAINT approval_cmt_instance_fk
                     REFERENCES approval_instances(id) ON DELETE CASCADE,
      parent_id    text
                     CONSTRAINT approval_cmt_parent_fk
                     REFERENCES approval_comments(id) ON DELETE CASCADE,
      author_id    text NOT NULL
                     CONSTRAINT approval_cmt_author_nonblank CHECK (author_id ~ '[!-~]'),
      body         text,
      mentions     jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      edited_at    timestamptz,
      deleted_at   timestamptz,
      CONSTRAINT approval_cmt_tombstone_body_cleared
        CHECK ((deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL)),
      CONSTRAINT approval_cmt_tombstone_mentions_cleared
        CHECK ((deleted_at IS NULL) OR (deleted_at IS NOT NULL AND mentions = '[]'::jsonb)),
      CONSTRAINT approval_cmt_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_comments_instance_created
      ON approval_comments (instance_id, created_at)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_comments_parent
      ON approval_comments (parent_id) WHERE parent_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_comments_parent`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_approval_comments_instance_created`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_comments`.execute(db)
}
