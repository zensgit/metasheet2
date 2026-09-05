import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock, warnMock, infoMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  warnMock: vi.fn(),
  infoMock: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: {},
  query: queryMock,
}))

// Mirrors tests/unit/audit-wrapper.test.ts's stub — lets us assert on logger.warn without
// pulling in the real winston transport.
vi.mock('../../src/core/logger', () => ({
  Logger: class {
    warn = warnMock
    info = infoMock
    error = vi.fn()
    debug = vi.fn()
  },
}))

import { AuditRepository } from '../../src/audit/AuditRepository'
import { startAuditLogPartitionEnsure } from '../../src/audit/audit-partition-schedule'

describe('AuditRepository#ensurePartitionsForCurrentAndNextMonth', () => {
  beforeEach(() => {
    queryMock.mockReset()
    warnMock.mockReset()
    infoMock.mockReset()
  })

  it('ensures current AND next month partitions in one query, reusing the advisory-lock/PARTITION OF scheme', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const repository = new AuditRepository()
    await expect(repository.ensurePartitionsForCurrentAndNextMonth()).resolves.toBe(true)

    expect(queryMock).toHaveBeenCalledTimes(1)
    const sql = String(queryMock.mock.calls[0][0])
    // Current AND next month names are both constructed in the same statement.
    expect(sql).toContain("current_partition_name TEXT := 'audit_logs_'")
    expect(sql).toContain("next_partition_name TEXT := 'audit_logs_'")
    expect(sql).toContain("DATE_TRUNC('month', CURRENT_DATE)")
    expect(sql).toContain("DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'")
    // Same advisory-lock namespace and idempotent DDL shape as ensureCurrentMonthPartition.
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('audit_logs_partition')")
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs')
    // Two idempotent DDL statements, one transaction (single DO block).
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2)
    expect(sql.match(/pg_advisory_xact_lock/g)).toHaveLength(2)
  })

  it('never throws on query failure: returns false and logs one warning without leaking connection details', async () => {
    const error = Object.assign(new Error('connection to server at "10.0.0.5" failed'), { code: 'ECONNREFUSED' })
    queryMock.mockRejectedValueOnce(error)

    const repository = new AuditRepository()
    await expect(repository.ensurePartitionsForCurrentAndNextMonth()).resolves.toBe(false)

    expect(warnMock).toHaveBeenCalledTimes(1)
    const [message] = warnMock.mock.calls[0]
    expect(message).not.toContain('10.0.0.5')
  })
})

describe('startAuditLogPartitionEnsure (AUDIT_LOG_PARTITION_ENSURE startup hook)', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    warnMock.mockReset()
    infoMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("mode 'off' (default) issues zero queries", async () => {
    const stop = startAuditLogPartitionEnsure({ mode: 'off' })
    await Promise.resolve()

    expect(queryMock).not.toHaveBeenCalled()
    stop()
  })

  it('defaults to off when AUDIT_LOG_PARTITION_ENSURE is unset', async () => {
    delete process.env.AUDIT_LOG_PARTITION_ENSURE
    const stop = startAuditLogPartitionEnsure()
    await Promise.resolve()

    expect(queryMock).not.toHaveBeenCalled()
    stop()
  })

  it("mode 'startup' ensures exactly once and never schedules a recurring timer", async () => {
    const stop = startAuditLogPartitionEnsure({ mode: 'startup' })
    await Promise.resolve()
    await Promise.resolve()

    expect(queryMock).toHaveBeenCalledTimes(1)
    const sql = String(queryMock.mock.calls[0][0])
    expect(sql).toContain('audit_logs_partition')
    expect(sql).toContain('PARTITION OF audit_logs')

    stop()
  })

  it("mode 'daily' ensures once at start, then again after 24h via a fake timer", async () => {
    vi.useFakeTimers()
    try {
      const stop = startAuditLogPartitionEnsure({ mode: 'daily' })
      await vi.advanceTimersByTimeAsync(0) // flush the immediate ensure

      expect(queryMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(queryMock).toHaveBeenCalledTimes(2)

      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("mode 'daily' does not fire the recurring tick early (23h59m)", async () => {
    vi.useFakeTimers()
    try {
      const stop = startAuditLogPartitionEnsure({ mode: 'daily' })
      await vi.advanceTimersByTimeAsync(0)
      expect(queryMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1)
      expect(queryMock).toHaveBeenCalledTimes(1)

      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('startAuditLogPartitionEnsure — default-repository construction failure', () => {
  afterEach(() => {
    vi.doUnmock('../../src/db/pg')
    vi.resetModules()
  })

  // AuditRepository's constructor throws synchronously ("Database pool not initialized")
  // when the pg pool isn't ready yet (default param `pool!` with pool === null). That must
  // never propagate out of the startup hook. Reuses the SAME db/pg mock shape as every other
  // test in this file — just with `pool: null` instead of `pool: {}` — via vi.doMock +
  // vi.resetModules() + a dynamic import, so the real (unmocked) AuditRepository constructor
  // runs against a null pool and genuinely throws.
  it('never throws when constructing the default AuditRepository fails: warns once and returns a no-op stop function', async () => {
    vi.resetModules()
    vi.doMock('../../src/db/pg', () => ({ pool: null, query: queryMock }))

    const { startAuditLogPartitionEnsure: freshStart } = await import('../../src/audit/audit-partition-schedule')

    queryMock.mockReset()
    warnMock.mockReset()
    infoMock.mockReset()

    let stop: (() => void) | undefined
    expect(() => {
      stop = freshStart({ mode: 'startup' })
    }).not.toThrow()

    expect(typeof stop).toBe('function')
    expect(queryMock).not.toHaveBeenCalled()
    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(String(warnMock.mock.calls[0][0])).toContain('repository unavailable')

    stop?.()
  })
})
