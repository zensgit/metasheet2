// Explicit offsets denote instants; naive wall clocks are parsed by the existing rule-zone path.
function parseImportAbsoluteDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const text = String(value ?? '').trim()
  let date
  if (/^(?:\d{10}|\d{13})$/.test(text)) {
    date = new Date(Number(text) * (text.length === 10 ? 1000 : 1))
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    date = new Date(text)
  } else {
    return null
  }
  return Number.isNaN(date.getTime()) ? null : date
}

async function normalizeImportCalendarRows({ db, orgId, payload, rows, coalesce, fallbackUserId }, helpers) {
  const {
    loadDefaultRule, loadAttendanceGroupRuleSetMap, loadRuleSetConfigById,
    resolveAttendanceGroupKey, normalizeRuleOverride, toWorkDate, normalizeDateOnly,
    resolveRowUserId, resolveImportRowUserReference, loadAttendanceImportUserIdentifierIndex,
    loadRotationAssignment, loadShiftAssignment, addDaysToDateKey, HttpError,
  } = helpers
  let baseRule
  let groupRules
  const rules = new Map()
  const contexts = new Map()
  const userOptions = {
    fallbackUserId: payload.userId ?? fallbackUserId,
    userMap: payload.userMap,
    userMapKeyField: payload.userMapKeyField,
    userMapSourceFields: payload.userMapSourceFields,
  }
  const instantRows = rows.filter(row => parseImportAbsoluteDate(row.workDate))
  const userIdentifierIndex = instantRows.length
    ? await loadAttendanceImportUserIdentifierIndex(db, orgId,
      instantRows.map(row => resolveRowUserId({ row, ...userOptions })))
    : new Map()
  let calendarError = null
  const unresolvedScopeRows = []
  const normalized = []
  const byDay = new Map()
  for (const row of rows) {
    const instant = parseImportAbsoluteDate(row.workDate)
    let workDate = coalesce ? normalizeDateOnly(row.workDate) : row.workDate
    if (instant) {
      baseRule ??= await loadDefaultRule(db, orgId)
      const groupKey = resolveAttendanceGroupKey(row)
      if (!payload.ruleSetId && groupKey) {
        groupRules ??= await loadAttendanceGroupRuleSetMap(db, orgId)
      }
      const ruleSetId = payload.ruleSetId ?? groupRules?.get(groupKey)
        ?? (groupKey ? payload.groupSync?.ruleSetId : null)
      if (ruleSetId && !rules.has(ruleSetId)) {
        rules.set(ruleSetId, await loadRuleSetConfigById(db, orgId, ruleSetId))
      }
      const override = normalizeRuleOverride(rules.get(ruleSetId)?.rule)
      const timeZone = override?.timezone || baseRule.timezone
      const { userId } = resolveImportRowUserReference(row, { ...userOptions, userIdentifierIndex })
      workDate = toWorkDate(instant, timeZone)
      if (userId) {
        const defaultRule = override
          ? { ...baseRule, ...override, timezone: timeZone, workingDays: override.workingDays ?? baseRule.workingDays }
          : baseRule
        const candidates = []
        // A local calendar date is at most one day from UTC. Reuse the importer's
        // rotation > assignment > rule precedence for each possible date.
        const utcDay = instant.toISOString().slice(0, 10)
        for (const offset of [-1, 0, 1]) {
          const date = addDaysToDateKey(utcDay, offset)
          const key = JSON.stringify([userId, ruleSetId ?? null, date])
          if (!contexts.has(key)) {
            // Calendar selection reads source/timezone only. The authorized calculation
            // still runs resolveWorkContext and its segment gate for the selected date.
            const rotation = await loadRotationAssignment(db, orgId, userId, date)
            const assignment = rotation ? null : await loadShiftAssignment(db, orgId, userId, date)
            contexts.set(key, {
              rule: rotation?.shift ?? assignment?.shift ?? defaultRule,
              source: rotation ? 'rotation' : assignment ? 'shift' : 'rule',
            })
          }
          const context = contexts.get(key)
          if (toWorkDate(instant, context.rule.timezone) === date) {
            candidates.push({ workDate: date, published: context.source !== 'rule' })
          }
        }
        const published = candidates.filter(candidate => candidate.published)
        const matches = published.length ? published : candidates
        if (matches.length !== 1) {
          calendarError ??= new HttpError(422, 'IMPORT_CALENDAR_DATE_UNRESOLVED', 'Import calendar date could not be resolved uniquely')
          unresolvedScopeRows.push(...matches.map(candidate => ({ ...row, workDate: candidate.workDate })))
        }
        if (matches.length) workDate = matches[0].workDate
      }
    }
    const next = { ...row, workDate: workDate ?? '' }
    if (!coalesce) {
      normalized.push(next)
      continue
    }
    const key = `${row.userId ?? row.fields?.sourceUserKey ?? 'unknown'}|${next.workDate}`
    const previous = byDay.get(key)
    if (previous) {
      previous.fields = { ...next.fields, ...previous.fields }
    } else {
      byDay.set(key, next)
      normalized.push(next)
    }
  }
  return { rows: normalized, calendarError, scopeRows: calendarError ? [...normalized, ...unresolvedScopeRows] : undefined }
}

// Keep uploaded-file iteration bounded while resolving subjects/calendars in batches.
async function iterateImportCalendarRows({ iterateRows, normalizeRows, onRow }) {
  let buffer = []
  let rowCount = 0
  let stopped = false
  const flush = async () => {
    if (!buffer.length || stopped) return
    const rows = await normalizeRows(buffer)
    buffer = []
    for (const row of rows) {
      const index = rowCount++
      if (typeof onRow === 'function' && await onRow(row, index) === false) {
        stopped = true
        break
      }
    }
  }
  const result = await iterateRows(async (row) => {
    buffer.push(row)
    if (buffer.length === 500) await flush()
    return !stopped
  })
  await flush()
  return { ...result, rowCount }
}

module.exports = { parseImportAbsoluteDate, normalizeImportCalendarRows, iterateImportCalendarRows }
