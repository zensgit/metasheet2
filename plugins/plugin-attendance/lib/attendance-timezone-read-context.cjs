'use strict'

const { AttendanceTimezonePolicyError } = require('./attendance-timezone-policy-store.cjs')
const { canonicalContextFingerprint } = require('./attendance-timezone-runtime.cjs')

const DAY = 86400000
function dateKey(value) {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return null
  const parsed = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null
}
function localDate(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant)
  const field = type => parts.find(part => part.type === type).value
  return field('year').padStart(4, '0') + '-' + field('month') + '-' + field('day')
}
function contextDto(context) {
  return {
    effectiveTimezone: context.timezone, timezoneSource: context.source,
    mode: context.mode, policyVersion: context.policyVersion,
    referenceId: context.referenceId, version: context.version,
  }
}

// Server-only readers. Every query uses the caller's transaction; neither
// current policy nor a trip is consulted to explain a persisted record.
function createAttendanceTimezoneReadContext({ runtime, acquireLocks, validateIanaTimezone, HttpError, settingsKey, normalizeSettings }) {
  function fail(code, status = 503) { throw new HttpError(status, code, code) }
  function port() {
    const value = runtime()
    if (!value || typeof value.loaderFor !== 'function') fail('ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE')
    return value
  }
  async function protect(work) {
    try { return await work() } catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof AttendanceTimezonePolicyError) fail(error.code, error.status)
      fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE')
    }
  }
  async function readCalendarSettings(trx) {
    return protect(async () => {
      if (typeof settingsKey !== 'string' || typeof normalizeSettings !== 'function') fail('ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE')
      const rows = await trx.query('SELECT value FROM system_configs WHERE key=$1', [settingsKey])
      if (rows.length > 1) fail('ATTENDANCE_TIMEZONE_SETTINGS_SOURCE_INVALID')
      let raw = rows.length ? rows[0].value : {}
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw) } catch { fail('ATTENDANCE_TIMEZONE_SETTINGS_SOURCE_INVALID') }
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('ATTENDANCE_TIMEZONE_SETTINGS_SOURCE_INVALID')
      return normalizeSettings(raw)
    })
  }
  async function assertMembers(trx, { orgId, actorId, userId }) {
    const ids = [...new Set([actorId, userId])]
    if (!orgId || ids.some(id => typeof id !== 'string' || !id)) fail('ATTENDANCE_TIMEZONE_INVALID_REFERENCE', 422)
    const rows = await trx.query(`SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id=u.id
      WHERE uo.org_id=$1 AND u.id=ANY($2::text[]) AND u.is_active=true AND uo.is_active=true`, [orgId, ids])
    if (new Set(rows.map(row => row.id)).size !== ids.length) fail('ATTENDANCE_TIMEZONE_MEMBER_REQUIRED', 403)
  }
  async function readCurrentTimezoneContext(trx, { orgId, userId, actorId = userId, occurredAt }) {
    return protect(async () => {
      if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) fail('ATTENDANCE_TIMEZONE_INVALID_INSTANT', 422)
      await acquireLocks(trx, { orgId, userId, mode: 'shared' })
      await assertMembers(trx, { orgId, userId, actorId })
      const current = port()
      const load = current.loaderFor(trx)
      const midnight = new Date(occurredAt.toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
      const matches = []
      // DATE membership and instant-based overrides can make more than one
      // local-date fixed point. Never pick the first candidate by row order.
      for (let offset = -2; offset <= 2; offset += 1) {
        const workDate = new Date(midnight + offset * DAY).toISOString().slice(0, 10)
        const context = await load({ orgId, userId, occurredAt, workDate })
        if (localDate(occurredAt, context.timezone) === workDate) matches.push(context)
      }
      if (matches.length !== 1) fail('ATTENDANCE_TIMEZONE_CURRENT_CONTEXT_CONFLICT', 409)
      const selected = matches[0]
      let nextEffectiveBoundary = null
      if (selected.mode === 'multi_timezone') {
        const rows = await trx.query(`SELECT effective_from AS starts_at,effective_to AS ends_at,timezone
          FROM attendance_employee_timezone_overrides WHERE org_id=$1 AND user_id=$2
            AND (effective_to IS NULL OR effective_to>$3)
          UNION ALL SELECT start_at,effective_end_at,destination_timezone
          FROM attendance_business_trip_arrangements WHERE org_id=$1 AND user_id=$2 AND effective_end_at>$3 AND effective_end_at>start_at`,
        [orgId, userId, occurredAt])
        const epochs = []
        const zones = new Set([selected.timezone])
        for (const row of rows) {
          zones.add(validateIanaTimezone(row.timezone))
          for (const value of [row.starts_at, row.ends_at]) {
            if (value === null) continue
            const epoch = new Date(value).getTime()
            if (!Number.isFinite(epoch)) fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE')
            if (epoch > occurredAt.getTime()) epochs.push(epoch)
          }
        }
        const memberships = await trx.query(`SELECT m.effective_from::text AS effective_from,
          m.effective_to::text AS effective_to,g.timezone
          FROM attendance_calculation_group_memberships m
          JOIN attendance_groups g ON g.id=m.group_id AND g.org_id=m.org_id
          WHERE m.org_id=$1 AND m.user_id=$2
            AND (m.effective_to IS NULL OR m.effective_to >= $3::date)`,
        [orgId, userId, selected.targetWorkDate])
        const defaults = await trx.query('SELECT timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true', [orgId])
        if (defaults.length !== 1) fail('ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED', 422)
        zones.add(validateIanaTimezone(defaults[0].timezone))
        for (const row of memberships) if (row.timezone !== null) zones.add(validateIanaTimezone(row.timezone))
        for (const row of memberships) {
          const start = dateKey(row.effective_from)
          const end = row.effective_to === null ? null : dateKey(row.effective_to)
          if (!start || (row.effective_to !== null && !end)) fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE')
          const dates = [start]
          if (end) dates.push(new Date(new Date(end + 'T00:00:00.000Z').getTime() + DAY).toISOString().slice(0, 10))
          for (const date of dates) for (const timezone of zones) {
            if (new Date(date + 'T00:00:00.000Z').getTime() + DAY <= occurredAt.getTime()) continue
            const boundary = current.uniqueWallInstant(date, '00:00', timezone).getTime()
            if (boundary > occurredAt.getTime()) epochs.push(boundary)
          }
        }
        // Earliest governed source boundary is conservative: a lower-priority
        // boundary can cause one extra refresh, never hide an earlier change.
        if (epochs.length) nextEffectiveBoundary = new Date(Math.min(...epochs)).toISOString()
      }
      return {
        resolvedForInstant: occurredAt.toISOString(), ...contextDto(selected),
        currentLocalDate: selected.targetWorkDate, nextEffectiveBoundary,
      }
    })
  }
  async function readCalendarContexts(trx, { orgId, userId, actorId = userId, workDates }) {
    return protect(async () => {
      await acquireLocks(trx, { orgId, userId, mode: 'shared' })
      await assertMembers(trx, { orgId, userId, actorId })
      const dates = [...new Set(workDates)].sort()
      if (dates.some(date => !dateKey(date))) fail('ATTENDANCE_TIMEZONE_INVALID_WORK_DATE', 422)
      // Historical dates are prefetched together and never sent through a
      // mutable target resolver, including legacy rows without a companion.
      const records = dates.length ? await trx.query(`SELECT id,work_date::text AS work_date,timezone,is_workday
        FROM attendance_current_records WHERE org_id=$1 AND user_id=$2
          AND work_date=ANY($3::date[])`, [orgId, userId, dates]) : []
      const stored = await readStoredContexts(trx, { orgId, userId, actorId, records })
      const byDate = new Map(records.map(row => [row.work_date, row]))
      const freshDates = dates.filter(date => !byDate.has(date))
      let targets = new Map()
      if (freshDates.length) {
        const current = port()
        if (typeof current.readTargetTimezoneContexts !== 'function') fail('ATTENDANCE_TIMEZONE_RUNTIME_UNAVAILABLE')
        targets = await current.readTargetTimezoneContexts(trx, { orgId, userId, workDates: freshDates })
        if (!(targets instanceof Map) || targets.size !== freshDates.length) fail('ATTENDANCE_TIMEZONE_TARGET_BATCH_INVALID')
        for (const workDate of freshDates) {
          const target = targets.get(workDate)
          if (!target || target.workDate !== workDate || target.orgId !== orgId || target.userId !== userId) {
            fail('ATTENDANCE_TIMEZONE_TARGET_BATCH_INVALID')
          }
        }
      }
      const result = new Map()
      for (const workDate of dates) {
        const record = byDate.get(workDate)
        if (record) {
          const saved = stored.get(workDate)
          result.set(workDate, {
            target: { timezone: saved.effectiveTimezone, isWorkingDay: record.is_workday === true, frozen: true },
            attendanceTimeContext: saved,
          })
          continue
        }
        const target = targets.get(workDate)
        result.set(workDate, {
          target,
          attendanceTimeContext: {
            targetWorkDate: workDate, effectiveTimezone: target.timezone,
            timezoneSource: target.provenance?.source ?? 'legacy_record',
            mode: target.provenance?.mode ?? null, policyVersion: target.provenance?.policyVersion ?? null,
            contextFingerprint: target.contextFingerprint, frozen: target.frozen,
          },
        })
      }
      return result
    })
  }
  async function readStoredContexts(trx, { orgId, userId, actorId = userId, records }) {
    return protect(async () => {
      await assertMembers(trx, { orgId, userId, actorId })
      const dates = [...new Set(records.map(row => dateKey(row.work_date)))]
      if (dates.some(date => !date)) fail('ATTENDANCE_TIMEZONE_STORED_CONTEXT_INVALID')
      if (!dates.length) return new Map()
      const rows = await trx.query(`SELECT c.*,c.work_date::text AS work_date FROM attendance_timezone_context_companions c
        JOIN attendance_records r ON r.id=c.record_id AND r.org_id=c.org_id
        WHERE c.org_id=$1 AND c.user_id=$2 AND c.work_date=ANY($3::date[])
          AND r.visibility_state='active'`, [orgId, userId, dates])
      const snapshots = new Map()
      const recordIds = new Map()
      for (const row of rows) {
        const date = dateKey(row.work_date)
        const frame = row.frame_snapshot
        if (!frame || !frame.identity || snapshots.has(date)
          || frame.orgId !== orgId || frame.userId !== userId || frame.workDate !== date
          || canonicalContextFingerprint(frame.identity) !== frame.fingerprint
          || frame.fingerprint !== row.context_fingerprint || frame.timezone !== row.timezone
          || canonicalContextFingerprint(row.original_freeze_snapshot) !== row.original_freeze_fingerprint) {
          fail('ATTENDANCE_TIMEZONE_STORED_CONTEXT_INVALID', 409)
        }
        snapshots.set(date, frame)
        recordIds.set(date, row.record_id)
      }
      const result = new Map()
      for (const row of records) {
        const date = dateKey(row.work_date)
        const frame = snapshots.get(date)
        const timezone = validateIanaTimezone(row.timezone)
        if (frame && (frame.timezone !== timezone || typeof row.id !== 'string' || recordIds.get(date) !== row.id)) {
          fail('ATTENDANCE_TIMEZONE_STORED_CONTEXT_INVALID', 409)
        }
        result.set(date, {
          effectiveTimezone: timezone,
          timezoneSource: frame?.timezoneContext?.source ?? 'legacy_record',
          mode: frame?.timezoneContext?.mode ?? null,
          policyVersion: frame?.timezoneContext?.policyVersion ?? null,
          contextFingerprint: frame?.fingerprint ?? null,
          frozen: true, targetWorkDate: date,
        })
      }
      return result
    })
  }
  return { assertMembers, readCurrentTimezoneContext, readCalendarContexts, readStoredContexts, readCalendarSettings }
}

function withTimezoneExportColumns(fields) {
  const required = [
    ['work_date', 'Work date'], ['first_in_at', 'First in (UTC)'], ['last_out_at', 'Last out (UTC)'],
    ['timezone', 'Attendance timezone'], ['timezone_source', 'Timezone source'],
  ]
  const requiredCodes = new Set(required.map(([code]) => code))
  const keys = new Set(fields.map(field => field.exportKey || field.code))
  const result = fields.map(field => {
    const key = field.exportKey || field.code
    if (!requiredCodes.has(key) || (field.code === key && field.formulaEnabled !== true)) return field
    // Keep configured values under a distinct key; reserved identity columns
    // always come from the stored record, never a configured formula.
    let exportKey = 'configured_' + key
    for (let suffix = 2; keys.has(exportKey); suffix += 1) exportKey = 'configured_' + key + '_' + suffix
    keys.add(exportKey)
    return { ...field, exportKey }
  })
  const authoritativeKeys = new Set(result.map(field => field.exportKey || field.code))
  for (const [code, name] of required) if (!authoritativeKeys.has(code)) result.push({ code, exportKey: code, name })
  return result
}

module.exports = { createAttendanceTimezoneReadContext, withTimezoneExportColumns }
