import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalMetricsService, type Query } from '../../src/services/ApprovalMetricsService'

/**
 * Wave 2 WP5 follow-up — unit coverage for the persistent breach-notify
 * dedupe primitives `listBreachesPendingNotification` and
 * `markBreachNotified`. SQL is asserted via shape so the partial-index
 * predicate stays honoured if anyone refactors the WHERE clause.
 */

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

describe('ApprovalMetricsService persistent breach dedupe', () => {
  let queryMock: ReturnType<typeof vi.fn>
  let service: ApprovalMetricsService

  beforeEach(() => {
    queryMock = vi.fn()
    service = new ApprovalMetricsService(queryMock as unknown as Query)
  })

  describe('listBreachesPendingNotification', () => {
    it('selects unnotified breached rows ordered by oldest sla_breached_at', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ instance_id: 'apr-1' }, { instance_id: 'apr-2' }],
      })

      const ids = await service.listBreachesPendingNotification(50)

      expect(ids).toEqual(['apr-1', 'apr-2'])
      expect(queryMock).toHaveBeenCalledTimes(1)
      const [sql, params] = queryMock.mock.calls[0]
      const flat = normalize(sql)
      expect(flat).toContain('FROM approval_metrics')
      expect(flat).toContain('sla_breached = TRUE')
      expect(flat).toContain('breach_notified_at IS NULL')
      expect(flat).toContain('ORDER BY sla_breached_at NULLS FIRST, started_at ASC')
      expect(flat).toContain('LIMIT $1')
      expect(params).toEqual([50])
    })

    it('clamps the limit into the safe [1, 1000] window', async () => {
      queryMock.mockResolvedValue({ rows: [] })
      await service.listBreachesPendingNotification(0)
      expect(queryMock.mock.calls[0][1]).toEqual([1])
      queryMock.mockClear()

      await service.listBreachesPendingNotification(5_000)
      expect(queryMock.mock.calls[0][1]).toEqual([1000])
      queryMock.mockClear()

      await service.listBreachesPendingNotification(undefined as unknown as number)
      expect(queryMock.mock.calls[0][1]).toEqual([200])
    })

    it('returns an empty list when the query returns no rows', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] })
      const ids = await service.listBreachesPendingNotification()
      expect(ids).toEqual([])
    })
  })

  describe('markBreachNotified', () => {
    it('updates only rows whose breach_notified_at is currently NULL', async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 2 })
      const stamp = new Date('2026-04-26T12:34:56Z')

      await service.markBreachNotified(['apr-1', 'apr-2'], stamp)

      expect(queryMock).toHaveBeenCalledTimes(1)
      const [sql, params] = queryMock.mock.calls[0]
      const flat = normalize(sql)
      expect(flat).toContain('UPDATE approval_metrics')
      expect(flat).toContain('SET breach_notified_at = $2')
      expect(flat).toContain('WHERE instance_id = ANY($1::text[])')
      expect(flat).toContain('AND breach_notified_at IS NULL')
      expect(params[0]).toEqual(['apr-1', 'apr-2'])
      expect(params[1]).toBe('2026-04-26T12:34:56.000Z')
    })

    it('is a no-op when given an empty id list', async () => {
      await service.markBreachNotified([])
      expect(queryMock).not.toHaveBeenCalled()
    })

    it('is a no-op when given a non-array', async () => {
      await service.markBreachNotified(undefined as unknown as string[])
      expect(queryMock).not.toHaveBeenCalled()
    })

    it('uses the current time when no notifiedAt is supplied', async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 })
      const before = Date.now()
      await service.markBreachNotified(['apr-1'])
      const after = Date.now()

      const stampMs = Date.parse(queryMock.mock.calls[0][1][1])
      expect(stampMs).toBeGreaterThanOrEqual(before)
      expect(stampMs).toBeLessThanOrEqual(after)
    })
  })
})
