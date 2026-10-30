'use strict'

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function epoch(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null
}

function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00.000Z')
  return epoch(date) !== null && date.toISOString().slice(0, 10) === value
}

function validTimezone(value) {
  if (!identifier(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
    return true
  } catch (_error) {
    return false
  }
}

function candidateSegmentSelectionKeyV1(candidate) {
  if (!candidate || !['orgId', 'userId', 'assignmentId', 'shiftId'].every(
    field => identifier(candidate[field]),
  ) || !dateKey(candidate.workDate)
    || (candidate.source !== 'shift' && candidate.source !== 'rotation')) return null
  return JSON.stringify([
    candidate.orgId, candidate.userId, candidate.workDate,
    candidate.source, candidate.assignmentId, candidate.shiftId,
  ])
}

function candidateEnvelope(candidate) {
  if (!candidate || !validTimezone(candidate.timezone)) return null
  const start = epoch(candidate.absoluteWindow?.startAt)
  const end = epoch(candidate.absoluteWindow?.endAt)
  return start !== null && end !== null && end > start ? [start, end] : null
}

// Internal evidence only: callers supply the served W4 context and strict converter.
// No authorization, provenance stamp, attribution tail, or transaction proof is minted.
function createCanonicalSegmentWindowEvidenceV1(entries, options = {}) {
  if (!Array.isArray(entries) || !options
    || typeof options.resolveInstant !== 'function'
    || typeof options.addDaysToDateKey !== 'function') return null
  const { resolveInstant, addDaysToDateKey } = options
  const byKey = new Map()
  for (const entry of entries) {
    const candidate = entry?.candidate
    const definition = entry?.definition
    const key = candidateSegmentSelectionKeyV1(candidate)
    const envelope = candidateEnvelope(candidate)
    if (key === null || byKey.has(key) || !envelope || !definition
      || !['orgId', 'userId', 'workDate', 'shiftId', 'timezone'].every(
        field => definition[field] === candidate[field],
      ) || !Array.isArray(definition.segments)
      || definition.segments.length < 1 || definition.segments.length > 3) return null
    const windows = []
    for (let index = 0; index < definition.segments.length; index += 1) {
      const segment = definition.segments[index]
      if (!segment || segment.index !== index || segment.startDayOffset !== 0
        || (segment.endDayOffset !== 0 && segment.endDayOffset !== 1)
        || typeof segment.startTime !== 'string' || typeof segment.endTime !== 'string'
        || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(segment.startTime)
        || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(segment.endTime)) return null
      const endDate = segment.endDayOffset === 1
        ? addDaysToDateKey(candidate.workDate, 1) : candidate.workDate
      if (!dateKey(endDate)) return null
      // Read primitive bounds immediately; even a converter reusing Dates cannot alias them.
      const start = epoch(resolveInstant(candidate.workDate, segment.startTime, candidate.timezone))
      const end = epoch(resolveInstant(endDate, segment.endTime, candidate.timezone))
      if (start === null || end === null || end <= start
        || start < envelope[0] || end > envelope[1]
        || (index > 0 && start < windows[index - 1][1])) return null
      windows.push([start, end])
    }
    byKey.set(key, { timezone: candidate.timezone, start: envelope[0], end: envelope[1], windows })
  }
  return Object.freeze({
    contains(candidate, instant) {
      const key = candidateSegmentSelectionKeyV1(candidate)
      const at = epoch(instant)
      const envelope = candidateEnvelope(candidate)
      const captured = key === null ? null : byKey.get(key)
      if (!captured || at === null || !envelope || candidate.timezone !== captured.timezone
        || envelope[0] !== captured.start || envelope[1] !== captured.end) return null
      return captured.windows.some(([start, end]) => at >= start && at <= end)
    },
  })
}

module.exports = { candidateSegmentSelectionKeyV1, createCanonicalSegmentWindowEvidenceV1 }
