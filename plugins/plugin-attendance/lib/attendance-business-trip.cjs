'use strict'

// Business-trip facts are separate from attendance/leave/overtime entitlements.
// All writers are invoked inside the canonical request transaction, after the
// org-policy -> membership timeline -> published schedule prefix has been taken.

let testInstant = null
function getBusinessTripServerInstant() {
  return new Date(process.env.NODE_ENV === 'test' && testInstant !== null ? testInstant : Date.now())
}
function setBusinessTripInstantForTests(value) {
  if (process.env.NODE_ENV !== 'test') throw new Error('ATTENDANCE_TRIP_TEST_CLOCK_FORBIDDEN')
  if (value === null) { testInstant = null; return }
  const instant = new Date(value).getTime()
  if (!Number.isFinite(instant)) throw new Error('ATTENDANCE_TRIP_TEST_CLOCK_INVALID')
  testInstant = instant
}

function createBusinessTripService({ HttpError, readWindows, readFrozenWindows }) {
  function fail(code, status = 422) { throw new HttpError(status, 'ATTENDANCE_TRIP_' + code, 'ATTENDANCE_TRIP_' + code) }
  function iso(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('EXPLICIT_INSTANT_REQUIRED')
    const day = new Date(value.slice(0,10) + 'T00:00:00.000Z')
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== value.slice(0,10)
      || Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) fail('INVALID_INTERVAL')
    const result = new Date(value)
    if (!Number.isFinite(result.getTime())) fail('INVALID_INTERVAL')
    return result
  }
  function parse(input, actorId) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT')
    if (Object.keys(input).some(key => !['userId', 'destinationTimezone', 'startAt', 'endAt', 'reason', 'approvalFlowId', 'operationId'].includes(key))) fail('INVALID_INPUT')
    const userId = input.userId === undefined ? actorId : input.userId
    if (typeof userId !== 'string' || !userId || userId !== userId.trim()) fail('INVALID_SUBJECT')
    const timezone = input.destinationTimezone
    if (typeof timezone !== 'string' || timezone !== timezone.trim() || !timezone || /^[+-]/.test(timezone)) fail('INVALID_ZONE')
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0)) } catch (_) { fail('INVALID_ZONE') }
    const startAt = iso(input.startAt), endAt = iso(input.endAt)
    if (endAt <= startAt) fail('INVALID_INTERVAL')
    if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 2000)) fail('INVALID_INPUT')
    for (const key of ['approvalFlowId', 'operationId']) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input[key]))) fail('INVALID_REFERENCE')
    }
    return { userId, destinationTimezone: timezone, startAt: startAt.toISOString(), endAt: endAt.toISOString(),
      reason: input.reason?.trim() || null, approvalFlowId: input.approvalFlowId || null }
  }
  async function member(trx, orgId, userId) {
    const rows = await trx.query('SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id=u.id '
      + 'WHERE u.id=$1 AND uo.org_id=$2 AND u.is_active=true AND uo.is_active=true FOR SHARE OF u,uo', [userId, orgId])
    if (rows.length !== 1) fail('MEMBER_REQUIRED', 403)
  }
  async function detail(trx, orgId, requestId) {
    const rows = await trx.query(`SELECT d.*, a.effective_end_at, a.version, a.published_at, a.cancelled_at
      FROM attendance_business_trip_requests d LEFT JOIN attendance_business_trip_arrangements a
      ON a.request_id=d.request_id AND a.org_id=d.org_id AND a.user_id=d.user_id
      WHERE d.org_id=$1 AND d.request_id=$2`, [orgId, requestId])
    if (rows.length !== 1) fail('NOT_FOUND', 404)
    return rows[0]
  }
  function map(row) {
    return { requestId: row.request_id, orgId: row.org_id, userId: row.user_id,
      destinationTimezone: row.destination_timezone, startAt: new Date(row.start_at).toISOString(), endAt: new Date(row.end_at).toISOString(),
      arrangement: row.published_at ? { effectiveEndAt: new Date(row.effective_end_at).toISOString(), version: row.version,
        publishedAt: new Date(row.published_at).toISOString(), cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null } : null }
  }
  async function windows(trx, row, now = null, excludeCurrentTrip = false, policyProjection) {
    if (typeof readWindows !== 'function') fail('BOUNDARY_READER_UNAVAILABLE', 503)
    const result = await readWindows(trx, { orgId: row.org_id, userId: row.user_id,
      from: new Date(row.start_at), to: new Date(row.end_at), timezone: row.destination_timezone,
      ...(excludeCurrentTrip ? {excludeTripRequestId:row.request_id} : {}),
      ...(policyProjection === undefined ? {} : {policyProjection}) })
    if (!Array.isArray(result)) fail('BOUNDARY_READER_UNAVAILABLE', 503)
    // The destination scan does not select the counterfactual base at now. Ask
    // explicitly for that boundary when preserving an already started shift.
    if (now && new Date(row.start_at) <= now && now < new Date(row.end_at)) {
      const current = await readWindows(trx,{orgId:row.org_id,userId:row.user_id,
        from:now,to:new Date(now.getTime()+1),timezone:row.destination_timezone,
        ...(excludeCurrentTrip ? {excludeTripRequestId:row.request_id} : {}),
        ...(policyProjection === undefined ? {} : {policyProjection})})
      if (!Array.isArray(current)) fail('BOUNDARY_READER_UNAVAILABLE',503)
      result.push(...current)
    }
    for (const window of result) {
      if (!(window.startAt instanceof Date) || !(window.endAt instanceof Date)
        || !Number.isFinite(window.startAt.getTime()) || !Number.isFinite(window.endAt.getTime()) || window.endAt <= window.startAt) fail('INVALID_SHIFT_WINDOW')
    }
    return result
  }
  function assertSingleWorkDateContext(items,start,end,now = null) {
    const relevantDates = new Set(items.filter(item => !now || item.endAt > now).map(item => item.workDate))
    const destinationDates = new Map()
    for (const item of items) {
      if (item.contextSide === 'destination' && relevantDates.has(item.workDate) && start <= item.startAt && item.endAt <= end) {
        const basis = item.projectionBasis
        if (!basis || !Number.isInteger(basis.policyVersion) || basis.policyVersion < 0
          || basis.calculationGroupMembership === undefined || !basis.rule || typeof basis.rule !== 'object'
          || !basis.calculationDefinition || typeof basis.calculationDefinition !== 'object'
          || Array.isArray(basis.calculationDefinition)) fail('PROJECTION_BASIS_UNAVAILABLE',503)
        const identity = JSON.stringify([item.shiftId,item.assignmentId,item.source,item.timezone,
          item.startAt.toISOString(),item.endAt.toISOString(),basis])
        if (destinationDates.has(item.workDate) && destinationDates.get(item.workDate) !== identity) fail('WORK_DATE_CONTEXT_CONFLICT',409)
        destinationDates.set(item.workDate,identity)
      }
    }
    for (const item of items) {
      if (item.contextSide === 'outside' && relevantDates.has(item.workDate) && (item.endAt <= start || end <= item.startAt)
        && destinationDates.has(item.workDate)) fail('WORK_DATE_CONTEXT_CONFLICT',409)
    }
  }
  async function frozenWindows(trx,row,from,to) {
    if (typeof readFrozenWindows !== 'function') fail('FROZEN_READER_UNAVAILABLE',503)
    const items = await readFrozenWindows(trx,{orgId:row.org_id,userId:row.user_id,from,to})
    if (!Array.isArray(items)) fail('FROZEN_READER_UNAVAILABLE',503)
    for (const item of items) {
      if (!(item.startAt instanceof Date) || !(item.endAt instanceof Date)
        || !Number.isFinite(item.startAt.getTime()) || !Number.isFinite(item.endAt.getTime())
        || item.endAt <= item.startAt || typeof item.workDate !== 'string') fail('INVALID_FROZEN_WINDOW',409)
    }
    return items
  }
  async function assertWholeShifts(trx, row, now) {
    const start = new Date(row.start_at), end = new Date(row.end_at)
    if (start < now) fail('RETROACTIVE_PUBLICATION', 409)
    const items = await windows(trx,row)
    assertSingleWorkDateContext(items,start,end)
    for (const window of items) {
      if ((window.startAt < start && start < window.endAt) || (window.startAt < end && end < window.endAt)) fail('PARTIAL_SHIFT', 409)
      if (window.startAt <= now && now < window.endAt && start < window.endAt && end > window.startAt) fail('SHIFT_ALREADY_STARTED', 409)
    }
    const frozen = await frozenWindows(trx,row,start,end)
    if (frozen.some(item => item.startAt < end && start < item.endAt)) fail('FROZEN_CONTEXT_CONFLICT',409)
    // Any prior first-in owns that work date's source identity, even after out.
    // An expired missed checkout on another date is not an ongoing shift.
    const existing = await trx.query(`SELECT id FROM attendance_records WHERE org_id=$1 AND user_id=$2
      AND visibility_state='active' AND first_in_at IS NOT NULL AND work_date >= $3::date AND work_date <= $4::date LIMIT 1`,
    [row.org_id,row.user_id,dateKey(row,start),dateKey(row,new Date(end.getTime()-1))])
    if (existing.length) fail('WORK_DATE_CONTEXT_CONFLICT',409)
  }
  async function publish(trx, request, actorId, now = new Date()) {
    const row = await detail(trx, request.org_id, request.id)
    if (row.user_id !== request.user_id || row.approval_instance_id !== request.approval_instance_id) fail('REQUEST_BINDING', 409)
    await member(trx, request.org_id, actorId)
    await member(trx, request.org_id, request.user_id)
    await assertWholeShifts(trx, row, now)
    try {
      await trx.query(`INSERT INTO attendance_business_trip_arrangements
        (request_id,org_id,user_id,destination_timezone,start_at,end_at,effective_end_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6)`, [row.request_id,row.org_id,row.user_id,row.destination_timezone,row.start_at,row.end_at])
    } catch (error) {
      if (error?.code === '23P01' || error?.code === '23505') fail('OVERLAP', 409)
      throw error
    }
  }
  async function cancel(trx, request, now = new Date()) {
    const row = await detail(trx, request.org_id, request.id)
    if (!row.published_at || row.cancelled_at) fail('ARRANGEMENT_STATE', 409)
    const start = new Date(row.start_at), end = new Date(row.effective_end_at)
    // AFTER the arrangement has ended there is nothing left to truncate. Do not
    // stamp cancelled_at over a finished trip.
    if (now >= end) fail('EVENT_ENDED', 409)
    let cutoff = new Date(Math.max(start.getTime(),Math.min(now.getTime(),end.getTime())))
    if (start <= now && now < end) {
      // Project the post-cancellation base authority without mutating the source
      // row. Preserve every started work date's identity, even with zero punches.
      const items = await windows(trx,row,now,true)
      items.push(...await frozenWindows(trx,row,start,end))
      const startedDates = new Set(items.filter(item => item.startAt <= now
        && item.startAt < end && start < item.endAt).map(item => item.workDate))
      for (const item of items) {
        if (startedDates.has(item.workDate) && item.endAt > cutoff) cutoff = item.endAt
      }
      if (cutoff > end) fail('CANCELLATION_BOUNDARY_CONFLICT',409)
      for (const item of items) {
        if (item.startAt < cutoff && cutoff < item.endAt) fail('PARTIAL_SHIFT',409)
      }
    }
    const changed = await trx.query(`UPDATE attendance_business_trip_arrangements
      SET effective_end_at=$3, cancelled_at=$4, version=version+1
      WHERE request_id=$1 AND org_id=$2 AND cancelled_at IS NULL RETURNING request_id`, [request.id,request.org_id,cutoff,now])
    if (changed.length !== 1) fail('ARRANGEMENT_STATE', 409)
  }
  // The writer captures this before any parent/member/source row locks, under
  // the exclusive org prefix. The returned verifier runs after its DML in the
  // same transaction, so a conflicting edit rolls back with the source change.
  async function prepareSourceChange(trx, { orgId, userIds = null, acquireLocks, now = new Date(), policyProjection }) {
    const rows = await trx.query(`SELECT * FROM attendance_business_trip_arrangements
      WHERE org_id=$1 AND effective_end_at > $2 AND start_at < effective_end_at
      AND ($3::text[] IS NULL OR user_id::text=ANY($3::text[])) ORDER BY user_id,request_id`,
    [orgId,now,userIds])
    if (!rows.length) return async () => {}
    if (typeof acquireLocks !== 'function') fail('BOUNDARY_LOCK_UNAVAILABLE',503)
    for (const userId of [...new Set(rows.map(row => row.user_id))].sort()) await acquireLocks(trx,{orgId,userId,mode:'exclusive'})
    function startedSignatures(items,row) {
      return [...new Set(items.filter(item => item.startAt <= now && now < item.endAt
        && item.startAt < new Date(row.effective_end_at) && new Date(row.start_at) < item.endAt)
        .map(item => JSON.stringify([item.workDate,item.shiftId,item.assignmentId,item.source,
          item.timezone,item.contextFingerprint ?? null,item.startAt.toISOString(),item.endAt.toISOString()])))].sort()
    }
    const before = []
    for (const row of rows) before.push(startedSignatures(await windows(trx,{...row,end_at:row.effective_end_at},now),row))
    return async () => {
      for (let i=0;i<rows.length;i++) {
        const row = rows[i], start = new Date(row.start_at), end = new Date(row.effective_end_at)
        const after = await windows(trx,{...row,end_at:row.effective_end_at},now,false,policyProjection)
        assertSingleWorkDateContext(after,start,end,now)
        if (JSON.stringify(before[i]) !== JSON.stringify(startedSignatures(after,row))) fail('STARTED_SHIFT_CHANGED',409)
        for (const item of after) {
          if ((start >= now && item.startAt < start && start < item.endAt) || (item.startAt < end && end < item.endAt)) fail('PARTIAL_SHIFT',409)
        }
      }
    }
  }
  function dateKey(row, instant) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone:row.destination_timezone,
      year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(instant).map(part => [part.type,part.value]))
    return parts.year+'-'+parts.month+'-'+parts.day
  }
  // Destination dates that overlap [cutoff, effective end). An ended trip has an
  // empty span. Hour steps keep a DST day from being skipped. The date key is the
  // same formatter assertWholeShifts already uses.
  function settlementWorkDates(row, now = new Date()) {
    const start = new Date(row.start_at)
    const end = new Date(row.effective_end_at ?? row.end_at)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) fail('INVALID_INTERVAL')
    if (typeof row.destination_timezone !== 'string' || !row.destination_timezone) fail('INVALID_ZONE')
    if (now >= end) return []
    const cutoff = Math.max(start.getTime(), Math.min(now.getTime(), end.getTime()))
    const keys = []
    let cursor = cutoff
    let steps = 0
    while (cursor < end.getTime()) {
      const key = dateKey(row, new Date(cursor))
      if (keys[keys.length - 1] !== key) keys.push(key)
      cursor += 60 * 60 * 1000
      steps += 1
      if (steps > 40000) fail('SETTLEMENT_SPAN_TOO_LONG', 409)
    }
    return keys
  }
  return { parse, member, detail, map, assertWholeShifts, publish, cancel, prepareSourceChange, settlementWorkDates, fail }
}

async function readApprovedTrips({ query, orgId, userId, occurredAt }) {
  const result = await query(`SELECT request_id,org_id,user_id,destination_timezone,start_at,effective_end_at,version
    FROM attendance_business_trip_arrangements WHERE org_id=$1 AND user_id=$2
    AND start_at <= $3 AND $3 < effective_end_at`, [orgId,userId,occurredAt])
  if (!result || !Array.isArray(result.rows)) throw new Error('ATTENDANCE_TRIP_SOURCE_UNAVAILABLE')
  return result.rows.map(row => ({ orgId: row.org_id, userId: row.user_id, referenceId: row.request_id,
    timezone: row.destination_timezone, version: row.version, approvalStatus: 'approved', lifecycleStatus: 'ACTIVE',
    startAt: row.start_at, endAt: row.effective_end_at }))
}

module.exports = { createBusinessTripService, readApprovedTrips, getBusinessTripServerInstant, setBusinessTripInstantForTests }
