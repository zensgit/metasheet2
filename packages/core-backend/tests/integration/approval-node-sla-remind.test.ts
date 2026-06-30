import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { ApprovalMetricsService } from '../../src/services/ApprovalMetricsService'
import {
  ApprovalSlaScheduler,
  type ApprovalNodeTimeoutReminder,
} from '../../src/services/ApprovalSlaScheduler'

/**
 * T1-1 node-level SLA (slice 1: `remind`) — real-DB proof of the scanner remind path and the
 * activation-stamp idempotency invariant (P1a). The unit suite hand-feeds metrics; this asserts the
 * real SQL wire: an overdue `current_node_deadline_at` row → resolve active assignees → reminder
 * dispatched ONCE → `markNodeTimeoutFired` clears the deadline so the next scan is empty.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const SHOT_INSTANCE = `node-sla-shot-${TS}`
const SHOT_ASSIGNEE = `node-sla-approver-${TS}`
const IDEM_INSTANCE = `node-sla-idem-${TS}`

function rawQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return poolManager.get().query<T>(sql, params) as unknown as Promise<{ rows: T[]; rowCount?: number | null }>
}

async function seedInstance(id: string, currentNodeKey: string | null): Promise<void> {
  await rawQuery(
    `INSERT INTO approval_instances (id, status, current_node_key)
     VALUES ($1, 'pending', $2)
     ON CONFLICT (id) DO NOTHING`,
    [id, currentNodeKey],
  )
}

describeIfDatabase('approval node-level SLA remind (T1-1 slice 1) — real DB', () => {
  beforeAll(async () => {
    await ensureApprovalSchemaReady()
  })

  afterAll(async () => {
    // CASCADE from approval_instances clears approval_metrics + approval_assignments.
    await rawQuery(`DELETE FROM approval_instances WHERE id = ANY($1)`, [[SHOT_INSTANCE, IDEM_INSTANCE]])
  })

  it('has DATABASE_URL configured (sentinel — never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('(a) single-shot: an overdue remind row notifies active assignees once, then the scan is empty', async () => {
    const metrics = new ApprovalMetricsService(rawQuery)

    await seedInstance(SHOT_INSTANCE, 'approval_1')
    // An open node_breakdown entry + an overdue deadline (1 min in the past), effect remind, no SLA so
    // the breach scan in tick() leaves this row alone.
    await rawQuery(
      `INSERT INTO approval_metrics
         (instance_id, template_id, tenant_id, started_at, sla_hours, node_breakdown,
          current_node_deadline_at, current_node_timeout_effect)
       VALUES ($1, NULL, 'default', now() - INTERVAL '10 minutes', NULL, $2::jsonb,
               now() - INTERVAL '1 minute', 'remind')`,
      [
        SHOT_INSTANCE,
        JSON.stringify([
          { nodeKey: 'approval_1', activatedAt: new Date(Date.now() - 600_000).toISOString(), decidedAt: null, durationSeconds: null, approverIds: [] },
        ]),
      ],
    )
    await rawQuery(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, is_active)
       VALUES ($1, 'user', $2, TRUE)`,
      [SHOT_INSTANCE, SHOT_ASSIGNEE],
    )

    const reminders: ApprovalNodeTimeoutReminder[] = []
    const scheduler = new ApprovalSlaScheduler({
      metrics,
      pool: { query: rawQuery },
      onNodeReminder: async (reminder) => {
        reminders.push(reminder)
      },
    })

    await scheduler.tick(new Date())

    const forThisInstance = reminders.filter((r) => r.instanceId === SHOT_INSTANCE)
    expect(forThisInstance).toHaveLength(1)
    expect(forThisInstance[0].effect).toBe('remind')
    expect(forThisInstance[0].assigneeIds).toContain(SHOT_ASSIGNEE)

    // markNodeTimeoutFired cleared the deadline → a second scan must not return this instance.
    const due2 = await metrics.scanNodeTimeouts(new Date())
    expect(due2.find((d) => d.instanceId === SHOT_INSTANCE)).toBeUndefined()

    const deadlineRow = await rawQuery<{ current_node_deadline_at: unknown }>(
      `SELECT current_node_deadline_at FROM approval_metrics WHERE instance_id = $1`,
      [SHOT_INSTANCE],
    )
    expect(deadlineRow.rows[0]?.current_node_deadline_at).toBeNull()

    // A second tick fires no further reminder for this instance.
    await scheduler.tick(new Date())
    expect(reminders.filter((r) => r.instanceId === SHOT_INSTANCE)).toHaveLength(1)
  })

  it('(b) idempotency (P1a): re-activating an open node never overwrites the stamped deadline', async () => {
    const metrics = new ApprovalMetricsService(rawQuery)
    const D1 = new Date('2030-01-01T00:00:00.000Z')
    const D2 = new Date('2030-06-01T00:00:00.000Z')

    await seedInstance(IDEM_INSTANCE, 'approval_1')
    await metrics.recordInstanceStart({
      instanceId: IDEM_INSTANCE,
      templateId: null,
      startedAt: new Date(),
      slaHours: null,
      initialNodeKey: null,
    })

    // First activation of approval_1 → stamps D1 (no open entry yet → added).
    await metrics.recordNodeActivation({
      instanceId: IDEM_INSTANCE,
      nodeKey: 'approval_1',
      activatedAt: new Date(),
      timeoutDeadline: D1,
      timeoutEffect: 'remind',
    })
    // Re-activation of the SAME still-open node with a LATER deadline → no-op (open entry exists).
    await metrics.recordNodeActivation({
      instanceId: IDEM_INSTANCE,
      nodeKey: 'approval_1',
      activatedAt: new Date(),
      timeoutDeadline: D2,
      timeoutEffect: 'remind',
    })
    // Re-activation with NO timeout → must NOT clear the existing deadline (still an open entry).
    await metrics.recordNodeActivation({
      instanceId: IDEM_INSTANCE,
      nodeKey: 'approval_1',
      activatedAt: new Date(),
    })

    const row = await rawQuery<{ current_node_deadline_at: string | Date | null; current_node_timeout_effect: string | null }>(
      `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
      [IDEM_INSTANCE],
    )
    const stored = row.rows[0]?.current_node_deadline_at
    expect(stored).not.toBeNull()
    expect(new Date(stored as string | Date).getTime()).toBe(D1.getTime())
    expect(row.rows[0]?.current_node_timeout_effect).toBe('remind')
  })
})
