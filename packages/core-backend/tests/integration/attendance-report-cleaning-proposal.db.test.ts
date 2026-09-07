import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up, down } from '../../src/db/migrations/zzzz20260907110000_create_attendance_report_projection_anchors'
import { refreshAttendanceReportProjectionAnchor, withholdAttendanceReportProjectionAnchors } from '../../src/attendance/attendance-multitable-cleaning-authority'
import { getObjectFieldId } from '../../src/multitable/provisioning'
import { acquireCanonicalSheetFence } from '../../src/multitable/canonical-sheet-fence'

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
