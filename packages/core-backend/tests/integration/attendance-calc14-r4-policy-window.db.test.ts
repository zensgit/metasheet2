import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAttendanceCalc14NativeFixture } from '../utils/attendance-calc14-native-fixture'
import { punchPlugin } from '../utils/attendance-online-punch-db'

// Main applies this NEW file only after the active frozen-pin controller ends.
// Actual W54 host, real PG source capture and HTTP calendar batch; no SQL mocks.
const url=process.env.ATTENDANCE_TEST_DATABASE_URL
if (!url || process.env.DATABASE_URL!==url) throw new Error('CALC14_R4_MATCHED_OWNED_DATABASE_REQUIRED')
const native=createAttendanceCalc14NativeFixture()
let ids:Awaited<ReturnType<typeof native.start>>
let token:string
const t='2026-09-15',control='2026-10-15'
type Target={timezone:string;workDate:string;frozen:boolean;provenance:{source:string;mode:string;policyVersion:number};
  window:{startAt:Date;endAt:Date}}
const plugin=punchPlugin as unknown as {
  readTargetTimezoneContext(trx:{query:(text:string,values?:unknown[])=>Promise<unknown[]>},
    input:{orgId:string;userId:string;workDate:string}):Promise<Target>
}
async function source(date:string,actorId:string,work:(query:(text:string,values?:unknown[])=>Promise<unknown>)=>Promise<void>) {
  const c=await native.pool.connect()
  try {
    await c.query('BEGIN')
    await c.query("SELECT set_config('metasheet.calc14_org',$1,true),set_config('metasheet.calc14_date_required','true',true),"
      +"set_config('metasheet.calc14_business_effective_date',$2,true),set_config('metasheet.calc14_actor',$3,true)",[ids.orgId,date,actorId])
    await work((text,values)=>c.query(text,values))
    await c.query('COMMIT')
  } catch(error) {await c.query('ROLLBACK');throw error} finally {c.release()}
}
async function readTarget(day:string) {
  const c=await native.pool.connect()
  const statements:string[]=[]
  try {
    await c.query('BEGIN')
    const target=await plugin.readTargetTimezoneContext({query:async(text,values)=>{
      statements.push(text);return (await c.query(text,values)).rows
    }},{orgId:ids.orgId,userId:ids.userId,workDate:day})
    await c.query('COMMIT')
    return {target,statements}
  } catch(error) {await c.query('ROLLBACK');throw error} finally {c.release()}
}
async function immutableInputRows() {
  return (await native.pool.query('SELECT id,event_kind,business_effective_date::text,payload FROM attendance_calc14_source_versions WHERE org_id=$1 ORDER BY id',[ids.orgId])).rows
}
beforeAll(async ()=>{
  ids=await native.start() // initial strict source A0 is known and disabled at 2026-09-01
  const actor=(await native.pool.query('SELECT assigned_by FROM attendance_calculation_group_memberships WHERE org_id=$1 AND user_id=$2',[ids.orgId,ids.userId])).rows[0]?.assigned_by
  if (typeof actor!=='string') throw new Error('CALC14_R4_SOURCE_ACTOR_REQUIRED')
  // Trusted synthetic dated evidence, not an ordinary-save historical authorization.
  await source('2026-09-02',actor,async query=>{
    await query('INSERT INTO attendance_timezone_policies(org_id,enabled,version,updated_by) VALUES($1,true,1,$2)',[ids.orgId,actor])
    await query('INSERT INTO attendance_employee_timezone_overrides(org_id,user_id,timezone,effective_from,effective_to,version,created_by,updated_by)'
      +" VALUES($1,$2,'Asia/Taipei',$3,$4,1,$5,$5)",[ids.orgId,ids.userId,t+'T00:00:00Z','2026-10-16T00:00:00Z',actor])
  })
  await source('2026-10-01',actor,query=>query('UPDATE attendance_timezone_policies SET enabled=false,version=version+1,updated_by=$2 WHERE org_id=$1',[ids.orgId,actor]).then(()=>undefined))
  const minted=await native.request('/api/auth/dev-token?userId='+ids.userId+'&tenantId='+ids.orgId+'&roles=viewer&perms=attendance:read',undefined,undefined,'GET')
  expect(minted.status).toBe(200)
  if (typeof minted.body.token!=='string') throw new Error('CALC14_R4_NATIVE_TOKEN_REQUIRED')
  token=minted.body.token
},120000)
afterAll(async ()=>{
  // Global integration cleanup clears NODE_ENV before this fixture closes its test clock.
  process.env.NODE_ENV='test'
await native.stop()},60000)
describe('CALC14 R4 actual retained-policy target and calendar batch',()=>{
  it('known A-enabled T remains employee Asia/Taipei after dated D-disabled, before first freeze',async ()=>{
    const before=await immutableInputRows()
    expect(await native.recordFor(t)).toBeNull()
    const current=(await native.pool.query('SELECT enabled,version FROM attendance_timezone_policies WHERE org_id=$1',[ids.orgId])).rows
    expect(current).toEqual([{enabled:false,version:2}])
    const {target}=await readTarget(t)
    expect({timezone:target.timezone,source:target.provenance.source,mode:target.provenance.mode,
      policyVersion:target.provenance.policyVersion,frozen:target.frozen,
      start:target.window.startAt.toISOString(),end:target.window.endAt.toISOString()}).toEqual({
      timezone:'Asia/Taipei',source:'employee_override',mode:'multi_timezone',policyVersion:1,frozen:false,
      start:t+'T01:00:00.000Z',end:t+'T09:00:00.000Z',
    })
    expect(target.timezone).not.toBe('UTC')
    expect(await native.recordFor(t)).toBeNull()
    expect(await immutableInputRows()).toEqual(before)
  })
  it('actual effective-calendar batch agrees with single T instead of supplying empty optional rows',async ()=>{
    const before=await immutableInputRows()
    const response=await native.request('/api/attendance/effective-calendar?userId='+ids.userId+'&from='+t+'&to='+t,token,undefined,'GET')
    expect(response.status).toBe(200)
    expect(response.body.data.items).toHaveLength(1)
    expect(response.body.data.items[0].attendanceTimeContext).toMatchObject({
      targetWorkDate:t,effectiveTimezone:'Asia/Taipei',timezoneSource:'employee_override',
      mode:'multi_timezone',policyVersion:1,frozen:false,
    })
    expect(response.body.data.items[0].attendanceTimeContext.effectiveTimezone).not.toBe('UTC')
    const {target}=await readTarget(t)
    expect(response.body.data.items[0].attendanceTimeContext.contextFingerprint).toBe((target as Target & {contextFingerprint:string}).contextFingerprint)
    expect(await native.recordFor(t)).toBeNull()
    expect(await immutableInputRows()).toEqual(before)
  })
  it('D-disabled control stays UTC with no optional employee/trip queries even while override covers D',async ()=>{
    const {target,statements}=await readTarget(control)
    expect({timezone:target.timezone,source:target.provenance.source,mode:target.provenance.mode,
      policyVersion:target.provenance.policyVersion,start:target.window.startAt.toISOString(),end:target.window.endAt.toISOString()})
      .toEqual({timezone:'UTC',source:'system_default',mode:'default_only',policyVersion:2,
        start:control+'T09:00:00.000Z',end:control+'T17:00:00.000Z'})
    expect(statements.filter(text=>/FROM attendance_(employee_timezone_overrides|business_trip_arrangements)/.test(text))).toEqual([])
    const response=await native.request('/api/attendance/effective-calendar?userId='+ids.userId+'&from='+control+'&to='+control,token,undefined,'GET')
    expect(response.status).toBe(200)
    expect(response.body.data.items[0].attendanceTimeContext).toMatchObject({
      effectiveTimezone:'UTC',timezoneSource:'system_default',mode:'default_only',policyVersion:2,
    })
    expect(await native.recordFor(control)).toBeNull()
  })
  it('unknown prehistory still refuses instead of borrowing disabled current inputs',async ()=>{
    await expect(readTarget('2026-08-31')).rejects.toMatchObject({
      status:422,code:'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE',
    })
  })
})
