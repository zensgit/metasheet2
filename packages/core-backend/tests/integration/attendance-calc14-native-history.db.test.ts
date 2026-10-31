import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAttendanceCalc14NativeFixture } from '../utils/attendance-calc14-native-fixture'

// New affected native cases only. This file boots W54 src/index and its own
// plugin source through the existing fixture. It must never run against a target
// database or use W52 dist as evidence. Missing owned DB fails in the helper.
const native=createAttendanceCalc14NativeFixture()
let ids:Awaited<ReturnType<typeof native.start>>
beforeAll(async ()=>{
  ids=await native.start()
  await native.editB()
},120000)
afterAll(async ()=>{
  // Global integration cleanup clears NODE_ENV before this fixture closes its test clock.
  process.env.NODE_ENV='test'
await native.stop()},60000)

async function firstA(day:string) {
  const response=await native.firstImport(day,'09:04','17:00')
  expect(response.status).toBe(200)
  const row=await native.recordFor(day)
  expect(row).not.toBeNull()
  expect(row?.outcome).toBe('completed')
  expect({worked:Number(row?.work_minutes),late:Number(row?.late_minutes)}).toEqual({worked:475,late:0})
  expect(row?.context_snapshot).toMatchObject({schemaVersion:2,selector:'group_effective',
    calculationGroupId:ids.groupId,shiftId:ids.shiftId,roundingMinutes:5,
    segments:[{index:0,startTime:'09:00',endTime:'17:00',lateGraceMinutes:5}]})
  expect(row?.attribution_snapshot).toMatchObject({posture:'resolved_v2',value:{
    workDate:day,shiftId:ids.shiftId,absoluteWindow:{startAt:`${day}T09:00:00.000Z`,endAt:`${day}T17:00:00.000Z`},
  }})
  expect(JSON.stringify(row?.input_provenance)).toContain('calc14-source-A')
  expect(JSON.stringify(row?.input_provenance)).not.toContain('calc14-source-B')
  return row
}

describe.sequential('CALC14 actual first historical canonical import and frozen compatibility',()=>{
  it('first unfrozen T after B uses complete A; a first D/control uses B on the same group/shift/rule-set IDs',async ()=>{
    expect(new Date().toISOString().slice(0,10)>ids.dates.d).toBe(true)
    await firstA(ids.dates.t)
    const response=await native.firstImport(ids.dates.control,'10:04','16:00')
    expect(response.status).toBe(200)
    const b=await native.recordFor(ids.dates.control)
    expect(b?.outcome).toBe('completed')
    expect({worked:Number(b?.work_minutes),late:Number(b?.late_minutes)}).toEqual({worked:345,late:3})
    expect(b?.context_snapshot).toMatchObject({schemaVersion:2,selector:'group_effective',
      calculationGroupId:ids.groupId,shiftId:ids.shiftId,roundingMinutes:15,
      segments:[{index:0,startTime:'10:00',endTime:'16:00',lateGraceMinutes:1}]})
    expect(b?.attribution_snapshot).toMatchObject({posture:'resolved_v2',value:{
      workDate:ids.dates.control,shiftId:ids.shiftId,absoluteWindow:{
        startAt:`${ids.dates.control}T10:00:00.000Z`,endAt:`${ids.dates.control}T16:00:00.000Z`,
      },
    }})
    expect(JSON.stringify(b?.input_provenance)).toContain('calc14-source-B')
    expect(JSON.stringify(b?.input_provenance)).not.toContain('calc14-source-A')
  })
  it('late first import still discovers T after publication withdrawal; uncovered control refuses with no target write',async ()=>{
    await native.withdraw('publication')
    await firstA('2026-09-16')
    const rejected=await native.firstImport('2026-10-21','10:04','16:00')
    expect(rejected.status).toBe(422)
    expect(rejected.body?.error?.code).toBe('ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
    expect(await native.recordFor('2026-10-21')).toBeNull()
  })
  it('late first import preserves dated member applicability after current member leaves',async ()=>{
    await native.withdraw('member')
    await firstA('2026-09-17')
  })
  it('late first import discovers T after current group/config/member/publication/W1 rows are deleted',async ()=>{
    await native.withdraw('current-source-delete','2026-10-22')
    await firstA('2026-09-18')
  })
  it('frozen_prior ignores new source invalidation and leaves original calculation bytes unchanged',async ()=>{
    const day='2026-09-19'
    const frozen=await firstA(day)
    const originalCalculationId=String(frozen?.calculation_id)
    const originalBytes=await native.frozenBytes(originalCalculationId)
    // Undated input change makes new history selection unavailable. The existing
    // frozen_prior route must not try to read or reissue a source context.
    await native.pool.query('UPDATE attendance_rules SET rounding_minutes=rounding_minutes+1 WHERE org_id=$1 AND is_default=true',[ids.orgId])
    const response=await native.recomputeFrozen(day)
    expect(response.status).toBe(200)
    expect(await native.frozenBytes(originalCalculationId)).toEqual(originalBytes)
    const reused=await native.recordFor(day)
    expect(reused?.context_snapshot).toMatchObject({schemaVersion:2,selector:'group_effective',roundingMinutes:5,
      segments:[{index:0,startTime:'09:00',endTime:'17:00',lateGraceMinutes:5}]})
  })
})
