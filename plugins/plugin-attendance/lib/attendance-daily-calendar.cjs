'use strict'

function localDateKey(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function addCalendarDays(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function previousCalendarDates(now, timeZone, days) {
  const today = localDateKey(now, timeZone)
  return Array.from({ length: days }, (_, index) => addCalendarDays(today, -index - 1))
}

function nextDailyRun({ now, timeZone, runAt, strictTime, warn }) {
  strictTime.validateIanaTimezone(timeZone)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(runAt)) throw new Error('DAILY_CALENDAR_CLOCK_INVALID')
  const today = localDateKey(now, timeZone)
  // A skipped calendar date or DST occurrence never becomes a normalized write.
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = addCalendarDays(today, offset)
    const result = strictTime.resolveLocalWallTime(date, runAt, 0, timeZone)
    if (result.posture === 'gap' || result.posture === 'fold') {
      warn(result.posture === 'gap' ? 'DAILY_CALENDAR_GAP_SKIPPED' : 'DAILY_CALENDAR_FOLD_SKIPPED')
      continue
    }
    if (result.posture !== 'unique' || !Number.isFinite(result.epochMs)) {
      throw new Error('DAILY_CALENDAR_WALL_INVALID')
    }
    if (result.epochMs > now) return result.epochMs
  }
  throw new Error('DAILY_CALENDAR_NO_UNIQUE_OCCURRENCE')
}

function createDailyCalendarScheduler({
  loadPlans, refreshPlan, runPlan, strictTime, warn,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let generation = 0
  let running = false
  let listRetry = null
  const plans = new Map()
  function stop() {
    generation += 1
    running = false
    if (listRetry !== null) clearTimer(listRetry)
    listRetry = null
    for (const state of plans.values()) {
      if (state.timer !== null) clearTimer(state.timer)
    }
    plans.clear()
  }
  async function replace(plan, token) {
    if (!running || token !== generation) return
    const previous = plans.get(plan.orgId)
    if (previous && previous.timer !== null) clearTimer(previous.timer)
    const state = { timer: null }
    plans.set(plan.orgId, state)
    await arm(plan, state, token)
  }
  async function arm(plan, state, token) {
    const isCurrent = () => running && token === generation && plans.get(plan.orgId) === state
    if (!isCurrent()) return
    function later(callback, delay) {
      state.timer = setTimer(async () => {
        if (!isCurrent()) return
        state.timer = null
        await callback()
      }, delay)
    }
    try {
      const fresh = await refreshPlan(plan)
      if (!isCurrent()) return
      const timestamp = nextDailyRun({ now: now(), ...fresh, strictTime, warn })
      later(async () => {
        if (!isCurrent()) return
        try {
          const current = await refreshPlan(fresh)
          if (!isCurrent()) return
          // A committed timezone change must not run an obsolete occurrence.
          if (current.timeZone === fresh.timeZone && current.runAt === fresh.runAt) {
            await runPlan(current, isCurrent)
          }
        } catch {
          warn('DAILY_CALENDAR_RUN_FAILED')
        } finally {
          if (isCurrent()) await arm(fresh, state, token)
        }
      }, Math.max(0, timestamp - now()))
    } catch {
      if (!isCurrent()) return
      warn('DAILY_CALENDAR_PLAN_FAILED')
      later(() => arm(plan, state, token), 60 * 1000)
    }
  }
  async function load(token) {
    try {
      const loaded = await loadPlans()
      if (!running || token !== generation) return
      // A committed org rearm may finish while the startup/list retry is pending.
      // Do not replace that plan, or any other plan already owned by this run.
      await Promise.all(loaded.map(plan => {
        if (!plans.has(plan.orgId)) return replace(plan, token)
      }))
    } catch {
      if (!running || token !== generation) return
      warn('DAILY_CALENDAR_ORG_LIST_FAILED')
      listRetry = setTimer(() => {
        if (!running || token !== generation) return
        listRetry = null
        return load(token)
      }, 60 * 1000)
    }
  }
  async function start() {
    stop()
    running = true
    await load(generation)
  }
  function rearm(plan) {
    return replace(plan, generation)
  }
  return { start, stop, rearm }
}

async function loadDailyCalendarDefaultRule(db, orgId, strictTime, mapRuleRow) {
  const rows = await db.query(
    'SELECT * FROM attendance_rules WHERE org_id = $1 AND is_default = true', [orgId],
  )
  if (rows.length !== 1) throw new Error('DAILY_CALENDAR_DEFAULT_REQUIRED')
  strictTime.validateIanaTimezone(rows[0].timezone)
  return mapRuleRow(rows[0])
}

async function loadDailyCalendarOrgPlans(db, warn) {
  const rows = await db.query('SELECT DISTINCT org_id FROM attendance_rules')
  return rows.flatMap(row => {
    if (typeof row.org_id !== 'string' || !row.org_id || row.org_id !== row.org_id.trim()) {
      warn('DAILY_CALENDAR_ORG_INVALID')
      return []
    }
    return [{ orgId: row.org_id }]
  })
}

module.exports = {
  nextDailyRun, previousCalendarDates, createDailyCalendarScheduler,
  loadDailyCalendarDefaultRule, loadDailyCalendarOrgPlans,
}
