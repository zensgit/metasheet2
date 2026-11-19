import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  memberships: new Map<string, string[]>(),
  columnType: 'jsonb',
  permissions: ['attendance:read'] as unknown,
  suppressWrite: false,
  mismatchId: false,
  failSql: '',
  failError: null as Error | null,
  corruptAt: '',
  corruptKind: '' as '' | 'user' | 'admission' | 'world',
  calls: 0,
}))

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  query: vi.fn(async () => {
    throw new Error('legacy permission revoke command unit refuses a real pool query')
  }),
  entry: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      transaction: mocks.transaction,
      query: mocks.query,
      getInternalPool: () => null,
    }),
  },
}))

vi.mock('../../src/rbac/authorization-input-lock', async (original) => {
  const actual = await original<typeof import('../../src/rbac/authorization-input-lock')>()
  return {
    ...actual,
    withAuthorizationInputTransaction: (
      plan: AuthorizationInputPlan,
      work: (tx: AuthorizationInputTx) => Promise<unknown>,
      options?: unknown,
    ) => {
      mocks.entry(plan, work, options)
      return actual.withAuthorizationInputTransaction(plan, async (tx) => {
        if (!state.corruptAt) return work(tx)
        const userIds = new Set(tx.witnessed.userIds)
        const admissionUserIds = new Set(tx.witnessed.admissionUserIds)
        let current = tx
        const query = async (sql: string, params?: unknown[]) => {
          if (sql.includes(state.corruptAt)) {
            if (state.corruptKind === 'user') userIds.delete([...userIds][0] ?? 'missing')
            if (state.corruptKind === 'admission') admissionUserIds.delete([...admissionUserIds][0] ?? 'missing')
            if (state.corruptKind === 'world') (current as { world: string }).world = 'exclusive'
          }
          return tx.query(sql, params)
        }
        current = retoken(tx, { witnessed: { userIds, admissionUserIds }, query })
        return work(current)
      }, options as never)
    },
  }
})

import { writeLegacyAuthorizationException } from '../../src/admin/authorization-exception-compat'

function revokeLegacyUserPermissionCommand(input: { actorId: string; userId: string; permission: string }) {
  return writeLegacyAuthorizationException({ actorId: input.actorId, userId: input.userId, action: { kind: 'legacy.revoke', code: input.permission } })
}
import { AuthorizationInputBusyError } from '../../src/rbac/authorization-input-lock'
import { AuthorizationInputContractError } from '../../src/rbac/authorization-input-brand'
import { AccessGraphUserUnavailableError } from '../../src/directory/access-graph-mutex'
import { PlatformActorAuthorityLost } from '../../src/admin/platform-actor-authority'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

const sqlLog: string[] = []
const queries: Array<{ sql: string; params: unknown[] | undefined; rowCount: number | null; rows: Array<Record<string, unknown>> }> = []

function answer(sql: string, params: unknown[] | undefined, result: { rows: Array<Record<string, unknown>>; rowCount?: number | null }) {
  const rowCount = result.rowCount ?? null
  queries.push({ sql, params, rowCount, rows: result.rows })
  return { rows: result.rows, rowCount }
}

function permissionWrites() {
  return queries.filter((query) => query.sql.includes('SET permissions'))
}

function retoken(source: AuthorizationInputTx, patch: { witnessed: AuthorizationInputTx['witnessed']; query: AuthorizationInputTx['query'] }): AuthorizationInputTx {
  const token = { ...source, witnessed: patch.witnessed, query: patch.query }
  mintAuthorizationInputBrand(token, [token])
  return token as AuthorizationInputTx
}

function user(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    email: null,
    username: id,
    mobile: null,
    activation_status: 'activated',
    role: id === 'actor' ? 'user' : 'user',
    is_active: true,
    access_generation: 1,
    deleted_at: null,
    purged_at: null,
    ...extra,
  }
}

function planOf(): AuthorizationInputPlan {
  return mocks.entry.mock.calls.at(-1)?.[0] as AuthorizationInputPlan
}

beforeEach(() => {
  vi.clearAllMocks()
  sqlLog.length = 0
  queries.length = 0
  state.users = new Map([
    ['actor', user('actor', { role: 'user' })],
    ['target', user('target')],
  ])
  state.memberships = new Map([
    ['actor', ['admin']],
    ['target', []],
  ])
  state.columnType = 'jsonb'
  state.permissions = ['attendance:read']
  state.suppressWrite = false
  state.mismatchId = false
  state.failSql = ''
  state.failError = null
  state.corruptAt = ''
  state.corruptKind = ''
  state.calls = 0
  mocks.transaction.mockImplementation(async (work: (client: { query: typeof mocks.transaction }) => Promise<unknown>) => {
    state.calls += 1
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        const text = String(sql)
        sqlLog.push(text)
        if (state.failSql && text.includes(state.failSql)) throw state.failError
        if (text.includes('SET TRANSACTION') || text.includes('set_config') || text.includes('pg_advisory_xact_lock')) return answer(text, params, { rows: [] })
        if (text.includes('current_setting')) return answer(text, params, { rows: [{ lock_timeout: '0', statement_timeout: '0' }] })
        // D21 (Y5a): the mutex's subject version bump, one sorted statement before the users-row locks.
        if (text.startsWith('INSERT INTO subject_authorization_versions ')) return answer(text, params, { rows: [], rowCount: (params?.[0] as unknown[]).length })
        if (text.includes('FOR UPDATE')) {
          const row = state.users.get(String(params?.[0]))
          return answer(text, params, { rows: row ? [row] : [] })
        }
        if (text.includes("role_id = 'admin' FOR SHARE")) {
          const held = (state.memberships.get(String(params?.[0])) ?? []).includes('admin')
          return answer(text, params, { rows: held ? [{ role_id: 'admin' }] : [] })
        }
        if (text.includes('SET permissions')) {
          if (state.suppressWrite) return answer(text, params, { rows: [], rowCount: 0 })
          if (state.mismatchId) return answer(text, params, { rows: [{ id: 'other-id' }], rowCount: 1 })
          return answer(text, params, { rows: [{ id: params?.[0] }], rowCount: 1 })
        }
        if (text.includes('SELECT to_jsonb(permissions)')) return answer(text, params, { rows: [{ permissions: state.permissions }] })
        if (text.includes('INSERT INTO authorization_operation_')) return answer(text, params, { rows: [], rowCount: 1 })
        if (text.includes('SELECT pg_typeof(permissions)')) {
          return answer(text, params, { rows: [{ permissions_type: state.columnType, permissions: state.permissions }], rowCount: 1 })
        }
        if (text.includes('directory_deprovision') || text.includes('access_generation')) return answer(text, params, { rows: [{ access_generation: 2 }], rowCount: 1 })
        throw new Error(`unexpected command sql: ${text.slice(0, 180)}`)
      },
    }
    return work(client)
  })
})

describe('legacy permission revoke command through the real default root', () => {
  it('freezes one five-key plan and one two-key witness before the first await', async () => {
    state.permissions = [' code ', 'code', 'keep', 7, ' code ']
    const input = { actorId: 'actor', userId: 'target', permission: 'code' }
    const pending = revokeLegacyUserPermissionCommand(input)
    input.actorId = 'mutated'
    input.userId = 'mutated'
    input.permission = 'mutated'
    await expect(pending).resolves.toEqual({ changed: true, profile: null })
    const plan = planOf()
    expect(plan).toEqual({
      intent: 'REVOKE_DIRECT',
      roleIds: [],
      userIds: ['actor', 'target'],
      admissionUserIds: ['actor', 'target'],
      witness: { userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'] },
    })
    expect(plan.userIds).toBe(plan.admissionUserIds)
    expect(plan.witness?.userIds).toBe(plan.userIds)
    expect(plan.witness?.admissionUserIds).toBe(plan.userIds)
    expect(Object.keys(plan).sort()).toEqual(['admissionUserIds', 'intent', 'roleIds', 'userIds', 'witness'])
    expect(Object.keys(plan.witness ?? {}).sort()).toEqual(['admissionUserIds', 'userIds'])
    for (const value of [plan, plan.roleIds, plan.userIds, plan.admissionUserIds, plan.witness, plan.witness?.userIds, plan.witness?.admissionUserIds]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(mocks.entry.mock.calls.at(-1)?.[2]).toBeUndefined()
    expect(state.calls).toBe(1)
    const write = permissionWrites()
    expect(write).toHaveLength(1)
    expect(write[0]?.params).toEqual(['target', '["keep",7]', JSON.stringify(state.permissions)])
    expect(write[0]?.sql).toContain('$2::jsonb')
    expect(write[0]?.rowCount).toBe(1)
    expect(write[0]?.rows).toEqual([{ id: 'target' }])
    expect(queries.some((query) => query.sql.includes('directory_deprovision_effects'))).toBe(true)
    expect(queries.some((query) => query.sql.includes('directory_deprovision_events'))).toBe(true)
  })

  it('uses one subject when the actor is the target', async () => {
    state.users = new Map([['actor', user('actor', { role: 'admin' })]])
    state.memberships = new Map([['actor', ['admin']]])
    await revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'actor', permission: 'attendance:read' })
    expect(planOf().userIds).toEqual(['actor'])
    expect(sqlLog.filter((sql) => sql.includes('FOR UPDATE'))).toHaveLength(1)
  })

  it('refuses an empty trimmed input before opening the root', async () => {
    await expect(revokeLegacyUserPermissionCommand({ actorId: ' ', userId: 'target', permission: 'attendance:read' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(state.calls).toBe(0)
  })

  it('refuses a raw admin with no live admin child and still takes the share', async () => {
    state.users.get('actor')!.role = 'admin'
    state.memberships.set('actor', [])
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toBeInstanceOf(PlatformActorAuthorityLost)
    expect(sqlLog.some((sql) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(true)
    expect(sqlLog.some((sql) => sql.includes('SET permissions'))).toBe(false)
    expect(sqlLog.some((sql) => sql.includes('FROM roles'))).toBe(false)
  })

  it('refuses a demoted actor before a missing target', async () => {
    state.users.delete('target')
    state.memberships.set('actor', [])
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(sqlLog.some((sql) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(true)
  })

  it('refuses a demoted actor before a recycled target', async () => {
    state.users.get('target')!.deleted_at = '2026-01-01'
    state.memberships.set('actor', [])
    const error = await revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PlatformActorAuthorityLost)
    expect((error as PlatformActorAuthorityLost).code).toBe('FORBIDDEN')
    expect(sqlLog.some((sql) => sql.includes('FOR SHARE'))).toBe(true)
  })

  it('writes an inactive target and a pending target', async () => {
    state.users.get('target')!.is_active = false
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).resolves.toEqual({ changed: true, profile: null })
    state.users.get('target')!.is_active = true
    state.users.get('target')!.activation_status = 'pending_activation'
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).resolves.toEqual({ changed: true, profile: null })
    const writes = permissionWrites()
    expect(writes).toHaveLength(2)
    expect(writes.every((query) => query.rowCount === 1 && query.rows[0]?.id === 'target' && query.params?.[0] === 'target' && query.params?.[1] === '[]')).toBe(true)
    expect(queries.filter((query) => query.sql.includes('directory_deprovision_effects'))).toHaveLength(2)
    expect(queries.filter((query) => query.sql.includes('directory_deprovision_events'))).toHaveLength(2)
  })

  it('preserves non-arrays and rejects zero or mismatched acknowledgements before supersede', async () => {
    state.permissions = { bad: true }
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).resolves.toEqual({ changed: false, profile: null })
    expect(sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    expect(permissionWrites()).toHaveLength(0)
    state.permissions = ['attendance:read']
    state.suppressWrite = true
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toThrow('AUTHORIZATION_EXCEPTION_WRITE_NOT_ACKNOWLEDGED')
    expect(sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    const zeroRow = permissionWrites()
    expect(zeroRow).toHaveLength(1)
    expect(zeroRow[0]?.rowCount).toBe(0)
    expect(zeroRow[0]?.rows).toEqual([])
    expect(zeroRow[0]?.params).toEqual(['target', '[]', JSON.stringify(state.permissions)])
    expect(zeroRow[0]?.sql).toContain('$2::jsonb')
    state.suppressWrite = false
    state.mismatchId = true
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toThrow('AUTHORIZATION_EXCEPTION_WRITE_NOT_ACKNOWLEDGED')
    expect(sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    const mismatch = permissionWrites()
    expect(mismatch).toHaveLength(2)
    expect(mismatch[1]?.rowCount).toBe(1)
    expect(mismatch[1]?.rows).toEqual([{ id: 'other-id' }])
    expect(mismatch[1]?.params?.[0]).toBe('target')
    expect(mismatch[1]?.sql).toContain('$2::jsonb')
  })

  it('throws on an unsupported column and on a text[] element that is not a string or null', async () => {
    state.columnType = 'json'
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toThrow('unsupported users.permissions type')
    expect(sqlLog.some((sql) => sql.includes('SET permissions'))).toBe(false)
    state.columnType = 'text[]'
    state.permissions = ['attendance:read', 7]
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toThrow('unsupported users.permissions type')
    expect(sqlLog.filter((sql) => sql.includes('SET permissions'))).toHaveLength(0)
  })

  it('keeps a recovery marker and maps a bare deadlock from the awaited write', async () => {
    state.failSql = 'SET permissions'
    state.failError = Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
    const marker = await revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' }).catch((error: unknown) => error)
    expect(marker).toBe(state.failError)
    expect(marker).not.toBeInstanceOf(AuthorizationInputBusyError)
    state.failError = Object.assign(new Error('deadlock detected'), { code: '40P01' })
    const busy = await revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' }).catch((error: unknown) => error)
    expect(busy).toBeInstanceOf(AuthorizationInputBusyError)
  })

  it('rejects a witness deleted during the admin share before inspection', async () => {
    state.corruptAt = "role_id = 'admin' FOR SHARE"
    state.corruptKind = 'user'
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toBeInstanceOf(AuthorizationInputContractError)
    expect(sqlLog.some((sql) => sql.includes('FOR SHARE'))).toBe(true)
    expect(sqlLog.some((sql) => sql.includes('pg_typeof'))).toBe(false)
  })

  it('rejects a witness deleted during inspection before the permission update', async () => {
    state.corruptAt = 'pg_typeof'
    state.corruptKind = 'admission'
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toBeInstanceOf(AuthorizationInputContractError)
    expect(sqlLog.some((sql) => sql.includes('pg_typeof'))).toBe(true)
    expect(sqlLog.some((sql) => sql.includes('SET permissions'))).toBe(false)
  })

  it('rejects a world change during inspection before the permission update', async () => {
    state.corruptAt = 'pg_typeof'
    state.corruptKind = 'world'
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toBeInstanceOf(AuthorizationInputContractError)
    expect(sqlLog.some((sql) => sql.includes('SET permissions'))).toBe(false)
  })

  it('rejects a witness deleted during the permission update before supersede', async () => {
    state.corruptAt = 'SET permissions'
    state.corruptKind = 'user'
    await expect(revokeLegacyUserPermissionCommand({ actorId: 'actor', userId: 'target', permission: 'attendance:read' })).rejects.toBeInstanceOf(AuthorizationInputContractError)
    expect(sqlLog.some((sql) => sql.includes('SET permissions'))).toBe(true)
    expect(sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    const write = permissionWrites()
    expect(write).toHaveLength(1)
    expect(write[0]?.rowCount).toBe(1)
    expect(write[0]?.rows).toEqual([{ id: 'target' }])
    expect(write[0]?.params).toEqual(['target', '[]', JSON.stringify(state.permissions)])
  })

  it('keeps the writer private and the command data-only', () => {
    const source = readFileSync(new URL('../../src/admin/legacy-permission-revoke.ts', import.meta.url), 'utf8')
    const route = readFileSync(new URL('../../src/routes/permissions.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/export async function revokeLegacyUserPermission\b/)
    expect(source).not.toMatch(/lockSharedAccessSubjects/)
    const root = readFileSync(new URL('../../src/admin/authorization-exception-compat.ts', import.meta.url), 'utf8')
    expect(source).toContain('assertPermissionExceptionRoot(tx, options, true, true)')
    expect(root).toContain('withAuthorizationInputTransaction(plan, async (tx)')
    expect(route).toContain('writeLegacyAuthorizationException(')
    expect(route).not.toMatch(/transaction\(async/)
  })
})
