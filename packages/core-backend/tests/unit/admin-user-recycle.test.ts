import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyRecycleMove,
  applyRecyclePurge,
  applyRecycleRestore,
  listDueRecycleUserIds,
  resolveUserRecycleRetentionDays,
  USER_TOMBSTONE_NAME,
  type RecycleClient,
} from '../../src/admin/user-recycle'

type UserRow = {
  id: string
  email: string | null
  name: string | null
  is_active: boolean
  is_admin: boolean
  role: string
  deleted_at: string | null
  deleted_by: string | null
  purge_after: string | null
  purged_at: string | null
  active_before_delete: boolean | null
  department: string | null
}

function clientFor(users: UserRow[], extras: { aliases?: string[]; identities?: string[] } = {}): RecycleClient & { sql: string[] } {
  const sql: string[] = []
  return {
    sql,
    query: async (statement, params = []) => {
      sql.push(statement)
      const id = String(params[0] ?? '')
      const user = users.find((row) => row.id === id)
      if (statement.includes('SET access_generation')) return { rows: [{ access_generation: 1 }] }
      if (statement.includes('COUNT(*)')) {
        const liveAdmins = users.filter((row) => row.id !== id && !row.deleted_at && !row.purged_at && (row.is_admin || row.role === 'admin'))
        return { rows: [{ c: liveAdmins.length }] }
      }
      if (statement.includes('FOR UPDATE') && statement.includes('FROM users')) {
        if (!user) return { rows: [] }
        return {
          rows: [{
            ...user,
            deletion_version: user.deleted_at,
            is_platform_admin: user.is_admin || user.role === 'admin',
          } as unknown as Record<string, unknown>],
        }
      }
      if (statement.includes('SET deleted_at')) {
        if (!user || user.deleted_at || user.purged_at) return { rows: [] }
        user.deleted_at = String(params[1])
        user.deleted_by = String(params[2])
        user.active_before_delete = user.is_active
        user.is_active = false
        user.purge_after = 'due'
        return { rows: [{ id: user.id, email: user.email }] }
      }
      if (statement.includes('SET is_active = COALESCE(active_before_delete')) {
        if (!user || !user.deleted_at || user.purged_at) return { rows: [] }
        user.is_active = user.active_before_delete ?? false
        user.deleted_at = null
        user.deleted_by = null
        user.purge_after = null
        user.active_before_delete = null
        return { rows: [{ id: user.id, email: user.email }] }
      }
      if (statement.includes('SET email = NULL')) {
        if (!user || !user.deleted_at || user.purged_at) return { rows: [] }
        expect(params[1]).toBe(USER_TOMBSTONE_NAME)
        user.email = null
        user.name = USER_TOMBSTONE_NAME
        user.department = null
        user.purged_at = String(params[3])
        user.is_active = false
        return { rows: [{ id: user.id }] }
      }
      if (statement.includes('DELETE FROM user_login_aliases') && extras.aliases) extras.aliases.length = 0
      if (statement.includes('DELETE FROM user_external_identities') && extras.identities) extras.identities.length = 0
      if (statement.includes('purge_after <=')) {
        return {
          rows: users
            .filter((row) => row.deleted_at && !row.purged_at && row.purge_after && row.purge_after <= String(params[0]))
            .map((row) => ({ id: row.id, deleted_at: row.deleted_at })),
        }
      }
      return { rows: [] }
    },
  }
}

describe('user recycle bin', () => {
  it('defaults retention to 30 days and clamps configuration', () => {
    expect(resolveUserRecycleRetentionDays({})).toBe(30)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: '0' })).toBe(30)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: 'nope' })).toBe(30)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: '14' })).toBe(14)
    expect(resolveUserRecycleRetentionDays({ USER_RECYCLE_RETENTION_DAYS: '99999' })).toBe(3650)
  })

  it('soft-deletes into the bin and refuses self-delete and the last platform admin', async () => {
    const users: UserRow[] = [
      { id: 'user-lin', email: 'lin@example.com', name: '林岚', is_active: true, is_admin: false, role: 'user', deleted_at: null, deleted_by: null, purge_after: null, purged_at: null, active_before_delete: null, department: '装配' },
      { id: 'admin-1', email: 'admin@example.com', name: '管理员', is_active: true, is_admin: true, role: 'admin', deleted_at: null, deleted_by: null, purge_after: null, purged_at: null, active_before_delete: null, department: null },
    ]
    const db = clientFor(users)
    const moved = await applyRecycleMove(db, { userId: 'user-lin', actorId: 'admin-1', retentionDays: 30, index: 0, now: new Date('2026-10-01T00:00:00.000Z') })
    expect(moved).toMatchObject({ ok: true, code: null, message: '已移入回收站' })
    expect(users[0]?.is_active).toBe(false)
    expect(users[0]?.deleted_by).toBe('admin-1')
    expect(users[0]?.active_before_delete).toBe(true)
    expect(db.sql.some((statement) => /DELETE\s+FROM\s+users/i.test(statement))).toBe(false)

    const self = await applyRecycleMove(db, { userId: 'admin-1', actorId: 'admin-1', retentionDays: 30, index: 1 })
    expect(self.code).toBe('SELF_DELETE_FORBIDDEN')

    const lastAdmin = await applyRecycleMove(db, { userId: 'admin-1', actorId: 'user-lin', retentionDays: 30, index: 2 })
    expect(lastAdmin.code).toBe('LAST_PLATFORM_ADMIN')
    expect(users[1]?.deleted_at).toBeNull()
  })

  it('restores the previous active flag and refuses a purged account', async () => {
    const users: UserRow[] = [
      { id: 'user-lin', email: 'lin@example.com', name: '林岚', is_active: false, is_admin: false, role: 'user', deleted_at: '2026-10-01T00:00:00.000Z', deleted_by: 'admin-1', purge_after: '2026-10-31T00:00:00.000Z', purged_at: null, active_before_delete: false, department: '装配' },
    ]
    const db = clientFor(users)
    const restored = await applyRecycleRestore(db, { userId: 'user-lin', actorId: 'admin-1', index: 0 })
    expect(restored.ok).toBe(true)
    expect(users[0]?.deleted_at).toBeNull()
    expect(users[0]?.is_active).toBe(false)

    users[0]!.deleted_at = '2026-10-01T00:00:00.000Z'
    users[0]!.purged_at = '2026-11-01T00:00:00.000Z'
    const purged = await applyRecycleRestore(db, { userId: 'user-lin', actorId: 'admin-1', index: 1 })
    expect(purged.code).toBe('ALREADY_PURGED')
  })

  it('anonymizes a due account and leaves the user row in place', async () => {
    const aliases = ['lin@example.com']
    const identities = ['ding-1']
    const users: UserRow[] = [
      { id: 'user-lin', email: 'lin@example.com', name: '林岚', is_active: false, is_admin: false, role: 'user', deleted_at: '2026-10-01T00:00:00.000Z', deleted_by: 'admin-1', purge_after: '2026-10-31T00:00:00.000Z', purged_at: null, active_before_delete: true, department: '装配' },
      { id: 'user-next', email: 'next@example.com', name: '下一位', is_active: false, is_admin: false, role: 'user', deleted_at: '2026-10-20T00:00:00.000Z', deleted_by: 'admin-1', purge_after: '2026-11-20T00:00:00.000Z', purged_at: null, active_before_delete: true, department: null },
    ]
    const db = clientFor(users, { aliases, identities })
    const due = await listDueRecycleUserIds(db, new Date('2026-10-31T12:00:00.000Z'))
    expect(due).toEqual(['user-lin'])

    const purged = await applyRecyclePurge(db, {
      userId: 'user-lin',
      actorId: 'system:user-recycle',
      index: 0,
      now: new Date('2026-10-31T12:00:00.000Z'),
      passwordHash: 'unusable',
    })
    expect(purged.ok).toBe(true)
    expect(users[0]).toMatchObject({ email: null, name: USER_TOMBSTONE_NAME, department: null, purged_at: '2026-10-31T12:00:00.000Z' })
    expect(users[0]?.deleted_at).toBeTruthy()
    expect(aliases).toEqual([])
    expect(identities).toEqual([])
    expect(db.sql.some((statement) => /DELETE\s+FROM\s+users\b/i.test(statement))).toBe(false)
    expect(db.sql.some((statement) => statement.includes('DELETE FROM user_login_aliases'))).toBe(true)
  })

  it('declares recycle columns in the migration', () => {
    const migration = readFileSync(resolve(__dirname, '../../src/db/migrations/zzzz20261031120000_add_users_recycle_bin.ts'), 'utf8')
    for (const column of ['deleted_at', 'deleted_by', 'purge_after', 'purged_at', 'purged_by', 'active_before_delete']) {
      expect(migration).toContain(column)
    }
    expect(migration).not.toContain('DROP TABLE users')
  })
})
