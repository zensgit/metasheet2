/**
 * M4 (PR-3a) task tables. Draft migration: do not apply from this PR, do not run against a
 * shared DB.
 *
 * Design: docs/development/task-m4-pr3a-backend-design-20260930.md §2.
 * Lock:   docs/development/task-feature-design-lock-20260917.md §4.1 / §4.2 / §4.3.
 *
 * Adds `tasks.remind_at` (+ `idx_tsk_remind`) and creates eight P1 tables: task_lists,
 * task_list_members, task_list_items, task_groups, task_group_items, task_list_events,
 * task_user_settings, task_notification_deliveries. One file on purpose
 * (ASSUMPTION(task-m4): [own-22]): the staging owner-exclusion mechanism can only prove that
 * tables are absent, so the added column and every index ride along with the table creation.
 *
 * Ordering: Kysely runs migrations in full-filename order. The full filename sorts after
 * `zzzz20260926120000_create_task_p0a_tables` (this migration ALTERs `tasks` and references
 * `tasks(id)`) and after `zzzz20260930090000_create_task_comments`. It also sorts after every
 * migration on main at merge time (lock §4 naming rule); recheck the prefix against main before
 * merging.
 *
 * Person columns are text with the single printable CHECK and no FK to `users` (same as P0-A).
 * Generated ids (`tlst_` / `tgrp_` / `tlev_`) use the four-conjunct CHECK; members and items use
 * composite primary keys; the outbox id is a uuid (RULED(2026-10-07): [R23]).
 * No database hard limits (RULED(2026-10-07): [R14]).
 * Every FK into tasks / task_lists / task_groups is ON DELETE CASCADE; task soft delete does not
 * cascade (RULED(2026-10-07): [R13]).
 * Org consistency (ASSUMPTION(task-m4): [own-37]): a list item and a group item carry the org_id
 * of both rows they join, through composite FKs to (id, org_id) of tasks, task_lists and
 * task_groups; a list-scope group references (list_id, org_id) of its list. Every referencing
 * column is NOT NULL except task_groups.list_id, which is NULL exactly for user-scope groups.
 * task_list_members joins no task and carries no org_id.
 * CHECK expressions call no function outside pg_catalog; the one function call is spelled
 * `pg_catalog.btrim(...)`, so every CHECK resolves under pg_restore's empty search_path.
 * This migration does not insert rows and does not touch `permissions`.
 */
import { sql, type Kysely } from 'kysely'

// Closed set of task_list_events.event_type (lock §4.2, all 15 words written at once).
const TASK_LIST_EVENT_TYPES = [
  'created',
  'renamed',
  'archived',
  'unarchived',
  'owner_transferred',
  'member_added',
  'member_removed',
  'member_role_changed',
  'item_added',
  'item_removed',
  'group_created',
  'group_renamed',
  'group_deleted',
  'field_bound',
  'field_unbound',
] as const

const listEventTypeList = sql.join(TASK_LIST_EVENT_TYPES.map((t) => sql.lit(t)))

export async function up(db: Kysely<unknown>): Promise<void> {
  // RULED(2026-10-07): [R03] remind_at column; [R06] its index. ASSUMPTION(task-m4): [own-26] the
  // index predicate stops at `remind_at IS NOT NULL` (scan window is decided in PR-3b).
  await sql`ALTER TABLE tasks ADD COLUMN remind_at timestamptz`.execute(db)
  await sql`
    CREATE INDEX idx_tsk_remind ON tasks (remind_at) WHERE remind_at IS NOT NULL
  `.execute(db)
  // ASSUMPTION(task-m4): [own-37] target of the composite FKs from the list and group items.
  await sql`ALTER TABLE tasks ADD CONSTRAINT tasks_id_org_id_key UNIQUE (id, org_id)`.execute(db)

  // Deviation from lock §13-15 (ASSUMPTION(task-m4): [dev-01]): no owner_id column. The single
  // source of truth for the owner is the task_list_members row with role = 'owner'
  // (uq_tlsm_owner). `icon` is created but not read or written by PR-3a
  // (ASSUMPTION(task-m4): [own-03]).
  await sql`
    CREATE TABLE task_lists (
      id text PRIMARY KEY,
      org_id text NOT NULL,
      name text NOT NULL,
      icon text,
      created_by text NOT NULL,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_lists_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_lists_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_lists_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
      CONSTRAINT task_lists_name_nonblank_chk CHECK (pg_catalog.btrim(name) <> ''),
      CONSTRAINT task_lists_id_org_id_key UNIQUE (id, org_id)
    )
  `.execute(db)

  // RULED(2026-10-07): [R12] roles read / edit / owner; at most one owner per list.
  await sql`
    CREATE TABLE task_list_members (
      list_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (list_id, user_id),
      CONSTRAINT task_list_members_list_fk FOREIGN KEY (list_id) REFERENCES task_lists (id) ON DELETE CASCADE,
      CONSTRAINT task_list_members_user_printable_chk CHECK (user_id ~ '^[!-~]+$'),
      CONSTRAINT task_list_members_role_chk CHECK (role IN ('read', 'edit', 'owner'))
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_tlsm_owner ON task_list_members (list_id) WHERE role = 'owner'
  `.execute(db)
  // ASSUMPTION(task-m4): [own-23] index beyond the lock's minimum set.
  await sql`CREATE INDEX idx_tlsm_user ON task_list_members (user_id)`.execute(db)

  // ASSUMPTION(task-m4): [own-37] the list and the task of one item are rows of the same org.
  await sql`
    CREATE TABLE task_list_items (
      list_id text NOT NULL,
      task_id text NOT NULL,
      org_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (list_id, task_id),
      CONSTRAINT task_list_items_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_list_items_list_fk FOREIGN KEY (list_id, org_id)
        REFERENCES task_lists (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_list_items_task_fk FOREIGN KEY (task_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE
    )
  `.execute(db)
  // Named in the lock §4.2 minimum index set.
  await sql`CREATE INDEX idx_tski_task ON task_list_items (task_id)`.execute(db)

  // RULED(2026-10-07): [R11] [R23] scopes list / user; at most one default group per container.
  await sql`
    CREATE TABLE task_groups (
      id text PRIMARY KEY,
      org_id text NOT NULL,
      scope text NOT NULL,
      list_id text,
      user_id text,
      name text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_groups_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_groups_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_groups_scope_chk CHECK (scope IN ('list', 'user')),
      CONSTRAINT task_groups_scope_owner_chk CHECK (
        (scope = 'list' AND list_id IS NOT NULL AND user_id IS NULL)
        OR (scope = 'user' AND user_id IS NOT NULL AND list_id IS NULL)
      ),
      CONSTRAINT task_groups_user_printable_chk CHECK (user_id IS NULL OR user_id ~ '^[!-~]+$'),
      CONSTRAINT task_groups_name_nonblank_chk CHECK (pg_catalog.btrim(name) <> ''),
      CONSTRAINT task_groups_position_chk CHECK (position >= 0),
      CONSTRAINT task_groups_id_org_id_key UNIQUE (id, org_id),
      CONSTRAINT task_groups_list_fk FOREIGN KEY (list_id, org_id)
        REFERENCES task_lists (id, org_id) ON DELETE CASCADE
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_tgrp_list_default ON task_groups (list_id)
    WHERE scope = 'list' AND is_default
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_tgrp_user_default ON task_groups (org_id, user_id)
    WHERE scope = 'user' AND is_default
  `.execute(db)
  // ASSUMPTION(task-m4): [own-23] indexes beyond the lock's minimum set.
  await sql`
    CREATE INDEX idx_tgrp_list ON task_groups (list_id) WHERE list_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_tgrp_user ON task_groups (org_id, user_id) WHERE user_id IS NOT NULL
  `.execute(db)

  // ASSUMPTION(task-m4): [own-37] the group and the task of one placement are rows of the same org.
  await sql`
    CREATE TABLE task_group_items (
      group_id text NOT NULL,
      task_id text NOT NULL,
      org_id text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, task_id),
      CONSTRAINT task_group_items_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_group_items_group_fk FOREIGN KEY (group_id, org_id)
        REFERENCES task_groups (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_group_items_task_fk FOREIGN KEY (task_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_group_items_position_chk CHECK (position >= 0)
    )
  `.execute(db)
  // ASSUMPTION(task-m4): [own-23]
  await sql`CREATE INDEX idx_tgri_task ON task_group_items (task_id)`.execute(db)

  await sql`
    CREATE TABLE task_list_events (
      id text PRIMARY KEY,
      list_id text NOT NULL,
      actor_id text NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_list_events_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_list_events_list_fk FOREIGN KEY (list_id) REFERENCES task_lists (id) ON DELETE CASCADE,
      CONSTRAINT task_list_events_actor_printable_chk CHECK (actor_id ~ '^[!-~]+$'),
      CONSTRAINT task_list_events_type_chk CHECK (event_type IN (${listEventTypeList}))
    )
  `.execute(db)
  // ASSUMPTION(task-m4): [own-23]
  await sql`
    CREATE INDEX idx_tlev_list_time ON task_list_events (list_id, occurred_at DESC)
  `.execute(db)

  // RULED(2026-10-07): [R02] settings row, badge_scope default 'overdue', daily reminder off,
  // default_remind_policy has no DB CHECK (closed set enforced by parseRemindPolicy).
  // RULED(2026-10-07): [R07] time_zone column and the daily-needs-time-zone CHECK.
  await sql`
    CREATE TABLE task_user_settings (
      user_id text NOT NULL,
      org_id text NOT NULL,
      badge_scope text NOT NULL DEFAULT 'overdue',
      daily_reminder_enabled boolean NOT NULL DEFAULT false,
      default_remind_policy jsonb NOT NULL DEFAULT '{"mode":"default"}'::jsonb,
      time_zone text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, org_id),
      CONSTRAINT task_user_settings_user_printable_chk CHECK (user_id ~ '^[!-~]+$'),
      CONSTRAINT task_user_settings_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_user_settings_badge_scope_chk CHECK (
        badge_scope IN ('off', 'overdue', 'overdue_or_today')
      ),
      CONSTRAINT task_user_settings_daily_needs_tz_chk CHECK (
        daily_reminder_enabled = false OR time_zone IS NOT NULL
      )
    )
  `.execute(db)

  // RULED(2026-10-07): [R23] the uuid id. ASSUMPTION(task-m4): [D1] outbox shape. PR-3a creates the
  // table only; no writer. org_id has no default (lock §4.3: never 'default').
  await sql`
    CREATE TABLE task_notification_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      source_type text NOT NULL,
      source_id text,
      source_key text NOT NULL,
      recipient_user_id text NOT NULL,
      recipient_role text NOT NULL,
      channel text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_attempt_at timestamptz,
      claimed_at timestamptz,
      claim_expires_at timestamptz,
      claim_worker_id text,
      delivered_at timestamptz,
      last_error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      redelivery_safe boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_notification_deliveries_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_notification_deliveries_recipient_printable_chk CHECK (
        recipient_user_id ~ '^[!-~]+$'
      ),
      CONSTRAINT task_notification_deliveries_role_chk CHECK (
        recipient_role IN ('creator', 'assignee', 'follower', 'list_member')
      ),
      CONSTRAINT task_notification_deliveries_status_chk CHECK (
        status IN ('pending', 'sending', 'sent', 'retrying', 'failed', 'skipped', 'outcome_unknown')
      ),
      CONSTRAINT task_notification_deliveries_attempt_count_chk CHECK (attempt_count >= 0),
      CONSTRAINT task_notification_deliveries_delivered_status_chk CHECK (
        delivered_at IS NULL OR status = 'sent'
      )
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_tskn_source_key ON task_notification_deliveries (org_id, source_key)
  `.execute(db)
  await sql`
    CREATE INDEX idx_tskn_claim ON task_notification_deliveries (status, next_attempt_at)
  `.execute(db)
  await sql`
    CREATE INDEX idx_tskn_reclaim ON task_notification_deliveries (status, claim_expires_at)
  `.execute(db)
  await sql`
    CREATE INDEX idx_tskn_source ON task_notification_deliveries (org_id, source_type, source_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_tskn_source`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tskn_reclaim`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tskn_claim`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_tskn_source_key`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tlev_list_time`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tgri_task`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tgrp_user`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tgrp_list`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_tgrp_user_default`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_tgrp_list_default`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tski_task`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tlsm_user`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_tlsm_owner`.execute(db)
  await sql`DROP TABLE IF EXISTS task_notification_deliveries`.execute(db)
  await sql`DROP TABLE IF EXISTS task_user_settings`.execute(db)
  await sql`DROP TABLE IF EXISTS task_list_events`.execute(db)
  await sql`DROP TABLE IF EXISTS task_group_items`.execute(db)
  await sql`DROP TABLE IF EXISTS task_groups`.execute(db)
  await sql`DROP TABLE IF EXISTS task_list_items`.execute(db)
  await sql`DROP TABLE IF EXISTS task_list_members`.execute(db)
  await sql`DROP TABLE IF EXISTS task_lists`.execute(db)
  await sql`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_id_org_id_key`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_tsk_remind`.execute(db)
  await sql`ALTER TABLE tasks DROP COLUMN IF EXISTS remind_at`.execute(db)
}
