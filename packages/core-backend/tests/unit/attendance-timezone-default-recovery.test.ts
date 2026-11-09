import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { prepareAttendanceTimezoneDefaultRecovery } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-default-recovery.cjs')
const { canonicalContextFingerprint } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs')
class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}
const orgId = 'recovery-unit-org', userId = 'recovery-unit-user', workDate = '2026-08-12'
const semantic = {workDate,shiftId:'shift',assignmentId:'assignment',source:'shift',timezone:'UTC'}
function fixture() {
  const state = {
    policy: {enabled:false,version:0},
    defaults: [{id:'default',timezone:'UTC',timezone_version:1}],
    open: [] as Record<string,unknown>[], nearby: [] as Record<string,unknown>[], groups:false, trips:false,
  }
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    expect(values[0]).toBe(orgId)
    if (sql.includes('FROM attendance_timezone_policies')) return state.policy.version === 0 ? [] : [state.policy]
    if (sql.includes('FROM attendance_rules')) return state.defaults
    if (sql.includes('FROM attendance_business_trip_arrangements')) return [{present:state.trips}]
    if (sql.includes('FROM attendance_records')) {
      expect(sql).toContain("visibility_state='active' AND first_in_at IS NOT NULL AND last_out_at IS NULL")
      return state.open
    }
    if (sql.includes('FROM attendance_calculation_group_memberships')) return [{present:state.groups}]
    if (sql.includes('FROM attendance_shift_assignments')) return state.nearby
    throw new Error('UNEXPECTED_QUERY')
  })
  const frame = {orgId,userId,workDate,timezone:'UTC',identity:{...semantic,timezoneContext:{referenceId:'old-default'}}}
  const readFrozenContext = vi.fn(async (): Promise<{recordId:string,frame:typeof frame} | null> => ({recordId:'record',frame}))
  const input = {
    orgId,now:new Date('2026-08-12T10:00:00Z'),timezone:'UTC',HttpError,
    readFrozenContext,
    readPublishedCandidates:vi.fn(async () => [{orgId,userId,workDate,shiftId:'shift',assignmentId:'assignment',source:'shift'}]),
    readCurrentSemantics:vi.fn(async () => [semantic]),fingerprint:canonicalContextFingerprint,
  }
  return {state,trx:{query},input,frame}
}
describe('explicit missing default recovery guards', () => {
  it('requires OFF and does not scan history on the ON branch',async () => {
    const f = fixture(); f.state.policy = {enabled:true,version:1}
    await expect(prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)).rejects.toMatchObject({status:503,code:'ATTENDANCE_TIMEZONE_DEFAULT_MISSING'})
    expect(f.trx.query).toHaveBeenCalledTimes(1)
  })
  it('requires the administrator supplied zone rather than a built-in or another org fallback',async () => {
    const f = fixture()
    await expect(prepareAttendanceTimezoneDefaultRecovery(f.trx,{...f.input,timezone:undefined})).rejects.toMatchObject({status:422,code:'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED'})
  })
  it('keeps approved future/active trip whole-shift source protection even on OFF',async () => {
    const f = fixture(); f.state.trips = true
    await expect(prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS'})
    expect(f.input.readFrozenContext).not.toHaveBeenCalled()
  })
  it('skips a pre-companion open parent (no freeze) and stays read-only',async () => {
    const f = fixture(); f.state.open = [{id:'record',user_id:userId,work_date:workDate,timezone:'UTC'}]
    f.input.readFrozenContext.mockResolvedValueOnce(null)
    await expect(prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)).resolves.toEqual(expect.any(Function))
    expect(f.trx.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  })
  it('does not require a freeze for a nearby slot that never started, and records no proof for it',async () => {
    const f = fixture(); f.state.nearby = [{user_id:userId}]
    f.input.readFrozenContext.mockResolvedValue(null)
    const verify = await prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)
    await verify()
    expect(f.input.readCurrentSemantics).not.toHaveBeenCalled()
  })
  it('still requires published candidates for a nearby assignment',async () => {
    const f = fixture(); f.state.nearby = [{user_id:userId}]
    f.input.readPublishedCandidates.mockResolvedValueOnce([])
    await expect(prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS'})
  })
  it.each(['recordId','orgId','userId','workDate','timezone'])('does not accept a freeze with mismatching %s',async field => {
    const f = fixture(); f.state.open = [{id:'record',user_id:userId,work_date:workDate,timezone:'UTC'}]
    const frozen = {recordId:'record',frame:{...f.frame}}
    if (field === 'recordId') frozen.recordId = 'wrong'
    else Object.assign(frozen.frame,{[field]:'wrong'})
    f.input.readFrozenContext.mockResolvedValueOnce(frozen)
    await expect(prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID'})
  })
  it('does not accept another assignment freeze for a nearby slot',async () => {
    const f = fixture(); f.state.nearby = [{user_id:userId}]
    f.frame.identity.assignmentId = 'another-slot'
    await expect(prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS'})
  })
  it('checks strict unique valid scoped default again after creation',async () => {
    const f = fixture(); const verify = await prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)
    f.state.defaults.push({id:'duplicate',timezone:'UTC',timezone_version:1})
    await expect(verify()).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS'})
  })
  it('checks the OFF policy revision again after creation',async () => {
    const f = fixture(); const verify = await prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)
    f.state.policy = {enabled:false,version:1}
    await expect(verify()).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED'})
  })
  it('permits a matching frozen published source but refuses any changed semantic projection',async () => {
    const f = fixture(); f.state.nearby = [{user_id:userId}]
    const verify = await prepareAttendanceTimezoneDefaultRecovery(f.trx,f.input)
    await expect(verify()).resolves.toBeUndefined()
    f.input.readCurrentSemantics.mockResolvedValueOnce([{...semantic,timezone:'Asia/Tokyo'}])
    await expect(verify()).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT'})
  })
})
