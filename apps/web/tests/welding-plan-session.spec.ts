import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { WeldingPlanError, type WeldingPlanClient, type RecoveryAuthority, type PlanRecord, type WorkflowState } from '../src/services/welding/planClient'
import { clone, equal, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const payload = () => ({ schema_version: 1 as const, bom: null, process_refs: [], product: { item_id: 'part', version_id: 'p1' }, drawing: { item_id: 'drawing', version_id: 'd1', file_id: 'f1', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }, welds: [{ weld_id: 'w1', display_no: '1', location: 'old', passes: [], joint_type: '', method: '', material_a: '', material_b: '', filler: '', thickness_a: null, thickness_b: null, manufacturing_length: null, measured_length: null, welding_requirements: '', inspection_requirements: '' }],
  overlay: { schema: 'vemcad-weld-overlay/3', opaque: { retain: true } }, assembly_source: { representation_id: 'original' } })
const plan = (): PlanRecord => ({ plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', draft_seq: 1, content_hash: 'a'.repeat(64), payload: payload(), sources: { baseline: 'original', actor: 19 } })
function fixture() {
  let stored: PlanRecoveryRecord | null = null, counter = 0
  const db: PlanRecoveryStore = {
    list: vi.fn(async value => stored && equal(stored.owner, value) ? [clone(stored)] : []),
    get: vi.fn(async (value, id) => stored && equal(stored.owner, value) && stored.recovery_id === id ? clone(stored) : null),
    claim: vi.fn(async record => { if (stored) return equal(stored, record); stored = clone(record); return true }),
    compareReplace: vi.fn(async (expected, next) => { if (!equal(stored, expected)) return false; stored = clone(next); return true }),
    close: vi.fn(),
  }
  const client = {
    recoveryOwner: vi.fn(async () => clone(owner)),
    list: vi.fn(async () => ({ items: [plan()], total: 1, offset: 0, limit: 50 })),
    read: vi.fn(async () => plan()),
    recover: vi.fn(async (_purpose, record: PlanRecoveryRecord): Promise<RecoveryAuthority> => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(record.owner), record_id: record.recovery_id, current: record.draft.version_id === null ? null : plan(), can_write: true, conflict: false })),
    save: vi.fn(async (record: PlanRecoveryRecord): Promise<PlanRecord> => ({ ...plan(), plan_id: record.draft.plan_id, item_version_id: record.draft.version_id ?? 'allocated', draft_seq: record.draft.base_draft_seq + 1, content_hash: 'b'.repeat(64), save_id: record.pending!.body.save_id, payload: clone(record.pending!.body.payload) as PlanRecord['payload'] })),
    productCandidates: vi.fn(async () => []), drawingCandidates: vi.fn(async () => []),
    productContext: vi.fn(async product => ({ ...product, name: 'Part', number: 'P1', version_label: 'A' })), bomCandidates: vi.fn(async () => []), authority: vi.fn(async () => owner),
  } as unknown as WeldingPlanClient
  let writable = true
  const session = useWeldingPlanSession({ client, openStore: async () => db, writable: () => writable, uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` })
  session.setWorkflowAdmission(async (scope, _mode, _target, action) => action(scope)); session.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope))
  return { session, client, db, getStored: () => clone(stored), setStored: (value: PlanRecoveryRecord | null) => { stored = clone(value) }, setWritable: (value: boolean) => { writable = value } }
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve() }
describe('welding plan save and recovery session', () => {
  const sessions: Array<ReturnType<typeof fixture>['session']> = []
  function make() { const f = fixture(); sessions.push(f.session); return f }
  beforeEach(() => localStorage.setItem('auth_token', 'native-A'))
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.restoreAllMocks() })
  async function opened(f: ReturnType<typeof fixture>) { await f.session.initialize(); await f.session.open('plan', 'v1') }
  it('ordinary save retains CAD context without implicitly opting into geometry measurement', async () => {
    const f = make(); await opened(f); f.session.state.overlayContextId = 'cad-context'
    await f.session.edit(next => { next.welds[0].location = 'ordinary parameter edit' })
    await f.session.save()
    expect(f.client.save).toHaveBeenCalledOnce()
    const original = vi.mocked(f.client.save).mock.calls[0][0]
    expect(original.pending!.body.overlay_context_id).toBe('cad-context')
    expect(original.pending!.body).not.toHaveProperty('measure_geometry')
  })
  it.each([false, true])('explicit measurement saves the fixed point with dirty=%s', async dirty => {
    const f = make(); await opened(f); f.session.state.overlayContextId = 'cad-context'
    if (dirty) await f.session.edit(next => { next.welds[0].location = 'explicit parameter edit' })
    const before = clone(f.session.state.payload)
    await f.session.save(true)
    expect(f.client.save).toHaveBeenCalledOnce()
    expect(vi.mocked(f.client.save).mock.calls[0][0].pending!.body).toMatchObject({ measure_geometry: true, overlay_context_id: 'cad-context', expected_draft_seq: 1, payload: before })
    expect(f.session.state.pending).toBeNull(); expect(f.session.state.draftSeq).toBe(2)
  })
  it.each(['context', 'overlay', 'version', 'writable', 'storage', 'pending', 'uncertain'])('does not send explicit measurement without %s admission', async gate => {
    const f = make(); await opened(f); f.session.state.overlayContextId = 'cad-context'
    await f.session.edit(next => { next.welds[0].location = 'retain dirty' })
    if (gate === 'context') f.session.state.overlayContextId = ''
    if (gate === 'overlay') delete f.session.state.payload.overlay
    if (gate === 'version') f.session.state.versionId = null
    if (gate === 'writable') f.setWritable(false)
    if (gate === 'storage') f.session.state.storageBlocked = true
    if (gate === 'uncertain') f.session.state.uncertain = true
    if (gate === 'pending') f.session.state.pending = { method: 'PUT', path: '/plan/versions/v1/draft', body: { save_id: 'retained' }, local_ahead: false }
    const before = clone(f.session.state.payload), pending = clone(f.session.state.pending)
    await f.session.save(true)
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.session.state.payload).toEqual(before)
    expect(f.session.state.pending).toEqual(pending)
  })
  it.each([false, true])('replays the exact UNKNOWN measurement choice %s despite a later opposite save click', async measure => {
    const f = make(); await opened(f); f.session.state.overlayContextId = 'original-context'
    await f.session.edit(next => { next.welds[0].location = 'original edit' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('unknown', 502, 'WELDING_RESULT_UNKNOWN'))
    await f.session.save(measure)
    const original = f.getStored()!; expect(original.pending).not.toBeNull()
    if (measure) expect(original.pending!.body.measure_geometry).toBe(true)
    else expect(original.pending!.body).not.toHaveProperty('measure_geometry')
    f.session.state.overlayContextId = 'later-context'
    await f.session.save(!measure)
    expect(f.client.save).toHaveBeenCalledTimes(1); expect(f.getStored()).toEqual(original)
    await f.session.confirmOriginal()
    expect(f.client.save).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.client.save).mock.calls[1][0].pending).toEqual(original.pending)
  })
  it.each(['context', 'target'])('rejects explicit measurement after the CAD barrier changes %s', async changed => {
    const f = make(); await opened(f); f.session.state.overlayContextId = 'cad-context'
    f.session.setCadBarrier(async () => {
      if (changed === 'context') f.session.state.overlayContextId = ''
      else { f.session.setCadBarrier(null); f.session.resetEntry(); await f.session.open('plan', 'v1'); f.session.state.overlayContextId = 'new-context' }
    })
    await f.session.save(true)
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.session.state.pending).toBeNull()
  })
  it.each(['InReview', 'Approved', 'Released', 'Superseded'])('opens %s read-only without draft recovery update authority', async state => {
    const f = make(), value = { ...plan(), state }
    vi.mocked(f.client.read).mockResolvedValue(value)
    vi.mocked(f.client.recover).mockRejectedValue(new WeldingPlanError('update denied', 404))
    await f.session.open('plan', 'v1')
    expect(f.session.state.savedPoint).toEqual(value); expect(f.session.state.blocked).toBe(true); expect(f.session.canEdit.value).toBe(false)
    await f.session.edit(next => { next.welds[0].location = 'not allowed' }); await f.session.save()
    expect(f.client.recover).not.toHaveBeenCalled(); expect(f.client.save).not.toHaveBeenCalled()
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled(); expect(f.session.state.payload).toEqual(value.payload)
  })
  it.each([403, 404])('opens a readable Draft strictly read-only after edit eligibility returns %s and a fresh GET confirms access', async status => {
    const f = make(), latest = { ...plan(), draft_seq: 2, content_hash: 'b'.repeat(64), payload: { ...payload(), welds: [{ ...payload().welds[0], location: 'latest readonly' }] } }
    vi.mocked(f.client.read).mockResolvedValueOnce(plan()).mockResolvedValueOnce(latest)
    vi.mocked(f.client.recover).mockRejectedValue(new WeldingPlanError('update denied', status))
    await f.session.open('plan', 'v1')
    expect(f.client.read).toHaveBeenCalledTimes(2); expect(f.client.recover).toHaveBeenCalledTimes(1)
    expect(f.session.state.savedPoint).toEqual(latest); expect(f.session.state.payload).toEqual(latest.payload)
    expect(f.session.state.blocked).toBe(true); expect(f.session.canEdit.value).toBe(false)
    await f.session.edit(next => { next.welds[0].location = 'not allowed' }); await f.session.save()
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
    expect(f.session.state.payload).toEqual(latest.payload)
  })
  it.each([0, 401, 409, 500])('does not fall back to a Draft read after edit probe error %s', async status => {
    const f = make(); vi.mocked(f.client.recover).mockRejectedValue(new WeldingPlanError('probe failed', status))
    await f.session.open('plan', 'v1')
    expect(f.client.read).toHaveBeenCalledTimes(1); expect(f.session.state.savedPoint).toBeNull()
    expect(f.session.canEdit.value).toBe(false); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it.each([403, 404])('does not apply the earlier Draft when the confirming GET returns %s', async status => {
    const f = make(); vi.mocked(f.client.read).mockResolvedValueOnce(plan()).mockRejectedValueOnce(new WeldingPlanError('read revoked', status))
    vi.mocked(f.client.recover).mockRejectedValue(new WeldingPlanError('update denied', 404))
    await f.session.open('plan', 'v1')
    expect(f.client.read).toHaveBeenCalledTimes(2); expect(f.session.state.savedPoint).toBeNull(); expect(f.session.canEdit.value).toBe(false)
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
  })
  it.each([{ ...owner, tenant_id: 'other' }, { ...owner, org_id: 'other' }, { ...owner, auth_user_id: 8 }, { ...owner, rbac_user_id: 20 }])('refuses the readonly Draft fallback after fresh owner changes to %j', async changed => {
    const f = make(); vi.mocked(f.client.recover).mockRejectedValue(new WeldingPlanError('update denied', 404))
    vi.mocked(f.client.recoveryOwner).mockResolvedValueOnce(clone(owner)).mockResolvedValueOnce(changed)
    await f.session.open('plan', 'v1')
    expect(f.session.state.savedPoint).toBeNull(); expect(f.session.state.planId).toBe(''); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it.each(['aborted', 'command-pending'])('does not publish the readonly Draft fallback after %s', async changed => {
    const f = make(); vi.mocked(f.client.recover).mockRejectedValue(new WeldingPlanError('update denied', 404))
    vi.mocked(f.client.read).mockResolvedValueOnce(plan()).mockImplementationOnce(async () => {
      if (changed === 'aborted') f.session.dispose()
      else f.session.state.commandPending = true
      return plan()
    })
    await f.session.open('plan', 'v1')
    expect(f.session.state.savedPoint).toBeNull(); expect(f.session.canEdit.value).toBe(false)
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
  })
  it.each([{ ...owner, tenant_id: 'other' }, { ...owner, org_id: 'other' }, { ...owner, auth_user_id: 8 }, { ...owner, rbac_user_id: 20 }])('refuses read-only open when fresh owner changes to %j', async changed => {
    const f = make(); vi.mocked(f.client.read).mockResolvedValue({ ...plan(), state: 'InReview' })
    vi.mocked(f.client.recoveryOwner).mockResolvedValueOnce(clone(owner)).mockResolvedValueOnce(changed)
    await f.session.open('plan', 'v1')
    expect(f.session.state.savedPoint).toBeNull(); expect(f.session.state.planId).toBe(''); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it.each(['read-404', 'owner-401', 'aborted'])('does not apply a read-only body after %s', async failure => {
    const f = make(); vi.mocked(f.client.read).mockImplementation(async () => {
      if (failure === 'read-404') throw new WeldingPlanError('not readable', 404)
      if (failure === 'aborted') f.session.dispose()
      return { ...plan(), state: 'InReview' }
    })
    if (failure === 'owner-401') vi.mocked(f.client.recoveryOwner).mockResolvedValueOnce(clone(owner)).mockRejectedValueOnce(new WeldingPlanError('revoked', 401))
    await f.session.open('plan', 'v1')
    expect(f.session.state.savedPoint).toBeNull(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it.each(['owner', 'abort', 'editSeq', 'dirty', 'pending'])('does not apply workflow body refresh after %s changes', async changed => {
    const f = make(); await opened(f); const original = clone(f.session.state.savedPoint), scope = f.session.capture()
    vi.mocked(f.client.recover).mockClear()
    vi.mocked(f.client.read).mockImplementation(async () => {
      if (changed === 'editSeq') f.session.state.editSeq++
      return { ...plan(), state: 'Approved' }
    })
    if (changed === 'owner') vi.mocked(f.client.authority).mockResolvedValue({ ...owner, rbac_user_id: 20 })
    if (changed === 'abort') f.session.dispose()
    if (changed === 'dirty') f.session.state.dirty = true
    if (changed === 'pending') f.session.state.pending = { method: 'PUT', path: '/plan/versions/v1/draft', body: { expected_draft_seq: 1, save_id: 'original', payload: payload() }, local_ahead: false }
    await expect(f.session.refreshWorkflowBody({ plan_id: 'plan', item_version_id: 'v1' }, scope)).rejects.toThrow()
    expect(f.session.state.savedPoint).toEqual(original); expect(f.client.recover).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
    if (changed === 'pending') expect(f.session.state.pending?.body.save_id).toBe('original')
    if (changed === 'dirty') expect(f.session.state.dirty).toBe(true)
  })
  it.each([
    { state: 'InReview', canWrite: false },
    { state: 'Approved', canWrite: false },
    { state: 'Released', canWrite: false },
    { state: 'Draft', canWrite: true },
    { state: 'Draft', canWrite: false },
  ])('replaces an earlier read error only after authorized workflow body refresh: %j', async ({ state, canWrite }) => {
    const f = make(); await opened(f)
    const value = { ...plan(), state }
    vi.mocked(f.client.read).mockRejectedValueOnce(new WeldingPlanError('焊接请求未确认（502）', 502)).mockResolvedValue(value)
    await f.session.open('plan', 'v1')
    expect(f.session.state.message).toBe('焊接请求未确认（502）')
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: value, can_write: canWrite, conflict: false }))
    await f.session.refreshWorkflowBody({ plan_id: 'plan', item_version_id: 'v1' }, f.session.capture())
    expect(f.session.state.savedPoint).toEqual(value)
    expect(f.session.state.message).toBe(state === 'Draft' && canWrite ? '已读取服务器草稿' : '已读取固定版本；当前仅可查看')
    expect(f.session.canEdit.value).toBe(state === 'Draft' && canWrite)
    expect(f.session.state.pending).toBeNull(); expect(f.client.save).not.toHaveBeenCalled()
    expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
  })
  it.each(['read', 'owner', 'abort'])('keeps the read error when workflow body refresh fails at %s', async failure => {
    const f = make(); await opened(f)
    vi.mocked(f.client.read).mockRejectedValueOnce(new WeldingPlanError('焊接请求未确认（502）', 502))
    await f.session.open('plan', 'v1')
    const previous = clone(f.session.state.savedPoint), scope = f.session.capture()
    vi.mocked(f.client.read).mockImplementation(async () => {
      if (failure === 'read') throw new WeldingPlanError('new read failure', 502)
      if (failure === 'abort') f.session.dispose()
      return { ...plan(), state: 'Approved' }
    })
    if (failure === 'owner') vi.mocked(f.client.authority).mockResolvedValue({ ...owner, rbac_user_id: 20 })
    await expect(f.session.refreshWorkflowBody({ plan_id: 'plan', item_version_id: 'v1' }, scope)).rejects.toThrow()
    expect(f.session.state.message).toBe('焊接请求未确认（502）')
    if (failure !== 'abort') expect(f.session.state.savedPoint).toEqual(previous)
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('saves and reopens the exact diagram reference with existing CAS and undo history', async () => {
    const f = make(); await opened(f); const next = clone(f.session.state.payload)
    next.resource_refs = [{ reference_id: 'diagram-ref', weld_id: 'w1', resource_id: 'joint', version_id: 'joint-v1', expected_content_hash: 'd'.repeat(64), purpose: 'joint_diagram', selected_fields: [] }]
    await f.session.commitPayload(next, f.session.capture()); expect(f.getStored()?.draft.payload).toEqual(next)
    const undo = f.session.historyCandidate('undo'); await f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor); expect(f.session.state.payload.resource_refs).toBeUndefined()
    const redo = f.session.historyCandidate('redo'); await f.session.commitPayload(redo.payload, f.session.capture(), redo.cursor); expect(f.session.state.payload).toEqual(next)
    await f.session.save(); expect(f.session.state.pending).toBeNull(); expect(f.session.state.dirty).toBe(false)
    const saved = await vi.mocked(f.client.save).mock.results[0].value
    vi.mocked(f.client.read).mockResolvedValue(saved)
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, original) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: original.recovery_id, current: saved, can_write: true, conflict: false }))
    await f.session.open('plan', 'v1'); expect(f.session.state.payload.resource_refs).toEqual(next.resource_refs)
    expect(f.session.state.payload.welds).toEqual(next.welds)
  })
  it('retains a diagram in UNKNOWN and later 409, then replays the exact original plan request', async () => {
    const f = make(); await opened(f); const next = clone(f.session.state.payload)
    next.resource_refs = [{ reference_id: 'diagram-original', weld_id: 'w1', resource_id: 'joint', version_id: 'joint-old-version', expected_content_hash: 'd'.repeat(64), purpose: 'joint_diagram', selected_fields: [] }]
    await f.session.commitPayload(next, f.session.capture())
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost ACK', 502)).mockRejectedValueOnce(new WeldingPlanError('conflict', 409))
    await f.session.save(); const original = f.getStored(); expect(original?.pending?.body.payload).toEqual(next)
    await f.session.confirmOriginal(); expect(f.getStored()).toEqual(original); expect(f.session.state.uncertain).toBe(true)
    await f.session.confirmOriginal()
    expect(vi.mocked(f.client.save).mock.calls.map(([value]) => value)).toEqual([original, original, original])
    expect(f.session.state.payload.resource_refs).toEqual(next.resource_refs); expect(f.session.state.pending).toBeNull()
  })
  it('F18b rejects malformed cross-plan reuse preparation without applying or persisting target data', async () => {
    const f = make(); await opened(f); const before = clone(f.session.state)
    await expect(f.session.prepareReuseTarget({ action: 'revise' } as any, { action: 'reuse' } as any, f.session.capture())).rejects.toThrow()
    expect(f.session.state).toEqual(before); expect(f.db.claim).not.toHaveBeenCalled()
  })
  const revisionSource = () => ({ schema: 'metasheet.welding_command_pending/1' as const, kind: 'workflow' as const, action: 'revise' as const, owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'revision-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), reason: '原文' } })
  const revisionReceipt = () => ({ schema: 'yuantus.welding_plan_revision_ack/1' as const, request_id: 'revision-original', action: 'revise' as const, plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 1, source_content_hash: 'a'.repeat(64), target_version_id: 'v2', target_version_label: 'B', target_draft_seq: 1 as const, target_content_hash: 'a'.repeat(64), inheritance_id: 'inheritance', inheritance_sha256: 'b'.repeat(64), state: 'Draft' as const })
  it.each(['Draft', 'InReview', 'Approved', 'Released', 'Superseded'])('C3 accepts actual advanced target %s with unchanged initial ACK basis', async state => {
    const f = make(); await opened(f); const target = { ...plan(), item_version_id: 'v2', version_label: 'B', state, draft_seq: 2, content_hash: 'c'.repeat(64) }
    vi.mocked(f.client.read).mockResolvedValue(target); vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: target, can_write: false, conflict: false }))
    const ack = revisionReceipt(), prepared = await f.session.prepareRevisionTarget(ack, revisionSource(), f.session.capture())
    expect(f.session.applyRevisionTarget(prepared)).toMatchObject({ draft_seq: 2, content_hash: 'c'.repeat(64) }); expect(f.session.state.serverState).toBe(state); expect(ack.target_draft_seq).toBe(1); expect(ack.state).toBe('Draft')
  })
  it.each(['identity', 'label', 'initial-hash', 'conflict', 'authority-current', 'owner', 'generation-gate'])('C3 rejects target preparation mismatch %s without state apply', async mismatch => {
    const f = make(); await opened(f); const target = { ...plan(), item_version_id: 'v2', version_label: 'B' }
    if (mismatch === 'identity') target.item_version_id = 'wrong'
    if (mismatch === 'label') target.version_label = 'wrong'
    if (mismatch === 'initial-hash') target.content_hash = 'c'.repeat(64)
    vi.mocked(f.client.read).mockResolvedValue(target); vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: mismatch === 'authority-current' ? { ...target, draft_seq: 2 } : target, can_write: false, conflict: mismatch === 'conflict' }))
    if (mismatch === 'owner') vi.mocked(f.client.authority).mockResolvedValue({ ...owner, rbac_user_id: 999 })
    if (mismatch === 'generation-gate') f.session.setCommandPending(f.session.capture(), true)
    await expect(f.session.prepareRevisionTarget(revisionReceipt(), revisionSource(), f.session.capture())).rejects.toThrow()
    expect(f.session.state.versionId).toBe('v1'); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('C3 prepares an advanced readonly real target without changing selection or persisting a target recovery', async () => {
    const f = make(); await opened(f)
    const ack = { schema: 'yuantus.welding_plan_revision_ack/1' as const, request_id: 'revision-original', action: 'revise' as const, plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 1, source_content_hash: 'a'.repeat(64), target_version_id: 'v2', target_version_label: 'B', target_draft_seq: 1 as const, target_content_hash: 'a'.repeat(64), inheritance_id: 'inheritance', inheritance_sha256: 'b'.repeat(64), state: 'Draft' as const }
    const target = { ...plan(), item_version_id: 'v2', version_label: 'B', draft_seq: 3, content_hash: 'c'.repeat(64), state: 'InReview', payload: { ...payload(), preparation_notes: 'real target' } }
    vi.mocked(f.client.read).mockResolvedValue(target); vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: target, can_write: false, conflict: false }))
    f.session.setWorkflowPending(f.session.capture(), true)
    const prepared = await f.session.prepareRevisionTarget(ack, { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'revision-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), reason: '原文' } }, f.session.capture())
    expect(f.session.state.versionId).toBe('v1'); expect(f.db.claim).not.toHaveBeenCalled()
    expect(f.session.applyRevisionTarget(prepared)).toMatchObject({ plan_id: 'plan', item_version_id: 'v2', draft_seq: 3, content_hash: 'c'.repeat(64) })
    expect(f.session.state.payload.preparation_notes).toBe('real target'); expect(f.session.state.blocked).toBe(true); expect(f.session.state.commandPending).toBe(false)
  })
  it('C3 prepare errors and revoked source scope leave the original selection untouched', async () => {
    const f = make(); await opened(f)
    const ack = { schema: 'yuantus.welding_plan_revision_ack/1', request_id: 'revision-original', action: 'revise', plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 1, source_content_hash: 'a'.repeat(64), target_version_id: 'v2', target_version_label: 'B', target_draft_seq: 1, target_content_hash: 'a'.repeat(64), inheritance_id: 'inheritance', inheritance_sha256: 'b'.repeat(64), state: 'Draft' } as any
    vi.mocked(f.client.read).mockRejectedValue(new Error('target denied'))
    await expect(f.session.prepareRevisionTarget(ack, { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'revision-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), reason: '原文' } }, f.session.capture())).rejects.toThrow('target denied')
    expect(f.session.state.versionId).toBe('v1'); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('separate pending writers take OR and an old generation false cannot clear workflow', async () => {
    const f = make(); await opened(f); const scope = f.session.capture()
    f.session.setWorkflowPending(scope, true); f.session.setCommandPending(scope, false)
    expect(f.session.state.commandPending).toBe(true); expect(f.session.canEdit.value).toBe(false)
    f.session.setCommandPending(scope, true); f.session.setWorkflowPending(scope, false)
    expect(f.session.state.commandPending).toBe(true)
    f.session.setCommandPending(scope, false); expect(f.session.canEdit.value).toBe(true)
  })
  it('missing workflow admission stays closed even with the generation gate registered', async () => {
    const f = make(); const session = useWeldingPlanSession({ client: f.client, openStore: async () => f.db, writable: () => true }); sessions.push(session)
    session.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope)); await session.open('plan', 'v1')
    expect(session.canEdit.value).toBe(false)
    const action = vi.fn(async () => 'forbidden'); expect(() => session.withTargetMutation(action)).toThrow('评审请求'); expect(action).not.toHaveBeenCalled()
  })
  const workflowPoint = (): WorkflowState => ({ schema: 'yuantus.welding_review_state/1', plan_id: 'plan', item_version_id: 'v1', state: 'Draft', draft_seq: 1, content_hash: 'a'.repeat(64), is_current: true, approval: null, final_generation: null, publication: null, final_profile: null, allowed_actions: [], issues: [] })
  it.each([true, false])('workflow busy cleanup releases its own command after external revocation, attached=%s', async attached => {
    const f = make(); if (attached) await opened(f)
    let active = true, release!: () => void
    const controller = new AbortController(), held = new Promise<void>(resolve => { release = resolve })
    const job = f.session.withWorkflowPoint(workflowPoint(), false, { signal: controller.signal, accepts: () => active }, async scope => {
      await held; expect(scope.accepts()).toBe(false); throw new Error('external revoked')
    })
    await settle(); expect(f.session.state.commandBusy).toBe(true)
    active = false; controller.abort(); release(); await expect(job).rejects.toThrow('external revoked')
    expect(f.session.state.commandBusy).toBe(false); expect(await f.session.prepareLeave()).toBe(true)
    const reads = vi.mocked(f.client.list).mock.calls.length; await f.session.initialize()
    expect(f.client.list).toHaveBeenCalledTimes(reads + 1); expect(f.client.save).not.toHaveBeenCalled(); expect(f.getStored()).toBeNull()
  })
  it.each([true, false])('workflow busy cleanup after reset cannot release a newer command, attached=%s', async attached => {
    const f = make(); if (attached) await opened(f)
    let oldActive = true, releaseOld!: () => void, releaseNew!: () => void
    const oldHeld = new Promise<void>(resolve => { releaseOld = resolve }), newHeld = new Promise<void>(resolve => { releaseNew = resolve })
    const external = () => ({ signal: new AbortController().signal, accepts: () => true })
    const oldJob = f.session.withWorkflowPoint(workflowPoint(), false, { signal: new AbortController().signal, accepts: () => oldActive }, async scope => {
      await oldHeld; expect(scope.accepts()).toBe(false); throw new Error('old scope')
    })
    await settle(); expect(f.session.state.commandBusy).toBe(true)
    f.session.resetEntry(); oldActive = false; expect(f.session.state.commandBusy).toBe(false)
    const newJob = f.session.withWorkflowPoint(workflowPoint(), false, external(), async scope => {
      await newHeld; expect(scope.accepts()).toBe(true); return 'new command'
    })
    await settle(); expect(f.session.state.commandBusy).toBe(true)
    releaseOld(); await expect(oldJob).rejects.toThrow('old scope')
    expect(f.session.state.commandBusy).toBe(true); expect(await f.session.prepareLeave()).toBe(false)
    releaseNew(); await expect(newJob).resolves.toBe('new command')
    expect(f.session.state.commandBusy).toBe(false); expect(f.client.save).not.toHaveBeenCalled(); expect(f.getStored()).toBeNull()
  })
  it('opens a saved point, releases the barrier and preserves opaque fields on save', async () => {
    const f = make(); await opened(f)
    expect(f.session.state.busy).toBe(false)
    await f.session.edit(value => { value.welds[0].location = 'changed' })
    await f.session.save()
    expect(f.client.save).toHaveBeenCalledTimes(1)
    expect(f.session.state.contentHash).toBe('b'.repeat(64))
    expect(f.session.state.payload).toMatchObject({ overlay: { opaque: { retain: true } }, assembly_source: { representation_id: 'original' } })
    expect(f.getStored()).toBeNull()
  })
  it('uses only an actual server read or save ACK as the generation saved point', async () => {
    const f = make(); await opened(f); expect(f.session.state.savedPoint).toEqual(plan())
    await f.session.edit(value => { value.welds[0].location = 'local' }); await settle()
    expect(f.session.state.savedPoint?.payload.welds[0].location).toBe('old')
    await expect(f.session.withSavedPoint(async () => 'wrong')).rejects.toThrow()
    await f.session.save(); expect(f.session.state.savedPoint).toMatchObject({ draft_seq: 2, content_hash: 'b'.repeat(64), payload: { welds: [{ location: 'local' }] } })
  })
  it('generation original gate blocks edit/save/leave without changing plan recovery records', async () => {
    const f = make(); await opened(f); const before = f.getStored()
    f.session.setCommandPending(f.session.capture(), true)
    expect(f.session.canEdit.value).toBe(false); await f.session.edit(value => { value.welds[0].location = 'forbidden' }); await f.session.save()
    expect(await f.session.prepareLeave()).toBe(false); expect(f.client.save).not.toHaveBeenCalled(); expect(f.getStored()).toEqual(before)
    expect(f.session.state.payload.welds[0].location).toBe('old')
  })
  it('does not dispatch before durable checkpoint finishes', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'changed' }); await settle()
    let commit!: (value: boolean) => void
    vi.mocked(f.db.compareReplace).mockImplementationOnce((_old, next) => new Promise(resolve => { commit = value => { f.setStored(next); resolve(value) } }))
    const job = f.session.save(); await settle()
    expect(f.client.save).not.toHaveBeenCalled()
    commit(true); await job
    expect(f.client.save).toHaveBeenCalledTimes(1)
  })
  it('storage failure retains memory and same original save ID; explicit retry can later persist it', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'changed' }); await settle()
    vi.mocked(f.db.compareReplace).mockRejectedValueOnce(new Error('quota exceeded'))
    await f.session.save()
    expect(f.client.save).not.toHaveBeenCalled()
    expect(f.session.state.payload.welds[0].location).toBe('changed')
    expect(f.session.state.message).toContain('未发送')
    const saveId = f.session.state.pending?.body.save_id
    await f.session.confirmOriginal()
    expect(f.client.save).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.client.save).mock.calls[0][0].pending!.body.save_id).toBe(saveId)
  })
  it('keeps UNKNOWN through a later 4xx and resends only the identical original body', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'changed' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost ACK', 502, 'WELDING_RESULT_UNKNOWN'))
      .mockRejectedValueOnce(new WeldingPlanError('conflict', 409))
    await f.session.save()
    const original = f.getStored()
    expect(f.session.state.uncertain).toBe(true)
    await f.session.confirmOriginal()
    expect(f.getStored()).toEqual(original)
    expect(vi.mocked(f.client.save).mock.calls[1][0]).toEqual(vi.mocked(f.client.save).mock.calls[0][0])
  })
  it.each([401, 403, 404, 410])('hides revoked content for %s and retains durable original pending', async status => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'changed' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('revoked', status))
    await f.session.save()
    expect(f.session.state.planId).toBe('')
    expect(f.session.state.owner).toBeNull()
    expect(f.getStored()?.pending?.body.save_id).toBeTruthy()
  })
  it('same-token A-B-A principal resets refuse an in-flight ACK and cannot clear its record', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'changed' })
    let finish!: (value: PlanRecord) => void
    vi.mocked(f.client.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saving = f.session.save(); await settle()
    const original = f.getStored()!
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-B')
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-A')
    finish({ ...plan(), draft_seq: 2, content_hash: 'b'.repeat(64), save_id: original.pending!.body.save_id, payload: clone(original.pending!.body.payload) as PlanRecord['payload'] }); await saving
    expect(f.session.state.planId).toBe('')
    expect(f.getStored()).toEqual(original)
  })
  it('cross-tab storage event clears the display even when final token text is unchanged', async () => {
    const f = make(); await opened(f)
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    expect(f.session.state.planId).toBe('')
    expect(f.session.state.plans).toEqual([])
  })
  it('same four-field owner with a new sid/session may fresh restore and confirm the original request', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'changed' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0))
    await f.session.save(); const original = f.getStored()!
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'same-owner-new-sid')
    await f.session.initialize(); await f.session.refreshRecoveries()
    expect(f.session.state.recoveries).toEqual([original])
    await f.session.previewRecovery(original); await f.session.restoreRecovery(); expect(f.session.state.savedPoint).toBeNull()
    expect(f.session.state.pending!.body).toEqual(original.pending!.body)
    await f.session.confirmOriginal()
    expect(f.getStored()).toBeNull()
  })
  it('a different owner never exposes or dispatches the previous owner record', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'changed' }); await settle()
    const original = f.getStored()!
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'other-owner')
    vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, auth_user_id: 8 })
    await f.session.initialize(); await f.session.refreshRecoveries()
    expect(f.session.state.recoveries).toEqual([])
    await f.session.previewRecovery(original)
    expect(f.session.state.preview).toBeNull()
    expect(f.client.save).not.toHaveBeenCalled()
  })
  it('readonly/conflict restore cannot create a new save', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'local' }); await settle(); const original = f.getStored()!
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, value) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: value.recovery_id, current: plan(), can_write: false, conflict: true }))
    await f.session.previewRecovery(original)
    vi.spyOn(Date, 'now').mockReturnValue(original.updated_at + 1000)
    await f.session.restoreRecovery(); await f.session.save()
    expect(f.session.canEdit.value).toBe(false)
    expect(f.client.save).not.toHaveBeenCalled()
  })
  it('preserves local_ahead after confirming only the older pending payload', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'submitted' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0))
    await f.session.save(); const original = f.getStored()!
    original.pending!.local_ahead = true; original.draft.payload.welds[0].location = 'later-edit'; f.setStored(original)
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'new-sid')
    await f.session.initialize(); await f.session.previewRecovery(original); await f.session.restoreRecovery(); expect(f.session.state.savedPoint).toBeNull()
    await f.session.confirmOriginal()
    expect(f.getStored()?.draft.payload.welds[0].location).toBe('later-edit')
    expect(f.getStored()?.pending).toBeNull()
    expect(f.session.state.blocked).toBe(true)
  })
  it('another tab replacing the durable record prevents stale ACK cleanup', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'submitted' })
    let finish!: (value: PlanRecord) => void
    vi.mocked(f.client.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saving = f.session.save(); await settle()
    const original = f.getStored()!, winner = clone(original); winner.updated_at++; winner.draft.payload.welds[0].location = 'other-tab'; f.setStored(winner)
    finish({ ...plan(), draft_seq: 2, content_hash: 'b'.repeat(64), save_id: original.pending!.body.save_id, payload: clone(original.pending!.body.payload) as PlanRecord['payload'] }); await saving
    expect(f.getStored()).toEqual(winner)
    expect(f.session.state.pending).not.toBeNull()
  })
  it('write OFF and frozen domain states disable new edits and saving', async () => {
    const f = make(); await opened(f); f.setWritable(false)
    await f.session.edit(value => { value.welds[0].location = 'forbidden' }); await f.session.save()
    expect(f.session.state.payload.welds[0].location).toBe('old')
    expect(f.client.save).not.toHaveBeenCalled()
  })
  it('owner changes during a list response clear that response and the previous display', async () => {
    const f = make()
    vi.mocked(f.client.recoveryOwner).mockResolvedValueOnce(owner).mockResolvedValueOnce({ ...owner, rbac_user_id: 20 })
    await f.session.initialize()
    expect(f.session.state.owner).toBeNull()
    expect(f.session.state.plans).toEqual([])
  })
  it('recovery list rechecks four-field owner after the storage await while preserving original history', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'private-A' }); await settle()
    const original = f.getStored()!
    await f.session.refreshRecoveries()
    expect(f.session.state.recoveries).toEqual([original])
    vi.mocked(f.db.list).mockImplementationOnce(async () => {
      vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 })
      return [clone(original)]
    })
    await f.session.refreshRecoveries()
    expect(f.session.state.recoveries).toEqual([])
    expect(f.session.state.owner).toBeNull()
    expect(f.getStored()).toEqual(original)
    expect(localStorage.getItem('auth_token')).toBe('native-A')
  })
  it('recovery preview rechecks four-field owner after authority await while preserving original history', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'private-A' }); await settle()
    const original = f.getStored()!
    await f.session.previewRecovery(original)
    expect(f.session.state.preview?.record).toEqual(original)
    vi.mocked(f.client.recover).mockImplementationOnce(async (_purpose, record) => {
      vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 })
      return { schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(record.owner), record_id: record.recovery_id, current: plan(), can_write: true, conflict: false }
    })
    await f.session.previewRecovery(original)
    expect(f.session.state.preview).toBeNull()
    expect(f.session.state.owner).toBeNull()
    expect(f.getStored()).toEqual(original)
    expect(localStorage.getItem('auth_token')).toBe('native-A')
  })
  it('navigation must finish a durable dirty checkpoint; a storage failure keeps the current editor', async () => {
    const f = make(); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'preserve-before-leave' }); await settle()
    vi.mocked(f.db.compareReplace).mockRejectedValueOnce(new Error('quota'))
    expect(await f.session.prepareLeave()).toBe(false)
    expect(f.session.state.payload.welds[0].location).toBe('preserve-before-leave')
    expect(await f.session.prepareLeave()).toBe(true)
    const original = f.getStored()!
    f.session.resetEntry()
    expect(f.session.state.planId).toBe('')
    expect(original.draft.payload.welds[0].location).toBe('preserve-before-leave')
  })
  it('publishes a complete atomic edit only after storage and preserves unknown content in undo/redo', async () => {
    const f = make(); await opened(f); const next = clone(f.session.state.payload); next.welds[0].method = 'atomic'; next.resource_refs = [{ reference_id: 'r', selected_fields: ['method'] }]
    let finish!: () => void
    vi.mocked(f.db.claim).mockImplementationOnce(record => new Promise(resolve => { finish = () => { f.setStored(record); resolve(true) } }))
    const committing = f.session.commitPayload(next, f.session.capture()); await settle()
    expect(f.session.state.payload.welds[0].method).toBe(''); expect(f.session.canEdit.value).toBe(false); expect(await f.session.prepareLeave()).toBe(false)
    finish(); await committing; expect(f.session.state.payload).toEqual(next); expect(f.session.canEdit.value).toBe(true)
    const undo = f.session.historyCandidate('undo'); await f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)
    expect(f.session.state.payload.welds[0].method).toBe(''); expect(f.session.state.payload.assembly_source).toEqual({ representation_id: 'original' })
    const redo = f.session.historyCandidate('redo'); await f.session.commitPayload(redo.payload, f.session.capture(), redo.cursor); expect(f.session.state.payload).toEqual(next)
  })
  it('does not publish or ACK an atomic edit on quota or owner change after persistence', async () => {
    const f = make(); await opened(f); const before = clone(f.session.state.payload), next = clone(before); next.welds[0].location = 'atomic'
    vi.mocked(f.db.claim).mockRejectedValueOnce(new Error('quota')); await expect(f.session.commitPayload(next)).rejects.toThrow('quota'); expect(f.session.state.payload).toEqual(before)
    vi.mocked(f.db.claim).mockImplementationOnce(async record => { f.setStored(record); vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 }); return true })
    await expect(f.session.commitPayload(next)).rejects.toThrow(); expect(f.session.state.owner).toBeNull(); expect(f.getStored()?.draft.payload).toEqual(next)
  })
  it('blocks save, plan switching and leave until an explicit CAD intent settles', async () => {
    const f = make(); await opened(f); await f.session.edit(p => { p.welds[0].location = 'edited' }); await settle()
    const barrier = vi.fn(async () => { throw new Error('CAD intent unfinished') }); f.session.setCadBarrier(barrier)
    await f.session.save(); expect(f.client.save).not.toHaveBeenCalled(); expect(await f.session.prepareLeave()).toBe(false)
    await f.session.newDraft(); expect(f.session.state.versionId).toBe('v1'); expect(f.session.state.payload.welds[0].location).toBe('edited')
    f.session.setCadBarrier(null); await f.session.save(); expect(f.client.save).toHaveBeenCalledOnce()
  })
  it('preserves history on subsequent represented saves and UNKNOWN', async () => {
    const f = make(); await opened(f); await f.session.edit(p => { p.welds[0].location = 'first' }); await f.session.save()
    expect(f.session.state.historyLength).toBe(1); await f.session.edit(p => { p.welds[0].location = 'second' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    expect(f.session.state.historyLength).toBe(2); expect(await f.session.prepareLeave()).toBe(false)
  })

  it('explicit local retry clears a failed edit checkpoint without sending a business save', async () => {
    const f = make(); await opened(f); vi.mocked(f.db.claim).mockRejectedValueOnce(new Error('quota'))
    await f.session.edit(p => { p.welds[0].location = 'memory' }); await settle(); expect(f.session.state.storageBlocked).toBe(true)
    await f.session.retryLocal(); expect(f.session.state.storageBlocked).toBe(false); expect(f.getStored()?.draft.payload.welds[0].location).toBe('memory'); expect(f.client.save).not.toHaveBeenCalled()
  })
  it('trims the old-protocol history only after the first exact represented save acknowledgement', async () => {
    const f = make(); const old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'; vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { p.welds[0].location = 'legacy' }); await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' }); expect(f.session.state.historyLength).toBe(2)
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('unknown', 0)); await f.session.save(); expect(f.session.state.historyLength).toBe(2)
    await f.session.confirmOriginal(); expect(f.session.state.historyLength).toBe(0)
    await f.session.edit(p => { p.welds[0].location = 'after' }); await f.session.save(); expect(f.session.state.historyLength).toBe(1)
  })

  it('allows only retained history while the first represented save is UNKNOWN', async () => {
    const f = make(), old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    const upgraded = clone(f.session.state.payload)
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const pending = clone(f.getStored()!.pending!)
    const undo = f.session.historyCandidate('undo')
    await expect(f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)).resolves.toBeDefined()
    expect(f.session.state.payload).toEqual(old.payload); expect(f.getStored()!.pending).toEqual({ ...pending, local_ahead: true })
    expect(f.session.state.historyLength).toBe(1); expect(f.session.canEdit.value).toBe(false)
    const redo = f.session.historyCandidate('redo'); await f.session.commitPayload(redo.payload, f.session.capture(), redo.cursor)
    expect(f.session.state.payload).toEqual(upgraded); expect(f.getStored()!.pending).toEqual(pending)
    await f.session.confirmOriginal(); expect(f.session.state.historyLength).toBe(0)
    expect(f.session.state.message).toContain('已建立多表示保存边界')
    expect(vi.mocked(f.client.save).mock.calls[1][0].pending!.body).toEqual(pending.body)
  })
  it.each(['save', 'replay'] as const)('announces the first represented boundary after exact %s ACK only', async route => {
    const f = make(), old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    if (route === 'replay') vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('unknown', 0))
    await f.session.save()
    if (route === 'replay') { expect(f.session.state.message).not.toContain('已建立多表示保存边界'); await f.session.confirmOriginal() }
    expect(f.session.state.message).toContain('已建立多表示保存边界')
  })

  it.each(['current', 'recovery-list'] as const)('keeps an undone local legacy copy read-only after exact ACK through %s and cold restore', async route => {
    const f = make(), old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const pending = clone(f.session.state.pending!), undo = f.session.historyCandidate('undo')
    await f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)
    if (route === 'current') await f.session.confirmOriginal()
    else await f.session.confirmRecoveryOriginal(f.getStored()!)
    const ack = await vi.mocked(f.client.save).mock.results[1].value, retained = f.getStored()!
    expect(vi.mocked(f.client.save).mock.calls[1][0].pending).toEqual({ ...pending, local_ahead: true })
    expect(retained.pending).toBeNull(); expect(retained.draft.payload).toEqual(old.payload)
    expect(retained.draft.base_draft_seq).toBe(ack.draft_seq); expect(retained.draft.base_content_hash).toBe(ack.content_hash)
    expect(f.session.state.payload).toEqual(old.payload); expect(f.session.state.savedPoint).toEqual(ack)
    expect(f.session.state.historyLength).toBe(0); expect(f.session.state.pending).toBeNull()
    expect(f.session.canEdit.value).toBe(false); expect(f.session.canHistory.value).toBe(false)
    expect(f.session.state.message).toContain('已建立多表示保存边界')
    f.session.resetEntry()
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: ack, can_write: true, conflict: false }))
    await f.session.initialize(); await f.session.previewRecovery(retained); await f.session.restoreRecovery()
    expect(f.session.state.payload).toEqual(old.payload); expect(f.session.canEdit.value).toBe(false)
    expect(f.session.state.message).toContain('旧格式本地副本仅供查看')
    await f.session.edit(p => { p.welds[0].location = 'forbidden downgrade' }); await f.session.save()
    expect(f.session.state.payload).toEqual(old.payload); expect(f.client.save).toHaveBeenCalledTimes(2)
  })
  it('keeps the upgrade basis and pending undo after cold restore of an edited legacy draft', async () => {
    const f = make(), old = plan(); (old.payload.overlay as any) = { schema: 'vemcad-weld-overlay/2', bindings: [{ weld_id: 'w1', entity_ids: [1] }] }
    vi.mocked(f.client.read).mockResolvedValue(old)
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: old, can_write: true, conflict: false }))
    await opened(f); await f.session.edit(p => { (p.overlay as any).bindings = [] })
    const retained = f.getStored()!; f.session.resetEntry(); await f.session.initialize()
    await f.session.previewRecovery(retained); await f.session.restoreRecovery()
    expect(f.session.state.savedPoint).toBeNull(); expect(f.session.upgradeReviewBasis()).toEqual(old.payload)
    const review = f.session.upgradeReviewBasis()!; review.welds[0].display_no = 'cannot alter save basis'
    expect(f.session.upgradeReviewBasis()).toEqual(old.payload)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    expect(f.session.canHistory.value).toBe(true)
    const undo = f.session.historyCandidate('undo'); await f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)
    expect(f.session.state.payload).toEqual(retained.draft.payload); expect(f.getStored()!.pending!.local_ahead).toBe(true)
  })
  it('marks an attached recovery-list replay UNKNOWN even if dispatch was previously refused', async () => {
    const f = make(), old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    vi.mocked(f.client.recoveryOwner).mockResolvedValueOnce(owner).mockRejectedValueOnce(new WeldingPlanError('temporary authority failure', 0))
    await f.session.save()
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.session.state.pending).not.toBeNull(); expect(f.session.state.uncertain).toBe(false)
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0))
    await f.session.confirmRecoveryOriginal(f.getStored()!)
    expect(f.session.state.uncertain).toBe(true); expect(f.session.canHistory.value).toBe(true)
    const undo = f.session.historyCandidate('undo'); await f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)
    expect(f.session.state.payload).toEqual(old.payload)
  })
  it('does not mistake a recovered unsaved upgrade for an already acknowledged boundary', async () => {
    const f = make(), old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old)
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: old, can_write: true, conflict: false }))
    await opened(f); await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    const retained = f.getStored()!; f.session.resetEntry(); await f.session.initialize()
    await f.session.previewRecovery(retained); await f.session.restoreRecovery()
    await f.session.edit(p => { p.welds[0].location = 'after cold unsaved upgrade' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    expect(f.session.canHistory.value).toBe(true); expect(f.session.state.historyLength).toBe(1)
    await f.session.confirmOriginal(); expect(f.session.state.historyLength).toBe(0)
    expect(f.session.state.message).toContain('已建立多表示保存边界')
  })
  it('redo compares sparse clearing fields by the same rules as the original submitted payload', async () => {
    const f = make(), old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { p.welds[0].group_name = 'saved group'; p.preparation_notes = 'saved note' }); await f.session.save()
    const beforeUpgrade = f.session.historyCandidate('undo'); await f.session.commitPayload(beforeUpgrade.payload, f.session.capture(), beforeUpgrade.cursor)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    expect(f.session.state.payload.welds[0]).not.toHaveProperty('group_name')
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const pending = clone(f.session.state.pending!)
    expect((pending.body.payload as any).welds[0].group_name).toBe(''); expect((pending.body.payload as any).preparation_notes).toBe('')
    const undo = f.session.historyCandidate('undo'); await f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)
    expect(f.session.state.pending!.local_ahead).toBe(true)
    const redo = f.session.historyCandidate('redo'); await f.session.commitPayload(redo.payload, f.session.capture(), redo.cursor)
    expect(f.session.state.pending).toEqual(pending); expect(f.session.state.payload.welds[0]).not.toHaveProperty('group_name')
    await f.session.confirmOriginal()
    expect(vi.mocked(f.client.save).mock.calls[2][0].pending).toEqual(pending)
    expect(f.getStored()).toBeNull(); expect(f.session.state.blocked).toBe(false); expect(f.session.state.historyLength).toBe(0)
  })
  it('consumes the current pending and history when the recovery-list entry confirms its exact ACK', async () => {
    const f = make(), old = plan(); (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const original = f.getStored()!; await f.session.confirmRecoveryOriginal(original)
    expect(f.session.state.pending).toBeNull(); expect(f.session.state.uncertain).toBe(false)
    expect(f.session.state.historyLength).toBe(0); expect(f.session.state.draftSeq).toBe(2)
    expect(f.getStored()).toBeNull(); expect(f.session.state.message).toContain('已建立多表示保存边界')
  })
  it('does not consume a different active editor when replaying a detached recovery', async () => {
    const f = make(); await opened(f); await f.session.edit(p => { p.welds[0].location = 'detached request' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const original = f.getStored()!; f.session.resetEntry(); await f.session.initialize(); await f.session.open('plan', 'v1')
    const before = clone(f.session.state.payload), recoveryId = f.session.state.recoveryId
    expect(recoveryId).not.toBe(original.recovery_id)
    await f.session.confirmRecoveryOriginal(original)
    expect(f.getStored()).toBeNull(); expect(f.session.state.payload).toEqual(before)
    expect(f.session.state.recoveryId).toBe(recoveryId); expect(f.session.state.draftSeq).toBe(1)
  })
  it.each(['body', 'cursor', 'ordinary-save', 'storage', 'owner'] as const)('refuses pending history after %s changes without replacing the original request', async changed => {
    const f = make(), old = plan()
    if (changed !== 'ordinary-save') (old.payload.overlay as any).schema = 'vemcad-weld-overlay/2'
    vi.mocked(f.client.read).mockResolvedValue(old); await opened(f)
    await f.session.edit(p => { (p.overlay as any).schema = 'vemcad-weld-overlay/3'; p.welds[0].location = 'upgrade' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const original = f.getStored()!, before = clone(f.session.state.payload), undo = f.session.historyCandidate('undo')
    if (changed === 'body') undo.payload.welds[0].location = 'injected edit'
    if (changed === 'cursor') undo.cursor = 9
    if (changed === 'storage') vi.mocked(f.db.compareReplace).mockResolvedValueOnce(false)
    if (changed === 'owner') vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 })
    await expect(f.session.commitPayload(undo.payload, f.session.capture(), undo.cursor)).rejects.toThrow()
    expect(f.getStored()).toEqual(original); expect(f.client.save).toHaveBeenCalledTimes(1)
    if (changed !== 'owner') { expect(f.session.state.payload).toEqual(before); expect(f.session.state.historyCursor).toBe(1) }
    else expect(f.session.state.owner).toBeNull()
  })

  it('hides the revoked principal when the atomic consumer fresh authority fails', async () => {
    const f = make(); await opened(f); const next = clone(f.session.state.payload); next.welds[0].location = 'unconfirmed'
    vi.mocked(f.client.recoveryOwner).mockRejectedValueOnce(new WeldingPlanError('revoked', 401))
    await expect(f.session.commitPayload(next)).rejects.toThrow('revoked'); expect(f.session.state.owner).toBeNull(); expect(f.session.state.planId).toBe(''); expect(f.db.claim).not.toHaveBeenCalled()
  })

})
