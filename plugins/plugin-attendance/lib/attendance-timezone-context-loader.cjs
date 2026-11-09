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
function createAttendanceTimezoneContextLoader({ query, policyStore, readApprovedTrips, readCalc14Sources, useRetainedPolicy = true }) {
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
  async function effectivePolicy(input, retained) {
    const policy = retained && useRetainedPolicy ? retained.rule.calc14_timezone_policy : await policyStore.readPolicy({ orgId: input.orgId })
    if (!policy || typeof policy.enabled !== 'boolean') fail('INVALID_ENABLED')
    if (!Number.isSafeInteger(policy.version) || policy.version < (policy.enabled ? 1 : 0)) {
      fail('INVALID_REVISION')
    }
    return policy
  }
  const loadAttendanceTimezoneContext = async function (input) {
    const { orgId, userId, occurredAt, workDate } = input || {}
    if (!identifier(orgId) || !identifier(userId)) fail('INVALID_REFERENCE')
    if (!instant(occurredAt)) fail('INVALID_INSTANT')
    if (!dateKey(workDate)) fail('INVALID_WORK_DATE')
    const at = new Date(occurredAt.getTime())
    try {
      const retained = readCalc14Sources ? await readCalc14Sources(input) : null
      const policy = await effectivePolicy(input, retained)
      const systemDefault = retained ? {
        orgId,referenceId:String(retained.rule.__calc14_version),version:retained.rule.__calc14_version,
        timezone:retained.rule.timezone,
      } : await policyStore.readDefault({ orgId })
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
      const retainedMemberships = retained?.userPublication?.memberships
      if (retained && (!Array.isArray(retainedMemberships) || retainedMemberships.some(row =>
        !row || !identifier(row.id) || !identifier(row.group_id) || !dateKey(row.effective_from)
        || (row.effective_to !== null && (!dateKey(row.effective_to) || row.effective_to < row.effective_from))))) {
        fail('INVALID_REFERENCE')
      }
      // Retained user-publication rows are already scoped by the core reader to
      // this org/user. Current W1 deletion must not erase the historical interval.
      const memberships = retained ? retainedMemberships
        .filter(row => row.effective_from <= workDate && (row.effective_to === null || row.effective_to >= workDate))
        .map(row => ({ id: row.id, org_id: orgId, user_id: userId, group_id: row.group_id,
          effective_from: row.effective_from, effective_to: row.effective_to }))
        : await rows(
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
        const groupRows = retained ? [retained.group] : await rows('SELECT id, org_id, timezone FROM attendance_groups WHERE id = $1 AND org_id = $2',
          [row.group_id, orgId])
        if (groupRows.length !== 1) fail('GROUP_REQUIRED')
        const group = groupRows[0]
        if (group.id !== row.group_id || group.org_id !== orgId) fail('INVALID_REFERENCE')
        const revisions = retained ? [{revision:retained.group.__calc14_version}]
          : await rows('SELECT revision FROM attendance_group_effect_revisions WHERE org_id = $1', [orgId])
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
  // Internal window-preload seam: use the same dated policy and validation as
  // the instant selector before deciding which optional intervals to fetch.
  loadAttendanceTimezoneContext.readEffectivePolicy = async input => {
    const { orgId, userId, workDate } = input || {}
    if (!identifier(orgId) || !identifier(userId)) fail('INVALID_REFERENCE')
    if (!dateKey(workDate)) fail('INVALID_WORK_DATE')
    const retained = readCalc14Sources ? await readCalc14Sources(input) : null
    return effectivePolicy(input, retained)
  }
  return loadAttendanceTimezoneContext
}

module.exports = { createAttendanceTimezoneContextLoader }
