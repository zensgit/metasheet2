/**
 * M5 (PR-4a) task tables. Draft migration: do not apply from this PR, do not run against a
 * shared DB.
 *
 * Design: docs/development/task-m5-pr4a-backend-design-20261010.md §2.
 * Lock:   docs/development/task-feature-design-lock-20260917.md §4.1 / §4.2.
 *
 * Adds four columns to `tasks` (is_milestone, recurrence, recurrence_series_id,
 * previous_occurrence_id) with eight named constraints and two indexes, the unique constraint
 * `task_comments_id_task_id_key`, and seven P2 tables: task_dependencies, task_fields,
 * task_list_field_bindings, task_field_values, task_attachments, task_attachment_purge_intents,
 * task_record_projection, plus the row-delete trigger on task_attachments. One file for all M5
 * DDL (ASSUMPTION(task-m5a): [a-06], D1): the staging exclusion mechanism can only prove that
 * tables are absent, so the added columns and every index ride along with the table creation.
 *
 * Ordering: Kysely runs migrations in full-filename order. The full filename sorts after
 * `zzzz20261009130000_create_task_m4_tables` (this migration references `tasks (id, org_id)`,
 * `task_lists (id, org_id)` and `task_comments`) and after every migration on main when it was
 * drafted. Recheck the prefix against main before merging (ASSUMPTION(task-m5a): [a-23]).
 *
 * Generated id columns (`tfld_` / `tatt_` / `tpi_` ids, the two series columns of `tasks`, and
 * the two key columns of the projection mapping) use the four-conjunct CHECK; org and person
 * columns use the single printable CHECK and have no FK to `users`.
 * Org consistency: every row that points at a task, a list or a field carries `org_id` and
 * references the target's `(id, org_id)` through a composite FK. The mapping table has no FK and
 * no org_id (lock §4.2, §7).
 * No FK cascades from a soft delete (task delete is a soft delete, RULED(2026-10-07): [R13]); the
 * two series FKs on `tasks` are NO ACTION.
 * CHECK expressions and the trigger body call functions only as `pg_catalog.<name>`, so they
 * resolve under pg_restore's empty search_path. The trigger and its function have names of their
 * own; nothing is created with OR REPLACE.
 * This migration does not insert rows and does not touch `permissions`; there are no database
 * hard limits (RULED(2026-10-09): [S28]).
 */
import { sql, type Kysely } from 'kysely'

// RULED(2026-10-09): [S25] the six field types.
const TASK_FIELD_TYPES = ['text', 'number', 'select', 'multiSelect', 'member', 'date'] as const
// RULED(2026-10-09): [S18] the attachment type allow-list.
const TASK_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
] as const
// ASSUMPTION(task-m5a): [a-22] three purge sources plus the trigger.
const TASK_ATTACHMENT_PURGE_REASONS = ['user_removed', 'unbound_ttl', 'reconciler_orphan', 'row_deleted'] as const

const literalList = (values: readonly string[]) => sql.join(values.map((v) => sql.lit(v)))

/** The eight `tasks` constraints of design §2.2, in the order up() adds them. */
const TASKS_M5_CONSTRAINTS = [
  'tasks_recurrence_object_chk',
  'tasks_recurrence_series_id_generated_chk',
  'tasks_recurrence_series_fk',
  'tasks_recurrence_series_not_self_chk',
  'tasks_previous_occurrence_id_generated_chk',
  'tasks_previous_occurrence_fk',
  'tasks_previous_occurrence_not_self_chk',
  'tasks_series_columns_paired_chk',
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  // ① tasks: four columns, eight constraints, two indexes.
  // RULED(2026-10-09): [S13] milestone flag; [S14] [S16] [S17] recurrence rule and series chain.
  await sql`ALTER TABLE tasks ADD COLUMN is_milestone boolean NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE tasks ADD COLUMN recurrence jsonb`.execute(db)
  await sql`ALTER TABLE tasks ADD COLUMN recurrence_series_id text`.execute(db)
  await sql`ALTER TABLE tasks ADD COLUMN previous_occurrence_id text`.execute(db)
  // ASSUMPTION(task-m5a): [a-06] (D2) the database only checks that the rule is an object; the
  // closed set is parseRecurrenceRule's.
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_object_chk CHECK (
      recurrence IS NULL OR pg_catalog.jsonb_typeof(recurrence) = 'object'
    )
  `.execute(db)
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_series_id_generated_chk CHECK (
      recurrence_series_id ~ '^[!-~]+$' AND recurrence_series_id !~ '__'
      AND recurrence_series_id !~ '^_' AND recurrence_series_id !~ '_$'
    )
  `.execute(db)
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_series_fk FOREIGN KEY (recurrence_series_id, org_id)
      REFERENCES tasks (id, org_id)
  `.execute(db)
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_series_not_self_chk CHECK (recurrence_series_id <> id)
  `.execute(db)
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_previous_occurrence_id_generated_chk CHECK (
      previous_occurrence_id ~ '^[!-~]+$' AND previous_occurrence_id !~ '__'
      AND previous_occurrence_id !~ '^_' AND previous_occurrence_id !~ '_$'
    )
  `.execute(db)
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_previous_occurrence_fk FOREIGN KEY (previous_occurrence_id, org_id)
      REFERENCES tasks (id, org_id)
  `.execute(db)
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_previous_occurrence_not_self_chk CHECK (previous_occurrence_id <> id)
  `.execute(db)
  // ASSUMPTION(task-m5a): [a-20] the series columns are both empty (first occurrence) or both set.
  await sql`
    ALTER TABLE tasks ADD CONSTRAINT tasks_series_columns_paired_chk CHECK (
      (recurrence_series_id IS NULL) = (previous_occurrence_id IS NULL)
    )
  `.execute(db)
  // ASSUMPTION(task-m5a): [a-20] an occurrence has at most one successor.
  await sql`
    CREATE UNIQUE INDEX uq_tsk_previous_occurrence ON tasks (previous_occurrence_id)
    WHERE previous_occurrence_id IS NOT NULL
  `.execute(db)
  // D2 (ASSUMPTION): series reads load every occurrence, soft-deleted ones included.
  await sql`
    CREATE INDEX idx_tsk_recurrence_series ON tasks (recurrence_series_id)
    WHERE recurrence_series_id IS NOT NULL
  `.execute(db)

  // ② ASSUMPTION(task-m5a): [a-07] target of the comment FK of task_attachments.
  await sql`ALTER TABLE task_comments ADD CONSTRAINT task_comments_id_task_id_key UNIQUE (id, task_id)`.execute(db)

  // ③ RULED(2026-10-09): [S11] [S12] one relation, no type or lag column; self loops are refused
  // here, cycles by the pure function under the structure lock (D4, ASSUMPTION).
  await sql`
    CREATE TABLE task_dependencies (
      predecessor_id text NOT NULL,
      successor_id text NOT NULL,
      org_id text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_dependencies_pkey PRIMARY KEY (predecessor_id, successor_id),
      CONSTRAINT task_dependencies_not_self_chk CHECK (predecessor_id <> successor_id),
      CONSTRAINT task_dependencies_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_dependencies_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
      CONSTRAINT task_dependencies_predecessor_fk FOREIGN KEY (predecessor_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_dependencies_successor_fk FOREIGN KEY (successor_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE
    )
  `.execute(db)
  await sql`CREATE INDEX idx_tdep_successor ON task_dependencies (successor_id)`.execute(db)
  await sql`CREATE INDEX idx_tdep_org ON task_dependencies (org_id)`.execute(db)

  // ④ RULED(2026-10-09): [S25] six types; [S26] definitions are hard deleted. The closed config
  // schema is parseFieldDefinition's (D10, ASSUMPTION).
  await sql`
    CREATE TABLE task_fields (
      id text PRIMARY KEY,
      org_id text NOT NULL,
      type text NOT NULL,
      name text NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_fields_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_fields_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_fields_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
      CONSTRAINT task_fields_type_chk CHECK (type IN (${literalList(TASK_FIELD_TYPES)})),
      CONSTRAINT task_fields_name_nonblank_chk CHECK (pg_catalog.btrim(name) <> ''),
      CONSTRAINT task_fields_config_object_chk CHECK (pg_catalog.jsonb_typeof(config) = 'object'),
      CONSTRAINT task_fields_id_org_id_key UNIQUE (id, org_id)
    )
  `.execute(db)
  await sql`CREATE INDEX idx_tfld_org ON task_fields (org_id)`.execute(db)

  // ⑤ ASSUMPTION(task-m5a): [a-08] RESTRICT toward the field; [a-42] position is written by the
  // service on every insert, and there is no (list_id, position) unique constraint.
  await sql`
    CREATE TABLE task_list_field_bindings (
      list_id text NOT NULL,
      field_id text NOT NULL,
      org_id text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      hidden boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_list_field_bindings_pkey PRIMARY KEY (list_id, field_id),
      CONSTRAINT task_list_field_bindings_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_list_field_bindings_position_chk CHECK (position >= 0),
      CONSTRAINT task_list_field_bindings_list_fk FOREIGN KEY (list_id, org_id)
        REFERENCES task_lists (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_list_field_bindings_field_fk FOREIGN KEY (field_id, org_id)
        REFERENCES task_fields (id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`CREATE INDEX idx_tflb_field ON task_list_field_bindings (field_id)`.execute(db)

  // ⑥ ASSUMPTION(task-m5a): [a-09] clearing a value deletes the row, so neither SQL NULL nor JSON
  // null is stored. RULED(2026-10-09): [S26] unbinding keeps values; values go with the definition.
  await sql`
    CREATE TABLE task_field_values (
      task_id text NOT NULL,
      field_id text NOT NULL,
      org_id text NOT NULL,
      value jsonb NOT NULL,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_field_values_pkey PRIMARY KEY (task_id, field_id),
      CONSTRAINT task_field_values_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_field_values_updated_by_printable_chk CHECK (updated_by ~ '^[!-~]+$'),
      CONSTRAINT task_field_values_value_not_json_null_chk CHECK (pg_catalog.jsonb_typeof(value) <> 'null'),
      CONSTRAINT task_field_values_task_fk FOREIGN KEY (task_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_field_values_field_fk FOREIGN KEY (field_id, org_id)
        REFERENCES task_fields (id, org_id) ON DELETE CASCADE
    )
  `.execute(db)
  await sql`CREATE INDEX idx_tfv_field ON task_field_values (field_id)`.execute(db)

  // ⑦ RULED(2026-10-09): [S30] the attachment tables ship with this migration; reads and writes
  // come later. [S18] type allow-list and size range; [S22] only 'unscanned' is written in M5.
  // ASSUMPTION(task-m5a): [a-07] row-state CHECKs and the NO ACTION comment FK.
  await sql`
    CREATE TABLE task_attachments (
      id text PRIMARY KEY,
      org_id text NOT NULL,
      task_id text,
      comment_id text,
      bind_kind text NOT NULL,
      uploader_id text NOT NULL,
      storage_key text NOT NULL,
      display_name text NOT NULL,
      mime_type text NOT NULL,
      size_bytes bigint NOT NULL,
      status text NOT NULL DEFAULT 'unbound',
      scan_state text NOT NULL DEFAULT 'unscanned',
      created_at timestamptz NOT NULL DEFAULT now(),
      bound_at timestamptz,
      deleted_at timestamptz,
      deleted_by text,
      CONSTRAINT task_attachments_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_attachments_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
      CONSTRAINT task_attachments_uploader_id_printable_chk CHECK (uploader_id ~ '^[!-~]+$'),
      CONSTRAINT task_attachments_storage_key_printable_chk CHECK (storage_key ~ '^[!-~]+$'),
      CONSTRAINT task_attachments_deleted_by_printable_chk CHECK (
        deleted_by IS NULL OR deleted_by ~ '^[!-~]+$'
      ),
      CONSTRAINT task_attachments_display_name_nonblank_chk CHECK (pg_catalog.btrim(display_name) <> ''),
      CONSTRAINT task_attachments_storage_key_key UNIQUE (storage_key),
      CONSTRAINT task_attachments_mime_type_chk CHECK (mime_type IN (${literalList(TASK_ATTACHMENT_MIME_TYPES)})),
      CONSTRAINT task_attachments_size_chk CHECK (size_bytes BETWEEN 1 AND 10485760),
      CONSTRAINT task_attachments_bind_kind_chk CHECK (bind_kind IN ('task', 'comment')),
      CONSTRAINT task_attachments_status_chk CHECK (status IN ('unbound', 'bound', 'deleted')),
      CONSTRAINT task_attachments_scan_state_chk CHECK (scan_state IN ('unscanned', 'clean', 'infected')),
      CONSTRAINT task_attachments_bound_has_task_chk CHECK ((bound_at IS NULL) = (task_id IS NULL)),
      CONSTRAINT task_attachments_unbound_state_chk CHECK (status <> 'unbound' OR bound_at IS NULL),
      CONSTRAINT task_attachments_bound_state_chk CHECK (status <> 'bound' OR bound_at IS NOT NULL),
      CONSTRAINT task_attachments_task_kind_chk CHECK (
        bind_kind <> 'task' OR (comment_id IS NULL AND bound_at IS NOT NULL)
      ),
      CONSTRAINT task_attachments_comment_kind_chk CHECK (
        bind_kind <> 'comment' OR ((comment_id IS NULL) = (bound_at IS NULL))
      ),
      CONSTRAINT task_attachments_deleted_state_chk CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
      CONSTRAINT task_attachments_task_fk FOREIGN KEY (task_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE,
      CONSTRAINT task_attachments_comment_fk FOREIGN KEY (comment_id, task_id)
        REFERENCES task_comments (id, task_id)
    )
  `.execute(db)
  await sql`CREATE INDEX idx_tatt_task ON task_attachments (task_id) WHERE task_id IS NOT NULL`.execute(db)
  await sql`CREATE INDEX idx_tatt_comment ON task_attachments (comment_id) WHERE comment_id IS NOT NULL`.execute(db)
  await sql`CREATE INDEX idx_tatt_unbound_sweep ON task_attachments (status, created_at)`.execute(db)

  // ⑧ D1 (ASSUMPTION): storage_key is unique from the start; every writer uses the id
  // 'tpi_' || md5(storage_key) and ON CONFLICT (storage_key) DO NOTHING.
  await sql`
    CREATE TABLE task_attachment_purge_intents (
      id text PRIMARY KEY,
      storage_key text NOT NULL,
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      lease_expires_at timestamptz,
      fence bigint NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      purged_at timestamptz,
      CONSTRAINT task_attachment_purge_intents_id_generated_chk CHECK (
        id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
      ),
      CONSTRAINT task_attachment_purge_intents_storage_key_printable_chk CHECK (storage_key ~ '^[!-~]+$'),
      CONSTRAINT task_attachment_purge_intents_reason_chk CHECK (
        reason IN (${literalList(TASK_ATTACHMENT_PURGE_REASONS)})
      ),
      CONSTRAINT task_attachment_purge_intents_status_chk CHECK (
        status IN ('pending', 'in_progress', 'done', 'dead_letter')
      ),
      CONSTRAINT task_attachment_purge_intents_attempts_chk CHECK (attempts >= 0),
      CONSTRAINT task_attachment_purge_intents_last_error_code_chk CHECK (
        last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]*$'
      ),
      CONSTRAINT task_attachment_purge_intents_storage_key_key UNIQUE (storage_key)
    )
  `.execute(db)
  await sql`CREATE INDEX idx_tapi_pending ON task_attachment_purge_intents (status, created_at)`.execute(db)

  // ⑨ RULED(2026-10-09): [S23] a deleted attachment row (a direct DELETE, or the cascade of a
  // task hard delete) leaves a purge intent for its stored object.
  await sql`
    CREATE FUNCTION task_attachment_enqueue_purge_on_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO task_attachment_purge_intents (id, storage_key, reason)
      VALUES ('tpi_' || pg_catalog.md5(OLD.storage_key), OLD.storage_key, 'row_deleted')
      ON CONFLICT (storage_key) DO NOTHING;
      RETURN NULL;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER task_attachment_purge_on_delete
    AFTER DELETE ON task_attachments
    FOR EACH ROW EXECUTE FUNCTION task_attachment_enqueue_purge_on_delete()
  `.execute(db)

  // ⑩ ASSUMPTION(task-m5a): [a-06] the mapping table ships here, reads and writes come later; no
  // FK and no org_id (lock §4.2, §7); [a-21] projected_digest.
  await sql`
    CREATE TABLE task_record_projection (
      list_id text NOT NULL,
      task_id text NOT NULL,
      projected_version integer NOT NULL,
      projected_digest text,
      last_projected_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_record_projection_pkey PRIMARY KEY (list_id, task_id),
      CONSTRAINT task_record_projection_list_id_generated_chk CHECK (
        list_id ~ '^[!-~]+$' AND list_id !~ '__' AND list_id !~ '^_' AND list_id !~ '_$'
      ),
      CONSTRAINT task_record_projection_task_id_generated_chk CHECK (
        task_id ~ '^[!-~]+$' AND task_id !~ '__' AND task_id !~ '^_' AND task_id !~ '_$'
      ),
      CONSTRAINT task_record_projection_version_chk CHECK (projected_version >= 1),
      CONSTRAINT task_record_projection_digest_chk CHECK (
        projected_digest IS NULL OR projected_digest ~ '^[a-f0-9]{64}$'
      ),
      CONSTRAINT task_record_projection_last_error_code_chk CHECK (
        last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]*$'
      )
    )
  `.execute(db)
  await sql`CREATE INDEX idx_trp_task ON task_record_projection (task_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // ⑩
  await sql`DROP TABLE IF EXISTS task_record_projection`.execute(db)
  // ⑨ the trigger, then its function.
  await sql`DROP TRIGGER IF EXISTS task_attachment_purge_on_delete ON task_attachments`.execute(db)
  await sql`DROP FUNCTION IF EXISTS task_attachment_enqueue_purge_on_delete()`.execute(db)
  // ⑧–③ the tables; their indexes and constraints go with them.
  await sql`DROP TABLE IF EXISTS task_attachment_purge_intents`.execute(db)
  await sql`DROP TABLE IF EXISTS task_attachments`.execute(db)
  await sql`DROP TABLE IF EXISTS task_field_values`.execute(db)
  await sql`DROP TABLE IF EXISTS task_list_field_bindings`.execute(db)
  await sql`DROP TABLE IF EXISTS task_fields`.execute(db)
  await sql`DROP TABLE IF EXISTS task_dependencies`.execute(db)
  // ②
  await sql`ALTER TABLE task_comments DROP CONSTRAINT IF EXISTS task_comments_id_task_id_key`.execute(db)
  // ① the two indexes, the eight constraints by name (reverse order), then the four columns.
  await sql`DROP INDEX IF EXISTS idx_tsk_recurrence_series`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_tsk_previous_occurrence`.execute(db)
  for (const name of [...TASKS_M5_CONSTRAINTS].reverse()) {
    await sql`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ${sql.id(name)}`.execute(db)
  }
  await sql`ALTER TABLE tasks DROP COLUMN IF EXISTS previous_occurrence_id`.execute(db)
  await sql`ALTER TABLE tasks DROP COLUMN IF EXISTS recurrence_series_id`.execute(db)
  await sql`ALTER TABLE tasks DROP COLUMN IF EXISTS recurrence`.execute(db)
  await sql`ALTER TABLE tasks DROP COLUMN IF EXISTS is_milestone`.execute(db)
}
