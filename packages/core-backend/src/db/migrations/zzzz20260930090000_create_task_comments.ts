/**
 * M3 (P0-B) task_comments — one-level, no threading, no `resolved`, no `mentions`.
 * Draft migration: do not apply from this PR, do not run against a shared DB.
 *
 * Shape follows `zzzz20260822120000_create_approval_comments.ts` per contract
 * (`docs/development/task-m3-backend-design-20260928.md` §4), amended by the
 * PR #6126 second-round review (「闸方对 M3 接口契约的第二轮意见」, P2 item 2):
 * `id` is `generateTaskDomainId('comment', …)` (`tcmt_…`) and carries the same
 * four-conjunct CHECK as `tasks.id` / `task_events.id` in the P0-A migration
 * (`zzzz20260926120000_create_task_p0a_tables.ts`), not the looser
 * `approval_comments`-style single-conjunct check. `author_id` uses the P0-A
 * single-conjunct printable CHECK (`^[!-~]+$`), matching `tasks.created_by` /
 * `task_events.actor_id` — NOT `approval_comments.author_id`'s unanchored
 * `~ '[!-~]'` (that form only requires one printable character anywhere in
 * the string).
 *
 * No `org_id` column (lock §4.3: `task_comments` does not carry org; scoped
 * through the parent task). No `resolved`, no `mentions`, no `parent_id`
 * (P0-B is flat, one-level; threading is out of scope, contract §1).
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE task_comments (
      id text PRIMARY KEY,
      task_id text NOT NULL,
      author_id text NOT NULL,
      body text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      edited_at timestamptz,
      deleted_at timestamptz,
      CONSTRAINT task_comments_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_comments_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
      CONSTRAINT task_comments_author_printable_chk CHECK (author_id ~ '^[!-~]+$'),
      CONSTRAINT task_comments_tombstone_body_cleared_chk CHECK (
        (deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL)
      )
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_tcmt_task_time ON task_comments (task_id, created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_tcmt_task_time`.execute(db)
  await sql`DROP TABLE IF EXISTS task_comments`.execute(db)
}
