import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, h, nextTick, reactive, type App } from 'vue'
import Panel from '../src/views/welding/WeldingSourceChangePanel.vue'
import { sourcePreparationFixture } from './fixtures/welding-source-preparation'
import { clone } from '../src/services/welding/planRecovery'
const mocks = vi.hoisted(() => ({ viewers: [] as any[], loads: [] as Promise<void>[] }))
vi.mock('../src/services/welding/cadBridge', () => ({ loadReadOnlyCad: vi.fn((frame, url, doc, accepts) => {
  const viewer = { loaded: mocks.loads.shift() ?? Promise.resolve(), destroy: vi.fn() }
  mocks.viewers.push({ frame, url, doc, accepts, viewer }); return viewer
}) }))
let app: App, root: HTMLDivElement
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); await nextTick() }
const button = (text: string) => [...root.querySelectorAll('button')].find(b => b.textContent!.trim() === text)!
const click = async (text: string) => { button(text).click(); await tick() }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
async function mount() {
  mocks.viewers = []; mocks.loads = []; const f = sourcePreparationFixture()
  const candidate = { item_id: f.next.item_id, version_id: f.next.version_id, file_id: f.next.file_id, file_role: f.next.file_role, checksum: f.next.expected_checksum, name: 'Next', number: 'D2', version_label: 'A' }
  const state = reactive({ owner: clone(f.owner), planId: 'plan', versionId: 'v', recoveryId: 'r', draftSeq: 1, contentHash: f.point.content_hash, editSeq: 0, payload: clone(f.point.payload), savedPoint: clone(f.point), busy: false, pending: null as any, commandPending: false, message: '' })
  const preview = { point: f.point, owner: f.owner, editSeq: 0, recoveryId: 'r', payload: f.point.payload, preparation: f.prepared }
  const session = { state, canEdit: computed(() => !state.busy && !state.pending), canChangeDrawing: computed(() => !state.busy && !state.pending),
    capture: () => { const seq = state.editSeq; return { accepts: () => seq === state.editSeq } }, fresh: vi.fn(async () => clone(f.owner)),
    client: { drawingCandidates: vi.fn(async () => [candidate]), cadTicket: vi.fn(async (_input: { purpose: string }) => ({ asset_url: '/readonly.html' })) },
    prepareDrawing: vi.fn(async () => clone(preview)), confirmDrawing: vi.fn(async (_value, scope) => {
      state.commandPending = true; await Promise.resolve(); state.commandPending = false
      state.pending = {}; await Promise.resolve(); expect(scope.accepts()).toBe(true)
      state.payload = clone(f.prepared.source_change.after.payload); state.draftSeq = 2; state.pending = null
    }), adoptSavedDrawing: vi.fn(async () => {}),
  }
  root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Panel, { session: session as any }) }); app.mount(root); await tick()
  const input = root.querySelector('input')!; input.value = 'next'; input.dispatchEvent(new Event('input', { bubbles: true })); await tick()
  await click('查找图纸'); await click('D2 · Next · A · f2')
  return { f, session, state }
}
afterEach(() => { app?.unmount(); root?.remove(); vi.restoreAllMocks() })
describe('source change Vue preview', () => {
  it('requires both readonly frames before confirm and keeps scope through pending/admission transitions', async () => {
    const f = await mount(), second = deferred(); mocks.loads = [Promise.resolve(), second.promise]
    await click('准备并预览换图')
    expect(mocks.viewers).toHaveLength(2); expect(button('确认换图并保存').disabled).toBe(true)
    expect(f.state.payload).toEqual(f.f.point.payload)
    second.resolve(); await tick(); expect(button('确认换图并保存').disabled).toBe(false)
    expect(f.session.client.cadTicket.mock.calls.map(row => row[0].purpose)).toEqual(['preparation', 'preparation'])
    await click('确认换图并保存'); expect(f.session.confirmDrawing).toHaveBeenCalledOnce()
    expect(f.state.payload.drawing).toEqual(f.f.next); expect(mocks.viewers.every(v => v.viewer.destroy.mock.calls.length)).toBe(true)
  })
  it.each(['cancel', 'edit', 'owner', 'point', 'query', 'unmount'])('destroys both frames and refuses late readiness after %s', async reason => {
    const f = await mount(), second = deferred(); mocks.loads = [Promise.resolve(), second.promise]
    await click('准备并预览换图'); expect(mocks.viewers).toHaveLength(2)
    if (reason === 'cancel') await click('取消换图预览')
    if (reason === 'edit') f.state.editSeq++
    if (reason === 'owner') f.state.owner.rbac_user_id++
    if (reason === 'point') f.state.contentHash = '0'.repeat(64)
    if (reason === 'query') { const input = root.querySelector('input')!; input.value = 'other'; input.dispatchEvent(new Event('input')) }
    if (reason === 'unmount') app.unmount()
    await tick(); second.resolve(); await tick()
    expect(mocks.viewers.every(v => v.viewer.destroy.mock.calls.length)).toBe(true)
    expect(mocks.viewers.every(v => !v.accepts())).toBe(true); expect(f.session.confirmDrawing).not.toHaveBeenCalled()
    if (reason !== 'unmount') expect(button('确认换图并保存').disabled).toBe(true)
    expect(f.state.payload).toEqual(f.f.point.payload)
  })
  it('cleans both frames if the second view fails', async () => {
    await mount(); const rejected = Promise.reject(new Error('viewer failed')); void rejected.catch(() => {})
    mocks.loads = [Promise.resolve(), rejected]; await click('准备并预览换图')
    expect(mocks.viewers.every(v => v.viewer.destroy.mock.calls.length)).toBe(true)
    expect(button('确认换图并保存').disabled).toBe(true); expect(root.textContent).toContain('viewer failed')
  })
})
