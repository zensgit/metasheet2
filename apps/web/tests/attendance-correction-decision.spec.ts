import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref, type App, type Component } from 'vue'
import Actions from '../src/views/attendance/AttendanceCorrectionDecisionActions.vue'
import TargetsSection from '../src/views/attendance/AttendanceCorrectionTargetsSection.vue'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { useAttendanceCorrectionTargets } from '../src/views/attendance/useAttendanceCorrectionTargets'
import { useAttendanceRequestTimezone } from '../src/views/attendance/useAttendanceRequestTimezone'
import { useAttendanceCorrectionEdit } from '../src/views/attendance/useAttendanceCorrectionEdit'
import type { CorrectionRequestRow } from '../src/views/attendance/attendanceCorrectionRequestContext'
import type { apiFetch } from '../src/utils/api'

const ids = vi.hoisted(() => ({ next: 0 }))
vi.mock('../src/utils/uuid', () => ({ randomUuid: () => '00000000-0000-4000-8000-' + String(++ids.next).padStart(12, '0') }))
const tr = (_en: string, zh: string) => zh
const source = { recordId: '11111111-1111-1111-1111-111111111111', calculationId: '22222222-2222-2222-2222-222222222222', calculationVersion: 1, semanticInputFingerprint: 'a'.repeat(64) }
const target = (segmentIndex = 0) => ({ kind: 'replacement' as const, segmentIndex, direction: 'check_in' as const, evidenceRef: 'event:' + segmentIndex })
const timezone = { orgId: 'org-a', userId: 'user-a', workDate: '2026-10-30', timezone: 'Asia/Taipei', contextFingerprint: 'b'.repeat(64),
  frozen: true, referenceId: source.recordId, provenance: null, window: { startAt: '2026-10-30T01:00:00Z', endAt: '2026-10-30T09:00:00Z' }, rule: { timezone: 'Asia/Taipei' }, isWorkingDay: true }
const context = (version = 1) => ({ schemaVersion: 1, requestId: '33333333-3333-3333-3333-333333333333', approvalInstanceId: 'approval-a',
  expectedApprovalVersion: 0, expectedApprovalNode: 'step:0', expectedSnapshotVersion: version, expectedSnapshotFingerprint: String(version).repeat(64) })
const row = (): CorrectionRequestRow => ({ id: context().requestId, status: 'pending', user_id: 'user-a', work_date: '2026-10-30', request_type: 'time_correction',
  requested_in_at: '2026-10-30T01:05:12.123Z', requested_out_at: null, reason: 'original',
  metadata: { correctionTargets: { schemaVersion: 1, source, checkIn: target(), checkOut: null }, timezoneContextV1: timezone }, decisionContext: context() })
const reply = (status = 200, data: unknown = {}) => new Response(JSON.stringify({ ok: status < 400, data }), { status })
let app: App | null
let root: HTMLDivElement
const mount = (component: Component, props: Record<string, unknown>, guard: ReturnType<typeof createAttendanceSessionGuard>) => {
  root = document.createElement('div'); document.body.append(root)
  app = createApp(component, props); app.provide(attendanceSessionGuardKey, guard); app.mount(root)
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const click = async (selector: string) => { root.querySelector<HTMLButtonElement>(selector)!.click(); await flush() }
beforeEach(() => { ids.next = 0 })
afterEach(() => { app?.unmount(); app = null; root?.remove(); vi.restoreAllMocks() })

describe('mounted correction decision commands', () => {
  it('binds the displayed token, retains one command id for retry, and requires a new decision after 409', async () => {
    const guard = createAttendanceSessionGuard('org-a', () => 'principal-a')
    const send = vi.fn().mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(409)).mockResolvedValue(reply())
    const reload = vi.fn()
    const state = reactive({ row: row() })
    mount(defineComponent({ setup: () => () => h(Actions, { row: state.row, entitled: true, editing: false, tr, send: send as typeof apiFetch, onReload: reload }) }), {}, guard)
    expect(root.querySelector('[data-correction-decision-token]')?.textContent).toContain('step:0')
    await click('[data-correction-approve]')
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-correction-approve]')?.disabled).toBe(false))
    await click('[data-correction-approve]')
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    const first = JSON.parse(send.mock.calls[0][1].body)
    expect(first).toEqual({ expectedApprovalVersion: 0, expectedApprovalNode: 'step:0', expectedSnapshotVersion: 1,
      expectedSnapshotFingerprint: '1'.repeat(64), operationId: '00000000-0000-4000-8000-000000000001' })
    expect(JSON.parse(send.mock.calls[1][1].body)).toEqual(first)
    expect(reload).toHaveBeenCalledOnce()
    await click('[data-correction-approve]')
    expect(send).toHaveBeenCalledTimes(2)
    state.row = { ...row(), decisionContext: context(2) }
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    await click('[data-correction-approve]')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    expect(JSON.parse(send.mock.calls[2][1].body)).toEqual({ ...first, expectedSnapshotVersion: 2, expectedSnapshotFingerprint: '2'.repeat(64),
      operationId: '00000000-0000-4000-8000-000000000002' })
  })
  it('blocks missing tokens and existing row entitlement denial', async () => {
    const send = vi.fn()
    const state = reactive<{ row: CorrectionRequestRow; entitled: boolean }>({ row: { ...row(), decisionContext: undefined }, entitled: true })
    mount({ setup: () => () => h(Actions, { ...state, editing: false, tr, send }) }, {}, createAttendanceSessionGuard('org-a', () => 'principal-a'))
    await click('[data-correction-approve]')
    expect(send).not.toHaveBeenCalled()
    state.row = row()
    state.entitled = false
    await flush()
    expect(root.querySelector('[data-correction-approve]')).toBeNull()
  })
  it('keeps reject comments and clears an in-flight command across principals', async () => {
    let principal = 'principal-a'
    const guard = createAttendanceSessionGuard('org-a', () => principal)
    let complete!: (value: Response) => void
    const send = vi.fn((_path: string, _options?: RequestInit) => new Promise<Response>(resolve => { complete = resolve }))
    const resolved = vi.fn()
    vi.spyOn(window, 'prompt').mockReturnValueOnce('  ').mockReturnValueOnce('  reason  ')
    mount(Actions, { row: row(), entitled: true, editing: false, tr, send, onResolved: resolved }, guard)
    await click('[data-correction-reject]')
    expect(send).not.toHaveBeenCalled()
    await click('[data-correction-reject]')
    expect(JSON.parse(send.mock.calls[0][1]!.body as string).comment).toBe('reason')
    principal = 'principal-b'
    guard.isCurrent()
    complete(reply())
    await flush()
    expect(resolved).not.toHaveBeenCalled()
    expect(root.querySelector<HTMLButtonElement>('[data-correction-approve]')?.disabled).toBe(true)
  })
})

function editorFixture(initial = row(), candidateSource = source) {
  const guard = createAttendanceSessionGuard('org-a', () => 'principal-a')
  const selected = vi.fn()
  const reload = vi.fn(async () => {})
  const candidates = [0, 1].map(index => ({ target: target(index), display: { timezone: timezone.timezone,
    expectedStartAt: timezone.window.startAt, expectedEndAt: timezone.window.endAt, originalOccurredAt: '2026-10-30T01:00:00Z', source: 'attendance_event' } }))
  const send = vi.fn(async (path: string, _options?: RequestInit) => path.includes('timezone-context') ? reply(200, timezone)
    : path.includes('correction-targets') ? reply(200, { schemaVersion: 1, posture: 'canonical', source: candidateSource, candidates }) : reply())
  const currentRow = ref(initial)
  let editor!: ReturnType<typeof useAttendanceCorrectionEdit>
  mount({
    setup() {
      const form = reactive({ workDate: '2026-10-30', requestType: 'time_correction', requestedInAt: '', requestedOutAt: '', reason: '', attachmentUrl: '' })
      const originals = ref<{ requestedInAt: string; requestedOutAt: string } | null>(null)
      const time = useAttendanceRequestTimezone({ workDate: () => form.workDate, userId: () => 'user-a', enabled: () => true,
        inAt: () => form.requestedInAt, outAt: () => form.requestedOutAt, originals: () => originals.value, guard, fetch: send as typeof apiFetch })
      const targets = useAttendanceCorrectionTargets({ workDate: () => form.workDate, userId: () => 'user-a', orgId: () => 'org-a',
        requestType: () => form.requestType, enabled: () => true, inAt: () => form.requestedInAt, outAt: () => form.requestedOutAt, guard, fetch: send as typeof apiFetch })
      editor = useAttendanceCorrectionEdit({ form, originals, userId: () => 'user-a', orgId: () => 'org-a', guard, targets, timezone: time,
        send: send as typeof apiFetch, reload })
      return () => h('div', [
        h('button', { 'data-edit': '', onClick: () => editor.begin(currentRow.value) }, 'edit'),
        h(TargetsSection, { tr, result: targets.result.value, chosen: targets.chosen, requested: targets.requested.value,
          loading: targets.loading.value, error: targets.error.value, onSelect: (side: 'checkIn' | 'checkOut', index: number | null) => { selected(side, index); targets.chosen[side] = index } }),
        h('button', { 'data-cancel-edit': '', onClick: () => editor.cancel() }, 'cancel'),
        h('button', { 'data-save': '', disabled: !editor.ready.value, onClick: () => editor.save({ workDate: form.workDate, requestType: form.requestType }) }, 'save'),
        h(Actions, { row: currentRow.value, entitled: true, editing: editor.blocks(currentRow.value), tr, send: send as typeof apiFetch }),
      ])
    },
  }, {}, guard)
  return { guard, selected, reload, send, currentRow, get editor() { return editor } }
}

describe('mounted pending correction editor', () => {
  it('refuses a changed frozen source without switching targets or sending PUT', async () => {
    const f = editorFixture(row(), { ...source, calculationVersion: 2 })
    await click('[data-edit]')
    await vi.waitFor(() => expect(f.editor.message.value).toBe('ATTENDANCE_CORRECTION_EDIT_FROZEN_CONTEXT_MISMATCH'))
    expect(f.editor.active.value?.targets.source).toEqual(source)
    expect(f.editor.ready.value).toBe(false)
    await click('[data-save]')
    expect(f.send.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false)
    expect(f.editor.message.value).toBe('ATTENDANCE_CORRECTION_EDIT_FROZEN_CONTEXT_MISMATCH')
    await click('[data-cancel-edit]')
    expect(f.editor.active.value).toBeNull()
  })
  it('refuses an owned pending request without frozen timezone DTO and adds no legacy or foreign-user edit capability', async () => {
    const original = row()
    const f = editorFixture({ ...original, metadata: { correctionTargets: original.metadata!.correctionTargets } })
    await click('[data-edit]')
    expect(f.editor.active.value).toBeNull()
    expect(f.editor.message.value).toBe('ATTENDANCE_CORRECTION_EDIT_TIMEZONE_CONTEXT_REQUIRED')
    expect(f.editor.eligible({ ...row(), metadata: {} })).toBe(false)
    expect(f.editor.eligible({ ...row(), user_id: 'user-b' })).toBe(false)
    expect(f.send.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false)
  })
  it('emits actual candidate choice into PUT, preserves original instant, and blocks approval of the edited snapshot', async () => {
    const { guard, selected, reload, send, currentRow, editor } = editorFixture()
    await click('[data-edit]')
    await vi.waitFor(() => expect(editor.ready.value).toBe(true))
    const select = root.querySelector<HTMLSelectElement>('[data-correction-targets] select')!
    select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); await flush()
    expect(selected).toHaveBeenCalledWith('checkIn', 1)
    await click('[data-save]')
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    const writes = send.mock.calls.filter(call => !call[0].includes('timezone-context') && !call[0].includes('correction-targets'))
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe('/api/attendance/requests/' + context().requestId)
    const options = (send.mock.calls as unknown as Array<[string, RequestInit]>).find(call => call[1]?.method === 'PUT')![1]
    expect(JSON.parse(String(options.body))).toEqual({ workDate: '2026-10-30', requestType: 'time_correction',
      requestedInAt: '2026-10-30T01:05:12.123Z', requestedOutAt: '', reason: 'original', attachmentUrl: '',
      correctionTargets: { schemaVersion: 1, source, checkIn: target(1), checkOut: null },
      expectedTimezoneContextFingerprint: timezone.contextFingerprint, expectedSnapshotVersion: 1,
      expectedSnapshotFingerprint: '1'.repeat(64), operationId: '00000000-0000-4000-8000-000000000001' })
    await click('[data-correction-approve]')
    expect(send.mock.calls.filter(call => call[0].endsWith('/approve'))).toHaveLength(0)
    currentRow.value = { ...row(), decisionContext: context(2) }
    await flush()
    await click('[data-correction-approve]')
    const decision = (send.mock.calls as unknown as Array<[string, RequestInit]>).find(call => call[0].endsWith('/approve'))!
    expect(JSON.parse(String(decision[1].body)).expectedSnapshotVersion).toBe(2)
    expect(reload).toHaveBeenCalledOnce()
    await click('[data-edit]')
    expect(editor.active.value?.row.id).toBe(context().requestId)
    guard.invalidate()
    await flush()
    expect(editor.active.value).toBeNull()
    expect(root.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(true)
  })
})
