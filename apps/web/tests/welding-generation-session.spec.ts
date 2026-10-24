import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { useWeldingGenerationSession } from '../src/views/welding/useWeldingGenerationSession'
import { clone, equal } from '../src/services/welding/planRecovery'
import { WeldingPlanError, generationBasis, type WeldingPlanClient } from '../src/services/welding/planClient'
import type { GenerationPending } from '../src/services/welding/commandRecovery'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const template = { id: 'welding-a4', version: '1', digest: 'b'.repeat(64), name: 'A4', available: true, unavailable_reason: null, default_options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null }, options_schema: {} }
const plan = { plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', draft_seq: 1, content_hash: 'a'.repeat(64), payload: { schema_version: 1, product: null, drawing: null, welds: [] }, sources: {} }
function fixture() {
  let original: GenerationPending | null = null
  const active = ref(true), writable = ref(true)
  const fixed = { generation_id: '00000000-0000-4000-8000-000000000009', render_key: 'c'.repeat(64), plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, plan_content_hash: 'a'.repeat(64), generation_content_hash: 'd'.repeat(64), purpose: 'review', template: { id: 'welding-a4', version: '1', digest: 'b'.repeat(64) } }
  const client = { recoveryOwner: vi.fn(async () => owner), read: vi.fn(async () => clone(plan)), recover: vi.fn(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: clone(plan), can_write: true, conflict: false })),
    renderTemplates: vi.fn(async () => [clone(template)]), listReviewGenerations: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 20 })),
    createReviewGeneration: vi.fn(async (_plan, _version, body) => ({ schema: 'yuantus.welding_generation_ack/1', request_id: body.request_id, ...fixed })),
    retryReviewGeneration: vi.fn(async (_basis, body) => ({ schema: 'yuantus.welding_generation_ack/1', request_id: body.request_id, ...fixed })),
    downloadReviewFile: vi.fn(async () => new Blob(['pdf'], { type: 'application/pdf' })),
    readReviewGeneration: vi.fn(async () => ({ schema: 'yuantus.welding_plan_generation/1', ...fixed, status: 'Queued', attempt: 0, created_at: '2026-10-09T00:00:00Z', review: { pending_count: 0, unbound_count: 0 }, files: { pdf: null, docx: null }, error: null })),
  } as unknown as WeldingPlanClient
  const db = { get: vi.fn(async () => clone(original)), claim: vi.fn(async value => { if (original) return equal(original, value); original = clone(value); return true }), clear: vi.fn(async value => { if (!equal(original, value)) return false; original = null; return true }), close: vi.fn() }
  const session = useWeldingPlanSession({ client, writable: () => writable.value })
  session.setWorkflowAdmission(async (scope, _mode, _target, action) => action(scope))
  const generation = useWeldingGenerationSession({ session, active: () => active.value, writable: () => writable.value, openStore: async () => db, uuid: () => '00000000-0000-4000-8000-000000000001' })
  return { session, generation, client, db, active, writable, fixed, getOriginal: () => clone(original), setOriginal: (value: GenerationPending | null) => { original = clone(value) } }
}
const fixtures: ReturnType<typeof fixture>[] = []
async function make() { const f = fixture(); fixtures.push(f); await f.session.open('plan', 'v1'); await f.generation.refresh(); return f }
beforeEach(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action() } }); localStorage.setItem('auth_token', 'native-A') })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
afterEach(() => { fixtures.splice(0).forEach(f => { f.generation.dispose(); f.session.dispose() }); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); delete (navigator as any).locks })
describe('saved review generation commands', () => {
  it('dispatches the current saved basis and clears only its bound original ACK', async () => {
    const f = await make(); await f.generation.create()
    expect(f.client.createReviewGeneration).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.client.createReviewGeneration).mock.calls[0][2]).toMatchObject({ expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), purpose: 'review' })
    expect(f.getOriginal()).toBeNull()
    expect(f.generation.state.current?.status).toBe('Queued')
  })
  it('waits for durable claim completion before dispatch and CAS completion before success', async () => {
    const f = await make(), claim = deferred<boolean>(), clear = deferred<boolean>()
    const actualClaim = f.db.claim.getMockImplementation()!, actualClear = f.db.clear.getMockImplementation()!
    f.db.claim.mockImplementationOnce(async value => { await actualClaim(value); return claim.promise })
    f.db.clear.mockImplementationOnce(async value => { await clear.promise; return actualClear(value) })
    const job = f.generation.create()
    await vi.waitFor(() => expect(f.db.claim).toHaveBeenCalled())
    expect(f.client.createReviewGeneration).not.toHaveBeenCalled(); expect(f.session.canEdit.value).toBe(false)
    claim.resolve(true); await vi.waitFor(() => expect(f.db.clear).toHaveBeenCalled())
    expect(f.generation.state.pending).not.toBeNull(); expect(f.generation.state.current).toBeNull()
    clear.resolve(true); await job; expect(f.getOriginal()).toBeNull()
  })
  it('keeps editing blocked when a form changes during durable claim', async () => {
    const f = await make(), claim = deferred<boolean>(), actualClaim = f.db.claim.getMockImplementation()!
    f.db.claim.mockImplementationOnce(async value => { await actualClaim(value); return claim.promise })
    const job = f.generation.create(); await vi.waitFor(() => expect(f.db.claim).toHaveBeenCalled())
    f.generation.state.options.header_text = 'changed after claim'; claim.resolve(true); await job
    expect(f.getOriginal()).not.toBeNull(); expect(f.client.createReviewGeneration).not.toHaveBeenCalled()
    expect(f.session.canEdit.value).toBe(false)
    await f.generation.refresh(); expect(f.generation.state.pending).toEqual(f.getOriginal())
  })
  it('retains exact original ID/body after UNKNOWN and then 409, and confirms by original POST', async () => {
    const f = await make()
    vi.mocked(f.client.createReviewGeneration).mockRejectedValueOnce(new WeldingPlanError('结果待确认', 502, 'WELDING_RESULT_UNKNOWN'))
      .mockRejectedValueOnce(new WeldingPlanError('内容已变化', 409, 'CONFLICT'))
    await f.generation.create(); const original = f.getOriginal()!
    expect(f.session.canEdit.value).toBe(false); await f.generation.confirmOriginal()
    expect(f.getOriginal()).toEqual(original); expect(f.db.clear).not.toHaveBeenCalled()
    await f.generation.confirmOriginal(); expect(f.getOriginal()).toBeNull()
    expect(vi.mocked(f.client.createReviewGeneration).mock.calls.map(value => value[2])).toEqual([original.body, original.body, original.body])
  })
  it('rejects a matching-looking ACK with another template and preserves the original', async () => {
    const f = await make()
    vi.mocked(f.client.createReviewGeneration).mockImplementationOnce(async (_plan, _version, body) => ({ schema: 'yuantus.welding_generation_ack/1', request_id: body.request_id, ...f.fixed, template: { ...f.fixed.template, digest: 'e'.repeat(64) } }))
    await f.generation.create(); expect(f.getOriginal()).not.toBeNull(); expect(f.db.clear).not.toHaveBeenCalled()
  })
  it('does not dispatch before the CAD barrier resolves, and blocks after its failure', async () => {
    const f = await make(), barrier = deferred<void>(); f.session.setCadBarrier(() => barrier.promise)
    const job = f.generation.create(); await nextTick(); expect(f.db.claim).not.toHaveBeenCalled()
    barrier.reject(new Error('图纸保存未完成')); await job; expect(f.client.createReviewGeneration).not.toHaveBeenCalled()
  })
  it('does not clear a late ACK after target replacement or let old finally unlock a new command', async () => {
    const f = await make(), ack = deferred<any>()
    vi.mocked(f.client.createReviewGeneration).mockImplementationOnce(() => ack.promise)
    const job = f.generation.create(); await vi.waitFor(() => expect(f.client.createReviewGeneration).toHaveBeenCalled())
    const original = f.getOriginal()!; f.session.resetEntry(); f.session.state.commandBusy = true
    ack.resolve({ schema: 'yuantus.welding_generation_ack/1', request_id: original.body.request_id, ...f.fixed }); await job
    expect(f.getOriginal()).toEqual(original); expect(f.db.clear).not.toHaveBeenCalled(); expect(f.session.state.commandBusy).toBe(true)
  })
  it('retains a late receipt after same-token ABA invalidation', async () => {
    const f = await make(), ack = deferred<any>(); vi.mocked(f.client.createReviewGeneration).mockImplementationOnce(() => ack.promise)
    const job = f.generation.create(); await vi.waitFor(() => expect(f.client.createReviewGeneration).toHaveBeenCalled())
    const original = f.getOriginal()!
    localStorage.setItem('auth_token', 'native-B'); window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    localStorage.setItem('auth_token', 'native-A'); window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    ack.resolve({ schema: 'yuantus.welding_generation_ack/1', request_id: original.body.request_id, ...f.fixed }); await job
    expect(f.getOriginal()).toEqual(original); expect(f.db.clear).not.toHaveBeenCalled(); expect(f.generation.state.current).toBeNull()
  })
  it('does not send on storage failure or overwrite a competing original', async () => {
    const f = await make(); f.db.claim.mockRejectedValueOnce(new Error('quota')); await f.generation.create()
    expect(f.client.createReviewGeneration).not.toHaveBeenCalled()
    f.db.claim.mockResolvedValueOnce(false); await f.generation.create(); expect(f.client.createReviewGeneration).not.toHaveBeenCalled()
  })
  it('retries only a failed review task with its complete fixed basis', async () => {
    const f = await make(), record = { schema: 'yuantus.welding_plan_generation/1', ...f.fixed, status: 'Failed', attempt: 2, created_at: '2026-10-09T00:00:00Z', review: { pending_count: 0, unbound_count: 0 }, files: { pdf: null, docx: null }, error: { stage: 'render', code: 'RENDER_FAILED', message: 'render failed' } } as import('../src/services/welding/planClient').ReviewGeneration
    vi.mocked(f.client.readReviewGeneration).mockResolvedValue(record)
    f.generation.state.items = [record]; await f.generation.select(record.generation_id); await f.generation.retryFailed()
    expect(f.db.claim.mock.calls[0][0]).toMatchObject({ action: 'retry', body: { expected_attempt: 2 }, basis: generationBasis(record) })
    expect(f.client.retryReviewGeneration).toHaveBeenCalledWith(generationBasis(record), { request_id: '00000000-0000-4000-8000-000000000001', expected_attempt: 2 }, expect.anything())
  })
  it('does not publish a revoked owner response and retains a pending original', async () => {
    const f = await make()
    vi.mocked(f.client.createReviewGeneration).mockImplementationOnce(async (_plan, _version, body) => {
      vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 })
      return { schema: 'yuantus.welding_generation_ack/1', request_id: body.request_id, ...f.fixed }
    })
    await f.generation.create(); expect(f.getOriginal()).not.toBeNull(); expect(f.db.clear).not.toHaveBeenCalled(); expect(f.generation.state.current).toBeNull()
  })
  it('keeps the current epoch for an equal owner returned in another key order', async () => {
    const f = await make(); vi.mocked(f.client.recoveryOwner).mockResolvedValue({ rbac_user_id: 19, auth_user_id: 7, org_id: 'org', tenant_id: 'tenant' })
    await f.generation.create(); expect(f.client.createReviewGeneration).toHaveBeenCalledTimes(1); expect(f.getOriginal()).toBeNull()
  })
  it('keeps a durable original when fresh owner access is revoked after dispatch', async () => {
    const f = await make(); vi.mocked(f.client.createReviewGeneration).mockImplementationOnce(async (_plan, _version, body) => {
      vi.mocked(f.client.recoveryOwner).mockRejectedValue(new WeldingPlanError('权限已变化', 403))
      return { schema: 'yuantus.welding_generation_ack/1', request_id: body.request_id, ...f.fixed }
    })
    await f.generation.create(); expect(f.getOriginal()).not.toBeNull(); expect(f.db.clear).not.toHaveBeenCalled(); expect(f.generation.state.items).toEqual([])
  })
  it('polls a fixed queued record once per interval and stops on dispose', async () => {
    const f = await make(); await f.generation.create(); const before = vi.mocked(f.client.readReviewGeneration).mock.calls.length
    vi.useFakeTimers()
    // A new explicit status read schedules under the controlled timer; this tests scheduling, not browser performance.
    f.generation.state.items = [f.generation.state.current!]; await f.generation.select(f.fixed.generation_id)
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(3000)
    expect(vi.mocked(f.client.readReviewGeneration).mock.calls.length).toBe(before + 2)
    f.generation.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers()
  })
  it('revokes a preview on cancel, target replacement and read feature revocation', async () => {
    const createUrl = vi.fn(() => 'blob:fixed-review'), revokeUrl = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL() { return createUrl() }; static revokeObjectURL(url: string) { revokeUrl(url) } })
    try {
      const f = await make(), file = { format: 'pdf' as const, mime_type: 'application/pdf', byte_size: 3, artifact_sha256: 'e'.repeat(64) }
      const ready = { schema: 'yuantus.welding_plan_generation/1', ...f.fixed, status: 'Ready', attempt: 1, created_at: '2026-10-09T00:00:00Z', review: { pending_count: 0, unbound_count: 0 }, files: { pdf: file, docx: { ...file, format: 'docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }, error: null } as import('../src/services/welding/planClient').ReviewGeneration
      f.generation.state.current = ready; await f.generation.download('pdf', true); expect(f.generation.state.previewUrl).toBe('blob:fixed-review')
      f.generation.cancelDownload(); expect(revokeUrl).toHaveBeenCalledWith('blob:fixed-review'); expect(f.generation.state.previewUrl).toBe('')
      f.generation.state.current = ready; await f.generation.download('pdf', true); f.active.value = false
      expect(f.generation.state.previewUrl).toBe(''); expect(revokeUrl).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })
  it('cannot expose a download after target changes while bytes are in flight', async () => {
    const f = await make(), file = { format: 'pdf' as const, mime_type: 'application/pdf', byte_size: 3, artifact_sha256: 'e'.repeat(64) }, bytes = deferred<Blob>()
    f.generation.state.current = { schema: 'yuantus.welding_plan_generation/1', ...f.fixed, status: 'Ready', attempt: 1, created_at: '2026-10-09T00:00:00Z', review: { pending_count: 0, unbound_count: 0 }, files: { pdf: file, docx: { ...file, format: 'docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }, error: null } as import('../src/services/welding/planClient').ReviewGeneration
    vi.mocked(f.client.downloadReviewFile).mockImplementationOnce(() => bytes.promise)
    const job = f.generation.download('pdf', true); await vi.waitFor(() => expect(f.client.downloadReviewFile).toHaveBeenCalled())
    f.session.resetEntry(); bytes.resolve(new Blob(['pdf'])); await job; expect(f.generation.state.previewUrl).toBe('')
  })
  it('reports invalid template options without dispatching or an uncaught UI exception', async () => {
    const f = await make(); f.generation.state.options.header_text = 'x'.repeat(257); await expect(f.generation.create()).resolves.toBeUndefined()
    expect(f.generation.state.message).toContain('请核对模板选项'); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.client.createReviewGeneration).not.toHaveBeenCalled()
  })
  it('does not dispatch a dirty local draft', async () => {
    const f = await make(); f.session.state.dirty = true; await f.generation.create()
    expect(f.client.createReviewGeneration).not.toHaveBeenCalled()
  })
})

describe('CAD focus refresh admission', () => {
  it.each(['storage', 'authority'])('keeps a generation %s admission failure closed until a successful fresh read', async failure => {
    const f = await make(), action = vi.fn(async () => {})
    if (failure === 'storage') f.db.get.mockRejectedValueOnce(new Error('storage unavailable'))
    else vi.mocked(f.client.recoveryOwner).mockRejectedValueOnce(new WeldingPlanError('authority unavailable', 503))
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled(); expect(f.generation.state.storageBlocked).toBe(true)
    expect(f.session.state.commandPending).toBe(true); expect(f.session.canEdit.value).toBe(false)
    expect(f.db.clear).not.toHaveBeenCalled()
    await f.session.withTargetMutation(action)
    expect(action).toHaveBeenCalledOnce(); expect(f.generation.state.storageBlocked).toBe(false)
    expect(f.session.state.commandPending).toBe(false); expect(f.session.canEdit.value).toBe(true)
  })
  it('does not turn an admitted CAD error into an unknown generation request', async () => {
    const f = await make()
    await expect(f.session.withTargetMutation(async () => { throw new Error('CAD module unavailable') })).rejects.toThrow('CAD module unavailable')
    expect(f.getOriginal()).toBeNull(); expect(f.generation.state.storageBlocked).toBe(false)
    expect(f.session.state.commandPending).toBe(false); expect(f.session.canEdit.value).toBe(true)
  })

  it('keeps the initiating click enabled while a clean focus read is held', async () => {
    const f = await make(), held = deferred<GenerationPending | null>()
    vi.mocked(f.db.get).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    expect(f.session.canEdit.value).toBe(true)
    let left = false
    const leaving = f.session.prepareLeave().then(value => { left = true; return value })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(left).toBe(false)
    held.resolve(null); expect(await leaving).toBe(true)
    const action = vi.fn(async () => {})
    await f.session.withTargetMutation(action); expect(action).toHaveBeenCalledOnce()
  })
  it.each(['leave', 'new', 'open'])('waits for a hidden original before %s and preserves its exact body', async target => {
    const f = await make(), held = deferred<GenerationPending | null>()
    const original: GenerationPending = { schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'create', owner: clone(owner), plan_id: 'plan', item_version_id: 'v1', basis: null, body: { request_id: 'external-request', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), purpose: 'review', template_id: template.id, template_version: template.version, template_digest: template.digest, template_options: clone(template.default_options) } }
    f.setOriginal(original); vi.mocked(f.db.get).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    expect(f.session.canEdit.value).toBe(true)
    let done = false
    const moving = (target === 'leave' ? f.session.prepareLeave() : target === 'new' ? f.session.newDraft() : f.session.open('other', 'v2')).then(value => { done = true; return value })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(done).toBe(false)
    held.resolve(clone(original)); const result = await moving
    if (target === 'leave') expect(result).toBe(false)
    expect(f.session.state.planId).toBe('plan'); expect(f.session.state.versionId).toBe('v1')
    expect(f.getOriginal()).toEqual(original); expect(f.session.canEdit.value).toBe(false)
    const action = vi.fn(async () => {})
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled(); expect(f.getOriginal()).toEqual(original)
  })
  it('does not admit a mutation while another page has an undiscovered original', async () => {
    const f = await make(), held = deferred<GenerationPending | null>()
    const original: GenerationPending = { schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'create', owner: clone(owner), plan_id: 'plan', item_version_id: 'v1', basis: null, body: { request_id: 'external-request', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), purpose: 'review', template_id: template.id, template_version: template.version, template_digest: template.digest, template_options: clone(template.default_options) } }
    f.setOriginal(original); vi.mocked(f.db.get).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(vi.mocked(f.db.get).mock.results.at(-1)?.value).toBe(held.promise))
    const action = vi.fn(async () => {})
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled(); expect(f.getOriginal()).toEqual(original)
    held.resolve(clone(original))
    await vi.waitFor(() => expect(f.session.canEdit.value).toBe(false))
  })
  it('blocks leave and mutation on a focus storage error', async () => {
    const f = await make()
    vi.mocked(f.db.get).mockRejectedValue(new Error('focus storage unavailable'))
    window.dispatchEvent(new Event('focus'))
    expect(await f.session.prepareLeave()).toBe(false)
    expect(f.session.canEdit.value).toBe(false)
    const action = vi.fn(async () => {})
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled()
  })
  it('discards a held focus read after an authentication epoch change', async () => {
    const f = await make(), held = deferred<GenerationPending | null>()
    vi.mocked(f.db.get).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    const leaving = f.session.prepareLeave()
    localStorage.setItem('auth_token', 'native-B'); window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    held.resolve(null); expect(await leaving).toBe(false)
    expect(f.session.state.owner).toBeNull(); expect(f.session.state.planId).toBe('')
    expect(f.session.canEdit.value).toBe(false)
  })
})
