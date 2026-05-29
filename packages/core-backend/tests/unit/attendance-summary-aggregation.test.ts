import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance summary aggregation', () => {
  it('counts adjusted worked rows even when the stored workday flag is false', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([
          {
            total_days: 1,
            total_minutes: 395,
            total_late_minutes: 0,
            total_early_leave_minutes: 0,
            normal_days: 0,
            late_days: 0,
            early_leave_days: 0,
            late_early_days: 0,
            partial_days: 0,
            absent_days: 0,
            adjusted_days: 1,
            off_days: 0,
          },
        ])
        .mockResolvedValueOnce([]),
    }

    const summary = await helpers.loadAttendanceSummary(
      db,
      'org-1',
      'new-hire-1',
      '2026-05-01',
      '2026-05-31',
    )

    expect(summary.total_minutes).toBe(395)
    expect(summary.adjusted_days).toBe(1)
    expect(summary.off_days).toBe(0)

    const aggregateSql = String(db.query.mock.calls[0]?.[0] || '')
    expect(aggregateSql).toContain('COALESCE(work_minutes, 0) > 0')
    expect(aggregateSql).toContain("status IN ('normal', 'late', 'early_leave', 'late_early', 'partial', 'adjusted')")
    expect(aggregateSql).toContain('NOT (is_workday = true OR COALESCE(work_minutes, 0) > 0')
  })

  it('can qualify the counted-day predicate for joined summary queries', () => {
    expect(helpers.buildAttendanceSummaryCountedDaySql('ar')).toBe(
      "(ar.is_workday = true OR COALESCE(ar.work_minutes, 0) > 0 OR ar.status IN ('normal', 'late', 'early_leave', 'late_early', 'partial', 'adjusted'))",
    )
  })
})
