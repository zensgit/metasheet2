import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { readAttendanceCalc14SourceVersionV1, readAttendanceCalc14UserPublicationV1, readAttendanceCalc14GroupSourcesV1 } from '../../src/attendance/attendance-calc14-source-history'
import { assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1 } from '../../src/attendance/attendance-calc14-source-write-context'

const require = createRequire(import.meta.url)
const { createAttendanceCalc14SourceHistory } =
  require('../../../../plugins/plugin-attendance/lib/attendance-calc14-source-history.cjs')

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const today = '2026-10-30'
function writer(state = 'group_authoritative') {
  const loadDefaultRule = vi.fn(async () => ({timezone:'UTC'}))
  return {loadDefaultRule, service:createAttendanceCalc14SourceHistory({
    HttpError,loadDefaultRule,assertOrdinaryBusinessEffectiveDate:assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1,resolveGroupArm:async () => ({effectiveState:state,selectsGroupArm:state==='group_authoritative'}),
    toWorkDate:(instant:Date) => instant.toISOString().slice(0,10),now:() => new Date(today+'T12:00:00Z'),
  })}
}

describe('CALC14 explicit ordinary date boundary', () => {
  it.each(['2026-02-30','2026-2-01','0000-01-01','2026-10-30T00:00:00Z','',null,42])('rejects invalid date %s', value => {
    expect(() => assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1(value,today)).toThrow('ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID')
  })
  it('requires separate historical authority, never derives a date from a schedule window', () => {
    expect(() => assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1('2026-10-29',today)).toThrow('ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED')
    expect(assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1('2026-10-31',today)).toBe('2026-10-31')
  })
  it('OFF ignores optional field and emits no application history SQL', async () => {
    const {service,loadDefaultRule}=writer('off')
    const query=vi.fn()
    await (await service.prepare({query},{orgId:'org',businessEffectiveDate:'invalid'}))()
    expect(query).not.toHaveBeenCalled()
    expect(loadDefaultRule).not.toHaveBeenCalled()
  })
  it.each(['group_shadow','group_eligible','group_authoritative','suspended'])('uses existing %s gate with no default date', async state => {
    const query=vi.fn(async (_text:string,_values?:unknown[]) => [])
    const {service}=writer(state)
    await service.prepare({query},{orgId:'org'})
    expect(query.mock.calls).toHaveLength(1)
    expect(query.mock.calls[0][0]).toContain("set_config('metasheet.calc14_date_required'")
    expect(query.mock.calls[0][1]).toEqual(['org','true'])
    expect(query.mock.calls[0][0]).not.toContain('calc14_business_effective_date')
  })
  it('validates before setting date context and maps storage conflict values-free', async () => {
    const query=vi.fn(async (_text:string,_values?:unknown[]) => [])
    const {service}=writer()
    await expect(service.prepare({query},{orgId:'org',businessEffectiveDate:'2026-10-29'}))
      .rejects.toMatchObject({status:403,code:'ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED'})
    expect(query).not.toHaveBeenCalled()
    const finish=await service.prepare({query},{orgId:'org',businessEffectiveDate:today})
    query.mockRejectedValueOnce({code:'23514',message:'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT'})
    await expect(finish()).rejects.toMatchObject({status:409,code:'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT'})
  })
})

describe('CALC14 unique source selection', () => {
  it('missing history returns null with an org-scoped date query and no current fallback', async () => {
    const query=vi.fn(async (_text:string,_values?:unknown[]) => ({rows:[]}))
    expect(await readAttendanceCalc14SourceVersionV1({query},{orgId:'a',kind:'shift',sourceId:'s',workDate:today})).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual(['a','shift','s',today])
    expect(query.mock.calls[0][0]).toContain("gap.event_kind='unversioned_change'")
  })
  it('does not choose an arbitrary winner for duplicate applicable input', async () => {
    const query=vi.fn(async () => ({rows:[{payload:{}},{payload:{}}]}))
    await expect(readAttendanceCalc14SourceVersionV1({query},{orgId:'a',kind:'shift',sourceId:'s',workDate:today}))
      .rejects.toThrow('ATTENDANCE_CALC14_SOURCE_HISTORY_AMBIGUOUS')
  })

})

const {createAttendanceCalc14ImportPolicy}=require('../../../../plugins/plugin-attendance/lib/attendance-calc14-import-policy.cjs')
describe('CALC14 native retained policy identity',()=>{
  it('keeps org/date/source-version in the native config and engine cache key',async ()=>{
    const snapshots=[
      {ruleSet:{id:'r',__calc14_version:1,config:{engine:{rules:[]}}},rule:{__calc14_version:7}},
      {ruleSet:{id:'r',__calc14_version:2,config:{engine:{rules:[]}}},rule:{__calc14_version:8}},
    ]
    const sourceReader={loadPublishedCandidates:vi.fn(async ()=>[{calc14Sources:snapshots.shift()}])}
    const service=createAttendanceCalc14ImportPolicy({HttpError,sourceReader})
    const a=await service.load({}, {orgId:'one',userId:'u',workDate:'2026-01-01',payload:{ruleSetId:'r'}})
    const b=await service.load({}, {orgId:'one',userId:'u',workDate:'2026-02-01',payload:{ruleSetId:'r'}})
    expect(JSON.parse(a.cacheKey)).toEqual(['one','r',1,'2026-01-01'])
    expect(JSON.parse(b.cacheKey)).toEqual(['one','r',2,'2026-02-01'])
    expect(a.ruleVersion).toBe('rule-set:r:source-version:1')
  })
  it('rejects a caller selecting a different current rule-set instead of the retained group source',async ()=>{
    const service=createAttendanceCalc14ImportPolicy({HttpError,sourceReader:{loadPublishedCandidates:async ()=>[
      {calc14Sources:{ruleSet:{id:'historical',__calc14_version:1,config:{}},rule:{__calc14_version:1}}},
    ]}})
    await expect(service.load({}, {orgId:'one',userId:'u',workDate:'2026-01-01',payload:{ruleSetId:'current'}}))
      .rejects.toMatchObject({status:409,code:'ATTENDANCE_CALC14_RULE_SET_SOURCE_MISMATCH'})
  })
})

const {createAttendanceCalc14CapabilityReader}=require('../../../../plugins/plugin-attendance/lib/attendance-calc14-source-history.cjs')
function capabilityReader(state:string) {
  const resolveGroupArm=vi.fn(async (_trx:unknown,_orgId:string)=>({effectiveState:state,selectsGroupArm:state==='group_authoritative'}))
  return {resolveGroupArm,reader:createAttendanceCalc14CapabilityReader({HttpError,resolveGroupArm})}
}
describe('CALC14 advisory date capability metadata',()=>{
  it.each(['group_shadow','group_eligible','group_authoritative','suspended'])('adds exact true from trusted %s without replacing old capabilities/org',async state=>{
    const {reader,resolveGroupArm}=capabilityReader(state)
    const trx={query:vi.fn()}
    const items=[{id:'g',orgId:'trusted'},{id:'s',orgId:'trusted',capabilities:{segmentCalculation:false,existing:'retained'}}]
    expect(await reader.decorateItems(trx,{orgId:'trusted',items})).toEqual([
      {id:'g',orgId:'trusted',capabilities:{businessEffectiveDateRequired:true}},
      {id:'s',orgId:'trusted',capabilities:{segmentCalculation:false,existing:'retained',businessEffectiveDateRequired:true}},
    ])
    expect(resolveGroupArm).toHaveBeenCalledTimes(1)
    expect(resolveGroupArm).toHaveBeenCalledWith(trx,'trusted')
    expect(trx.query).not.toHaveBeenCalled()
    expect(items[0]).toEqual({id:'g',orgId:'trusted'})
  })
  it('OFF keeps exact list item objects, old capabilities and default-rule fallback bytes',async ()=>{
    const {reader}=capabilityReader('off')
    const items=[{id:'g',orgId:'trusted'},{id:'s',orgId:'trusted',capabilities:{segmentCalculation:true}}]
    const before=JSON.stringify(items)
    expect(await reader.decorateItems({}, {orgId:'trusted',items})).toBe(items)
    expect(JSON.stringify(items)).toBe(before)
    const fallback={orgId:'legacy-default',timezone:'UTC'}
    expect(await reader.decorateOrgData({}, {orgId:'trusted',data:fallback})).toBe(fallback)
    expect(await reader.requirementForOrg({},'trusted')).toBe(false)
  })
  it('binds rule metadata to authenticated org and refuses borrowing another org default',async ()=>{
    const {reader}=capabilityReader('group_shadow')
    const data={orgId:'trusted',timezone:'UTC',capabilities:{existing:false}}
    expect(await reader.decorateOrgData({}, {orgId:'trusted',data})).toEqual({
      orgId:'trusted',timezone:'UTC',capabilities:{existing:false,businessEffectiveDateRequired:true},
    })
    await expect(reader.decorateOrgData({}, {orgId:'trusted',data:{orgId:'other'}}))
      .rejects.toMatchObject({status:403,code:'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID'})
  })
  it('refuses foreign list items before reading any posture for them',async ()=>{
    const {reader,resolveGroupArm}=capabilityReader('group_authoritative')
    await expect(reader.decorateItems({}, {orgId:'trusted',items:[{orgId:'other',capabilities:{segmentCalculation:true}}]}))
      .rejects.toMatchObject({status:403,code:'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID'})
    expect(resolveGroupArm).not.toHaveBeenCalled()
  })
  it.each([null,{}, {effectiveState:'unknown',selectsGroupArm:false},
    {effectiveState:'off',selectsGroupArm:'false'}, {effectiveState:'suspended',selectsGroupArm:true}])('refuses unknown/malformed posture without inferring metadata',async arm=>{
    const reader=createAttendanceCalc14CapabilityReader({HttpError,resolveGroupArm:async ()=>arm})
    await expect(reader.decorateItems({}, {orgId:'trusted',items:[{orgId:'trusted'}]}))
      .rejects.toMatchObject({status:503,code:'ATTENDANCE_CALC14_SOURCE_POSTURE_UNAVAILABLE'})
  })
  it('does not turn public resolver failure into OFF or active metadata',async ()=>{
    const reader=createAttendanceCalc14CapabilityReader({HttpError,resolveGroupArm:async ()=>{throw new Error('W7_CONTEXT_SOURCE_STATE_AMBIGUOUS')}})
    await expect(reader.requirementForOrg({},'trusted'))
      .rejects.toMatchObject({status:503,code:'ATTENDANCE_CALC14_SOURCE_POSTURE_UNAVAILABLE'})
  })
  it('wires advisory metadata to the actual public W7 port and authenticated existing routes',()=>{
    const source=readFileSync(new URL('../../../../plugins/plugin-attendance/index.cjs',import.meta.url),'utf8')
    const start=source.indexOf('const attendanceCalc14CapabilityReader = createAttendanceCalc14CapabilityReader(')
    const binding=source.slice(start,source.indexOf('const attendanceCalc14ImportPolicy =',start))
    expect(start).toBeGreaterThan(0)
    expect(binding).toContain('attendanceW4SegmentCalculationPortRef.resolveAttendanceW7GroupArmSelectionV1({ query: pluginQueryAdapter(trx) }, orgId)')
    expect(binding).not.toContain('referenceSegments')
    const groups=source.slice(source.indexOf("'/api/attendance/groups',\n      async (req, res) => {"),source.indexOf("'/api/attendance/groups/:id'",source.indexOf("'/api/attendance/groups',\n      async (req, res) => {")))
    expect(groups).toContain('const orgId = routeActorAccess.orgId')
    expect(groups).toContain('attendanceCalc14CapabilityReader.decorateItems(db, { orgId, items: rows.map(mapAttendanceGroupRow) })')
    const shifts=source.slice(source.indexOf("'/api/attendance/shifts',\n      withPermission('attendance:admin'"),source.indexOf("'/api/attendance/shifts/:id'",source.indexOf("'/api/attendance/shifts',\n      withPermission('attendance:admin'")))
    expect(shifts).toContain('const orgId = actorAccess.orgId')
    expect(shifts).toContain('attendanceCalc14CapabilityReader.decorateItems(db, { orgId, items: data.items })')
    const rule=source.slice(source.indexOf("'/api/attendance/rules/default',\n      withPermission('attendance:read'"),source.indexOf("'/api/attendance/rules/default',\n      withPermission('attendance:admin'"))
    expect(rule).toContain('const orgId = routeActorAccess.orgId')
    expect(rule).toContain('attendanceCalc14CapabilityReader.decorateOrgData(db, { orgId, data: rule })')
  })
})


const {createAttendanceCalc14SourceReader}=require('../../../../plugins/plugin-attendance/lib/attendance-calc14-source-reader.cjs')
const {createAttendanceTimezoneContextLoader}=require('../../../../plugins/plugin-attendance/lib/attendance-timezone-context-loader.cjs')
describe('CALC14 Rawls source counterexamples',()=>{
  it('passes a real query client into the core history reader, including missing-history failure',async ()=>{
    const db={query:vi.fn(async (_text:string,_values?:unknown[])=>[])}
    const reader=createAttendanceCalc14SourceReader({
      HttpError,port:()=>({acquireTimezoneRuntimeLocks:async ()=>{},
        readAttendanceCalc14UserPublicationV1,readAttendanceCalc14GroupSourcesV1}),
      pluginQueryAdapter:(client:typeof db)=>async (text:string,values?:unknown[])=>({rows:await client.query(text,values)}),
    })
    await expect(reader.readForUser(db,{orgId:'org',userId:'subject',workDate:'2026-02-16'}))
      .rejects.toMatchObject({status:422,code:'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE'})
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query.mock.calls[0][1]).toEqual(['org','user_publication','subject','2026-02-16'])
  })
  it.each(['deleted','replaced'])('uses retained W1 when current membership is %s',async state=>{
    const currentMemberships=state==='deleted' ? [] : [{id:'current-membership',org_id:'org',user_id:'subject',
      group_id:'current-group',effective_from:'2026-01-01',effective_to:null}]
    const query=vi.fn(async ()=>({rows:currentMemberships}))
    const loader=createAttendanceTimezoneContextLoader({
      query,policyStore:{
        readPolicy:vi.fn(),readDefault:vi.fn(),readEmployeeOverride:async ()=>null,
      },
      readCalc14Sources:async ()=>({
        group:{id:'historical-group',org_id:'org',timezone:'Asia/Taipei',__calc14_version:12},
        rule:{timezone:'UTC',__calc14_version:7,calc14_timezone_policy:{enabled:true,version:1}},
        userPublication:{memberships:[{id:'historical-membership',group_id:'historical-group',
          effective_from:'2026-01-01',effective_to:'2026-02-28'}],assignments:[],rotations:[]},
      }),
    })
    const result=await loader({orgId:'org',userId:'subject',workDate:'2026-02-16',occurredAt:new Date('2026-02-16T02:00:00Z')})
    expect({timezone:result.timezone,source:result.source,mode:result.mode,referenceId:result.referenceId,
      version:result.version,membership:result.calculationGroupMembership}).toEqual({
      timezone:'Asia/Taipei',source:'calculation_group',mode:'multi_timezone',referenceId:'historical-group',version:12,
      membership:{membershipId:'historical-membership',groupId:'historical-group',
        effectiveFrom:'2026-01-01',effectiveTo:'2026-02-28'},
    })
    expect(query).not.toHaveBeenCalled()
  })
})
