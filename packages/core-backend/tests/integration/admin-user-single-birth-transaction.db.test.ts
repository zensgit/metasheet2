import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const schema = `sb_${globalThis.crypto.randomUUID().replace(/-/g, '')}`
  if (!/^sb_[0-9a-f]{32}$/.test(schema)) throw new Error('SINGLE_BIRTH_SCHEMA_INVALID')
  return {
    schema,
    service: undefined as unknown,
    imported: undefined as { close?: () => Promise<void> } | undefined,
    active: 0,
    pids: [] as number[],
    commits: 0,
    sql: [] as string[],
    tries: [] as Array<{ sql: string; acquired: unknown }>,
    afterSql: undefined as undefined | ((sql: string, pid: number, client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>),
  }
})

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  state.imported = actual.poolManager
  return { ...actual, poolManager: { get: () => {
    if (!/^sb_[0-9a-f]{32}$/.test(state.schema)) throw new Error('SINGLE_BIRTH_SCHEMA_REQUIRED')
    const service = (state.service ??= new actual.ConnectionPool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      name: 'single-birth-db',
      application_name: 'single_birth_pg',
      options: `-c search_path=${state.schema},pg_catalog`,
    })) as InstanceType<typeof actual.ConnectionPool>
    return {
      getInternalPool: () => service.getInternalPool(),
      query: service.query.bind(service),
      transaction: async <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown>; __rawClient: PoolClient }) => Promise<Result>) => {
        state.active++
        try {
          const result = await service.transaction(async (client) => {
            const pid = Number((client.__rawClient as PoolClient & { processID: number }).processID)
            state.pids.push(pid)
            return work({
              __rawClient: client.__rawClient,
              query: async (sql, params) => {
                const text = typeof sql === 'string' ? sql : ''
                state.sql.push(text)
                const queryResult = await client.query(sql, params)
                if (text.includes(ORG_TRY) || text.includes(ROLLOUT_TRY)) {
                  const acquired = (queryResult as { rows?: ReadonlyArray<{ acquired?: unknown }> }).rows?.[0]?.acquired
                  state.tries.push({ sql: text, acquired })
                }
                await state.afterSql?.(text, pid, client)
                return queryResult
              },
            })
          })
          state.commits++
          return result
        } finally { state.active-- }
      },
    }
  } } }
})
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))

import { createAdminUserBirthCommand } from '../../src/admin/admin-user-birth-command'
import type { AdminUserBirthInput } from '../../src/admin/admin-user-birth-command'
import { buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../../src/attendance/attendance-timezone-runtime-locks'
import {
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
} from '../../src/attendance/w4c0-identity'
import { normalizeLoginIdentifier } from '../../src/auth/login-identifier'
import { poolManager } from '../../src/integration/db/connection-pool'

const { lockAttendanceTimezoneOrg } = createRequire(import.meta.url)(fileURLToPath(new URL(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs',
  import.meta.url,
))) as {
  lockAttendanceTimezoneOrg: (
    query: (sql: string, params?: unknown[]) => Promise<unknown>,
    orgId: string,
  ) => Promise<void>
}

class ShiftWriterHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ShiftWriterHttpError'
    this.status = status
    this.code = code
    if (details !== undefined) Object.assign(this, { details })
  }
}

type ShiftQuery = (sql: string, params?: unknown[]) => Promise<unknown[]>
type ShiftDb = {
  transaction: <T>(work: (trx: { query: ShiftQuery }) => Promise<T>) => Promise<T>
}

const { createAttendanceShiftService } = createRequire(import.meta.url)(fileURLToPath(new URL(
  '../../../../plugins/plugin-attendance/lib/attendance-shift-service.cjs',
  import.meta.url,
))) as {
  createAttendanceShiftService: (deps: {
    HttpError: typeof ShiftWriterHttpError
    randomUUID: () => string
    resolveShiftTiming: () => never
    normalizeWorkingDays: (value: unknown) => number[]
    mapShiftRow: (row: { org_id?: unknown }) => { orgId: unknown }
    DEFAULT_SHIFT: {
      name: string
      timezone: string
      workStartTime: string
      workEndTime: string
      lateGraceMinutes: number
      earlyGraceMinutes: number
      roundingMinutes: number
      workingDays: number[]
    }
    DEFAULT_ORG_ID: string
    prepareTimezoneSourceChange: (
      trx: { query: ShiftQuery },
      input: { orgId: string },
    ) => Promise<() => Promise<void>>
  }) => {
    updateShift: (
      db: ShiftDb,
      input: { orgId: string; shiftId: string; patch: { name: string } },
    ) => Promise<unknown>
    deleteShift: (db: ShiftDb, input: { orgId: string; shiftId: string }) => Promise<unknown>
  }
}

function normalizeShiftWorkingDays(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(item => Number(item)).filter(item => Number.isFinite(item))
  if (typeof value === 'string') {
    try { return normalizeShiftWorkingDays(JSON.parse(value)) } catch { return [1, 2, 3, 4, 5] }
  }
  return [1, 2, 3, 4, 5]
}

const shiftService = createAttendanceShiftService({
  HttpError: ShiftWriterHttpError,
  randomUUID,
  resolveShiftTiming: () => { throw new Error('SINGLE_BIRTH_SHIFT_ENVELOPE_UNEXPECTED') },
  normalizeWorkingDays: normalizeShiftWorkingDays,
  mapShiftRow: (row) => ({ orgId: row.org_id ?? null }),
  DEFAULT_SHIFT: {
    name: 'Synthetic shift',
    timezone: 'UTC',
    workStartTime: '09:00',
    workEndTime: '18:00',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    roundingMinutes: 5,
    workingDays: [1, 2, 3, 4, 5],
  },
  DEFAULT_ORG_ID: 'default',
  prepareTimezoneSourceChange: async (trx, input) => {
    await lockAttendanceTimezoneOrg(trx.query, input.orgId)
    return async () => {}
  },
})

function shiftDb(client: PoolClient): ShiftDb {
  return {
    transaction: async (work) => work({
      query: async (sql, params) => (await client.query(sql, params)).rows,
    }),
  }
}

const SCHEMA_SQL = `
-- D21 (Y5a): the access-graph mutex bumps the subjects' version rows before the users rows.
CREATE TABLE subject_authorization_versions (LIKE public.subject_authorization_versions INCLUDING ALL);
CREATE TABLE users (
  id text PRIMARY KEY,
  email text,
  username text,
  name text,
  mobile text,
  employee_no text,
  department text,
  position text,
  hire_date date,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  role text NOT NULL DEFAULT 'user',
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  is_admin boolean NOT NULL DEFAULT false,
  activation_status text NOT NULL DEFAULT 'activated',
  local_password_set boolean NOT NULL DEFAULT true,
  access_generation bigint NOT NULL DEFAULT 0,
  avatar_url text,
  last_login_at timestamptz,
  deleted_at timestamptz,
  deleted_by text,
  purge_after timestamptz,
  purged_at timestamptz,
  purged_by text,
  active_before_delete boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_activation_status_check CHECK (activation_status IN ('pending_activation', 'activated'))
);
CREATE TABLE permissions (
  code varchar(255) PRIMARY KEY,
  name varchar(255) NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE roles (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_roles (
  user_id varchar(255) NOT NULL,
  role_id varchar(255) NOT NULL,
  assignment_source text CONSTRAINT user_roles_assignment_source_check CHECK (assignment_source IN ('manual', 'creation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE role_permissions (
  role_id varchar(255) NOT NULL,
  permission_code varchar(255) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_code)
);
CREATE TABLE user_permissions (
  user_id varchar(255) NOT NULL,
  permission_code varchar(255) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_code)
);
CREATE TABLE user_login_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email', 'mobile', 'username')),
  normalized_value text NOT NULL,
  source text NOT NULL DEFAULT 'migration',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_login_aliases_normalized_value_key UNIQUE (normalized_value)
);
CREATE TABLE user_namespace_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'platform_admin',
  granted_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, namespace)
);
CREATE TABLE user_orgs (
  user_id text NOT NULL,
  org_id text NOT NULL,
  is_active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);
CREATE TABLE attendance_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  name text NOT NULL,
  code text,
  timezone text NOT NULL DEFAULT 'UTC',
  rule_set_id uuid,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE attendance_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  group_id uuid NOT NULL REFERENCES attendance_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (org_id, group_id, user_id)
);
CREATE TABLE attendance_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  name text NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  work_start_time time NOT NULL DEFAULT '09:00',
  work_end_time time NOT NULL DEFAULT '18:00',
  is_overnight boolean NOT NULL DEFAULT false,
  late_grace_minutes integer NOT NULL DEFAULT 10,
  early_grace_minutes integer NOT NULL DEFAULT 10,
  rounding_minutes integer NOT NULL DEFAULT 5,
  working_days jsonb NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  flex_mode text NOT NULL DEFAULT 'strict',
  flex_required_minutes integer,
  flex_arrival_window_before_minutes integer,
  flex_arrival_window_after_minutes integer,
  flex_core_start_time time,
  flex_core_end_time time,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT attendance_shifts_flex_mode_check CHECK (flex_mode IN ('strict', 'flex_required_duration')),
  CONSTRAINT attendance_shifts_flex_discriminated_check CHECK (
    (
      flex_mode = 'strict'
      AND flex_required_minutes IS NULL
      AND flex_arrival_window_before_minutes IS NULL
      AND flex_arrival_window_after_minutes IS NULL
      AND flex_core_start_time IS NULL
      AND flex_core_end_time IS NULL
    )
    OR (
      flex_mode = 'flex_required_duration'
      AND flex_required_minutes IS NOT NULL
      AND flex_required_minutes > 0
      AND flex_required_minutes <= 1440
      AND flex_arrival_window_before_minutes IS NOT NULL
      AND flex_arrival_window_before_minutes >= 0
      AND flex_arrival_window_after_minutes IS NOT NULL
      AND flex_arrival_window_after_minutes >= 0
      AND (
        (flex_core_start_time IS NULL AND flex_core_end_time IS NULL)
        OR (flex_core_start_time IS NOT NULL AND flex_core_end_time IS NOT NULL)
      )
    )
  )
);
CREATE UNIQUE INDEX uq_attendance_shifts_id_org ON attendance_shifts (id, org_id);
CREATE TABLE attendance_shift_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  shift_id uuid NOT NULL,
  segment_index integer NOT NULL,
  start_time time NOT NULL,
  start_day_offset integer NOT NULL DEFAULT 0,
  end_time time NOT NULL,
  end_day_offset integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT chk_attendance_shift_segments_index_range CHECK (segment_index BETWEEN 0 AND 2),
  CONSTRAINT chk_attendance_shift_segments_start_day_offset CHECK (start_day_offset = 0),
  CONSTRAINT chk_attendance_shift_segments_end_day_offset CHECK (end_day_offset IN (0, 1)),
  CONSTRAINT fk_attendance_shift_segments_shift_org FOREIGN KEY (shift_id, org_id) REFERENCES attendance_shifts (id, org_id) ON DELETE CASCADE,
  UNIQUE (shift_id, segment_index)
);
CREATE TABLE attendance_shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  user_id text NOT NULL,
  shift_id uuid NOT NULL REFERENCES attendance_shifts(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE attendance_group_fixed_schedule_configs (
  org_id text NOT NULL,
  shift_id uuid NOT NULL
);
CREATE TABLE attendance_rotation_rules (
  org_id text NOT NULL,
  shift_sequence jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE attendance_requests (
  id uuid PRIMARY KEY,
  status text NOT NULL
);
CREATE TABLE attendance_shift_swap_requests (
  org_id text NOT NULL,
  request_id uuid NOT NULL,
  requester_shift_id uuid,
  counterparty_shift_id uuid
);
CREATE TABLE attendance_schedule_dispatch_requests (
  org_id text NOT NULL,
  target_shift_id uuid NOT NULL,
  publish_status text NOT NULL
);
CREATE TABLE attendance_calculation_rollout_state (
  org_id text PRIMARY KEY,
  state text NOT NULL,
  engine_version text NOT NULL,
  reason_code text NOT NULL,
  actor_id text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL,
  prior_state text,
  scope text NOT NULL DEFAULT 'synthetic_staging',
  CONSTRAINT chk_acrs_state CHECK (state IN ('legacy', 'shadow', 'eligible', 'authoritative', 'suspended')),
  CONSTRAINT chk_acrs_prior_state CHECK (prior_state IS NULL OR prior_state IN ('legacy', 'shadow', 'eligible', 'authoritative', 'suspended')),
  CONSTRAINT chk_acrs_scope CHECK (scope = 'synthetic_staging'),
  CONSTRAINT chk_acrs_version CHECK (version >= 1)
);
CREATE OR REPLACE FUNCTION attendance_w4_rollout_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (
      (NEW.state = 'legacy' AND NEW.prior_state IS NULL) OR
      (NEW.state = 'shadow' AND NEW.prior_state = 'legacy')
    ) THEN
      RAISE EXCEPTION 'W4C0_ROLLOUT: illegal initial rollout state on %', TG_TABLE_NAME;
    END IF;
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'W4C0_ROLLOUT: initial rollout version must be 1 on %', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.scope IS DISTINCT FROM OLD.scope THEN
    RAISE EXCEPTION 'W4C0_ROLLOUT: rollout identity fields are immutable on %', TG_TABLE_NAME;
  END IF;
  IF NOT (
    (OLD.state = 'legacy' AND NEW.state = 'shadow') OR
    (OLD.state = 'shadow' AND NEW.state IN ('eligible', 'legacy')) OR
    (OLD.state = 'eligible' AND NEW.state IN ('authoritative', 'shadow')) OR
    (OLD.state = 'authoritative' AND NEW.state = 'suspended') OR
    (OLD.state = 'suspended' AND NEW.state = 'authoritative')
  ) THEN
    RAISE EXCEPTION 'W4C0_ROLLOUT: illegal rollout state transition on %', TG_TABLE_NAME;
  END IF;
  IF NEW.prior_state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'W4C0_ROLLOUT: prior_state must record the previous state on %', TG_TABLE_NAME;
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'W4C0_ROLLOUT: optimistic version must increment on %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER trg_acrs_state_guard
  BEFORE INSERT OR UPDATE ON attendance_calculation_rollout_state
  FOR EACH ROW EXECUTE FUNCTION attendance_w4_rollout_state_guard();
`

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1' && !databaseUrl) throw new Error('SINGLE_BIRTH_DATABASE_REQUIRED')

const POST_USER_FAULTS = [
  ['user_login_aliases', 1, 'ALIAS_WRITE_FAILED'],
  ['user_roles', 1, '22012'],
  ['user_namespace_admissions', 1, '22012'],
  ['user_namespace_admissions', 2, '22012'],
  ['user_permissions', 1, '22012'],
  ['user_orgs', 1, '22012'],
  ['attendance_group_members', 1, '22012'],
  ['attendance_shift_assignments', 1, '22012'],
] as const

const ORG_TRY = 'pg_try_advisory_xact_lock(hashtextextended'
const ROLLOUT_TRY = 'pg_try_advisory_xact_lock_shared($1::bigint)'
const ROLE_SHARE = 'SELECT id::text AS id FROM roles WHERE id = $1::text FOR SHARE'

function bindQuery(client: PoolClient): (sql: string, params?: unknown[]) => Promise<unknown> {
  return (sql, params) => client.query(sql, params)
}

function orgLockText(orgId: string) {
  return buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgId)
}

function rolloutLockText(orgId: string) {
  return buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(orgId)).toString()
}

function outcome<Result>(promise: Promise<Result>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}

describe('single user BIRTH command on actual PostgreSQL', () => {
  let observer: PgPool
  let bootstrap: PgPool
  let baseline: Awaited<ReturnType<typeof neighborFacts>>
  let baselineOwned!: NeighborOwned
  let allowlistSnapshot: string | undefined
  const tracked: Array<Promise<unknown>> = []
  const holders: Holder[] = []
  const pauseReleases: Array<() => void> = []

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('SINGLE_BIRTH_DATABASE_REQUIRED')
    if (!/^sb_[0-9a-f]{32}$/.test(state.schema)) throw new Error('SINGLE_BIRTH_SCHEMA_INVALID')
    bootstrap = new PgPool({ connectionString: databaseUrl, max: 1, application_name: 'single_birth_pg_bootstrap' })
    await bootstrap.query('SELECT 1')
    await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await runIdent(bootstrap, 'CREATE SCHEMA %I', state.schema)
    observer = new PgPool({
      connectionString: databaseUrl,
      max: 8,
      application_name: 'single_birth_pg_observer',
      options: `-c search_path=${state.schema},pg_catalog`,
    })
    await expectSchema(observer)
    await observer.query(SCHEMA_SQL)
    await expectSchema(poolManager.get())
    await observer.query(
      `INSERT INTO permissions (code, name) VALUES ('files:read', 'Files read'), ('directory:read', 'Directory read')`,
    )
    baselineOwned = await seedNeighbor()
    baseline = await neighborFacts()
    allowlistSnapshot = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  })
  beforeEach(() => {
    expect(state.active).toBe(0)
    state.pids = []
    state.commits = 0
    state.sql = []
    state.tries = []
    state.afterSql = undefined
  })
  afterEach(async () => {
    await settle()
    restoreAllowlist()
    expect(await neighborFacts()).toEqual(baseline)
  })
  afterAll(async () => {
    await settle().catch(() => undefined)
    const service = state.service as { getInternalPool?: () => { end: () => Promise<void> }; stopMetricsCollection?: () => void } | undefined
    service?.stopMetricsCollection?.()
    if (service?.getInternalPool) await service.getInternalPool().end()
    if (observer) await observer.end()
    if (bootstrap && /^sb_[0-9a-f]{32}$/.test(state.schema)) await runIdent(bootstrap, 'DROP SCHEMA IF EXISTS %I CASCADE', state.schema)
    if (bootstrap) await bootstrap.end()
    if (state.imported?.close) await state.imported.close()
  })

  async function until(check: () => boolean | Promise<boolean>, message: string) {
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    throw new Error(message)
  }
  function track<Result>(promise: Promise<Result>) {
    const settled = outcome(promise)
    tracked.push(settled)
    return settled
  }
  async function settle() {
    state.afterSql = undefined
    for (const release of pauseReleases.splice(0)) release()
    const pending = tracked.splice(0)
    const open = holders.splice(0)
    for (const holder of open) {
      if (!holder.busy) await holder.finish('ROLLBACK')
    }
    for (const promise of pending) await promise
    for (const holder of open) await holder.finish('ROLLBACK')
    await until(() => state.active === 0, 'SINGLE_BIRTH_TRANSACTION_NOT_SETTLED')
  }
  async function control() {
    const client = await observer.connect()
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '5s'")
    let closed = false
    const holder: Holder = {
      client,
      pid: Number((client as PoolClient & { processID: number }).processID),
      busy: false,
      finish: async (action) => {
        if (closed) return
        closed = true
        try {
          await client.query(action)
        } catch (error) {
          const code = (error as { code?: string }).code
          if (action === 'COMMIT') {
            try { await client.query('ROLLBACK') } catch { /* the commit already left this transaction */ }
          } else if (code !== '25P01' && code !== '25P02') {
            client.release()
            throw error
          }
        }
        client.release()
      },
    }
    holders.push(holder)
    return holder
  }
  async function blocked(waiter: number, holder: number) {
    await until(async () => (await observer.query(
      "SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1",
      [waiter, holder],
    )).rows[0]?.blocked === true, 'SINGLE_BIRTH_LOCK_WAIT_NOT_OBSERVED')
  }
  async function waitingQuery(pid: number) {
    const rows = (await observer.query('SELECT query FROM pg_stat_activity WHERE pid = $1', [pid])).rows as Array<{ query?: unknown }>
    return String(rows[0]?.query ?? '')
  }
  function pauseOn(match: (sql: string) => boolean) {
    let open = true
    let parked = false
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    const release = () => {
      if (!open) return
      open = false
      releaseGate()
    }
    pauseReleases.push(release)
    state.afterSql = async (sql) => {
      if (!open || parked || !match(sql)) return
      parked = true
      await gate
    }
    return { pending: () => parked, release }
  }
  function watchLock(pid: number) {
    let stop = false
    let saw = false
    const done = (async () => {
      while (!stop) {
        try {
          const rows = (await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])).rows as Array<{ wait_event_type?: unknown }>
          if (rows[0]?.wait_event_type === 'Lock') saw = true
        } catch { /* the observer is only a sampler */ }
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
    })()
    return { saw: () => saw, stop: async () => { stop = true; await done } }
  }
  async function advisoryHashGranted(pid: number, keyText: string, mode: 'ExclusiveLock' | 'ShareLock') {
    const rows = (await observer.query(
      `SELECT 1
         FROM pg_locks l
         JOIN (SELECT hashtextextended($2::text, 0) AS k) key ON TRUE
        WHERE l.locktype = 'advisory' AND l.pid = $1 AND l.granted AND l.objsubid = 1
          AND l.mode = $3
          AND l.classid::bigint = ((key.k >> 32) & 4294967295)::bigint
          AND l.objid::bigint = (key.k & 4294967295)::bigint`,
      [pid, keyText, mode],
    )).rows
    return rows.length > 0
  }
  async function advisoryIntGranted(pid: number, keyText: string, mode: 'ExclusiveLock' | 'ShareLock') {
    const rows = (await observer.query(
      `SELECT 1
         FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.pid = $1 AND l.granted AND l.objsubid = 1
          AND l.mode = $3
          AND l.classid::bigint = (($2::bigint >> 32) & 4294967295)::bigint
          AND l.objid::bigint = ($2::bigint & 4294967295)::bigint`,
      [pid, keyText, mode],
    )).rows
    return rows.length > 0
  }
  function acquiredTry(marker: string) {
    const rows = state.tries.filter((row) => row.sql.includes(marker))
    return rows.length === 1 ? rows[0].acquired : undefined
  }
  async function rewriteShift(client: PoolClient, orgId: string, shiftId: string, mode: 'update' | 'delete') {
    const db = shiftDb(client)
    if (mode === 'update') {
      await shiftService.updateShift(db, { orgId, shiftId, patch: { name: 'Synthetic shift renamed' } })
      return
    }
    await shiftService.deleteShift(db, { orgId, shiftId })
  }
  function restoreAllowlist() {
    if (allowlistSnapshot === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = allowlistSnapshot
  }
  function lockCounts() {
    return {
      org: state.sql.filter(sql => sql.includes(ORG_TRY)).length,
      rollout: state.sql.filter(sql => sql.includes(ROLLOUT_TRY)).length,
      shift: state.sql.filter(sql => sql.includes('FROM attendance_shifts') && sql.includes('FOR SHARE')).length,
    }
  }
  async function columnNames(table: string) {
    const names = (await observer.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [state.schema, table],
    )).rows.map(row => String((row as { column_name?: unknown }).column_name))
    if (names.length === 0 || names.some(name => !/^[a-z_][a-z0-9_]*$/.test(name))) {
      throw new Error(`SINGLE_BIRTH_COLUMNS_UNREADABLE:${table}`)
    }
    return names
  }
  function normalizeRow(names: string[], row: Record<string, unknown>) {
    const out: Record<string, unknown> = {}
    for (const name of names) {
      const value = row[name]
      out[name] = value instanceof Date ? value.toISOString() : value
    }
    return out
  }
  async function scopedRows(table: string, key: string, id: string, order: string) {
    const names = await columnNames(table)
    if (!names.includes(key) || !names.includes(order)) throw new Error(`SINGLE_BIRTH_COLUMNS_UNREADABLE:${table}`)
    const listed = names.map(name => textColumn(name) ? `"${name}"::text AS "${name}"` : `"${name}"`).join(', ')
    const rows = (await observer.query(
      `SELECT ${listed} FROM ${table} WHERE "${key}" = $1 ORDER BY "${order}"`,
      [id],
    )).rows as Array<Record<string, unknown>>
    return rows.map(row => normalizeRow(names, row))
  }
  function expectBusinessRow(row: Record<string, unknown>, expected: Record<string, unknown>) {
    for (const [key, value] of Object.entries(row)) {
      if (key === 'created_at' || key === 'updated_at') {
        expect(typeof value).toBe('string')
        expect(value).not.toBe('')
        continue
      }
      if (key === 'id' && !(key in expected)) {
        expect(typeof value).toBe('string')
        expect(value).not.toBe('')
        continue
      }
      if (!(key in expected)) {
        expect(value).toBeNull()
        continue
      }
      expect(value).toEqual(expected[key])
    }
    for (const key of Object.keys(expected)) {
      if (!(key in row)) throw new Error(`SINGLE_BIRTH_COLUMN_MISSING:${key}`)
    }
    if ('created_at' in row && 'updated_at' in row) expect(row.created_at).toEqual(row.updated_at)
  }
  async function counts(userId: string) {
    return (await observer.query(
      `SELECT
         (SELECT count(*)::int FROM users WHERE id = $1) AS users,
         (SELECT count(*)::int FROM user_login_aliases WHERE user_id = $1) AS aliases,
         (SELECT count(*)::int FROM user_roles WHERE user_id = $1) AS roles,
         (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id = $1) AS admissions,
         (SELECT count(*)::int FROM user_permissions WHERE user_id = $1) AS permissions,
         (SELECT count(*)::int FROM user_orgs WHERE user_id = $1) AS orgs,
         (SELECT count(*)::int FROM attendance_group_members WHERE user_id = $1) AS groups,
         (SELECT count(*)::int FROM attendance_shift_assignments WHERE user_id = $1) AS shifts`,
      [userId],
    )).rows[0]
  }
  async function expectEmpty(userId: string) {
    expect(await counts(userId)).toEqual({
      users: 0, aliases: 0, roles: 0, admissions: 0, permissions: 0, orgs: 0, groups: 0, shifts: 0,
    })
    expect(state.commits).toBe(0)
  }
  async function expectPersisted(fixture: Fixture, assignmentId: string | null) {
    const normalized = normalizeLoginIdentifier(fixture.email)
    if (!normalized) throw new Error('SINGLE_BIRTH_ALIAS_REQUIRED')
    expect(await counts(fixture.userId)).toEqual({
      users: 1,
      aliases: 1,
      roles: 1,
      admissions: fixture.admissionNamespaces.length > 0 ? 2 : 1,
      permissions: fixture.directPermissions.length,
      orgs: fixture.orgId ? 1 : 0,
      groups: fixture.groupId ? 1 : 0,
      shifts: fixture.shiftId ? 1 : 0,
    })
    const users = await scopedRows('users', 'id', fixture.userId, 'id')
    expect(users).toHaveLength(1)
    expectBusinessRow(users[0], {
      id: fixture.userId,
      email: fixture.email,
      username: null,
      name: 'Synthetic birth target',
      mobile: null,
      employee_no: null,
      department: null,
      position: null,
      hire_date: null,
      password_hash: 'synthetic-unused',
      must_change_password: true,
      role: 'user',
      permissions: fixture.directPermissions,
      is_active: fixture.isActive,
      is_admin: false,
      activation_status: 'activated',
      local_password_set: true,
      access_generation: '0',
    })
    const aliases = await scopedRows('user_login_aliases', 'user_id', fixture.userId, 'normalized_value')
    expect(aliases).toHaveLength(1)
    expectBusinessRow(aliases[0], {
      user_id: fixture.userId,
      kind: 'email',
      normalized_value: normalized,
      source: 'admin_create',
    })
    const memberships = await scopedRows('user_roles', 'user_id', fixture.userId, 'role_id')
    expect(memberships).toHaveLength(1)
    expectBusinessRow(memberships[0], { user_id: fixture.userId, role_id: fixture.roleId, assignment_source: 'creation' })
    const admissions = await scopedRows('user_namespace_admissions', 'user_id', fixture.userId, 'namespace')
    const expectedAdmissions = [
      {
        user_id: fixture.userId,
        namespace: 'attendance',
        enabled: false,
        source: 'admin_create',
        granted_by: null,
        updated_by: fixture.actorId,
      },
      ...(fixture.admissionNamespaces.includes('directory') ? [{
        user_id: fixture.userId,
        namespace: 'directory',
        enabled: true,
        source: 'admin_create',
        granted_by: fixture.actorId,
        updated_by: fixture.actorId,
      }] : []),
    ]
    expect(admissions).toHaveLength(expectedAdmissions.length)
    admissions.forEach((row, index) => expectBusinessRow(row, expectedAdmissions[index]))
    const permissions = await scopedRows('user_permissions', 'user_id', fixture.userId, 'permission_code')
    if (fixture.directPermissions.length === 0) expect(permissions).toEqual([])
    else {
      expect(permissions).toHaveLength(1)
      expectBusinessRow(permissions[0], { user_id: fixture.userId, permission_code: 'files:read' })
    }
    const orgs = fixture.orgId ? await scopedRows('user_orgs', 'user_id', fixture.userId, 'org_id') : []
    if (!fixture.orgId) expect(orgs).toEqual([])
    else {
      expect(orgs).toHaveLength(1)
      expectBusinessRow(orgs[0], { user_id: fixture.userId, org_id: fixture.orgId, is_active: true })
    }
    const members = fixture.groupId ? await scopedRows('attendance_group_members', 'user_id', fixture.userId, 'group_id') : []
    if (!fixture.groupId) expect(members).toEqual([])
    else {
      expect(members).toHaveLength(1)
      expectBusinessRow(members[0], { org_id: fixture.orgId, group_id: fixture.groupId, user_id: fixture.userId })
    }
    const assignments = fixture.shiftId ? await scopedRows('attendance_shift_assignments', 'user_id', fixture.userId, 'shift_id') : []
    if (!fixture.shiftId) expect(assignments).toEqual([])
    else {
      if (!assignmentId) throw new Error('SINGLE_BIRTH_ASSIGNMENT_REQUIRED')
      expect(assignments).toHaveLength(1)
      expectBusinessRow(assignments[0], {
        id: assignmentId,
        org_id: fixture.orgId,
        user_id: fixture.userId,
        shift_id: fixture.shiftId,
        start_date: '2026-11-17',
        end_date: null,
        is_active: true,
      })
    }
  }
  async function seed(options: SeedOptions): Promise<Fixture> {
    const actorId = `single-birth-${options.label}-actor-${randomUUID()}`
    const userId = `single-birth-${options.label}-target-${randomUUID()}`
    const roleId = `single-birth-${options.label}-role-${randomUUID()}`
    const segments = options.segments ?? 0
    const orgId = options.org || options.group || segments > 0 ? randomUUID() : null
    const groupId = options.group ? randomUUID() : null
    const shiftId = segments > 0 ? randomUUID() : null
    const authority = options.authority ?? 'raw'
    const isActive = options.isActive ?? true
    const directPermissions = options.direct ? ['files:read'] : []
    const admissionNamespaces = options.directory ? ['directory'] : []
    await observer.query(
      `INSERT INTO users (id, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $1, 'Synthetic birth actor', 'synthetic-unused', $2, '[]'::jsonb, true, false, 'activated')`,
      [actorId, authority === 'raw' ? 'admin' : 'user'],
    )
    if (authority === 'member') await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
    if (options.directory) await observer.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, 'directory:read'])
    if (orgId && groupId) await observer.query('INSERT INTO attendance_groups (id, org_id, name) VALUES ($1, $2, $3)', [groupId, orgId, 'Synthetic group'])
    if (orgId && shiftId) {
      await observer.query(
        `INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, late_grace_minutes, early_grace_minutes, rounding_minutes, working_days)
         VALUES ($1, $2, 'Synthetic shift', 'UTC', '09:00', '18:00', false, 10, 10, 5, '[1,2,3,4,5]'::jsonb)`,
        [shiftId, orgId],
      )
      const segmentRows = segments === 1
        ? [{ index: 0, start: '09:00', end: '18:00' }]
        : [{ index: 0, start: '09:00', end: '12:00' }, { index: 1, start: '13:00', end: '18:00' }]
      for (const segment of segmentRows) {
        await observer.query(
          `INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
           VALUES ($1, $2, $3, $4, $5, 0, 0)`,
          [orgId, shiftId, segment.index, segment.start, segment.end],
        )
      }
    }
    if (orgId && options.rollout) {
      await observer.query(
        `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
         VALUES ($1, 'shadow', 'synthetic-engine', 'synthetic-reason', $2, 1, 'legacy', 'synthetic_staging')`,
        [orgId, actorId],
      )
    }
    return {
      actorId,
      userId,
      roleId,
      email: `${userId}@example.invalid`,
      orgId,
      groupId,
      shiftId,
      isActive,
      directPermissions,
      admissionNamespaces,
    }
  }
  function inputOf(fixture: Fixture): AdminUserBirthInput {
    return {
      actorId: fixture.actorId,
      userId: fixture.userId,
      email: fixture.email,
      username: null,
      name: 'Synthetic birth target',
      mobile: null,
      employeeNo: null,
      department: null,
      position: null,
      hireDate: null,
      passwordHash: 'synthetic-unused',
      mustChangePassword: true,
      role: 'user',
      directPermissions: fixture.directPermissions,
      isActive: fixture.isActive,
      roleId: fixture.roleId,
      admissionNamespaces: fixture.admissionNamespaces,
      attendanceOrgId: fixture.orgId,
      attendanceGroupId: fixture.groupId,
      attendanceGroupName: fixture.groupId ? 'Synthetic group' : null,
      defaultShiftId: fixture.shiftId,
      defaultShiftName: fixture.shiftId ? 'Synthetic shift' : null,
      defaultShiftStartDate: fixture.shiftId ? '2026-11-17' : null,
    }
  }
  async function seedNeighbor() {
    const userId = `single-birth-neighbor-${randomUUID()}`
    const roleId = `single-birth-neighbor-role-${randomUUID()}`
    const orgId = randomUUID()
    const groupId = randomUUID()
    const shiftId = randomUUID()
    const email = `${userId}@example.invalid`
    await observer.query(
      `INSERT INTO users (id, username, email, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $1, $2, 'Synthetic birth neighbor', 'synthetic-unused', 'user', '[]'::jsonb, true, false, 'activated')`,
      [userId, email],
    )
    await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
    await observer.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, 'directory:read'])
    await observer.query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [userId, 'files:read'])
    await observer.query(
      "INSERT INTO user_login_aliases (user_id, kind, normalized_value, source) VALUES ($1, 'email', $2, 'synthetic')",
      [userId, email],
    )
    await observer.query(
      `INSERT INTO user_namespace_admissions
         (user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at)
       VALUES ($1, 'single-birth-neighbor', true, 'synthetic', NULL, $1, NOW(), NOW())`,
      [userId],
    )
    await observer.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
    await observer.query('INSERT INTO attendance_groups (id, org_id, name) VALUES ($1, $2, $3)', [groupId, orgId, 'Synthetic neighbor group'])
    await observer.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [orgId, groupId, userId],
    )
    await observer.query(
      `INSERT INTO attendance_shifts (id, org_id, name) VALUES ($1, $2, 'Synthetic neighbor shift')`,
      [shiftId, orgId],
    )
    await observer.query(
      `INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, end_time)
       VALUES ($1, $2, 0, '09:00', '18:00')`,
      [orgId, shiftId],
    )
    await observer.query(
      `INSERT INTO attendance_shift_assignments (org_id, user_id, shift_id, start_date, is_active)
       VALUES ($1, $2, $3, '2026-01-15', true)`,
      [orgId, userId, shiftId],
    )
    await observer.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'shadow', 'synthetic-engine', 'synthetic-reason', $2, 1, 'legacy', 'synthetic_staging')`,
      [orgId, userId],
    )
    return { userId, roleId, orgId, groupId, shiftId }
  }
  async function neighborFacts() {
    const owned = baselineOwned
    return {
      user: await scopedRows('users', 'id', owned.userId, 'id'),
      alias: await scopedRows('user_login_aliases', 'user_id', owned.userId, 'normalized_value'),
      admission: await scopedRows('user_namespace_admissions', 'user_id', owned.userId, 'namespace'),
      membership: await scopedRows('user_roles', 'user_id', owned.userId, 'role_id'),
      role: await scopedRows('roles', 'id', owned.roleId, 'id'),
      rolePermissions: await scopedRows('role_permissions', 'role_id', owned.roleId, 'permission_code'),
      permissions: await scopedRows('user_permissions', 'user_id', owned.userId, 'permission_code'),
      org: await scopedRows('user_orgs', 'user_id', owned.userId, 'org_id'),
      group: await scopedRows('attendance_groups', 'id', owned.groupId, 'id'),
      member: await scopedRows('attendance_group_members', 'user_id', owned.userId, 'group_id'),
      shift: await scopedRows('attendance_shifts', 'id', owned.shiftId, 'id'),
      segments: await scopedRows('attendance_shift_segments', 'shift_id', owned.shiftId, 'segment_index'),
      assignment: await scopedRows('attendance_shift_assignments', 'user_id', owned.userId, 'shift_id'),
      rollout: await scopedRows('attendance_calculation_rollout_state', 'org_id', owned.orgId, 'org_id'),
    }
  }

  it('commits a selected role and disabled attendance admission with no onboarding locks', async () => {
    const fixture = await seed({ label: 'none' })
    const actorBefore = await scopedRows('users', 'id', fixture.actorId, 'id')
    const value = await createAdminUserBirthCommand(inputOf(fixture))
    expect(value).toBeNull()
    expect(state.commits).toBe(1)
    expect(lockCounts()).toEqual({ org: 0, rollout: 0, shift: 0 })
    await expectPersisted(fixture, null)
    expect(await scopedRows('users', 'id', fixture.actorId, 'id')).toEqual(actorBefore)
  })

  it('links an inactive user to an org without a timezone lock', async () => {
    const fixture = await seed({ label: 'org', org: true, isActive: false })
    const actorBefore = await scopedRows('users', 'id', fixture.actorId, 'id')
    const value = await createAdminUserBirthCommand(inputOf(fixture))
    expect(value).toEqual({ orgId: fixture.orgId, group: null, defaultShift: null })
    expect(state.commits).toBe(1)
    expect(lockCounts()).toEqual({ org: 0, rollout: 0, shift: 0 })
    await expectPersisted(fixture, null)
    expect(await scopedRows('users', 'id', fixture.actorId, 'id')).toEqual(actorBefore)
  })

  it('commits a group member and a one-segment shift after one org try and one shift share', async () => {
    const fixture = await seed({ label: 'group-segment', org: true, group: true, segments: 1 })
    const actorBefore = await scopedRows('users', 'id', fixture.actorId, 'id')
    const shiftBefore = await scopedRows('attendance_shifts', 'id', fixture.shiftId ?? '', 'id')
    const value = await createAdminUserBirthCommand(inputOf(fixture))
    expect(value).toMatchObject({
      orgId: fixture.orgId,
      group: { id: fixture.groupId, name: 'Synthetic group', memberCreated: true },
      defaultShift: { id: fixture.shiftId, name: 'Synthetic shift', startDate: '2026-11-17' },
    })
    expect(state.commits).toBe(1)
    expect(lockCounts()).toEqual({ org: 1, rollout: 0, shift: 1 })
    const orgAt = state.sql.findIndex(sql => sql.includes(ORG_TRY))
    const shiftAt = state.sql.findIndex(sql => sql.includes('FROM attendance_shifts') && sql.includes('FOR SHARE'))
    expect(orgAt).toBeGreaterThanOrEqual(0)
    expect(shiftAt).toBeGreaterThan(orgAt)
    await expectPersisted(fixture, value?.defaultShift?.assignmentId ?? null)
    expect(await scopedRows('users', 'id', fixture.actorId, 'id')).toEqual(actorBefore)
    expect(await scopedRows('attendance_shifts', 'id', fixture.shiftId ?? '', 'id')).toEqual(shiftBefore)
  })

  it('commits a multisegment shift when the canonical shadow posture is enabled', async () => {
    const fixture = await seed({ label: 'multi', org: true, group: true, segments: 2, rollout: true })
    if (!fixture.orgId) throw new Error('SINGLE_BIRTH_ORG_REQUIRED')
    const actorBefore = await scopedRows('users', 'id', fixture.actorId, 'id')
    const rolloutBefore = await scopedRows('attendance_calculation_rollout_state', 'org_id', fixture.orgId, 'org_id')
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    try {
      const value = await createAdminUserBirthCommand(inputOf(fixture))
      expect(value).toMatchObject({
        orgId: fixture.orgId,
        group: { id: fixture.groupId, name: 'Synthetic group', memberCreated: true },
        defaultShift: { id: fixture.shiftId, name: 'Synthetic shift', startDate: '2026-11-17' },
      })
      expect(state.commits).toBe(1)
      expect(lockCounts()).toEqual({ org: 1, rollout: 1, shift: 1 })
      const orgAt = state.sql.findIndex(sql => sql.includes(ORG_TRY))
      const rolloutAt = state.sql.findIndex(sql => sql.includes(ROLLOUT_TRY))
      expect(orgAt).toBeGreaterThanOrEqual(0)
      expect(rolloutAt).toBeGreaterThan(orgAt)
      expect(state.sql.some(sql => sql.includes('FROM attendance_calculation_rollout_state'))).toBe(true)
      await expectPersisted(fixture, value?.defaultShift?.assignmentId ?? null)
      expect(await scopedRows('users', 'id', fixture.actorId, 'id')).toEqual(actorBefore)
      expect(await scopedRows('attendance_calculation_rollout_state', 'org_id', fixture.orgId, 'org_id')).toEqual(rolloutBefore)
    } finally {
      restoreAllowlist()
    }
  })

  it('rereads a raw admin revocation committed while the actor row lock is held', async () => {
    const fixture = await seed({ label: 'raw-revoke', authority: 'raw' })
    const holder = await control()
    await holder.client.query("UPDATE users SET role = 'user' WHERE id = $1", [fixture.actorId])
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await blocked(state.pids[0], holder.pid)
      expect(await waitingQuery(state.pids[0])).toContain('FROM users')
      expect(await waitingQuery(state.pids[0])).toContain('FOR UPDATE')
      expect(state.commits).toBe(0)
      expect(await counts(fixture.userId)).toEqual({
        users: 0, aliases: 0, roles: 0, admissions: 0, permissions: 0, orgs: 0, groups: 0, shifts: 0,
      })
      await holder.finish('COMMIT')
      expect(await run).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
      await expectEmpty(fixture.userId)
      expect((await observer.query('SELECT role FROM users WHERE id = $1', [fixture.actorId])).rows).toEqual([{ role: 'user' }])
    } finally {
      await settle()
    }
  }, 20_000)

  it('rereads a member admin child deleted while its share lock is held', async () => {
    const fixture = await seed({ label: 'member-revoke', authority: 'member' })
    const actorBefore = await scopedRows('users', 'id', fixture.actorId, 'id')
    const holder = await control()
    await holder.client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await blocked(state.pids[0], holder.pid)
      expect(await waitingQuery(state.pids[0])).toContain("role_id = 'admin' FOR SHARE")
      expect(state.commits).toBe(0)
      expect(await counts(fixture.userId)).toEqual({
        users: 0, aliases: 0, roles: 0, admissions: 0, permissions: 0, orgs: 0, groups: 0, shifts: 0,
      })
      await holder.finish('COMMIT')
      expect(await run).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
      await expectEmpty(fixture.userId)
      expect(await scopedRows('users', 'id', fixture.actorId, 'id')).toEqual(actorBefore)
      expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([])
    } finally {
      await settle()
    }
  }, 20_000)

  it.each(POST_USER_FAULTS)('rolls back the born user after native 22012 following %s insert %s as %s', async (table, nth, expectedCode) => {
    const fixture = await seed({
      label: `fault-${table}-${nth}`,
      org: true,
      group: true,
      segments: 1,
      directory: true,
      direct: true,
    })
    const actorBefore = await scopedRows('users', 'id', fixture.actorId, 'id')
    const roleBefore = await scopedRows('roles', 'id', fixture.roleId, 'id')
    let fired = false
    let seen = 0
    let nativeCode: unknown
    state.afterSql = async (sql, _pid, client) => {
      if (!new RegExp(`^INSERT INTO ${table}\\b`, 'i').test(sql.trim())) return
      seen += 1
      if (seen !== nth || fired) return
      fired = true
      try { await client.query('SELECT 1 / 0') } catch (error) {
        nativeCode = (error as { code?: unknown }).code
        throw error
      }
    }
    const result = await outcome(createAdminUserBirthCommand(inputOf(fixture)))
    expect(result).toMatchObject({ ok: false, error: { code: expectedCode } })
    expect(fired).toBe(true)
    expect(nativeCode).toBe('22012')
    await expectEmpty(fixture.userId)
    expect(await scopedRows('users', 'id', fixture.actorId, 'id')).toEqual(actorBefore)
    expect(await scopedRows('roles', 'id', fixture.roleId, 'id')).toEqual(roleBefore)
    expect(await scopedRows('attendance_shifts', 'id', fixture.shiftId ?? '', 'id')).toHaveLength(1)
    expect(await scopedRows('attendance_shift_segments', 'shift_id', fixture.shiftId ?? '', 'segment_index')).toHaveLength(1)
  })

  it('commits a group without a shift, including the enabled directory admission and direct permission', async () => {
    const fixture = await seed({ label: 'group-only', org: true, group: true, directory: true, direct: true })
    const value = await createAdminUserBirthCommand(inputOf(fixture))
    expect(value).toEqual({
      orgId: fixture.orgId,
      group: { id: fixture.groupId, name: 'Synthetic group', memberCreated: true },
      defaultShift: null,
    })
    expect(state.commits).toBe(1)
    expect(lockCounts()).toEqual({ org: 1, rollout: 0, shift: 0 })
    expect(state.sql.some((sql) => sql.includes(ROLLOUT_TRY))).toBe(false)
    await expectPersisted(fixture, null)
  })

  it('commits a one-segment shift without a group after one org try and one shift share', async () => {
    const fixture = await seed({ label: 'segment-only', org: true, segments: 1 })
    const value = await createAdminUserBirthCommand(inputOf(fixture))
    expect(value).toMatchObject({
      orgId: fixture.orgId,
      group: null,
      defaultShift: { id: fixture.shiftId, name: 'Synthetic shift', startDate: '2026-11-17' },
    })
    expect(state.commits).toBe(1)
    expect(lockCounts()).toEqual({ org: 1, rollout: 0, shift: 1 })
    const orgAt = state.sql.findIndex((sql) => sql.includes(ORG_TRY))
    const shiftAt = state.sql.findIndex((sql) => sql.includes('FROM attendance_shifts') && sql.includes('FOR SHARE'))
    expect(orgAt).toBeGreaterThanOrEqual(0)
    expect(shiftAt).toBeGreaterThan(orgAt)
    await expectPersisted(fixture, value?.defaultShift?.assignmentId ?? null)
  })

  it('rereads a selected role deleted while its share lock is held', async () => {
    const fixture = await seed({ label: 'role-delete' })
    const holder = await control()
    await holder.client.query('DELETE FROM roles WHERE id = $1', [fixture.roleId])
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await blocked(state.pids[0], holder.pid)
      expect(await waitingQuery(state.pids[0])).toContain(ROLE_SHARE)
      expect(state.commits).toBe(0)
      expect(await counts(fixture.userId)).toEqual({
        users: 0, aliases: 0, roles: 0, admissions: 0, permissions: 0, orgs: 0, groups: 0, shifts: 0,
      })
      await holder.finish('COMMIT')
      expect(await run).toMatchObject({ ok: false, error: { code: 'ROLE_NOT_FOUND', message: 'Role not found' } })
      await expectEmpty(fixture.userId)
      expect(await scopedRows('roles', 'id', fixture.roleId, 'id')).toEqual([])
    } finally {
      await settle()
    }
  }, 20_000)

  it('returns busy without waiting when the org holder is itself waiting on the actor', async () => {
    const fixture = await seed({ label: 'org-nowait', org: true, group: true, segments: 1 })
    if (!fixture.orgId) throw new Error('SINGLE_BIRTH_ORG_REQUIRED')
    const holder = await control()
    const pause = pauseOn((sql) => sql.includes('FROM users') && sql.includes('FOR UPDATE'))
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    let competitorDone = false
    let watch: ReturnType<typeof watchLock> | undefined
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await until(() => pause.pending(), 'SINGLE_BIRTH_ACTOR_LOCK_NOT_OBSERVED')
      await lockAttendanceTimezoneOrg(bindQuery(holder.client), fixture.orgId)
      const competitor = holder.client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [fixture.actorId]).then(() => {
        competitorDone = true
      })
      track(competitor)
      await blocked(holder.pid, state.pids[0])
      expect(competitorDone).toBe(false)
      expect(await advisoryHashGranted(holder.pid, orgLockText(fixture.orgId), 'ExclusiveLock')).toBe(true)
      const sampler = watchLock(state.pids[0])
      watch = sampler
      const started = Date.now()
      pause.release()
      const result = await run
      const elapsed = Date.now() - started
      await sampler.stop()
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'AUTHORIZATION_INPUT_BUSY',
          status: 409,
          retryable: true,
          reason: 'lock_timeout',
          busyReason: 'lock_timeout',
          message: 'Authorization inputs are busy; retry this change.',
        },
      })
      expect(acquiredTry(ORG_TRY)).toBe(false)
      expect(sampler.saw()).toBe(false)
      expect(elapsed).toBeLessThan(2500)
      expect(await advisoryHashGranted(holder.pid, orgLockText(fixture.orgId), 'ExclusiveLock')).toBe(true)
      await expectEmpty(fixture.userId)
    } finally {
      pause.release()
      await watch?.stop()
      await settle()
    }
  }, 20_000)

  it('holds the org lock and blocks the canonical waiter until commit', async () => {
    const fixture = await seed({ label: 'org-inverse', org: true, group: true, segments: 1 })
    if (!fixture.orgId) throw new Error('SINGLE_BIRTH_ORG_REQUIRED')
    const holder = await control()
    const pause = pauseOn((sql) => sql.includes(ORG_TRY))
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    let waiterDone = false
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await until(() => pause.pending(), 'SINGLE_BIRTH_ORG_TRY_NOT_OBSERVED')
      expect(acquiredTry(ORG_TRY)).toBe(true)
      expect(await advisoryHashGranted(state.pids[0], orgLockText(fixture.orgId), 'ExclusiveLock')).toBe(true)
      const waiter = lockAttendanceTimezoneOrg(bindQuery(holder.client), fixture.orgId).then(() => {
        waiterDone = true
      })
      track(waiter)
      await blocked(holder.pid, state.pids[0])
      const waiting = await waitingQuery(holder.pid)
      expect(waiting).toContain('pg_advisory_xact_lock(hashtextextended')
      expect(waiting).not.toContain('pg_try')
      expect(waiterDone).toBe(false)
      pause.release()
      const result = await run
      expect(result.ok).toBe(true)
      expect(state.commits).toBe(1)
      await waiter
      expect(waiterDone).toBe(true)
      await expectPersisted(fixture, result.ok ? result.value?.defaultShift?.assignmentId ?? null : null)
    } finally {
      pause.release()
      await settle()
    }
  }, 20_000)

  it('commits beside an unrelated org lock', async () => {
    const fixture = await seed({ label: 'org-unrelated', org: true, group: true, segments: 1 })
    if (!fixture.orgId) throw new Error('SINGLE_BIRTH_ORG_REQUIRED')
    const otherOrg = randomUUID()
    const holder = await control()
    await lockAttendanceTimezoneOrg(bindQuery(holder.client), otherOrg)
    const pause = pauseOn((sql) => sql.includes(ORG_TRY))
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await until(() => pause.pending(), 'SINGLE_BIRTH_ORG_TRY_NOT_OBSERVED')
      expect(acquiredTry(ORG_TRY)).toBe(true)
      expect(await advisoryHashGranted(holder.pid, orgLockText(otherOrg), 'ExclusiveLock')).toBe(true)
      expect(await advisoryHashGranted(state.pids[0], orgLockText(fixture.orgId), 'ExclusiveLock')).toBe(true)
      expect(await advisoryHashGranted(holder.pid, orgLockText(fixture.orgId), 'ExclusiveLock')).toBe(false)
      expect(await advisoryHashGranted(state.pids[0], orgLockText(otherOrg), 'ExclusiveLock')).toBe(false)
      pause.release()
      const result = await run
      expect(result.ok).toBe(true)
      expect(state.commits).toBe(1)
      expect(lockCounts()).toEqual({ org: 1, rollout: 0, shift: 1 })
      expect(await advisoryHashGranted(holder.pid, orgLockText(otherOrg), 'ExclusiveLock')).toBe(true)
      await expectPersisted(fixture, result.ok ? result.value?.defaultShift?.assignmentId ?? null : null)
    } finally {
      pause.release()
      await settle()
    }
  }, 20_000)

  it.each(['update', 'delete'] as const)('refuses birth while the canonical shift %s writer holds the org lock', async (mode) => {
    const fixture = await seed({ label: `shift-${mode}-writer`, org: true, group: true, segments: 1 })
    if (!fixture.orgId || !fixture.shiftId) throw new Error('SINGLE_BIRTH_SHIFT_REQUIRED')
    const holder = await control()
    await lockAttendanceTimezoneOrg(bindQuery(holder.client), fixture.orgId)
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    let watch: ReturnType<typeof watchLock> | undefined
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      const sampler = watchLock(state.pids[0])
      watch = sampler
      const started = Date.now()
      const result = await run
      const elapsed = Date.now() - started
      await sampler.stop()
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'AUTHORIZATION_INPUT_BUSY', status: 409, busyReason: 'lock_timeout' },
      })
      expect(acquiredTry(ORG_TRY)).toBe(false)
      expect(sampler.saw()).toBe(false)
      expect(elapsed).toBeLessThan(2500)
      expect(await advisoryHashGranted(holder.pid, orgLockText(fixture.orgId), 'ExclusiveLock')).toBe(true)
      await expectEmpty(fixture.userId)
      await rewriteShift(holder.client, fixture.orgId, fixture.shiftId, mode)
      await holder.finish('COMMIT')
      if (mode === 'update') {
        expect((await scopedRows('attendance_shifts', 'id', fixture.shiftId, 'id'))[0]?.name).toBe('Synthetic shift renamed')
        expect(await scopedRows('attendance_shift_segments', 'shift_id', fixture.shiftId, 'segment_index')).toHaveLength(1)
      } else {
        expect(await scopedRows('attendance_shifts', 'id', fixture.shiftId, 'id')).toEqual([])
        expect(await scopedRows('attendance_shift_segments', 'shift_id', fixture.shiftId, 'segment_index')).toEqual([])
      }
    } finally {
      await watch?.stop()
      await settle()
    }
  }, 20_000)

  it.each(['update', 'delete'] as const)('blocks the canonical shift %s writer on the org lock until birth commits', async (mode) => {
    const fixture = await seed({ label: `shift-${mode}-birth`, org: true, group: true, segments: 1 })
    if (!fixture.orgId || !fixture.shiftId) throw new Error('SINGLE_BIRTH_SHIFT_REQUIRED')
    const holder = await control()
    const pause = pauseOn((sql) => sql.includes(ORG_TRY))
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    let waiterDone = false
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await until(() => pause.pending(), 'SINGLE_BIRTH_ORG_TRY_NOT_OBSERVED')
      expect(acquiredTry(ORG_TRY)).toBe(true)
      const waiter = lockAttendanceTimezoneOrg(bindQuery(holder.client), fixture.orgId).then(() => {
        waiterDone = true
      })
      track(waiter)
      await blocked(holder.pid, state.pids[0])
      const waiting = await waitingQuery(holder.pid)
      expect(waiting).toContain('pg_advisory_xact_lock(hashtextextended')
      expect(waiting).not.toContain('pg_try')
      expect(waiterDone).toBe(false)
      pause.release()
      const result = await run
      expect(result.ok).toBe(true)
      expect(state.commits).toBe(1)
      await waiter
      if (mode === 'delete') {
        const deleted = await outcome(rewriteShift(holder.client, fixture.orgId, fixture.shiftId, mode))
        expect(deleted).toMatchObject({
          ok: false,
          error: { status: 409, code: 'ATTENDANCE_SHIFT_DELETE_BLOCKED' },
        })
        await holder.finish('ROLLBACK')
        expect((await counts(fixture.userId)).users).toBe(1)
        expect(await scopedRows('attendance_shifts', 'id', fixture.shiftId, 'id')).toHaveLength(1)
        expect(await scopedRows('attendance_shift_segments', 'shift_id', fixture.shiftId, 'segment_index')).toHaveLength(1)
        expect(await scopedRows('attendance_shift_assignments', 'user_id', fixture.userId, 'shift_id')).toHaveLength(1)
      } else {
        await rewriteShift(holder.client, fixture.orgId, fixture.shiftId, mode)
        await holder.finish('COMMIT')
        expect((await counts(fixture.userId)).users).toBe(1)
        expect((await scopedRows('attendance_shifts', 'id', fixture.shiftId, 'id'))[0]?.name).toBe('Synthetic shift renamed')
        expect(await scopedRows('attendance_shift_assignments', 'user_id', fixture.userId, 'shift_id')).toHaveLength(1)
      }
    } finally {
      pause.release()
      await settle()
    }
  }, 20_000)

  it('returns rollout busy without waiting when the exclusive rollout lock is already held', async () => {
    const fixture = await seed({ label: 'rollout-exclusive', org: true, group: true, segments: 2, rollout: true })
    if (!fixture.orgId) throw new Error('SINGLE_BIRTH_ORG_REQUIRED')
    const holder = await control()
    const key = rolloutLockText(fixture.orgId)
    await holder.client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key])
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    let watch: ReturnType<typeof watchLock> | undefined
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      const sampler = watchLock(state.pids[0])
      watch = sampler
      const started = Date.now()
      const result = await run
      const elapsed = Date.now() - started
      await sampler.stop()
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY', httpStatus: 503, lockClass: 'rollout' },
      })
      expect(acquiredTry(ROLLOUT_TRY)).toBe(false)
      expect(sampler.saw()).toBe(false)
      expect(elapsed).toBeLessThan(2500)
      expect(process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED ?? '').not.toContain(fixture.orgId)
      expect(await advisoryIntGranted(holder.pid, key, 'ExclusiveLock')).toBe(true)
      await expectEmpty(fixture.userId)
    } finally {
      await watch?.stop()
      await settle()
    }
  }, 20_000)

  it('keeps the multisegment share until commit, then the exclusive probe succeeds', async () => {
    const fixture = await seed({ label: 'rollout-share', org: true, group: true, segments: 2, rollout: true })
    if (!fixture.orgId) throw new Error('SINGLE_BIRTH_ORG_REQUIRED')
    const key = rolloutLockText(fixture.orgId)
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    const pause = pauseOn((sql) => sql.includes(ROLLOUT_TRY))
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    const probe = await control()
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await until(() => pause.pending(), 'SINGLE_BIRTH_ROLLOUT_TRY_NOT_OBSERVED')
      expect(acquiredTry(ROLLOUT_TRY)).toBe(true)
      expect(await advisoryIntGranted(state.pids[0], key, 'ShareLock')).toBe(true)
      const held = await probe.client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [key])
      expect(held.rows[0]?.acquired).toBe(false)
      await probe.finish('ROLLBACK')
      pause.release()
      const result = await run
      expect(result.ok).toBe(true)
      expect(state.commits).toBe(1)
      const after = await control()
      try {
        const released = await after.client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [key])
        expect(released.rows[0]?.acquired).toBe(true)
      } finally {
        await after.finish('ROLLBACK')
      }
      await expectPersisted(fixture, result.ok ? result.value?.defaultShift?.assignmentId ?? null : null)
    } finally {
      pause.release()
      restoreAllowlist()
      await settle()
    }
  }, 20_000)

  it('settles the rollout try while a share is held, an org waiter is blocked, and an exclusive is queued', async () => {
    const fixture = await seed({ label: 'rollout-queued', org: true, group: true, segments: 2, rollout: true })
    if (!fixture.orgId) throw new Error('SINGLE_BIRTH_ORG_REQUIRED')
    const key = rolloutLockText(fixture.orgId)
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    const pause = pauseOn((sql) => sql.includes(ORG_TRY))
    const run = track(createAdminUserBirthCommand(inputOf(fixture)))
    const share = await control()
    const exclusive = await control()
    let exclusiveDone = false
    let shareOrgDone = false
    let watch: ReturnType<typeof watchLock> | undefined
    try {
      await until(() => state.pids.length === 1, 'SINGLE_BIRTH_PID_NOT_OBSERVED')
      await until(() => pause.pending(), 'SINGLE_BIRTH_ORG_TRY_NOT_OBSERVED')
      expect(acquiredTry(ORG_TRY)).toBe(true)
      await share.client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key])
      const shareOrgWait = lockAttendanceTimezoneOrg(bindQuery(share.client), fixture.orgId).then(() => {
        shareOrgDone = true
      })
      track(shareOrgWait)
      await blocked(share.pid, state.pids[0])
      const shareSql = await waitingQuery(share.pid)
      expect(shareSql).toContain('pg_advisory_xact_lock(hashtextextended')
      expect(shareSql).not.toContain('pg_try')
      expect(shareOrgDone).toBe(false)
      const exclusiveWait = exclusive.client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]).then(() => {
        exclusiveDone = true
      })
      track(exclusiveWait)
      await blocked(exclusive.pid, share.pid)
      const exclusiveSql = await waitingQuery(exclusive.pid)
      expect(exclusiveSql).toContain('pg_advisory_xact_lock($1::bigint)')
      expect(exclusiveSql).not.toContain('pg_try')
      expect(exclusiveDone).toBe(false)
      const sampler = watchLock(state.pids[0])
      watch = sampler
      const started = Date.now()
      pause.release()
      const result = await run
      const elapsed = Date.now() - started
      await sampler.stop()
      const acquired = acquiredTry(ROLLOUT_TRY)
      expect(acquired === true || acquired === false).toBe(true)
      expect(sampler.saw()).toBe(false)
      expect(elapsed).toBeLessThan(2500)
      expect(await advisoryIntGranted(share.pid, key, 'ShareLock')).toBe(true)
      expect(exclusiveDone).toBe(false)
      await blocked(exclusive.pid, share.pid)
      if (acquired === true) {
        expect(result).toMatchObject({ ok: true })
        expect(state.commits).toBe(1)
        await expectPersisted(fixture, result.ok ? result.value?.defaultShift?.assignmentId ?? null : null)
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY', httpStatus: 503, lockClass: 'rollout' },
        })
        await expectEmpty(fixture.userId)
      }
    } finally {
      pause.release()
      await watch?.stop()
      restoreAllowlist()
      await settle()
    }
  }, 20_000)

  it('leaves the alias owner unchanged when the normalized email is already claimed', async () => {
    const fixture = await seed({ label: 'alias-conflict' })
    const ownerId = `single-birth-alias-owner-${randomUUID()}`
    const normalized = normalizeLoginIdentifier(fixture.email)
    if (!normalized) throw new Error('SINGLE_BIRTH_ALIAS_REQUIRED')
    await observer.query(
      `INSERT INTO users (id, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $1, 'Synthetic alias owner', 'synthetic-unused', 'user', '[]'::jsonb, true, false, 'activated')`,
      [ownerId],
    )
    await observer.query(
      "INSERT INTO user_login_aliases (user_id, kind, normalized_value, source) VALUES ($1, 'email', $2, 'synthetic')",
      [ownerId, normalized],
    )
    const ownerBefore = await scopedRows('user_login_aliases', 'user_id', ownerId, 'normalized_value')
    const result = await outcome(createAdminUserBirthCommand(inputOf(fixture)))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'ALIAS_CONFLICT', message: 'A login identifier is already claimed by another account' },
    })
    expect(state.commits).toBe(0)
    await expectEmpty(fixture.userId)
    expect(await scopedRows('user_login_aliases', 'user_id', ownerId, 'normalized_value')).toEqual(ownerBefore)
    expect(ownerBefore[0]?.user_id).toBe(ownerId)
    expect(ownerBefore[0]?.normalized_value).toBe(normalized)
  })

  it('rolls back the born user after native 22012 once the users insert returns and before born registration', async () => {
    const fixture = await seed({ label: 'users-fault' })
    const actorBefore = await scopedRows('users', 'id', fixture.actorId, 'id')
    const roleBefore = await scopedRows('roles', 'id', fixture.roleId, 'id')
    let fired = false
    let nativeCode: unknown
    state.afterSql = async (sql, _pid, client) => {
      if (fired || !/^INSERT INTO users\b/i.test(sql.trim())) return
      fired = true
      try { await client.query('SELECT 1 / 0') } catch (error) {
        nativeCode = (error as { code?: unknown }).code
        throw error
      }
    }
    const result = await outcome(createAdminUserBirthCommand(inputOf(fixture)))
    expect(result).toMatchObject({ ok: false, error: { code: '22012' } })
    expect(fired).toBe(true)
    expect(nativeCode).toBe('22012')
    await expectEmpty(fixture.userId)
    expect(await scopedRows('users', 'id', fixture.actorId, 'id')).toEqual(actorBefore)
    expect(await scopedRows('roles', 'id', fixture.roleId, 'id')).toEqual(roleBefore)
  })
})

type Holder = {
  client: PoolClient
  pid: number
  busy: boolean
  finish: (action: 'COMMIT' | 'ROLLBACK') => Promise<void>
}

type Fixture = {
  actorId: string
  userId: string
  roleId: string
  email: string
  orgId: string | null
  groupId: string | null
  shiftId: string | null
  isActive: boolean
  directPermissions: string[]
  admissionNamespaces: string[]
}

type SeedOptions = {
  label: string
  authority?: 'raw' | 'member'
  isActive?: boolean
  org?: boolean
  group?: boolean
  segments?: 0 | 1 | 2
  directory?: boolean
  direct?: boolean
  rollout?: boolean
}

type NeighborOwned = {
  userId: string
  roleId: string
  orgId: string
  groupId: string
  shiftId: string
}

function textColumn(name: string) {
  return name.endsWith('_at') || name.endsWith('_time') || name === 'hire_date' || name === 'start_date' || name === 'end_date' || name === 'access_generation' || name === 'purge_after'
}

async function runIdent(pool: PgPool, template: 'CREATE SCHEMA %I' | 'DROP SCHEMA IF EXISTS %I CASCADE', name: string) {
  if (!/^sb_[0-9a-f]{32}$/.test(name)) throw new Error('SINGLE_BIRTH_SCHEMA_INVALID')
  const formatted = await pool.query(`SELECT format('${template}', $1::text) AS sql`, [name])
  await pool.query(String((formatted.rows[0] as { sql?: unknown } | undefined)?.sql))
}

async function expectSchema(source: { query: (sql: string) => Promise<{ rows: ReadonlyArray<unknown> }> }) {
  const seen = await source.query('SELECT current_schema() AS schema')
  const schema = (seen.rows[0] as { schema?: unknown } | undefined)?.schema
  if (schema !== state.schema) throw new Error('SINGLE_BIRTH_SEARCH_PATH_REJECTED')
}
