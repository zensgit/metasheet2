'use strict'

/**
 * Canonical fixed-schedule producer key — the single implementation.
 *
 * The producer key is the join key the fixed-schedule effectiveness
 * derivation (FSER) uses to decide which `attendance_shift_assignments` rows
 * are "ours" versus `differentKeyRows`. W6-R4 requires this to have exactly
 * one implementation: `index.cjs` delegates its own
 * `buildAttendanceGroupFixedScheduleProducerKey` here, and the backend's
 * `/effective-policy` route injects this same function into the FSER
 * instance it builds, so both call sites run identical code.
 *
 * Placed under `lib/` rather than exported from `index.cjs` because the
 * backend's plugin-lib resolver only resolves files under
 * `plugins/plugin-attendance/lib/` (see `resolve-plugin-attendance-lib.ts`).
 *
 * Scope note: what is single-source here is the producer-key path.
 * `index.cjs` keeps its own general-purpose `normalizeDateOnly` for its
 * other call sites; this module carries the date-only normalisation the
 * producer key needs. `index.cjs`'s test seam exposes its `normalizeDateOnly`
 * so a parity test can prove the two agree — see
 * `tests/unit/attendance-w6-producer-key-single-source.test.ts`.
 */

const ATTENDANCE_GROUP_FIXED_SCHEDULE_PRODUCER_TYPE = 'attendance_group_fixed_schedule'

/**
 * Byte-for-byte the semantics of `normalizeDateOnly` in
 * `plugins/plugin-attendance/index.cjs`. Kept in agreement by an executable
 * parity test over a shared input table, not by comment.
 */
function normalizeDateOnly(value) {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d{10,13}$/.test(raw)) {
    const ts = Number(raw.length === 10 ? `${raw}000` : raw)
    if (Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10)
  }
  const match = raw.match(/(\d{2,4})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    let year = match[1]
    const month = match[2].padStart(2, '0')
    const day = match[3].padStart(2, '0')
    if (year.length === 2) year = `20${year}`
    return `${year.padStart(4, '0')}-${month}-${day}`
  }
  if (raw.includes('T')) return raw.slice(0, 10)
  if (raw.includes(' ')) return raw.split(' ')[0]
  return raw.slice(0, 10)
}

/** The canonical assignment end-date normalisation (`normalizeDateOnly` with a
 * pass-through fallback), unchanged from `index.cjs`. */
function normalizeAttendanceScheduleAssignmentEndDate(value) {
  const normalized = normalizeDateOnly(value)
  return normalized || value || null
}

/** The canonical producer key. `endDate` is normalised before the join. */
function buildAttendanceGroupFixedScheduleProducerKey(input) {
  const endDate = normalizeAttendanceScheduleAssignmentEndDate(input.endDate)
  return [
    ATTENDANCE_GROUP_FIXED_SCHEDULE_PRODUCER_TYPE,
    input.groupId,
    input.shiftId,
    input.startDate,
    endDate ?? 'null',
  ].join(':')
}

module.exports = {
  ATTENDANCE_GROUP_FIXED_SCHEDULE_PRODUCER_TYPE,
  normalizeDateOnly,
  normalizeAttendanceScheduleAssignmentEndDate,
  buildAttendanceGroupFixedScheduleProducerKey,
}
