/**
 * M5 schema shape (design task-m5-pr4a-backend-design-20261010.md §2, §6.3) and the real-path cells
 * of the M5|7 lock-order control (§4.2, §6.1).
 *
 * Pins the exact column / constraint / index sets of the seven M5 tables, the four `tasks`
 * columns with their eight constraints and two indexes, and `task_comments_id_task_id_key`
 * against the design; exercises every CHECK, FK and unique index the design names, by constraint
 * name, one accepted and one refused row each; checks the attachment row-delete trigger; and runs
 * the migration's own down() then up() inside one transaction on one connection, compares the
 * catalog snapshots, and rolls back (§2.11).
 *
 * The lock-order cells run the production paths that take a task lock (a structure write through
 * withOrgStructure, task creation, one scheduler tick) with the wrapper's test-only recorder on,
 * one operation at a time, and assert each one's recorded sequence; then the reverse-order and
 * leader coexistence cells inside real transactions. The wrapper's unit cells and the static cell
 * are in tests/unit/task-lock-order.test.ts.
 * This file does not start MetaSheetServer.
 */
import '../helpers/assert-rbac-optional-off'
import { createHash, randomUUID } from 'node:crypto'
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely'
import pg, { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  setTaskLockOrderRecorderForTests,
  TaskLockOrderViolation,
  withTaskLockOrder,
  type TaskLockOrderLock,
} from '../../src/db/task-advisory-locks'
import { down as m5Down, up as m5Up } from '../../src/db/migrations/zzzz20261012150000_create_task_m5_tables'
import { poolManager } from '../../src/integration/db/connection-pool'
import { newTaskCommentId, newTaskId, newTaskListId } from '../../src/services/task-ids-runtime'
import { createTask } from '../../src/services/task-records'
import { TaskScheduler, type LeaderClient } from '../../src/services/task-scheduler'
import { setTaskParent } from '../../src/services/task-structure'
import {
  TASK_ATTACHMENT_BIND_KINDS,
  TASK_ATTACHMENT_LIMITS,
  TASK_ATTACHMENT_MIME_EXTENSIONS,
  TASK_ATTACHMENT_SCAN_STATES,
  TASK_ATTACHMENT_STATUSES,
} from '../../src/tasks/task-attachments'
import { TASK_FIELD_TYPES } from '../../src/tasks/task-fields'
import { generateTaskDomainId } from '../../src/tasks/task-ids'
import { dropTaskM4Fixtures } from '../helpers/task-m4-fixtures'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m5-schema.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m5schema_'
const STAMP = randomUUID()
const STAMP_HEX = STAMP.replace(/-/g, '')
const STORAGE_PREFIX = `m5schema/${STAMP_HEX}/`

const M5_TABLES = [
  'task_dependencies',
  'task_fields',
  'task_list_field_bindings',
  'task_field_values',
  'task_attachments',
  'task_attachment_purge_intents',
  'task_record_projection',
] as const

const TASKS_COLUMNS = ['is_milestone', 'recurrence', 'recurrence_series_id', 'previous_occurrence_id']
const TASKS_CONSTRAINTS = [
  'tasks_previous_occurrence_fk',
  'tasks_previous_occurrence_id_generated_chk',
  'tasks_previous_occurrence_not_self_chk',
  'tasks_recurrence_object_chk',
  'tasks_recurrence_series_fk',
  'tasks_recurrence_series_id_generated_chk',
  'tasks_recurrence_series_not_self_chk',
  'tasks_series_columns_paired_chk',
]
const TASKS_INDEXES = ['idx_tsk_recurrence_series', 'uq_tsk_previous_occurrence']
const COMMENTS_KEY = 'task_comments_id_task_id_key'

// ── Pins (hand-checked against design §2; text is PostgreSQL's normalized catalog form) ──

type Column = [table: string, column: string, type: string, notNull: boolean, defaultExpr: string | null]

const TSTZ = 'timestamp with time zone'

// RULED(2026-10-09): [S13] (is_milestone), [S14] [S16] [S17] (series columns), [S30] (attachment
// tables in this migration), [S18] [S22] (attachment checks). ASSUMPTION(task-m5a): [a-06] (D1 the
// mapping table here, D2 recurrence only an object), [a-07], [a-08], [a-09], [a-20], [a-21],
// [a-22], [a-42].
const EXPECTED_COLUMNS: Column[] = [
  ['task_attachment_purge_intents', 'attempts', 'integer', true, '0'],
  ['task_attachment_purge_intents', 'created_at', TSTZ, true, 'now()'],
  ['task_attachment_purge_intents', 'fence', 'bigint', true, '0'],
  ['task_attachment_purge_intents', 'id', 'text', true, null],
  ['task_attachment_purge_intents', 'last_error', 'text', false, null],
  ['task_attachment_purge_intents', 'lease_expires_at', TSTZ, false, null],
  ['task_attachment_purge_intents', 'purged_at', TSTZ, false, null],
  ['task_attachment_purge_intents', 'reason', 'text', true, null],
  ['task_attachment_purge_intents', 'status', 'text', true, "'pending'::text"],
  ['task_attachment_purge_intents', 'storage_key', 'text', true, null],
  ['task_attachments', 'bind_kind', 'text', true, null],
  ['task_attachments', 'bound_at', TSTZ, false, null],
  ['task_attachments', 'comment_id', 'text', false, null],
  ['task_attachments', 'created_at', TSTZ, true, 'now()'],
  ['task_attachments', 'deleted_at', TSTZ, false, null],
  ['task_attachments', 'deleted_by', 'text', false, null],
  ['task_attachments', 'display_name', 'text', true, null],
  ['task_attachments', 'id', 'text', true, null],
  ['task_attachments', 'mime_type', 'text', true, null],
  ['task_attachments', 'org_id', 'text', true, null],
  ['task_attachments', 'scan_state', 'text', true, "'unscanned'::text"],
  ['task_attachments', 'size_bytes', 'bigint', true, null],
  ['task_attachments', 'status', 'text', true, "'unbound'::text"],
  ['task_attachments', 'storage_key', 'text', true, null],
  ['task_attachments', 'task_id', 'text', false, null],
  ['task_attachments', 'uploader_id', 'text', true, null],
  ['task_dependencies', 'created_at', TSTZ, true, 'now()'],
  ['task_dependencies', 'created_by', 'text', true, null],
  ['task_dependencies', 'org_id', 'text', true, null],
  ['task_dependencies', 'predecessor_id', 'text', true, null],
  ['task_dependencies', 'successor_id', 'text', true, null],
  ['task_field_values', 'field_id', 'text', true, null],
  ['task_field_values', 'org_id', 'text', true, null],
  ['task_field_values', 'task_id', 'text', true, null],
  ['task_field_values', 'updated_at', TSTZ, true, 'now()'],
  ['task_field_values', 'updated_by', 'text', true, null],
  ['task_field_values', 'value', 'jsonb', true, null],
  ['task_fields', 'config', 'jsonb', true, "'{}'::jsonb"],
  ['task_fields', 'created_at', TSTZ, true, 'now()'],
  ['task_fields', 'created_by', 'text', true, null],
  ['task_fields', 'id', 'text', true, null],
  ['task_fields', 'name', 'text', true, null],
  ['task_fields', 'org_id', 'text', true, null],
  ['task_fields', 'type', 'text', true, null],
  ['task_fields', 'updated_at', TSTZ, true, 'now()'],
  ['task_list_field_bindings', 'created_at', TSTZ, true, 'now()'],
  ['task_list_field_bindings', 'field_id', 'text', true, null],
  ['task_list_field_bindings', 'hidden', 'boolean', true, 'false'],
  ['task_list_field_bindings', 'list_id', 'text', true, null],
  ['task_list_field_bindings', 'org_id', 'text', true, null],
  ['task_list_field_bindings', 'position', 'integer', true, '0'],
  ['task_record_projection', 'created_at', TSTZ, true, 'now()'],
  ['task_record_projection', 'last_error', 'text', false, null],
  ['task_record_projection', 'last_projected_at', TSTZ, false, null],
  ['task_record_projection', 'list_id', 'text', true, null],
  ['task_record_projection', 'projected_digest', 'text', false, null],
  ['task_record_projection', 'projected_version', 'integer', true, null],
  ['task_record_projection', 'task_id', 'text', true, null],
  ['task_record_projection', 'updated_at', TSTZ, true, 'now()'],
  ['tasks', 'is_milestone', 'boolean', true, 'false'],
  ['tasks', 'previous_occurrence_id', 'text', false, null],
  ['tasks', 'recurrence', 'jsonb', false, null],
  ['tasks', 'recurrence_series_id', 'text', false, null],
]

const GENERATED_ID = (col: string): string =>
  `CHECK (((${col} ~ '^[!-~]+$'::text) AND (${col} !~ '__'::text) AND (${col} !~ '^_'::text) AND (${col} !~ '_$'::text)))`
const PRINTABLE = (col: string): string => `CHECK ((${col} ~ '^[!-~]+$'::text))`
const IN_LIST = (col: string, values: string[]): string =>
  `CHECK ((${col} = ANY (ARRAY[${values.map((v) => `'${v}'::text`).join(', ')}])))`
const ERROR_CODE = (col: string): string => `CHECK (((${col} IS NULL) OR (${col} ~ '^[A-Z][A-Z0-9_]*$'::text)))`

const EXPECTED_CONSTRAINTS: Array<[string, string]> = [
  ['task_attachment_purge_intents_attempts_chk', 'CHECK ((attempts >= 0))'],
  ['task_attachment_purge_intents_id_generated_chk', GENERATED_ID('id')],
  ['task_attachment_purge_intents_last_error_code_chk', ERROR_CODE('last_error')],
  ['task_attachment_purge_intents_pkey', 'PRIMARY KEY (id)'],
  ['task_attachment_purge_intents_reason_chk', IN_LIST('reason', ['user_removed', 'unbound_ttl', 'reconciler_orphan', 'row_deleted'])],
  ['task_attachment_purge_intents_status_chk', IN_LIST('status', ['pending', 'in_progress', 'done', 'dead_letter'])],
  ['task_attachment_purge_intents_storage_key_key', 'UNIQUE (storage_key)'],
  ['task_attachment_purge_intents_storage_key_printable_chk', PRINTABLE('storage_key')],
  ['task_attachments_bind_kind_chk', IN_LIST('bind_kind', ['task', 'comment'])],
  ['task_attachments_bound_has_task_chk', 'CHECK (((bound_at IS NULL) = (task_id IS NULL)))'],
  ['task_attachments_bound_state_chk', "CHECK (((status <> 'bound'::text) OR (bound_at IS NOT NULL)))"],
  ['task_attachments_comment_fk', 'FOREIGN KEY (comment_id, task_id) REFERENCES task_comments(id, task_id)'],
  ['task_attachments_comment_kind_chk', "CHECK (((bind_kind <> 'comment'::text) OR ((comment_id IS NULL) = (bound_at IS NULL))))"],
  ['task_attachments_deleted_by_printable_chk', "CHECK (((deleted_by IS NULL) OR (deleted_by ~ '^[!-~]+$'::text)))"],
  ['task_attachments_deleted_state_chk', "CHECK (((status = 'deleted'::text) = (deleted_at IS NOT NULL)))"],
  ['task_attachments_display_name_nonblank_chk', "CHECK ((btrim(display_name) <> ''::text))"],
  ['task_attachments_id_generated_chk', GENERATED_ID('id')],
  ['task_attachments_mime_type_chk', IN_LIST('mime_type', ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv'])],
  ['task_attachments_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_attachments_pkey', 'PRIMARY KEY (id)'],
  ['task_attachments_scan_state_chk', IN_LIST('scan_state', ['unscanned', 'clean', 'infected'])],
  ['task_attachments_size_chk', 'CHECK (((size_bytes >= 1) AND (size_bytes <= 10485760)))'],
  ['task_attachments_status_chk', IN_LIST('status', ['unbound', 'bound', 'deleted'])],
  ['task_attachments_storage_key_key', 'UNIQUE (storage_key)'],
  ['task_attachments_storage_key_printable_chk', PRINTABLE('storage_key')],
  ['task_attachments_task_fk', 'FOREIGN KEY (task_id, org_id) REFERENCES tasks(id, org_id) ON DELETE CASCADE'],
  ['task_attachments_task_kind_chk', "CHECK (((bind_kind <> 'task'::text) OR ((comment_id IS NULL) AND (bound_at IS NOT NULL))))"],
  ['task_attachments_unbound_state_chk', "CHECK (((status <> 'unbound'::text) OR (bound_at IS NULL)))"],
  ['task_attachments_uploader_id_printable_chk', PRINTABLE('uploader_id')],
  ['task_comments_id_task_id_key', 'UNIQUE (id, task_id)'],
  ['task_dependencies_created_by_printable_chk', PRINTABLE('created_by')],
  ['task_dependencies_not_self_chk', 'CHECK ((predecessor_id <> successor_id))'],
  ['task_dependencies_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_dependencies_pkey', 'PRIMARY KEY (predecessor_id, successor_id)'],
  ['task_dependencies_predecessor_fk', 'FOREIGN KEY (predecessor_id, org_id) REFERENCES tasks(id, org_id) ON DELETE CASCADE'],
  ['task_dependencies_successor_fk', 'FOREIGN KEY (successor_id, org_id) REFERENCES tasks(id, org_id) ON DELETE CASCADE'],
  ['task_field_values_field_fk', 'FOREIGN KEY (field_id, org_id) REFERENCES task_fields(id, org_id) ON DELETE CASCADE'],
  ['task_field_values_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_field_values_pkey', 'PRIMARY KEY (task_id, field_id)'],
  ['task_field_values_task_fk', 'FOREIGN KEY (task_id, org_id) REFERENCES tasks(id, org_id) ON DELETE CASCADE'],
  ['task_field_values_updated_by_printable_chk', PRINTABLE('updated_by')],
  ['task_field_values_value_not_json_null_chk', "CHECK ((jsonb_typeof(value) <> 'null'::text))"],
  ['task_fields_config_object_chk', "CHECK ((jsonb_typeof(config) = 'object'::text))"],
  ['task_fields_created_by_printable_chk', PRINTABLE('created_by')],
  ['task_fields_id_generated_chk', GENERATED_ID('id')],
  ['task_fields_id_org_id_key', 'UNIQUE (id, org_id)'],
  ['task_fields_name_nonblank_chk', "CHECK ((btrim(name) <> ''::text))"],
  ['task_fields_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_fields_pkey', 'PRIMARY KEY (id)'],
  ['task_fields_type_chk', IN_LIST('type', ['text', 'number', 'select', 'multiSelect', 'member', 'date'])],
  ['task_list_field_bindings_field_fk', 'FOREIGN KEY (field_id, org_id) REFERENCES task_fields(id, org_id) ON DELETE RESTRICT'],
  ['task_list_field_bindings_list_fk', 'FOREIGN KEY (list_id, org_id) REFERENCES task_lists(id, org_id) ON DELETE CASCADE'],
  ['task_list_field_bindings_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_list_field_bindings_pkey', 'PRIMARY KEY (list_id, field_id)'],
  ['task_list_field_bindings_position_chk', 'CHECK (("position" >= 0))'],
  ['task_record_projection_digest_chk', "CHECK (((projected_digest IS NULL) OR (projected_digest ~ '^[a-f0-9]{64}$'::text)))"],
  ['task_record_projection_last_error_code_chk', ERROR_CODE('last_error')],
  ['task_record_projection_list_id_generated_chk', GENERATED_ID('list_id')],
  ['task_record_projection_pkey', 'PRIMARY KEY (list_id, task_id)'],
  ['task_record_projection_task_id_generated_chk', GENERATED_ID('task_id')],
  ['task_record_projection_version_chk', 'CHECK ((projected_version >= 1))'],
  ['tasks_previous_occurrence_fk', 'FOREIGN KEY (previous_occurrence_id, org_id) REFERENCES tasks(id, org_id)'],
  ['tasks_previous_occurrence_id_generated_chk', GENERATED_ID('previous_occurrence_id')],
  ['tasks_previous_occurrence_not_self_chk', 'CHECK ((previous_occurrence_id <> id))'],
  ['tasks_recurrence_object_chk', "CHECK (((recurrence IS NULL) OR (jsonb_typeof(recurrence) = 'object'::text)))"],
  ['tasks_recurrence_series_fk', 'FOREIGN KEY (recurrence_series_id, org_id) REFERENCES tasks(id, org_id)'],
  ['tasks_recurrence_series_id_generated_chk', GENERATED_ID('recurrence_series_id')],
  ['tasks_recurrence_series_not_self_chk', 'CHECK ((recurrence_series_id <> id))'],
  ['tasks_series_columns_paired_chk', 'CHECK (((recurrence_series_id IS NULL) = (previous_occurrence_id IS NULL)))'],
]

const IDX = (name: string, unique: boolean, table: string, rest: string): [string, string] =>
  [name, `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON public.${table} USING btree ${rest}`]

const EXPECTED_INDEXES: Array<[string, string]> = [
  IDX('idx_tapi_pending', false, 'task_attachment_purge_intents', '(status, created_at)'),
  IDX('idx_tatt_comment', false, 'task_attachments', '(comment_id) WHERE (comment_id IS NOT NULL)'),
  IDX('idx_tatt_task', false, 'task_attachments', '(task_id) WHERE (task_id IS NOT NULL)'),
  IDX('idx_tatt_unbound_sweep', false, 'task_attachments', '(status, created_at)'),
  IDX('idx_tdep_org', false, 'task_dependencies', '(org_id)'),
  IDX('idx_tdep_successor', false, 'task_dependencies', '(successor_id)'),
  IDX('idx_tfld_org', false, 'task_fields', '(org_id)'),
  IDX('idx_tflb_field', false, 'task_list_field_bindings', '(field_id)'),
  IDX('idx_tfv_field', false, 'task_field_values', '(field_id)'),
  IDX('idx_trp_task', false, 'task_record_projection', '(task_id)'),
  IDX('idx_tsk_recurrence_series', false, 'tasks', '(recurrence_series_id) WHERE (recurrence_series_id IS NOT NULL)'),
  IDX('task_attachment_purge_intents_pkey', true, 'task_attachment_purge_intents', '(id)'),
  IDX('task_attachment_purge_intents_storage_key_key', true, 'task_attachment_purge_intents', '(storage_key)'),
  IDX('task_attachments_pkey', true, 'task_attachments', '(id)'),
  IDX('task_attachments_storage_key_key', true, 'task_attachments', '(storage_key)'),
  IDX('task_comments_id_task_id_key', true, 'task_comments', '(id, task_id)'),
  IDX('task_dependencies_pkey', true, 'task_dependencies', '(predecessor_id, successor_id)'),
  IDX('task_field_values_pkey', true, 'task_field_values', '(task_id, field_id)'),
  IDX('task_fields_id_org_id_key', true, 'task_fields', '(id, org_id)'),
  IDX('task_fields_pkey', true, 'task_fields', '(id)'),
  IDX('task_list_field_bindings_pkey', true, 'task_list_field_bindings', '(list_id, field_id)'),
  IDX('task_record_projection_pkey', true, 'task_record_projection', '(list_id, task_id)'),
  IDX('uq_tsk_previous_occurrence', true, 'tasks', '(previous_occurrence_id) WHERE (previous_occurrence_id IS NOT NULL)'),
]

// ── Catalog snapshot (one query runner so the same code serves the pool and a transaction) ──

type Runner = <R>(text: string, params?: unknown[]) => Promise<R[]>

const poolRunner: Runner = async <R>(text: string, params: unknown[] = []) =>
  (await poolManager.get().query(text, params)).rows as R[]

interface Snapshot {
  columns: Column[]
  constraints: Array<[string, string]>
  indexes: Array<[string, string]>
  triggers: Array<[string, string]>
}

async function snapshot(run: Runner): Promise<Snapshot> {
  const tables = [...M5_TABLES]
  const columns = await run<{ t: string; c: string; ty: string; nn: boolean; d: string | null }>(
    `SELECT cl.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty,
            a.attnotnull AS nn, pg_get_expr(ad.adbin, ad.adrelid) AS d
       FROM pg_attribute a
       JOIN pg_class cl ON cl.oid = a.attrelid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE cl.relnamespace = 'public'::regnamespace
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (cl.relname = ANY($1::text[]) OR (cl.relname = 'tasks' AND a.attname = ANY($2::text[])))
      ORDER BY cl.relname, a.attname`,
    [tables, TASKS_COLUMNS],
  )
  const constraints = await run<{ n: string; d: string }>(
    `SELECT c.conname AS n, pg_get_constraintdef(c.oid) AS d
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relnamespace = 'public'::regnamespace
        AND (cl.relname = ANY($1::text[])
             OR (cl.relname = 'tasks' AND c.conname = ANY($2::text[]))
             OR (cl.relname = 'task_comments' AND c.conname = $3))
      ORDER BY c.conname`,
    [tables, TASKS_CONSTRAINTS, COMMENTS_KEY],
  )
  const indexes = await run<{ n: string; d: string }>(
    `SELECT indexname AS n, indexdef AS d
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND (tablename = ANY($1::text[])
             OR (tablename = 'tasks' AND indexname = ANY($2::text[]))
             OR (tablename = 'task_comments' AND indexname = $3))
      ORDER BY indexname`,
    [tables, TASKS_INDEXES, COMMENTS_KEY],
  )
  const triggers = await run<{ n: string; d: string }>(
    `SELECT t.tgname AS n, pg_get_triggerdef(t.oid) AS d
       FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY($1::text[])
      ORDER BY t.tgname`,
    [tables],
  )
  return {
    columns: columns.map((r) => [r.t, r.c, r.ty, r.nn, r.d]),
    constraints: constraints.map((r) => [r.n, r.d]),
    indexes: indexes.map((r) => [r.n, r.d]),
    triggers: triggers.map((r) => [r.n, r.d]),
  }
}

/**
 * Every column, constraint, index and trigger of `tasks` and `task_comments`, M2–M4 objects
 * included: down() must remove exactly the M5 objects from these two tables and up() must add
 * exactly them back.
 */
interface WholeTables {
  columns: Array<[table: string, column: string, type: string, notNull: boolean, defaultExpr: string | null]>
  constraints: Array<[table: string, name: string, def: string]>
  indexes: Array<[table: string, name: string, def: string]>
  triggers: Array<[table: string, name: string, def: string]>
}

const WHOLE_TABLES = ['tasks', 'task_comments']

async function wholeTables(run: Runner): Promise<WholeTables> {
  const columns = await run<{ t: string; c: string; ty: string; nn: boolean; d: string | null }>(
    `SELECT cl.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty,
            a.attnotnull AS nn, pg_get_expr(ad.adbin, ad.adrelid) AS d
       FROM pg_attribute a
       JOIN pg_class cl ON cl.oid = a.attrelid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY($1::text[])
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY cl.relname, a.attname`,
    [WHOLE_TABLES],
  )
  const constraints = await run<{ t: string; n: string; d: string }>(
    `SELECT cl.relname AS t, c.conname AS n, pg_get_constraintdef(c.oid) AS d
       FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY($1::text[])
      ORDER BY cl.relname, c.conname`,
    [WHOLE_TABLES],
  )
  const indexes = await run<{ t: string; n: string; d: string }>(
    `SELECT tablename AS t, indexname AS n, indexdef AS d FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      ORDER BY tablename, indexname`,
    [WHOLE_TABLES],
  )
  const triggers = await run<{ t: string; n: string; d: string }>(
    `SELECT cl.relname AS t, t.tgname AS n, pg_get_triggerdef(t.oid) AS d
       FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY($1::text[])
      ORDER BY cl.relname, t.tgname`,
    [WHOLE_TABLES],
  )
  return {
    columns: columns.map((r) => [r.t, r.c, r.ty, r.nn, r.d]),
    constraints: constraints.map((r) => [r.t, r.n, r.d]),
    indexes: indexes.map((r) => [r.t, r.n, r.d]),
    triggers: triggers.map((r) => [r.t, r.n, r.d]),
  }
}

/** `whole` with the M5 objects of `tasks` and `task_comments` taken out. */
function withoutM5(whole: WholeTables): WholeTables {
  const m5Constraint = (t: string, n: string): boolean =>
    (t === 'tasks' && TASKS_CONSTRAINTS.includes(n)) || (t === 'task_comments' && n === COMMENTS_KEY)
  const m5Index = (t: string, n: string): boolean =>
    (t === 'tasks' && TASKS_INDEXES.includes(n)) || (t === 'task_comments' && n === COMMENTS_KEY)
  return {
    columns: whole.columns.filter(([t, c]) => !(t === 'tasks' && TASKS_COLUMNS.includes(c))),
    constraints: whole.constraints.filter(([t, n]) => !m5Constraint(t, n)),
    indexes: whole.indexes.filter(([t, n]) => !m5Index(t, n)),
    triggers: whole.triggers,
  }
}

const byKey = <T extends unknown[]>(rows: T[]): T[] =>
  [...rows].sort((a, b) => JSON.stringify(a.slice(0, 2)).localeCompare(JSON.stringify(b.slice(0, 2))))

const sortByName = (rows: Array<[string, string]>): Array<[string, string]> =>
  [...rows].sort((a, b) => a[0].localeCompare(b[0]))

// ── Row helpers ──

const projectionKeys: Array<[string, string]> = []

function org(label: string): string {
  return `${ORG_PREFIX}${label}_${STAMP}`
}

function rnd(n: number): string {
  return randomUUID().replace(/-/g, '').slice(0, Math.max(n, 1))
}

const fieldId = (): string => generateTaskDomainId('field', rnd)
const attachmentId = (): string => generateTaskDomainId('attachment', rnd)
const storageKey = (): string => `${STORAGE_PREFIX}${randomUUID()}`
const intentIdFor = (key: string): string => `tpi_${createHash('md5').update(key).digest('hex')}`

async function q(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return (await poolManager.get().query(text, params)).rows
}

async function pgError(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run()
  } catch (err) {
    const e = err as { code?: string; constraint?: string }
    return { code: e.code, constraint: e.constraint }
  }
  return {}
}

async function expectPgError(run: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
  const caught = await pgError(run)
  expect(caught.code, `expected SQLSTATE ${code}`).toBe(code)
  if (constraint) expect(caught.constraint).toBe(constraint)
}

async function insertTask(orgId: string, extra: Record<string, unknown> = {}, id = newTaskId()): Promise<string> {
  const row: Record<string, unknown> = { id, org_id: orgId, title: '备料复核', created_by: `usr_c_${STAMP_HEX}`, ...extra }
  const cols = Object.keys(row)
  await q(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  )
  return id
}

async function insertList(orgId: string): Promise<string> {
  const id = newTaskListId()
  await q(`INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, '备料复核', $3)`, [id, orgId, `usr_c_${STAMP_HEX}`])
  return id
}

async function insertComment(taskId: string): Promise<string> {
  const id = newTaskCommentId()
  await q(`INSERT INTO task_comments (id, task_id, author_id, body) VALUES ($1, $2, $3, '评论')`, [id, taskId, `usr_c_${STAMP_HEX}`])
  return id
}

async function insertField(orgId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = { id: fieldId(), org_id: orgId, type: 'text', name: '备注', created_by: `usr_c_${STAMP_HEX}`, ...extra }
  const cols = Object.keys(row)
  await q(
    `INSERT INTO task_fields (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  )
  return String(row.id)
}

async function insertRow(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cols = Object.keys(row)
  const rows = await q(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    cols.map((c) => row[c]),
  )
  return rows[0]
}

/** A task-level attachment, bound at upload. */
function taskAttachment(orgId: string, taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: attachmentId(),
    org_id: orgId,
    task_id: taskId,
    bind_kind: 'task',
    uploader_id: `usr_u_${STAMP_HEX}`,
    storage_key: storageKey(),
    display_name: '图纸.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    status: 'bound',
    bound_at: new Date(),
    ...extra,
  }
}

/** A comment attachment that is not bound yet. */
function unboundCommentAttachment(orgId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: attachmentId(),
    org_id: orgId,
    bind_kind: 'comment',
    uploader_id: `usr_u_${STAMP_HEX}`,
    storage_key: storageKey(),
    display_name: '照片.png',
    mime_type: 'image/png',
    size_bytes: 2048,
    ...extra,
  }
}

function projectionRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const row = { list_id: newTaskListId(), task_id: newTaskId(), projected_version: 1, ...extra }
  projectionKeys.push([String(row.list_id), String(row.task_id)])
  return row
}

async function cleanup(): Promise<void> {
  const db = poolManager.get()
  const byOrg = 'left(org_id, length($1)) = $1'
  // Unbound attachments do not cascade from a task; their delete writes intents, removed below.
  await db.query(`DELETE FROM task_attachments WHERE ${byOrg}`, [ORG_PREFIX])
  // One statement per table: a series chain goes in the same statement (its FKs are NO ACTION).
  await db.query(`DELETE FROM tasks WHERE ${byOrg}`, [ORG_PREFIX])
  await db.query(`DELETE FROM task_lists WHERE ${byOrg}`, [ORG_PREFIX])
  await db.query(`DELETE FROM task_fields WHERE ${byOrg}`, [ORG_PREFIX])
  await db.query('DELETE FROM task_attachment_purge_intents WHERE left(storage_key, length($1)) = $1', [STORAGE_PREFIX])
  for (const [listId, taskId] of projectionKeys) {
    await db.query('DELETE FROM task_record_projection WHERE list_id = $1 AND task_id = $2', [listId, taskId])
  }
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX })
}

// ── Cells ──

describe('task M5 schema (real db)', () => {
  afterAll(async () => {
    await cleanup()
  })

  describe('catalog pins', () => {
    it('the seven M5 tables, the four tasks columns, the eight tasks constraints and task_comments_id_task_id_key exist', async () => {
      for (const table of M5_TABLES) {
        const rows = await q('SELECT to_regclass($1)::text AS r', [`public.${table}`])
        expect(rows[0].r, table).toBe(table)
      }
      const cols = await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = ANY($1::text[]) ORDER BY column_name`,
        [TASKS_COLUMNS],
      )
      expect(cols.map((r) => r.column_name)).toEqual([...TASKS_COLUMNS].sort())
      const cons = await q(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND conname = ANY($1::text[]) ORDER BY conname`,
        [TASKS_CONSTRAINTS],
      )
      expect(cons.map((r) => r.conname)).toEqual(TASKS_CONSTRAINTS)
      const key = await q(`SELECT 1 FROM pg_constraint WHERE conrelid = 'public.task_comments'::regclass AND conname = $1`, [COMMENTS_KEY])
      expect(key).toHaveLength(1)
    })

    it('column set (name, type, nullability, default) equals the design exactly', async () => {
      const snap = await snapshot(poolRunner)
      expect(byKey(snap.columns)).toEqual(byKey(EXPECTED_COLUMNS))
    })

    it('constraint set (name, definition) equals the design exactly', async () => {
      const snap = await snapshot(poolRunner)
      expect(snap.constraints).toEqual(sortByName(EXPECTED_CONSTRAINTS))
    })

    it('index set (name, definition) equals the design exactly, idx_tsk_recurrence_series and idx_tdep_org included', async () => {
      const snap = await snapshot(poolRunner)
      expect(snap.indexes).toEqual(sortByName(EXPECTED_INDEXES))
      const named = await q(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_tsk_recurrence_series', 'idx_tdep_org') ORDER BY indexname`,
      )
      expect(named.map((r) => r.indexname)).toEqual(['idx_tdep_org', 'idx_tsk_recurrence_series'])
    })

    it('FK actions: series NO ACTION; dependencies, values, list bindings and task attachments CASCADE; field bindings RESTRICT; comment attachments NO ACTION; none deferrable', async () => {
      const rows = await q(
        `SELECT c.conname, c.confrelid::regclass::text AS target, c.confdeltype, c.condeferrable
           FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
          WHERE c.contype = 'f' AND cl.relnamespace = 'public'::regnamespace
            AND (cl.relname = ANY($1::text[]) OR (cl.relname = 'tasks' AND c.conname = ANY($2::text[])))
          ORDER BY c.conname`,
        [[...M5_TABLES], TASKS_CONSTRAINTS],
      )
      expect(rows.map((r) => [r.conname, r.target, r.confdeltype, r.condeferrable])).toEqual([
        ['task_attachments_comment_fk', 'task_comments', 'a', false],
        ['task_attachments_task_fk', 'tasks', 'c', false],
        ['task_dependencies_predecessor_fk', 'tasks', 'c', false],
        ['task_dependencies_successor_fk', 'tasks', 'c', false],
        ['task_field_values_field_fk', 'task_fields', 'c', false],
        ['task_field_values_task_fk', 'tasks', 'c', false],
        ['task_list_field_bindings_field_fk', 'task_fields', 'r', false],
        ['task_list_field_bindings_list_fk', 'task_lists', 'c', false],
        ['tasks_previous_occurrence_fk', 'tasks', 'a', false],
        ['tasks_recurrence_series_fk', 'tasks', 'a', false],
      ])
    })

    it('the mapping table has no FK and no org_id column (lock §4.2, §7)', async () => {
      const fks = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.task_record_projection'::regclass AND contype = 'f'`)
      expect(fks).toEqual([])
      const orgCol = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'task_record_projection' AND column_name = 'org_id'`)
      expect(orgCol).toEqual([])
    })

    it('the row-delete trigger and its function: AFTER DELETE FOR EACH ROW, body calls pg_catalog.md5 only', async () => {
      const snap = await snapshot(poolRunner)
      expect(snap.triggers).toEqual([[
        'task_attachment_purge_on_delete',
        'CREATE TRIGGER task_attachment_purge_on_delete AFTER DELETE ON public.task_attachments FOR EACH ROW EXECUTE FUNCTION task_attachment_enqueue_purge_on_delete()',
      ]])
      const fn = await q(
        `SELECT p.prosrc, p.pronamespace::regnamespace::text AS ns, l.lanname
           FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.proname = 'task_attachment_enqueue_purge_on_delete'`,
      )
      expect(fn).toHaveLength(1)
      expect(fn[0].ns).toBe('public')
      expect(fn[0].lanname).toBe('plpgsql')
      const body = String(fn[0].prosrc)
      expect(body).toContain("'tpi_' || pg_catalog.md5(OLD.storage_key)")
      expect(body).toContain('ON CONFLICT (storage_key) DO NOTHING')
      // Every function call in the body is pg_catalog-qualified.
      expect(body.replace(/pg_catalog\.md5\(/g, '')).not.toMatch(/\bmd5\s*\(/)
    })

    it('no constraint or column default of the M5 tables or the new tasks constraints depends on a function outside pg_catalog (pg_restore empty search_path)', async () => {
      const outside = `
        SELECT cl.relname, p.proname, p.pronamespace::regnamespace::text AS ns
          FROM pg_depend d
          JOIN pg_proc p ON d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid
          JOIN (
            SELECT 'pg_constraint'::regclass AS classid, c.oid AS objid, c.conrelid AS relid, c.conname::text AS name FROM pg_constraint c
            UNION ALL
            SELECT 'pg_attrdef'::regclass, ad.oid, ad.adrelid, NULL FROM pg_attrdef ad
          ) o ON o.classid = d.classid AND o.objid = d.objid
          JOIN pg_class cl ON cl.oid = o.relid
         WHERE cl.relnamespace = 'public'::regnamespace
           AND (cl.relname = ANY($1::text[]) OR (cl.relname = 'tasks' AND o.name = ANY($2::text[])))
           AND p.pronamespace <> 'pg_catalog'::regnamespace`
      expect(await q(outside, [[...M5_TABLES], TASKS_CONSTRAINTS])).toEqual([])
      // Positive control: the same query does see a CHECK that calls a public function.
      const probeTable = `task_m5_dep_probe_${STAMP_HEX}`
      const probeFn = `task_m5_dep_probe_fn_${STAMP_HEX}`
      const PROBE_ROLLBACK = Symbol('dep-probe-rollback')
      let seen: string[] | undefined
      try {
        await poolManager.get().transaction(async (client) => {
          await client.query(`CREATE FUNCTION public.${probeFn}(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT t $$`)
          await client.query(`CREATE TABLE public.${probeTable} (v text CHECK (public.${probeFn}(v) <> ''))`)
          const res = await client.query(outside, [[probeTable], []])
          seen = (res.rows as Array<{ proname: string }>).map((r) => r.proname)
          throw PROBE_ROLLBACK
        })
      } catch (err) {
        if (err !== PROBE_ROLLBACK) throw err
      }
      expect(seen).toEqual([probeFn])
    })

    // RULED(2026-10-09): [S18] [S19] [S22] [S25]. The pure validators and the CHECKs must name the
    // same closed sets, or a value the validator accepts is refused by the database. The purge
    // reasons and the intent statuses have no pure-module counterpart and are pinned above only.
    it('the closed-set CHECKs equal the pure-module constants (field types, attachment mime types, statuses, bind kinds, scan states, size ceiling)', async () => {
      const rows = await q(
        `SELECT c.conname AS n, pg_get_constraintdef(c.oid) AS d FROM pg_constraint c
          WHERE c.conname = ANY($1::text[]) AND c.connamespace = 'public'::regnamespace ORDER BY c.conname`,
        [[
          'task_attachments_bind_kind_chk',
          'task_attachments_mime_type_chk',
          'task_attachments_scan_state_chk',
          'task_attachments_size_chk',
          'task_attachments_status_chk',
          'task_fields_type_chk',
        ]],
      )
      const defs = new Map(rows.map((r) => [String(r.n), String(r.d)]))
      expect(defs.size).toBe(6)
      const listed = (name: string): string[] => {
        const def = defs.get(name) ?? ''
        expect(def, name).toMatch(/= ANY \(ARRAY\[/)
        return [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]).sort()
      }
      const sorted = (values: readonly string[]): string[] => [...values].sort()
      expect(listed('task_fields_type_chk')).toEqual(sorted(TASK_FIELD_TYPES))
      expect(listed('task_attachments_mime_type_chk')).toEqual(sorted(Object.keys(TASK_ATTACHMENT_MIME_EXTENSIONS)))
      expect(listed('task_attachments_status_chk')).toEqual(sorted(TASK_ATTACHMENT_STATUSES))
      expect(listed('task_attachments_bind_kind_chk')).toEqual(sorted(TASK_ATTACHMENT_BIND_KINDS))
      expect(listed('task_attachments_scan_state_chk')).toEqual(sorted(TASK_ATTACHMENT_SCAN_STATES))
      const size = /size_bytes >= (\d+)\) AND \(size_bytes <= (\d+)/.exec(defs.get('task_attachments_size_chk') ?? '')
      expect(size?.slice(1).map(Number)).toEqual([1, TASK_ATTACHMENT_LIMITS.maxFileBytes])
    })
  })

  // RULED(2026-10-09): [S13] [S14] [S16] [S17]. ASSUMPTION(task-m5a): [a-20], [a-06] (D2).
  describe('tasks: milestone, recurrence and the series chain', () => {
    it('is_milestone defaults to false; recurrence accepts an object and refuses an array (tasks_recurrence_object_chk)', async () => {
      const orgId = org('tsk')
      const id = await insertTask(orgId, { recurrence: { freq: 'weekly' } })
      expect(await q('SELECT is_milestone, recurrence FROM tasks WHERE id = $1', [id])).toEqual([{ is_milestone: false, recurrence: { freq: 'weekly' } }])
      await expectPgError(() => insertTask(orgId, { recurrence: JSON.stringify([1]) }), '23514', 'tasks_recurrence_object_chk')
      await expectPgError(() => insertTask(orgId, { recurrence: JSON.stringify('weekly') }), '23514', 'tasks_recurrence_object_chk')
    })

    it('a chain first → second → third is accepted; both series columns on each later occurrence', async () => {
      const orgId = org('tsk')
      const first = await insertTask(orgId)
      const second = await insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: first })
      const third = await insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: second })
      const rows = await q(
        'SELECT id, recurrence_series_id, previous_occurrence_id FROM tasks WHERE id = ANY($1::text[]) ORDER BY created_at, id',
        [[first, second, third]],
      )
      expect(rows).toHaveLength(3)
      expect(rows.find((r) => r.id === third)).toEqual({ id: third, recurrence_series_id: first, previous_occurrence_id: second })
    })

    it('tasks_series_columns_paired_chk: one series column without the other is 23514', async () => {
      const orgId = org('tsk')
      const first = await insertTask(orgId)
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: first }), '23514', 'tasks_series_columns_paired_chk')
      await expectPgError(() => insertTask(orgId, { previous_occurrence_id: first }), '23514', 'tasks_series_columns_paired_chk')
    })

    it('tasks_recurrence_series_not_self_chk: recurrence_series_id = id is 23514', async () => {
      const orgId = org('tsk')
      const first = await insertTask(orgId)
      const id = newTaskId()
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: id, previous_occurrence_id: first }, id), '23514', 'tasks_recurrence_series_not_self_chk')
    })

    it('tasks_previous_occurrence_not_self_chk: previous_occurrence_id = id is 23514', async () => {
      const orgId = org('tsk')
      const first = await insertTask(orgId)
      const id = newTaskId()
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: id }, id), '23514', 'tasks_previous_occurrence_not_self_chk')
    })

    it('the four-conjunct CHECK on both series columns: leading _, trailing _, __ and a space are 23514', async () => {
      const orgId = org('tsk')
      const first = await insertTask(orgId)
      for (const bad of ['_tsk_a', 'tsk_a_', 'tsk__a', 'tsk a']) {
        await expectPgError(() => insertTask(orgId, { recurrence_series_id: bad, previous_occurrence_id: first }), '23514', 'tasks_recurrence_series_id_generated_chk')
        await expectPgError(() => insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: bad }), '23514', 'tasks_previous_occurrence_id_generated_chk')
      }
    })

    it('tasks_recurrence_series_fk / tasks_previous_occurrence_fk: a missing task or a task of another org is 23503', async () => {
      const orgId = org('tsk')
      const first = await insertTask(orgId)
      const foreign = await insertTask(org('tsk2'))
      const missing = newTaskId()
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: missing, previous_occurrence_id: first }), '23503', 'tasks_recurrence_series_fk')
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: foreign, previous_occurrence_id: first }), '23503', 'tasks_recurrence_series_fk')
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: missing }), '23503', 'tasks_previous_occurrence_fk')
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: foreign }), '23503', 'tasks_previous_occurrence_fk')
    })

    it('uq_tsk_previous_occurrence: a second successor of one occurrence is 23505', async () => {
      const orgId = org('tsk')
      const first = await insertTask(orgId)
      await insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: first })
      await expectPgError(() => insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: first }), '23505', 'uq_tsk_previous_occurrence')
    })

    it('hard delete (design §2.2): an earlier occurrence alone is refused by the NO ACTION FK; the whole chain in one statement goes', async () => {
      const orgId = org('chain')
      const first = await insertTask(orgId)
      const second = await insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: first })
      const third = await insertTask(orgId, { recurrence_series_id: first, previous_occurrence_id: second })
      await expectPgError(() => q('DELETE FROM tasks WHERE id = $1', [second]), '23503', 'tasks_previous_occurrence_fk')
      await expectPgError(() => q('DELETE FROM tasks WHERE id = $1', [first]), '23503')
      await q('DELETE FROM tasks WHERE id = ANY($1::text[])', [[first, second, third]])
      expect(await q('SELECT id FROM tasks WHERE id = ANY($1::text[])', [[first, second, third]])).toEqual([])
    })
  })

  // RULED(2026-10-09): [S11] [S12]. D4 (ASSUMPTION).
  describe('task_dependencies', () => {
    it('an edge is accepted; the same edge twice is 23505 (task_dependencies_pkey); a self loop is 23514', async () => {
      const orgId = org('dep')
      const a = await insertTask(orgId)
      const b = await insertTask(orgId)
      const edge = { predecessor_id: a, successor_id: b, org_id: orgId, created_by: 'usr_d' }
      const row = await insertRow('task_dependencies', edge)
      expect(row.created_at).toBeInstanceOf(Date)
      await expectPgError(() => insertRow('task_dependencies', edge), '23505', 'task_dependencies_pkey')
      await insertRow('task_dependencies', { ...edge, predecessor_id: b, successor_id: a })
      await expectPgError(() => insertRow('task_dependencies', { ...edge, successor_id: a }), '23514', 'task_dependencies_not_self_chk')
    })

    it('printable org_id and created_by (23514)', async () => {
      const orgId = org('dep')
      const a = await insertTask(orgId)
      const b = await insertTask(orgId)
      await expectPgError(() => insertRow('task_dependencies', { predecessor_id: a, successor_id: b, org_id: orgId, created_by: 'usr d' }), '23514', 'task_dependencies_created_by_printable_chk')
      // An org id with a space cannot match a task row, but the CHECK fires first.
      await expectPgError(() => insertRow('task_dependencies', { predecessor_id: a, successor_id: b, org_id: 'org x', created_by: 'usr_d' }), '23514', 'task_dependencies_org_id_printable_chk')
    })

    it('both FKs refuse a missing task and a task of another org (23503); a hard delete of either end cascades', async () => {
      const orgId = org('dep')
      const a = await insertTask(orgId)
      const b = await insertTask(orgId)
      const foreign = await insertTask(org('dep2'))
      await expectPgError(() => insertRow('task_dependencies', { predecessor_id: newTaskId(), successor_id: b, org_id: orgId, created_by: 'usr_d' }), '23503', 'task_dependencies_predecessor_fk')
      await expectPgError(() => insertRow('task_dependencies', { predecessor_id: foreign, successor_id: b, org_id: orgId, created_by: 'usr_d' }), '23503', 'task_dependencies_predecessor_fk')
      await expectPgError(() => insertRow('task_dependencies', { predecessor_id: a, successor_id: foreign, org_id: orgId, created_by: 'usr_d' }), '23503', 'task_dependencies_successor_fk')
      await insertRow('task_dependencies', { predecessor_id: a, successor_id: b, org_id: orgId, created_by: 'usr_d' })
      await q('DELETE FROM tasks WHERE id = $1', [b])
      expect(await q('SELECT 1 FROM task_dependencies WHERE predecessor_id = $1', [a])).toEqual([])
    })
  })

  // RULED(2026-10-09): [S25] [S26]. D10 (ASSUMPTION).
  describe('task_fields', () => {
    it('defaults: config {} and both timestamps; a tfld_ id passes the four-conjunct CHECK', async () => {
      const id = await insertField(org('fld'))
      const rows = await q('SELECT config, created_at, updated_at FROM task_fields WHERE id = $1', [id])
      expect(rows[0].config).toEqual({})
      expect(rows[0].created_at).toBeInstanceOf(Date)
      expect(id).toMatch(/^tfld_[A-Za-z0-9]+$/)
    })

    it('the six types are accepted, any other is 23514 (task_fields_type_chk)', async () => {
      const orgId = org('fld')
      for (const type of ['text', 'number', 'select', 'multiSelect', 'member', 'date']) await insertField(orgId, { type })
      await expectPgError(() => insertField(orgId, { type: 'multiselect' }), '23514', 'task_fields_type_chk')
      await expectPgError(() => insertField(orgId, { type: 'attachment' }), '23514', 'task_fields_type_chk')
    })

    it('id, org_id, created_by, name and config CHECKs (23514); a duplicate id is 23505', async () => {
      const orgId = org('fld')
      await expectPgError(() => insertField(orgId, { id: 'tfld__x' }), '23514', 'task_fields_id_generated_chk')
      await expectPgError(() => insertField(orgId, { id: '_tfld_x' }), '23514', 'task_fields_id_generated_chk')
      await expectPgError(() => insertField('org x'), '23514', 'task_fields_org_id_printable_chk')
      await expectPgError(() => insertField(orgId, { created_by: 'usr x' }), '23514', 'task_fields_created_by_printable_chk')
      await expectPgError(() => insertField(orgId, { name: '   ' }), '23514', 'task_fields_name_nonblank_chk')
      await expectPgError(() => insertField(orgId, { config: JSON.stringify([]) }), '23514', 'task_fields_config_object_chk')
      const id = await insertField(orgId)
      await expectPgError(() => insertField(orgId, { id }), '23505', 'task_fields_pkey')
    })
  })

  // ASSUMPTION(task-m5a): [a-08] [a-42]. RULED(2026-10-09): [S26].
  describe('task_list_field_bindings', () => {
    it('a binding is accepted with defaults position 0, hidden false; the same pair twice is 23505; position -1 is 23514', async () => {
      const orgId = org('flb')
      const listId = await insertList(orgId)
      const field = await insertField(orgId)
      const row = await insertRow('task_list_field_bindings', { list_id: listId, field_id: field, org_id: orgId })
      expect([row.position, row.hidden]).toEqual([0, false])
      await expectPgError(() => insertRow('task_list_field_bindings', { list_id: listId, field_id: field, org_id: orgId }), '23505', 'task_list_field_bindings_pkey')
      const other = await insertField(orgId)
      await expectPgError(() => insertRow('task_list_field_bindings', { list_id: listId, field_id: other, org_id: orgId, position: -1 }), '23514', 'task_list_field_bindings_position_chk')
      // No (list_id, position) unique constraint: two bindings may share a position mid-reorder.
      await insertRow('task_list_field_bindings', { list_id: listId, field_id: other, org_id: orgId, position: 0 })
      const third = await insertField(orgId)
      await expectPgError(() => insertRow('task_list_field_bindings', { list_id: listId, field_id: third, org_id: 'org x' }), '23514', 'task_list_field_bindings_org_id_printable_chk')
    })

    it('list and field FKs refuse a missing row and a row of another org (23503)', async () => {
      const orgId = org('flb')
      const listId = await insertList(orgId)
      const field = await insertField(orgId)
      const foreignList = await insertList(org('flb2'))
      const foreignField = await insertField(org('flb2'))
      await expectPgError(() => insertRow('task_list_field_bindings', { list_id: newTaskListId(), field_id: field, org_id: orgId }), '23503', 'task_list_field_bindings_list_fk')
      await expectPgError(() => insertRow('task_list_field_bindings', { list_id: foreignList, field_id: field, org_id: orgId }), '23503', 'task_list_field_bindings_list_fk')
      await expectPgError(() => insertRow('task_list_field_bindings', { list_id: listId, field_id: fieldId(), org_id: orgId }), '23503', 'task_list_field_bindings_field_fk')
      await expectPgError(() => insertRow('task_list_field_bindings', { list_id: listId, field_id: foreignField, org_id: orgId }), '23503', 'task_list_field_bindings_field_fk')
    })

    it('deleting a bound field definition is refused (RESTRICT, 23503); deleting the list cascades the binding, then the field deletes', async () => {
      const orgId = org('flb')
      const listId = await insertList(orgId)
      const field = await insertField(orgId)
      await insertRow('task_list_field_bindings', { list_id: listId, field_id: field, org_id: orgId })
      await expectPgError(() => q('DELETE FROM task_fields WHERE id = $1', [field]), '23503', 'task_list_field_bindings_field_fk')
      await q('DELETE FROM task_lists WHERE id = $1', [listId])
      expect(await q('SELECT 1 FROM task_list_field_bindings WHERE field_id = $1', [field])).toEqual([])
      await q('DELETE FROM task_fields WHERE id = $1', [field])
      expect(await q('SELECT 1 FROM task_fields WHERE id = $1', [field])).toEqual([])
    })
  })

  // ASSUMPTION(task-m5a): [a-09]. RULED(2026-10-09): [S26]. D17 (ASSUMPTION).
  describe('task_field_values', () => {
    it('a value is accepted; the same (task, field) twice is 23505; JSON null is 23514; SQL NULL is 23502', async () => {
      const orgId = org('tfv')
      const taskId = await insertTask(orgId)
      const field = await insertField(orgId)
      const row = await insertRow('task_field_values', { task_id: taskId, field_id: field, org_id: orgId, value: JSON.stringify('A'), updated_by: 'usr_v' })
      expect(row.value).toBe('A')
      await expectPgError(() => insertRow('task_field_values', { task_id: taskId, field_id: field, org_id: orgId, value: JSON.stringify('B'), updated_by: 'usr_v' }), '23505', 'task_field_values_pkey')
      const other = await insertField(orgId)
      await expectPgError(() => insertRow('task_field_values', { task_id: taskId, field_id: other, org_id: orgId, value: 'null', updated_by: 'usr_v' }), '23514', 'task_field_values_value_not_json_null_chk')
      await expectPgError(() => insertRow('task_field_values', { task_id: taskId, field_id: other, org_id: orgId, value: null, updated_by: 'usr_v' }), '23502')
      await expectPgError(() => insertRow('task_field_values', { task_id: taskId, field_id: other, org_id: orgId, value: '0', updated_by: 'usr v' }), '23514', 'task_field_values_updated_by_printable_chk')
      await expectPgError(() => insertRow('task_field_values', { task_id: taskId, field_id: other, org_id: 'org x', value: '0', updated_by: 'usr_v' }), '23514', 'task_field_values_org_id_printable_chk')
    })

    it('task and field FKs refuse a row of another org (23503); a hard-deleted task or field takes its values', async () => {
      const orgId = org('tfv')
      const taskId = await insertTask(orgId)
      const field = await insertField(orgId)
      const foreignTask = await insertTask(org('tfv2'))
      const foreignField = await insertField(org('tfv2'))
      await expectPgError(() => insertRow('task_field_values', { task_id: foreignTask, field_id: field, org_id: orgId, value: '1', updated_by: 'usr_v' }), '23503', 'task_field_values_task_fk')
      await expectPgError(() => insertRow('task_field_values', { task_id: taskId, field_id: foreignField, org_id: orgId, value: '1', updated_by: 'usr_v' }), '23503', 'task_field_values_field_fk')
      await insertRow('task_field_values', { task_id: taskId, field_id: field, org_id: orgId, value: '1', updated_by: 'usr_v' })
      await q('DELETE FROM task_fields WHERE id = $1', [field])
      expect(await q('SELECT 1 FROM task_field_values WHERE task_id = $1', [taskId])).toEqual([])
      const field2 = await insertField(orgId)
      await insertRow('task_field_values', { task_id: taskId, field_id: field2, org_id: orgId, value: '2', updated_by: 'usr_v' })
      await q('DELETE FROM tasks WHERE id = $1', [taskId])
      expect(await q('SELECT 1 FROM task_field_values WHERE field_id = $1', [field2])).toEqual([])
    })
  })

  // RULED(2026-10-09): [S18] [S19] [S22] [S30]. ASSUMPTION(task-m5a): [a-07].
  describe('task_attachments', () => {
    it('accepted rows: a task-level attachment, an unbound comment attachment, a bound comment attachment, a deleted one; defaults unbound / unscanned', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      const commentId = await insertComment(taskId)
      await insertRow('task_attachments', taskAttachment(orgId, taskId))
      const unbound = await insertRow('task_attachments', unboundCommentAttachment(orgId))
      expect([unbound.status, unbound.scan_state, unbound.task_id, unbound.comment_id, unbound.bound_at]).toEqual(['unbound', 'unscanned', null, null, null])
      await insertRow('task_attachments', unboundCommentAttachment(orgId, { task_id: taskId, comment_id: commentId, status: 'bound', bound_at: new Date() }))
      await insertRow('task_attachments', taskAttachment(orgId, taskId, { status: 'deleted', deleted_at: new Date(), deleted_by: 'usr_x' }))
    })

    it('id, printable and display-name CHECKs (23514); storage_key unique (23505)', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { id: 'tatt__x' })), '23514', 'task_attachments_id_generated_chk')
      await expectPgError(() => insertRow('task_attachments', unboundCommentAttachment('org x')), '23514', 'task_attachments_org_id_printable_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { uploader_id: 'usr x' })), '23514', 'task_attachments_uploader_id_printable_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { storage_key: `${STORAGE_PREFIX}a b` })), '23514', 'task_attachments_storage_key_printable_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { status: 'deleted', deleted_at: new Date(), deleted_by: 'usr x' })), '23514', 'task_attachments_deleted_by_printable_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { display_name: '  ' })), '23514', 'task_attachments_display_name_nonblank_chk')
      const key = storageKey()
      await insertRow('task_attachments', taskAttachment(orgId, taskId, { storage_key: key }))
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { storage_key: key })), '23505', 'task_attachments_storage_key_key')
    })

    it('the same id twice with a different storage key is 23505 (task_attachments_pkey)', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      const first = await insertRow('task_attachments', taskAttachment(orgId, taskId))
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { id: first.id })), '23505', 'task_attachments_pkey')
    })

    it('closed sets (23514): mime type, bind kind, status, scan state; size is 1..10485760', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      for (const mime of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv']) {
        await insertRow('task_attachments', taskAttachment(orgId, taskId, { mime_type: mime }))
      }
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { mime_type: 'image/svg+xml' })), '23514', 'task_attachments_mime_type_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { bind_kind: 'list' })), '23514', 'task_attachments_bind_kind_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { status: 'purged' })), '23514', 'task_attachments_status_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { scan_state: 'pending' })), '23514', 'task_attachments_scan_state_chk')
      await insertRow('task_attachments', taskAttachment(orgId, taskId, { size_bytes: 1 }))
      await insertRow('task_attachments', taskAttachment(orgId, taskId, { size_bytes: 10485760 }))
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { size_bytes: 0 })), '23514', 'task_attachments_size_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { size_bytes: 10485761 })), '23514', 'task_attachments_size_chk')
    })

    it('row-state CHECKs, each refused by its own name (23514)', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      const commentId = await insertComment(taskId)
      // An unbound row that names a task.
      await expectPgError(() => insertRow('task_attachments', unboundCommentAttachment(orgId, { task_id: taskId })), '23514', 'task_attachments_bound_has_task_chk')
      // 'unbound' with a bound time.
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { status: 'unbound' })), '23514', 'task_attachments_unbound_state_chk')
      // 'bound' without a bound time.
      await expectPgError(() => insertRow('task_attachments', unboundCommentAttachment(orgId, { status: 'bound' })), '23514', 'task_attachments_bound_state_chk')
      // A task-level attachment is never unbound.
      await expectPgError(() => insertRow('task_attachments', unboundCommentAttachment(orgId, { bind_kind: 'task' })), '23514', 'task_attachments_task_kind_chk')
      // A task-level attachment carries no comment id.
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { comment_id: commentId })), '23514', 'task_attachments_task_kind_chk')
      // Named cell (§6.3): an unbound comment attachment that carries a comment id.
      await expectPgError(() => insertRow('task_attachments', unboundCommentAttachment(orgId, { comment_id: commentId })), '23514', 'task_attachments_comment_kind_chk')
      // A bound comment attachment without a comment id.
      await expectPgError(() => insertRow('task_attachments', unboundCommentAttachment(orgId, { task_id: taskId, status: 'bound', bound_at: new Date() })), '23514', 'task_attachments_comment_kind_chk')
      // 'deleted' without a delete time, and a delete time on a row that is not 'deleted'.
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { status: 'deleted' })), '23514', 'task_attachments_deleted_state_chk')
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, taskId, { deleted_at: new Date() })), '23514', 'task_attachments_deleted_state_chk')
    })

    it('task FK refuses a task of another org (23503); comment FK refuses a comment of another task (23503)', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      const otherTask = await insertTask(orgId)
      const foreign = await insertTask(org('att2'))
      const otherComment = await insertComment(otherTask)
      await expectPgError(() => insertRow('task_attachments', taskAttachment(orgId, foreign)), '23503', 'task_attachments_task_fk')
      await expectPgError(
        () => insertRow('task_attachments', unboundCommentAttachment(orgId, { task_id: taskId, comment_id: otherComment, status: 'bound', bound_at: new Date() })),
        '23503',
        'task_attachments_comment_fk',
      )
    })

    it('named cell (§6.3, S19 column set): binding an unbound comment attachment without writing task_id is 23514 (bound_has_task); the same statement with task_id succeeds', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      const commentId = await insertComment(taskId)
      const att = await insertRow('task_attachments', unboundCommentAttachment(orgId))
      await expectPgError(
        () => q(`UPDATE task_attachments SET status = 'bound', comment_id = $2, bound_at = now() WHERE id = $1 AND status = 'unbound'`, [att.id, commentId]),
        '23514',
        'task_attachments_bound_has_task_chk',
      )
      const res = await poolManager.get().query(
        `UPDATE task_attachments SET status = 'bound', comment_id = $2, task_id = $3, bound_at = now() WHERE id = $1 AND status = 'unbound'`,
        [att.id, commentId, taskId],
      )
      expect(res.rowCount).toBe(1)
    })

    it('named cell (§6.3): deleting the comment of a bound comment attachment directly is refused by task_attachments_comment_fk (23503)', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      const commentId = await insertComment(taskId)
      await insertRow('task_attachments', unboundCommentAttachment(orgId, { task_id: taskId, comment_id: commentId, status: 'bound', bound_at: new Date() }))
      await expectPgError(() => q('DELETE FROM task_comments WHERE id = $1', [commentId]), '23503', 'task_attachments_comment_fk')
    })

    it('named cell (§6.3): a hard delete of a task with a comment attachment succeeds; comment and attachment go in the same statement and the trigger writes the intent', async () => {
      const orgId = org('att')
      const taskId = await insertTask(orgId)
      const commentId = await insertComment(taskId)
      const key = storageKey()
      const att = await insertRow('task_attachments', unboundCommentAttachment(orgId, { task_id: taskId, comment_id: commentId, status: 'bound', bound_at: new Date(), storage_key: key }))
      await q('DELETE FROM tasks WHERE id = $1', [taskId])
      expect(await q('SELECT 1 FROM task_attachments WHERE id = $1', [att.id])).toEqual([])
      expect(await q('SELECT 1 FROM task_comments WHERE id = $1', [commentId])).toEqual([])
      const intents = await q('SELECT id, storage_key, reason, status, attempts, fence FROM task_attachment_purge_intents WHERE storage_key = $1', [key])
      expect(intents).toEqual([{ id: intentIdFor(key), storage_key: key, reason: 'row_deleted', status: 'pending', attempts: 0, fence: '0' }])
    })
  })

  // RULED(2026-10-09): [S23]. ASSUMPTION(task-m5a): [a-22]; D1 (ASSUMPTION).
  describe('task_attachment_purge_intents and the row-delete trigger', () => {
    it('a direct DELETE of an attachment writes one row_deleted intent with id tpi_ || md5(storage_key); an existing intent for the key is kept (ON CONFLICT DO NOTHING)', async () => {
      const orgId = org('tpi')
      const key1 = storageKey()
      const key2 = storageKey()
      const a1 = await insertRow('task_attachments', unboundCommentAttachment(orgId, { storage_key: key1 }))
      const a2 = await insertRow('task_attachments', unboundCommentAttachment(orgId, { storage_key: key2 }))
      await insertRow('task_attachment_purge_intents', { id: intentIdFor(key2), storage_key: key2, reason: 'user_removed' })
      await q('DELETE FROM task_attachments WHERE id = ANY($1::text[])', [[a1.id, a2.id]])
      const rows = await q('SELECT id, storage_key, reason FROM task_attachment_purge_intents WHERE storage_key = ANY($1::text[]) ORDER BY reason', [[key1, key2]])
      expect(rows).toEqual([
        { id: intentIdFor(key1), storage_key: key1, reason: 'row_deleted' },
        { id: intentIdFor(key2), storage_key: key2, reason: 'user_removed' },
      ])
    })

    it('an UPDATE of an attachment writes no intent (the trigger is on DELETE only)', async () => {
      const orgId = org('tpi')
      const taskId = await insertTask(orgId)
      const key = storageKey()
      const att = await insertRow('task_attachments', taskAttachment(orgId, taskId, { storage_key: key }))
      await q(`UPDATE task_attachments SET status = 'deleted', deleted_at = now(), deleted_by = 'usr_x' WHERE id = $1`, [att.id])
      expect(await q('SELECT 1 FROM task_attachment_purge_intents WHERE storage_key = $1', [key])).toEqual([])
    })

    it('CHECKs (23514): id, storage key, reason, status, attempts, last_error code; storage_key unique (23505); defaults', async () => {
      const ins = (extra: Record<string, unknown>) => {
        const key = storageKey()
        return insertRow('task_attachment_purge_intents', { id: intentIdFor(key), storage_key: key, reason: 'unbound_ttl', ...extra })
      }
      const row = await ins({})
      expect([row.status, row.attempts, row.fence, row.last_error, row.lease_expires_at, row.purged_at]).toEqual(['pending', 0, '0', null, null, null])
      for (const reason of ['user_removed', 'unbound_ttl', 'reconciler_orphan', 'row_deleted']) await ins({ reason })
      for (const status of ['pending', 'in_progress', 'done', 'dead_letter']) await ins({ status })
      await ins({ last_error: 'STORAGE_NOT_FOUND' })
      await expectPgError(() => ins({ id: 'tpi__x' }), '23514', 'task_attachment_purge_intents_id_generated_chk')
      await expectPgError(() => ins({ storage_key: `${STORAGE_PREFIX}a b` }), '23514', 'task_attachment_purge_intents_storage_key_printable_chk')
      await expectPgError(() => ins({ reason: 'expired' }), '23514', 'task_attachment_purge_intents_reason_chk')
      await expectPgError(() => ins({ status: 'failed' }), '23514', 'task_attachment_purge_intents_status_chk')
      await expectPgError(() => ins({ attempts: -1 }), '23514', 'task_attachment_purge_intents_attempts_chk')
      await expectPgError(() => ins({ last_error: 'disk full' }), '23514', 'task_attachment_purge_intents_last_error_code_chk')
      const key = storageKey()
      await insertRow('task_attachment_purge_intents', { id: intentIdFor(key), storage_key: key, reason: 'unbound_ttl' })
      await expectPgError(() => insertRow('task_attachment_purge_intents', { id: `tpi_${rnd(32)}`, storage_key: key, reason: 'unbound_ttl' }), '23505', 'task_attachment_purge_intents_storage_key_key')
    })

    it('the same id twice with a different storage key is 23505 (task_attachment_purge_intents_pkey)', async () => {
      const key = storageKey()
      const id = intentIdFor(key)
      await insertRow('task_attachment_purge_intents', { id, storage_key: key, reason: 'unbound_ttl' })
      await expectPgError(() => insertRow('task_attachment_purge_intents', { id, storage_key: storageKey(), reason: 'unbound_ttl' }), '23505', 'task_attachment_purge_intents_pkey')
    })
  })

  // ASSUMPTION(task-m5a): [a-06] [a-21]; lock §4.2, §7.
  describe('task_record_projection', () => {
    it('a row for a list and task that do not exist is accepted (no FK); the same pair twice is 23505', async () => {
      const row = projectionRow({ projected_digest: 'a'.repeat(64), last_error: 'SHEET_MISSING' })
      const stored = await insertRow('task_record_projection', row)
      expect(stored.created_at).toBeInstanceOf(Date)
      await expectPgError(() => insertRow('task_record_projection', { ...row }), '23505', 'task_record_projection_pkey')
    })

    it('CHECKs (23514): both key columns four-conjunct, version >= 1, digest 64 lower-case hex, last_error code', async () => {
      await expectPgError(() => insertRow('task_record_projection', projectionRow({ list_id: 'tlst__x' })), '23514', 'task_record_projection_list_id_generated_chk')
      await expectPgError(() => insertRow('task_record_projection', projectionRow({ list_id: 'tlst_x_' })), '23514', 'task_record_projection_list_id_generated_chk')
      await expectPgError(() => insertRow('task_record_projection', projectionRow({ task_id: '_tsk_x' })), '23514', 'task_record_projection_task_id_generated_chk')
      await expectPgError(() => insertRow('task_record_projection', projectionRow({ projected_version: 0 })), '23514', 'task_record_projection_version_chk')
      await expectPgError(() => insertRow('task_record_projection', projectionRow({ projected_digest: 'A'.repeat(64) })), '23514', 'task_record_projection_digest_chk')
      await expectPgError(() => insertRow('task_record_projection', projectionRow({ projected_digest: 'a'.repeat(63) })), '23514', 'task_record_projection_digest_chk')
      await expectPgError(() => insertRow('task_record_projection', projectionRow({ last_error: 'boom' })), '23514', 'task_record_projection_last_error_code_chk')
    })
  })

  describe('task_comments_id_task_id_key', () => {
    it('the key is UNIQUE (id, task_id) and is the target of task_attachments_comment_fk; a repeated (id, task_id) is 23505 (the primary key refuses it too)', async () => {
      const orgId = org('cmt')
      const taskId = await insertTask(orgId)
      const commentId = await insertComment(taskId)
      const key = await q(
        `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'public.task_comments'::regclass AND conname = $1`,
        [COMMENTS_KEY],
      )
      expect(key).toEqual([{ d: 'UNIQUE (id, task_id)' }])
      const target = await q(
        `SELECT conname FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.task_comments'::regclass
            AND conrelid = 'public.task_attachments'::regclass`,
      )
      expect(target).toEqual([{ conname: 'task_attachments_comment_fk' }])
      await expectPgError(() => q(`INSERT INTO task_comments (id, task_id, author_id, body) VALUES ($1, $2, 'usr_c', 'x')`, [commentId, taskId]), '23505')
    })
  })

  // RULED(2026-10-09): [S09]; ASSUMPTION(task-m5a): [a-36]. Design §4.2, §6.1.
  describe('M5|7 lock-order control — real paths', () => {
    let seen = new Map<number, TaskLockOrderLock[]>()
    const record = (): void => {
      seen = new Map()
      setTaskLockOrderRecorderForTests((instance, lock) => {
        const list = seen.get(instance) ?? []
        list.push(lock)
        seen.set(instance, list)
      })
    }

    afterEach(() => {
      setTaskLockOrderRecorderForTests(null)
    })

    it('a structure write through withOrgStructure (set parent) records exactly one sequence, non-empty, first item rank 1 (structure)', async () => {
      const orgId = org('lock')
      const actor = `usr_l_${STAMP_HEX}`
      const root = await createTask({ orgId, creatorId: actor, title: '根', assignees: [actor] })
      const child = await createTask({ orgId, creatorId: actor, title: '子', assignees: [actor] })
      record()
      const result = await setTaskParent({ orgId, actorId: actor, taskId: child.id, body: { parentId: root.id } })
      expect(result.parentId).toBe(root.id)
      const sequences = [...seen.values()]
      expect(sequences).toEqual([['structure']])
      expect(sequences[0].length).toBeGreaterThan(0)
      expect(sequences[0][0]).toBe('structure')
    })

    it('task creation records exactly one sequence: [structure]', async () => {
      const orgId = org('lock')
      const actor = `usr_l_${STAMP_HEX}`
      record()
      await createTask({ orgId, creatorId: actor, title: '建任务', assignees: [actor] })
      expect([...seen.values()]).toEqual([['structure']])
    })

    it('one scheduler tick records exactly one sequence: [leader]', async () => {
      record()
      const scheduler = new TaskScheduler({
        scanJobs: [],
        connectLeaderClient: () => poolManager.get().getInternalPool().connect() as unknown as Promise<LeaderClient>,
        logger: { info: () => undefined, warn: () => undefined },
      })
      const result = await scheduler.runTick()
      expect(result.leader).toBe(true)
      expect([...seen.values()]).toEqual([['leader']])
    })

    async function inTransaction(run: (client: pg.Client) => Promise<void>): Promise<void> {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
      await client.connect()
      try {
        await client.query('BEGIN')
        await run(client)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.end()
      }
    }

    async function heldAdvisory(client: pg.Client): Promise<number> {
      const rows = await client.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`)
      return Number(rows.rows[0].n)
    }

    it('reverse order in one transaction: projection then structure throws TaskLockOrderViolation; the structure lock is not taken', async () => {
      await inTransaction(async (client) => {
        const locks = withTaskLockOrder((sql, params) => client.query(sql, params))
        await locks.projection(newTaskListId(), newTaskId())
        const caught = await locks.structure(org('lock')).then(() => null, (error: unknown) => error)
        expect(caught).toBeInstanceOf(TaskLockOrderViolation)
        expect(await heldAdvisory(client)).toBe(1)
      })
    })

    it('leader coexistence, structure first: the leader lock throws and is not taken', async () => {
      await inTransaction(async (client) => {
        const locks = withTaskLockOrder((sql, params) => client.query(sql, params))
        await locks.structure(org('lock'))
        const caught = await locks.schedulerLeader().then(() => null, (error: unknown) => error)
        expect(caught).toBeInstanceOf(TaskLockOrderViolation)
        expect(await heldAdvisory(client)).toBe(1)
      })
    })

    it('leader coexistence, leader first: the structure lock throws and is not taken', async () => {
      await inTransaction(async (client) => {
        const locks = withTaskLockOrder((sql, params) => client.query(sql, params))
        await locks.schedulerLeader()
        const caught = await locks.structure(org('lock')).then(() => null, (error: unknown) => error)
        expect(caught).toBeInstanceOf(TaskLockOrderViolation)
        expect(await heldAdvisory(client)).toBe(1)
      })
    })
  })

  describe('migration down() then up() inside one rolled-back transaction', () => {
    const ROLLBACK = Symbol('task-m5-schema-rollback')
    let pool: Pool | undefined
    let kdb: Kysely<unknown> | undefined
    let fieldsOidBefore: string | undefined
    let sentinelFieldId: string | undefined

    afterAll(async () => {
      if (kdb) await kdb.destroy()
      else if (pool) await pool.end()
    })

    it('down() removes the seven tables, the trigger function, the four tasks columns with their constraints and indexes, and task_comments_id_task_id_key, and nothing else of tasks or task_comments; up() restores identical columns, constraints, indexes and trigger', async () => {
      const url = process.env.DATABASE_URL
      if (!url) throw new Error('DATABASE_URL is required')
      sentinelFieldId = await insertField(org('rollback'))
      fieldsOidBefore = String((await q(`SELECT 'public.task_fields'::regclass::oid::text AS oid`))[0].oid)
      pool = new Pool({ connectionString: url, max: 1 })
      kdb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
      let reachedEnd = false
      try {
        await kdb.transaction().execute(async (trx) => {
          const run: Runner = async <R>(text: string, params: unknown[] = []) =>
            (await trx.executeQuery(CompiledQuery.raw(text, params))).rows as R[]
          const before = await snapshot(run)
          expect(byKey(before.columns)).toEqual(byKey(EXPECTED_COLUMNS))
          expect(before.constraints).toEqual(sortByName(EXPECTED_CONSTRAINTS))
          expect(before.indexes).toEqual(sortByName(EXPECTED_INDEXES))
          const wholeBefore = await wholeTables(run)
          const wholeExpectedDown = withoutM5(wholeBefore)
          // The M5 objects of the two tables are all in the snapshot that down() takes away.
          expect(wholeBefore.columns.length - wholeExpectedDown.columns.length).toBe(TASKS_COLUMNS.length)
          expect(wholeBefore.constraints.length - wholeExpectedDown.constraints.length).toBe(TASKS_CONSTRAINTS.length + 1)
          expect(wholeBefore.indexes.length - wholeExpectedDown.indexes.length).toBe(TASKS_INDEXES.length + 1)

          await m5Down(trx)
          for (const table of M5_TABLES) {
            const rows = await run<{ r: string | null }>(`SELECT to_regclass('public.${table}')::text AS r`)
            expect(rows[0].r, table).toBeNull()
          }
          const empty = await snapshot(run)
          expect(empty).toEqual({ columns: [], constraints: [], indexes: [], triggers: [] })
          const named = await run(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_tsk_recurrence_series', 'idx_tdep_org')`)
          expect(named).toEqual([])
          const fn = await run(`SELECT 1 FROM pg_proc WHERE proname = 'task_attachment_enqueue_purge_on_delete'`)
          expect(fn).toEqual([])
          const tasks = await run<{ r: string | null }>(`SELECT to_regclass('public.tasks')::text AS r`)
          expect(tasks[0].r).toBe('tasks')
          const m4Key = await run(`SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND conname = 'tasks_id_org_id_key'`)
          expect(m4Key).toHaveLength(1)
          // Whole tables: down() removed the M5 objects of tasks and task_comments and nothing else.
          expect(await wholeTables(run)).toEqual(wholeExpectedDown)

          await m5Up(trx)
          const after = await snapshot(run)
          expect(byKey(after.columns)).toEqual(byKey(before.columns))
          expect(after.constraints).toEqual(before.constraints)
          expect(after.indexes).toEqual(before.indexes)
          expect(after.triggers).toEqual(before.triggers)
          // Whole tables: up() added back exactly what down() removed, and nothing else.
          expect(await wholeTables(run)).toEqual(wholeBefore)
          reachedEnd = true
          throw ROLLBACK
        })
      } catch (err) {
        if (err !== ROLLBACK) throw err
      }
      expect(reachedEnd).toBe(true)
    })

    it('after the rollback the same task_fields table (same OID, sentinel row), the tasks columns and the trigger are there', async () => {
      for (const table of M5_TABLES) {
        const rows = await q('SELECT to_regclass($1)::text AS r', [`public.${table}`])
        expect(rows[0].r, table).toBe(table)
      }
      expect(fieldsOidBefore).toBeDefined()
      const oid = await q(`SELECT 'public.task_fields'::regclass::oid::text AS oid`)
      expect(oid[0].oid).toBe(fieldsOidBefore)
      expect((await q('SELECT count(*)::int AS n FROM task_fields WHERE id = $1', [sentinelFieldId]))[0].n).toBe(1)
      const snap = await snapshot(poolRunner)
      expect(byKey(snap.columns)).toEqual(byKey(EXPECTED_COLUMNS))
      expect(snap.triggers).toHaveLength(1)
    })
  })
})
