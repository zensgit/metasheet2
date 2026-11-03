'use strict'

// Calendar reads may display multiple selected slots under one governed timezone.
// The caller supplies the existing calendar selector's order, not raw SQL order.
function calendarCandidateKey(candidate) {
  return `${candidate.source}:${candidate.assignmentId ?? candidate.rule?.id}`
}

function buildCalendarTimezoneDay(windows, { candidateOrder, fingerprint }) {
  if (!windows.length) return null
  const byCandidate = new Map()
  const authorities = new Set()
  for (const window of windows) {
    authorities.add(fingerprint(window.timezoneContext))
    const key = calendarCandidateKey(window)
    const previous = byCandidate.get(key)
    if (previous && previous.contextFingerprint !== window.contextFingerprint) return null
    byCandidate.set(key,window)
  }
  if (authorities.size !== 1) return null
  const order = candidateOrder.length ? candidateOrder : [...byCandidate.keys()]
  if (order.length !== byCandidate.size || new Set(order).size !== order.length) return null
  const selected = order.map(key => byCandidate.get(key))
  if (selected.some(window => !window)) return null
  // No published selection means exactly one strict default-rule fallback.
  if (!candidateOrder.length && (selected.length !== 1 || selected[0].source !== 'rule')) return null
  const primary = selected[0]
  const isWorkingDay = selected.some(window => window.isWorkingDay)
  return {
    ...primary,
    startAt:new Date(Math.min(...selected.map(window => window.startAt.getTime()))),
    endAt:new Date(Math.max(...selected.map(window => window.endAt.getTime()))),
    isWorkingDay,
    sourceContext:{...primary.sourceContext,isWorkingDay},
    contextFingerprint:selected.length === 1 ? primary.contextFingerprint
      : fingerprint({kind:'calendar_day',windows:selected.map(window => window.contextFingerprint)}),
    calendarWindows:selected,
  }
}

module.exports = { buildCalendarTimezoneDay, calendarCandidateKey }
