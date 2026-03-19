import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logEventMock, warnMock } = vi.hoisted(() => ({
  logEventMock: vi.fn(),
  warnMock: vi.fn(),
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
    error = vi.fn()
    debug = vi.fn()
  },
}))

import { auditLog } from '../../src/audit/audit'

describe('auditLog', () => {
  beforeEach(() => {
    logEventMock.mockReset()
    warnMock.mockReset()
  })

  it('passes numeric actor ids through to the audit service', async () => {
    logEventMock.mockResolvedValueOnce(undefined)

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
  })

  it('swallows audit write failures so callers do not fail closed', async () => {
    logEventMock.mockRejectedValueOnce(new Error('no partition of relation "audit_logs" found for row'))

    await expect(auditLog({
      actorId: '26979f88-e7cc-4b40-a975-a0353d19aec0',
      actorType: 'user',
      action: 'grant',
      resourceType: 'user-role',
      resourceId: 'user-1:attendance_employee',
      meta: { roleId: 'attendance_employee' },
    })).resolves.toBeUndefined()

    expect(warnMock).toHaveBeenCalledWith(
      'Audit log write failed; continuing without blocking request',
      expect.objectContaining({
        action: 'grant',
        resourceType: 'user-role',
        resourceId: 'user-1:attendance_employee',
        error: 'no partition of relation "audit_logs" found for row',
      }),
    )
  })
})
