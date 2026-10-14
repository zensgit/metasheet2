'use strict'

/**
 * D1 pure timezone selection. A future server adapter supplies authoritative,
 * effective, same-org rows; these inputs are never online-punch client authority.
 * No DB, flag/clock reads or wall-clock conversion. Provenance stays internal.
 * OFF selects a validated system default, not a claim of legacy byte identity.
 *
 * @typedef {{orgId: string, referenceId: string, version: number, timezone: string}} DefaultZone
 * @typedef {{orgId: string, userId: string, referenceId: string, version: number, timezone: string}} EmployeeZone
 * @typedef {{orgId: string, userId: string, referenceId: string, version: number, timezone?: string|null}} GroupZone
 * @typedef {EmployeeZone & {approvalStatus: 'approved'|'pending'|'rejected', lifecycleStatus: 'ACTIVE'|'INACTIVE', startAt: Date, endAt: Date}} TripZone
 * @typedef {'system_default'|'trip'|'employee_override'|'calculation_group'} ZoneSource
 * @typedef {'default_only'|'multi_timezone'} ZoneMode
 * @typedef {'ATTENDANCE_TIMEZONE_INVALID_INPUT'|'ATTENDANCE_TIMEZONE_INVALID_ENABLED'|'ATTENDANCE_TIMEZONE_INVALID_REFERENCE'|'ATTENDANCE_TIMEZONE_INVALID_ZONE'|'ATTENDANCE_TIMEZONE_INVALID_INSTANT'|'ATTENDANCE_TIMEZONE_INVALID_TRIP_STATUS'|'ATTENDANCE_TIMEZONE_INVALID_TRIP_INTERVAL'} InvalidCode
 * @typedef {'ATTENDANCE_TIMEZONE_MULTIPLE_TRIPS'|'ATTENDANCE_TIMEZONE_MULTIPLE_EMPLOYEE_OVERRIDES'|'ATTENDANCE_TIMEZONE_MULTIPLE_CALCULATION_GROUPS'} AmbiguousCode
 * @typedef {{status: 'selected', timezone: string, source: ZoneSource, mode: ZoneMode, referenceId: string, version: number}|{status: 'invalid', code: InvalidCode}|{status: 'ambiguous', code: AmbiguousCode}} ZoneResult
 */

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function isInstant(value) {
  return value instanceof Date && Number.isFinite(value.getTime())
}

// Match the existing work-date resolver's Intl validation, without dependencies.
function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(new Date(0))
    return true
  } catch (_error) {
    return false
  }
}

function hasValidReference(row, orgId, userId) {
  return row && typeof row === 'object' && !Array.isArray(row)
    && row.orgId === orgId
    && (userId === undefined || row.userId === userId)
    && isIdentifier(row.referenceId)
    && Number.isSafeInteger(row.version) && row.version > 0
}

/** @param {InvalidCode} code @returns {ZoneResult} */
function invalid(code) {
  return { status: 'invalid', code }
}

/** @returns {ZoneResult} */
function select(row, source, mode) {
  if (!isValidTimeZone(row.timezone)) return invalid('ATTENDANCE_TIMEZONE_INVALID_ZONE')
  return {
    status: 'selected',
    timezone: row.timezone.trim(),
    source,
    mode,
    referenceId: row.referenceId,
    version: row.version,
  }
}

/**
 * ON requires occurredAt; OFF never reads it or the optional source rows.
 * Optional row arrays mean absence, never query failure. 'approved' means final
 * approved; an adapter must not map an intermediate approval step to this value.
 * Trips use UTC [startAt, endAt). Multiple rows at the selecting tier are
 * ambiguous even with equal zones. A group with no zone inherits the default;
 * group lookup is independent of W7 enablement.
 * @param {{enabled?: boolean, orgId: string, userId: string, occurredAt?: Date, systemDefault: DefaultZone, trips?: TripZone[], employeeOverrides?: EmployeeZone[], calculationGroups?: GroupZone[]}} input
 * @returns {ZoneResult}
 */
function resolveAttendanceTimezone(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !isIdentifier(input.orgId) || !isIdentifier(input.userId)) {
    return invalid('ATTENDANCE_TIMEZONE_INVALID_INPUT')
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return invalid('ATTENDANCE_TIMEZONE_INVALID_ENABLED')
  }
  if (!hasValidReference(input.systemDefault, input.orgId)) {
    return invalid('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
  }
  const mode = input.enabled === true ? 'multi_timezone' : 'default_only'
  const defaultResult = select(input.systemDefault, 'system_default', mode)
  if (defaultResult.status !== 'selected' || input.enabled !== true) return defaultResult
  if (!isInstant(input.occurredAt)) return invalid('ATTENDANCE_TIMEZONE_INVALID_INSTANT')

  const trips = input.trips === undefined ? [] : input.trips
  const employees = input.employeeOverrides === undefined ? [] : input.employeeOverrides
  const groups = input.calculationGroups === undefined ? [] : input.calculationGroups
  if (![trips, employees, groups].every(Array.isArray)) {
    return invalid('ATTENDANCE_TIMEZONE_INVALID_INPUT')
  }
  // Identity/provenance frames must remain valid even below the selecting tier.
  for (const rows of [trips, employees, groups]) {
    for (const row of rows) {
      if (!hasValidReference(row, input.orgId, input.userId)) {
        return invalid('ATTENDANCE_TIMEZONE_INVALID_REFERENCE')
      }
    }
  }
  for (const trip of trips) {
    if (!['approved', 'pending', 'rejected'].includes(trip.approvalStatus)
      || !['ACTIVE', 'INACTIVE'].includes(trip.lifecycleStatus)) {
      return invalid('ATTENDANCE_TIMEZONE_INVALID_TRIP_STATUS')
    }
    if (!isInstant(trip.startAt) || !isInstant(trip.endAt)
      || trip.endAt.getTime() <= trip.startAt.getTime()) {
      return invalid('ATTENDANCE_TIMEZONE_INVALID_TRIP_INTERVAL')
    }
  }
  const instant = input.occurredAt.getTime()
  const eligibleTrips = trips.filter(trip => trip.approvalStatus === 'approved'
    && trip.lifecycleStatus === 'ACTIVE'
    && instant >= trip.startAt.getTime() && instant < trip.endAt.getTime())
  for (const [rows, source, code] of [
    [eligibleTrips, 'trip', 'ATTENDANCE_TIMEZONE_MULTIPLE_TRIPS'],
    [employees, 'employee_override', 'ATTENDANCE_TIMEZONE_MULTIPLE_EMPLOYEE_OVERRIDES'],
    [groups, 'calculation_group', 'ATTENDANCE_TIMEZONE_MULTIPLE_CALCULATION_GROUPS'],
  ]) {
    if (rows.length > 1) return { status: 'ambiguous', code }
    if (rows.length === 1) {
      if (source === 'calculation_group' && rows[0].timezone == null) return defaultResult
      return select(rows[0], source, mode)
    }
  }
  return defaultResult
}

module.exports = { resolveAttendanceTimezone }
