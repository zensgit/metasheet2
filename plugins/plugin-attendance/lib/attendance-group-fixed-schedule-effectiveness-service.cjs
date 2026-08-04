'use strict'

const REASON_ORDER = [
  'NO_DESIRED_CONFIG',
  'NO_TARGET_MEMBERS',
  'DIFFERENT_MANAGED_KEY_ACTIVE',
  'TARGET_MEMBER_MISSING',
  'NON_MEMBER_TARGET_ACTIVE',
  'DUPLICATE_MATCHING_ASSIGNMENT',
  'ASSIGNMENT_VALUE_MISMATCH',
  'UNPUBLISHED_MANAGED_ROW',
  'EFFECTIVE',
]

function formatDateOnly(value) {
  if (value == null) return null
  if (value instanceof Date) {
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
      .join('-')
  }
  const normalized = String(value)
  const match = normalized.match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : normalized
}

function mapDesired(row) {
  if (!row) return null
  return {
    shiftId: row.shift_id,
    startDate: formatDateOnly(row.start_date),
    endDate: formatDateOnly(row.end_date),
    revision: Number(row.revision),
  }
}

function isPublished(row) {
  return (row.publish_status ?? 'published') === 'published'
}

function assignmentMatchesDesired(row, desired) {
  return String(row.shift_id) === String(desired.shiftId)
    && formatDateOnly(row.start_date) === desired.startDate
    && formatDateOnly(row.end_date) === desired.endDate
}

function buildManagedSets(rows) {
  const sets = new Map()
  for (const row of rows) {
    const key = [row.producer_key, row.shift_id, formatDateOnly(row.start_date), formatDateOnly(row.end_date)].join('|')
    const current = sets.get(key)
    if (current) {
      current.rowCount += 1
      continue
    }
    sets.set(key, {
      shiftId: row.shift_id,
      startDate: formatDateOnly(row.start_date),
      endDate: formatDateOnly(row.end_date),
      producerKey: row.producer_key,
      rowCount: 1,
    })
  }
  return [...sets.values()].sort((left, right) => {
    const leftKey = `${left.producerKey}|${left.shiftId}|${left.startDate}|${left.endDate}`
    const rightKey = `${right.producerKey}|${right.shiftId}|${right.startDate}|${right.endDate}`
    return leftKey.localeCompare(rightKey)
  })
}

function deriveAttendanceGroupFixedScheduleEffectiveness({ desired, targetMemberIds, managedRows, producerKey, evaluatedAt }) {
  const members = new Set(targetMemberIds.map(String))
  const publishedRows = managedRows.filter(isPublished)
  const unpublishedRows = managedRows.filter(row => !isPublished(row))
  const coverage = {
    targetMembers: members.size,
    matchingMembers: 0,
    missingMembers: members.size,
    nonMemberTargets: 0,
    differentKeyRows: 0,
  }

  if (!desired) {
    return {
      state: 'not_configured',
      reasonCodes: ['NO_DESIRED_CONFIG'],
      desired: null,
      coverage,
      drift: {
        unconfiguredManagedRows: managedRows.length,
        unpublishedManagedRows: unpublishedRows.length,
        managedSets: buildManagedSets(managedRows),
      },
      evaluatedAt,
    }
  }

  const differentKeyRows = publishedRows.filter(row => row.producer_key !== producerKey)
  const matchingKeyRows = publishedRows.filter(row => row.producer_key === producerKey)
  const matchingRowsByMember = new Map()
  let duplicateMatchingAssignment = false
  let assignmentValueMismatch = false

  for (const row of matchingKeyRows) {
    const userId = String(row.user_id)
    if (!members.has(userId)) {
      coverage.nonMemberTargets += 1
      continue
    }
    if (!assignmentMatchesDesired(row, desired)) {
      assignmentValueMismatch = true
      continue
    }
    const rows = matchingRowsByMember.get(userId) ?? []
    rows.push(row)
    matchingRowsByMember.set(userId, rows)
  }

  for (const userId of members) {
    const rows = matchingRowsByMember.get(userId) ?? []
    if (rows.length) coverage.matchingMembers += 1
    if (rows.length > 1) duplicateMatchingAssignment = true
  }
  coverage.missingMembers = coverage.targetMembers - coverage.matchingMembers
  coverage.differentKeyRows = differentKeyRows.length

  const reasons = new Set()
  if (!coverage.targetMembers) reasons.add('NO_TARGET_MEMBERS')
  if (differentKeyRows.length) reasons.add('DIFFERENT_MANAGED_KEY_ACTIVE')
  if (coverage.missingMembers) reasons.add('TARGET_MEMBER_MISSING')
  if (coverage.nonMemberTargets) reasons.add('NON_MEMBER_TARGET_ACTIVE')
  if (duplicateMatchingAssignment) reasons.add('DUPLICATE_MATCHING_ASSIGNMENT')
  if (assignmentValueMismatch) reasons.add('ASSIGNMENT_VALUE_MISMATCH')
  if (unpublishedRows.length) reasons.add('UNPUBLISHED_MANAGED_ROW')

  const effective = coverage.targetMembers > 0
    && !differentKeyRows.length
    && !coverage.missingMembers
    && !coverage.nonMemberTargets
    && !duplicateMatchingAssignment
    && !assignmentValueMismatch
  if (effective) reasons.add('EFFECTIVE')

  return {
    state: differentKeyRows.length ? 'configuration_changed' : effective ? 'effective' : 'pending_apply',
    reasonCodes: REASON_ORDER.filter(reason => reasons.has(reason)),
    desired,
    coverage,
    drift: {
      unconfiguredManagedRows: 0,
      unpublishedManagedRows: unpublishedRows.length,
      managedSets: buildManagedSets(differentKeyRows),
    },
    evaluatedAt,
  }
}

function createAttendanceGroupFixedScheduleEffectivenessService({ HttpError, buildAttendanceGroupFixedScheduleProducerKey, now = () => new Date().toISOString() }) {
  async function getEffectiveness(db, input) {
    const groupRows = await db.query(
      'SELECT id FROM attendance_groups WHERE id = $1 AND org_id = $2 LIMIT 1',
      [input.groupId, input.orgId],
    )
    if (!groupRows.length) throw new HttpError(404, 'NOT_FOUND', 'Group not found')

    const configRows = await db.query(
      `SELECT shift_id, start_date, end_date, revision
         FROM attendance_group_fixed_schedule_configs
        WHERE org_id = $1 AND group_id = $2
        LIMIT 1`,
      [input.orgId, input.groupId],
    )
    const memberRows = await db.query(
      `SELECT DISTINCT user_id
         FROM attendance_group_members
        WHERE org_id = $1 AND group_id = $2
        ORDER BY user_id ASC`,
      [input.orgId, input.groupId],
    )
    const managedRows = await db.query(
      `SELECT user_id, shift_id, start_date, end_date, publish_status, producer_key
         FROM attendance_shift_assignments
        WHERE org_id = $1
          AND producer_type = 'attendance_group_fixed_schedule'
          AND producer_ref_id = $2
          AND COALESCE(is_active, true) = true
        ORDER BY producer_key ASC, user_id ASC, start_date ASC, created_at ASC, id ASC`,
      [input.orgId, input.groupId],
    )
    const desired = mapDesired(configRows[0])
    const producerKey = desired
      ? buildAttendanceGroupFixedScheduleProducerKey({
        groupId: input.groupId,
        shiftId: desired.shiftId,
        startDate: desired.startDate,
        endDate: desired.endDate,
      })
      : null
    return {
      groupId: input.groupId,
      ...deriveAttendanceGroupFixedScheduleEffectiveness({
        desired,
        targetMemberIds: memberRows.map(row => row.user_id),
        managedRows,
        producerKey,
        evaluatedAt: now(),
      }),
    }
  }

  return { getEffectiveness }
}

module.exports = {
  REASON_ORDER,
  deriveAttendanceGroupFixedScheduleEffectiveness,
  createAttendanceGroupFixedScheduleEffectivenessService,
}
