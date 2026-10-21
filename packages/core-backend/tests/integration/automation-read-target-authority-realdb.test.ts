/**
 * Actual target helper + actual DB-fresh access/permission services against an
 * owned random PostgreSQL schema. This is a prerequisite proof, not a full host
 * port/source authorization proof. The fixture deliberately has NO meta_records
 * table: neither permission decisions nor completeness may depend on data reads.
 */
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AutomationTargetAuthorityError,
  lockAutomationReadConditionFields,
  lockAutomationReadTarget,
  type AutomationReadTargetInput,
} from '../../src/integration/automation-read-target-authority'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECTED_DB must actually provide a database', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const scope = {
  actorId: 'synthetic-actor', baseId: 'synthetic-base', sheetId: 'synthetic-sheet',
  fieldIds: ['synthetic-field-b', 'synthetic-field-a'],
}
const actorRole = 'synthetic-role'
const actorGroup = '00000000-0000-4000-8000-000000000001'
const foreignActorId = 'synthetic-foreign-actor'
const acls = ['users', 'user_roles', 'user_permissions', 'role_permissions',
  'platform_member_group_members', 'spreadsheet_permissions', 'field_permissions', 'record_permissions'] as const
const conditionalRules = [{ id: 'synthetic-deny-rule', fieldId: 'synthetic-field-a',
  operator: 'eq', value: 'synthetic-private-value', effect: 'deny_read' }]

describeDatabase('Automation read target prerequisite: actual PostgreSQL permission decisions and locks', () => {
  const schema = `automation_read_target_${randomBytes(8).toString('hex')}`
  let pool: Pool
  let admin: PoolClient
  let reader: PoolClient
  let writer: PoolClient
  let observer: PoolClient
  const queries: string[] = []
  const conditionProjectionFacts: Array<{ textNull: boolean; bytes: number | null; oversized: boolean }> = []
  let conditionProjectionOverflow = false

  const tracked: Queryable = {
    async query(sql, params) {
      queries.push(sql)
      const result = await reader.query(sql, params)
      if (sql.includes('AS property_json')) {
        for (const row of result.rows) {
          if (conditionProjectionFacts.length >= 256) { conditionProjectionOverflow = true; break }
          conditionProjectionFacts.push({ textNull: row.property_json === null,
            bytes: typeof row.property_json === 'string' ? Buffer.byteLength(row.property_json, 'utf8') : null,
            oversized: row.property_oversized === true })
        }
      }
      return result
    },
  }
  async function capture(input: AutomationReadTargetInput = scope) {
    queries.length = 0
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { return await lockAutomationReadTarget(tracked, input) } finally { await reader.query('ROLLBACK') }
  }
  async function denied(input = scope): Promise<void> {
    await expect(capture(input)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_DENIED' })
  }
  async function captureConditions(input: AutomationReadTargetInput = scope) {
    queries.length = 0
    conditionProjectionFacts.length = 0
    conditionProjectionOverflow = false
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { return await lockAutomationReadConditionFields(tracked, input) } finally { await reader.query('ROLLBACK') }
  }
  async function conditionsDenied(): Promise<void> {
    await expect(captureConditions()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_DENIED' })
  }
  async function globalRead(enabled: boolean): Promise<void> {
    await admin.query('DELETE FROM user_permissions')
    if (enabled) await admin.query('INSERT INTO user_permissions VALUES ($1,$2)', [scope.actorId, 'multitable:read'])
  }
  async function setAdmin(): Promise<void> {
    await admin.query('INSERT INTO user_roles VALUES ($1,$2)', [scope.actorId, 'admin'])
  }
  async function fieldDeny(subjectType = 'user', subjectId = scope.actorId): Promise<void> {
    await admin.query(`INSERT INTO field_permissions
      (sheet_id,field_id,subject_type,subject_id,visible,read_only) VALUES ($1,$2,$3,$4,false,false)`,
    [scope.sheetId, scope.fieldIds[0], subjectType, subjectId])
  }
  async function pid(client: PoolClient): Promise<number> {
    return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  }
  async function waitForBlock(blockedPid: number, blockerPid: number, done: () => boolean): Promise<void> {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const result = await observer.query(`SELECT $2::int = ANY(pg_blocking_pids(pid)) AS blocked
        FROM pg_stat_activity WHERE pid = $1`, [blockedPid, blockerPid])
      if (result.rows[0]?.blocked === true) return
      expect(done()).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    expect.fail('Expected PostgreSQL to report a target authority lock')
  }
  async function proveBlocked(statement: string, params: unknown[] = [],
    lock: typeof lockAutomationReadTarget = lockAutomationReadTarget): Promise<void> {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await lock(reader, scope)
    await writer.query('BEGIN')
    const readerPid = await pid(reader), writerPid = await pid(writer)
    let done = false
    const pending = writer.query(statement, params).then(result => { done = true; return result })
    void pending.catch(() => {})
    try {
      await waitForBlock(writerPid, readerPid, () => done)
      expect(done).toBe(false)
      await reader.query('COMMIT')
      expect((await pending).rowCount).toBeGreaterThan(0)
      await writer.query('COMMIT')
    } finally {
      await reader.query('ROLLBACK')
      await pending.catch(() => {})
      await writer.query('ROLLBACK')
    }
  }

  beforeAll(async () => {
    if (!/^automation_read_target_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(`CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean);
      CREATE TABLE user_roles (user_id text, role_id text, PRIMARY KEY(user_id,role_id));
      CREATE TABLE user_permissions (user_id text, permission_code text, PRIMARY KEY(user_id,permission_code));
      CREATE TABLE role_permissions (role_id text, permission_code text, PRIMARY KEY(role_id,permission_code));
      CREATE TABLE platform_member_group_members (user_id text, group_id uuid, PRIMARY KEY(user_id,group_id));
      CREATE TABLE spreadsheet_permissions (sheet_id text, subject_type text, subject_id text, perm_code text);
      CREATE TABLE field_permissions (sheet_id text, field_id text, subject_type text, subject_id text, visible boolean, read_only boolean);
      CREATE TABLE record_permissions (sheet_id text, record_id text, subject_type text, subject_id text, access_level text);
      CREATE TABLE meta_bases (id text PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE meta_sheets (id text PRIMARY KEY, base_id text NOT NULL, deleted_at timestamptz,
        row_level_read_permissions_enabled boolean DEFAULT false, conditional_read_rules jsonb DEFAULT '[]');
      CREATE TABLE meta_fields (id text PRIMARY KEY, sheet_id text NOT NULL, type text NOT NULL, property jsonb)`)
    reader = await pool.connect()
    writer = await pool.connect()
    observer = await pool.connect()
    for (const client of [admin, reader, writer, observer]) {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query("SET statement_timeout = '8s'")
    }
  })

  afterAll(async () => {
    for (const client of [reader, writer, observer]) {
      if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    }
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      // Only the validated random schema this suite created, never public/customer data.
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    for (const client of [admin, reader, writer, observer]) await client.query('ROLLBACK')
    await admin.query(`TRUNCATE users, user_roles, user_permissions, role_permissions, platform_member_group_members,
      spreadsheet_permissions, field_permissions, record_permissions, meta_bases, meta_sheets, meta_fields`)
    await admin.query(`INSERT INTO users VALUES ($1,'user','[]',true),($2,'user','[]',true)`,
      [scope.actorId, foreignActorId])
    await admin.query('INSERT INTO meta_bases (id) VALUES ($1)', [scope.baseId])
    await admin.query('INSERT INTO meta_sheets (id,base_id) VALUES ($1,$2)', [scope.sheetId, scope.baseId])
    for (const fieldId of scope.fieldIds) {
      await admin.query(`INSERT INTO meta_fields VALUES ($1,$2,'string','{}')`, [fieldId, scope.sheetId])
    }
    await globalRead(true)
  })

  it('reads fresh actual global permission and returns a frozen finite projection without reading records', async () => {
    const locked = await capture()
    expect(locked).toMatchObject({ actorId: scope.actorId, baseId: scope.baseId, sheetId: scope.sheetId,
      fieldIds: [...scope.fieldIds].sort() })
    expect(locked.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(locked)).toBe(true)
    expect(Object.isFrozen(locked.fieldIds)).toBe(true)
    expect(locked).not.toHaveProperty('tenantId')
    expect(queries.some(sql => /FROM user_permissions/.test(sql))).toBe(true)
    expect(queries.some(sql => /FROM field_permissions/.test(sql))).toBe(true)
    expect(queries.some(sql => /\b(?:FROM|JOIN)\s+(?:meta_records|record_permissions)\b/i.test(sql))).toBe(false)
    expect((await admin.query("SELECT to_regclass('meta_records') AS records")).rows[0].records).toBeNull()
    await globalRead(false)
    await denied()
    await globalRead(true)
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId })
  })

  it('resolves current role-derived and legacy global read grants without JWT/cache substitutes', async () => {
    await globalRead(false)
    await admin.query('INSERT INTO user_roles VALUES ($1,$2)', [scope.actorId, actorRole])
    await admin.query('INSERT INTO role_permissions VALUES ($1,$2)', [actorRole, 'multitable:read'])
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId })
    await admin.query('DELETE FROM role_permissions')
    await denied()
    await admin.query(`UPDATE users SET permissions = '["multitable:read"]'`)
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId })
  })

  it('does not adopt a foreign user direct global read grant when the owner has none', async () => {
    await globalRead(false)
    await admin.query('INSERT INTO user_permissions VALUES ($1,$2)', [foreignActorId, 'multitable:read'])
    await denied()
  })

  it('does not adopt a foreign user role global read grant when the owner is outside that role', async () => {
    await globalRead(false)
    await admin.query('INSERT INTO user_roles VALUES ($1,$2)', [foreignActorId, actorRole])
    await admin.query('INSERT INTO role_permissions VALUES ($1,$2)', [actorRole, 'multitable:read'])
    await denied()
  })

  it.each(['user', 'member-group', 'role'])('does not adopt a foreign %s sheet grant when the owner has no read authority', async subjectType => {
    await globalRead(false)
    let subjectId = foreignActorId
    if (subjectType === 'member-group') {
      subjectId = actorGroup
      await admin.query('INSERT INTO platform_member_group_members VALUES ($1,$2)', [foreignActorId, actorGroup])
    } else if (subjectType === 'role') {
      subjectId = actorRole
      await admin.query('INSERT INTO user_roles VALUES ($1,$2)', [foreignActorId, actorRole])
    }
    // This is the only sheet assignment; no own/global grant can mask a missing
    // subject or membership-user predicate in the real permission query.
    await admin.query('INSERT INTO spreadsheet_permissions VALUES ($1,$2,$3,$4)',
      [scope.sheetId, subjectType, subjectId, 'spreadsheet:read'])
    await denied()
  })

  it.each(['user', 'member-group', 'role'])('resolves a real %s sheet read grant without a global grant', async subjectType => {
    await globalRead(false)
    let subjectId = scope.actorId
    if (subjectType === 'member-group') {
      subjectId = actorGroup
      await admin.query('INSERT INTO platform_member_group_members VALUES ($1,$2)', [scope.actorId, actorGroup])
    } else if (subjectType === 'role') {
      subjectId = actorRole
      await admin.query('INSERT INTO user_roles VALUES ($1,$2)', [scope.actorId, actorRole])
    }
    await admin.query('INSERT INTO spreadsheet_permissions VALUES ($1,$2,$3,$4)',
      [scope.sheetId, subjectType, subjectId, 'spreadsheet:read'])
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId })
    await admin.query('DELETE FROM spreadsheet_permissions')
    await denied()
  })

  it.each(['user', 'member-group', 'role'])('rejects an actual %s field deny, including when a competing allow exists', async subjectType => {
    let subjectId = scope.actorId
    if (subjectType === 'member-group') {
      subjectId = actorGroup
      await admin.query('INSERT INTO platform_member_group_members VALUES ($1,$2)', [scope.actorId, actorGroup])
    } else if (subjectType === 'role') {
      subjectId = actorRole
      await admin.query('INSERT INTO user_roles VALUES ($1,$2)', [scope.actorId, actorRole])
    }
    await admin.query(`INSERT INTO field_permissions VALUES ($1,$2,'user',$3,true,false)`,
      [scope.sheetId, scope.fieldIds[0], scope.actorId])
    await fieldDeny(subjectType, subjectId)
    await denied()
  })

  it('does not apply a foreign user direct field deny to the owner', async () => {
    await fieldDeny('user', foreignActorId)
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId, fieldIds: [...scope.fieldIds].sort() })
  })

  it.each(['member-group', 'role'])('applies a %s field deny only after the owner joins, despite existing foreign membership', async subjectType => {
    const subjectId = subjectType === 'member-group' ? actorGroup : actorRole
    const membershipTable = subjectType === 'member-group' ? 'platform_member_group_members' : 'user_roles'
    await fieldDeny(subjectType, subjectId)
    await admin.query(`INSERT INTO ${membershipTable} VALUES ($1,$2)`, [foreignActorId, subjectId])
    // The exact denied group/role already has another user: removing its user_id
    // predicate must fail this positive half, not merely leave an empty subquery.
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId, fieldIds: [...scope.fieldIds].sort() })
    await admin.query(`INSERT INTO ${membershipTable} VALUES ($1,$2)`, [scope.actorId, subjectId])
    await denied()
  })

  it.each([{ hidden: true }, { visible: false }])('rejects required metadata-hidden fields even for current normalized admin: %j', async property => {
    await setAdmin()
    await admin.query('UPDATE meta_fields SET property = $1::jsonb WHERE id = $2', [JSON.stringify(property), scope.fieldIds[0]])
    await denied()
  })

  it('rejects a required ACL-hidden field even for current normalized admin', async () => {
    await setAdmin()
    await fieldDeny()
    await denied()
  })

  it('allows read-only stored fields but rejects an entirely missing actor despite a surviving sheet grant', async () => {
    await admin.query(`UPDATE meta_fields SET property = '{"readOnly":true}'`)
    await admin.query(`INSERT INTO field_permissions VALUES ($1,$2,'user',$3,true,true)`,
      [scope.sheetId, scope.fieldIds[0], scope.actorId])
    await expect(capture()).resolves.toMatchObject({ fieldIds: [...scope.fieldIds].sort() })
    await admin.query('INSERT INTO spreadsheet_permissions VALUES ($1,$2,$3,$4)',
      [scope.sheetId, 'user', scope.actorId, 'spreadsheet:read'])
    await admin.query('DELETE FROM users')
    await denied()
  })

  it.each([
    ['no record denies or conditional rules', false, false],
    ['conditional rules only', true, false],
    ['explicit record deny', false, true],
  ] as const)('rejects row-read flag ON for non-admin with %s, without a denied-record oracle', async (_label, conditional, recordDeny) => {
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $1::jsonb',
      [JSON.stringify(conditional ? conditionalRules : [])])
    if (recordDeny) await admin.query('INSERT INTO record_permissions VALUES ($1,$2,$3,$4,$5)',
      [scope.sheetId, 'synthetic-record', 'user', scope.actorId, 'none'])
    await denied()
    expect(queries.some(sql => /\b(?:FROM|JOIN)\s+(?:meta_records|record_permissions)\b/i.test(sql))).toBe(false)
  })

  it('honors actual current admin row-policy bypass, and revocation immediately restores refusal', async () => {
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $1::jsonb',
      [JSON.stringify(conditionalRules)])
    await denied()
    await setAdmin()
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId })
    await admin.query('DELETE FROM user_roles WHERE role_id = $1', ['admin'])
    await denied()
  })

  it.each(acls)('fails closed with missing authority table %s before compatibility loaders can degrade', async table => {
    await admin.query(`ALTER TABLE ${table} RENAME TO ${table}_missing`)
    try {
      await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
    } finally { await admin.query(`ALTER TABLE ${table}_missing RENAME TO ${table}`) }
  })

  it('fails closed on missing or null row-policy flag', async () => {
    await admin.query('ALTER TABLE meta_sheets RENAME COLUMN row_level_read_permissions_enabled TO flag_missing')
    try {
      await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
    } finally { await admin.query('ALTER TABLE meta_sheets RENAME COLUMN flag_missing TO row_level_read_permissions_enabled') }
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled = NULL')
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
  })

  it('does not swallow a real permission-query schema failure after the authority table lock succeeds', async () => {
    await admin.query('ALTER TABLE field_permissions RENAME COLUMN visible TO visible_missing')
    try {
      await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
    } finally { await admin.query('ALTER TABLE field_permissions RENAME COLUMN visible_missing TO visible') }
  })

  const scopeEdits = [
    ['deleted base', 'UPDATE meta_bases SET deleted_at = now()'],
    ['missing base', 'DELETE FROM meta_bases'],
    ['deleted sheet', 'UPDATE meta_sheets SET deleted_at = now()'],
    ['missing sheet', 'DELETE FROM meta_sheets'],
    ['moved sheet', "UPDATE meta_sheets SET base_id = 'different-base'"],
    ['missing required field', "DELETE FROM meta_fields WHERE id = 'synthetic-field-b'"],
    ['moved required field', "UPDATE meta_fields SET sheet_id = 'different-sheet' WHERE id = 'synthetic-field-b'"],
    ['inactive actor', 'UPDATE users SET is_active = false'],
    ['disabled actor', "UPDATE users SET role = 'disabled'"],
  ] as const
  it.each(scopeEdits)('rejects committed %s', async (_label, sql) => {
    await admin.query(sql)
    await denied()
  })

  it.each(['formula', 'lookup', 'rollup', 'link', 'synthetic-plugin-type'])('rejects transitive or unknown field type %s', async type => {
    await admin.query('UPDATE meta_fields SET type = $1 WHERE id = $2', [type, scope.fieldIds[0]])
    await denied()
  })

  it.each([{ mirrorOf: 'synthetic-source-field' }, { mirrorOf: null }, { mirrorOf: '' }])('rejects raw mirror metadata %j', async property => {
    await admin.query('UPDATE meta_fields SET property = $1::jsonb WHERE id = $2', [JSON.stringify(property), scope.fieldIds[0]])
    await denied()
  })

  it('fingerprints stored field metadata changes and normalizes only the expected field ordering', async () => {
    const first = await capture()
    expect((await capture({ ...scope, fieldIds: [...scope.fieldIds].reverse() })).fingerprint).toBe(first.fingerprint)
    await admin.query(`UPDATE meta_fields SET property = '{"readOnly":true}' WHERE id = $1`, [scope.fieldIds[0]])
    expect((await capture()).fingerprint).not.toBe(first.fingerprint)
  })

  it('rejects real autocommit and a forged transaction marker before taking locks', async () => {
    await expect(lockAutomationReadTarget(reader, scope)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_TRANSACTION_REQUIRED' })
    const forged = { query: reader.query.bind(reader), isTransaction: true as const }
    await expect(lockAutomationReadTarget(forged, scope)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_TRANSACTION_REQUIRED' })
  })

  it.each(['REPEATABLE READ', 'SERIALIZABLE', 'READ UNCOMMITTED'])('rejects real %s isolation', async isolation => {
    await reader.query(`BEGIN ISOLATION LEVEL ${isolation}`)
    try {
      await expect(lockAutomationReadTarget(reader, scope)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_TRANSACTION_REQUIRED' })
    } finally { await reader.query('ROLLBACK') }
  })

  it('holds actual SHARE relation locks on all eight authority tables, including an empty record ACL table', async () => {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      await lockAutomationReadTarget(reader, scope)
      const locks = await observer.query(`SELECT c.relname FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE l.pid = $1 AND l.mode = 'ShareLock' AND l.granted AND n.nspname = $2`, [await pid(reader), schema])
      expect(locks.rows.map(row => row.relname).sort()).toEqual([...acls].sort())
    } finally { await reader.query('ROLLBACK') }
  })

  it('blocks a new field-deny INSERT until commit, then the next proof rejects', async () => {
    await proveBlocked(`INSERT INTO field_permissions VALUES ($1,$2,'user',$3,false,false)`,
      [scope.sheetId, scope.fieldIds[0], scope.actorId])
    await denied()
  })

  it('blocks an INSERT activating group-deny membership until commit, then rejects', async () => {
    await fieldDeny('member-group', actorGroup)
    await proveBlocked('INSERT INTO platform_member_group_members VALUES ($1,$2)', [scope.actorId, actorGroup])
    await denied()
  })

  it('blocks deletion of the membership supplying the only sheet read grant, then rejects', async () => {
    await globalRead(false)
    await admin.query('INSERT INTO platform_member_group_members VALUES ($1,$2)', [scope.actorId, actorGroup])
    await admin.query('INSERT INTO spreadsheet_permissions VALUES ($1,$2,$3,$4)',
      [scope.sheetId, 'member-group', actorGroup, 'spreadsheet:read'])
    await proveBlocked('DELETE FROM platform_member_group_members WHERE user_id = $1', [scope.actorId])
    await denied()
  })

  it('blocks a new subject role membership that would activate a field deny, then rejects', async () => {
    await fieldDeny('role', actorRole)
    await proveBlocked('INSERT INTO user_roles VALUES ($1,$2)', [scope.actorId, actorRole])
    await denied()
  })

  it('blocks normalized admin role INSERT and derives the new bypass only after commit', async () => {
    await proveBlocked('INSERT INTO user_roles VALUES ($1,$2)', [scope.actorId, 'admin'])
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled = true')
    await expect(capture()).resolves.toMatchObject({ actorId: scope.actorId })
  })

  it('blocks a new record deny INSERT even while the flag is OFF and record ACLs are empty', async () => {
    await proveBlocked('INSERT INTO record_permissions VALUES ($1,$2,$3,$4,$5)',
      [scope.sheetId, 'synthetic-record', 'user', scope.actorId, 'none'])
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled = true')
    await denied()
  })

  it.each(acls)('rejects NOWAIT when %s already has a conflicting writer relation lock', async table => {
    await writer.query('BEGIN')
    await writer.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`)
    try {
      const started = Date.now()
      try {
        await capture()
        expect.fail('Busy authority must reject')
      } catch (error) {
        expect(error).toBeInstanceOf(AutomationTargetAuthorityError)
        expect(error).toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE', message: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
        expect(error).not.toHaveProperty('cause')
        expect(Date.now() - started).toBeLessThan(2000)
      }
    } finally { await writer.query('ROLLBACK') }
  })

  const metadataRows = [
    ['base', 'meta_bases', scope.baseId, 'deleted_at = now()'],
    ['sheet', 'meta_sheets', scope.sheetId, 'deleted_at = now()'],
    ['field', 'meta_fields', scope.fieldIds[0], `property = '{"hidden":true}'::jsonb`],
  ] as const
  it.each(metadataRows)('rejects NOWAIT for a held %s mutation', async (_label, table, id, edit) => {
    await writer.query('BEGIN')
    await writer.query(`UPDATE ${table} SET ${edit} WHERE id = $1`, [id])
    try {
      const started = Date.now()
      await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
      expect(Date.now() - started).toBeLessThan(2000)
    } finally { await writer.query('ROLLBACK') }
  })

  const metadataMutations = metadataRows.flatMap(([label, table, id, edit]) => [
    [`${label} update`, `UPDATE ${table} SET ${edit} WHERE id = $1`, id],
    [`${label} delete`, `DELETE FROM ${table} WHERE id = $1`, id],
  ])
  it.each(metadataMutations)('blocks %s through the actual row locks until commit', async (_label, statement, id) => {
    await proveBlocked(statement, [id])
    await denied()
  })

  it('blocks row-read flag activation until commit, then rejects completeness', async () => {
    await proveBlocked('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [scope.sheetId])
    await denied()
  })

  it.each(['person', 'user', 'link'])('condition fields accept stored %s IDs without widening the original target projection', async type => {
    await admin.query('UPDATE meta_fields SET type=$1', [type])
    const result = await captureConditions()
    expect(result).toMatchObject({ actorId: scope.actorId, baseId: scope.baseId, sheetId: scope.sheetId,
      fieldIds: [...scope.fieldIds].sort(), fields: [...scope.fieldIds].sort().map(id => ({ id, type, propertyJson: '{}' })) })
    expect(Object.keys(result).sort()).toEqual(['actorId', 'baseId', 'fieldIds', 'fields', 'fingerprint', 'sheetId'])
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.fields)).toBe(true)
    expect(result.fields.every(field => Object.isFrozen(field) && Object.keys(field).sort().join(',') === 'id,propertyJson,type')).toBe(true)
    expect(queries.some(sql => /\b(?:FROM|JOIN)\s+(?:meta_records|meta_links|record_permissions)\b/iu.test(sql))).toBe(false)
    expect((await admin.query("SELECT to_regclass('meta_records') AS records")).rows[0].records).toBeNull()
    await denied()
    await admin.query("UPDATE meta_fields SET type='string'")
    const target = await capture()
    expect(Object.keys(target).sort()).toEqual(['actorId', 'baseId', 'fieldIds', 'fingerprint', 'sheetId'])
  })

  it.each([{ hidden: true }, { visible: false }])('condition field metadata-hidden %j still rejects a current admin', async property => {
    await setAdmin()
    await admin.query('UPDATE meta_fields SET type=$1,property=$2::jsonb WHERE id=$3', ['person', JSON.stringify(property), scope.fieldIds[0]])
    await conditionsDenied()
  })

  it.each(['user', 'member-group', 'role'])('condition fields obey a current %s deny despite another allow', async subjectType => {
    await admin.query("UPDATE meta_fields SET type='link'")
    let subjectId = scope.actorId
    if (subjectType === 'member-group') {
      subjectId = actorGroup
      await admin.query('INSERT INTO platform_member_group_members VALUES ($1,$2)', [scope.actorId, actorGroup])
    } else if (subjectType === 'role') {
      subjectId = actorRole
      await admin.query('INSERT INTO user_roles VALUES ($1,$2)', [scope.actorId, actorRole])
    }
    await admin.query(`INSERT INTO field_permissions VALUES ($1,$2,'user',$3,true,false)`,
      [scope.sheetId, scope.fieldIds[0], scope.actorId])
    await fieldDeny(subjectType, subjectId)
    await conditionsDenied()
  })

  it('condition field ACL hidden still rejects admin while read-only alone remains readable', async () => {
    await setAdmin()
    await admin.query(`UPDATE meta_fields SET type='user',property='{"readOnly":true}'::jsonb`)
    await admin.query(`INSERT INTO field_permissions VALUES ($1,$2,'user',$3,true,true)`,
      [scope.sheetId, scope.fieldIds[0], scope.actorId])
    await expect(captureConditions()).resolves.toMatchObject({ fieldIds: [...scope.fieldIds].sort() })
    await fieldDeny()
    await conditionsDenied()
  })

  it.each([
    ['empty policy', false, false], ['conditional policy', true, false], ['record deny', false, true],
  ] as const)('condition fields reject non-admin row-read ON with %s without querying records', async (_label, conditional, recordDeny) => {
    await admin.query("UPDATE meta_fields SET type='person'")
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled=true,conditional_read_rules=$1::jsonb',
      [JSON.stringify(conditional ? conditionalRules : [])])
    if (recordDeny) await admin.query('INSERT INTO record_permissions VALUES ($1,$2,$3,$4,$5)',
      [scope.sheetId, 'synthetic-record', 'user', scope.actorId, 'none'])
    await conditionsDenied()
    expect(queries.some(sql => /\b(?:FROM|JOIN)\s+(?:meta_records|record_permissions)\b/iu.test(sql))).toBe(false)
  })

  it('condition fields use current admin row-policy bypass and reject immediately after its revocation', async () => {
    await admin.query("UPDATE meta_fields SET type='person'")
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled=true')
    await setAdmin()
    await expect(captureConditions()).resolves.toMatchObject({ actorId: scope.actorId })
    await admin.query("DELETE FROM user_roles WHERE role_id='admin'")
    await conditionsDenied()
  })

  it.each(['formula', 'lookup', 'rollup', 'attachment', 'synthetic-plugin-type'])('condition fields refuse non-stored or unsupported type %s', async type => {
    await admin.query('UPDATE meta_fields SET type=$1 WHERE id=$2', [type, scope.fieldIds[0]])
    await conditionsDenied()
  })

  it.each([{ mirrorOf: 'synthetic-source-field' }, { mirrorOf: null }, { mirrorOf: '' }])('condition link field rejects any own mirror metadata %j', async property => {
    await admin.query('UPDATE meta_fields SET type=$1,property=$2::jsonb WHERE id=$3', ['link', JSON.stringify(property), scope.fieldIds[0]])
    await conditionsDenied()
  })

  it('condition fields re-read global grants on every transaction instead of retaining a previous proof', async () => {
    await admin.query("UPDATE meta_fields SET type='user'")
    await expect(captureConditions()).resolves.toMatchObject({ actorId: scope.actorId })
    await globalRead(false)
    await conditionsDenied()
    await globalRead(true)
    await expect(captureConditions()).resolves.toMatchObject({ actorId: scope.actorId })
  })

  it.each(acls)('condition fields fail closed for missing authority table %s', async table => {
    await admin.query(`ALTER TABLE ${table} RENAME TO ${table}_missing`)
    try {
      await expect(captureConditions()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
    } finally { await admin.query(`ALTER TABLE ${table}_missing RENAME TO ${table}`) }
  })

  it('condition field permission-query failure stays sticky after the table lock succeeded', async () => {
    await admin.query('ALTER TABLE field_permissions RENAME COLUMN visible TO visible_missing')
    try {
      await expect(captureConditions()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
    } finally { await admin.query('ALTER TABLE field_permissions RENAME COLUMN visible_missing TO visible') }
  })

  it('condition field proof blocks a new real deny INSERT until commit, then the next proof refuses', async () => {
    await admin.query("UPDATE meta_fields SET type='link'")
    await proveBlocked(`INSERT INTO field_permissions VALUES ($1,$2,'user',$3,false,false)`,
      [scope.sheetId, scope.fieldIds[0], scope.actorId], lockAutomationReadConditionFields)
    await conditionsDenied()
  })

  it('condition raw property SQL admits exactly 65536 bytes and rejects larger text before driver transfer', async () => {
    await admin.query(`UPDATE meta_fields SET property=jsonb_build_object('padding',
      repeat('x',65536-octet_length(jsonb_build_object('padding','')::text))) WHERE id=$1`, [scope.fieldIds[0]])
    const result = await captureConditions()
    const field = result.fields.find(candidate => candidate.id === scope.fieldIds[0])
    expect(field).toBeDefined()
    expect(Buffer.byteLength(field?.propertyJson ?? '', 'utf8')).toBe(65536)
    expect(conditionProjectionOverflow).toBe(false)
    expect(conditionProjectionFacts).toContainEqual({ textNull: false, bytes: 65536, oversized: false })
    await admin.query(`UPDATE meta_fields SET property=jsonb_build_object('padding',property->>'padding' || 'x') WHERE id=$1`, [scope.fieldIds[0]])
    await conditionsDenied()
    expect(conditionProjectionOverflow).toBe(false)
    // Final refusal alone cannot prove the SQL transport bound: removing CASE must fail this check.
    expect(conditionProjectionFacts).toContainEqual({ textNull: true, bytes: null, oversized: true })
  })

  it('condition property text preserves exact PG numeric literals and fingerprints changes lost by JS JSONB parsing', async () => {
    await admin.query(`UPDATE meta_fields SET type='select',property=
      '{"options":[{"value":9007199254740993}],"decimal":0.12345678901234567890123456789}'::jsonb WHERE id=$1`, [scope.fieldIds[0]])
    const first = await captureConditions()
    const raw = (await admin.query('SELECT property::text AS raw FROM meta_fields WHERE id=$1', [scope.fieldIds[0]])).rows[0].raw
    const field = first.fields.find(candidate => candidate.id === scope.fieldIds[0])
    expect(field?.propertyJson).toBe(raw)
    expect(field?.propertyJson).toContain('9007199254740993')
    expect(field?.propertyJson).toContain('0.12345678901234567890123456789')
    await admin.query(`UPDATE meta_fields SET property=jsonb_set(property,'{options,0,value}','9007199254740992'::jsonb) WHERE id=$1`, [scope.fieldIds[0]])
    expect((await captureConditions()).fingerprint).not.toBe(first.fingerprint)
  })

  it('condition field NULL properties normalize to an empty object without a mutable property escape', async () => {
    await admin.query('UPDATE meta_fields SET property=NULL WHERE id=$1', [scope.fieldIds[0]])
    await admin.query("UPDATE meta_fields SET property='null'::jsonb WHERE id=$1", [scope.fieldIds[1]])
    const result = await captureConditions()
    expect(result.fields.every(field => field.propertyJson === '{}' && !Object.hasOwn(field, 'property'))).toBe(true)
  })
})
