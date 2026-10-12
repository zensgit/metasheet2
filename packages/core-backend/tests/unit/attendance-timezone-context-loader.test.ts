import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type Row = Record<string, unknown>
type Query = (sql: string, values: unknown[]) => Promise<{ rows: Row[] }>
type Load = (input: Row) => Promise<Row>
const { createAttendanceTimezoneContextLoader: create } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-context-loader.cjs',
) as { createAttendanceTimezoneContextLoader: (deps: {
  query: Query, policyStore: Record<string, (input: Row) => Promise<unknown>>,
  readApprovedTrips?: (input: Row) => Promise<unknown>,
}) => Load }
const at = new Date('2026-10-12T00:30:00Z')
const workDate = '2026-10-11'
const base = { orgId: 'org-a', userId: 'user-a', occurredAt: at, workDate }
const systemDefault = { orgId: 'org-a', referenceId: 'default-a', timezone: 'Asia/Singapore', version: 7 }
const employee = {
  orgId: 'org-a', userId: 'user-a', referenceId: 'employee-a', timezone: 'Asia/Tokyo', version: 5,
  effectiveFrom: new Date('2026-10-12T00:00:00Z'), effectiveTo: new Date('2026-10-13T00:00:00Z'),
}
function membership(change: Row = {}): Row {
  return { id: 'membership-a', org_id: 'org-a', user_id: 'user-a', group_id: 'group-a',
    effective_from: '2026-10-01', effective_to: '2026-10-11', ...change }
}
const group = { id: 'group-a', org_id: 'org-a', timezone: 'Europe/London' }
function setup(enabled = true, responses: Row[][] = []) {
  const query = vi.fn<Parameters<Query>, ReturnType<Query>>()
  for (const rows of responses) query.mockResolvedValueOnce({ rows })
  query.mockResolvedValue({ rows: [] })
  const policyStore = {
    readPolicy: vi.fn().mockResolvedValue({ enabled, version: 3 }),
    readDefault: vi.fn().mockResolvedValue(systemDefault),
    readEmployeeOverride: vi.fn().mockResolvedValue(null),
  }
  return { query, policyStore, load: create({ query, policyStore }) }
}
function error(code: string, status = 422): Row {
  return { code: 'ATTENDANCE_TIMEZONE_' + code, message: 'ATTENDANCE_TIMEZONE_' + code, status }
}
function selected(source = 'system_default', timezone = 'Asia/Singapore', referenceId = 'default-a', version = 7,
  mode = 'multi_timezone', calculationGroupMembership: Row | null = null): Row {
  return { status: 'selected', source, timezone, referenceId, version, mode, policyVersion: 3,
    resolvedForInstant: at, targetWorkDate: workDate, calculationGroupMembership }
}

describe('D2 authoritative timezone context loader', () => {
  it('OFF returns strict default and never queries overrides, groups or future trips', async () => {
    const { query, policyStore } = setup(false)
    const trips = vi.fn().mockRejectedValue(new Error('PRIVATE_SENTINEL'))
    const load = create({ query, policyStore, readApprovedTrips: trips })
    expect(await load(base)).toEqual(selected('system_default', 'Asia/Singapore', 'default-a', 7, 'default_only'))
    expect(policyStore.readPolicy.mock.calls).toEqual([[{ orgId: 'org-a' }]])
    expect(policyStore.readDefault.mock.calls).toEqual([[{ orgId: 'org-a' }]])
    expect(policyStore.readEmployeeOverride).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(trips).not.toHaveBeenCalled()
  })
  it('missing policy means OFF/v0 while default still carries its governed real revision', async () => {
    const { load, policyStore } = setup(false)
    policyStore.readPolicy.mockResolvedValue({ enabled: false, version: 0 })
    expect(await load(base)).toEqual({ ...selected('system_default', 'Asia/Singapore', 'default-a', 7, 'default_only'), policyVersion: 0 })
  })
  it.each(['readPolicy', 'readDefault', 'readEmployeeOverride'] as const)('raw %s failure is 503, never absence or fallback', async key => {
    const { load, policyStore } = setup()
    policyStore[key].mockRejectedValue(new Error('PRIVATE_SENTINEL'))
    await expect(load(base)).rejects.toMatchObject(error('SOURCE_UNAVAILABLE', 503))
  })
  it('even OFF rejects an invalid/cross-org strict default before optional source reads', async () => {
    for (const change of [{ orgId: 'org-b' }, { timezone: 'Invalid/Sentinel' }, { version: 0 }]) {
      const { load, policyStore, query } = setup(false)
      policyStore.readDefault.mockResolvedValue({ ...systemDefault, ...change })
      await expect(load(base)).rejects.toMatchObject({ status: 422 })
      expect(query).not.toHaveBeenCalled()
      expect(policyStore.readEmployeeOverride).not.toHaveBeenCalled()
    }
  })
  it.each([undefined, null, 'true', 1])('rejects nonboolean authoritative policy %s', enabled => {
    const { load, policyStore } = setup()
    policyStore.readPolicy.mockResolvedValue({ enabled, version: 1 })
    return expect(load(base)).rejects.toMatchObject(error('INVALID_ENABLED'))
  })
  it.each([0, '1', 1.5, -1, Number.MAX_SAFE_INTEGER + 1])('rejects enabled policy revision %s', version => {
    const { load, policyStore } = setup()
    policyStore.readPolicy.mockResolvedValue({ enabled: true, version })
    return expect(load(base)).rejects.toMatchObject(error('INVALID_REVISION'))
  })
  it('ON with no employee or calculation membership inherits exact default, not display groups', async () => {
    const { load, query, policyStore } = setup()
    expect(await load(base)).toEqual(selected())
    expect(policyStore.readEmployeeOverride.mock.calls).toEqual([[{ orgId: 'org-a', userId: 'user-a', at }]])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('FROM attendance_calculation_group_memberships')
    expect(query.mock.calls[0][0]).not.toContain('attendance_group_members ')
    expect(query.mock.calls[0][1]).toEqual(['org-a', 'user-a', '2026-10-11'])
    expect(query.mock.calls[0][0]).toContain('effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)')
  })
  it('ON employee authority uses UTC instant separately from target workDate', async () => {
    const { load, policyStore } = setup()
    policyStore.readEmployeeOverride.mockResolvedValue(employee)
    expect(await load(base)).toEqual(selected('employee_override', 'Asia/Tokyo', 'employee-a', 5))
  })
  it('selects target-date calculation group with actual org-wide revision and separate membership bounds', async () => {
    const { load, query } = setup(true, [[membership()], [group], [{ revision: '19' }]])
    const provenance = { membershipId: 'membership-a', groupId: 'group-a', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-11' }
    expect(await load(base)).toEqual(selected('calculation_group', 'Europe/London', 'group-a', 19, 'multi_timezone', provenance))
    expect(query.mock.calls[1]).toEqual([
      'SELECT id, org_id, timezone FROM attendance_groups WHERE id = $1 AND org_id = $2', ['group-a', 'org-a'],
    ])
    expect(query.mock.calls[2]).toEqual([
      'SELECT revision FROM attendance_group_effect_revisions WHERE org_id = $1', ['org-a'],
    ])
  })
  it('employee wins a valid group while separate membership provenance remains available', async () => {
    const { load, policyStore } = setup(true, [[membership()], [group], [{ revision: '19' }]])
    policyStore.readEmployeeOverride.mockResolvedValue(employee)
    expect(await load(base)).toEqual(selected('employee_override', 'Asia/Tokyo', 'employee-a', 5, 'multi_timezone', {
      membershipId: 'membership-a', groupId: 'group-a', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-11',
    }))
  })
  it('an absent group timezone inherits default but never manufactures group revision', async () => {
    const { load } = setup(true, [[membership()], [{ ...group, timezone: null }], [{ revision: '6' }]])
    expect(await load(base)).toEqual(selected('system_default', 'Asia/Singapore', 'default-a', 7, 'multi_timezone', {
      membershipId: 'membership-a', groupId: 'group-a', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-11',
    }))
  })
  it.each([0, '0', null, undefined, '1.5', '01', '9007199254740992', Number.MAX_SAFE_INTEGER + 1])('refuses invalid/lossy org group revision %s', revision => {
    const { load } = setup(true, [[membership()], [group], [{ revision }]])
    return expect(load(base)).rejects.toMatchObject(error('INVALID_GROUP_REVISION'))
  })
  it('refuses missing real group revision instead of using 1 or updated_at', async () => {
    const { load } = setup(true, [[membership()], [{ ...group, updated_at: at }], []])
    await expect(load(base)).rejects.toMatchObject(error('GROUP_REVISION_REQUIRED'))
  })
  it('refuses multiple effective memberships regardless of row order or employee precedence', async () => {
    for (const rows of [[membership(), membership({ id: 'membership-b' })], [membership({ id: 'membership-b' }), membership()]]) {
      const { load, policyStore, query } = setup(true, [rows, [group], [{ revision: '7' }]])
      policyStore.readEmployeeOverride.mockResolvedValue(employee)
      await expect(load(base)).rejects.toMatchObject(error('MULTIPLE_CALCULATION_GROUPS', 409))
      expect(query).toHaveBeenCalledTimes(1)
    }
  })
  it.each([
    { org_id: 'org-b' }, { user_id: 'user-b' }, { id: '' }, { group_id: '' },
    { effective_from: '2026-10-12' }, { effective_to: '2026-10-10' }, { effective_to: '2026-02-30' },
  ])('refuses invalid membership frame %j', change => {
    const { load, query } = setup(true, [[membership(change)]])
    return expect(load(base)).rejects.toMatchObject(error('INVALID_REFERENCE')).then(() => {
      expect(query).toHaveBeenCalledTimes(1)
    })
  })
  it('missing or cross-org group never falls back to default', async () => {
    const absent = setup(true, [[membership()], []])
    await expect(absent.load(base)).rejects.toMatchObject(error('GROUP_REQUIRED'))
    const foreign = setup(true, [[membership()], [{ ...group, org_id: 'org-b' }]])
    await expect(foreign.load(base)).rejects.toMatchObject(error('INVALID_REFERENCE'))
  })
  it.each([0, 1, 2])('group/membership/revision database failure after %s reads is 503', async count => {
    const query = vi.fn<Parameters<Query>, ReturnType<Query>>()
    for (const row of [membership(), group].slice(0, count)) query.mockResolvedValueOnce({ rows: [row] })
    query.mockRejectedValue(new Error('PRIVATE_SENTINEL'))
    const { policyStore } = setup()
    const load = create({ query, policyStore })
    await expect(load(base)).rejects.toMatchObject(error('SOURCE_UNAVAILABLE', 503))
  })
  it.each([
    { orgId: 'org-b' }, { userId: 'user-b' }, { effectiveFrom: new Date('2026-10-12T01:00:00Z') },
    { effectiveTo: at }, { effectiveTo: undefined },
  ])('refuses stale/cross-subject employee frame %j', change => {
    const { load, policyStore } = setup()
    policyStore.readEmployeeOverride.mockResolvedValue({ ...employee, ...change })
    return expect(load(base)).rejects.toMatchObject(error('INVALID_EMPLOYEE_INTERVAL'))
  })
  it.each(['2026-02-30', '2026-2-03', '2026-10-11T00:00:00Z', '', null])('requires an explicit valid target workDate %s', date => {
    const { load, query } = setup()
    return expect(load({ ...base, workDate: date })).rejects.toMatchObject(error('INVALID_WORK_DATE')).then(() => {
      expect(query).not.toHaveBeenCalled()
    })
  })
  it('does not accept client date strings as server UTC instants', async () => {
    const { load } = setup()
    await expect(load({ ...base, occurredAt: '2026-10-12T00:30:00Z' })).rejects.toMatchObject(error('INVALID_INSTANT'))
  })
  it('future approved-trip reader receives only trusted selectors and selected trip outranks employee', async () => {
    const { query, policyStore } = setup()
    policyStore.readEmployeeOverride.mockResolvedValue(employee)
    const trip = { orgId: 'org-a', userId: 'user-a', referenceId: 'trip-a', timezone: 'America/New_York', version: 12,
      approvalStatus: 'approved', lifecycleStatus: 'ACTIVE', startAt: new Date('2026-10-12T00:00:00Z'), endAt: new Date('2026-10-13T00:00:00Z') }
    const trips = vi.fn().mockResolvedValue([trip])
    const load = create({ query, policyStore, readApprovedTrips: trips })
    expect(await load({ ...base, trips: [{ timezone: 'Invalid/Client' }], timezone: 'Invalid/Client' }))
      .toEqual(selected('trip', 'America/New_York', 'trip-a', 12))
    expect(trips.mock.calls).toEqual([[{ query, orgId: 'org-a', userId: 'user-a', occurredAt: at, workDate }]])
  })
  it('invalid chosen group timezone never becomes inheritance', async () => {
    const { load } = setup(true, [[membership()], [{ ...group, timezone: 'Invalid/Sentinel' }], [{ revision: '2' }]])
    await expect(load(base)).rejects.toMatchObject(error('INVALID_ZONE'))
  })
  it('future store with two eligible approved trips refuses equal-zone ambiguity', async () => {
    const { query, policyStore } = setup()
    const trip = { ...employee, referenceId: 'trip-a', approvalStatus: 'approved', lifecycleStatus: 'ACTIVE',
      startAt: employee.effectiveFrom, endAt: employee.effectiveTo }
    const load = create({ query, policyStore, readApprovedTrips: async () => [trip, { ...trip, referenceId: 'trip-b' }] })
    await expect(load(base)).rejects.toMatchObject(error('MULTIPLE_TRIPS', 409))
  })
  it('future trip errors/malformed/ambiguous/cross-org rows are never treated as no trip', async () => {
    for (const value of [null, [{ orgId: 'org-b' }]]) {
      const { query, policyStore } = setup()
      const load = create({ query, policyStore, readApprovedTrips: async () => value })
      await expect(load(base)).rejects.toMatchObject({ status: 422 })
    }
    const { query, policyStore } = setup()
    await expect(create({ query, policyStore, readApprovedTrips: async () => { throw new Error('PRIVATE_SENTINEL') } })(base))
      .rejects.toMatchObject(error('SOURCE_UNAVAILABLE', 503))
  })
})


describe('request-only timezone target capability', () => {
  const {createAttendanceTimezoneRuntime:createRuntime} = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs')
  class RequestScopeError extends Error {
    constructor(public status:number,public code:string,message:string) { super(message) }
  }
  function requestScopeHarness() {
    const input = {orgId:'org-a',userId:'user-a',workDate:'2026-10-12'}
    const scopeContext = {userId:input.userId,attendanceGroups:[],roles:[],roleTags:[]}
    const authorized = new WeakMap<object,{orgId:string,userId:string}>()
    const prefixEvents:string[] = []
    const rule = {id:'rule-a',timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays:[1,2,3,4,5],isOvernight:false}
    const query = vi.fn(async (sql:string) => {
      if (sql.includes('FROM users u JOIN user_orgs')) return [] // inactive or moved legacy applicant
      if (sql.includes('FROM attendance_timezone_policies')) return [{enabled:true,version:1}]
      if (sql.includes('FROM attendance_rules')) return [{id:'rule-a',timezone:'UTC',timezone_version:1}]
      if (sql.includes('attendance_timezone_context_companions') || sql.includes('FROM attendance_records')
        || sql.includes('attendance_employee_timezone_overrides') || sql.includes('attendance_calculation_group_memberships')) return []
      throw new Error('UNEXPECTED_REQUEST_SCOPE_SQL')
    })
    const trx = {query}
    const resolveRuleContext = vi.fn(async (value:Row) => {
      expect(value.scopeContext).toBe(scopeContext)
      return {rule,source:'rule',isWorkingDay:true,holiday:null}
    })
    const runtime = createRuntime({
      HttpError:RequestScopeError,
      acquireRuntimeLocks:vi.fn(async () => { prefixEvents.push('prefix') }),
      authorizeRequestTarget:async (readTrx:object,subject:{orgId:string,userId:string}) => {
        expect(prefixEvents[0]).toBe('prefix')
        prefixEvents.push('scope')
        const proof = authorized.get(readTrx)
        if (!proof || proof.orgId !== subject.orgId || proof.userId !== subject.userId) {
          throw new RequestScopeError(403,'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED','ATTENDANCE_TIMEZONE_MEMBER_REQUIRED')
        }
        return scopeContext
      },
      loadPublishedCandidates:async () => [],readApprovedTrips:async () => [],
      loadCalendarOverrides:async () => [],mapRuleRow:() => rule,
      resolveRuleContext,normalizeTimeString:(time:string) => time,
      validateIanaTimezone:(zone:string) => zone,
      addDaysToDateKey:(date:string,days:number) => new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10),
      toWorkDate:(date:Date) => date.toISOString().slice(0,10),
      resolveLocalWallTime:(date:string,time:string) => ({posture:'unique',epochMs:Date.parse(date+'T'+time+':00Z')}),
    })
    return {input,scopeContext,authorized,trx,query,resolveRuleContext,runtime}
  }
  it('public target refuses inactive subjects even with request-shaped proof fields',async () => {
    const h = requestScopeHarness()
    h.authorized.set(h.trx,h.input)
    await expect(h.runtime.readTargetTimezoneContext(h.trx,{
      ...h.input,authorizedRequestSubject:true,authorizeReadSubject:() => true,
    })).rejects.toMatchObject({status:403,code:'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'})
    expect(h.query).toHaveBeenCalledTimes(1)
    expect(h.query.mock.calls[0][0]).toContain('u.is_active=true AND uo.is_active=true')
    expect(h.resolveRuleContext).not.toHaveBeenCalled()
  })
  it('internal target without server proof refuses before reading facts',async () => {
    const h = requestScopeHarness()
    await expect(h.runtime.readRequestTimezoneContext(h.trx,h.input))
      .rejects.toMatchObject({status:403,code:'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'})
    expect(h.query).not.toHaveBeenCalled()
  })
  it.each([{orgId:'org-b'},{userId:'user-b'}])('foreign internal scope %j refuses before reading facts',async change => {
    const h = requestScopeHarness()
    h.authorized.set(h.trx,h.input)
    await expect(h.runtime.readRequestTimezoneContext(h.trx,{...h.input,...change}))
      .rejects.toMatchObject({status:403,code:'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'})
    expect(h.query).not.toHaveBeenCalled()
  })
  it('ON authorized target uses shared facts and returns its exact proof to the original transaction without public bypass',async () => {
    const h = requestScopeHarness()
    h.authorized.set(h.trx,h.input)
    const target = await h.runtime.readRequestTimezoneContext(h.trx,h.input)
    expect(target).toMatchObject({...h.input,timezone:'UTC',frozen:false,provenance:{source:'system_default',mode:'multi_timezone'}})
    expect(h.runtime.requestTargetFactsFor(h.trx).window.contextFingerprint).toBe(target.contextFingerprint)
    expect(h.resolveRuleContext).toHaveBeenCalled()
    expect(h.query.mock.calls.some(([sql]) => sql.includes('FROM users u JOIN user_orgs'))).toBe(false)
    expect(h.query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true)
    h.authorized.delete(h.trx)
    await expect(h.runtime.readTargetTimezoneContext(h.trx,h.input))
      .rejects.toMatchObject({status:403,code:'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'})
  })
})
