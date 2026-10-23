import type { Request } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/db/pg', () => ({ query: queryMock, pool: null }))

import {
  isApprovalTemplateManager,
  loadApprovalUserRoleIds,
  resolveApprovalPushRecipientRoles,
  resolveApprovalActorRoleClaims,
  resolveApprovalActorRoles,
} from '../../src/services/approval-actor-roles'

function req(user: unknown): Request {
  return { user } as unknown as Request
}

function answer(column: string | null, roleIds: Array<string | null>) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM users\b/.test(sql)) return { rows: column === undefined ? [] : [{ role: column }] }
    if (/FROM user_roles\b/.test(sql)) return { rows: roleIds.map((role_id) => ({ role_id })) }
    throw new Error(`unexpected query: ${sql}`)
  })
}

describe('approval actor role set = claims ∪ users.role ∪ user_roles.role_id (ids only)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('unions the request claims with the stored column and every user_roles row, deduplicated', async () => {
    answer('employee', ['reviewer', ' finance ', '', null, 'employee'])
    const roles = await resolveApprovalActorRoles(req({ id: 'u1', role: 'employee' }))
    expect(roles.sort()).toEqual(['employee', 'finance', 'reviewer'])
  })

  it('reads role IDS only: never joins the roles table, so role names cannot enter the set', async () => {
    answer('user', ['r1'])
    await loadApprovalUserRoleIds('u1')
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql))
    expect(sqls).toHaveLength(2)
    for (const sql of sqls) {
      expect(sql).not.toMatch(/\bJOIN\b/i)
      expect(sql).not.toMatch(/\bname\b/i)
    }
  })

  it('keeps the admin upgrade the request carries even when the stored column is something else', async () => {
    answer('manager', [])
    expect((await resolveApprovalActorRoles(req({ id: 'u2', role: 'admin' }))).sort()).toEqual(['admin', 'manager'])
  })

  it('FAILS CLOSED by rejecting when the user_roles read fails — never a narrower set', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM users\b/.test(sql)) return { rows: [{ role: 'employee' }] }
      throw new Error('user_roles unavailable')
    })
    await expect(resolveApprovalActorRoles(req({ id: 'u3', role: 'employee' }))).rejects.toThrow('user_roles unavailable')
  })

  it('FAILS CLOSED by rejecting when the users read fails', async () => {
    queryMock.mockRejectedValue(new Error('users unavailable'))
    await expect(resolveApprovalActorRoles(req({ id: 'u4', role: 'employee' }))).rejects.toThrow('users unavailable')
  })

  it('reads once per request (memoized) and again for a new request', async () => {
    answer('user', ['r1'])
    const one = req({ id: 'u5', role: 'user' })
    await resolveApprovalActorRoles(one)
    await resolveApprovalActorRoles(one)
    expect(queryMock).toHaveBeenCalledTimes(2)
    await resolveApprovalActorRoles(req({ id: 'u5', role: 'user' }))
    expect(queryMock).toHaveBeenCalledTimes(4)
  })

  it('no actor id ⇒ claims only, no database read', async () => {
    expect(await resolveApprovalActorRoles(req({ role: 'x' }))).toEqual(['x'])
    expect(await resolveApprovalActorRoles(req(undefined))).toEqual([])
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('resolveApprovalActorRoleClaims stays a pure read of the request', () => {
    expect(resolveApprovalActorRoleClaims(req({ id: 'u6', role: ' a ', roles: ['a', 'b'] }))).toEqual(['a', 'b'])
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('push recipients get users.role ∪ user_roles ids, and the read failure propagates (caller skips that push)', async () => {
    answer('user', ['r1'])
    expect((await resolveApprovalPushRecipientRoles('u7')).sort()).toEqual(['r1', 'user'])
    queryMock.mockRejectedValue(new Error('down'))
    await expect(resolveApprovalPushRecipientRoles('u7')).rejects.toThrow('down')
  })

  it('template-manager status reads only the role CLAIMS handed to it plus permissions', () => {
    expect(isApprovalTemplateManager(['member'], [])).toBe(false)
    expect(isApprovalTemplateManager(['admin'], [])).toBe(true)
    expect(isApprovalTemplateManager(['member'], ['approval-templates:manage'])).toBe(true)
    expect(isApprovalTemplateManager(['member'], ['approvals:read', 'approvals:write'])).toBe(false)
  })
})
