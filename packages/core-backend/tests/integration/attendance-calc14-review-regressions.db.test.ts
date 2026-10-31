import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

// Actual source host, registered public ports and HTTP routes; main supplies the
// migrated, owned isolated DB. These are new counterexamples, never skip-green.
const dbUrl=process.env.ATTENDANCE_TEST_DATABASE_URL
if (!dbUrl || process.env.DATABASE_URL!==dbUrl) throw new Error('CALC14_MATCHED_OWNED_DATABASE_REQUIRED')
const host=createOnlinePunchDbFixture({retainHistoryInIsolatedDatabase:true})
const prior={w4:process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,w7:process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED}
let admin:Awaited<ReturnType<typeof host.start>>
beforeAll(async ()=>{
  delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  delete process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED
  admin=await host.start()
})
afterAll(async ()=>{
  // Global integration cleanup clears NODE_ENV before this fixture closes its test clock.
  process.env.NODE_ENV='test'

  try {await host.stop()} finally {
    for (const [key,value] of [
      ['ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',prior.w4],
      ['ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED',prior.w7],
    ] as const) {
      if (value===undefined) delete process.env[key];else process.env[key]=value
    }
  }
})
describe('CALC14 Rawls actual OFF host regressions',()=>{
  it('OFF writers and metadata use the real core query-client interface (R1/P2)',async ()=>{
    const created=await host.request('/api/attendance/shifts',admin.token,{
      orgId:host.orgId,name:'CALC14 OFF source regression',timezone:'UTC',
      workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6],
      businessEffectiveDate:'ignored-while-off',
    })
    expect(created.status).toBe(201)
    const shifts=await host.request('/api/attendance/shifts?orgId='+host.orgId,admin.token,undefined,'GET')
    expect(shifts.status).toBe(200)
    const shift=shifts.body.data.items.find((item:{id:string})=>item.id===created.body.data.id)
    expect(shift.orgId).toBe(host.orgId)
    expect(shift.capabilities?.businessEffectiveDateRequired).toBeUndefined()
    const rule=await host.request('/api/attendance/rules/default?orgId='+host.orgId,admin.token,undefined,'GET')
    expect(rule.status).toBe(200)
    expect(rule.body.data.orgId).toBe(host.orgId)
    expect(rule.body.data.capabilities?.businessEffectiveDateRequired).toBeUndefined()
    const history=await host.pool.query('SELECT count(*)::int AS n FROM attendance_calc14_source_versions WHERE org_id=$1',[host.orgId])
    expect(history.rows).toEqual([{n:0}])
  })
  it('OFF default-rule check-in without published candidates builds fallback attribution (R3)',async ()=>{
    punchClock.setOnlinePunchInstantForTests('2026-10-29T10:00:00Z')
    const response=await host.request('/api/attendance/punch',admin.token,{orgId:host.orgId,eventType:'check_in'})
    expect(response.status).toBe(200)
    const events=await host.pool.query(
      'SELECT event_type,work_date::text AS work_date,timezone FROM attendance_events WHERE org_id=$1 AND user_id=$2',
      [host.orgId,admin.userId])
    expect(events.rows).toEqual([{event_type:'check_in',work_date:'2026-10-29',timezone:'UTC'}])
  })
})
