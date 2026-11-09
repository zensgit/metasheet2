import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { useAttendanceGroupFixedSchedule } from '../src/views/attendance/useAttendanceGroupFixedSchedule'
import { businessEffectiveDateError, withBusinessEffectiveDate } from '../src/views/attendance/attendanceBusinessEffectiveDate'

const desired = { shiftId: 'shift-a', startDate: '2026-11-01', endDate: '2026-11-30', revision: 1 }
const response = (data: unknown, status = 200) => ({
  ok: status < 400, status,
  json: async () => status < 400 ? { ok: true, data } : { ok: false, error: data },
}) as Response
const editor = (groupId: string) => ({
  groupId, capabilities: { businessEffectiveDateRequired: true }, state: 'pending_apply', reasonCodes: ['TARGET_MEMBER_MISSING'], desired,
  drift: { managedSets: [] },
  referenceEligibility: { shiftId: 'shift-a', allowed: true, reasonCode: null },
})
const result = (groupId: string) => ({
  group: { id: groupId }, shift: { id: 'shift-a' },
  window: { startDate: desired.startDate, endDate: desired.endDate },
  target: { total: 1 }, wouldCreate: [], skipped: [], blockingConflicts: [],
})
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
const scopes: EffectScope[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function harness(failure?: string, capabilityOverride?: { value: unknown }) {
  const capability = ref(capabilityOverride ? capabilityOverride.value : true)
  const groupId = ref<string | null>('group-a')
  const orgId = ref('org-a')
  const status = vi.fn()
  const apiFetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST' && failure) return response({ code: failure }, failure.includes('HISTORICAL') ? 403 : 409)
    if (path.endsWith('/config/update')) return response({ ...desired, revision: 2, groupId: groupId.value })
    if (path.endsWith('/clear')) return response({ deactivated: [] })
    if (init?.method === 'POST') return response({ ...result(groupId.value!), ...(path.endsWith('/apply') ? { applied: true } : {}), ...(path.endsWith('/rebuild') ? { rebuilt: true } : {}) })
    return response({ ...editor(groupId.value!), capabilities: { businessEffectiveDateRequired: capability.value } })
  })
  const scope = effectScope(); scopes.push(scope)
  const schedule = scope.run(() => useAttendanceGroupFixedSchedule({
    groupId, orgId: () => orgId.value, enabled: ref(true), hasShift: () => true,
    rememberShift: () => {}, apiFetch, tr: (_en, zh) => zh, setStatus: status,
    reloadAssignments: async () => {}, confirm: () => true,
  }))!
  return { schedule, groupId, orgId, apiFetch, status, capability }
}
const body = (call: [string, RequestInit?]) => JSON.parse(String(call[1]?.body))

describe('CALC14 effective date at fixed-schedule calls', () => {
  it.each([
    ['unknown', undefined],
    ['off', false],
    ['malformed', 'true'],
  ])('CALC14 %s editor capability keeps fixed-schedule writer bodies unchanged', async (_state, capability) => {
    const h = harness(undefined, { value: capability }); await flush()
    Object.assign(h.schedule.effectiveDates, { apply: '2026-12-01', rebuild: '2026-12-02', clear: '2026-12-03' })
    await h.schedule.preview(); await h.schedule.apply(); await h.schedule.rebuild(); await h.schedule.clear()
    const writes = h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    const base = { shiftId: desired.shiftId, startDate: desired.startDate, endDate: desired.endDate, orgId: 'org-a' }
    expect(writes.map(call => body(call))).toEqual([
      base, { ...base, expectedConfigRevision: 1 }, { ...base, expectedConfigRevision: 1 }, base,
    ])
  })

  it('CALC14 capability loss clears every fixed-schedule action date', async () => {
    const h = harness(undefined, { value: true }); await flush()
    Object.assign(h.schedule.effectiveDates, { save: '2026-12-01', apply: '2026-12-01', rebuild: '2026-12-01', clear: '2026-12-01' })
    h.capability.value = false
    await h.schedule.load()
    expect(h.schedule.effectiveDates).toEqual({ save: '', apply: '', rebuild: '', clear: '' })
  })

  it('projects an explicit date only, retaining the exact old body for blank input', () => {
    const old = { orgId: 'org-a', userIds: ['user-a'] }
    expect(withBusinessEffectiveDate(old, '')).toBe(old)
    expect(JSON.stringify(withBusinessEffectiveDate(old, ''))).toBe(JSON.stringify(old))
    expect(withBusinessEffectiveDate(old, '2026-12-01')).toEqual({ ...old, businessEffectiveDate: '2026-12-01' })
  })

  it('sends separate dates on apply, rebuild and clear, never on preview', async () => {
    const h = harness(); await flush()
    Object.assign(h.schedule.effectiveDates, { apply: '2026-12-01', rebuild: '2026-12-02', clear: '2026-12-03' })
    await h.schedule.preview()
    await h.schedule.apply()
    await h.schedule.rebuild()
    await h.schedule.clear()
    const writes = h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes.map(([path]) => path.split('/').pop())).toEqual(['preview', 'apply', 'rebuild', 'clear'])
    const base = { shiftId: desired.shiftId, startDate: desired.startDate, endDate: desired.endDate, orgId: 'org-a' }
    expect(body(writes[0]!)).toEqual(base)
    expect(body(writes[1]!)).toEqual({ ...base, expectedConfigRevision: 1, businessEffectiveDate: '2026-12-01' })
    expect(body(writes[2]!)).toEqual({ ...base, expectedConfigRevision: 1, businessEffectiveDate: '2026-12-02' })
    expect(body(writes[3]!)).toEqual({ ...base, businessEffectiveDate: '2026-12-03' })
  })

  it('sends the explicitly entered date when saving desired configuration', async () => {
    const groupId = ref<string | null>('group-a')
    let saved = false
    const apiFetch = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.endsWith('/config/update')) {
        saved = true
        return response({ ...desired, groupId: 'group-a' })
      }
      const data = editor('group-a')
      if (!saved) {
        return response({ ...data, state: 'not_configured', reasonCodes: ['NO_DESIRED_CONFIG'], desired: null,
          referenceEligibility: path.includes('shiftId=shift-a') ? data.referenceEligibility : null })
      }
      return response(data)
    })
    const scope = effectScope(); scopes.push(scope)
    const schedule = scope.run(() => useAttendanceGroupFixedSchedule({
      groupId, orgId: () => 'org-a', enabled: ref(true), hasShift: () => true,
      rememberShift: () => {}, apiFetch, tr: (_en, zh) => zh, setStatus: () => {},
      reloadAssignments: async () => {}, confirm: () => true,
    }))!
    await flush()
    Object.assign(schedule.form, { shiftId: desired.shiftId, startDate: desired.startDate, endDate: desired.endDate })
    await flush()
    schedule.effectiveDates.save = '2026-12-05'
    await schedule.save()
    const write = apiFetch.mock.calls.find(([path]) => path.endsWith('/config/update'))!
    expect(body(write)).toEqual({ shiftId: 'shift-a', startDate: '2026-11-01', endDate: '2026-11-30',
      orgId: 'org-a', expectedConfigRevision: 0, businessEffectiveDate: '2026-12-05' })
    expect(schedule.effectiveDates.save).toBe('')
  })

  it('clears dates when switching group, org, shift or managed set', async () => {
    const h = harness(); await flush()
    h.schedule.effectiveDates.apply = '2026-12-01'
    h.groupId.value = 'group-b'
    expect(h.schedule.effectiveDates.apply).toBe('')
    await flush()
    h.schedule.effectiveDates.save = '2026-12-02'
    h.orgId.value = 'org-b'
    expect(h.schedule.effectiveDates.save).toBe('')
    await flush()
    h.schedule.effectiveDates.rebuild = '2026-12-03'
    h.schedule.form.shiftId = 'shift-b'
    expect(h.schedule.effectiveDates.rebuild).toBe('')
    h.schedule.effectiveDates.clear = '2026-12-04'
    h.schedule.selectedManagedKey.value = 'other'
    expect(h.schedule.effectiveDates.clear).toBe('')
  })

  it.each([
    ['ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED', '请为本次变更填写生效日期。'],
    ['ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID', '请填写有效的生效日期。'],
    ['ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED', '历史生效日期需单独核验并授权。'],
    ['ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT', '该日期已有不同变更，或早于已有变更。请核对历史后再选择日期。'],
    ['ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE', '所需历史资料不完整，请联系管理员核验后再操作。'],
  ])('shows typed failure %s without a retry', async (code, expected) => {
    const h = harness(code); await flush()
    await h.schedule.rebuild()
    expect(h.status).toHaveBeenLastCalledWith(expected, 'error')
    expect(h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(businessEffectiveDateError(code, (_en, zh) => zh)).toBe(expected)
  })
})
