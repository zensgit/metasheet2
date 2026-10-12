import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { acquireBusinessTripRequestPrefixV1 } from '../../src/attendance/attendance-business-trip-locks'
import {
  acquireAttendanceTimezoneRuntimeLocksV1,
  buildAttendanceTimezoneRuntimeOrgLockKeyV1,
} from '../../src/attendance/attendance-timezone-runtime-locks'
import {
  buildAttendanceW7MembershipTimelineLockKeyV1,
  buildAttendanceW7ScheduleFactsLockKeyV1,
} from '../../src/attendance/w7-resolver/w7-composite-lock-order'

const { attendanceTimezoneOrgLockKey } = createRequire(import.meta.url)(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs',
) as { attendanceTimezoneOrgLockKey(orgId: string): string }
const orgId = '1971d75c-65d0-40c0-b058-bc7d5f278d37'
const userId = 'fc987fb5-c6b5-4efd-a3df-a4bac5da250a'

describe('attendance timezone canonical runtime lock prefix', () => {
  it.each([orgId, 'default'])('matches the actual D1 exclusive writer key for %s', org => {
    expect(buildAttendanceTimezoneRuntimeOrgLockKeyV1(org)).toBe(attendanceTimezoneOrgLockKey(org))
  })

  it('takes policy before the unchanged shared timeline and schedule families', async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = []
    const trx = { query: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      return { rows: [] }
    } }
    await acquireAttendanceTimezoneRuntimeLocksV1(trx, { orgId, userId })
    expect(calls).toEqual([
      { sql: 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
        values: [attendanceTimezoneOrgLockKey(orgId)] },
      { sql: 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
        values: [buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)] },
      { sql: 'SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))',
        values: [buildAttendanceW7ScheduleFactsLockKeyV1(orgId), userId] },
    ])
  })

  it('uses exclusive policy mode without changing the following composite order', async () => {
    const calls: string[] = []
    const trx = { query: async (sql: string) => { calls.push(sql); return { rows: [] } } }
    await acquireAttendanceTimezoneRuntimeLocksV1(trx, { orgId, userId, mode: 'exclusive' })
    expect(calls).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
      'SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))',
    ])
  })

  it('rejects an illegal lock mode before acquiring any family', async () => {
    const calls: string[] = []
    const trx = { query: async (sql: string) => { calls.push(sql); return { rows: [] } } }
    await expect(acquireAttendanceTimezoneRuntimeLocksV1(trx, {
      orgId, userId, mode: 'true' as 'shared',
    })).rejects.toThrow('ATTENDANCE_TIMEZONE_INVALID_LOCK_MODE')
    expect(calls).toEqual([])
  })

  it('does not reach either facts family after a policy lock error', async () => {
    const error = new Error('SYNTHETIC_POLICY_LOCK_FAILURE')
    const calls: string[] = []
    const trx = { query: async (sql: string) => { calls.push(sql); throw error } }
    await expect(acquireAttendanceTimezoneRuntimeLocksV1(trx, { orgId, userId })).rejects.toBe(error)
    expect(calls).toEqual(['SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))'])
  })
})

describe('related request prefix before external approval parents',()=>{
  const requestId='f380de63-7caf-4a81-b84d-e6b3f845663d'
  const types=['leave','overtime','missed_check_in','missed_check_out','time_correction']
  function fixture(requestType:string) {
    const calls:{sql:string;values:readonly unknown[]}[]=[]
    let transactionId='own-transaction'
    const trx={query:async(sql:string,values:readonly unknown[]=[])=>{
      calls.push({sql,values})
      if (sql.includes('SELECT user_id,request_type')) return {rows:[{user_id:userId,request_type:requestType}]}
      if (sql.includes('FROM pg_locks')) return {rows:[{held:1}]}
      if (sql.includes('txid_current()')) return {rows:[{transaction_id:transactionId}]}
      if (sql.includes('FROM users u JOIN user_orgs')) return {rows:[{id:userId}]}
      return {rows:[]}
    }}
    return {trx,calls,setTransaction:(value:string)=>{transactionId=value}}
  }
  it.each(types)('%s takes the shared org/facts prefix without changing actor authorization',async requestType=>{
    const f=fixture(requestType)
    await acquireBusinessTripRequestPrefixV1(f.trx,{orgId,requestId,actorId:userId})
    const acquisitions=f.calls.filter(call=>call.sql.includes('pg_advisory_xact_lock'))
    expect(acquisitions).toEqual([
      {sql:'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',values:[buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgId)]},
      {sql:'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',values:[buildAttendanceW7MembershipTimelineLockKeyV1(orgId,userId)]},
      {sql:'SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))',values:[buildAttendanceW7ScheduleFactsLockKeyV1(orgId),userId]},
    ])
    expect(f.calls.filter(call=>call.sql.includes('FROM users u JOIN user_orgs'))).toEqual([])
  })
  it.each(types)('%s external redemption refuses an org lock without the same transaction preparation and takes no late lock',async requestType=>{
    const f=fixture(requestType)
    await expect(acquireBusinessTripRequestPrefixV1(f.trx,{orgId,requestId,external:true}))
      .rejects.toThrow('ATTENDANCE_TIMEZONE_EXTERNAL_PREFIX_REQUIRED')
    expect(f.calls.filter(call=>call.sql.includes('pg_advisory_xact_lock'))).toEqual([])
  })
  it('accepts actual preparation for the same client and transaction with no late acquisition',async()=>{
    const f=fixture('leave')
    await acquireBusinessTripRequestPrefixV1(f.trx,{orgId,requestId})
    f.calls.length=0
    await acquireBusinessTripRequestPrefixV1(f.trx,{orgId,requestId,external:true})
    expect(f.calls.filter(call=>call.sql.includes('pg_advisory_xact_lock'))).toEqual([])
  })
  it('rejects stale preparation on a pooled client reused for another transaction',async()=>{
    const f=fixture('leave')
    await acquireBusinessTripRequestPrefixV1(f.trx,{orgId,requestId})
    f.setTransaction('next-own-transaction');f.calls.length=0
    await expect(acquireBusinessTripRequestPrefixV1(f.trx,{orgId,requestId,external:true}))
      .rejects.toThrow('ATTENDANCE_TIMEZONE_EXTERNAL_PREFIX_REQUIRED')
    expect(f.calls.filter(call=>call.sql.includes('pg_advisory_xact_lock'))).toEqual([])
  })
})
