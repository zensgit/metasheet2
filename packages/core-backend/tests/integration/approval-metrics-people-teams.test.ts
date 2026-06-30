import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { ApprovalMetricsService } from '../../src/services/ApprovalMetricsService'

/**
 * T2-3 person/team analytics — real-DB proof that the new requester/department
 * aggregations read the actual `approval_instances.requester_snapshot` JSONB through
 * real SQL (FROM approval_metrics m LEFT JOIN approval_instances i), not a hand-built
 * fixture. DATABASE_URL-gated; the sentinel makes a silent skip impossible to mistake
 * for a pass. The seed sets `directoryDepartment` but deliberately NOT `department`,
 * so a regression that reads `->>'department'` instead of the COALESCE would drop the
 * Engineering bucket → RED (the wire-vs-fixture drift this test exists to catch).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const TENANT = `t23-tenant-${TS}`
const INSTANCE = `t23-inst-${TS}`

describeIfDatabase('ApprovalMetricsService person/team analytics (T2-3, real DB)', () => {
  const svc = new ApprovalMetricsService()

  beforeAll(async () => {
    await query(
      `INSERT INTO approval_instances (id, status, source_system, requester_snapshot)
       VALUES ($1, 'approved', 'platform', $2::jsonb)`,
      [INSTANCE, JSON.stringify({ id: 'u-1', name: 'Alice', directoryDepartment: 'Engineering' })],
    )
    await query(
      `INSERT INTO approval_metrics (instance_id, tenant_id, started_at, terminal_state, duration_seconds)
       VALUES ($1, $2, now(), 'approved', 120)`,
      [INSTANCE, TENANT],
    )
  })

  afterAll(async () => {
    await query('DELETE FROM approval_metrics WHERE instance_id = $1', [INSTANCE]).catch(() => {})
    await query('DELETE FROM approval_instances WHERE id = $1', [INSTANCE]).catch(() => {})
  })

  it('sentinel: DATABASE_URL set (DB lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('groups by the requester department via directoryDepartment (real JSONB snapshot)', async () => {
    const rows = await svc.getMetricsByDepartment({ tenantId: TENANT })
    const eng = rows.find((r) => r.key === 'Engineering')
    expect(eng, 'an Engineering bucket read from requester_snapshot->>directoryDepartment').toBeTruthy()
    expect(eng).toMatchObject({ key: 'Engineering', name: 'Engineering', total: 1, approved: 1 })
  })

  it('groups by the requester (person)', async () => {
    const rows = await svc.getMetricsByRequester({ tenantId: TENANT })
    const alice = rows.find((r) => r.key === 'u-1')
    expect(alice).toMatchObject({ key: 'u-1', name: 'Alice', total: 1, approved: 1 })
  })
})
