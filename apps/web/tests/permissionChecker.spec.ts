import { describe, expect, it } from 'vitest'
import {
  permissionCheckerRequestBody,
  permissionCheckerStillCurrent,
  readPermissionCheckerResponse,
} from '../src/views/permissionChecker'

describe('permissionChecker', () => {
  it('posts only the frozen user and permission code', () => {
    expect(permissionCheckerRequestBody('user-1', 'crm:read')).toEqual({
      userId: 'user-1',
      permission: 'crm:read',
    })
  })

  it('reads allowed and denied only from the boolean, and drops a mismatched receipt', () => {
    expect(readPermissionCheckerResponse({
      httpStatus: 200,
      payload: { userId: 'user-1', permission: 'crm:read', allowed: true },
      requestedUserId: 'user-1',
      requestedPermission: 'crm:read',
    }).phase).toBe('allowed')
    expect(readPermissionCheckerResponse({
      httpStatus: 200,
      payload: { userId: 'user-1', permission: 'crm:read', allowed: false },
      requestedUserId: 'user-1',
      requestedPermission: 'crm:read',
    }).phase).toBe('denied')
    const mismatched = readPermissionCheckerResponse({
      httpStatus: 200,
      payload: { userId: 'user-2', permission: 'crm:read', allowed: true },
      requestedUserId: 'user-1',
      requestedPermission: 'crm:read',
    })
    expect(mismatched.phase).toBe('error')
    expect(mismatched.detail).not.toContain('：允许')
    expect(readPermissionCheckerResponse({
      httpStatus: 200,
      payload: { userId: 'user-1', permission: 'crm:read', allowed: 'true' },
      requestedUserId: 'user-1',
      requestedPermission: 'crm:read',
    }).phase).toBe('error')
  })

  it('keeps forbidden, degraded, and transport errors from becoming an allow or deny', () => {
    const forbidden = readPermissionCheckerResponse({
      httpStatus: 403,
      payload: { error: 'Cannot check permissions for another user', allowed: true },
      requestedUserId: 'user-1',
      requestedPermission: 'crm:read',
    })
    expect(forbidden.phase).toBe('forbidden')
    expect(forbidden.detail).not.toContain('：允许')
    const degraded = readPermissionCheckerResponse({
      httpStatus: 200,
      payload: { userId: 'user-1', permission: 'crm:read', allowed: false, degraded: true },
      requestedUserId: 'user-1',
      requestedPermission: 'crm:read',
    })
    expect(degraded.phase).toBe('degraded')
    expect(degraded.detail).not.toContain('：不允许')
    const failed = readPermissionCheckerResponse({
      httpStatus: 500,
      payload: { error: 'Failed to check permission', allowed: true },
      requestedUserId: 'user-1',
      requestedPermission: 'crm:read',
    })
    expect(failed.phase).toBe('error')
    expect(failed.detail).toContain('Failed to check permission')
    expect(failed.detail).not.toContain('：允许')
  })

  it('rejects a response whose user or code is no longer the frozen selection', () => {
    expect(permissionCheckerStillCurrent(2, 2, 'user-1', 'crm:read', 'user-1', 'crm:read')).toBe(true)
    expect(permissionCheckerStillCurrent(2, 3, 'user-1', 'crm:read', 'user-1', 'crm:read')).toBe(false)
    expect(permissionCheckerStillCurrent(2, 2, 'user-1', 'crm:read', 'user-2', 'crm:read')).toBe(false)
    expect(permissionCheckerStillCurrent(2, 2, 'user-1', 'crm:read', 'user-1', 'workflow:read')).toBe(false)
  })
})
