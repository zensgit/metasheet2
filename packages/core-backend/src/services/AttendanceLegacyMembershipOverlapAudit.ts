import type { QueryResult, QueryResultRow } from 'pg'
import { query } from '../db/pg'

export const ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY =
  'ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY'
export const ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR =
  'ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR'

const MANIFEST_VERSION = 'attendance-legacy-membership-overlap-v1' as const
const INTERVAL_POSTURE = 'legacy_effective_interval_unknown' as const
const REMEDIATION = 'manual_transfer_required' as const

type QueryExecutor = (
  statement: string,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>

type SchemaRow = {
  members_table: string | null
  groups_table: string | null
  member_columns: string[] | null
  group_columns: string[] | null
}

type LegacyMembershipRow = {
  source_row_id: string
  org_id: string
  user_id: string
  group_id: string
  group_found: boolean
}

export interface AttendanceLegacyMembershipCandidate {
  groupId: string
  sourceRowIds: string[]
}

export interface AttendanceLegacyMembershipConflict {
  orgId: string
  userId: string
  interval: {
    posture: typeof INTERVAL_POSTURE
    effectiveFrom: null
    effectiveTo: null
  }
  remediation: {
    posture: typeof REMEDIATION
    transitionService: 'transitionAttendanceCalculationGroupMembership'
    requiredInput: readonly [
      'targetGroupId',
      'effectiveOn',
      'actorId',
      'reason',
      'correlationId',
    ]
  }
  candidates: AttendanceLegacyMembershipCandidate[]
}

export interface AttendanceLegacyMembershipAuditManifest {
  manifestVersion: typeof MANIFEST_VERSION
  orgId: string
  sourceTable: 'attendance_group_members'
  intervalPosture: typeof INTERVAL_POSTURE
  scannedRows: number
  conflictCount: number
  zeroConflicts: boolean
  conflicts: AttendanceLegacyMembershipConflict[]
}

export class AttendanceLegacyMembershipAuditError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AttendanceLegacyMembershipAuditError'
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function requireOrgId(value: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) {
    throw new AttendanceLegacyMembershipAuditError(
      'ORG_ID_REQUIRED',
      400,
      'orgId is required',
    )
  }
  return normalized
}

function buildManifest(
  orgId: string,
  rows: LegacyMembershipRow[],
): AttendanceLegacyMembershipAuditManifest {
  const rowsByUser = new Map<string, LegacyMembershipRow[]>()
  for (const row of rows) {
    if (!row.group_found) {
      throw new AttendanceLegacyMembershipAuditError(
        ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR,
        409,
        'Legacy membership references a missing or cross-organization group',
      )
    }
    const userRows = rowsByUser.get(row.user_id) ?? []
    userRows.push(row)
    rowsByUser.set(row.user_id, userRows)
  }

  const conflicts = [...rowsByUser.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .flatMap(([userId, userRows]) => {
      const rowsByGroup = new Map<string, string[]>()
      for (const row of userRows) {
        const sourceRows = rowsByGroup.get(row.group_id) ?? []
        sourceRows.push(row.source_row_id)
        rowsByGroup.set(row.group_id, sourceRows)
      }
      if (rowsByGroup.size < 2) return []

      const candidates = [...rowsByGroup.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([groupId, sourceRowIds]) => ({
          groupId,
          sourceRowIds: [...sourceRowIds].sort(compareText),
        }))

      return [{
        orgId,
        userId,
        interval: {
          posture: INTERVAL_POSTURE,
          effectiveFrom: null,
          effectiveTo: null,
        },
        remediation: {
          posture: REMEDIATION,
          transitionService: 'transitionAttendanceCalculationGroupMembership' as const,
          requiredInput: [
            'targetGroupId',
            'effectiveOn',
            'actorId',
            'reason',
            'correlationId',
          ] as const,
        },
        candidates,
      }]
    })

  return {
    manifestVersion: MANIFEST_VERSION,
    orgId,
    sourceTable: 'attendance_group_members',
    intervalPosture: INTERVAL_POSTURE,
    scannedRows: rows.length,
    conflictCount: conflicts.length,
    zeroConflicts: conflicts.length === 0,
    conflicts,
  }
}

export async function auditAttendanceLegacyMembershipOverlaps(
  orgIdInput: string,
  runQuery: QueryExecutor = query,
): Promise<AttendanceLegacyMembershipAuditManifest> {
  const orgId = requireOrgId(orgIdInput)
  const schemaResult = await runQuery(
    `SELECT to_regclass('public.attendance_group_members')::text AS members_table,
            to_regclass('public.attendance_groups')::text AS groups_table,
            ARRAY(
              SELECT column_name::text
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'attendance_group_members'
               ORDER BY column_name
            ) AS member_columns,
            ARRAY(
              SELECT column_name::text
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'attendance_groups'
               ORDER BY column_name
            ) AS group_columns`,
  )
  const schema = schemaResult.rows[0] as SchemaRow | undefined
  const memberColumns = new Set(schema?.member_columns ?? [])
  const groupColumns = new Set(schema?.group_columns ?? [])
  const requiredMemberColumns = ['id', 'org_id', 'group_id', 'user_id']
  const requiredGroupColumns = ['id', 'org_id']
  if (
    !schema?.members_table
    || !schema.groups_table
    || requiredMemberColumns.some((column) => !memberColumns.has(column))
    || requiredGroupColumns.some((column) => !groupColumns.has(column))
  ) {
    throw new AttendanceLegacyMembershipAuditError(
      ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY,
      503,
      'Legacy attendance membership schema is not ready',
    )
  }

  const result = await runQuery(
    `SELECT m.id::text AS source_row_id,
            m.org_id,
            m.user_id,
            m.group_id::text AS group_id,
            (g.id IS NOT NULL) AS group_found
       FROM attendance_group_members m
       LEFT JOIN attendance_groups g
         ON g.id = m.group_id
        AND g.org_id = m.org_id
      WHERE m.org_id = $1
      ORDER BY m.user_id ASC, m.group_id ASC, m.id ASC`,
    [orgId],
  )

  return buildManifest(orgId, result.rows as LegacyMembershipRow[])
}
