'use strict'

const { createAttendanceTimezonePolicyStore } = require('./attendance-timezone-policy-store.cjs')

// Called only by the authorized default PUT, while the runtime holds the org
// policy and member locks. This creates a missing source; it never repairs or
// reinterprets a historical parent from the proposed rule.
async function prepareAttendanceTimezoneDefaultRecovery(trx, {
  orgId, now, timezone, readFrozenContext, readPublishedCandidates,
  readCurrentSemantics, fingerprint, HttpError,
}) {
  function fail(code, status = 409) { throw new HttpError(status,code,code) }
  const query = async (sql,values) => ({rows:await trx.query(sql,values)})
  const store = createAttendanceTimezonePolicyStore({
    query,transaction:work => work(query),authorizeManage:async () => false,
  })
  const policy = await store.readPolicy({orgId})
  if (policy.enabled !== false) fail('ATTENDANCE_TIMEZONE_DEFAULT_MISSING',503)
  if (typeof timezone !== 'string' || !timezone) fail('ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED',422)

  // OFF still protects approved trip whole-shift boundaries on source writes.
  // Without the old default, their before projection cannot be proven.
  const trips = await trx.query(`SELECT EXISTS(SELECT 1 FROM attendance_business_trip_arrangements
    WHERE org_id=$1 AND effective_end_at>$2 AND start_at<effective_end_at) AS present`,[orgId,now])
  if (trips.length !== 1 || typeof trips[0].present !== 'boolean') fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
  if (trips[0].present) fail('ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS')

  const open = await trx.query(`SELECT id,user_id,work_date::text,timezone FROM attendance_records
    WHERE org_id=$1 AND visibility_state='active' AND first_in_at IS NOT NULL AND last_out_at IS NULL`,[orgId])
  for (const record of open) {
    const frozen = await readFrozenContext(trx,{orgId,userId:String(record.user_id),workDate:record.work_date})
    // A pre-companion record has no frozen reading for the new default to change.
    // Its later writes follow the companion store's same-zone, default-only rule.
    if (!frozen) continue
    const {frame} = frozen
    if (frozen.recordId !== record.id || frame.orgId !== orgId || frame.userId !== String(record.user_id)
      || frame.workDate !== record.work_date || frame.timezone !== record.timezone) {
      fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
    }
  }

  // A missing default provides no trustworthy old wall zone. UTC -2..+1
  // conservatively covers possibly started overnight published dates. Only a
  // frozen reading is protected: a nearby date with a freeze must match its own
  // slot. A date without one may still hold records written by paths that skip
  // the strict default (old pending approvals, import); those stay unfrozen and
  // follow the companion store's same-zone rule, so a different new zone makes
  // them refuse later writes rather than be reinterpreted.
  const day = now.toISOString().slice(0,10)
  const groups = await trx.query(`SELECT EXISTS(SELECT 1 FROM attendance_calculation_group_memberships
    WHERE org_id=$1 AND effective_from <= $2::date+1
      AND (effective_to IS NULL OR effective_to >= $2::date-2)) AS present`,[orgId,day])
  if (groups.length !== 1 || typeof groups[0].present !== 'boolean') fail('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',503)
  if (groups[0].present) fail('ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS')
  const nearby = await trx.query(`SELECT user_id FROM attendance_shift_assignments WHERE org_id=$1 AND is_active=true
    AND COALESCE(publish_status,'published')='published'
    AND start_date <= $2::date+1 AND (end_date IS NULL OR end_date >= $2::date-2)
    UNION SELECT a.user_id FROM attendance_rotation_assignments a
    JOIN attendance_rotation_rules r ON r.id=a.rotation_rule_id AND r.org_id=a.org_id AND r.is_active=true
    WHERE a.org_id=$1 AND a.is_active=true AND COALESCE(a.publish_status,'published')='published'
    AND a.start_date <= $2::date+1 AND (a.end_date IS NULL OR a.end_date >= $2::date-2)
    ORDER BY user_id`,[orgId,day])
  const workDates = [-2,-1,0,1].map(offset => new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10))
  const proofs = []
  for (const {user_id:userId} of nearby) {
    const candidates = await readPublishedCandidates(trx,{orgId,userId,workDates,strictSources:true})
    if (!candidates.length) fail('ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS')
    for (const candidate of candidates) {
      const frozen = await readFrozenContext(trx,{orgId,userId,workDate:candidate.workDate})
      if (!frozen) continue
      const frame = frozen.frame
      if (!frame || candidate.orgId !== orgId || candidate.userId !== userId
        || frame.orgId !== orgId || frame.userId !== userId || frame.workDate !== candidate.workDate
        || frame.identity.assignmentId !== candidate.assignmentId || frame.identity.shiftId !== candidate.shiftId
        || frame.identity.source !== candidate.source) {
        fail('ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS')
      }
      const semantic = {...frame.identity}
      delete semantic.timezoneContext
      proofs.push({userId,workDate:candidate.workDate,assignmentId:candidate.assignmentId,semantic})
    }
  }

  return async () => {
    const current = await store.readPolicy({orgId})
    if (current.enabled !== false || current.version !== policy.version) fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED')
    const created = await store.readDefault({orgId})
    if (created.timezone !== timezone) fail('ATTENDANCE_TIMEZONE_CONTEXT_CHANGED')
    for (const proof of proofs) {
      const current = await readCurrentSemantics(trx,{orgId,userId:proof.userId,workDate:proof.workDate,now})
      const matches = current.filter(value => value.assignmentId === proof.assignmentId)
      if (matches.length !== 1 || fingerprint(matches[0]) !== fingerprint(proof.semantic)) {
        fail('ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT')
      }
    }
  }
}

module.exports = { prepareAttendanceTimezoneDefaultRecovery }
