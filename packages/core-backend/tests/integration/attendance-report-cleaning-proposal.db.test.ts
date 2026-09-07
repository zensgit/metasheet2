import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up, down } from '../../src/db/migrations/zzzz20260907110000_create_attendance_report_projection_anchors'
import { refreshAttendanceReportProjectionAnchor, withholdAttendanceReportProjectionAnchors, assertAttendanceCleaningActor, lockAttendanceCleaningProjectionAccess, readAttendanceCleaningSourceSeed, lockAttendanceCleaningSource } from '../../src/attendance/attendance-multitable-cleaning-authority'
import { getObjectFieldId } from '../../src/multitable/provisioning'
import { acquireCanonicalSheetFence, canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { AttendanceCleaningConnectionUncertainError, runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'

// This suite owns its database; never fall back to an application DATABASE_URL.
const source = process.env.ATTENDANCE_TEST_DATABASE_URL
const suite = source ? describe : describe.skip
suite('ACP projection authority real database', () => {
  const name = `attendance_acp_${randomUUID().replaceAll('-', '')}`
  const recordId = randomUUID()
  const calculationId = randomUUID()
  const rowKeyField = getObjectFieldId('org-acp:attendance', 'attendance_report_records', 'row_key')
  let admin: Pool
  let pool: Pool
  let db: Kysely<unknown>

  beforeAll(async () => {
    const url = new URL(source!)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('ACP_TEST_LOCAL_DATABASE_REQUIRED')
    }
    admin = new Pool({ connectionString: url.toString(), max: 1 })
    await admin.query(`CREATE DATABASE "${name}"`)
    url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.toString(), max: 2 })
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await pool.query(`
      CREATE TABLE meta_sheets (id text PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE meta_records (id text PRIMARY KEY, sheet_id text REFERENCES meta_sheets(id), data jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1);
      CREATE TABLE meta_fields (id text PRIMARY KEY, sheet_id text REFERENCES meta_sheets(id));
      CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean, activation_status text);
      CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean);
      CREATE TABLE user_roles (user_id text, role_id text);
      CREATE TABLE user_permissions (user_id text, permission_code text);
      CREATE TABLE role_permissions (role_id text, permission_code text);
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean);
      CREATE TABLE system_configs (key text PRIMARY KEY, value text);
      CREATE TABLE attendance_leave_types (id text PRIMARY KEY, org_id text, code text, name text, is_active boolean);
      CREATE TABLE attendance_overtime_rules (id text PRIMARY KEY, org_id text, code text, name text, is_active boolean);
      INSERT INTO users VALUES ('actor-acp', 'user', '[]', true, 'activated');
      INSERT INTO user_orgs VALUES ('actor-acp', 'org-acp', true);
      INSERT INTO user_permissions VALUES ('actor-acp', 'attendance:admin');
      INSERT INTO user_roles VALUES ('actor-acp', 'attendance_admin');
      INSERT INTO user_namespace_admissions VALUES ('actor-acp', 'attendance', true);
      CREATE TABLE plugin_multitable_object_registry (sheet_id text, project_id text, plugin_name text, object_id text);
      CREATE TABLE attendance_records (
        id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, work_date date NOT NULL,
        timezone text NOT NULL, first_in_at timestamptz, last_out_at timestamptz,
        work_minutes integer NOT NULL, late_minutes integer NOT NULL, early_leave_minutes integer NOT NULL,
        status text NOT NULL, is_workday boolean NOT NULL, projection_owner text NOT NULL,
        current_calculation_id uuid, visibility_state text NOT NULL, visibility_reason text NOT NULL,
        UNIQUE(id, org_id));
      CREATE TABLE attendance_record_calculations (
        id uuid PRIMARY KEY, attendance_record_id uuid NOT NULL, org_id text NOT NULL,
        version integer NOT NULL, mode text NOT NULL, outcome text NOT NULL,
        UNIQUE(id, attendance_record_id, org_id));
      INSERT INTO meta_sheets VALUES ('sheet_acp', NULL);
      INSERT INTO meta_sheets VALUES ('sheet_catalog', NULL);
      INSERT INTO meta_records(id, sheet_id) VALUES ('rec_acp', 'sheet_acp');
      INSERT INTO plugin_multitable_object_registry VALUES ('sheet_acp', 'org-acp:attendance', 'plugin-attendance', 'attendance_report_records');
      INSERT INTO plugin_multitable_object_registry VALUES ('sheet_catalog', 'org-acp:attendance', 'plugin-attendance', 'attendance_report_field_catalog');
    `)
    await pool.query('INSERT INTO meta_fields VALUES ($1, $2)', [rowKeyField, 'sheet_acp'])
    await pool.query(`
      ALTER TABLE meta_sheets ADD COLUMN base_id text, ADD COLUMN row_level_read_permissions_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN conditional_read_rules jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE meta_records ADD COLUMN created_by text, ADD COLUMN locked boolean NOT NULL DEFAULT false;
      ALTER TABLE meta_fields ADD COLUMN type text NOT NULL DEFAULT 'text', ADD COLUMN property jsonb NOT NULL DEFAULT '{}';
      CREATE TABLE platform_member_group_members (group_id uuid, user_id text);
      CREATE TABLE spreadsheet_permissions (sheet_id text, subject_type text, subject_id text, perm_code text);
      CREATE TABLE field_permissions (id uuid DEFAULT gen_random_uuid(), sheet_id text, field_id text, subject_type text, subject_id text, visible boolean, read_only boolean);
      CREATE TABLE record_permissions (id uuid DEFAULT gen_random_uuid(), sheet_id text, record_id text, subject_type text, subject_id text, access_level text);
    `)
    await pool.query('UPDATE meta_records SET data = $1', [JSON.stringify({ [rowKeyField]: 'synthetic-row' })])
    await pool.query(`INSERT INTO attendance_records VALUES
      ($1, 'org-acp', 'user-acp', '2026-09-07', 'UTC', NULL, NULL, 480, 10, 0,
       'late', true, 'w4', $2, 'active', 'active')`, [recordId, calculationId])
    await pool.query("ALTER TABLE attendance_records ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'")
    await pool.query(`INSERT INTO attendance_record_calculations VALUES
      ($1, $2, 'org-acp', 1, 'authoritative', 'completed')`, [calculationId, recordId])
    await up(db)
  }, 30_000)

  afterAll(async () => {
    if (db) await db.destroy()
    else if (pool) await pool.end()
    if (admin) {
      // All owning pools have closed before the scratch database is dropped.
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      const residue = await admin.query('SELECT count(*)::int AS count FROM pg_database WHERE datname = $1', [name])
      expect(residue.rows[0].count).toBe(0)
      await admin.end()
    }
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM meta_records')
  })

  it.each([
    { attendanceCleaningAuthority: true },
    { attendanceCleaningSheetIds: ['sheet_acp'] },
    { attendanceCleaningAuthority: false, attendanceCleaningSheetIds: ['sheet_acp'] },
    { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: [] },
  ])('rejects an incomplete ACP fence option before touching the connection: %j', async (options) => {
    let queries = 0
    await expect(Reflect.apply(runAttendanceResultOperationTransactionV1, undefined, [
      { query: async () => { queries += 1; throw new Error('CONNECTION_MUST_NOT_BE_USED') } },
      async () => null, options,
    ])).rejects.toThrow('W4C0_ATTENDANCE_CLEANING_REPLAY_INVALID')
    expect(queries).toBe(0)
  })

  it('experiments with a pre-BEGIN session fence in the exact one-argument writer lock space', async () => {
    const reader = await pool.connect()
    const writer = await pool.connect()
    const key = canonicalSheetFenceKey('sheet_acp')
    let held = false
    try {
      const acquired = await reader.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [key])
      held = acquired.rows[0].acquired
      expect(held).toBe(true)
      await reader.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      expect((await reader.query("SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = 'sheet_acp'")).rows[0].count).toBe(0)
      await writer.query('BEGIN')
      // Same one-argument bigint overload as the unconditional create helper.
      expect((await writer.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [key])).rows[0].acquired).toBe(false)
      // The two-int namespace is disjoint and must not be mistaken for protection.
      expect((await writer.query('SELECT pg_try_advisory_xact_lock(0, hashtext($1)) AS acquired', [key])).rows[0].acquired).toBe(true)
      await writer.query('ROLLBACK')
      await reader.query('COMMIT')
      expect((await reader.query('SELECT pg_advisory_unlock(hashtext($1)) AS released', [key])).rows[0].released).toBe(true)
      held = false
      await writer.query('BEGIN')
      await acquireCanonicalSheetFence((statement, params) => writer.query(statement, params), 'sheet_acp')
      await writer.query("INSERT INTO meta_records (id, sheet_id) VALUES ('rec_after_session', 'sheet_acp')")
      await writer.query('COMMIT')
      expect((await reader.query("SELECT count(*)::int AS count FROM meta_records WHERE id = 'rec_after_session'")).rows[0].count).toBe(1)
    } finally {
      await writer.query('ROLLBACK')
      await reader.query('ROLLBACK')
      if (held) expect((await reader.query('SELECT pg_advisory_unlock(hashtext($1)) AS released', [key])).rows[0].released).toBe(true)
      writer.release()
      reader.release()
    }
  })

  it('experiments with inverse lock order: initial try-lock does not prevent a later wait cycle', async () => {
    const first = await pool.connect()
    const second = await pool.connect()
    const sheetKey = canonicalSheetFenceKey('sheet_acp')
    const precedingKey = 'attendance-acp-test-only-preceding-lock'
    let held = false
    let waiting: Promise<unknown> | undefined
    try {
      held = (await first.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [sheetKey])).rows[0].acquired
      expect(held).toBe(true)
      const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await second.query('BEGIN')
      await second.query("SET LOCAL lock_timeout = '2000ms'")
      await second.query('SELECT pg_advisory_xact_lock(hashtext($1))', [precedingKey])
      // Deliberately synthetic preceding lock: this proves the candidate's hazard,
      // not that an existing production W4 caller uses this inverse order.
      waiting = acquireCanonicalSheetFence((statement, params) => second.query(statement, params), 'sheet_acp')
        .then(() => ({ acquired: true }), () => ({ acquired: false }))
      const deadline = Date.now() + 1500
      let blocked = false
      while (Date.now() < deadline) {
        blocked = (await first.query("SELECT wait_event_type = 'Lock' AS blocked FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.blocked === true
        if (blocked) break
      }
      expect(blocked).toBe(true)
      await first.query('BEGIN')
      await first.query("SET LOCAL lock_timeout = '100ms'")
      await expect(first.query('SELECT pg_advisory_xact_lock(hashtext($1))', [precedingKey])).rejects.toMatchObject({ code: '55P03' })
      await first.query('ROLLBACK')
      expect((await first.query('SELECT pg_advisory_unlock(hashtext($1)) AS released', [sheetKey])).rows[0].released).toBe(true)
      held = false
      expect(await waiting).toEqual({ acquired: true })
      await second.query('ROLLBACK')
      const residue = await first.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND pid IN (pg_backend_pid(), $1)", [pid])
      expect(residue.rows[0].count).toBe(0)
    } finally {
      await first.query('ROLLBACK')
      if (held) expect((await first.query('SELECT pg_advisory_unlock(hashtext($1)) AS released', [sheetKey])).rows[0].released).toBe(true)
      if (waiting) await waiting
      await second.query('ROLLBACK')
      second.release()
      first.release()
    }
  })

  it('requires a DB-fresh active same-org attendance administrator, not generic multitable write', async () => {
    const input = { orgId: 'org-acp', actorId: 'actor-acp', tokenSubjectUserId: 'actor-acp' }
    const client = await pool.connect()
    const check = async (candidate = input) => {
      await client.query('BEGIN')
      try {
        return await assertAttendanceCleaningActor((statement, params) => client.query(statement, params), candidate)
      } finally {
        await client.query('ROLLBACK')
      }
    }
    try {
      expect((await check()).userId).toBe('actor-acp')
      await pool.query('UPDATE user_namespace_admissions SET enabled = false')
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('DELETE FROM user_namespace_admissions')
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query("INSERT INTO user_namespace_admissions VALUES ('actor-acp', 'attendance', true)")
      expect((await check()).userId).toBe('actor-acp')
      await expect(check({ ...input, orgId: 'different-org' })).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await expect(check({ ...input, tokenSubjectUserId: 'different-actor' })).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query("UPDATE user_permissions SET permission_code = 'multitable:write'")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query("UPDATE users SET role = 'admin'")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query("UPDATE users SET role = 'user'")
      await pool.query("INSERT INTO user_roles VALUES ('actor-acp', 'admin')")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('DELETE FROM user_roles')
      await pool.query("INSERT INTO user_roles VALUES ('actor-acp', 'attendance_admin')")
      await pool.query("UPDATE user_permissions SET permission_code = 'attendance:admin'")
      await pool.query('UPDATE user_orgs SET is_active = false')
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('UPDATE user_orgs SET is_active = true')
      await pool.query('UPDATE users SET is_active = false')
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query("UPDATE users SET is_active = true, activation_status = 'pending'")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
    } finally {
      await pool.query("UPDATE user_permissions SET permission_code = 'attendance:admin'")
      await pool.query('UPDATE user_orgs SET is_active = true')
      await pool.query("UPDATE users SET role = 'user', is_active = true, activation_status = 'activated'")
      await pool.query('DELETE FROM user_roles')
      await pool.query("INSERT INTO user_roles VALUES ('actor-acp', 'attendance_admin')")
      await pool.query('DELETE FROM user_namespace_admissions')
      await pool.query("INSERT INTO user_namespace_admissions VALUES ('actor-acp', 'attendance', true)")
      client.release()
    }
  })

  it('releases actual session fences on partial acquisition, body refusal and serialization retry without stealing reentrant locks', async () => {
    const client = await pool.connect()
    const writer = await pool.connect()
    const statements: string[] = []
    const connection = { query: (statement: string, params?: readonly unknown[]) => {
      statements.push(statement)
      return client.query(statement, params ? [...params] : [])
    } }
    const options = { attendanceCleaningAuthority: true as const, attendanceCleaningSheetIds: ['sheet_acp', 'sheet_catalog'] }
    const keys = (await client.query(`SELECT DISTINCT hashtext(value)::bigint AS key
      FROM unnest($1::text[]) AS value ORDER BY key`, [options.attendanceCleaningSheetIds.map(canonicalSheetFenceKey)])).rows.map(row => String(row.key))
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const ownLocks = async () => (await writer.query("SELECT count(*)::int AS count FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'", [pid])).rows[0].count
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT pg_advisory_xact_lock($1::bigint)', [keys[1]])
      await expect(runAttendanceResultOperationTransactionV1(connection, async () => { throw new Error('BODY_MUST_NOT_RUN') }, options))
        .rejects.toThrow('W4C0_ATTENDANCE_CLEANING_AUTHORITY_BUSY')
      expect(await ownLocks()).toBe(0)
      expect(statements.filter(statement => statement.startsWith('SELECT pg_advisory_unlock'))).toHaveLength(1)
      await writer.query('ROLLBACK')
      await client.query('SELECT pg_advisory_lock($1::bigint)', [keys[0]])
      await expect(runAttendanceResultOperationTransactionV1(connection, async () => null, options))
        .rejects.toThrow('W4C0_ATTENDANCE_CLEANING_REPLAY_INVALID')
      expect(await ownLocks()).toBe(1)
      expect((await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [keys[0]])).rows[0].released).toBe(true)
      expect((await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [keys[0]])).rows[0].released).toBe(false)
      await expect(runAttendanceResultOperationTransactionV1(connection, async () => { throw new Error('SYNTHETIC_REFUSAL') }, options))
        .rejects.toThrow('SYNTHETIC_REFUSAL')
      expect(await ownLocks()).toBe(0)
      statements.length = 0
      let attempts = 0
      expect(await runAttendanceResultOperationTransactionV1(connection, async () => {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('SYNTHETIC_SERIALIZATION'), { code: '40001' })
        return 'completed'
      }, { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp', 'sheet_acp'] })).toBe('completed')
      expect(attempts).toBe(2)
      expect(statements.filter(statement => statement.startsWith('SELECT pg_try_advisory_lock'))).toHaveLength(2)
      expect(statements.filter(statement => statement.startsWith('SELECT pg_advisory_unlock'))).toHaveLength(2)
      const firstRelease = statements.findIndex(statement => statement.startsWith('SELECT pg_advisory_unlock'))
      const secondBegin = statements.lastIndexOf('BEGIN ISOLATION LEVEL SERIALIZABLE')
      expect(firstRelease).toBeLessThan(secondBegin)
      expect(await ownLocks()).toBe(0)
    } finally {
      await writer.query('ROLLBACK')
      await client.query('ROLLBACK')
      // Exact candidate keys only; no unlock-all, including when an assertion fails.
      for (const key of keys) await client.query('SELECT pg_advisory_unlock($1::bigint)', [key])
      writer.release()
      client.release()
    }
  })

  it.each(['attendance_leave_types', 'attendance_overtime_rules'] as const)(
    'fences new and changed %s definitions before the SERIALIZABLE snapshot', async (table) => {
      // Closed two-table fixture list above, never an HTTP-provided SQL identifier.
      await pool.query(`INSERT INTO ${table} (id, org_id, name, is_active) VALUES ('existing', 'org-acp', 'before', true)`)
      const client = await pool.connect()
      let changed = false
      const connection = { query: async (statement: string, params?: readonly unknown[]) => {
        if (statement.startsWith('LOCK TABLE') && !changed) {
          await pool.query(`UPDATE ${table} SET name = 'after' WHERE id = 'existing'`)
          await pool.query(`INSERT INTO ${table} (id, org_id, name, is_active) VALUES ('new', 'org-acp', 'added', true)`)
          changed = true
        }
        return client.query(statement, params ? [...params] : [])
      } }
      try {
        const definitions = await runAttendanceResultOperationTransactionV1(connection, async () =>
          (await client.query(`SELECT id, name FROM ${table} WHERE org_id = 'org-acp' AND is_active ORDER BY id`)).rows,
        { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] })
        expect(definitions).toEqual([{ id: 'existing', name: 'after' }, { id: 'new', name: 'added' }])
        const writer = await pool.connect()
        try {
          await writer.query('BEGIN')
          await writer.query(`UPDATE ${table} SET name = 'in-flight' WHERE id = 'existing'`)
          await expect(runAttendanceResultOperationTransactionV1(connection, async () => null,
            { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] }))
            .rejects.toThrow('W4C0_ATTENDANCE_CLEANING_AUTHORITY_BUSY')
          await writer.query('ROLLBACK')
          await runAttendanceResultOperationTransactionV1(connection, async () => {
            await writer.query('BEGIN')
            await writer.query("SET LOCAL lock_timeout = '100ms'")
            await expect(writer.query(`INSERT INTO ${table} (id, org_id, name, is_active) VALUES ('during', 'org-acp', 'during', true)`))
              .rejects.toMatchObject({ code: '55P03' })
            await writer.query('ROLLBACK')
          }, { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] })
        } finally {
          await writer.query('ROLLBACK')
          writer.release()
        }
      } finally {
        client.release()
        await pool.query(`DELETE FROM ${table}`)
      }
    },
  )

  it('locks the canonical-anchored source and sees catalog insertion plus retries a concurrent catalog edit', async () => {
    const requested = getObjectFieldId('org-acp:attendance', 'attendance_report_records', 'cleaning_requested')
    const reason = getObjectFieldId('org-acp:attendance', 'attendance_report_records', 'cleaning_reason')
    await pool.query('INSERT INTO meta_fields (id, sheet_id) VALUES ($1, $3), ($2, $3) ON CONFLICT DO NOTHING', [requested, reason, 'sheet_acp'])
    await pool.query("INSERT INTO user_permissions VALUES ('actor-acp', 'multitable:write')")
    await pool.query('INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, $3)',
      ['rec_acp', 'sheet_acp', JSON.stringify({ [rowKeyField]: 'synthetic-row', [requested]: true, [reason]: 'synthetic reason' })])
    await pool.query("INSERT INTO meta_records (id, sheet_id, data) VALUES ('catalog_existing', 'sheet_catalog', '{\"revision\":1}')")
    const client = await pool.connect()
    const input = { orgId: 'org-acp', actorId: 'actor-acp', tokenSubjectUserId: 'actor-acp', projectionRecordId: 'rec_acp', expectedVersion: 1 }
    const query = (statement: string, params?: unknown[]) => client.query(statement, params)
    let inserted = false
    let edited = false
    let bodies = 0
    try {
      await client.query('BEGIN')
      await refreshAttendanceReportProjectionAnchor(query, { projectionRecordId: 'rec_acp', canonicalRecordId: recordId, sourceFingerprint: 'a'.repeat(40) })
      await client.query('COMMIT')
      await client.query('BEGIN')
      const seed = await readAttendanceCleaningSourceSeed(query, input)
      await client.query('COMMIT')
      const observed = { query: async (statement: string, params?: readonly unknown[]) => {
        if (statement.startsWith('SELECT pg_try_advisory_lock') && !inserted) {
          const creator = await pool.connect()
          try {
            await creator.query('BEGIN')
            await acquireCanonicalSheetFence((sql, values) => creator.query(sql, values), 'sheet_catalog')
            await creator.query("INSERT INTO meta_records (id, sheet_id, data) VALUES ('catalog_new', 'sheet_catalog', '{\"revision\":1}')")
            await creator.query('COMMIT')
            inserted = true
          } finally {
            await creator.query('ROLLBACK')
            creator.release()
          }
        }
        if (statement.startsWith('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id') && !edited) {
          // Existing PATCH does not require the writer flag. FOR UPDATE must detect
          // its post-snapshot commit instead of silently using the old definition.
          await pool.query("UPDATE meta_records SET data = '{\"revision\":2}', version = version + 1 WHERE id = 'catalog_existing'")
          edited = true
        }
        return client.query(statement, params ? [...params] : [])
      } }
      const result = await runAttendanceResultOperationTransactionV1(observed, async () => {
        bodies += 1
        return lockAttendanceCleaningSource(observed.query, input, seed)
      }, { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp', 'sheet_catalog'] })
      expect(inserted && edited).toBe(true)
      expect(bodies).toBe(2)
      expect(result.catalog).toEqual([
        { id: 'catalog_existing', data: { revision: 2 }, version: 2 },
        { id: 'catalog_new', data: { revision: 1 }, version: 1 },
      ])
      expect(result.record.canonical_record_id).toBe(recordId)
      expect(result.projection.data[requested]).toBe(true)
      await expect(runAttendanceResultOperationTransactionV1(observed, () => lockAttendanceCleaningSource(observed.query, input,
        { ...seed, canonicalRecordId: randomUUID() }),
      { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp', 'sheet_catalog'] })).rejects.toThrow()
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await pool.query("DELETE FROM user_permissions WHERE permission_code = 'multitable:write'")
      await pool.query('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [[requested, reason]])
    }
  })

  it.each(['acquire', 'begin', 'commit', 'rollback', 'unlock'] as const)(
    'marks the pooled connection for destruction after an uncertain %s result', async (fault) => {
      const client = await pool.connect()
      let injected = false
      let bodyCalls = 0
      const connection = { query: async (statement: string, params?: readonly unknown[]) => {
        const matches = fault === 'acquire' ? statement.startsWith('SELECT pg_try_advisory_lock')
          : fault === 'unlock' ? statement.startsWith('SELECT pg_advisory_unlock')
            : statement.startsWith(fault.toUpperCase())
        const result = await client.query(statement, params ? [...params] : [])
        if (matches && !injected) {
          injected = true
          // Lose the response after the real server action, not before it.
          throw new Error('SYNTHETIC_LOST_RESPONSE')
        }
        return result
      } }
      try {
        await expect(runAttendanceResultOperationTransactionV1(connection, async () => {
          bodyCalls += 1
          if (fault === 'rollback') throw new Error('SYNTHETIC_BODY_REFUSAL')
          return null
        }, { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] }))
          .rejects.toBeInstanceOf(AttendanceCleaningConnectionUncertainError)
        expect(injected).toBe(true)
        expect(bodyCalls).toBeLessThanOrEqual(1)
      } finally {
        // This is the actual pg pool destruction contract, not a normal release.
        client.release(new Error('SYNTHETIC_DESTROY_UNCERTAIN_CONNECTION'))
      }
      const observer = await pool.connect()
      try {
        await observer.query('BEGIN')
        expect((await observer.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [canonicalSheetFenceKey('sheet_acp')])).rows[0].acquired).toBe(true)
      } finally {
        await observer.query('ROLLBACK')
        observer.release()
      }
    },
  )

  it('locks effective proposal access and refuses sheet, field, row, duplicate and liveness drift', async () => {
    const requested = getObjectFieldId('org-acp:attendance', 'attendance_report_records', 'cleaning_requested')
    const reason = getObjectFieldId('org-acp:attendance', 'attendance_report_records', 'cleaning_reason')
    await pool.query('INSERT INTO meta_fields (id, sheet_id) VALUES ($1, $3), ($2, $3)', [requested, reason, 'sheet_acp'])
    await pool.query("INSERT INTO user_permissions VALUES ('actor-acp', 'multitable:write')")
    await pool.query('INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, $3)',
      ['rec_acp', 'sheet_acp', JSON.stringify({ [rowKeyField]: 'synthetic-row', [requested]: true, [reason]: 'synthetic reason' })])
    const client = await pool.connect()
    const connection = { query: (statement: string, params?: readonly unknown[]) => client.query(statement, params ? [...params] : []) }
    const check = () => runAttendanceResultOperationTransactionV1(connection, async () =>
      lockAttendanceCleaningProjectionAccess((statement, params) => client.query(statement, params),
        { actorId: 'actor-acp', tokenSubjectUserId: 'actor-acp', orgId: 'org-acp', projectionRecordId: 'rec_acp' }),
    { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] })
    try {
      expect((await check()).fieldIds).toEqual({ requested, reason })
      let duplicateCommitted = false
      const insertBeforeFence = async (statement: string, params?: readonly unknown[]) => {
          if ((statement === 'SELECT pg_advisory_xact_lock(hashtext($1))'
            || statement === 'SELECT pg_try_advisory_lock($1::bigint) AS acquired') && !duplicateCommitted) {
            const creator = await pool.connect()
            try {
              await creator.query('BEGIN')
              await acquireCanonicalSheetFence((sql, values) => creator.query(sql, values), 'sheet_acp')
              await creator.query("INSERT INTO meta_records (id, sheet_id, data) SELECT 'rec_snapshot_duplicate', sheet_id, data FROM meta_records WHERE id = 'rec_acp'")
              await creator.query('COMMIT')
              duplicateCommitted = true
            } finally { creator.release() }
          }
          return connection.query(statement, params)
      }
      await expect(runAttendanceResultOperationTransactionV1({ query: insertBeforeFence }, async () =>
        lockAttendanceCleaningProjectionAccess(insertBeforeFence,
          { actorId: 'actor-acp', tokenSubjectUserId: 'actor-acp', orgId: 'org-acp', projectionRecordId: 'rec_acp' }),
      { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] })).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      expect(duplicateCommitted).toBe(true)
      await pool.query("DELETE FROM meta_records WHERE id = 'rec_snapshot_duplicate'")
      // The deny commits exactly before the fence. Moving that fence after the
      // wrapper's first SELECT leaves an old snapshot and makes this reject RED.
      let denyCommitted = false
      const interleaved = { query: async (statement: string, params?: readonly unknown[]) => {
        if (/^LOCK TABLE/.test(statement) && !denyCommitted) {
          await pool.query("INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ('sheet_acp', $1, 'user', 'actor-acp', true, true)", [reason])
          denyCommitted = true
        }
        return connection.query(statement, params)
      } }
      await expect(runAttendanceResultOperationTransactionV1(interleaved, async () =>
        lockAttendanceCleaningProjectionAccess((statement, params) => client.query(statement, params),
          { actorId: 'actor-acp', tokenSubjectUserId: 'actor-acp', orgId: 'org-acp', projectionRecordId: 'rec_acp' }),
      { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] })).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      expect(denyCommitted).toBe(true)
      await pool.query('DELETE FROM field_permissions')
      expect((await check()).projection.id).toBe('rec_acp')
      const competingWriter = await pool.connect()
      try {
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await competingWriter.query('BEGIN')
        await competingWriter.query("INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ('sheet_acp', $1, 'user', 'actor-acp', true, true)", [reason])
        await expect(check()).rejects.toThrow('W4C0_ATTENDANCE_CLEANING_AUTHORITY_BUSY')
        const locks = await competingWriter.query("SELECT count(*)::int AS count FROM pg_locks WHERE pid = $1 AND mode = 'ShareLock' AND locktype = 'relation'", [pid])
        expect(locks.rows[0].count).toBe(0)
      } finally {
        await competingWriter.query('ROLLBACK')
        competingWriter.release()
      }
      expect((await check()).projection.id).toBe('rec_acp')
      const writer = await pool.connect()
      let insertion: Promise<void> | undefined
      let inserted = false
      try {
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await runAttendanceResultOperationTransactionV1(connection, async () => {
        await lockAttendanceCleaningProjectionAccess((statement, params) => client.query(statement, params),
          { actorId: 'actor-acp', tokenSubjectUserId: 'actor-acp', orgId: 'org-acp', projectionRecordId: 'rec_acp' })
        insertion = writer.query("INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ('sheet_acp', $1, 'user', 'actor-acp', true, true)", [reason])
          .then(() => { inserted = true })
        let waiting = false
        const deadline = Date.now() + 2000
        while (!inserted && !waiting && Date.now() < deadline) {
          await client.query('SELECT pg_stat_clear_snapshot()')
          const state = await client.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid])
          waiting = state.rows[0]?.wait_event_type === 'Lock'
        }
        expect(waiting, 'new deny must wait for the ACP authority transaction').toBe(true)
        expect(inserted).toBe(false)
        }, { attendanceCleaningAuthority: true, attendanceCleaningSheetIds: ['sheet_acp'] })
      } finally {
        if (insertion) await insertion
        writer.release()
      }
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('DELETE FROM field_permissions')
      expect((await check()).projection.id).toBe('rec_acp')
      await pool.query("INSERT INTO spreadsheet_permissions VALUES ('sheet_acp', 'user', 'actor-acp', 'read')")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('DELETE FROM spreadsheet_permissions')
      expect((await check()).projection.id).toBe('rec_acp')
      await pool.query("INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ('sheet_acp', $1, 'user', 'actor-acp', true, true)", [reason])
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('UPDATE field_permissions SET visible = false, read_only = false')
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('DELETE FROM field_permissions')
      expect((await check()).projection.id).toBe('rec_acp')
      await pool.query("UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = 'sheet_acp'")
      await pool.query("INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ('sheet_acp', 'rec_acp', 'user', 'actor-acp', 'none')")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query('DELETE FROM record_permissions')
      expect((await check()).projection.id).toBe('rec_acp')
      await pool.query("INSERT INTO meta_records (id, sheet_id, data) SELECT 'rec_duplicate', sheet_id, data FROM meta_records WHERE id = 'rec_acp'")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
      await pool.query("DELETE FROM meta_records WHERE id = 'rec_duplicate'")
      expect((await check()).projection.id).toBe('rec_acp')
      await pool.query("UPDATE meta_sheets SET deleted_at = now() WHERE id = 'sheet_acp'")
      await expect(check()).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
    } finally {
      await pool.query('DELETE FROM spreadsheet_permissions; DELETE FROM field_permissions; DELETE FROM record_permissions')
      await pool.query("DELETE FROM user_permissions WHERE permission_code = 'multitable:write'")
      await pool.query('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [[requested, reason]])
      await pool.query("UPDATE meta_sheets SET deleted_at = NULL, row_level_read_permissions_enabled = false WHERE id = 'sheet_acp'")
      client.release()
    }
  })

  it('refreshes an anchor from a PostgreSQL date and guards canonical identity and nonempty down', async () => {
    await pool.query('INSERT INTO meta_records(id, sheet_id, data) VALUES ($1, $2, $3)',
      ['rec_acp', 'sheet_acp', JSON.stringify({ [rowKeyField]: 'synthetic-row' })])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await refreshAttendanceReportProjectionAnchor((sql, params) => client.query(sql, params), {
        projectionRecordId: 'rec_acp', canonicalRecordId: recordId, sourceFingerprint: 'a'.repeat(40),
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    const anchor = await pool.query('SELECT * FROM attendance_report_projection_anchors')
    expect(anchor.rows).toHaveLength(1)
    expect(anchor.rows[0].source_selector).toBe('current_calculation')
    expect(anchor.rows[0].source_calculation_id).toBe(calculationId)
    await expect(pool.query("UPDATE attendance_report_projection_anchors SET org_id = 'other-org'"))
      .rejects.toMatchObject({ message: 'ATTENDANCE_CLEANING_ANCHOR_IDENTITY_IMMUTABLE' })
    await expect(down(db)).rejects.toThrow('ATTENDANCE_CLEANING_ANCHOR_DOWN_IN_USE')
    await up(db)
    expect((await pool.query('SELECT count(*)::int AS count FROM attendance_report_projection_anchors')).rows[0].count).toBe(1)
    await pool.query('DELETE FROM meta_records')
    expect((await pool.query('SELECT count(*)::int AS count FROM attendance_report_projection_anchors')).rows[0].count).toBe(0)
    await down(db)
    await down(db)
    await up(db)
  })

  it('rejects a replay with missing canonical uniqueness instead of accepting drift', async () => {
    await pool.query('ALTER TABLE attendance_report_projection_anchors DROP CONSTRAINT uq_attendance_report_projection_anchor_canonical')
    try {
      await expect(up(db)).rejects.toThrow('ATTENDANCE_CLEANING_ANCHOR_SCHEMA_DRIFT')
    } finally {
      await pool.query('ALTER TABLE attendance_report_projection_anchors ADD CONSTRAINT uq_attendance_report_projection_anchor_canonical UNIQUE (org_id, canonical_record_id)')
    }
  })

  it.each([
    ['nullable calculation revision',
      'ALTER TABLE attendance_report_projection_anchors ALTER COLUMN source_calculation_version DROP NOT NULL',
      'ALTER TABLE attendance_report_projection_anchors ALTER COLUMN source_calculation_version SET NOT NULL'],
    ['changed timestamp default',
      "ALTER TABLE attendance_report_projection_anchors ALTER COLUMN created_at SET DEFAULT '2020-01-01'::timestamptz",
      'ALTER TABLE attendance_report_projection_anchors ALTER COLUMN created_at SET DEFAULT now()'],
    ['disabled immutable trigger',
      'ALTER TABLE attendance_report_projection_anchors DISABLE TRIGGER trg_attendance_report_projection_anchor_identity',
      'ALTER TABLE attendance_report_projection_anchors ENABLE TRIGGER trg_attendance_report_projection_anchor_identity'],
  ])('rejects catalog drift: %s', async (_name, mutation, restore) => {
    await pool.query(mutation)
    try {
      await expect(up(db)).rejects.toThrow('ATTENDANCE_CLEANING_ANCHOR_SCHEMA_DRIFT')
    } finally {
      await pool.query(restore)
    }
    await up(db)
  })

  it('withholds the full duplicate group even when the caller supplies only the first page', async () => {
    await pool.query('INSERT INTO meta_records(id, sheet_id, data) VALUES ($1, $2, $3)',
      ['rec_acp', 'sheet_acp', JSON.stringify({ [rowKeyField]: 'synthetic-row' })])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await refreshAttendanceReportProjectionAnchor((statement, params) => client.query(statement, params), {
        projectionRecordId: 'rec_acp', canonicalRecordId: recordId, sourceFingerprint: 'a'.repeat(40),
      })
      await client.query('COMMIT')
      await pool.query(`INSERT INTO meta_records(id, sheet_id, data)
        SELECT 'rec_duplicate_' || n, 'sheet_acp', $1::jsonb FROM generate_series(1, 55) n`,
      [JSON.stringify({ [rowKeyField]: 'synthetic-row' })])
      await client.query('BEGIN')
      await withholdAttendanceReportProjectionAnchors((statement, params) => client.query(statement, params),
        Array.from({ length: 50 }, (_, index) => `rec_duplicate_${index + 1}`))
      await client.query('COMMIT')
      expect((await pool.query('SELECT count(*)::int AS count FROM attendance_report_projection_anchors')).rows[0].count).toBe(0)
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await pool.query('DELETE FROM meta_records')
    }
  })

  it('rechecks a duplicate committed between initial scope lookup and the sync fence', async () => {
    const data = JSON.stringify({ [rowKeyField]: 'synthetic-row' })
    await pool.query('INSERT INTO meta_records(id, sheet_id, data) VALUES ($1, $2, $3)', ['rec_acp', 'sheet_acp', data])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await refreshAttendanceReportProjectionAnchor((statement, params) => client.query(statement, params), {
        projectionRecordId: 'rec_acp', canonicalRecordId: recordId, sourceFingerprint: 'a'.repeat(40),
      })
      await client.query('COMMIT')
      let raced = false
      await client.query('BEGIN')
      await refreshAttendanceReportProjectionAnchor(async (statement, params) => {
        const result = await client.query(statement, params)
        if (!raced && statement.includes('SELECT registry.sheet_id, registry.project_id')) {
          raced = true
          const writer = await pool.connect()
          try {
            await writer.query('BEGIN')
            await acquireCanonicalSheetFence((text, args) => writer.query(text, args), 'sheet_acp')
            await writer.query('INSERT INTO meta_records(id, sheet_id, data) VALUES ($1, $2, $3)', ['rec_racing', 'sheet_acp', data])
            await writer.query('COMMIT')
          } finally {
            await writer.query('ROLLBACK')
            writer.release()
          }
        }
        return result
      }, { projectionRecordId: 'rec_acp', canonicalRecordId: recordId, sourceFingerprint: 'a'.repeat(40) })
      await client.query('COMMIT')
      expect(raced).toBe(true)
      expect((await pool.query('SELECT count(*)::int AS count FROM attendance_report_projection_anchors')).rows[0].count).toBe(0)
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await pool.query('DELETE FROM meta_records')
    }
  })

  it('refuses down when an in-flight anchor insert commits before its exclusive lock', async () => {
    await pool.query("INSERT INTO meta_records(id, sheet_id) VALUES ('rec_acp', 'sheet_acp')")
    const writer = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query(`INSERT INTO attendance_report_projection_anchors
        (projection_record_id, org_id, canonical_record_id, source_selector,
         source_calculation_id, source_calculation_version, canonical_source_digest, source_fingerprint)
        VALUES ('rec_acp', 'org-acp', $1, 'current_calculation', $2, 1, $3, $4)`,
      [recordId, calculationId, 'a'.repeat(64), 'b'.repeat(40)])
      pending = down(db).then(() => null, error => error)
      const deadline = Date.now() + 3000
      let waiting = false
      while (Date.now() < deadline) {
        const active = await admin.query(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'`, [name])
        if (active.rows[0].count > 0) { waiting = true; break }
      }
      expect(waiting).toBe(true)
      await writer.query('COMMIT')
      expect(await pending).toMatchObject({ message: 'ATTENDANCE_CLEANING_ANCHOR_DOWN_IN_USE' })
      expect((await pool.query('SELECT count(*)::int AS count FROM attendance_report_projection_anchors')).rows[0].count).toBe(1)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      if (pending) await pending
    }
  })

  it('refuses a colliding guard function when the anchor table is absent', async () => {
    await pool.query('DELETE FROM meta_records')
    await down(db)
    await pool.query(`CREATE FUNCTION attendance_report_projection_anchor_identity_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`)
    try {
      await expect(up(db)).rejects.toThrow('ATTENDANCE_CLEANING_ANCHOR_SCHEMA_DRIFT')
      const body = await pool.query("SELECT prosrc FROM pg_proc WHERE oid = 'attendance_report_projection_anchor_identity_guard()'::regprocedure")
      expect(body.rows[0].prosrc).toBe(' BEGIN RETURN NEW; END; ')
      expect((await pool.query("SELECT to_regclass('attendance_report_projection_anchors') AS table_name")).rows[0].table_name).toBeNull()
    } finally {
      await pool.query('DROP FUNCTION attendance_report_projection_anchor_identity_guard()')
    }
    await up(db)
  })
})
