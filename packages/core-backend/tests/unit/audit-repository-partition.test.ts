import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: {},
  query: queryMock,
}))

import { AuditRepository, type AuditLogData } from '../../src/audit/AuditRepository'

function buildAuditLogData(overrides: Partial<AuditLogData> = {}): AuditLogData {
  return {
    eventType: 'ATTENDANCE_POLICY_UPDATED',
    eventCategory: 'attendance',
    action: 'update',
    resourceType: 'attendance-policy',
    resourceId: 'policy-1',
    actionDetails: { changed: ['timezone'] },
    ...overrides,
  }
}

function missingAuditLogPartitionError(): Error & { code: string } {
  return Object.assign(new Error('no partition of relation "audit_logs" found for row'), {
    code: '23514',
  })
}

describe('AuditRepository audit_logs partition lifecycle', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('keeps the normal audit insert path to one query', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 200 }], rowCount: 1 })

    const repository = new AuditRepository()

    await expect(repository.createAuditLog(buildAuditLogData())).resolves.toBe(200)

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO audit_logs')
  })

  it('self-heals the current-month partition and retries the audit insert once', async () => {
    queryMock
      .mockRejectedValueOnce(missingAuditLogPartitionError())
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 503 }], rowCount: 1 })

    const repository = new AuditRepository()

    await expect(repository.createAuditLog(buildAuditLogData())).resolves.toBe(503)

    expect(queryMock).toHaveBeenCalledTimes(3)
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO audit_logs')
    expect(queryMock.mock.calls[1][0]).toContain("DATE_TRUNC('month', CURRENT_DATE)")
    expect(queryMock.mock.calls[1][0]).toContain('CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs')
    expect(queryMock.mock.calls[2][0]).toContain('INSERT INTO audit_logs')
  })

  it('does not retry unrelated audit insert errors', async () => {
    const error = new Error('permission denied for table audit_logs')
    queryMock.mockRejectedValueOnce(error)

    const repository = new AuditRepository()

    await expect(repository.createAuditLog(buildAuditLogData())).rejects.toThrow(error)
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('can ensure the database server current-month partition directly', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const repository = new AuditRepository()

    await repository.ensureCurrentMonthPartition()

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0][0]).toContain("partition_name := 'audit_logs_'")
    expect(queryMock.mock.calls[0][0]).toContain("DATE_TRUNC('month', CURRENT_DATE)")
    expect(queryMock.mock.calls[0][0]).toContain('pg_advisory_xact_lock')
  })
})
