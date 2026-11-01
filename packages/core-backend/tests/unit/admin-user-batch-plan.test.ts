import { describe, expect, it } from 'vitest'
import {
  ADMIN_USER_BATCH_LIMIT,
  HARD_DELETE_CONFIRM_TEXT,
  planCreateBatch,
  planDeleteBatch,
  planStatusBatch,
  planUpdateBatch,
  type KnownBatchUser,
} from '../../src/admin/user-batch-plan'

const lin: KnownBatchUser = {
  id: 'user-lin',
  email: 'linlan@example.com',
  name: '林岚',
  role: 'user',
  department: '装配车间',
  isActive: true,
}

describe('admin user batch plan', () => {
  it('rejects an empty batch and a batch over the limit', () => {
    expect(planCreateBatch({ body: { items: [] }, existingEmails: new Set(), knownRoleIds: new Set() }).ok).toBe(false)
    const tooMany = planCreateBatch({
      body: { items: Array.from({ length: ADMIN_USER_BATCH_LIMIT + 1 }, () => ({ email: 'a@example.com', name: '测试用户' })) },
      existingEmails: new Set(),
      knownRoleIds: new Set(['user']),
    })
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.code).toBe('BATCH_LIMIT_EXCEEDED')
  })

  it('flags bad emails, in-batch duplicates, existing emails, and unknown roles', () => {
    const plan = planCreateBatch({
      body: {
        items: [
          { email: 'not-an-email', name: '测试用户' },
          { email: 'linlan@example.com', name: '林岚' },
          { email: 'linlan@example.com', name: '林岚' },
          { email: 'new@example.com', name: '新同事', roleId: 'missing-role' },
          { email: 'ok@example.com', name: '可用', roleId: 'user', department: '计划部' },
        ],
      },
      existingEmails: new Set(['linlan@example.com']),
      knownRoleIds: new Set(['user']),
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows.map((row) => row.email)).toEqual(['ok@example.com'])
    expect(plan.failures.map((row) => row.code)).toEqual([
      'INVALID_EMAIL',
      'EMAIL_ALREADY_EXISTS',
      'DUPLICATE_EMAIL_IN_BATCH',
      'ROLE_NOT_FOUND',
    ])
  })

  it('derives a name from the email local part when paste mode omits one', () => {
    const plan = planCreateBatch({
      body: { items: [{ email: 'guest.user@example.com', roleId: 'user' }] },
      existingEmails: new Set(),
      knownRoleIds: new Set(['user']),
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows[0]?.name).toBe('guest.user')
  })

  it('plans an update diff by user id or email and refuses a mismatch', () => {
    const other: KnownBatchUser = { ...lin, id: 'user-other', email: 'other@example.com', name: '其他人' }
    const usersById = new Map([[lin.id, lin], [other.id, other]])
    const usersByEmail = new Map([[lin.email!, lin], [other.email!, other]])
    const plan = planUpdateBatch({
      body: {
        items: [
          { userId: lin.id, department: '质量部' },
          { email: 'linlan@example.com', isActive: false },
          { userId: lin.id, email: 'other@example.com', department: '仓储' },
          { department: '仓储' },
        ],
      },
      usersById,
      usersByEmail,
      knownRoleIds: new Set(['user']),
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows).toHaveLength(2)
    expect(plan.rows[0]?.changes).toEqual([{ field: 'department', before: '装配车间', after: '质量部' }])
    expect(plan.rows[1]?.changes[0]?.field).toBe('isActive')
    expect(plan.failures.map((row) => row.code)).toEqual(['AMBIGUOUS_MATCH', 'MATCH_KEY_REQUIRED'])
  })

  it('plans an explicit role replacement even when users.role already matches', () => {
    const plan = planUpdateBatch({
      body: { items: [{ userId: lin.id, roleId: 'user' }] },
      usersById: new Map([[lin.id, lin]]),
      usersByEmail: new Map([[lin.email!, lin]]),
      knownRoleIds: new Set(['user']),
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.failures).toEqual([])
    expect(plan.rows).toEqual([
      expect.objectContaining({ userId: lin.id, roleId: 'user', changes: [] }),
    ])
  })

  it('requires both userId and email to resolve to the same person', () => {
    const plan = planUpdateBatch({
      body: {
        items: [
          { userId: lin.id, email: 'missing@example.com', department: '仓储' },
          { userId: 'missing-user', email: lin.email, department: '仓储' },
          { userId: 'missing-user', email: 'missing@example.com', department: '仓储' },
        ],
      },
      usersById: new Map([[lin.id, lin]]),
      usersByEmail: new Map([[lin.email!, lin]]),
      knownRoleIds: new Set(['user']),
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows).toEqual([])
    expect(plan.failures.map((row) => row.code)).toEqual([
      'AMBIGUOUS_MATCH',
      'AMBIGUOUS_MATCH',
      'USER_NOT_FOUND',
    ])
  })

  it('refuses disabling the actor and unknown users', () => {
    const plan = planStatusBatch({
      userIds: ['admin-1', 'missing'],
      isActive: false,
      actorId: 'admin-1',
      knownIds: new Set(['admin-1']),
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows).toHaveLength(0)
    expect(plan.failures.map((row) => row.code)).toEqual(['SELF_DISABLE_FORBIDDEN', 'USER_NOT_FOUND'])
  })

  it('requires the typed phrase and plans a recycle move instead of deleting the row', () => {
    const admin: KnownBatchUser = {
      id: 'admin-1',
      email: 'admin@example.com',
      name: '管理员',
      role: 'admin',
      department: null,
      isActive: true,
      isPlatformAdmin: true,
    }
    const users = new Map<string, KnownBatchUser>([[lin.id, lin], [admin.id, admin]])
    const missing = planDeleteBatch({
      userIds: ['user-lin'],
      mode: 'hard',
      confirmText: '删除',
      actorId: 'admin-1',
      knownIds: new Set(['user-lin']),
      knownUsers: users,
      livePlatformAdminCount: 1,
    })
    expect(missing.ok).toBe(false)
    if (missing.ok || !('code' in missing)) return
    expect(missing.code).toBe('CONFIRM_TEXT_MISMATCH')

    const planned = planDeleteBatch({
      userIds: [lin.id, admin.id, 'missing'],
      mode: 'hard',
      confirmText: HARD_DELETE_CONFIRM_TEXT,
      actorId: 'admin-1',
      knownIds: new Set([lin.id, admin.id]),
      knownUsers: users,
      livePlatformAdminCount: 1,
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.rows.map((row) => row.userId)).toEqual([lin.id])
    expect(planned.failures.map((row) => row.code)).toEqual(['SELF_DELETE_FORBIDDEN', 'USER_NOT_FOUND'])

    const disable = planDeleteBatch({
      userIds: ['user-lin'],
      mode: 'disable',
      confirmText: '停用',
      actorId: 'admin-1',
      knownIds: new Set(['user-lin']),
    })
    expect(disable.ok).toBe(true)
    if (!disable.ok) return
    expect(disable.rows.map((row) => row.userId)).toEqual(['user-lin'])
  })

  it('refuses a new invite for an email that is still in the recycle bin', () => {
    const plan = planCreateBatch({
      body: { items: [{ email: 'linlan@example.com', name: '林岚' }] },
      existingEmails: new Set(),
      recycleEmails: new Set(['linlan@example.com']),
      knownRoleIds: new Set(),
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows).toHaveLength(0)
    expect(plan.failures[0]?.code).toBe('USER_IN_RECYCLE_BIN')
  })
})
