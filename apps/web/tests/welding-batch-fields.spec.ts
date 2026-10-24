import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, nextTick, ref } from 'vue'
import Fields from '../src/views/welding/WeldingBatchFields.vue'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { useWeldingCadSession } from '../src/views/welding/useWeldingCadSession'
import { clone, equal, type PlanPayload, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'
import { withGenerationOwnerLock } from '../src/services/welding/commandRecovery'
import type { PlanRecord, WeldingPlanClient } from '../src/services/welding/planClient'

const owner = { tenant_id: 't', org_id: 'o', auth_user_id: 7, rbac_user_id: 19 }
const cleanups: Array<() => void> = []
let root: HTMLDivElement
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 120; i++) await Promise.resolve(); await nextTick() }
async function setup() {
  const payload: PlanPayload = { schema_version: 1, product: { item_id: 'p', version_id: 'pv' }, drawing: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'drawing', expected_checksum: 'a'.repeat(64) },
    overlay: null, future: { preserve: [1, 'opaque'] }, process_refs: [], welds: [
      { weld_id: 'a', display_no: 'W1', classification: 'existing', manufacturing_length: { value: 10, unit: 'mm' }, future: 'preserve' },
      { weld_id: 'b', display_no: 'W2', group_name: 'old', included: false },
      { weld_id: 'c', display_no: 'W3', group_name: 'untouched', included: true },
    ] }
  const plan: PlanRecord = { plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W', state: 'Draft', version_label: 'A', draft_seq: 1, content_hash: 'a'.repeat(64), payload, sources: {} }
  let stored: PlanRecoveryRecord | null = null
  const db: PlanRecoveryStore = { list: async () => [], get: async () => clone(stored), claim: vi.fn(async record => { if (stored) return false; stored = clone(record); return true }), compareReplace: vi.fn(async (old, next) => { if (!equal(old, stored)) return false; stored = clone(next); return true }), close() {} }
  const client = { recoveryOwner: vi.fn(async () => clone(owner)), list: vi.fn(async () => ({ items: [], total: 0, offset: 0 })), read: vi.fn(async () => clone(plan)), recover: vi.fn(async (_p, record) => ({ owner, record_id: record.recovery_id, current: clone(plan), can_write: true, conflict: false })), save: vi.fn() } as unknown as WeldingPlanClient
  const writable = ref(true), scope = effectScope()
  const session = scope.run(() => useWeldingPlanSession({ client, openStore: async () => db, writable: () => writable.value }))!
  session.setWorkflowAdmission(async (scope, _mode, _target, action) => { session.check(scope); return action(scope) })
  session.setGenerationAdmission(async (scope, _mode, _target, action) => withGenerationOwnerLock(owner, scope, action))
  await session.initialize(); await session.open('plan', 'v1')
  const cad = scope.run(() => useWeldingCadSession(session))!, barrier = vi.fn(cad.barrier)
  root = document.createElement('div'); document.body.append(root)
  const app = createApp(Fields, { session, barrier }); app.mount(root)
  const element = root
  const unmount = () => { app.unmount(); element.remove() }
  cleanups.push(() => { unmount(); scope.stop() })
  await nextTick()
  return { session, cad, db, client, barrier, writable, unmount, stored: () => clone(stored), original: clone(payload) }
}
const button = (label: string) => [...root.querySelectorAll('button')].find(row => row.textContent === label)!
async function click(label: string) { button(label).click(); await flush() }
function input(label: string) { return [...root.querySelectorAll('label')].find(row => row.textContent!.trim() === label || row.childNodes[0].textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')! }
async function select(id: string, checked = true) { const el = root.querySelector<HTMLInputElement>(`input[type=checkbox][value="${id}"]`)!; el.checked = checked; el.dispatchEvent(new Event('change', { bubbles: true })); await nextTick() }
async function enable(label: string) { const el = input(label) as HTMLInputElement; el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); await nextTick() }
async function text(label: string, value: string) { const el = input(label); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); await nextTick() }
async function chooseGroup() { await select('a'); await select('b'); await enable('修改统计分组'); await text('新的统计分组', 'new') }
async function column(field: string) { const el = input('工艺参数列'); el.value = field; el.dispatchEvent(new Event('change', { bubbles: true })); await nextTick() }
beforeEach(() => {
  localStorage.setItem('auth_token', 'batch-test')
  const tails = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request(name: string, _options: unknown, action: () => Promise<unknown>) { const job = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(action); tails.set(name, job); return job } } })
})
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); localStorage.clear(); delete (navigator as unknown as { locks?: unknown }).locks })

describe('batch fields using the actual plan session and owner lock', () => {
  it('changes one process column for selected IDs with references intact and one reversible durable history step', async () => {
    const f = await setup()
    await f.session.edit(next => { next.resource_refs = [{ reference_id: 'ref', weld_id: 'a', resource_id: 'wps', version_id: 'fixed', expected_content_hash: 'b'.repeat(64), selected_fields: ['method'] }] })
    const before = clone(f.session.state.payload), history = f.session.state.historyLength
    await select('a'); await select('b'); await enable('修改工艺参数'); await text('新的工艺参数值', 'SMAW')
    expect(button('预览批量变更').disabled).toBe(false); await click('预览批量变更')
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2); expect(f.session.state.payload).toEqual(before)
    await click('确认批量变更')
    const expected = clone(before); expected.welds[0].method = expected.welds[1].method = 'SMAW'
    expect(f.session.state.payload).toEqual(expected); expect(f.session.state.historyLength).toBe(history + 1)
    expect(f.session.state.payload.resource_refs).toEqual(before.resource_refs); expect(f.client.save).not.toHaveBeenCalled()
    await f.cad.history('undo'); expect(f.session.state.payload).toEqual(before)
    await f.cad.history('redo'); expect(f.session.state.payload).toEqual(expected)
  })
  it('keeps explicit length units, zero and null clearing while preserving other process columns', async () => {
    const f = await setup(); await select('a'); await enable('修改工艺参数'); await column('manufacturing_length')
    const unit = input('工艺参数单位'); unit.value = 'in'; unit.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
    await text('新的工艺参数值', '0'); await click('预览批量变更'); await click('确认批量变更')
    expect(f.session.state.payload.welds[0]).toEqual({ ...f.original.welds[0], manufacturing_length: { value: 0, unit: 'in' } })
    expect(f.session.state.payload.welds.slice(1)).toEqual(f.original.welds.slice(1))
    await text('新的工艺参数值', ''); await click('预览批量变更'); expect(root.querySelector('table')!.textContent).toContain('空（清除）')
    await click('确认批量变更'); expect(f.session.state.payload.welds[0].manufacturing_length).toBeNull()
    await f.cad.history('undo'); expect(f.session.state.payload.welds[0].manufacturing_length).toEqual({ value: 0, unit: 'in' })
  })
  it('rejects native bad numeric input and invalidates an existing empty-value preview before confirmation', async () => {
    const f = await setup(); await select('a'); await enable('修改工艺参数'); await column('manufacturing_length')
    await click('预览批量变更'); expect(root.querySelector('table')).not.toBeNull()
    const value = input('新的工艺参数值') as HTMLInputElement, confirm = button('确认批量变更')
    // Chromium exposes an incomplete exponent as an empty value with badInput set.
    Object.defineProperty(value, 'validity', { configurable: true, value: { badInput: true } })
    value.dispatchEvent(new Event('input', { bubbles: true })); confirm.click(); await flush()
    expect(f.session.state.payload).toEqual(f.original); expect(root.querySelector('table')).toBeNull()
    await click('预览批量变更'); expect(root.querySelector('table')).toBeNull()
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.session.state.historyLength).toBe(0)
    Object.defineProperty(value, 'validity', { configurable: true, value: { badInput: false } })
    value.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    await click('预览批量变更'); await click('确认批量变更')
    expect(f.session.state.payload.welds[0].manufacturing_length).toBeNull()
    expect(f.session.state.historyLength).toBe(1)
  })
  it('checks process text Unicode and domain lengths before preview and accepts multiline requirements', async () => {
    const f = await setup(); await select('a'); await enable('修改工艺参数')
    for (const value of ['bad\0text', '\ud800', '😀'.repeat(257)]) {
      await text('新的工艺参数值', value); await click('预览批量变更'); expect(root.querySelector('table')).toBeNull()
    }
    await column('welding_requirements'); await text('新的工艺参数值', '字'.repeat(4001)); await click('预览批量变更'); expect(root.querySelector('table')).toBeNull()
    expect(f.session.state.historyLength).toBe(0); expect(f.db.claim).not.toHaveBeenCalled()
    await text('新的工艺参数值', '逐道清理\n确认后检验'); await click('预览批量变更'); await click('确认批量变更')
    expect(f.session.state.payload.welds[0]).toEqual({ ...f.original.welds[0], welding_requirements: '逐道清理\n确认后检验' })
  })
  it('rejects negative lengths and invalidates a process preview synchronously on column or unit changes', async () => {
    const f = await setup(); await select('a'); await enable('修改工艺参数'); await column('thickness_a')
    await text('新的工艺参数值', '-1'); await click('预览批量变更'); expect(root.querySelector('table')).toBeNull()
    await text('新的工艺参数值', '12'); await click('预览批量变更')
    const confirm = button('确认批量变更'), unit = input('工艺参数单位'); unit.value = 'in'; unit.dispatchEvent(new Event('change', { bubbles: true })); confirm.click(); await flush()
    expect(root.querySelector('table')).toBeNull(); expect(f.session.state.payload).toEqual(f.original)
    await click('预览批量变更'); const field = input('工艺参数列'); field.value = 'method'; field.dispatchEvent(new Event('change', { bubbles: true })); confirm.click(); await flush()
    expect(root.querySelector('table')).toBeNull(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.session.state.historyLength).toBe(0)
  })
  it('previews only selected stable IDs and enabled fields without writing, then cancels', async () => {
    const f = await setup(); await chooseGroup(); await enable('修改统计参与'); await click('预览批量变更')
    expect(root.querySelectorAll('tbody tr')).toHaveLength(4)
    expect(root.querySelector('table')!.textContent).toContain('未设置（默认参与）'); expect(root.querySelector('table')!.textContent).not.toContain('W3')
    expect(f.session.state.payload).toEqual(f.original); expect(f.session.state.historyLength).toBe(0)
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
    await click('取消批量预览'); expect(root.querySelector('table')).toBeNull(); expect(f.barrier).toHaveBeenCalledTimes(1)
  })
  it('confirms exactly one durable history step and undo redo restore sparse fields and all unrelated data', async () => {
    const f = await setup(); await chooseGroup(); await click('预览批量变更'); await click('确认批量变更')
    const expected = clone(f.original); expected.welds[0].group_name = expected.welds[1].group_name = 'new'
    expect(f.session.state.payload).toEqual(expected); expect(f.stored()!.draft.payload).toEqual(expected)
    expect(f.session.state.historyLength).toBe(1); expect(f.session.state.historyCursor).toBe(1); expect(f.session.state.editSeq).toBe(1)
    expect(f.db.claim).toHaveBeenCalledTimes(1); expect(f.client.save).not.toHaveBeenCalled(); expect(f.barrier).toHaveBeenCalledTimes(2)
    await f.cad.history('undo')
    expect(f.session.state.payload).toEqual(f.original); expect(Object.hasOwn(f.session.state.payload.welds[0], 'group_name')).toBe(false)
    await f.cad.history('redo')
    expect(f.session.state.payload).toEqual(expected); expect(f.session.state.historyLength).toBe(1)
  })
  it('clears explicit text and writes a strict excluded flag without erasing unselected fields', async () => {
    const f = await setup(); await select('a'); await enable('修改企业分类'); await enable('修改统计参与')
    const el = input('新的参与状态') as HTMLSelectElement; el.selectedIndex = 1; el.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
    await click('预览批量变更'); expect(root.querySelector('table')!.textContent).toContain('空（清除）'); await click('确认批量变更')
    expect(f.session.state.payload.welds[0]).toEqual({ ...f.original.welds[0], classification: '', included: false })
    expect(f.session.state.payload.welds.slice(1)).toEqual(f.original.welds.slice(1))
  })
  it('rejects invalid Unicode labels and complete no-op patches before any history or persistence', async () => {
    const f = await setup(); await select('b'); await enable('修改统计分组')
    for (const value of ['old', ' bad ', 'bad/name', '😀'.repeat(65)]) {
      await text('新的统计分组', value); await click('预览批量变更'); expect(root.querySelector('table')).toBeNull()
    }
    expect(f.session.state.historyLength).toBe(0); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.session.state.payload).toEqual(f.original)
  })
  it('invalidates preview synchronously when choices change even before DOM disabled state flushes', async () => {
    const f = await setup(); await chooseGroup(); await click('预览批量变更')
    const confirm = button('确认批量变更'), el = input('新的统计分组'); el.value = 'changed'; el.dispatchEvent(new Event('input', { bubbles: true })); confirm.click(); await flush()
    expect(root.querySelector('table')).toBeNull(); expect(f.session.state.payload).toEqual(f.original); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('does not publish late previews after cancel or selection changes during the snapshot barrier', async () => {
    const f = await setup(); await chooseGroup()
    const first = deferred(); f.barrier.mockImplementationOnce(() => first.promise); await click('预览批量变更'); await click('取消批量预览'); first.resolve(); await flush()
    expect(root.querySelector('table')).toBeNull()
    const second = deferred(); f.barrier.mockImplementationOnce(() => second.promise); await click('预览批量变更'); await select('b', false); second.resolve(); await flush()
    expect(root.querySelector('table')).toBeNull(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('invalidates preview for payload and saved CAS changes without applying obsolete choices', async () => {
    const f = await setup(); await chooseGroup(); await click('预览批量变更')
    await f.session.edit(next => { next.welds[2].location = 'new location' }); await flush(); expect(root.querySelector('table')).toBeNull()
    await click('预览批量变更'); f.session.state.draftSeq++; await flush(); expect(root.querySelector('table')).toBeNull()
    expect(f.session.state.payload.welds[0].group_name).toBeUndefined(); expect(f.session.state.historyLength).toBe(1)
  })
  it('rejects a confirmation whose target changes while its second snapshot is pending', async () => {
    const f = await setup(); await chooseGroup(); await click('预览批量变更')
    const held = deferred(); f.barrier.mockImplementationOnce(() => held.promise); await click('确认批量变更')
    f.session.resetEntry(); held.resolve(); await flush()
    expect(f.session.state.planId).toBe(''); expect(f.session.state.payload.welds).toEqual([]); expect(f.session.state.historyLength).toBe(0); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('rechecks inner admission and tolerates normal transient commandPending during admission', async () => {
    const f = await setup(); await chooseGroup(); await click('预览批量变更')
    let calls = 0
    f.session.setWorkflowAdmission(async (scope, _mode, _target, action) => {
      f.session.check(scope); f.session.setWorkflowPending(scope, true); await Promise.resolve(); f.session.setWorkflowPending(scope, false)
      if (++calls === 2) throw new Error('revoked at inner admission')
      return action(scope)
    })
    await click('确认批量变更'); expect(calls).toBe(2); expect(root.textContent).toContain('revoked at inner admission')
    expect(f.session.state.payload).toEqual(f.original); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.session.state.historyLength).toBe(0)
  })
  it('does not publish an in-memory batch or history when durable recovery refuses the write', async () => {
    const f = await setup(); await chooseGroup(); await click('预览批量变更'); vi.mocked(f.db.claim).mockResolvedValueOnce(false)
    await click('确认批量变更'); expect(f.session.state.storageBlocked).toBe(true); expect(f.session.state.payload).toEqual(f.original)
    expect(f.session.state.historyLength).toBe(0); expect(f.stored()).toBeNull(); expect(f.client.save).not.toHaveBeenCalled()
  })
  it('deduplicates confirm and disables cancellation once the atomic confirmation starts', async () => {
    const f = await setup(); await chooseGroup(); await click('预览批量变更')
    const held = deferred(); f.barrier.mockImplementationOnce(() => held.promise); await click('确认批量变更'); await click('确认批量变更')
    expect(button('取消批量预览').disabled).toBe(true); held.resolve(); await flush()
    expect(f.session.state.historyLength).toBe(1); expect(f.db.claim).toHaveBeenCalledTimes(1)
  })
  it('refuses read-only and storage-blocked edits and drops an unmounted late preview', async () => {
    const f = await setup(); await chooseGroup(); f.writable.value = false; await flush(); await click('预览批量变更'); expect(f.barrier).not.toHaveBeenCalled()
    f.writable.value = true; f.session.state.storageBlocked = true; await flush(); await click('预览批量变更'); expect(root.querySelector('table')).toBeNull()
    f.session.state.storageBlocked = false; const held = deferred(); f.barrier.mockImplementationOnce(() => held.promise); await click('预览批量变更'); f.unmount(); held.resolve(); await flush()
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.session.state.payload).toEqual(f.original)
  })
})
