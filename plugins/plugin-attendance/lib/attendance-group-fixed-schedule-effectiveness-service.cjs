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

// #4709 FSER-4 prerequisite (contract amendment, §2, RATIFIED
// `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): applicability for
// the member-safe self projection. Deliberately kept in this module — not in
// the route file and not re-derived per-caller — because it reuses the exact
// same `isPublished`/`assignmentMatchesDesired` predicates the group four-state
// derivation above uses, so there is exactly one place that knows what
// "matching" means. `matching` requires EXACTLY ONE eligible row: a member
// with zero matching rows is obviously `non_matching`, and a member with a
// duplicate matching row (the group-level `DUPLICATE_MATCHING_ASSIGNMENT` case)
// is `non_matching` too — the contract's "exactly one" is stricter than the
// group-level `coverage.matchingMembers` count, which only requires "at least
// one" and reports duplicates as a separate reason code.
function deriveAttendanceGroupFixedScheduleSelfApplicability({ desired, producerKey, managedRows, userId }) {
  if (!desired) return 'not_configured'
  const subject = String(userId)
  const ownEligibleMatchingRows = managedRows.filter(row => String(row.user_id) === subject
    && isPublished(row)
    && row.producer_key === producerKey
    && assignmentMatchesDesired(row, desired))
  return ownEligibleMatchingRows.length === 1 ? 'matching' : 'non_matching'
}

function createAttendanceGroupFixedScheduleEffectivenessService({ HttpError, buildAttendanceGroupFixedScheduleProducerKey, now = () => new Date().toISOString() }) {
  async function loadEffectivenessFacts(db, { orgId, groupId }) {
    const configRows = await db.query(
      `SELECT shift_id, start_date, end_date, revision
         FROM attendance_group_fixed_schedule_configs
        WHERE org_id = $1 AND group_id = $2
        LIMIT 1`,
      [orgId, groupId],
    )
    const memberRows = await db.query(
      `SELECT DISTINCT user_id
         FROM attendance_group_members
        WHERE org_id = $1 AND group_id = $2
        ORDER BY user_id ASC`,
      [orgId, groupId],
    )
    const managedRows = await db.query(
      `SELECT user_id, shift_id, start_date, end_date, publish_status, producer_key
         FROM attendance_shift_assignments
        WHERE org_id = $1
          AND producer_type = 'attendance_group_fixed_schedule'
          AND producer_ref_id = $2
          AND COALESCE(is_active, true) = true
        ORDER BY producer_key ASC, user_id ASC, start_date ASC, created_at ASC, id ASC`,
      [orgId, groupId],
    )
    const desired = mapDesired(configRows[0])
    const producerKey = desired
      ? buildAttendanceGroupFixedScheduleProducerKey({
        groupId,
        shiftId: desired.shiftId,
        startDate: desired.startDate,
        endDate: desired.endDate,
      })
      : null
    return { desired, producerKey, targetMemberIds: memberRows.map(row => row.user_id), managedRows }
  }

  async function getEffectiveness(db, input) {
    const groupRows = await db.query(
      'SELECT id FROM attendance_groups WHERE id = $1 AND org_id = $2 LIMIT 1',
      [input.groupId, input.orgId],
    )
    if (!groupRows.length) throw new HttpError(404, 'NOT_FOUND', 'Group not found')

    const facts = await loadEffectivenessFacts(db, { orgId: input.orgId, groupId: input.groupId })
    return {
      groupId: input.groupId,
      ...deriveAttendanceGroupFixedScheduleEffectiveness({
        ...facts,
        evaluatedAt: now(),
      }),
    }
  }

  // #4709 FSER-4 prerequisite, contract §2: member-safe self projection. The
  // route (plugins/plugin-attendance/index.cjs) has already resolved the
  // caller's identity solely from the authenticated principal (never a
  // body/query/header selector) before calling this. This function itself
  // proves — in exactly one org-scoped query, before loading any config or
  // assignment fact — that the subject is a live, activated user with an
  // active org membership AND a member of the named group in that same org.
  // Any failure of that proof (missing group, non-membership, inactive or
  // non-activated subject, inactive or missing org membership) throws the
  // SAME values-free 404: this function never discloses which predicate
  // failed. Only after the proof passes does it load the desired config and
  // managed rows, reusing the exact same `loadEffectivenessFacts` and
  // `deriveAttendanceGroupFixedScheduleEffectiveness` the admin route uses —
  // one `now()` call feeds both the state derivation and the response, so a
  // parity check against the admin projection over the same fixture is a
  // same-instant comparison, not two independent wall-clock calls.
  async function getSelfEffectiveness(db, { orgId, groupId, userId }) {
    const proofRows = await db.query(
      `SELECT 1
         FROM users u
         JOIN user_orgs uo ON uo.user_id = u.id AND uo.org_id = $1
         JOIN attendance_group_members agm ON agm.user_id = u.id AND agm.org_id = $1 AND agm.group_id = $2
        WHERE u.id = $3
          AND u.is_active = true
          AND COALESCE(u.activation_status, 'activated') = 'activated'
          AND uo.is_active = true
        LIMIT 1`,
      [orgId, groupId, userId],
    )
    if (!proofRows.length) throw new HttpError(404, 'NOT_FOUND', 'Not found')

    const facts = await loadEffectivenessFacts(db, { orgId, groupId })
    const evaluatedAt = now()
    const derived = deriveAttendanceGroupFixedScheduleEffectiveness({ ...facts, evaluatedAt })
    const applicability = deriveAttendanceGroupFixedScheduleSelfApplicability({
      desired: facts.desired,
      producerKey: facts.producerKey,
      managedRows: facts.managedRows,
      userId,
    })

    // Exact-key projection (contract §2): never `coverage`, `drift`,
    // `managedSets`, `producerKey`, or a raw user identifier.
    return {
      groupId,
      state: derived.state,
      reasonCodes: derived.reasonCodes,
      desired: derived.desired,
      applicability,
      evaluatedAt,
    }
  }

  return { getEffectiveness, getSelfEffectiveness }
}

module.exports = {
  REASON_ORDER,
  deriveAttendanceGroupFixedScheduleEffectiveness,
  deriveAttendanceGroupFixedScheduleSelfApplicability,
  createAttendanceGroupFixedScheduleEffectivenessService,
}
