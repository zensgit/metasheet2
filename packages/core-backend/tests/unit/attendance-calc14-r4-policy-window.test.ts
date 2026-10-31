import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { resolveAttendanceLocalWallTimeV1, validateAttendanceIanaTimezoneV1 } from '../../src/attendance/w4c1-strict-time'

const require=createRequire(import.meta.url)
const {createAttendanceTimezoneRuntime}=require('../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs')
const {readApprovedTrips}=require('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs')
class HttpError extends Error {
  constructor(readonly status:number,readonly code:string) {super(code)}
}
const t='2026-09-15',d='2026-10-01',control='2026-10-15'
const addDays=(day:string,offset:number)=>new Date(new Date(day+'T00:00:00Z').getTime()+offset*86400000).toISOString().slice(0,10)
function fixture(options:{legacyOff?:boolean;unknown?:boolean}={}) {
  const row={id:'default',org_id:'org',timezone:'UTC',timezone_version:1,
    work_start_time:'09:00',work_end_time:'17:00'}
  const rule={id:'shift',timezone:'UTC',workStartTime:'09:00',workEndTime:'17:00',isOvernight:false,
    workingDays:[0,1,2,3,4,5,6],lateGraceMinutes:5,earlyGraceMinutes:5,roundingMinutes:5,
    severeLateThresholdMinutes:60,absenceLateThresholdMinutes:240}
  const employee={id:'employee-A',org_id:'org',user_id:'subject',timezone:'Asia/Taipei',version:1,
    effective_from:new Date(t+'T00:00:00Z'),effective_to:new Date(addDays(control,1)+'T00:00:00Z')}
  const calls:{text:string;values:unknown[]}[]=[]
  // Test-only bounded row adapter. Native draft below exercises real parameterized PG/host loading.
  const trx={query:async (text:string,values:unknown[]=[])=>{
    calls.push({text,values})
    if (text.includes('FROM attendance_timezone_context_companions') || text.includes('FROM attendance_records')) return []
    if (text.includes('FROM users u JOIN user_orgs')) return [{id:'subject'}]
    if (text.startsWith('SELECT enabled, version FROM attendance_timezone_policies')) return [{enabled:false,version:2}]
    if (text.includes('FROM attendance_rules WHERE org_id')) return [row]
    if (text.startsWith('SELECT effective_from AS start_at')) return [{start_at:employee.effective_from,end_at:employee.effective_to}]
    if (text.includes('FROM attendance_employee_timezone_overrides')) {
      if (values.length===4) return [employee]
      const at=values[2] as Date
      return employee.effective_from<=at && at<employee.effective_to ? [employee] : []
    }
    if (text.includes('FROM attendance_business_trip_arrangements')
      || text.includes('FROM attendance_calculation_group_memberships')
      || text.includes('FROM attendance_holidays')) return []
    throw new Error('UNEXPECTED_R4_UNIT_QUERY')
  }}
  const readCalc14Sources=vi.fn(async (_trx:unknown,input:{workDate:string})=>{
    if (options.legacyOff) return null
    if (options.unknown) throw new HttpError(422,'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
    return {rule:{...row,__calc14_version:input.workDate<d ? 7 : 8,
      calc14_timezone_policy:{enabled:input.workDate<d,version:input.workDate<d ? 1 : 2}},
      group:{id:'group',org_id:'org',timezone:'UTC',__calc14_version:3},
      userPublication:{memberships:[{id:'membership',group_id:'group',effective_from:'2026-01-01',effective_to:null}]}}
  })
  const runtime=createAttendanceTimezoneRuntime({
    HttpError,readCalc14Sources,readApprovedTrips,
    acquireRuntimeLocks:async ()=>{},loadCalendarOverrides:async ()=>[],mapRuleRow:()=>rule,mapHolidayRow:(value:unknown)=>value,
    addDaysToDateKey:addDays,normalizeTimeString:(value:string)=>value.slice(0,5),
    resolveLocalWallTime:resolveAttendanceLocalWallTimeV1,validateIanaTimezone:validateAttendanceIanaTimezoneV1,
    toWorkDate:(at:Date)=>at.toISOString().slice(0,10),
    loadPublishedCandidates:async (_trx:unknown,input:{workDates:string[]})=>input.workDates.map(workDate=>({
      orgId:'org',userId:'subject',workDate,shiftId:'shift',assignmentId:'assignment',source:'shift',
      workStartTime:'09:00',workEndTime:'17:00',isOvernight:false,rule,
    })),
    selectCalendarCandidates:async (_trx:unknown,input:{candidates:unknown[]})=>({candidates:input.candidates,multiShiftDay:{enabled:false},prefetched:{}}),
    resolveRuleContext:async (input:{publishedProfile?:{rule:unknown};defaultRule:unknown})=>({
      rule:input.publishedProfile?.rule ?? input.defaultRule,isWorkingDay:true,source:'shift',holiday:null,
    }),
    readCalculationDefinition:async (_trx:unknown,input:{timezone:string;workDate:string})=>({kind:'unit-facts',timezone:input.timezone,workDate:input.workDate}),
  })
  return {trx,runtime,calls,readCalc14Sources}
}
function selected(target:{timezone:string;provenance:{source:string;mode:string;policyVersion:number};window:{startAt:Date;endAt:Date}}) {
  return {timezone:target.timezone,source:target.provenance.source,mode:target.provenance.mode,
    policyVersion:target.provenance.policyVersion,start:target.window.startAt.toISOString(),end:target.window.endAt.toISOString()}
}
const expectedA={timezone:'Asia/Taipei',source:'employee_override',mode:'multi_timezone',policyVersion:1,
  start:t+'T01:00:00.000Z',end:t+'T09:00:00.000Z'}
const expectedD={timezone:'UTC',source:'system_default',mode:'default_only',policyVersion:2,
  start:control+'T09:00:00.000Z',end:control+'T17:00:00.000Z'}
describe('CALC14 R4 per-date policy and full-window cuts',()=>{
  it('single T uses enabled A after current D disables policy; UTC is a negative control',async ()=>{
    const f=fixture()
    const target=await f.runtime.readTargetTimezoneContext(f.trx,{orgId:'org',userId:'subject',workDate:t})
    expect(selected(target)).toEqual(expectedA)
    expect(target.timezone).not.toBe('UTC')
    expect(f.calls.some(call=>call.text.startsWith('SELECT effective_from AS start_at'))).toBe(true)
    expect(f.readCalc14Sources).toHaveBeenCalledTimes(1)
  })
  it('mixed batch retains enabled A at T while D control remains disabled, with interval preload',async ()=>{
    const f=fixture()
    const result=await f.runtime.readTargetTimezoneContexts(f.trx,{orgId:'org',userId:'subject',workDates:[t,control]})
    expect([selected(result.get(t)),selected(result.get(control))]).toEqual([expectedA,expectedD])
    expect(f.calls.filter(call=>call.text.startsWith('SELECT id,timezone,version,effective_from,effective_to'))).toHaveLength(1)
    expect(f.readCalc14Sources).toHaveBeenCalledTimes(2)
  })
  it('disabled D alone does not fetch employee/trip optional rows or force enabled policy',async ()=>{
    const f=fixture()
    const result=await f.runtime.readTargetTimezoneContexts(f.trx,{orgId:'org',userId:'subject',workDates:[control]})
    expect(selected(result.get(control))).toEqual(expectedD)
    expect(f.calls.filter(call=>/FROM attendance_(employee_timezone_overrides|business_trip_arrangements)/.test(call.text))).toEqual([])
  })
  it('legacy OFF keeps default-only output and optional-source IO absent',async ()=>{
    const f=fixture({legacyOff:true})
    const target=await f.runtime.readTargetTimezoneContext(f.trx,{orgId:'org',userId:'subject',workDate:control})
    expect(selected(target)).toEqual(expectedD)
    expect(f.calls.filter(call=>/FROM attendance_(employee_timezone_overrides|business_trip_arrangements)/.test(call.text))).toEqual([])
    expect(f.readCalc14Sources).toHaveBeenCalledTimes(1)
  })
  it.each(['single','batch'])('unknown history stays strict in %s, never current-disabled fallback',async mode=>{
    const f=fixture({unknown:true})
    const input={orgId:'org',userId:'subject',workDate:t}
    const read=mode==='single' ? f.runtime.readTargetTimezoneContext(f.trx,input)
      : f.runtime.readTargetTimezoneContexts(f.trx,{...input,workDates:[t]})
    await expect(read).rejects.toMatchObject({status:422,code:'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE'})
  })
})
