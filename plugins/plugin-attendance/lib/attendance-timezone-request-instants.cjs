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

module.exports = {validateAttendanceRelatedAbsoluteInstantsV1}
