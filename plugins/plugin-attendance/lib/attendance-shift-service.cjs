'use strict'

/**
 * Canonical attendance shift service (W3 / #4556 design lock
 * docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md
 * section 3.1 + W3 safety erratum 2026-07-24).
 *
 * This module is the ONE writer for attendance_shifts + attendance_shift_segments.
 * A second independent segment writer is forbidden (design lock section 3.1). Every
 * create/update/delete goes through here so segments and the legacy envelope
 * (work_start_time / work_end_time / is_overnight) are always written together in one
 * transaction.
 *
 * Contracts implemented here:
 *   - 1..3 segments, dense indexes beginning at 0, positive per-segment duration,
 *     ordered non-overlapping absolute intervals after day offsets, total planned
 *     minutes > 0 and <= 24h, at most one midnight crossing (end_day_offset = 1),
 *     every segment in the parent shift timezone (segments carry no timezone).
 *   - Dual-read: reads prefer persisted segment rows; a legacy shift without segment
 *     rows is synthesized as segment 0 from its envelope.
 *   - Envelope derivation: legacy fields always expose the OUTER envelope of the
 *     segments (first segment start .. last segment end); multi-segment shifts also
 *     expose calculationMode = 'segments' so a legacy client is not led to believe
 *     the envelope is payable time (red line R8). The break between segments is
 *     never part of plannedMinutes.
 *   - While ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED is OFF for an org,
 *     multi-segment authoring is preview-only: assertShiftReferenceAllowed /
 *     assertShiftSequenceReferenceAllowed make every reference-producing writer
 *     named in the erratum fail with a typed 422 and zero writes, and any durable
 *     assignment / rotation / pending swap / pending-or-published dispatch reference
 *     blocks converting one segment to multiple (409, zero writes), including ended
 *     assignment history.
 *   - Delete shares one transaction-level lock protocol with reference writers:
 *     writers lock the shift row FOR SHARE inside their write transaction before
 *     inserting a reference; delete locks it FOR UPDATE before checking blockers,
 *     so no reference can be inserted between the check and the parent delete.
 *     Delete returns a typed 409 with zero writes for every durable blocker class
 *     and never relies on FK cascade to remove those references. Historical
 *     rejected/cancelled/candidate rows do not block delete; reads that can no
 *     longer resolve their shift expose a neutral label, never the raw UUID.
 *
 * W3 does NOT implement authoritative segment calculation (W4). There is no
 * calculation here; the flag only gates whether multi-segment shifts may be
 * referenced by scheduling writers.
 *
 * W5 flexible single-segment mode (design lock §3.3 / §9.6):
 *   - strict discriminated flexPolicy on the shift row (default strict);
 *   - flex_required_duration only when the shift has exactly one segment;
 *   - multi-segment flex is a typed 422 with zero writes;
 *   - legacy envelope bytes for strict shifts stay unchanged.
 */

const SEGMENT_MIN = 1
const SEGMENT_MAX = 3
const MINUTES_PER_DAY = 1440
const SEGMENT_CALCULATION_FLAG_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
// #4556 Gate A / Option B cutover: this constant is NO LONGER a reference-writer gate.
// The plugin's own env-reading predicate (`isSegmentCalculationEnabled`) has been retired
// so there is ONE source of truth for reference-writer authorization — the core canonical
// posture port (`resolveOrgSegmentCalculationPosture`, exact-org allowlist, wildcard-refused,
// persisted rollout row). Every reference writer now resolves the port on its write trx and
// passes an explicit boolean; nothing here reads the environment for authorization.
//
// The constant survives ONLY as an injected, values-safe DIAGNOSTIC of whether the W4
// AUTHORITATIVE CALCULATOR itself has shipped (it has not — this stays `false`). Its sole
// consumer is the W6 group effective-policy aggregate via `attendance-admin.ts`, where it is
// the second conjunct of `calculationPosture === 'authoritative' && segmentCalculationImplemented`
// — i.e. even an org the port resolves `authoritative` must not be shown 'effective' results
// until the calculator exists. Flipping it belongs to the reviewed change that lands W4C-1.
const SEGMENT_CALCULATION_IMPLEMENTED = false
const SHIFT_REFERENCE_DELETED_LABEL = 'Deleted or unavailable shift'

const SHIFT_SERVICE_ERROR = Object.freeze({
  SEGMENTS_INVALID: 'ATTENDANCE_SHIFT_SEGMENTS_INVALID',
  SEGMENT_MODE_AMBIGUOUS: 'ATTENDANCE_SHIFT_SEGMENT_MODE_AMBIGUOUS',
  ENVELOPE_COLLAPSE_REJECTED: 'ATTENDANCE_SHIFT_ENVELOPE_COLLAPSE_REJECTED',
  MULTI_SEGMENT_CALCULATION_DISABLED: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED',
  SEGMENT_CONVERSION_BLOCKED: 'ATTENDANCE_SHIFT_SEGMENT_CONVERSION_BLOCKED',
  DELETE_BLOCKED: 'ATTENDANCE_SHIFT_DELETE_BLOCKED',
  FLEX_POLICY_INVALID: 'ATTENDANCE_SHIFT_FLEX_POLICY_INVALID',
})

const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const SEGMENT_INPUT_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const FLEX_MAX_REQUIRED_MINUTES = 1440
const FLEX_STRICT_KEYS = Object.freeze(['mode'])
const FLEX_REQUIRED_KEYS = Object.freeze([
  'mode',
  'requiredMinutes',
  'arrivalWindowBeforeMinutes',
  'arrivalWindowAfterMinutes',
  'coreStartTime',
  'coreEndTime',
])

function hasClosedFlexPolicyShape(value, requiredKeys, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const ownKeys = Object.getOwnPropertyNames(value)
  if (requiredKeys.some((key) => !ownKeys.includes(key))) return false
  if (ownKeys.some((key) => !allowedKeys.includes(key))) return false
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && !descriptor.get && !descriptor.set
  })
}

function isMissingSchemaError(error) {
  if (error?.code === '42P01' || error?.code === '42703') return true
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  return (message.includes('relation') || message.includes('column')) && message.includes('does not exist')
}

function parseTimeToMinutes(value) {
  if (typeof value !== 'string') return null
  const match = TIME_PATTERN.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = match[3] !== undefined ? Number(match[3]) : 0
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return null
  return hours * 60 + minutes
}

function normalizeTimeString(value) {
  const minutes = parseTimeToMinutes(value)
  if (minutes === null) return null
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function normalizeSegmentInputTime(value) {
  if (typeof value !== 'string' || !SEGMENT_INPUT_TIME_PATTERN.test(value)) return null
  return value
}

function createAttendanceShiftService(deps) {
  const {
    HttpError,
    randomUUID,
    resolveShiftTiming,
    normalizeWorkingDays,
    mapShiftRow,
    DEFAULT_SHIFT,
    DEFAULT_ORG_ID,
    normalizeLegacyRotationRulesForShiftName,
  } = deps

  function segmentValidationError(details) {
    return new HttpError(
      422,
      SHIFT_SERVICE_ERROR.SEGMENTS_INVALID,
      details[0]?.message || 'Invalid shift segments',
      details,
    )
  }

  function fieldDetail(field, message) {
    return [{ field, message }]
  }

  function flexValidationError(details) {
    return new HttpError(
      422,
      SHIFT_SERVICE_ERROR.FLEX_POLICY_INVALID,
      details[0]?.message || 'Invalid flex policy',
      details,
    )
  }

  function parseClockMinutesStrict(value) {
    if (typeof value !== 'string' || !SEGMENT_INPUT_TIME_PATTERN.test(value)) return null
    const hours = Number(value.slice(0, 2))
    const minutes = Number(value.slice(3, 5))
    return hours * 60 + minutes
  }

  /**
   * Authoring guarantee: every allowed clamped expected-start covers optional core.
   * latestPermittedStart <= coreStart AND earliestPermittedStart + required >= coreEnd.
   */
  function flexCoreHoursCoveredByAllClampedIntervals({
    segmentStartMinutes,
    arrivalWindowBeforeMinutes,
    arrivalWindowAfterMinutes,
    requiredMinutes,
    coreStartMinutes,
    coreEndMinutes,
  }) {
    if (!(coreEndMinutes > coreStartMinutes)) return false
    if (!(requiredMinutes > 0)) return false
    if (arrivalWindowBeforeMinutes < 0 || arrivalWindowAfterMinutes < 0) return false
    const earliestPermittedStart = segmentStartMinutes - arrivalWindowBeforeMinutes
    const latestPermittedStart = segmentStartMinutes + arrivalWindowAfterMinutes
    return latestPermittedStart <= coreStartMinutes
      && earliestPermittedStart + requiredMinutes >= coreEndMinutes
  }

  /**
   * Strict discriminated flex policy validation (design lock §3.3).
   * multi-segment flex is rejected. Optional core hours must be coverable by
   * every clamped arrival (authoring-only; no new runtime reasonCode).
   * `segmentStartTime` is required when core hours are set.
   */
  function validateFlexPolicy(rawPolicy, segmentCount, segmentStartTime = null) {
    if (rawPolicy === undefined) {
      return {
        mode: 'strict',
        requiredMinutes: null,
        arrivalWindowBeforeMinutes: null,
        arrivalWindowAfterMinutes: null,
        coreStartTime: null,
        coreEndTime: null,
      }
    }
    if (rawPolicy === null) {
      throw flexValidationError(fieldDetail('flexPolicy', 'flexPolicy must be an object'))
    }
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
      throw flexValidationError(fieldDetail('flexPolicy', 'flexPolicy must be an object'))
    }
    const mode = rawPolicy.mode
    if (mode === 'strict') {
      if (!hasClosedFlexPolicyShape(rawPolicy, FLEX_STRICT_KEYS, FLEX_STRICT_KEYS)) {
        throw flexValidationError(
          fieldDetail('flexPolicy', 'strict flexPolicy may only carry mode'),
        )
      }
      return {
        mode: 'strict',
        requiredMinutes: null,
        arrivalWindowBeforeMinutes: null,
        arrivalWindowAfterMinutes: null,
        coreStartTime: null,
        coreEndTime: null,
      }
    }
    if (mode !== 'flex_required_duration') {
      throw flexValidationError(
        fieldDetail('flexPolicy.mode', 'flexPolicy.mode must be strict or flex_required_duration'),
      )
    }
    if (!hasClosedFlexPolicyShape(
      rawPolicy,
      ['mode', 'requiredMinutes', 'arrivalWindowBeforeMinutes', 'arrivalWindowAfterMinutes'],
      FLEX_REQUIRED_KEYS,
    )) {
      throw flexValidationError(
        fieldDetail('flexPolicy', 'flex_required_duration contains missing or unknown fields'),
      )
    }
    if (!Number.isInteger(segmentCount) || segmentCount < 1) {
      throw flexValidationError(fieldDetail('segments', 'flex policy requires a validated segment set'))
    }
    if (segmentCount !== 1) {
      throw flexValidationError(
        fieldDetail(
          'flexPolicy.mode',
          'flex_required_duration is supported only for a one-segment shift',
        ),
      )
    }
    const requiredMinutes = rawPolicy.requiredMinutes
    if (
      !Number.isInteger(requiredMinutes)
      || requiredMinutes <= 0
      || requiredMinutes > FLEX_MAX_REQUIRED_MINUTES
    ) {
      throw flexValidationError(
        fieldDetail(
          'flexPolicy.requiredMinutes',
          `requiredMinutes must be an integer in 1..${FLEX_MAX_REQUIRED_MINUTES}`,
        ),
      )
    }
    const arrivalWindowBeforeMinutes = rawPolicy.arrivalWindowBeforeMinutes
    if (!Number.isInteger(arrivalWindowBeforeMinutes) || arrivalWindowBeforeMinutes < 0) {
      throw flexValidationError(
        fieldDetail(
          'flexPolicy.arrivalWindowBeforeMinutes',
          'arrivalWindowBeforeMinutes must be a non-negative integer',
        ),
      )
    }
    const arrivalWindowAfterMinutes = rawPolicy.arrivalWindowAfterMinutes
    if (!Number.isInteger(arrivalWindowAfterMinutes) || arrivalWindowAfterMinutes < 0) {
      throw flexValidationError(
        fieldDetail(
          'flexPolicy.arrivalWindowAfterMinutes',
          'arrivalWindowAfterMinutes must be a non-negative integer',
        ),
      )
    }
    const coreStartRaw = rawPolicy.coreStartTime === undefined ? null : rawPolicy.coreStartTime
    const coreEndRaw = rawPolicy.coreEndTime === undefined ? null : rawPolicy.coreEndTime
    if ((coreStartRaw === null) !== (coreEndRaw === null)) {
      throw flexValidationError(
        fieldDetail('flexPolicy.coreStartTime', 'coreStartTime and coreEndTime must both be set or both null'),
      )
    }
    let coreStartTime = null
    let coreEndTime = null
    if (coreStartRaw !== null) {
      coreStartTime = normalizeSegmentInputTime(coreStartRaw)
      coreEndTime = normalizeSegmentInputTime(coreEndRaw)
      if (!coreStartTime) {
        throw flexValidationError(
          fieldDetail('flexPolicy.coreStartTime', 'coreStartTime must use HH:MM format'),
        )
      }
      if (!coreEndTime) {
        throw flexValidationError(
          fieldDetail('flexPolicy.coreEndTime', 'coreEndTime must use HH:MM format'),
        )
      }
      const coreStartMin = parseClockMinutesStrict(coreStartTime)
      const coreEndMin = parseClockMinutesStrict(coreEndTime)
      if (coreStartMin === null || coreEndMin === null || coreEndMin <= coreStartMin) {
        throw flexValidationError(
          fieldDetail('flexPolicy.coreEndTime', 'core hours must be a positive same-day interval'),
        )
      }
      const segmentStartMin = parseClockMinutesStrict(segmentStartTime)
      if (segmentStartMin === null) {
        throw flexValidationError(
          fieldDetail(
            'flexPolicy.coreStartTime',
            'core hours require a single-segment startTime to prove every clamped arrival covers core',
          ),
        )
      }
      if (!flexCoreHoursCoveredByAllClampedIntervals({
        segmentStartMinutes: segmentStartMin,
        arrivalWindowBeforeMinutes,
        arrivalWindowAfterMinutes,
        requiredMinutes,
        coreStartMinutes: coreStartMin,
        coreEndMinutes: coreEndMin,
      })) {
        throw flexValidationError(
          fieldDetail(
            'flexPolicy.coreStartTime',
            'core hours must be covered by every allowed clamped arrival '
              + '(latest permitted start <= coreStart and earliest permitted start + requiredMinutes >= coreEnd)',
          ),
        )
      }
    }
    return {
      mode: 'flex_required_duration',
      requiredMinutes,
      arrivalWindowBeforeMinutes,
      arrivalWindowAfterMinutes,
      coreStartTime,
      coreEndTime,
    }
  }

  function mapFlexPolicyFromRow(shiftRow) {
    const mode = shiftRow.flex_mode === 'flex_required_duration'
      ? 'flex_required_duration'
      : 'strict'
    if (mode === 'strict') {
      return { mode: 'strict' }
    }
    return {
      mode: 'flex_required_duration',
      requiredMinutes: Number(shiftRow.flex_required_minutes),
      arrivalWindowBeforeMinutes: Number(shiftRow.flex_arrival_window_before_minutes),
      arrivalWindowAfterMinutes: Number(shiftRow.flex_arrival_window_after_minutes),
      coreStartTime: shiftRow.flex_core_start_time
        ? (normalizeTimeString(shiftRow.flex_core_start_time) || null)
        : null,
      coreEndTime: shiftRow.flex_core_end_time
        ? (normalizeTimeString(shiftRow.flex_core_end_time) || null)
        : null,
    }
  }

  /**
   * Validate a raw segments array against the section 3.1 contract and return the
   * normalized rows (dense segment_index assigned by array position). Throws a typed
   * 422 with field-specific details; callers must write nothing when it throws.
   */
  function validateShiftSegments(rawSegments) {
    if (!Array.isArray(rawSegments)) {
      throw segmentValidationError(fieldDetail('segments', 'segments must be an array'))
    }
    if (rawSegments.length < SEGMENT_MIN || rawSegments.length > SEGMENT_MAX) {
      throw segmentValidationError(fieldDetail('segments', `segments must contain between ${SEGMENT_MIN} and ${SEGMENT_MAX} entries`))
    }

    const normalized = rawSegments.map((raw, index) => {
      const field = `segments.${index}`
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw segmentValidationError(fieldDetail(field, 'segment must be an object'))
      }
      if (raw.segmentIndex !== undefined && raw.segmentIndex !== index) {
        throw segmentValidationError(fieldDetail(`${field}.segmentIndex`, 'segment indexes must be dense and begin at 0'))
      }
      const startTime = normalizeSegmentInputTime(raw.startTime)
      if (!startTime) {
        throw segmentValidationError(fieldDetail(`${field}.startTime`, 'segment startTime must use HH:MM format'))
      }
      const endTime = normalizeSegmentInputTime(raw.endTime)
      if (!endTime) {
        throw segmentValidationError(fieldDetail(`${field}.endTime`, 'segment endTime must use HH:MM format'))
      }
      const startDayOffset = raw.startDayOffset === undefined ? 0 : raw.startDayOffset
      if (startDayOffset !== 0) {
        throw segmentValidationError(fieldDetail(`${field}.startDayOffset`, 'startDayOffset is fixed to 0 in v1'))
      }
      const endDayOffset = raw.endDayOffset === undefined ? 0 : raw.endDayOffset
      if (endDayOffset !== 0 && endDayOffset !== 1) {
        throw segmentValidationError(fieldDetail(`${field}.endDayOffset`, 'endDayOffset must be 0 or 1'))
      }
      const startAbs = parseTimeToMinutes(startTime) + startDayOffset * MINUTES_PER_DAY
      const endAbs = parseTimeToMinutes(endTime) + endDayOffset * MINUTES_PER_DAY
      if (endAbs <= startAbs) {
        throw segmentValidationError(fieldDetail(`${field}.endTime`, 'segment must have a positive duration'))
      }
      return {
        segmentIndex: index,
        startTime,
        startDayOffset,
        endTime,
        endDayOffset,
        startAbs,
        endAbs,
      }
    })

    let midnightCrossings = 0
    let totalMinutes = 0
    for (let index = 0; index < normalized.length; index += 1) {
      const segment = normalized[index]
      if (segment.endDayOffset === 1) midnightCrossings += 1
      totalMinutes += segment.endAbs - segment.startAbs
      if (index > 0 && segment.startAbs < normalized[index - 1].endAbs) {
        throw segmentValidationError(
          fieldDetail(`segments.${index}.startTime`, 'segments must be ordered and non-overlapping after day offsets are applied'),
        )
      }
    }
    if (midnightCrossings > 1) {
      throw segmentValidationError(fieldDetail('segments', 'at most one segment may cross midnight'))
    }
    if (totalMinutes <= 0 || totalMinutes > MINUTES_PER_DAY) {
      throw segmentValidationError(fieldDetail('segments', 'total planned minutes must be greater than 0 and at most 24 hours'))
    }

    return normalized.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      startTime: segment.startTime,
      startDayOffset: segment.startDayOffset,
      endTime: segment.endTime,
      endDayOffset: segment.endDayOffset,
    }))
  }

  /**
   * Outer envelope of a validated segment set. The envelope is a compatibility
   * projection only — it is never payable time for a multi-segment shift (R8).
   */
  function deriveEnvelopeFromSegments(segments) {
    const first = segments[0]
    const last = segments[segments.length - 1]
    const plannedMinutes = segments.reduce((total, segment) => {
      return total + (segment.endDayOffset * MINUTES_PER_DAY + parseTimeToMinutes(segment.endTime))
        - (segment.startDayOffset * MINUTES_PER_DAY + parseTimeToMinutes(segment.startTime))
    }, 0)
    return {
      workStartTime: first.startTime,
      workEndTime: last.endTime,
      isOvernight: segments.some((segment) => segment.endDayOffset === 1),
      plannedMinutes,
    }
  }

  /** Legacy dual-read synthesis: a shift without segment rows is segment 0 of its envelope. */
  function synthesizeSegmentsFromEnvelope(shiftRow) {
    const workStartTime = normalizeTimeString(shiftRow.work_start_time) || DEFAULT_SHIFT.workStartTime
    const workEndTime = normalizeTimeString(shiftRow.work_end_time) || DEFAULT_SHIFT.workEndTime
    const isOvernight = shiftRow.is_overnight === true || shiftRow.is_overnight === 't'
    return [{
      id: null,
      segmentIndex: 0,
      startTime: workStartTime,
      startDayOffset: 0,
      endTime: workEndTime,
      endDayOffset: isOvernight ? 1 : 0,
    }]
  }

  /**
   * Values-safe capability projection: state and labels only, no secrets and no
   * member/user values. Shows authoritative segment calculation disabled by default.
   *
   * #4556 Gate A / Option B: this projection is a pure DTO with no write trx / port in
   * hand, so it is pinned to the closed legacy posture (`enabled: false`) rather than
   * re-deriving posture from the environment. That is byte-identical to the retired
   * env-gate's production behaviour (the plugin master gate was OFF, so this was always
   * `false`). The authoritative reference-writer decision is made by the port, not here;
   * a shadow/authoritative org's capability hint stays 'preview_only'.
   *
   * STILL PINNED after the residual-R4 slice — deliberately, and adjudicated rather than
   * forgotten. R4 opened the AUTHORIZATION door
   * (`index.cjs`, `assertWorkContextSegmentCalculationAllowed`), which refuses writes; this
   * function is a DISPLAY hint that gates nothing (Gate A adjudication #3: the whole
   * `SEGMENT_CALCULATION_IMPLEMENTED` family reaches only the read-only W6 effective-policy
   * aggregate, whose transaction is `SET TRANSACTION READ ONLY`). Making it accurate needs a
   * posture read on a request-scoped client this synchronous DTO does not have, i.e. a route
   * change, not a one-line thread-through. Named out of scope, not claimed resolved: an
   * enabled org sees `preview_only` in the shift DTO while its writers are admitted.
   */
  function buildShiftCapabilities(orgId) {
    const enabled = false
    return {
      segmentCalculation: {
        enabled,
        defaultEnabled: false,
        authoritativeResults: enabled,
        multiSegmentAuthoring: enabled ? 'enabled' : 'preview_only',
        flag: SEGMENT_CALCULATION_FLAG_ENV,
      },
    }
  }

  function mapSegmentRow(row) {
    return {
      id: row.id ?? null,
      segmentIndex: Number(row.segment_index),
      startTime: normalizeTimeString(row.start_time),
      startDayOffset: Number(row.start_day_offset ?? 0),
      endTime: normalizeTimeString(row.end_time),
      endDayOffset: Number(row.end_day_offset ?? 0),
    }
  }

  function mapSegmentOutput(segment) {
    return {
      id: segment.id ?? null,
      segmentIndex: segment.segmentIndex,
      segment_index: segment.segmentIndex,
      startTime: segment.startTime,
      start_time: segment.startTime,
      startDayOffset: segment.startDayOffset,
      start_day_offset: segment.startDayOffset,
      endTime: segment.endTime,
      end_time: segment.endTime,
      endDayOffset: segment.endDayOffset,
      end_day_offset: segment.endDayOffset,
    }
  }

  /**
   * Full shift DTO: legacy envelope fields (compatibility projection), segments,
   * calculationMode, plannedMinutes, flexPolicy, and the values-safe capability block.
   */
  function mapShiftWithSegments(shiftRow, segmentRows, orgId) {
    const base = mapShiftRow(shiftRow)
    const persisted = (segmentRows ?? []).map(mapSegmentRow)
    const segments = persisted.length > 0 ? persisted : synthesizeSegmentsFromEnvelope(shiftRow)
    const envelope = deriveEnvelopeFromSegments(segments)
    const flexPolicy = mapFlexPolicyFromRow(shiftRow)
    // Flex planned minutes are the required duration, not the outer envelope.
    const plannedMinutes = flexPolicy.mode === 'flex_required_duration'
      ? flexPolicy.requiredMinutes
      : envelope.plannedMinutes
    return {
      ...base,
      segments: segments.map(mapSegmentOutput),
      calculationMode: segments.length > 1 ? 'segments' : 'envelope',
      plannedMinutes,
      flexPolicy,
      flexEligible: segments.length === 1,
      capabilities: buildShiftCapabilities(orgId ?? base.orgId),
    }
  }

  /** Batched segment hydration for a page of parent shifts (one query, grouped by shift). */
  async function loadSegmentsByShiftId(db, orgId, shiftIds) {
    const byShiftId = new Map()
    const ids = Array.from(new Set((shiftIds ?? []).filter(Boolean)))
    if (ids.length === 0) return byShiftId
    try {
      const rows = await db.query(
        `SELECT *
           FROM attendance_shift_segments
          WHERE org_id = $1
            AND shift_id = ANY($2::uuid[])
          ORDER BY shift_id, segment_index`,
        [orgId, ids],
      )
      for (const row of rows) {
        const key = String(row.shift_id)
        if (!byShiftId.has(key)) byShiftId.set(key, [])
        byShiftId.get(key).push(row)
      }
    } catch (error) {
      if (isMissingSchemaError(error)) return byShiftId
      throw error
    }
    return byShiftId
  }

  async function countPersistedSegments(db, orgId, shiftId) {
    try {
      const rows = await db.query(
        'SELECT COUNT(*)::int AS total FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2',
        [orgId, shiftId],
      )
      return Number(rows[0]?.total ?? 0)
    } catch (error) {
      if (isMissingSchemaError(error)) return 0
      throw error
    }
  }

  async function insertSegmentRows(trx, orgId, shiftId, segments) {
    for (const segment of segments) {
      await trx.query(
        `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          orgId,
          shiftId,
          segment.segmentIndex,
          segment.startTime,
          segment.startDayOffset,
          segment.endTime,
          segment.endDayOffset,
        ],
      )
    }
  }

  async function readShiftWithSegments(trx, orgId, shiftRow) {
    const segmentsByShiftId = await loadSegmentsByShiftId(trx, orgId, [shiftRow.id])
    return mapShiftWithSegments(shiftRow, segmentsByShiftId.get(String(shiftRow.id)) ?? [], orgId)
  }

  /**
   * Canonical create. input.segments (validated) wins; providing both segments and
   * legacy timing fields is rejected as ambiguous. A legacy-envelope create persists
   * a synthesized segment 0 so every new shift has segment rows.
   */
  async function createShift(db, { orgId, input }) {
    const hasSegments = input.segments !== undefined && input.segments !== null
    const hasLegacyTiming = input.workStartTime !== undefined
      || input.workEndTime !== undefined
      || input.isOvernight !== undefined
    if (hasSegments && hasLegacyTiming) {
      throw new HttpError(
        422,
        SHIFT_SERVICE_ERROR.SEGMENT_MODE_AMBIGUOUS,
        'Provide either segments or legacy start/end fields, not both',
        fieldDetail('segments', 'Cannot combine segments with workStartTime/workEndTime/isOvernight'),
      )
    }

    let segments
    let envelope
    if (hasSegments) {
      segments = validateShiftSegments(input.segments)
      envelope = deriveEnvelopeFromSegments(segments)
    } else {
      const timing = resolveShiftTiming({
        workStartTime: input.workStartTime ?? DEFAULT_SHIFT.workStartTime,
        workEndTime: input.workEndTime ?? DEFAULT_SHIFT.workEndTime,
        explicitOvernight: input.isOvernight,
      })
      if (timing.error) {
        throw new HttpError(400, 'VALIDATION_ERROR', timing.error)
      }
      envelope = { ...timing, plannedMinutes: null }
      segments = validateShiftSegments([{
        startTime: timing.workStartTime,
        endTime: timing.workEndTime,
        endDayOffset: timing.isOvernight ? 1 : 0,
      }])
      envelope.plannedMinutes = deriveEnvelopeFromSegments(segments).plannedMinutes
    }

    const flexPolicy = validateFlexPolicy(
      input.flexPolicy,
      segments.length,
      segments[0]?.startTime ?? null,
    )

    const shiftId = randomUUID()
    return db.transaction(async (trx) => {
      const rows = await trx.query(
        `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight,
          late_grace_minutes, early_grace_minutes, rounding_minutes, working_days,
          flex_mode, flex_required_minutes, flex_arrival_window_before_minutes,
          flex_arrival_window_after_minutes, flex_core_start_time, flex_core_end_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                 $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          shiftId,
          orgId,
          input.name ?? DEFAULT_SHIFT.name,
          input.timezone ?? DEFAULT_SHIFT.timezone,
          envelope.workStartTime,
          envelope.workEndTime,
          envelope.isOvernight,
          input.lateGraceMinutes ?? DEFAULT_SHIFT.lateGraceMinutes,
          input.earlyGraceMinutes ?? DEFAULT_SHIFT.earlyGraceMinutes,
          input.roundingMinutes ?? DEFAULT_SHIFT.roundingMinutes,
          JSON.stringify(normalizeWorkingDays(input.workingDays ?? DEFAULT_SHIFT.workingDays)),
          flexPolicy.mode,
          flexPolicy.requiredMinutes,
          flexPolicy.arrivalWindowBeforeMinutes,
          flexPolicy.arrivalWindowAfterMinutes,
          flexPolicy.coreStartTime,
          flexPolicy.coreEndTime,
        ],
      )
      await insertSegmentRows(trx, orgId, shiftId, segments)
      return readShiftWithSegments(trx, orgId, rows[0])
    })
  }

  /**
   * Canonical update. Three modes, exactly one per request:
   *   - segments: replace all segments, derive the envelope from them. Converting
   *     one segment to multiple is blocked (409, zero writes) while the flag is OFF
   *     and the shift has any durable assignment / rotation / pending swap /
   *     pending-or-published dispatch reference, including ended history.
   *   - envelope: legacy start/end write on a single-segment shift; updates the
   *     envelope and segment 0 together. Rejected (422, zero writes) on a
   *     multi-segment shift — a start/end-only PUT cannot collapse segments.
   *   - metadata: no segments and no timing fields — preserves segments and the
   *     stored envelope.
   */
  async function updateShift(db, { orgId, shiftId, patch }) {
    const hasSegments = patch.segments !== undefined && patch.segments !== null
    const hasEnvelopeTiming = patch.workStartTime !== undefined
      || patch.workEndTime !== undefined
      || patch.isOvernight !== undefined
    if (hasSegments && hasEnvelopeTiming) {
      throw new HttpError(
        422,
        SHIFT_SERVICE_ERROR.SEGMENT_MODE_AMBIGUOUS,
        'Provide either segments or legacy start/end fields, not both',
        fieldDetail('segments', 'Cannot combine segments with workStartTime/workEndTime/isOvernight'),
      )
    }
    const mode = hasSegments ? 'segments' : (hasEnvelopeTiming ? 'envelope' : 'metadata')

    return db.transaction(async (trx) => {
      const existingRows = await trx.query(
        'SELECT * FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [shiftId, orgId],
      )
      if (!existingRows.length) {
        throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
      }
      const existing = existingRows[0]
      const currentSegmentCount = await countPersistedSegments(trx, orgId, shiftId)

      let segments = null
      let envelope = null
      if (mode === 'segments') {
        segments = validateShiftSegments(patch.segments)
        const currentCount = currentSegmentCount === 0 ? 1 : currentSegmentCount
        // #4556 Gate A / Option B: the service holds a write trx but no port, so the
        // 1->multi conversion guard is pinned to the closed legacy posture (block whenever
        // durable references exist). Byte-identical to the retired env-gate's production
        // behaviour (master gate OFF => the env term was always true). Residual R4: a
        // Gate-C-enabled shadow org still cannot convert here until this guard is re-sourced
        // from the port in a later slice.
        if (segments.length > 1 && currentCount <= 1) {
          const blockers = await findShiftDeleteBlockers(trx, { orgId, shiftId, shiftName: existing.name })
          if (blockers.length > 0) {
            throw new HttpError(
              409,
              SHIFT_SERVICE_ERROR.SEGMENT_CONVERSION_BLOCKED,
              'Shift has durable references and cannot be converted from one segment to multiple segments while segment calculation is disabled',
              blockers.map((blocker) => ({ field: blocker.blocker, message: `${blocker.blocker}: ${blocker.count}` })),
            )
          }
        }
        envelope = deriveEnvelopeFromSegments(segments)
      } else if (mode === 'envelope') {
        if (currentSegmentCount > 1) {
          throw new HttpError(
            422,
            SHIFT_SERVICE_ERROR.ENVELOPE_COLLAPSE_REJECTED,
            'A start/end-only update cannot modify a multi-segment shift; submit the full segments array instead',
            fieldDetail('workStartTime', 'Multi-segment shifts require a segments array update'),
          )
        }
        const timing = resolveShiftTiming({
          workStartTime: patch.workStartTime ?? existing.work_start_time,
          workEndTime: patch.workEndTime ?? existing.work_end_time,
          explicitOvernight: patch.isOvernight,
          fallbackOvernight: existing.is_overnight,
        })
        if (timing.error) {
          throw new HttpError(400, 'VALIDATION_ERROR', timing.error)
        }
        segments = validateShiftSegments([{
          startTime: timing.workStartTime,
          endTime: timing.workEndTime,
          endDayOffset: timing.isOvernight ? 1 : 0,
        }])
        envelope = { ...timing, plannedMinutes: deriveEnvelopeFromSegments(segments).plannedMinutes }
      }

      if (
        patch.name !== undefined
        && patch.name !== existing.name
        && typeof normalizeLegacyRotationRulesForShiftName === 'function'
      ) {
        const normalizationResult = await normalizeLegacyRotationRulesForShiftName(
          trx,
          orgId,
          shiftId,
          existing.name,
        )
        if (normalizationResult.ambiguous) {
          throw new HttpError(
            409,
            'CONFLICT',
            'Cannot rename shift while legacy rotation rules still reference a duplicate shift name',
          )
        }
      }

      const name = patch.name ?? existing.name
      const timezone = patch.timezone ?? existing.timezone
      const lateGraceMinutes = patch.lateGraceMinutes ?? existing.late_grace_minutes
      const earlyGraceMinutes = patch.earlyGraceMinutes ?? existing.early_grace_minutes
      const roundingMinutes = patch.roundingMinutes ?? existing.rounding_minutes
      const workingDays = patch.workingDays !== undefined
        ? normalizeWorkingDays(patch.workingDays)
        : normalizeWorkingDays(existing.working_days)
      const workStartTime = envelope ? envelope.workStartTime : existing.work_start_time
      const workEndTime = envelope ? envelope.workEndTime : existing.work_end_time
      const isOvernight = envelope ? envelope.isOvernight : (existing.is_overnight === true || existing.is_overnight === 't')

      // Flex policy: explicit patch wins; otherwise re-validate the stored policy
      // against the post-update segment count (blocks multi-segment flex) and
      // the final segment-0 start (core-hours authoring guarantee).
      const finalSegmentCount = segments
        ? segments.length
        : (currentSegmentCount === 0 ? 1 : currentSegmentCount)
      let finalSegmentStartTime = segments?.[0]?.startTime ?? null
      if (finalSegmentStartTime == null) {
        const existingSegments = await loadSegmentsByShiftId(trx, orgId, [shiftId])
        const rows = existingSegments.get(String(shiftId)) ?? []
        if (rows.length > 0) {
          const ordered = rows
            .slice()
            .sort((a, b) => Number(a.segment_index) - Number(b.segment_index))
          finalSegmentStartTime = normalizeTimeString(ordered[0].start_time)
        } else {
          finalSegmentStartTime = normalizeTimeString(existing.work_start_time)
        }
      }
      let flexPolicy
      if (patch.flexPolicy !== undefined) {
        flexPolicy = validateFlexPolicy(patch.flexPolicy, finalSegmentCount, finalSegmentStartTime)
      } else {
        flexPolicy = validateFlexPolicy(
          mapFlexPolicyFromRow(existing),
          finalSegmentCount,
          finalSegmentStartTime,
        )
      }

      const rows = await trx.query(
        `UPDATE attendance_shifts
            SET name = $3,
                timezone = $4,
                work_start_time = $5,
                work_end_time = $6,
                is_overnight = $7,
                late_grace_minutes = $8,
                early_grace_minutes = $9,
                rounding_minutes = $10,
                working_days = $11::jsonb,
                flex_mode = $12,
                flex_required_minutes = $13,
                flex_arrival_window_before_minutes = $14,
                flex_arrival_window_after_minutes = $15,
                flex_core_start_time = $16,
                flex_core_end_time = $17,
                updated_at = now()
          WHERE id = $1 AND org_id = $2
          RETURNING *`,
        [
          shiftId,
          orgId,
          name,
          timezone,
          workStartTime,
          workEndTime,
          isOvernight,
          lateGraceMinutes,
          earlyGraceMinutes,
          roundingMinutes,
          JSON.stringify(workingDays),
          flexPolicy.mode,
          flexPolicy.requiredMinutes,
          flexPolicy.arrivalWindowBeforeMinutes,
          flexPolicy.arrivalWindowAfterMinutes,
          flexPolicy.coreStartTime,
          flexPolicy.coreEndTime,
        ],
      )

      if (segments) {
        await trx.query(
          'DELETE FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2',
          [orgId, shiftId],
        )
        await insertSegmentRows(trx, orgId, shiftId, segments)
      }

      return readShiftWithSegments(trx, orgId, rows[0])
    })
  }

  /** Dual-read detail: persisted segments when present, legacy synthesis otherwise. */
  async function readShift(db, { orgId, shiftId }) {
    const rows = await db.query(
      'SELECT * FROM attendance_shifts WHERE id = $1 AND org_id = $2 LIMIT 1',
      [shiftId, orgId],
    )
    if (!rows.length) return null
    return readShiftWithSegments(db, orgId, rows[0])
  }

  /** Parent-first pagination, then one batched segment hydration for the page. */
  async function listShifts(db, { orgId, page, pageSize, offset }) {
    const countRows = await db.query(
      'SELECT COUNT(*)::int AS total FROM attendance_shifts WHERE org_id = $1',
      [orgId],
    )
    const total = Number(countRows[0]?.total ?? 0)
    const rows = await db.query(
      `SELECT * FROM attendance_shifts
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [orgId, pageSize, offset],
    )
    const segmentsByShiftId = await loadSegmentsByShiftId(db, orgId, rows.map((row) => row.id))
    return {
      items: rows.map((row) => mapShiftWithSegments(row, segmentsByShiftId.get(String(row.id)) ?? [], orgId)),
      total,
      page,
      pageSize,
    }
  }

  /**
   * Durable delete blockers (W3 erratum): ANY assignment row (including
   * ended/inactive history), any rotation-rule shift_sequence reference (id or
   * legacy name; rotation assignments are protected indirectly through their
   * rule), a pending swap requester/counterparty snapshot, or a
   * pending/published dispatch target, or desired fixed-schedule config. Rejected swap snapshots, cancelled
   * dispatch snapshots, and auto-write candidate ids are immutable historical
   * evidence and deliberately NOT blockers.
   */
  async function findShiftDeleteBlockers(trx, { orgId, shiftId, shiftName }) {
    const blockers = []
    const assignmentRows = await trx.query(
      'SELECT COUNT(*)::int AS total FROM attendance_shift_assignments WHERE org_id = $1 AND shift_id = $2',
      [orgId, shiftId],
    )
    const assignmentCount = Number(assignmentRows[0]?.total ?? 0)
    if (assignmentCount > 0) blockers.push({ blocker: 'shift_assignments', count: assignmentCount })

    const fixedConfigRows = await trx.query(
      'SELECT COUNT(*)::int AS total FROM attendance_group_fixed_schedule_configs WHERE org_id = $1 AND shift_id = $2',
      [orgId, shiftId],
    )
    const fixedConfigCount = Number(fixedConfigRows[0]?.total ?? 0)
    if (fixedConfigCount > 0) blockers.push({ blocker: 'fixed_schedule_configs', count: fixedConfigCount })

    const rotationRows = await trx.query(
      `SELECT COUNT(*)::int AS total
         FROM attendance_rotation_rules r
        WHERE r.org_id = $1
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(COALESCE(r.shift_sequence, '[]'::jsonb)) AS seq(shift_ref)
             WHERE seq.shift_ref = $2::text
                OR seq.shift_ref = $3::text
          )`,
      [orgId, shiftId, shiftName ?? ''],
    )
    const rotationCount = Number(rotationRows[0]?.total ?? 0)
    if (rotationCount > 0) blockers.push({ blocker: 'rotation_rules', count: rotationCount })

    const swapRows = await trx.query(
      `SELECT COUNT(*)::int AS total
         FROM attendance_shift_swap_requests d
         JOIN attendance_requests r ON r.id = d.request_id
        WHERE d.org_id = $1
          AND r.status = 'pending'
          AND (d.requester_shift_id = $2 OR d.counterparty_shift_id = $2)`,
      [orgId, shiftId],
    )
    const swapCount = Number(swapRows[0]?.total ?? 0)
    if (swapCount > 0) blockers.push({ blocker: 'shift_swap_requests', count: swapCount })

    const dispatchRows = await trx.query(
      `SELECT COUNT(*)::int AS total
         FROM attendance_schedule_dispatch_requests
        WHERE org_id = $1
          AND target_shift_id = $2
          AND publish_status IN ('pending', 'published')`,
      [orgId, shiftId],
    )
    const dispatchCount = Number(dispatchRows[0]?.total ?? 0)
    if (dispatchCount > 0) blockers.push({ blocker: 'schedule_dispatch_requests', count: dispatchCount })

    return blockers
  }

  /**
   * Canonical delete. Shares the reference-writer lock protocol: the shift row is
   * locked FOR UPDATE before the blocker check, and every reference writer locks
   * the same row FOR SHARE inside its own transaction before inserting, so no
   * reference can appear between the check and the delete. Returns a typed 409
   * with zero writes for any durable blocker; historical evidence rows remain
   * stored untouched.
   */
  async function deleteShift(db, { orgId, shiftId }) {
    return db.transaction(async (trx) => {
      const shiftRows = await trx.query(
        'SELECT id, name FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [shiftId, orgId],
      )
      if (!shiftRows.length) {
        throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
      }
      const shift = shiftRows[0]
      const blockers = await findShiftDeleteBlockers(trx, { orgId, shiftId, shiftName: shift.name })
      if (blockers.length > 0) {
        throw new HttpError(
          409,
          SHIFT_SERVICE_ERROR.DELETE_BLOCKED,
          'Shift is still referenced by scheduling records and cannot be deleted; historical evidence is preserved',
          blockers.map((blocker) => ({ field: blocker.blocker, message: `${blocker.blocker}: ${blocker.count} reference(s)` })),
        )
      }
      await trx.query(
        'DELETE FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2',
        [orgId, shiftId],
      )
      await trx.query(
        'DELETE FROM attendance_shifts WHERE id = $1 AND org_id = $2',
        [shiftId, orgId],
      )
      return { id: shiftId }
    })
  }

  /**
   * Canonical assignability guard for every reference-producing writer (erratum).
   * Locks the shift row FOR SHARE inside the caller's write transaction (the same
   * row delete locks FOR UPDATE), then fails closed with a typed 422 when the
   * shift has more than one persisted segment and authoritative segment
   * calculation is disabled for the org. Throws 404 when the shift does not exist
   * in the org.
   */
  async function assertShiftReferenceAllowed(trx, { orgId, shiftId, producer, referenceSegments }) {
    const rows = await trx.query(
      'SELECT id FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR SHARE',
      [shiftId, orgId],
    )
    if (!rows.length) {
      throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
    }
    await assertLockedShiftReferenceAllowed(trx, { orgId, shiftId, producer, referenceSegments })
  }

  // #4556 Gate A / Option B: a PURE function of the explicit `referenceSegments` boolean.
  // `true` (the org's canonical posture, resolved by the port on the caller's write trx —
  // exact-org allowlisted, wildcard-refused, persisted rollout row) admits any segment count.
  // Anything else (`false`, or a caller that failed to resolve the port) is fail-closed: a
  // multi-segment / unverifiable shift throws the typed 422. There is no environment read and
  // no `=== undefined => isSegmentCalculationEnabled` fallback anymore — the plugin's second
  // gating mechanism is retired, leaving the port as the one source of truth.
  function assertSegmentCalculationAllowed({ orgId, shiftId, segmentCount, producer, referenceSegments }) {
    if (referenceSegments === true) return
    const normalizedCount = Number(segmentCount)
    if (segmentCount == null || !Number.isInteger(normalizedCount) || normalizedCount < 0) {
      throw new HttpError(
        422,
        SHIFT_SERVICE_ERROR.MULTI_SEGMENT_CALCULATION_DISABLED,
        `Shift segment state cannot be verified; authoritative segment calculation is disabled for this org, so ${producer} cannot continue`,
        fieldDetail('shiftId', `Unable to verify segment state for shift ${shiftId}`),
      )
    }
    if (normalizedCount > 1) {
      throw new HttpError(
        422,
        SHIFT_SERVICE_ERROR.MULTI_SEGMENT_CALCULATION_DISABLED,
        `Shift has ${normalizedCount} segments; authoritative segment calculation is disabled for this org, so ${producer} cannot use a multi-segment shift`,
        fieldDetail('shiftId', 'Multi-segment shift is authoring preview-only while segment calculation is disabled'),
      )
    }
  }

  async function assertLockedShiftReferenceAllowed(trx, { orgId, shiftId, producer, referenceSegments }) {
    const segmentCount = await countPersistedSegments(trx, orgId, shiftId)
    assertSegmentCalculationAllowed({ orgId, shiftId, segmentCount, producer, referenceSegments })
  }

  /**
   * Sequence variant for rotation rules and rotation-rule-driven writers. Locks
   * every referenced shift in one ORDER BY id FOR SHARE query (deadlock-safe) and
   * applies the same fail-closed 422 to each. Non-UUID legacy names conservatively
   * lock and check every org-scoped match; unresolvable legacy names are left to the
   * caller's existing validation.
   */
  async function assertShiftSequenceReferenceAllowed(trx, { orgId, shiftRefs, producer, referenceSegments }) {
    const refs = Array.from(new Set((shiftRefs ?? []).map((ref) => String(ref ?? '').trim()).filter(Boolean)))
    if (refs.length === 0) return
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const uuidRefs = refs.filter((ref) => uuidPattern.test(ref)).sort()
    const nameRefs = refs.filter((ref) => !uuidPattern.test(ref))
    const rows = await trx.query(
      `SELECT id, name
         FROM attendance_shifts
        WHERE org_id = $1
          AND (
            id = ANY($2::uuid[])
            OR name = ANY($3::text[])
          )
        ORDER BY id
        FOR SHARE`,
      [orgId, uuidRefs, nameRefs],
    )
    const foundIds = new Set(rows.map((row) => String(row.id)))
    const missingUuid = uuidRefs.find((shiftId) => !foundIds.has(shiftId))
    if (missingUuid) {
      throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
    }
    const lockedIds = Array.from(foundIds).sort()
    for (const shiftId of lockedIds) {
      await assertLockedShiftReferenceAllowed(trx, { orgId, shiftId, producer, referenceSegments })
    }
  }

  /**
   * Neutral-label support for historical reads (erratum): rejected swap snapshots,
   * cancelled dispatch snapshots, and auto-write candidate rows that can no longer
   * resolve their shift must expose a neutral deleted/unavailable label and never
   * the raw UUID. rows are mutated in place: a resolvable id keeps its value and
   * gains a label; an unresolvable id is replaced with null plus the neutral label.
   */
  async function loadShiftNameLookup(db, orgId, shiftIds) {
    const lookup = new Map()
    const ids = Array.from(new Set((shiftIds ?? []).filter(Boolean)))
    if (ids.length === 0) return lookup
    const rows = await db.query(
      'SELECT id, name FROM attendance_shifts WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [orgId, ids],
    )
    for (const row of rows) {
      lookup.set(String(row.id), typeof row.name === 'string' ? row.name : '')
    }
    return lookup
  }

  function applyShiftReferenceLabels(rows, nameLookup, fieldSpecs) {
    for (const row of rows ?? []) {
      for (const spec of fieldSpecs) {
        const rawId = row[spec.idField]
        if (!rawId) continue
        const key = String(rawId)
        if (nameLookup.has(key)) {
          row[spec.labelField] = nameLookup.get(key) || SHIFT_REFERENCE_DELETED_LABEL
          row[spec.statusField] = 'available'
        } else {
          row[spec.idField] = null
          row[spec.labelField] = SHIFT_REFERENCE_DELETED_LABEL
          row[spec.statusField] = 'deleted'
        }
      }
    }
    return rows
  }

  return {
    validateShiftSegments,
    validateFlexPolicy,
    mapFlexPolicyFromRow,
    deriveEnvelopeFromSegments,
    synthesizeSegmentsFromEnvelope,
    buildShiftCapabilities,
    mapShiftWithSegments,
    loadSegmentsByShiftId,
    countPersistedSegments,
    createShift,
    updateShift,
    readShift,
    listShifts,
    deleteShift,
    findShiftDeleteBlockers,
    assertSegmentCalculationAllowed,
    assertShiftReferenceAllowed,
    assertShiftSequenceReferenceAllowed,
    loadShiftNameLookup,
    applyShiftReferenceLabels,
  }
}

module.exports = {
  SEGMENT_MIN,
  SEGMENT_MAX,
  MINUTES_PER_DAY,
  SEGMENT_CALCULATION_FLAG_ENV,
  SEGMENT_CALCULATION_IMPLEMENTED,
  SHIFT_REFERENCE_DELETED_LABEL,
  SHIFT_SERVICE_ERROR,
  createAttendanceShiftService,
}
