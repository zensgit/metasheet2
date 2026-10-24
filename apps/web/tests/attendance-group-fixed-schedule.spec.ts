import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { parseFixedScheduleEditor, useAttendanceGroupFixedSchedule } from '../src/views/attendance/useAttendanceGroupFixedSchedule'

const a = { shiftId: 'shift-a', startDate: '2026-10-01', endDate: '2026-10-31', revision: 4 }
const b = { shiftId: 'shift-b', startDate: '2026-11-01', endDate: '2026-11-30', revision: 7 }
function formOf(value: typeof a) { return { shiftId: value.shiftId, startDate: value.startDate, endDate: value.endDate } }
function editor(groupId = 'group-a', desired: typeof a | null = a, allowed = true) {
  return { groupId, state: desired ? 'pending_apply' : 'not_configured', reasonCodes: desired ? ['TARGET_MEMBER_MISSING'] : ['NO_DESIRED_CONFIG'], desired,
    drift: { managedSets: [] as Array<{ shiftId: string; startDate: string; endDate: string | null; producerKey: string; rowCount: number }> },
    referenceEligibility: desired ? { shiftId: desired.shiftId, allowed, reasonCode: allowed ? null : 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED' } : null }
}
function json(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify({ ok: status < 400, ...(status < 400 ? { data } : { error: data }) })) } as Response
}
function result(groupId = 'group-a', desired = a) {
  return { group: { id: groupId }, shift: { id: desired.shiftId }, window: { startDate: desired.startDate, endDate: desired.endDate }, target: { total: 1 }, wouldCreate: [], skipped: [], blockingConflicts: [] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() } }
const scopes: EffectScope[] = []
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()) })
function harness(handler: (path: string, init?: RequestInit) => Promise<Response> = async () => json(editor())) {
  const groupId = ref<string | null>('group-a')
  const orgId = ref('org-a')
  const enabled = ref(true)
  const knownShifts = new Set(['shift-a', 'shift-b'])
  const rememberShift = vi.fn((value: unknown) => knownShifts.add((value as { id: string }).id))
  const apiFetch = vi.fn(handler)
  const setStatus = vi.fn()
  const reloadAssignments = vi.fn(async (_isCurrent: () => boolean) => {})
  const confirm = vi.fn(() => true)
  const scope = effectScope(); scopes.push(scope)
  const schedule = scope.run(() => useAttendanceGroupFixedSchedule<ReturnType<typeof result>>({
    groupId, orgId: () => orgId.value || undefined, enabled, hasShift: id => knownShifts.has(id), rememberShift,
    apiFetch, setStatus, reloadAssignments, confirm, tr: (en, _zh) => en,
  }))!
  return { schedule, groupId, orgId, enabled, knownShifts, rememberShift, apiFetch, setStatus, reloadAssignments, confirm }
}

describe('attendance group fixed schedule editor', () => {
  it('reads each group saved shift, date window and revision when reopened', async () => {
    const h = harness(async path => json(editor(path.includes('group-b') ? 'group-b' : 'group-a', path.includes('group-b') ? b : a)))
    await flush(); expect(h.schedule.form).toEqual(formOf(a))
    h.groupId.value = 'group-b'; await flush(); expect(h.schedule.form).toEqual(formOf(b))
    h.groupId.value = 'group-a'; await flush(); expect(h.schedule.form).toEqual(formOf(a))
    expect(h.schedule.editor.value?.desired?.revision).toBe(4)
    expect(h.apiFetch.mock.calls.every(([path]) => path.includes('/fixed-schedule/editor?'))).toBe(true)
  })

  it('keeps an unconfigured group blank instead of inferring intent from shifts or managed rows', async () => {
    const data = editor('group-a', null)
    data.drift.managedSets.push({ ...a, producerKey: 'old-key', rowCount: 1 })
    const h = harness(async () => json(data)); await flush()
    expect(h.schedule.form).toEqual({ shiftId: '', startDate: '', endDate: '' })
    expect(h.schedule.rebuildAvailable.value).toBe(false)
    expect(h.schedule.clearAvailable.value).toBe(false)
  })

  it('saves the first desired configuration explicitly with revision zero and no assignment writes', async () => {
    let saved = false
    const h = harness(async (path, init) => {
      if (path.endsWith('/config/update')) { saved = true; return json({ ...a, groupId: 'group-a', revision: 1 }) }
      const data = editor('group-a', saved ? { ...a, revision: 1 } : null)
      if (path.includes('shiftId=shift-a') && !saved) data.referenceEligibility = { shiftId: 'shift-a', allowed: true, reasonCode: null }
      return json(data)
    })
    await flush(); Object.assign(h.schedule.form, { shiftId: a.shiftId, startDate: a.startDate, endDate: a.endDate }); await flush()
    expect(h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])
    await h.schedule.save()
    const writes = h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ shiftId: a.shiftId, startDate: a.startDate, endDate: a.endDate, orgId: 'org-a', expectedConfigRevision: 0 })
    expect(h.schedule.editor.value?.desired?.revision).toBe(1)
    expect(h.reloadAssignments).not.toHaveBeenCalled()
    expect(h.setStatus).toHaveBeenLastCalledWith('Desired configuration saved. Assignments were not changed.')
  })

  it('requires explicit save after edits, rereads its revision, then applies the matching preview', async () => {
    let saved = a
    const h = harness(async (path, init) => {
      if (path.endsWith('/config/update')) { expect(JSON.parse(String(init?.body)).expectedConfigRevision).toBe(4); saved = { ...b, revision: 5 }; return json({ ...saved, groupId: 'group-a' }) }
      if (path.endsWith('/preview')) return json(result('group-a', b))
      if (path.endsWith('/apply')) return json({ ...result('group-a', b), applied: true })
      const data = editor('group-a', saved)
      if (path.includes('shiftId=shift-b')) data.referenceEligibility = { shiftId: 'shift-b', allowed: true, reasonCode: null }
      return json(data)
    })
    await flush(); Object.assign(h.schedule.form, formOf(b)); await flush()
    expect(h.schedule.rebuildAvailable.value).toBe(false)
    await h.schedule.apply(); expect(h.apiFetch.mock.calls.some(([path]) => path.endsWith('/apply'))).toBe(false)
    await h.schedule.save(); await h.schedule.preview(); expect(h.schedule.applyAvailable.value).toBe(true)
    await h.schedule.apply()
    const call = h.apiFetch.mock.calls.find(([path]) => path.endsWith('/apply'))!
    expect(JSON.parse(String(call[1]!.body))).toEqual({ shiftId: b.shiftId, startDate: b.startDate, endDate: b.endDate, orgId: 'org-a', expectedConfigRevision: 5 })
    expect(h.reloadAssignments).toHaveBeenCalledTimes(1)
    expect(h.schedule.applyAvailable.value).toBe(false)
  })

  it('rereads on typed CAS conflict without overwriting the draft or replaying the write', async () => {
    let reads = 0
    const h = harness(async path => {
      if (path.endsWith('/config/update')) return json({ code: 'ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED' }, 409)
      reads += 1
      return json(editor('group-a', reads > 1 ? { ...a, revision: 5 } : a))
    })
    await flush(); h.schedule.form.endDate = '2026-10-30'; await h.schedule.save()
    expect(h.schedule.loadState.value).toBe('ready')
    expect(h.schedule.errorMessage.value).toContain('configuration changed')
    expect(h.schedule.editor.value?.desired?.revision).toBe(5)
    expect(h.schedule.form.endDate).toBe('2026-10-30')
    expect(h.schedule.rebuildAvailable.value).toBe(false)
    expect(h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    await h.schedule.load(); expect(h.schedule.form.endDate).toBe(a.endDate)
  })

  it('preserves the draft and warns when another admin changes desired config between save and reread', async () => {
    let saved = false
    const candidate = { ...a, endDate: '2026-10-30', revision: 5 }
    const h = harness(async path => {
      if (path.endsWith('/config/update')) { saved = true; return json({ ...candidate, groupId: 'group-a' }) }
      const data = editor('group-a', saved ? b : a)
      if (saved) data.referenceEligibility = { shiftId: a.shiftId, allowed: true, reasonCode: null }
      return json(data)
    })
    await flush(); h.schedule.form.endDate = candidate.endDate; await h.schedule.save()
    expect(h.schedule.form).toEqual(formOf(candidate))
    expect(h.schedule.editor.value?.desired).toEqual(b)
    expect(h.schedule.errorMessage.value).toContain('configuration changed')
    expect(h.schedule.rebuildAvailable.value).toBe(false)
    expect(h.setStatus).not.toHaveBeenCalledWith('Desired configuration saved. Assignments were not changed.')
    expect(h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('keeps preview and config saving available when authoritative multi-segment writes are disabled', async () => {
    const h = harness(async path => path.endsWith('/preview') ? json(result()) : json(editor('group-a', a, false)))
    await flush(); expect(h.schedule.previewAvailable.value).toBe(true)
    await h.schedule.preview()
    expect(h.schedule.applyAvailable.value).toBe(false)
    expect(h.schedule.rebuildAvailable.value).toBe(false)
    expect(h.schedule.clearAvailable.value).toBe(true)
    h.schedule.form.endDate = '2026-10-30'
    expect(h.schedule.saveAvailable.value).toBe(true)
    expect(h.schedule.eligibilityHint.value).toContain('cannot apply or rebuild multi-segment')
    await h.schedule.rebuild(); expect(h.apiFetch.mock.calls.some(([path]) => path.endsWith('/rebuild'))).toBe(false)
  })

  it('clears only the selected old managed tuple without saving draft or requiring write eligibility', async () => {
    const data = editor('group-a', b, false)
    data.state = 'configuration_changed'
    data.drift.managedSets.push({ ...a, producerKey: 'old-key', rowCount: 2 })
    const h = harness(async path => path.endsWith('/clear') ? json({ deactivated: [{}, {}] }) : json(data))
    await flush(); h.schedule.form.endDate = '2026-11-29'
    h.schedule.selectedManagedKey.value = h.schedule.managedKey(data.drift.managedSets[0]!)
    expect(h.schedule.clearAvailable.value).toBe(true)
    await h.schedule.clear()
    const writes = h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes.map(([path]) => path)).toEqual(['/api/attendance/groups/group-a/fixed-schedule/clear'])
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ shiftId: a.shiftId, startDate: a.startDate, endDate: a.endDate, orgId: 'org-a' })
    expect(h.schedule.form.endDate).toBe('2026-11-29')
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })

  it('keeps a removed old selection unavailable instead of retargeting clear to the desired set', async () => {
    const data = editor('group-a', b)
    data.drift.managedSets.push({ ...a, producerKey: 'old-key', rowCount: 1 })
    const h = harness(async path => {
      if (path.endsWith('/clear')) { data.drift.managedSets = []; return json({ deactivated: [{}] }) }
      return json(data)
    }); await flush()
    const key = h.schedule.managedKey(data.drift.managedSets[0]!)
    h.schedule.selectedManagedKey.value = key; await h.schedule.clear()
    expect(h.schedule.selectedManagedKey.value).toBe(key)
    expect(h.schedule.clearAvailable.value).toBe(false)
    await h.schedule.clear()
    expect(h.apiFetch.mock.calls.filter(([path]) => path.endsWith('/clear'))).toHaveLength(1)
    h.schedule.selectedManagedKey.value = ''; expect(h.schedule.clearAvailable.value).toBe(true)
  })

  it('invalidates a preview when authoritative revision changes without changing its tuple', async () => {
    let revision = 4
    const h = harness(async path => path.endsWith('/preview') ? json(result()) : json(editor('group-a', { ...a, revision })))
    await flush(); await h.schedule.preview(); expect(h.schedule.applyAvailable.value).toBe(true)
    revision = 6; await h.schedule.load(false)
    expect(h.schedule.previewResult.value).toBeNull()
    expect(h.schedule.applyAvailable.value).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)('suppresses a pending preview %s from an older authoritative revision', async outcome => {
    let revision = 4
    const old = deferred<Response>()
    const h = harness(async path => path.endsWith('/preview') ? old.promise : json(editor('group-a', { ...a, revision })))
    await flush(); const pending = h.schedule.preview()
    revision = 6; await h.schedule.load(false)
    if (outcome === 'resolve') old.resolve(json(result())); else old.reject(new Error('old revision failure'))
    await pending
    expect(h.schedule.previewResult.value).toBeNull()
    expect(h.schedule.applyAvailable.value).toBe(false)
    expect(h.schedule.editor.value?.desired?.revision).toBe(6)
    expect(h.schedule.loadState.value).toBe('ready')
    expect(h.setStatus).not.toHaveBeenCalled()
  })

  it('clears an explicitly selected historical set without creating or inferring desired configuration', async () => {
    const data = editor('group-a', null)
    data.drift.managedSets.push({ ...a, producerKey: 'historical-key', rowCount: 1 })
    const h = harness(async path => path.endsWith('/clear') ? json({ deactivated: [{}] }) : json(data))
    await flush(); h.schedule.selectedManagedKey.value = h.schedule.managedKey(data.drift.managedSets[0]!)
    expect(h.schedule.clearAvailable.value).toBe(true)
    await h.schedule.clear()
    expect(h.schedule.form).toEqual({ shiftId: '', startDate: '', endDate: '' })
    expect(h.schedule.editor.value?.desired).toBeNull()
    const writes = h.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes.map(([path]) => path)).toEqual(['/api/attendance/groups/group-a/fixed-schedule/clear'])
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ shiftId: a.shiftId, startDate: a.startDate, endDate: a.endDate, orgId: 'org-a' })
  })

  it('passes a context guard to an in-flight assignment refresh after rebuild', async () => {
    const old = deferred<void>()
    const h = harness(async path => path.endsWith('/rebuild') ? json({ ...result(), rebuilt: true }) : json(path.includes('group-b') ? editor('group-b', b) : editor()))
    let mutated = false
    h.reloadAssignments.mockImplementation(async (isCurrent: () => boolean) => { await old.promise; if (isCurrent()) mutated = true })
    await flush(); const pending = h.schedule.rebuild(); await flush()
    expect(h.reloadAssignments).toHaveBeenCalledTimes(1)
    h.groupId.value = 'group-b'; await flush(); old.resolve(); await pending
    expect(mutated).toBe(false)
    expect(h.schedule.form).toEqual(formOf(b))
  })

  it('does not fall back to clearing the desired set for an unknown or unbounded legacy selection', async () => {
    const data = editor(); data.drift.managedSets.push({ ...a, endDate: null, producerKey: 'legacy', rowCount: 1 })
    const h = harness(async () => json(data)); await flush()
    expect(h.schedule.loadState.value).toBe('ready')
    h.schedule.selectedManagedKey.value = 'not-listed'; expect(h.schedule.clearAvailable.value).toBe(false)
    h.schedule.selectedManagedKey.value = h.schedule.managedKey(data.drift.managedSets[0]!)
    await h.schedule.clear(); expect(h.apiFetch.mock.calls.some(([path]) => path.endsWith('/clear'))).toBe(false)
  })

  it('preserves the selected tuple when clear confirmation is cancelled', async () => {
    const h = harness(); await flush(); h.confirm.mockReturnValue(false)
    await h.schedule.clear(); expect(h.schedule.form).toEqual(formOf(a))
    expect(h.apiFetch.mock.calls.some(([path]) => path.endsWith('/clear'))).toBe(false)
  })

  it.each([403, 404, 503])('fails closed on an editor HTTP %s without a default schedule', async status => {
    const h = harness(async () => json({ code: status === 503 ? 'DB_NOT_READY' : 'NOT_FOUND' }, status)); await flush()
    expect(h.schedule.loadState.value).toBe('error')
    expect(h.schedule.form).toEqual({ shiftId: '', startDate: '', endDate: '' })
    expect(h.schedule.previewAvailable.value).toBe(false)
    await h.schedule.rebuild(); expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...editor(), state: 'unknown' }, { ...editor(), desired: { ...a, revision: 0 } },
    { ...editor(), desired: { ...a, startDate: '2026-02-30' } }, { ...editor(), reasonCodes: ['UNKNOWN_REASON'] },
    { ...editor(), referenceEligibility: { shiftId: a.shiftId, allowed: 'true', reasonCode: null } },
    { ...editor(), referenceEligibility: { shiftId: a.shiftId, allowed: false, reasonCode: null } },
    { ...editor(), referenceEligibility: { shiftId: 'wrong-shift', allowed: true, reasonCode: null } },
    { ...editor(), drift: { managedSets: [{ ...a, producerKey: '', rowCount: 1 }] } },
  ])('rejects malformed or unknown editor fields without enabling writes: %j', async data => {
    const h = harness(async () => json(data)); await flush()
    expect(h.schedule.loadState.value).toBe('error')
    expect(h.schedule.rebuildAvailable.value).toBe(false)
  })

  it('checks read identity independently of transport success', () => {
    expect(() => parseFixedScheduleEditor(editor('group-b'), 'group-a')).toThrow('INVALID_FIXED_SCHEDULE_EDITOR')
  })

  it('hydrates a saved shift outside the list page through the existing single read', async () => {
    const h = harness(async path => path.includes('/shifts/shift-a?') ? json({ id: 'shift-a', orgId: 'org-a', name: 'Earlier shift', workStartTime: '08:00:00', workEndTime: '17:00:00', workingDays: [1, 2, 3, 4, 5] }) : json(editor()))
    h.knownShifts.delete('shift-a'); await flush()
    expect(h.apiFetch.mock.calls.map(([path]) => path)).toEqual(['/api/attendance/groups/group-a/fixed-schedule/editor?orgId=org-a', '/api/attendance/shifts/shift-a?orgId=org-a'])
    expect(h.rememberShift).toHaveBeenCalledTimes(1)
    expect(h.schedule.form.shiftId).toBe('shift-a')
    expect(h.schedule.rebuildAvailable.value).toBe(true)
  })

  it.each([json({ code: 'NOT_FOUND' }, 404), json({ id: 'shift-a', name: 'Malformed' })])('keeps an unreadable saved shift visible and unavailable', async response => {
    const h = harness(async path => path.includes('/shifts/') ? response : json(editor()))
    h.knownShifts.delete('shift-a'); await flush()
    expect(h.schedule.form.shiftId).toBe('shift-a')
    expect(h.schedule.form.startDate).toBe(a.startDate)
    expect(h.rememberShift).not.toHaveBeenCalled()
    expect(h.schedule.rebuildAvailable.value).toBe(false)
    expect(h.schedule.eligibilityHint.value).toContain('unavailable')
  })

  it('accepts an authenticated off-page shift when no org selector is supplied', async () => {
    const h = harness(async path => path.includes('/shifts/') ? json({ id: 'shift-a', orgId: 'authenticated-org', name: 'Earlier shift', workStartTime: '08:00:00', workEndTime: '17:00:00', workingDays: [1] }) : json(editor()))
    h.knownShifts.delete('shift-a'); h.orgId.value = ''; await flush()
    expect(h.rememberShift).toHaveBeenCalledTimes(1)
    expect(h.schedule.rebuildAvailable.value).toBe(true)
  })

  it('rejects an off-page shift from a different explicit org selector', async () => {
    const h = harness(async path => path.includes('/shifts/') ? json({ id: 'shift-a', orgId: 'other-org', name: 'Earlier shift', workStartTime: '08:00:00', workEndTime: '17:00:00', workingDays: [1] }) : json(editor()))
    h.knownShifts.delete('shift-a'); await flush()
    expect(h.rememberShift).not.toHaveBeenCalled()
    expect(h.schedule.rebuildAvailable.value).toBe(false)
  })

  it('never uses a stale missing-shift response after group selection changes', async () => {
    const old = deferred<Response>()
    const h = harness(async path => path.includes('/shifts/') ? old.promise : json(path.includes('group-b') ? editor('group-b', b) : editor()))
    h.knownShifts.delete('shift-a'); await flush()
    h.groupId.value = 'group-b'; await flush()
    old.resolve(json({ id: 'shift-a', name: 'Old', workStartTime: '08:00', workEndTime: '17:00', workingDays: [1] })); await flush()
    expect(h.rememberShift).not.toHaveBeenCalled()
    expect(h.schedule.form).toEqual(formOf(b))
  })

  it('suppresses an old group editor success after switching groups', async () => {
    const old = deferred<Response>()
    const h = harness(async path => path.includes('group-a') ? old.promise : json(editor('group-b', b)))
    h.groupId.value = 'group-b'; await flush(); old.resolve(json(editor())); await flush()
    expect(h.schedule.form).toEqual(formOf(b))
    expect(h.schedule.loadState.value).toBe('ready')
  })

  it('suppresses stale editor errors and finally state after switching organizations', async () => {
    const old = deferred<Response>()
    const h = harness(async path => path.includes('orgId=org-a') ? old.promise : json(editor('group-a', b)))
    h.orgId.value = 'org-b'; await flush(); old.reject(new Error('sensitive backend detail')); await flush()
    expect(h.schedule.form).toEqual(formOf(b))
    expect(h.schedule.errorMessage.value).toBe('')
    expect(h.schedule.loadState.value).toBe('ready')
    expect(h.setStatus).not.toHaveBeenCalled()
  })

  it('suppresses candidate eligibility responses for an older selection', async () => {
    const old = deferred<Response>()
    const h = harness(async path => {
      if (path.includes('shiftId=shift-b')) return old.promise
      return json(editor())
    }); await flush()
    h.schedule.form.shiftId = 'shift-b'; h.schedule.form.shiftId = 'shift-a'; await flush()
    const obsolete = editor(); obsolete.referenceEligibility = { shiftId: 'shift-b', allowed: false, reasonCode: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED' }
    old.resolve(json(obsolete)); await flush()
    expect(h.schedule.editor.value?.referenceEligibility?.shiftId).toBe('shift-a')
    expect(h.schedule.rebuildAvailable.value).toBe(true)
  })

  it('keeps dates edited while candidate eligibility is loading and reaches a usable state', async () => {
    const h = harness(async path => {
      const data = editor()
      if (path.includes('shiftId=shift-b')) data.referenceEligibility = { shiftId: 'shift-b', allowed: true, reasonCode: null }
      return json(data)
    }); await flush()
    Object.assign(h.schedule.form, formOf(b)); await flush()
    expect(h.schedule.form).toEqual(formOf(b))
    expect(h.schedule.loadState.value).toBe('ready')
    expect(h.schedule.saveAvailable.value).toBe(true)
  })

  it.each(['resolve', 'reject'] as const)('suppresses a late preview %s after group change', async outcome => {
    const old = deferred<Response>()
    const h = harness(async path => path.endsWith('/preview') ? old.promise : json(path.includes('group-b') ? editor('group-b', b) : editor()))
    await flush(); const pending = h.schedule.preview()
    h.groupId.value = 'group-b'; await flush()
    if (outcome === 'resolve') old.resolve(json(result())); else old.reject(new Error('old request error'))
    await pending
    expect(h.schedule.form).toEqual(formOf(b))
    expect(h.schedule.previewResult.value).toBeNull()
    expect(h.schedule.loadState.value).toBe('ready')
    expect(h.setStatus).not.toHaveBeenCalled()
  })

  it('does not expose a preview after the date candidate changes during its request', async () => {
    const old = deferred<Response>()
    const h = harness(async path => path.endsWith('/preview') ? old.promise : json(editor()))
    await flush(); const pending = h.schedule.preview(); h.schedule.form.endDate = '2026-10-30'
    old.resolve(json(result())); await pending
    expect(h.schedule.previewResult.value).toBeNull()
    expect(h.schedule.operation.value).toBeNull()
    expect(h.schedule.applyAvailable.value).toBe(false)
  })

  it('suppresses successful save effects after an organization switch', async () => {
    const old = deferred<Response>()
    const h = harness(async path => path.endsWith('/config/update') ? old.promise : json(editor()))
    await flush(); h.schedule.form.endDate = '2026-10-30'; const pending = h.schedule.save()
    h.orgId.value = 'org-b'; await flush(); old.resolve(json({ ...a, endDate: '2026-10-30', revision: 5, groupId: 'group-a' })); await pending
    expect(h.schedule.form).toEqual(formOf(a))
    expect(h.schedule.editor.value?.desired?.revision).toBe(4)
    expect(h.setStatus).not.toHaveBeenCalled()
  })

  it('suppresses successful rebuild effects after a group switch', async () => {
    const old = deferred<Response>()
    const h = harness(async path => path.endsWith('/rebuild') ? old.promise : json(path.includes('group-b') ? editor('group-b', b) : editor()))
    await flush(); const pending = h.schedule.rebuild(); h.groupId.value = 'group-b'; await flush()
    old.resolve(json({ ...result(), rebuilt: true })); await pending
    expect(h.reloadAssignments).not.toHaveBeenCalled()
    expect(h.schedule.previewResult.value).toBeNull()
    expect(h.schedule.form).toEqual(formOf(b))
  })

  it('rejects a malformed successful preview instead of enabling apply', async () => {
    const h = harness(async path => path.endsWith('/preview') ? json({ ...result('group-b') }) : json(editor()))
    await flush(); await h.schedule.preview()
    expect(h.schedule.loadState.value).toBe('error')
    expect(h.schedule.applyAvailable.value).toBe(false)
  })

  it('does not submit an invalid window or a second concurrent write', async () => {
    const old = deferred<Response>()
    const h = harness(async path => path.endsWith('/rebuild') ? old.promise : json(editor())); await flush()
    h.schedule.form.endDate = '2026-09-30'; await h.schedule.preview()
    expect(h.apiFetch.mock.calls.some(([path]) => path.endsWith('/preview'))).toBe(false)
    h.schedule.form.endDate = a.endDate; const pending = h.schedule.rebuild(); await h.schedule.rebuild()
    expect(h.apiFetch.mock.calls.filter(([path]) => path.endsWith('/rebuild'))).toHaveLength(1)
    old.resolve(json({ ...result(), rebuilt: true })); await pending
  })
})
