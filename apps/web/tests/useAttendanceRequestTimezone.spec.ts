// @vitest-environment node
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { useAttendanceRequestTimezone } from '../src/views/attendance/useAttendanceRequestTimezone'
import { attendanceTimezoneErrorMessage } from '../src/views/attendance/attendanceTimezoneError'
import type { apiFetch } from '../src/utils/api'

const dto = (workDate = '2026-01-07', timezone = 'Asia/Singapore') => ({
  ok: true, data: {
    orgId: 'org-a', userId: 'self-a', workDate, timezone, contextFingerprint: 'a'.repeat(64),
    frozen: false, referenceId: null, provenance: null, isWorkingDay: true,
    window: { startAt: '2026-01-07T01:00:00.000Z', endAt: '2026-01-07T10:00:00.000Z' },
    rule: { workStartTime: '09:00', workEndTime: '18:00' },
  },
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(r => { resolve = r })
  return { promise, resolve }
}
function fixture(send: typeof apiFetch) {
  const workDate = ref('2026-01-07')
  const userId = ref('self-a')
  const enabled = ref(true)
  const inAt = ref('2026-01-07T09:00')
  const outAt = ref('2026-01-07T18:00')
  const originals = ref<{ requestedInAt: string; requestedOutAt: string } | null>(null)
  let identity = 'principal-a'
  const guard = createAttendanceSessionGuard('org-a', () => identity)
  const scope = effectScope()
  let state!: ReturnType<typeof useAttendanceRequestTimezone>
  scope.run(() => { state = useAttendanceRequestTimezone({
    workDate: () => workDate.value, userId: () => userId.value, enabled: () => enabled.value,
    inAt: () => inAt.value, outAt: () => outAt.value, originals: () => originals.value,
    guard, fetch: guard.wrapFetch(send),
  }) })
  return { state, workDate, userId, enabled, inAt, outAt, originals, guard, scope,
    changeIdentity: () => { identity = 'principal-b'; guard.isCurrent() } }
}

describe('related document trusted target timezone state', () => {
  it('retains the known failure code, blocks submission and clears it on recovery or session change', async () => {
    const send = vi.fn().mockResolvedValueOnce(response({ ok: false, error: {
      code: 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED', message: 'PRIVATE_SENTINEL',
    } }, 422)).mockImplementation(async () => response(dto()))
    const f = fixture(send); await settle()
    expect(f.state.errorCode.value).toBe('ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED')
    expect(f.state.ready.value).toBe(false)
    expect(f.state.times()).toBeNull()
    expect(attendanceTimezoneErrorMessage(f.state.errorCode.value, (_, zh) => zh))
      .toBe('本组织尚未配置默认考勤规则。请考勤管理员检查默认规则和升级前置条件；仅刷新不能修复缺失配置。')
    await f.state.refresh()
    expect(f.state.errorCode.value).toBeNull()
    expect(f.state.failed.value).toBe(false)
    expect(f.state.ready.value).toBe(true)
    f.changeIdentity()
    expect(f.state.errorCode.value).toBeNull()
    expect(f.state.times()).toBeNull()
    f.scope.stop()
  })
  it.each([null, {}, 'PRIVATE_SENTINEL', 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED PRIVATE_SENTINEL'])('never renders unknown error values: %j', code => {
    expect(attendanceTimezoneErrorMessage(code, en => en)).toBeNull()
  })

  it('accepts the complete HTTP envelope and converts both walls to target UTC with its fingerprint', async () => {
    const send = vi.fn(async () => response(dto()))
    const f = fixture(send)
    expect(f.state.times()).toBeNull()
    await settle()
    expect(send).toHaveBeenCalledWith('/api/attendance/timezone-context/me?workDate=2026-01-07', { method: 'GET' })
    expect(f.state.ready.value).toBe(true)
    expect(f.state.times()).toEqual({ requestedInAt: '2026-01-07T01:00:00.000Z',
      requestedOutAt: '2026-01-07T10:00:00.000Z', expectedTimezoneContextFingerprint: 'a'.repeat(64) })
    f.scope.stop()
  })
  it('uses Tokyo target time independently of browser timezone', async () => {
    const f = fixture(vi.fn(async () => response(dto('2026-01-07', 'Asia/Tokyo'))))
    await settle()
    expect(f.state.times()).toEqual({ requestedInAt: '2026-01-07T00:00:00.000Z',
      requestedOutAt: '2026-01-07T09:00:00.000Z', expectedTimezoneContextFingerprint: 'a'.repeat(64) })
    f.scope.stop()
  })
  it('clears the old target synchronously and ignores a late previous-date response', async () => {
    const first = deferred(); const second = deferred()
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const f = fixture(send)
    f.workDate.value = '2026-01-08'
    expect(f.state.ready.value).toBe(false)
    second.resolve(response(dto('2026-01-08', 'Asia/Tokyo')))
    await settle()
    expect(f.state.target.value?.workDate).toBe('2026-01-08')
    first.resolve(response(dto('2026-01-07')))
    await settle()
    expect(f.state.target.value?.timezone).toBe('Asia/Tokyo')
    expect(f.state.loading.value).toBe(false)
    expect(f.state.failed.value).toBe(false)
    f.scope.stop()
  })
  it('does not submit stale target times while a refresh is pending', async () => {
    const next = deferred()
    const send = vi.fn().mockResolvedValueOnce(response(dto())).mockReturnValueOnce(next.promise)
    const f = fixture(send); await settle()
    expect(f.state.ready.value).toBe(true)
    const pending = f.state.refresh()
    expect(f.state.target.value).toBeNull()
    expect(f.state.times()).toBeNull()
    next.resolve(response(dto())); await pending
    expect(f.state.ready.value).toBe(true)
    f.scope.stop()
  })
  it.each([
    { ...dto(), data: { ...dto().data, orgId: 'other' } },
    { ...dto(), data: { ...dto().data, userId: 'other' } },
    { ...dto(), data: { ...dto().data, contextFingerprint: 'unbound' } },
    { ...dto(), data: { ...dto().data, workDate: '2026-01-08' } },
  ])('refuses an unbound response and retains no partial target: %j', async body => {
    const f = fixture(vi.fn(async () => response(body))); await settle()
    expect({ failed: f.state.failed.value, target: f.state.target.value, times: f.state.times() })
      .toEqual({ failed: true, target: null, times: null })
    f.scope.stop()
  })
  it('requires an explicit repeated-time choice and resets it when the wall changes', async () => {
    const f = fixture(vi.fn(async () => response(dto('2026-01-07', 'America/New_York'))))
    await settle()
    f.inAt.value = '2026-11-01T01:30'
    f.outAt.value = ''
    expect(f.state.resolved.value.inAt.kind).toBe('fold')
    expect(f.state.times()).toBeNull()
    f.state.selected.inAt = '2026-11-01T06:30:00.000Z'
    expect(f.state.times()).toEqual({ requestedInAt: '2026-11-01T06:30:00.000Z',
      requestedOutAt: '', expectedTimezoneContextFingerprint: 'a'.repeat(64) })
    f.inAt.value = '2026-11-01T01:31'
    expect(f.state.selected.inAt).toBe('')
    expect(f.state.times()).toBeNull()
    f.scope.stop()
  })
  it('rejects a skipped local time without repairing it', async () => {
    const f = fixture(vi.fn(async () => response(dto('2026-01-07', 'America/New_York'))))
    await settle();f.inAt.value = '2026-03-08T02:30'
    expect(f.state.resolved.value.inAt.kind).toBe('gap')
    expect(f.state.times()).toBeNull()
    f.scope.stop()
  })
  it('preserves an unchanged original later fold with seconds/ms but honors a selected other offset', async () => {
    const f = fixture(vi.fn(async () => response(dto('2026-01-07', 'America/New_York'))))
    await settle()
    f.inAt.value = '2026-11-01T01:30:20.456'; f.outAt.value = ''
    f.originals.value = { requestedInAt: '2026-11-01T06:30:20.456Z', requestedOutAt: '' }
    expect(f.state.times()?.requestedInAt).toBe('2026-11-01T06:30:20.456Z')
    f.state.selected.inAt = '2026-11-01T05:30:20.456Z'
    expect(f.state.times()?.requestedInAt).toBe('2026-11-01T05:30:20.456Z')
    f.scope.stop()
  })
  it('discards in-flight response and all selections when the session changes', async () => {
    const pending = deferred(); const f = fixture(vi.fn(() => pending.promise))
    f.state.selected.inAt = 'old'
    f.changeIdentity()
    pending.resolve(response(dto())); await settle()
    expect({ target: f.state.target.value, ready: f.state.ready.value, selected: f.state.selected.inAt, loading: f.state.loading.value })
      .toEqual({ target: null, ready: false, selected: '', loading: false })
    expect(f.state.times()).toBeNull()
    f.scope.stop()
  })
  it('does not populate an unmounted scope from an in-flight response', async () => {
    const pending = deferred(); const f = fixture(vi.fn(() => pending.promise))
    f.scope.stop();pending.resolve(response(dto()));await settle()
    expect(f.state.target.value).toBeNull()
    expect(f.state.times()).toBeNull()
  })
  it.each([
    ['ATTENDANCE_TIMEZONE_DEFAULT_MISSING', '已有考勤配置需要升级检查，暂时无法补建默认考勤规则。请管理员检查升级前置条件。'],
    ['ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED', '该日期已有历史考勤记录，但缺少所需的冻结上下文。请管理员处理历史数据升级；刷新不能解决此问题。'],
  ])('explains the persistent upgrade blocker %s without suggesting a refresh repair', (code, message) => {
    expect(attendanceTimezoneErrorMessage(code, (_en, zh) => zh)).toBe(message)
  })
  it('does not guess a target after HTTP or network failure', async () => {
    const f = fixture(vi.fn(async () => response({ ok: false, error: { code: 'private-value' } }, 409)))
    await settle();expect(f.state.failed.value).toBe(true);expect(f.state.times()).toBeNull()
    f.scope.stop()
  })
})
