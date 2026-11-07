import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, ref } from 'vue'
import {
  parseFixedScheduleAdmin, parseFixedScheduleSelf, type FixedScheduleAudience,
} from '../src/views/attendance/attendanceFixedScheduleEffectiveness'
import { useAttendanceFixedScheduleEffectiveness } from '../src/views/attendance/useAttendanceFixedScheduleEffectiveness'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { ATTENDANCE_RULES_ME_OMIT_HEADERS } from '../src/views/attendance/rulesMeContract'
import { FIXED_GROUP, OTHER_FIXED_GROUP, FIXED_STATES, fixedScheduleFixture } from './fixtures/fixedScheduleEffectiveness'

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const wrappers: Array<{ unmount: () => void }> = []
async function flushPromises() {
  for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() }
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}
type Loader = ReturnType<typeof useAttendanceFixedScheduleEffectiveness>
function harness(fetch: typeof import('../src/utils/api').apiFetch, audience: FixedScheduleAudience = 'self') {
  const group = ref(FIXED_GROUP)
  const context = ref('org-a')
  const enabled = ref(true)
  const expectedOrg = ref<string | null>(null)
  let loader!: Loader
  const Child = defineComponent({ setup() {
    loader = useAttendanceFixedScheduleEffectiveness({
      audience: () => audience, groupId: () => group.value, contextKey: () => context.value,
      enabled: () => enabled.value, expectedOrgId: () => expectedOrg.value, apiFetch: fetch,
    })
    return () => h('div', { 'data-status': loader.status.value }, loader.data.value?.state ?? 'unavailable')
  } })
  const Parent = defineComponent({ setup() {
    provide(attendanceSessionGuardKey, createAttendanceSessionGuard('org-a'))
    return () => h(Child)
  } })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(Parent)
  app.mount(host)
  let mounted = true
  const wrapper = { unmount() { if (mounted) { app.unmount(); host.remove(); mounted = false } } }
  wrappers.push(wrapper)
  return { wrapper, loader, group, context, enabled, expectedOrg }
}
function deferred() {
  let resolve!: (response: Response) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('auth_token', 'synthetic-session-a') })
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); localStorage.clear() })

describe('FSER-4 strict shared contract', () => {
  it.each(FIXED_STATES)('preserves canonical %s exactly for both response shapes', state => {
    const admin = fixedScheduleFixture(state)
    const self = fixedScheduleFixture(state, true)
    expect(parseFixedScheduleAdmin(admin, FIXED_GROUP)).toEqual(admin.data)
    expect(parseFixedScheduleSelf(self, FIXED_GROUP)).toEqual(self.data)
  })
  it.each(['matching', 'non_matching'] as const)('preserves member applicability %s without counts', applicability => {
    const input = fixedScheduleFixture('pending_apply', true, applicability === 'matching')
    expect(parseFixedScheduleSelf(input, FIXED_GROUP)).toEqual(input.data)
    expect(Object.keys(parseFixedScheduleSelf(input, FIXED_GROUP)!)).toEqual([
      'groupId', 'state', 'reasonCodes', 'desired', 'evaluatedAt', 'applicability',
    ])
  })
  it('preserves supplied reason order rather than sorting or deriving status', () => {
    const input = fixedScheduleFixture()
    input.data.reasonCodes = ['UNPUBLISHED_MANAGED_ROW', 'TARGET_MEMBER_MISSING']
    expect(parseFixedScheduleAdmin(input, FIXED_GROUP)?.reasonCodes).toEqual(input.data.reasonCodes)
    expect(parseFixedScheduleAdmin(input, FIXED_GROUP)?.state).toBe('pending_apply')
  })
  it('rejects the sibling response shape in both directions', () => {
    expect(parseFixedScheduleSelf(fixedScheduleFixture(), FIXED_GROUP)).toBeNull()
    expect(parseFixedScheduleAdmin(fixedScheduleFixture('pending_apply', true), FIXED_GROUP)).toBeNull()
  })
  it.each(['coverage', 'drift', 'managedSets', 'producerKey', 'userId', 'orgId'])('rejects self field %s even when empty', key => {
    const input = fixedScheduleFixture('pending_apply', true)
    expect(parseFixedScheduleSelf({ ...input, data: { ...input.data, [key]: [] } }, FIXED_GROUP)).toBeNull()
    expect(parseFixedScheduleSelf({ ...input, data: { ...input.data, desired: { ...input.data.desired, [key]: [] } } }, FIXED_GROUP)).toBeNull()
  })
  it.each([
    { state: 'EFFECTIVE' }, { state: null }, { reasonCodes: ['FUTURE_REASON'] },
    { reasonCodes: ['EFFECTIVE', 'EFFECTIVE'] }, { applicability: 'unknown' },
    { groupId: OTHER_FIXED_GROUP }, { evaluatedAt: 'not-an-instant' },
    { desired: { shiftId: 'x', startDate: '2026-02-30', endDate: '2026-03-01', revision: 1 } },
    { desired: { shiftId: 'x', startDate: '2026-03-02', endDate: '2026-03-01', revision: 1 } },
    { desired: { shiftId: 'x', startDate: '2026-03-01', endDate: '2026-03-01', revision: 0 } },
    { desired: { shiftId: 'x', startDate: '2026-03-01', endDate: '2026-03-01', revision: '1' } },
  ])('rejects malformed member projection %#', change => {
    const input = fixedScheduleFixture('pending_apply', true)
    expect(parseFixedScheduleSelf({ ...input, data: { ...input.data, ...change } }, FIXED_GROUP)).toBeNull()
  })
  it.each(['targetMembers', 'matchingMembers', 'missingMembers', 'nonMemberTargets', 'differentKeyRows'])('rejects noninteger or missing coverage %s', key => {
    const input = fixedScheduleFixture()
    for (const bad of ['0', -1, 1.5, null]) {
      const coverage = { ...('coverage' in input.data ? input.data.coverage : {}), [key]: bad }
      expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, coverage } }, FIXED_GROUP)).toBeNull()
    }
    const coverage = { ...('coverage' in input.data ? input.data.coverage : {}) } as Record<string, unknown>
    delete coverage[key]
    expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, coverage } }, FIXED_GROUP)).toBeNull()
  })
  it('accepts a real historical open-ended managed set without widening desired config dates', () => {
    const input = fixedScheduleFixture('configuration_changed')
    const drift = 'drift' in input.data ? input.data.drift : null
    const legacy = { ...input, data: { ...input.data, drift: { ...drift, managedSets: [{ ...drift?.managedSets[0], endDate: null }] } } }
    expect(parseFixedScheduleAdmin(legacy, FIXED_GROUP)?.drift.managedSets[0].endDate).toBeNull()
    expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, desired: { ...input.data.desired, endDate: null } } }, FIXED_GROUP)).toBeNull()
  })
  it('rejects a zero-row managed set instead of accepting an empty drift claim', () => {
    const input = fixedScheduleFixture('configuration_changed')
    const drift = 'drift' in input.data ? input.data.drift : null
    expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, drift: { ...drift,
      managedSets: [{ ...drift?.managedSets[0], rowCount: 0 }] } } }, FIXED_GROUP)).toBeNull()
  })
  it('rejects missing/extra envelope, desired, drift and managed-set keys without salvage', () => {
    const input = fixedScheduleFixture('configuration_changed')
    expect(parseFixedScheduleAdmin({ ...input, metadata: {} }, FIXED_GROUP)).toBeNull()
    expect(parseFixedScheduleAdmin({ ok: true }, FIXED_GROUP)).toBeNull()
    expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, desired: { ...input.data.desired, note: {} } } }, FIXED_GROUP)).toBeNull()
    const drift = 'drift' in input.data ? input.data.drift : null
    expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, drift: { ...drift, note: {} } } }, FIXED_GROUP)).toBeNull()
    expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, drift: { ...drift, managedSets: [{ ...drift?.managedSets[0], rowCount: '1' }] } } }, FIXED_GROUP)).toBeNull()
    expect(parseFixedScheduleAdmin({ ...input, data: { ...input.data, drift: { ...drift, managedSets: [{ ...drift?.managedSets[0], userId: 'forbidden' }] } } }, FIXED_GROUP)).toBeNull()
  })
})

describe('FSER-4 shared read lifecycle', () => {
  it.each(['admin', 'self'] as const)('uses only the %s read route with no ambient subject selectors', async audience => {
    const fetch = vi.fn().mockResolvedValue(response(fixedScheduleFixture('pending_apply', audience === 'self')))
    const { loader } = harness(fetch, audience)
    await flushPromises()
    expect(loader.status.value).toBe('ready')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, options] = fetch.mock.calls[0]
    expect(path).toBe('/api/attendance/groups/' + FIXED_GROUP + '/fixed-schedule/effectiveness' + (audience === 'self' ? '/me' : ''))
    expect(options).toEqual({ method: 'GET', signal: expect.any(AbortSignal), omitHeaders: ATTENDANCE_RULES_ME_OMIT_HEADERS, suppressUnauthorizedRedirect: true })
    expect(options).not.toHaveProperty('body')
  })
  it.each(['admin', 'self'] as const)('asserts expected organization without selecting the %s subject', async audience => {
    const fetch = vi.fn(async (_path: string, init?: import('../src/utils/api').ApiFetchOptions) =>
      new Headers(init?.headers).get('x-org-id') === 'org-b'
        ? response({ ok: false, error: { code: 'ORG_SCOPE_MISMATCH' } }, 403)
        : response(fixedScheduleFixture('effective', audience === 'self')))
    const { loader, expectedOrg } = harness(fetch, audience)
    await flushPromises()
    expectedOrg.value = 'org-a'
    expect(loader.data.value).toBeNull()
    await flushPromises()
    const [path, options] = fetch.mock.calls.at(-1)!
    expect(path).not.toContain('?')
    expect(options?.headers).toEqual({ 'x-org-id': 'org-a' })
    expect(options?.omitHeaders).toEqual(ATTENDANCE_RULES_ME_OMIT_HEADERS.filter(name => name !== 'x-org-id'))
    expect(options).not.toHaveProperty('body')
    expectedOrg.value = 'org-b'
    expect(loader.data.value).toBeNull()
    await flushPromises()
    expect(loader.status.value).toBe('unavailable')
    expect(loader.data.value).toBeNull()
  })
  it.each([401, 403, 404, 503])('clears old success on HTTP %s instead of rendering a valid state', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(response(fixedScheduleFixture('effective', true)))
      .mockResolvedValueOnce(response({ ok: false, error: { code: 'UNAVAILABLE' } }, status))
    const { loader } = harness(fetch)
    await flushPromises()
    expect(loader.data.value?.state).toBe('effective')
    const pending = loader.load()
    expect(loader.data.value).toBeNull()
    expect(loader.status.value).toBe('loading')
    await pending
    expect(loader.data.value).toBeNull()
    expect(loader.status.value).toBe('unavailable')
  })
  it.each(['network', 'json', 'shape'])('fails closed after prior valid data on %s error', async mode => {
    const fetch = vi.fn().mockResolvedValueOnce(response(fixedScheduleFixture('effective', true)))
    if (mode === 'network') fetch.mockRejectedValueOnce(new Error('synthetic network error'))
    else if (mode === 'json') fetch.mockResolvedValueOnce(new Response('<html>error</html>'))
    else fetch.mockResolvedValueOnce(response(fixedScheduleFixture()))
    const { loader } = harness(fetch)
    await flushPromises()
    await loader.load()
    expect(loader.status.value).toBe('unavailable')
    expect(loader.data.value).toBeNull()
  })
  it.each(['late-success', 'late-failure'])('suppresses %s from the previous group', async mode => {
    const old = deferred()
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(fixedScheduleFixture('pending_apply', true, false, OTHER_FIXED_GROUP)))
    const { loader, group } = harness(fetch)
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toContain(FIXED_GROUP)
    group.value = OTHER_FIXED_GROUP
    expect(loader.data.value).toBeNull()
    await flushPromises()
    expect(loader.data.value?.groupId).toBe(OTHER_FIXED_GROUP)
    if (mode === 'late-success') old.resolve(response(fixedScheduleFixture('effective', true)))
    else old.reject(new Error('old request failed'))
    await flushPromises()
    expect(loader.data.value?.groupId).toBe(OTHER_FIXED_GROUP)
    expect(loader.data.value?.state).toBe('pending_apply')
    expect(loader.status.value).toBe('ready')
  })
  it('clears data synchronously when the presentation organization context changes', async () => {
    const next = deferred()
    const fetch = vi.fn().mockResolvedValueOnce(response(fixedScheduleFixture('effective', true))).mockReturnValueOnce(next.promise)
    const { loader, context } = harness(fetch)
    await flushPromises()
    context.value = 'org-b'
    expect(loader.data.value).toBeNull()
    expect(loader.status.value).toBe('loading')
    next.resolve(response(fixedScheduleFixture('pending_apply', true)))
    await flushPromises()
    expect(loader.data.value?.state).toBe('pending_apply')
  })
  it('clears on an actual principal switch and refuses its old late response', async () => {
    const old = deferred()
    const fetch = vi.fn().mockReturnValue(old.promise)
    const { loader } = harness(fetch)
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'synthetic-session-b')
    await flushPromises()
    expect(loader.data.value).toBeNull()
    expect(loader.status.value).toBe('unavailable')
    old.resolve(response(fixedScheduleFixture('effective', true)))
    await flushPromises()
    expect(loader.data.value).toBeNull()
    expect(loader.status.value).toBe('unavailable')
  })
  it('drops data on a cross-tab storage session switch', async () => {
    const fetch = vi.fn().mockResolvedValue(response(fixedScheduleFixture('effective', true)))
    const { loader } = harness(fetch)
    await flushPromises()
    localStorage.setItem('auth_token', 'synthetic-session-b')
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    expect(loader.data.value).toBeNull()
    expect(loader.status.value).toBe('unavailable')
  })
  it('binds same-subject token refreshes as distinct request sessions', async () => {
    const jwt = (nonce: string) => 'header.' + btoa(JSON.stringify({ sub: 'synthetic-self', nonce })) + '.signature'
    localStorage.setItem('auth_token', jwt('a'))
    const old = deferred()
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(fixedScheduleFixture('pending_apply', true)))
    const { loader } = harness(fetch)
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', jwt('b'))
    await flushPromises()
    expect(loader.data.value?.state).toBe('pending_apply')
    old.resolve(response(fixedScheduleFixture('effective', true)))
    await flushPromises()
    expect(loader.data.value?.state).toBe('pending_apply')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('does not dispatch a queued initial read after its host unmounts', async () => {
    const fetch = vi.fn().mockResolvedValue(response(fixedScheduleFixture('effective', true)))
    const { wrapper, loader } = harness(fetch)
    wrapper.unmount()
    await flushPromises()
    expect(fetch).not.toHaveBeenCalled()
    expect(loader.data.value).toBeNull()
  })
  it('aborts on unmount and ignores both settlement and queued auth notifications', async () => {
    const old = deferred()
    const fetch = vi.fn().mockReturnValue(old.promise)
    const { loader, wrapper } = harness(fetch)
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    const signal = fetch.mock.calls[0][1].signal as AbortSignal
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'synthetic-session-b')
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    old.resolve(response(fixedScheduleFixture('effective', true)))
    await flushPromises()
    expect(loader.data.value).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
