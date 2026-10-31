import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createOnlinePunchDbFixture } from './attendance-online-punch-db'
import { seedAttendanceW7ContextSourcePostureV1 } from './w7-context-source-posture-fixture'

const require=createRequire(import.meta.url)
const {buildAttendanceGroupFixedScheduleProducerKey}=require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs')

/** Real source host + actual HTTP import + real PG snapshots. The main-owned
 * heavy slot invokes this against a newly migrated OWNED synthetic database.
 * A/B below are explicitly trusted synthetic historical source evidence, not
 * an ordinary-save backdating route. No trigger/guard/FK is disabled. */
export function createAttendanceCalc14NativeFixture() {
  if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('CALC14_OWNED_DATABASE_REQUIRED')
  const host=createOnlinePunchDbFixture({retainHistoryInIsolatedDatabase:true})
  const prior={w4:process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,w7:process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED}
  const groupId=randomUUID(),shiftId=randomUUID(),ruleSetId=randomUUID(),assignmentId=randomUUID()
  let admin:Awaited<ReturnType<typeof host.start>>
  let subject:Awaited<ReturnType<typeof host.user>>
  const dates={a:'2026-09-01',t:'2026-09-15',d:'2026-10-01',control:'2026-10-15',withdrawal:'2026-10-20'}
  const engine=(version:'A'|'B')=>({templates:[{
    name:'CALC14 retained source marker',
    rules:[{
      id:`calc14-source-${version}`,
      when:{userId:subject.userId},
      then:{warning:`CALC14_SOURCE_${version}`},
    }],
  }]})
  async function sourceTransaction(date:string,work:(query:(text:string,values?:unknown[])=>Promise<unknown>)=>Promise<void>) {
    const client=await host.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('metasheet.calc14_org',$1,true),
        set_config('metasheet.calc14_date_required','true',true),
        set_config('metasheet.calc14_business_effective_date',$2,true),
        set_config('metasheet.calc14_actor',$3,true)`,[host.orgId,date,admin.userId])
      await work((text,values)=>client.query(text,values))
      await client.query('COMMIT')
    } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
  }
  async function start() {
    // Existing exact-org test gates are registered before host activation.
    // No Stream/lifecycle/external-write setting is enabled by this fixture.
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED=host.orgId
    process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED=host.orgId
    admin=await host.start()
    subject=await host.user(false)
    const schema=await host.pool.query("SELECT to_regclass('attendance_calc14_source_versions') IS NOT NULL AS present")
    if (schema.rows[0]?.present!==true) throw new Error('CALC14_W54_MIGRATION_REQUIRED')
    await sourceTransaction(dates.a,async query=>{
      await query(`UPDATE attendance_rules SET timezone='UTC',late_grace_minutes=5,early_grace_minutes=5,
        rounding_minutes=5,severe_late_threshold_minutes=60,absence_late_threshold_minutes=240,
        working_days='[0,1,2,3,4,5,6]'::jsonb WHERE org_id=$1 AND is_default=true`,[host.orgId])
      await query(`INSERT INTO attendance_rule_sets(id,org_id,name,version,scope,config,is_default)
        VALUES($1,$2,'CALC14 synthetic retained policy',1,'org',$3::jsonb,false)`,[ruleSetId,host.orgId,JSON.stringify({engine:engine('A')})])
      await query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,
        late_grace_minutes,early_grace_minutes,rounding_minutes,working_days,flex_mode)
        VALUES($1,$2,'CALC14 synthetic strict shift','UTC','09:00','17:00',false,5,5,5,'[0,1,2,3,4,5,6]'::jsonb,'strict')`,[shiftId,host.orgId])
      await query(`INSERT INTO attendance_shift_segments(id,org_id,shift_id,segment_index,start_time,end_time,start_day_offset,end_day_offset)
        VALUES($1,$2,$3,0,'09:00','17:00',0,0)`,[randomUUID(),host.orgId,shiftId])
      await query(`INSERT INTO attendance_groups(id,org_id,name,code,attendance_type,timezone,rule_set_id)
        VALUES($1,$2,'CALC14 synthetic group',$3,'fixed_shift','UTC',$4)`,[groupId,host.orgId,`calc14-${groupId}`,ruleSetId])
      await query(`INSERT INTO attendance_group_fixed_schedule_configs(org_id,group_id,shift_id,start_date,end_date,revision,updated_by)
        VALUES($1,$2,$3,'2026-01-01','2026-12-31',1,$4)`,[host.orgId,groupId,shiftId,admin.userId])
      await query('INSERT INTO attendance_group_members(org_id,group_id,user_id) VALUES($1,$2,$3)',[host.orgId,groupId,subject.userId])
      const key=buildAttendanceGroupFixedScheduleProducerKey({groupId,shiftId,startDate:'2026-01-01',endDate:'2026-12-31'})
      await query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,
        producer_type,producer_ref_id,producer_key,producer_run_id,publish_status)
        VALUES($1,$2,$3,$4,'2026-01-01','2026-12-31',true,'attendance_group_fixed_schedule',$5,$6,$7,'published')`,
      [assignmentId,host.orgId,subject.userId,shiftId,groupId,key,randomUUID()])
      await query(`INSERT INTO attendance_calculation_group_memberships(org_id,user_id,group_id,effective_from,effective_to,
        assigned_by,assigned_reason,assigned_correlation_id) VALUES($1,$2,$3,'2026-01-01',NULL,$4,'synthetic-trusted-source',$5)`,
      [host.orgId,subject.userId,groupId,admin.userId,randomUUID()])
    })
    await host.pool.query(`INSERT INTO attendance_calculation_rollout_state(org_id,state,engine_version,reason_code,actor_id,version,prior_state)
      VALUES($1,'legacy','calc14-native-fixture','TEST_FIXTURE',$2,1,NULL)`,[host.orgId,admin.userId])
    for (const [state,priorState,version] of [['shadow','legacy',2],['eligible','shadow',3],['authoritative','eligible',4]]) {
      await host.pool.query('UPDATE attendance_calculation_rollout_state SET state=$2,prior_state=$3,version=$4 WHERE org_id=$1',[host.orgId,state,priorState,version])
    }
    await seedAttendanceW7ContextSourcePostureV1(host.pool,host.orgId,'group_authoritative',{actorId:admin.userId,engineVersion:'calc14-native-fixture'})
    return {orgId:host.orgId,userId:subject.userId,groupId,shiftId,ruleSetId,assignmentId,dates}
  }
  async function editB() {
    await sourceTransaction(dates.d,async query=>{
      await query(`UPDATE attendance_shifts SET work_start_time='10:00',work_end_time='16:00',
        late_grace_minutes=1,rounding_minutes=15 WHERE id=$1 AND org_id=$2`,[shiftId,host.orgId])
      await query("UPDATE attendance_shift_segments SET start_time='10:00',end_time='16:00' WHERE shift_id=$1 AND org_id=$2",[shiftId,host.orgId])
      await query('UPDATE attendance_rule_sets SET config=$3::jsonb,version=version+1 WHERE id=$1 AND org_id=$2',[ruleSetId,host.orgId,JSON.stringify({engine:engine('B')})])
    })
  }
  async function withdraw(mode:'publication'|'member'|'current-source-delete',date=dates.withdrawal) {
    await sourceTransaction(date,async query=>{
      if (mode==='publication') await query('UPDATE attendance_shift_assignments SET is_active=false WHERE id=$1 AND org_id=$2',[assignmentId,host.orgId])
      if (mode==='member') await query('DELETE FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3',[host.orgId,groupId,subject.userId])
      if (mode==='current-source-delete') {
        await query('DELETE FROM attendance_shift_assignments WHERE org_id=$1 AND id=$2',[host.orgId,assignmentId])
        await query('DELETE FROM attendance_group_fixed_schedule_configs WHERE org_id=$1 AND group_id=$2',[host.orgId,groupId])
        await query('DELETE FROM attendance_group_members WHERE org_id=$1 AND group_id=$2',[host.orgId,groupId])
        await query('DELETE FROM attendance_calculation_group_memberships WHERE org_id=$1 AND group_id=$2',[host.orgId,groupId])
        await query('DELETE FROM attendance_groups WHERE org_id=$1 AND id=$2',[host.orgId,groupId])
      }
    })
  }
  async function recordFor(day:string) {
    const result=await host.pool.query(`SELECT r.id::text AS record_id,r.current_calculation_id::text AS calculation_id,
      r.work_minutes,r.late_minutes,c.version,c.outcome,c.context_snapshot,c.attribution_snapshot,c.input_provenance
      FROM attendance_records r LEFT JOIN attendance_record_calculations c ON c.id=r.current_calculation_id
      WHERE r.org_id=$1 AND r.user_id=$2 AND r.work_date=$3::date`,[host.orgId,subject.userId,day])
    if (result.rows.length>1) throw new Error('CALC14_NATIVE_TARGET_AMBIGUOUS')
    return result.rows[0] ?? null
  }
  async function firstImport(day:string,first:string,last:string) {
    if (await recordFor(day)) throw new Error('CALC14_FIRST_HISTORICAL_TARGET_ALREADY_FROZEN')
    return host.request('/api/attendance/import/commit',admin.token,{orgId:host.orgId,userId:subject.userId,
      idempotencyKey:`calc14-${randomUUID()}`,rows:[{userId:subject.userId,workDate:day,fields:{
        firstInAt:`${day}T${first}:00Z`,lastOutAt:`${day}T${last}:00Z`,
      }}]})
  }
  async function frozenBytes(calculationId:string) {
    const result=await host.pool.query(`SELECT context_snapshot::text,attribution_snapshot::text,segment_snapshot::text,
      evidence_snapshot::text,approved_facts_snapshot::text FROM attendance_record_calculations
      WHERE id=$1::uuid AND org_id=$2`,[calculationId,host.orgId])
    if (result.rows.length!==1) throw new Error('CALC14_NATIVE_FROZEN_TARGET_MISSING')
    return result.rows[0]
  }
  async function recomputeFrozen(day:string) {
    const prior=await recordFor(day)
    if (!prior?.calculation_id) throw new Error('CALC14_NATIVE_FROZEN_TARGET_MISSING')
    return host.request(`/api/attendance/records/${prior.record_id}/recompute`,admin.token,{
      policy:'frozen_prior',operationId:randomUUID(),expectedCalculationId:prior.calculation_id,
      expectedCalculationVersion:Number(prior.version),
    })
  }
  async function stop() {
    try {await host.stop()} finally {
      if (prior.w4===undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED=prior.w4
      if (prior.w7===undefined) delete process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED
      else process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED=prior.w7
    }
  }
  return {start,stop,editB,withdraw,firstImport,recordFor,frozenBytes,recomputeFrozen,request:host.request,pool:host.pool,dates}
}
