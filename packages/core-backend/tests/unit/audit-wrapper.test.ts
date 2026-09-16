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
