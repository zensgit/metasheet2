import { computed, onScopeDispose, reactive, ref, shallowRef, watch, type Ref } from 'vue'

import { businessEffectiveDateError, withBusinessEffectiveDate } from './attendanceBusinessEffectiveDate'

type Translate = (en: string, zh: string) => string
type Candidate = { shiftId: string; startDate: string; endDate: string }
type Desired = Candidate & { revision: number }
export type FixedScheduleManagedSet = Omit<Candidate, 'endDate'> & { endDate: string | null; producerKey: string; rowCount: number }
export type FixedScheduleEditor = {
  groupId: string
  state: 'not_configured' | 'configuration_changed' | 'effective' | 'pending_apply'
  reasonCodes: string[]
  desired: Desired | null
  drift: { managedSets: FixedScheduleManagedSet[] }
  capabilities?: { businessEffectiveDateRequired?: unknown }
  referenceEligibility: { shiftId: string; allowed: boolean; reasonCode: string | null } | null
}
type PreviewResult = {
  target: { total: number }
  wouldCreate: unknown[]
  skipped: unknown[]
  blockingConflicts: unknown[]
  applied?: boolean
  rebuilt?: boolean
  deactivated?: unknown[]
}
type Options = {
  groupId: Ref<string | null>
  orgId: () => string | undefined
  enabled: Ref<boolean>
  hasShift: (shiftId: string) => boolean
  rememberShift: (shift: unknown) => void
  apiFetch: (path: string, options?: RequestInit) => Promise<Response>
  tr: Translate
  setStatus: (message: string, kind?: 'info' | 'error') => void
  reloadAssignments: (isCurrent: () => boolean) => Promise<void>
  confirm: (message: string) => boolean
}
const states = ['not_configured', 'configuration_changed', 'effective', 'pending_apply']
const reasons = new Set(['NO_DESIRED_CONFIG', 'NO_TARGET_MEMBERS', 'DIFFERENT_MANAGED_KEY_ACTIVE', 'TARGET_MEMBER_MISSING', 'NON_MEMBER_TARGET_ACTIVE', 'DUPLICATE_MATCHING_ASSIGNMENT', 'ASSIGNMENT_VALUE_MISMATCH', 'UNPUBLISHED_MANAGED_ROW', 'EFFECTIVE'])
const multiSegmentCode = 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED'
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
function candidate(value: unknown): value is Candidate & Record<string, unknown> {
  return record(value) && typeof value.shiftId === 'string' && value.shiftId.length > 0
    && date(value.startDate) && date(value.endDate) && value.startDate <= value.endDate
}
function desired(value: unknown): value is Desired & Record<string, unknown> {
  return candidate(value) && record(value) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0
}
export function parseFixedScheduleEditor(value: unknown, groupId: string): FixedScheduleEditor {
  if (!record(value) || value.groupId !== groupId || !states.includes(String(value.state))
    || !Array.isArray(value.reasonCodes) || !value.reasonCodes.every(code => typeof code === 'string' && reasons.has(code))
    || (value.desired !== null && !desired(value.desired))
    || (value.state === 'not_configured') !== (value.desired === null)
    || !record(value.drift) || !Array.isArray(value.drift.managedSets)
    || !value.drift.managedSets.every(set => record(set) && typeof set.shiftId === 'string' && set.shiftId.length > 0
      && date(set.startDate) && (set.endDate === null || (date(set.endDate) && set.startDate <= set.endDate))
      && typeof set.producerKey === 'string' && set.producerKey.length > 0
      && Number.isSafeInteger(set.rowCount) && Number(set.rowCount) > 0)) {
    throw new Error('INVALID_FIXED_SCHEDULE_EDITOR')
  }
  const eligibility = value.referenceEligibility
  if (eligibility !== null && (!record(eligibility) || typeof eligibility.shiftId !== 'string'
    || !eligibility.shiftId || typeof eligibility.allowed !== 'boolean'
    || !(eligibility.reasonCode === null || eligibility.reasonCode === multiSegmentCode)
    || (eligibility.allowed && eligibility.reasonCode !== null)
    || (!eligibility.allowed && eligibility.reasonCode !== multiSegmentCode))) {
    throw new Error('INVALID_FIXED_SCHEDULE_EDITOR')
  }
  return value as FixedScheduleEditor
}
class FixedScheduleRequestError extends Error {
  declare readonly code: string
  declare readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.code = code
    this.status = status
  }
}
export function useAttendanceGroupFixedSchedule<Result extends PreviewResult>(options: Options) {
  const { tr } = options
  const form = reactive<Candidate>({ shiftId: '', startDate: '', endDate: '' })
  const effectiveDates = reactive({ save: '', apply: '', rebuild: '', clear: '' })
  const editor = ref<FixedScheduleEditor | null>(null)
  const loadState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const errorMessage = ref('')
  const previewResult = shallowRef<Result | null>(null)
  const operation = ref<'save' | 'preview' | 'apply' | 'rebuild' | 'clear' | null>(null)
  const selectedManagedKey = ref('')
  let generation = 0
  let readSequence = 0
  let draftVersion = 0
  let hydrating = false
  let operationSequence = 0
  onScopeDispose(() => { generation += 1; readSequence += 1; operationSequence += 1 })
  const fingerprint = () => JSON.stringify([form.shiftId, form.startDate, form.endDate])
  const context = () => JSON.stringify([options.orgId() ?? '', options.groupId.value, options.enabled.value])
  const snapshot = () => ({ generation, context: context(), fingerprint: fingerprint(), draftVersion, revision: editor.value?.desired?.revision ?? 0 })
  const current = (token: ReturnType<typeof snapshot>) => token.generation === generation
    && token.context === context() && token.fingerprint === fingerprint() && token.draftVersion === draftVersion
  const effectiveDateAvailable = computed(() => {
    const data = editor.value
    if (!options.enabled.value || !data || data.groupId !== options.groupId.value) return false
    return record(data.capabilities) && data.capabilities.businessEffectiveDateRequired === true
  })
  const busy = computed(() => loadState.value === 'loading' || operation.value !== null)
  const ready = computed(() => options.enabled.value && Boolean(options.groupId.value) && loadState.value === 'ready')
  const valid = computed(() => candidate(form) && options.hasShift(form.shiftId))
  const dirty = computed(() => !editor.value?.desired || JSON.stringify([
    editor.value.desired.shiftId, editor.value.desired.startDate, editor.value.desired.endDate,
  ]) !== fingerprint())
  const saved = computed(() => ready.value && valid.value && !dirty.value && Boolean(editor.value?.desired))
  const allowed = computed(() => editor.value?.referenceEligibility?.shiftId === form.shiftId
    && editor.value.referenceEligibility.allowed === true)
  const previewAvailable = computed(() => ready.value && valid.value && !busy.value)
  const saveAvailable = computed(() => previewAvailable.value && dirty.value)
  const rebuildAvailable = computed(() => saved.value && allowed.value && !busy.value)
  const applyAvailable = computed(() => rebuildAvailable.value && Boolean(previewResult.value)
    && previewResult.value!.blockingConflicts.length === 0 && !previewResult.value!.applied && !previewResult.value!.rebuilt)
  const managedSets = computed(() => editor.value?.drift.managedSets ?? [])
  const managedKey = (set: FixedScheduleManagedSet) => JSON.stringify([set.producerKey, set.shiftId, set.startDate, set.endDate])
  const selectedManagedSet = computed(() => managedSets.value.find(set => managedKey(set) === selectedManagedKey.value) ?? null)
  const clearAvailable = computed(() => ready.value && !busy.value && (selectedManagedKey.value
    ? candidate(selectedManagedSet.value) : saved.value))
  const eligibilityHint = computed(() => {
    if (loadState.value !== 'ready') return ''
    if (form.shiftId && !options.hasShift(form.shiftId)) return tr('The saved shift is unavailable in this list. Select an available shift to continue.', '已保存班次当前不在可用列表中，请选择可用班次后继续。')
    if (editor.value?.referenceEligibility?.reasonCode === multiSegmentCode) return tr('This organization cannot apply or rebuild multi-segment shifts. Preview and saving the desired configuration remain available.', '当前组织暂不支持应用或重建多时段班次，仍可预览及保存期望配置。')
    if (dirty.value) return tr('Save the desired configuration before applying or rebuilding. Saving does not write assignments.', '请先保存期望配置，再应用或重建；保存配置不会写入排班。')
    return ''
  })
  function localizedError(error: unknown): string {
    if (error instanceof FixedScheduleRequestError) {
      const effectiveError = businessEffectiveDateError(error.code, tr)
      if (effectiveError) return effectiveError
      if (error.code === 'ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED') return tr('The saved configuration changed. Reload it and review before retrying.', '已保存配置已变化，请重新加载并核对后再操作。')
      if (error.code === multiSegmentCode) return tr('This organization cannot reference multi-segment shifts for scheduling.', '当前组织暂不支持引用多时段班次进行排班。')
      if (error.status === 403) return tr('You do not have permission to manage this group schedule.', '没有管理此考勤组排班的权限。')
      if (error.status === 404) return tr('The group or shift is unavailable. Reload and select again.', '考勤组或班次不可用，请重新加载后选择。')
      if (error.status === 503) return tr('Schedule configuration is temporarily unavailable. Reload before continuing.', '排班配置暂时不可用，请重新加载后继续。')
    }
    return tr('Unable to read or update the fixed schedule safely. Reload before continuing.', '无法安全读取或更新固定排班，请重新加载后继续。')
  }
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await options.apiFetch(path, init)
    const body: unknown = await response.json()
    if (!response.ok || !record(body) || body.ok !== true) {
      const error = record(body) && record(body.error) ? body.error : null
      throw new FixedScheduleRequestError(typeof error?.code === 'string' ? error.code : '', response.status)
    }
    return body.data
  }
  function fail(error: unknown) {
    errorMessage.value = localizedError(error)
    options.setStatus(errorMessage.value, 'error')
    previewResult.value = null
    // After any failed write the authoritative state must be read again before retrying.
    editor.value = null
    loadState.value = 'error'
  }
  async function load(hydrate = true) {
    const groupId = options.groupId.value
    if (!groupId || !options.enabled.value) return
    const token = snapshot()
    const sequence = ++readSequence
    loadState.value = 'loading'
    errorMessage.value = ''
    const query = new URLSearchParams()
    const orgId = options.orgId()
    if (orgId) query.set('orgId', orgId)
    if (!hydrate && form.shiftId) query.set('shiftId', form.shiftId)
    try {
      const data = parseFixedScheduleEditor(await request(`/api/attendance/groups/${groupId}/fixed-schedule/editor?${query.toString()}`), groupId)
      if (!current(token) || sequence !== readSequence) return
      const expectedShiftId = !hydrate && form.shiftId ? form.shiftId : data.desired?.shiftId ?? null
      if ((data.referenceEligibility?.shiftId ?? null) !== expectedShiftId) throw new Error('INVALID_FIXED_SCHEDULE_EDITOR')
      if (expectedShiftId && !options.hasShift(expectedShiftId)) {
        try {
          const shiftQuery = new URLSearchParams()
          if (orgId) shiftQuery.set('orgId', orgId)
          const shift = await request(`/api/attendance/shifts/${encodeURIComponent(expectedShiftId)}?${shiftQuery.toString()}`)
          if (!current(token) || sequence !== readSequence) return
          if (record(shift) && shift.id === expectedShiftId && typeof shift.name === 'string'
            && typeof shift.workStartTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(shift.workStartTime)
            && typeof shift.workEndTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(shift.workEndTime)
            && Array.isArray(shift.workingDays) && shift.workingDays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
            && (shift.orgId === undefined || orgId === undefined || shift.orgId === orgId)) options.rememberShift(shift)
        } catch {
          // Keep the saved selection visible but unavailable when its own read is denied.
          if (!current(token) || sequence !== readSequence) return
        }
      }
      if ((editor.value?.desired?.revision ?? 0) !== (data.desired?.revision ?? 0)) previewResult.value = null
      editor.value = data
      if (hydrate) {
        hydrating = true
        Object.assign(form, { shiftId: data.desired?.shiftId ?? '', startDate: data.desired?.startDate ?? '', endDate: data.desired?.endDate ?? '' })
        hydrating = false
      }
      loadState.value = 'ready'
    } catch (error) {
      if (current(token) && sequence === readSequence) fail(error)
    }
  }
  watch(() => [form.shiftId, form.startDate, form.endDate], (next, previous) => {
    if (!hydrating && next[0] !== previous[0]) Object.assign(effectiveDates, { save: '', apply: '', rebuild: '', clear: '' })
    draftVersion += 1
    previewResult.value = null
    if (!hydrating && (next[0] !== previous[0] || loadState.value === 'loading') && options.groupId.value && options.enabled.value) void load(false)
  }, { flush: 'sync' })
  watch(effectiveDateAvailable, () => {
    Object.assign(effectiveDates, { save: '', apply: '', rebuild: '', clear: '' })
  }, { flush: 'sync' })
  watch(selectedManagedKey, () => { effectiveDates.clear = '' }, { flush: 'sync' })
  watch(context, () => {
    generation += 1
    readSequence += 1
    operationSequence += 1
    operation.value = null
    editor.value = null
    loadState.value = 'idle'
    errorMessage.value = ''
    selectedManagedKey.value = ''
    Object.assign(effectiveDates, { save: '', apply: '', rebuild: '', clear: '' })
    hydrating = true
    Object.assign(form, { shiftId: '', startDate: '', endDate: '' })
    hydrating = false
    previewResult.value = null
    void load()
  }, { immediate: true, flush: 'sync' })
  async function recover(error: unknown) {
    fail(error)
    if (error instanceof FixedScheduleRequestError && error.code === 'ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED') {
      const token = snapshot()
      const message = localizedError(error)
      await load(false)
      if (current(token) && loadState.value === 'ready') errorMessage.value = message
    }
  }
  async function save() {
    if (!saveAvailable.value) return
    const token = snapshot()
    const groupId = options.groupId.value!
    const payload = { shiftId: form.shiftId, startDate: form.startDate, endDate: form.endDate, orgId: options.orgId(), expectedConfigRevision: editor.value?.desired?.revision ?? 0 }
    const operationId = ++operationSequence
    operation.value = 'save'
    previewResult.value = null
    try {
      const data = await request(`/api/attendance/groups/${groupId}/fixed-schedule/config/update`, { method: 'POST', body: JSON.stringify(withBusinessEffectiveDate(payload, effectiveDateAvailable.value ? effectiveDates.save : '')) })
      if (!current(token)) return
      if (!desired(data) || !record(data) || data.groupId !== groupId || (data.orgId !== undefined && options.orgId() !== undefined && data.orgId !== options.orgId()) || JSON.stringify([data.shiftId, data.startDate, data.endDate]) !== token.fingerprint) throw new Error('INVALID_FIXED_SCHEDULE_CONFIG')
      await load(false)
      if (!current(token) || loadState.value !== 'ready') return
      const reloaded = editor.value?.desired
      if (!reloaded || reloaded.revision !== data.revision
        || JSON.stringify([reloaded.shiftId, reloaded.startDate, reloaded.endDate]) !== token.fingerprint) {
        errorMessage.value = localizedError(new FixedScheduleRequestError('ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED', 409))
        options.setStatus(errorMessage.value, 'error')
        return
      }
      effectiveDates.save = ''
      options.setStatus(tr('Desired configuration saved. Assignments were not changed.', '期望配置已保存，未修改排班。'))
    } catch (error) { if (current(token) && token.revision === (editor.value?.desired?.revision ?? 0)) await recover(error) }
    finally { if (operationId === operationSequence) operation.value = null }
  }
  async function run(action: 'preview' | 'apply' | 'rebuild' | 'clear') {
    const available = { preview: previewAvailable, apply: applyAvailable, rebuild: rebuildAvailable, clear: clearAvailable }
    if (!available[action].value) return
    const token = snapshot()
    const groupId = options.groupId.value!
    const selectedSet = selectedManagedSet.value
    const payload = { ...(action === 'clear' && selectedSet ? {
      shiftId: selectedSet.shiftId, startDate: selectedSet.startDate, endDate: selectedSet.endDate,
    } : { shiftId: form.shiftId, startDate: form.startDate, endDate: form.endDate }), orgId: options.orgId(), ...(['apply', 'rebuild'].includes(action) ? { expectedConfigRevision: editor.value!.desired!.revision } : {}) }
    if (action === 'clear' && !options.confirm(tr(
      'Clear only the selected shift and date window of managed rows? Unmanaged/manual rows are preserved.',
      '确认仅清除所选班次与日期窗口的已管理排班吗？未管理/手工排班将保留。',
    ))) return
    if (!current(token) || !available[action].value) return
    const operationId = ++operationSequence
    operation.value = action
    if (action === 'preview') previewResult.value = null
    try {
      const data = await request(`/api/attendance/groups/${groupId}/fixed-schedule/${action}`, { method: 'POST', body: JSON.stringify(action === 'preview' ? payload : withBusinessEffectiveDate(payload, effectiveDateAvailable.value ? effectiveDates[action] : '')) })
      if (!current(token) || (action !== 'clear' && token.revision !== (editor.value?.desired?.revision ?? 0))) return
      if (!record(data) || (action === 'clear' ? !Array.isArray(data.deactivated)
        : !record(data.group) || data.group.id !== groupId || !record(data.shift) || data.shift.id !== payload.shiftId
          || !record(data.window) || data.window.startDate !== payload.startDate || data.window.endDate !== payload.endDate
          || !record(data.target) || !Number.isSafeInteger(data.target.total) || Number(data.target.total) < 0 || !Array.isArray(data.wouldCreate)
          || !Array.isArray(data.skipped) || !Array.isArray(data.blockingConflicts))) throw new Error('INVALID_FIXED_SCHEDULE_RESULT')
      if (action === 'clear') previewResult.value = null
      else previewResult.value = data as Result
      if (action !== 'preview') {
        await options.reloadAssignments(() => current(token))
        if (!current(token)) return
        await load(false)
        if (!current(token) || loadState.value !== 'ready') return
      }
      if (action !== 'preview') effectiveDates[action] = ''
      options.setStatus(action === 'preview' ? tr('Fixed schedule preview ready. No assignments were written.', '固定排班预览已生成，未写入任何排班。')
        : action === 'apply' ? tr('Fixed schedule applied. Existing frozen attendance context is preserved.', '固定排班已应用，已有冻结考勤上下文将保留。')
          : action === 'rebuild' ? tr('Managed fixed schedule rows rebuilt. Existing frozen attendance context is preserved.', '已重建已管理固定排班，已有冻结考勤上下文将保留。')
            : tr(`Cleared ${(data.deactivated as unknown[]).length} managed fixed schedule rows.`, `已清除 ${(data.deactivated as unknown[]).length} 条已管理固定排班。`))
    } catch (error) { if (current(token) && (action === 'clear' || token.revision === (editor.value?.desired?.revision ?? 0))) await recover(error) }
    finally { if (operationId === operationSequence) operation.value = null }
  }
  return { form, effectiveDates, effectiveDateAvailable, editor, loadState, errorMessage, operation, previewResult, busy, dirty, managedSets,
    selectedManagedKey, managedKey, eligibilityHint, previewAvailable, saveAvailable, applyAvailable,
    rebuildAvailable, clearAvailable, load, save, preview: () => run('preview'), apply: () => run('apply'),
    rebuild: () => run('rebuild'), clear: () => run('clear') }
}
