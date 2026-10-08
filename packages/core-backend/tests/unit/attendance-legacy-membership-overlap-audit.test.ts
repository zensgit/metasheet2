import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR,
  ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY,
  AttendanceLegacyMembershipAuditError,
  auditAttendanceLegacyMembershipOverlaps,
} from '../../src/services/AttendanceLegacyMembershipOverlapAudit'

function result(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  }
}

describe('attendance legacy membership overlap audit', () => {
  const readySchema = {
    members_table: 'attendance_group_members',
    groups_table: 'attendance_groups',
    member_columns: ['group_id', 'id', 'org_id', 'user_id'],
    group_columns: ['id', 'org_id'],
  }

  it('emits a deterministic, minimal manual-repair manifest', async () => {
    const rows = [
      { source_row_id: 'row-b', org_id: 'org-a', user_id: 'user-a', group_id: 'group-b', group_found: true },
      { source_row_id: 'row-a', org_id: 'org-a', user_id: 'user-a', group_id: 'group-a', group_found: true },
      { source_row_id: 'row-c', org_id: 'org-a', user_id: 'user-b', group_id: 'group-a', group_found: true },
    ]
    const runQuery = vi.fn()
      .mockResolvedValueOnce(result([readySchema]))
      .mockResolvedValueOnce(result(rows))
      .mockResolvedValueOnce(result([readySchema]))
      .mockResolvedValueOnce(result([...rows].reverse()))

    const first = await auditAttendanceLegacyMembershipOverlaps(' org-a ', runQuery)
    const second = await auditAttendanceLegacyMembershipOverlaps('org-a', runQuery)

    expect(second).toEqual(first)
    expect(first).toEqual({
      manifestVersion: 'attendance-legacy-membership-overlap-v1',
      orgId: 'org-a',
      sourceTable: 'attendance_group_members',
      intervalPosture: 'legacy_effective_interval_unknown',
      scannedRows: 3,
      conflictCount: 1,
      zeroConflicts: false,
      conflicts: [{
        orgId: 'org-a',
        userId: 'user-a',
        interval: {
          posture: 'legacy_effective_interval_unknown',
          effectiveFrom: null,
          effectiveTo: null,
        },
        remediation: {
          posture: 'manual_transfer_required',
          transitionService: 'transitionAttendanceCalculationGroupMembership',
          requiredInput: ['targetGroupId', 'effectiveOn', 'actorId', 'reason', 'correlationId'],
        },
        candidates: [
          { groupId: 'group-a', sourceRowIds: ['row-a'] },
          { groupId: 'group-b', sourceRowIds: ['row-b'] },
        ],
      }],
    })
    expect(runQuery.mock.calls[1][1]).toEqual(['org-a'])
    expect(runQuery.mock.calls[3][1]).toEqual(['org-a'])
    const statements = runQuery.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(statements).toMatch(/WHERE m\.org_id = \$1/)
    expect(statements).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i)
  })

  it('returns a stable zero-conflict manifest', async () => {
    const runQuery = vi.fn()
      .mockResolvedValueOnce(result([readySchema]))
      .mockResolvedValueOnce(result([
        { source_row_id: 'row-a', org_id: 'org-a', user_id: 'user-a', group_id: 'group-a', group_found: true },
      ]))

    const manifest = await auditAttendanceLegacyMembershipOverlaps('org-a', runQuery)
    expect(manifest).toMatchObject({ scannedRows: 1, conflictCount: 0, zeroConflicts: true, conflicts: [] })
  })

  it('fails closed for a missing schema, corrupt group link, or absent org', async () => {
    await expect(auditAttendanceLegacyMembershipOverlaps('org-a', async () => result([
      { members_table: null, groups_table: null, member_columns: [], group_columns: [] },
    ]))).rejects.toMatchObject({
      code: ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY,
      status: 503,
    })

    const corruptQuery = vi.fn()
      .mockResolvedValueOnce(result([readySchema]))
      .mockResolvedValueOnce(result([
        { source_row_id: 'row-a', org_id: 'org-a', user_id: 'user-a', group_id: 'missing', group_found: false },
      ]))
    await expect(auditAttendanceLegacyMembershipOverlaps('org-a', corruptQuery)).rejects.toMatchObject({
      code: ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR,
      status: 409,
    })
    await expect(auditAttendanceLegacyMembershipOverlaps('   ')).rejects.toBeInstanceOf(
      AttendanceLegacyMembershipAuditError,
    )
  })

  it('fails closed when a required legacy column is absent', async () => {
    await expect(auditAttendanceLegacyMembershipOverlaps('org-a', async () => result([{
      ...readySchema,
      member_columns: ['id', 'org_id', 'user_id'],
    }]))).rejects.toMatchObject({
      code: ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY,
      status: 503,
    })
  })
})
