import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const { createBusinessTripService, readApprovedTrips, getBusinessTripServerInstant, setBusinessTripInstantForTests } = require('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs')
class HttpError extends Error { constructor(public status: number, public code: string, message: string) { super(message) } }
const base = { destinationTimezone:'Asia/Tokyo', startAt:'2026-11-02T00:00:00Z', endAt:'2026-11-03T00:00:00Z' }
const row = { org_id:'org-a',user_id:'user-a',start_at:new Date(base.startAt),end_at:new Date(base.endAt),destination_timezone:'Asia/Tokyo' }
const ruleProfile={timezone:'Asia/Tokyo',workStartTime:'09:00',workEndTime:'18:00'}
const projectionBasis={policyVersion:0,calculationGroupMembership:null,rule:ruleProfile,
  calculationDefinition:{kind:'rule',isWorkday:true,holidayKind:null,rule:ruleProfile}}
function setup(windows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue([])
  const readWindows = vi.fn().mockResolvedValue(windows)
  const readFrozenWindows=vi.fn().mockResolvedValue([])
  return { query,readWindows,readFrozenWindows,service:createBusinessTripService({HttpError,readWindows,readFrozenWindows}) }
}
describe('business trip strict inputs and whole shift policy',() => {
  it('limits deterministic clock to test mode and returns independent instants',() => {
    const prior=process.env.NODE_ENV
    try {
      process.env.NODE_ENV='test'
      setBusinessTripInstantForTests('2026-11-02T02:00:00Z')
      const first=getBusinessTripServerInstant();first.setUTCFullYear(2000)
      expect(getBusinessTripServerInstant().toISOString()).toBe('2026-11-02T02:00:00.000Z')
      expect(()=>setBusinessTripInstantForTests('invalid')).toThrow('ATTENDANCE_TRIP_TEST_CLOCK_INVALID')
      process.env.NODE_ENV='production'
      expect(()=>setBusinessTripInstantForTests(null)).toThrow('ATTENDANCE_TRIP_TEST_CLOCK_FORBIDDEN')
      expect(Math.abs(getBusinessTripServerInstant().getTime()-Date.now())).toBeLessThan(1000)
    } finally {
      process.env.NODE_ENV='test';setBusinessTripInstantForTests(null)
      if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior
    }
  })

  it('normalizes explicit instants without granting entitlements',() => {
    expect(setup().service.parse(base,'user-a')).toEqual({...base,startAt:new Date(base.startAt).toISOString(),endAt:new Date(base.endAt).toISOString(),userId:'user-a',reason:null,approvalFlowId:null})
  })
  it.each(['2026-11-02T09:00','2026-11-02','bad'])('rejects unzoned or invalid start %s',startAt => {
    expect(() => setup().service.parse({...base,startAt},'user-a')).toThrow('ATTENDANCE_TRIP_EXPLICIT_INSTANT_REQUIRED')
  })
  it.each(['metadata','status','orgId','approvalStatus','version','policyProjection'])('refuses client authority field %s',key => {
    expect(() => setup().service.parse({...base,[key]:'approved'},'user-a')).toThrow('ATTENDANCE_TRIP_INVALID_INPUT')
  })
  it.each(['Invalid/Zone','+09:00',' Asia/Tokyo'])('rejects invalid named zone %s',destinationTimezone => {
    expect(() => setup().service.parse({...base,destinationTimezone},'user-a')).toThrow('ATTENDANCE_TRIP_INVALID_ZONE')
  })
  it.each(['2026-02-30T00:00:00Z','2026-11-02T24:00:00Z'])('rejects normalized invalid calendar instant %s',startAt => {
    expect(() => setup().service.parse({...base,startAt},'user-a')).toThrow('ATTENDANCE_TRIP_INVALID_INTERVAL')
  })
  it('rejects empty or backwards intervals',() => {
    for (const endAt of [base.startAt,'2026-11-01T00:00:00Z']) expect(() => setup().service.parse({...base,endAt},'user-a')).toThrow('ATTENDANCE_TRIP_INVALID_INTERVAL')
  })
  it('refuses retroactive publication before optional facts',async () => {
    const f=setup();await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-02T01:00:00Z'))).rejects.toMatchObject({status:409,code:'ATTENDANCE_TRIP_RETROACTIVE_PUBLICATION'})
    expect(f.readWindows).not.toHaveBeenCalled()
  })
  it.each([
    ['2026-11-01T23:00:00Z','2026-11-02T01:00:00Z'],
    ['2026-11-02T23:00:00Z','2026-11-03T01:00:00Z'],
  ])('rejects a boundary inside published shift %s..%s even with zero punches',async (startAt,endAt) => {
    const f=setup([{startAt:new Date(startAt),endAt:new Date(endAt)}])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({status:409,code:'ATTENDANCE_TRIP_PARTIAL_SHIFT'})
    expect(f.query).not.toHaveBeenCalled()
  })
  it.each([
    {...projectionBasis,policyVersion:1},
    {...projectionBasis,calculationGroupMembership:{id:'membership-new',version:2}},
    {...projectionBasis,rule:{...projectionBasis.rule,graceMinutes:7}},
    {...projectionBasis,calculationDefinition:{...projectionBasis.calculationDefinition,rule:{...ruleProfile,roundingMinutes:15}}},
  ])('same-zone atomic windows still reject distinct authoritative projection basis',async(changed)=>{
    const first={contextSide:'destination',projectionBasis,workDate:'2026-11-02',shiftId:'shift',
      assignmentId:'assignment',source:'shift',timezone:'Asia/Tokyo',startAt:row.start_at,endAt:row.end_at}
    const f=setup([first,{...first,projectionBasis:changed}])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z')))
      .rejects.toMatchObject({status:409,code:'ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT'})
  })
  it('a missing authoritative destination projection basis fails closed',async()=>{
    const f=setup([{contextSide:'destination',workDate:'2026-11-02',startAt:row.start_at,endAt:row.end_at}])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z')))
      .rejects.toMatchObject({status:503,code:'ATTENDANCE_TRIP_PROJECTION_BASIS_UNAVAILABLE'})
  })
  it.each([undefined,null,[]])('a missing or malformed calculation definition cannot silently weaken destination equality',async(calculationDefinition)=>{
    const f=setup([{contextSide:'destination',projectionBasis:{...projectionBasis,calculationDefinition},
      workDate:'2026-11-02',startAt:row.start_at,endAt:row.end_at}])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z')))
      .rejects.toMatchObject({status:503,code:'ATTENDANCE_TRIP_PROJECTION_BASIS_UNAVAILABLE'})
  })
  it('permits exact half-open whole shift boundaries',async () => {
    const f=setup([{startAt:row.start_at,endAt:row.end_at}])
    await f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z'))
    expect(f.query).toHaveBeenCalledTimes(1)
  })
  it('a prior first-in on the destination work date rejects a different trip source',async () => {
    const f=setup();f.query.mockResolvedValue([{id:'record'}])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({status:409,code:'ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT'})
    expect(f.query.mock.calls[0][0]).toContain("visibility_state='active'")
    expect(f.query.mock.calls[0][0]).not.toContain('last_out_at IS NULL')
    expect(f.query.mock.calls[0][1]).toEqual(['org-a','user-a','2026-11-02','2026-11-03'])
  })
  it('an original frozen shift cannot be overwritten by a new trip',async()=>{
    const f=setup();f.readFrozenWindows.mockResolvedValue([{workDate:'2026-11-01',startAt:new Date('2026-11-01T23:00:00Z'),endAt:new Date('2026-11-02T02:00:00Z')}])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({status:409,code:'ATTENDANCE_TRIP_FROZEN_CONTEXT_CONFLICT'})
    expect(f.query).not.toHaveBeenCalled()
  })
  it('a missing frozen reader fails closed before publication',async()=>{
    const service=createBusinessTripService({HttpError,readWindows:async()=>[]})
    await expect(service.assertWholeShifts({query:vi.fn()},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({status:503,code:'ATTENDANCE_TRIP_FROZEN_READER_UNAVAILABLE'})
  })
  it('missing published reader cannot silently approve',async () => {
    const service=createBusinessTripService({HttpError})
    await expect(service.assertWholeShifts({query:vi.fn()},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({status:503,code:'ATTENDANCE_TRIP_BOUNDARY_READER_UNAVAILABLE'})
  })
  it('trip reader uses scoped server instant and preserves cancelled historical effective end',async () => {
    const query=vi.fn().mockResolvedValue({rows:[{request_id:'trip',org_id:'org-a',user_id:'user-a',destination_timezone:'Asia/Tokyo',start_at:row.start_at,effective_end_at:row.end_at,version:2}]})
    expect(await readApprovedTrips({query,orgId:'org-a',userId:'user-a',occurredAt:row.start_at})).toEqual([{orgId:'org-a',userId:'user-a',referenceId:'trip',timezone:'Asia/Tokyo',version:2,approvalStatus:'approved',lifecycleStatus:'ACTIVE',startAt:row.start_at,endAt:row.end_at}])
    expect(query.mock.calls[0][1]).toEqual(['org-a','user-a',row.start_at])
    expect(query.mock.calls[0][0]).toContain('start_at <= $3 AND $3 < effective_end_at')
  })
  it('allows a multi-year interval without inventing an extra business limit',() => {
    expect(setup().service.parse({...base,endAt:'2028-11-03T00:00:00Z'},'user-a').endAt).toBe('2028-11-03T00:00:00.000Z')
  })
  it('invalid published end cannot silently pass a whole-shift guard',async() => {
    const f=setup([{startAt:row.start_at,endAt:new Date('invalid')}])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({code:'ATTENDANCE_TRIP_INVALID_SHIFT_WINDOW'})
  })
  it('cancellation preserves an already started published shift without punches',async() => {
    const now=new Date('2026-11-02T10:00:00Z'), end=new Date('2026-11-02T18:00:00Z')
    const f=setup([{startAt:new Date('2026-11-02T09:00:00Z'),endAt:end}])
    f.query.mockResolvedValueOnce([{...row,request_id:'trip',published_at:row.start_at,effective_end_at:row.end_at,cancelled_at:null}]).mockResolvedValueOnce([{request_id:'trip'}])
    await f.service.cancel({query:f.query},{id:'trip',org_id:'org-a'},now)
    expect(f.query.mock.calls[1][1]).toEqual(['trip','org-a',end,now])
  })
  it('future cancellation retains an empty half-open history row',async() => {
    const now=new Date('2026-11-01T10:00:00Z'),f=setup()
    f.query.mockResolvedValueOnce([{...row,request_id:'trip',published_at:now,effective_end_at:row.end_at,cancelled_at:null}]).mockResolvedValueOnce([{request_id:'trip'}])
    await f.service.cancel({query:f.query},{id:'trip',org_id:'org-a'},now)
    expect(f.query.mock.calls[1][1]).toEqual(['trip','org-a',row.start_at,now])
  })
  it('a read-only policy projection uses actual before facts and projected after facts without writes',async()=>{
    const f=setup(),policyProjection={orgId:'org-a',enabled:true,expectedVersion:0}
    f.query.mockResolvedValue([{...row,request_id:'request',effective_end_at:row.end_at}])
    f.readWindows.mockImplementation(async (_trx:unknown,input:{policyProjection?:unknown})=>input.policyProjection
      ? [{startAt:new Date('2026-11-01T23:00:00Z'),endAt:new Date('2026-11-02T01:00:00Z')}]
      : [])
    const verify=await f.service.prepareSourceChange({query:f.query},{orgId:'org-a',
      now:new Date('2026-11-01T00:00:00Z'),acquireLocks:vi.fn(),policyProjection})
    expect(f.readWindows.mock.calls[0][1]).not.toHaveProperty('policyProjection')
    await expect(verify()).rejects.toMatchObject({status:409,code:'ATTENDANCE_TRIP_PARTIAL_SHIFT'})
    expect(f.readWindows.mock.calls[1][1].policyProjection).toBe(policyProjection)
    expect(f.query).toHaveBeenCalledOnce()
    expect(f.query.mock.calls[0][0]).toMatch(/^SELECT /)
  })
  it('a benign future source change is permitted after ordered locks and strict revalidation',async() => {
    const f=setup([{startAt:row.start_at,endAt:row.end_at}]),acquireLocks=vi.fn()
    f.query.mockResolvedValue([{...row,request_id:'trip',effective_end_at:row.end_at}])
    const verify=await f.service.prepareSourceChange({query:f.query},{orgId:'org-a',acquireLocks,now:new Date('2026-11-01T00:00:00Z')})
    expect(acquireLocks.mock.calls).toEqual([[{query:f.query},{orgId:'org-a',userId:'user-a',mode:'exclusive'}]])
    await verify();expect(f.readWindows).toHaveBeenCalledTimes(2)
  })
  it('a source edit introducing a partial trip boundary rolls back',async() => {
    const f=setup(),acquireLocks=vi.fn()
    f.query.mockResolvedValue([{...row,request_id:'trip',effective_end_at:row.end_at}])
    const verify=await f.service.prepareSourceChange({query:f.query},{orgId:'org-a',acquireLocks,now:new Date('2026-11-01T00:00:00Z')})
    f.readWindows.mockResolvedValue([{startAt:new Date('2026-11-01T23:00:00Z'),endAt:new Date('2026-11-02T01:00:00Z')}])
    await expect(verify()).rejects.toMatchObject({code:'ATTENDANCE_TRIP_PARTIAL_SHIFT',status:409})
  })
  it('a source edit cannot change a started no-punch published shift',async() => {
    const f=setup([{workDate:'2026-11-02',shiftId:'shift',timezone:'Asia/Tokyo',startAt:row.start_at,endAt:row.end_at}]),acquireLocks=vi.fn()
    f.query.mockResolvedValue([{...row,request_id:'trip',effective_end_at:row.end_at}])
    const verify=await f.service.prepareSourceChange({query:f.query},{orgId:'org-a',acquireLocks,now:new Date('2026-11-02T10:00:00Z')})
    f.readWindows.mockResolvedValue([])
    await expect(verify()).rejects.toMatchObject({code:'ATTENDANCE_TRIP_STARTED_SHIFT_CHANGED',status:409})
  })

  it.each(['Asia/Tokyo','UTC'])('refuses same-work-date trip/base contexts even when zone is %s',async timezone=>{
    const f=setup([
      {contextSide:'destination',projectionBasis,workDate:'2026-11-02',shiftId:'a',assignmentId:'a',timezone:'Asia/Tokyo',startAt:new Date('2026-11-02T09:00:00Z'),endAt:new Date('2026-11-02T12:00:00Z')},
      {contextSide:'outside',workDate:'2026-11-02',shiftId:'b',assignmentId:'b',timezone,startAt:new Date('2026-11-01T22:00:00Z'),endAt:new Date('2026-11-01T23:00:00Z')},
    ])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({code:'ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT',status:409})
  })
  it('refuses distinct atomic assignments within one trip work date',async()=>{
    const f=setup([
      {contextSide:'destination',projectionBasis,workDate:'2026-11-02',shiftId:'a',assignmentId:'a',startAt:new Date('2026-11-02T09:00:00Z'),endAt:new Date('2026-11-02T12:00:00Z')},
      {contextSide:'destination',projectionBasis,workDate:'2026-11-02',shiftId:'b',assignmentId:'b',startAt:new Date('2026-11-02T13:00:00Z'),endAt:new Date('2026-11-02T18:00:00Z')},
    ])
    await expect(f.service.assertWholeShifts({query:f.query},row,new Date('2026-11-01T00:00:00Z'))).rejects.toMatchObject({code:'ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT',status:409})
  })

  it('same-zone started window still rejects changed canonical provenance',async()=>{
    const window={workDate:'2026-11-02',shiftId:'shift',timezone:'Asia/Tokyo',startAt:row.start_at,endAt:row.end_at,contextFingerprint:'before'}
    const f=setup([window]),acquireLocks=vi.fn(),now=new Date('2026-11-02T10:00:00Z')
    f.query.mockResolvedValue([{...row,request_id:'trip',effective_end_at:row.end_at}])
    const verify=await f.service.prepareSourceChange({query:f.query},{orgId:'org-a',acquireLocks,now})
    expect(f.readWindows.mock.calls.some(([,input])=>input.from.getTime()===now.getTime()&&input.to.getTime()===now.getTime()+1)).toBe(true)
    f.readWindows.mockResolvedValue([{...window,contextFingerprint:'after'}])
    await expect(verify()).rejects.toMatchObject({code:'ATTENDANCE_TRIP_STARTED_SHIFT_CHANGED',status:409})
  })
  it('started cancellation preserves the work date through its counterfactual base window',async()=>{
    const now=new Date('2026-11-02T02:00:00Z'),cutoff=new Date('2026-11-02T18:00:00Z')
    const f=setup([
      {workDate:'2026-11-02',contextSide:'destination',projectionBasis,startAt:row.start_at,endAt:new Date('2026-11-02T09:00:00Z')},
      {workDate:'2026-11-02',contextSide:'outside',startAt:new Date('2026-11-02T09:00:00Z'),endAt:cutoff},
    ])
    f.query.mockResolvedValueOnce([{...row,request_id:'trip',published_at:row.start_at,effective_end_at:row.end_at,cancelled_at:null}]).mockResolvedValueOnce([{request_id:'trip'}])
    await f.service.cancel({query:f.query},{id:'trip',org_id:'org-a'},now)
    expect(f.query.mock.calls[1][1]).toEqual(['trip','org-a',cutoff,now])
    expect(f.readWindows.mock.calls.every(([,input])=>input.excludeTripRequestId==='trip')).toBe(true)
  })
  it('started cancellation preserves the original frozen window even if live candidates changed',async()=>{
    const now=new Date('2026-11-02T02:00:00Z'),cutoff=new Date('2026-11-02T18:00:00Z'),f=setup([])
    f.readFrozenWindows.mockResolvedValue([{workDate:'2026-11-02',startAt:row.start_at,endAt:cutoff}])
    f.query.mockResolvedValueOnce([{...row,request_id:'trip',published_at:row.start_at,effective_end_at:row.end_at,cancelled_at:null}]).mockResolvedValueOnce([{request_id:'trip'}])
    await f.service.cancel({query:f.query},{id:'trip',org_id:'org-a'},now)
    expect(f.query.mock.calls[1][1]).toEqual(['trip','org-a',cutoff,now])
  })
  it('cancellation refuses a counterfactual that would extend beyond its approved end',async()=>{
    const now=new Date('2026-11-02T02:00:00Z'),f=setup([
      {workDate:'2026-11-02',startAt:row.start_at,endAt:new Date('2026-11-02T09:00:00Z')},
      {workDate:'2026-11-02',startAt:new Date('2026-11-02T09:00:00Z'),endAt:new Date('2026-11-04T00:00:00Z')},
    ])
    f.query.mockResolvedValueOnce([{...row,request_id:'trip',published_at:row.start_at,effective_end_at:row.end_at,cancelled_at:null}])
    await expect(f.service.cancel({query:f.query},{id:'trip',org_id:'org-a'},now)).rejects.toMatchObject({code:'ATTENDANCE_TRIP_CANCELLATION_BOUNDARY_CONFLICT',status:409})
    expect(f.query).toHaveBeenCalledTimes(1)
  })

})
