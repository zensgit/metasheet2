import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  attendanceLegacyRepairRecordFingerprintV1,
  inspectAttendanceTimezoneLegacyRepairV1 as inspect,
  previewAttendanceTimezoneLegacyRepairV1 as preview,
  applyAttendanceTimezoneLegacyRepairV1 as apply,
  type AttendanceLegacyRepairEvidenceV1,
} from '../../src/attendance/attendance-timezone-legacy-repair'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('TIMEZONE_LEGACY_REPAIR_REAL_DATABASE_REQUIRED')
const live = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
type Actor = Awaited<ReturnType<typeof live.user>>
const workDate = '2026-01-12'
const at = (hour: string) => workDate + 'T' + hour + ':00.000Z'

describe('controlled legacy timezone repair actual HTTP/PostgreSQL', () => {
  let admin: Actor
  beforeAll(async () => {
    admin = await live.start()
    await live.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1", [admin.userId])
    await live.pool.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin') ON CONFLICT DO NOTHING", [admin.userId])
  }, 180000)
  beforeEach(async () => {
    punchClock.setOnlinePunchInstantForTests(at('08:00'))
    await live.pool.query("UPDATE attendance_rules SET timezone='UTC',work_start_time='09:00',work_end_time='18:00' WHERE org_id=$1 AND is_default=true", [live.orgId])
  })
  afterAll(async () => { await live.stop() }, 60000)
  async function row(recordId: string) {
    const client = await live.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query("SET LOCAL TIME ZONE 'UTC'")
      const result = await client.query('SELECT to_jsonb(r) AS data FROM attendance_records r WHERE id=$1', [recordId])
      await client.query('COMMIT')
      return result.rows[0].data
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }
  async function historical(subject?: Actor) {
    const actor = subject ?? await live.user()
    await live.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1", [actor.userId])
    const recordId = randomUUID()
    await live.pool.query(`INSERT INTO attendance_records
      (id,org_id,user_id,work_date,timezone,first_in_at,status,is_workday,meta,created_at,updated_at)
      VALUES($1,$2,$3,$4,'UTC',$5,'partial',true,$6::jsonb,$5,$5)`,
    [recordId,live.orgId,actor.userId,workDate,at('09:00'),JSON.stringify({ severe_late_count:0,severe_late_minutes:0,absence_late_count:0 })])
    const original = await row(recordId)
    const evidence: AttendanceLegacyRepairEvidenceV1 = {
      schemaVersion:1,kind:'archived_legacy_rule_context',orgId:live.orgId,userId:actor.userId,recordId,workDate,timezone:'UTC',
      expectedRecordFingerprint:attendanceLegacyRepairRecordFingerprintV1(original),
      archive:{reference:'synthetic-original-default-context',capturedAt:at('09:00'),reviewedBy:admin.userId,attestation:'historical_source_reviewed'},
      rule:{id:randomUUID(),orgId:live.orgId,timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',isOvernight:false,
        workingDays:[0,1,2,3,4,5,6],lateGraceMinutes:0,earlyGraceMinutes:0,roundingMinutes:1,
        severeLateThresholdMinutes:30,absenceLateThresholdMinutes:60,flexMode:null,flexRequiredMinutes:null,
        flexArrivalWindowBeforeMinutes:null,flexArrivalWindowAfterMinutes:null,flexCoreStartTime:null,flexCoreEndTime:null},
      calendar:{isWorkingDay:true,holiday:null},
      noWinningAssignment:{reasonCode:'UNSCHEDULED_NO_SHIFT',attestation:'no_winning_assignment_at_original_record_freeze'},
      attribution:{tailMinutes:120,approvedOvertimeWindows:[],attestation:'complete_historical_tail_and_approved_overtime'},
      absoluteWindow:{startAt:at('09:00'),endAt:at('18:00')},attributionWindow:{startAt:at('09:00'),endAt:at('20:00')},
    }
    return {actor,recordId,original,evidence}
  }
  function input(evidence: AttendanceLegacyRepairEvidenceV1, actorId = admin.userId) {
    return {source:JSON.stringify(evidence),actorId,archiveSourceConfirmed:true as const}
  }
  async function repair(evidence: AttendanceLegacyRepairEvidenceV1) {
    const request = input(evidence), plan = await preview(live.pool,request)
    const approved = {...request,approvedSourceSha256:plan.sourceSha256,approvedPlanSha256:plan.planSha256}
    expect((await apply(live.pool,approved)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_APPLIED')
    return approved
  }
  async function punch(actor: Actor, eventType: string, hour: string) {
    punchClock.setOnlinePunchInstantForTests(at(hour))
    return live.request('/api/attendance/punch',actor.token,{orgId:live.orgId,eventType,operationId:randomUUID()})
  }
  async function target(actor: Actor) {
    return live.request('/api/attendance/timezone-context/me?workDate='+workDate,actor.token,undefined,'GET')
  }
  async function addChangedHistoricalAssignment(actor: Actor) {
    const shiftId=randomUUID()
    await live.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days)
      VALUES($1,$2,'synthetic later configuration','Asia/Tokyo','08:00','17:00','[0,1,2,3,4,5,6]'::jsonb)`,[shiftId,live.orgId])
    await live.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
      VALUES($1,$2,$3,$4,$5,$5,true,'published')`,[randomUUID(),live.orgId,actor.userId,shiftId,workDate])
  }
  it('OFF: read-only plan, unchanged parent, checkout and replay keep archived UTC after current rules change',async()=>{
    const h=await historical()
    // Same-zone pre-companion dates now follow the unfrozen pre-upgrade path;
    // a changed default zone (same local date at 18:00Z) still needs the controlled repair.
    await live.pool.query("UPDATE attendance_rules SET timezone='America/New_York' WHERE org_id=$1 AND is_default=true",[live.orgId])
    const blocked=await punch(h.actor,'check_out','18:00')
    expect(blocked).toMatchObject({status:409,body:{error:{code:'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED'}}})
    const admission=await inspect(live.pool,{orgId:live.orgId,actorId:admin.userId})
    expect(admission).toMatchObject({code:'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED',scanComplete:true,counts:{ordinaryLegacyRecordsWithoutCompanion:1,openOrdinaryLegacyRecordsWithoutCompanion:1}})
    const before=await live.counts(h.actor.userId)
    await preview(live.pool,input(h.evidence))
    expect(await live.counts(h.actor.userId)).toEqual(before)
    expect((await live.pool.query('SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE record_id=$1',[h.recordId])).rows).toEqual([{n:0}])
    const approved=await repair(h.evidence)
    expect(await row(h.recordId)).toEqual(h.original)
    expect((await inspect(live.pool,{orgId:live.orgId,actorId:admin.userId})).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_READY')
    await live.pool.query("UPDATE attendance_rules SET timezone='Asia/Tokyo',work_start_time='08:00',work_end_time='17:00' WHERE org_id=$1 AND is_default=true",[live.orgId])
    await addChangedHistoricalAssignment(h.actor)
    const accepted=await punch(h.actor,'check_out','18:00')
    expect(accepted.status,accepted.body.error?.code).toBe(200)
    expect(await row(h.recordId)).toMatchObject({timezone:'UTC',work_date:workDate,first_in_at:h.original.first_in_at,late_minutes:0,early_leave_minutes:0})
    expect(new Date((await row(h.recordId)).last_out_at).toISOString()).toBe(at('18:00'))
    const after=await row(h.recordId)
    expect((await apply(live.pool,approved)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ALREADY_APPLIED')
    expect(await row(h.recordId)).toEqual(after)
    const events=await live.pool.query('SELECT event_type,timezone,work_date::text FROM attendance_events WHERE org_id=$1 AND user_id=$2',[live.orgId,h.actor.userId])
    expect(events.rows).toEqual([{event_type:'check_out',timezone:'UTC',work_date:workDate}])
  })
  it('same-day check-in uses the repaired frame rather than a different current timezone',async()=>{
    const h=await historical();await repair(h.evidence)
    await live.pool.query("UPDATE attendance_rules SET timezone='Asia/Tokyo' WHERE org_id=$1 AND is_default=true",[live.orgId])
    const result=await punch(h.actor,'check_in','09:15')
    expect(result.status,result.body.error?.code).toBe(200)
    expect(await row(h.recordId)).toMatchObject({timezone:'UTC',work_date:workDate,first_in_at:h.original.first_in_at})
  })
  it.each(['missed_check_out','missed_check_in','time_correction','leave'])('new %s and approval use the repaired context despite later assignment changes',async requestType=>{
    const h=await historical();await repair(h.evidence)
    const leaveTypeId=randomUUID()
    await live.pool.query("INSERT INTO attendance_leave_types(id,org_id,code,name) VALUES($1,$2,$3,'synthetic repair')",[leaveTypeId,live.orgId,'repair_'+leaveTypeId])
    const context=await target(h.actor);expect(context.status).toBe(200)
    const made=await live.request('/api/attendance/requests',h.actor.token,{orgId:live.orgId,requestType,workDate,operationId:randomUUID(),
      requestedInAt:at('09:00'),requestedOutAt:at('18:00'),expectedTimezoneContextFingerprint:context.body.data.contextFingerprint,
      ...(requestType==='leave'?{leaveTypeId}:{}),
    })
    expect(made.status,made.body.error?.code).toBe(201)
    await addChangedHistoricalAssignment(h.actor)
    const decided=await live.request('/api/attendance/requests/'+made.body.data.request.id+'/approve',admin.token,{})
    expect(decided.status,decided.body.error?.code).toBe(200)
    expect(await row(h.recordId)).toMatchObject({timezone:'UTC',work_date:workDate})
  })
  it.each(['missed_check_out','missed_check_in','time_correction','leave'])('old pending %s without timezone metadata adopts the repaired parent on approval',async requestType=>{
    const actor=await live.user()
    await live.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    const leaveTypeId=randomUUID()
    await live.pool.query("INSERT INTO attendance_leave_types(id,org_id,code,name) VALUES($1,$2,$3,'synthetic old pending')",[leaveTypeId,live.orgId,'pending_'+leaveTypeId])
    const made=await live.request('/api/attendance/requests',actor.token,{orgId:live.orgId,requestType,workDate,operationId:randomUUID(),
      requestedInAt:at('09:00'),requestedOutAt:at('18:00'),...(requestType==='leave'?{leaveTypeId}:{}),
    })
    expect(made.status,made.body.error?.code).toBe(201)
    const requestId=made.body.data.request.id
    // Synthetic old-version shape: original generic requests had no timezoneContextV1.
    await live.pool.query("UPDATE attendance_requests SET metadata=metadata-'timezoneContextV1' WHERE id=$1 AND org_id=$2",[requestId,live.orgId])
    const h=await historical(actor);await repair(h.evidence)
    await live.pool.query("UPDATE attendance_rules SET timezone='Asia/Tokyo' WHERE org_id=$1 AND is_default=true",[live.orgId])
    await addChangedHistoricalAssignment(actor)
    const decided=await live.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{})
    expect(decided.status,decided.body.error?.code).toBe(200)
    expect(await row(h.recordId)).toMatchObject({timezone:'UTC',work_date:workDate})
    expect((await live.pool.query('SELECT metadata FROM attendance_requests WHERE id=$1',[requestId])).rows[0].metadata.timezoneContextV1).toBeUndefined()
    if(requestType==='leave') {
      const previous=process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED
      process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED='true'
      try {
        const launched=await live.request('/api/attendance/requests/'+requestId+'/cancel-round?orgId='+live.orgId,actor.token,{reason:'synthetic repaired leave cancellation'})
        expect(launched.status,launched.body.error?.code).toBe(201)
        const cancelled=await live.request('/api/attendance/requests/'+requestId+'/cancel-round/actions?orgId='+live.orgId,admin.token,{action:'approve',expectedRoundId:launched.body.data.round.roundId})
        expect(cancelled.status,cancelled.body.error?.code).toBe(200)
        expect((await live.pool.query('SELECT status FROM attendance_requests WHERE id=$1',[requestId])).rows).toEqual([{status:'cancelled'}])
        expect(await row(h.recordId)).toMatchObject({timezone:'UTC',work_date:workDate})
      } finally {
        if(previous===undefined) delete process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED
        else process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED=previous
      }
    }
  })
  it('a closed overnight repair tail does not steal the next day check-in',async()=>{
    const h=await historical()
    await live.pool.query('UPDATE attendance_records SET first_in_at=$2,last_out_at=$3 WHERE id=$1',
      [h.recordId,at('20:00'),'2026-01-13T05:00:00Z'])
    h.evidence.expectedRecordFingerprint=attendanceLegacyRepairRecordFingerprintV1(await row(h.recordId))
    h.evidence.rule={...h.evidence.rule,workStartTime:'20:00',workEndTime:'05:00',isOvernight:true}
    h.evidence.attribution.tailMinutes=360
    h.evidence.absoluteWindow={startAt:at('20:00'),endAt:'2026-01-13T05:00:00Z'}
    h.evidence.attributionWindow={startAt:at('20:00'),endAt:'2026-01-13T11:00:00Z'}
    await repair(h.evidence)
    const closed=await row(h.recordId)
    punchClock.setOnlinePunchInstantForTests('2026-01-13T09:00:00Z')
    const next=await live.request('/api/attendance/punch',h.actor.token,{orgId:live.orgId,eventType:'check_in',operationId:randomUUID()})
    expect(next.status,next.body.error?.code).toBe(200)
    expect(await row(h.recordId)).toEqual(closed)
    expect((await live.pool.query('SELECT work_date::text FROM attendance_records WHERE org_id=$1 AND user_id=$2 ORDER BY work_date',
      [live.orgId,h.actor.userId])).rows).toEqual([{work_date:workDate},{work_date:'2026-01-13'}])
  })
  it('rejects a stale approved plan without companion or parent changes',async()=>{
    const h=await historical(),request=input(h.evidence),plan=await preview(live.pool,request)
    await live.pool.query('UPDATE attendance_records SET work_minutes=7 WHERE id=$1',[h.recordId])
    const changed=await row(h.recordId)
    await expect(apply(live.pool,{...request,approvedSourceSha256:plan.sourceSha256,approvedPlanSha256:plan.planSha256}))
      .rejects.toMatchObject({code:'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_RECORD_CHANGED'})
    expect(await row(h.recordId)).toEqual(changed)
    expect((await live.pool.query('SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE record_id=$1',[h.recordId])).rows).toEqual([{n:0}])
  })
  it('requires the scoped operator and does not leak a cross-organization record into a plan',async()=>{
    const h=await historical(),reader=await live.user(false)
    await expect(preview(live.pool,input({...h.evidence,archive:{...h.evidence.archive,reviewedBy:reader.userId}},reader.userId)))
      .rejects.toMatchObject({code:'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ACTOR_FORBIDDEN'})
    const otherOrg=randomUUID()
    await live.pool.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)',[admin.userId,otherOrg])
    await live.pool.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)',[h.actor.userId,otherOrg])
    const crossed={...h.evidence,orgId:otherOrg,rule:{...h.evidence.rule,orgId:otherOrg}}
    await expect(preview(live.pool,input(crossed))).rejects.toMatchObject({code:'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_RECORD_NOT_FOUND'})
    const otherAdmission=await inspect(live.pool,{orgId:otherOrg,actorId:admin.userId})
    expect(otherAdmission).toMatchObject({code:'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED',scanComplete:true,counts:{
      defaultRules:0,missingDefaultRules:1,recordsScanned:0,pendingRelatedRequestsScanned:0,ordinaryLegacyRecordsWithoutCompanion:0,
    }})
  })
  it('serializes concurrent approved replay into one companion without changing the parent',async()=>{
    const h=await historical(),request=input(h.evidence),plan=await preview(live.pool,request)
    const approved={...request,approvedSourceSha256:plan.sourceSha256,approvedPlanSha256:plan.planSha256}
    const results=await Promise.all([apply(live.pool,approved),apply(live.pool,approved)])
    expect(results.map(result=>result.code).sort()).toEqual(['ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ALREADY_APPLIED','ATTENDANCE_TIMEZONE_LEGACY_REPAIR_APPLIED'])
    expect(await row(h.recordId)).toEqual(h.original)
    expect((await live.pool.query('SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE record_id=$1',[h.recordId])).rows).toEqual([{n:1}])
  })
  it('runs the operator CLI preview, approved apply and replay against the real database',async()=>{
    const h=await historical(),directory=await mkdtemp(join(tmpdir(),'attendance-repair-cli-'))
    const source=join(directory,'synthetic.json')
    try {
      await writeFile(source,JSON.stringify(h.evidence),{mode:0o600})
      const args=['--import','tsx',resolve('scripts/attendance-timezone-legacy-repair.ts'),'--source='+source,'--actor='+admin.userId,'--confirm-archive-source']
      const run=async(extra:string[]=[])=>{
        const result=await promisify(execFile)(process.execPath,[...args,...extra],{env:{...process.env,DATABASE_URL:process.env.ATTENDANCE_TEST_DATABASE_URL},timeout:30000}).catch(error=>{
          const code=JSON.parse(error.stdout || '{}').code
          throw new Error(typeof code==='string' ? code : 'SYNTHETIC_CLI_PROCESS_FAILED')
        })
        expect(result.stderr).toBe('')
        return JSON.parse(result.stdout)
      }
      const plan=await run()
      expect(plan.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREVIEW_READY')
      expect(await row(h.recordId)).toEqual(h.original)
      const approval=['--apply','--approved-source-sha256='+plan.sourceSha256,'--approved-plan-sha256='+plan.planSha256]
      expect((await run(approval)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_APPLIED')
      expect((await run(approval)).code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ALREADY_APPLIED')
      expect(await row(h.recordId)).toEqual(h.original)
    } finally {await rm(directory,{recursive:true,force:true})}
  },60000)
  it('preflight splits a same-zone untracked record out of BLOCKED only under multi-timezone off and the same default zone',async()=>{
    const scan=async()=>(await inspect(live.pool,{orgId:live.orgId,actorId:admin.userId})).counts
    const base=await scan()
    await historical()
    const same=await scan()
    expect(same.writableNowLegacyRecordsWithoutCompanion-base.writableNowLegacyRecordsWithoutCompanion).toBe(1)
    expect(same.ordinaryLegacyRecordsWithoutCompanion-base.ordinaryLegacyRecordsWithoutCompanion).toBe(1)
    await live.pool.query("UPDATE attendance_rules SET timezone='America/New_York' WHERE org_id=$1 AND is_default=true",[live.orgId])
    const other=await scan()
    expect(other.writableNowLegacyRecordsWithoutCompanion).toBe(0)
    expect(other.ordinaryLegacyRecordsWithoutCompanion).toBe(same.ordinaryLegacyRecordsWithoutCompanion)
    await live.pool.query("UPDATE attendance_rules SET timezone='UTC' WHERE org_id=$1 AND is_default=true",[live.orgId])
    await live.pool.query('INSERT INTO attendance_timezone_policies(org_id,enabled,version,updated_by) VALUES($1,true,1,$2)',[live.orgId,admin.userId])
    try { expect((await scan()).writableNowLegacyRecordsWithoutCompanion).toBe(0) }
    finally { await live.pool.query('DELETE FROM attendance_timezone_policies WHERE org_id=$1',[live.orgId]) }
  })
  it('rejects repair creation and use after a persisted shadow transition even when flags are OFF',async()=>{
    const repaired=await historical();await repair(repaired.evidence)
    const unbound=await historical()
    await live.pool.query(`INSERT INTO attendance_calculation_rollout_state
      (org_id,state,engine_version,reason_code,actor_id,version,prior_state)
      VALUES($1,'shadow','repair-synthetic','TEST_FIXTURE',$2,1,'legacy')`,[live.orgId,admin.userId])
    await expect(preview(live.pool,input(unbound.evidence))).rejects.toMatchObject({code:'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_POSTURE_UNSUPPORTED'})
    expect(await target(repaired.actor)).toMatchObject({status:409,body:{error:{code:'ATTENDANCE_TIMEZONE_REPAIR_POSTURE_UNSUPPORTED'}}})
    expect(await punch(repaired.actor,'check_out','18:00')).toMatchObject({status:409,body:{error:{code:'ATTENDANCE_TIMEZONE_REPAIR_POSTURE_UNSUPPORTED'}}})
    expect(await row(repaired.recordId)).toEqual(repaired.original)
    expect((await inspect(live.pool,{orgId:live.orgId,actorId:admin.userId}))).toMatchObject({code:'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED',scanComplete:true})
  })
  it('preflight does not count a same-zone untracked record as writable now under a persisted shadow posture',async()=>{
    // Rollout rows cannot be deleted; the previous case leaves the org in shadow, so only ensure it here.
    await live.pool.query(`INSERT INTO attendance_calculation_rollout_state
      (org_id,state,engine_version,reason_code,actor_id,version,prior_state)
      VALUES($1,'shadow','repair-synthetic','TEST_FIXTURE',$2,1,'legacy') ON CONFLICT(org_id) DO NOTHING`,[live.orgId,admin.userId])
    expect((await live.pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1',[live.orgId])).rows).toEqual([{state:'shadow'}])
    const before=(await inspect(live.pool,{orgId:live.orgId,actorId:admin.userId})).counts
    await historical()
    const after=(await inspect(live.pool,{orgId:live.orgId,actorId:admin.userId}))
    expect(after.counts.writableNowLegacyRecordsWithoutCompanion).toBe(0)
    expect(after.counts.ordinaryLegacyRecordsWithoutCompanion-before.ordinaryLegacyRecordsWithoutCompanion).toBe(1)
    expect(after.code).toBe('ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED')
  })

  const scopedPreflightExpected = {
    code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_PREFLIGHT_BLOCKED', scanComplete: true, counts: {
      defaultRules: 1, missingDefaultRules: 0, multipleDefaultRules: 0, invalidDefaultTimezones: 0,
      recordsScanned: 1, ordinaryLegacyRecordsWithoutCompanion: 1, openOrdinaryLegacyRecordsWithoutCompanion: 1,
      unsupportedLegacyRecordsWithoutCompanion: 0, writableNowLegacyRecordsWithoutCompanion: 1,
      v2CandidatesRequireValidation: 0, invalidCompanions: 0, companionCandidatesRequireValidation: 0,
      legacyRepairPostureBlocked: 0, pendingRelatedRequestsScanned: 1, pendingRequestsWithoutUsableContext: 1,
      pendingRequestsRequireValidation: 1, tokenCandidatesRequireValidation: 0, overtimeCandidatesRequireValidation: 0,
    },
  }
  async function preflightScopeFixture() {
    const ownOrg = randomUUID(), foreignOrg = randomUUID()
    const ownAdmin = randomUUID(), foreignAdmin = randomUUID(), subject = randomUUID()
    for (const id of [ownAdmin, foreignAdmin, subject]) {
      await live.pool.query("INSERT INTO users(id,email,username,name,password_hash,is_active,activation_status) "
        + "VALUES($1,$2,$1,'preflight scope fixture','disabled',true,'activated')", [id, id + '@preflight-scope.test'])
    }
    for (const id of [ownAdmin, foreignAdmin]) {
      await live.pool.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [id])
    }
    for (const [userId, orgId] of [[ownAdmin, ownOrg], [foreignAdmin, foreignOrg], [subject, ownOrg], [subject, foreignOrg]]) {
      await live.pool.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)', [userId, orgId])
    }
    for (const [orgId, zone] of [[ownOrg, 'UTC'], [foreignOrg, 'Asia/Tokyo']]) {
      await live.pool.query('INSERT INTO attendance_rules(id,org_id,name,timezone,is_default) '
        + "VALUES($1,$2,'preflight scope fixture',$3,true)", [randomUUID(), orgId, zone])
      await live.pool.query('INSERT INTO attendance_timezone_policies(org_id,enabled,version,updated_by) VALUES($1,$2,1,$3)',
        [orgId, orgId === foreignOrg, orgId === ownOrg ? ownAdmin : foreignAdmin])
      await live.pool.query('INSERT INTO attendance_records(id,org_id,user_id,work_date,timezone,first_in_at,status,is_workday,meta) '
        + "VALUES($1,$2,$3,$4,'UTC',$5,'partial',true,'{}'::jsonb)", [randomUUID(), orgId, subject, workDate, at('09:00')])
      await live.pool.query('INSERT INTO attendance_requests(id,org_id,user_id,work_date,request_type,status,metadata) '
        + "VALUES($1,$2,$3,$4,'missed_check_out','pending','{}'::jsonb)", [randomUUID(), orgId, subject, workDate])
    }
    await live.pool.query('INSERT INTO attendance_calculation_rollout_state '
      + '(org_id,state,engine_version,reason_code,actor_id,version,prior_state) '
      + "VALUES($1,'shadow','preflight-synthetic','TEST_FIXTURE',$2,1,'legacy')", [foreignOrg, foreignAdmin])
    return { ownOrg, foreignOrg, ownAdmin, foreignAdmin }
  }
  async function preflightScopeSnapshot(orgs: string[]) {
    const result = await live.pool.query(
      "SELECT kind,data FROM (SELECT 'record' AS kind,to_jsonb(r) AS data FROM attendance_records r WHERE org_id=ANY($1::text[]) "
      + "UNION ALL SELECT 'request',to_jsonb(r) FROM attendance_requests r WHERE org_id=ANY($1::text[]) "
      + "UNION ALL SELECT 'companion',to_jsonb(r) FROM attendance_timezone_context_companions r WHERE org_id=ANY($1::text[]) "
      + "UNION ALL SELECT 'event',to_jsonb(r) FROM attendance_events r WHERE org_id=ANY($1::text[]) "
      + "UNION ALL SELECT 'rule',to_jsonb(r) FROM attendance_rules r WHERE org_id=ANY($1::text[]) "
      + "UNION ALL SELECT 'policy',to_jsonb(r) FROM attendance_timezone_policies r WHERE org_id=ANY($1::text[]) "
      + "UNION ALL SELECT 'rollout',to_jsonb(r) FROM attendance_calculation_rollout_state r WHERE org_id=ANY($1::text[]) "
      + ') AS scoped_rows ORDER BY kind,data::text', [orgs])
    return result.rows
  }
  async function observedPreflight(orgId: string, actorId: string, marker: string, queries: string[]) {
    try {
      return await inspect({ connect: async () => {
        const client = await live.pool.connect()
        return { query: async (sql: string, values?: unknown[]) => {
          queries.push(sql)
          return client.query(sql, values)
        }, release: () => client.release() }
      } }, { orgId, actorId })
    } finally {
      console.info('MUT06_PREFLIGHT_NATIVE', JSON.stringify({ case: marker,
        SQL: queries.filter(sql => /^\s*SELECT/.test(sql)).map(sql => createHash('sha256').update(sql).digest('hex')) }))
    }
  }
  it('MUT06_PREFLIGHT_SCAN: own counts exclude legal foreign records, requests, configuration and JOIN peers', async () => {
    const f = await preflightScopeFixture(), orgs = [f.ownOrg, f.foreignOrg]
    const before = await preflightScopeSnapshot(orgs), queries: string[] = []
    const result = await observedPreflight(f.ownOrg, f.ownAdmin, 'MUT06_PREFLIGHT_SCAN', queries)
    expect(result, 'MUT06_PREFLIGHT_SCAN_COUNTS').toEqual(scopedPreflightExpected)
    const selects = queries.filter(sql => /^\s*SELECT/.test(sql))
    expect(selects).toHaveLength(6)
    const recordSQL = selects.find(sql => sql.includes('FROM attendance_records r LEFT JOIN'))!
    const requestSQL = selects.find(sql => sql.includes('FROM attendance_requests req'))!
    expect(recordSQL, 'MUT06_PREFLIGHT_RECORD_PRIMARY').toContain("WHERE r.org_id=$1 AND r.visibility_state='active'")
    expect(recordSQL, 'MUT06_PREFLIGHT_RECORD_COMPANION_JOIN').toContain('c.record_id=r.id AND c.org_id=r.org_id')
    expect(recordSQL, 'MUT06_PREFLIGHT_RECORD_CALCULATION_JOIN').toContain('calc.attendance_record_id=r.id AND calc.org_id=r.org_id')
    expect(requestSQL, 'MUT06_PREFLIGHT_REQUEST_PRIMARY').toContain("WHERE req.org_id=$1 AND req.status='pending'")
    expect(requestSQL, 'MUT06_PREFLIGHT_REQUEST_RECORD_JOIN').toContain('ON r.org_id=req.org_id AND r.user_id=req.user_id')
    expect(requestSQL, 'MUT06_PREFLIGHT_REQUEST_COMPANION_JOIN').toContain('c.record_id=r.id AND c.org_id=r.org_id')
    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(queries.at(-1)).toBe('COMMIT')
    expect(await preflightScopeSnapshot(orgs), 'MUT06_PREFLIGHT_SCAN_NO_WRITES').toEqual(before)
  })
  it('MUT06_PREFLIGHT_ACTOR: a persisted administrator in only the foreign org cannot start the own scan', async () => {
    const f = await preflightScopeFixture(), orgs = [f.ownOrg, f.foreignOrg]
    const before = await preflightScopeSnapshot(orgs), control: string[] = [], denied: string[] = []
    expect(await observedPreflight(f.ownOrg, f.ownAdmin, 'MUT06_PREFLIGHT_ACTOR_CONTROL', control),
      'MUT06_PREFLIGHT_ACTOR_OWN_CONTROL').toEqual(scopedPreflightExpected)
    await expect(observedPreflight(f.ownOrg, f.foreignAdmin, 'MUT06_PREFLIGHT_ACTOR_DENIED', denied),
      'MUT06_PREFLIGHT_ACTOR_FOREIGN_REFUSAL').rejects.toMatchObject({ code: 'ATTENDANCE_TIMEZONE_LEGACY_REPAIR_ACTOR_FORBIDDEN' })
    expect(denied.filter(sql => /^\s*SELECT/.test(sql))).toHaveLength(1)
    expect(denied.some(sql => /FROM attendance_(records|requests)/.test(sql))).toBe(false)
    expect(denied.at(-1)).toBe('ROLLBACK')
    expect(await preflightScopeSnapshot(orgs), 'MUT06_PREFLIGHT_ACTOR_NO_WRITES').toEqual(before)
  })


})
