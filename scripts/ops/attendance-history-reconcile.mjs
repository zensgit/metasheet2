#!/usr/bin/env node
// Read-only observations for one employee and an explicit historical window.
// Missing raw events can be legitimate for imports/adjustments; this is not a
// recalculation or a verdict that a cross-midnight assignment is incorrect.
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

export function historyScope(env) {
  const { ORG_ID: orgId, USER_ID: userId, FROM_DATE: from, TO_DATE: to } = env
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  if (![orgId, userId].every(value => typeof value === 'string' && value.trim() === value && value.length > 0)
    || !validDate(from) || !validDate(to) || from > to || Date.parse(to) - Date.parse(from) > 31 * 86400000) {
    throw new Error('ATTENDANCE_HISTORY_SCOPE_INVALID')
  }
  return { orgId, userId, from, to }
}

function instantMs(value) {
  if (!(value instanceof Date) && (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))) return null
  if (typeof value === 'string') {
    const day = new Date(`${value.slice(0, 10)}T00:00:00Z`)
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null
  }
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function localDay(instant, timezone) {
  try {
    if (typeof timezone !== 'string' || !timezone.trim()) return null
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(instant))
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-')
  } catch {
    return null
  }
}

export function summarizeHistory(records, events) {
  const counts = {
    records: records.length, rawEvents: events.length,
    recordsWithoutRawEvents: 0, recordsMissingIn: 0, recordsMissingOut: 0,
    completedPairsWithZeroMinutes: 0, reversedCompletedPairs: 0, recordBoundariesWithoutMatchingEvents: 0,
    recordsWithEventTimezoneDifference: 0, invalidRecordTimezones: 0,
    invalidEventTimezones: 0, invalidRecordInstants: 0, invalidEventInstants: 0,
    eventsWithLocalDateDifferentFromWorkDate: 0,
  }
  for (const record of records) {
    const sameDay = events.filter(event => event.work_date === record.work_date)
    if (sameDay.length === 0) counts.recordsWithoutRawEvents += 1
    if (!record.first_in_at) counts.recordsMissingIn += 1
    if (!record.last_out_at) counts.recordsMissingOut += 1
    if (record.first_in_at && record.last_out_at && Number(record.work_minutes) === 0) counts.completedPairsWithZeroMinutes += 1
    // PostgreSQL compares the original timestamptz values, retaining microseconds
    // that the pg driver's JavaScript Date representation would truncate.
    if (record.reversed_completed_pair) counts.reversedCompletedPairs += 1
    counts.recordBoundariesWithoutMatchingEvents += Number(record.unmatched_boundaries || 0)
    if (!localDay('2000-01-01T00:00:00Z', record.timezone)) counts.invalidRecordTimezones += 1
    if (sameDay.some(event => event.timezone !== record.timezone)) counts.recordsWithEventTimezoneDifference += 1
    for (const field of ['first_in_at', 'last_out_at']) {
      if (!record[field]) continue
      const boundary = instantMs(record[field])
      if (boundary === null) counts.invalidRecordInstants += 1
    }
  }
  for (const event of events) {
    const instant = instantMs(event.occurred_at)
    const timezoneValid = localDay('2000-01-01T00:00:00Z', event.timezone) !== null
    if (!timezoneValid) counts.invalidEventTimezones += 1
    if (instant === null) counts.invalidEventInstants += 1
    if (timezoneValid && instant !== null && localDay(instant, event.timezone) !== event.work_date) counts.eventsWithLocalDateDifferentFromWorkDate += 1
  }
  return { code: 'ATTENDANCE_HISTORY_OBSERVATIONS', readOnly: true, counts }
}

export async function reconcileHistory(client, scope) {
  const params = [scope.orgId, scope.userId, scope.from, scope.to]
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query('SET LOCAL statement_timeout = 10000')
    const records = await client.query(`SELECT work_date::text, timezone, first_in_at, last_out_at, work_minutes,
      COALESCE(last_out_at < first_in_at, false) AS reversed_completed_pair,
      (CASE WHEN first_in_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM attendance_events e WHERE e.org_id = r.org_id AND e.user_id = r.user_id
        AND e.work_date = r.work_date AND e.event_type = 'check_in' AND e.occurred_at = r.first_in_at
      ) THEN 1 ELSE 0 END + CASE WHEN last_out_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM attendance_events e WHERE e.org_id = r.org_id AND e.user_id = r.user_id
        AND e.work_date = r.work_date AND e.event_type = 'check_out' AND e.occurred_at = r.last_out_at
      ) THEN 1 ELSE 0 END) AS unmatched_boundaries
      FROM attendance_records r WHERE org_id = $1 AND user_id = $2
      AND work_date BETWEEN $3::date AND $4::date LIMIT 10001`, params)
    const events = await client.query(`SELECT work_date::text, timezone, occurred_at, event_type
      FROM attendance_events WHERE org_id = $1 AND user_id = $2
      AND work_date BETWEEN $3::date AND $4::date LIMIT 10001`, params)
    if (records.rows.length > 10000 || events.rows.length > 10000) throw new Error('ATTENDANCE_HISTORY_WINDOW_TOO_LARGE')
    return summarizeHistory(records.rows, events.rows)
  } finally {
    await client.query('ROLLBACK')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client
  try {
    const scope = historyScope(process.env)
    if (!process.env.DATABASE_URL) throw new Error('ATTENDANCE_HISTORY_DATABASE_REQUIRED')
    const pg = createRequire(new URL('../../packages/core-backend/package.json', import.meta.url))('pg')
    client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 })
    await client.connect()
    console.log(JSON.stringify(await reconcileHistory(client, scope)))
  } catch (error) {
    const code = ['ATTENDANCE_HISTORY_SCOPE_INVALID', 'ATTENDANCE_HISTORY_DATABASE_REQUIRED', 'ATTENDANCE_HISTORY_WINDOW_TOO_LARGE'].includes(error?.message)
      ? error.message : 'ATTENDANCE_HISTORY_READ_FAILED'
    console.error(JSON.stringify({ code }))
    process.exitCode = 1
  } finally {
    if (client) {
      try { await client.end() } catch {
        console.error(JSON.stringify({ code: 'ATTENDANCE_HISTORY_CLOSE_FAILED' }))
        process.exitCode = 1
      }
    }
  }
}
