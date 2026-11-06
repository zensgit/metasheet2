import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logEventMock, warnMock, errorMock } = vi.hoisted(() => ({
  logEventMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
}))

vi.mock('../../src/audit/AuditService', () => ({
  AuditService: class {
    logEvent = logEventMock
  },
}))

vi.mock('../../src/core/logger', () => ({
  Logger: class {
    warn = warnMock
    info = vi.fn()
    error = errorMock
    debug = vi.fn()
  },
}))

import { coreMetrics } from '../../src/integration/metrics/metrics'
import { AUDIT_WRITE_ERRORS_METRIC, auditLog } from '../../src/audit/audit'

const failureCount = (): number => coreMetrics.getCustomMetric(AUDIT_WRITE_ERRORS_METRIC) ?? 0

describe('auditLog', () => {
  beforeEach(() => {
    logEventMock.mockReset()
    warnMock.mockReset()
    errorMock.mockReset()
  })

  it('passes numeric actor ids through to the audit service', async () => {
    logEventMock.mockResolvedValueOnce(undefined)
    const before = failureCount()

    await auditLog({
      actorId: '42',
      actorType: 'user',
      action: 'grant',
      resourceType: 'permission',
      resourceId: 'user-1:attendance:read',
      meta: { permission: 'attendance:read' },
    })

    expect(logEventMock).toHaveBeenCalledWith(
      'GRANT',
      'grant',
      {
        userId: 42,
        resourceType: 'permission',
        resourceId: 'user-1:attendance:read',
        actionDetails: { permission: 'attendance:read' },
      },
    )
    expect(warnMock).not.toHaveBeenCalled()
    expect(errorMock).not.toHaveBeenCalled()
    expect(failureCount()).toBe(before)
  })

  it('keeps a UUID admin on user_name for local department-head maintenance only', async () => {
    logEventMock.mockResolvedValue(undefined)
    const adminId = '26979f88-e7cc-4b40-a975-a0353d19aec0'

    await auditLog({
      actorId: adminId,
      actorType: 'user',
      action: 'directory.local_membership.set_department_head',
      resourceType: 'directory-membership',
      resourceId: 'account:department',
      meta: { isDepartmentHead: true },
    })

    expect(logEventMock).toHaveBeenCalledWith(
      'DIRECTORY.LOCAL_MEMBERSHIP.SET_DEPARTMENT_HEAD',
      'directory.local_membership.set_department_head',
      {
        userId: undefined,
        userName: adminId,
        resourceType: 'directory-membership',
        resourceId: 'account:department',
        actionDetails: { isDepartmentHead: true },
      },
    )

    logEventMock.mockClear()
    await auditLog({
      actorId: adminId,
      actorType: 'user',
      action: 'grant',
      resourceType: 'permission',
      resourceId: 'user-1:attendance:read',
    })
    expect(logEventMock).toHaveBeenCalledWith(
      'GRANT',
      'grant',
      {
        userId: undefined,
        resourceType: 'permission',
        resourceId: 'user-1:attendance:read',
        actionDetails: undefined,
      },
    )
  })

  it('keeps a UUID admin on user_name for local member projection only when the actor is a user', async () => {
    logEventMock.mockResolvedValue(undefined)
    const adminId = '26979f88-e7cc-4b40-a975-a0353d19aec0'

    await auditLog({
      actorId: adminId,
      actorType: 'user',
      action: 'directory.local_member.project',
      resourceType: 'directory-account',
      resourceId: 'account-1',
      meta: { integrationId: 'integration-1' },
    })
    expect(logEventMock).toHaveBeenCalledWith(
      'DIRECTORY.LOCAL_MEMBER.PROJECT',
      'directory.local_member.project',
      {
        userId: undefined,
        userName: adminId,
        resourceType: 'directory-account',
        resourceId: 'account-1',
        actionDetails: { integrationId: 'integration-1' },
      },
    )

    logEventMock.mockClear()
    await auditLog({
      actorId: '42',
      actorType: 'user',
      action: 'directory.local_member.project',
      resourceType: 'directory-account',
      resourceId: 'account-2',
    })
    expect(logEventMock).toHaveBeenCalledWith(
      'DIRECTORY.LOCAL_MEMBER.PROJECT',
      'directory.local_member.project',
      {
        userId: 42,
        userName: '42',
        resourceType: 'directory-account',
        resourceId: 'account-2',
        actionDetails: undefined,
      },
    )

    logEventMock.mockClear()
    await auditLog({
      actorId: '7',
      actorType: 'user',
      action: 'directory.local_membership.set_department_head',
      resourceType: 'directory-membership',
      resourceId: 'account:department',
    })
    expect(logEventMock).toHaveBeenCalledWith(
      'DIRECTORY.LOCAL_MEMBERSHIP.SET_DEPARTMENT_HEAD',
      'directory.local_membership.set_department_head',
      {
        userId: 7,
        userName: '7',
        resourceType: 'directory-membership',
        resourceId: 'account:department',
        actionDetails: undefined,
      },
    )

    logEventMock.mockClear()
    await auditLog({
      actorId: adminId,
      actorType: 'system',
      action: 'directory.local_member.project',
      resourceType: 'directory-account',
      resourceId: 'account-3',
    })
    expect(logEventMock).toHaveBeenCalledWith(
      'DIRECTORY.LOCAL_MEMBER.PROJECT',
      'directory.local_member.project',
      {
        userId: undefined,
        resourceType: 'directory-account',
        resourceId: 'account-3',
        actionDetails: undefined,
      },
    )

    logEventMock.mockClear()
    await auditLog({
      actorId: adminId,
      actorType: 'user',
      action: 'directory.local_account.create',
      resourceType: 'directory-account',
      resourceId: 'account-4',
    })
    expect(logEventMock).toHaveBeenCalledWith(
      'DIRECTORY.LOCAL_ACCOUNT.CREATE',
      'directory.local_account.create',
      {
        userId: undefined,
        resourceType: 'directory-account',
        resourceId: 'account-4',
        actionDetails: undefined,
      },
    )
  })

  it('swallows audit write failures so callers do not fail closed', async () => {
    const driverError = Object.assign(
      new Error('no partition of relation "audit_logs" found for row with resource_id 26979f88'),
      { code: '23514' },
    )
    logEventMock.mockRejectedValueOnce(driverError)
    const before = failureCount()

    await expect(auditLog({
      actorId: '26979f88-e7cc-4b40-a975-a0353d19aec0',
      actorType: 'user',
      action: 'grant',
      resourceType: 'user-role',
      resourceId: 'user-1:attendance_employee',
      meta: { roleId: 'attendance_employee', secretish: 'super-secret-value' },
    })).resolves.toBeUndefined()

    // Non-blocking contract: never downgraded to warn, never thrown.
    expect(warnMock).not.toHaveBeenCalled()
    expect(errorMock).toHaveBeenCalledTimes(1)
    expect(failureCount()).toBe(before + 1)

    const call = errorMock.mock.calls[0]
    // No second argument at all: nothing can leak through a meta payload.
    expect(call).toHaveLength(1)
    const message = call[0] as string
    expect(typeof message).toBe('string')
    expect(message).toContain('Audit log write failed')
    expect(message).toContain('action=grant')
    expect(message).toContain('resource_type=user-role')
    expect(message).toContain('error_code=23514')

    // Values-free: no resourceId, no meta values, no driver text.
    expect(message).not.toContain('user-1:attendance_employee')
    expect(message).not.toContain('attendance_employee')
    expect(message).not.toContain('super-secret-value')
    expect(message).not.toContain('26979f88')
    expect(message).not.toContain('no partition of relation')
    expect(message).not.toContain('audit_logs')
  })

  it('falls back to a placeholder code when the driver gives none', async () => {
    logEventMock.mockRejectedValueOnce('plain string failure with row value 12345')
    const before = failureCount()

    await expect(auditLog({
      actorType: 'system',
      action: 'revoke',
      resourceType: 'user-role',
      resourceId: 'user-9:attendance_employee',
    })).resolves.toBeUndefined()

    expect(errorMock).toHaveBeenCalledTimes(1)
    expect(failureCount()).toBe(before + 1)
    const message = errorMock.mock.calls[0][0] as string
    expect(message).toContain('error_code=UNKNOWN')
    expect(message).not.toContain('12345')
  })
})
