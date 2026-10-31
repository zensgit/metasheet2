import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up, down } from '../../src/db/migrations/zzzz20261030120000_create_attendance_calc14_source_versions'
import { readAttendanceCalc14GroupSourcesV1, readAttendanceCalc14UserPublicationV1 } from '../../src/attendance/attendance-calc14-source-history'
import { resolveW7GroupEffectiveFactsInTransactionV1 } from '../../src/attendance/w7-resolver/w7-group-effective-facts-resolver'
import { loadAttendanceCalc14W7SourceRowsInTransactionV1 } from '../../src/attendance/attendance-calc14-w7-source-loader'

const require=createRequire(import.meta.url)
const {deriveAttendanceGroupFixedScheduleEffectiveness}=require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs')
const {buildAttendanceGroupFixedScheduleProducerKey}=require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs')
// Explicit owned synthetic DB only. Missing DB is a failed gate, never skip-green.
const dbUrl=process.env.ATTENDANCE_TEST_DATABASE_URL
const schema='calc14_'+randomUUID().replaceAll('-','')
let pool:Pool
let db:Kysely<unknown>
const asTrx=(client:PoolClient) => ({query:async (text:string,values?:unknown[]) => {
  const result=await client.query(text,values)
  return {rows:result.rows as Array<Record<string,unknown>>}
}})
async function transaction<T>(work:(client:PoolClient)=>Promise<T>, date?:string):Promise<T> {
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    if (date) await client.query(`SELECT set_config('metasheet.calc14_date_required','true',true),
      set_config('metasheet.calc14_business_effective_date',$1,true)`,[date])
    const result=await work(client)
    await client.query('COMMIT')
    return result
  } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
}
async function fixture() {
  const org=randomUUID(),group=randomUUID(),shift=randomUUID(),user=randomUUID(),assignment=randomUUID()
  const start='2026-01-01',end='2026-12-31'
  const key=buildAttendanceGroupFixedScheduleProducerKey({groupId:group,shiftId:shift,startDate:start,endDate:end})
  await transaction(async c=>{
    await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[org])
    await c.query(`INSERT INTO attendance_groups VALUES ($1,$2,'fixed_shift','UTC',NULL)`,[group,org])
    await c.query(`INSERT INTO attendance_shifts VALUES ($1,$2,NULL,'09:00','17:00',false,5,5,5,'strict','[1,2,3,4,5]')`,[shift,org])
    await c.query(`INSERT INTO attendance_shift_segments VALUES ($1,$2,$3,0,'09:00','17:00',0,0)`,[randomUUID(),org,shift])
    await c.query(`INSERT INTO attendance_rules VALUES ($1,$2,'UTC',60,240,true)`,[randomUUID(),org])
    await c.query('INSERT INTO attendance_group_members VALUES ($1,$2,$3)',[org,group,user])
    await c.query('INSERT INTO attendance_group_fixed_schedule_configs VALUES ($1,$2,$3,$4,$5,1)',[org,group,shift,start,end])
    await c.query(`INSERT INTO attendance_shift_assignments VALUES ($1,$2,$3,$4,$5,$6,'published',$7,
      'attendance_group_fixed_schedule',$8,0,true)`,[assignment,org,user,shift,start,end,key,group])
    await c.query('INSERT INTO attendance_calculation_group_memberships VALUES ($1,$2,$3,$4,$5,NULL)',[randomUUID(),org,user,group,start])
  },start)
  return {org,group,shift,user,assignment}
}
async function editShift(f:Awaited<ReturnType<typeof fixture>>, date:string, rounding=15) {
  await transaction(async c=>{
    await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
    await c.query(`UPDATE attendance_shifts SET work_start_time='10:00',work_end_time='18:00',
      late_grace_minutes=1,rounding_minutes=$2 WHERE id=$1`,[f.shift,rounding])
    await c.query("UPDATE attendance_shift_segments SET start_time='10:00',end_time='18:00' WHERE shift_id=$1",[f.shift])
  },date)
}
async function resolve(f:Awaited<ReturnType<typeof fixture>>, date:string) {
  return transaction(c=>resolveW7GroupEffectiveFactsInTransactionV1(asTrx(c),{
    loadSourceRows:loadAttendanceCalc14W7SourceRowsInTransactionV1,
    deriveFixedScheduleEffectiveness:deriveAttendanceGroupFixedScheduleEffectiveness,
    buildFixedScheduleProducerKey:buildAttendanceGroupFixedScheduleProducerKey,
    loadOrgRuleFacts:async ()=>{throw new Error('CURRENT_RULE_FALLBACK_FORBIDDEN')},
  },{orgId:f.org,userId:f.user,workDate:date,timezone:'UTC',isWorkday:true,holidayKind:null}))
}

beforeAll(async ()=>{
  if (!dbUrl) throw new Error('ATTENDANCE_TEST_DATABASE_URL_REQUIRED_FOR_CALC14')
  pool=new Pool({connectionString:dbUrl,max:2,options:`-c search_path=${schema}`})
  await pool.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`CREATE TABLE attendance_groups (id text PRIMARY KEY,org_id text,attendance_type text,timezone text,rule_set_id text);
    CREATE TABLE attendance_shifts (id text PRIMARY KEY,org_id text,timezone text,work_start_time text,work_end_time text,
      is_overnight boolean,late_grace_minutes integer,early_grace_minutes integer,rounding_minutes integer,flex_mode text,working_days jsonb);
    CREATE TABLE attendance_shift_segments (id text PRIMARY KEY,org_id text,shift_id text,segment_index integer,
      start_time text,end_time text,start_day_offset integer,end_day_offset integer);
    CREATE TABLE attendance_rules (id text PRIMARY KEY,org_id text,timezone text,severe_late_threshold_minutes integer,
      absence_late_threshold_minutes integer,is_default boolean);
    CREATE TABLE attendance_rule_sets (id text PRIMARY KEY,org_id text,config jsonb,is_default boolean);
    CREATE TABLE attendance_group_members (org_id text,group_id text,user_id text);
    CREATE TABLE attendance_group_fixed_schedule_configs (org_id text,group_id text,shift_id text,start_date date,end_date date,revision integer);
    CREATE TABLE attendance_shift_assignments (id text PRIMARY KEY,org_id text,user_id text,shift_id text,start_date date,end_date date,
      publish_status text,producer_key text,producer_type text,producer_ref_id text,slot_index integer,is_active boolean,created_at timestamptz DEFAULT now());
    CREATE TABLE attendance_holidays (id text,org_id text,holiday_date date,is_working_day boolean);
    CREATE TABLE attendance_timezone_policies (org_id text,enabled boolean,version integer);
    CREATE TABLE system_configs (key text PRIMARY KEY,value text);
    CREATE TABLE attendance_rotation_assignments (id text,org_id text,user_id text,rotation_rule_id text,start_date date,end_date date,publish_status text,is_active boolean);
    CREATE TABLE attendance_calculation_group_memberships (id text,org_id text,user_id text,group_id text,effective_from date,effective_to date);`)
  db=new Kysely({dialect:new PostgresDialect({pool})})
  await up(db)
})
afterAll(async ()=>{
  if (pool) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  if (db) await db.destroy()
})

describe('CALC14 real source capture and existing W7 facts',()=>{
  it('same group/shift first historical resolution uses A after B, including actual segments/grace/rounding',async ()=>{
    const f=await fixture()
    await editShift(f,'2026-02-01')
    const a=await resolve(f,'2026-01-15'),b=await resolve(f,'2026-02-16')
    expect(a).toEqual({ok:true,facts:{orgId:f.org,userId:f.user,workDate:'2026-01-15',timezone:'UTC',
      calculationGroupId:f.group,shiftId:f.shift,isWorkday:true,holidayKind:null,roundingMinutes:5,
      severeLateThresholdMinutes:60,absenceLateThresholdMinutes:240,
      segments:[{index:0,startTime:'09:00',endTime:'17:00',startDayOffset:0,endDayOffset:0,lateGraceMinutes:5,earlyLeaveGraceMinutes:5}]}})
    if (a.ok === false) throw new Error('EXPECTED_HISTORY_A')
    expect(b).toEqual({ok:true,facts:{...a.facts,workDate:'2026-02-16',roundingMinutes:15,
      segments:[{index:0,startTime:'10:00',endTime:'18:00',startDayOffset:0,endDayOffset:0,lateGraceMinutes:1,earlyLeaveGraceMinutes:5}]}})
    expect(await resolve(f,'2025-12-31')).toEqual({ok:false,reason:'incomplete-policy'})
  })
  it('retains group timezone, org thresholds and dated holiday applicability',async ()=>{
    const f=await fixture()
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query("UPDATE attendance_groups SET timezone='Asia/Taipei' WHERE id=$1",[f.group])
      await c.query('UPDATE attendance_rules SET severe_late_threshold_minutes=30,absence_late_threshold_minutes=120 WHERE org_id=$1',[f.org])
      await c.query("INSERT INTO attendance_holidays VALUES ($1,$2,'2026-02-16',false)",[randomUUID(),f.org])
    },'2026-02-01')
    const a=await resolve(f,'2026-01-15'),b=await resolve(f,'2026-02-16')
    if (a.ok===false || b.ok===false) throw new Error('EXPECTED_COMPLETE_DATED_SOURCES')
    expect({timezone:a.facts.timezone,severe:a.facts.severeLateThresholdMinutes,absence:a.facts.absenceLateThresholdMinutes,
      workday:a.facts.isWorkday,holiday:a.facts.holidayKind}).toEqual({timezone:'UTC',severe:60,absence:240,workday:true,holiday:null})
    expect({timezone:b.facts.timezone,severe:b.facts.severeLateThresholdMinutes,absence:b.facts.absenceLateThresholdMinutes,
      workday:b.facts.isWorkday,holiday:b.facts.holidayKind}).toEqual({timezone:'Asia/Taipei',severe:30,absence:120,workday:false,holiday:'holiday'})
  })
  it('retained timezone uses historical W1 after current group/membership deletion (Rawls R2)',async ()=>{
    const f=await fixture()
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query("UPDATE attendance_groups SET timezone='Asia/Taipei' WHERE id=$1",[f.group])
      await c.query('INSERT INTO attendance_timezone_policies VALUES ($1,true,1)',[f.org])
    },'2026-02-01')
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query('DELETE FROM attendance_shift_assignments WHERE id=$1',[f.assignment])
      await c.query('DELETE FROM attendance_group_members WHERE group_id=$1',[f.group])
      await c.query('DELETE FROM attendance_calculation_group_memberships WHERE group_id=$1',[f.group])
      await c.query('DELETE FROM attendance_groups WHERE id=$1',[f.group])
    },'2026-03-01')
    await transaction(async c=>{
      const workDate='2026-02-16'
      const sources=await readAttendanceCalc14GroupSourcesV1(asTrx(c),{orgId:f.org,groupId:f.group,workDate})
      const userPublication=await readAttendanceCalc14UserPublicationV1(asTrx(c),{orgId:f.org,userId:f.user,workDate})
      if (!sources || !userPublication) throw new Error('EXPECTED_RETAINED_TIMEZONE_SOURCES')
      const {createAttendanceTimezoneContextLoader}=require('../../../../plugins/plugin-attendance/lib/attendance-timezone-context-loader.cjs')
      const statements:string[]=[]
      const loader=createAttendanceTimezoneContextLoader({
        query:async (text:string,values?:unknown[])=>{statements.push(text);return asTrx(c).query(text,values)},
        policyStore:{readPolicy:async ()=>{throw new Error('CURRENT_POLICY_FORBIDDEN')},
          readDefault:async ()=>{throw new Error('CURRENT_DEFAULT_FORBIDDEN')},readEmployeeOverride:async ()=>null},
        readCalc14Sources:async ()=>({...sources,userPublication}),
      })
      const result=await loader({orgId:f.org,userId:f.user,workDate,occurredAt:new Date(workDate+'T02:00:00Z')})
      expect({timezone:result.timezone,source:result.source,groupId:result.calculationGroupMembership?.groupId})
        .toEqual({timezone:'Asia/Taipei',source:'calculation_group',groupId:f.group})
      expect(statements).toEqual([])
    })
  })
  it('retains same-ID group rule-set config A/B rather than substituting default org rule history',async ()=>{
    const f=await fixture()
    const ruleSet=randomUUID()
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query("INSERT INTO attendance_rule_sets VALUES ($1,$2,$3::jsonb,false)",[ruleSet,f.org,JSON.stringify({rule:{lateGraceMinutes:2}})])
      await c.query('UPDATE attendance_groups SET rule_set_id=$2 WHERE id=$1',[f.group,ruleSet])
    },'2026-02-01')
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query('UPDATE attendance_rule_sets SET config=$2::jsonb WHERE id=$1',[ruleSet,JSON.stringify({rule:{lateGraceMinutes:9}})])
    },'2026-03-01')
    await transaction(async c=>{
      const a=await readAttendanceCalc14GroupSourcesV1(asTrx(c),{orgId:f.org,groupId:f.group,workDate:'2026-02-16'})
      const b=await readAttendanceCalc14GroupSourcesV1(asTrx(c),{orgId:f.org,groupId:f.group,workDate:'2026-03-16'})
      expect(a?.ruleSet?.config).toEqual({rule:{lateGraceMinutes:2}})
      expect(b?.ruleSet?.config).toEqual({rule:{lateGraceMinutes:9}})
      expect(a?.ruleSet?.__calc14_version).not.toBe(b?.ruleSet?.__calc14_version)
    })
  })
  it('real PG current loader and retained loader feed the same seam for a multi-member group',async ()=>{
    const f=await fixture(),other=randomUUID()
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query('INSERT INTO attendance_group_members VALUES ($1,$2,$3)',[f.org,f.group,other])
      await c.query(`INSERT INTO attendance_shift_assignments
        (id,org_id,user_id,shift_id,start_date,end_date,publish_status,producer_key,producer_type,producer_ref_id,slot_index,is_active)
        SELECT $1,org_id,$2,shift_id,start_date,end_date,publish_status,producer_key,producer_type,producer_ref_id,slot_index,is_active
        FROM attendance_shift_assignments WHERE id=$3`,[randomUUID(),other,f.assignment])
      await c.query("INSERT INTO attendance_calculation_group_memberships VALUES ($1,$2,$3,$4,'2026-02-01',NULL)",[randomUUID(),f.org,other,f.group])
    },'2026-02-01')
    const historical=await resolve(f,'2026-02-16')
    const current=await transaction(c=>resolveW7GroupEffectiveFactsInTransactionV1(asTrx(c),{
      deriveFixedScheduleEffectiveness:deriveAttendanceGroupFixedScheduleEffectiveness,
      buildFixedScheduleProducerKey:buildAttendanceGroupFixedScheduleProducerKey,
      loadOrgRuleFacts:async trx=>{
        const rules=await trx.query('SELECT severe_late_threshold_minutes,absence_late_threshold_minutes FROM attendance_rules WHERE org_id=$1 AND is_default=true',[f.org])
        return {severeLateThresholdMinutes:Number(rules.rows[0].severe_late_threshold_minutes),absenceLateThresholdMinutes:Number(rules.rows[0].absence_late_threshold_minutes)}
      },
    },{orgId:f.org,userId:f.user,workDate:'2026-02-16',timezone:'UTC',isWorkday:true,holidayKind:null}))
    expect(current).toEqual(historical)
    expect(current.ok).toBe(true)
  })
  it('A -> OFF undated B -> dated C refuses the unknown interval even when C matches current',async ()=>{
    const f=await fixture()
    await transaction(c=>c.query('UPDATE attendance_shifts SET rounding_minutes=10 WHERE id=$1',[f.shift]))
    await editShift(f,'2026-03-01',20)
    expect(await resolve(f,'2026-02-16')).toEqual({ok:false,reason:'incomplete-policy'})
    const c=await resolve(f,'2026-03-16')
    if (c.ok === false) throw new Error('EXPECTED_HISTORY_C')
    expect(c.facts.roundingMinutes).toBe(20)
    const marker=await pool.query(`SELECT business_effective_date,payload FROM attendance_calc14_source_versions
      WHERE org_id=$1 AND source_kind='shift' AND event_kind='unversioned_change'`,[f.org])
    expect(marker.rows).toEqual([{business_effective_date:null,payload:null}])
  })
  it('retains dated member removal and publication withdrawal instead of reading current FSER applicability',async ()=>{
    const f=await fixture()
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query('UPDATE attendance_shift_assignments SET is_active=false WHERE id=$1',[f.assignment])
      await c.query('DELETE FROM attendance_group_members WHERE group_id=$1',[f.group])
    },'2026-02-01')
    expect((await resolve(f,'2026-01-15')).ok).toBe(true)
    expect(await resolve(f,'2026-02-16')).toEqual({ok:false,reason:'incomplete-policy'})
  })
  it('discovers T from retained membership/publication after current source rows are deleted',async ()=>{
    const f=await fixture()
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query('DELETE FROM attendance_shift_assignments WHERE id=$1',[f.assignment])
      await c.query('DELETE FROM attendance_group_members WHERE group_id=$1',[f.group])
      await c.query('DELETE FROM attendance_calculation_group_memberships WHERE group_id=$1',[f.group])
      await c.query('DELETE FROM attendance_groups WHERE id=$1',[f.group])
    },'2026-02-01')
    expect((await resolve(f,'2026-01-15')).ok).toBe(true)
    expect(await resolve(f,'2026-02-16')).toEqual({ok:false,reason:'membership-absent'})
  })
  it('no-op produces no false version; same-day conflicting edit and immutable history update fail atomically',async ()=>{
    const f=await fixture()
    const count=()=>pool.query('SELECT count(*)::int AS n FROM attendance_calc14_source_versions WHERE org_id=$1',[f.org])
    const before=(await count()).rows
    await transaction(async c=>{
      await c.query("SELECT set_config('metasheet.calc14_org',$1,true)",[f.org])
      await c.query('UPDATE attendance_shifts SET rounding_minutes=rounding_minutes WHERE id=$1',[f.shift])
    },'2026-01-01')
    expect((await count()).rows).toEqual(before)
    await expect(editShift(f,'2026-01-01')).rejects.toMatchObject({code:'23514',message:'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT'})
    expect((await resolve(f,'2026-01-15')).ok).toBe(true)
    await expect(pool.query('UPDATE attendance_calc14_source_versions SET payload=NULL WHERE org_id=$1',[f.org]))
      .rejects.toMatchObject({code:'23514',message:'ATTENDANCE_CALC14_SOURCE_IMMUTABLE'})
  })
  it('unknown prehistory and another org cannot borrow current or foreign input',async ()=>{
    const f=await fixture()
    await transaction(async c=>{
      expect(await readAttendanceCalc14GroupSourcesV1(asTrx(c),{orgId:f.org,groupId:f.group,workDate:'2025-12-31'})).toBeNull()
      expect(await readAttendanceCalc14GroupSourcesV1(asTrx(c),{orgId:randomUUID(),groupId:f.group,workDate:'2026-01-15'})).toBeNull()
    })
  })
  it('uncontextualized public-writer member insertion invalidates initialized provenance',async ()=>{
    const f=await fixture()
    await transaction(c=>c.query('INSERT INTO attendance_group_members VALUES ($1,$2,$3)',[f.org,f.group,randomUUID()]))
    expect(await resolve(f,'2026-01-15')).toEqual({ok:false,reason:'incomplete-policy'})
  })
  it('global settings change creates gap provenance, never a historical effective date',async ()=>{
    const f=await fixture()
    await pool.query("INSERT INTO system_configs VALUES ('attendance.settings',$1) ON CONFLICT (key) DO UPDATE SET value=$1",[JSON.stringify({calc14SyntheticMarker:f.org})])
    expect(await resolve(f,'2026-01-15')).toEqual({ok:false,reason:'incomplete-policy'})
  })
  it('rollback does not silently erase retained source evidence',async ()=>{
    await expect(down(db)).rejects.toMatchObject({code:'55000',message:'ATTENDANCE_CALC14_ROLLBACK_BLOCKED'})
  })
})

// Source-only populated isolation additions. Main supplies the owned FULL459
// public schema; these cases neither migrate it nor start an application host.
describe.sequential('CALC14 populated public source isolation', () => {
  let ownPool: Pool
  const sourceDates = { a: '2026-01-01', t: '2026-01-15', b: '2026-02-01', d: '2026-02-16' }
  const sourceDeps = {
    loadSourceRows: loadAttendanceCalc14W7SourceRowsInTransactionV1,
    deriveFixedScheduleEffectiveness: deriveAttendanceGroupFixedScheduleEffectiveness,
    buildFixedScheduleProducerKey: buildAttendanceGroupFixedScheduleProducerKey,
    loadOrgRuleFacts: async () => { throw new Error('CURRENT_RULE_FALLBACK_FORBIDDEN') },
  }
  async function ownedTransaction<T>(work: (c: PoolClient) => Promise<T>, org?: string, date?: string): Promise<T> {
    const c = await ownPool.connect()
    try {
      await c.query('BEGIN')
      if (org && date) await c.query(`SELECT set_config('metasheet.calc14_org',$1,true),
        set_config('metasheet.calc14_date_required','true',true),
        set_config('metasheet.calc14_business_effective_date',$2,true)`, [org, date])
      const result = await work(c)
      await c.query('COMMIT')
      return result
    } catch (error) { await c.query('ROLLBACK'); throw error } finally { c.release() }
  }
  beforeAll(async () => {
    if (!dbUrl) throw new Error('CALC14_POPULATED_OWNED_PUBLIC_DATABASE_REQUIRED')
    ownPool = new Pool({ connectionString: dbUrl, max: 2, options: '-c search_path=public' })
    expect((await ownPool.query(`SELECT current_schema() AS schema,
      to_regclass('public.kysely_migration') IS NOT NULL AS ledger,
      to_regprocedure('public.attendance_calc14_capture_source(text,text,text)') IS NOT NULL AS capture,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.attendance_group_fixed_schedule_configs'::regclass
        AND conname='attendance_group_fixed_schedule_configs_shift_org_fk' AND contype='f') AS parent_fk,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.attendance_calculation_group_memberships'::regclass
        AND conname='attendance_calc_group_memberships_no_overlap' AND contype='x') AS timeline_guard`)).rows)
      .toEqual([{ schema: 'public', ledger: true, capture: true, parent_fk: true, timeline_guard: true }])
  })
  afterAll(async () => { if (ownPool) await ownPool.end() })

  async function populatedPair() {
    const shared = randomUUID()
    await ownPool.query(`INSERT INTO users(id,username,name,password_hash,role,is_active,is_admin)
      VALUES($1,$1,'CALC14 shared synthetic identity','disabled','user',true,false)`, [shared])
    const pair = [0, 1].map(index => ({
      org: randomUUID(), group: randomUUID(), shift: randomUUID(), ruleSet: randomUUID(),
      exclusive: randomUUID(), shared, index, timezone: index === 0 ? 'UTC' : 'Asia/Taipei',
    }))
    for (const f of pair) {
      // Trusted synthetic A/B dates only, using the unchanged production GUC and
      // deferred capture functions. All parents exist before their children.
      await ownedTransaction(async c => {
        await c.query(`INSERT INTO users(id,username,name,password_hash,role,is_active,is_admin)
          VALUES($1,$1,'CALC14 exclusive synthetic identity','disabled','user',true,false)`, [f.exclusive])
        for (const user of [shared, f.exclusive]) await c.query(
          'INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)', [user, f.org])
        await c.query(`INSERT INTO attendance_rules(id,org_id,name,timezone,is_default,
          severe_late_threshold_minutes,absence_late_threshold_minutes,working_days)
          VALUES($1,$2,'CALC14 populated rule',$3,true,$4,$5,'[0,1,2,3,4,5,6]'::jsonb)`,
        [randomUUID(), f.org, f.timezone, 60 - 30 * f.index, 240 - 120 * f.index])
        await c.query(`INSERT INTO attendance_rule_sets(id,org_id,name,version,scope,config,is_default)
          VALUES($1,$2,'CALC14 populated rule set',1,'org',$3::jsonb,false)`,
        [f.ruleSet, f.org, JSON.stringify({ rule: { lateGraceMinutes: 5 + f.index } })])
        await c.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,
          is_overnight,late_grace_minutes,early_grace_minutes,rounding_minutes,working_days,flex_mode)
          VALUES($1,$2,'CALC14 populated shift',$3,$4,$5,false,$6,5,$7,'[0,1,2,3,4,5,6]'::jsonb,'strict')`,
        [f.shift, f.org, f.timezone, f.index === 0 ? '09:00' : '07:00', f.index === 0 ? '17:00' : '15:00', 5 + f.index, 5 + 5 * f.index])
        await c.query(`INSERT INTO attendance_shift_segments(id,org_id,shift_id,segment_index,start_time,end_time,start_day_offset,end_day_offset)
          VALUES($1,$2,$3,0,$4,$5,0,0)`, [randomUUID(), f.org, f.shift, f.index === 0 ? '09:00' : '07:00', f.index === 0 ? '17:00' : '15:00'])
        await c.query(`INSERT INTO attendance_groups(id,org_id,name,code,attendance_type,timezone,rule_set_id)
          VALUES($1,$2,'CALC14 populated group',$5,'fixed_shift',$3,$4)`, [f.group, f.org, f.timezone, f.ruleSet, f.group])
        await c.query(`INSERT INTO attendance_group_fixed_schedule_configs(org_id,group_id,shift_id,start_date,end_date,revision,updated_by)
          VALUES($1,$2,$3,'2026-01-01','2026-12-31',1,$4)`, [f.org, f.group, f.shift, f.exclusive])
        await c.query(`INSERT INTO attendance_holidays(org_id,holiday_date,name,is_working_day)
          VALUES($1,$2,'CALC14 populated calendar',$3)`, [f.org, sourceDates.d, f.index === 1])
        for (const user of [shared, f.exclusive]) {
          await c.query('INSERT INTO attendance_group_members(org_id,group_id,user_id) VALUES($1,$2,$3)', [f.org, f.group, user])
          const key = buildAttendanceGroupFixedScheduleProducerKey({ groupId: f.group, shiftId: f.shift, startDate: sourceDates.a, endDate: '2026-12-31' })
          await c.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,
            producer_type,producer_ref_id,producer_key,producer_run_id,publish_status,slot_index)
            VALUES($1,$2,$3,$4,$5,'2026-12-31',true,'attendance_group_fixed_schedule',$6,$7,$8,'published',0)`,
          [randomUUID(), f.org, user, f.shift, sourceDates.a, f.group, key, randomUUID()])
          await c.query(`INSERT INTO attendance_calculation_group_memberships(org_id,user_id,group_id,effective_from,
            assigned_by,assigned_reason,assigned_correlation_id) VALUES($1,$2,$3,$4,$2,'trusted-synthetic-source',$5)`,
          [f.org, user, f.group, sourceDates.a, randomUUID()])
        }
      }, f.org, sourceDates.a)
      await ownedTransaction(async c => {
        await c.query(`UPDATE attendance_shifts SET work_start_time=$3,work_end_time=$4,rounding_minutes=$5
          WHERE org_id=$1 AND id=$2`, [f.org, f.shift, f.index === 0 ? '10:00' : '08:00', f.index === 0 ? '18:00' : '16:00', 15 + 5 * f.index])
        await c.query(`UPDATE attendance_shift_segments SET start_time=$3,end_time=$4 WHERE org_id=$1 AND shift_id=$2`,
          [f.org, f.shift, f.index === 0 ? '10:00' : '08:00', f.index === 0 ? '18:00' : '16:00'])
        await c.query(`UPDATE attendance_rules SET severe_late_threshold_minutes=severe_late_threshold_minutes+10,
          absence_late_threshold_minutes=absence_late_threshold_minutes+10 WHERE org_id=$1`, [f.org])
        await c.query('UPDATE attendance_rule_sets SET config=$3::jsonb,version=version+1 WHERE org_id=$1 AND id=$2',
          [f.org, f.ruleSet, JSON.stringify({ rule: { lateGraceMinutes: 9 + f.index } })])
      }, f.org, sourceDates.b)
    }
    for (const f of pair) expect((await ownPool.query(`SELECT source_kind,event_kind,count(*)::int AS versions
      FROM public.attendance_calc14_source_versions WHERE org_id=$1 GROUP BY source_kind,event_kind ORDER BY source_kind`, [f.org])).rows)
      .toEqual([
        { source_kind: 'desired', event_kind: 'version', versions: 1 },
        { source_kind: 'group', event_kind: 'version', versions: 1 },
        { source_kind: 'members', event_kind: 'version', versions: 1 },
        { source_kind: 'publication', event_kind: 'version', versions: 1 },
        { source_kind: 'rule', event_kind: 'version', versions: 2 },
        { source_kind: 'rule_set', event_kind: 'version', versions: 2 },
        { source_kind: 'shift', event_kind: 'version', versions: 2 },
        { source_kind: 'user_publication', event_kind: 'version', versions: 2 },
      ])
    return pair
  }
  type Populated = Awaited<ReturnType<typeof populatedPair>>[number]
  async function publicBytes(orgs: string[]) {
    const result: Record<string, string[]> = {}
    for (const table of ['attendance_groups', 'attendance_rules', 'attendance_rule_sets', 'attendance_shifts',
      'attendance_shift_segments', 'attendance_group_fixed_schedule_configs', 'attendance_group_members',
      'attendance_shift_assignments', 'attendance_rotation_assignments', 'attendance_holidays',
      'attendance_calculation_group_memberships', 'attendance_calc14_source_versions', 'user_orgs']) {
      result[table] = (await ownPool.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${table} t
        WHERE org_id=ANY($1::text[]) ORDER BY to_jsonb(t)::text`, [orgs])).rows.map(row => row.bytes)
    }
    result.users = (await ownPool.query(`SELECT to_jsonb(u)::text AS bytes FROM public.users u
      WHERE EXISTS (SELECT 1 FROM public.user_orgs uo WHERE uo.user_id=u.id AND uo.org_id=ANY($1::text[]))
      ORDER BY u.id`, [orgs])).rows.map(row => row.bytes)
    return result
  }
  async function positiveSources(f: Populated, userId = f.shared) {
    for (const [workDate, later] of [[sourceDates.t, false], [sourceDates.d, true]] as const) {
      await ownedTransaction(async c => {
        const input = { orgId: f.org, userId, workDate, timezone: 'UTC', isWorkday: true, holidayKind: null }
        const source = await readAttendanceCalc14GroupSourcesV1(asTrx(c), { orgId: f.org, groupId: f.group, workDate })
        if (!source) throw new Error('CALC14_POPULATED_COMPLETE_GROUP_REQUIRED')
        expect({ group: source.group.id, org: source.group.org_id, desiredShift: source.desired.shift_id,
          shift: source.shift.id, shiftOrg: source.shift.org_id, ruleOrg: source.rule.org_id, ruleSet: source.ruleSet?.id,
          members: source.members, publicationUsers: source.publication.map(row => row.user_id).sort(),
          publicationScopes: source.publication.map(row => [row.org_id, row.producer_ref_id, row.shift_id]) })
          .toEqual({ group: f.group, org: f.org, desiredShift: f.shift, shift: f.shift, shiftOrg: f.org,
            ruleOrg: f.org, ruleSet: f.ruleSet, members: [f.shared, f.exclusive].sort().map(user_id => ({ user_id })),
            publicationUsers: [f.shared, f.exclusive].sort(), publicationScopes: [[f.org, f.group, f.shift], [f.org, f.group, f.shift]] })
        expect(source.ruleSet?.config).toEqual({ rule: { lateGraceMinutes: (later ? 9 : 5) + f.index } })
        const loaded = await loadAttendanceCalc14W7SourceRowsInTransactionV1(asTrx(c), sourceDeps, input)
        expect(loaded?.calendarFacts).toEqual({ isWorkday: !later || f.index === 1, holidayKind: later && f.index === 0 ? 'holiday' : null })
        expect(await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(c), sourceDeps, input)).toEqual({ ok: true, facts: {
          orgId: f.org, userId, workDate, timezone: f.timezone, calculationGroupId: f.group, shiftId: f.shift,
          isWorkday: !later || f.index === 1, holidayKind: later && f.index === 0 ? 'holiday' : null,
          roundingMinutes: (later ? 15 : 5) + 5 * f.index,
          severeLateThresholdMinutes: 60 - 30 * f.index + (later ? 10 : 0),
          absenceLateThresholdMinutes: 240 - 120 * f.index + (later ? 10 : 0),
          segments: [{ index: 0, startTime: later ? (f.index === 0 ? '10:00' : '08:00') : (f.index === 0 ? '09:00' : '07:00'),
            endTime: later ? (f.index === 0 ? '18:00' : '16:00') : (f.index === 0 ? '17:00' : '15:00'),
            startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 5 + f.index, earlyLeaveGraceMinutes: 5 }],
        } })
      })
    }
  }

  it('C14_SQL_POPULATED_GROUP_SCOPE: two populated orgs retain distinct A/B sources and reject crossed source keys', async () => {
    const pair = await populatedPair()
    const before = await publicBytes(pair.map(f => f.org))
    for (const f of pair) await positiveSources(f)
    const { readAttendanceCalc14SourceVersionV1 } = await import('../../src/attendance/attendance-calc14-source-history')
    for (const [own, foreign] of [pair, [pair[1], pair[0]]]) {
      await ownedTransaction(async c => {
        for (const workDate of [sourceDates.t, sourceDates.d]) {
          expect(await readAttendanceCalc14GroupSourcesV1(asTrx(c), { orgId: own.org, groupId: foreign.group, workDate })).toBeNull()
          for (const [kind, sourceId] of [['group', foreign.group], ['desired', foreign.group], ['members', foreign.group],
            ['publication', foreign.group], ['shift', foreign.shift], ['rule_set', foreign.ruleSet], ['rule', foreign.org]] as const) {
            expect(await readAttendanceCalc14SourceVersionV1(asTrx(c), { orgId: own.org, kind, sourceId, workDate })).toBeNull()
          }
          expect(await readAttendanceCalc14SourceVersionV1(asTrx(c), { orgId: own.org, kind: 'shift', sourceId: own.group, workDate })).toBeNull()
        }
      })
    }
    expect(await publicBytes(pair.map(f => f.org))).toEqual(before)
  })

  it('C14_SQL_POPULATED_PUBLICATION_SCOPE: shared global identity stays org-scoped and foreign-only users cannot borrow history', async () => {
    const pair = await populatedPair()
    const before = await publicBytes(pair.map(f => f.org))
    for (const f of pair) { await positiveSources(f); await positiveSources(f, f.exclusive) }
    for (const [own, foreign] of [pair, [pair[1], pair[0]]]) {
      await ownedTransaction(async c => {
        for (const workDate of [sourceDates.t, sourceDates.d]) {
          const publication = await readAttendanceCalc14UserPublicationV1(asTrx(c), { orgId: own.org, userId: own.shared, workDate })
          if (!publication) throw new Error('CALC14_SHARED_PUBLICATION_REQUIRED')
          expect(publication.memberships.map(row => row.group_id)).toEqual([own.group])
          expect(publication.assignments.map(row => [row.org_id, row.user_id, row.shift_id, row.producer_ref_id]))
            .toEqual([[own.org, own.shared, own.shift, own.group]])
          expect(publication.rotations).toEqual([])
          const input = { orgId: own.org, userId: foreign.exclusive, workDate, timezone: 'UTC', isWorkday: true, holidayKind: null }
          expect(await readAttendanceCalc14UserPublicationV1(asTrx(c), input)).toBeNull()
          expect(await loadAttendanceCalc14W7SourceRowsInTransactionV1(asTrx(c), sourceDeps, input)).toBeNull()
          expect(await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(c), sourceDeps, input)).toEqual({ ok: false, reason: 'incomplete-policy' })
        }
      })
      // A legitimate foreign shift update would change its payload; the actual
      // production capture refuses the mismatched bound org and rolls it back.
      await expect(ownedTransaction(async c => {
        await c.query('UPDATE attendance_shifts SET rounding_minutes=rounding_minutes+1 WHERE org_id=$1 AND id=$2', [foreign.org, foreign.shift])
        await c.query("SELECT attendance_calc14_capture_source($1,'shift',$2)", [foreign.org, foreign.shift])
      }, own.org, '2026-03-01')).rejects.toMatchObject({ code: '23514', message: 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID' })
    }
    expect(await publicBytes(pair.map(f => f.org))).toEqual(before)
  })
})
