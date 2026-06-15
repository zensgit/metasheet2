import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'

import { AttendanceExpiryService } from '../../src/services/AttendanceExpiryService'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeWithDb = dbUrl ? describe : describe.skip

async function requireTable(pool: Pool, tableName: string): Promise<void> {
  const tableCheck = await pool.query('SELECT to_regclass($1) AS name', [`public.${tableName}`])
  if (!tableCheck.rows[0]?.name) {
    throw new Error(`Attendance expiry integration database is missing ${tableName}; run migrations first.`)
  }
}

describeWithDb('AttendanceExpiryService (④ C4-1)', () => {
  it('expires active lots once and leaves NULL, future, and spent lots untouched', async () => {
    const pool = new Pool({ connectionString: dbUrl })
    const service = new AttendanceExpiryService(async <T = unknown>(sql, params = []) => {
      const result = await pool.query<T>(sql, params)
      return { rows: result.rows, rowCount: result.rowCount }
    })
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-c4-expiry-${runSuffix}`
    const source = (tag: string) => `c4-expiry:${runSuffix}:${tag}`
    const lotIds: Record<string, string> = {}

    const insertLot = async (tag: string, options: {
      amount: number
      remaining: number
      status: 'active' | 'exhausted'
      expiresAt: string | null
    }): Promise<string> => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, expires_at)
         VALUES ('default', $1, 'comp_time', $2, $3, 'manual_grant', $4, $5, $6)
         RETURNING id`,
        [userId, options.amount, options.remaining, source(tag), options.status, options.expiresAt],
      )
      return inserted.rows[0].id
    }

    try {
      await requireTable(pool, 'attendance_leave_balances')
      await requireTable(pool, 'attendance_leave_balance_events')

      lotIds.expiredA = await insertLot('expired-a', {
        amount: 120,
        remaining: 90,
        status: 'active',
        expiresAt: '2000-01-01T00:00:00Z',
      })
      lotIds.expiredB = await insertLot('expired-b', {
        amount: 60,
        remaining: 45,
        status: 'active',
        expiresAt: '2000-01-02T00:00:00Z',
      })
      lotIds.nullExpiry = await insertLot('null-expiry', {
        amount: 80,
        remaining: 80,
        status: 'active',
        expiresAt: null,
      })
      lotIds.futureExpiry = await insertLot('future-expiry', {
        amount: 70,
        remaining: 70,
        status: 'active',
        expiresAt: '2099-01-01T00:00:00Z',
      })
      lotIds.exhaustedPast = await insertLot('exhausted-past', {
        amount: 50,
        remaining: 0,
        status: 'exhausted',
        expiresAt: '2000-01-03T00:00:00Z',
      })

      const first = await service.expireCompTimeBalances()
      expect(first.map(row => ({ balanceId: row.balanceId, expiredMinutes: row.expiredMinutes })).sort((a, b) => a.balanceId.localeCompare(b.balanceId))).toEqual(
        [
          { balanceId: lotIds.expiredA, expiredMinutes: 90 },
          { balanceId: lotIds.expiredB, expiredMinutes: 45 },
        ].sort((a, b) => a.balanceId.localeCompare(b.balanceId)),
      )

      const lots = await pool.query<{ id: string; remaining_minutes: number; status: string }>(
        `SELECT id, remaining_minutes, status
           FROM attendance_leave_balances
          WHERE user_id = $1`,
        [userId],
      )
      const byId = new Map(lots.rows.map(row => [row.id, row]))
      expect(byId.get(lotIds.expiredA)).toMatchObject({ remaining_minutes: 0, status: 'expired' })
      expect(byId.get(lotIds.expiredB)).toMatchObject({ remaining_minutes: 0, status: 'expired' })
      expect(byId.get(lotIds.nullExpiry)).toMatchObject({ remaining_minutes: 80, status: 'active' })
      expect(byId.get(lotIds.futureExpiry)).toMatchObject({ remaining_minutes: 70, status: 'active' })
      expect(byId.get(lotIds.exhaustedPast)).toMatchObject({ remaining_minutes: 0, status: 'exhausted' })

      const events = await pool.query<{ balance_id: string; event_type: string; delta_minutes: number; source_type: string | null }>(
        `SELECT balance_id, event_type, delta_minutes, source_type
           FROM attendance_leave_balance_events
          WHERE user_id = $1
          ORDER BY balance_id`,
        [userId],
      )
      expect(events.rows.map(row => ({
        balanceId: row.balance_id,
        eventType: row.event_type,
        deltaMinutes: Number(row.delta_minutes),
        sourceType: row.source_type,
      }))).toEqual(
        [
          { balanceId: lotIds.expiredA, eventType: 'expire', deltaMinutes: -90, sourceType: 'comp_time_expiry' },
          { balanceId: lotIds.expiredB, eventType: 'expire', deltaMinutes: -45, sourceType: 'comp_time_expiry' },
        ].sort((a, b) => a.balanceId.localeCompare(b.balanceId)),
      )

      const second = await service.expireCompTimeBalances()
      expect(second).toEqual([])
      const eventCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM attendance_leave_balance_events
          WHERE user_id = $1 AND event_type = 'expire'`,
        [userId],
      )
      expect(eventCount.rows[0].count).toBe('2')
    } finally {
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })

  it('derives the expire event source_type per leave_type_code (年假 L1, #2622): annual -> annual_leave_expiry, others -> {type}_expiry', async () => {
    const pool = new Pool({ connectionString: dbUrl })
    const service = new AttendanceExpiryService(async <T = unknown>(sql, params = []) => {
      const result = await pool.query<T>(sql, params)
      return { rows: result.rows, rowCount: result.rowCount }
    })
    const runSuffix = Date.now().toString(36)
    const userId = `attendance-l1-expiry-source-${runSuffix}`
    const lotIds: Record<string, string> = {}
    const insertLot = async (tag: string, leaveTypeCode: string): Promise<string> => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, expires_at)
         VALUES ('default', $1, $2, 480, 480, 'manual_grant', $3, 'active', '2000-01-01T00:00:00Z')
         RETURNING id`,
        [userId, leaveTypeCode, `l1-expiry:${runSuffix}:${tag}`],
      )
      return inserted.rows[0].id
    }

    try {
      await requireTable(pool, 'attendance_leave_balances')
      await requireTable(pool, 'attendance_leave_balance_events')

      lotIds.annual = await insertLot('annual', 'annual')
      lotIds.compTime = await insertLot('comp', 'comp_time')
      lotIds.sick = await insertLot('sick', 'sick')

      const expired = await service.expireCompTimeBalances()
      expect(expired.map(row => row.balanceId).sort()).toEqual([lotIds.annual, lotIds.compTime, lotIds.sick].sort())

      const events = await pool.query<{ balance_id: string; source_type: string | null; delta_minutes: number; event_type: string }>(
        `SELECT balance_id, source_type, delta_minutes, event_type
           FROM attendance_leave_balance_events
          WHERE user_id = $1`,
        [userId],
      )
      const sourceByLot = new Map(events.rows.map(row => [row.balance_id, row.source_type]))
      // comp_time stays comp_time_expiry (no-regress); annual derives annual_leave_expiry; any other
      // leave type derives {leave_type_code}_expiry (the CASE ELSE branch).
      expect(sourceByLot.get(lotIds.compTime)).toBe('comp_time_expiry')
      expect(sourceByLot.get(lotIds.annual)).toBe('annual_leave_expiry')
      expect(sourceByLot.get(lotIds.sick)).toBe('sick_expiry')
      expect(events.rows.every(row => row.event_type === 'expire' && Number(row.delta_minutes) === -480)).toBe(true)
    } finally {
      await pool.query('DELETE FROM attendance_leave_balance_events WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_leave_balances WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })
})
