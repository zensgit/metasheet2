/**
 * D21 authorization version protocol (slice Y5a) — the real-PostgreSQL half of the proof.
 *
 *   M — trigger coverage, writer by writer, through RAW SQL on the pool (no helper in the path: the
 *       same statements a psql script, a data migration or a plugin raw query would issue), including
 *       two FK CASCADES (permissions → user_permissions, platform_member_groups → members), the
 *       meta_sheets / users column-conditional triggers (an unrelated column edit does not bump), the
 *       meta_fields visibility derivation (options edits do not bump), the perf statement (an
 *       ordinary meta_records write bumps NOTHING) and the one encoding the trigger does not read (M-10:
 *       a legacy jsonb-STRING property, listed in the hard-condition registry);
 *   B — two-connection barriers with a real admission holder: a writer blocks until the holder
 *       commits; a revoke committed first is visible to the next holder; joining a deny-carrying
 *       member group blocks through the subject row; a bound-record write blocks through the record
 *       FOR SHARE; an access-graph writer (mutex bump first) is SERIALIZED, no deadlock;
 *   K — the holder-vs-multi-row-writer cycle (writer holds the subject row exclusively and then wants
 *       the sheet row the holder shares) ends in 40P01 mapped to the typed CONFLICT, never a pass;
 *   P — posture: all 13 triggers present and enabled; the migration's down() removes them and up() is
 *       idempotent (run last; restored in finally).
 *
 * Waits are bounded by wall time and observed through pg_stat_activity / pg_blocking_pids — no sleeps
 * stand in for a lock. CI: DATABASE_URL-gated; excluded from the no-DB default vitest config (so a
 * describeIfDatabase skip cannot pass as green) and wired as a WHOLE FILE into the approval real-DB
 * step of .github/workflows/plugin-tests.yml. EXPECT_DB=1 arms the anti-skip sentinel. The field-row writer rule
 * cases (the #6792 follow-up) are registered at the end: authz-version-field-row-order-realdb.cases.ts.
 */
import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  dropAuthorizationVersionProtocol,
  installAuthorizationVersionProtocol,
} from '../../src/db/migrations/zzzz20261106110500_add_authorization_version_rows'
import { lockUsersForAccessGraphWrite } from '../../src/directory/access-graph-mutex'
import {
  AUTHORIZATION_PROTOCOL_GAPS,
  AUTHORIZATION_VERSION_TRIGGERS,
  AuthorizationVersionProtocolError,
  SHEET_PERMISSION_VERSIONS_TABLE,
  SUBJECT_AUTHORIZATION_VERSIONS_TABLE,
  bumpSheetPermissionVersions,
  bumpSubjectAuthorizationVersions,
  isAuthorizationVersionConflict,
  lockAuthorizationVersionsForAdmission,
  verifyAuthorizationVersionTriggerPosture,
} from '../../src/multitable/authz-version-protocol'
import { loadFieldsForSheet } from '../../src/multitable/loaders'
import { isFieldPermissionHidden } from '../../src/multitable/permission-derivation'
import { defineAuthzVersionFieldRowOrderRealDbCases } from './authz-version-field-row-order-realdb.cases'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECT_DB=1 must actually provide a database', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const P = `y5a_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
const ACTOR = `${P}_actor`
const SUBJECT = `${P}_subject`
const TENANT = `${P}_tenant`
const SHEET = `${P}_sheet`
const FIELD = `${P}_field`
const RECORD = `${P}_record`
const ROLE = `${P}_role`
const PERMISSION = `${P}:perm`

describeIfDatabase.sequential('D21 authorization version protocol (real PostgreSQL)', () => {
  let pool: Pool
  let holder: PoolClient
  let writer: PoolClient
  let inspector: PoolClient
  let groupId = ''

  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params)
  const sheetVersion = async (sheetId = SHEET): Promise<number> => {
    const { rows } = await q(`SELECT version::text AS version FROM ${SHEET_PERMISSION_VERSIONS_TABLE} WHERE sheet_id = $1`, [sheetId])
    return rows[0] ? Number(rows[0].version) : 0
  }
  const subjectVersion = async (userId: string): Promise<number> => {
    const { rows } = await q(`SELECT version::text AS version FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id = $1`, [userId])
    return rows[0] ? Number(rows[0].version) : 0
  }
  const versionRowCount = async (): Promise<number> => {
    const { rows } = await q(
      `SELECT (SELECT count(*) FROM ${SHEET_PERMISSION_VERSIONS_TABLE} WHERE sheet_id LIKE $1)
            + (SELECT count(*) FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id LIKE $1) AS n`,
      [`${P}%`],
    )
    return Number(rows[0]?.n ?? 0)
  }
  /** Runs a raw statement on the pool (autocommit — exactly what a psql script or a plugin raw query does) and returns the version delta. */
  async function sheetDelta(sql: string, params: unknown[] = [], sheetId = SHEET): Promise<number> {
    const before = await sheetVersion(sheetId)
    await q(sql, params)
    return (await sheetVersion(sheetId)) - before
  }
  async function subjectDelta(sql: string, params: unknown[] = [], userId = SUBJECT): Promise<number> {
    const before = await subjectVersion(userId)
    await q(sql, params)
    return (await subjectVersion(userId)) - before
  }
  const pidOf = async (client: PoolClient): Promise<number> => Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  /** Bounded wait until `waiterPid` is blocked on a lock held by `holderPid`. */
  async function waitUntilBlocked(waiterPid: number, holderPid: number, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { rows } = await inspector.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE pid = $1::int AND wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid))`,
        [waiterPid, holderPid],
      )
      if (rows.length === 1) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`timed out waiting for pid ${waiterPid} to block on pid ${holderPid}`)
  }
  const beginHolder = async () => {
    await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  }
  const admission = (input: Partial<Parameters<typeof lockAuthorizationVersionsForAdmission>[1]> = {}) =>
    lockAuthorizationVersionsForAdmission(holder, { sheetIds: [SHEET], actorId: ACTOR, tenantId: TENANT, recordId: RECORD, ...input })

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
    holder = await pool.connect()
    writer = await pool.connect()
    inspector = await pool.connect()
    for (const client of [holder, writer]) await client.query("SET statement_timeout = '20s'")
    for (const userId of [ACTOR, SUBJECT]) {
      await q(
        `INSERT INTO users (id, email, password_hash, role, is_active, activation_status, is_admin, permissions)
         VALUES ($1, $1 || '@example.test', 'x', 'user', TRUE, 'activated', FALSE, '[]'::jsonb)`,
        [userId],
      )
    }
    await q(`INSERT INTO meta_sheets (id, name) VALUES ($1, 'Y5a sheet')`, [SHEET])
    await q(`INSERT INTO meta_fields (id, sheet_id, name, type, property) VALUES ($1, $2, 'f', 'text', '{"options": []}'::jsonb)`, [FIELD, SHEET])
    await q(`INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, '{"status": "open"}'::jsonb)`, [RECORD, SHEET])
    await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [ROLE])
    await q(`INSERT INTO permissions (code, name) VALUES ($1, 'Y5a permission')`, [PERMISSION])
    groupId = String((await q(`INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id::text AS id`, [`${P}_group`])).rows[0].id)
    // The fixture inserts above already bumped through the triggers; the matrix measures DELTAS.
  })

  afterEach(async () => {
    for (const client of [holder, writer]) await client.query('ROLLBACK').catch(() => undefined)
  })

  afterAll(async () => {
    for (const client of [holder, writer]) await client.query('ROLLBACK').catch(() => undefined)
    await q(`DELETE FROM record_permissions WHERE sheet_id = $1`, [SHEET]).catch(() => undefined)
    await q(`DELETE FROM field_permissions WHERE sheet_id = $1`, [SHEET]).catch(() => undefined)
    await q(`DELETE FROM spreadsheet_permissions WHERE sheet_id = $1`, [SHEET]).catch(() => undefined)
    await q(`DELETE FROM meta_sheets WHERE id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM platform_member_groups WHERE name LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM user_namespace_admissions WHERE user_id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM user_roles WHERE user_id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM user_permissions WHERE user_id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM permissions WHERE code LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM roles WHERE id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM users WHERE id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM ${SHEET_PERMISSION_VERSIONS_TABLE} WHERE sheet_id LIKE $1`, [`${P}%`]).catch(() => undefined)
    await q(`DELETE FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} WHERE subject_id LIKE $1`, [`${P}%`]).catch(() => undefined)
    for (const client of [holder, writer, inspector]) client?.release()
    await pool?.end()
  })

  it('P-01 posture: all 13 triggers are installed, enabled (O) and point at the two hardened functions', async () => {
    expect(await verifyAuthorizationVersionTriggerPosture(pool)).toEqual({ ok: true, triggers: 13 })
    const { rows } = await q(`SELECT proname, proconfig FROM pg_proc WHERE proname LIKE 'metasheet_authz_bump_%' ORDER BY proname`)
    expect(rows.map((row) => row.proname)).toEqual(['metasheet_authz_bump_sheet_permission_version', 'metasheet_authz_bump_subject_authorization_version'])
    for (const row of rows) expect(row.proconfig).toEqual(['search_path=pg_catalog, public'])
    // Fixture creation already left version rows behind: users INSERT and the sheet-layer writes below start from them.
    expect(await subjectVersion(ACTOR)).toBeGreaterThanOrEqual(1)
  })

  describe('M — writer coverage through raw SQL (no helper in the path)', () => {
    it('M-01 spreadsheet_permissions INSERT / UPDATE / DELETE each bump the sheet row', async () => {
      expect(await sheetDelta(`INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1, $2, 'user', $2, 'read')`, [SHEET, ACTOR])).toBe(1)
      expect(await sheetDelta(`UPDATE spreadsheet_permissions SET perm_code = 'write' WHERE sheet_id = $1 AND subject_id = $2`, [SHEET, ACTOR])).toBe(1)
      expect(await sheetDelta(`DELETE FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_id = $2`, [SHEET, ACTOR])).toBe(1)
    })

    it('M-02 field_permissions and record_permissions rows (a hidden field, a member-group deny row) bump the sheet row', async () => {
      expect(await sheetDelta(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible) VALUES ($1, $2, 'user', $3, FALSE)`, [SHEET, FIELD, ACTOR])).toBe(1)
      expect(await sheetDelta(`INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1, $2, 'member-group', $3, 'none')`, [SHEET, RECORD, groupId])).toBe(1)
      expect(await sheetDelta(`DELETE FROM record_permissions WHERE sheet_id = $1 AND record_id = $2`, [SHEET, RECORD])).toBe(1)
      expect(await sheetDelta(`DELETE FROM field_permissions WHERE sheet_id = $1`, [SHEET])).toBe(1)
    })

    it('M-03 meta_sheets bumps only when an authority column actually changes; a rename or an unchanged value does not', async () => {
      expect(await sheetDelta(`UPDATE meta_sheets SET row_level_read_permissions_enabled = TRUE WHERE id = $1`, [SHEET])).toBe(1)
      expect(await sheetDelta(`UPDATE meta_sheets SET row_level_read_permissions_enabled = TRUE WHERE id = $1`, [SHEET])).toBe(0)
      expect(await sheetDelta(`UPDATE meta_sheets SET name = 'renamed' WHERE id = $1`, [SHEET])).toBe(0)
      expect(await sheetDelta(`UPDATE meta_sheets SET conditional_read_rules = '[{"field": "f", "op": "eq", "value": "x"}]'::jsonb WHERE id = $1`, [SHEET])).toBe(1)
      expect(await sheetDelta(`UPDATE meta_sheets SET system_kind = NULL, updated_at = now() WHERE id = $1`, [SHEET])).toBe(0)
      expect(await sheetDelta(`UPDATE meta_sheets SET deleted_at = now() WHERE id = $1`, [SHEET])).toBe(1)
      expect(await sheetDelta(`UPDATE meta_sheets SET deleted_at = NULL WHERE id = $1`, [SHEET])).toBe(1)
      expect(await sheetDelta(`UPDATE meta_sheets SET grid_export_closure = 'stock_prep_pilot', grid_export_closed_at = now(), grid_export_closed_by = $2 WHERE id = $1`, [SHEET, ACTOR])).toBe(1)
      expect(await sheetDelta(`UPDATE meta_sheets SET grid_export_closure = NULL, grid_export_closed_at = NULL, grid_export_closed_by = NULL WHERE id = $1`, [SHEET])).toBe(1)
    })

    it('M-04 meta_sheets DELETE bumps (the version row outlives the sheet)', async () => {
      const gone = `${P}_gone`
      await q(`INSERT INTO meta_sheets (id, name) VALUES ($1, 'gone')`, [gone])
      await q(`INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1, $2, 'user', $2, 'read')`, [gone, ACTOR])
      const before = await sheetVersion(gone)
      expect(before).toBeGreaterThanOrEqual(1)
      await q(`DELETE FROM meta_sheets WHERE id = $1`, [gone])
      // The sheet DELETE trigger and the cascaded spreadsheet_permissions DELETE trigger both fired.
      expect(await sheetVersion(gone)).toBe(before + 2)
    })

    it('M-05 meta_fields bumps exactly on the hidden/visible derivation; option and format edits never do', async () => {
      const setProperty = (property: string) => sheetDelta(`UPDATE meta_fields SET property = $2::jsonb WHERE id = $1`, [FIELD, property])
      expect(await setProperty('{"options": ["a"]}')).toBe(0)
      expect(await setProperty('{"options": ["a"], "hidden": false}')).toBe(0)
      expect(await setProperty('{"options": ["a"], "hidden": true}')).toBe(1)
      expect(await setProperty('{"options": ["b"], "hidden": true}')).toBe(0)
      expect(await setProperty('{"options": ["b"]}')).toBe(1)
      expect(await setProperty('{"visible": false}')).toBe(1)
      expect(await setProperty('{"visible": false, "format": "x"}')).toBe(0)
      expect(await setProperty('{"visible": true}')).toBe(1)
      expect(await sheetDelta(`UPDATE meta_fields SET name = 'renamed' WHERE id = $1`, [FIELD])).toBe(0)
    })

    it('M-10 the legacy jsonb-STRING property encoding is outside the trigger, and the registry lists it: a raw string-encoded hide bumps nothing while the readers read it hidden (verifier r1 F4)', async () => {
      // The readers' own derivation (loadFieldsForSheet -> serializeFieldRow -> normalizeJson), as Y5's check 3 reads it.
      const readersSeeHidden = async (): Promise<boolean | 'absent'> => {
        const fields = await loadFieldsForSheet((sql: string, params?: unknown[]) => q(sql, params ?? []), SHEET)
        const field = fields.find((entry) => entry.id === FIELD)
        return field ? isFieldPermissionHidden(field) : 'absent'
      }
      await q(`UPDATE meta_fields SET property = '{"options": []}'::jsonb WHERE id = $1`, [FIELD])
      expect(await readersSeeHidden()).toBe(false)
      // `property -> 'hidden'` is NULL for a jsonb string: the trigger sees no flag change, the readers parse a hide.
      expect(await sheetDelta(`UPDATE meta_fields SET property = to_jsonb($2::text) WHERE id = $1`, [FIELD, JSON.stringify({ hidden: true })])).toBe(0)
      expect((await q(`SELECT jsonb_typeof(property) AS kind FROM meta_fields WHERE id = $1`, [FIELD])).rows[0].kind).toBe('string')
      expect(await readersSeeHidden()).toBe(true)
      expect(
        AUTHORIZATION_PROTOCOL_GAPS.find((gap) => gap.id === 'field-property-jsonb-string-encoding')?.checks,
        'while the trigger cannot see this encoding, the hard-condition registry must list it (check 3)',
      ).toEqual([3])
      // Back to an object: still no flag change for the trigger. Control: the same hide as an OBJECT bumps, both ways.
      expect(await sheetDelta(`UPDATE meta_fields SET property = '{"options": []}'::jsonb WHERE id = $1`, [FIELD])).toBe(0)
      expect(await sheetDelta(`UPDATE meta_fields SET property = '{"options": [], "hidden": true}'::jsonb WHERE id = $1`, [FIELD])).toBe(1)
      expect(await readersSeeHidden()).toBe(true)
      expect(await sheetDelta(`UPDATE meta_fields SET property = '{"options": []}'::jsonb WHERE id = $1`, [FIELD])).toBe(1)
    })

    it('M-06 PERF: an ordinary record write bumps nothing — no sheet row, no subject row, no new version row', async () => {
      const [sheetBefore, subjectBefore, rowsBefore] = [await sheetVersion(), await subjectVersion(ACTOR), await versionRowCount()]
      await q(`UPDATE meta_records SET data = '{"status": "closed"}'::jsonb, version = version + 1 WHERE id = $1`, [RECORD])
      await q(`INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, '{}'::jsonb)`, [`${P}_record2`, SHEET])
      await q(`DELETE FROM meta_records WHERE id = $1`, [`${P}_record2`])
      expect([await sheetVersion(), await subjectVersion(ACTOR), await versionRowCount()]).toEqual([sheetBefore, subjectBefore, rowsBefore])
      const { rows } = await q(`SELECT count(*)::int AS n FROM pg_trigger trg JOIN pg_class rel ON rel.oid = trg.tgrelid WHERE rel.relname = 'meta_records' AND NOT trg.tgisinternal AND trg.tgname LIKE '%authz%'`)
      expect(rows[0].n).toBe(0)
    })

    it('M-07 user_roles, user_permissions (+ the permissions FK cascade), user_orgs and user_namespace_admissions bump the subject row', async () => {
      expect(await subjectDelta(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [SUBJECT, ROLE])).toBe(1)
      expect(await subjectDelta(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`, [SUBJECT, ROLE])).toBe(1)
      expect(await subjectDelta(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)`, [SUBJECT, PERMISSION])).toBe(1)
      const fk = await q(`SELECT confdeltype FROM pg_constraint WHERE conname = 'user_permissions_permission_code_fkey'`)
      expect(fk.rows[0]?.confdeltype, 'the permissions → user_permissions FK must cascade for this case to prove anything').toBe('c')
      expect(await subjectDelta(`DELETE FROM permissions WHERE code = $1`, [PERMISSION])).toBe(1)
      expect((await q(`SELECT 1 FROM user_permissions WHERE user_id = $1`, [SUBJECT])).rows).toEqual([])
      expect(await subjectDelta(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [SUBJECT, TENANT])).toBe(1)
      expect(await subjectDelta(`UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1 AND org_id = $2`, [SUBJECT, TENANT])).toBe(1)
      expect(await subjectDelta(`INSERT INTO user_namespace_admissions (user_id, namespace, enabled) VALUES ($1, 'integration', TRUE)`, [SUBJECT])).toBe(1)
      expect(await subjectDelta(`UPDATE user_namespace_admissions SET enabled = FALSE WHERE user_id = $1 AND namespace = 'integration'`, [SUBJECT])).toBe(1)
    })

    it('M-08 member-group membership bumps the subject row on join and on the FK cascade of the group delete', async () => {
      const cascadeGroup = String((await q(`INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id::text AS id`, [`${P}_cascade_group`])).rows[0].id)
      expect(await subjectDelta(`INSERT INTO platform_member_group_members (group_id, user_id, created_at) VALUES ($1::uuid, $2, now())`, [cascadeGroup, SUBJECT])).toBe(1)
      const fk = await q(`SELECT confdeltype FROM pg_constraint WHERE conname = 'platform_member_group_members_group_id_fkey'`)
      expect(fk.rows[0]?.confdeltype, 'the group → members FK must cascade for this case to prove anything').toBe('c')
      expect(await subjectDelta(`DELETE FROM platform_member_groups WHERE id = $1::uuid`, [cascadeGroup])).toBe(1)
      expect((await q(`SELECT 1 FROM platform_member_group_members WHERE user_id = $1`, [SUBJECT])).rows).toEqual([])
    })

    it('M-09 users bumps on role / is_active / activation_status / permissions / is_admin changes, on INSERT and DELETE; profile edits and unchanged values do not', async () => {
      expect(await subjectDelta(`UPDATE users SET is_active = FALSE WHERE id = $1`, [SUBJECT])).toBe(1)
      expect(await subjectDelta(`UPDATE users SET is_active = FALSE WHERE id = $1`, [SUBJECT])).toBe(0)
      expect(await subjectDelta(`UPDATE users SET name = 'renamed', updated_at = now() WHERE id = $1`, [SUBJECT])).toBe(0)
      expect(await subjectDelta(`UPDATE users SET activation_status = 'pending_activation' WHERE id = $1`, [SUBJECT])).toBe(1)
      expect(await subjectDelta(`UPDATE users SET is_admin = TRUE WHERE id = $1`, [SUBJECT])).toBe(1)
      expect(await subjectDelta(`UPDATE users SET role = 'admin' WHERE id = $1`, [SUBJECT])).toBe(1)
      expect(await subjectDelta(`UPDATE users SET permissions = '["x:read"]'::jsonb WHERE id = $1`, [SUBJECT])).toBe(1)
      expect(await subjectDelta(`UPDATE users SET role = 'user', is_admin = FALSE, is_active = TRUE, activation_status = 'activated', permissions = '[]'::jsonb WHERE id = $1`, [SUBJECT])).toBe(1)
      const newcomer = `${P}_newcomer`
      await q(`INSERT INTO users (id, email, password_hash) VALUES ($1, $1 || '@example.test', 'x')`, [newcomer])
      expect(await subjectVersion(newcomer)).toBe(1)
      expect(await subjectDelta(`DELETE FROM users WHERE id = $1`, [newcomer], newcomer)).toBe(1)
    })
  })

  describe('B — two-connection barriers against a real admission holder', () => {
    it('B-01 a deny-row writer blocks on the sheet row until the holder commits; the version the holder read is then advanced', async () => {
      await beginHolder()
      const locked = await admission()
      expect(locked.sheetVersions).toEqual([{ sheetId: SHEET, version: await sheetVersion() }])
      const [holderPid, writerPid] = [await pidOf(holder), await pidOf(writer)]
      let settled = false
      await writer.query('BEGIN')
      const write = writer.query(
        `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1, $2, 'user', $3, 'none')`,
        [SHEET, RECORD, ACTOR],
      ).then(() => { settled = true })
      await waitUntilBlocked(writerPid, holderPid)
      expect(settled).toBe(false)
      await holder.query('COMMIT')
      await write
      expect(settled).toBe(true)
      await writer.query('COMMIT')
      expect(await sheetVersion()).toBe(locked.sheetVersions[0]!.version + 1)
      await q(`DELETE FROM record_permissions WHERE sheet_id = $1 AND record_id = $2`, [SHEET, RECORD])
    })

    it('B-02 a revoke committed FIRST is what the next holder reads: the sheet version moved on, and the record row carries the deny', async () => {
      await beginHolder()
      const first = await admission()
      await holder.query('COMMIT')
      await q(`INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1, $2, 'user', $3, 'none')`, [SHEET, RECORD, ACTOR])
      await beginHolder()
      const second = await admission()
      await holder.query('COMMIT')
      expect(second.sheetVersions[0]!.version).toBe(first.sheetVersions[0]!.version + 1)
      expect(second.subjectVersion.version).toBe(first.subjectVersion.version)
      await q(`DELETE FROM record_permissions WHERE sheet_id = $1 AND record_id = $2`, [SHEET, RECORD])
    })

    it('B-03 joining a member group that carries a deny row counts as a revoke: the member INSERT blocks on the SUBJECT row until the holder commits', async () => {
      await q(`INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1, $2, 'member-group', $3, 'none')`, [SHEET, RECORD, groupId])
      await beginHolder()
      const locked = await admission()
      const [holderPid, writerPid] = [await pidOf(holder), await pidOf(writer)]
      let settled = false
      await writer.query('BEGIN')
      const join = writer.query(`INSERT INTO platform_member_group_members (group_id, user_id, created_at) VALUES ($1::uuid, $2, now())`, [groupId, ACTOR]).then(() => { settled = true })
      await waitUntilBlocked(writerPid, holderPid)
      expect(settled).toBe(false)
      await holder.query('COMMIT')
      await join
      await writer.query('COMMIT')
      expect(await subjectVersion(ACTOR)).toBe(locked.subjectVersion.version + 1)
      await q(`DELETE FROM platform_member_group_members WHERE group_id = $1::uuid AND user_id = $2`, [groupId, ACTOR])
      await q(`DELETE FROM record_permissions WHERE sheet_id = $1 AND record_id = $2`, [SHEET, RECORD])
    })

    it('B-04 a write to the bound record blocks on the record FOR SHARE until the holder commits, and bumps no version', async () => {
      await beginHolder()
      const locked = await admission()
      expect(locked.record).toMatchObject({ recordId: RECORD, sheetId: SHEET, deletedAt: null })
      const [holderPid, writerPid] = [await pidOf(holder), await pidOf(writer)]
      let settled = false
      await writer.query('BEGIN')
      const write = writer.query(`UPDATE meta_records SET data = '{"status": "denied"}'::jsonb WHERE id = $1`, [RECORD]).then(() => { settled = true })
      await waitUntilBlocked(writerPid, holderPid)
      expect(settled).toBe(false)
      await holder.query('COMMIT')
      await write
      await writer.query('COMMIT')
      expect(await sheetVersion()).toBe(locked.sheetVersions[0]!.version)
      expect(await subjectVersion(ACTOR)).toBe(locked.subjectVersion.version)
    })

    it('B-05 an access-graph writer (mutex: subject row first, then users FOR UPDATE) is SERIALIZED behind the holder — no 40P01 on either side', async () => {
      await beginHolder()
      const locked = await admission()
      const [holderPid, writerPid] = [await pidOf(holder), await pidOf(writer)]
      const order: string[] = []
      await writer.query('BEGIN')
      const writerRun = (async () => {
        const lockedUsers = await lockUsersForAccessGraphWrite(writer, [ACTOR])
        order.push('writer:locked')
        expect(lockedUsers.get(ACTOR)?.id).toBe(ACTOR)
        await writer.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [ACTOR])
        await writer.query('COMMIT')
        order.push('writer:committed')
      })()
      await waitUntilBlocked(writerPid, holderPid)
      expect(order).toEqual([])
      order.push('holder:commit')
      await holder.query('COMMIT')
      await writerRun
      expect(order).toEqual(['holder:commit', 'writer:locked', 'writer:committed'])
      // mutex bump + users trigger bump
      expect(await subjectVersion(ACTOR)).toBe(locked.subjectVersion.version + 2)
      await q(`UPDATE users SET is_active = TRUE WHERE id = $1`, [ACTOR])
    })
  })

  describe('K — the holder-vs-multi-row-writer cycle', () => {
    it('K-01 a writer that holds the subject row and then wants the sheet row deadlocks the holder; PostgreSQL raises 40P01 and the helper maps it to CONFLICT — never a pass', async () => {
      const superuser = await q(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)
      expect(superuser.rows[0]?.rolsuper, 'deadlock_timeout is a superuser setting; the CI database user is one').toBe(true)
      // The writer detects late, the holder early: the holder is the deterministic victim.
      await writer.query('BEGIN')
      await writer.query("SET LOCAL deadlock_timeout = '20s'")
      await bumpSubjectAuthorizationVersions(writer, [ACTOR])
      await beginHolder()
      await holder.query("SET LOCAL deadlock_timeout = '1500ms'")
      const [holderPid, writerPid] = [await pidOf(holder), await pidOf(writer)]
      const outcome = admission().then(() => 'resolved' as const, (error: unknown) => error)
      await waitUntilBlocked(holderPid, writerPid)
      const writerBump = bumpSheetPermissionVersions(writer, [SHEET])
      const error = await outcome
      expect(error).toBeInstanceOf(AuthorizationVersionProtocolError)
      expect((error as AuthorizationVersionProtocolError).code).toBe('AUTHZ_VERSION_CONFLICT')
      expect((error as AuthorizationVersionProtocolError).sqlState).toBe('40P01')
      expect((error as AuthorizationVersionProtocolError).retryable).toBe(true)
      expect(isAuthorizationVersionConflict(error)).toBe(true)
      await holder.query('ROLLBACK')
      await expect(writerBump).resolves.toEqual([SHEET])
      await writer.query('COMMIT')
      // After the writer committed, a fresh admission goes through and sees both bumps.
      await beginHolder()
      const retry = await admission()
      await holder.query('COMMIT')
      expect(retry.sheetVersions[0]!.version).toBeGreaterThanOrEqual(1)
    })

    it('K-02 two RAW writers (no explicit bump) that touch the same two subjects in opposite order deadlock each other: exactly one side gets 40P01 — the price of skipping the canonical bump; the protocol-following form serializes (multitable-recovery-authority-stability-realdb)', async () => {
      const [orgA, orgB] = [`${P}_k2_org_a`, `${P}_k2_org_b`]
      await holder.query('BEGIN')
      await writer.query('BEGIN')
      for (const client of [holder, writer]) await client.query("SET LOCAL deadlock_timeout = '200ms'")
      // holder holds ACTOR's subject row; writer holds SUBJECT's subject row (through the user_orgs trigger).
      await holder.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [ACTOR, orgA])
      await writer.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [SUBJECT, orgA])
      // Now each wants the other's row: holder → SUBJECT, writer → ACTOR.
      const outcomes = await Promise.allSettled([
        holder.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [SUBJECT, orgB]),
        writer.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [ACTOR, orgB]),
      ])
      const codes = outcomes.map((outcome) => outcome.status === 'rejected' ? String((outcome.reason as { code?: unknown }).code) : 'ok')
      expect(codes.filter((code) => code === '40P01')).toHaveLength(1)
      expect(codes.filter((code) => code === 'ok')).toHaveLength(1)
      // Both transactions are rolled back by afterEach; nothing of this case is committed.
    })
  })

  describe('P — migration down / up', () => {
    it('P-02 down() removes every trigger, function and table; up() reinstalls them and is idempotent (posture green again)', async () => {
      const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
      try {
        await dropAuthorizationVersionProtocol(db)
        const posture = await verifyAuthorizationVersionTriggerPosture(pool)
        expect(posture.ok).toBe(false)
        expect(posture.ok === false ? posture.missing : []).toHaveLength(AUTHORIZATION_VERSION_TRIGGERS.length)
        expect((await q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'metasheet_authz_bump_%'`)).rows[0].n).toBe(0)
        expect((await q(`SELECT to_regclass($1) AS t`, [SHEET_PERMISSION_VERSIONS_TABLE])).rows[0].t).toBeNull()
        await beginHolder()
        await expect(admission()).rejects.toMatchObject({ code: 'AUTHZ_VERSION_PROTOCOL_UNAVAILABLE' })
        await holder.query('ROLLBACK')
      } finally {
        await installAuthorizationVersionProtocol(db)
        await installAuthorizationVersionProtocol(db)
      }
      expect(await verifyAuthorizationVersionTriggerPosture(pool)).toEqual({ ok: true, triggers: 13 })
      expect(await sheetDelta(`INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1, $2, 'user', $2, 'read')`, [SHEET, ACTOR])).toBe(1)
      await q(`DELETE FROM spreadsheet_permissions WHERE sheet_id = $1`, [SHEET])
    })
  })
})

// The field-row writer rule (#6792 follow-up): the sheet version row before the meta_fields row lock, path by path.
defineAuthzVersionFieldRowOrderRealDbCases()
