/**
 * P0-A task tables. Draft migration: do not apply from this PR.
 *
 * Tables: tasks, task_assignees, task_followers, task_events.
 * Checks and indexes follow task-feature-design-lock-20260917.md §4.1 / §4.2
 * and plan v5 §2.1–§2.3. Indexes that belong to later tables
 * (task_list_items, task_comments, outbox) are not created here.
 *
 * Generated ids use the four-conjunct printable check. org_id / created_by /
 * user_id / actor_id / assigned_by use only the single printable check.
 * `task_events.id` is a `tev_…` id from `generateTaskDomainId('event', …)`
 * (owner 2026-09-26). This migration does not insert rows.
 */
import { sql, type Kysely } from 'kysely'

const TASK_EVENT_TYPES = [
  'created',
  'title_changed',
  'description_changed',
  'due_changed',
  'start_changed',
  'remind_changed',
  'assignee_added',
  'assignee_removed',
  'follower_added',
  'follower_removed',
  'completion_mode_changed',
  'self_completed',
  'self_reopened',
  'completed',
  'completed_by_any',
  'reopened',
  'deleted',
  'left',
  'parent_set',
  'parent_cleared',
  'commented',
  'attachment_added',
  'attachment_removed',
  'field_value_changed',
  'list_added',
  'list_removed',
  'group_changed',
  'milestone_set',
  'milestone_cleared',
  'dependency_added',
  'dependency_removed',
  'recurrence_set',
  'recurrence_cleared',
  'recurrence_spawned',
] as const

const eventTypeList = sql.join(TASK_EVENT_TYPES.map((t) => sql.lit(t)))

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE tasks (
      id text PRIMARY KEY,
      org_id text NOT NULL,
      title text NOT NULL,
      description text,
      status text NOT NULL DEFAULT 'open',
      start_date date,
      start_time time,
      due_date date,
      due_time time,
      time_zone text,
      due_at timestamptz,
      completion_mode text NOT NULL DEFAULT 'all',
      parent_id text,
      depth integer NOT NULL DEFAULT 0,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      deleted_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT tasks_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT tasks_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT tasks_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
      CONSTRAINT tasks_title_nonblank_chk CHECK (btrim(title) <> ''),
      CONSTRAINT tasks_status_chk CHECK (status IN ('open', 'done')),
      CONSTRAINT tasks_completion_mode_chk CHECK (completion_mode IN ('all', 'any')),
      CONSTRAINT tasks_depth_chk CHECK (depth BETWEEN 0 AND 4),
      CONSTRAINT tasks_time_zone_when_dated_chk CHECK (
        time_zone IS NOT NULL OR (due_date IS NULL AND start_date IS NULL)
      ),
      CONSTRAINT tasks_due_time_needs_date_chk CHECK (due_time IS NULL OR due_date IS NOT NULL),
      CONSTRAINT tasks_start_time_needs_date_chk CHECK (start_time IS NULL OR start_date IS NOT NULL),
      CONSTRAINT tasks_parent_fk FOREIGN KEY (parent_id) REFERENCES tasks (id)
    )
  `.execute(db)

  await sql`
    CREATE TABLE task_assignees (
      task_id text NOT NULL,
      user_id text NOT NULL,
      completed_at timestamptz,
      assigned_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, user_id),
      CONSTRAINT task_assignees_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
      CONSTRAINT task_assignees_user_printable_chk CHECK (user_id ~ '^[!-~]+$'),
      CONSTRAINT task_assignees_assigned_by_printable_chk CHECK (
        assigned_by IS NULL OR assigned_by ~ '^[!-~]+$'
      )
    )
  `.execute(db)

  await sql`
    CREATE TABLE task_followers (
      task_id text NOT NULL,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, user_id),
      CONSTRAINT task_followers_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
      CONSTRAINT task_followers_user_printable_chk CHECK (user_id ~ '^[!-~]+$')
    )
  `.execute(db)

  await sql`
    CREATE TABLE task_events (
      id text PRIMARY KEY,
      task_id text NOT NULL,
      actor_id text NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_events_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_events_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
      CONSTRAINT task_events_actor_printable_chk CHECK (actor_id ~ '^[!-~]+$'),
      CONSTRAINT task_events_type_chk CHECK (event_type IN (${eventTypeList}))
    )
  `.execute(db)

  await sql`CREATE INDEX idx_tska_user ON task_assignees (user_id)`.execute(db)
  await sql`CREATE INDEX idx_tskf_user ON task_followers (user_id)`.execute(db)
  await sql`
    CREATE INDEX idx_tsk_org_status ON tasks (org_id, status) WHERE deleted_at IS NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_tsk_creator ON tasks (created_by) WHERE deleted_at IS NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_tsk_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_tsk_due ON tasks (due_at)
    WHERE due_time IS NOT NULL AND status = 'open' AND deleted_at IS NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_tsk_due_date ON tasks (due_date)
    WHERE due_time IS NULL AND status = 'open' AND deleted_at IS NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_tske_task_time ON task_events (task_id, occurred_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_tske_task_time`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tsk_due_date`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tsk_due`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tsk_parent`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tsk_creator`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tsk_org_status`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tskf_user`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tska_user`.execute(db)
  await sql`DROP TABLE IF EXISTS task_events`.execute(db)
  await sql`DROP TABLE IF EXISTS task_followers`.execute(db)
  await sql`DROP TABLE IF EXISTS task_assignees`.execute(db)
  await sql`DROP TABLE IF EXISTS tasks`.execute(db)
}
