'use strict'

/**
 * AttendanceWorkDateResolver (W2 / #4556)
 *
 * Shared, dependency-injected CommonJS work-date resolver used by live punch,
 * import, correction, overtime, recompute, and scheduled derivation.
 *
 * Output is a closed union: resolved | ambiguous | unresolved.
 * Candidates are atomic (workDate, shiftId, segmentIndex, absoluteWindow).
 * W2 does not implement segments yet → segmentIndex is always null.
 *
 * Contract note (hard stop — free_time / unscheduled / explicit-import):
 *   `resolved.shiftId` is REQUIRED and non-null. free_time groups, unscheduled
 *   days, and explicit-import rows without an org-scoped published shift cannot
 *   honestly produce a non-null shiftId. Those paths return `unresolved` with a
 *   dedicated reasonCode. This module deliberately does NOT nullable-widen
 *   shiftId and does NOT invent a synthetic/default shift.
 */

const DEFAULT_ATTRIBUTION_TAIL_MINUTES = 120
// Safe upper bound (OD-4556-6): the tail is bounded, never a full day.
const MAX_ATTRIBUTION_TAIL_MINUTES = 360
const OVERTIME_ATTRIBUTION_VERSION = 1
const OVERTIME_ATTRIBUTION_KEY = 'overtimeAttributionV1'
const FROZEN_ATTRIBUTION_KEY = 'workDateAttributionV1'

const REASON = Object.freeze({
  // resolved
  OPEN_PREVIOUS_NIGHT_RECORD: 'OPEN_PREVIOUS_NIGHT_RECORD',
  CURRENT_DAY_CONTAINING_SHIFT: 'CURRENT_DAY_CONTAINING_SHIFT',
  PREVIOUS_NIGHT_CONTAINING_SHIFT: 'PREVIOUS_NIGHT_CONTAINING_SHIFT',
  SINGLE_MATCHING_CANDIDATE: 'SINGLE_MATCHING_CANDIDATE',
  FROZEN_ATTRIBUTION: 'FROZEN_ATTRIBUTION',
  OVERTIME_EXTENDED_WINDOW: 'OVERTIME_EXTENDED_WINDOW',
  POST_SHIFT_ATTRIBUTION_TAIL: 'POST_SHIFT_ATTRIBUTION_TAIL',
  // ambiguous
  OVERLAPPING_SHIFT_WINDOWS: 'OVERLAPPING_SHIFT_WINDOWS',
  MULTIPLE_PUBLISHED_CANDIDATES: 'MULTIPLE_PUBLISHED_CANDIDATES',
  // unresolved
  NO_MATCHING_SHIFT: 'NO_MATCHING_SHIFT',
  FREE_TIME_NO_SHIFT: 'FREE_TIME_NO_SHIFT',
  UNSCHEDULED_NO_SHIFT: 'UNSCHEDULED_NO_SHIFT',
  EXPLICIT_IMPORT_REQUIRES_SHIFT: 'EXPLICIT_IMPORT_REQUIRES_SHIFT',
  EXPLICIT_SHIFT_MISMATCH: 'EXPLICIT_SHIFT_MISMATCH',
  MALFORMED_CROSS_ORG_REFERENCE: 'MALFORMED_CROSS_ORG_REFERENCE',
  MALFORMED_CROSS_USER_REFERENCE: 'MALFORMED_CROSS_USER_REFERENCE',
  MALFORMED_CANDIDATE_SHAPE: 'MALFORMED_CANDIDATE_SHAPE',
  MALFORMED_CANDIDATE_SOURCE: 'MALFORMED_CANDIDATE_SOURCE',
  INVALID_INPUT: 'INVALID_INPUT',
  NO_PUBLISHED_CANDIDATE: 'NO_PUBLISHED_CANDIDATE',
})

const CHANNELS = Object.freeze([
  'live',
  'import',
  'correction',
  'overtime',
  'recompute',
  'scheduled',
])

function clampAttributionTailMinutes(value, fallback = DEFAULT_ATTRIBUTION_TAIL_MINUTES) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const floored = Math.floor(n)
  if (floored < 0) return 0
  if (floored > MAX_ATTRIBUTION_TAIL_MINUTES) return MAX_ATTRIBUTION_TAIL_MINUTES
  return floored
}

function normalizeWorkDateAttributionSetting(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    // Bounded post-shift attribution tail. NEVER reuse lateGrace/earlyGrace/tolerance.
    postShiftTailMinutes: clampAttributionTailMinutes(
      config.postShiftTailMinutes ?? config.post_shift_tail_minutes,
      DEFAULT_ATTRIBUTION_TAIL_MINUTES,
    ),
  }
}

function isDateInstance(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(new Date(0))
    return true
  } catch (_error) {
    return false
  }
}

function toIso(value) {
  if (!isDateInstance(value)) return null
  return value.toISOString()
}

function serializeCandidate(candidate) {
  return {
    workDate: candidate.workDate,
    shiftId: candidate.shiftId,
    segmentIndex: candidate.segmentIndex == null ? null : candidate.segmentIndex,
    absoluteWindow: {
      startAt: toIso(candidate.absoluteWindow.startAt),
      endAt: toIso(candidate.absoluteWindow.endAt),
    },
    source: candidate.source || null,
    assignmentId: candidate.assignmentId || null,
    isOvernight: candidate.isOvernight === true,
  }
}

/**
 * Ambiguity payload contract: candidates expose ONLY
 * workDate / shiftId / segmentIndex / absoluteWindow. No source, assignmentId,
 * or internal flags leak into the actionable error surface.
 */
function serializeAmbiguousCandidate(candidate) {
  return {
    workDate: candidate.workDate,
    shiftId: candidate.shiftId,
    segmentIndex: candidate.segmentIndex == null ? null : candidate.segmentIndex,
    absoluteWindow: {
      startAt: toIso(candidate.absoluteWindow?.startAt),
      endAt: toIso(candidate.absoluteWindow?.endAt),
    },
  }
}

/** Deterministic total order so ambiguity payloads never depend on row order. */
function compareCandidatesStable(a, b) {
  const byWorkDate = String(a.workDate).localeCompare(String(b.workDate))
  if (byWorkDate !== 0) return byWorkDate
  const byShift = String(a.shiftId).localeCompare(String(b.shiftId))
  if (byShift !== 0) return byShift
  const segA = a.segmentIndex == null ? -1 : Number(a.segmentIndex)
  const segB = b.segmentIndex == null ? -1 : Number(b.segmentIndex)
  if (segA !== segB) return segA - segB
  const startA = isDateInstance(a.absoluteWindow?.startAt) ? a.absoluteWindow.startAt.getTime() : 0
  const startB = isDateInstance(b.absoluteWindow?.startAt) ? b.absoluteWindow.startAt.getTime() : 0
  if (startA !== startB) return startA - startB
  const endA = isDateInstance(a.absoluteWindow?.endAt) ? a.absoluteWindow.endAt.getTime() : 0
  const endB = isDateInstance(b.absoluteWindow?.endAt) ? b.absoluteWindow.endAt.getTime() : 0
  return endA - endB
}

function buildAbsoluteWindow({
  workDate,
  workStartTime,
  workEndTime,
  timezone,
  isOvernight,
  buildZonedDate,
  addDaysToDateKey,
}) {
  if (!workDate || !workStartTime || !workEndTime || typeof buildZonedDate !== 'function') {
    return null
  }
  const endDate = isOvernight && typeof addDaysToDateKey === 'function'
    ? addDaysToDateKey(workDate, 1)
    : workDate
  if (!endDate) return null
  const startAt = buildZonedDate(workDate, workStartTime, timezone)
  const endAt = buildZonedDate(endDate, workEndTime, timezone)
  if (!isDateInstance(startAt) || !isDateInstance(endAt)) return null
  if (endAt.getTime() <= startAt.getTime()) return null
  return { startAt, endAt }
}

/**
 * Build attribution window from absolute shift window + bounded tail + optional OT extension.
 * Grace/tolerance are intentionally NOT parameters and must never be applied here.
 */
function buildAttributionWindow(absoluteWindow, options = {}) {
  if (!absoluteWindow || !isDateInstance(absoluteWindow.startAt) || !isDateInstance(absoluteWindow.endAt)) {
    return null
  }
  const tailMinutes = clampAttributionTailMinutes(
    options.attributionTailMinutes,
    DEFAULT_ATTRIBUTION_TAIL_MINUTES,
  )
  let endMs = absoluteWindow.endAt.getTime() + tailMinutes * 60000

  const approvedOvertimeWindows = Array.isArray(options.approvedOvertimeWindows)
    ? options.approvedOvertimeWindows
    : []
  for (const ot of approvedOvertimeWindows) {
    if (!ot) continue
    // Both the approved request row and its creation-frozen anchor must prove
    // the complete identity. Never fill missing fields from resolver context.
    if (String(ot.orgId) !== String(options.orgId)) continue
    if (String(ot.userId) !== String(options.userId)) continue
    if (String(ot.workDate) !== String(options.workDate)) continue
    if (String(ot.shiftId) !== String(options.shiftId)) continue
    // Legacy or partial anchors never extend/backfill.
    const anchor = parseOvertimeAttributionV1(ot.anchor)
    if (!anchor) continue
    if (anchor.orgId !== String(options.orgId)) continue
    if (anchor.userId !== String(options.userId)) continue
    if (anchor.workDate !== String(options.workDate)) continue
    if (anchor.shiftId !== String(options.shiftId)) continue
    const approvedEnd = isDateInstance(ot.approvedEndAt)
      ? ot.approvedEndAt
      : (ot.approvedEndAt ? new Date(ot.approvedEndAt) : null)
    if (!isDateInstance(approvedEnd)) continue
    const otEndMs = approvedEnd.getTime() + tailMinutes * 60000
    if (otEndMs > endMs) endMs = otEndMs
  }

  return {
    startAt: absoluteWindow.startAt,
    endAt: new Date(endMs),
  }
}

function isInstantInWindow(occurredAt, window) {
  if (!isDateInstance(occurredAt) || !window) return false
  if (!isDateInstance(window.startAt) || !isDateInstance(window.endAt)) return false
  const ms = occurredAt.getTime()
  return ms >= window.startAt.getTime() && ms <= window.endAt.getTime()
}

function parseOvertimeAttributionV1(raw) {
  if (!raw || typeof raw !== 'object') return null
  const version = Number(raw.version)
  if (version !== OVERTIME_ATTRIBUTION_VERSION) return null
  const orgId = raw.orgId == null ? null : String(raw.orgId)
  const userId = raw.userId == null ? null : String(raw.userId)
  const workDate = raw.workDate == null ? null : String(raw.workDate)
  const shiftId = raw.shiftId == null ? null : String(raw.shiftId)
  const source = raw.source === 'shift' || raw.source === 'rotation' ? raw.source : null
  const assignmentId = raw.assignmentId == null ? null : String(raw.assignmentId)
  if (!orgId || !userId || !workDate || !shiftId || !source || !assignmentId) return null
  return {
    version: OVERTIME_ATTRIBUTION_VERSION,
    orgId,
    userId,
    workDate,
    shiftId,
    source,
    assignmentId,
  }
}

function buildOvertimeAttributionV1({ orgId, userId, workDate, shiftId, source, assignmentId }) {
  const anchor = parseOvertimeAttributionV1({
    version: OVERTIME_ATTRIBUTION_VERSION,
    orgId,
    userId,
    workDate,
    shiftId,
    source,
    assignmentId,
  })
  if (!anchor) {
    throw new Error('OVERTIME_ATTRIBUTION_INVALID')
  }
  return anchor
}

function anchorsEqual(a, b) {
  const left = parseOvertimeAttributionV1(a)
  const right = parseOvertimeAttributionV1(b)
  if (!left || !right) return false
  return (
    left.version === right.version
    && left.orgId === right.orgId
    && left.userId === right.userId
    && left.workDate === right.workDate
    && left.shiftId === right.shiftId
    && left.source === right.source
    && left.assignmentId === right.assignmentId
  )
}

/**
 * Frozen work-date attribution snapshot contract (version 1):
 * requires version=1 + orgId + userId + workDate + shiftId. Snapshots missing
 * identity fields are NOT honored — they predate the versioned contract.
 */
function parseFrozenWorkDateAttribution(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (Number(raw.version) !== 1) return null
  const orgId = raw.orgId == null ? null : String(raw.orgId)
  const userId = raw.userId == null ? null : String(raw.userId)
  const workDate = raw.workDate == null ? null : String(raw.workDate)
  const shiftId = raw.shiftId == null ? null : String(raw.shiftId)
  if (!orgId || !userId || !workDate || !shiftId) return null
  // W2 has no segment-aware attribution. A non-null value belongs to a future
  // contract version and must not be accepted under version 1.
  if (raw.segmentIndex != null) return null
  const segmentIndex = null
  return {
    version: 1,
    orgId,
    userId,
    workDate,
    shiftId,
    segmentIndex,
    reasonCode: raw.reasonCode == null ? REASON.FROZEN_ATTRIBUTION : String(raw.reasonCode),
    evidenceSnapshot: raw.evidenceSnapshot && typeof raw.evidenceSnapshot === 'object'
      ? raw.evidenceSnapshot
      : null,
  }
}

function buildFrozenWorkDateAttribution(resolved, identity = null) {
  if (!resolved || resolved.kind !== 'resolved') return null
  if (resolved.segmentIndex != null) return null
  const orgId = identity?.orgId ?? null
  const userId = identity?.userId ?? null
  if (!orgId || !userId) return null
  return {
    version: 1,
    orgId: String(orgId),
    userId: String(userId),
    workDate: resolved.workDate,
    shiftId: resolved.shiftId,
    segmentIndex: resolved.segmentIndex == null ? null : resolved.segmentIndex,
    reasonCode: resolved.reasonCode,
    evidenceSnapshot: resolved.evidenceSnapshot || null,
  }
}

function resolvedResult({ workDate, shiftId, segmentIndex = null, reasonCode, evidenceSnapshot }) {
  if (!workDate || !shiftId) {
    throw new Error('resolved requires non-null workDate and shiftId')
  }
  if (segmentIndex != null) {
    throw new Error('W2 resolved requires null segmentIndex')
  }
  return {
    kind: 'resolved',
    workDate: String(workDate),
    shiftId: String(shiftId),
    segmentIndex: null,
    reasonCode,
    evidenceSnapshot: evidenceSnapshot || null,
  }
}

function ambiguousResult({ candidates, reasonCode }) {
  const ordered = (Array.isArray(candidates) ? [...candidates] : []).sort(compareCandidatesStable)
  return {
    kind: 'ambiguous',
    candidates: ordered.map(serializeAmbiguousCandidate),
    reasonCode,
  }
}

function unresolvedResult({ reasonCode, evidenceSnapshot = null }) {
  return {
    kind: 'unresolved',
    reasonCode,
    evidenceSnapshot,
  }
}

/**
 * Pure selection over already-built atomic candidates.
 * Precedence (OD-4556-8):
 *   1. open previous-night record whose window contains the punch
 *   2. current-day containing shift (absolute window, not merely tail)
 *   3. single remaining match
 *   4. actionable ambiguity for ties
 */
function selectAmongMatchingCandidates({
  matching,
  occurredAt,
  calendarWorkDate,
  openRecords,
  attributionTailMinutes,
  orgId,
  userId,
}) {
  if (!Array.isArray(matching) || matching.length === 0) {
    return unresolvedResult({ reasonCode: REASON.NO_MATCHING_SHIFT })
  }

  const openByWorkDate = new Map()
  for (const record of Array.isArray(openRecords) ? openRecords : []) {
    if (!record || !record.workDate) continue
    if (!record.orgId || String(record.orgId) !== String(orgId)) continue
    if (!record.userId || String(record.userId) !== String(userId)) continue
    // Open = has first_in, missing last_out (incomplete overnight / partial).
    const hasIn = Boolean(record.firstInAt || record.first_in_at)
    const hasOut = Boolean(record.lastOutAt || record.last_out_at)
    if (hasIn && !hasOut) {
      openByWorkDate.set(String(record.workDate), record)
    }
  }

  const openPreviousMatches = matching.filter((candidate) => {
    if (!openByWorkDate.has(String(candidate.workDate))) return false
    // Open previous-night precedence requires the previous candidate ITSELF to be
    // an overnight shift whose workDate is strictly before the calendar day.
    if (calendarWorkDate && String(candidate.workDate) >= String(calendarWorkDate)) return false
    return candidate.isOvernight === true
  })

  if (openPreviousMatches.length === 1) {
    const winner = openPreviousMatches[0]
    return resolvedResult({
      workDate: winner.workDate,
      shiftId: winner.shiftId,
      segmentIndex: winner.segmentIndex,
      reasonCode: REASON.OPEN_PREVIOUS_NIGHT_RECORD,
      orgId: winner.orgId,
      userId: winner.userId,
      evidenceSnapshot: {
        calendarWorkDate,
        attributionTailMinutes,
        winner: serializeCandidate(winner),
        openRecordWorkDate: winner.workDate,
        matchingCount: matching.length,
      },
    })
  }
  if (openPreviousMatches.length > 1) {
    return ambiguousResult({
      candidates: openPreviousMatches,
      reasonCode: REASON.OVERLAPPING_SHIFT_WINDOWS,
    })
  }

  // Current-day containing shift: punch inside the ABSOLUTE shift window for calendar day.
  const currentDayContaining = matching.filter((candidate) => {
    if (!calendarWorkDate || String(candidate.workDate) !== String(calendarWorkDate)) return false
    return isInstantInWindow(occurredAt, candidate.absoluteWindow)
  })
  if (currentDayContaining.length === 1) {
    const winner = currentDayContaining[0]
    const inAbsolute = isInstantInWindow(occurredAt, winner.absoluteWindow)
    const inTailOnly = !inAbsolute && isInstantInWindow(occurredAt, winner.attributionWindow)
    return resolvedResult({
      workDate: winner.workDate,
      shiftId: winner.shiftId,
      segmentIndex: winner.segmentIndex,
      reasonCode: inTailOnly
        ? REASON.POST_SHIFT_ATTRIBUTION_TAIL
        : (winner.extendedByOvertime ? REASON.OVERTIME_EXTENDED_WINDOW : REASON.CURRENT_DAY_CONTAINING_SHIFT),
      orgId: winner.orgId,
      userId: winner.userId,
      evidenceSnapshot: {
        calendarWorkDate,
        attributionTailMinutes,
        winner: serializeCandidate(winner),
        matchingCount: matching.length,
      },
    })
  }
  if (currentDayContaining.length > 1) {
    return ambiguousResult({
      candidates: currentDayContaining,
      reasonCode: REASON.OVERLAPPING_SHIFT_WINDOWS,
    })
  }

  // Previous-night containing (no open record): still valid for post-midnight punches inside
  // the previous overnight absolute/attribution window (fold of #4558).
  const previousNightContaining = matching.filter((candidate) => {
    if (calendarWorkDate && String(candidate.workDate) >= String(calendarWorkDate)) return false
    return candidate.isOvernight === true
  })
  if (previousNightContaining.length === 1 && matching.length === 1) {
    const winner = previousNightContaining[0]
    return resolvedResult({
      workDate: winner.workDate,
      shiftId: winner.shiftId,
      segmentIndex: winner.segmentIndex,
      reasonCode: REASON.PREVIOUS_NIGHT_CONTAINING_SHIFT,
      orgId: winner.orgId,
      userId: winner.userId,
      evidenceSnapshot: {
        calendarWorkDate,
        attributionTailMinutes,
        winner: serializeCandidate(winner),
        matchingCount: matching.length,
      },
    })
  }

  if (matching.length === 1) {
    const winner = matching[0]
    const inAbsolute = isInstantInWindow(occurredAt, winner.absoluteWindow)
    let reasonCode = REASON.SINGLE_MATCHING_CANDIDATE
    if (winner.extendedByOvertime && !inAbsolute) reasonCode = REASON.OVERTIME_EXTENDED_WINDOW
    else if (!inAbsolute) reasonCode = REASON.POST_SHIFT_ATTRIBUTION_TAIL
    else if (calendarWorkDate && String(winner.workDate) === String(calendarWorkDate)) {
      reasonCode = REASON.CURRENT_DAY_CONTAINING_SHIFT
    } else if (winner.isOvernight) {
      reasonCode = REASON.PREVIOUS_NIGHT_CONTAINING_SHIFT
    }
    return resolvedResult({
      workDate: winner.workDate,
      shiftId: winner.shiftId,
      segmentIndex: winner.segmentIndex,
      reasonCode,
      orgId: winner.orgId,
      userId: winner.userId,
      evidenceSnapshot: {
        calendarWorkDate,
        attributionTailMinutes,
        winner: serializeCandidate(winner),
        matchingCount: 1,
      },
    })
  }

  // Tie between previous overnight and current-day (or multiple) without open-record winner.
  return ambiguousResult({
    candidates: matching,
    reasonCode: REASON.OVERLAPPING_SHIFT_WINDOWS,
  })
}

/**
 * Select exactly one published candidate for overtime request-creation freeze.
 * No row-order / current-schedule / default-rule inference: cardinality must be 1.
 */
function selectSinglePublishedCandidateForOvertime(candidates, { orgId, userId, workDate } = {}) {
  const filtered = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    if (!candidate || !candidate.shiftId || !candidate.assignmentId) return false
    // Validate candidate orgId AND userId strictly: a candidate that cannot prove
    // both identities is never eligible for an overtime attribution freeze.
    if (orgId && String(candidate.orgId) !== String(orgId)) return false
    if (userId && String(candidate.userId) !== String(userId)) return false
    if (workDate && String(candidate.workDate) !== String(workDate)) return false
    if (candidate.source !== 'shift' && candidate.source !== 'rotation') return false
    return true
  })
  if (filtered.length === 0) {
    return unresolvedResult({ reasonCode: REASON.NO_PUBLISHED_CANDIDATE })
  }
  if (filtered.length > 1) {
    return ambiguousResult({
      candidates: filtered,
      reasonCode: REASON.MULTIPLE_PUBLISHED_CANDIDATES,
    })
  }
  const winner = filtered[0]
  return resolvedResult({
    workDate: winner.workDate,
    shiftId: winner.shiftId,
    segmentIndex: winner.segmentIndex,
    reasonCode: REASON.SINGLE_MATCHING_CANDIDATE,
    orgId: winner.orgId,
    userId: winner.userId,
    evidenceSnapshot: {
      winner: serializeCandidate(winner),
      source: winner.source,
      assignmentId: winner.assignmentId,
    },
  })
}

/**
 * Create the shared resolver. All I/O is injected; pure selection stays local.
 *
 * @param {object} deps
 * @param {(args: object) => Promise<object[]>} deps.loadPublishedCandidates
 *   Must return atomic candidates for org-scoped published shift/rotation rows only.
 * @param {(args: object) => Promise<object[]>} [deps.loadOpenRecords]
 * @param {(args: object) => Promise<object[]>} [deps.loadApprovedOvertimeWindows]
 * @param {(args: object) => Promise<number>} [deps.getAttributionTailMinutes]
 * @param {(date: Date, timezone: string) => string} deps.toWorkDate
 * @param {Function} deps.buildZonedDate
 * @param {Function} deps.addDaysToDateKey
 * @param {Function} [deps.normalizeTimeString]
 * @param {Function} [deps.resolveOvernightFlag]
 */
function createAttendanceWorkDateResolver(deps = {}) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('AttendanceWorkDateResolver requires a dependency bag')
  }
  const {
    loadPublishedCandidates,
    loadOpenRecords,
    loadApprovedOvertimeWindows,
    getAttributionTailMinutes,
    toWorkDate,
    buildZonedDate,
    addDaysToDateKey,
    normalizeTimeString,
    resolveOvernightFlag,
  } = deps

  if (typeof loadPublishedCandidates !== 'function') {
    throw new Error('AttendanceWorkDateResolver requires loadPublishedCandidates')
  }
  if (typeof toWorkDate !== 'function') {
    throw new Error('AttendanceWorkDateResolver requires toWorkDate')
  }
  if (typeof buildZonedDate !== 'function') {
    throw new Error('AttendanceWorkDateResolver requires buildZonedDate')
  }
  if (typeof addDaysToDateKey !== 'function') {
    throw new Error('AttendanceWorkDateResolver requires addDaysToDateKey')
  }

  async function resolveAttributionTailMinutes(input) {
    if (Number.isFinite(Number(input?.attributionTailMinutes))) {
      return clampAttributionTailMinutes(input.attributionTailMinutes)
    }
    if (typeof getAttributionTailMinutes === 'function') {
      return clampAttributionTailMinutes(await getAttributionTailMinutes({
        orgId: input.orgId,
        channel: input.channel,
      }))
    }
    return DEFAULT_ATTRIBUTION_TAIL_MINUTES
  }

  function normalizeCandidateRow(row, attributionTailMinutes, approvedOvertimeWindows, ctx) {
    const malformedShape = (reason) => ({ __malformedShape: true, reason, row })
    if (!row || !row.shiftId || !row.workDate || !row.assignmentId) {
      return malformedShape('identity')
    }
    if (!row.orgId || String(row.orgId) !== String(ctx.orgId)) {
      return { __malformedCrossOrg: true, row }
    }
    if (!row.userId || String(row.userId) !== String(ctx.userId)) {
      return { __malformedCrossUser: true, row }
    }
    const workStartTime = typeof normalizeTimeString === 'function'
      ? normalizeTimeString(row.workStartTime ?? row.work_start_time)
      : (row.workStartTime ?? row.work_start_time)
    const workEndTime = typeof normalizeTimeString === 'function'
      ? normalizeTimeString(row.workEndTime ?? row.work_end_time)
      : (row.workEndTime ?? row.work_end_time)
    if (!workStartTime || !workEndTime) return malformedShape('shift_window')
    if (row.timezone != null && !isValidTimeZone(row.timezone)) {
      return malformedShape('timezone')
    }
    const timezone = (typeof row.timezone === 'string' && row.timezone.trim())
      ? row.timezone.trim()
      : ctx.timezone
    if (!isValidTimeZone(timezone)) return malformedShape('timezone')
    if (row.source !== 'shift' && row.source !== 'rotation') {
      return { __malformedSource: true, row }
    }
    const isOvernight = typeof resolveOvernightFlag === 'function'
      ? resolveOvernightFlag(row.isOvernight ?? row.is_overnight, workStartTime, workEndTime)
      : Boolean(row.isOvernight ?? row.is_overnight)
    const absoluteWindow = buildAbsoluteWindow({
      workDate: row.workDate,
      workStartTime,
      workEndTime,
      timezone,
      isOvernight,
      buildZonedDate,
      addDaysToDateKey,
    })
    if (!absoluteWindow) return malformedShape('absolute_window')
    const attributionWindow = buildAttributionWindow(absoluteWindow, {
      attributionTailMinutes,
      approvedOvertimeWindows,
      orgId: ctx.orgId,
      userId: ctx.userId,
      workDate: row.workDate,
      shiftId: row.shiftId,
    })
    if (!attributionWindow) return malformedShape('attribution_window')
    if (row.segmentIndex != null) {
      return malformedShape('segment_index')
    }
    const segmentIndex = null
    const baseEndMs = absoluteWindow.endAt.getTime() + attributionTailMinutes * 60000
    const extendedByOvertime = attributionWindow.endAt.getTime() > baseEndMs
    return {
      orgId: String(row.orgId),
      userId: String(row.userId),
      workDate: String(row.workDate),
      shiftId: String(row.shiftId),
      segmentIndex,
      absoluteWindow,
      attributionWindow,
      source: row.source,
      assignmentId: row.assignmentId == null ? null : String(row.assignmentId),
      isOvernight,
      extendedByOvertime,
    }
  }

  /**
   * @param {object} input
   * @returns {Promise<object>} resolved | ambiguous | unresolved
   */
  async function resolve(input = {}) {
    const orgId = input.orgId == null ? null : String(input.orgId)
    const userId = input.userId == null ? null : String(input.userId)
    const channel = input.channel == null ? 'live' : input.channel
    const timezone = isValidTimeZone(input.timezone) ? input.timezone.trim() : null
    const occurredAt = isDateInstance(input.occurredAt)
      ? input.occurredAt
      : (input.occurredAt ? new Date(input.occurredAt) : null)

    if (!orgId || !userId) {
      return unresolvedResult({ reasonCode: REASON.INVALID_INPUT, evidenceSnapshot: { orgId, userId } })
    }
    if (!CHANNELS.includes(channel)) {
      return unresolvedResult({
        reasonCode: REASON.INVALID_INPUT,
        evidenceSnapshot: { channel: input.channel },
      })
    }

    // Frozen correction/recompute attribution is creation-time evidence. It must not be
    // invalidated by later timezone/config drift.
    if (
      (channel === 'correction' || channel === 'recompute')
      && input.frozenAttribution
    ) {
      const frozen = parseFrozenWorkDateAttribution(input.frozenAttribution)
      if (!frozen) {
        throw new Error('FROZEN_ATTRIBUTION_INVALID')
      }
      if (frozen.orgId !== orgId || frozen.userId !== userId) {
        throw new Error('FROZEN_ATTRIBUTION_IDENTITY_MISMATCH')
      }
      return resolvedResult({
        workDate: frozen.workDate,
        shiftId: frozen.shiftId,
        segmentIndex: frozen.segmentIndex,
        reasonCode: REASON.FROZEN_ATTRIBUTION,
        evidenceSnapshot: {
          frozen: true,
          priorReasonCode: frozen.reasonCode,
          priorEvidence: frozen.evidenceSnapshot,
          channel,
        },
      })
    }

    if (input.timezone != null && !timezone) {
      return unresolvedResult({
        reasonCode: REASON.INVALID_INPUT,
        evidenceSnapshot: { channel, timezone: input.timezone },
      })
    }
    if (
      isDateInstance(occurredAt)
      && !timezone
      && !input.calendarWorkDate
      && !input.explicitWorkDate
    ) {
      return unresolvedResult({
        reasonCode: REASON.INVALID_INPUT,
        evidenceSnapshot: { channel, timezone: null },
      })
    }

    // free_time cannot honestly satisfy non-null shiftId on resolved.
    if (input.groupAttendanceType === 'free_time') {
      return unresolvedResult({
        reasonCode: REASON.FREE_TIME_NO_SHIFT,
        evidenceSnapshot: {
          channel,
          contractConflict:
            'resolved.shiftId is non-null; free_time has no published shift candidate. '
            + 'Do not invent a synthetic shiftId or nullable-widen the resolved contract.',
        },
      })
    }

    // Explicit import: authorized workDate evidence alone is not enough without shiftId.
    if (channel === 'import' && input.explicitWorkDate && !input.explicitShiftId) {
      // If schedule candidates exist we still resolve via schedule; only fail closed when the
      // caller declared "explicit work date only" with no shift and no schedule lookup desired.
      if (input.explicitWorkDateOnly === true) {
        return unresolvedResult({
          reasonCode: REASON.EXPLICIT_IMPORT_REQUIRES_SHIFT,
          evidenceSnapshot: {
            channel,
            explicitWorkDate: input.explicitWorkDate,
            contractConflict:
              'resolved.shiftId is non-null; explicit-import workDate without an org-scoped '
              + 'published shiftId cannot produce resolved. Do not invent or nullable-widen shiftId.',
          },
        })
      }
    }

    if (!isDateInstance(occurredAt) && channel !== 'overtime' && channel !== 'scheduled') {
      return unresolvedResult({ reasonCode: REASON.INVALID_INPUT, evidenceSnapshot: { channel } })
    }

    const calendarWorkDate = input.calendarWorkDate
      || (isDateInstance(occurredAt) && timezone
        ? toWorkDate(occurredAt, timezone)
        : input.explicitWorkDate)
      || null
    if (channel === 'scheduled' && !calendarWorkDate) {
      return unresolvedResult({
        reasonCode: REASON.INVALID_INPUT,
        evidenceSnapshot: { channel, calendarWorkDate: null },
      })
    }

    const attributionTailMinutes = await resolveAttributionTailMinutes(input)

    const workDates = []
    if (calendarWorkDate) {
      workDates.push(calendarWorkDate)
      const previous = addDaysToDateKey(calendarWorkDate, -1)
      if (previous) workDates.push(previous)
    }
    if (input.explicitWorkDate && !workDates.includes(input.explicitWorkDate)) {
      workDates.push(String(input.explicitWorkDate))
    }

    const rawCandidates = await loadPublishedCandidates({
      orgId,
      userId,
      workDates,
      calendarWorkDate,
      timezone,
      channel,
      explicitShiftId: input.explicitShiftId || null,
    })

    if (!Array.isArray(rawCandidates)) {
      throw new Error('WORK_DATE_CANDIDATE_SOURCE_INVALID')
    }

    // Cross-org/user references fail closed (R7).
    for (const row of rawCandidates) {
      if (row && (!row.orgId || String(row.orgId) !== String(orgId))) {
        return unresolvedResult({
          reasonCode: REASON.MALFORMED_CROSS_ORG_REFERENCE,
          evidenceSnapshot: { orgId, foreignOrgId: row.orgId, shiftId: row.shiftId || null },
        })
      }
      if (row && (!row.userId || String(row.userId) !== String(userId))) {
        return unresolvedResult({
          reasonCode: REASON.MALFORMED_CROSS_USER_REFERENCE,
          evidenceSnapshot: { userId, foreignUserId: row.userId, shiftId: row.shiftId || null },
        })
      }
    }
    if (channel === 'import' && input.explicitShiftId) {
      const claimedShiftId = String(input.explicitShiftId)
      if (
        rawCandidates.length === 0
        || rawCandidates.some((row) => String(row?.shiftId ?? '') !== claimedShiftId)
      ) {
        return unresolvedResult({
          reasonCode: REASON.EXPLICIT_SHIFT_MISMATCH,
          evidenceSnapshot: {
            explicitShiftId: claimedShiftId,
            candidateShiftIds: rawCandidates
              .map((row) => row?.shiftId)
              .filter(Boolean)
              .map(String),
          },
        })
      }
    }

    let approvedOvertimeWindows = Array.isArray(input.approvedOvertimeWindows)
      ? input.approvedOvertimeWindows
      : null
    if (!approvedOvertimeWindows && typeof loadApprovedOvertimeWindows === 'function') {
      approvedOvertimeWindows = await loadApprovedOvertimeWindows({
        orgId,
        userId,
        workDates,
        channel,
      })
    }
    if (!Array.isArray(approvedOvertimeWindows)) {
      throw new Error('APPROVED_OVERTIME_SOURCE_INVALID')
    }

    const candidates = []
    for (const row of rawCandidates) {
      const normalized = normalizeCandidateRow(row, attributionTailMinutes, approvedOvertimeWindows, {
        orgId,
        userId,
        timezone,
      })
      if (normalized?.__malformedShape) {
        return unresolvedResult({
          reasonCode: REASON.MALFORMED_CANDIDATE_SHAPE,
          evidenceSnapshot: {
            reason: normalized.reason,
            workDate: normalized.row?.workDate ?? null,
            shiftId: normalized.row?.shiftId ?? null,
          },
        })
      }
      if (normalized.__malformedCrossOrg) {
        return unresolvedResult({
          reasonCode: REASON.MALFORMED_CROSS_ORG_REFERENCE,
          evidenceSnapshot: { orgId, foreignOrgId: normalized.row?.orgId || null },
        })
      }
      if (normalized.__malformedCrossUser) {
        return unresolvedResult({
          reasonCode: REASON.MALFORMED_CROSS_USER_REFERENCE,
          evidenceSnapshot: { userId, foreignUserId: normalized.row?.userId || null },
        })
      }
      if (normalized.__malformedSource) {
        return unresolvedResult({
          reasonCode: REASON.MALFORMED_CANDIDATE_SOURCE,
          evidenceSnapshot: {
            source: normalized.row?.source ?? null,
            shiftId: normalized.row?.shiftId ?? null,
          },
        })
      }
      candidates.push(normalized)
    }

    // Overtime freeze path: pick exactly one published candidate for the work date.
    if (channel === 'overtime' && input.mode === 'freeze_request_anchor') {
      const workDate = input.explicitWorkDate || calendarWorkDate
      return selectSinglePublishedCandidateForOvertime(candidates, { orgId, userId, workDate })
    }

    // Scheduled derivation has no real punch instant. Selecting by a synthetic
    // timestamp would let one slot hide another on a multi-shift day. W2 has no
    // segment support yet, so a target date must have exactly one published
    // candidate; multiple candidates are review-required ambiguity.
    if (channel === 'scheduled') {
      const scheduledCandidates = candidates.filter(
        (candidate) => String(candidate.workDate) === String(calendarWorkDate),
      )
      if (scheduledCandidates.length === 1) {
        const winner = scheduledCandidates[0]
        return resolvedResult({
          workDate: winner.workDate,
          shiftId: winner.shiftId,
          segmentIndex: winner.segmentIndex,
          reasonCode: REASON.SINGLE_MATCHING_CANDIDATE,
          orgId: winner.orgId,
          userId: winner.userId,
          evidenceSnapshot: {
            calendarWorkDate,
            winner: serializeCandidate(winner),
            matchingCount: 1,
            channel,
          },
        })
      }
      if (scheduledCandidates.length > 1) {
        return ambiguousResult({
          candidates: scheduledCandidates,
          reasonCode: REASON.MULTIPLE_PUBLISHED_CANDIDATES,
        })
      }
      return unresolvedResult({
        reasonCode: REASON.UNSCHEDULED_NO_SHIFT,
        evidenceSnapshot: {
          channel,
          calendarWorkDate,
          workDates,
        },
      })
    }

    if (candidates.length === 0) {
      // Unscheduled: no published assignment for the candidate dates.
      return unresolvedResult({
        reasonCode: REASON.UNSCHEDULED_NO_SHIFT,
        evidenceSnapshot: {
          channel,
          calendarWorkDate,
          workDates,
          contractConflict:
            'resolved.shiftId is non-null; unscheduled users have no published shift. '
            + 'Do not invent a default-rule shiftId or nullable-widen resolved.shiftId.',
        },
      })
    }

    const matching = candidates.filter((candidate) =>
      isInstantInWindow(occurredAt, candidate.attributionWindow)
    )

    let openRecords = Array.isArray(input.openRecords) ? input.openRecords : null
    if (!openRecords && typeof loadOpenRecords === 'function') {
      openRecords = await loadOpenRecords({
        orgId,
        userId,
        workDates,
        channel,
      })
    }
    if (!Array.isArray(openRecords)) {
      throw new Error('OPEN_RECORD_SOURCE_INVALID')
    }

    return selectAmongMatchingCandidates({
      matching,
      occurredAt,
      calendarWorkDate,
      openRecords,
      attributionTailMinutes,
      orgId,
      userId,
    })
  }

  return {
    resolve,
    // pure helpers re-exported for adapters/tests
    selectAmongMatchingCandidates,
    selectSinglePublishedCandidateForOvertime,
    buildAbsoluteWindow: (args) => buildAbsoluteWindow({
      ...args,
      buildZonedDate,
      addDaysToDateKey,
    }),
    buildAttributionWindow,
    isInstantInWindow,
  }
}

module.exports = {
  DEFAULT_ATTRIBUTION_TAIL_MINUTES,
  MAX_ATTRIBUTION_TAIL_MINUTES,
  OVERTIME_ATTRIBUTION_VERSION,
  OVERTIME_ATTRIBUTION_KEY,
  FROZEN_ATTRIBUTION_KEY,
  REASON,
  CHANNELS,
  clampAttributionTailMinutes,
  normalizeWorkDateAttributionSetting,
  buildAbsoluteWindow,
  buildAttributionWindow,
  isInstantInWindow,
  parseOvertimeAttributionV1,
  buildOvertimeAttributionV1,
  anchorsEqual,
  parseFrozenWorkDateAttribution,
  buildFrozenWorkDateAttribution,
  resolvedResult,
  ambiguousResult,
  unresolvedResult,
  selectAmongMatchingCandidates,
  selectSinglePublishedCandidateForOvertime,
  createAttendanceWorkDateResolver,
  serializeCandidate,
}
