import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalMetricsService, type Query, type TransactionRunner } from '../../src/services/ApprovalMetricsService'

/**
 * Unit coverage for ApprovalMetricsService — uses an injected mock `Query`
 * so no pg is required. Covers the happy paths + the small amount of
 * in-memory breakdown bookkeeping that the service owns.
 */

interface Row {
  node_breakdown: unknown
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

describe('ApprovalMetricsService', () => {
  let queryMock: ReturnType<typeof vi.fn>
  let service: ApprovalMetricsService

  beforeEach(() => {
    queryMock = vi.fn()
    service = new ApprovalMetricsService(queryMock as unknown as Query)
  })

  describe('recordInstanceStart', () => {
    it('inserts a metrics row with ON CONFLICT DO NOTHING', async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 })

      await service.recordInstanceStart({
        instanceId: 'apr-1',
        templateId: 'tmpl-1',
        tenantId: 'tenant-a',
        startedAt: new Date('2026-04-25T10:00:00Z'),
        slaHours: 24,
        initialNodeKey: 'approval_1',
      })

      expect(queryMock).toHaveBeenCalledTimes(1)
      const [sql, params] = queryMock.mock.calls[0]
      expect(normalize(sql)).toContain('INSERT INTO approval_metrics')
      expect(normalize(sql)).toContain('ON CONFLICT (instance_id) DO NOTHING')
      expect(params[0]).toBe('apr-1')
      expect(params[1]).toBe('tmpl-1')
      expect(params[2]).toBe('tenant-a')
      expect(params[3]).toBe('2026-04-25T10:00:00.000Z')
      expect(params[4]).toBe(24)
      const breakdown = JSON.parse(params[5])
      expect(breakdown).toHaveLength(1)
      expect(breakdown[0]).toMatchObject({ nodeKey: 'approval_1', decidedAt: null, approverIds: [] })
    })

    it('falls back to "default" tenant id when blank', async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 })

      await service.recordInstanceStart({
        instanceId: 'apr-2',
        templateId: null,
        tenantId: '   ',
        startedAt: new Date('2026-04-25T10:00:00Z'),
      })

      expect(queryMock.mock.calls[0][1][2]).toBe('default')
      expect(queryMock.mock.calls[0][1][5]).toBe('[]')
    })
  })

  describe('recordNodeActivation', () => {
    it('appends a new open entry (plus a separate deadline write) and re-emit is a no-op', async () => {
      // A NEW activation now issues three calls: SELECT current breakdown, the
      // breakdown UPDATE, then the T1-1 best-effort deadline UPDATE — the last
      // ONLY because a brand-new entry was added.
      queryMock
        .mockResolvedValueOnce({ rows: [{ node_breakdown: [] }] as Row[] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })

      await service.recordNodeActivation({
        instanceId: 'apr-1',
        nodeKey: 'approval_2',
        activatedAt: new Date('2026-04-25T11:00:00Z'),
      })

      expect(queryMock).toHaveBeenCalledTimes(3)
      const updatePayload = JSON.parse(queryMock.mock.calls[1][1][1])
      expect(updatePayload).toHaveLength(1)
      expect(updatePayload[0]).toMatchObject({ nodeKey: 'approval_2', decidedAt: null })
      // The deadline UPDATE is a SEPARATE best-effort write (NOT folded into the
      // breakdown transaction). With no timeout on this activation it CLEARS both
      // columns so the prior node's deadline can never linger on the new node.
      const [deadlineSql, deadlineParams] = queryMock.mock.calls[2]
      expect(normalize(deadlineSql)).toContain('UPDATE approval_metrics')
      expect(normalize(deadlineSql)).toContain('SET current_node_deadline_at = $2')
      expect(normalize(deadlineSql)).toContain('current_node_timeout_effect = $3')
      expect(deadlineParams).toEqual(['apr-1', null, null])

      // Re-emit with an existing open entry → mutate returns null, `added` stays
      // false → NO breakdown UPDATE and crucially NO deadline UPDATE (this is the
      // foundation's P1a idempotency guard locked at the unit level).
      queryMock.mockClear()
      queryMock.mockResolvedValueOnce({
        rows: [{ node_breakdown: [{ nodeKey: 'approval_2', activatedAt: 'x', decidedAt: null, durationSeconds: null, approverIds: [] }] }] as Row[],
      })
      await service.recordNodeActivation({
        instanceId: 'apr-1',
        nodeKey: 'approval_2',
        activatedAt: new Date('2026-04-25T11:05:00Z'),
      })
      // Only the SELECT (FOR UPDATE) ran — no deadline write was emitted.
      expect(queryMock).toHaveBeenCalledTimes(1)
      expect(normalize(queryMock.mock.calls[0][0])).toContain('FOR UPDATE')
    })

    it('stamps the new node deadline + effect when the activation carries a timeout (T1-1 lock)', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [{ node_breakdown: [] }] as Row[] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })

      const deadline = new Date('2026-04-25T15:00:00Z')
      await service.recordNodeActivation({
        instanceId: 'apr-1',
        nodeKey: 'approval_2',
        activatedAt: new Date('2026-04-25T11:00:00Z'),
        timeoutDeadline: deadline,
        timeoutEffect: 'auto_reject',
      })

      // SELECT + breakdown UPDATE + the separate deadline UPDATE.
      expect(queryMock).toHaveBeenCalledTimes(3)
      const [deadlineSql, deadlineParams] = queryMock.mock.calls[2]
      expect(normalize(deadlineSql)).toContain('UPDATE approval_metrics')
      expect(normalize(deadlineSql)).toContain('SET current_node_deadline_at = $2')
      expect(normalize(deadlineSql)).toContain('current_node_timeout_effect = $3')
      expect(deadlineParams).toEqual(['apr-1', '2026-04-25T15:00:00.000Z', 'auto_reject'])
    })

    it('returns silently when the instance has no metrics row', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] as Row[] })

      await service.recordNodeActivation({
        instanceId: 'unknown',
        nodeKey: 'approval_1',
        activatedAt: new Date(),
      })

      expect(queryMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('recordNodeDecision', () => {
    it('closes the open entry with a computed duration', async () => {
      queryMock
        .mockResolvedValueOnce({
          rows: [{
            node_breakdown: [
              { nodeKey: 'approval_1', activatedAt: '2026-04-25T10:00:00.000Z', decidedAt: null, durationSeconds: null, approverIds: [] },
            ],
          }] as Row[],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // T1-1: the separate deadline-clear UPDATE that follows the breakdown write.
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })

      await service.recordNodeDecision({
        instanceId: 'apr-1',
        nodeKey: 'approval_1',
        decidedAt: new Date('2026-04-25T10:30:00.000Z'),
        approverIds: ['u1'],
      })

      const breakdown = JSON.parse(queryMock.mock.calls[1][1][1])
      expect(breakdown[0]).toMatchObject({
        nodeKey: 'approval_1',
        decidedAt: '2026-04-25T10:30:00.000Z',
        durationSeconds: 1800,
        approverIds: ['u1'],
      })
    })

    it('runs read-modify-write breakdown updates inside the injected transaction runner', async () => {
      const calls: string[] = []
      const txQuery = vi.fn<Query>()
        .mockImplementation(async (sql) => {
          calls.push(normalize(sql).startsWith('SELECT node_breakdown') ? 'select' : 'update')
          if (normalize(sql).startsWith('SELECT node_breakdown')) {
            return {
              rows: [{
                node_breakdown: [
                  { nodeKey: 'approval_1', activatedAt: '2026-04-25T10:00:00.000Z', decidedAt: null, durationSeconds: null, approverIds: [] },
                ],
              }],
              rowCount: 1,
            }
          }
          return { rows: [], rowCount: 1 }
        })
      const transaction = vi.fn<TransactionRunner>(async (fn) => {
        calls.push('begin')
        const result = await fn(txQuery)
        calls.push('commit')
        return result
      })
      const serviceWithTransaction = new ApprovalMetricsService(queryMock as unknown as Query, transaction)

      await serviceWithTransaction.recordNodeDecision({
        instanceId: 'apr-1',
        nodeKey: 'approval_1',
        decidedAt: new Date('2026-04-25T10:30:00.000Z'),
        approverIds: ['u1'],
      })

      expect(transaction).toHaveBeenCalledTimes(1)
      // The breakdown read-modify-write stays fully inside the transaction…
      expect(calls).toEqual(['begin', 'select', 'update', 'commit'])
      expect(normalize(String(txQuery.mock.calls[0][0]))).toContain('FOR UPDATE')
      // …while the T1-1 deadline-clear is a SEPARATE best-effort write issued via
      // the plain (non-transactional) query runner — and it clears BOTH columns.
      expect(queryMock).toHaveBeenCalledTimes(1)
      const [clearSql, clearParams] = queryMock.mock.calls[0]
      expect(normalize(clearSql)).toContain('UPDATE approval_metrics')
      expect(normalize(clearSql)).toContain('current_node_deadline_at = NULL')
      expect(normalize(clearSql)).toContain('current_node_timeout_effect = NULL')
      expect(clearParams).toEqual(['apr-1'])
    })

    it('synthesizes a zero-duration entry when no matching open entry exists', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [{ node_breakdown: [] }] as Row[] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // T1-1: the separate deadline-clear UPDATE that follows the breakdown write.
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })

      await service.recordNodeDecision({
        instanceId: 'apr-1',
        nodeKey: 'approval_2',
        decidedAt: new Date('2026-04-25T11:00:00Z'),
        approverIds: ['u2'],
      })

      const breakdown = JSON.parse(queryMock.mock.calls[1][1][1])
      expect(breakdown).toHaveLength(1)
      expect(breakdown[0]).toMatchObject({ nodeKey: 'approval_2', activatedAt: null, durationSeconds: null })
    })
  })

  describe('recordTerminal', () => {
    it('issues a single UPDATE with duration computed in SQL', async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 })

      await service.recordTerminal({
        instanceId: 'apr-1',
        terminalState: 'approved',
        terminalAt: new Date('2026-04-25T12:00:00Z'),
      })

      const [sql, params] = queryMock.mock.calls[0]
      expect(normalize(sql)).toContain('UPDATE approval_metrics')
      expect(normalize(sql)).toContain('EXTRACT(EPOCH FROM ($2::timestamptz - started_at))')
      // T1-1: terminal also clears the node-timeout deadline columns in the SAME update.
      expect(normalize(sql)).toContain('current_node_deadline_at = NULL')
      expect(normalize(sql)).toContain('current_node_timeout_effect = NULL')
      expect(params[2]).toBe('approved')
    })
  })

  describe('checkSlaBreaches', () => {
    it('returns breached instance ids from the update', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ instance_id: 'apr-1' }, { instance_id: 'apr-9' }],
        rowCount: 2,
      })

      const now = new Date('2026-04-25T12:00:00Z')
      const breached = await service.checkSlaBreaches(now)

      expect(breached).toEqual(['apr-1', 'apr-9'])
      const [sql, params] = queryMock.mock.calls[0]
      expect(normalize(sql)).toContain(`sla_breached = TRUE`)
      expect(normalize(sql)).toContain(`started_at + (sla_hours * interval '1 hour') < $1`)
      expect(normalize(sql)).toContain(`RETURNING instance_id`)
      expect(params[0]).toBe('2026-04-25T12:00:00.000Z')
    })
  })

  describe('getMetricsSummary', () => {
    it('aggregates counts, percentiles, and per-template rows', async () => {
      queryMock
        .mockResolvedValueOnce({
          rows: [{
            total: '10',
            approved: '6',
            rejected: '2',
            revoked: '1',
            returned: '0',
            running: '1',
            avg_duration: '3600',
            p50_duration: '3600',
            p95_duration: '7200',
            sla_breach_count: '2',
            sla_candidate_count: '5',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            template_id: 'tmpl-1',
            total: '5',
            approved: '3',
            rejected: '1',
            revoked: '1',
            avg_duration: '1800',
            sla_breach_count: '1',
            sla_candidate_count: '2',
          }],
        })

      const summary = await service.getMetricsSummary({
        tenantId: 'tenant-a',
        since: '2026-04-01T00:00:00Z',
        until: '2026-04-30T00:00:00Z',
      })

      expect(summary).toMatchObject({
        total: 10,
        approved: 6,
        rejected: 2,
        revoked: 1,
        running: 1,
        avgDurationSeconds: 3600,
        p50DurationSeconds: 3600,
        p95DurationSeconds: 7200,
        slaBreachCount: 2,
        slaCandidateCount: 5,
        slaBreachRate: 0.4,
      })
      expect(summary.byTemplate).toHaveLength(1)
      expect(summary.byTemplate[0]).toMatchObject({
        templateId: 'tmpl-1',
        total: 5,
        approved: 3,
        slaBreachRate: 0.5,
      })
    })

    it('applies tenantId and date filters to both queries', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [{ total: '0', approved: '0', rejected: '0', revoked: '0', returned: '0', running: '0', avg_duration: null, p50_duration: null, p95_duration: null, sla_breach_count: '0', sla_candidate_count: '0' }] })
        .mockResolvedValueOnce({ rows: [] })

      await service.getMetricsSummary({ tenantId: 'tenant-z', since: new Date('2026-04-20Z'), until: new Date('2026-04-25Z') })

      for (const call of queryMock.mock.calls) {
        const sql = normalize(call[0])
        expect(sql).toContain('tenant_id = $1')
        expect(sql).toContain('started_at >= $2')
        expect(sql).toContain('started_at <= $3')
        expect(call[1][0]).toBe('tenant-z')
      }
    })
  })

  describe('getMetricsReport', () => {
    it('returns summary plus slowest instances and riskiest SLA templates', async () => {
      queryMock
        .mockResolvedValueOnce({
          rows: [{
            total: '2',
            approved: '1',
            rejected: '0',
            revoked: '0',
            returned: '0',
            running: '1',
            avg_duration: '3600',
            p50_duration: '3600',
            p95_duration: '7200',
            sla_breach_count: '1',
            sla_candidate_count: '2',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            template_id: 'tmpl-1',
            total: '2',
            approved: '1',
            rejected: '0',
            revoked: '0',
            avg_duration: '3600',
            sla_breach_count: '1',
            sla_candidate_count: '2',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            instance_id: 'apr-slow',
            template_id: 'tmpl-1',
            started_at: '2026-04-25T01:00:00Z',
            terminal_at: '2026-04-25T03:00:00Z',
            terminal_state: 'approved',
            duration_seconds: '7200',
            sla_hours: '1',
            sla_breached: true,
            sla_breached_at: '2026-04-25T02:05:00Z',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            template_id: 'tmpl-1',
            total: '2',
            sla_candidate_count: '2',
            sla_breach_count: '1',
            avg_duration: '3600',
            p95_duration: '7200',
          }],
        })

      const report = await service.getMetricsReport({
        tenantId: 'tenant-a',
        since: '2026-04-01T00:00:00Z',
        until: '2026-04-30T00:00:00Z',
        limit: 500,
      })

      expect(report.summary.total).toBe(2)
      expect(report.slowestInstances).toEqual([{
        instanceId: 'apr-slow',
        templateId: 'tmpl-1',
        startedAt: '2026-04-25T01:00:00Z',
        terminalAt: '2026-04-25T03:00:00Z',
        terminalState: 'approved',
        durationSeconds: 7200,
        slaHours: 1,
        slaBreached: true,
        slaBreachedAt: '2026-04-25T02:05:00Z',
      }])
      expect(report.breachedTemplates[0]).toMatchObject({
        templateId: 'tmpl-1',
        total: 2,
        slaCandidateCount: 2,
        slaBreachCount: 1,
        slaBreachRate: 0.5,
        avgDurationSeconds: 3600,
        p95DurationSeconds: 7200,
      })

      const slowestSql = normalize(queryMock.mock.calls[2][0])
      expect(slowestSql).toContain('duration_seconds IS NOT NULL')
      expect(slowestSql).toContain('ORDER BY duration_seconds DESC')
      expect(slowestSql).toContain('LIMIT $4')
      expect(queryMock.mock.calls[2][1]).toEqual([
        'tenant-a',
        '2026-04-01T00:00:00.000Z',
        '2026-04-30T00:00:00.000Z',
        50,
      ])

      const templatesSql = normalize(queryMock.mock.calls[3][0])
      expect(templatesSql).toContain('HAVING COUNT(*) FILTER (WHERE sla_hours IS NOT NULL) > 0')
      expect(templatesSql).toContain('sla_breached = TRUE')
      expect(templatesSql).toContain('LIMIT $4')
    })
  })

  describe('listActiveBreaches', () => {
    it('queries active breached rows ordered by breach time', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 'm1', instance_id: 'apr-1', template_id: 'tmpl-1', tenant_id: 'default',
            started_at: 'x', terminal_at: null, terminal_state: null, duration_seconds: null,
            sla_hours: 24, sla_breached: true, sla_breached_at: 'y', node_breakdown: [],
            created_at: 'x', updated_at: 'x',
          },
        ],
      })

      const rows = await service.listActiveBreaches({ tenantId: 'default', limit: 10 })

      expect(rows).toHaveLength(1)
      expect(rows[0].instance_id).toBe('apr-1')
      const sql = normalize(queryMock.mock.calls[0][0])
      expect(sql).toContain('sla_breached = TRUE')
      expect(sql).toContain('terminal_at IS NULL')
    })
  })

  describe('getInstanceMetrics', () => {
    it('returns the row when present', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{
          id: 'm1', instance_id: 'apr-1', template_id: null, tenant_id: 'default',
          started_at: 'x', terminal_at: null, terminal_state: null, duration_seconds: null,
          sla_hours: null, sla_breached: false, sla_breached_at: null, node_breakdown: [],
          created_at: 'x', updated_at: 'x',
        }],
      })

      const row = await service.getInstanceMetrics('apr-1')

      expect(row?.instance_id).toBe('apr-1')
      expect(Array.isArray(row?.node_breakdown)).toBe(true)
    })

    it('returns null when absent', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] })
      expect(await service.getInstanceMetrics('missing')).toBeNull()
    })
  })
})
