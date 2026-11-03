'use strict'

const { parseFrozenWorkDateAttribution, MAX_ATTRIBUTION_TAIL_MINUTES } = require('./attendance-work-date-resolver.cjs')

function createAttendanceTimezoneFrozenWindowReader({ HttpError }) {
  function fail() { throw new HttpError(409, 'ATTENDANCE_TIMEZONE_FROZEN_WINDOW_INVALID', 'ATTENDANCE_TIMEZONE_FROZEN_WINDOW_INVALID') }
  function json(value) { return typeof value === 'string' ? JSON.parse(value) : value }
  function bounds(value) {
    if (!value || typeof value.startAt !== 'string' || typeof value.endAt !== 'string') fail()
    const startAt = new Date(value.startAt)
    const endAt = new Date(value.endAt)
    if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) fail()
    return { startAt, endAt }
  }
  return async function readFrozenTimezoneWindows(trx, { orgId, userId, from, to }) {
    const rows = await trx.query(`SELECT r.id,r.org_id,r.user_id,r.work_date::text,r.timezone,r.meta,
      c.frame_snapshot,c.context_fingerprint,
      calc.attribution_snapshot,calc.context_snapshot
      FROM attendance_records r
      LEFT JOIN attendance_timezone_context_companions c ON c.record_id=r.id AND c.org_id=r.org_id
      LEFT JOIN attendance_record_calculations calc ON calc.id=r.current_calculation_id
        AND calc.attendance_record_id=r.id AND calc.org_id=r.org_id
      WHERE r.org_id=$1 AND r.user_id=$2 AND r.first_in_at IS NOT NULL AND r.visibility_state='active'`,[orgId,userId])
    const result = []
    for (const row of rows) {
      let absoluteWindow, attributionWindow, shiftId = null, provenance = null
      if (row.frame_snapshot) {
        const frame = json(row.frame_snapshot)
        if (frame.orgId !== orgId || frame.userId !== userId || frame.workDate !== row.work_date
          || frame.timezone !== row.timezone || frame.fingerprint !== row.context_fingerprint) fail()
        absoluteWindow = bounds(frame.absoluteWindow)
        attributionWindow = bounds(frame.attributionWindow)
        shiftId = frame.resolution?.shiftId ?? null
        provenance = frame.timezoneContext
      } else {
        const attribution = json(row.attribution_snapshot)
        const context = json(row.context_snapshot)
        if (attribution?.posture === 'resolved_v2') {
          const frozen = attribution.value
          if (frozen.orgId !== orgId || frozen.userId !== userId || frozen.workDate !== row.work_date
            || !context || context.timezone !== row.timezone) fail()
          absoluteWindow = bounds(frozen.absoluteWindow)
          attributionWindow = bounds(frozen.attributionWindow)
          shiftId = frozen.shiftId
        } else {
          const metadata = json(row.meta)
          const frozen = parseFrozenWorkDateAttribution(metadata?.workDateAttributionV1 ?? metadata?.workDateAttribution)
          // No absolute frozen evidence is not proof of an infinitely ongoing shift.
          if (!frozen) continue
          if (frozen.orgId !== orgId || frozen.userId !== userId || frozen.workDate !== row.work_date) fail()
          absoluteWindow = bounds(frozen.evidenceSnapshot?.winner?.absoluteWindow)
          // The governed maximum is only a preselection bound, never a guessed tail.
          if (absoluteWindow.startAt >= to
            || absoluteWindow.endAt.getTime()+MAX_ATTRIBUTION_TAIL_MINUTES*60_000 <= from.getTime()) continue
          const tail = frozen.evidenceSnapshot?.attributionTailMinutes
          if (!Number.isInteger(tail) || tail < 0 || tail > MAX_ATTRIBUTION_TAIL_MINUTES) fail()
          attributionWindow = { startAt: absoluteWindow.startAt, endAt: new Date(absoluteWindow.endAt.getTime()+tail*60_000) }
          shiftId = frozen.shiftId
        }
      }
      if (attributionWindow.startAt.getTime() !== absoluteWindow.startAt.getTime()
        || attributionWindow.endAt < absoluteWindow.endAt) fail()
      if (absoluteWindow.startAt < to && from < attributionWindow.endAt) {
        result.push({ recordId:row.id,workDate:row.work_date,shiftId,timezone:row.timezone,
          startAt:absoluteWindow.startAt,endAt:absoluteWindow.endAt,
          attributionStartAt:attributionWindow.startAt,attributionEndAt:attributionWindow.endAt,
          contextFingerprint:row.context_fingerprint ?? null,timezoneContext:provenance })
      }
    }
    return result
  }
}

module.exports = { createAttendanceTimezoneFrozenWindowReader }
