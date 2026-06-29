import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

type QueryCall = { sql: string, params: unknown[] }

function schemaMissingError(tableName: string) {
  return Object.assign(new Error(`relation "${tableName}" does not exist`), { code: '42P01' })
}

describe('attendance result edit helpers', () => {
  it('fails closed with 503 when the payroll cycle table is unavailable', async () => {
    const calls: QueryCall[] = []
    const trx = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params })
        if (sql.includes('FROM attendance_record_result_edits')) return []
        if (sql.includes('FROM attendance_records')) {
          return [{
            id: '11111111-1111-4111-8111-111111111111',
            user_id: 'user-1',
            org_id: 'org-1',
            work_date: '2026-06-25',
            status: 'late',
            is_workday: true,
            timezone: 'Asia/Shanghai',
            first_in_at: '2026-06-25T01:30:00.000Z',
            last_out_at: '2026-06-25T10:00:00.000Z',
            work_minutes: 480,
            late_minutes: 30,
            early_leave_minutes: 0,
            meta: {},
          }]
        }
        if (sql.includes('FROM attendance_payroll_cycles')) {
          throw schemaMissingError('attendance_payroll_cycles')
        }
        throw new Error(`unexpected query after payroll-cycle guard: ${sql}`)
      },
    }

    await expect(helpers.applyAttendanceResultEdit(trx, {
      orgId: 'org-1',
      recordId: '11111111-1111-4111-8111-111111111111',
      targetStatus: 'normal',
      overrideMetrics: null,
      reason: 'manual correction',
      evidence: [],
      actorUserId: 'admin-1',
      idempotencyKey: 'idem-1',
      editWindowDays: 180,
    })).rejects.toMatchObject({
      status: 503,
      code: 'DB_NOT_READY',
      message: 'payroll cycle table unavailable; result edit refused (fail-closed)',
    })

    expect(calls.map((call) => call.sql)).toHaveLength(3)
    expect(calls[2]?.sql).toContain('FROM attendance_payroll_cycles')
  })
})
