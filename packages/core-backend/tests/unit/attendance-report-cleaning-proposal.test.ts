import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  AttendanceMultitableCleaningAuthorityError,
  buildAttendanceCanonicalSourceDigest,
  refreshAttendanceReportProjectionAnchor,
} from '../../src/attendance/attendance-multitable-cleaning-authority'

const require = createRequire(import.meta.url)
const {
  buildAttendanceCleaningProposal,
  buildAttendanceCleaningProposalDigest,
  buildAttendanceCleaningProposalCleanup,
  normalizeAttendanceMultitableCleaningPolicy,
} = require('../../../../plugins/plugin-attendance/lib/attendance-report-cleaning-proposal.cjs')

describe('attendance report cleaning proposal', () => {
  it('enables the ACP gate only for literal true', () => {
    expect(normalizeAttendanceMultitableCleaningPolicy({ enabled: true })).toEqual({ enabled: true })
    expect(normalizeAttendanceMultitableCleaningPolicy({ enabled: 'true' })).toEqual({ enabled: false })
    expect(normalizeAttendanceMultitableCleaningPolicy(undefined)).toEqual({ enabled: false })
  })

  it('accepts only a bounded, trimmed requested proposal with a fixed normal target', () => {
    expect(buildAttendanceCleaningProposal({
      cleaning_requested: true,
      cleaning_reason: '  normalize verified exception  ',
      target_status: 'absent',
    })).toEqual({ requested: true, reason: 'normalize verified exception', targetStatus: 'normal' })
    expect(buildAttendanceCleaningProposal({ cleaning_requested: true, cleaning_reason: '   ' })).toBeNull()
    expect(buildAttendanceCleaningProposal({ cleaning_requested: 'true', cleaning_reason: 'valid' })).toBeNull()
    expect(buildAttendanceCleaningProposal({ cleaning_requested: true, cleaning_reason: 'x'.repeat(501) })).toBeNull()
  })

  it('uses only proposal identity inputs in the digest and cleanup changes', () => {
    const proposal = { requested: true, reason: 'normalize verified exception', targetStatus: 'normal' }
    const input = {
      orgId: 'org-a',
      projectionRecordId: 'rec-a',
      sourceFingerprint: 'a'.repeat(40),
      proposal,
    }
    expect(buildAttendanceCleaningProposalDigest(input)).toBe(
      buildAttendanceCleaningProposalDigest({ ...input, projectionVersion: 99, customField: 'ignored' }),
    )
    expect(buildAttendanceCleaningProposalDigest({ ...input, sourceFingerprint: 'b'.repeat(40) }))
      .not.toBe(buildAttendanceCleaningProposalDigest(input))
    expect(buildAttendanceCleaningProposalCleanup()).toEqual({
      cleaning_requested: false,
      cleaning_reason: null,
    })
  })

  it('derives the anchor digest from closed canonical facts, not a projection timestamp', () => {
    const facts = {
      projection_record_id: 'rec_anchor',
      canonical_record_id: '00000000-0000-4000-8000-000000000001',
      org_id: 'org-a',
      user_id: 'user-a',
      work_date: '2026-09-07',
      timezone: 'UTC',
      first_in_at: '2026-09-07T09:00:00.000Z',
      last_out_at: '2026-09-07T18:00:00.000Z',
      work_minutes: 480,
      late_minutes: 0,
      early_leave_minutes: 0,
      status: 'late',
      is_workday: true,
      projection_owner: 'w4',
      current_calculation_id: '00000000-0000-4000-8000-000000000002',
      visibility_state: 'active',
      visibility_reason: 'active',
    }
    expect(buildAttendanceCanonicalSourceDigest({ ...facts, updated_at: 'ignored' } as never))
      .toBe(buildAttendanceCanonicalSourceDigest({ ...facts, updated_at: 'also-ignored' } as never))
    expect(buildAttendanceCanonicalSourceDigest({ ...facts, status: 'absent' } as never))
      .not.toBe(buildAttendanceCanonicalSourceDigest(facts))
    expect(() => buildAttendanceCanonicalSourceDigest({ ...facts, status: '' } as never))
      .toThrow(AttendanceMultitableCleaningAuthorityError)
  })

  it('refreshes only a DB-selected authoritative calculation and revokes a true legacy binding', async () => {
    const baseRow = {
      projection_record_id: 'rec_anchor', canonical_record_id: '00000000-0000-4000-8000-000000000001',
      org_id: 'org-a', user_id: 'user-a', work_date: '2026-09-07', timezone: 'UTC',
      first_in_at: null, last_out_at: null, work_minutes: 0, late_minutes: 0, early_leave_minutes: 0,
      status: 'late', is_workday: true, projection_owner: 'w4',
      current_calculation_id: '00000000-0000-4000-8000-000000000002', visibility_state: 'active', visibility_reason: 'active',
    }
    const statements: string[] = []
    await refreshAttendanceReportProjectionAnchor(async (statement) => {
      statements.push(statement)
      if (statement.includes('FROM meta_records projection')) return { rows: [baseRow] }
      if (statement.includes("WHERE id = $1")) return { rows: [{ id: baseRow.current_calculation_id, version: 2, mode: 'authoritative', outcome: 'completed' }] }
      if (statement.includes('FROM attendance_report_projection_anchors')) return { rows: [] }
      if (statement.includes('INSERT INTO attendance_report_projection_anchors')) return { rows: [{ projection_record_id: baseRow.projection_record_id }] }
      throw new Error('unexpected query')
    }, {
      projectionRecordId: baseRow.projection_record_id,
      canonicalRecordId: baseRow.canonical_record_id,
      sourceFingerprint: 'a'.repeat(40),
    })
    expect(statements.some(statement => statement.includes('INSERT INTO attendance_report_projection_anchors'))).toBe(true)

    const legacyStatements: string[] = []
    await refreshAttendanceReportProjectionAnchor(async (statement) => {
      legacyStatements.push(statement)
      if (statement.includes('FROM meta_records projection')) return { rows: [{ ...baseRow, projection_owner: 'legacy_untracked', current_calculation_id: null }] }
      if (statement.includes("outcome = 'completed'")) return { rows: [] }
      if (statement.includes('DELETE FROM attendance_report_projection_anchors')) return { rows: [] }
      throw new Error('unexpected query')
    }, {
      projectionRecordId: baseRow.projection_record_id,
      canonicalRecordId: baseRow.canonical_record_id,
      sourceFingerprint: 'a'.repeat(40),
    })
    expect(legacyStatements.some(statement => statement.includes('DELETE FROM attendance_report_projection_anchors'))).toBe(true)

    const rebindStatements: string[] = []
    await expect(refreshAttendanceReportProjectionAnchor(async (statement) => {
      rebindStatements.push(statement)
      if (statement.includes('FROM meta_records projection')) return { rows: [baseRow] }
      if (statement.includes("WHERE id = $1")) return { rows: [{ id: baseRow.current_calculation_id, version: 2, mode: 'authoritative', outcome: 'completed' }] }
      if (statement.includes('FROM attendance_report_projection_anchors')) return { rows: [{ canonical_record_id: '00000000-0000-4000-8000-000000000099' }] }
      throw new Error('unexpected query')
    }, {
      projectionRecordId: baseRow.projection_record_id,
      canonicalRecordId: baseRow.canonical_record_id,
      sourceFingerprint: 'a'.repeat(40),
    })).rejects.toThrow(AttendanceMultitableCleaningAuthorityError)
    expect(rebindStatements.some(statement => statement.includes('INSERT INTO attendance_report_projection_anchors'))).toBe(false)
  })
})
