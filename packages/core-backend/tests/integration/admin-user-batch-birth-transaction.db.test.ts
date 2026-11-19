import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  service: undefined as unknown,
  active: 0,
  pids: [] as number[],
  commits: 0,
  afterSql: undefined as undefined | ((sql: string, pid: number, client: { query: (sql: string) => Promise<unknown> }) => Promise<void>),
}))

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  return { ...actual, poolManager: { get: () => {
    const service = (state.service ??= new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 4, name: 'batch-birth-db' })) as InstanceType<typeof actual.ConnectionPool>
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
                const result = await client.query(sql, params)
                await state.afterSql?.(sql, pid, client)
                return result
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

import { createAdminBatchUserCommand } from '../../src/admin/admin-user-batch-birth-command'
import { normalizeLoginIdentifier } from '../../src/auth/login-identifier'
import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { AUTHORIZATION_INPUT_STATEMENTS } from '../../src/rbac/authorization-input-lock'

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1' && !databaseUrl) throw new Error('BATCH_BIRTH_DATABASE_REQUIRED')
const describeDatabase = databaseUrl ? describe : describe.skip

function outcome<Result>(promise: Promise<Result>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}

describeDatabase('batch user BIRTH command on actual PostgreSQL', () => {
  let observer: PgPool
  const userIds: string[] = []
  const roleIds: string[] = []
  const controls: Array<() => Promise<void>> = []
  const releases: Array<() => void> = []

  beforeAll(async () => {
    observer = new PgPool({ connectionString: databaseUrl, max: 5 })
    await observer.query('SELECT 1')
  })
  beforeEach(() => {
    expect(state.active).toBe(0)
    state.pids = []
    state.commits = 0
    state.afterSql = undefined
  })
  afterEach(async () => {
    state.afterSql = undefined
    for (const release of releases.splice(0)) release()
    for (const close of controls.splice(0)) await close()
    await until(() => state.active === 0, 'BATCH_BIRTH_TRANSACTION_NOT_SETTLED')
    if (roleIds.length > 0) await observer.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [roleIds])
    for (const table of ['user_login_aliases', 'user_namespace_admissions', 'user_roles']) {
      await observer.query(`DELETE FROM ${table} WHERE user_id = ANY($1::text[])`, [userIds])
    }
    await observer.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
    await observer.query('DELETE FROM roles WHERE id = ANY($1::text[])', [roleIds])
    userIds.length = 0
    roleIds.length = 0
  })
  afterAll(async () => {
    if (state.service) await (state.service as ConnectionPool).getInternalPool().end()
    await observer?.end()
  })

  async function until(check: () => boolean | Promise<boolean>, message: string) {
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(message)
  }
  function gate() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    releases.push(resolve)
    return { promise, release: resolve }
  }
  async function control() {
    const client = await observer.connect()
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '5s'")
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await client.query('ROLLBACK')
      client.release()
    }
    controls.push(close)
    return { client, pid: Number((client as PoolClient & { processID: number }).processID), close }
  }
  async function blocked(waiter: number, holder: number) {
    await until(async () => (await observer.query(
      "SELECT wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1",
      [waiter, holder],
    )).rows[0]?.blocked === true, 'EXPECTED_NATIVE_BIRTH_LOCK_WAIT')
  }
  async function fixture(authority: 'raw' | 'member' = 'raw', selectedRole = true, label = 'batch-birth') {
    const actorId = `${label}-actor-${randomUUID()}`
    const userId = `${label}-target-${randomUUID()}`
    const roleId = selectedRole ? `${label}-role-${randomUUID()}` : null
    userIds.push(actorId, userId)
    await observer.query(
      `INSERT INTO users (id, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $1, 'Synthetic birth actor', 'synthetic-unused', $2, '[]'::jsonb, true, false, 'activated')`,
      [actorId, authority === 'raw' ? 'admin' : 'user'],
    )
    if (authority === 'member') await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    if (roleId) {
      roleIds.push(roleId)
      await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
    }
    return { actorId, userId, roleId, email: `${userId}@example.invalid`, name: 'Synthetic birth target', department: null, passwordHash: 'synthetic-unused' }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function counts(input: Fixture) {
    return (await observer.query(
      `SELECT (SELECT count(*)::int FROM users WHERE id=$1) AS users,
       (SELECT count(*)::int FROM user_login_aliases WHERE user_id=$1) AS aliases,
       (SELECT count(*)::int FROM user_roles WHERE user_id=$1) AS roles,
       (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id=$1) AS admissions`,
      [input.userId],
    )).rows[0]
  }
  async function expectEmpty(input: Fixture) {
    expect(await counts(input)).toEqual({ users: 0, aliases: 0, roles: 0, admissions: 0 })
    expect(state.commits).toBe(0)
  }
  async function expectBorn(input: Fixture) {
    expect(await counts(input)).toEqual({ users: 1, aliases: 1, roles: input.roleId ? 1 : 0, admissions: 1 })
    expect((await observer.query(
      `SELECT username, mobile, employee_no, position, hire_date, permissions, must_change_password,
       is_active, is_admin, activation_status, local_password_set, role, created_at = updated_at AS same_time
       FROM users WHERE id=$1`, [input.userId],
    )).rows).toEqual([{
      username: null, mobile: null, employee_no: null, position: null, hire_date: null, permissions: [],
      must_change_password: true, is_active: true, is_admin: false, activation_status: 'activated',
      local_password_set: true, role: input.roleId ?? 'user', same_time: true,
    }])
    expect((await observer.query('SELECT namespace, enabled, source, updated_by FROM user_namespace_admissions WHERE user_id=$1', [input.userId])).rows)
      .toEqual([{ namespace: 'attendance', enabled: false, source: 'admin_batch_create', updated_by: input.actorId }])
  }

  async function columnNames(table: string) {
    const names = (await observer.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    )).rows.map(row => String(row.column_name))
    if (names.length === 0 || names.some(name => !/^[a-z_][a-z0-9_]*$/.test(name))) {
      throw new Error(`BATCH_BIRTH_COLUMNS_UNREADABLE:${table}`)
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
    if (!names.includes(key) || !names.includes(order)) throw new Error(`BATCH_BIRTH_COLUMNS_UNREADABLE:${table}`)
    const listed = names.map(name => `"${name}"`).join(', ')
    const rows = (await observer.query(
      `SELECT ${listed} FROM ${table} WHERE "${key}" = $1 ORDER BY "${order}"`,
      [id],
    )).rows as Array<Record<string, unknown>>
    return rows.map(row => normalizeRow(names, row))
  }
  async function contentPermissionCode() {
    const found = (await observer.query(
      `SELECT code FROM permissions
        WHERE code IN ('attendance:read', 'demo:read', 'spreadsheet:read', 'test:read')
        ORDER BY code
        LIMIT 1`,
    )).rows as Array<{ code?: unknown }>
    const code = found[0]?.code
    if (found.length !== 1 || typeof code !== 'string' || code.length === 0) throw new Error('BATCH_BIRTH_PERMISSION_CODE_REQUIRED')
    return code
  }
  async function neighbor(code: string) {
    const userId = `batch-birth-neighbor-user-${randomUUID()}`
    const roleId = `batch-birth-neighbor-role-${randomUUID()}`
    const email = `${userId}@example.invalid`
    userIds.push(userId)
    roleIds.push(roleId)
    await observer.query(
      `INSERT INTO users (id, username, email, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $1, $2, 'Synthetic birth neighbor', 'synthetic-unused', 'user', '[]'::jsonb, true, false, 'activated')`,
      [userId, email],
    )
    await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
    await observer.query(
      "INSERT INTO user_login_aliases (user_id, kind, normalized_value, source) VALUES ($1, 'email', $2, 'synthetic')",
      [userId, email],
    )
    await observer.query(
      `INSERT INTO user_namespace_admissions
         (user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at)
       VALUES ($1, 'batch-birth-neighbor', true, 'synthetic', NULL, $1, NOW(), NOW())`,
      [userId],
    )
    await observer.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, code])
    return { userId, roleId, email }
  }
  async function neighborFacts(owned: { userId: string; roleId: string }) {
    return {
      user: await scopedRows('users', 'id', owned.userId, 'id'),
      alias: await scopedRows('user_login_aliases', 'user_id', owned.userId, 'normalized_value'),
      admission: await scopedRows('user_namespace_admissions', 'user_id', owned.userId, 'namespace'),
      membership: await scopedRows('user_roles', 'user_id', owned.userId, 'role_id'),
      role: await scopedRows('roles', 'id', owned.roleId, 'id'),
      permissions: await scopedRows('role_permissions', 'role_id', owned.roleId, 'permission_code'),
    }
  }
  function requireRole(input: Fixture) {
    if (!input.roleId) throw new Error('BATCH_BIRTH_ROLE_REQUIRED')
    return input.roleId
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
      if (!(key in row)) throw new Error(`BATCH_BIRTH_COLUMN_MISSING:${key}`)
    }
    if ('created_at' in row && 'updated_at' in row) expect(row.created_at).toEqual(row.updated_at)
  }
  async function expectPersistedBirth(input: Fixture, shape: { membership: boolean; rolePresent: boolean; permissionCode: string | null }) {
    expect(await counts(input)).toEqual({
      users: 1, aliases: 1, roles: shape.membership ? 1 : 0, admissions: 1,
    })
    const users = await scopedRows('users', 'id', input.userId, 'id')
    expect(users).toHaveLength(1)
    const actorInputMigration = await observer.query(
      'SELECT name FROM kysely_migration WHERE name = $1',
      ['zzzz20261118090000_admin_grant_actor_inputs'],
    )
    const hasActorInputs = actorInputMigration.rows.length === 1
    expect('local_credential_version' in users[0]).toBe(hasActorInputs)
    const required = ['id', 'email', 'username', 'name', 'mobile', 'employee_no', 'department', 'position', 'hire_date', 'password_hash', 'must_change_password', 'role', 'permissions', 'is_active', 'is_admin', 'activation_status', 'local_password_set', 'access_generation', 'created_at', 'updated_at']
    for (const name of required) {
      if (!(name in users[0])) throw new Error(`BATCH_BIRTH_USER_COLUMN_MISSING:${name}`)
    }
    expectBusinessRow(users[0], {
      id: input.userId,
      email: input.email,
      username: null,
      name: input.name,
      mobile: null,
      employee_no: null,
      department: input.department,
      position: null,
      hire_date: null,
      password_hash: input.passwordHash,
      must_change_password: true,
      role: input.roleId ?? 'user',
      permissions: [],
      is_active: true,
      is_admin: false,
      activation_status: 'activated',
      local_password_set: true,
      // The actor-input migration generates the credential version whenever that schema is installed.
      ...(hasActorInputs && {
        local_credential_version: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      }),
      access_generation: '0',
    })
    const aliases = await scopedRows('user_login_aliases', 'user_id', input.userId, 'normalized_value')
    const normalized = normalizeLoginIdentifier(input.email)
    if (!normalized) throw new Error('BATCH_BIRTH_ALIAS_REQUIRED')
    expect(aliases).toHaveLength(1)
    expectBusinessRow(aliases[0], {
      user_id: input.userId,
      kind: 'email',
      normalized_value: normalized,
      source: 'admin_batch_create',
    })
    const memberships = await scopedRows('user_roles', 'user_id', input.userId, 'role_id')
    if (!shape.membership) expect(memberships).toEqual([])
    else {
      const roleId = requireRole(input)
      expect(memberships).toHaveLength(1)
      expectBusinessRow(memberships[0], { user_id: input.userId, role_id: roleId, assignment_source: 'creation' })
    }
    const admissions = await scopedRows('user_namespace_admissions', 'user_id', input.userId, 'namespace')
    expect(admissions).toHaveLength(1)
    expectBusinessRow(admissions[0], {
      user_id: input.userId,
      namespace: 'attendance',
      enabled: false,
      source: 'admin_batch_create',
      granted_by: null,
      updated_by: input.actorId,
    })
    const roleId = input.roleId
    if (roleId && shape.rolePresent) {
      const roles = await scopedRows('roles', 'id', roleId, 'id')
      expect(roles).toHaveLength(1)
      expectBusinessRow(roles[0], { id: roleId, name: roleId, approval_usable: false })
    } else if (roleId) expect(await scopedRows('roles', 'id', roleId, 'id')).toEqual([])
    const permissions = roleId ? await scopedRows('role_permissions', 'role_id', roleId, 'permission_code') : []
    if (!shape.permissionCode) expect(permissions).toEqual([])
    else {
      expect(permissions).toHaveLength(1)
      expectBusinessRow(permissions[0], { role_id: roleId, permission_code: shape.permissionCode })
    }
  }
  function pauseOn(match: (sql: string) => boolean) {
    const paused = gate()
    let seen = false
    let pid = 0
    state.afterSql = async (sql, backend) => {
      if (seen || !match(sql)) return
      seen = true
      pid = backend
      await paused.promise
    }
    return { seen: () => seen, pid: () => pid, release: paused.release }
  }
  async function waitingQuery(pid: number) {
    const rows = (await observer.query('SELECT query FROM pg_stat_activity WHERE pid = $1', [pid])).rows as Array<{ query?: unknown }>
    return String(rows[0]?.query ?? '')
  }

  it.each(['raw', 'member'] as const)('commits all birth facts using %s actor authority', async (authority) => {
    const input = await fixture(authority)
    await createAdminBatchUserCommand(input)
    expect(state.commits).toBe(1)
    await expectBorn(input)
  })

  it('uses the database defaults and no role membership when no role was selected', async () => {
    const input = await fixture('raw', false)
    await createAdminBatchUserCommand(input)
    await expectBorn(input)
  })

  it.each(['inactive', 'pending', 'authority-lost'] as const)('refuses %s actor without any birth facts', async (condition) => {
    const input = await fixture()
    if (condition === 'inactive') await observer.query('UPDATE users SET is_active=false WHERE id=$1', [input.actorId])
    if (condition === 'pending') await observer.query("UPDATE users SET activation_status='pending_activation' WHERE id=$1", [input.actorId])
    if (condition === 'authority-lost') await observer.query("UPDATE users SET role='user', is_admin=true WHERE id=$1", [input.actorId])
    await expect(createAdminBatchUserCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expectEmpty(input)
  })

  it('rereads a raw actor revocation committed before its row lock', async () => {
    const input = await fixture()
    const holder = await control()
    await holder.client.query("UPDATE users SET role='user' WHERE id=$1", [input.actorId])
    const run = outcome(createAdminBatchUserCommand(input))
    await until(() => state.pids.length === 1, 'BIRTH_PID_NOT_OBSERVED')
    await blocked(state.pids[0], holder.pid)
    await holder.client.query('COMMIT')
    await holder.close()
    expect(await run).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await expectEmpty(input)
  }, 20_000)

  it.each(['raw', 'member'] as const)('holds %s authority through visibility and commit', async (authority) => {
    const input = await fixture(authority)
    const paused = gate()
    let reached = false
    state.afterSql = async (sql) => {
      if (!sql.includes('INSERT INTO user_namespace_admissions')) return
      reached = true
      await paused.promise
    }
    const run = outcome(createAdminBatchUserCommand(input))
    await until(() => reached, 'BIRTH_PRECOMMIT_NOT_OBSERVED')
    expect(await counts(input)).toEqual({ users: 0, aliases: 0, roles: 0, admissions: 0 })
    const revoker = await control()
    const change = outcome(authority === 'raw'
      ? revoker.client.query("UPDATE users SET role='user' WHERE id=$1", [input.actorId])
      : revoker.client.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [input.actorId]))
    await blocked(revoker.pid, state.pids[0])
    paused.release()
    expect(await run).toEqual({ ok: true, value: undefined })
    expect((await change).ok).toBe(true)
    await revoker.client.query('COMMIT')
    await revoker.close()
    await expectBorn(input)
  }, 20_000)

  it('rereads an RBAC child deleted before its positive share', async () => {
    const input = await fixture('member')
    const revoker = await control()
    await revoker.client.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [input.actorId])
    const run = outcome(createAdminBatchUserCommand(input))
    await until(() => state.pids.length === 1, 'BIRTH_PID_NOT_OBSERVED')
    await blocked(state.pids[0], revoker.pid)
    await revoker.client.query('COMMIT')
    await revoker.close()
    expect(await run).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await expectEmpty(input)
  }, 20_000)

  it('refuses a selected role deleted before its parent share', async () => {
    const input = await fixture()
    const holder = await control()
    await holder.client.query('DELETE FROM roles WHERE id=$1', [input.roleId])
    const run = outcome(createAdminBatchUserCommand(input))
    await until(() => state.pids.length === 1, 'BIRTH_PID_NOT_OBSERVED')
    await blocked(state.pids[0], holder.pid)
    await holder.client.query('COMMIT')
    await holder.close()
    expect(await run).toMatchObject({ ok: false, error: { code: 'ROLE_NOT_FOUND' } })
    await expectEmpty(input)
  }, 20_000)

  it('waits for an exclusive authorization world before creating anything', async () => {
    const input = await fixture()
    const holder = await control()
    expect((await holder.client.query(AUTHORIZATION_INPUT_STATEMENTS.worldExclusiveTry)).rows).toEqual([{ acquired: true }])
    const run = outcome(createAdminBatchUserCommand(input))
    await until(() => state.pids.length === 1, 'BIRTH_PID_NOT_OBSERVED')
    await blocked(state.pids[0], holder.pid)
    await expectEmpty(input)
    await holder.client.query('COMMIT')
    await holder.close()
    expect(await run).toEqual({ ok: true, value: undefined })
    await expectBorn(input)
  }, 20_000)

  it('rolls back the new user when an existing alias owns its email', async () => {
    const input = await fixture()
    await observer.query("INSERT INTO user_login_aliases (user_id,kind,normalized_value,source) VALUES ($1,'email',$2,'synthetic')", [input.actorId, input.email])
    expect((await outcome(createAdminBatchUserCommand(input))).ok).toBe(false)
    await expectEmpty(input)
    expect((await observer.query('SELECT user_id FROM user_login_aliases WHERE normalized_value=$1', [input.email])).rows).toEqual([{ user_id: input.actorId }])
  })

  it.each(['users', 'user_login_aliases', 'user_roles', 'user_namespace_admissions'] as const)('rolls back every birth fact after a native SQL failure following %s', async (table) => {
    const input = await fixture()
    let nativeEffect = false
    let nativeCode: unknown
    state.afterSql = async (sql, _pid, client) => {
      if (nativeEffect || !new RegExp(`INSERT INTO ${table}\\s*\\(`).test(sql)) return
      nativeEffect = true
      try { await client.query('SELECT 1 / 0') } catch (error) {
        nativeCode = (error as { code?: unknown }).code
        throw error
      }
    }
    expect(await outcome(createAdminBatchUserCommand(input))).toMatchObject({
      ok: false, error: { code: table === 'user_login_aliases' ? 'ALIAS_WRITE_FAILED' : '22012' },
    })
    expect(nativeEffect).toBe(true)
    expect(nativeCode).toBe('22012')
    await expectEmpty(input)
  })

  it.each(['writer-first', 'birth-first'] as const)('edits selected role content with a parent update lock %s', async (order) => {
    const code = await contentPermissionCode()
    const owned = await neighbor(code)
    const before = await neighborFacts(owned)
    const input = await fixture('raw', true, `batch-birth-content-${order}`)
    const roleId = requireRole(input)
    const actorBefore = await scopedRows('users', 'id', input.actorId, 'id')
    const roleBefore = await scopedRows('roles', 'id', roleId, 'id')
    const parentShare = 'FROM roles WHERE id = $1::text FOR SHARE'
    const writer = await control()
    const writeContent = () => (async () => {
      const locked = await writer.client.query(AUTHORIZATION_INPUT_STATEMENTS.roleRow, [roleId])
      const inserted = await writer.client.query(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)',
        [roleId, code],
      )
      return { locked: locked.rows, inserted: inserted.rowCount }
    })()
    let held: ReturnType<typeof pauseOn> | undefined
    let written: ReturnType<typeof writeContent> | undefined
    try {
      const empty = { users: 0, aliases: 0, roles: 0, admissions: 0 }
      if (order === 'writer-first') {
        written = writeContent()
        expect(await written).toEqual({ locked: [{ id: roleId }], inserted: 1 })
        const birth = outcome(createAdminBatchUserCommand(input))
        await until(() => state.pids.length === 1, 'BIRTH_PID_NOT_OBSERVED')
        await blocked(state.pids[0], writer.pid)
        expect(await waitingQuery(state.pids[0])).toContain(parentShare)
        expect(state.commits).toBe(0)
        expect(await counts(input)).toEqual(empty)
        expect(await scopedRows('role_permissions', 'role_id', roleId, 'permission_code')).toEqual([])
        await writer.client.query('COMMIT')
        await writer.close()
        expect(await birth).toEqual({ ok: true, value: undefined })
      } else {
        held = pauseOn(sql => sql.includes(parentShare))
        const birth = outcome(createAdminBatchUserCommand(input))
        await until(() => held?.seen() === true && state.pids.length === 1, 'BIRTH_PARENT_SHARE_NOT_OBSERVED')
        written = writeContent()
        await blocked(writer.pid, state.pids[0])
        expect(held.pid()).toBe(state.pids[0])
        expect(await waitingQuery(writer.pid)).toContain('FROM roles WHERE id = $1::text FOR UPDATE')
        expect(state.commits).toBe(0)
        expect(await counts(input)).toEqual(empty)
        expect(await scopedRows('role_permissions', 'role_id', roleId, 'permission_code')).toEqual([])
        held.release()
        expect(await birth).toEqual({ ok: true, value: undefined })
        expect(state.commits).toBe(1)
        expect(await written).toEqual({ locked: [{ id: roleId }], inserted: 1 })
        expect(await scopedRows('role_permissions', 'role_id', roleId, 'permission_code')).toEqual([])
        await writer.client.query('COMMIT')
        await writer.close()
      }
      expect(state.commits).toBe(1)
      await expectPersistedBirth(input, { membership: true, rolePresent: true, permissionCode: code })
      expect(await scopedRows('roles', 'id', roleId, 'id')).toEqual(roleBefore)
      expect(await scopedRows('users', 'id', input.actorId, 'id')).toEqual(actorBefore)
      expect(await neighborFacts(owned)).toEqual(before)
    } finally {
      held?.release()
      await written?.catch(() => undefined)
    }
  }, 20_000)

  it('deletes the selected role only after the birth that already holds its parent share', async () => {
    expect((await observer.query(
      "SELECT count(*)::int AS total FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND contype = 'f'",
    )).rows).toEqual([{ total: 0 }])
    const code = await contentPermissionCode()
    const owned = await neighbor(code)
    const before = await neighborFacts(owned)
    const input = await fixture('raw', true, 'batch-birth-role-delete')
    const roleId = requireRole(input)
    const actorBefore = await scopedRows('users', 'id', input.actorId, 'id')
    const held = pauseOn(sql => sql.includes('FROM roles WHERE id = $1::text FOR SHARE'))
    const birth = outcome(createAdminBatchUserCommand(input))
    const deleter = await control()
    let removal: ReturnType<typeof deleter.client.query> | undefined
    try {
      await until(() => held.seen() && state.pids.length === 1, 'BIRTH_PARENT_SHARE_NOT_OBSERVED')
      removal = deleter.client.query('DELETE FROM roles WHERE id = $1', [roleId])
      await blocked(deleter.pid, state.pids[0])
      expect(held.pid()).toBe(state.pids[0])
      expect(await waitingQuery(deleter.pid)).toContain('DELETE FROM roles')
      expect(state.commits).toBe(0)
      expect(await counts(input)).toEqual({ users: 0, aliases: 0, roles: 0, admissions: 0 })
      expect(await scopedRows('roles', 'id', roleId, 'id')).toHaveLength(1)
      held.release()
      expect(await birth).toEqual({ ok: true, value: undefined })
      expect(state.commits).toBe(1)
      expect((await removal).rowCount).toBe(1)
      await expectPersistedBirth(input, { membership: true, rolePresent: true, permissionCode: null })
      await deleter.client.query('COMMIT')
      await deleter.close()
      await expectPersistedBirth(input, { membership: true, rolePresent: false, permissionCode: null })
      expect(await scopedRows('users', 'id', input.actorId, 'id')).toEqual(actorBefore)
      expect(await neighborFacts(owned)).toEqual(before)
    } finally {
      held.release()
      await removal?.catch(() => undefined)
    }
  }, 20_000)

  it('commits exactly one of two births that claim the same normalized alias', async () => {
    const code = await contentPermissionCode()
    const owned = await neighbor(code)
    const before = await neighborFacts(owned)
    const winner = await fixture('raw', true, 'batch-birth-alias-winner')
    const loser = await fixture('raw', true, 'batch-birth-alias-loser')
    const token = randomUUID()
    const normalized = `batch-birth-alias-race-${token}@example.invalid`
    winner.email = `Batch-Birth-Alias-Race-${token}@Example.Invalid`
    loser.email = normalized
    expect(winner.email).not.toBe(loser.email)
    expect(normalizeLoginIdentifier(winner.email)).toBe(normalized)
    expect(normalizeLoginIdentifier(loser.email)).toBe(normalized)
    const winnerActor = await scopedRows('users', 'id', winner.actorId, 'id')
    const loserActor = await scopedRows('users', 'id', loser.actorId, 'id')
    const loserRole = await scopedRows('roles', 'id', requireRole(loser), 'id')
    const held = pauseOn(sql => sql.includes('INSERT INTO user_login_aliases'))
    const first = outcome(createAdminBatchUserCommand(winner))
    try {
      await until(() => held.seen(), 'ALIAS_CLAIM_NOT_OBSERVED')
      const second = outcome(createAdminBatchUserCommand(loser))
      await until(() => state.pids.length === 2, 'SECOND_BIRTH_PID_NOT_OBSERVED')
      const waiter = state.pids.find(pid => pid !== held.pid())
      expect(waiter).toBeGreaterThan(0)
      await blocked(waiter ?? 0, held.pid())
      expect(await waitingQuery(waiter ?? 0)).toContain('INSERT INTO user_login_aliases')
      expect(state.commits).toBe(0)
      expect(await counts(winner)).toEqual({ users: 0, aliases: 0, roles: 0, admissions: 0 })
      expect(await counts(loser)).toEqual({ users: 0, aliases: 0, roles: 0, admissions: 0 })
      expect((await observer.query('SELECT user_id FROM user_login_aliases WHERE normalized_value = $1', [normalized])).rows).toEqual([])
      held.release()
      expect(await first).toEqual({ ok: true, value: undefined })
      expect(await second).toMatchObject({ ok: false, error: { code: 'ALIAS_CONFLICT' } })
      expect(state.commits).toBe(1)
      await expectPersistedBirth(winner, { membership: true, rolePresent: true, permissionCode: null })
      expect(await counts(loser)).toEqual({ users: 0, aliases: 0, roles: 0, admissions: 0 })
      expect((await observer.query(
        'SELECT user_id, kind, normalized_value, source FROM user_login_aliases WHERE normalized_value = $1 ORDER BY user_id',
        [normalized],
      )).rows).toEqual([{ user_id: winner.userId, kind: 'email', normalized_value: normalized, source: 'admin_batch_create' }])
      expect(await scopedRows('roles', 'id', requireRole(loser), 'id')).toEqual(loserRole)
      expect(await scopedRows('users', 'id', winner.actorId, 'id')).toEqual(winnerActor)
      expect(await scopedRows('users', 'id', loser.actorId, 'id')).toEqual(loserActor)
      expect(await neighborFacts(owned)).toEqual(before)
    } finally {
      held.release()
    }
  }, 20_000)
})
