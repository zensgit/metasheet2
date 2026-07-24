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
 */

const SEGMENT_MIN = 1
const SEGMENT_MAX = 3
const MINUTES_PER_DAY = 1440
const SEGMENT_CALCULATION_FLAG_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
// W3 has no authoritative segment calculator. An environment value alone must never
// make reference writers accept multi-segment shifts or advertise authoritative
// results. W4 must flip this only in the same reviewed change that adds the calculator.
const SEGMENT_CALCULATION_IMPLEMENTED = false
const SHIFT_REFERENCE_DELETED_LABEL = 'Deleted or unavailable shift'

const SHIFT_SERVICE_ERROR = Object.freeze({
  SEGMENTS_INVALID: 'ATTENDANCE_SHIFT_SEGMENTS_INVALID',
  SEGMENT_MODE_AMBIGUOUS: 'ATTENDANCE_SHIFT_SEGMENT_MODE_AMBIGUOUS',
  ENVELOPE_COLLAPSE_REJECTED: 'ATTENDANCE_SHIFT_ENVELOPE_COLLAPSE_REJECTED',
  MULTI_SEGMENT_CALCULATION_DISABLED: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED',
  SEGMENT_CONVERSION_BLOCKED: 'ATTENDANCE_SHIFT_SEGMENT_CONVERSION_BLOCKED',
  DELETE_BLOCKED: 'ATTENDANCE_SHIFT_DELETE_BLOCKED',
})

const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const SEGMENT_INPUT_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

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
   * Org-scoped authoritative-calculation flag. The env var holds a comma-separated
   * list of opted-in org ids ('*' = all); unset/empty means OFF for every org.
   * W3 ships it OFF everywhere; enabling it is a separately authorized rollout step.
   */
  function isSegmentCalculationEnabled(orgId) {
    if (!SEGMENT_CALCULATION_IMPLEMENTED) return false
    const raw = typeof process.env[SEGMENT_CALCULATION_FLAG_ENV] === 'string'
      ? process.env[SEGMENT_CALCULATION_FLAG_ENV]
      : ''
    const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    if (entries.length === 0) return false
    if (entries.includes('*')) return true
    return entries.includes(String(orgId ?? DEFAULT_ORG_ID))
  }

  /**
   * Values-safe capability projection: state and labels only, no secrets and no
   * member/user values. Shows authoritative segment calculation disabled by default.
   */
  function buildShiftCapabilities(orgId) {
    const enabled = isSegmentCalculationEnabled(orgId)
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
   * calculationMode, plannedMinutes, and the values-safe capability block.
   */
  function mapShiftWithSegments(shiftRow, segmentRows, orgId) {
    const base = mapShiftRow(shiftRow)
    const persisted = (segmentRows ?? []).map(mapSegmentRow)
    const segments = persisted.length > 0 ? persisted : synthesizeSegmentsFromEnvelope(shiftRow)
    const envelope = deriveEnvelopeFromSegments(segments)
    return {
      ...base,
      segments: segments.map(mapSegmentOutput),
      calculationMode: segments.length > 1 ? 'segments' : 'envelope',
      plannedMinutes: envelope.plannedMinutes,
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

    const shiftId = randomUUID()
    return db.transaction(async (trx) => {
      const rows = await trx.query(
        `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, late_grace_minutes, early_grace_minutes, rounding_minutes, working_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
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
        if (segments.length > 1 && currentCount <= 1 && !isSegmentCalculationEnabled(orgId)) {
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
   * pending/published dispatch target. Rejected swap snapshots, cancelled
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
  async function assertShiftReferenceAllowed(trx, { orgId, shiftId, producer }) {
    const rows = await trx.query(
      'SELECT id FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR SHARE',
      [shiftId, orgId],
    )
    if (!rows.length) {
      throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
    }
    await assertLockedShiftReferenceAllowed(trx, { orgId, shiftId, producer })
  }

  function assertSegmentCalculationAllowed({ orgId, shiftId, segmentCount, producer }) {
    if (isSegmentCalculationEnabled(orgId)) return
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

  async function assertLockedShiftReferenceAllowed(trx, { orgId, shiftId, producer }) {
    const segmentCount = await countPersistedSegments(trx, orgId, shiftId)
    assertSegmentCalculationAllowed({ orgId, shiftId, segmentCount, producer })
  }

  /**
   * Sequence variant for rotation rules and rotation-rule-driven writers. Locks
   * every referenced shift in one ORDER BY id FOR SHARE query (deadlock-safe) and
   * applies the same fail-closed 422 to each. Non-UUID legacy names conservatively
   * lock and check every org-scoped match; unresolvable legacy names are left to the
   * caller's existing validation.
   */
  async function assertShiftSequenceReferenceAllowed(trx, { orgId, shiftRefs, producer }) {
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
      await assertLockedShiftReferenceAllowed(trx, { orgId, shiftId, producer })
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
    deriveEnvelopeFromSegments,
    synthesizeSegmentsFromEnvelope,
    isSegmentCalculationEnabled,
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
