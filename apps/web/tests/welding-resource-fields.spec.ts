import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import Fields from '../src/views/welding/WeldingResourceFields.vue'
import { useWeldingWorkflowSession } from '../src/views/welding/useWeldingWorkflowSession'
import { useWeldingGenerationSession } from '../src/views/welding/useWeldingGenerationSession'
import { validateWorkflowPending, type CommandRecoveryStore } from '../src/services/welding/commandRecovery'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { clone, equal, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'
import type { WeldingPlanClient } from '../src/services/welding/planClient'
import type { ResourceMaintenanceRecord } from '../src/services/welding/resourceContracts'
let app: App<Element>, root: HTMLDivElement, dispose: () => void
const owner = { tenant_id: 't', org_id: 'o', auth_user_id: 7, rbac_user_id: 19 }
const jointRecord = (): ResourceMaintenanceRecord => ({ resource_id: 'r', item_version_id: 'rv', content_hash: 'b'.repeat(64), name: 'Joint', number: 'J1', kind: 'joint_diagram', version_label: 'A', state: 'Draft',
  payload: { schema_version: 1, kind: 'joint_diagram', suggested_fields: { joint_type: 'text is separate' }, document: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'reference', expected_fingerprint: 'c'.repeat(64) } },
  sources: { document: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'reference', fingerprint: 'c'.repeat(64), checksum: 'd'.repeat(64), title: 'Joint', file_name: 'joint.png', version_label: 'A', state: 'Draft', is_released: false },
    diagram: { schema: 'yuantus.welding_joint_diagram/1', actual_sha256: 'd'.repeat(64), byte_size: 3, mime_type: 'image/png', format: 'png', width: 2, height: 3, exif_orientation: 6 } } })
async function mount(actualAdmission = false) {
  const flags = { writable: true }
  let stored: PlanRecoveryRecord | null = null
  const payload = { schema_version: 1, product: { item_id: 'p', version_id: 'pv' }, drawing: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }, welds: [{ weld_id: 'w', display_no: '1', method: 'manual', filler: 'keep', passes: [{ sequence: 7, current: { value: 90, unit: 'A' } }], future: true }] }
  const plan = { plan_id: 'p', item_version_id: 'v', draft_seq: 1, content_hash: 'a'.repeat(64), state: 'Draft', name: 'P', number: '1', payload, sources: {}, version_label: 'A' }
  const record = { resource_id: 'r', item_version_id: 'rv', content_hash: 'b'.repeat(64), kind: 'wps', payload: { schema_version: 1, kind: 'wps', suggested_fields: { method: 'registered', passes: [{ sequence: 1, current: { value: 100, unit: 'A' } }] } } }
  const client = { recoveryOwner: vi.fn(async () => clone(owner)), read: vi.fn(async () => clone(plan)), recover: vi.fn(async (_p, r) => ({ owner, record_id: r.recovery_id, current: clone(plan), can_write: true, conflict: false })), list: vi.fn(async () => ({ items: [], total: 0, offset: 0 })), resource: vi.fn(async () => clone(record)),
    readResource: vi.fn(async () => jointRecord()), readResourceDiagram: vi.fn(async () => new Blob(['abc'], { type: 'image/png' })) } as unknown as WeldingPlanClient
  const db: PlanRecoveryStore = { list: async () => [], get: async () => clone(stored), claim: vi.fn(async r => { stored = clone(r); return true }), compareReplace: vi.fn(async (old, next) => { if (!equal(stored, old)) return false; stored = clone(next); return true }), close() {} }
  const session = useWeldingPlanSession({ client, openStore: async () => db, writable: () => flags.writable }); session.setWorkflowAdmission(async (scope, _mode, _target, action) => action(scope)); session.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope)); dispose = session.dispose; await session.initialize(); await session.open('p', 'v')
  const commands: CommandRecoveryStore = { get: vi.fn(async () => null), claim: vi.fn(async () => false), clear: vi.fn(async () => false), getWorkflow: vi.fn(async () => null), claimWorkflow: vi.fn(async () => false), clearWorkflow: vi.fn(async () => false), close: vi.fn() }
  if (actualAdmission) {
    client.authority = vi.fn(async () => clone(owner))
    client.readReviewState = vi.fn(async () => ({ schema: 'yuantus.welding_review_state/1' as const, plan_id: 'p', item_version_id: 'v', state: 'Draft' as const, draft_seq: 1, content_hash: 'a'.repeat(64), is_current: true, approval: null, final_generation: null, publication: null, final_profile: null, allowed_actions: [], issues: [] }))
    const workflow = useWeldingWorkflowSession({ session, active: () => true, writable: () => flags.writable, openStore: async () => commands })
    const generation = useWeldingGenerationSession({ session, active: () => true, writable: () => flags.writable, openStore: async () => commands })
    dispose = () => { generation.dispose(); workflow.dispose(); session.dispose() }
  }
  root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Fields, { session }) }); app.mount(root); return { session, client, db, commands, flags, stored: () => stored }
}
const button = (label: string) => [...root.querySelectorAll('button')].find(b => b.textContent === label)!
async function set(label: string, value: string) { const input = [...root.querySelectorAll('label')].find(l => l.childNodes[0].textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!; input.value = value; input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await nextTick() }
async function preview() { await set('目标焊缝', 'w'); await set('资料 ID', 'r'); await set('版本 ID', 'rv'); button('读取固定版本并预览').click(); await vi.waitFor(() => expect(root.textContent).toContain('registered')) }
async function select(key: string) { const input = root.querySelector<HTMLInputElement>(`input[type=checkbox][value=${key}]`)!; input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); await nextTick() }
beforeEach(() => { localStorage.setItem('auth_token', 'native'); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, action) => action()) } }) })
afterEach(() => { app?.unmount(); dispose?.(); root?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'locks') })
describe('actual resource preview and atomic import UI', () => {
  it('compares manual/registered values, imports selected fields only and detaches last reference without reverting values', async () => {
    const f = await mount(); await preview(); expect(root.textContent).toContain('manual'); await select('method'); button('带入明确选定字段').click()
    await vi.waitFor(() => expect(f.session.state.payload.welds[0].method).toBe('registered'))
    expect(f.session.state.payload.welds[0]).toMatchObject({ filler: 'keep', passes: [{ sequence: 7 }], future: true }); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    const refs = f.session.state.payload.resource_refs as any[]; expect(refs[0]).toMatchObject({ resource_id: 'r', version_id: 'rv', expected_content_hash: 'b'.repeat(64), selected_fields: ['method'] })
    button('解除此字段引用').click(); await vi.waitFor(() => expect(f.session.state.payload.resource_refs).toEqual([])); expect(f.session.state.payload.welds[0].method).toBe('registered')
  })
  it('replaces passes as a whole and rejects stale preview after another edit', async () => {
    const f = await mount(); await preview(); await select('passes'); expect(root.textContent).toContain('整体替换'); button('带入明确选定字段').click()
    await vi.waitFor(() => expect((f.session.state.payload.welds[0].passes as any[])[0].sequence).toBe(1)); expect((f.session.state.payload.welds[0].passes as any[])).toHaveLength(1)
    await preview(); await select('method'); await f.session.edit(p => { p.welds[0].filler = 'later' }); await nextTick(); button('带入明确选定字段').click(); await vi.waitFor(() => expect(root.textContent).toContain('会话或目标已变化')); expect(f.session.state.payload.welds[0].method).toBe('manual')
  })
  it('does not publish imported values before durable storage or after same-token Y owner changes', async () => {
    const f = await mount(); await preview(); await select('method'); vi.mocked(f.db.claim).mockRejectedValueOnce(new Error('quota')); button('带入明确选定字段').click(); await vi.waitFor(() => expect(root.textContent).toContain('quota')); expect(f.session.state.payload.welds[0].method).toBe('manual')
    vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 }); button('读取固定版本并预览').click(); await vi.waitFor(() => expect(f.session.state.owner).toBeNull()); expect(root.textContent).not.toContain('registered')
  })
})

describe('explicit plan diagram reference through actual durable commitPayload', () => {
  const nativeUrl = URL
  beforeEach(() => {
    vi.stubGlobal('URL', class extends nativeUrl { static createObjectURL = vi.fn(() => 'blob:joint'); static revokeObjectURL = vi.fn() })
    vi.stubGlobal('Image', class { naturalWidth = 2; naturalHeight = 3; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(value: string) { if (value) queueMicrotask(() => this.onload?.()) } })
  })
  async function diagram() {
    await set('目标焊缝', 'w'); await set('资料 ID', 'r'); await set('版本 ID', 'rv')
    button('读取并预览固定接头图').click(); await nextTick()
    await vi.waitFor(() => {
      expect(root.querySelector('img')).not.toBeNull()
      const confirm = [...root.querySelectorAll('button')].find(value => ['明确引用接头图', '明确替换接头图引用'].includes(value.textContent ?? ''))
      expect(confirm).toBeDefined(); expect(confirm!.disabled).toBe(false)
    })
  }
  it('does not edit on preview, then creates/replaces/removes only the explicit diagram reference', async () => {
    const f = await mount(); await preview(); await select('method'); button('带入明确选定字段').click()
    await vi.waitFor(() => expect(f.session.state.payload.welds[0].method).toBe('registered'))
    const before = clone(f.session.state.payload), textRef = clone(before.resource_refs)
    await diagram(); expect(f.session.state.payload).toEqual(before); expect(f.client.readResource).toHaveBeenCalled()
    button('明确引用接头图').click(); await vi.waitFor(() => expect((f.session.state.payload.resource_refs as unknown[]).length).toBe(2))
    const first = (f.session.state.payload.resource_refs as Record<string, unknown>[]).find(r => r.purpose === 'joint_diagram')!
    expect(first).toEqual({ reference_id: expect.any(String), weld_id: 'w', resource_id: 'r', version_id: 'rv', expected_content_hash: 'b'.repeat(64), purpose: 'joint_diagram', selected_fields: [] })
    expect(f.session.state.payload.welds).toEqual(before.welds); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    await diagram(); button('明确替换接头图引用').click()
    await vi.waitFor(() => expect((f.session.state.payload.resource_refs as Record<string, unknown>[]).find(r => r.purpose === 'joint_diagram')!.reference_id).not.toBe(first.reference_id))
    button('解除整项接头图引用').click(); await vi.waitFor(() => expect(f.session.state.payload.resource_refs).toEqual(textRef)); expect(f.session.state.payload.welds).toEqual(before.welds)
    const undo = f.session.historyCandidate('undo'); await f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)
    expect((f.session.state.payload.resource_refs as unknown[]).length).toBe(2)
    const redo = f.session.historyCandidate('redo'); await f.session.commitPayload(redo.payload, f.session.capture(), redo.cursor); expect(f.session.state.payload.resource_refs).toEqual(textRef)
  })
  it('hands off a verified diagram through the actual workflow/generation gates exactly once for reference and replacement', async () => {
    const f = await mount(true), gate = vi.spyOn(f.session, 'setWorkflowPending'), before = clone(f.session.state.payload)
    await diagram(); expect(f.session.state.payload).toEqual(before); expect(f.db.claim).not.toHaveBeenCalled()
    button('明确引用接头图').click(); await vi.waitFor(() => expect(f.session.state.payload.resource_refs).toHaveLength(1))
    expect(gate.mock.calls.some(([, pending]) => pending)).toBe(true); expect(f.commands.getWorkflow).toHaveBeenCalled(); expect(f.commands.get).toHaveBeenCalled()
    expect(f.db.claim).toHaveBeenCalledOnce(); expect(f.session.state.payload.welds).toEqual(before.welds); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    const first = (f.session.state.payload.resource_refs as Record<string, unknown>[])[0].reference_id
    await diagram(); button('明确替换接头图引用').click()
    await vi.waitFor(() => expect((f.session.state.payload.resource_refs as Record<string, unknown>[])[0].reference_id).not.toBe(first))
    expect(f.db.claim).toHaveBeenCalledOnce(); expect(f.db.compareReplace).toHaveBeenCalledOnce(); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    expect(f.session.state.payload.welds).toEqual(before.welds)
  })
  it('rechecks resource access before referencing a cached diagram and preserves the local draft on rejection', async () => {
    const f = await mount(true); await diagram()
    const before = clone(f.session.state.payload), editSeq = f.session.state.editSeq, stored = clone(f.stored())
    vi.mocked(f.client.readResource).mockRejectedValueOnce(new Error('resource access revoked'))
    button('明确引用接头图').click()
    await vi.waitFor(() => expect(root.textContent).toContain('resource access revoked'))
    expect(f.client.readResource).toHaveBeenCalledTimes(2)
    expect(f.session.state.payload).toEqual(before); expect(f.session.state.editSeq).toBe(editSeq); expect(f.stored()).toEqual(stored)
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
    expect(root.querySelector('img')).toBeNull(); expect(root.textContent).not.toContain('拟引用图：')
    expect(button('明确引用接头图').disabled).toBe(true); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:joint')
  })
  it('rejects a changed fixed diagram hash on reference revalidation before durable writes', async () => {
    const f = await mount(true); await diagram(); const before = clone(f.session.state.payload)
    vi.mocked(f.client.readResource).mockResolvedValueOnce({ ...jointRecord(), content_hash: 'e'.repeat(64) })
    button('明确引用接头图').click(); await vi.waitFor(() => expect(root.textContent).toContain('固定图引用摘要已变化'))
    expect(f.session.state.payload).toEqual(before); expect(f.stored()).toBeNull()
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled(); expect(root.querySelector('img')).toBeNull()
  })
  it.each(['owner', 'target', 'edit', 'selection-revert'])('rejects %s change while revalidating resource access', async change => {
    const f = await mount(true); await diagram(); let release!: () => void
    vi.mocked(f.client.readResource).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(jointRecord()) }))
    button('明确引用接头图').click(); await vi.waitFor(() => expect(release).toBeDefined())
    if (change === 'owner') f.session.state.owner = { ...owner, rbac_user_id: 20 }
    else if (change === 'target') f.session.state.versionId = 'other'
    else if (change === 'edit') { f.session.state.payload.welds[0].filler = 'later'; f.session.state.editSeq++ }
    else { await set('资料 ID', 'other'); await set('资料 ID', 'r') }
    await nextTick(); release(); await vi.waitFor(() => expect(root.querySelector('[role=alert]')?.textContent).not.toBe(''))
    expect(f.session.state.payload.resource_refs).toBeUndefined(); expect(f.stored()).toBeNull()
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled(); expect(root.querySelector('img')).toBeNull()
  })
  it.each(['weld-revert', 'resource-revert', 'version-revert', 'owner', 'target', 'edit', 'writable'])('rejects %s change during the actual admission handoff before any durable write', async change => {
    const f = await mount(true); await diagram(); let release!: () => void
    vi.mocked(f.client.authority).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(clone(owner)) }))
    button('明确引用接头图').click(); await vi.waitFor(() => expect(release).toBeDefined())
    if (change === 'weld-revert') { await set('目标焊缝', ''); await set('目标焊缝', 'w') }
    else if (change === 'resource-revert') { await set('资料 ID', 'other'); await set('资料 ID', 'r') }
    else if (change === 'version-revert') { await set('版本 ID', 'other'); await set('版本 ID', 'rv') }
    else if (change === 'owner') f.session.state.owner = { ...owner, rbac_user_id: 20 }
    else if (change === 'target') f.session.state.versionId = 'other'
    else if (change === 'edit') { f.session.state.payload.welds[0].filler = 'later'; f.session.state.editSeq++ }
    else f.flags.writable = false
    await nextTick(); release(); await vi.waitFor(() => expect(root.querySelector('[role=alert]')?.textContent).not.toBe(''))
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled(); expect(f.stored()).toBeNull()
    expect(f.session.state.payload.resource_refs).toBeUndefined(); expect(f.session.state.historyLength).toBe(0)
  })
  it('keeps a real other-page workflow original blocked after the preview-to-mutation handoff', async () => {
    const f = await mount(true); await diagram(); const before = clone(f.session.state.payload)
    const pending = validateWorkflowPending({ schema: 'metasheet.welding_command_pending/1', kind: 'workflow', owner, plan_id: 'p', item_version_id: 'v', action: 'withdraw',
      body: { request_id: 'other-original', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), approval_request_id: 'approval', expected_submission_hash: 'a'.repeat(64), reason: 'pending' } })
    vi.mocked(f.commands.getWorkflow).mockResolvedValue(pending); button('明确引用接头图').click()
    await vi.waitFor(() => expect(root.textContent).toContain('原评审请求仍待确认'))
    expect(f.session.state.commandPending).toBe(true); expect(f.session.state.payload).toEqual(before); expect(f.stored()).toBeNull()
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
  })
  it('does not publish payload, recovery store or history when the diagram claim hits quota', async () => {
    const f = await mount(); const before = clone(f.session.state.payload), stored = clone(f.stored())
    const history = { cursor: f.session.state.historyCursor, length: f.session.state.historyLength, editSeq: f.session.state.editSeq }
    await diagram()
    vi.mocked(f.db.claim).mockRejectedValueOnce(new Error('quota')); button('明确引用接头图').click()
    await vi.waitFor(() => expect(root.textContent).toContain('quota'))
    expect(f.session.state.payload).toEqual(before); expect(f.stored()).toEqual(stored)
    expect({ cursor: f.session.state.historyCursor, length: f.session.state.historyLength, editSeq: f.session.state.editSeq }).toEqual(history)
    expect(f.session.state.storageBlocked).toBe(true); expect(f.session.state.atomicBusy).toBe(false)
    expect(f.db.claim).toHaveBeenCalledOnce(); expect(f.db.compareReplace).not.toHaveBeenCalled()
  })
  it('preserves the complete payload and stored recovery when a diagram replacement loses CAS', async () => {
    const f = await mount(); await diagram(); button('明确引用接头图').click()
    await vi.waitFor(() => expect(f.session.state.payload.resource_refs).toHaveLength(1))
    expect(f.db.claim).toHaveBeenCalledOnce(); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    const saved = clone(f.session.state.payload), stored = clone(f.stored())
    await diagram(); vi.mocked(f.db.compareReplace).mockResolvedValueOnce(false)
    button('明确替换接头图引用').click(); await vi.waitFor(() => expect(root.textContent).toContain('恢复点'))
    expect(f.session.state.payload).toEqual(saved); expect(f.stored()).toEqual(stored)
    expect(f.db.compareReplace).toHaveBeenCalledOnce(); expect(vi.mocked(f.db.compareReplace).mock.calls[0][0]).toEqual(stored)
    expect(f.session.state.storageBlocked).toBe(true); expect(f.session.state.atomicBusy).toBe(false)
  })
  it('invalidates proof after another edit and blocks modifications while a command is pending', async () => {
    const f = await mount(); await diagram(); await f.session.edit(p => { p.welds[0].filler = 'later' }); await nextTick()
    expect(root.querySelector('img')).toBeNull(); expect(button('明确引用接头图').disabled).toBe(true)
    await diagram(); f.session.setCommandPending(f.session.capture(), true); await nextTick()
    expect(button('明确引用接头图').disabled).toBe(true); expect(f.session.state.payload.resource_refs).toBeUndefined(); expect(f.session.state.payload.welds[0].filler).toBe('later')
  })
  it('rejects a wrong current fixed hash and same-token owner drift without changing refs', async () => {
    const f = await mount(); await f.session.edit(p => { p.resource_refs = [{ reference_id: 'old', weld_id: 'w', resource_id: 'r', version_id: 'rv', expected_content_hash: 'e'.repeat(64), purpose: 'joint_diagram', selected_fields: [] }] })
    await set('目标焊缝', 'w'); await set('资料 ID', 'r'); await set('版本 ID', 'rv'); const before = clone(f.session.state.payload)
    button('读取并预览固定接头图').click(); await vi.waitFor(() => expect(root.textContent).toContain('固定摘要已变化'))
    expect(f.client.readResourceDiagram).not.toHaveBeenCalled(); expect(f.session.state.payload).toEqual(before)
    vi.mocked(f.client.readResource).mockResolvedValue({ ...jointRecord(), content_hash: 'e'.repeat(64) })
    vi.mocked(f.client.readResourceDiagram).mockImplementationOnce(async () => { vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 }); return new Blob(['abc'], { type: 'image/png' }) })
    button('读取并预览固定接头图').click(); await vi.waitFor(() => expect(f.session.state.owner).toBeNull()); expect(root.querySelector('img')).toBeNull()
  })
})
