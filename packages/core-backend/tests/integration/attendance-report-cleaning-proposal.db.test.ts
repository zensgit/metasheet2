import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up, down } from '../../src/db/migrations/zzzz20260907110000_create_attendance_report_projection_anchors'
import { refreshAttendanceReportProjectionAnchor, withholdAttendanceReportProjectionAnchors, assertAttendanceCleaningActor, lockAttendanceCleaningProjectionAccess } from '../../src/attendance/attendance-multitable-cleaning-authority'
import { getObjectFieldId } from '../../src/multitable/provisioning'
import { acquireCanonicalSheetFence } from '../../src/multitable/canonical-sheet-fence'
import { runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'

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
      INSERT INTO meta_records(id, sheet_id) VALUES ('rec_acp', 'sheet_acp');
      INSERT INTO plugin_multitable_object_registry VALUES ('sheet_acp', 'org-acp:attendance', 'plugin-attendance', 'attendance_report_records');
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
    { attendanceCleaningAuthority: true })
    try {
      expect((await check()).fieldIds).toEqual({ requested, reason })
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
      { attendanceCleaningAuthority: true })).rejects.toThrow('ATTENDANCE_CLEANING_FORBIDDEN')
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
        }, { attendanceCleaningAuthority: true })
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
