'use strict'

const { resolveAttendanceTimezone } = require('./attendance-timezone-policy.cjs')
const { AttendanceTimezonePolicyError } = require('./attendance-timezone-policy-store.cjs')

function fail(code, status = 422) {
  throw new AttendanceTimezonePolicyError('ATTENDANCE_TIMEZONE_' + code, status)
}
function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}
function instant(value) {
  return value instanceof Date && Number.isFinite(value.getTime())
}
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00.000Z')
  return instant(parsed) && parsed.toISOString().slice(0, 10) === value
}
function select(input) {
  const result = resolveAttendanceTimezone(input)
  if (result.status !== 'selected') {
    throw new AttendanceTimezonePolicyError(result.code, result.status === 'ambiguous' ? 409 : 422)
  }
  return result
}

// pg returns bigint as text. Convert only a canonical positive integer that
// the selector can represent losslessly; never substitute a constant/revision
// timestamp for missing governance.
function groupRevision(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_GROUP_REVISION')
  return value
}

/**
 * Internal server adapter, not a client selector or permission gate.
 * query and the D1 policyStore MUST bind to the same coherent transaction.
 * The canonical caller takes the org-policy lock before membership/group fact
 * locks; no lock is acquired here below an existing parent/request lock.
 *
 * Future readApprovedTrips({query, orgId, userId, occurredAt, workDate}) must
 * return authoritative same-org final-approved lifecycle rows in the pure
 * selector's TripZone shape. Absence currently means the trip model is not
 * implemented, not a claim that a future trip database is empty. A failed
 * reader never becomes absence; trip authority is never supplied in load input.
 */
function createAttendanceTimezoneContextLoader({ query, policyStore, readApprovedTrips }) {
  if (typeof query !== 'function'
    || !policyStore
    || !['readPolicy', 'readDefault', 'readEmployeeOverride'].every(key => typeof policyStore[key] === 'function')
    || (readApprovedTrips !== undefined && typeof readApprovedTrips !== 'function')) {
    fail('INVALID_ADAPTER')
  }
  async function rows(sql, values) {
    const result = await query(sql, values)
    if (!result || !Array.isArray(result.rows)) fail('SOURCE_UNAVAILABLE', 503)
    return result.rows
  }
  return async function loadAttendanceTimezoneContext(input) {
    const { orgId, userId, occurredAt, workDate } = input || {}
    if (!identifier(orgId) || !identifier(userId)) fail('INVALID_REFERENCE')
    if (!instant(occurredAt)) fail('INVALID_INSTANT')
    if (!dateKey(workDate)) fail('INVALID_WORK_DATE')
    const at = new Date(occurredAt.getTime())
    try {
      const policy = await policyStore.readPolicy({ orgId })
      if (!policy || typeof policy.enabled !== 'boolean') fail('INVALID_ENABLED')
      if (!Number.isSafeInteger(policy.version) || policy.version < (policy.enabled ? 1 : 0)) {
        fail('INVALID_REVISION')
      }
      const systemDefault = await policyStore.readDefault({ orgId })
      const base = { orgId, userId, systemDefault }
      const defaultResult = select({ ...base, enabled: false })
      function context(result, membership) {
        return {
          ...result,
          policyVersion: policy.version,
          resolvedForInstant: new Date(at.getTime()),
          targetWorkDate: workDate,
          calculationGroupMembership: membership,
        }
      }
      if (!policy.enabled) return context(defaultResult, null)

      const employee = await policyStore.readEmployeeOverride({ orgId, userId, at })
      if (employee !== null && (!employee || employee.orgId !== orgId || employee.userId !== userId
        || !instant(employee.effectiveFrom)
        || (employee.effectiveTo !== null && !instant(employee.effectiveTo))
        || employee.effectiveFrom > at
        || (employee.effectiveTo !== null && employee.effectiveTo <= at))) {
        fail('INVALID_EMPLOYEE_INTERVAL')
      }
      // W1 membership is a closed DATE interval, unlike employee/trip UTC [from,to).
      // Keep membership id/bounds separately: the group counter does not govern
      // membership timeline mutations.
      const memberships = await rows(
        'SELECT id, org_id, user_id, group_id, effective_from::text AS effective_from, effective_to::text AS effective_to '
          + 'FROM attendance_calculation_group_memberships WHERE org_id = $1 AND user_id = $2 '
          + 'AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)',
        [orgId, userId, workDate],
      )
      if (memberships.length > 1) fail('MULTIPLE_CALCULATION_GROUPS', 409)
      let membership = null
      const groups = []
      if (memberships.length) {
        const row = memberships[0]
        if (row.org_id !== orgId || row.user_id !== userId || !identifier(row.id) || !identifier(row.group_id)
          || !dateKey(row.effective_from) || row.effective_from > workDate
          || (row.effective_to !== null && (!dateKey(row.effective_to) || row.effective_to < workDate))) {
          fail('INVALID_REFERENCE')
        }
        const groupRows = await rows('SELECT id, org_id, timezone FROM attendance_groups WHERE id = $1 AND org_id = $2',
          [row.group_id, orgId])
        if (groupRows.length !== 1) fail('GROUP_REQUIRED')
        const group = groupRows[0]
        if (group.id !== row.group_id || group.org_id !== orgId) fail('INVALID_REFERENCE')
        const revisions = await rows('SELECT revision FROM attendance_group_effect_revisions WHERE org_id = $1', [orgId])
        if (revisions.length !== 1) fail('GROUP_REVISION_REQUIRED')
        const version = groupRevision(revisions[0].revision)
        groups.push({ orgId, userId, referenceId: group.id, version, timezone: group.timezone })
        membership = {
          membershipId: row.id, groupId: row.group_id,
          effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
        }
      }
      // The existing DB trigger increments this ORG-wide counter for every
      // attendance_groups mutation, including raw SQL and other groups in the
      // org. This is deliberately conservative, not a per-group timezone revision.
      const trips = readApprovedTrips
        ? await readApprovedTrips({ query, orgId, userId, occurredAt: new Date(at.getTime()), workDate })
        : undefined
      if (readApprovedTrips && !Array.isArray(trips)) fail('INVALID_TRIP_SOURCE')
      const result = select({
        ...base, enabled: true, occurredAt: at,
        employeeOverrides: employee === null ? [] : [employee],
        calculationGroups: groups,
        ...(trips === undefined ? {} : { trips }),
      })
      return context(result, membership)
    } catch (error) {
      if (error instanceof AttendanceTimezonePolicyError) throw error
      fail('SOURCE_UNAVAILABLE', 503)
    }
  }
}

module.exports = { createAttendanceTimezoneContextLoader }
