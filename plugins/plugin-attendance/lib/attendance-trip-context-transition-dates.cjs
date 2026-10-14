'use strict'

const DAY = 86400000

// Representatives of actual source-definition cells, not a calendar/day scan.
// Every published rotation assignment emits a non-null atomic candidate daily.
// Two concurrent assignments therefore already witness distinct contexts at the
// first date of their overlap; there is no legitimate row-order single winner.
// For one rotation, a complete lcm(sequence length, 7) covers every phase/weekday.
// The caller still resolves all candidates and strict UTC windows for these dates.
async function readTripContextTransitionDates(trx, { orgId, userId, from, to, timezone }) {
  function fail() {
    const error = new Error('ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE')
    error.code = 'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE'
    error.status = 503
    throw error
  }
  function ordinal(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail()
    const instant = new Date(value + 'T00:00:00.000Z')
    if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0,10) !== value) fail()
    return instant.getTime() / DAY
  }
  function key(day) { return new Date(day * DAY).toISOString().slice(0,10) }
  if (typeof orgId !== 'string' || !orgId || typeof userId !== 'string' || !userId
    || !(from instanceof Date) || !(to instanceof Date)
    || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) fail()
  try { new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format(from) } catch (_) { fail() }
  if (typeof timezone !== 'string' || !timezone || /^[+-]/.test(timezone)) fail()
  // Same UTC envelope used by the authoritative boundary reader: covers IANA
  // date-line offsets, overnight candidates and the governed attribution tail.
  const low = ordinal(from.toISOString().slice(0,10)) - 3
  const high = ordinal(to.toISOString().slice(0,10)) + 1
  const params = [orgId,userId,key(high),key(low)]
  async function rows(sql, values) {
    try {
      const result = await trx.query(sql,values)
      if (!Array.isArray(result)) fail()
      return result
    } catch (_) { fail() }
  }
  const direct = await rows(`SELECT a.id,a.org_id,a.user_id,a.start_date::text,a.end_date::text
    FROM attendance_shift_assignments a JOIN attendance_shifts s ON s.id=a.shift_id AND s.org_id=a.org_id
    WHERE a.org_id=$1 AND a.user_id=$2 AND a.is_active=true
      AND COALESCE(a.publish_status,'published')='published'
      AND a.start_date <= $3::date AND (a.end_date IS NULL OR a.end_date >= $4::date)`,params)
  const rotations = await rows(`SELECT a.id,a.org_id,a.user_id,a.start_date::text,a.end_date::text,r.shift_sequence
    FROM attendance_rotation_assignments a JOIN attendance_rotation_rules r ON r.id=a.rotation_rule_id AND r.org_id=a.org_id
    WHERE a.org_id=$1 AND a.user_id=$2 AND a.is_active=true AND r.is_active=true
      AND COALESCE(a.publish_status,'published')='published'
      AND a.start_date <= $3::date AND (a.end_date IS NULL OR a.end_date >= $4::date)`,params)
  const memberships = await rows(`SELECT id,org_id,user_id,effective_from::text AS start_date,effective_to::text AS end_date
    FROM attendance_calculation_group_memberships WHERE org_id=$1 AND user_id=$2
      AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $4::date)`,params)
  const holidays = await rows(`SELECT org_id,holiday_date::text FROM attendance_holidays
    WHERE org_id=$1 AND holiday_date BETWEEN $2::date AND $3::date`,[orgId,key(low),key(high)])
  const settings = await rows('SELECT value FROM system_configs WHERE key=$1',['attendance.settings'])
  if (settings.length > 1) fail()
  const cuts = new Set([low,high+1])
  function cut(day) { if (day >= low && day <= high+1) cuts.add(day) }
  function span(row) {
    if (row.org_id !== orgId || row.user_id !== userId) fail()
    const start = ordinal(row.start_date), end = row.end_date === null ? high : ordinal(row.end_date)
    if (end < start || end < low || start > high) fail()
    cut(start);cut(end+1)
    return {start,end}
  }
  for (const row of direct) span(row)
  for (const row of memberships) span(row) // membership end is inclusive DATE.
  const rotationSpans = rotations.map(row => {
    const bounds = span(row), sequence = row.shift_sequence
    if (!Array.isArray(sequence) || !sequence.length || sequence.some(ref => typeof ref !== 'string' || !ref.trim())) fail()
    return {...bounds,length:sequence.length}
  })
  for (const row of holidays) {
    if (row.org_id !== orgId) fail()
    const day = ordinal(row.holiday_date);cut(day);cut(day+1)
  }
  let config
  try { config = settings.length ? (typeof settings[0].value === 'string' ? JSON.parse(settings[0].value) : settings[0].value) : null } catch (_) { fail() }
  const overrides = config?.calendarPolicy?.overrides ?? []
  if (!Array.isArray(overrides)) fail()
  for (const override of overrides) {
    if (!override || typeof override !== 'object') continue
    for (const field of ['date','from','to']) {
      if (typeof override[field] !== 'string' || !override[field].trim()) continue
      const day = ordinal(override[field].trim())
      cut(day)
      if (field !== 'from') cut(day+1)
    }
  }
  const boundaries = [...cuts].sort((a,b)=>a-b), result = new Set()
  function gcd(a,b) { while (b) { const next=a%b;a=b;b=next } return a }
  for (let index=0;index<boundaries.length-1;index++) {
    const first=boundaries[index], last=boundaries[index+1]-1
    const active=rotationSpans.filter(row=>row.start<=first && first<=row.end)
    // Multiple rotations are all returned by the real reader. A single witness
    // proves their atomic assignment identities conflict; no phase is discarded
    // from a potentially valid single-rotation context.
    const period=active.length===1 ? active[0].length/gcd(active[0].length,7)*7 : 7
    const count=Math.min(period,last-first+1)
    for (let offset=0;offset<count;offset++) result.add(key(first+offset))
    result.add(key(last))
  }
  return [...result].sort()
}

module.exports = { readTripContextTransitionDates }
