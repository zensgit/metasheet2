import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildAttendanceReportManagedContentPlan,
} = require('../../../../plugins/plugin-attendance/lib/attendance-report-managed-content-drift.cjs')

describe('attendance report managed-content drift plan', () => {
  const managedFieldIds = ['fld_row_key', 'fld_total_minutes', 'fld_source', 'fld_fields', 'fld_synced_at']

  it('skips a clean projection and ignores the volatile sync timestamp', () => {
    expect(buildAttendanceReportManagedContentPlan({
      existingData: {
        fld_row_key: 'row-1',
        fld_total_minutes: 480,
        fld_source: 'source-a',
        fld_fields: 'fields-a',
        fld_synced_at: '2026-08-30T00:00:00.000Z',
        custom_note: { keep: true },
      },
      desiredData: {
        fld_row_key: 'row-1',
        fld_total_minutes: 480,
        fld_source: 'source-a',
        fld_fields: 'fields-a',
        fld_synced_at: '2026-08-31T00:00:00.000Z',
      },
      managedFieldIds,
      volatileFieldId: 'fld_synced_at',
      fingerprintsMatch: true,
    })).toEqual({ action: 'skip', reason: 'clean', changes: null })
  })

  it('repairs same-fingerprint managed drift without including custom fields', () => {
    const plan = buildAttendanceReportManagedContentPlan({
      existingData: {
        fld_row_key: 'row-1',
        fld_total_minutes: 999,
        fld_source: 'source-a',
        fld_fields: 'fields-a',
        fld_synced_at: '2026-08-30T00:00:00.000Z',
        custom_note: { keep: true },
      },
      desiredData: {
        fld_row_key: 'row-1',
        fld_total_minutes: 480,
        fld_source: 'source-a',
        fld_fields: 'fields-a',
        fld_synced_at: '2026-08-31T00:00:00.000Z',
      },
      managedFieldIds,
      volatileFieldId: 'fld_synced_at',
      fingerprintsMatch: true,
    })

    expect(plan).toEqual({
      action: 'patch',
      reason: 'managed_drift',
      changes: {
        fld_row_key: 'row-1',
        fld_total_minutes: 480,
        fld_source: 'source-a',
        fld_fields: 'fields-a',
        fld_synced_at: '2026-08-31T00:00:00.000Z',
      },
    })
    expect(plan.changes).not.toHaveProperty('custom_note')
  })

  it('preserves the existing fingerprint-mismatch patch behavior', () => {
    expect(buildAttendanceReportManagedContentPlan({
      existingData: {
        fld_row_key: 'row-1',
        fld_total_minutes: 480,
        fld_source: 'old-source',
        fld_fields: 'fields-a',
        fld_synced_at: '2026-08-30T00:00:00.000Z',
      },
      desiredData: {
        fld_row_key: 'row-1',
        fld_total_minutes: 480,
        fld_source: 'new-source',
        fld_fields: 'fields-a',
        fld_synced_at: '2026-08-31T00:00:00.000Z',
      },
      managedFieldIds,
      volatileFieldId: 'fld_synced_at',
      fingerprintsMatch: false,
    })).toMatchObject({ action: 'patch', reason: 'fingerprint_mismatch' })
  })

  it('fails closed when the desired managed map omits a declared field', () => {
    expect(() => buildAttendanceReportManagedContentPlan({
      existingData: {},
      desiredData: { fld_row_key: 'row-1' },
      managedFieldIds: ['fld_row_key', 'fld_total_minutes'],
      volatileFieldId: 'fld_synced_at',
      fingerprintsMatch: true,
    })).toThrow('ATTENDANCE_REPORT_MANAGED_CONTENT_INVALID')
  })
})
