/**
 * D21 authorization version protocol (slice Y5a) — the no-database half of the proof.
 *
 *   T — the trigger set the migration installs (which tables, which events, which names);
 *   B — the explicit bump helpers (canonical order, one statement, no statement for nothing);
 *   L — the admission lock helper on a recording fake (statement order = the documented lock order,
 *       admin-ness from locked rows only, 40P01 / 40001 / 55P03 → typed CONFLICT, never success,
 *       posture / transaction / input failures closed and values-free);
 *   W — the writers that bump FIRST (source-level order of the access-graph mutex);
 *   D — the live-authority drift guard (the six statements equal automation-live-authority.ts);
 *   C — the census: no plugin root writes a covered table; only the migration and the protocol
 *       module write the two version tables;
 *   R — the hard-condition registry;
 *   X — the CI wiring of the real-DB half.
 *
 * The real-PostgreSQL half (trigger coverage per writer incl. raw SQL and an FK cascade, the
 * two-connection barriers, the deadlock → CONFLICT mapping) is tests/integration/authz-version-protocol.db.test.ts.
 */
import { requiredSuiteJob } from '../../../../scripts/ops/plugin-tests-workflow-contract.mjs'
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import {
  AUTHORIZATION_VERSION_COVERED_TABLES,
  AUTHORIZATION_VERSION_TRIGGERS,
  META_SHEETS_AUTHORITY_COLUMNS,
  SHEET_PERMISSION_VERSIONS_TABLE,
  SUBJECT_AUTHORIZATION_VERSIONS_TABLE,
  USERS_AUTHORITY_COLUMNS,
  down as migrationDown,
  up as migrationUp,
} from '../../src/db/migrations/zzzz20261106110500_add_authorization_version_rows'
import {
  ADMISSION_LOCK_ORDER,
  AUTHORIZATION_PROTOCOL_GAPS,
  AUTHORIZATION_VERSION_CONFLICT_SQLSTATES,
  AUTHORIZATION_VERSION_TRIGGER_POSTURE_SQL,
  AuthorizationVersionProtocolError,
  LIVE_AUTHORITY_LOCK_ORDER,
  SHEET_PERMISSION_VERSIONS_BUMP_SQL,
  SHEET_ROW_KEY_SHARE_SQL,
  SUBJECT_AUTHORIZATION_VERSIONS_BUMP_SQL,
  authorizationProtocolGapsFor,
  bumpAuthorizationVersions,
  bumpSheetPermissionVersionBehindSheetRow,
  bumpSheetPermissionVersions,
  bumpSubjectAuthorizationVersions,
  canonicalAuthorizationIds,
  fieldVisibilityTriggerWouldFire,
  isAuthorizationVersionConflict,
  lockAuthorizationVersionsForAdmission,
  verifyAuthorizationVersionTriggerPosture,
} from '../../src/multitable/authz-version-protocol'
import { normalizeJson } from '../../src/multitable/field-codecs'
import { isFieldPermissionHidden } from '../../src/multitable/permission-derivation'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const BACKEND = path.join(ROOT, 'packages', 'core-backend')
const SRC = path.join(BACKEND, 'src')
const DB_SPEC = 'tests/integration/authz-version-protocol.db.test.ts'
const MIGRATION = 'zzzz20261106110500_add_authorization_version_rows'

const COVERED = [
  'spreadsheet_permissions', 'field_permissions', 'record_permissions', 'meta_sheets', 'meta_fields',
  'user_roles', 'platform_member_group_members', 'user_permissions', 'user_orgs', 'user_namespace_admissions', 'users',
] as const

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()

function postureRows(options: { omit?: string[]; disable?: string[]; wrongFunction?: string[] } = {}) {
  return AUTHORIZATION_VERSION_TRIGGERS
    .filter((entry) => !(options.omit ?? []).includes(entry.trigger))
    .map((entry) => ({
      table_name: entry.table,
      trigger_name: entry.trigger,
      function_name: (options.wrongFunction ?? []).includes(entry.trigger) ? 'something_else' : entry.fn,
      enabled: (options.disable ?? []).includes(entry.trigger) ? 'D' : 'O',
    }))
}

type Fixture = {
  xids?: [string, string]
  isolation?: string
  posture?: Array<Record<string, unknown>>
  roles?: string[]
  rolePermissions?: Array<{ role_id: string; permission_code: string }>
  directPermissions?: string[]
  user?: Record<string, unknown> | null
  membership?: Record<string, unknown> | null
  admission?: Record<string, unknown> | null
  record?: Record<string, unknown> | null
  sheetVersion?: string
  subjectVersion?: string
  failWith?: { when: RegExp; error: unknown }
}

/** A recording transaction fake that answers every statement of the lock order. */
function createTrx(fixture: Fixture = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probes = 0
  const xids = fixture.xids ?? ['801', '801']
  const query = async (sql: string, params: unknown[] = []) => {
    const text = collapse(sql)
    calls.push({ sql: text, params })
    if (fixture.failWith && fixture.failWith.when.test(text)) throw fixture.failWith.error
    if (text.includes('current_setting')) return { rows: [{ isolation: fixture.isolation ?? 'read committed' }], rowCount: 1 }
    if (text.includes('pg_current_xact_id')) return { rows: [{ xid: xids[Math.min(probes++, 1)] }], rowCount: 1 }
    if (text.startsWith('SELECT rel.relname AS table_name')) return { rows: fixture.posture ?? postureRows(), rowCount: 0 }
    if (text.startsWith(`INSERT INTO ${SHEET_PERMISSION_VERSIONS_TABLE} (sheet_id)`)) return { rows: [], rowCount: 0 }
    if (text.startsWith(`INSERT INTO ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE} (subject_id)`)) return { rows: [], rowCount: 0 }
    if (text.startsWith(`SELECT sheet_id, version::text AS version FROM ${SHEET_PERMISSION_VERSIONS_TABLE}`)) {
      return { rows: [{ sheet_id: params[0], version: fixture.sheetVersion ?? '7' }], rowCount: 1 }
    }
    if (text.startsWith(`SELECT subject_id, version::text AS version FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE}`)) {
      return { rows: [{ subject_id: params[0], version: fixture.subjectVersion ?? '3' }], rowCount: 1 }
    }
    if (/FROM user_roles\s/.test(text)) return { rows: (fixture.roles ?? ['viewer']).map((role_id) => ({ role_id })), rowCount: 0 }
    if (/FROM role_permissions\s/.test(text)) return { rows: fixture.rolePermissions ?? [{ role_id: 'viewer', permission_code: 'multitable:read' }], rowCount: 0 }
    if (/FROM user_permissions\s/.test(text)) return { rows: (fixture.directPermissions ?? []).map((permission_code) => ({ permission_code })), rowCount: 0 }
    if (/FROM users\s/.test(text)) {
      const user = fixture.user === undefined
        ? { id: params[0], role: 'user', is_active: true, activation_status: 'activated', permissions: [] }
        : fixture.user
      return { rows: user ? [user] : [], rowCount: user ? 1 : 0 }
    }
    if (/FROM user_orgs\s/.test(text)) {
      const membership = fixture.membership === undefined ? { user_id: params[0], org_id: params[1], is_active: true } : fixture.membership
      return { rows: membership ? [membership] : [], rowCount: membership ? 1 : 0 }
    }
    if (/FROM user_namespace_admissions\s/.test(text)) {
      const admission = fixture.admission === undefined ? { namespace: 'integration', enabled: true } : fixture.admission
      return { rows: admission ? [admission] : [], rowCount: admission ? 1 : 0 }
    }
    if (/FROM meta_records\s/.test(text)) {
      const record = fixture.record === undefined ? { id: params[0], sheet_id: 'sheet-a', data: { k: 1 }, deleted_at: null } : fixture.record
      return { rows: record ? [record] : [], rowCount: record ? 1 : 0 }
    }
    throw new Error(`unscripted statement: ${text}`)
  }
  return { query, calls }
}

const INPUT = { sheetIds: ['sheet-b', 'sheet-a'], actorId: 'actor-1', tenantId: 'tenant-1', recordId: 'rec-1' }

describe('T — the trigger set', () => {
  it('T-01 covers exactly the eleven tables of the three layers, and nothing on meta_records / meta_view_permissions / role_permissions', () => {
    expect([...AUTHORIZATION_VERSION_COVERED_TABLES].sort()).toEqual([...COVERED].sort())
    for (const table of ['meta_records', 'meta_view_permissions', 'meta_views', 'role_permissions', 'roles', 'permissions']) {
      expect(AUTHORIZATION_VERSION_TRIGGERS.some((entry) => entry.table === table), table).toBe(false)
    }
    expect(AUTHORIZATION_VERSION_TRIGGERS).toHaveLength(13)
    expect(new Set(AUTHORIZATION_VERSION_TRIGGERS.map((entry) => entry.trigger)).size).toBe(13)
    expect(Object.isFrozen(AUTHORIZATION_VERSION_TRIGGERS)).toBe(true)
  })

  it('T-02 row tables fire on INSERT, UPDATE and DELETE; meta_sheets / users fire on their authority columns and lifecycle; meta_fields only on the visibility derivation', () => {
    for (const table of ['spreadsheet_permissions', 'field_permissions', 'record_permissions']) {
      const entry = AUTHORIZATION_VERSION_TRIGGERS.find((candidate) => candidate.table === table)
      expect(entry).toMatchObject({ layer: 'sheet', keyColumn: 'sheet_id', events: 'BEFORE INSERT OR UPDATE OR DELETE' })
    }
    for (const table of ['user_roles', 'platform_member_group_members', 'user_permissions', 'user_orgs', 'user_namespace_admissions']) {
      const entry = AUTHORIZATION_VERSION_TRIGGERS.find((candidate) => candidate.table === table)
      expect(entry).toMatchObject({ layer: 'subject', keyColumn: 'user_id', events: 'BEFORE INSERT OR UPDATE OR DELETE' })
    }
    // Whole-row UPDATE triggers: the watched columns travel as a TG_ARGV text list and are compared
    // inside the function (an `UPDATE OF` list or a WHEN clause would put a pg_depend edge on the
    // columns and block the DROP COLUMN of an earlier migration's down()).
    const usersEvents = AUTHORIZATION_VERSION_TRIGGERS.filter((entry) => entry.table === 'users').map((entry) => entry.events)
    expect(usersEvents).toEqual([`BEFORE UPDATE (bump when any of ${USERS_AUTHORITY_COLUMNS.join(', ')} changes)`, 'BEFORE INSERT OR DELETE'])
    expect([...USERS_AUTHORITY_COLUMNS]).toEqual(['role', 'is_active', 'activation_status', 'permissions', 'is_admin'])
    const sheetsEvents = AUTHORIZATION_VERSION_TRIGGERS.filter((entry) => entry.table === 'meta_sheets').map((entry) => entry.events)
    expect(sheetsEvents).toEqual([`BEFORE UPDATE (bump when any of ${META_SHEETS_AUTHORITY_COLUMNS.join(', ')} changes)`, 'BEFORE DELETE'])
    expect([...META_SHEETS_AUTHORITY_COLUMNS]).toEqual(['row_level_read_permissions_enabled', 'conditional_read_rules', 'grid_export_closure', 'deleted_at', 'system_kind'])
    const fields = AUTHORIZATION_VERSION_TRIGGERS.filter((entry) => entry.table === 'meta_fields')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.events).toBe('BEFORE UPDATE (bump when the hidden/visible derivation of property changes)')
    const migration = readFileSync(path.join(SRC, 'db', 'migrations', `${MIGRATION}.ts`), 'utf8')
    const ddl = migration.slice(migration.indexOf('export async function installAuthorizationVersionProtocol'))
    expect(ddl).not.toMatch(/UPDATE OF /)
    expect(ddl).not.toMatch(/\bWHEN \(/)
    expect(ddl).toMatch(/BEFORE UPDATE ON public\.meta_sheets[\s\S]*?\('id', \$\{sql\.lit\(META_SHEETS_AUTHORITY_COLUMNS\.join\(','\)\)\}\)/)
    expect(ddl).toMatch(/BEFORE UPDATE ON public\.users[\s\S]*?\('id', \$\{sql\.lit\(USERS_AUTHORITY_COLUMNS\.join\(','\)\)\}\)/)
    expect(ddl).toMatch(/BEFORE UPDATE ON public\.meta_fields[\s\S]*?\('sheet_id', 'field-visibility'\)/)
  })

  it('T-03 every name sorts AFTER its recovery-authority sibling on the same table (same-event BEFORE ROW triggers fire in name order, so a BUSY refusal fails fast)', () => {
    for (const [table, recoveryTrigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      for (const entry of AUTHORIZATION_VERSION_TRIGGERS.filter((candidate) => candidate.table === table)) {
        expect(entry.trigger > recoveryTrigger, `${entry.trigger} must sort after ${recoveryTrigger}`).toBe(true)
        expect(entry.trigger).not.toBe(recoveryTrigger)
      }
    }
  })

  it('T-04 the migration module exports up/down and the hardening precedent is in its DDL text (fixed search_path, schema-qualified table, DROP TRIGGER IF EXISTS before CREATE)', () => {
    expect(typeof migrationUp).toBe('function')
    expect(typeof migrationDown).toBe('function')
    const source = readFileSync(path.join(SRC, 'db', 'migrations', `${MIGRATION}.ts`), 'utf8')
    expect(source).toContain('SET search_path = pg_catalog, public')
    expect(source).toContain(`INSERT INTO public.\${sql.raw(identifier(table))} AS v`)
    expect(source).toContain('DROP TRIGGER IF EXISTS')
    expect(source).toContain('CREATE OR REPLACE FUNCTION public.')
    expect(source).toContain('CREATE TABLE IF NOT EXISTS public.')
    // Visibility derivation exactly as permission-derivation.ts: hidden === true, visible === false —
    // computed inside the function on to_jsonb(OLD) / to_jsonb(NEW) (no WHEN clause: see the docblock).
    expect(source).toContain(`COALESCE((old_row -> 'property' -> 'hidden') = 'true'::jsonb, FALSE)`)
    expect(source).toContain(`COALESCE((new_row -> 'property' -> 'visible') = 'false'::jsonb, FALSE)`)
    expect(source).toContain(`IF watched = 'field-visibility' THEN`)
    // Installed ENABLED, never ALWAYS (restore rehearsals under session_replication_role = replica stay trigger-free).
    expect(source).not.toMatch(/ENABLE ALWAYS TRIGGER/)
    expect(source).not.toMatch(/DISABLE TRIGGER/)
  })
})

describe('B — the explicit bump helpers', () => {
  it('B-01 canonical order: trimmed, blanks dropped, de-duplicated, byte-ascending', () => {
    expect(canonicalAuthorizationIds([' u-b ', 'u-a', 'u-b', '', '  ', 'U-0', 'u-a'])).toEqual(['U-0', 'u-a', 'u-b'])
    expect(canonicalAuthorizationIds([])).toEqual([])
  })

  it('B-02 sheet and subject bumps are ONE statement each with the sorted array; nothing is issued for an empty list', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return { rows: [] } }
    expect(await bumpSheetPermissionVersions(query, ['s-2', 's-1', 's-2'])).toEqual(['s-1', 's-2'])
    expect(await bumpSubjectAuthorizationVersions({ query }, ['u-9', 'u-1'])).toEqual(['u-1', 'u-9'])
    expect(statements).toEqual([
      { sql: SHEET_PERMISSION_VERSIONS_BUMP_SQL, params: [['s-1', 's-2']] },
      { sql: SUBJECT_AUTHORIZATION_VERSIONS_BUMP_SQL, params: [['u-1', 'u-9']] },
    ])
    statements.length = 0
    expect(await bumpSheetPermissionVersions(query, [])).toEqual([])
    expect(await bumpSubjectAuthorizationVersions(query, [' '])).toEqual([])
    expect(statements).toEqual([])
  })

  it('B-03 the bump statement is an ordered upsert-and-increment on the version table (the same shape the triggers run)', () => {
    for (const [sql, table, key] of [
      [SHEET_PERMISSION_VERSIONS_BUMP_SQL, SHEET_PERMISSION_VERSIONS_TABLE, 'sheet_id'],
      [SUBJECT_AUTHORIZATION_VERSIONS_BUMP_SQL, SUBJECT_AUTHORIZATION_VERSIONS_TABLE, 'subject_id'],
    ] as const) {
      const text = collapse(sql)
      expect(text).toContain(`INSERT INTO ${table} AS v (${key}, version, updated_at)`)
      expect(text).toContain('WITH ORDINALITY')
      expect(text).toContain('ORDER BY s.ord')
      expect(text).toContain(`ON CONFLICT (${key}) DO UPDATE SET version = v.version + 1`)
    }
  })

  it('B-04 the combined bump takes sheets ascending first, then subjects ascending', async () => {
    const order: Array<[string | undefined, unknown]> = []
    const query = async (sql: string, params: unknown[] = []) => {
      order.push([/INSERT INTO (\w+)/.exec(sql)?.[1], params[0]])
      return { rows: [] }
    }
    expect(await bumpAuthorizationVersions(query, { sheetIds: ['s-b', 's-a'], userIds: ['u-b', 'u-a'] })).toEqual({ sheetIds: ['s-a', 's-b'], userIds: ['u-a', 'u-b'] })
    expect(order).toEqual([
      [SHEET_PERMISSION_VERSIONS_TABLE, ['s-a', 's-b']],
      [SUBJECT_AUTHORIZATION_VERSIONS_TABLE, ['u-a', 'u-b']],
    ])
  })

  it('B-05 the bump behind the sheet row: meta_sheets FOR KEY SHARE first, then the version row — two statements, one sheet; nothing for a blank id', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return { rows: [] } }
    expect(await bumpSheetPermissionVersionBehindSheetRow(query, ' s-1 ')).toEqual(['s-1'])
    expect(await bumpSheetPermissionVersionBehindSheetRow({ query }, 's-2')).toEqual(['s-2'])
    expect(statements).toEqual([
      { sql: SHEET_ROW_KEY_SHARE_SQL, params: ['s-1'] },
      { sql: SHEET_PERMISSION_VERSIONS_BUMP_SQL, params: [['s-1']] },
      { sql: SHEET_ROW_KEY_SHARE_SQL, params: ['s-2'] },
      { sql: SHEET_PERMISSION_VERSIONS_BUMP_SQL, params: [['s-2']] },
    ])
    // the lock an FK child insert takes on its own — no stronger (it must not queue behind ordinary meta_sheets UPDATEs)
    expect(collapse(SHEET_ROW_KEY_SHARE_SQL)).toBe('SELECT id FROM meta_sheets WHERE id = $1 FOR KEY SHARE')
    statements.length = 0
    expect(await bumpSheetPermissionVersionBehindSheetRow(query, '  ')).toEqual([])
    expect(statements).toEqual([])
  })
})

describe('L — the admission lock helper', () => {
  it('L-01 statement order IS the documented lock order: probes, posture, sheet rows ascending (ensure + FOR SHARE), subject row, the six live-authority reads, the bound record', async () => {
    const trx = createTrx()
    const result = await lockAuthorizationVersionsForAdmission(trx, INPUT)
    const kinds = trx.calls.map(({ sql }) => {
      if (sql.includes('current_setting')) return 'isolation'
      if (sql.includes('pg_current_xact_id')) return 'xid'
      if (sql.startsWith('SELECT rel.relname AS table_name')) return 'posture'
      if (sql.startsWith(`INSERT INTO ${SHEET_PERMISSION_VERSIONS_TABLE}`)) return 'sheet:ensure'
      if (sql.includes(`FROM ${SHEET_PERMISSION_VERSIONS_TABLE}`)) return 'sheet:share'
      if (sql.startsWith(`INSERT INTO ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE}`)) return 'subject:ensure'
      if (sql.includes(`FROM ${SUBJECT_AUTHORIZATION_VERSIONS_TABLE}`)) return 'subject:share'
      const table = /FROM (\w+)/.exec(sql)?.[1]
      return table ?? sql
    })
    expect(kinds).toEqual([
      'isolation', 'xid', 'xid', 'posture',
      'sheet:ensure', 'sheet:share', 'sheet:ensure', 'sheet:share',
      'subject:ensure', 'subject:share',
      ...LIVE_AUTHORITY_LOCK_ORDER,
      'meta_records',
    ])
    // Sheets ascending even though the input listed them the other way round.
    expect(trx.calls.filter(({ sql }) => sql.startsWith(`INSERT INTO ${SHEET_PERMISSION_VERSIONS_TABLE}`)).map(({ params }) => params[0])).toEqual(['sheet-a', 'sheet-b'])
    expect(trx.calls.filter(({ sql }) => sql.includes(`FROM ${SHEET_PERMISSION_VERSIONS_TABLE}`)).map(({ params }) => params[0])).toEqual(['sheet-a', 'sheet-b'])
    // Every version row and every authority row is held FOR SHARE; the only writes are the DO NOTHING ensures.
    const shares = trx.calls.filter(({ sql }) => /FOR SHARE$/.test(sql))
    expect(shares).toHaveLength(2 + 1 + LIVE_AUTHORITY_LOCK_ORDER.length + 1)
    expect(trx.calls.filter(({ sql }) => /^(UPDATE|DELETE)\b/.test(sql))).toEqual([])
    expect(trx.calls.filter(({ sql }) => /^INSERT\b/.test(sql)).every(({ sql }) => sql.endsWith('DO NOTHING'))).toBe(true)
    // The record is addressed by the bound id within the locked sheets, never by id alone.
    const record = trx.calls.find(({ sql }) => sql.includes('FROM meta_records'))
    expect(record?.params).toEqual(['rec-1', ['sheet-a', 'sheet-b']])
    expect(record?.sql).toContain('FOR SHARE')
    expect(result).toMatchObject({
      sheetVersions: [{ sheetId: 'sheet-a', version: 7 }, { sheetId: 'sheet-b', version: 7 }],
      subjectVersion: { subjectId: 'actor-1', version: 3 },
      record: { recordId: 'rec-1', sheetId: 'sheet-a', data: { k: 1 }, deletedAt: null },
      lockOrder: ADMISSION_LOCK_ORDER,
    })
    expect([...ADMISSION_LOCK_ORDER]).toEqual([SHEET_PERMISSION_VERSIONS_TABLE, SUBJECT_AUTHORIZATION_VERSIONS_TABLE, ...LIVE_AUTHORITY_LOCK_ORDER, 'meta_records'])
  })

  it('L-02 the six live-authority statements are issued with the live-authority parameters and no JOIN back into user_roles', async () => {
    const trx = createTrx({ roles: ['z_role', 'a_role'] })
    await lockAuthorizationVersionsForAdmission(trx, INPUT)
    const byTable = (table: string) => trx.calls.find(({ sql }) => new RegExp(`FROM ${table}\\s`).test(sql))!
    expect(byTable('user_roles').params).toEqual(['actor-1'])
    expect(byTable('role_permissions').params).toEqual([['a_role', 'z_role']])
    expect(byTable('role_permissions').sql).not.toContain('JOIN')
    expect(byTable('user_permissions').params).toEqual(['actor-1'])
    expect(byTable('users').params).toEqual(['actor-1'])
    expect(byTable('user_orgs').params).toEqual(['actor-1', 'tenant-1'])
    expect(byTable('user_namespace_admissions').params).toEqual(['actor-1', 'integration'])
    expect(trx.calls.filter(({ sql }) => /FROM user_roles\s/.test(sql))).toHaveLength(1)
  })

  it('L-03 no record requested → no meta_records statement and record = null; an absent record row → null, never a fabricated one', async () => {
    const without = createTrx()
    const result = await lockAuthorizationVersionsForAdmission(without, { ...INPUT, recordId: null })
    expect(without.calls.some(({ sql }) => sql.includes('meta_records'))).toBe(false)
    expect(result.record).toBeNull()
    const absent = createTrx({ record: null })
    expect((await lockAuthorizationVersionsForAdmission(absent, INPUT)).record).toBeNull()
  })

  it('L-04 admin-ness comes from LOCKED ROWS only, the live-authority contract: admin role, users.role = admin, or the role:admin code — never users.is_admin or the request', async () => {
    const cases: Array<[Fixture, boolean]> = [
      [{ roles: ['admin'] }, true],
      [{ roles: ['viewer'], user: { id: 'actor-1', role: 'admin', is_active: true, activation_status: 'activated', permissions: [], is_admin: false } }, true],
      [{ roles: ['viewer'], directPermissions: ['role:admin'] }, true],
      [{ roles: ['viewer'], user: { id: 'actor-1', role: 'user', is_active: true, activation_status: 'activated', permissions: ['role:admin'] } }, true],
      [{ roles: ['viewer'], user: { id: 'actor-1', role: 'user', is_active: true, activation_status: 'activated', permissions: [], is_admin: true } }, false],
      [{ roles: ['viewer'] }, false],
      [{ roles: [], user: null, membership: null, admission: null }, false],
    ]
    for (const [fixture, expected] of cases) {
      const trx = createTrx(fixture)
      const result = await lockAuthorizationVersionsForAdmission(trx, INPUT)
      expect(result.authority.isAdmin, JSON.stringify(fixture)).toBe(expected)
    }
    const facts = await lockAuthorizationVersionsForAdmission(createTrx({ roles: ['viewer', 'editor'], rolePermissions: [{ role_id: 'viewer', permission_code: 'multitable:read' }, { role_id: 'editor', permission_code: 'multitable:write' }], directPermissions: ['crm:read'], user: { id: 'actor-1', role: 'user', is_active: true, activation_status: 'activated', permissions: ['legacy:code'] } }), INPUT)
    expect(facts.authority).toMatchObject({
      roleIds: ['editor', 'viewer'],
      permissionCodes: ['crm:read', 'legacy:code', 'multitable:read', 'multitable:write'],
      directPermissionCodes: ['crm:read'],
      user: { id: 'actor-1', role: 'user', isActive: true, activationStatus: 'activated', permissions: ['legacy:code'] },
      membership: { orgId: 'tenant-1', isActive: true },
      integrationAdmission: { enabled: true },
      isAdmin: false,
    })
  })

  it('L-05 40P01 / 40001 / 55P03 on ANY statement → typed CONFLICT (retryable, sqlState kept), never a resolved result', async () => {
    expect([...AUTHORIZATION_VERSION_CONFLICT_SQLSTATES]).toEqual(['40P01', '40001', '55P03'])
    for (const code of AUTHORIZATION_VERSION_CONFLICT_SQLSTATES) {
      for (const when of [/FROM sheet_permission_versions/, /FROM subject_authorization_versions/, /FROM users\s/, /FROM meta_records/, /^INSERT INTO sheet_permission_versions/]) {
        const trx = createTrx({ failWith: { when, error: Object.assign(new Error('synthetic_private_detail'), { code }) } })
        const outcome = await lockAuthorizationVersionsForAdmission(trx, INPUT).then(() => 'resolved', (error: unknown) => error)
        expect(outcome).toBeInstanceOf(AuthorizationVersionProtocolError)
        const error = outcome as AuthorizationVersionProtocolError
        expect(error.code).toBe('AUTHZ_VERSION_CONFLICT')
        expect(error.retryable).toBe(true)
        expect(error.sqlState).toBe(code)
        expect(isAuthorizationVersionConflict(error)).toBe(true)
        expect(JSON.stringify(error) + error.message + String(error.stack)).not.toContain('synthetic_private_detail')
      }
    }
  })

  it('L-06 any other database failure → AUTHZ_VERSION_UNAVAILABLE, not retryable, values-free; a posture-query failure is mapped the same way', async () => {
    for (const when of [/FROM role_permissions/, /^SELECT rel.relname/]) {
      const trx = createTrx({ failWith: { when, error: Object.assign(new Error('relation "x" does not exist synthetic_private_detail'), { code: '42P01' }) } })
      const error = await lockAuthorizationVersionsForAdmission(trx, INPUT).catch((caught: unknown) => caught) as AuthorizationVersionProtocolError
      expect(error).toBeInstanceOf(AuthorizationVersionProtocolError)
      expect(error.code).toBe('AUTHZ_VERSION_UNAVAILABLE')
      expect(error.retryable).toBe(false)
      expect(isAuthorizationVersionConflict(error)).toBe(false)
      expect(error.message + JSON.stringify(error)).not.toContain('synthetic_private_detail')
    }
    // A version row that cannot be read after the ensure is unavailable, not silently version 0.
    const zero = createTrx({ sheetVersion: '0' })
    await expect(lockAuthorizationVersionsForAdmission(zero, INPUT)).rejects.toMatchObject({ code: 'AUTHZ_VERSION_UNAVAILABLE' })
  })

  it('L-07 the posture is verified BEFORE any lock: a missing, disabled or re-pointed trigger closes the admission with the gap named, and no version row is touched', async () => {
    for (const posture of [
      postureRows({ omit: ['trg_meta_fields_zz_authz_sheet_version_visibility'] }),
      postureRows({ disable: ['trg_users_zz_authz_subject_version_update'] }),
      postureRows({ wrongFunction: ['trg_record_permissions_zz_authz_sheet_version'] }),
    ]) {
      const trx = createTrx({ posture })
      const error = await lockAuthorizationVersionsForAdmission(trx, INPUT).catch((caught: unknown) => caught) as AuthorizationVersionProtocolError
      expect(error).toBeInstanceOf(AuthorizationVersionProtocolError)
      expect(error.code).toBe('AUTHZ_VERSION_PROTOCOL_UNAVAILABLE')
      expect(error.missingTriggers).toHaveLength(1)
      expect(trx.calls.some(({ sql }) => sql.includes('_versions') && !sql.startsWith('SELECT rel.relname'))).toBe(false)
      expect(trx.calls.some(({ sql }) => /FOR SHARE/.test(sql))).toBe(false)
    }
    expect(await verifyAuthorizationVersionTriggerPosture(createTrx().query)).toEqual({ ok: true, triggers: 13 })
    expect(await verifyAuthorizationVersionTriggerPosture(createTrx({ posture: postureRows({ omit: ['trg_users_zz_authz_subject_version_lifecycle'] }) }).query))
      .toEqual({ ok: false, missing: ['users.trg_users_zz_authz_subject_version_lifecycle'] })
    // The posture query asks the catalog for exactly the expected trigger names, by name, in public.
    const posture = createTrx()
    await verifyAuthorizationVersionTriggerPosture(posture.query)
    expect(posture.calls[0]!.params).toEqual([AUTHORIZATION_VERSION_TRIGGERS.map((entry) => entry.trigger)])
    expect(collapse(AUTHORIZATION_VERSION_TRIGGER_POSTURE_SQL)).toContain("ns.nspname = 'public'")
    expect(collapse(AUTHORIZATION_VERSION_TRIGGER_POSTURE_SQL)).toContain('NOT trg.tgisinternal')
  })

  it('L-08 the helper refuses outside a READ COMMITTED transaction (two xid probes must agree) and refuses malformed input before issuing anything', async () => {
    const autocommit = createTrx({ xids: ['11', '12'] })
    await expect(lockAuthorizationVersionsForAdmission(autocommit, INPUT)).rejects.toMatchObject({ code: 'AUTHZ_VERSION_TRANSACTION_REQUIRED' })
    expect(autocommit.calls.some(({ sql }) => sql.includes('_versions'))).toBe(false)
    const serializable = createTrx({ isolation: 'serializable' })
    await expect(lockAuthorizationVersionsForAdmission(serializable, INPUT)).rejects.toMatchObject({ code: 'AUTHZ_VERSION_TRANSACTION_REQUIRED' })
    for (const input of [
      { ...INPUT, sheetIds: [] },
      { ...INPUT, sheetIds: [' sheet-a'] },
      { ...INPUT, actorId: '' },
      { ...INPUT, actorId: 'a\u0000b' },
      { ...INPUT, tenantId: 'x'.repeat(256) },
      { ...INPUT, recordId: 'r\u001f' },
      null,
      [],
    ]) {
      const trx = createTrx()
      await expect(lockAuthorizationVersionsForAdmission(trx, input as never)).rejects.toMatchObject({ code: 'AUTHZ_VERSION_INPUT_INVALID' })
      expect(trx.calls).toEqual([])
    }
  })
})

describe('W — writers bump FIRST', () => {
  it('W-01 the access-graph mutex bumps the subject version rows (sorted, one statement) BEFORE the first users FOR UPDATE', () => {
    const source = readFileSync(path.join(SRC, 'directory', 'access-graph-mutex.ts'), 'utf8')
    const bumpAt = source.indexOf('await bumpSubjectAuthorizationVersions(client, normalizedUserIds)')
    // The statement text (template literal end), not the docblock that explains it.
    const lockAt = source.indexOf('FOR UPDATE`,')
    expect(bumpAt).toBeGreaterThan(0)
    expect(lockAt).toBeGreaterThan(bumpAt)
    expect(source.match(/bumpSubjectAuthorizationVersions\(/g)).toHaveLength(1)
  })

  it('W-02 role assignment bumps between the roles FOR SHARE review and the membership write; the five autocommit routes now run in transaction() with the bump first', () => {
    const roleAssignment = readFileSync(path.join(SRC, 'rbac', 'role-assignment.ts'), 'utf8')
    for (const write of ['INSERT INTO user_roles', 'DELETE FROM user_roles']) {
      const writeAt = roleAssignment.indexOf(write)
      const bumpAt = roleAssignment.lastIndexOf('await bumpSubjectAuthorizationVersions(executor, userIds)', writeAt)
      const reviewAt = roleAssignment.lastIndexOf("await assertDelegatedRoleCodesAssignable(executor, roleId, options.scope", writeAt)
      expect(bumpAt).toBeGreaterThan(reviewAt)
      expect(writeAt).toBeGreaterThan(bumpAt)
    }
    const permissions = readFileSync(path.join(SRC, 'routes', 'permissions.ts'), 'utf8')
    expect(permissions.match(/await transaction\(async \(client\) => \{\s*await bumpSubjectAuthorizationVersions\(client, \[userId\]\)/g)).toHaveLength(3)
    expect(permissions).not.toMatch(/pool\.query\(\s*[`']\s*(INSERT INTO|DELETE FROM) user_permissions/)
    const adminUsers = readFileSync(path.join(SRC, 'routes', 'admin-users.ts'), 'utf8')
    expect(adminUsers).toMatch(/await transaction\(async \(client\) => \{\s*await bumpSubjectAuthorizationVersions\(client, \[userId\]\)\s*if \(action === 'assign'\)/)
    expect(adminUsers).not.toMatch(/await query\(\s*`INSERT INTO platform_member_group_members/)
    expect(adminUsers).toMatch(/async function syncLegacyAdminProfile[\s\S]*?await transaction\(async \(client\) => \{\s*await bumpSubjectAuthorizationVersions\(client, \[userId\]\)/)
  })

  it('W-03 sheet layer: every route bumps AFTER its meta_sheets row lock and BEFORE any exclusive record lock — the record-permission routes between record-link phases 1–4 (shared) and phase 5, the grant / configuration routes right after assertSheetLiveForUpdate', () => {
    const univer = readFileSync(path.join(SRC, 'routes', 'univer-meta.ts'), 'utf8')
    for (const outcome of ['PutRecordPermissionTxnOutcome', 'DeleteRecordPermissionTxnOutcome']) {
      const start = univer.indexOf(`pool.transaction(async ({ query }): Promise<${outcome}> => {`)
      expect(start).toBeGreaterThan(0)
      const body = univer.slice(start, start + 1600)
      const phasesAt = body.indexOf('await lockRecordLinkAuthorityRowsOnQuery(query, {')
      const bumpAt = body.indexOf('await bumpSheetPermissionVersions(query, [sheetId])')
      const rowAuthAt = body.indexOf('await acquireRecordLinkRowAuthLockOnQuery(query, sheetId, recordId)')
      expect(phasesAt).toBeGreaterThan(0)
      expect(bumpAt).toBeGreaterThan(phasesAt)
      expect(rowAuthAt).toBeGreaterThan(bumpAt)
      // Nothing but the shared phases precedes the bump; nothing exclusive is taken before it
      // (code only — the comments explaining the order name the exclusive locks).
      expect(body.slice(0, bumpAt).replace(/\/\/[^\n]*/g, '')).not.toMatch(/FOR UPDATE|pg_advisory_xact_lock|INSERT INTO|DELETE FROM|UPDATE /)
    }
    // The four sheet-configuration / grant routes bump right after the sheet row lock.
    expect(univer.match(/await assertSheetLiveForUpdate\(query, sheetId\)\s*(?:\/\/[^\n]*\n\s*)?await bumpSheetPermissionVersions\(query, \[sheetId\]\)/g)).toHaveLength(4)
    const spreadsheet = readFileSync(path.join(SRC, 'routes', 'spreadsheet-permissions.ts'), 'utf8')
    expect(spreadsheet.match(/await assertSheetLiveForUpdate\(query, req\.params\.id\)\s*(?:\/\/[^\n]*\n\s*)?await bumpSheetPermissionVersions\(query, \[req\.params\.id\]\)/g)).toHaveLength(2)
  })

  it('W-04 the controlled handover bumps the subject rows BEFORE its users FOR UPDATE NOWAIT probe, which precedes the mutex', () => {
    const source = readFileSync(path.join(SRC, 'directory', 'controlled-handover.ts'), 'utf8')
    const bumpAt = source.indexOf('await bumpSubjectAuthorizationVersions(c, userIds)')
    const probeAt = source.indexOf("'SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT'")
    const mutexAt = source.indexOf('await lockUsersForAccessGraphWrite(c, userIds)')
    expect(bumpAt).toBeGreaterThan(0)
    expect(probeAt).toBeGreaterThan(bumpAt)
    expect(mutexAt).toBeGreaterThan(probeAt)
  })

  it('W-05 the deprovision ledger and the evidence-API restore bump the subject row before their own users FOR UPDATE', () => {
    const ledger = readFileSync(path.join(SRC, 'directory', 'deprovision-ledger.ts'), 'utf8')
    const ledgerBumpAt = ledger.indexOf('await bumpSubjectAuthorizationVersions(client, [localUserId])')
    const ledgerLockAt = ledger.indexOf('`SELECT id FROM users WHERE id = $1::text FOR UPDATE`')
    expect(ledgerBumpAt).toBeGreaterThan(0)
    expect(ledgerLockAt).toBeGreaterThan(ledgerBumpAt)
    const evidence = readFileSync(path.join(SRC, 'directory', 'deprovision-evidence-api.ts'), 'utf8')
    const bumpAt = evidence.indexOf('await bumpSubjectAuthorizationVersions(client, [eventOwner])')
    expect(bumpAt).toBeGreaterThan(0)
    const txnStart = evidence.lastIndexOf('transaction(async (client) => {', bumpAt)
    expect(txnStart).toBeGreaterThan(0)
    expect(evidence.slice(txnStart, bumpAt)).not.toMatch(/FOR UPDATE|lockUsersForAccessGraphWrite/)
    const lockAfter = evidence.slice(bumpAt).search(/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE`/)
    expect(lockAfter).toBeGreaterThan(0)
  })

  it('W-06 setUserNamespaceAdmission bumps after the advisory and before the upsert; the two user_orgs helpers bump before their first statement', () => {
    const admission = readFileSync(path.join(SRC, 'rbac', 'namespace-admission.ts'), 'utf8')
    expect(admission).toMatch(/await lockNamespaceAdmissionWrites\(client, userId\)\s*(?:\/\/[^\n]*\n\s*)*await bumpSubjectAuthorizationVersions\(client, \[userId\]\)\s*await client\.query\(\s*`INSERT INTO user_namespace_admissions/)
    const sync = readFileSync(path.join(SRC, 'directory', 'directory-sync.ts'), 'utf8')
    for (const helper of ['upsertActiveUserOrgMembership', 'deactivateUserOrgMembershipIfNoOtherActiveBinding']) {
      const start = sync.indexOf(`export async function ${helper}(`)
      expect(start).toBeGreaterThan(0)
      const body = sync.slice(start, start + 900)
      const bumpAt = body.indexOf('await bumpSubjectAuthorizationVersions(client, [options.userId])')
      const firstQueryAt = body.indexOf('await client.query(')
      expect(bumpAt).toBeGreaterThan(0)
      expect(firstQueryAt).toBeGreaterThan(bumpAt)
    }
  })
})

describe('F — the field-row writer rule (sheet version row before the first meta_fields row lock; the #6792 follow-up)', () => {
  it('F-01 fieldVisibilityTriggerWouldFire is the trigger\'s own test: the M-05 matrix of the real-DB file, step for step', () => {
    // Same sequence as authz-version-protocol.db.test.ts M-05 (each step's expected trigger delta: 1 = bump).
    const steps: Array<[unknown, unknown, boolean]> = [
      [{ options: [] }, { options: ['a'] }, false],
      [{ options: ['a'] }, { options: ['a'], hidden: false }, false],
      [{ options: ['a'], hidden: false }, { options: ['a'], hidden: true }, true],
      [{ options: ['a'], hidden: true }, { options: ['b'], hidden: true }, false],
      [{ options: ['b'], hidden: true }, { options: ['b'] }, true],
      [{ options: ['b'] }, { visible: false }, true],
      [{ visible: false }, { visible: false, format: 'x' }, false],
      [{ visible: false, format: 'x' }, { visible: true }, true],
    ]
    for (const [stored, next, fires] of steps) expect(fieldVisibilityTriggerWouldFire(stored, next), JSON.stringify([stored, next])).toBe(fires)
  })

  it('F-02 the flags, not the derivation; JSON true / false only; a non-object property has neither flag', () => {
    // already hidden: adding visible:false changes no derivation, and the trigger still fires
    expect(fieldVisibilityTriggerWouldFire({ hidden: true }, { hidden: true, visible: false })).toBe(true)
    // `= 'true'::jsonb` / `= 'false'::jsonb`: a string or a number is neither flag
    expect(fieldVisibilityTriggerWouldFire({ hidden: 'true' }, {})).toBe(false)
    expect(fieldVisibilityTriggerWouldFire({ hidden: 1, visible: 0 }, {})).toBe(false)
    expect(fieldVisibilityTriggerWouldFire({ visible: 'false' }, { visible: null })).toBe(false)
    // `property -> 'hidden'` is NULL for an array, a string, a number or null
    for (const nonObject of [null, undefined, [], ['hidden'], 'x', JSON.stringify({ hidden: true }), 7]) {
      expect(fieldVisibilityTriggerWouldFire(nonObject, {}), JSON.stringify(nonObject)).toBe(false)
      expect(fieldVisibilityTriggerWouldFire(nonObject, { hidden: true }), JSON.stringify(nonObject)).toBe(true)
      expect(fieldVisibilityTriggerWouldFire({ visible: false }, nonObject), JSON.stringify(nonObject)).toBe(true)
    }
  })

  it('F-03 source order: every meta_fields writer that can trip the trigger bumps after its fence and before its first field-row lock', () => {
    // LF-normalized: a Windows checkout is CRLF, CI is LF.
    const readLf = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const univer = readLf(path.join(SRC, 'routes', 'univer-meta.ts'))
    const at = (source: string, needle: string, from = 0) => {
      const index = source.indexOf(needle, from)
      expect(index, needle).toBeGreaterThan(0)
      return index
    }
    // config-restore, generic branch: the bump precedes the snapshot's FOR NO KEY UPDATE
    const genericBump = at(univer, 'if (configRevertCanTripFieldVisibility(rev)) await bumpSheetPermissionVersions(query, [sheetId])\n        // A field snapshot')
    expect(at(univer, 'await loadEntityConfigSnapshot(query, rev, { lockField: true })', genericBump)).toBeGreaterThan(genericBump)
    // config-restore, lossy-retype branch: the bump precedes the FOR UPDATE field read (and therefore its cell locks)
    const lossyRead = at(univer, 'const fieldRow = await loadLossyRetypeFieldRow(query, rev.entity_id, true)')
    const lossyBump = univer.lastIndexOf('if (configRevertCanTripFieldVisibility(rev)) await bumpSheetPermissionVersions(query, [sheetId])', lossyRead)
    expect(lossyBump).toBeGreaterThan(univer.lastIndexOf('await fenceWriterEntry(query, sheetId)', lossyRead))
    expect(univer.match(/if \(configRevertCanTripFieldVisibility\(rev\)\) await bumpSheetPermissionVersions\(query, \[sheetId\]\)/g)).toHaveLength(2)
    // PATCH /fields: the conditional bump precedes the sibling shift and the late locked re-read, and goes BEHIND the
    // sheet row (a conversion to autoNumber inserts an FK child of meta_sheets after it: verifier r1 F1, the twin)
    const patchBump = at(univer, 'if (fieldVisibilityTriggerWouldFire(validated.property, nextProperty)) await bumpSheetPermissionVersionBehindSheetRow(query, sheetId)')
    expect(at(univer, 'UPDATE meta_fields SET "order" = "order" + 1', patchBump)).toBeGreaterThan(patchBump)
    expect(at(univer, 'await query(PATCH_FIELD_LOCKED_REREAD_SQL, [fieldId])', patchBump)).toBeGreaterThan(patchBump)
    expect(at(univer, 'await backfillAutoNumberField(query, sheetId, fieldId, nextProperty, { overwrite: true })', patchBump)).toBeGreaterThan(patchBump)
    expect(univer.lastIndexOf('await fenceWriterEntry(query, preflightSheetId)', patchBump)).toBeGreaterThan(0)
    expect(univer.match(/fieldVisibilityTriggerWouldFire\(/g)).toHaveLength(1)
    // the plugin property port (no FK child insert after its bump: the plain bump) and an overwriting ensureFields
    // (its INSERT of a new field takes FOR KEY SHARE on the sheet row: the bump goes behind the sheet row, verifier r1 F1)
    const provisioning = readLf(path.join(SRC, 'multitable', 'provisioning.ts'))
    const portBump = at(provisioning, 'await bumpSheetPermissionVersions(input.query, [sheetId])\n  const existing = await input.query(PATCH_OBJECT_FIELD_PROPERTY_READ_SQL')
    expect(provisioning.lastIndexOf('await fenceWriterEntry(input.query, sheetId)', portBump)).toBeGreaterThan(0)
    const ensureBump = at(provisioning, "if (fields.length > 0 && (overwriteMode === 'overwrite' || overwriteMode === 'observe')) {\n    await bumpSheetPermissionVersionBehindSheetRow(input.query, input.sheetId)\n  }")
    expect(at(provisioning, 'for (const [index, field] of fields.entries()) {', ensureBump)).toBeGreaterThan(ensureBump)
    expect(provisioning.lastIndexOf('if (fields.length > 0) await fenceWriterEntry(input.query, input.sheetId)', ensureBump)).toBeGreaterThan(0)
    // the field retype convert and its undo (verifier r1 F2): the plain bump after the fence and the in-transaction gate,
    // before each function's first row lock — the field row FOR UPDATE (convert), the job row FOR UPDATE (undo)
    const convert = readLf(path.join(SRC, 'multitable', 'field-retype-convert-execute.ts'))
    const convertBumps = Array.from(convert.matchAll(/await bumpSheetPermissionVersions\(query, \[sheetId\]\)/g)).map((match) => match.index!)
    expect(convertBumps).toHaveLength(2)
    const executeAt = at(convert, 'export async function executeFieldRetypeConvert(')
    const undoAt = at(convert, 'export async function undoFieldRetypeConvert(')
    for (const [label, start, bump, firstLock] of [
      ['execute', executeAt, convertBumps[0]!, at(convert, `'SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1 FOR UPDATE'`, executeAt)],
      ['undo', undoAt, convertBumps[1]!, at(convert, 'FROM meta_field_retype_conversions\n      WHERE convert_revision_id = $1::uuid AND field_id = $2 AND sheet_id = $3\n      FOR UPDATE', undoAt)],
    ] as const) {
      expect([label, bump > at(convert, 'await enterFence(query, sheetId)', start)]).toEqual([label, true])
      expect([label, bump > at(convert, 'if (gate) return { ok: false, gate }', start)]).toEqual([label, true])
      expect([label, bump < firstLock]).toEqual([label, true])
      expect([label, convert.slice(start, bump).includes('FOR UPDATE\'') || /FOR UPDATE`/.test(convert.slice(start, bump))]).toEqual([label, false])
    }
    expect(convertBumps[0]!).toBeLessThan(undoAt)
    expect(convertBumps[1]!).toBeGreaterThan(undoAt)
  })
})

describe('D — the live-authority drift guard', () => {
  it('D-01 the helper issues the live-authority reads in the order automation-live-authority.ts locks them (statement text normalized)', async () => {
    const source = readFileSync(path.join(SRC, 'integration', 'automation-live-authority.ts'), 'utf8')
    const liveStatements = Array.from(source.matchAll(/`([^`]*FOR SHARE)`/g)).map((match) => collapse(match[1]!))
    expect(liveStatements).toHaveLength(LIVE_AUTHORITY_LOCK_ORDER.length)
    expect(liveStatements.map((sql) => /FROM (\w+)/.exec(sql)?.[1])).toEqual([...LIVE_AUTHORITY_LOCK_ORDER])
    const trx = createTrx()
    await lockAuthorizationVersionsForAdmission(trx, INPUT)
    const helperStatements = trx.calls
      .map(({ sql }) => sql)
      .filter((sql) => LIVE_AUTHORITY_LOCK_ORDER.some((table) => new RegExp(`FROM ${table}\\s`).test(sql)))
    expect(helperStatements).toEqual(liveStatements)
    expect(source).toContain('Lock order: user_roles -> role_permissions -> user_permissions -> users -> user_orgs')
  })
})

describe('C — the census', () => {
  const CENSUS_ROOTS = ['plugins', 'packages/core-backend/plugins'] as const
  const DML = new RegExp(
    `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?)\\s+"?(public\\.)?(${COVERED.join('|')})\\b`,
    'i',
  )
  const walk = (dir: string, files: string[]) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '__tests__') continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full, files)
      else if (/\.(ts|cts|mts|cjs|mjs|js|sql)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(full)
    }
    return files
  }
  /** Code only: block comments, `//` lines and SQL `--` lines are prose (a docblock may quote a statement). */
  const codeOf = (file: string) => readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

  it('C-01 the DML regex catches the writer shapes and leaves reads alone', () => {
    for (const writer of [
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
      'UPDATE users SET is_active = false WHERE id = $1',
      'DELETE FROM\n  platform_member_group_members WHERE user_id = $1',
      'TRUNCATE TABLE record_permissions',
      'insert into "field_permissions" (sheet_id) values ($1)',
      'UPDATE public.meta_sheets SET deleted_at = now()',
    ]) expect(DML.test(writer), writer).toBe(true)
    for (const reader of [
      'SELECT user_id FROM platform_member_group_members WHERE group_id = $1',
      'LEFT JOIN user_orgs uo ON uo.user_id = u.id',
      'SELECT * FROM users_view',
      'UPDATE users_audit SET x = 1',
    ]) expect(DML.test(reader), reader).toBe(false)
  })

  it('C-02 no in-tree plugin root writes a covered table through its raw database handle (the triggers would cover it; the census says there is none to cover)', () => {
    const writers: string[] = []
    for (const root of CENSUS_ROOTS) {
      const files = walk(path.join(ROOT, root), [])
      expect(files.length, `${root} walk found files`).toBeGreaterThan(0)
      for (const file of files) {
        if (DML.test(codeOf(file))) writers.push(path.relative(ROOT, file).replace(/\\/g, '/'))
      }
    }
    expect(writers).toEqual([])
  })

  it('C-03 only the migration and the protocol module write the two version tables (one-writer census over core-backend/src and the plugin roots)', () => {
    // Literal table names, the module's `${…_TABLE}` placeholders, and the migration's identifier() form.
    const VERSION_DML = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+"?(public\.)?((sheet_permission_versions|subject_authorization_versions)\b|\$\{(SHEET_PERMISSION_VERSIONS_TABLE|SUBJECT_AUTHORIZATION_VERSIONS_TABLE)\})|\$\{sql\.raw\(identifier\(table\)\)\}/i
    const writers: string[] = []
    for (const root of ['packages/core-backend/src', ...CENSUS_ROOTS]) {
      for (const file of walk(path.join(ROOT, root), [])) {
        if (VERSION_DML.test(codeOf(file))) writers.push(path.relative(ROOT, file).replace(/\\/g, '/'))
      }
    }
    expect(writers.sort()).toEqual([
      `packages/core-backend/src/db/migrations/${MIGRATION}.ts`,
      'packages/core-backend/src/multitable/authz-version-protocol.ts',
    ])
  })
})

describe('R — the hard-condition registry', () => {
  it('R-01 names the project registry (check 1), the request cache (checks 2-4), the replica / TRUNCATE window and the not-installed posture; it is frozen data', () => {
    expect(Object.isFrozen(AUTHORIZATION_PROTOCOL_GAPS)).toBe(true)
    expect(AUTHORIZATION_PROTOCOL_GAPS.map((gap) => gap.id)).toEqual([
      'stock-prep-project-registry',
      'request-cache-admin-and-codes',
      'session-replication-role-replica',
      'triggers-not-installed',
      'field-property-jsonb-string-encoding',
    ])
    for (const gap of AUTHORIZATION_PROTOCOL_GAPS) {
      expect(Object.isFrozen(gap)).toBe(true)
      expect(gap.handling.length).toBeGreaterThan(20)
      expect(gap.input.length).toBeGreaterThan(20)
      // Values-free: locations, never hosts, credentials or ids.
      expect(gap.input + gap.handling).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|password|appKey|authorityCode/i)
    }
    expect(authorizationProtocolGapsFor([1]).map((gap) => gap.id)).toEqual(['stock-prep-project-registry'])
    expect(authorizationProtocolGapsFor([3]).map((gap) => gap.id)).toEqual(['request-cache-admin-and-codes', 'session-replication-role-replica', 'triggers-not-installed', 'field-property-jsonb-string-encoding'])
    expect(authorizationProtocolGapsFor([4]).map((gap) => gap.id)).toEqual(['request-cache-admin-and-codes', 'session-replication-role-replica', 'triggers-not-installed'])
    expect(authorizationProtocolGapsFor([]).map((gap) => gap.id)).toEqual([])
    expect(AUTHORIZATION_PROTOCOL_GAPS.find((gap) => gap.id === 'request-cache-admin-and-codes')?.kind).toBe('forbidden-input')
  })

  it('R-02 the legacy jsonb-STRING property encoding is listed while the trigger and the readers disagree on it (verifier r1 F4; the real-DB premise is G-01)', () => {
    const gap = AUTHORIZATION_PROTOCOL_GAPS.find((entry) => entry.id === 'field-property-jsonb-string-encoding')
    expect(gap).toBeDefined()
    expect(gap!.checks).toEqual([3])
    expect(gap!.kind).toBe('bypass-window')
    // the premise, at unit level: the trigger's own test reads no flag from a string-encoded property …
    const hiddenAsString = JSON.stringify({ hidden: true })
    expect(fieldVisibilityTriggerWouldFire({}, hiddenAsString)).toBe(false)
    expect(fieldVisibilityTriggerWouldFire(JSON.stringify({}), hiddenAsString)).toBe(false)
    // … while the readers' derivation parses it (normalizeJson → hidden)
    expect(isFieldPermissionHidden({ property: normalizeJson(hiddenAsString) })).toBe(true)
    expect(isFieldPermissionHidden({ property: normalizeJson({}) })).toBe(false)
    // the handling names the operational rule and the closing normalization, values-free
    expect(gap!.handling).toMatch(/raw SQL writes meta_fields\.property as a JSON object/)
    expect(gap!.handling).toMatch(/normalization/)
    expect(gap!.input).toMatch(/property -> 'hidden' is NULL for a string/)
  })
})

describe('X — CI wiring of the real-DB half', () => {
  it('X-01 the whole file runs once in the approval real-DB step, is excluded from the no-DB runner, exists, and is pinned by the parallel contract', () => {
    const workflow = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/plugin-tests.yml'), 'utf8')) as Parameters<typeof requiredSuiteJob>[0]
    const step = requiredSuiteJob(workflow, 'approval-db').steps.find((entry: { id?: string }) => entry.id === 'approval-real-db-integration') as
      { id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown } | undefined
    expect(step?.if).toBe("matrix.node-version == '20.x'")
    expect(step?.env?.EXPECT_DB).toBe('1')
    expect(step?.['continue-on-error']).toBeUndefined()
    const command = (step?.run ?? '').replace(/\\\r?\n/g, ' ')
    expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /)
    expect(command.split(/\s+/).filter((token) => token === DB_SPEC)).toHaveLength(1)
    const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(BACKEND, 'vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    let excluded = false
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
        excluded ||= node.initializer.elements.some((entry) => ts.isStringLiteral(entry) && entry.text === DB_SPEC)
      }
      ts.forEachChild(node, visit)
    }
    visit(config)
    expect(excluded).toBe(true)
    expect(existsSync(path.join(BACKEND, DB_SPEC))).toBe(true)
    const contract = readFileSync(path.join(ROOT, 'scripts/ops/plugin-tests-parallel-contract.test.mjs'), 'utf8')
    expect(contract.match(/authz-version-protocol\.db\.test\.ts/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
