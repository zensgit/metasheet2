/**
 * §7.6 Delivery Closure — HTTP route-level tests for the OPERATOR-initiated redelivery endpoint
 * POST /api/attendance-admin/notification-deliveries/:deliveryId/redeliver (real DB).
 *
 * Proves the PR #4102 owner CHANGES-REQUESTED wiring end-to-end through Express:
 *   - FIX 2 platform-admin gate: an attendance:admin who is NOT a platform admin gets 403; a
 *     platform admin proceeds. `ensurePlatformAdmin` decides access via isRbacAdmin against REAL
 *     Postgres (no mock shadows the gate).
 *   - handler status mapping: 400 bad id / 409 not_eligible / 409 outcome_unknown / 200
 *     already_delivered / 200 requeued.
 *   - FIX 3 audit: ONE values-free audit row (operation=notification_redeliver, resource_id=the
 *     deliveryId, meta.redelivery = {org_id, channel, old_status, result}) with NO PII (recipient id
 *     / source_key never appear anywhere in the row).
 *
 * rbacGuard is stubbed to a pass-through so the test ISOLATES the new platform-admin gate (the thing
 * under review). The router-level attendance:admin guard is a separate, pre-existing control; it is
 * not the subject here, and — because `attendance` is a namespace-admission-controlled resource — a
 * token-only attendance:admin user would otherwise be rejected by rbacGuard's namespace check before
 * ever reaching ensurePlatformAdmin, defeating the point of the test. Load-bearing mutation (record
 * in PR body): removing the `if (!platformAdminId) return` early-return in the handler makes the 403
 * test go RED.
 *
 * DATABASE_URL-gated (describeIfDb): excluded from the no-DB vitest job so it cannot skip-green, and
 * wired as a WHOLE FILE into the `Run approval real-DB integration` step in plugin-tests.yml.
 */
import { randomUUID } from 'crypto'

import express from 'express'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub rbacGuard to pass-through; keep every other rbac export intact (the router graph pulls
// userHasPermission/isAdmin from this module).
vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})

import { pool } from '../../src/db/pg'
import { attendanceAdminRouter } from '../../src/routes/attendance-admin'
import { attendanceAuditMiddleware } from '../../src/middleware/attendance-production'
import { DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME } from '../../src/services/AttendanceNotificationDeliveryWorker'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool!.query(sql, params)

const ORG = `org_redeliver_route_${Date.now()}`
const RECIPIENT = 'recipient_pii_should_never_be_audited'

type SeedStatus = 'failed' | 'sent' | 'outcome_unknown'

// Mutable authenticated user for the fake auth middleware.
let currentUser: Record<string, unknown> | null = null

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = currentUser ?? undefined
  next()
})
app.use(attendanceAuditMiddleware())
app.use(attendanceAdminRouter())

async function seed(status: SeedStatus, opts: { channel?: string; redeliverySafe?: boolean; sourceKey?: string } = {}): Promise<string> {
  const sourceKey = opts.sourceKey ?? `sk_route_${randomUUID()}`
  const channel = opts.channel ?? DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
  const redeliverySafe = opts.redeliverySafe ?? (status === 'failed' && channel === DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
  const attemptCount = status === 'failed' ? 5 : status === 'outcome_unknown' ? 2 : 0
  const deliveredAt = status === 'sent' ? 'NOW()' : 'NULL'
  const res = await q(
    `INSERT INTO attendance_notification_deliveries
       (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel,
        status, attempt_count, redelivery_safe, next_attempt_at, last_error, delivered_at, payload)
     VALUES
       ($1, 'test', NULL, $2, $3, 'employee', $4, $5, $6, $7,
        NOW() - interval '1 hour',
        ${status === 'failed' ? "'boom: previous send failed'" : 'NULL'},
        ${deliveredAt}, '{}'::jsonb)
     RETURNING id::text AS id`,
    [ORG, sourceKey, RECIPIENT, channel, status, attemptCount, redeliverySafe],
  )
  return (res.rows[0] as { id: string }).id
}

async function pollAuditRow(deliveryId: string): Promise<{ resource_id: string; action: string; status_code: number; actor_id: string | null; meta: Record<string, unknown> } | null> {
  // The audit insert runs on res 'finish' AFTER supertest resolves — poll briefly for it.
  for (let i = 0; i < 40; i += 1) {
    const res = await q(
      `SELECT resource_id, action, status_code, actor_id, meta
         FROM operation_audit_logs
        WHERE resource_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [deliveryId],
    )
    if (res.rows.length > 0) {
      return res.rows[0] as { resource_id: string; action: string; status_code: number; actor_id: string | null; meta: Record<string, unknown> }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

describeIfDb('§7.6 — attendance notification redelivery route (platform-admin gate, real DB)', () => {
  beforeEach(() => {
    currentUser = null
  })

  afterAll(async () => {
    await q(`DELETE FROM operation_audit_logs WHERE resource_type = 'attendance' AND actor_id IN ('platform-admin-1','att-admin-not-platform')`).catch(() => {})
    await q(`DELETE FROM attendance_notification_deliveries WHERE org_id = $1`, [ORG]).catch(() => {})
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('403: an attendance:admin who is NOT a platform admin is refused (platform-admin gate)', async () => {
    // Passes the (stubbed) attendance:admin router guard, but is not a platform admin: isRbacAdmin is
    // consulted against real Postgres and this id has no admin role → 403 FORBIDDEN.
    currentUser = { id: 'att-admin-not-platform', permissions: ['attendance:admin'] }
    const id = await seed('failed', { redeliverySafe: true })

    const res = await request(app)
      .post(`/api/attendance-admin/notification-deliveries/${id}/redeliver`)
      .send({})

    expect(res.status).toBe(403)
    // The row was NOT requeued (gate blocked before the mutation).
    const row = await q(`SELECT status FROM attendance_notification_deliveries WHERE id = $1::uuid`, [id])
    expect((row.rows[0] as { status: string }).status).toBe('failed')
  })

  it('400: a bad (non-UUID) deliveryId is rejected', async () => {
    currentUser = { id: 'platform-admin-1', role: 'admin' }
    const res = await request(app)
      .post('/api/attendance-admin/notification-deliveries/not-a-uuid/redeliver')
      .send({})
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('DELIVERY_ID_INVALID')
  })

  it('409: a historical DingTalk failure (redelivery_safe=false) is not_eligible', async () => {
    currentUser = { id: 'platform-admin-1', role: 'admin' }
    const id = await seed('failed', { redeliverySafe: false })
    const res = await request(app)
      .post(`/api/attendance-admin/notification-deliveries/${id}/redeliver`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('DELIVERY_NOT_ELIGIBLE')
  })

  it('409: an outcome_unknown row is refused (never resent)', async () => {
    currentUser = { id: 'platform-admin-1', role: 'admin' }
    const id = await seed('outcome_unknown')
    const res = await request(app)
      .post(`/api/attendance-admin/notification-deliveries/${id}/redeliver`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('DELIVERY_OUTCOME_UNKNOWN')
  })

  it('200: an already-sent row is an idempotent no-op (already_delivered)', async () => {
    currentUser = { id: 'platform-admin-1', role: 'admin' }
    const id = await seed('sent')
    const res = await request(app)
      .post(`/api/attendance-admin/notification-deliveries/${id}/redeliver`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body?.data?.outcome).toBe('already_delivered')
  })

  it('200: a definite DingTalk failure is requeued AND a values-free, PII-free audit row is written', async () => {
    currentUser = { id: 'platform-admin-1', role: 'admin' }
    const sourceKey = `sk_route_audit_${randomUUID()}`
    const id = await seed('failed', { redeliverySafe: true, sourceKey })

    const res = await request(app)
      .post(`/api/attendance-admin/notification-deliveries/${id}/redeliver`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body?.data?.outcome).toBe('requeued')
    expect(res.body?.data?.status).toBe('pending')

    const audit = await pollAuditRow(id)
    expect(audit).not.toBeNull()
    // resource_id keyed to the exact row acted on.
    expect(audit?.resource_id).toBe(id)
    expect(audit?.status_code).toBe(200)
    expect(audit?.actor_id).toBe('platform-admin-1')

    const meta = audit?.meta ?? {}
    expect(meta.operation).toBe('notification_redeliver')
    const redelivery = (meta.redelivery ?? {}) as Record<string, unknown>
    expect(redelivery.org_id).toBe(ORG)
    expect(redelivery.channel).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
    expect(redelivery.old_status).toBe('failed')
    expect(redelivery.result).toBe('requeued')

    // NO PII: neither the recipient id nor the source_key may appear ANYWHERE in the audit row
    // (columns or serialized meta).
    const serialized = JSON.stringify(audit)
    expect(serialized).not.toContain(RECIPIENT)
    expect(serialized).not.toContain(sourceKey)
  })
})
