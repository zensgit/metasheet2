import { randomUUID } from 'node:crypto'
import type { QueryResult, QueryResultRow } from 'pg'
import { query, transaction } from '../db/pg'

export const ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP =
  'ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CORRELATION_ID_LENGTH = 128
const MAX_REASON_LENGTH = 1000

type QueryExecutor = (
  statement: string,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>

type MembershipRow = {
  id: string
  org_id: string
  user_id: string
  group_id: string
  effective_from: string
  effective_to: string | null
  assigned_by: string
  assigned_reason: string
  assigned_correlation_id: string
  closed_by: string | null
  closed_reason: string | null
  closed_correlation_id: string | null
  created_at: string | Date
  updated_at: string | Date
}

type OperationRow = {
  org_id: string
  correlation_id: string
  user_id: string
  target_group_id: string
  effective_on: string
  actor_id: string
  reason: string
  result_membership_id: string
  result_snapshot: unknown
  outcome: AttendanceCalculationGroupMembershipTransitionOutcome
}

export type AttendanceCalculationGroupMembershipTransitionOutcome =
  | 'transitioned'
  | 'unchanged'

export interface AttendanceCalculationGroupMembership {
  id: string
  orgId: string
  userId: string
  groupId: string
  effectiveFrom: string
  effectiveTo: string | null
  assignedBy: string
  assignedReason: string
  assignedCorrelationId: string
  closedBy: string | null
  closedReason: string | null
  closedCorrelationId: string | null
  createdAt: string
  updatedAt: string
}

export interface TransitionAttendanceCalculationGroupMembershipInput {
  orgId: string
  userId: string
  targetGroupId: string
  effectiveOn: string
  actorId: string
  reason: string
  correlationId?: string
}

export interface TransitionAttendanceCalculationGroupMembershipResult {
  correlationId: string
  outcome: AttendanceCalculationGroupMembershipTransitionOutcome
  membership: AttendanceCalculationGroupMembership
}

export class AttendanceCalculationGroupMembershipError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AttendanceCalculationGroupMembershipError'
  }
}

function asDateString(value: unknown): string {
  if (value instanceof Date) {
    const year = String(value.getFullYear()).padStart(4, '0')
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return String(value)
}

function asIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function mapMembership(row: MembershipRow): AttendanceCalculationGroupMembership {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    groupId: row.group_id,
    effectiveFrom: asDateString(row.effective_from),
    effectiveTo: row.effective_to == null ? null : asDateString(row.effective_to),
    assignedBy: row.assigned_by,
    assignedReason: row.assigned_reason,
    assignedCorrelationId: row.assigned_correlation_id,
    closedBy: row.closed_by,
    closedReason: row.closed_reason,
    closedCorrelationId: row.closed_correlation_id,
    createdAt: asIsoString(row.created_at),
    updatedAt: asIsoString(row.updated_at),
  }
}

function requireText(
  value: string,
  code: string,
  field: string,
  maxLength?: number,
): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new AttendanceCalculationGroupMembershipError(code, 400, `${field} is required`)
  }
  if (maxLength && normalized.length > maxLength) {
    throw new AttendanceCalculationGroupMembershipError(
      code,
      400,
      `${field} must be at most ${maxLength} characters`,
    )
  }
  return normalized
}

function normalizeUuid(value: string, code: string, field: string): string {
  const normalized = requireText(value, code, field)
  if (!UUID_RE.test(normalized)) {
    throw new AttendanceCalculationGroupMembershipError(
      code,
      400,
      `${field} must be a UUID`,
    )
  }
  return normalized.toLowerCase()
}

export function normalizeAttendanceMembershipDate(value: string): string {
  const normalized = value.trim()
  if (!DATE_RE.test(normalized)) {
    throw new AttendanceCalculationGroupMembershipError(
      'EFFECTIVE_ON_INVALID',
      400,
      'effectiveOn must be a calendar date in YYYY-MM-DD format',
    )
  }
  const [year, month, day] = normalized.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AttendanceCalculationGroupMembershipError(
      'EFFECTIVE_ON_INVALID',
      400,
      'effectiveOn must be a valid calendar date',
    )
  }
  return normalized
}

function previousCalendarDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function isOverlapError(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string }
  return (
    candidate?.code === '23P01' &&
    candidate?.constraint === 'attendance_calc_group_memberships_no_overlap'
  )
}

function assertTimelineIntegrity(rows: MembershipRow[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index]
    const from = asDateString(current.effective_from)
    const to = current.effective_to == null ? null : asDateString(current.effective_to)
    if (to && to < from) {
      throw new AttendanceCalculationGroupMembershipError(
        'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
        409,
        'Calculation-group membership timeline contains an invalid interval',
      )
    }
    const next = rows[index + 1]
    if (next && (to == null || to >= asDateString(next.effective_from))) {
      throw new AttendanceCalculationGroupMembershipError(
        'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
        409,
        'Calculation-group membership timeline contains overlapping intervals',
      )
    }
  }
}

function operationMatches(
  operation: OperationRow,
  input: Required<TransitionAttendanceCalculationGroupMembershipInput>,
): boolean {
  return (
    operation.org_id === input.orgId &&
    operation.user_id === input.userId &&
    operation.target_group_id === input.targetGroupId &&
    asDateString(operation.effective_on) === input.effectiveOn &&
    operation.actor_id === input.actorId &&
    operation.reason === input.reason &&
    operation.correlation_id === input.correlationId
  )
}

function readOperationSnapshot(value: unknown): AttendanceCalculationGroupMembership {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttendanceCalculationGroupMembershipError(
      'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
      409,
      'Idempotency record contains an invalid membership snapshot',
    )
  }
  const snapshot = value as Partial<AttendanceCalculationGroupMembership>
  const requiredText = [
    snapshot.id,
    snapshot.orgId,
    snapshot.userId,
    snapshot.groupId,
    snapshot.effectiveFrom,
    snapshot.assignedBy,
    snapshot.assignedReason,
    snapshot.assignedCorrelationId,
    snapshot.createdAt,
    snapshot.updatedAt,
  ]
  if (requiredText.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new AttendanceCalculationGroupMembershipError(
      'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
      409,
      'Idempotency record contains an incomplete membership snapshot',
    )
  }
  return snapshot as AttendanceCalculationGroupMembership
}

async function readMembershipById(
  runQuery: QueryExecutor,
  orgId: string,
  membershipId: string,
): Promise<MembershipRow | null> {
  const result = await runQuery(
    `SELECT *
       FROM attendance_calculation_group_memberships
      WHERE org_id = $1 AND id = $2`,
    [orgId, membershipId],
  )
  return (result.rows[0] as MembershipRow | undefined) ?? null
}

export async function listAttendanceCalculationGroupMemberships(
  orgIdInput: string,
  userIdInput: string,
  runQuery: QueryExecutor = query,
): Promise<AttendanceCalculationGroupMembership[]> {
  const orgId = requireText(orgIdInput, 'ORG_ID_REQUIRED', 'orgId')
  const userId = requireText(userIdInput, 'USER_ID_REQUIRED', 'userId')
  const result = await runQuery(
    `SELECT *
       FROM attendance_calculation_group_memberships
      WHERE org_id = $1 AND user_id = $2
      ORDER BY effective_from ASC, id ASC`,
    [orgId, userId],
  )
  const rows = result.rows as MembershipRow[]
  assertTimelineIntegrity(rows)
  return rows.map(mapMembership)
}

export async function transitionAttendanceCalculationGroupMembership(
  rawInput: TransitionAttendanceCalculationGroupMembershipInput,
): Promise<TransitionAttendanceCalculationGroupMembershipResult> {
  const input: Required<TransitionAttendanceCalculationGroupMembershipInput> = {
    orgId: requireText(rawInput.orgId, 'ORG_ID_REQUIRED', 'orgId'),
    userId: requireText(rawInput.userId, 'USER_ID_REQUIRED', 'userId'),
    targetGroupId: normalizeUuid(
      rawInput.targetGroupId,
      'TARGET_GROUP_ID_INVALID',
      'targetGroupId',
    ),
    effectiveOn: normalizeAttendanceMembershipDate(rawInput.effectiveOn),
    actorId: requireText(rawInput.actorId, 'ACTOR_ID_REQUIRED', 'actorId'),
    reason: requireText(
      rawInput.reason,
      'REASON_REQUIRED',
      'reason',
      MAX_REASON_LENGTH,
    ),
    correlationId: requireText(
      rawInput.correlationId || randomUUID(),
      'CORRELATION_ID_INVALID',
      'correlationId',
      MAX_CORRELATION_ID_LENGTH,
    ),
  }

  try {
    return await transaction(async (client) => {
      const runQuery = client.query as QueryExecutor

      await runQuery(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`attendance-calc-operation\u001f${input.orgId}\u001f${input.correlationId}`],
      )

      const operationResult = await runQuery(
        `SELECT org_id, correlation_id, user_id, target_group_id, effective_on,
                actor_id, reason, result_membership_id, result_snapshot, outcome
           FROM attendance_calculation_group_membership_operations
          WHERE org_id = $1 AND correlation_id = $2
          FOR UPDATE`,
        [input.orgId, input.correlationId],
      )
      const existingOperation = operationResult.rows[0] as OperationRow | undefined
      if (existingOperation) {
        if (!operationMatches(existingOperation, input)) {
          throw new AttendanceCalculationGroupMembershipError(
            'CORRELATION_ID_REUSED',
            409,
            'correlationId was already used with a different transition payload',
          )
        }
        const membership = await readMembershipById(
          runQuery,
          input.orgId,
          existingOperation.result_membership_id,
        )
        if (!membership) {
          throw new AttendanceCalculationGroupMembershipError(
            'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
            409,
            'Idempotency record points to a missing membership',
          )
        }
        return {
          correlationId: input.correlationId,
          outcome: existingOperation.outcome,
          membership: readOperationSnapshot(existingOperation.result_snapshot),
        }
      }

      await runQuery(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`attendance-calc-timeline\u001f${input.orgId}\u001f${input.userId}`],
      )

      const targetGroup = await runQuery(
        `SELECT id
           FROM attendance_groups
          WHERE id = $1 AND org_id = $2`,
        [input.targetGroupId, input.orgId],
      )
      if (targetGroup.rows.length === 0) {
        throw new AttendanceCalculationGroupMembershipError(
          'TARGET_GROUP_NOT_FOUND',
          404,
          'No calculation group exists in the requested organization',
        )
      }

      const timelineResult = await runQuery(
        `SELECT *
           FROM attendance_calculation_group_memberships
          WHERE org_id = $1 AND user_id = $2
          ORDER BY effective_from ASC, id ASC
          FOR UPDATE`,
        [input.orgId, input.userId],
      )
      const timeline = timelineResult.rows as MembershipRow[]
      assertTimelineIntegrity(timeline)

      // Lock order is timeline -> lifecycle rows. A direct semantic UPDATE already
      // owns its membership tuple before the DB trigger locks users/user_orgs, so
      // taking these locks in the opposite order would create a mixed-writer deadlock.
      const activeUser = await runQuery(
        `SELECT 1
           FROM users u
           JOIN user_orgs uo
             ON uo.user_id = u.id
            AND uo.org_id = $2
          WHERE u.id = $1
            AND u.is_active = true
            AND uo.is_active = true
          LIMIT 1
          FOR UPDATE OF u, uo`,
        [input.userId, input.orgId],
      )
      if (activeUser.rows.length === 0) {
        throw new AttendanceCalculationGroupMembershipError(
          'ACTIVE_ORG_USER_REQUIRED',
          422,
          'Target user must be active in the requested organization',
        )
      }

      const current = timeline.find((row) => {
        const from = asDateString(row.effective_from)
        const to = row.effective_to == null ? null : asDateString(row.effective_to)
        return from <= input.effectiveOn && (to == null || to >= input.effectiveOn)
      })

      if (current?.group_id === input.targetGroupId) {
        const membership = mapMembership(current)
        await runQuery(
          `INSERT INTO attendance_calculation_group_membership_operations (
             org_id, correlation_id, user_id, target_group_id, effective_on,
             actor_id, reason, result_membership_id, result_snapshot, outcome
           ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb, 'unchanged')`,
          [
            input.orgId,
            input.correlationId,
            input.userId,
            input.targetGroupId,
            input.effectiveOn,
            input.actorId,
            input.reason,
            current.id,
            JSON.stringify(membership),
          ],
        )
        return {
          correlationId: input.correlationId,
          outcome: 'unchanged',
          membership,
        }
      }

      if (current && asDateString(current.effective_from) === input.effectiveOn) {
        throw new AttendanceCalculationGroupMembershipError(
          'ATTENDANCE_CALCULATION_GROUP_TRANSITION_IMPOSSIBLE',
          409,
          'A different membership already begins on effectiveOn; it cannot be replaced without deleting history',
        )
      }

      const next = timeline.find(
        (row) => asDateString(row.effective_from) > input.effectiveOn,
      )
      const targetEffectiveTo = next
        ? previousCalendarDate(asDateString(next.effective_from))
        : null

      if (current) {
        await runQuery(
          `UPDATE attendance_calculation_group_memberships
              SET effective_to = ($3::date - 1),
                  closed_by = $4,
                  closed_reason = $5,
                  closed_correlation_id = $6,
                  updated_at = now()
            WHERE id = $1 AND org_id = $2`,
          [
            current.id,
            input.orgId,
            input.effectiveOn,
            input.actorId,
            input.reason,
            input.correlationId,
          ],
        )
      }

      const inserted = await runQuery(
        `INSERT INTO attendance_calculation_group_memberships (
           org_id, user_id, group_id, effective_from, effective_to,
           assigned_by, assigned_reason, assigned_correlation_id
         ) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8)
         RETURNING *`,
        [
          input.orgId,
          input.userId,
          input.targetGroupId,
          input.effectiveOn,
          targetEffectiveTo,
          input.actorId,
          input.reason,
          input.correlationId,
        ],
      )
      const membership = inserted.rows[0] as MembershipRow
      const membershipSnapshot = mapMembership(membership)

      await runQuery(
        `INSERT INTO attendance_calculation_group_membership_operations (
           org_id, correlation_id, user_id, target_group_id, effective_on,
           actor_id, reason, result_membership_id, result_snapshot, outcome
         ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb, 'transitioned')`,
        [
          input.orgId,
          input.correlationId,
          input.userId,
          input.targetGroupId,
          input.effectiveOn,
          input.actorId,
          input.reason,
          membership.id,
          JSON.stringify(membershipSnapshot),
        ],
      )

      return {
        correlationId: input.correlationId,
        outcome: 'transitioned',
        membership: membershipSnapshot,
      }
    })
  } catch (error) {
    if (error instanceof AttendanceCalculationGroupMembershipError) throw error
    if (isOverlapError(error)) {
      throw new AttendanceCalculationGroupMembershipError(
        ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP,
        409,
        'Calculation-group membership overlaps an existing effective interval',
      )
    }
    throw error
  }
}
