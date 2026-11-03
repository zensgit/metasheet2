'use strict'

// Fresh related-document input only. Replay invokes no mutable admission,
// and omitted/null endpoints keep the existing minutes-only business policy.
function validateAttendanceRelatedAbsoluteInstantsV1(body, HttpError) {
  for (const key of ['requestedInAt','requested_in_at','clockIn','requestedOutAt','requested_out_at','clockOut']) {
    const value = body[key]
    if (value === undefined || value === null) continue
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    const date = match ? new Date(match[1]+'T00:00:00.000Z') : null
    if (!match || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==match[1]
      || Number(match[2])>23 || Number(match[3])>59 || (match[4] !== undefined && Number(match[4])>59)
      || !Number.isFinite(Date.parse(value))) {
      throw new HttpError(422,'ATTENDANCE_TIMEZONE_INSTANT_INVALID','ATTENDANCE_TIMEZONE_INSTANT_INVALID')
    }
  }
}

// A single request has one work-date slot. Preserve existing same-day quantity
// rules; a night shift may additionally own an interval across local midnight.
function validateAttendanceLeaveTargetRangeV1(draft, target, HttpError, toWorkDate) {
  if (draft.requestType !== 'leave' || !target) return
  const start = draft.requestedInAt == null ? null : new Date(draft.requestedInAt).getTime()
  const end = draft.requestedOutAt == null ? null : new Date(draft.requestedOutAt).getTime()
  if (start === null && end === null) return
  const invalid = (start !== null && !Number.isFinite(start))
    || (end !== null && !Number.isFinite(end))
    || (start !== null && end !== null && end <= start)
  if (!invalid) {
    const points = [start, end === null ? null : end-1].filter(value => value !== null)
    const sameWorkDate = points.every(value => toWorkDate(new Date(value),target.timezone) === target.workDate)
    const windowStart = Date.parse(target.window.startAt)
    const windowEnd = Date.parse(target.window.endAt)
    const inTargetShift = points.every(value => value >= windowStart && value < windowEnd)
    if (sameWorkDate || inTargetShift) return
  }
  throw new HttpError(409,'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT','ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT')
}

module.exports = {validateAttendanceRelatedAbsoluteInstantsV1,validateAttendanceLeaveTargetRangeV1}
