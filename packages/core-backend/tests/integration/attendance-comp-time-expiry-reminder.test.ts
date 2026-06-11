import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'

import {
  CompTimeExpiryReminderService,
  type CompTimeExpiryReminderQuery,
} from '../../src/services/CompTimeExpiryReminderService'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

async function requireTable(pool: Pool, tableName: string): Promise<void> {
  const tableCheck = await pool.query(`SELECT to_regclass(current_schema() || '.' || $1) AS name`, [tableName])
  if (!tableCheck.rows[0]?.name) {
    throw new Error(`Integration database is missing ${tableName}; run core-backend migrations before executing this suite.`)
  }
}

describeDb('C5-1b comp-time expiry reminder producer (real DB)', () => {
  let pool: Pool
  let serviceQuery: CompTimeExpiryReminderQuery

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl })
    serviceQuery = async (sql, params) => {
      const r = await pool.query(sql, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
  })

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
  })

  it('produces subject + owner/sub_owner delivery rows for in-window comp-time lots, skips non-candidates, and never mutates balances', async () => {
    const suffix = `ctexp${Date.now().toString(36)}`
    const org = `org-${suffix}`
    const subject = `u-expiring-${suffix}`
    const ownerActive = `u-owner-${suffix}`
    const subOwnerInactive = `u-subowner-inactive-${suffix}`
    const ownerMissing = `u-owner-missing-${suffix}`
    const groupId = randomUUID()
    const sourceId = (label: string) => `manual-${label}-${suffix}`
    const sourceKey = (label: string) => `manual:${label}:${suffix}`
    let inWindowBalanceId = ''
    let futureBalanceId = ''
    let nullExpiryBalanceId = ''
    let expiredBalanceId = ''
    let nonCompBalanceId = ''
    let exhaustedBalanceId = ''

    const seedUser = (uid: string, active = true) =>
      pool.query(
        `INSERT INTO users (id, email, password_hash, name, role, is_active)
         VALUES ($1,$2,'hash',$3,'user',$4)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
        [uid, `${uid}@example.test`, uid, active],
      )

    const insertBalance = async (label: string, leaveType: string, remaining: number, expiresAt: string | null, status = 'active') => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_id, source_key, expires_at, status)
         VALUES ($1,$2,$3,120,$4,'manual_grant',$5,$6,$7::timestamptz,$8)
         RETURNING id::text AS id`,
        [org, subject, leaveType, remaining, sourceId(label), sourceKey(label), expiresAt, status],
      )
      return result.rows[0].id
    }

    try {
      await requireTable(pool, 'attendance_leave_balances')
      await requireTable(pool, 'attendance_notification_deliveries')
      await requireTable(pool, 'attendance_group_managers')

      await seedUser(subject)
      await seedUser(ownerActive)
      await seedUser(subOwnerInactive, false)
      await pool.query(
        `INSERT INTO attendance_groups (id, org_id, name, attendance_type)
         VALUES ($1,$2,'expiry-reminder-group','scheduled_shift')`,
        [groupId, org],
      )
      await pool.query(
        `INSERT INTO attendance_group_members (id, org_id, group_id, user_id)
         VALUES ($1,$2,$3,$4)`,
        [randomUUID(), org, groupId, subject],
      )
      await pool.query(
        `INSERT INTO attendance_group_managers (id, org_id, group_id, user_id, role) VALUES
           ($1,$5,$4,$6,'owner'),
           ($2,$5,$4,$7,'sub_owner'),
           ($3,$5,$4,$8,'owner')`,
        [randomUUID(), randomUUID(), randomUUID(), groupId, org, ownerActive, subOwnerInactive, ownerMissing],
      )

      inWindowBalanceId = await insertBalance('in-window', 'comp_time', 120, '2026-07-04T12:00:00.000Z')
      futureBalanceId = await insertBalance('future', 'comp_time', 120, '2026-07-20T12:00:00.000Z')
      nullExpiryBalanceId = await insertBalance('null-expiry', 'comp_time', 120, null)
      expiredBalanceId = await insertBalance('expired', 'comp_time', 120, '2026-06-30T12:00:00.000Z')
      nonCompBalanceId = await insertBalance('non-comp', 'annual_leave', 120, '2026-07-04T12:00:00.000Z')
      exhaustedBalanceId = await insertBalance('exhausted', 'comp_time', 0, '2026-07-04T12:00:00.000Z', 'exhausted')

      const svc = new CompTimeExpiryReminderService({
        query: serviceQuery,
        now: () => new Date('2026-07-01T00:00:00.000Z'),
        lookaheadDays: 7,
      })

      const candidates = await svc.scanCandidates()
      const mine = candidates.filter((candidate) => candidate.orgId === org)
      expect(mine).toEqual([expect.objectContaining({
        balanceId: inWindowBalanceId,
        userId: subject,
        windowDate: '2026-07-04',
        remainingMinutes: 120,
      })])

      const firstRun = await svc.run()
      expect(firstRun.deliveries).toBeGreaterThanOrEqual(4)

      const deliveryRows = async (balanceId: string) => (await pool.query(
        `SELECT *
           FROM attendance_notification_deliveries
          WHERE org_id = $1
            AND source_type = 'comp_time_expiry_reminder'
            AND source_id = $2
          ORDER BY recipient_user_id`,
        [org, balanceId],
      )).rows
      const deliveries = await deliveryRows(inWindowBalanceId)
      expect(deliveries).toHaveLength(4)
      const byRecipient = new Map(deliveries.map((row) => [row.recipient_user_id, row]))
      expect(byRecipient.get(subject)).toMatchObject({
        recipient_role: 'subject',
        channel: 'dingtalk_work_notification',
        status: 'pending',
        last_error: null,
      })
      expect(byRecipient.get(ownerActive)).toMatchObject({
        recipient_role: 'owner',
        channel: 'dingtalk_work_notification',
        status: 'pending',
        last_error: null,
      })
      expect(byRecipient.get(subOwnerInactive)).toMatchObject({
        recipient_role: 'sub_owner',
        status: 'skipped',
        last_error: 'recipient_inactive_or_missing',
      })
      expect(byRecipient.get(ownerMissing)).toMatchObject({
        recipient_role: 'owner',
        status: 'skipped',
        last_error: 'recipient_inactive_or_missing',
      })
      const subjectPayload = parsePayload(byRecipient.get(subject)?.payload)
      expect(subjectPayload).toMatchObject({
        kind: 'comp_time_expiry_reminder',
        balanceId: inWindowBalanceId,
        sourceType: 'comp_time_expiry_reminder',
        subjectUserId: subject,
        recipientUserId: subject,
        recipientRole: 'subject',
        windowDate: '2026-07-04',
        remainingMinutes: 120,
      })
      const ownerPayload = parsePayload(byRecipient.get(ownerActive)?.payload)
      expect(ownerPayload.recipientRoles).toEqual(['owner'])
      expect(ownerPayload.groupIds).toEqual([groupId])

      for (const skipped of [futureBalanceId, nullExpiryBalanceId, expiredBalanceId, nonCompBalanceId, exhaustedBalanceId]) {
        expect(await deliveryRows(skipped)).toHaveLength(0)
      }

      const beforeRepeat = await deliveryRows(inWindowBalanceId)
      await svc.run()
      expect(await deliveryRows(inWindowBalanceId)).toHaveLength(beforeRepeat.length)

      const balance = (await pool.query(
        `SELECT remaining_minutes, status, expires_at::text AS expires_at
           FROM attendance_leave_balances
          WHERE id = $1`,
        [inWindowBalanceId],
      )).rows[0]
      expect(Number(balance.remaining_minutes)).toBe(120)
      expect(balance.status).toBe('active')
      expect(balance.expires_at).toBeTruthy()
    } finally {
      await pool.query('DELETE FROM attendance_notification_deliveries WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [subject]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [subject]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_group_managers WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_group_members WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_groups WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[subject, ownerActive, subOwnerInactive]]).catch(() => undefined)
    }
  })
})

function parsePayload(value: unknown): Record<string, unknown> {
  return typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>
}
