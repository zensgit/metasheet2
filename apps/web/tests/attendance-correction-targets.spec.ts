import { describe, expect, it, vi } from 'vitest'
import AttendanceCorrectionTargetsSection from '../src/views/attendance/AttendanceCorrectionTargetsSection.vue'
import { createApp, effectScope, nextTick, ref } from 'vue'
import { createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { parseCorrectionTargets, parseFrozenTargets, projectCorrectionTargets } from '../src/views/attendance/attendanceCorrectionTargets'
import { useAttendanceCorrectionTargets } from '../src/views/attendance/useAttendanceCorrectionTargets'

const source = { recordId: '11111111-1111-1111-1111-111111111111', calculationId: '22222222-2222-2222-2222-222222222222', calculationVersion: 1, semanticInputFingerprint: 'a'.repeat(64) }
const display = { timezone: 'Asia/Taipei', expectedStartAt: '2026-10-30T01:00:00Z', expectedEndAt: '2026-10-30T09:00:00Z', originalOccurredAt: '2026-10-30T01:05:00Z', source: 'attendance_event' }
const replacement = (segmentIndex: number, direction = 'check_in') => ({ target: { kind: 'replacement', segmentIndex, direction, evidenceRef: 'event:123' }, display })
const insertion = { target: { kind: 'insertion', segmentIndex: 0, direction: 'check_out' }, display: { ...display, originalOccurredAt: null, source: 'empty_boundary' } }
const body = (candidates: unknown[]) => ({ ok: true, data: { schemaVersion: 1, posture: 'canonical', source, candidates } })

describe('correction target projection', () => {
  it('requires an explicit choice for multiple candidates and projects only closed targets', () => {
    const result = parseCorrectionTargets(body([replacement(0), replacement(1), insertion]))
    expect(result?.posture).toBe('canonical')
    if (!result) throw new Error('fixture')
    expect(projectCorrectionTargets(result, { checkIn: null, checkOut: null }, { checkIn: true, checkOut: true })).toBeNull()
    expect(projectCorrectionTargets(result, { checkIn: 1, checkOut: null }, { checkIn: true, checkOut: true })).toEqual({
      schemaVersion: 1, source, checkIn: replacement(1).target, checkOut: insertion.target,
    })
    expect(projectCorrectionTargets(result, { checkIn: 1, checkOut: 2 }, { checkIn: false, checkOut: true })).toEqual({
      schemaVersion: 1, source, checkIn: null, checkOut: insertion.target,
    })
  })
  it('accepts only explicit legacy and rejects invalid target and namespace fields', () => {
    expect(parseCorrectionTargets({ ok: true, data: { schemaVersion: 1, posture: 'legacy_projection_only', source: null, candidates: [] } })).toEqual({ posture: 'legacy_projection_only' })
    expect(parseCorrectionTargets(body([{ ...replacement(0), target: { ...replacement(0).target, orgId: 'foreign' } }]))).toBeNull()
    expect(parseCorrectionTargets(body([{ ...insertion, target: { ...insertion.target, evidenceRef: 'invented' } }]))).toBeNull()
    expect(parseCorrectionTargets({ ok: true, data: { schemaVersion: 1, posture: 'unknown', source: null, candidates: [] } })).toBeNull()
    expect(parseFrozenTargets({ schemaVersion: 1, source, checkIn: insertion.target, checkOut: null })).toBeNull()
  })
})

describe('correction target session isolation', () => {
  it('admits only explicit legacy through the real composable and refuses errors or unverified sources', async () => {
    const guard = createAttendanceSessionGuard('org-a', () => 'principal-a')
    const pending: Array<(value: Response) => void> = []
    const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
    const scope = effectScope()
    const state = scope.run(() => useAttendanceCorrectionTargets({
      workDate: () => '2026-10-30', userId: () => 'user-a', orgId: () => 'org-a', requestType: () => 'missed_check_in',
      inAt: () => '2026-10-30T09:00', outAt: () => '', enabled: () => true, guard,
      fetch: fetch as unknown as typeof import('../src/utils/api').apiFetch,
    }))!
    const legacy = { ok: true, data: { schemaVersion: 1, posture: 'legacy_projection_only', source: null, candidates: [] } }
    try {
      pending[0]({ ok: true, json: async () => legacy } as Response)
      const refresh = state.refresh()
      pending[1]({ ok: true, json: async () => legacy } as Response)
      await refresh
      expect(state.result.value).toEqual({ posture: 'legacy_projection_only' })
      expect(state.ready.value).toBe(true)
      expect(state.payload.value).toBeNull()

      for (const [ok, responseBody, error] of [
        [false, { ok: false, error: { code: 'NOT_FOUND' } }, 'NOT_FOUND'],
        [true, { ok: true, data: { schemaVersion: 1, posture: 'unknown', source: null, candidates: [] } }, 'ATTENDANCE_CORRECTION_TARGET_INVALID'],
        [true, { ok: true, data: { schemaVersion: 1, posture: 'canonical', source: null, candidates: [] } }, 'ATTENDANCE_CORRECTION_TARGET_INVALID'],
      ] as const) {
        const refresh = state.refresh()
        expect(state.ready.value).toBe(false)
        expect(state.payload.value).toBeNull()
        pending[pending.length - 1]({ ok, json: async () => responseBody } as Response)
        await refresh
        expect(state.result.value).toBeNull()
        expect(state.ready.value).toBe(false)
        expect(state.payload.value).toBeNull()
        expect(state.error.value).toBe(error)
      }
    } finally {
      scope.stop()
    }
  })
  it('discards late responses after date, request type, org and principal changes', async () => {
    let identity = 'principal-a'
    const guard = createAttendanceSessionGuard('org-a', () => identity)
    const date = ref('2026-10-30')
    const org = ref('org-a')
    const user = ref('user-a')
    const type = ref('missed_check_in')
    const pending: Array<(value: Response) => void> = []
    const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
    const scope = effectScope()
    const state = scope.run(() => useAttendanceCorrectionTargets({
      workDate: () => date.value, userId: () => user.value, orgId: () => org.value, requestType: () => type.value,
      inAt: () => '2026-10-30T09:00', outAt: () => '', enabled: () => true, guard,
      fetch: fetch as unknown as typeof import('../src/utils/api').apiFetch,
    }))!
    const response = () => ({ ok: true, json: async () => body([replacement(0)]) }) as Response
    date.value = '2026-10-31'
    pending[0](response())
    await nextTick()
    await Promise.resolve()
    expect(state.result.value).toBeNull()
    user.value = 'user-b'
    pending[1](response())
    await nextTick()
    await Promise.resolve()
    expect(state.result.value).toBeNull()
    type.value = 'missed_check_out'
    pending[2](response())
    await nextTick()
    await Promise.resolve()
    expect(state.result.value).toBeNull()
    org.value = 'org-b'
    pending[3](response())
    await nextTick()
    await Promise.resolve()
    expect(state.result.value).toBeNull()
    org.value = 'org-a'
    identity = 'principal-b'
    pending[4](response())
    await nextTick()
    await Promise.resolve()
    expect(state.result.value).toBeNull()
    expect(state.ready.value).toBe(false)
    scope.stop()
  })
})

describe('correction target human selection', () => {
  it('identical timestamps remain distinguishable by exact evidence reference and source', async () => {
    const first = replacement(0)
    const second = { ...replacement(0), target: { ...replacement(0).target, evidenceRef: 'event:456' } }
    const result = parseCorrectionTargets(body([first, second]))
    if (result?.posture !== 'canonical') throw new Error('canonical fixture')
    const root = document.createElement('div')
    document.body.append(root)
    const onSelect = vi.fn()
    const app = createApp(AttendanceCorrectionTargetsSection, {
      tr: (en: string) => en, result, loading: false, error: '',
      chosen: { checkIn: null, checkOut: null }, requested: { checkIn: true, checkOut: false }, onSelect,
    })
    app.mount(root)
    try {
      const labels = Array.from(root.querySelectorAll('option')).slice(1).map(option => option.textContent)
      expect(labels).toHaveLength(2)
      expect(labels[0]).toContain('Source: attendance_event')
      expect(labels[0]).toContain('Reference: event:123')
      expect(labels[1]).toContain('Source: attendance_event')
      expect(labels[1]).toContain('Reference: event:456')
      expect(labels[0]).not.toBe(labels[1])
      expect(projectCorrectionTargets(result, { checkIn: null, checkOut: null }, { checkIn: true, checkOut: false })).toBeNull()
      const select = root.querySelector('select')
      if (!select) throw new Error('target select missing')
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith('checkIn', 1)
      expect(projectCorrectionTargets(result, { checkIn: 1, checkOut: null }, { checkIn: true, checkOut: false })).toEqual({
        schemaVersion: 1, source, checkIn: second.target, checkOut: null,
      })
    } finally {
      app.unmount()
      root.remove()
    }
  })
})
