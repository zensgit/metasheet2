import { computed, onScopeDispose, ref, watch } from 'vue'
import type { createAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import type { apiFetch } from '../../utils/api'
import { randomUuid } from '../../utils/uuid'
import { formatRecordRequestTime } from './attendanceRecordRequestPrefill'
import { parseAttendanceTimezoneTarget, type AttendanceTimezoneTarget } from './attendanceTimezoneTarget'
import { parseFrozenTargets, type CorrectionTargets } from './attendanceCorrectionTargets'
import { correctionDecisionContext, type CorrectionDecisionContext, type CorrectionRequestRow } from './attendanceCorrectionRequestContext'
import type { useAttendanceCorrectionTargets } from './useAttendanceCorrectionTargets'
import type { useAttendanceRequestTimezone } from './useAttendanceRequestTimezone'

export function useAttendanceCorrectionEdit(input: {
  form: { workDate: string; requestType: string; requestedInAt: string; requestedOutAt: string; reason: string; attachmentUrl: string }
  originals: { value: { requestedInAt: string; requestedOutAt: string } | null }
  userId: () => string; orgId: () => string; guard: ReturnType<typeof createAttendanceSessionGuard>
  targets: ReturnType<typeof useAttendanceCorrectionTargets>; timezone: ReturnType<typeof useAttendanceRequestTimezone>
  send: typeof apiFetch; reload: () => Promise<unknown>
}) {
  const active = ref<{ row: CorrectionRequestRow; context: CorrectionDecisionContext; targets: CorrectionTargets; timezone: AttendanceTimezoneTarget } | null>(null)
  const message = ref('')
  const busy = ref(false)
  const conflict = ref(false)
  const invalidated = ref<Record<string, string>>({})
  let generation = 0
  let retry: { key: string; operationId: string } | null = null
  let opening = false
  function eligible(row: CorrectionRequestRow): boolean {
    return input.guard.isCurrent() && row.status === 'pending' && row.user_id === input.userId()
      && ['missed_check_in', 'missed_check_out', 'time_correction'].includes(row.request_type)
      && !!parseFrozenTargets(row.metadata?.correctionTargets) && !!correctionDecisionContext(row)
  }
  function cancel(): void {
    ++generation
    active.value = null
    conflict.value = false
    retry = null
    busy.value = false
    input.originals.value = null
    input.form.requestedInAt = ''
    input.form.requestedOutAt = ''
    message.value = ''
  }
  async function begin(row: CorrectionRequestRow): Promise<boolean> {
    if (!eligible(row)) return false
    const context = correctionDecisionContext(row)!
    const targets = parseFrozenTargets(row.metadata?.correctionTargets)!
    const timezone = parseAttendanceTimezoneTarget({ ok: true, data: row.metadata?.timezoneContextV1 },
      { orgId: input.guard.orgId, userId: input.userId(), workDate: row.work_date })
    if (!timezone || [row.requested_in_at, row.requested_out_at].some(value => value !== null
      && (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))))) {
      message.value = 'ATTENDANCE_CORRECTION_EDIT_TIMEZONE_CONTEXT_REQUIRED'
      return false
    }
    cancel()
    const current = ++generation
    opening = true
    input.form.workDate = row.work_date
    input.form.requestType = row.request_type
    input.form.requestedInAt = formatRecordRequestTime(row.requested_in_at ?? '', timezone.timezone)
    input.form.requestedOutAt = formatRecordRequestTime(row.requested_out_at ?? '', timezone.timezone)
    input.form.reason = row.reason ?? ''
    input.form.attachmentUrl = typeof row.metadata?.attachmentUrl === 'string' ? row.metadata.attachmentUrl : ''
    input.originals.value = { requestedInAt: row.requested_in_at ?? '', requestedOutAt: row.requested_out_at ?? '' }
    active.value = { row: { ...row }, context, targets, timezone }
    opening = false
    await Promise.all([input.timezone.refresh(), input.targets.refresh()])
    if (current !== generation || !input.guard.isCurrent() || !active.value) return false
    const result = input.targets.result.value
    if (result?.posture === 'canonical' && JSON.stringify(result.source) === JSON.stringify(targets.source)) {
      for (const side of ['checkIn', 'checkOut'] as const) {
        const index = result.candidates.findIndex(item => JSON.stringify(item.target) === JSON.stringify(targets[side]))
        input.targets.chosen[side] = index < 0 ? null : index
        if (targets[side] !== null && index < 0) conflict.value = true
      }
    }
    if (!ready.value) message.value = 'ATTENDANCE_CORRECTION_EDIT_FROZEN_CONTEXT_MISMATCH'
    return true
  }
  const ready = computed(() => {
    const edit = active.value
    const result = input.targets.result.value
    const zone = input.timezone.target.value
    return !conflict.value && !!edit && eligible(edit.row) && input.form.workDate === edit.row.work_date && input.form.requestType === edit.row.request_type
      && result?.posture === 'canonical' && JSON.stringify(result.source) === JSON.stringify(edit.targets.source)
      && zone?.contextFingerprint === edit.timezone.contextFingerprint && zone.timezone === edit.timezone.timezone
      && input.timezone.ready.value && input.targets.ready.value
  })
  function blocks(row: CorrectionRequestRow): boolean {
    const fingerprint = correctionDecisionContext(row)?.expectedSnapshotFingerprint
    return active.value?.row.id === row.id || (!!fingerprint && invalidated.value[row.id] === fingerprint)
  }
  async function save(payload: Record<string, unknown>): Promise<boolean> {
    const edit = active.value
    if (!edit || !ready.value || busy.value) { message.value = 'ATTENDANCE_CORRECTION_EDIT_FROZEN_CONTEXT_MISMATCH'; return false }
    const targets = input.targets.payload.value
    if (!targets) return false
    const times = input.timezone.times()
    if (!times) return false
    const patch = { workDate: edit.row.work_date, requestType: edit.row.request_type,
      ...(typeof payload.orgId === 'string' ? { orgId: payload.orgId } : {}),
      requestedInAt: times.requestedInAt, requestedOutAt: times.requestedOutAt,
      reason: input.form.reason, attachmentUrl: input.form.attachmentUrl, correctionTargets: targets,
      expectedTimezoneContextFingerprint: edit.timezone.contextFingerprint,
      expectedSnapshotVersion: edit.context.expectedSnapshotVersion, expectedSnapshotFingerprint: edit.context.expectedSnapshotFingerprint }
    const key = JSON.stringify(patch)
    try {
      if (!retry || retry.key !== key) retry = { key, operationId: randomUuid() }
    } catch { message.value = 'ATTENDANCE_CORRECTION_OPERATION_REQUIRED'; return false }
    const current = ++generation
    busy.value = true
    invalidated.value = { ...invalidated.value, [edit.row.id]: edit.context.expectedSnapshotFingerprint }
    try {
      const response = await input.send('/api/attendance/requests/' + encodeURIComponent(edit.row.id), { method: 'PUT',
        body: JSON.stringify({ ...patch, operationId: retry.operationId }) })
      const body = await response.json()
      if (current !== generation || !input.guard.isCurrent()) return false
      if (response.status === 409) {
        retry = null
        conflict.value = true
        input.targets.stale()
        message.value = 'ATTENDANCE_CORRECTION_EDIT_STALE_REOPEN_REQUIRED'
        await input.reload()
        return false
      }
      if (!response.ok || body?.ok !== true) { message.value = 'ATTENDANCE_CORRECTION_EDIT_FAILED'; return false }
      cancel()
      await input.reload()
      return true
    } catch {
      if (current === generation && input.guard.isCurrent()) message.value = 'ATTENDANCE_CORRECTION_EDIT_RETRY_REQUIRED'
      return false
    } finally { if (current === generation) busy.value = false }
  }
  watch([input.userId, input.orgId, input.guard.stale], () => { cancel(); invalidated.value = {} }, { flush: 'sync' })
  watch([() => input.form.workDate, () => input.form.requestType], () => {
    if (!opening && active.value && (input.form.workDate !== active.value.row.work_date || input.form.requestType !== active.value.row.request_type)) cancel()
  }, { flush: 'sync' })
  onScopeDispose(() => { ++generation })
  return { active, message, busy, ready, eligible, begin, cancel, save, blocks }
}
