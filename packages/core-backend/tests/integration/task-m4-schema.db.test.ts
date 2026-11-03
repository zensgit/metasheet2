/**
 * M4 schema shape (design task-m4-pr3a-backend-design-20260930.md §2, §10.2).
 *
 * Pins the exact column / constraint / index sets of the eight M4 tables, `tasks.remind_at` and
 * `tasks_id_org_id_key` against the design, exercises every CHECK / unique / FK behaviour the
 * design names (including the composite org FKs, ASSUMPTION(task-m4): [own-37]), and runs the
 * migration's own down() then up() inside one transaction on one connection, compares the catalog
 * snapshots, and rolls back (§2.3). This file does not start MetaSheetServer.
 */
import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { down as m4Down, up as m4Up } from '../../src/db/migrations/zzzz20261009130000_create_task_m4_tables'
import { newTaskGroupId, newTaskId, newTaskListEventId, newTaskListId } from '../../src/services/task-ids-runtime'
import { dropTaskM4Fixtures } from '../helpers/task-m4-fixtures'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-schema.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4schema_'
const STAMP = randomUUID()

const M4_TABLES = [
  'task_lists',
  'task_list_members',
  'task_list_items',
  'task_groups',
  'task_group_items',
  'task_list_events',
  'task_user_settings',
  'task_notification_deliveries',
] as const

// ── Pins (hand-checked against design §2.2; text is PostgreSQL's normalized catalog form) ──

type Column = [table: string, column: string, type: string, notNull: boolean, defaultExpr: string | null]

const TSTZ = 'timestamp with time zone'

// Pinned values that depend on ruled items, RULED(2026-10-07): [R03] (tasks.remind_at), [R02]
// (task_user_settings defaults), [R07] (time_zone), [R23] (uuid id), [R11] (task_groups scope
// columns); and on unruled ones, ASSUMPTION(task-m4): [D1] (outbox shape, org_id without default),
// [dev-01] (no task_lists.owner_id), [own-03] (task_lists.icon), [own-37] (org_id on the list and
// group items).
const EXPECTED_COLUMNS: Column[] = [
  ['task_group_items', 'created_at', TSTZ, true, 'now()'],
  ['task_group_items', 'group_id', 'text', true, null],
  ['task_group_items', 'org_id', 'text', true, null],
  ['task_group_items', 'position', 'integer', true, '0'],
  ['task_group_items', 'task_id', 'text', true, null],
  ['task_groups', 'created_at', TSTZ, true, 'now()'],
  ['task_groups', 'id', 'text', true, null],
  ['task_groups', 'is_default', 'boolean', true, 'false'],
  ['task_groups', 'list_id', 'text', false, null],
  ['task_groups', 'name', 'text', true, null],
  ['task_groups', 'org_id', 'text', true, null],
  ['task_groups', 'position', 'integer', true, '0'],
  ['task_groups', 'scope', 'text', true, null],
  ['task_groups', 'updated_at', TSTZ, true, 'now()'],
  ['task_groups', 'user_id', 'text', false, null],
  ['task_list_events', 'actor_id', 'text', true, null],
  ['task_list_events', 'event_type', 'text', true, null],
  ['task_list_events', 'id', 'text', true, null],
  ['task_list_events', 'list_id', 'text', true, null],
  ['task_list_events', 'occurred_at', TSTZ, true, 'now()'],
  ['task_list_events', 'payload', 'jsonb', true, "'{}'::jsonb"],
  ['task_list_items', 'created_at', TSTZ, true, 'now()'],
  ['task_list_items', 'list_id', 'text', true, null],
  ['task_list_items', 'org_id', 'text', true, null],
  ['task_list_items', 'task_id', 'text', true, null],
  ['task_list_members', 'created_at', TSTZ, true, 'now()'],
  ['task_list_members', 'list_id', 'text', true, null],
  ['task_list_members', 'role', 'text', true, null],
  ['task_list_members', 'user_id', 'text', true, null],
  ['task_lists', 'archived_at', TSTZ, false, null],
  ['task_lists', 'created_at', TSTZ, true, 'now()'],
  ['task_lists', 'created_by', 'text', true, null],
  ['task_lists', 'icon', 'text', false, null],
  ['task_lists', 'id', 'text', true, null],
  ['task_lists', 'name', 'text', true, null],
  ['task_lists', 'org_id', 'text', true, null],
  ['task_lists', 'updated_at', TSTZ, true, 'now()'],
  ['task_notification_deliveries', 'attempt_count', 'integer', true, '0'],
  ['task_notification_deliveries', 'channel', 'text', true, null],
  ['task_notification_deliveries', 'claim_expires_at', TSTZ, false, null],
  ['task_notification_deliveries', 'claim_worker_id', 'text', false, null],
  ['task_notification_deliveries', 'claimed_at', TSTZ, false, null],
  ['task_notification_deliveries', 'created_at', TSTZ, true, 'now()'],
  ['task_notification_deliveries', 'delivered_at', TSTZ, false, null],
  ['task_notification_deliveries', 'id', 'uuid', true, 'gen_random_uuid()'],
  ['task_notification_deliveries', 'last_attempt_at', TSTZ, false, null],
  ['task_notification_deliveries', 'last_error', 'text', false, null],
  ['task_notification_deliveries', 'next_attempt_at', TSTZ, true, 'now()'],
  ['task_notification_deliveries', 'org_id', 'text', true, null],
  ['task_notification_deliveries', 'payload', 'jsonb', true, "'{}'::jsonb"],
  ['task_notification_deliveries', 'recipient_role', 'text', true, null],
  ['task_notification_deliveries', 'recipient_user_id', 'text', true, null],
  ['task_notification_deliveries', 'redelivery_safe', 'boolean', true, 'false'],
  ['task_notification_deliveries', 'source_id', 'text', false, null],
  ['task_notification_deliveries', 'source_key', 'text', true, null],
  ['task_notification_deliveries', 'source_type', 'text', true, null],
  ['task_notification_deliveries', 'status', 'text', true, "'pending'::text"],
  ['task_notification_deliveries', 'updated_at', TSTZ, true, 'now()'],
  ['task_user_settings', 'badge_scope', 'text', true, "'overdue'::text"],
  ['task_user_settings', 'created_at', TSTZ, true, 'now()'],
  ['task_user_settings', 'daily_reminder_enabled', 'boolean', true, 'false'],
  ['task_user_settings', 'default_remind_policy', 'jsonb', true, `'{"mode": "default"}'::jsonb`],
  ['task_user_settings', 'org_id', 'text', true, null],
  ['task_user_settings', 'time_zone', 'text', false, null],
  ['task_user_settings', 'updated_at', TSTZ, true, 'now()'],
  ['task_user_settings', 'user_id', 'text', true, null],
  ['tasks', 'remind_at', TSTZ, false, null],
]

const GENERATED_ID = (col: string): string =>
  `CHECK (((${col} ~ '^[!-~]+$'::text) AND (${col} !~ '__'::text) AND (${col} !~ '^_'::text) AND (${col} !~ '_$'::text)))`
const PRINTABLE = (col: string): string => `CHECK ((${col} ~ '^[!-~]+$'::text))`
const IN_LIST = (col: string, values: string[]): string =>
  `CHECK ((${col} = ANY (ARRAY[${values.map((v) => `'${v}'::text`).join(', ')}])))`

const LIST_EVENT_TYPES = [
  'created', 'renamed', 'archived', 'unarchived', 'owner_transferred',
  'member_added', 'member_removed', 'member_role_changed',
  'item_added', 'item_removed',
  'group_created', 'group_renamed', 'group_deleted',
  'field_bound', 'field_unbound',
]

// RULED(2026-10-07): [R12] (member roles), [R11] [R23] (group scope rules, tgrp_/tlev_ id
// CHECKs), [R02] [R07] (badge_scope set, daily-needs-time-zone), [R13] (ON DELETE CASCADE, soft
// delete does not cascade), [R14] (no hard limits). ASSUMPTION(task-m4): [D1] (outbox status /
// role sets), [own-37] (composite org FKs and their (id, org_id) targets).
const EXPECTED_CONSTRAINTS: Array<[string, string]> = [
  ['task_group_items_group_fk', 'FOREIGN KEY (group_id, org_id) REFERENCES task_groups(id, org_id) ON DELETE CASCADE'],
  ['task_group_items_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_group_items_pkey', 'PRIMARY KEY (group_id, task_id)'],
  ['task_group_items_position_chk', 'CHECK (("position" >= 0))'],
  ['task_group_items_task_fk', 'FOREIGN KEY (task_id, org_id) REFERENCES tasks(id, org_id) ON DELETE CASCADE'],
  ['task_groups_id_generated_chk', GENERATED_ID('id')],
  ['task_groups_id_org_id_key', 'UNIQUE (id, org_id)'],
  ['task_groups_list_fk', 'FOREIGN KEY (list_id, org_id) REFERENCES task_lists(id, org_id) ON DELETE CASCADE'],
  ['task_groups_name_nonblank_chk', "CHECK ((btrim(name) <> ''::text))"],
  ['task_groups_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_groups_pkey', 'PRIMARY KEY (id)'],
  ['task_groups_position_chk', 'CHECK (("position" >= 0))'],
  ['task_groups_scope_chk', IN_LIST('scope', ['list', 'user'])],
  ['task_groups_scope_owner_chk', "CHECK ((((scope = 'list'::text) AND (list_id IS NOT NULL) AND (user_id IS NULL)) OR ((scope = 'user'::text) AND (user_id IS NOT NULL) AND (list_id IS NULL))))"],
  ['task_groups_user_printable_chk', "CHECK (((user_id IS NULL) OR (user_id ~ '^[!-~]+$'::text)))"],
  ['task_list_events_actor_printable_chk', PRINTABLE('actor_id')],
  ['task_list_events_id_generated_chk', GENERATED_ID('id')],
  ['task_list_events_list_fk', 'FOREIGN KEY (list_id) REFERENCES task_lists(id) ON DELETE CASCADE'],
  ['task_list_events_pkey', 'PRIMARY KEY (id)'],
  ['task_list_events_type_chk', IN_LIST('event_type', LIST_EVENT_TYPES)],
  ['task_list_items_list_fk', 'FOREIGN KEY (list_id, org_id) REFERENCES task_lists(id, org_id) ON DELETE CASCADE'],
  ['task_list_items_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_list_items_pkey', 'PRIMARY KEY (list_id, task_id)'],
  ['task_list_items_task_fk', 'FOREIGN KEY (task_id, org_id) REFERENCES tasks(id, org_id) ON DELETE CASCADE'],
  ['task_list_members_list_fk', 'FOREIGN KEY (list_id) REFERENCES task_lists(id) ON DELETE CASCADE'],
  ['task_list_members_pkey', 'PRIMARY KEY (list_id, user_id)'],
  ['task_list_members_role_chk', IN_LIST('role', ['read', 'edit', 'owner'])],
  ['task_list_members_user_printable_chk', PRINTABLE('user_id')],
  ['task_lists_created_by_printable_chk', PRINTABLE('created_by')],
  ['task_lists_id_generated_chk', GENERATED_ID('id')],
  ['task_lists_id_org_id_key', 'UNIQUE (id, org_id)'],
  ['task_lists_name_nonblank_chk', "CHECK ((btrim(name) <> ''::text))"],
  ['task_lists_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_lists_pkey', 'PRIMARY KEY (id)'],
  ['task_notification_deliveries_attempt_count_chk', 'CHECK ((attempt_count >= 0))'],
  ['task_notification_deliveries_delivered_status_chk', "CHECK (((delivered_at IS NULL) OR (status = 'sent'::text)))"],
  ['task_notification_deliveries_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_notification_deliveries_pkey', 'PRIMARY KEY (id)'],
  ['task_notification_deliveries_recipient_printable_chk', PRINTABLE('recipient_user_id')],
  ['task_notification_deliveries_role_chk', IN_LIST('recipient_role', ['creator', 'assignee', 'follower', 'list_member'])],
  ['task_notification_deliveries_status_chk', IN_LIST('status', ['pending', 'sending', 'sent', 'retrying', 'failed', 'skipped', 'outcome_unknown'])],
  ['task_user_settings_badge_scope_chk', IN_LIST('badge_scope', ['off', 'overdue', 'overdue_or_today'])],
  ['task_user_settings_daily_needs_tz_chk', 'CHECK (((daily_reminder_enabled = false) OR (time_zone IS NOT NULL)))'],
  ['task_user_settings_org_id_printable_chk', PRINTABLE('org_id')],
  ['task_user_settings_pkey', 'PRIMARY KEY (user_id, org_id)'],
  ['task_user_settings_user_printable_chk', PRINTABLE('user_id')],
  ['tasks_id_org_id_key', 'UNIQUE (id, org_id)'],
]

const IDX = (name: string, unique: boolean, table: string, rest: string): [string, string] =>
  [name, `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON public.${table} USING btree ${rest}`]

// RULED(2026-10-07): [R06] (idx_tsk_remind), [R12] (uq_tlsm_owner), [R11] (uq_tgrp_*_default).
// ASSUMPTION(task-m4): [own-26] (the idx_tsk_remind predicate), [D1] (outbox one unique + three
// non-unique), [own-23] (five extra indexes), [own-37] (the three (id, org_id) unique indexes).
const EXPECTED_INDEXES: Array<[string, string]> = [
  IDX('idx_tgri_task', false, 'task_group_items', '(task_id)'),
  IDX('idx_tgrp_list', false, 'task_groups', '(list_id) WHERE (list_id IS NOT NULL)'),
  IDX('idx_tgrp_user', false, 'task_groups', '(org_id, user_id) WHERE (user_id IS NOT NULL)'),
  IDX('idx_tlev_list_time', false, 'task_list_events', '(list_id, occurred_at DESC)'),
  IDX('idx_tlsm_user', false, 'task_list_members', '(user_id)'),
  IDX('idx_tsk_remind', false, 'tasks', '(remind_at) WHERE (remind_at IS NOT NULL)'),
  IDX('idx_tski_task', false, 'task_list_items', '(task_id)'),
  IDX('idx_tskn_claim', false, 'task_notification_deliveries', '(status, next_attempt_at)'),
  IDX('idx_tskn_reclaim', false, 'task_notification_deliveries', '(status, claim_expires_at)'),
  IDX('idx_tskn_source', false, 'task_notification_deliveries', '(org_id, source_type, source_id)'),
  IDX('task_group_items_pkey', true, 'task_group_items', '(group_id, task_id)'),
  IDX('task_groups_id_org_id_key', true, 'task_groups', '(id, org_id)'),
  IDX('task_groups_pkey', true, 'task_groups', '(id)'),
  IDX('task_list_events_pkey', true, 'task_list_events', '(id)'),
  IDX('task_list_items_pkey', true, 'task_list_items', '(list_id, task_id)'),
  IDX('task_list_members_pkey', true, 'task_list_members', '(list_id, user_id)'),
  IDX('task_lists_id_org_id_key', true, 'task_lists', '(id, org_id)'),
  IDX('task_lists_pkey', true, 'task_lists', '(id)'),
  IDX('task_notification_deliveries_pkey', true, 'task_notification_deliveries', '(id)'),
  IDX('task_user_settings_pkey', true, 'task_user_settings', '(user_id, org_id)'),
  IDX('tasks_id_org_id_key', true, 'tasks', '(id, org_id)'),
  IDX('uq_tgrp_list_default', true, 'task_groups', "(list_id) WHERE ((scope = 'list'::text) AND is_default)"),
  IDX('uq_tgrp_user_default', true, 'task_groups', "(org_id, user_id) WHERE ((scope = 'user'::text) AND is_default)"),
  IDX('uq_tlsm_owner', true, 'task_list_members', "(list_id) WHERE (role = 'owner'::text)"),
  IDX('uq_tskn_source_key', true, 'task_notification_deliveries', '(org_id, source_key)'),
]

// ── Catalog snapshot (one query runner so the same code serves the pool and a transaction) ──

type Runner = <R>(text: string, params?: unknown[]) => Promise<R[]>

const poolRunner: Runner = async <R>(text: string, params: unknown[] = []) =>
  (await poolManager.get().query(text, params)).rows as R[]

interface Snapshot {
  columns: Column[]
  constraints: Array<[string, string]>
  indexes: Array<[string, string]>
}

async function snapshot(run: Runner): Promise<Snapshot> {
  const tables = [...M4_TABLES]
  const columns = await run<{ t: string; c: string; ty: string; nn: boolean; d: string | null }>(
    `SELECT cl.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty,
            a.attnotnull AS nn, pg_get_expr(ad.adbin, ad.adrelid) AS d
       FROM pg_attribute a
       JOIN pg_class cl ON cl.oid = a.attrelid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE cl.relnamespace = 'public'::regnamespace
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (cl.relname = ANY($1::text[]) OR (cl.relname = 'tasks' AND a.attname = 'remind_at'))
      ORDER BY cl.relname, a.attname`,
    [tables],
  )
  const constraints = await run<{ n: string; d: string }>(
    `SELECT c.conname AS n, pg_get_constraintdef(c.oid) AS d
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relnamespace = 'public'::regnamespace
        AND (cl.relname = ANY($1::text[]) OR (cl.relname = 'tasks' AND c.conname = 'tasks_id_org_id_key'))
      ORDER BY c.conname`,
    [tables],
  )
  const indexes = await run<{ n: string; d: string }>(
    `SELECT indexname AS n, indexdef AS d
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND (tablename = ANY($1::text[]) OR (tablename = 'tasks' AND indexname IN ('idx_tsk_remind', 'tasks_id_org_id_key')))
      ORDER BY indexname`,
    [tables],
  )
  return {
    columns: columns.map((r) => [r.t, r.c, r.ty, r.nn, r.d]),
    constraints: constraints.map((r) => [r.n, r.d]),
    indexes: indexes.map((r) => [r.n, r.d]),
  }
}

const byKey = <T extends unknown[]>(rows: T[]): T[] =>
  [...rows].sort((a, b) => JSON.stringify(a.slice(0, 2)).localeCompare(JSON.stringify(b.slice(0, 2))))

// ── Row helpers ──

function org(label: string): string {
  return `${ORG_PREFIX}${label}_${STAMP}`
}

async function q(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return (await poolManager.get().query(text, params)).rows
}

async function expectPgError(run: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
  let caught: { code?: string; constraint?: string } | undefined
  try {
    await run()
  } catch (err) {
    caught = err as { code?: string; constraint?: string }
  }
  expect(caught, `expected SQLSTATE ${code}`).toBeDefined()
  expect(caught?.code).toBe(code)
  if (constraint) expect(caught?.constraint).toBe(constraint)
}

async function insertTask(orgId: string): Promise<string> {
  const id = newTaskId()
  await q(`INSERT INTO tasks (id, org_id, title, created_by) VALUES ($1, $2, '备料复核', $3)`, [id, orgId, `usr_c_${STAMP}`])
  return id
}

async function insertList(orgId: string, name = '备料复核'): Promise<string> {
  const id = newTaskListId()
  await q(`INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)`, [id, orgId, name, `usr_c_${STAMP}`])
  return id
}

async function insertListGroup(orgId: string, listId: string, isDefault: boolean): Promise<string> {
  const id = newTaskGroupId()
  await q(
    `INSERT INTO task_groups (id, org_id, scope, list_id, name, is_default) VALUES ($1, $2, 'list', $3, '分组', $4)`,
    [id, orgId, listId, isDefault],
  )
  return id
}

async function insertOutbox(orgId: string, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {
    org_id: orgId,
    source_type: 'task',
    source_key: `key_${randomUUID()}`,
    recipient_user_id: `usr_r_${STAMP}`,
    recipient_role: 'assignee',
    channel: 'dingtalk',
    ...overrides,
  }
  const cols = Object.keys(row)
  const rows = await q(
    `INSERT INTO task_notification_deliveries (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    cols.map((c) => row[c]),
  )
  return rows[0]
}

// ── Cells ──

describe('task M4 schema (real db)', () => {
  afterAll(async () => {
    await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX })
  })

  describe('catalog pins', () => {
    it('the eight M4 tables, tasks.remind_at and tasks_id_org_id_key exist', async () => {
      for (const table of M4_TABLES) {
        const rows = await q('SELECT to_regclass($1)::text AS r', [`public.${table}`])
        expect(rows[0].r, table).toBe(table)
      }
      const col = await q(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'remind_at'`,
      )
      expect(col).toHaveLength(1)
    })

    it('column set (name, type, nullability, default) equals the design exactly', async () => {
      const snap = await snapshot(poolRunner)
      expect(byKey(snap.columns)).toEqual(byKey(EXPECTED_COLUMNS))
    })

    it('constraint set (name, definition) equals the design exactly', async () => {
      const snap = await snapshot(poolRunner)
      expect(snap.constraints).toEqual([...EXPECTED_CONSTRAINTS].sort((a, b) => a[0].localeCompare(b[0])))
    })

    it('index set (name, definition) equals the design exactly, incl. idx_tski_task and the outbox indexes', async () => {
      const snap = await snapshot(poolRunner)
      expect(snap.indexes).toEqual([...EXPECTED_INDEXES].sort((a, b) => a[0].localeCompare(b[0])))
    })

    it('every FK into tasks / task_lists / task_groups is ON DELETE CASCADE and not deferrable', async () => {
      const rows = await q(
        `SELECT c.conname, c.confrelid::regclass::text AS target, c.confdeltype, c.condeferrable
           FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
          WHERE c.contype = 'f' AND cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY($1::text[])
          ORDER BY c.conname`,
        [[...M4_TABLES]],
      )
      expect(rows.map((r) => [r.conname, r.target])).toEqual([
        ['task_group_items_group_fk', 'task_groups'],
        ['task_group_items_task_fk', 'tasks'],
        ['task_groups_list_fk', 'task_lists'],
        ['task_list_events_list_fk', 'task_lists'],
        ['task_list_items_list_fk', 'task_lists'],
        ['task_list_items_task_fk', 'tasks'],
        ['task_list_members_list_fk', 'task_lists'],
      ])
      for (const r of rows) {
        expect(r.confdeltype, String(r.conname)).toBe('c')
        expect(r.condeferrable, String(r.conname)).toBe(false)
      }
    })

    it('no constraint or column default on the M4 tables depends on a function outside pg_catalog (pg_restore empty search_path)', async () => {
      const outside = `
        SELECT cl.relname, p.proname, p.pronamespace::regnamespace::text AS ns
          FROM pg_depend d
          JOIN pg_proc p ON d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid
          JOIN (
            SELECT 'pg_constraint'::regclass AS classid, c.oid AS objid, c.conrelid AS relid FROM pg_constraint c
            UNION ALL
            SELECT 'pg_attrdef'::regclass, ad.oid, ad.adrelid FROM pg_attrdef ad
          ) o ON o.classid = d.classid AND o.objid = d.objid
          JOIN pg_class cl ON cl.oid = o.relid
         WHERE cl.relnamespace = 'public'::regnamespace
           AND cl.relname = ANY($1::text[])
           AND p.pronamespace <> 'pg_catalog'::regnamespace`
      expect(await q(outside, [[...M4_TABLES]])).toEqual([])

      // Positive control: the same query does see a CHECK that calls a public function.
      const probeTable = `task_m4_dep_probe_${STAMP.replace(/-/g, '')}`
      const probeFn = `task_m4_dep_probe_fn_${STAMP.replace(/-/g, '')}`
      const PROBE_ROLLBACK = Symbol('dep-probe-rollback')
      let seen: string[] | undefined
      try {
        await poolManager.get().transaction(async (client) => {
          await client.query(`CREATE FUNCTION public.${probeFn}(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT t $$`)
          await client.query(`CREATE TABLE public.${probeTable} (v text CHECK (public.${probeFn}(v) <> ''))`)
          const res = await client.query(outside, [[probeTable]])
          seen = (res.rows as Array<{ proname: string }>).map((r) => r.proname)
          throw PROBE_ROLLBACK
        })
      } catch (err) {
        if (err !== PROBE_ROLLBACK) throw err
      }
      expect(seen).toEqual([probeFn])
      expect(await q('SELECT to_regclass($1)::text AS r', [`public.${probeTable}`])).toEqual([{ r: null }])
    })
  })

  // RULED(2026-10-07): [R23] (uuid id). ASSUMPTION(task-m4): [D1] (outbox shape).
  describe('outbox (task_notification_deliveries)', () => {
    it('org_id has no default: an insert without it is 23502', async () => {
      await expectPgError(() => q(
        `INSERT INTO task_notification_deliveries (source_type, source_key, recipient_user_id, recipient_role, channel)
         VALUES ('task', $1, 'usr_x', 'assignee', 'dingtalk')`,
        [`key_${randomUUID()}`],
      ), '23502')
    })

    it("recipient_role 'observer' is 23514", async () => {
      await expectPgError(() => insertOutbox(org('ob'), { recipient_role: 'observer' }), '23514', 'task_notification_deliveries_role_chk')
    })

    it("status 'outcome_unknown' is insertable and defaults are uuid id / pending / 0 / false / {}", async () => {
      const row = await insertOutbox(org('ob'), { status: 'outcome_unknown' })
      expect(row.status).toBe('outcome_unknown')
      const plain = await insertOutbox(org('ob'))
      expect(String(plain.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(plain.status).toBe('pending')
      expect(plain.attempt_count).toBe(0)
      expect(plain.redelivery_safe).toBe(false)
      expect(plain.payload).toEqual({})
      expect(plain.next_attempt_at).toBeInstanceOf(Date)
    })

    it('the same (org_id, source_key) twice is 23505; another org may reuse the key', async () => {
      const key = `key_${randomUUID()}`
      await insertOutbox(org('ob'), { source_key: key })
      await expectPgError(() => insertOutbox(org('ob'), { source_key: key }), '23505', 'uq_tskn_source_key')
      await insertOutbox(org('ob2'), { source_key: key })
    })

    it("delivered_at requires status 'sent'; attempt_count is non-negative", async () => {
      await expectPgError(() => insertOutbox(org('ob'), { delivered_at: new Date() }), '23514', 'task_notification_deliveries_delivered_status_chk')
      await insertOutbox(org('ob'), { delivered_at: new Date(), status: 'sent' })
      await expectPgError(() => insertOutbox(org('ob'), { attempt_count: -1 }), '23514', 'task_notification_deliveries_attempt_count_chk')
    })
  })

  // RULED(2026-10-07): [R12]
  describe('list members', () => {
    it('a second owner in the same list is 23505; owners in two lists are fine', async () => {
      const orgId = org('mem')
      const listA = await insertList(orgId)
      const listB = await insertList(orgId)
      await q(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, 'usr_o1', 'owner')`, [listA])
      await q(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, 'usr_o1', 'owner')`, [listB])
      await q(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, 'usr_e1', 'edit')`, [listA])
      await expectPgError(
        () => q(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, 'usr_o2', 'owner')`, [listA]),
        '23505',
        'uq_tlsm_owner',
      )
    })

    it("role 'admin' is 23514", async () => {
      const listId = await insertList(org('mem'))
      await expectPgError(
        () => q(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, 'usr_a', 'admin')`, [listId]),
        '23514',
        'task_list_members_role_chk',
      )
    })
  })

  // RULED(2026-10-07): [R11] [R23]
  describe('groups', () => {
    it('a second default group in the same list is 23505', async () => {
      const orgId = org('grp')
      const listId = await insertList(orgId)
      await insertListGroup(orgId, listId, true)
      await insertListGroup(orgId, listId, false)
      await expectPgError(() => insertListGroup(orgId, listId, true), '23505', 'uq_tgrp_list_default')
    })

    it('a second user-scope default group for the same (org_id, user_id) is 23505; another org is fine', async () => {
      const orgId = org('grp')
      const ins = (o: string) => q(
        `INSERT INTO task_groups (id, org_id, scope, user_id, name, is_default) VALUES ($1, $2, 'user', 'usr_g', '默认', true)`,
        [newTaskGroupId(), o],
      )
      await ins(orgId)
      await expectPgError(() => ins(orgId), '23505', 'uq_tgrp_user_default')
      await ins(org('grp2'))
    })

    it("scope 'list' with a null list_id is 23514", async () => {
      await expectPgError(() => q(
        `INSERT INTO task_groups (id, org_id, scope, name) VALUES ($1, $2, 'list', '分组')`,
        [newTaskGroupId(), org('grp')],
      ), '23514', 'task_groups_scope_owner_chk')
    })

    it("scope 'user' that also carries a list_id is 23514", async () => {
      const orgId = org('grp')
      const listId = await insertList(orgId)
      await expectPgError(() => q(
        `INSERT INTO task_groups (id, org_id, scope, list_id, user_id, name) VALUES ($1, $2, 'user', $3, 'usr_g', '分组')`,
        [newTaskGroupId(), orgId, listId],
      ), '23514', 'task_groups_scope_owner_chk')
    })

    it('negative positions are 23514 on groups and group items', async () => {
      const orgId = org('grp')
      const listId = await insertList(orgId)
      await expectPgError(() => q(
        `INSERT INTO task_groups (id, org_id, scope, list_id, name, position) VALUES ($1, $2, 'list', $3, '分组', -1)`,
        [newTaskGroupId(), orgId, listId],
      ), '23514', 'task_groups_position_chk')
      const groupId = await insertListGroup(orgId, listId, false)
      const taskId = await insertTask(orgId)
      await expectPgError(() => q(
        `INSERT INTO task_group_items (group_id, task_id, org_id, position) VALUES ($1, $2, $3, -1)`,
        [groupId, taskId, orgId],
      ), '23514', 'task_group_items_position_chk')
    })
  })

  // RULED(2026-10-07): [R02] [R07]
  describe('user settings', () => {
    it("badge_scope 'all_open' is 23514", async () => {
      await expectPgError(() => q(
        `INSERT INTO task_user_settings (user_id, org_id, badge_scope) VALUES ('usr_s', $1, 'all_open')`,
        [org('set')],
      ), '23514', 'task_user_settings_badge_scope_chk')
    })

    it('daily_reminder_enabled = true with a null time_zone is 23514; with a time_zone it is fine', async () => {
      await expectPgError(() => q(
        `INSERT INTO task_user_settings (user_id, org_id, daily_reminder_enabled) VALUES ('usr_s', $1, true)`,
        [org('set')],
      ), '23514', 'task_user_settings_daily_needs_tz_chk')
      await q(
        `INSERT INTO task_user_settings (user_id, org_id, daily_reminder_enabled, time_zone) VALUES ('usr_s', $1, true, 'Asia/Shanghai')`,
        [org('set')],
      )
    })

    it("defaults: badge_scope 'overdue', daily reminder off, remind policy {mode: default}", async () => {
      const rows = await q(
        `INSERT INTO task_user_settings (user_id, org_id) VALUES ('usr_s', $1) RETURNING *`,
        [org('set2')],
      )
      expect(rows[0].badge_scope).toBe('overdue')
      expect(rows[0].daily_reminder_enabled).toBe(false)
      expect(rows[0].default_remind_policy).toEqual({ mode: 'default' })
      expect(rows[0].time_zone).toBeNull()
    })
  })

  describe('list events', () => {
    it('a word outside the closed set is 23514', async () => {
      const listId = await insertList(org('ev'))
      await expectPgError(() => q(
        `INSERT INTO task_list_events (id, list_id, actor_id, event_type) VALUES ($1, $2, 'usr_a', 'deleted')`,
        [newTaskListEventId(), listId],
      ), '23514', 'task_list_events_type_chk')
    })

    it.each(LIST_EVENT_TYPES)('event_type %s is insertable', async (word) => {
      const listId = await insertList(org('ev'))
      await q(
        `INSERT INTO task_list_events (id, list_id, actor_id, event_type) VALUES ($1, $2, 'usr_a', $3)`,
        [newTaskListEventId(), listId, word],
      )
    })
  })

  // RULED(2026-10-07): [R23] (tgrp_ / tlev_ prefixes)
  describe('generated ids (four-conjunct CHECK)', () => {
    const shapes = [
      ['leading _', (p: string) => `_${p}_abc`],
      ['trailing _', (p: string) => `${p}_abc_`],
      ['double __', (p: string) => `${p}__abc`],
    ] as const

    const cases = (['tlst', 'tgrp', 'tlev'] as const).flatMap((prefix) =>
      shapes.map(([shape, make]) => [prefix, shape, make(prefix)] as const))

    it.each(cases)('%s id with %s is 23514', async (prefix, _shape, badId) => {
      const orgId = org('ids')
      if (prefix === 'tlst') {
        await expectPgError(() => q(
          `INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, 'n', 'usr_c')`,
          [badId, orgId],
        ), '23514', 'task_lists_id_generated_chk')
      } else if (prefix === 'tgrp') {
        await expectPgError(() => q(
          `INSERT INTO task_groups (id, org_id, scope, user_id, name) VALUES ($1, $2, 'user', 'usr_g', 'n')`,
          [badId, orgId],
        ), '23514', 'task_groups_id_generated_chk')
      } else {
        const listId = await insertList(orgId)
        await expectPgError(() => q(
          `INSERT INTO task_list_events (id, list_id, actor_id, event_type) VALUES ($1, $2, 'usr_a', 'created')`,
          [badId, listId],
        ), '23514', 'task_list_events_id_generated_chk')
      }
    })

    it('person / org columns reject a space (single printable conjunct)', async () => {
      await expectPgError(() => q(
        `INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, 'org x', 'n', 'usr_c')`,
        [newTaskListId()],
      ), '23514', 'task_lists_org_id_printable_chk')
      const listId = await insertList(org('ids'))
      await expectPgError(() => q(
        `INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, 'usr x', 'read')`,
        [listId],
      ), '23514', 'task_list_members_user_printable_chk')
    })
  })

  describe('names', () => {
    it("'' and blank names are 23514 on lists and groups; '备料复核' is insertable", async () => {
      const orgId = org('name')
      await expectPgError(() => insertList(orgId, ''), '23514', 'task_lists_name_nonblank_chk')
      await expectPgError(() => insertList(orgId, '   '), '23514', 'task_lists_name_nonblank_chk')
      const listId = await insertList(orgId, '备料复核')
      await expectPgError(() => q(
        `INSERT INTO task_groups (id, org_id, scope, list_id, name) VALUES ($1, $2, 'list', $3, '')`,
        [newTaskGroupId(), orgId, listId],
      ), '23514', 'task_groups_name_nonblank_chk')
      await q(
        `INSERT INTO task_groups (id, org_id, scope, list_id, name) VALUES ($1, $2, 'list', $3, '备料复核')`,
        [newTaskGroupId(), orgId, listId],
      )
    })
  })

  // ASSUMPTION(task-m4): [own-37] a list item, a group item and a list-scope group join rows of
  // one org only. Each cross-org insert below breaks exactly one composite FK.
  describe('org consistency (composite FKs)', () => {
    it('a list item whose list and task are in different orgs is 23503 whichever org it carries; a same-org item is insertable; no org_id is 23502', async () => {
      const orgA = org('xoA')
      const orgB = org('xoB')
      const taskA = await insertTask(orgA)
      const listA = await insertList(orgA)
      const listB = await insertList(orgB)
      const item = (listId: string, taskId: string, orgId: string) =>
        q('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, taskId, orgId])
      await expectPgError(() => item(listB, taskA, orgA), '23503', 'task_list_items_list_fk')
      await expectPgError(() => item(listB, taskA, orgB), '23503', 'task_list_items_task_fk')
      await expectPgError(() => q('INSERT INTO task_list_items (list_id, task_id) VALUES ($1, $2)', [listA, taskA]), '23502')
      await item(listA, taskA, orgA)
      const rows = await q('SELECT list_id, org_id FROM task_list_items WHERE task_id = $1', [taskA])
      expect(rows).toEqual([{ list_id: listA, org_id: orgA }])
    })

    it('a list-scope group in another org than its list is 23503; a user-scope group references no list', async () => {
      const orgA = org('xgA')
      const orgB = org('xgB')
      const listA = await insertList(orgA)
      await expectPgError(() => q(
        `INSERT INTO task_groups (id, org_id, scope, list_id, name) VALUES ($1, $2, 'list', $3, '分组')`,
        [newTaskGroupId(), orgB, listA],
      ), '23503', 'task_groups_list_fk')
      await q(`INSERT INTO task_groups (id, org_id, scope, user_id, name) VALUES ($1, $2, 'user', 'usr_g', '分组')`, [newTaskGroupId(), orgB])
    })

    it('a group item whose group and task are in different orgs is 23503 whichever org it carries', async () => {
      const orgA = org('xiA')
      const orgB = org('xiB')
      const taskA = await insertTask(orgA)
      const groupB = await insertListGroup(orgB, await insertList(orgB), false)
      const place = (orgId: string) =>
        q('INSERT INTO task_group_items (group_id, task_id, org_id) VALUES ($1, $2, $3)', [groupB, taskA, orgId])
      await expectPgError(() => place(orgA), '23503', 'task_group_items_group_fk')
      await expectPgError(() => place(orgB), '23503', 'task_group_items_task_fk')
    })

    it('a task or a list that has list items keeps its org: moving either one is 23503', async () => {
      const orgA = org('xmA')
      const orgB = org('xmB')
      const taskA = await insertTask(orgA)
      const listA = await insertList(orgA)
      await q('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listA, taskA, orgA])
      await expectPgError(() => q('UPDATE tasks SET org_id = $2 WHERE id = $1', [taskA, orgB]), '23503', 'task_list_items_task_fk')
      await expectPgError(() => q('UPDATE task_lists SET org_id = $2 WHERE id = $1', [listA, orgB]), '23503', 'task_list_items_list_fk')
      const task = await q('SELECT org_id FROM tasks WHERE id = $1', [taskA])
      expect(task[0].org_id).toBe(orgA)
    })
  })

  // RULED(2026-10-07): [R13]
  describe('cascade and soft delete', () => {
    async function seedPlacedTask(orgId: string): Promise<{ taskId: string; listId: string; groupId: string }> {
      const taskId = await insertTask(orgId)
      const listId = await insertList(orgId)
      const groupId = await insertListGroup(orgId, listId, true)
      await q('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, taskId, orgId])
      await q('INSERT INTO task_group_items (group_id, task_id, org_id) VALUES ($1, $2, $3)', [groupId, taskId, orgId])
      return { taskId, listId, groupId }
    }

    async function placements(taskId: string): Promise<[number, number]> {
      const li = await q('SELECT count(*)::int AS n FROM task_list_items WHERE task_id = $1', [taskId])
      const gi = await q('SELECT count(*)::int AS n FROM task_group_items WHERE task_id = $1', [taskId])
      return [Number(li[0].n), Number(gi[0].n)]
    }

    it('soft delete (deleted_at only) keeps list items and group items', async () => {
      const { taskId } = await seedPlacedTask(org('soft'))
      await q('UPDATE tasks SET deleted_at = now() WHERE id = $1', [taskId])
      expect(await placements(taskId)).toEqual([1, 1])
    })

    it('deleting the task row removes its list items and group items', async () => {
      const { taskId } = await seedPlacedTask(org('hard'))
      await q('DELETE FROM tasks WHERE id = $1', [taskId])
      expect(await placements(taskId)).toEqual([0, 0])
    })

    it('DELETE FROM tasks WHERE org_id = … succeeds while that org has list items', async () => {
      const orgId = org('orgdel')
      const { taskId, listId } = await seedPlacedTask(orgId)
      await q('DELETE FROM tasks WHERE org_id = $1', [orgId])
      expect(await placements(taskId)).toEqual([0, 0])
      const list = await q('SELECT count(*)::int AS n FROM task_lists WHERE id = $1', [listId])
      expect(Number(list[0].n)).toBe(1)
    })

    it('deleting a list removes its members, items, list-scope groups (and their items) and events', async () => {
      const orgId = org('listdel')
      const { taskId, listId, groupId } = await seedPlacedTask(orgId)
      await q(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, 'usr_o', 'owner')`, [listId])
      await q(`INSERT INTO task_list_events (id, list_id, actor_id, event_type) VALUES ($1, $2, 'usr_o', 'created')`, [newTaskListEventId(), listId])
      await q('DELETE FROM task_lists WHERE id = $1', [listId])
      expect(await placements(taskId)).toEqual([0, 0])
      for (const [table, col, id] of [
        ['task_list_members', 'list_id', listId],
        ['task_list_events', 'list_id', listId],
        ['task_groups', 'id', groupId],
      ] as const) {
        const rows = await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id])
        expect(Number(rows[0].n), table).toBe(0)
      }
      const task = await q('SELECT count(*)::int AS n FROM tasks WHERE id = $1', [taskId])
      expect(Number(task[0].n)).toBe(1)
    })
  })

  describe('fixture cleanup', () => {
    it('dropTaskM4Fixtures matches the org prefix literally: an org id that only matches it with _ as a wildcard stays', async () => {
      const prefix = `${ORG_PREFIX}lk_${STAMP.replace(/-/g, '')}_`
      const inside = await insertTask(`${prefix}a`)
      const lookalike = `${prefix.replace(/_/g, 'X')}a`
      const outside = await insertTask(lookalike)
      try {
        await dropTaskM4Fixtures({ orgPrefix: prefix })
        expect((await q('SELECT count(*)::int AS n FROM tasks WHERE id = $1', [inside]))[0].n).toBe(0)
        expect((await q('SELECT count(*)::int AS n FROM tasks WHERE id = $1', [outside]))[0].n).toBe(1)
      } finally {
        await q('DELETE FROM tasks WHERE org_id = $1', [lookalike])
      }
    })
  })

  describe('migration down() then up() inside one rolled-back transaction', () => {
    const ROLLBACK = Symbol('task-m4-schema-rollback')
    let pool: Pool | undefined
    let kdb: Kysely<unknown> | undefined
    // Recorded before the transaction: a committed down() + up() would recreate task_lists under a
    // new OID and without this row, a rolled-back one keeps both.
    let listsOidBefore: string | undefined
    let sentinelListId: string | undefined

    afterAll(async () => {
      if (kdb) await kdb.destroy()
      else if (pool) await pool.end()
    })

    it('down() removes the eight tables, remind_at, idx_tsk_remind and tasks_id_org_id_key; up() restores identical columns, constraints and indexes', async () => {
      const url = process.env.DATABASE_URL
      if (!url) throw new Error('DATABASE_URL is required')
      sentinelListId = await insertList(org('rollback'))
      listsOidBefore = String((await q(`SELECT 'public.task_lists'::regclass::oid::text AS oid`))[0].oid)
      pool = new Pool({ connectionString: url, max: 1 })
      kdb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
      let reachedEnd = false
      try {
        await kdb.transaction().execute(async (trx) => {
          const run: Runner = async <R>(text: string, params: unknown[] = []) =>
            (await trx.executeQuery(CompiledQuery.raw(text, params))).rows as R[]
          const before = await snapshot(run)
          expect(byKey(before.columns)).toEqual(byKey(EXPECTED_COLUMNS))

          await m4Down(trx)
          for (const table of M4_TABLES) {
            const rows = await run<{ r: string | null }>(`SELECT to_regclass('public.${table}')::text AS r`)
            expect(rows[0].r, table).toBeNull()
          }
          const col = await run(`SELECT 1 FROM pg_attribute WHERE attrelid = 'public.tasks'::regclass AND attname = 'remind_at' AND NOT attisdropped`)
          expect(col).toEqual([])
          const idx = await run<{ r: string | null }>(`SELECT to_regclass('public.idx_tsk_remind')::text AS r`)
          expect(idx[0].r).toBeNull()
          const key = await run(`SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND conname = 'tasks_id_org_id_key'`)
          expect(key).toEqual([])
          const tasks = await run<{ r: string | null }>(`SELECT to_regclass('public.tasks')::text AS r`)
          expect(tasks[0].r).toBe('tasks')

          await m4Up(trx)
          const after = await snapshot(run)
          expect(byKey(after.columns)).toEqual(byKey(before.columns))
          expect(after.constraints).toEqual(before.constraints)
          expect(after.indexes).toEqual(before.indexes)
          reachedEnd = true
          throw ROLLBACK
        })
      } catch (err) {
        if (err !== ROLLBACK) throw err
      }
      expect(reachedEnd).toBe(true)
    })

    it('after the rollback the same task_lists table (same OID, sentinel row) and remind_at, idx_tsk_remind, tasks_id_org_id_key are there', async () => {
      for (const table of M4_TABLES) {
        const rows = await q('SELECT to_regclass($1)::text AS r', [`public.${table}`])
        expect(rows[0].r, table).toBe(table)
      }
      expect(listsOidBefore).toBeDefined()
      const oid = await q(`SELECT 'public.task_lists'::regclass::oid::text AS oid`)
      expect(oid[0].oid).toBe(listsOidBefore)
      const sentinel = await q('SELECT count(*)::int AS n FROM task_lists WHERE id = $1', [sentinelListId])
      expect(sentinel[0].n).toBe(1)
      const idx = await q(`SELECT to_regclass('public.idx_tsk_remind')::text AS r`)
      expect(idx[0].r).toBe('idx_tsk_remind')
      const col = await q(`SELECT 1 FROM pg_attribute WHERE attrelid = 'public.tasks'::regclass AND attname = 'remind_at' AND NOT attisdropped`)
      expect(col).toHaveLength(1)
      const key = await q(`SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND conname = 'tasks_id_org_id_key'`)
      expect(key).toHaveLength(1)
    })
  })
})
