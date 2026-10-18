import { afterAll,afterEach,beforeEach,describe,expect,it } from 'vitest'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
if(!process.env.ATTENDANCE_TEST_DATABASE_URL)throw new Error('ATTENDANCE_TRIP_TRANSITIONS_REAL_DATABASE_REQUIRED')
const require=createRequire(import.meta.url)
const {readTripContextTransitionDates:read}=require('../../../../plugins/plugin-attendance/lib/attendance-trip-context-transition-dates.cjs')
const pool=new Pool({connectionString:process.env.ATTENDANCE_TEST_DATABASE_URL})
let client:PoolClient,orgId:string,userId:string,shiftId:string
const from=new Date('2030-01-01T00:00:00Z'),to=new Date('2230-01-01T00:00:00Z')
async function load(){
  return read({query:async(sql:string,args:unknown[])=>(await client.query(sql,args)).rows},{orgId,userId,from,to,timezone:'Asia/Tokyo'}) as Promise<string[]>
}
beforeEach(async()=>{
  client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  orgId=randomUUID();userId=randomUUID();shiftId=randomUUID()
  await client.query("INSERT INTO users(id,email,username,password_hash,is_active) VALUES($1,$2,$1,'disabled',true)",[userId,userId+'@trip-transition.test'])
  await client.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)',[userId,orgId])
  await client.query("INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days) VALUES($1,$2,'synthetic transition','UTC','09:00','18:00','[1,2,3,4,5]'::jsonb)",[shiftId,orgId])
})
afterEach(async()=>{await client.query('ROLLBACK');client.release()})
afterAll(async()=>{await pool.end()})
describe('trip context representatives against real schema',()=>{
  it('finds an interior published direct slot without crossing org or draft boundaries',async()=>{
    await client.query("INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status,slot_index) VALUES($1,$2,$3,$4,'2100-06-12','2100-06-12',true,'published',1)",[randomUUID(),orgId,userId,shiftId])
    await client.query("INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status,slot_index) VALUES($1,$2,$3,$4,'2101-06-12','2101-06-12',true,'draft',1)",[randomUUID(),orgId,userId,shiftId])
    const foreignOrg=randomUUID(),foreignShift=randomUUID()
    await client.query("INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time) VALUES($1,$2,'synthetic foreign','UTC','09:00','18:00')",[foreignShift,foreignOrg])
    await client.query("INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status,slot_index) VALUES($1,$2,$3,$4,'2102-06-12','2102-06-12',true,'published',1)",[randomUUID(),foreignOrg,userId,foreignShift])
    const dates=await load()
    expect(dates).toContain('2100-06-12');expect(dates).toContain('2100-06-13')
    expect(dates).not.toContain('2101-06-12');expect(dates).not.toContain('2102-06-12')
    expect(dates.length).toBeLessThan(30)
  })
  it('uses real rotation sequence and inclusive membership dates to cover all phase-weekday pairs',async()=>{
    const ruleId=randomUUID(),groupId=randomUUID()
    await client.query("INSERT INTO attendance_rotation_rules(id,org_id,name,timezone,shift_sequence,is_active) VALUES($1,$2,'synthetic phase','UTC',$3::jsonb,true)",[ruleId,orgId,JSON.stringify(Array(31).fill(shiftId))])
    await client.query("INSERT INTO attendance_rotation_assignments(id,org_id,user_id,rotation_rule_id,start_date,end_date,is_active,publish_status) VALUES($1,$2,$3,$4,'2030-01-01','2229-12-31',true,'published')",[randomUUID(),orgId,userId,ruleId])
    await client.query("INSERT INTO attendance_groups(id,org_id,name,timezone) VALUES($1,$2,'synthetic calculation','UTC')",[groupId,orgId])
    await client.query("INSERT INTO attendance_calculation_group_memberships(org_id,user_id,group_id,effective_from,effective_to,assigned_by,assigned_reason,assigned_correlation_id) VALUES($1,$2,$3,'2100-05-01','2100-05-03',$2,'synthetic',$4)",[orgId,userId,groupId,randomUUID()])
    const dates=await load()
    expect(dates).toEqual(expect.arrayContaining(['2100-05-01','2100-05-03','2100-05-04']))
    const pairs=new Set(dates.filter(date=>date>='2030-01-01'&&date<'2100-05-01').map(date=>{
      const at=new Date(date+'T00:00:00Z');return ((at.getTime()-from.getTime())/86400000%31)+':'+at.getUTCDay()
    }))
    expect(pairs.size).toBe(217)
    expect(dates.length).toBeLessThan(450)
  })
  it('reads actual holiday and calendar override exceptions in the caller transaction',async()=>{
    await client.query("INSERT INTO attendance_holidays(org_id,holiday_date,name,is_working_day) VALUES($1,'2110-05-08','synthetic holiday',false)",[orgId])
    await client.query("INSERT INTO system_configs(key,value) VALUES('attendance.settings',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [JSON.stringify({calendarPolicy:{overrides:[{date:'2120-01-05',effective:{source:'org',isWorkingDay:true}},{from:'2130-06-05',to:'2130-06-11',effective:{source:'org',isWorkingDay:false}}]}})])
    const dates=await load()
    expect(dates).toEqual(expect.arrayContaining(['2110-05-08','2110-05-09','2120-01-05','2120-01-06','2130-06-05','2130-06-11','2130-06-12']))
  })
  it('an actual unavailable source fails closed rather than treating it as no calendar',async()=>{
    await client.query('ALTER TABLE attendance_holidays RENAME TO attendance_holidays_transition_unavailable')
    await expect(load()).rejects.toMatchObject({status:503,code:'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE',message:'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE'})
  })
})
