import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type Input = Record<string, unknown>
type Query = (sql: string, values: unknown[]) => Promise<{ rows: Input[] }>
type Store = Record<string, (input: Input) => Promise<unknown>>
const { createAttendanceTimezonePolicyStore: create, attendanceTimezoneOrgLockKey: key } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs',
) as {
  createAttendanceTimezonePolicyStore: (adapter: {
    query: Query, transaction: (work: (query: Query) => Promise<unknown>) => Promise<unknown>,
    authorizeManage: (input: Input) => Promise<boolean>,
    prepareTripSourceChange?: (input: Input) => Promise<() => Promise<void>>,
  }) => Store,
  attendanceTimezoneOrgLockKey: (orgId: string) => string,
}
function setup(responses: Input[][] = []) {
  const query = vi.fn<Parameters<Query>, ReturnType<Query>>()
  for (const rows of responses) query.mockResolvedValueOnce({ rows })
  query.mockResolvedValue({ rows: [] })
  const authorizeManage = vi.fn().mockResolvedValue(true)
  const transaction = vi.fn(async (work: (q: Query) => Promise<unknown>) => work(query))
  return { query, authorizeManage, transaction, store: create({ query, transaction, authorizeManage, prepareTripSourceChange: async () => async () => {} }) }
}
const expectedError = (code: string, status = 422) => ({
  code: 'ATTENDANCE_TIMEZONE_' + code, message: 'ATTENDANCE_TIMEZONE_' + code, status,
})
const actor = { orgId: 'org-a', actorId: 'actor-a' }
const from = new Date('2026-10-12T00:00:00Z')
const to = new Date('2026-10-13T00:00:00Z')

describe('D1 timezone policy persistence contracts', () => {
  it('uses unambiguous shared org lock keys', () => {
    expect(key('org:a')).toBe('["attendance-timezone-policy-v1","org:a"]')
    expect(key('org:a')).not.toBe(key('org'))
  })
  it('policy absence is OFF v0 without reading a default or another org', async () => {
    const { store, query } = setup()
    expect(await store.readPolicy({ orgId: 'org-a' })).toEqual({ enabled: false, version: 0 })
    expect(query.mock.calls).toEqual([
      ['SELECT enabled, version FROM attendance_timezone_policies WHERE org_id = $1', ['org-a']],
    ])
  })
  it('DB failure is 503 with no raw exception values', async () => {
    const { store, query } = setup()
    query.mockRejectedValue(new Error('PRIVATE_SENTINEL'))
    await expect(store.readPolicy({ orgId: 'org-a' })).rejects.toMatchObject(expectedError('STORE_UNAVAILABLE', 503))
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('requires a default even when policy is absent', async () => {
    const { store } = setup()
    await expect(store.readDefault({ orgId: 'org-a' })).rejects.toMatchObject(expectedError('DEFAULT_REQUIRED'))
  })
  it('reads default only from the exact supplied organization', async () => {
    const { store, query } = setup([[{ id: 'rule-a', timezone: 'Asia/Tokyo', timezone_version: 4 }]])
    expect(await store.readDefault({ orgId: 'org-a' })).toEqual({
      orgId: 'org-a', referenceId: 'rule-a', timezone: 'Asia/Tokyo', version: 4,
    })
    expect(query.mock.calls).toEqual([
      ['SELECT id, timezone, timezone_version FROM attendance_rules WHERE org_id = $1 AND is_default = true', ['org-a']],
    ])
  })
  it('rejects multiple default rows instead of picking row order', async () => {
    const { store } = setup([[{ id: 'a' }, { id: 'b' }]])
    await expect(store.readDefault({ orgId: 'org-a' })).rejects.toMatchObject(expectedError('MULTIPLE_DEFAULTS', 409))
  })
  it.each(['Invalid/Sentinel', ' Asia/Tokyo', '', null])('rejects illegal persisted default %s', timezone => {
    const { store } = setup([[{ id: 'a', timezone, timezone_version: 1 }]])
    return expect(store.readDefault({ orgId: 'org-a' })).rejects.toMatchObject(expectedError('INVALID_ZONE'))
  })
  it.each([0, -1, 1.5, '1', null])('rejects ungoverned default revision %s', timezone_version => {
    const { store } = setup([[{ id: 'a', timezone: 'UTC', timezone_version }]])
    return expect(store.readDefault({ orgId: 'org-a' })).rejects.toMatchObject(expectedError('INVALID_REVISION'))
  })
  it.each(['true', 1, null])('rejects persisted nonboolean policy %s', enabled => {
    const { store } = setup([[{ enabled, version: 1 }]])
    return expect(store.readPolicy({ orgId: 'org-a' })).rejects.toMatchObject(expectedError('INVALID_ENABLED'))
  })
  it.each(['true', 'false', 1, 0, null, undefined])('rejects nonboolean policy input %s before SQL', enabled => {
    const { store, query } = setup()
    expect(() => store.setPolicy({ ...actor, enabled, expectedVersion: 0 })).toThrow('ATTENDANCE_TIMEZONE_INVALID_ENABLED')
    expect(query).not.toHaveBeenCalled()
  })
  it('requires an explicit internal management authorization', async () => {
    const { store, authorizeManage, query } = setup()
    authorizeManage.mockResolvedValue(false)
    await expect(store.setPolicy({ ...actor, enabled: true, expectedVersion: 0 }))
      .rejects.toMatchObject(expectedError('FORBIDDEN', 403))
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key('org-a')],
    ])
  })
  it('rejects inactive/cross-org actor inside transaction', async () => {
    const { store, transaction, query } = setup([[], []])
    await expect(store.setPolicy({ ...actor, enabled: true, expectedVersion: 0 }))
      .rejects.toMatchObject(expectedError('MEMBER_REQUIRED', 403))
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[1][1]).toEqual(['actor-a', 'org-a'])
  })
  it('checks expected version and never writes on mismatch', async () => {
    const { store, query } = setup([[], [{ id: 'actor-a' }], [{ enabled: false, version: 2 }]])
    await expect(store.setPolicy({ ...actor, enabled: true, expectedVersion: 1 }))
      .rejects.toMatchObject(expectedError('CONFIG_CHANGED', 409))
    expect(query.mock.calls.map(([sql]) => sql.startsWith('INSERT'))).toEqual([false, false, false])
  })
  it('policy mutation and enum-only audit share the injected transaction', async () => {
    const { store, query, transaction } = setup([
      [], [{ id: 'actor-a' }], [], [{ enabled: true, version: 1 }], [],
    ])
    expect(await store.setPolicy({ ...actor, enabled: true, expectedVersion: 0 }))
      .toEqual({ enabled: true, version: 1 })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(query.mock.calls.at(-1)?.[1]).toEqual(['org-a', 'actor-a', 'policy_set', 'org-a', 1])
  })
  it('requires an active target in the same org before override lookup', async () => {
    const { store, query } = setup()
    await expect(store.readEmployeeOverride({ orgId: 'org-a', userId: 'foreign', at: from }))
      .rejects.toMatchObject(expectedError('MEMBER_REQUIRED', 403))
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual(['foreign', 'org-a'])
  })
  it('uses UTC half-open effective lookup and preserves exact source frame', async () => {
    const { store, query } = setup([[{ id: 'user-a' }], [{
      id: 'override-a', timezone: 'Asia/Singapore', version: 3, effective_from: from, effective_to: to,
    }]])
    expect(await store.readEmployeeOverride({ orgId: 'org-a', userId: 'user-a', at: from })).toEqual({
      orgId: 'org-a', userId: 'user-a', referenceId: 'override-a', timezone: 'Asia/Singapore',
      version: 3, effectiveFrom: from, effectiveTo: to,
    })
    expect(query.mock.calls[1][0]).toContain('effective_from <= $3 AND (effective_to IS NULL OR $3 < effective_to)')
    expect(query.mock.calls[1][1]).toEqual(['org-a', 'user-a', from])
  })
  it('does not turn ambiguous employee lookup into inheritance', async () => {
    const { store } = setup([[{ id: 'user-a' }], [{ id: 'a' }, { id: 'b' }]])
    await expect(store.readEmployeeOverride({ orgId: 'org-a', userId: 'user-a', at: from }))
      .rejects.toMatchObject(expectedError('MULTIPLE_EMPLOYEE_OVERRIDES', 409))
  })
  it('does not accept local date strings as UTC instants', () => {
    const { store, query } = setup()
    expect(() => store.readEmployeeOverride({ orgId: 'org-a', userId: 'user-a', at: '2026-10-12' }))
      .toThrow('ATTENDANCE_TIMEZONE_INVALID_INSTANT')
    expect(query).not.toHaveBeenCalled()
  })
  it('rejects illegal override zone/interval before mutation', () => {
    const { store, query } = setup()
    const input = { ...actor, userId: 'user-a', timezone: 'UTC', effectiveFrom: from,
      effectiveTo: from, expectedPolicyVersion: 0 }
    expect(() => store.createEmployeeOverride(input)).toThrow('ATTENDANCE_TIMEZONE_INVALID_INTERVAL')
    expect(() => store.createEmployeeOverride({ ...input, timezone: 'Invalid/Sentinel', effectiveTo: to }))
      .toThrow('ATTENDANCE_TIMEZONE_INVALID_ZONE')
    expect(query).not.toHaveBeenCalled()
  })
  it('requires the trip reader before mutable row locks when D3 has an affected arrangement',async()=>{
    const query=vi.fn<Parameters<Query>,ReturnType<Query>>()
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{present:true}]})
      .mockResolvedValueOnce({rows:[{request_id:'trip'}]})
    const store=create({query,transaction:async work=>work(query),authorizeManage:async()=>true})
    await expect(store.setPolicy({...actor,enabled:true,expectedVersion:0}))
      .rejects.toMatchObject(expectedError('TRIP_GUARD_UNAVAILABLE',503))
    expect(query.mock.calls.some(([sql])=>sql.includes('FOR UPDATE'))).toBe(false)
    expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false)
  })
  it('captures and verifies trip boundaries around source DML inside the same transaction',async()=>{
    const sequence:string[]=[]
    const query:Query=async(sql)=>{
      sequence.push(sql.startsWith('SELECT pg_advisory')?'prefix':sql.startsWith('INSERT INTO attendance_timezone_policies')?'write':'query')
      if(sql.includes('FROM users')) return {rows:[{id:'actor-a'}]}
      if(sql.startsWith('INSERT INTO attendance_timezone_policies')) return {rows:[{enabled:true,version:1}]}
      return {rows:[]}
    }
    const store=create({query,transaction:async work=>work(query),authorizeManage:async()=>true,
      prepareTripSourceChange:async input=>{
        expect(input).toEqual({query,orgId:actor.orgId,userIds:null})
        sequence.push('capture')
        return async()=>{sequence.push('verify');throw Object.assign(new Error('ATTENDANCE_TRIP_PARTIAL_SHIFT'),{code:'ATTENDANCE_TRIP_PARTIAL_SHIFT'})}
      }})
    await expect(store.setPolicy({...actor,enabled:true,expectedVersion:0})).rejects.toMatchObject({code:'ATTENDANCE_TRIP_PARTIAL_SHIFT',status:409})
    expect(sequence[0]).toBe('prefix');expect(sequence[1]).toBe('capture')
    expect(sequence.indexOf('write')).toBeGreaterThan(sequence.indexOf('capture'));expect(sequence.at(-1)).toBe('verify')
  })

})
