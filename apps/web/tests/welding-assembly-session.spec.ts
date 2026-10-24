import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWeldingWorkflowSession } from '../src/views/welding/useWeldingWorkflowSession'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { WeldingPlanError, type WeldingPlanClient, type PlanRecord, type BomProjection, type AssemblyPreview } from '../src/services/welding/planClient'
import { validateWorkflowPending, type CommandRecoveryStore } from '../src/services/welding/commandRecovery'
import { withGenerationOwnerLock } from '../src/services/welding/commandRecovery'
import { clone, equal, type AssemblySide, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }, hash = 'a'.repeat(64)
const product = { item_id: 'part', version_id: 'p1' }
const side = (path: string[]): AssemblySide => ({ role: '人工命名侧', path, item_id: 'same-part', version_id: 'part-v1' })
const connection = () => ({ a: side(['rel-a']), b: side(['rel-b']) })
const projection = (next = false): BomProjection => ({ baseline_id: next ? 'new-bom' : 'old-bom', fingerprint: (next ? 'c' : 'b').repeat(64), name: '装配', number: 'B1', captured_depth: 2,
  root: { path: [], ...product, name: '产品', number: 'P1', version_label: 'A' },
  occurrences: ['rel-a', 'rel-b'].map(rel => ({ path: [rel], item_id: 'same-part', version_id: 'part-v1', name: '零件', number: 'P2', version_label: 'A', quantity: '1e1000', uom: '', find_number: '' })) })
function plan(adopted = false, hasBom = true): PlanRecord {
  return { plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', draft_seq: 1, content_hash: hash,
    payload: { schema_version: 1, product, drawing: { item_id: 'drawing', version_id: 'd1', file_id: 'file', file_role: 'drawing', expected_checksum: 'd'.repeat(64) }, process_refs: [],
      bom: hasBom ? { baseline_id: 'old-bom', expected_fingerprint: 'b'.repeat(64) } : null,
      ...(adopted ? { assembly_format: 'yuantus.welding_assembly/1' } : {}),
      welds: [{ weld_id: 'w1', display_no: '1', location: '', joint_type: '', method: '', material_a: '', material_b: '', filler: '', thickness_a: null, thickness_b: null,
        manufacturing_length: null, measured_length: null, welding_requirements: '', inspection_requirements: '', passes: [], ...(adopted ? { assembly: connection() } : {}) }] },
    sources: adopted ? { assembly: { schema: 'yuantus.welding_assembly/1', adopted_welds: ['w1'] } } : {} }
}
function impact(record: PlanRecoveryRecord): AssemblyPreview {
  const selected = record.pending!.body.payload as PlanRecord['payload'], assembly = selected.welds[0].assembly as ReturnType<typeof connection>, command = record.pending!.body.assembly_change as { from_fingerprint: string; to_fingerprint: string }
  const view = { sides: { a: { selection: assembly.a, facts: null, provenance: null, unknown: ['missing_occurrence', 'missing_witness'] }, b: { selection: assembly.b, facts: null, provenance: null, unknown: ['missing_occurrence', 'missing_witness'] } }, unknown: ['missing_occurrence', 'missing_witness'] }
  return { schema: 'yuantus.welding_assembly_preview/1', plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: hash, from_fingerprint: command.from_fingerprint, to_fingerprint: command.to_fingerprint,
    affected_welds: [{ weld_id: 'w1', reason_codes: ['assembly_selection_changed', 'missing_occurrence', 'missing_witness'], before: null, after: view, state: 'unknown' }] }
}
const sessions: Array<ReturnType<typeof useWeldingPlanSession>> = []
const workflows: Array<ReturnType<typeof useWeldingWorkflowSession>> = []
function fixture(adopted = false, hasBom = true, twoWelds = false) {
  let stored: PlanRecoveryRecord | null = null, counter = 0, writable = true, server = plan(adopted, hasBom)
  if (twoWelds) server.payload.welds.push({ ...clone(server.payload.welds[0]), weld_id: 'w2', display_no: '2' })
  const db: PlanRecoveryStore = {
    list: vi.fn(async identity => stored && equal(stored.owner, identity) ? [clone(stored)] : []),
    get: vi.fn(async (identity, id) => stored && equal(stored.owner, identity) && id === stored.recovery_id ? clone(stored) : null),
    claim: vi.fn(async value => { if (stored) return equal(stored, value); stored = clone(value); return true }),
    compareReplace: vi.fn(async (expected, next) => { if (!equal(expected, stored)) return false; stored = clone(next); return true }), close: vi.fn(),
  }
  const client = {
    authority: vi.fn(async () => clone(owner)),
    readReviewState: vi.fn(async () => ({ schema: 'yuantus.welding_review_state/1', plan_id: 'plan', item_version_id: 'v1', state: 'Draft', draft_seq: server.draft_seq, content_hash: server.content_hash, is_current: true, approval: null, final_generation: null, publication: null, final_profile: null, allowed_actions: [], issues: [] })),
    recoveryOwner: vi.fn(async () => clone(owner)), read: vi.fn(async () => clone(server)), list: vi.fn(async () => ({ items: [clone(server)], total: 1, offset: 0, limit: 50 })),
    recover: vi.fn(async (_purpose, record: PlanRecoveryRecord) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(record.owner), record_id: record.recovery_id, current: clone(server), can_write: true, conflict: false })),
    bomCandidates: vi.fn(async () => [projection(), projection(true)]), assemblyPreview: vi.fn(async record => impact(record)),
    save: vi.fn(async (record: PlanRecoveryRecord) => { expect(stored).toEqual(record); server = { ...server, draft_seq: 2, content_hash: 'e'.repeat(64), payload: clone(record.pending!.body.payload) as PlanRecord['payload'] }; return clone(server) }),
  } as unknown as WeldingPlanClient
  const makeSession = () => {
    const session = useWeldingPlanSession({ client, openStore: async () => db, writable: () => writable, uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` })
    session.setWorkflowAdmission(async (scope, _mode, _target, action) => action(scope)); session.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope)); sessions.push(session); return session
  }
  const session = makeSession()
  return { session, client, db, makeSession, stored: () => clone(stored), replace: (value: PlanRecoveryRecord | null) => { stored = clone(value) }, writable: (value: boolean) => { writable = value } }
}
async function opened(adopted = false, hasBom = true) { const f = fixture(adopted, hasBom); await f.session.initialize(); await f.session.open('plan', 'v1'); await f.session.readAssemblyCandidates(); return f }
async function savedOverlayAck(wrongId = false) {
  const f = fixture(), ordinary = vi.mocked(f.client.save).getMockImplementation()!
  vi.mocked(f.client.save).mockImplementation(async (record, scope) => ({ ...await ordinary(record, scope),
    save_id: wrongId ? 'wrong-original' : record.pending!.body.save_id as string }))
  await f.session.initialize(); await f.session.open('plan', 'v1')
  await f.session.edit(payload => { payload.overlay = { schema: 'vemcad-weld-overlay/3',
    snapshot: { meta: { unit: 'mm' }, entities: [], layers: [], blocks: [] }, bindings: [] } })
  await f.session.save()
  return f
}
const preview = (f: Awaited<ReturnType<typeof opened>>) => f.session.previewAssembly(projection(true), 'w1', connection())
beforeEach(() => localStorage.setItem('auth_token', 'native-A'))
afterEach(() => { workflows.splice(0).forEach(workflow => workflow.dispose()); sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })

describe('F18 assembly session durable originals', () => {

  it('freezes two proposed connections in one read-only preview and exact apply original', async () => {
    const f = fixture(true, true, true); await f.session.initialize(); await f.session.open('plan', 'v1'); await f.session.readAssemblyCandidates()
    const a = connection(), b = connection(); a.a.role = 'first proposed role'; b.b.role = 'second proposed role'
    const expectedA = clone(a), expectedB = clone(b), before = clone(f.session.state.payload)
    const work = f.session.previewAssembly(projection(true), 'w2', b, [{ weldId: 'w1', connection: a }])
    a.a.role = 'late mutation'; b.b.role = 'late mutation'; await work
    const displayed = clone(f.session.state.assemblyPreview)!, payload = displayed.original.pending!.body.payload as PlanRecord['payload']
    expect(payload.welds[0].assembly).toEqual(expectedA); expect(payload.welds[1].assembly).toEqual(expectedB)
    expect(f.session.state.payload).toEqual(before); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
    await f.session.applyAssembly(); expect(vi.mocked(f.client.save).mock.calls[0][0].pending).toEqual(displayed.original.pending)
  })
  it.each(['foreign-weld', 'foreign-position', 'duplicate'])('rejects an invalid staged %s before dispatch or durable writes', async damage => {
    const f = fixture(true, true, true); await f.session.initialize(); await f.session.open('plan', 'v1'); await f.session.readAssemblyCandidates()
    const entry = { weldId: 'w1', connection: connection() }, before = clone(f.session.state.payload)
    if (damage === 'foreign-weld') entry.weldId = 'other-plan-weld'
    if (damage === 'foreign-position') entry.connection.a.path = ['other-bom-path']
    await expect(f.session.previewAssembly(projection(true), 'w2', connection(), damage === 'duplicate' ? [entry, clone(entry)] : [entry])).rejects.toThrow()
    expect(f.client.assemblyPreview).not.toHaveBeenCalled(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.session.state.payload).toEqual(before)
  })
  it('reads BOM after a validated overlay3 save ACK when recovery current differs only by receipt save_id', async () => {
    const f = await savedOverlayAck(), sent = vi.mocked(f.client.save).mock.calls[0][0]
    expect(sent.pending).toMatchObject({ method: 'PUT', body: { expected_draft_seq: 1, payload: { overlay: { schema: 'vemcad-weld-overlay/3' } } } })
    expect(f.session.state.savedPoint?.save_id).toBe(sent.pending!.body.save_id)
    expect(f.session.state.draftSeq).toBe(2); expect(f.session.state.dirty).toBe(false); expect(f.stored()).toBeNull()
    const authority = await f.client.recover('restore', sent, f.session.capture())
    const { save_id, ...point } = f.session.state.savedPoint!
    expect(save_id).toBe(sent.pending!.body.save_id); expect(authority.current).toEqual(point)
    expect(Object.hasOwn(authority.current!, 'save_id')).toBe(false)
    vi.mocked(f.db.claim).mockClear(); vi.mocked(f.db.compareReplace).mockClear()
    await f.session.readAssemblyCandidates()
    expect(f.client.bomCandidates).toHaveBeenCalledOnce(); expect(f.client.bomCandidates).toHaveBeenCalledWith(product, expect.anything())
    expect(f.session.state.assemblyCandidates).toEqual([projection(), projection(true)])
    expect(f.client.save).toHaveBeenCalledOnce(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
  })
  it.each(['seq', 'hash', 'payload', 'owner', 'permission', 'conflict', 'scope'])('still rejects assembly after an overlay3 ACK when recovery %s changes', async kind => {
    const f = await savedOverlayAck(), ordinary = vi.mocked(f.client.recover).getMockImplementation()!
    vi.mocked(f.client.recover).mockClear()
    vi.mocked(f.client.recover).mockImplementation(async (...args) => {
      const value = await ordinary(...args)
      if (kind === 'seq') value.current!.draft_seq++
      if (kind === 'hash') value.current!.content_hash = 'f'.repeat(64)
      if (kind === 'payload') value.current!.payload.welds[0].method = 'changed'
      if (kind === 'owner') value.owner = { ...owner, auth_user_id: 88 }
      if (kind === 'permission') value.can_write = false
      if (kind === 'conflict') value.conflict = true
      if (kind === 'scope') notifyAuthPrincipalChange()
      return value
    })
    vi.mocked(f.db.claim).mockClear(); vi.mocked(f.db.compareReplace).mockClear()
    await f.session.readAssemblyCandidates()
    expect(f.client.recover).toHaveBeenCalledWith('restore', expect.anything(), expect.anything())
    expect(f.client.bomCandidates).not.toHaveBeenCalled(); expect(f.session.state.assemblyCandidates).toEqual([])
    expect(f.client.save).toHaveBeenCalledOnce(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.db.compareReplace).not.toHaveBeenCalled()
  })
  it('rejects a wrong overlay3 ACK save_id before assembly and retains the durable original', async () => {
    const f = await savedOverlayAck(true), sent = vi.mocked(f.client.save).mock.calls[0][0]
    expect(f.session.state.savedPoint?.draft_seq).toBe(1); expect(f.session.state.uncertain).toBe(true)
    expect(f.stored()?.pending).toEqual(sent.pending); expect(f.session.state.message).toContain('保存回执键不匹配')
    await expect(f.session.readAssemblyCandidates()).rejects.toThrow()
    expect(f.client.bomCandidates).not.toHaveBeenCalled(); expect(f.client.save).toHaveBeenCalledOnce()
  })
  it.each([false, true])('adopts association via PUT with hasBom=%s and no synthetic witness or change command', async hasBom => {
    const f = await opened(false, hasBom)
    await f.session.saveAssembly(projection(), 'w1', connection())
    expect(f.client.save).toHaveBeenCalledOnce(); const original = vi.mocked(f.client.save).mock.calls[0][0]
    expect(original.pending).toMatchObject({ method: 'PUT', path: '/plan/versions/v1/draft', body: { expected_draft_seq: 1, payload: { assembly_format: 'yuantus.welding_assembly/1', welds: [{ assembly: connection() }] } } })
    expect(Object.hasOwn(original.pending!.body, 'assembly_change')).toBe(false)
    expect(Object.hasOwn((original.pending!.body.payload as PlanRecord['payload']).welds[0].assembly as object, 'witness')).toBe(false)
    expect(f.session.state.savedPoint?.draft_seq).toBe(2); expect(f.stored()).toBeNull()
  })
  it('changes an existing association on the same BOM via PUT and preserves raw manual witness', async () => {
    const f = await opened(true), selected = connection(); selected.a.witness = { witness_id: 'manual-A', source: 'manual', material: '人工材料记录' }
    await f.session.saveAssembly(projection(), 'w1', selected)
    expect(vi.mocked(f.client.save).mock.calls[0][0].pending!.method).toBe('PUT')
    expect((f.session.state.payload.welds[0].assembly as typeof selected).a.witness).toEqual(selected.a.witness)
    expect(Object.hasOwn((f.session.state.payload.welds[0].assembly as typeof selected).a.witness!, 'thickness')).toBe(false)
  })
  it('cancels with explicit reason via PUT while keeping adopted format and weld', async () => {
    const f = await opened(true); await f.session.cancelAssembly('w1', '人工确认取消此关联')
    const original = vi.mocked(f.client.save).mock.calls[0][0]
    expect(original.pending).toMatchObject({ method: 'PUT', body: { assembly_cancel: { weld_id: 'w1', reason: '人工确认取消此关联' }, payload: { assembly_format: 'yuantus.welding_assembly/1' } } })
    expect(f.session.state.payload.welds).toHaveLength(1); expect(Object.hasOwn(f.session.state.payload.welds[0], 'assembly')).toBe(false)
  })
  it('previews read-only in memory, then persists and sends exactly the displayed POST apply original', async () => {
    const f = await opened(true), before = clone(f.session.state.payload)
    await preview(f); const displayed = clone(f.session.state.assemblyPreview)!
    expect(f.stored()).toBeNull(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.session.state.payload).toEqual(before)
    expect(displayed.impact.affected_welds[0].state).toBe('unknown')
    await f.session.applyAssembly(); const sent = vi.mocked(f.client.save).mock.calls[0][0]
    expect(sent.pending).toEqual(displayed.original.pending); expect(sent.pending!.method).toBe('POST'); expect(sent.pending!.path).toBe('/plan/versions/v1/assembly-apply')
    expect(sent.pending!.body).toMatchObject({ expected_draft_seq: 1, assembly_change: { expected_content_hash: hash, from_fingerprint: 'b'.repeat(64), to_fingerprint: 'c'.repeat(64) } })
    expect(f.session.state.assemblyPreview).toBeNull(); expect(f.stored()).toBeNull(); expect(f.session.state.draftSeq).toBe(2)
  })
  it('keeps the same preview original through a same-value recoveryOwner fresh and normal explicit apply', async () => {
    const f = await opened(true); await preview(f); const original = clone(f.session.state.assemblyPreview)!
    expect(original).not.toBeNull(); await f.session.fresh(f.session.capture())
    expect(f.session.state.assemblyPreview).toEqual(original); expect(f.client.save).not.toHaveBeenCalled()
    await f.session.applyAssembly(); expect(vi.mocked(f.client.save).mock.calls[0][0].pending).toEqual(original.original.pending); expect(f.stored()).toBeNull()
  })
  it.each(['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id'])('rejects a late preview when actual owner %s changes', async field => {
    const f = await opened(true), next = { ...owner }
    if (field === 'tenant_id') next.tenant_id = 'other-tenant'
    else if (field === 'org_id') next.org_id = 'other-org'
    else if (field === 'auth_user_id') next.auth_user_id++
    else next.rbac_user_id++
    vi.mocked(f.client.assemblyPreview).mockImplementation(async record => { vi.mocked(f.client.recoveryOwner).mockResolvedValue(next); return impact(record) })
    await preview(f); expect(f.session.state.assemblyPreview).toBeNull(); expect(f.session.state.owner).toBeNull(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('rejects a late preview after an actual auth ABA instead of restoring its old selections', async () => {
    const f = await opened(true)
    vi.mocked(f.client.assemblyPreview).mockImplementation(async record => { localStorage.setItem('auth_token', 'native-B'); notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-A'); notifyAuthPrincipalChange(); return impact(record) })
    await preview(f); expect(f.session.state.assemblyPreview).toBeNull(); expect(f.session.state.owner).toBeNull(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it.each(['seq', 'hash', 'edit'])('rejects a late preview when the actual %s savepoint primitive changes', async field => {
    const f = await opened(true)
    vi.mocked(f.client.assemblyPreview).mockImplementation(async record => {
      if (field === 'seq') f.session.state.draftSeq++
      else if (field === 'hash') f.session.state.contentHash = 'f'.repeat(64)
      else f.session.state.editSeq++
      return impact(record)
    })
    await preview(f); expect(f.session.state.assemblyPreview).toBeNull(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('rejects a late preview when its candidate baseline/fingerprint selection disappears', async () => {
    const f = await opened(true)
    vi.mocked(f.client.assemblyPreview).mockImplementation(async record => { f.session.state.assemblyCandidates = [projection()]; return impact(record) })
    await preview(f); expect(f.session.state.assemblyPreview).toBeNull(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('does not convert a different fixed BOM into PUT association saving', async () => {
    const f = await opened(true); await expect(f.session.saveAssembly(projection(true), 'w1', connection())).rejects.toThrow()
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it.each(['quota', 'CAS'])('sends zero writes when checkpoint fails with %s', async kind => {
    const f = await opened(true); await preview(f)
    if (kind === 'quota') vi.mocked(f.db.claim).mockRejectedValue(new Error('quota')); else vi.mocked(f.db.claim).mockResolvedValue(false)
    await f.session.applyAssembly(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.session.state.pending?.method).toBe('POST'); expect(f.session.state.storageBlocked).toBe(true)
  })
  it('retains the exact original UUID/method/path/body after lost ACK and retries through confirmOriginal', async () => {
    const f = await opened(true); await preview(f); vi.mocked(f.client.save).mockRejectedValueOnce(new Error('lost ACK'))
    await f.session.applyAssembly(); const original = f.stored()!
    expect(f.session.state.uncertain).toBe(true); expect(f.session.state.assemblyPreview).toBeNull()
    await f.session.confirmOriginal(); expect(vi.mocked(f.client.save).mock.calls.map(call => call[0])).toEqual([original, original]); expect(f.stored()).toBeNull()
  })
  it('restores an UNKNOWN POST apply and confirms it without minting a replacement original', async () => {
    const f = await opened(true); await preview(f); vi.mocked(f.client.save).mockRejectedValueOnce(new Error('lost ACK')); await f.session.applyAssembly()
    const original = f.stored()!, restored = f.makeSession(); await restored.initialize(); await restored.previewRecovery(original); await restored.restoreRecovery()
    expect(restored.state.pending).toEqual(original.pending); expect(restored.state.savedPoint).toBeNull(); expect(restored.state.assemblyPreview).toBeNull(); expect(restored.canAssembly.value).toBe(false)
    await restored.confirmOriginal(); expect(vi.mocked(f.client.save).mock.calls[1][0]).toEqual(original); expect(f.stored()).toBeNull()
  })
  it('preserves durable original when ACK CAS loses to another page', async () => {
    const f = await opened(true); await preview(f); vi.mocked(f.db.compareReplace).mockResolvedValue(false)
    await f.session.applyAssembly(); expect(f.stored()?.pending?.method).toBe('POST'); expect(f.session.state.draftSeq).toBe(1); expect(f.session.state.pending).not.toBeNull()
  })
  it.each([401, 403])('hides the page on %s and keeps only the durable original', async status => {
    const f = await opened(true); await preview(f); vi.mocked(f.client.save).mockRejectedValue(new WeldingPlanError('revoked', status)); await f.session.applyAssembly()
    expect(f.session.state.owner).toBeNull(); expect(f.session.state.assemblyPreview).toBeNull(); expect(f.stored()?.pending?.method).toBe('POST')
  })
  it.each(['ABA', 'owner', 'payload', 'other-tab'])('rejects late %s ACK without consuming the original', async kind => {
    const f = await opened(true); await preview(f)
    vi.mocked(f.client.save).mockImplementation(async original => {
      if (kind === 'ABA') { localStorage.setItem('auth_token', 'native-B'); notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-A'); notifyAuthPrincipalChange() }
      if (kind === 'owner') vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, auth_user_id: 88 })
      if (kind === 'other-tab') f.replace({ ...original, updated_at: original.updated_at + 1 })
      return { ...plan(true), draft_seq: 2, content_hash: 'e'.repeat(64), payload: kind === 'payload' ? plan(true).payload : clone(original.pending!.body.payload) as PlanRecord['payload'] }
    })
    await f.session.applyAssembly(); expect(f.stored()?.pending).not.toBeNull(); expect(f.session.state.draftSeq).not.toBe(2)
    if (['ABA', 'owner'].includes(kind)) expect(f.session.state.owner).toBeNull()
  })
  it('checks write availability after durable checkpoint and retry authority, before first save', async () => {
    const f = await opened(true); await preview(f); const ordinary = vi.mocked(f.client.recover).getMockImplementation()!
    vi.mocked(f.client.recover).mockImplementation(async (purpose, record, scope) => { const result = await ordinary(purpose, record, scope); if (purpose === 'retry') f.writable(false); return result })
    await f.session.applyAssembly(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.stored()?.pending?.method).toBe('POST')
  })
  it.each(['owner', 'seq', 'hash', 'edit', 'rights'])('does not apply stale preview after %s changes', async kind => {
    const f = await opened(true); await preview(f)
    if (kind === 'owner') f.session.state.owner = { ...owner, rbac_user_id: 99 }
    else if (kind === 'seq') f.session.state.draftSeq++
    else if (kind === 'hash') f.session.state.contentHash = 'f'.repeat(64)
    else if (kind === 'edit') await f.session.edit(payload => { payload.welds[0].location = 'later' })
    else f.writable(false)
    await expect(f.session.applyAssembly()).rejects.toThrow(); expect(f.client.save).not.toHaveBeenCalled()
  })
  it('does not publish an in-flight preview after a different selection closes it', async () => {
    const f = await opened(true); vi.mocked(f.client.assemblyPreview).mockImplementation(async record => { f.session.clearAssemblyPreview(); return impact(record) })
    await preview(f); expect(f.session.state.assemblyPreview).toBeNull(); expect(f.client.save).not.toHaveBeenCalled()
  })
  it('rechecks current Draft write authorization even when preview previously succeeded', async () => {
    const f = await opened(true); await preview(f); const ordinary = vi.mocked(f.client.recover).getMockImplementation()!
    vi.mocked(f.client.recover).mockImplementation(async (...args) => ({ ...await ordinary(...args), can_write: false }))
    await f.session.applyAssembly(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it('does not dispatch or checkpoint while the CAD barrier rejects', async () => {
    const f = await opened(true); f.session.setCadBarrier(async () => { throw new Error('CAD pending') })
    await preview(f); expect(f.client.assemblyPreview).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.client.save).not.toHaveBeenCalled()
  })
  it.each(['dirty', 'storage', 'uncertain', 'cad', 'atomic', 'generation', 'workflow', 'released'])('blocks new assembly work when %s is occupied', async kind => {
    const f = await opened(true)
    if (kind === 'dirty') f.session.state.dirty = true
    else if (kind === 'storage') f.session.state.storageBlocked = true
    else if (kind === 'uncertain') f.session.state.uncertain = true
    else if (kind === 'cad') f.session.state.cadBusy = true
    else if (kind === 'atomic') f.session.state.atomicBusy = true
    else if (kind === 'generation') f.session.setCommandPending(f.session.capture(), true)
    else if (kind === 'workflow') f.session.setWorkflowPending(f.session.capture(), true)
    else f.session.state.serverState = 'Released'
    await expect(preview(f)).rejects.toThrow(); expect(f.client.assemblyPreview).not.toHaveBeenCalled(); expect(f.client.save).not.toHaveBeenCalled()
  })
  it.each(['generation', 'workflow'])('checks durable %s admission before preview and saving', async kind => {
    const f = await opened(true), blocked = async () => { throw new Error('other-tab original pending') }
    if (kind === 'generation') f.session.setGenerationAdmission(blocked); else f.session.setWorkflowAdmission(blocked)
    await preview(f); expect(f.client.assemblyPreview).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.client.save).not.toHaveBeenCalled()
  })
  it.each([false, true])('uses the actual workflow admission hook with durable pending=%s', async occupied => {
    const f = await opened(true), request = vi.fn(async (_name, _options, action) => action())
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const original = validateWorkflowPending({ schema: 'metasheet.welding_command_pending/1', kind: 'workflow', owner, plan_id: 'plan', item_version_id: 'v1', action: 'withdraw',
      body: { request_id: 'workflow-original', expected_draft_seq: 1, expected_content_hash: hash, approval_request_id: 'approval', expected_submission_hash: hash, reason: '人工撤回原评审' } })
    const commandDb: CommandRecoveryStore = { get: vi.fn(async () => null), claim: vi.fn(async () => false), clear: vi.fn(async () => false), getWorkflow: vi.fn(async () => occupied ? original : null), claimWorkflow: vi.fn(async () => false), clearWorkflow: vi.fn(async () => false), close: vi.fn() }
    const gate = vi.spyOn(f.session, 'setWorkflowPending')
    const workflow = useWeldingWorkflowSession({ session: f.session, active: () => true, writable: () => true, openStore: async () => commandDb }); workflows.push(workflow)
    try {
      await preview(f); expect(commandDb.getWorkflow).toHaveBeenCalled()
      expect(gate.mock.calls.some(([, value]) => value === true)).toBe(true)
      if (occupied) {
        expect(f.session.state.commandPending).toBe(true); expect(f.client.assemblyPreview).not.toHaveBeenCalled(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
      } else {
        expect(gate.mock.calls.some(([, value]) => value === false)).toBe(true)
        const pending = clone(f.session.state.assemblyPreview?.original.pending); expect(pending?.method).toBe('POST')
        await f.session.applyAssembly(); expect(vi.mocked(f.client.save).mock.calls[0][0].pending).toEqual(pending); expect(f.stored()).toBeNull()
      }
    } finally { Reflect.deleteProperty(navigator, 'locks') }
  })
  it('uses one reentrant owner lease for checkpoint plus original dispatch', async () => {
    const request = vi.fn(async (_name, _options, action) => action()); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    try {
      const f = await opened(true); await preview(f)
      f.session.setWorkflowAdmission((scope, _mode, _target, action) => withGenerationOwnerLock(owner, scope, action))
      f.session.setGenerationAdmission((scope, _mode, _target, action) => withGenerationOwnerLock(owner, scope, action))
      await f.session.applyAssembly(); expect(request).toHaveBeenCalledOnce(); expect(f.client.save).toHaveBeenCalledOnce(); expect(f.stored()).toBeNull()
    } finally { Reflect.deleteProperty(navigator, 'locks') }
  })
})
